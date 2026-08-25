# 実験計画 — モデルサイズの梯子

**技術リスクを安い順に殺す**順序で並べている。

規模は `short / medium / long` の目安のみで、時刻は書かない。**進捗に応じて変える前提**であり、確定していない数字を書くと後からそれがスケジュール上の事実として扱われてしまうため。イベント終了時刻が確定したら初めて時刻を乗せる。

## まず動かす — QUICKSTART

リスク分類より先に、**手を動かして1回通す**ための手順。`AGENTS.md` の「smallest executable step」に相当する。

1. `llmlet-mod.js` / `llmlet-mod.wasm` と `llmlet.js`、`examples/simple/*` を同じ docroot に置く
2. **先に** PeerServer を起動する — `npm --prefix tools/peerserver run start`
   ⚠️ **ページより先に起動すること。** ページは Peer ID の取得に PeerServer を使うため、1タブ構成でも起動していないと初期化できない。`tools/peerserver` が `peer@1.0.2` を固定し、`--host 0.0.0.0 --port 9000` で起動する (`0.0.0.0` は `127.0.0.1` も含むので同一PC構成もそのまま動く)。初回だけオンラインで `npm ci --prefix tools/peerserver` が要る
3. **COOP / COEP ヘッダ付き**で配信する — `python scripts/serve-runtime.py <docroot> --port 8888`
   `crossOriginIsolated === true` をブラウザで確認すること (ヘッダ目視では不十分)
4. **タブを3枚**開く。各タブの Peer ID を、全タブの接続先欄に貼る (F22 により2枚では層が割れない)
5. モデル URL に小さい dense GGUF (llmlet 実績のある SmolLM2-1.7B-Instruct-q4_k_m 等) を入れてプロンプトを投げる

`examples/simple/index.html` は PeerServer アドレスを `127.0.0.1:9000` でハードコードしている。複数PCで使うときは書き換えが要るが、`make-lan-bundle.py --peerserver HOST:PORT` が代行する。

⚠️ 同ファイルは PeerJS 本体を `https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js` から読み込む。**素の example はインターネットが無いとページすら開かない** (`DECISIONS.md` D1 / D2 に抵触)。会場で使うなら peerjs を自前配信に差し替えること。

## 実測済みの結果 (2026-08-23)

**段0b / 0.5 / 1 / 2 は達成済み。** 同一PC・3タブ・Chrome・NVIDIA Turing での結果。あわせて **LAN-IP origin が不可であること (F24) も確定**した。

| 確認したこと | 結果 |
|---|---|
| 再現ビルド (段0b) | 完了済み。`build/reference-llmlet/` に `llmlet-mod.js` / `.wasm` (47MB)。システムログの `build: 8645 (c4b18b39d)` が pin したフォーク commit と一致 |
| COOP / COEP | `scripts/serve-runtime.py` で `crossOriginIsolated === true`、`SharedArrayBuffer: function`、`navigator.gpu: object` を確認 |
| WebGPU limits (段0.5-2) | `maxStorageBufferBindingSize = 2147483644` (≈ 2 GiB。厳密には 4 バイト小さい) / `maxBufferSize = 2147483648` (2.00 GiB)。adapter は `nvidia` / `turing`。`await __lanProbe.gpu()` で採取 |
| **段1** 1タブ・Qwen2.5-0.5B Q4_K_M | **成功。** token 生成を確認。`WebGPU compute buffer 298.50 MiB` / `CPU compute buffer 12.01 MiB` / `graph splits = 2` |
| **段2** 3タブ (client 1 + server 2) | **成功。** layers 0-14 → RPC0 / 15-23 → RPC1 に分割され、トークン生成まで完走。`graph splits = 3` |
| F20 (偽の free memory) | **確認。** 2ピアとも `2048 MiB free` と申告 = `maxBufferSize` そのもの |
| F21 (入力層 CPU 固定) | **確認。** `CPU model buffer size = 89.26 MiB` (Qwen2.5-0.5B は vocab 151936) |
| F22 (3タブ必要) | **確認。** 3タブで層分割が成立 |
| IndexedDB クォータ | 8.39 GB (この端末)。469 MiB のモデルで 468.6 MB 消費 |
| モデル配信要件 | Hugging Face は HEAD + `Content-Length`、206 Range、CORS すべて満たす。**一方 `scripts/serve-runtime.py` は Range 非対応**なので、ここから GGUF を配ると非206経路になる |
| **段2.6** LAN-only バンドル | **成功。** 外部HTTP 0件 (Resource Timing)、`RTCPeerConnection` の config は `{iceServers: []}`、ICE candidate は **host のみ** (srflx / relay なし) = STUN/TURN 未使用。ローカル配信の GGUF (Range 非対応 = F4 の非206経路) で3タブ分散推論が完走 |
| **段2.7** localhost-origin → LAN-address self-connect | **成功。** `http://127.0.0.1:8888` のページから `192.168.0.26:9000` の PeerServer へ接続し Peer ID を取得。preflight 4項目すべて通過、外部HTTP 0件。**LNA の権限プロンプトは介在しなかった** (F25) |
| **LAN-IP origin** (`http://192.168.0.26:8889`) → 段6 の論点 | **不可を確定 (F24)。** COOP/COEP を正しく送っても `crossOriginIsolated: false` / `SharedArrayBuffer: undefined` / `navigator.gpu: undefined`。Chrome が「origin was untrustworthy」として COOP を無視する |

