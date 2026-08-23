# 実験計画 — モデルサイズの梯子

**技術リスクを安い順に殺す**順序で並べている。

規模は `short / medium / long` の目安のみで、時刻は書かない。**進捗に応じて変える前提**であり、確定していない数字を書くと後からそれがスケジュール上の事実として扱われてしまうため。イベント終了時刻が確定したら初めて時刻を乗せる。

## まず動かす — QUICKSTART

リスク分類より先に、**手を動かして1回通す**ための手順。`AGENTS.md` の「smallest executable step」に相当する。

1. `llmlet-mod.js` / `llmlet-mod.wasm` と `llmlet.js`、`examples/simple/*` を同じ docroot に置く
2. **先に** PeerServer を起動する — `npx --package=peer peerjs --port 9000` (**npm パッケージ名は `peer`、bin 名が `peerjs`**。fresh 環境では `--package` を明示する方が確実)
   ⚠️ **ページより先に起動すること。** ページは Peer ID の取得に PeerServer を使うため、1タブ構成でも起動していないと初期化できない。既定で `::` (全インタフェース) にバインドする
3. **COOP / COEP ヘッダ付き**で配信する — `python scripts/serve-runtime.py <docroot> --port 8888`
   `crossOriginIsolated === true` をブラウザで確認すること (ヘッダ目視では不十分)
4. **タブを3枚**開く。各タブの Peer ID を、全タブの接続先欄に貼る (F22 により2枚では層が割れない)
5. モデル URL に小さい dense GGUF (llmlet 実績のある SmolLM2-1.7B-Instruct-q4_k_m 等) を入れてプロンプトを投げる

`examples/simple/index.html` は PeerServer アドレスを `127.0.0.1:9000` でハードコードしているので、複数PCで使うときは書き換えが要る。

⚠️ 同ファイルは PeerJS 本体を `https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js` から読み込む。**素の example はインターネットが無いとページすら開かない** (`DECISIONS.md` D1 / D2 に抵触)。会場で使うなら peerjs を自前配信に差し替えること。

## 実測済みの結果 (2026-08-23)

**段0b / 0.5 / 1 / 2 は達成済み。段2.5 は plain HTTP では不可と確定。** 同一PC・3タブ・Chrome・NVIDIA Turing での結果。

| 確認したこと | 結果 |
|---|---|
| 再現ビルド (段0b) | 完了済み。`build/reference-llmlet/` に `llmlet-mod.js` / `.wasm` (47MB)。システムログの `build: 8645 (c4b18b39d)` が pin したフォーク commit と一致 |
| COOP / COEP | `scripts/serve-runtime.py` で `crossOriginIsolated === true`、`SharedArrayBuffer: function`、`navigator.gpu: object` を確認 |
| WebGPU limits (段0.5-2) | `maxStorageBufferBindingSize = 2048 MiB` / `maxBufferSize = 2.00 GiB` |
| **段1** 1タブ・Qwen2.5-0.5B Q4_K_M | **成功。** token 生成を確認。`WebGPU compute buffer 298.50 MiB` / `CPU compute buffer 12.01 MiB` / `graph splits = 2` |
| **段2** 3タブ (client 1 + server 2) | **成功。** layers 0-14 → RPC0 / 15-23 → RPC1 に分割され、トークン生成まで完走。`graph splits = 3` |
| F20 (偽の free memory) | **確認。** 2ピアとも `2048 MiB free` と申告 = `maxBufferSize` そのもの |
| F21 (入力層 CPU 固定) | **確認。** `CPU model buffer size = 89.26 MiB` (Qwen2.5-0.5B は vocab 151936) |
| F22 (3タブ必要) | **確認。** 3タブで層分割が成立 |
| IndexedDB クォータ | 8.39 GB (この端末)。469 MiB のモデルで 468.6 MB 消費 |
| モデル配信要件 | Hugging Face は HEAD + `Content-Length`、206 Range、CORS すべて満たす。**一方 `scripts/serve-runtime.py` は Range 非対応**なので、ここから GGUF を配ると非206経路になる |
| **段2.5** LAN IP (`http://192.168.0.26:8889`) | **不可を確定 (F24)。** COOP/COEP を正しく送っても `crossOriginIsolated: false` / `SharedArrayBuffer: undefined` / `navigator.gpu: undefined`。Chrome が「origin was untrustworthy」として COOP を無視する |

**次は段2.5 (Secure Context) から。** ここまでは全て `127.0.0.1` で、LAN IP は未検証。

## 梯子

