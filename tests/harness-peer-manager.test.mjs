// Tests for the harness transport itself.
//
// The Runtime-only harness only tells us something if its PeerManager is correct.
// When a browser run fails we need to be able to say "the transport is fine, so this
// is the Runtime" instead of debugging both at once.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createHarnessPeerManager,
  SEND_CHUNK_BYTES,
} from "../harness/runtime-only/harness-peer-manager.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i += 1) await tick();
}

/** A same-origin message bus: like BroadcastChannel, senders do not see their own posts. */
function createBus() {
  const handlers = [];
  /** Every data frame that crossed the bus, kept so tests can inspect its buffer. */
  const dataFrames = [];
  return {
    dataFrames,
    get dataSizes() {
      return dataFrames.map((frame) => frame.byteLength);
    },
    endpoint() {
      let own = null;
      return {
        post(message) {
          if (message.kind === "data") dataFrames.push(message.bytes);
          setTimeout(() => {
            for (const handler of handlers) {
              if (handler !== own) handler(message);
            }
          }, 0);
        },
        onMessage(handler) {
          own = handler;
          handlers.push(handler);
        },
        close() {},
      };
    },
  };
}

function pair(fdMaxA = 1024, fdMaxB = fdMaxA) {
  const bus = createBus();
  const events = { a: [], b: [] };

  const a = createHarnessPeerManager({
    nodeId: "a",
    transport: bus.endpoint(),
    fdMax: fdMaxA,
    onEvent: (event) => events.a.push(event),
  });
  const b = createHarnessPeerManager({
    nodeId: "b",
    transport: bus.endpoint(),
    fdMax: fdMaxB,
    onEvent: (event) => events.b.push(event),
  });
  return { a, b, events, bus };
}

/**
 * Every frame must own a private, bounded ArrayBuffer.
 *
 * send() receives a view into the WASM heap, which is a SharedArrayBuffer in the
 * pthread build. Posting a subarray of it would structured-clone a window onto live
 * Runtime memory; it would also drag the whole multi-megabyte backing buffer along.
 */
function assertFramesOwnBoundedBuffers(frames) {
  for (const frame of frames) {
    assert.ok(
      frame.buffer.byteLength <= SEND_CHUNK_BYTES,
      `frame backing buffer is ${frame.buffer.byteLength} bytes, over the ${SEND_CHUNK_BYTES} cap`,
    );
    assert.equal(frame.byteOffset, 0, "a frame must not be an offset view into a larger buffer");
    assert.equal(frame.buffer.byteLength, frame.byteLength, "a frame must own its buffer exactly");
    assert.equal(frame.buffer instanceof ArrayBuffer, true, "a frame must not share memory");
  }
}

/** ggml-rpc.cpp send_peer_retry(): keep calling until the socket took everything. */
function sendPeerRetry(pm, fd, data) {
  let total = 0;
  let calls = 0;
  while (total < data.byteLength) {
    const n = pm.send(fd, data.subarray(total));
    calls += 1;
    if (n < 0) return { total: n, calls };
    if (n === 0) throw new Error("send() accepted nothing; send_peer_retry would spin");
    total += n;
  }
  return { total, calls };
}