**次は段3 (2台の物理PC) へ。** LAN-IP origin は実測で不可と分かったので、**各PCが自機の `localhost` を開く**構成で進める (TLS 不要)。

## 梯子

| 段 | 内容 | 合格条件 | 規模 |
|---|---|---|---|
| ~~0a~~ | **不要だった** — 段0b が先に完了したため公開成果物は使わず | llmlet 公開デモの `llmlet-mod.js` / `.wasm` を使って QUICKSTART が通る。**再現ビルドを待たずに段1以降へ進める** | short |
| **0b ✅** | llmlet 参照ビルド再現 (`scripts/build-llmlet-reference.ps1`) | `build/reference-llmlet/` に成果物が生成される。**バックグラウンドで並行実行し、失敗しても段1以降を止めない** | long |
| **0.5 ✅** | **静的確認2点** (下記) | 2点とも確認済み。**モデル選定をここで決める** | short |
| **1 ✅** | 1タブ・小モデル (1〜2B 級 dense) | token が生成される。WebGPU / CPU のどちらで動いたかを記録 | medium |
| **2 ✅** | 同一PC・**3タブ** (client 1 + server 2) + device 割当ログ | **2ピアに層が分かれた状態**で token 生成。あわせて O1 / O3 / O7 をログで確認 ⚠️ **同一 GPU / 同一メモリなので「計算資源を束ねた証明」にはならない** | medium |
| **2.6 ✅** | **LAN-only バンドル検証** — peerjs をローカル vendor、`iceServers: []`、モデルもローカル配信 | 外部HTTP 0件 / ICE は host candidate のみ / 3タブ token 生成完走。**アダプタ遮断での再現のみ未実施** | medium |
| **2.7 ✅** | **localhost-origin → LAN-address PeerServer self-connect ゲート (1台)** (下記) | Peer ID が表示される / preflight 4項目 / 外部HTTP 0件。**2台目を持ち込む前に潰す** | short |
| **3 ←次** | **2台の物理PC、各自 `localhost`** (下記) — **TLS 不要** | RPC0 / RPC1 が別筐体のサーバータブに対応し、両方に layer が配置された状態で token 生成完走。あわせて O4 (mDNS / AP isolation) と転送スループット | medium |
| 4 | Hono signaling へ差し替え | PeerJS を外し、Hono 経由で DataChannel 開通 → token 生成 | medium |
| 5 | **1台に載らないモデルを複数PCで** | **単一タブでは載らないモデルが N ピアで動く。プロダクトの実証点であり、デモの最低ライン** | long |
| 6 | **共有URL / BYOD 用の trusted secure origin** (下記) — **製品統合問題として分離** | 通常設定のブラウザで単一 URL から `crossOriginIsolated === true` | 未定 |
| 7 | ストレッチ: より大きいモデル | 下記 | 余剰時間 |

## 段0.5 の内容 (静的確認)

| # | 確認すること | 方法 |
|---|---|---|
| 1 | **対象モデルの全演算をピアのバックエンドが実行できるか** (O0) | `grep -rn MUL_MAT_ID .work/llmlet/llama.cpp/ggml/src/ggml-webgpu/` → **現時点で0件を確認済み**。MoE を選ぶなら WebGPU ピアでは動かない (F14) |
| 2 | **実機の `maxStorageBufferBindingSize`** (F12) | `(await navigator.gpu.requestAdapter()).limits.maxStorageBufferBindingSize` を対象モデルの最大テンソルバイト数と突き合わせる。上限を超えるテンソルがあると `supports_op` が false を返して同じ行き止まりになる |

**モデル選定の分岐**: 1 の結果により、**デモには dense モデルを使う**のが既定路線になる。

fork と upstream の差分規模 (O6) はここに含めない。upstream 追随を判断する時点で調べればよい。

## 段2.6 — LAN-only バンドル (実施済み)

素の example は peerjs と bootstrap を CDN から読み、PeerJS は既定で Google STUN / PeerJS TURN を使う (F23)。**JS をローカル化しただけでは D1/D2 を満たさない。**

`scripts/make-lan-bundle.py` が次をまとめて行う。

1. `llmlet-mod.js` / `.wasm` / `llmlet.js` / `index.html` を集める
2. peerjs と bootstrap を vendor する (この1回だけネットワークが要る)
3. `index.html` を書き換える — CDN 参照をローカルへ、**`peerOptions.config = { iceServers: [] }` を注入**
4. `--model` を渡せば GGUF も同梱する

```bash
python scripts/make-lan-bundle.py <out> --model <gguf> --probe
npm --prefix tools/peerserver run start
python scripts/serve-runtime.py <out> --port 8888
```

### PeerServer 起動の穴を塞いだ

当初は `npx --package=peer peerjs --port 9000` で起動していた。**バンドル自体は外部HTTP 0件だったが、PeerServer の起動だけが npm registry を叩いていた** — fresh 環境では起動時点で D1/D2 を破る。`tools/peerserver` に `peer@1.0.2` を dependency として固定し、`npm --prefix tools/peerserver run start` で起動する形にした。

**offline のスコープ**: `node_modules/` は commit しないので、**fresh clone では `npm ci --prefix tools/peerserver` にインターネットが要る**。示せるのは「**準備完了後、実行中はインターネット不要**」まで。D1/D2 は**実行時の通信制約**として扱う。

