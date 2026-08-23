# 実験計画 — モデルサイズの梯子

**技術リスクを安い順に殺す**順序で並べている。

規模は `short / medium / long` の目安のみで、時刻は書かない。**進捗に応じて変える前提**であり、確定していない数字を書くと後からそれがスケジュール上の事実として扱われてしまうため。イベント終了時刻が確定したら初めて時刻を乗せる。

## まず動かす — QUICKSTART

リスク分類より先に、**手を動かして1回通す**ための手順。`AGENTS.md` の「smallest executable step」に相当する。

1. `llmlet-mod.js` / `llmlet-mod.wasm` と `llmlet.js`、`examples/simple/*` を同じ docroot に置く
2. PeerServer を起動する — `npx peerjs --port 9000` (**パッケージ名は `peer` だが bin 名は `peerjs`**)
3. **COOP / COEP ヘッダ付き**で `http://localhost:8888` を配信する
4. **タブを3枚**開く。各タブの Peer ID を、全タブの接続先欄に貼る (F22 により2枚では層が割れない)
5. モデル URL に小さい dense GGUF (llmlet 実績のある SmolLM2-1.7B-Instruct-q4_k_m 等) を入れてプロンプトを投げる

`examples/simple/index.html` は PeerServer アドレスを `127.0.0.1:9000` でハードコードしているので、複数PCで使うときは書き換えが要る。

## 梯子

| 段 | 内容 | 合格条件 | 規模 |
|---|---|---|---|
| **0a** | **公開ビルド成果物でスモークテスト** | llmlet 公開デモの `llmlet-mod.js` / `.wasm` を使って QUICKSTART が通る。**再現ビルドを待たずに段1以降へ進める** | short |
| 0b | llmlet 参照ビルド再現 (`scripts/build-llmlet-reference.ps1`) | `build/reference-llmlet/` に成果物が生成される。**バックグラウンドで並行実行し、失敗しても段1以降を止めない** | long |
| **0.5** | **静的確認2点** (下記) | 2点とも確認済み。**モデル選定をここで決める** | short |
| 1 | 1タブ・小モデル (1〜2B 級 dense) | token が生成される。WebGPU / CPU のどちらで動いたかを記録 | medium |
| 2 | 同一PC・**3タブ** (client 1 + server 2) + device 割当ログ | **2ピアに層が分かれた状態**で token 生成。あわせて O1 / O3 / O7 をログで確認 ⚠️ **同一 GPU / 同一メモリなので「計算資源を束ねた証明」にはならない** | medium |
| **2.5** | **Secure Context ゲート** (下記) | LAN IP 経由で `crossOriginIsolated === true` かつ `navigator.gpu != null` かつ `typeof SharedArrayBuffer !== 'undefined'` | medium |
| 3 | 2台の物理PC + **O4 (接続性)** | 別筐体2台で token 生成。mDNS / AP isolation の疎通を確認。転送スループットも実測 | medium |
| 4 | Hono signaling へ差し替え | PeerJS を外し、Hono 経由で DataChannel 開通 → token 生成 | medium |
| 5 | **1台に載らないモデルを複数PCで** | **単一タブでは載らないモデルが N ピアで動く。プロダクトの実証点であり、デモの最低ライン** | long |
| 6 | ストレッチ: より大きいモデル | 下記 | 余剰時間 |

## 段0.5 の内容 (静的確認)

| # | 確認すること | 方法 |
|---|---|---|
| 1 | **対象モデルの全演算をピアのバックエンドが実行できるか** (O0) | `grep -rn MUL_MAT_ID .work/llmlet/llama.cpp/ggml/src/ggml-webgpu/` → **現時点で0件を確認済み**。MoE を選ぶなら WebGPU ピアでは動かない (F14) |
| 2 | **実機の `maxStorageBufferBindingSize`** (F12) | `(await navigator.gpu.requestAdapter()).limits.maxStorageBufferBindingSize` を対象モデルの最大テンソルバイト数と突き合わせる。上限を超えるテンソルがあると `supports_op` が false を返して同じ行き止まりになる |

**モデル選定の分岐**: 1 の結果により、**デモには dense モデルを使う**のが既定路線になる。

fork と upstream の差分規模 (O6) はここに含めない。upstream 追随を判断する時点で調べればよい。

## 段2.5 — Secure Context ゲート (モデル不要・5分で判定)

**段3 より前に必ず通すこと。** ここを飛ばすと段3 で原因不明の停止に遭う。

