# Runtime 公開インターフェース

このリポジトリ (Runtime) が Web アプリ側 (`RiTa-23/dip_Distributed_LLM`) に提供する境界を定義する。

**現状**: Web repo の `docs/implementation-spec.md` §6 が3関数を「①コア分散基盤」= このリポジトリの責務として記載しており、同 spec は「チャット入力欄・トークン表示は①のWASM連携API確定後に接続」と書いている。つまり **Web 側は Runtime 側の API 確定を待って止まっている**。この文書を最優先で埋める理由がこれ。

以下は確定 API ではなく、**Web repo が現在期待している integration surface** である。

## P0 未解決 — 実装着手前に決着させる

3関数だけではチャットが成立しない。細かいエラー伝播の設計より先に、この4点を決める。

| # | 論点 | 内容 |
|---|---|---|
| P0-1 | **prompt 投入経路が無い** | `onToken` は出力のみ。`generate(prompt)` に相当する入力 API が存在しない。制御プレーンにも無い (Web repo `docs/api-contract.md` v2 に prompt 用メッセージは無く、生成は requester ブラウザ内で完結するため WS メッセージにはならない) |
| P0-2 | **model source の受け渡しが未定義** | HTTP URL を渡すのか `File` を渡すのか。**URL 経路を選ぶ場合の必須条件は HEAD + `Content-Length`** (F13)。**206 Range は強く推奨だが必須ではない** — 非対応でも IndexedDB への全体先読みへフォールバックする (F4 / O2) |
| P0-3 | **`startWasmPeerServer` の引数の向きが逆の疑い** | Web repo の `docs/webrtc-implementation.md` では React 側が `pc.ondatachannel` で Runtime へ channel を**渡す側**。ならば自然な形は `startWasmPeerServer(channel)`、または `startWasmPeerServer()` + `attachDataChannel(channel)` |
| P0-4 | **ライフサイクルが未定義** | 停止 / 破棄 / generation 切替時の再初期化。多重呼び出し時の挙動 |

## Web 側が現在期待している3関数

出典: Web repo `docs/implementation-spec.md` §6 (原文ママ)

```ts
startWasmClient(dataChannels: Record<string, RTCDataChannel>): Promise<void>
onToken(callback: (token: string, done: boolean) => void): void
startWasmPeerServer(onDataChannel: (channel: RTCDataChannel) => void): Promise<void>
```

P0-1〜P0-4 を反映した形に変わる前提で扱うこと。この3関数をそのまま確定として実装しない。

## ホストページ要件

Runtime を読み込むページが満たすべき条件。

| 要件 | 内容 | 合格条件 |
|---|---|---|
| COOP / COEP | Emscripten の pthread 利用に必須 | **ヘッダの目視ではなく、ブラウザで `crossOriginIsolated === true` を確認する** |
| **HEAD + Content-Length** | モデルサイズを `fetch(url, {method:'HEAD'})` の `content-length` から取得している。**ヘッダが無いと `headers.get()` が `null` を返し、`Number(null) === 0` なので `size` が 0 になる**。0 バイトの仮想ファイルができてそのまま壊れる ([CONSTRAINTS.md](CONSTRAINTS.md) F13) | `curl -I <url>` が `Content-Length` を返すこと。**Range より先に踏むエラー** |
| GGUF 配信の Range (**推奨・必須ではない**) | HTTP URL 経路を使う場合 | `curl -H 'Range: bytes=0-1' -i <url>` が **206** を返すこと。返さなくても動くが、推論開始前に全体を先読みするため起動が遅れ、IndexedDB クォータの影響も受ける ([CONSTRAINTS.md](CONSTRAINTS.md) O2) |

## offload の既定値

`-ngl` を指定しない場合でも **CPU に落ちるわけではない**。llmlet は `-ngl` 未指定時に `model_params.n_gpu_layers` を触らず、`llama_model_default_params()` の既定 `-1` が残る。フォークの `llama-model.cpp` はこれを `params.n_gpu_layers >= 0 ? params.n_gpu_layers : hparams.n_layer + 1` と解決するため、**既定は全 layer offload** ([CONSTRAINTS.md](CONSTRAINTS.md) F19)。

層数を意図的に絞りたいときだけ `-ngl` を明示する。

## モデル・演算子の前提

Runtime が実行できるモデルは、**ピア側バックエンドが実際に実行できる演算**に制約される。しかも RPC デバイスは「何でも実行できる」と申告するため、クライアントからはそれが見えない ([CONSTRAINTS.md](CONSTRAINTS.md) の「根本原因」節)。

現時点で分かっている具体例は2つ。`ggml-webgpu` に `MUL_MAT_ID` が無いため **MoE モデルは WebGPU ピアで動かない** (F14)。また **単一テンソルが `maxStorageBufferBindingSize` を超えるモデル**も `supports_op` で弾かれる (F12)。どちらもピア側に CPU フォールバックが無いため行き止まりになる (F16)。

Web 側にモデルを選ばせる API を作る場合、この制約を Runtime 側で検査して明示的にエラーを返すこと。黙って落ちるのが最悪。

## DataChannel 引き渡し規約

- `binaryType = 'arraybuffer'` を設定してから渡す
- `open` 状態になってから渡す
- **close 責任の所在は未確定** (P0-4)。現状どちらが閉じるか決まっていない
- **想定外のピアからの DataChannel は受け入れない。** `ggml-rpc` は相手から来たテンソル記述子をデシリアライズして自プロセスのメモリを操作するため、「LAN だから安全」では解消しない ([CONSTRAINTS.md](CONSTRAINTS.md) セキュリティ節)

## 責務境界

| 領域 | Runtime | Web | 未割当 |
|---|---|---|---|
| WASM llama.cpp のビルド | ✅ | | |
| RPC の WebRTC 対応パッチ | ✅ | | |
| WebGPU バックエンド有効化 | ✅ | | |
| DataChannel 上の RPC バイト列 | ✅ | | |
| WebSocket 制御プレーン | | ✅ | |
| SDP / ICE 交換 | | ✅ | |
| RTCPeerConnection の生成・維持 | | ✅ | |
| GGUF の HTTP 配信 | | ✅ | |
| **prompt の投入経路** | | | ⬜ P0-1 |
| **model source の指定** | | | ⬜ P0-2 |
| **DataChannel の close 責任** | | | ⬜ P0-4 |
| **generation 切替時の再初期化** | | | ⬜ P0-4 |

「未割当」を空欄にせず明示する。ここが統合時の事故ポイントになる。

## llmlet 側の接合点

PeerJS を自前シグナリングへ差し替える際に触ることになる境界 (llmlet `libllmlet.js` で確認):

```text
Module.PeerManager.{ connect, accept, send, recv, register_buf, close_connection }
```

`release_conn` は接合点ではない。実体は `$release_conn: function(ptr) { _free(ptr); }` で、単なるバッファ解放。