⚠️ **`npm install --prefix tools/peerserver` に書き換えないこと。** この環境 (npm 10.9.4) では `ENOENT` になる — `--dry-run` でも同じ。**原因は未調査**であり、npm 一般の挙動として断定はしない (公式ドキュメントは `--prefix` を「cwd を変えずに別ディレクトリでコマンドを実行する」用途として載せている)。`npm ci --prefix tools/peerserver` は実測で成功する。加えて `ci` は lockfile を要求し `package.json` と不一致なら失敗し lockfile を書き換えないので、**pin した依存を再現する用途には元々こちらが適している**。

### 「外部0件」の確かめ方

**DevTools の Network だけでは不十分。** WebRTC の STUN/TURN は fetch/XHR 一覧に出ない。3系統で見る。観測コードは `scripts/lan-probe.js` にあり、`make-lan-bundle.py --probe` で注入される。

| 対象 | 方法 | 実測結果 |
|---|---|---|
| HTTP 資産 | `performance.getEntriesByType('resource')` を非ローカル origin でフィルタ | **0件** |
| ICE 設定 | `RTCPeerConnection` をラップして引数を記録 | **`{iceServers: []}`** |
| 実際の ICE 経路 | 同ラッパで candidate の `typ` を収集 | **`host` のみ** (srflx / relay なし) |

`chrome://webrtc-internals` で選ばれた candidate pair を見るのは**任意のクロスチェック**。ラッパ側は config も採れるのでそちらを主系にする。

⚠️ **probe は `peerjs.min.js` より「後」に読み込むこと。** PeerJS 1.5.5 は module load 時の feature detection で `new RTCPeerConnection(DEFAULT_CONFIG)` + `createDataChannel("_PEERJSTEST")` を実行し、その `DEFAULT_CONFIG` は `stun:stun.l.google.com:19302` と `turn:eu-0.turn.peerjs.com` / `turn:us-0.turn.peerjs.com` を含む (実バンドルを grep して確認)。probe を前に置くと**この self-test の config を拾って「STUN/TURN を使っている」と誤検知する**。同 IIFE は `createOffer` / `setLocalDescription` を呼ばないため **ICE gathering は起きず実通信も発生しない**ので、後ろに置いて取り逃す情報は無い。`make-lan-bundle.py` が `<script>` をこの位置に挿す。

**未実施**: ネットワークアダプタを物理的に遮断しての再現。観測した経路に外部は無いが、遮断試験まではやっていない。

## 段2.7 — localhost-origin → LAN-address PeerServer self-connect ゲート (実施済み)

段3 では PC-B のページが **PC-A の LAN IP にある PeerServer** へ繋ぐ。その配線のうち**1台で潰せる部分だけ**を、2台目・モデル・WebGPU 抜きで先に確認する。

```text
同一PC:
  page:       http://127.0.0.1:8888     (loopback origin = secure context)
  PeerServer: ws://192.168.0.26:9000    (自機の LAN address)
```

```bash
python scripts/make-lan-bundle.py <out> --peerserver 192.168.0.26:9000 --probe
npm --prefix tools/peerserver run start
python scripts/serve-runtime.py <out> --port 8888
```

### 何が言えて、何が言えないか

| | 項目 |
|---|---|
| **✓ 証明できる** | `peerserverAddress` の書き換え / PeerJS の host・port 設定 / PeerServer が LAN address で listen できる / **loopback origin から LAN address への HTTP + WebSocket がブラウザで成立する** / Peer ID 取得 |
| **✗ 証明できない** | PC-B → PC-A の Windows Firewall inbound / AP isolation / 物理 LAN 経路 / 別PC間の WebRTC・DataChannel・RPC |

**自機の LAN IP 宛ての接続は同一ホスト内で完結するので、物理 LAN を横断した証拠にはならない。**「段2.7 が通った = Firewall も通った」とは書かない。Firewall は段3 の頭で PC-B から `Test-NetConnection` で潰す。

### 実測結果 (2026-08-23)

| 確認したこと | 結果 |
|---|---|
| preflight | `origin: http://127.0.0.1:8888` / `isSecureContext: true` / `crossOriginIsolated: true` / `gpu: true` / `sab: "function"` |
| Peer ID 取得 | **成功。** ページ表示 `75e65500-e673-44c2-9b66-768720824805`、PeerServer 側ログも `Client connected: 75e65500-...` で一致 |
| 接続先 | `netstat` で `192.168.0.26:9000 <-> 192.168.0.26:50060 ESTABLISHED`。**loopback ではなく LAN address のソケットペア** |
| 外部HTTP | **0件。** 取得資産は `127.0.0.1:8888` の4件と `192.168.0.26:9000/peerjs/id` のみ |
| LNA 権限プロンプト | **介在しなかった** (F25)。`/peerjs/id` が 200 で返り WebSocket も開通 |
| probe の切り分け | 記録された ICE config は **0件** — PeerJS の self-test (Google STUN + PeerJS TURN) を拾っていない。ラッパ自体は生きており、合成的に1件作ると正しく捕捉した。⚠️ **これは「self-test を誤記録していない」ことの証拠であって、`iceServers: []` が実通信で使われた証拠ではない** — 段2.7 は signaling だけで DataConnection を作っていないため。後者の根拠は段2.6 (DataConnection 付きで config `{iceServers: []}` / candidate `host` のみを実測) |

