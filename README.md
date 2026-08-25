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

Expected artifacts:

```text
build/reference-llmlet/
├─ llmlet-mod.js
└─ llmlet-mod.wasm
```

The checkout is stored under `.work/llmlet/`. Both `.work/` and `build/` are intentionally ignored by Git.

The pinned upstream Makefile already exports the runtime methods needed by the Web bridge, including `release_conn`.

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

Implement the PeerJS-independent Runtime adapter described in [`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md):

1. reuse llmlet's model / ChunkCache / prompt / lifecycle glue
2. inject the Web repository's `Module.PeerManager` instead of calling `newPeerManager()`
3. copy/serve the pinned `llmlet-mod.js` / `.wasm`
4. prove **Hono signaling → Web PeerManager → real WASM → one real prompt** on one machine
5. repeat that integrated path on two physical PCs

Only after this vertical slice passes should the project move to the main product proof: a dense model that does not fit on one peer but runs across multiple peers.