/** connect_peer() on a plus accept_peer() on b, the way llama.cpp pairs them up. */
async function link(a, b) {
  const accepted = new Promise((resolve) => b.accept(resolve));
  const connected = new Promise((resolve) => a.connect("b", resolve));
  const [clientFd, serverFd] = await Promise.all([connected, accepted]);
  return { clientFd, serverFd };
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function receive(pm, fd, len) {
  const chunks = [];
  return new Promise((resolve) => {
    pm.recv(fd, len, (chunk) => chunks.push(new Uint8Array(chunk)), (ok) =>
      resolve({ ok, bytes: concat(chunks) }),
    );
  });
}

test("connect, accept, send and recv complete a round trip", async () => {
  const { a, b } = pair();
  const { clientFd, serverFd } = await link(a, b);

  assert.ok(clientFd >= 0);
  assert.ok(serverFd >= 0);

  const payload = new TextEncoder().encode("hello runtime");
  assert.equal(a.send(clientFd, payload), payload.byteLength);

  const received = await receive(b, serverFd, 1024);
  assert.equal(received.ok, true);
  assert.equal(new TextDecoder().decode(received.bytes), "hello runtime");
});

test("recv respects the requested length and keeps the remainder", async () => {
  const { a, b } = pair();
  const { clientFd, serverFd } = await link(a, b);

  a.send(clientFd, new TextEncoder().encode("abcdefgh"));

  const first = await receive(b, serverFd, 3);
  assert.equal(new TextDecoder().decode(first.bytes), "abc");

  const second = await receive(b, serverFd, 100);
  assert.equal(new TextDecoder().decode(second.bytes), "defgh");
});

test("recv parks until data arrives instead of reporting an empty read", async () => {
  const { a, b } = pair();
  const { clientFd, serverFd } = await link(a, b);

  let settled = false;
  const pending = receive(b, serverFd, 16).then((result) => {
    settled = true;
    return result;
  });

  await flush();
  assert.equal(settled, false, "an empty read looks like a closed peer to recv_data()");

  a.send(clientFd, new TextEncoder().encode("late"));
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(new TextDecoder().decode(result.bytes), "late");
});

test("closing the connection wakes a parked recv with a failure", async () => {
  const { a, b } = pair();
  const { clientFd, serverFd } = await link(a, b);

  const pending = receive(b, serverFd, 16);
  await flush();

  assert.equal(a.close_connection(clientFd), 0);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(b.openFds(), [], "no live connections left on the peer");
});

test("a remote close tombstones the fd instead of freeing the number", async () => {
  const { a, b } = pair();
  const { clientFd, serverFd } = await link(a, b);

  // a closes; b hears about it but its own Runtime has not called close_peer yet.
  a.close_connection(clientFd);
  await flush();

  assert.deepEqual(b.openFds(), [], "the connection is no longer live");
  assert.deepEqual(b.reservedFds(), [serverFd], "but the fd number is still reserved");
  assert.equal(b.send(serverFd, new Uint8Array(4)), -1, "a tombstoned fd cannot send");
  assert.equal((await receive(b, serverFd, 8)).ok, false, "and cannot receive");

  const stats = b.fdStats().find((row) => row.fd === serverFd);
  assert.equal(stats.state, "closed");
  assert.equal(stats.runtimeCloses, 0, "the peer Runtime has not closed it yet");
});

test("a tombstoned fd is not handed out again until the Runtime closes it", async () => {
  // Only the peer is constrained, the way it is in practice: one number to fight
  // over there, so the race is forced.
  const { a, b } = pair(1024, 1);
  const first = await link(a, b);
  assert.equal(first.serverFd, 0);

  a.close_connection(first.clientFd);
  await flush();

  // A new client arrives before the peer Runtime got around to close_peer(0).
  // Releasing fd 0 here would make the pending close_peer(0) tear down this new
  // connection instead of the old one.
  let secondFd = "not-called";
  b.accept((fd) => {
    secondFd = fd;
  });
  a.connect("b", () => {});
  await flush();
  assert.equal(secondFd, "not-called", "fd 0 must stay reserved");

  // The peer Runtime finally closes it, and only then can the number be reused.
  assert.equal(b.close_connection(first.serverFd), 0);
  a.connect("b", () => {});
  await flush();
  assert.equal(secondFd, 0, "after the Runtime closed it, fd 0 comes back");
});

test("close() tombstones without releasing, because the Runtime still owns the fds", async () => {
  const { a, b } = pair();
  const { serverFd } = await link(a, b);

  b.close();

  assert.deepEqual(b.openFds(), []);
  assert.deepEqual(b.reservedFds(), [serverFd], "close() must not re-open the reuse race");
  assert.equal(b.fdStats().find((row) => row.fd === serverFd).runtimeCloses, 0);
});

test("a reused fd is accepted, registered and closed once per connection", async () => {
  // One fd number on the peer, reused every cycle: exactly the shape the browser
  // check looks for.
  const { a, b, events } = pair(1024, 1);

  // Deliberately the same pointer every time. free() followed by malloc() is allowed
  // to return the address it just released, so pointer identity proves nothing about
  // whether Module._connbuf[fd] was cleared. The counts do, which is why the browser
  // check compares accepted / registrations / runtimeCloses instead of pointers.
  const SAME_PTR = 0x1000;

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const { clientFd, serverFd } = await link(a, b);
    assert.equal(serverFd, 0, "the peer keeps reusing fd 0");

    // What the peer Runtime does per connection: recv_peer registers its buffer once,
    // then the server loop closes the fd after rpc_serve_client returns (patch 0002).
    b.register_buf(serverFd, SAME_PTR);
    a.close_connection(clientFd);
    await flush();
    b.close_connection(serverFd);
    await flush();
  }

  const peer = b.fdStats().find((row) => row.fd === 0);
  assert.equal(peer.accepted, 3, "three connections used this fd");
  // patch 0002: the RPC server closes the fd it accepted.
  assert.equal(peer.runtimeCloses, peer.accepted, "every accept must be matched by a close");
  // patch 0001: close_peer cleared Module._connbuf, so recv_peer registers again.
  assert.equal(peer.registrations, peer.accepted, "every accept must register a buffer");
  assert.equal(peer.state, "released");

  const epochs = events.b
    .filter((event) => event.type === "register_buf" && event.fd === 0)
    .map((event) => event.epoch);
  assert.deepEqual(epochs, [1, 2, 3]);
});

