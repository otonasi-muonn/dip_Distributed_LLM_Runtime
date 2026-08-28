# O11 Diagnostic Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan.

## Goal

780M WebGPU peer の O11 について、既存の外形症状を変えずに node155/157 の実体と既存 wait/pipeline/buffer/binding lifecycle の境界を一度だけ計測し、明確なコード原因が無ければ discrete GPU 実験へ移る。

## Architecture

変更は既存の opt-in `patches/0005-ggml-webgpu-graph-progress-trace.patch` に限定する。trace OFF は追加ログも追加診断処理も行わず、trace ON でも既存の 0-timeout poll を観測するだけにする。node の一般情報と通常 `MUL_MAT` 固有情報を分離し、Qwen3.6 の `MUL_MAT_ID` 単体結果から Granite node157 を推論しない。

## Tech Stack

- C++: pinned llama.cpp の `ggml-webgpu.cpp` に適用する patch
- JavaScript: patch の観測契約を検証する Node test
- PowerShell: 既存の llmlet/reference/runtime harness build script
- Browser/WebGPU: AMD Radeon 780M、同一 Granite、同一 prompt、同一 peer 構成
- Documentation: 日本語の `docs/` と `tasks/todo.md`

## Tasks

### Task 1: Diagnostic contract test (RED first)

`tests/webgpu-trace-patch.test.mjs` を追加し、patch に次の契約が存在することを検証する。

- 既存の `WaitAny(1, &sub->submit_done, 0)` が 1 回だけ残る。
- その poll の status と `subs_before/subs_after` を trace する。
- node の name/type/shape と通常 `MUL_MAT` の path/pipeline/shape 情報を trace する。
- pipeline/buffer/binding/encoder の境界 marker がある。

まず現状に対して実行し、意図した未実装契約で RED になることを確認する。

### Task 2: Minimal observability patch

patch のみを編集する。

- 0-timeout poll の前後に既存 call を囲む trace を追加する。blocking wait、timeout、同期、イベント処理は追加しない。
- graph node trace に `ggml_get_name`、`ggml_type_name`、4 次元 shape を追加する。
- 通常 `MUL_MAT` に `vec/fast/legacy`、pipeline 名、src/dst metadata、workgroup を追加する。
- `ggml_backend_webgpu_build_multi` の既存処理境界を trace する。
- test を GREEN にした後、`git apply --check` と build で patch の適用性を確認する。

### Task 3: Build and controlled OFF/ON measurement

既存 build script で runtime artifact を再生成する。Qwen3.6 本体は取得しない。変更後ビルドで、同一条件の trace OFF → trace ON を 1 セット実施する。OFF/ON の `ready`、first token、runtime error、timeout と、ON の最後の marker、poll の status/subs、node155/157 metadata を保存する。

### Task 4: Evidence-based decision

ログを「観測事実 / 推測 / 未検証」に分ける。明確なコード原因が出た場合だけ最小修正を追加し、再テストする。単に node157 内の停止区間が狭まっただけなら修正しない。その場合は 780M を打ち切り、discrete GPU で同一モデルの O11 を確認する。

### Task 5: Documentation and final verification

既知の誤記を計測結果に依存せず訂正する。

- `retries=0` を GPU 完了の証拠と書かない。
- Part D の `OK 131` を `MUL_MAT 131/131` と書かない。
- Qwen3.6 の個別 op test と Granite node157 を同一条件として扱わない。
- node157 が `MUL_MAT` であることから graph state/buffer/binding/pipeline cache を原因確定しない。
- patch0004 の standalone pass が full graph lifecycle を否定しないことを明記する。

変更前後の status/diff、tests、build、実測結果を確認し、`tasks/todo.md` のレビュー欄と残課題 DoD を更新する。main へ merge しない。
