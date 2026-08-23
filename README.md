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
bundle makes no external requests. `--peerserver HOST:PORT` points the page at a
PeerServer on another machine, and `--probe` injects
[`scripts/lan-probe.js`](scripts/lan-probe.js), which records external requests, ICE
configuration, candidate types, and the WebGPU adapter. `--model` copies the GGUF in
under its own name rather than a fixed one, because llmlet keys its chunk cache on a
hash of the model URL and never checks size or content
([`docs/CONSTRAINTS.md`](docs/CONSTRAINTS.md) F26). `serve-runtime.py` adds the COOP/COEP headers the
pthread build needs; confirm `crossOriginIsolated === true` in the browser rather than
trusting the headers alone.

Signalling needs a local PeerServer, started before the page:

```bash
npm --prefix tools/peerserver run start
```

[`tools/peerserver`](tools/peerserver) pins `peer@1.0.2` so that starting the signalling
server does not reach npm. Run `npm ci --prefix tools/peerserver` once while online.
`npm install --prefix` fails with ENOENT in this environment (npm 10.9.4); the cause is
uninvestigated, so treat that as an observation rather than a rule about npm. `ci` is the
better fit anyway: it requires the lockfile, fails on a mismatch, and never rewrites it.

**What "no internet" covers.** `node_modules/` is not committed, so a fresh clone needs
network access for that install. What the LAN-only bundle demonstrates is that
**nothing leaves the machine at run time** — it is not an offline setup story.

Open **three** tabs: the client excludes only its own peer id, so two
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