test("close() drops connections but keeps a pending accept", async () => {
  const { a, b } = pair();

  let acceptedFd = null;
  b.accept((fd) => {
    acceptedFd = fd;
  });

  // A generation reset closes everything on the peer while the RPC thread is still
  // parked in accept_peer(); dropping that waiter strands it in Atomics.wait().
  b.close();

  a.connect("b", () => {});
  await flush();

  assert.notEqual(acceptedFd, null, "the peer must still be able to accept after close()");
});

test("frames are copies, not windows into the caller's buffer", async () => {
  const { a, b, bus } = pair();
  const { clientFd } = await link(a, b);

  // Mimic HEAPU8.subarray(ptr, ptr + len): a small window into a large buffer.
  const heap = new Uint8Array(4 * SEND_CHUNK_BYTES);
  heap.fill(0xab);
  const view = heap.subarray(SEND_CHUNK_BYTES, SEND_CHUNK_BYTES + 1024);

  assert.equal(a.send(clientFd, view), 1024);
  assertFramesOwnBoundedBuffers(bus.dataFrames);

  // The sender reuses the heap as soon as send() returns; the frame must not follow.
  heap.fill(0x00);
  assert.equal(bus.dataFrames[0].every((byte) => byte === 0xab), true);
});

test("send and recv on an unknown fd fail instead of hanging", async () => {
  const { a, b } = pair();
  await link(a, b);

  assert.equal(a.send(99, new Uint8Array(1)), -1);
  assert.equal(a.close_connection(99), -1);

  const result = await receive(b, 99, 16);
  assert.equal(result.ok, false);
});

test("a small send is taken whole in one call", async () => {
  const { a, b, bus } = pair();
  const { clientFd } = await link(a, b);

  const payload = new TextEncoder().encode("short");
  assert.equal(a.send(clientFd, payload), payload.byteLength);
  assert.deepEqual(bus.dataSizes, [payload.byteLength]);
  assertFramesOwnBoundedBuffers(bus.dataFrames);
});

test("send() reports partial writes, so send_peer_retry drives a large transfer", async () => {
  const { a, b, bus } = pair();
  const { clientFd, serverFd } = await link(a, b);

  const payload = new Uint8Array(1_500_000);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;

  const { total, calls } = sendPeerRetry(a, clientFd, payload);
  assert.equal(total, payload.byteLength);
  assert.ok(calls > 1, "one send() must not swallow the whole tensor");

  // The point of the cap: no single structured clone carries the whole buffer, and
  // no frame is a view that keeps the 1.5 MB source alive.
  assert.equal(bus.dataSizes.length, calls);
  assert.ok(
    Math.max(...bus.dataSizes) < payload.byteLength,
    "a large tensor must not cross the bus as one clone",
  );
  assertFramesOwnBoundedBuffers(bus.dataFrames);

  const chunks = [];
  let received = 0;
  while (received < payload.length) {
    const result = await receive(b, serverFd, 1024 * 1024);
    assert.equal(result.ok, true);
    chunks.push(result.bytes);
    received += result.bytes.byteLength;
  }
  assert.deepEqual(concat(chunks), payload);
});
