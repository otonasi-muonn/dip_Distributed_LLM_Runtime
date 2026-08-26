# dip_Distributed_LLM_Runtime

Browser-side runtime experiments for distributed LLM inference with `llama.cpp`.

Project context and current hypotheses live in [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md). Shared development guidance lives in [`AGENTS.md`](AGENTS.md).

## Current status

The reference Runtime path has passed both:

- same-PC multi-peer layer splitting
- **physical 2-PC distributed inference** over LAN WebRTC DataChannels

The physical run used host-only ICE (`iceServers: []`) and produced a real model response while the second physical PC handled RPC traffic. See [`docs/STAGE3_RESULT_2026-08-25.md`](docs/STAGE3_RESULT_2026-08-25.md).

The next critical step is **not more PeerJS instrumentation**. It is connecting the real WASM Runtime to the separate Web repository's existing Hono signaling + `Module.PeerManager` implementation. The integration contract is [`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) | Entry point: current project state and next critical path |
| [`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md) | Current Runtime ↔ Web boundary and adapter contract |
| [`docs/STAGE3_RESULT_2026-08-25.md`](docs/STAGE3_RESULT_2026-08-25.md) | Physical 2-PC success, mDNS failure mode, remaining limits |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Settled product decisions and their evidence |
| [`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) | Verified / hypothesis / open technical constraints |
| [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) | Experiment ladder and detailed historical experiment notes |
| [`docs/handoff/web-repo-corrections.md`](docs/handoff/web-repo-corrections.md) | Findings to hand back to the Web application repository |

## Reproduce the pinned llmlet build

```powershell
./scripts/build-llmlet-reference.ps1
```

Prerequisites:

- Git
- Docker with `docker build` support

Pinned llmlet commit:

```text
730bad2f5b4d6598f55b09eb22d54b5bf2a467ed
```

The build is **the pinned commit plus `patches/*.patch`**, not stock llmlet. The patches move
ownership of the RPC receive buffer into the WASM glue, where the thread that allocated it can free
it; see the buffer ownership section of [`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md).

Expected artifacts:

```text
build/reference-llmlet/
├─ llmlet-mod.js
├─ llmlet-mod.wasm
└─ BUILD_INFO.txt   pinned commits, SHA-256 of every applied patch, SHA-256 of the artifacts
```

The build runs in a staging directory and is published only after it succeeds, and
`BUILD_INFO.txt` is written last. A failed build therefore leaves no provenance behind and
does not touch the previous artifacts.

The checkout is stored under `.work/llmlet/`. Both `.work/` and `build/` are intentionally ignored by Git.

## Export the Runtime for the Web repository

```powershell
./scripts/export-web-runtime.ps1
```

Writes `llmlet-mod.js`, `llmlet-mod.wasm`, `llmlet-runtime.js`, `BUILD_INFO.txt` and
`SHA256SUMS.txt` into `build/web-runtime/`. This repository does not know the Web application's
directory layout; copying the files into its static serving directory is the Web side's decision.

The export **refuses artifacts whose `BUILD_INFO.txt` does not match the pinned commits, the
current patch set, or the artifact hashes it records**. A pre-patch WASM bundle cannot be handed
over by accident, and neither can an older `llmlet-mod.js`/`.wasm` sitting next to a newer
`BUILD_INFO.txt`.

## Runtime-only integration harness

Proves the Runtime below the Web boundary without PeerJS, WebRTC or Hono: two tabs of one page,
an injected `Module.PeerManager` over a same-origin BroadcastChannel, the real
`llmlet-mod.js`/`.wasm`, a small dense GGUF, and one real generated answer.

```powershell
./scripts/build-runtime-harness.ps1
```

```bash
python scripts/serve-runtime.py build/runtime-harness --port 8888
```

Open `?role=peer&id=peer-1&fdmax=4` in one tab and
`?role=requester&id=req-1&peers=peer-1&fdmax=4` in another. Procedure and pass criteria are in
[`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md).

## Tests

```bash
node --test "tests/**/*.test.mjs"
```

Adapter lifecycle and harness transport only. They run against a fake Emscripten factory, so
pthreads, `Module._connbuf` and WebGPU are **not** covered — those need the browser harness above.

## LAN-only reference harness

Two helpers run the current PeerJS-based reference path locally:

```bash
python scripts/make-lan-bundle.py <out> --model <gguf> --probe
python scripts/serve-runtime.py <out> --port 8888
```

`make-lan-bundle.py` vendors PeerJS and Bootstrap at build time and patches the resulting page to `iceServers: []`. `--peerserver HOST:PORT` points it at a local PeerServer; `--probe` injects `scripts/lan-probe.js`.

Start signaling first:

```bash
npm --prefix tools/peerserver run start
```

`tools/peerserver` pins `peer@1.0.2`. A fresh clone still needs one online `npm ci --prefix tools/peerserver`; the demonstrated offline property is **runtime traffic stays local after preparation**, not “fresh clone installs offline”.

The harness remains useful for isolating Runtime regressions, but it is no longer the product integration architecture. The Web app owns Hono signaling, RTCPeerConnection/DataChannel establishment, and the DataChannel-side `PeerManager`.

## Important measured caveats

- LAN-IP plain HTTP is not a trustworthy origin for the required SharedArrayBuffer/WebGPU path; the reference physical test used each PC's `localhost`.
- In the measured 2-PC environment, Chrome mDNS-obfuscated host candidates failed in one direction. Disabling that anonymization for diagnosis exposed raw LAN host candidates and the connection succeeded. This is not a BYOD solution.
- `/restart` reproduced a WebGPU cleanup `RuntimeError: unreachable` on one restart path, although the same page later generated again. Lifecycle/restart is still open.
- Current WebGPU peers cannot run MoE models requiring `MUL_MAT_ID`; use a dense model for the next vertical slice.

## Next executable step

The PeerJS-independent adapter (`runtime/llmlet-runtime.js`) now runs in a real browser: the
Runtime-only harness connects a requester and a WebGPU peer, loads a dense GGUF over RPC, produces
real output, disconnects and reconnects. See the Gate A results in
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

The graceful-stop defect (O9) is fixed. It was a cross-thread teardown: emdawnwebgpu keeps its JS
handle table per Emscripten module instance, but the C++ static destructors run on the browser main
thread, whose table is empty. `patches/0003` keeps the WebGPU registry alive for the module's
lifetime on Emscripten only. The pre-fix bundle aborted on 4/4 sessions of the same harness.

What each browser actually covered: the in-app pane ran the graceful stop, the peer-without-restart
handover, five consecutive start/generate/stop cycles and the GPU sampling; **real Chrome ran the
graceful stop and the peer-without-restart handover only**. See F42 / F44 in
[`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md).

1. ~~rebuild the reference artifacts with `patches/` applied~~ — done
2. ~~pass the Runtime-only harness in a real browser~~ — done (Gate A)
3. hand `build/web-runtime/` to the Web repository
4. prove **Hono signaling → Web PeerManager → real WASM → one real prompt** on one machine
5. repeat that integrated path on two physical PCs

Only after this vertical slice passes should the project move to the main product proof: a dense model that does not fit on one peer but runs across multiple peers.
