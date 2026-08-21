# 実験計画 — モデルサイズの梯子

**技術リスクを安い順に殺す**順序で並べている。各段は「問い」「合格条件」「時間箱」を持つ。

残り日程は約3日。**打ち切り基準と Plan B を先に決めてある** — 最低ラインは「これが落ちたら何を見せるか」とセットでなければ意味を持たないため。

## 段0.5 を最初に置く理由

コードを読むだけで決着する項目が3つある。測定装置を組む前にこれを済ませる。**所要15分で P0 が3つ片付く。**

## 梯子

| 段 | 内容 | 合格条件 | 時間箱 |
|---|---|---|---|
| 0 | llmlet 参照ビルド再現 | `build/reference-llmlet/` に `llmlet-mod.js` と `llmlet-mod.wasm` が生成される | 3h |
| **0.5** | **静的確認3点** (下記) | 3点すべて確認済み。**モデル選定 (dense か MoE か) をここで決める** | **0.5h** |
| 1 | 1タブ・小モデル (~0.5-1GB、**dense**) | token が生成される。WebGPU / CPU のどちらで動いたかを記録。`-ngl` を明示指定する | 3h |
| 2 | 同一PC・2タブ + device 割当ログ | 2ピアに層が分かれた状態で token 生成。あわせて O1 (device 割当) と O3 (cache hit/miss・実転送量) をログで確認 ⚠️ **同一 GPU / 同一メモリなので「計算資源を束ねた証明」にはならない** | 3h |
| 3 | 2台の物理PC + **O4 (接続性)** | 別筐体2台で token 生成。mDNS / AP isolation の疎通を確認。転送スループットも実測 | 4h |
| 4 | Hono signaling へ差し替え | PeerJS を外し、Hono 経由で DataChannel 開通 → token 生成 | 4h |
| 5 | **1台に載らないモデルを複数PCで** | **単一タブでは載らないモデルが N ピアで動く。プロダクトの実証点であり、デモの最低ライン** | 4h |
| 6 | ストレッチ: より大きいモデル | 下記 | 余剰時間 |

## 段0.5 の内容 (静的確認)

| # | 確認すること | 方法 |
|---|---|---|
| 1 | ピアのバックエンドが対象モデルの op を実行できるか (O0) | `grep -rn MUL_MAT_ID .work/llmlet/llama.cpp/ggml/src/ggml-webgpu/` → **現時点で0件を確認済み**。MoE を選ぶなら WebGPU ピアでは動かない (`CONSTRAINTS.md` F14-F16) |
| 2 | 実機の `maxStorageBufferBindingSize` (F12) | `(await navigator.gpu.requestAdapter()).limits.maxStorageBufferBindingSize` を対象モデルの最大テンソルバイト数と突き合わせる |
| 3 | フォークと upstream の差分規模 (O6) | `git -C .work/llmlet/llama.cpp log --oneline origin/rebase-20260401 ^upstream/master \| wc -l` |

**モデル選定の分岐**: 1 の結果により、**デモには dense モデルを使う**のが既定路線になる。MoE を使うならピアを CPU バックエンドで回す必要があり、F1 の 4GB 天井と CPU 速度が効く。

## 段3 で O4 を早期に潰す理由

O4 (mDNS / AP isolation による接続失敗) は**モデル不要・ブラウザ2台だけで検証できる**うえ、失敗すると通信自体が成立せず全段が止まる。安くて致命的なので前倒しする。

段4 (Hono 差し替え) より前に置いているが、**段3 で llmlet 素の PeerJS を使う場合は `npx peer --port 9000` などでローカル PeerServer を立てること**。llmlet 既定のパブリックブローカーは `DECISIONS.md` D1 (インターネット越し通信をしない) / D2 (クラウド不使用) に違反する。

## 段6 の合格条件

**式にしない。** `ピア数 × 実効ヒープ ≥ 重み + KV` のような単純化は成り立たない。理由:

- 1層分の床 (F8)
- requester 自身のメモリ消費
- WebGPU メモリと WASM heap は別勘定
- 一時バッファ / context state / RPC 転送バッファ
- デバイスごとに available memory が非対称
- `maxStorageBufferBindingSize` による単一テンソル上限 (F12)

代わりに、次をすべて満たすことを実測で確認する。

1. 各ピアが最低配置単位 (1層) を保持できる
2. ピアのバックエンドが全 op を実行できる (O0)
3. llama.cpp が全 tensor と context state を各デバイスへ配置できる
4. 実際に token 生成まで完走する

補足: `n_ctx` は 2048〜4096 に明示指定してメモリ変数を減らす (O5)。テキスト限定なら `mmproj` をロードしない (F9)。

### Qwen3.6-35B-A3B について

`DECISIONS.md` D8 の目標だが、**MoE であるため現状の WebGPU バックエンドでは動かない** (`CONSTRAINTS.md` F14-F16)。ストレッチですらなく、**別作業 (WGSL shader の実装、または upstream 追随) が前提になる**。現行 upstream の `ggml-webgpu` には `mul_mat_id` が存在するため、フォークを upstream へ追随できれば道は開ける。3日では選べない。

## 打ち切り基準と Plan B

| 時点 | 判定 | 行動 |
|---|---|---|
| D-1 12:00 | 段3 (2物理PC) 未達 | 段2 (同一PC2タブ・小モデル) をデモ構成として**凍結**し、以降は演出とログ可視化に全振りする |
| D-1 18:00 | 段5 未達 | 段4 までの構成でデモを固める |

**Plan B の合格条件**: 2タブで層が分かれた状態のトークン生成 + 層配分ログの画面表示。「複数の実行単位にモデルが分かれている」ことが目で見えれば、コンセプトは伝わる。

ロールバック計画は YAGNI 違反ではなく、Acceptance Criteria の一部として扱う。
