# Agent Guide

This file provides shared working guidance for AI coding agents and developers in this repository.

For the current project context, hypotheses, open questions, and near-term investigation targets, read:

- `docs/AI_CONTEXT.md`

`docs/AI_CONTEXT.md` is living project context and may change as implementation and experiments progress. This file focuses on the more stable development approach and repository boundaries.

## Repository boundary

This repository is the Runtime side of the distributed LLM project.

The expected output is Runtime/build artifacts that can be consumed by the separate Web application repository. A local development server or test page may be used when needed to run WASM/WebGPU in a browser, but production Web application concerns normally belong elsewhere.

Typical Runtime-side concerns include:

- llama.cpp integration and builds
- WebAssembly / Emscripten
- WebGPU
- llama.cpp RPC in a browser environment
- browser-side Runtime glue
- Runtime build artifacts
- focused test or demo harnesses needed to verify the Runtime

React UI, Hono application logic, room UX, and product-facing orchestration normally belong to the Web application repository unless a small local harness is needed for Runtime verification.

## Default development workflow

Use this as the default way to approach implementation work. It is a development method, not a fixed product architecture.

1. **Understand the current state**
   - Read the relevant local code and `docs/AI_CONTEXT.md`.
   - For unfamiliar llama.cpp / browser RPC behavior, inspect the relevant upstream implementation or the llmlet reference before assuming how it works.

2. **Choose the smallest useful experiment or change**
   - Prefer a narrow, executable step that answers one question or enables one capability.
   - Avoid implementing surrounding future features only because they may become useful later.

3. **Make the change**
   - Reuse existing llama.cpp / llmlet behavior where it fits the current problem.
   - Add custom abstractions or infrastructure when the concrete need is visible from the code or experiment.

4. **Verify the behavior that matters**
   - Build the affected Runtime artifacts.
   - When the change is browser-, WASM-, WebGPU-, or RPC-related, prefer an actual smoke test or runtime observation over relying only on static checks.
   - Use logs and observed behavior to debug failures before stacking additional speculative changes.

5. **Update knowledge when useful**
   - If the work confirms or disproves an assumption that affects future development, update the relevant document in `docs/`.
   - Keep verified facts distinct from current hypotheses and open questions.

## Decision guidance

When several approaches are possible, generally prefer:

- current code and observed behavior over stale documentation
- upstream llama.cpp behavior over reimplementing equivalent functionality
- a small vertical PoC over a broad speculative framework
- reversible changes over large early abstractions
- explicit unknowns over invented certainty
- measuring browser/runtime behavior when static reasoning is insufficient

Do not treat current architecture sketches or model choices as permanent merely because they are documented. At the same time, do not discard established working behavior without a concrete reason.

## Working with external references

Two important references are currently:

- llama.cpp: https://github.com/ggml-org/llama.cpp
- llmlet: https://github.com/ktock/llmlet

Use them as implementation references, not as requirements to copy unchanged.

## Related project

- Web application: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
