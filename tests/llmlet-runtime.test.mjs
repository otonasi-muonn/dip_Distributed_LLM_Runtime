// Lifecycle regression tests for runtime/llmlet-runtime.js.
//
// Every case here maps to a finding from the adversarial review of the pinned llmlet
// glue. They run against a fake Emscripten factory, so they prove the adapter's
// promise and error handling only. Anything that depends on real pthreads, WebGPU or
// Module._connbuf has to be checked in a browser (docs/RUNTIME_INTERFACE.md).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installBrowserEnv } from "./helpers/browser-env.mjs";
import { control } from "./fixtures/fake-llmlet/llmlet-mod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASE = pathToFileURL(path.join(HERE, "fixtures", "fake-llmlet") + path.sep).href;
const CHUNK_MAX = 100_000_000;

const { startRequester, startPeer } = await import("../runtime/llmlet-runtime.js");

let env;

beforeEach(() => {
  control.reset();
  env = installBrowserEnv();
});

afterEach(() => {
  env.restore();
});

// ---- helpers ---------------------------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function flush(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) await tick();
}

async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await tick();
  }
}

function stubPeerManager() {
  const calls = { close: 0, registered: [] };
  return {
    calls,
    connect() {},
    accept() {},
    send() {
      return 0;
    },
    recv(_fd, _len, _writeCB, doneCB) {
      doneCB(false);
    },
    close_connection() {
      return 0;
    },
    register_buf(fd, ptr) {
      calls.registered.push([fd, ptr]);
    },
    close() {
      calls.close += 1;
    },
  };
}

function modelFile(bytes = 8, name = "model.gguf") {
  return { kind: "file", file: new File([new Uint8Array(bytes)], name) };
}

/** Decode what the adapter hands to get_next_prompt(): one char per UTF-8 byte. */
const fromBinary = (value) =>
  new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));

/** Stand in for main.cpp driving the Module hooks. */
function simulate(Module) {
  return {
    systemPrompt() {
      let captured;
      Module.pending_system_prompt((value) => {
        captured = value;
      });
      return captured;
    },
    /** main.cpp asking for the next prompt; resolves with what the adapter sends. */
    nextPrompt() {
      return new Promise((resolve) => Module.pending_prompt(resolve));
    },
    emit(text) {
      for (const byte of new TextEncoder().encode(text)) {
        Module.TTY.default_tty_ops.put_char(null, byte);
      }
    },
    exit(code) {
      Module.onExit?.(code);
    },
    abort(reason) {
      Module.onAbort?.(reason);
    },
  };
}

/** Start a requester and wait until the adapter finished wiring the Module. */
async function startedRequester(overrides = {}) {
  const peerManager = stubPeerManager();
  const output = [];
  const errors = [];
  const runtime = startRequester({
    baseUrl: FIXTURE_BASE,
    peerManager,
    peerIds: ["peer-1"],
    model: modelFile(),
    onText: (delta) => output.push(delta),
    onLog: () => {},
    onError: (error) => errors.push(error),
    ...overrides,
  });
  const Module = await control.waitForModule();
  await waitFor(() => Module.onExit !== undefined, "adapter to install onExit");
  await flush();
  return { runtime, Module, peerManager, output, errors, sim: simulate(Module) };
}

// ---- prompt / generation boundary -------------------------------------------

test("generate resolves when C++ asks for the next prompt, and streams UTF-8", async () => {
  const { runtime, output, sim } = await startedRequester();

  const firstPrompt = sim.nextPrompt();
  await runtime.ready;

  const generation = runtime.generate("日本語で挨拶して");
  assert.equal(fromBinary(await firstPrompt), "日本語で挨拶して");

  sim.emit("こんにちは");
  // main.cpp prints a newline and loops back to get_next_prompt().
  sim.emit("\n");
  const secondPrompt = sim.nextPrompt();

  await generation;
  assert.equal(output.join(""), "こんにちは\n");
  assert.equal(secondPrompt instanceof Promise, true);
});