**ブラウザ**: Chromium 148 (Claude 内蔵ブラウザ / Electron 42.9.2)。LNA の WebSocket 拡張は Chrome 147 で入っているのでこのビルドには含まれる。**当日使う Chrome では起動時に preflight をもう一度通すこと** — 1分で済む。

### 失敗したときの切り分け順

1. `peerserverAddress` の書き換え漏れ — バンドルの `index.html` を grep
2. PeerServer の bind アドレス — `netstat -an | grep :9000` が `0.0.0.0` を出しているか
3. PeerJS の host/port パース — `peerserverAddress.split(":")` の結果

**LNA は現行では該当しない** (F25) ので原因候補から外す。「権限プロンプトが出なかった = 未検証」ではなく「そもそも gate される方向ではない」。

## 段3 — 2台の物理PC、各自 `localhost` (TLS 不要)

**各PCが自機の `http://localhost:8888` を開く。** localhost は potentially trustworthy なので secure context になり、**TLS は要らない** (F24 は LAN-IP を origin にする構成の話)。

### 3タブにする — 2タブでは資源を束ねた証明にならない

requester は**自分自身の Peer ID だけ**を RPC 先から除外する (F22)。したがって同じ PC-A 上の別タブも正当な RPC ターゲットになる。

```text
PC-A (http://localhost:8888)
├─ requester tab  (?noserver=true で自身はサーバを起動しない)
└─ server tab A   ← PC-A の GPU
        │
        │ LAN WebRTC DataChannel
        ▼
PC-B (http://localhost:8888)
└─ server tab B   ← PC-B の GPU
```

**PC-A requester + PC-B server の2タブだと RPC デバイスが1個しかない。** token が出ても示せるのは「PC-A が PC-B へオフロードできた」までで、「2台の資源を束ねた」にはならない。

### 切り分けを純化する

モデルは **requester のローカル File 選択**を使う。URL 経路にすると HEAD / Range probe / 206判定 / IndexedDB がまだ走って切り分けが濁る。File にすれば **TLS / Hono / CORS / HTTP Range / モデル配信 / インターネット**が全部落ち、検証対象が **LAN 越しの signaling / DataChannel / RPC / 物理PC間の layer 分散 / token 生成**だけになる。

GGUF は **PC-A にだけあればよい**。RPC は必要なテンソルをピアへ送る構造なので、PC-B にモデルを置く必要はない。

### 用意するもの

**PC-A で1回だけ clean build し、その成果物を PC-B へ丸ごとコピーする。PC-B では再生成しない。** こうすると「2台の runtime bytes が本当に同じか」という問いが消える。

段階ごとに**別のバンドル**を作る。ネットワークを変えると PC-A の IP が変わるので、古いバンドルを使う事故を防ぐ。

| 段階 | 出力 | `--peerserver` |
|---|---|---|
| A (同一PC 3タブ) | `build/stageA-local` | `127.0.0.1:9000` |
| B (物理2PC) | `build/stage3-lan` | **自前ルータに繋いで確定した** PC-A の IP |

段階B のバンドルは、**PC-A の新しい LAN IP が確定してから**作る。

```powershell
# 出力ディレクトリは再利用される構造なので、必ず消してから作る。
# 実際に、手編集された index.html が残ったまま「再生成成功」になった事故がある。
Remove-Item .\build\stage3-lan -Recurse -Force -ErrorAction SilentlyContinue
python scripts\make-lan-bundle.py build\stage3-lan --peerserver <確定したPC-A-IP>:9000 --probe

# 安全柵: STUN を手編集した経緯があるので毎回見る。0件であること。
Select-String .\build\stage3-lan\index.html -Pattern "stun:|turn:"

# manifest を保存し、PC-B へコピーした後に同じ値になることを確認する
Get-ChildItem .\build\stage3-lan -File | Get-FileHash -Algorithm SHA256
```

各PCで自機の loopback を開く。**PeerServer は PC-A だけ**で起動する。

```bash
python scripts/serve-runtime.py <out> --port 8888
npm --prefix tools/peerserver run start      # PC-A のみ
```

### 試行記録 (2026-08-25) — ネットワークが前提を満たさず無効

**通ったところ**: PeerServer signaling / 両筐体で WebGPU + RPC server 起動 / PC-B への incoming PeerJS connection (`received connection: <Requester ID>`)。
**止まったところ**: PC-A → PC-B の DataChannel が `connecting → failed`。`iceServers: []` でも Google STUN 追加でも同じ。

**この試行は O4 の検証になっていない。** 2台が別 IPv4 subnet にあり、PC-A から PC-B への直接経路が存在しなかった。

| 計測 (PC-A 上) | 結果 |
|---|---|
| PC-A | `192.168.0.26/24`、GW `192.168.0.1` |
| PC-A の routing table | **`192.168.1.0/24` へのエントリなし** |
| PC-A → PC-B (`192.168.1.106`) ping | 到達不能 |
| PC-A → PC-B tracert | `192.168.0.1 → 218.40.227.155 → 218.40.226.77 → 61.203.192.249` — **default route で ISP へ抜けて消える** |
| PC-A の Ethernet ネットワーク分類 | Public |
| PC-A の Chrome inbound firewall 規則 | mDNS (UDP) の1件のみ |

B→A:9000 の TCP が通ったのは**片方向**で、**A→B 方向は一度も確認していなかった**。

