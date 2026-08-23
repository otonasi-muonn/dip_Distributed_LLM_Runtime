# Web アプリ側リポジトリへの指摘

宛先: `RiTa-23/dip_Distributed_LLM` (`develop`)

Runtime 側で llmlet と llama.cpp の実コードを読んで判明した、Web アプリ側に影響する事項です。反映するかは Web 側の判断に委ねます。

**前提**: 確認時点で `apps/server/src/index.ts` は Hono の Hello World スキャフォールドのままで、`apps/web/src/` にも `hooks/` `webrtc/` はまだありません。つまり以下の多くは**「実装済みコードのバグ」ではなく「実装前に直しておくと安い仕様書の記述」**です。タイミングとしてはむしろ最良です。

---

## P0

### 1. Runtime API に prompt 投入経路と model source が無い

`docs/implementation-spec.md` §6 の3関数:

```ts
startWasmClient(dataChannels: Record<string, RTCDataChannel>): Promise<void>
onToken(callback: (token: string, done: boolean) => void): void
startWasmPeerServer(onDataChannel: (channel: RTCDataChannel) => void): Promise<void>
```

これだけではチャットが成立しません。

- `onToken` は**出力のみ**。`generate(prompt)` に相当する入力 API がありません。`docs/api-contract.md` v2 に prompt 用メッセージが無いのは正しい (生成が requester ブラウザ内で完結するため) のですが、**その代わりに Runtime API 側に入口が必要**です
- **model source** (HTTP URL か `File` か) の受け渡しが未定義です
- `startWasmPeerServer(onDataChannel)` は**引数の向きが逆の疑い**があります。`docs/webrtc-implementation.md` では React 側が `pc.ondatachannel` で Runtime へ channel を渡す側なので、自然な形は `startWasmPeerServer(channel)` か `startWasmPeerServer()` + `attachDataChannel(channel)` です

Runtime 側でも `docs/RUNTIME_INTERFACE.md` に P0 未解決として記載しています。早めに握れると双方の手戻りが減ります。

### 2. モデル配信の HTTP 要件 (HEAD が先、Range が後)

llmlet はモデルファイルを丸ごとメモリに載せません。まず `HEAD` でサイズを取り、その後チャンク単位で読みます。

**(a) HEAD が Content-Length を返すこと — こちらが先に踏みます**

```js
let response = await fetch(modelURL, { method: 'HEAD' });
const contentLength = response.headers.get('content-length');
const size = Number(contentLength)
```

ヘッダが無いと `headers.get()` は `null` を返し、`Number(null)` は **0** になります。0 バイトの仮想ファイルができ、`Range: bytes=0--1` という不正なリクエストになってモデルロードが失敗します。**沈黙して壊れるのではなく、ロードエラーで落ちます。**

```bash
curl -I http://localhost:3000/models/your-model.gguf
```

**(b) 206 Range に応答できること — 未対応でも致命傷ではありません**

llmlet は `Range: bytes=0-1` で 206 を判定し、返らなければ全体を先読みするパスへフォールバックします。**訂正**: 当初こちらから「全体がメモリに載って破綻する」と伝えかけましたが、実コードを読むと誤りでした。フォールバック側も 100MB のバッファを使い回して IndexedDB へ流し込むストリーミングで、**メモリは増えません**。

実際のコストは次の3つです。

1. 推論開始前に GGUF 全体を先読みするため、**デモの開始が遅れる** (会場 Wi-Fi の実測時間がそのまま乗る)
2. **IndexedDB のクォータ**を超えると `"failed to load model"` で即死する
3. リロード時に途中再開が効かない

優先度は P1 相当ですが、`serveStatic` が Range を返せるならその方が明確に有利です。**Range 対応の有無はこちらでは未確認です。**下記で確認してください。なお Hono の 206 対応は optional な引数として実装されている形跡があるため、**バージョンを上げるだけでは有効にならない可能性があります**。

```bash
curl -H 'Range: bytes=0-1' -i http://localhost:3000/models/your-model.gguf
```

**なお `curl` は CORS をテストしません。** ページ (Vite の :5173 など) と GGUF 配信 (:3000) がオリジン違いなら `Access-Control-Allow-Origin` が必要です。**curl は通るのにブラウザで落ちる**のが当日最悪の踏み方なので、実際のページから `fetch` して確認してください。

### 3. デモに使うモデルは dense を選んでください (MoE は現状動きません)

Runtime 側の調査で判明した、**モデル選定に直接効く制約**です。

- llmlet が pin している llama.cpp (`ktock/llama.cpp` の `rebase-20260401`) の WebGPU バックエンドには **`MUL_MAT_ID` の実装がありません** (backend 全体で grep 0 件)。これは **MoE のエキスパート FFN そのもの**です
- 同じ理由で、**単一テンソルが実機の `maxStorageBufferBindingSize` を超えるモデル**も弾かれます。WebGPU の `supports_op` がこの値をハードゲートとして見ているためで、こちらは dense でも起こりえます
- RPC デバイスは「何でも実行できる」と申告する実装 (`return true` + TODO コメント) なので、クライアント側は構わず MoE の演算をピアへ送ります
- ピア側は単一バックエンドを直接呼ぶ作りで、**CPU への自動退避がありません**

`docs/requirements.md` 系の資料にある `Qwen3.6-35B-A3B` は MoE です。**このままではデモに使えません。**

**まず llmlet に実績のある 1〜2B 級の dense モデル**(SmolLM2-1.7B-Instruct-q4_k_m 等)から始めてください。ここから上げられるかは、こちらの段3 でスループットを実測してから判断します。**現時点で 7B 以上を前提に配信を用意しないでください** — 会場 Wi-Fi と DataChannel で破綻する側の数字です。

---