| 段 | 内容 | 合格条件 | 規模 |
|---|---|---|---|
| ~~0a~~ | **不要だった** — 段0b が先に完了したため公開成果物は使わず | llmlet 公開デモの `llmlet-mod.js` / `.wasm` を使って QUICKSTART が通る。**再現ビルドを待たずに段1以降へ進める** | short |
| **0b ✅** | llmlet 参照ビルド再現 (`scripts/build-llmlet-reference.ps1`) | `build/reference-llmlet/` に成果物が生成される。**バックグラウンドで並行実行し、失敗しても段1以降を止めない** | long |
| **0.5 ✅** | **静的確認2点** (下記) | 2点とも確認済み。**モデル選定をここで決める** | short |
| **1 ✅** | 1タブ・小モデル (1〜2B 級 dense) | token が生成される。WebGPU / CPU のどちらで動いたかを記録 | medium |
| **2 ✅** | 同一PC・**3タブ** (client 1 + server 2) + device 割当ログ | **2ピアに層が分かれた状態**で token 生成。あわせて O1 / O3 / O7 をログで確認 ⚠️ **同一 GPU / 同一メモリなので「計算資源を束ねた証明」にはならない** | medium |
| **2.5 ⛔** | **Secure Context ゲート** (下記) — **plain HTTP の LAN IP では通らないことを実測済み (F24)** | LAN IP 経由で `crossOriginIsolated === true` かつ `navigator.gpu != null` かつ `typeof SharedArrayBuffer !== 'undefined'` | medium |
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

**段3 より前に必ず通すこと。実測で「plain HTTP の LAN IP では通らない」ことが確定している (F24)** ので、これは仮説ではなく既知の阻害要因。

`navigator.gpu` は Secure Context 限定であり、`SharedArrayBuffer` (= `-pthread` / `PROXY_TO_PTHREAD` に必須) も Secure Context + cross-origin isolation を要求する。**`http://localhost` は potentially trustworthy 扱いだが、`http://192.168.x.x` は違う。**

つまり2台目の PC から LAN IP でアクセスした瞬間、`navigator.gpu` が `undefined` になり WASM が起動しない。

**確認手順** (PC-B から PC-A のページを開き、コンソールで実行):

```js
console.log(navigator.gpu, crossOriginIsolated, typeof SharedArrayBuffer)
```

3つとも通れば合格。通らない場合の対処は2経路あり、**どちらを選ぶかで PeerServer 側の扱いが変わる**。経路を混ぜると signaling で詰まる。

### 経路 A: 開発用 Chrome フラグ (推奨・軽い)

各端末の Chrome に `--unsafely-treat-insecure-origin-as-secure=http://<PC-Aのローカル IP>:8888` を設定する。**ページは HTTP のままなので、PeerServer も HTTP/WS のままでよい** (QUICKSTART の構成をそのまま使える)。

### 経路 B: 自己署名 HTTPS

ページを HTTPS で配信し、証明書を全端末に信頼させる。**この場合 PeerServer も TLS/WSS 化するか、リバースプロキシ配下に置く必要がある。**

理由: PeerJS はカスタム host 利用時、ページが HTTPS なら `secure` を自動的に true にする。**ページだけ HTTPS にして PeerServer を平文の 9000 で立てると、今度は signaling 側が WSS を要求して繋がらない。**

**どちらもそれ自体が作業なので、段3 の見積もりに含めること。**

### 検証状況 (2026-08-23)

| 経路 | 状態 |
|---|---|
| plain `http://` LAN IP | **不可を実測 (F24)。** COOP が無視され `crossOriginIsolated: false` |
| 経路 A: Chrome フラグ | 未検証 |
| 経路 B: 自己署名 HTTPS | **サーバ側は動作確認済み** (`scripts/serve-runtime.py --cert --key`、curl で 200、SAN に IP を含む証明書を生成)。**ブラウザ側は未達** — 信頼していない証明書は警告で止まり、検証に使ったブラウザはナビゲーション自体を拒否した。**残る問題は技術ではなく「参加者端末に証明書をどう信頼させるか」** (O8) |

**失敗時の退避**: 全員が同じ PC で複数タブ (段2 構成) に即座に戻す。**この退避先は実際に動作確認済み**なので、最低ラインは確保されている。

## 段3 の注意 — 素の llmlet は D1 / D2 を破る

llmlet は `iceServers` を一切設定しない (F23)。PeerJS の既定 config は Google STUN と PeerJS TURN を含むため、**そのまま使うとインターネットへ出る**。`DECISIONS.md` D1 (インターネット越し通信をしない) / D2 (クラウド不使用) に違反する。

段3 では次の3点をセットで用意する。

1. `peerOptions: { config: { iceServers: [] } }` を明示的に渡す
2. ローカル PeerServer を立てる — `npx --package=peer peerjs --port 9000`。**2台構成では全インタフェースにバインドすること** (公式例の `127.0.0.1:9000` はループバックのみ)。段2.5 で経路 B (HTTPS) を選んだ場合は **TLS/WSS 化も必要**
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