**確定**: D1/D2 を維持し relay を使わない条件で、PC-A → PC-B の直接経路が無かった。
**未確定 (仮説のまま)**: PC-B が別ルータ / NAT 配下にいるか / 両者の srflx が同一 public IP になり hairpin が要るか / mDNS 難読化が実際に経路を隠していたか。**candidate と candidate-pair を記録していなかったので、どれも測れていない。** これを測れるようにしたのが `scripts/lan-probe.js` の ICE 診断。

同じ試行中に `/restart` の WebGPU cleanup crash も観測した。**DataChannel 失敗とは別事象** (`CONSTRAINTS.md` O9)。

### まずネットワークが段3の前提を満たすか確かめる

上の失敗はここを見ていれば試行前に分かった。**モデルもブラウザも要らない。**

1. **両PCで `ipconfig` を実行し、IPv4 アドレスと subnet mask / prefix を記録する。**
   **同一 IPv4 subnet にいること**を確認する。`/24` である必要はない — `/23` でも `10.x` でも `172.16.x` でもよく、必要なのは「実際の prefix 上で同じ subnet」または「双方向に直接 routing 可能」なこと。
2. **`tracert <相手のIP>` を両方向で実行する。**
   **ISP のアドレスへ抜けたら、その時点で中止する。** private address が default route へ流れているということで、LAN として繋がっていない。これが 2026-08-25 の決定的な指標だった。
3. **ping を両方向で見る。**
   ⚠️ **routing の sanity check であって合否ではない。** Windows Firewall が ICMP だけ落とす構成があるので、**ping 失敗単独では WebRTC 不合格としない**。逆に ping が通っても UDP が通る保証はない。
4. **両PCで当該ネットワークの分類を Private にする。**
   Public プロファイルは inbound を強く絞る。`Get-NetConnectionProfile` で確認する。
5. **VPN と仮想 NIC を停止し、NIC を棚卸しする (F30)。**
   `candidateTypes: ["host"]` は「STUN/TURN を使っていない」証拠にはなるが、**経路が意図した LAN NIC だった証明にはならない** —
   VPN・仮想・複数物理 NIC もすべて host candidate を出し、mDNS 難読化のせいで candidate アドレスからは NIC を判別できない。
   **可能なら意図した物理 NIC を各PC 1本だけ有効化する。** PC-A には Tailscale アダプタが存在するので特に注意。

   ```powershell
   Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name, InterfaceDescription, LinkSpeed
   Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress, InterfaceAlias, PrefixLength
   Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' }
   ```

   この一覧を **selected candidate pair と併せて**記録する。

### まず Firewall を潰す (段2.7 で証明できなかった部分)

PC-B から。モデルもブラウザも要らない。

```powershell
Test-NetConnection 192.168.0.26 -Port 9000
```

ここで落ちたら Windows Firewall の inbound 規則 (Private / Public プロファイル) を疑う。**段2.7 の合格はこの経路を一切保証しない** — 自機宛ての接続は同一ホスト内で完結するため。

### 開始前チェックリスト

**0-a. 段3 では `/restart` を使わない (O9)。**
`/restart` は WebGPU cleanup で落ちる可能性がある。物理2PC が `connected` → RPC0/RPC1 → layer 配置まで来たところで踏むと、**O4 の実験と O9 の再現が混ざって両方とも読めなくなる**。O9 の確認は**段階A (同一PC) で単独に**行う。段3 で復帰が必要なときは reload → Peer ID 再入力。

**0-b. 段3 では ping ボタンを使わない (F27)。3タブすべて手入力する。**
ping は `BroadcastChannel('webrtc')` なので **PC-A 内の2タブにだけ届く**。押すと requester の `otherpeers` に server A だけが追記され、後から server B を足すと重複や順序の汚染が起きる。**その順序が RPC0 / RPC1 を決める**ので静かに事故る。

1. **古い Runtime タブを全部閉じる** — 前回 `777b5c45` / `ff4f075b` / `e8f025bb` の3枚が残っていた
2. **stale PeerServer が居ないことを確認する** — 前回 `npx` 版が 9000 を掴んでいて測定を汚した

   ```powershell
   Get-NetTCPConnection -LocalPort 9000 -ErrorAction SilentlyContinue
   ```

