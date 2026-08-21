# Agent Guide

This file provides shared working guidance for AI coding agents and developers in this repository.

Before substantive work, read `docs/AI_CONTEXT.md` for the current project context, working hypotheses, open questions, and near-term investigation targets.

`docs/AI_CONTEXT.md` is living project context. This file is intentionally more stable and focuses on repository boundaries and the default development method.

## Repository boundary

This repository is the Runtime side of the distributed LLM project.

Its main output is Runtime/build artifacts that can be consumed by the separate Web application repository.

Typical Runtime-side concerns include:

- llama.cpp integration and builds
- WebAssembly / Emscripten
- WebGPU
- llama.cpp RPC in a browser environment
- browser-side Runtime glue
- Runtime build artifacts
- focused local test pages or harnesses needed to verify the Runtime

Product-facing concerns such as React UI, Hono application logic, room UX, roster management, and production Web application orchestration normally belong to the Web application repository.

A temporary local server may be used when browser execution requires one for WASM/WebGPU testing. Do not introduce a production server or backend service into this repository unless the Runtime itself develops a concrete requirement for it.

## Default development method

Use this as the normal workflow for implementation and investigation. It is more stable than the current product architecture, but it can still be revised when experience shows a better method.

### 1. Establish the question

Before editing code, identify the specific behavior or capability being worked on and what observation would count as success.

Read the relevant local code and `docs/AI_CONTEXT.md`. When the task depends on llama.cpp, browser RPC, WebGPU, or llmlet behavior, inspect the relevant implementation before assuming how it works.

### 2. Prefer the smallest executable step

Choose a change or experiment that answers one question or enables one concrete capability.

Avoid implementing adjacent future features only because they may become useful later. Prefer reversible changes while the Runtime architecture is still being learned through implementation.

### 3. Reuse before replacing

Check whether llama.cpp, llmlet, the browser platform, or existing local code already provides the needed behavior before adding a parallel implementation.

Reuse does not mean copying an existing implementation unchanged. If existing behavior does not fit the current requirement, make the smallest justified change and record the reason when it matters for future work.

### 4. Verify the behavior, not only the code

Run the most relevant verification available for the change.

- Build the affected Runtime artifacts when build output is involved.
- For browser-, WASM-, WebGPU-, RPC-, or multi-peer changes, prefer an actual smoke test or runtime observation when practical.
- A successful compile, type check, or unit test is not by itself proof that browser/runtime behavior works.
- Do not report a capability as working when the critical path has not actually been exercised; state what was and was not verified.

### 5. Diagnose before stacking fixes

When an experiment fails, first use logs, observed state, error output, or a smaller reproduction to identify the failing layer.

Avoid accumulating speculative fixes across several layers at once. Change one relevant assumption at a time when practical so the result teaches us something about the Runtime.

### 6. Preserve useful knowledge

When work confirms or disproves an assumption that affects future development, update the relevant document in `docs/`.

Keep these categories distinguishable:

- verified behavior
- current hypothesis
- open question

Do not turn every implementation detail into permanent documentation; record information that is likely to matter to later work.

## Decision guidance

When several approaches are plausible, generally prefer:

- current code and observed behavior over stale documentation
- upstream behavior over reimplementing equivalent functionality without a reason
- a small vertical PoC over a broad speculative framework
- reversible changes over large early abstractions
- explicit unknowns over invented certainty
- runtime measurement when static reasoning is insufficient

Current architecture sketches, model choices, and implementation ideas are not permanent merely because they are documented. Working behavior should also not be discarded without a concrete reason.

## Working with external references

Important implementation references currently include:

- llama.cpp: https://github.com/ggml-org/llama.cpp
- llmlet: https://github.com/ktock/llmlet

Use them as implementation references rather than requirements to copy unchanged.

## Related project

- Web application: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
