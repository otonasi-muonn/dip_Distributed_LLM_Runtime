// Browser Runtime glue for the pinned llmlet build.
//
// Derived from ktock/llmlet's llmlet.js (MIT), pinned at
// 730bad2f5b4d6598f55b09eb22d54b5bf2a467ed.
//
// The important difference from upstream's demo glue is that this file DOES NOT
// create PeerJS connections. The Web application owns signaling/DataChannels and
// injects an object implementing Module.PeerManager.

const CHUNK_MAX = 100_000_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Runtime errors can happen before a consumer awaits ready/stop. Attach a handler
  // immediately so the browser does not report a misleading unhandledrejection; the
  // original promise still rejects normally for explicit awaiters.
  void promise.catch(() => {});
  return { promise, resolve, reject, settled: false };
}

function settleResolve(d, value) {
  if (d.settled) return;
  d.settled = true;
  d.resolve(value);
}

function settleReject(d, error) {
  if (d.settled) return;
  d.settled = true;
  d.reject(error);
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function emit(callback, value) {
  try {
    callback?.(value);
  } catch (error) {
    console.error("runtime callback failed", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOrTimeout(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true, () => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

function requireBrowserRuntime() {
  if (typeof window === "undefined") throw new Error("llmlet Runtime must run in a browser");
  if (!window.isSecureContext) throw new Error("secure context is required");
  if (!window.crossOriginIsolated) throw new Error("crossOriginIsolated === true is required");
  if (typeof SharedArrayBuffer !== "function") throw new Error("SharedArrayBuffer is unavailable");
  if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable");
}

function requirePeerManager(pm) {
  const methods = [
    "connect",
    "accept",
    "send",
    "recv",
    "close_connection",
    "register_buf",
    "close",
  ];
  for (const method of methods) {
    if (typeof pm?.[method] !== "function") {
      throw new Error(`PeerManager.${method}() is required`);
    }
  }
}

async function openChunkCache() {
  const name = "ChunkCache";
  const storeName = "chunks";
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(storeName)) {
        req.result.createObjectStore(storeName);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open ChunkCache"));
  });

  const transactionDone = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });

  return {
    db,
    storeName,
    async put(key, chunk) {
      const tx = db.transaction(storeName, "readwrite");
      const txDone = transactionDone(tx);
      const store = tx.objectStore(storeName);
      const reqDone = new Promise((resolve, reject) => {
        const req = store.put(chunk, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("ChunkCache put failed"));
      });
      await Promise.all([reqDone, txDone]);
    },
    async get(key) {
      const tx = db.transaction(storeName, "readonly");
      // Register completion handlers before waiting for the request. A readonly
      // transaction is allowed to complete immediately after its request succeeds;
      // attaching oncomplete afterwards can miss the event and hang forever.
      const txDone = transactionDone(tx);
      const store = tx.objectStore(storeName);
      const reqDone = new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("ChunkCache get failed"));
      });
      const [value] = await Promise.all([reqDone, txDone]);
      return value;
    },
    close() {
      db.close();
    },
  };
}