`navigator.gpu` は Secure Context 限定であり、`SharedArrayBuffer` (= `-pthread` / `PROXY_TO_PTHREAD` に必須) も Secure Context + cross-origin isolation を要求する。**`http://localhost` は potentially trustworthy 扱いだが、`http://192.168.x.x` は違う。**

つまり2台目の PC から LAN IP でアクセスした瞬間、`navigator.gpu` が `undefined` になり WASM が起動しない。

**確認手順** (PC-B から PC-A のページを開き、コンソールで実行):

```js
console.log(navigator.gpu, crossOriginIsolated, typeof SharedArrayBuffer)
```

3つとも通れば合格。通らない場合の対処は、自己署名証明書 + 全端末への信頼設定、または各端末に `--unsafely-treat-insecure-origin-as-secure` を設定するかのいずれか。**どちらもそれ自体が作業なので、段3 の見積もりに含めること。**

**失敗時の退避**: 全員が同じ PC で複数タブ (段2 構成) に即座に戻す。

## 段3 の注意 — 素の llmlet は D1 / D2 を破る

llmlet は `iceServers` を一切設定しない (F23)。PeerJS の既定 config は Google STUN と PeerJS TURN を含むため、**そのまま使うとインターネットへ出る**。`DECISIONS.md` D1 (インターネット越し通信をしない) / D2 (クラウド不使用) に違反する。

段3 では次の3点をセットで用意する。

1. `peerOptions: { config: { iceServers: [] } }` を明示的に渡す
2. ローカル PeerServer を立てる — `npx peerjs --port 9000`。**2台構成では全インタフェースにバインドすること** (公式例の `127.0.0.1:9000` はループバックのみ)
3. `examples/simple/index.html` の `peerserverAddress = "127.0.0.1:9000"` を書き換える

O4 (mDNS / AP isolation) はモデル不要で検証でき、失敗すると全段が止まるので、段2.5 と合わせて早期に潰す。

## 段6 の合格条件

**式にしない。** `ピア数 × 実効ヒープ ≥ 重み + KV` のような単純化は成り立たない。理由:

- 1層分の床 (F8)
- **requester 自身のヒープ下限** — `token_embd` は必ず CPU に固定される (F21)
- WebGPU メモリと WASM heap は別勘定
- 一時バッファ / context state / RPC 転送バッファ
- デバイスごとに available memory が非対称、**かつその報告値自体が壊れている可能性** (F20 / O7)
- `maxStorageBufferBindingSize` による単一テンソル上限 (F12)

代わりに、次をすべて満たすことを実測で確認する。

1. 各ピアが最低配置単位 (1層) を保持できる
2. **ピアのバックエンドが全 op を実行できる** (O0)
3. llama.cpp が全 tensor と context state を各デバイスへ配置できる
4. 実際に token 生成まで完走する

補足: `n_ctx` は 2048〜4096 に明示指定してメモリ変数を減らす (O5)。テキスト限定なら `mmproj` をロードしない (F9)。

### Qwen3.6-35B-A3B について

`DECISIONS.md` D8 の目標だが、**MoE であるため現状の WebGPU バックエンドでは動かない** (F14)。ストレッチですらなく別作業が前提になる。

選択肢は3つ。(a) WGSL shader を自作、(b) フォーク全体を upstream 追随、(c) upstream から `mul_mat_id` 関連シェーダと `supports_op` の case だけ cherry-pick。(c) が一見安いが、フォーク側のシェーダ埋め込み機構が upstream と異なる可能性が高く安く済む保証はない。**いずれも3日では選べない。**

## 打ち切り条件と Plan B

時計ではなく**技術状態**で判断する。

| 条件 | 行動 |
|---|---|
| 段0b (再現ビルド) が通らない | **公開ビルド成果物 (段0a) で確定**し、再現ビルドは諦める |
| 段2.5 (Secure Context) が通らない | 複数PC構成を諦め、同一PC複数タブをデモ構成として凍結 |
| 段3 (2物理PC) が成立しない | 段2 (同一PC**3タブ**) をデモ構成として**凍結**し、以降は演出とログ可視化に全振りする |
| 段5 (1台に載らないモデル) が成立しない | 段4 までの **2PC distributed** をデモの到達点として固める |

**Plan B の合格条件**: **3タブ (client 1 + server 2)** で層が分かれた状態のトークン生成 + 層配分ログの画面表示。「複数の実行単位にモデルが分かれている」ことが目で見えれば、コンセプトは伝わる。

⚠️ **2タブでは層が割れない** (F22)。Plan B を2タブで設計すると退避先が存在しなくなる。

ロールバック計画は YAGNI 違反ではなく、Acceptance Criteria の一部として扱う。
