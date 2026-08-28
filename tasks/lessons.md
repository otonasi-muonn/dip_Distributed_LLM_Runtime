# 調査の再発防止ルール

- `retries` は特定の blocking loop の反復数として扱い、GPU submission 完了の証拠とは扱わない。既存の non-blocking poll は status と submission 数を別途観測する。
- 集計値の `OK` は対象 operation の内訳を確認してから記述する。総 operation 数の OK を特定 operation の成功数へ読み替えない。
- 異なるモデル、shape、type、実行 path、pipeline の standalone test と graph 内の node を同一条件とみなさない。
- standalone numerical test の成功は、full graph の state、buffer、binding、pipeline cache、lifetime の健全性を証明しない。
- 停止位置の絞り込みは原因確定ではない。明確なコード原因と再現性のある検証結果が揃った場合だけ最小修正へ進む。