3. **PC-A で fresh PeerServer を起動** — `npm --prefix tools/peerserver run start`
4. **キャッシュ削除 — 同じファイル名で中身の違うモデルを使う場合だけ (F26)。**
   **内容を変えていないならこの手順ごと飛ばす**のが一番実験を汚さない。消すと RPC チャンクも道連れになる (F5)。
   段3 は requester の**ローカル File 選択**を使うので、キーになるのは**ディスク上のファイル名**であってバンドルの basename ではない。

   1. Runtime タブを全部閉じる
   2. PC-A で **requester ページだけ**開く — `http://127.0.0.1:8888/?noserver=true`
      `?noserver=true` なら `startServer` を呼ばず (`index.html:116`)、生成を始めるまで `runClient` も走らない (`index.html:212`) ので `ChunkCache` への接続が無い
   3. **生成は始めない**
   4. コンソールで削除を await する

      ```js
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase("ChunkCache");
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
        // blocked は「失敗」ではない。要求は pending のまま残る
        req.onblocked = () => reject(new Error("ChunkCache deletion blocked"));
      });
      ```

   5. `onsuccess` を確認してからページを reload する

   ⚠️ **`blocked` は削除要求をキャンセルしない。** `blocked` イベントは not cancelable で、**要求は生き続け、邪魔している接続が閉じた瞬間に削除が成功する**。上の reject は「検出」であって「中止」ではない。**放置すると、あとでタブを閉じた瞬間に静かに cache が消える。**

   **実測 (2026-08-23、別 origin `http://127.0.0.1:8890` で隔離して確認):**

   | 手順 | 結果 |
   |---|---|
   | 通常ページ (server 起動あり) で上の snippet | `REJECTED: ChunkCache deletion blocked` (2ms)。`databases()` に `ChunkCache` は**残ったまま** |
   | そのまま `?noserver=true` へ遷移し接続を閉じる | `databases()` が **`[]`** — **reject した削除が完了していた** |
   | 対照: `?noserver=true` で開いて snippet (DB は存在) | `onsuccess` に 1ms で到達、`databases()` は `[]` |

   つまり「blocked が出たので消えなかった」と判断して続行すると、**あとで消える。**

   **blocked が1度でも出たら、その段3 run は中止する:**
   1. Runtime タブを全部閉じる (pending だった削除がここで完了する)
   2. `?noserver=true` のページだけ開き直す
   3. 削除をもう一度実行し、**`onsuccess` まで到達すること**を確認する
   4. そこから段3 を最初からやり直す

   **合格条件は `onsuccess` に到達したことだけ。** `indexedDB.databases()` は**存在する DB の一覧であって開いている接続の一覧ではない**ので、そこに `ChunkCache` が無いことは接続が無いことの証明にならない。デバッグ表示として見るのは構わない。
5. **PC-B から到達性を確認** — `Test-NetConnection <PC-A の LAN IP> -Port 9000`
6. **両PCで自機の `http://localhost:8888` を開く**
7. **両PCで preflight** — `__lanProbe.preflight()` と **`await __lanProbe.gpu()`**
   `navigator.gpu` の存在だけでは adapter が取れる保証にならない。**PC-B の adapter と limits はここで採る** (PC-A は `maxStorageBufferBindingSize = 2147483644` / `maxBufferSize = 2147483648` / `nvidia turing`)
8. **Peer ID → 物理PC 表を埋める** (下記)
9. **`otherpeers` を役割ごとに手入力する** (下記)

   ⚠️ **リロードすると Peer ID が変わる。** 2026-08-25 はこれで `rejecting connection from unexpected peer:` を踏んだ。**どれか1枚でもリロードしたら、そのタブの新しい ID を関係する全タブの `otherpeers` に入れ直す。** これは F27 (ping ボタン) とは別の事故なので、ping を使わなくても起きる。
10. **requester から生成**
11. **ログを突き合わせる** (下記「合格条件」)
12. **3タブそれぞれで ICE 診断を回収する**

    ```js
    copy(JSON.stringify(__lanProbe.report(), null, 2))
    ```

    成否によらず取る。失敗した run こそこれが要る。`report()` は同期なので `await` は要らない。直前の状態変化時点のスナップショットで足りない場合だけ `await __lanProbe.refreshStats()` を使う。

**`otherpeers` の役割表**:

| タブ | 物理PC | 入れるもの |
|---|---|---|
| requester (`?noserver=true`) | PC-A | **server A ID, server B ID の順** — この順が RPC0 / RPC1 を決める |
| server A | PC-A | requester ID |
| server B | PC-B | requester ID |

全タブに全 ID を入れても動くが、役割ごとに絞る方が RPC index の事故が減る。

### 失敗したときの切り分け

**signaling → WebRTC → llmlet transport → llama RPC → model execution** のどこで止まったかを、症状から1段ずつ落とす。

| 症状 | 疑う層 |
|---|---|
| Peer ID が取れない | PeerServer / port 9000 |
| Peer ID は取れるが DataConnection が開かない | ICE / Windows Firewall / AP isolation |
| `rejecting connection from unexpected peer:` | `otherpeers` の入力ミス — **リロード後の Peer ID 更新漏れ**、または F27 の ping による汚染 |
| **DataConnection は開くが `using device RPC0 ...` が出ない** | **llmlet PeerManager / RPC handshake / server 側 Runtime** |
| RPC0 / RPC1 は出るがモデルロード・生成で死ぬ | WebGPU / メモリ / model placement |

**ネットワーク側か Runtime 側かを最初の1分で分ける**のが狙い。

#### DataConnection が開かないときは診断を読む

`__lanProbe.report()` の `connections[]` を、**失敗した接続の `peerId`** で引く。