async function digestString(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function addRemoteFile(Module, chunkCache, fileId, dir, fileName, size, fetchRange) {
  Module.preRun ??= [];
  Module.preRun.push((mod) => {
    mod.addRunDependency("load-model");
    void (async () => {
      try {
        const FS = Module.FS;
        const fullPath = `${dir}/${fileName}`;

        try {
          FS.mkdirTree(dir);
        } catch {
          // mkdirTree is intentionally idempotent here.
        }

        FS.createDataFile(dir, fileName, new Uint8Array(0), true, false, true);
        const node = FS.lookupPath(fullPath).node;
        if (!node) throw new Error(`failed to create virtual model file ${fullPath}`);

        node.size = size;
        node.waitingTable = {};
        node.remote_error = null;

        const maxEntries = 5;
        node.stream_ops = {
          read(stream, buffer, offset, length, position) {
            try {
              if (length === 0) return 0;
              if (node.remote_error != null) throw new FS.ErrnoError(28);

              const idx = Math.floor(position / CHUNK_MAX);
              const chunkPosition = idx * CHUNK_MAX;
              const chunkSize = Math.min(CHUNK_MAX, node.size - chunkPosition);

              if (node.waitingTable[idx] != null) {
                if (!node.waitingTable[idx].done) throw new FS.ErrnoError(6);

                const innerOffset = position % CHUNK_MAX;
                const copySize = Math.min(
                  length,
                  node.waitingTable[idx].length - innerOffset,
                );
                buffer.set(
                  node.waitingTable[idx].res.subarray(innerOffset, innerOffset + copySize),
                  offset,
                );
                node.waitingTable[idx].lastUsed = Date.now();

                if (Object.keys(node.waitingTable).length > maxEntries) {
                  let oldest = null;
                  for (const key in node.waitingTable) {
                    if (oldest === null || node.waitingTable[key].lastUsed < node.waitingTable[oldest].lastUsed) {
                      oldest = key;
                    }
                  }
                  if (oldest !== null) delete node.waitingTable[oldest];
                }
                return copySize;
              }

              node.waitingTable[idx] = { res: null, error: null, done: false, lastUsed: Date.now() };
              const key = `chunk:${fileId}:${chunkPosition}-${chunkPosition + chunkSize}`;

              chunkCache
                .get(key)
                .then((data) => {
                  if (data != null) {
                    node.waitingTable[idx].res = new Uint8Array(data);
                    node.waitingTable[idx].done = true;
                    node.waitingTable[idx].length = data.byteLength;
                    return;
                  }

                  return fetchRange(chunkPosition, chunkPosition + chunkSize).then((raw) => {
                    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                    void chunkCache.put(key, bytes).catch((error) => {
                      console.warn("failed to cache model chunk", error);
                    });
                    node.waitingTable[idx].res = bytes;
                    node.waitingTable[idx].done = true;
                    node.waitingTable[idx].length = bytes.byteLength;
                  });
                })
                .catch((error) => {
                  node.remote_error = error;
                  console.error("model chunk load failed", error);
                });

              // Emscripten retries the read after the async chunk arrives.
              throw new FS.ErrnoError(6);
            } catch (error) {
              if (error?.name !== "ErrnoError") {
                node.remote_error = error;
                console.error("model virtual file read failed", error);
                throw new FS.ErrnoError(28);
              }
              throw error;
            }
          },

          llseek(stream, offset, whence) {
            let pos = offset;
            if (whence === 1) pos += stream.position;
            else if (whence === 2) pos = node.size + offset;
            if (pos < 0) throw new FS.ErrnoError(22);
            return pos;
          },
        };
      } catch (error) {
        console.error("failed to set up model virtual file", error);
      } finally {
        mod.removeRunDependency("load-model");
      }
    })();
  });
}

async function fetchWholeModelToCache(fileId, modelUrl, chunkCache) {
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download model: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  let chunk = new Uint8Array(CHUNK_MAX);
  let chunkLength = 0;
  let chunkPosition = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (chunkLength > 0) {
        const key = `chunk:${fileId}:${chunkPosition}-${chunkPosition + chunkLength}`;
        await chunkCache.put(key, chunk.slice(0, chunkLength));
      }
      return;
    }

    let readOffset = 0;
    while (readOffset < value.length) {
      const copyLength = Math.min(value.length - readOffset, CHUNK_MAX - chunkLength);
      chunk.set(value.subarray(readOffset, readOffset + copyLength), chunkLength);
      chunkLength += copyLength;
      readOffset += copyLength;

      if (chunkLength === CHUNK_MAX) {
        const key = `chunk:${fileId}:${chunkPosition}-${chunkPosition + CHUNK_MAX}`;
        await chunkCache.put(key, chunk);
        chunkPosition += CHUNK_MAX;
        chunk = new Uint8Array(CHUNK_MAX);
        chunkLength = 0;
      }
    }
  }
}

