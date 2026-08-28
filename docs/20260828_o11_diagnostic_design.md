# O11 追加診断の設計

## 目的

AMD Radeon 780M の WebGPU peer で実 MoE グラフが first token に到達しない O11 について、原因を推測で修正せず、discrete GPU 実験へ進む判断に必要な情報だけを追加取得する。

## 確認済みの前提

- 現在の trace は `ggml_webgpu_encode_node()` の呼び出し前に node を表示するため、`node=157 op=MUL_MAT` が最後に出たことは「node 157 の encode 呼び出しから戻っていない」と読める。
- ただし、`wait(partial) retries=0` は既存の blocking loop が 1 回も回らなかったことを示すだけで、submission が GPU で完了した証拠ではない。既存の `WaitAny(..., 0)` の結果を新たに表示する。
- `OK 131` は Part D の全 operation の結果であり、`MUL_MAT 131/131` という operation 別集計は現在の記録から導けない。
- Qwen3.6 の個別 `MUL_MAT_ID` 検証と、Granite の node157 の通常 `MUL_MAT` はモデル、shape、type、path、pipeline が異なり得る。したがって前者から後者の graph 内動作を保証しない。

## 変更範囲

`patches/0005-ggml-webgpu-graph-progress-trace.patch` の trace が有効な場合だけ、次を記録する。

1. 既存の 0-timeout `WaitAny` poll について、poll 前後の `subs` 数と `status`。新しい wait、timeout、`ProcessEvents`、同期は追加しない。
2. 各 node の name/type/shape と、`MUL_MAT` の src/dst の type/shape/stride/offset/byte size。
3. 通常 `MUL_MAT` の `vec/fast/legacy` path、選択された pipeline 名、workgroup 数。
4. pipeline 取得後から parameter buffer allocation、bind group、encoder/pass、finish までの既存処理境界。ログがどこで途切れるかだけを観測し、挙動は変えない。

ログは `GGML_WEBGPU_TRACE` が有効な場合だけ出し、通常の dense/RPC/WebGPU 経路の出力と挙動を変更しない。

## 実測手順と判定

同一の 780M / Granite / prompt / peer 構成で、変更後ビルドについて次の 1 セットを実行する。

1. trace OFF: 従来どおり `ready` 後に first token なし、runtime error なし、timeout となるか確認する。
2. trace ON: 同じ条件で詳細 trace を取得する。

OFF と ON の外形症状が一致しない場合は「trace 非影響」を PASS にしない。ON で停止位置が狭まっても、それだけでは原因確定・修正理由にしない。

## 修正へ進む条件

既存処理の明確なコード原因（例えば再現可能な parameter pool の待ち、特定の bind group/pipeline 作成失敗、または lifetime の不整合）が観測で確定した場合のみ、その原因に対する最小修正を行う。それ以外は診断パッチのみで止め、780M の追加深掘りをせず discrete GPU 実験へ進む。
