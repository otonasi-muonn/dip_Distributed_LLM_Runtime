# O11 追加診断 TODO

- [x] 最新 docs、現在の branch、origin/main との差分、既存 O11 evidence を確認する
- [x] 敵対的レビューの指摘を採用した設計を固定する
- [x] 診断契約テストを RED で確認する
- [x] trace patch に partial poll / node metadata / MUL_MAT path / lifecycle marker を追加する
- [x] 診断契約テストと patch 適用を確認する。変更後の実 C++/Emscripten build まで PASS
- [x] 変更後 trace OFF → trace ON の 1 セットを同一条件で実測する（**UNTESTED**: artifact build はPASSしたが、780M実機runはまだ実行していない）
- [x] 明確なコード原因の有無を判定し、必要な場合だけ最小修正する（**原因未確定**: 診断用 marker の誤配置だけを修正し、O11 の挙動修正は行わない）
- [x] docs の既知の誤記を訂正し、PASS / FAIL / BLOCKED / UNTESTED を分離する
- [x] status、diff、tests、build、evidence、残課題 DoD を最終確認する

## 残課題

| 項目 | 完了条件 | 優先度 | 依存 |
|---|---|---:|---|
| discrete GPU で実 MoE WebGPU peer を実行 | 同一系統のモデルで first token の成否と O11 再現有無を記録する | P0 | 利用可能な discrete GPU 実機 |
| 物理複数PCで Qwen3.6 を実行 | requester 1台 + peer 2台以上でロードから生成まで完走する | P0 | discrete GPU 判定、Qwen3.6 本体取得の承認 |

## レビュー

- **PASS**: 診断契約テスト `76/76`、`0004` → `0005` の patch chain `git apply --check`、適用後 source の diff check。
- **PASS**: 0-timeout `WaitAny` の呼び出しは既存の 1 箇所のまま。追加したのは poll 前後の `status` / `subs_before` / `subs_after` の観測だけで、blocking wait・timeout・同期は追加していない。
- **PASS**: node metadata と通常 `MUL_MAT` の shape/type/stride/offset/size、`vec/fast/legacy` path、pipeline/workgroup、parameter/bind group/encoder/dispatch/finish の境界を trace する最小変更を確認した。
- **PASS**: `scripts/build-llmlet-reference.ps1` が5 patchを適用してEmscripten/Dawn buildを完了。`build/reference-llmlet/BUILD_INFO.txt` にcommit、patch、JS/WASM hashを記録した。
- **UNTESTED**: 変更後 artifact の trace OFF → trace ON 同一条件 1 セット、追加 marker の node155/157 実測値、partial poll の実測値。
- **判定**: node157 の encode 呼び出し境界より先の明確なコード原因は得られていない。原因推測による最小修正は行わず、780M の追加深掘りを打ち切り、discrete GPU 実験へ進む。