async function prepareModel(Module, chunkCache, source) {
  Module.arguments.push("-m", "/work/model.gguf");

  if (source?.kind === "file") {
    const file = source.file;
    if (!(file instanceof File)) throw new Error("model.file must be a File");
    if (file.size <= 0) throw new Error("model file is empty");

    // Upstream keyed only on file.name. Include cheap metadata so replacing a file
    // under the same name does not silently reuse the most common stale-cache case.
    const fileId = await digestString(`${file.name}\0${file.size}\0${file.lastModified}`);
    addRemoteFile(Module, chunkCache, fileId, "/work", "model.gguf", file.size, (begin, end) =>
      file.slice(begin, end).arrayBuffer(),
    );
    return;
  }

  if (source?.kind === "url") {
    const modelUrl = source.url;
    if (!modelUrl) throw new Error("model URL is empty");

    const head = await fetch(modelUrl, { method: "HEAD" });
    if (!head.ok) throw new Error(`failed to access model HEAD: HTTP ${head.status}`);

    const rawLength = head.headers.get("content-length");
    if (rawLength == null) throw new Error("model response has no Content-Length");
    const size = Number(rawLength);
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`invalid model Content-Length: ${rawLength}`);
    }

    const identity = [
      modelUrl,
      rawLength,
      head.headers.get("etag") ?? "",
      head.headers.get("last-modified") ?? "",
    ].join("\0");
    const fileId = await digestString(identity);

    const probe = await fetch(modelUrl, { headers: { Range: "bytes=0-1" } });
    const rangeSupported = probe.status === 206;
    // We only needed the status. Do not keep a response body around.
    try {
      await probe.body?.cancel();
    } catch {
      // Some browsers have already consumed/closed the tiny body.
    }

    if (!rangeSupported) {
      console.warn("HTTP Range is unavailable; preloading the whole model into IndexedDB");
      await fetchWholeModelToCache(fileId, modelUrl, chunkCache);
    }

    addRemoteFile(Module, chunkCache, fileId, "/work", "model.gguf", size, (begin, end) => {
      if (!rangeSupported) {
        throw new Error("unexpected cache miss after full model preload");
      }
      return fetch(modelUrl, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
      }).then(async (response) => {
        if (response.status !== 206) {
          throw new Error(`model range request failed: HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      });
    });
    return;
  }

  throw new Error("model source must be {kind:'file', file} or {kind:'url', url}");
}

function utf8BinaryString(text) {
  const bytes = new TextEncoder().encode(text);
  // Avoid Function.apply/spread: a prompt can be large enough to exceed argument limits.
  let out = "";
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    out += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return out;
}

function createUtf8Output(onText) {
  const decoder = new TextDecoder("utf-8");
  return {
    line(value) {
      emit(onText, `${value}\n`);
    },
    byte(value) {
      if (value == null) {
        const tail = decoder.decode();
        if (tail) emit(onText, tail);
        return;
      }
      const text = decoder.decode(Uint8Array.of(value & 0xff), { stream: true });
      if (text) emit(onText, text);
    },
    flush() {
      const tail = decoder.decode();
      if (tail) emit(onText, tail);
    },
  };
}

function resolveBaseUrl(baseUrl) {
  if (baseUrl) return new URL(baseUrl, document.baseURI);
  return new URL("./", import.meta.url);
}

async function importModuleFactory(baseUrl) {
  const moduleUrl = new URL("llmlet-mod.js", baseUrl).href;
  const moduleFactory = await import(moduleUrl);
  if (typeof moduleFactory.default !== "function") {
    throw new Error("llmlet-mod.js has no default Emscripten factory export");
  }
  return { moduleFactory, moduleUrl };
}

function configureFiles(Module, baseUrl, moduleUrl) {
  Module.locateFile = (path) => new URL(path, baseUrl).href;
  Module.mainScriptUrlOrBlob = moduleUrl;
}

function configureNoColor(Module) {
  Module.preRun ??= [];
  Module.preRun.push(() => {
    Module.ENV.NO_COLOR = "1";
  });
}

function safeForceExit(Module) {
  try {
    Module?._emscripten_force_exit?.(0);
  } catch (error) {
    // O9: WebGPU cleanup can currently throw here. Keep the error observable,
    // but do not turn best-effort shutdown into a second unhandled exception.
    console.warn("force-exit raised during Runtime shutdown", error);
  }
}

/**
 * Start one browser as a llama.cpp RPC backend.
 *
 * The PeerManager must already be wired to the Web application's DataChannel layer.
 * Keep this Runtime alive across generation changes; only the PeerManager links should
 * be reorganized between generations.
 */
export function startPeer(options) {
  requireBrowserRuntime();
  requirePeerManager(options?.peerManager);

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const ready = deferred();
  const exited = deferred();
  let Module = null;
  let chunkCache = null;
  let stopping = false;

  const fail = (value) => {
    const error = asError(value);
    emit(options.onError, error);
    settleReject(ready, error);
    settleReject(exited, error);
  };

  void (async () => {
    try {
      const { moduleFactory, moduleUrl } = await importModuleFactory(baseUrl);
      chunkCache = await openChunkCache();

      Module = {
        print: (line) => emit(options.onLog, line),
        printErr: (line) => emit(options.onLog, line),
        stdin: () => null,
        PeerManager: options.peerManager,
        ChunkCache: chunkCache,
        arguments: ["-d", "-rpcbackend"],
      };
      if (options.disableWebGPU) Module.arguments.push("-device", "cpu");

      configureNoColor(Module);
      configureFiles(Module, baseUrl, moduleUrl);

      Module.onRuntimeInitialized = () => settleResolve(ready);
      Module.onExit = (code) => {
        chunkCache?.close();
        if (!stopping && code !== 0) fail(new Error(`peer Runtime exited with code ${code}`));
        else settleResolve(exited);
      };
      Module.onAbort = (reason) => fail(new Error(`peer Runtime aborted: ${String(reason)}`));

      await moduleFactory.default(Module);
      // Some Emscripten configurations do not call a user supplied hook; factory
      // resolution still means the runtime has initialized.
      settleResolve(ready);
    } catch (error) {
      fail(error);
    }
  })();

  return {
    ready: ready.promise,
    releaseConn(ptr) {
      Module?.release_conn?.(ptr);
    },
    async stop() {
      if (stopping) return exited.promise.catch(() => {});
      stopping = true;
      try {
        options.peerManager.close();
      } finally {
        safeForceExit(Module);
      }
      const clean = await waitOrTimeout(exited.promise, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      if (!clean) chunkCache?.close();
    },
  };
}

/**
 * Start the requester/client Runtime.
 *
 * generate() resolves when C++ finishes the answer and asks for the next prompt. This
 * gives us an explicit generation boundary without guessing from trailing newlines.
 */
export function startRequester(options) {
  requireBrowserRuntime();
  requirePeerManager(options?.peerManager);
  if (!Array.isArray(options.peerIds) || options.peerIds.length === 0) {
    throw new Error("requester requires at least one peerId");
  }
  if (new Set(options.peerIds).size !== options.peerIds.length) {
    throw new Error("peerIds must not contain duplicates");
  }

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const ready = deferred();
  const exited = deferred();
  const output = createUtf8Output(options.onText);

  let Module = null;
  let chunkCache = null;
  let promptWaiter = null;
  let activeGeneration = null;
  let cancelRequested = false;
  let stopRequested = false;
  let stopped = false;

  const fail = (value) => {
    const error = asError(value);
    emit(options.onError, error);
    settleReject(ready, error);
    if (activeGeneration) {
      settleReject(activeGeneration, error);
      activeGeneration = null;
    }
    settleReject(exited, error);
  };

  const deliverPrompt = (text) => {
    const cb = promptWaiter;
    promptWaiter = null;
    if (!cb) return false;
    cb(utf8BinaryString(text));
    return true;
  };

  void (async () => {
    try {
      const { moduleFactory, moduleUrl } = await importModuleFactory(baseUrl);
      chunkCache = await openChunkCache();

      Module = {
        print: (line) => output.line(line),
        printErr: (line) => emit(options.onLog, line),
        PeerManager: options.peerManager,
        ChunkCache: chunkCache,
        arguments: ["-d"],
      };

      for (const peerId of options.peerIds) {
        Module.arguments.push("-rpc", peerId);
      }
      if (Array.isArray(options.args)) Module.arguments.unshift(...options.args);

      Module.isDecodingCancel = () => (cancelRequested ? 1 : 0);
      Module.pending_system_prompt = (cb) => cb(utf8BinaryString(options.systemPrompt ?? ""));
      Module.pending_prompt = (cb) => {
        // Reaching this callback means model/context initialization succeeded and C++
        // is waiting for input. On later calls it also marks the previous generation done.
        settleResolve(ready);

        if (activeGeneration) {
          const done = activeGeneration;
          activeGeneration = null;
          cancelRequested = false;
          settleResolve(done);
        }

        if (stopRequested) {
          cb(""); // main.cpp treats prompt length 0 as graceful end-of-session.
          return;
        }

        promptWaiter = cb;
      };

      configureNoColor(Module);
      configureFiles(Module, baseUrl, moduleUrl);
      await prepareModel(Module, chunkCache, options.model);

      Module.onExit = (code) => {
        stopped = true;
        output.flush();
        chunkCache?.close();
        if (!stopRequested && code !== 0) fail(new Error(`requester Runtime exited with code ${code}`));
        else settleResolve(exited);
      };
      Module.onAbort = (reason) => fail(new Error(`requester Runtime aborted: ${String(reason)}`));

      await moduleFactory.default(Module);

      // Upstream llmlet overrides put_char after factory initialization so output can
      // stream before a full line is available. Use an incremental UTF-8 decoder here;
      // String.fromCodePoint(byte) corrupts Japanese/multibyte output.
      if (Module.TTY?.default_tty_ops) {
        Module.TTY.default_tty_ops.put_char = (_tty, value) => output.byte(value);
      }
    } catch (error) {
      fail(error);
    }
  })();

  return {
    ready: ready.promise,
    releaseConn(ptr) {
      Module?.release_conn?.(ptr);
    },
    async generate(prompt) {
      if (typeof prompt !== "string" || prompt.length === 0) {
        throw new Error("prompt must be a non-empty string");
      }
      if (stopRequested || stopped) throw new Error("requester Runtime is stopping/stopped");
      await ready.promise;
      if (activeGeneration) throw new Error("a generation is already running");
      if (!promptWaiter) throw new Error("requester is not waiting for a prompt");

      const generation = deferred();
      activeGeneration = generation;
      cancelRequested = false;
      if (!deliverPrompt(prompt)) {
        activeGeneration = null;
        throw new Error("failed to deliver prompt to Runtime");
      }
      return generation.promise;
    },
    cancel() {
      if (activeGeneration) cancelRequested = true;
    },
    async stop() {
      if (stopRequested) return exited.promise.catch(() => {});
      stopRequested = true;
      cancelRequested = true;

      // If C++ is already waiting for the next prompt, end naturally now. If it is
      // generating, isDecodingCancel() makes it return to pending_prompt, where the
      // stopRequested branch sends the empty prompt.
      if (promptWaiter) deliverPrompt("");

      let clean = await waitOrTimeout(exited.promise, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      if (!clean) {
        // Fallback only. O9 has shown this path can throw during WebGPU cleanup.
        options.peerManager.close();
        safeForceExit(Module);
        clean = await waitOrTimeout(exited.promise, 1_000);
      }
      if (!clean) chunkCache?.close();
    },
  };
}