## P1

### 4. ICE candidate の pending キューが両側とも無い

`docs/webrtc-implementation.md` は requester 側・peer 側ともに、受信した candidate を即座に `addIceCandidate` しています。

`setRemoteDescription` より先に candidate が到着すると throw します。WebRTC で最も頻出する不具合です。両側に「remote description 設定前の candidate を溜めておき、設定後に flush する」キューを入れてください。

### 5. peer 側が module-level の単一 `pc` を持っている

```ts
let pc: RTCPeerConnection | null = null
```

generation が変わって新しい offer が来たとき、**古い接続を閉じずに上書き**します。requester 側には `teardownAllConnections()` がありますが、peer 側に相当する後始末がありません。

### 6. Hono スケルトンの3点

`docs/implementation-spec.md` §4.2 のスケルトンについて。

- `startNewGeneration()` が**定義されているだけで呼ばれていません** (コメントのみ)。このままだと generation が永久に始まりません
- `onClose()` が role も進行中の generation も見ずに `generation_aborted` を無条件ブロードキャストします。requester が抜けたときや、生成していないときにも飛びます
- `webrtc_signal` の `fromId` をクライアント入力のまま転送しています → 下記7

### 7. セキュリティは「省略」ではなく「最小限は残す」

`docs/comparison-with-llmlet.md` に「セキュリティ考慮を丸ごと省略できる」「会場という閉じた信頼できる空間なので正当にスキップできる」という趣旨の記述があります。

llama.cpp 公式は RPC について "Never run the RPC server on an open network or in a sensitive environment!" と警告し、実装を fragile かつ insecure な PoC と明記しています。

ただし「公式がそう書いているから」だけだと「うちはブラウザサンドボックス内だし DataChannel 経由でしか届かないので当たらない」と反論できてしまうので、**理由まで書きます**。

`ggml-rpc` は、**相手から送られてきたテンソル記述子をデシリアライズして自プロセスのメモリを操作します**。つまり信頼できないピアから DataChannel を受け入れること自体が、相手にこちらのメモリを触らせることに近い意味を持ちます。「LAN だから安全」では解消しません。しかも**ピアとして動くのは参加者個人の端末**です。

本格的な認証は省略してよいと思いますが、以下は残すことを勧めます。いずれも数行です。

- `fromId` はクライアントの申告ではなく、**サーバ側で WS 接続の identity から付与する**
- `targetId` が roster 内に存在するか確認してから転送する
- 想定外のピアからの DataChannel を拒否する

### 8. 参加者への告知

参加者の端末が他人の推論計算を担う構成です。「あなたの端末の計算資源が使われる」ことの告知・同意導線が、Runtime 側の資料にも Web 側の資料にも見当たりませんでした。

推論の一部が第三者端末のメモリ上で行われる点も含めて、参加者向けの説明が必要かどうかを判断してください。ハッカソン運営の規約次第の面もあります。

なお RPC には 1MiB 超のテンソル payload を IndexedDB へキャッシュする実装がありますが、**プロンプト由来のデータがこの経路とサイズ条件を通る範囲までは確認できていません**。「載る」と断定はできない、という状態です。

---

## P2

### 9. `implementation-spec.md` の簡略 snippet が詳細ガイドと不整合

§5.3 の `connectToPeer` について。

- `fromId: 'me'` というリテラルが入っています。コピーして使うと Hono のルーティングが壊れます
- `pc.setLocalDescription(offer)` を await せずに `send(...)` しており競合します

なお **`docs/webrtc-implementation.md` 側は正しく await 済み**です。WebRTC 実装全体の問題ではなく、簡略 snippet と詳細ガイドの不整合です。

### 10. Notion `フロント開発(React)` が現行契約と不整合の可能性

GitHub `develop` の `docs/api-contract.md` は既に **v2** で、`packages/shared-types/messages.ts` とも一致しています。**リポジトリ側は問題ありません。**

一方 Notion の `フロント開発(React)` ページは、`token` メッセージ / `assign_plan` / `plan_finalized` / `peer_status` の `progress` フィールドを前提にした記述が残っているようです。いずれも現行契約には存在しません。

Notion ページ本体はこちらで特定できていないため、**要確認**としての指摘です。

---

## 指摘しないことにした項目

| 項目 | 落とした理由 |
|---|---|
| `switch` 内の `const target` が `no-case-declarations` 違反 | ESLint 設定が確認できず、ランタイム不具合でもない |
| COOP/COEP を `await next()` の後に付与しているのは不確実 | コードを読んだだけではバグと確定できない。代わりに**実機で `crossOriginIsolated === true` を確認する**ことを合格条件にするのを勧めます |
| `docs/api-contract.md` などが存在しない (参照切れ) | **`develop` に全て存在しており、事実ではありませんでした** |
| GGUF 全体がメモリに載って 4GB 上限で破綻する | **実コードを読んで否定されました** (上記2)。当初こちらの誤りです |

---

## ライセンス

- **llmlet**: MIT (`Copyright 2025 The LLMlet authors`)。改変・配布は可能ですが、**著作権表示とライセンス文の保持が条件**です。フォークしてコードを取り込む場合、取り込んだ側に LICENSE をどう残すかを決めておいてください
- **Qwen3.6-35B-A3B / ggml-org の GGUF**: Apache-2.0。**Apache-2.0 の条件に従った再配布が可能**です。ただし配布前に、(a) HF の該当リポジトリの現物ライセンス表記、(b) `NOTICE` ファイルの有無 (Apache-2.0 第4条(d) は NOTICE の帰属表示の保持を求めます) を人間が確認してください
- モデル重みに OSS ライセンスがどこまで及ぶかは法的にまだ確立していない領域です。判断が必要な場合は人間が確認してください