| 診断で見えるもの | 読み方 |
|---|---|
| `candidates[]` が空 | gathering が始まっていない。ICE 以前 — signaling / SDP を疑う |
| `candidates[].isMdns` が true で、`stats.pairs` が全部 `failed` / `succeeded` が1つも無い | **mDNS 名を相手が解決できていない。** 同一 subnet に居ないか、マルチキャストが遮断されている |
| `remoteCandidates[]` が空 | 相手の candidate が届いていない。**片側の gathering か signaling の問題**であって自分の ICE ではない |
| `remoteCandidates[].isMdns` が true | **相手も難読化している。** 両側とも `.local` なら host 経路は subnet を跨げない |
| `candidateTypes` に `srflx` / `relay` が出る | **D1/D2 違反。** `iceServers: []` が効いていない (`iceConfigs` を確認する) |
| `candidateErrors[]` に `errorCode` がある | STUN/TURN へ出ようとして失敗している。LAN-only 構成なら**そもそも出ているのが異常** |
| `stats.selected` が null で `pairsEverObserved` に `succeeded` も無い | 疎通経路ゼロ。下の切り分け順へ |
| `stats.selected.local.addressSource` が `"signaled"` | stats が住所を伏せたので signaled candidate から取った値 (F29)。`matchedOn` が照合の強さ。⚠️ **これは signaling に載ったアドレスであって実 IP ではない** — `.local` なら `.local` のまま |
| `addressSource` が `"ambiguous-signaled"` | 候補が複数一致したので**採用していない**。`candidateMatches` に件数。**推測値を読まないこと** |
| `statsSnapshots` の `error` | その時点の `getStats()` が失敗した (接続破棄など)。診断の欠落であって疎通の失敗ではない |

**切り分け順** (成果物には入れない、手順のみ):

1. `isMdns` が true で pair が1つも `succeeded` にならない → **mDNS**。両PCの Chrome を `--disable-features=WebRtcHideLocalIpsWithMdns --user-data-dir=<temp>` で起動して再試験 (F28)
2. 素の IP candidate が出ているのに pair が成立しない → **firewall**。Chrome の inbound UDP を許可する
3. どちらでも駄目 → **AP isolation**。有線スイッチで切り分ける
4. ここまでで駄目なら初めて TURN を検討する。**D7 の変更提案になるので、勝手に採らずユーザー判断を仰ぐ**

### どのピアがどの物理PCかを記録する

RPC device の index は `otherpeers` 欄の記入順で決まる (`llmlet.js:849-856` が自分を除いて `-rpc` を順に push → `main.cpp:219-222` が順に登録 → `ggml-rpc.cpp:2103` の `dev_id` が単調増加)。**requester タブの `otherpeers` 欄に、意図した順で貼ること。**

| Peer ID | 物理PC | タブ役割 | `otherpeers` 欄での順位 | 対応する RPC index |
|---|---|---|---|---|
| | PC-A | server A | 1 | RPC0 |
| | PC-B | server B | 2 | RPC1 |

**突き合わせは2段**になる。

1. `llama_model_load_from_file_impl: using device RPC0 (<peer-id>) (...) - N MiB free`
   → **RPC index → Peer ID。** RPC backend が `dev_desc = endpoint` を入れており (`ggml-rpc.cpp:2104`)、llmlet では endpoint が Peer ID なので、この行だけで対応が取れる
2. `load_tensors: layer N assigned to device RPCk`
   → **層 → RPC index。** ⚠️ **この行は Peer ID を含まない** (`ggml_backend_dev_name(dev)` = `"RPC0"`)。1と繋いで読む。`LLAMA_LOG_DEBUG` なので `-d` 付きが前提 (llmlet は既定で付与)

### 合格条件

**PC-A の server タブと PC-B の server タブの両方に最低1層が配置され、その状態で token 生成が完走すること。**

上の表を埋めたうえで、1と2のログを両方残す。「RPC0 に layers 0-14」だけでは、**RPC0 がどの物理筐体だったかが後から辿れない**。

あわせて O4 (mDNS / AP isolation) と転送スループットもここで測る。O4 はモデル不要で検証でき、失敗すると全段が止まる。

**O4 を「解決した」と書くには、token が出たことに加えて ICE 側の証拠が要る** (`__lanProbe.report()` を3タブ分残す)。

| 見るもの | 合格 |
|---|---|
| `connectionState` | 物理PC間の接続が `connected` に到達 |
| `stats.selected` | **selected candidate pair を特定できる** — `selectedVia` が `transport.selectedCandidatePairId`、取れなければ fallback の `nominated+succeeded` |
| `candidateTypes` | `host` のみ。`srflx` / `relay` が出たら **D1/D2 違反**なので不合格 |
| `connectionsWithoutPeerId` | `0`。どの `RTCPeerConnection` がどのピア宛てか対応が取れていること |
| `externalResourceCount` | `0` |
| `mdnsLocalCandidateCount` / `mdnsRemoteCandidateCount` | **0 である必要はない。** `.local` のまま繋がったなら「mDNS がこのネットワークで解決できた」という積極的な結果で、O4 に対する答えとしてはむしろ強い |
| `ambiguousAddressCount` | 出たらその pair の住所は**採用しない**。診断が「一意に決められなかった」と言っている状態で、推測値ではない |
| `pairsEverObserved` | 失敗時に、**各 snapshot で観測できた pair の履歴**が残っていること |
| NIC 棚卸し | VPN / 仮想アダプタが落ちており、意図した物理 NIC の一覧が記録されていること (F30) |
| バンドル | PC-A / PC-B の全ファイルが**同一 SHA256** であること |

⚠️ `.local` が出ること自体は失敗ではない。**Chrome は loopback 同士でも難読化する** (F28)。判定するのは pair が成立したかどうか。

⚠️ **`pairsEverObserved` は「試された pair 全部」ではない。** ポーリングしていないので、状態遷移の合間に生成されて消えた pair は観測されない。**取得できた snapshot のいずれかで観測された pair の和集合**であって、それ以上ではない。

## 段6 — 共有URL / BYOD 用の trusted secure origin (製品統合問題)

