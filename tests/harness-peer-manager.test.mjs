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

function pair(fdMax = 1024) {
  const bus = createBus();
  const events = { a: [], b: [] };

  const a = createHarnessPeerManager({
    nodeId: "a",
    transport: bus.endpoint(),
    fdMax,
    onEvent: (event) => events.a.push(event),
  });
  const b = createHarnessPeerManager({
    nodeId: "b",
    transport: bus.endpoint(),
    fdMax,
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
  assert.deepEqual(b.openFds(), []);
});

test("a reused fd registers again, whatever pointer malloc hands back", async () => {
  const { a, b, events } = pair(2);

  // Deliberately the same pointer every time. free() followed by malloc() is allowed
  // to return the address it just released, so pointer identity proves nothing about
  // whether Module._connbuf[fd] was cleared. The registration count does, which is why
  // the browser check counts registrations per fd instead of comparing pointers.
  const SAME_PTR = 0x1000;

  const used = [];
  for (let i = 0; i < 4; i += 1) {
    const { clientFd } = await link(a, b);
    used.push(clientFd);
    // Stand in for recv_peer registering its receive buffer for this fd.
    a.register_buf(clientFd, SAME_PTR);
    a.close_connection(clientFd);
    await flush();
  }

  assert.deepEqual(used, [0, 1, 0, 1], "fd numbers must wrap below fdMax");

  assert.deepEqual(a.fdStats(), [
    { fd: 0, connections: 2, registrations: 2 },
    { fd: 1, connections: 2, registrations: 2 },
  ]);

  const epochsForFd0 = events.a
    .filter((event) => event.type === "register_buf" && event.fd === 0)
    .map((event) => event.epoch);
  assert.deepEqual(epochsForFd0, [1, 2], "a reused fd must register a second time");
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