test("a second generate runs after the first, and overlapping calls are refused", async () => {
  const { runtime, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const g1 = runtime.generate("one");
  await p1;

  await assert.rejects(runtime.generate("two"), /already running/);

  const p2 = sim.nextPrompt();
  await g1;
  const g2 = runtime.generate("two");
  assert.equal(fromBinary(await p2), "two");
  sim.nextPrompt();
  await g2;
});

test("options.env reaches Module.ENV without dropping NO_COLOR", async () => {
  startPeer({
    peerManager: stubPeerManager(),
    baseUrl: FIXTURE_BASE,
    onLog: () => {},
    env: { GGML_WEBGPU_TRACE: "1", DROPPED: undefined },
  });
  const Module = await control.waitForModule();

  assert.equal(Module.ENV.NO_COLOR, "1", "the existing setting must survive");
  assert.equal(Module.ENV.GGML_WEBGPU_TRACE, "1");
  assert.equal("DROPPED" in Module.ENV, false, "undefined values must not become the string undefined");
});

test("cancel() stops decoding but still resolves the generation", async () => {
  const { runtime, Module, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("long answer please");
  await p1;

  assert.equal(Module.isDecodingCancel(), 0);
  runtime.cancel();
  assert.equal(Module.isDecodingCancel(), 1);

  sim.nextPrompt();
  await generation; // cancel is a caller-requested short answer, not a failure
  assert.equal(Module.isDecodingCancel(), 0, "the cancel flag must not leak into the next generation");
});

test("stop() during a generation rejects it instead of reporting truncated output as done", async () => {
  const { runtime, Module, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("long answer please");
  await p1;
  sim.emit("partial");

  const stopping = runtime.stop();
  assert.equal(Module.isDecodingCancel(), 1);

  // C++ breaks out of the decode loop and asks for the next prompt.
  const p2 = sim.nextPrompt();
  await assert.rejects(generation, /interrupted by stop/);
  assert.equal(await p2, "", "an empty prompt ends the main.cpp chat loop");

  sim.exit(0);
  await stopping;
});

test("stop() rejects a generation even when the Runtime only comes back through onExit", async () => {
  const { runtime, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("hello");
  await p1;

  const stopping = runtime.stop();
  sim.exit(0); // force-exit path: pending_prompt is never reached again
  await assert.rejects(generation, /interrupted by stop/);
  await stopping;
});

// ---- unexpected exits --------------------------------------------------------

test("an exit nobody asked for fails the requester instead of hanging generate()", async () => {
  const { runtime, errors, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("hello");
  await p1;

  // Exit code 0 used to be treated as a clean shutdown, leaving generate() pending.
  sim.exit(0);

  await assert.rejects(generation, /exited unexpectedly with code 0/);
  assert.equal(errors.length >= 1, true);
  assert.match(errors[0].message, /exited unexpectedly with code 0/);
});

test("a peer exit nobody asked for is reported, including exit code 0", async () => {
  const peerManager = stubPeerManager();
  const errors = [];
  const runtime = startPeer({
    baseUrl: FIXTURE_BASE,
    peerManager,
    onLog: () => {},
    onError: (error) => errors.push(error),
  });

  const Module = await control.waitForModule();
  await runtime.ready;

  // ggml_backend_rpc_start_server returns 0 when backend init fails; the loop never
  // returns otherwise, so any exit here is a failure.
  Module.onExit(0);

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /peer Runtime exited unexpectedly with code 0/);
});

test("an abort rejects the running generation", async () => {
  const { runtime, errors, sim } = await startedRequester();

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("hello");
  await p1;

  sim.abort("context size exceeded");

  await assert.rejects(generation, /aborted/);
  assert.match(errors[0].message, /context size exceeded/);
});

// ---- ChunkCache --------------------------------------------------------------

test("ChunkCache.get never rejects when IndexedDB fails, and warns once", async () => {
  const { Module } = await startedRequester();

  env.failures.get = true;
  // libllmlet.js cache_get() sits in Atomics.wait() and is only notified from the
  // resolve path, so a rejection here would deadlock the peer's RPC thread.
  assert.equal(await Module.ChunkCache.get("rpcchunk:a"), undefined);
  assert.equal(await Module.ChunkCache.get("rpcchunk:b"), undefined);

  const warnings = env.warnings.filter((line) => line.includes("ChunkCache read failed"));
  assert.equal(warnings.length, 1, "the warning is per cache instance, not per lookup");
});

test("ChunkCache.get survives a closed database connection", async () => {
  const { Module } = await startedRequester();

  Module.ChunkCache.close();
  assert.equal(await Module.ChunkCache.get("rpcchunk:a"), undefined);
});

test("ChunkCache.put still reports failure, because cache_put_inner handles it", async () => {
  const { Module } = await startedRequester();

  env.failures.put = true;
  await assert.rejects(Module.ChunkCache.put("rpcchunk:a", new Uint8Array(1)));
});

// ---- model virtual file ------------------------------------------------------

test("the chunk LRU never evicts a chunk that is still loading", async () => {
  const { Module } = await startedRequester();
  const node = control.files.get("/work/model.gguf");
  assert.ok(node?.stream_ops, "the adapter must install stream_ops on the model node");

  // Pretend the model is large enough to need more chunks than the LRU keeps.
  node.size = 6 * CHUNK_MAX;
  const buffer = new Uint8Array(16);

  const read = (chunkIndex) => {
    try {
      return node.stream_ops.read({}, buffer, 0, 1, chunkIndex * CHUNK_MAX);
    } catch (error) {
      assert.equal(error.name, "ErrnoError"); // EAGAIN: the fork retries the read
      return null;
    }
  };

  for (let i = 0; i < 5; i += 1) {
    read(i);
    await waitFor(() => node.waitingTable[i]?.done === true, `chunk ${i} to load`);
  }

  read(5); // still loading, and the least recently used entry
  assert.equal(node.waitingTable[5].done, false);

  read(0); // a completed chunk: this is where eviction runs
  assert.ok(node.waitingTable[5], "the pending chunk must survive eviction");
  assert.equal(
    Object.keys(node.waitingTable).length,
    5,
    "a completed chunk is evicted instead",
  );

  await waitFor(() => node.waitingTable[5]?.done === true, "chunk 5 to finish loading");
  assert.equal(node.remote_error, null, "evicting a pending chunk would surface as a load error");
});

// ---- buffer ownership --------------------------------------------------------

test("releaseConn() does not free the WASM receive buffer", async () => {
  const { runtime } = await startedRequester();

  runtime.releaseConn(4096);
  runtime.releaseConn(8192);

  // recv_peer() caches the buffer per fd on the RPC pthread and only re-registers it
  // when the slot is empty, so freeing from here leaves a dangling pointer behind.
  // patches/0001-llmlet-close-peer-free-connbuf.patch frees it on the owning thread.
  assert.deepEqual(control.releaseConnCalls, []);
});

// ---- prompt size -------------------------------------------------------------

test("a prompt that would overflow the n_ctx buffer is refused", async () => {
  const { runtime, sim } = await startedRequester();

  const waiting = sim.nextPrompt();
  await runtime.ready;

  // 3 bytes each in UTF-8: 1400 characters is over the 4096 byte default.
  await assert.rejects(runtime.generate("あ".repeat(1400)), /UTF-8 bytes/);

  // Just under the limit still works: the check counts bytes, not characters.
  const generation = runtime.generate("あ".repeat(1000));
  assert.equal(fromBinary(await waiting).length, 1000);
  sim.nextPrompt();
  await generation;
});

test("the prompt limit follows -c from args", async () => {
  const { runtime, sim } = await startedRequester({ args: ["-c", "8192"] });

  const waiting = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("あ".repeat(1400)); // 4200 bytes, fine at 8192
  await waiting;
  sim.nextPrompt();
  await generation;
});

test("an oversized system prompt is refused before the Runtime starts", () => {
  assert.throws(
    () =>
      startRequester({
        baseUrl: FIXTURE_BASE,
        peerManager: stubPeerManager(),
        peerIds: ["peer-1"],
        model: modelFile(),
        systemPrompt: "x".repeat(4096),
      }),
    /systemPrompt is 4096 UTF-8 bytes/,
  );
  assert.equal(control.modules.length, 0);
});

// ---- startup and shutdown ----------------------------------------------------

test("stop() before startup finishes never starts the Runtime and settles ready", async () => {
  const peerManager = stubPeerManager();
  const runtime = startRequester({
    baseUrl: FIXTURE_BASE,
    peerManager,
    peerIds: ["peer-1"],
    model: modelFile(),
  });

  await runtime.stop();

  assert.equal(control.modules.length, 0, "the Emscripten factory must not be called");
  await assert.rejects(runtime.ready, /stopped before it became ready/);
});

test("stopping a peer before startup finishes never starts the Runtime", async () => {
  const peerManager = stubPeerManager();
  const runtime = startPeer({ baseUrl: FIXTURE_BASE, peerManager });

  await runtime.stop();

  assert.equal(control.modules.length, 0);
  await assert.rejects(runtime.ready, /stopped before it became ready/);
  assert.equal(peerManager.calls.close, 1);
});

test("a startup failure closes the IndexedDB connection and reports the error", async () => {
  control.failWith = new Error("factory exploded");
  const errors = [];
  const runtime = startPeer({
    baseUrl: FIXTURE_BASE,
    peerManager: stubPeerManager(),
    onError: (error) => errors.push(error),
  });

  await assert.rejects(runtime.ready, /factory exploded/);
  assert.equal(errors.length, 1);
  assert.equal(
    env.connections.some((connection) => connection.closed),
    true,
    "leaving the connection open blocks indexedDB.deleteDatabase()",
  );
});

test("a second stop() is bounded by the same timeout", async () => {
  const { runtime, sim } = await startedRequester();
  sim.nextPrompt();
  await runtime.ready;

  const first = runtime.stop();
  sim.exit(0);
  await first;
  // exited already settled, so this must return rather than wait forever.
  await runtime.stop();
});

// ---- arguments and callbacks -------------------------------------------------

test("peerIds keep their order in the -rpc arguments", async () => {
  const { Module } = await startedRequester({ peerIds: ["peer-b", "peer-a"] });

  assert.deepEqual(Module.arguments, [
    "-d",
    "-rpc",
    "peer-b",
    "-rpc",
    "peer-a",
    "-m",
    "/work/model.gguf",
  ]);
});

test("duplicate peerIds are refused", () => {
  assert.throws(
    () =>
      startRequester({
        baseUrl: FIXTURE_BASE,
        peerManager: stubPeerManager(),
        peerIds: ["peer-1", "peer-1"],
        model: modelFile(),
      }),
    /must not contain duplicates/,
  );
});

test("a throwing onText or onError callback does not break the Runtime", async () => {
  const { runtime, sim } = await startedRequester({
    onText: () => {
      throw new Error("onText exploded");
    },
    onError: () => {
      throw new Error("onError exploded");
    },
  });

  const p1 = sim.nextPrompt();
  await runtime.ready;
  const generation = runtime.generate("hello");
  await p1;

  sim.emit("output");
  sim.nextPrompt();
  await generation;
});