**これは Runtime の 2PC 検証とは切り離す。** 「単一の URL を配って通常設定のブラウザから開かせる」ときにだけ必要になる問題であり、**段3 の前提条件ではない** (各PCが自機の localhost を開けば済む)。

`navigator.gpu` は Secure Context 限定であり、`SharedArrayBuffer` (= `-pthread` / `PROXY_TO_PTHREAD` に必須) も Secure Context + cross-origin isolation を要求する。**`http://localhost` は potentially trustworthy 扱いだが、`http://192.168.x.x` は違う。**

つまり**参加者に LAN IP の URL を配る構成**では、その瞬間に `navigator.gpu` が `undefined` になり WASM が起動しない。

**確認手順** (PC-B から PC-A のページを開き、コンソールで実行):

```js
console.log(navigator.gpu, crossOriginIsolated, typeof SharedArrayBuffer)
```

3つとも通れば合格。通らない場合の対処は2経路あり、**どちらを選ぶかで PeerServer 側の扱いが変わる**。経路を混ぜると signaling で詰まる。

### 経路 A: 開発用 Chrome フラグ (推奨・軽い)

各端末の Chrome を**2つのフラグをセットで**起動する。**`--user-data-dir` を併記しないとこのスイッチは効かない** (Chromium 公式)。

```text
--user-data-dir=<専用プロファイルのパス>
--unsafely-treat-insecure-origin-as-secure=http://<PC-Aのローカル IP>:8888
```

**ページは HTTP のままなので、PeerServer も HTTP/WS のままでよい。**

⚠️ **この経路ではページ origin が `local` address space になる**ため、段2.7 で確認した `loopback → local` の免除 (F25) は効かなくなる。**PeerServer も LAN IP で指すこと** — LAN IP のページから `localhost` の PeerServer へ繋ぐ形は `local → loopback` にあたり、Chrome のリリースノート上は LNA 対象と読める。仕様側の記述とズレているので断定はしないが、**わざわざその形にする理由が無い**。

### 経路 B: 自己署名 HTTPS

ページを HTTPS で配信し、証明書を全端末に信頼させる。**この場合 PeerServer も TLS/WSS 化するか、リバースプロキシ配下に置く必要がある。**

理由: PeerJS はカスタム host 利用時、ページが HTTPS なら `secure` を自動的に true にする。**ページだけ HTTPS にして PeerServer を平文の 9000 で立てると、今度は signaling 側が WSS を要求して繋がらない。**

**どちらもそれ自体が作業なので、段3 の見積もりに含めること。**

### 検証状況 (2026-08-23)

| 経路 | 状態 |
|---|---|
| plain `http://` LAN IP | **不可を実測 (F24)。** COOP が無視され `crossOriginIsolated: false` |
| 経路 A: Chrome フラグ | 未検証 |
| 経路 B: 自己署名 HTTPS | **サーバ側は動作確認済み** (`scripts/serve-runtime.py --cert --key`、curl で 200、SAN に IP を含む証明書を生成)。**ブラウザ側は未達** — 信頼していない証明書は警告で止まり、検証に使ったブラウザはナビゲーション自体を拒否した。**残る問題は「参加者端末に証明書をどう信頼させるか」だけではない** — ブラウザで `isSecureContext` / `crossOriginIsolated` / `navigator.gpu` / `SharedArrayBuffer` を通すまでは **server-side 準備済み / browser end-to-end 未検証** の扱い (O8)。なお **HTTPS にしただけでは足りず**、`SharedArrayBuffer` には COOP/COEP による cross-origin isolation が引き続き必要 |

**失敗時の退避**: 全員が同じ PC で複数タブ (段2 構成) に即座に戻す。ただし退避先の状態を正確に分けておく。

| 退避先 | 状態 |
|---|---|
| **技術 fallback** (同一PC3タブで層分散 → token 生成) | **確認済み** |
| **LAN-only デモ fallback** (D1/D2 準拠) | **確認済み (段2.6)** — `scripts/make-lan-bundle.py` の生成物で外部HTTP 0件・ICE host のみ・token 生成完走。⚠️ **ネットワークアダプタを遮断しての再現だけは未実施**なので、「観測した通信経路には外部が無い」であって「物理的に遮断しても動く」までは示していない |

## 段7 (ストレッチ) の合格条件

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
| 段2.6 (LAN-only) が通らない | **合格済み。** 再実行が必要になった場合のみ: 外部依存が残ったままでは D1/D2 を満たせないので、依存元を特定して潰すまで先へ進まない |
| 段2.7 (LAN-address signalling) が通らない | **合格済み。** 会場の別ネットワークで再実行して落ちた場合は、PeerServer の到達性を潰すまで段3 へ進まない |
| 段3 (2物理PC) が成立しない (O4: mDNS / AP isolation 等) | 段2 (同一PC**3タブ**) をデモ構成として**凍結**し、以降は演出とログ可視化に全振りする |
| 段5 (1台に載らないモデル) が成立しない | 段4 までの **2PC distributed** をデモの到達点として固める |

**Plan B の合格条件**: **3タブ (client 1 + server 2)** で層が分かれた状態のトークン生成 + 層配分ログの画面表示。「複数の実行単位にモデルが分かれている」ことが目で見えれば、コンセプトは伝わる。

⚠️ **2タブでは層が割れない** (F22)。Plan B を2タブで設計すると退避先が存在しなくなる。

ロールバック計画は YAGNI 違反ではなく、Acceptance Criteria の一部として扱う。
