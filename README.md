# dip_Distributed_LLM_Runtime

Browser-side runtime experiments for distributed LLM inference with `llama.cpp`.

Project context and current hypotheses live in [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md). Shared development guidance lives in [`AGENTS.md`](AGENTS.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) | Entry point: project context and document index |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Settled decisions, separating product calls from verified technical facts |
| [`docs/RUNTIME_INTERFACE.md`](docs/RUNTIME_INTERFACE.md) | The boundary this repository exposes to the web application (has open P0 items) |
| [`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) | Technical constraints, split into verified / hypothesis / open |
| [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) | Model-size ladder, experiment order, and measured results |
| [`docs/handoff/web-repo-corrections.md`](docs/handoff/web-repo-corrections.md) | Findings to hand back to the web application repository |

## Local runtime testing

Two helpers for running the browser runtime locally:

```bash
python scripts/make-lan-bundle.py <out> --model <gguf>   # LAN-only bundle
python scripts/serve-runtime.py <out> --port 8888        # COOP/COEP server
```

`make-lan-bundle.py` vendors peerjs and bootstrap and pins `iceServers: []`, so the
bundle makes no external requests. `serve-runtime.py` adds the COOP/COEP headers the
pthread build needs; confirm `crossOriginIsolated === true` in the browser rather than
trusting the headers alone.

Signalling needs a local PeerServer (`npx --package=peer peerjs --port 9000`), started
before the page. Open **three** tabs: the client excludes only its own peer id, so two
tabs put every layer on a single peer. See [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

## Current first step

Before changing the Runtime architecture, reproduce the existing `llmlet` reference build.

The repository includes a PowerShell helper that checks out the currently pinned llmlet revision with its submodules and runs llmlet's upstream Docker build:

```powershell
./scripts/build-llmlet-reference.ps1
```

Prerequisites:

- Git
- Docker with `docker build` support

The script currently pins llmlet commit:

```text
730bad2f5b4d6598f55b09eb22d54b5bf2a467ed
```

Expected build artifacts:

```text
build/reference-llmlet/
├─ llmlet-mod.js
└─ llmlet-mod.wasm
```

The checkout used for this reference experiment is stored under `.work/llmlet/`. Both `.work/` and `build/` are intentionally ignored by Git.

This helper only makes the upstream reference build reproducible from this repository. A successful build should not be treated as proof that browser inference, WebGPU, or multi-peer RPC behavior has been verified; those are separate runtime checks.
