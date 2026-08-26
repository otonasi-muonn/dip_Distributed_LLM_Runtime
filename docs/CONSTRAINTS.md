# 技術制約

`AGENTS.md` の分類に従い「検証済み / 仮説 / 未解決」を区別する。**検証済み項目には、それが何の実装について確認された事実かを併記する** — llmlet 参照実装で成り立つことが、移植後の自分たちの Runtime でも成り立つとは限らないため。

## 対象リビジョン

- **llmlet**: `730bad2f5b4d6598f55b09eb22d54b5bf2a467ed` (`scripts/build-llmlet-reference.ps1` の pin。確認時点で `main` と identical)
- **llama.cpp**: ⚠️ llmlet が pin しているのは **upstream ではなく `ktock/llama.cpp` フォーク**。`c4b18b39dbebb29d2f9f934dd0b136a9493a962e` (branch `rebase-20260401`)。フォークである事実は `.gitmodules` の URL、commit と branch は `git -C .work/llmlet submodule status` で確認 (`.gitmodules` には URL しか書かれていない)

**この2点は上流が更新されたら再確認が必要。** 特に llama.cpp がフォークである点は、upstream のドキュメントに書いてある挙動をそのまま前提にできないことを意味する。

## 検証済み

### メモリ

| # | 事実 | 対象実装 |
|---|---|---|
| F1 | `MEMORY64=2` は「wasm64 for clang/lld だが Binaryen で wasm32 に lowering し、wasm32 エンジン上で動かす」モード。`MAXIMUM_MEMORY` の既定は 2GB で、llmlet は 4GB を明示指定。**4GB が天井であり、超えるには `MEMORY64=1` (真の wasm64) が必要** | llmlet build 設定 / Emscripten 公式 |
| F2 | llmlet README は「CPU backend の available heap は最大 2GB」「Wasm module の maximum heap は 2GB」と書いているが、**Makefile は 4GB を指定しており矛盾している**。実効値は未測定 | llmlet README / `Makefile` |

### モデルロード

| # | 事実 | 対象実装 |
|---|---|---|
| F3 | モデルファイルは MEMFS に丸ごと常駐しない。`addRemoteFile()` が `FS.createDataFile(..., new Uint8Array(0), ...)` で空ファイルを作り `node.size = size` を設定、`stream_ops.read` オーバーライドでオンデマンド取得する。`chunkMax = 100000000` (100MB)、`maxEntries = 5`。HTTP は `Range: bytes=0-1` で 206 を判定してレンジ取得し、`"chunk:" + fileID + ...` キーで IndexedDB へキャッシュ | llmlet `llmlet.js` |
| F4 | **`status != 206` の場合、`fetchModel()` が `response.body.getReader()` でストリーム読みし、100MB の `Uint8Array` を1本使い回して IndexedDB へ順次 `put` する。**その後 `addRemoteFile()` は通常通り設置され、読み出しは chunkcache から行われる。**WASM linear memory は増えない** | llmlet `llmlet.js` |
| **F26** | **chunk cache のキーは内容を見ていない。** ローカル File 選択は `digestStr(file.name)` = **ファイル名だけ**、URL 指定は `digestStr(modelURL)`。`chunkCache()` は素の IndexedDB key→value ストア (`ChunkCache` / `chunks`) で、**サイズ検証も内容ハッシュもバージョンも無い**。キーが `chunk:<fileID>:<start>-<end>` なので、サイズが変わっても**重なる範囲は古い chunk を掴む** → GGUF が部分的に壊れ「再現しない失敗」になる。**顕在化する経路は一様ではない** — 非206経路は `fetchModel()` が cache ヒット判定なしで**無条件に**呼ばれ全 chunk を `put()` し直すため上書きされて表面化しにくい (`llmlet.js:657-663`)。**直撃するのは ①ローカル File 選択 (段3 はこれ) ②Range 対応 URL (段4 の Hono 等)**。**軽減**: モデル固有のファイル名を使う — ただし**衝突確率を下げるだけで解決ではない**。パスが違っても `file.name` は同じになりうる (`2026-08-23版/Qwen7B-Q4.gguf` と `2026-08-24版/Qwen7B-Q4.gguf` はどちらも `Qwen7B-Q4.gguf`)。**同じ名前で中身を差し替えたときは `ChunkCache` を消すしかない。** ⚠️ **消すときは `?noserver=true` のページから** — `runServer` が起動直後に `chunkCache()` を開き (`llmlet.js:707-708`)、`index.html:116` は `?noserver=true` でなければサーバを自動起動するので、通常のページを開いた後だと `deleteDatabase` が blocked になる。⚠️ **`blocked` は削除要求をキャンセルしない** (not cancelable、要求は pending のまま残り接続が閉じた瞬間に成功する) ので、blocked を検出したら run ごとやり直す — 手順は `EXPERIMENTS.md` 段3 の開始前チェックリスト。⚠️ **F5 の `rpcchunk:` キーは同じストアに同居する**ので、消すと RPC チャンクキャッシュも一緒に消える (O3 の再転送量を測る回では測定が変わる) | llmlet `llmlet.js:533-570,637,653,707` / `examples/simple/index.html:116` |
| F13 | モデルサイズは `fetch(modelURL, { method: 'HEAD' })` の `content-length` から取得し `node.size` に設定する。**ヘッダが無いと `headers.get()` は `null` を返し、`Number(null) === 0` なので `size` が 0 になる**（`NaN` ではない）。0 バイトの仮想ファイルが作られ、`chunkSize = 0` → `Range: bytes=0--1` が失敗して `ErrnoError` になる (**沈黙して壊れるのではなく、ロードエラーで落ちる**) | llmlet `llmlet.js` / ECMA-262 |

### 分散・演算子

| # | 事実 | 対象実装 |
|---|---|---|
| F14 | **`ggml-webgpu` に `GGML_OP_MUL_MAT_ID` の実装が存在しない** (backend 全体で grep 0 件、`mul_mat_id.wgsl` も無し)。`supports_op` の switch にも case が無く `default` 落ちする。比較: CUDA 6 / Vulkan 9 / Metal 4 / CPU 2 ファイルに実装あり。**`MUL_MAT_ID` は MoE のエキスパート FFN そのもの** | llama.cpp フォーク `ggml-webgpu.cpp` |
| F12 | **`ggml_backend_webgpu_device_supports_op` は冒頭で `maxStorageBufferBindingSize` によるハードゲートを持つ。** `op` / `src0` / `src1` / `src2` のいずれかの `ggml_nbytes` が上限を超えると `supports_op` が false を返す。この上限はデバイス依存。**実測 (NVIDIA Turing / Chrome): 2048 MiB** — Q4 の単一テンソルは遥かに小さいため、この規模では実害なし。内蔵GPU/モバイルでは小さくなりうるので機種ごとに測る | llama.cpp フォーク `ggml-webgpu.cpp` |
| F15 | `ggml_backend_rpc_device_supports_op` は `op` を見ずに**無条件 `true` を返す** (コード内に `//TODO: call the remote backend and cache the results`)。client 側スケジューラは未対応 op でも RPC ピアへ投げる | llama.cpp フォーク `ggml-rpc.cpp` |
| F16 | `rpc_server::graph_compute` は `ggml_backend_graph_compute(backends[device], graph)` を呼ぶ。`ggml_backend_sched` を通さないため、**ピア側にスケジューラによる CPU フォールバックは無い** | llama.cpp フォーク `ggml-rpc.cpp` |
| F18 | `rpc_server` は**複数バックエンドを保持できる** (`rpc_server(std::vector<ggml_backend_t> all_backends)`、`device_count = backends.size()`)。しかし llmlet `main.cpp` は、WebGPU が使えれば **WebGPU 1個だけ**を登録し、CPU は `devices.empty()` のときのみ追加する | llama.cpp フォーク `ggml-rpc.cpp` / llmlet `main.cpp` |
| F17 | `main.cpp` は RPC デバイスがあればそれだけを `model_params.devices` に入れ、ローカルデバイスは `devices.empty()` のときのみ使う。**ピアが1台でも繋がっていれば、requester のローカルデバイスは配置対象に入らない** | llmlet `main.cpp` |
| F20 | **`ggml_backend_webgpu_device_get_memory` は実空き容量ではなく `maxBufferSize` (アダプタ上限の定数) を free / total の両方として返す** (コード内に `// TODO: for now, return maxBufferSize as both free and total memory`)。この値が RPC 経由でそのまま client へ渡る。**実測: 2台のピアがどちらも `2048 MiB free` と申告** (`using device RPC0 ... - 2048 MiB free`)。実 VRAM とは無関係 | llama.cpp フォーク `ggml-webgpu.cpp:3152-3156` |
| F21 | **入力層は常に CPU に固定される。** `pimpl->dev_input = { cpu_dev, ... }` (コメント: `there is very little benefit to offloading the input layer, so always keep it on the CPU`)。つまり `token_embd.weight` は必ず requester のローカル CPU = WASM linear memory に乗る。`main.cpp` は `use_mmap = false` なので mmap 回避もできない。**実測: Qwen2.5-0.5B (vocab 151936) で `CPU model buffer size = 89.26 MiB`** | llama.cpp フォーク `llama-model.cpp:2685-2687` / llmlet `main.cpp` |
| F22 | **クライアントは自分自身を RPC 接続先から除外する** (`if (peersList[i] == peer.peer.id) { continue; }`)。F17 と合わせると、**2タブ (client 1 + server 1) では RPC デバイスが1個しかなく、全層がその1ピアに乗る**。層を分けるには **3タブ以上 (client 1 + server 2)** が必要。**実測で確認済み** — 3タブ構成で layers 0-14 → RPC0 / 15-23 → RPC1 に分割され、トークン生成まで完走 | llmlet `llmlet.js:849-856` / llmlet README |
| **F24** | **plain `http://` の LAN IP では Runtime が起動できない。実測済み。** `http://192.168.0.26:8889` で COOP/COEP を正しく送っていても `crossOriginIsolated: false`、`SharedArrayBuffer: undefined`、`navigator.gpu: undefined` になる。Chrome のコンソールは明示的に `The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy. Please deliver the response using the HTTPS protocol. You can also use the 'localhost' origin instead.` と出す。**ヘッダの問題ではなく origin の問題なので、サーバ設定では直せない**。⚠️ これは **LAN-IP URL をページ origin にする構成**についての事実であって、複数PC構成一般の話ではない — **各PCが自機の `http://localhost` を開く構成なら secure context なので TLS は不要** | 実測 (Chrome / 2026-08-23) |
| F23 | **llmlet は `iceServers` を一切設定しない** (`llmlet.js` に該当文字列 0 件、`new Peer(options && options.peerOptions || {})` のみ)。PeerJS の既定 config は Google STUN と PeerJS TURN を含むため、**素の llmlet を使うとインターネットへ出る** | llmlet `llmlet.js` / PeerJS 既定 |
| F19 | `llama_model_default_params()` は `n_gpu_layers = -1`。フォークの `llama-model.cpp` は `params.n_gpu_layers >= 0 ? params.n_gpu_layers : hparams.n_layer + 1` と解決する。llmlet は `-ngl` 未指定時に `model_params.n_gpu_layers` を触らないため、**既定は全 layer offload** | llama.cpp フォーク `llama-model.cpp` / llmlet `main.cpp` |
| F7 | RPC は重みと KV キャッシュの両方を "in proportion to each device's available memory" で自動配分。`--tensor-split` で手動化可。公式に「Never run the RPC server on an open network or in a sensitive environment!」と明記 | ⚠️ **upstream llama.cpp のドキュメント**。実際にビルドされるのはフォークなので、挙動の一致は未確認 |
| F8 | 層粒度で分割されるため、**各ピアは最低1層分を保持できる必要がある**。並列化は未対応で各ピアは逐次評価。1サーバは同時に1クライアントのみ | 「1サーバ1クライアント」は `ggml-rpc.cpp:1900-1907` (`accept_peer` → `rpc_serve_client` がブロッキング) で確認。層粒度は `llama-model.cpp` の layer 割当。**並列化未対応は llmlet README のみが出典** |
| F5 | RPC チャンクも IndexedDB にキャッシュされる。`Module.ChunkCache.get/put`、キー `"rpcchunk:" + rawkey`。⚠️ **別ストアではなくモデル chunk と同じ `ChunkCache` / `chunks` を、キーの接頭辞だけ変えて共有している** (`Module.ChunkCache` は `chunkCache()` の戻り値そのもの) — したがって DB を消すと両方消える (F26) | llmlet `libllmlet.js` / `llmlet.js:630,708` |
| **F27** | **ping ボタンのピア発見は `BroadcastChannel('webrtc')` で、別筐体には届かない。** 同一 origin・同一 storage partition の context 間だけの通信であり、ネットワークプロトコルではない。**「効かない」ではなく「部分的に効く」のが危険** — 段3 の構成 (PC-A に requester + server A、PC-B に server B) では PC-A 内の2タブ間だけ届くので、ping を押すと `otherpeers` に **server A だけ**が `value += e.data.src + ','` で追記される。その後 server B を手入力すると、押した回数や入力順で重複や `B, A` の順序が起こりうる。**この順序が RPC0 / RPC1 を決める** (F22 と同じ経路)。受信側は `allowedPeers: (p) => options.getTargetNodes().includes(p)` で判定し、外れると `console.error("rejecting connection from unexpected peer:" + conn.peer)` を出して `conn.close()` する。**段2 / 2.6 が同一ブラウザだったので ping が全タブを埋め、`allowedPeers` は一度も噛まなかった。段3 では噛む** | llmlet `examples/simple/index.html:239-258` / `llmlet.js:133-137,730` / MDN Broadcast Channel API |

| **F28** | **Chrome の mDNS 難読化は既定で有効で、同一マシン内でも効く。** 実測 (Chrome 151 / 2026-08-25): `http://127.0.0.1:8888` の1タブ内に PeerJS ピアを2つ作って接続したところ、host candidate は両側とも `f20c036e-….local` になった。**loopback 同士でもこうなる**ので、段2 / 段2.6 が「host candidate のみ」で通っていたことは「素の IP が出ていた」ことを意味しない — mDNS 名が同一ホスト内で解決できていただけである。**難読化を切る手段は `chrome://flags` に依存しない**: 起動オプション `--disable-features=WebRtcHideLocalIpsWithMdns` (別プロファイルにするため `--user-data-dir` を併用)、または Enterprise ポリシー `WebRtcLocalIpsAllowedUrls`。⚠️ **どちらも成果物の前提にしない。** 会場は自前ルータなので、これは O4 が失敗したときの**一時的な切り分け手段**としてのみ使う | 実測 (Chrome 151 / 2026-08-25、`scripts/lan-probe.js`) / Chrome Enterprise policy `WebRtcLocalIpsAllowedUrls` |
| **F29** | **`getStats()` は mDNS candidate の `address` / `ip` を空文字列 `""` にして返す** (`undefined` ではない)。実測で `local-candidate` / `remote-candidate` の両方が `address: ""`, `ip: ""` になった。**`stat.address \|\| stat.ip \|\| null` と書くと空文字がそのまま通る**ので、住所が取れたように見えて実は空になる。したがって失敗した candidate-pair の住所を知るには、`onicecandidate` と `addIceCandidate()` で見た signaled candidate と突き合わせるしかない。**照合キーは `foundation` + `protocol` + `port` + `candidateType` + `priority` が使える** — 実測 (Chrome 151) で stats の `foundation` は SDP 行の foundation と一致し、`lan-probe.js` の strong tier が実際に当たった (`matchedOn`)。⚠️ **`component` は stats に存在しない**ので照合キーに使えない (`RTCIceCandidate.component` も `"rtp"`/`"rtcp"` という別表現)。⚠️ **これで得られるのは「signaling に載った candidate address」であって、実 IP ではない。** `.local` なら復元後も `.local` のままで、mDNS 名の背後にある実アドレスはここからは分からない。⚠️ 複数一致したときは**採用してはいけない** (`addressSource: "ambiguous-signaled"`)。remote 側は `addIceCandidate()` を包まないと一切見えない | 実測 (Chrome 151 / 2026-08-25、`scripts/lan-probe.js`) |
| **F30** | **`candidateTypes` が `host` だけでも「経路が意図した LAN NIC だった」証明にはならない。** `host` のみ (srflx / relay 0件) は「STUN/TURN を使っていない」証拠としては強く、D1/D2 の ICE 設定軸はこれで足りる。しかし **VPN・仮想 NIC・複数の物理 NIC もすべて host candidate を出す**うえ、F28 の mDNS 難読化で **candidate アドレスからはどの NIC 由来かを判別できない** (stats 側も F29 で伏せられる)。コード側では解けないので、**運用で担保する** — 試験前に VPN (Tailscale 等) と仮想 NIC を停止し、可能なら意図した物理 NIC を各PC 1本だけ有効化し、`Get-NetAdapter` / `Get-NetIPAddress` / `Get-NetRoute` を記録して selected candidate pair と併せて残す (`EXPERIMENTS.md` 段3 の事前確認) | F28 / F29 より導出。PC-A には Tailscale アダプタが存在する |

### Runtime glue / lifecycle

2026-08-26 の adapter 実装時に、pin 済み `libllmlet.js` / `main.cpp` / fork の `ggml-rpc.cpp` と、
**生成後の `build/reference-llmlet/llmlet-mod.js`** を突き合わせて確認した。

| # | 事実 | 対象実装 |
|---|---|---|
| **F31** | **`cache_get_inner` の `.catch` は `console.error` するだけで `Atomics.notify` しない。** `cache_get` は `Atomics.wait(HEAP32, ptr, -1)` でブロックしているので、`Module.ChunkCache.get()` が reject すると **その pthread は永久に戻らない**。`cache_put_inner` は `.catch` で `done(false)` を呼ぶので put 側は安全。⚠️ **`cache_get` / `cache_put` は `cache_dir` でガードされていない** — fork は file cache を JS bridge に差し替えており、`set_tensor_hash` が `HASH_THRESHOLD = 1MiB` 超のテンソルごとに `cache_get` を呼ぶ。つまり **peer 側モデルロードの hot path**。IndexedDB が quota などで失敗すると、エラーも timeout も出ないまま requester ごと固まる | llmlet `libllmlet.js:245-268` / fork `ggml-rpc.cpp:169-170,577,1237-1240,1316` |
| **F32** | **`__proxy` の有無で実行 thread が決まる。** `recv_peer` / `close_peer` / `connect_peer` / `accept_peer` / `cache_get` / `cache_put` / `get_next_prompt` は `'none'` = **呼び出し thread (RPC を回す pthread)**。`register_buf` / `close_peer_inner` / `*_inner` / `is_decoding_cancel` / `send_peer` は `'sync'` = **main thread**。pthread worker は自前の `Module` オブジェクトを持ち、main から渡るのは `onExit` / `onAbort` / `print` / `printErr` の proxy だけ (`knownHandlers`)。**したがって main thread の JS から pthread 側 `Module._connbuf` へは到達できない** | 生成 `llmlet-mod.js` / `libllmlet.js` |
| **F33** | **`_close_peer` は `Module._connbuf[fd]` を掃除しない**うえ、`register_buf` は `_connbuf[fd] == null` の初回だけ呼ばれる。さらに **RPC server は accept した fd を閉じない** (`close_peer` の唯一の呼び出しは client 側 `socket_t::~socket_t()`)。PeerManager 側が `release_conn` で free すると、fd 番号の再利用時に use-after-free。Web repo の `newFd()` は `FD_MAX = 1024` を巡回する。**`patches/0001` / `patches/0002` で修正**。⚠️ patch 後も、受信した thread と別 thread から `close_peer` が呼ばれた場合は元 thread 側の entry が残る (実測では同一 thread) | 生成 `llmlet-mod.js` / fork `ggml-rpc.cpp:114,1899-1907` / Web repo `peerManager.ts:73,171-183` |
| **F34** | **peer の exit は常に異常。** `ggml_backend_rpc_start_server` は healthy なら `while(true){ accept_peer(); rpc_serve_client(); }` で戻らない。一方 `ggml_backend_dev_init` 失敗時は early return し、`start_backend` が `return 0` → **main が exit code 0**。つまり「backend を1つも掴めなかった」が exit 0 として観測される | fork `ggml-rpc.cpp:1880-1907` / llmlet `main.cpp:57-76,200` |
| **F35** | **`_fd_write` / `_fd_read` は `proxiedFunctionTable` に載っており main thread で実行される。** したがって main thread の `Module.TTY.default_tty_ops.put_char` 差し替えでトークン出力を拾えるし、モデル仮想ファイルの `stream_ops.read` から main thread の `chunkCache` を参照できる | 生成 `llmlet-mod.js` |
| **F36** | **`Module.onExit` は main の return / `_emscripten_force_exit` の両方で発火する。** `_proc_exit` は main thread で `Module["onExit"]?.(code)` を呼び、`callMain` が積んだ keepalive は `exitOnMainThread` が pop する。`abort(what)` は**最初に** `Module["onAbort"]?.(what)` を呼んでから `___trap()` する | 生成 `llmlet-mod.js` |
| **F37** | **prompt は `n_ctx` バイト未満でなければならない。** `get_next_prompt_inner` / `get_system_prompt_inner` は `res = min(bytes, len)` のあと `HEAPU8.set([0], ptr + res)` を書き、バッファは `malloc(n_ctx)`。**ちょうど `n_ctx` バイトで 1 バイトはみ出す**うえ、バイト境界で切るので multibyte が割れる。⚠️ 上流 `llmlet.js` は生 JS 文字列を `charCodeAt` で書き込んでいたので、**そもそも日本語 prompt が壊れていた**。adapter は UTF-8 encode してからバイト長で検証する | llmlet `libllmlet.js:173-227` / `main.cpp:374,384-386` |
| **F38** | **fork の `read_raw_unsafe` は `errno == EAGAIN` で busy-retry する。** モデル仮想ファイルが `FS.ErrnoError(6)` を投げて非同期取得を待つ設計はこれに依存している (`emscripten_sleep` を挟まないので、main thread へ proxy される `_fd_read` の合間に取得が進む) | fork `llama-mmap.cpp:256-278` |

### Runtime 実測 (2026-08-26, Runtime-only harness)

patch 済み reference build (llmlet `730bad2f` + llama.cpp `c4b18b39` + `patches/0001,0002`) を
実ブラウザで動かして確認した。構成は同一 origin 2 タブ + BroadcastChannel、
Qwen2.5-0.5B-Instruct Q4_K_M、peer は WebGPU (NVIDIA Turing)。

| # | 事実 | 対象実装 |
|---|---|---|
| **F39** | **llama.cpp RPC client は RPC 操作ごとに socket を開閉する。** 1 回のモデルロード + 1 回の生成で **peer が accept した論理接続は 175 本** (in-app pane と実 Chrome で同値を再現)。同時に live なのは常に 1 本 (open → close → open の順で、重ならない)。⚠️ **今回と同程度の接続数 (1 peer / Qwen2.5-0.5B-Instruct Q4_K_M / 1 セッション 175 接続) が続く場合、Web repo の `FD_MAX = 1024` は約 6 世代で一周する。** この「6」は目安であって定数ではなく、接続数は peer 数・モデル・生成長で変わる。無条件に言えるのは **fd 番号の再利用が通常運用で起きる**ことまで。llmlet のコメント "the C code does frequent close and open of the socket" はこの意味だった | 実測 (Runtime-only harness) |
| **F40** | **`patches/0001` / `0002` は実行時に効いている。** peer 側 `fdmax=4` で 1 セッションを回すと fd 0-3 が **それぞれ 43-44 回再利用**される。⚠️ **2 つのブラウザで測った範囲が違うので分けて読むこと。** **in-app pane**: requester を stop したあとの最終値が **accepted=175 / registrations=175 / runtimeCloses=175 (lag 0)**。**実 Chrome (A9)**: **accepted=175 / registrations=175 / runtimeCloses=174 / live=1** — stop を実行していないため 1 本が in-flight のまま。したがって実 Chrome での 0002 判定は **`runtimeCloses + live == accepted`**。`registrations == accepted` は両方で成立。`runtimeCloses` が accepted に追随するのは **0002** (RPC server が accept した fd を閉じる)、`registrations` が追随するのは **0001** (`close_peer` が `_connbuf` slot を消すので `recv_peer` が再登録する) の直接証拠。⚠️ **ptr は毎回同じ値 (`102629376`) が返った** — `free` 直後の `malloc` が同じアドレスを返すので、**ptr の一致/不一致は判定に使えない** | 実測 (Runtime-only harness) |
| **F41** | **peer Runtime は requester の再起動をまたいで生き残る。** requester を 4 セッション作り直しても peer は無再起動で `accept_peer()` へ戻り続け、**peer 側のエラーログは 0 件**。2 回目以降のセッションも実生成に成功した | 実測 (Runtime-only harness) |
| **F42** | **O9 の分類は cross-thread (context affinity) 違反。double-destroy でも earlier-release でもない。** emdawnwebgpu の `WebGPU.Internals.jsObjects` は **Emscripten module instance ごと**に存在し、`proxiedFunctionTable` に emwgpu 系は 1 つも無い。`-sPROXY_TO_PTHREAD` なので WebGPU handle は `main()` を走らせる pthread の table に入るが、`exitRuntime()` は pthread では即 return し、`___funcs_on_exit()` (= `__cxa_atexit` の static destructor) を **browser main thread でのみ**実行する。その thread の table は空。所有権を壊しているのは **ggml-webgpu** が WebGPU global context を関数ローカル static (`ggml-webgpu.cpp` の `ggml_backend_webgpu_reg()`) に置いていること。**実測 (2026-08-26, in-app pane, 2タブ + 実GGUF + 実RPC生成 + graceful stop)**: 問題の ptr は全 run・全 context で **SET 1 回 (pthread 側) と MISS 1 回 (main thread 側) のみ、DEL はどこにも無い**。落ちた context は `tableKeys=0` / `setTotalHere=0`。MISS は `DTORS-BEGIN` の直後、`_emwgpuBufferDestroy` → `getJsObject` の中。`~llama_context` の完了ログはその前。**requester だけが落ちて peer が無傷な理由も判明** — peer は `ggml_backend_webgpu_backend_init` が作った `webgpu_context_struct` を生かしたままなので (`ggml_backend_rpc_start_server` が戻らない) shared_ptr の refcount が 0 にならず `~webgpu_global_context_struct` 自体が走らない。requester はローカル WebGPU backend を持たず static だけが保持者なので refcount が 0 になる。**`patches/0003` で解消済み** (F44) | 実測 (Runtime-only harness + 生成 JS の読解) |
| **F44** | **`patches/0003` (Emscripten 限定で reg context を process/module lifetime にする) で O9 は解消。** 実測 A/B: 同一 harness・同一モデル・同一マシンで、**pre-fix バンドル (wasm `A881404F...`) は 4/4 セッションで `onError fired: requester Runtime aborted: Assertion failed`**、**patched バンドル (wasm `B87861C9...`) は 5/5 cycle が `ok` かつ note 空**。in-app pane と **実 Chrome の両方**で graceful stop が abort 無しに完了し、`onError` は一度も発火しない。stop 所要は pane 71-79 ms / 実 Chrome 282 ms で、force-exit fallback (`stopTimeoutMs=120000`) は未使用。⚠️ GPU メモリについて言えるのは **「cycle ごとの明白な増加なし」まで** — nvidia-smi はデバイス全体の粗いサンプルであり、意図的に lifetime を teardown へ委ねた修正なので **leak が無いことの証明にはならない** | 実測 (Runtime-only harness, pane + 実 Chrome) |
| **F43** | **in-app Browser pane は `document.hidden === true` でタブを動かす。** 同じセッションが 50s → 134s のように大きくぶれるので、**この環境の所要時間は性能指標として使えない**。機能判定にのみ使う | 実測 |

### その他

| # | 事実 | 対象実装 |
|---|---|---|
| F9 | Qwen3.6-35B-A3B は実在。Apache-2.0、35B総/**3B活性 MoE**、native context 262,144、Q4_K_M ≈ 20.4GB。vision は `mmproj` 別ファイル | Qwen 公式 / ggml-org |
| F10 | llmlet は MIT (`Copyright 2025 The LLMlet authors`)。改変・配布可だが著作権表示とライセンス文の保持が条件 | llmlet `LICENSE` |
| **F25** | **`loopback` origin から `local` (LAN IP) 宛ての通信は Local Network Access (LNA) の対象ではない。** WICG 仕様の address space 順序は `loopback < local < public` で、local network request は「destination が initiator より **less public**」なもののみ。さらに仕様は *"Requests originating from the loopback address should not be considered local network requests"* と loopback 起点を明示除外する。**したがって各PCが自機の `http://localhost` を開き、PC-A の LAN IP の PeerServer へ繋ぐ段2.7 / 段3 の構成は、LNA が gate する方向ではない。** ⚠️ **現行 Chrome における他の address-space 組み合わせについては、ここでは主張しない** — Chrome 142/147 のリリースノートは `local → loopback` も LNA request として記述する一方、WICG 仕様には「Chromium は現状 `public → local/loopback` しか実装しておらず cross-origin local requests は enforce していない」旨の注記があり、一次情報同士がズレている。必要になった段で実測する | WICG `local-network-access` 仕様 / Chrome 142・147 リリースノート。**実測 (段2.7)**: Chromium 148 で `http://127.0.0.1:8888` のページから `http://192.168.0.26:9000/peerjs/id` の取得と WebSocket 接続が権限プロンプト無しで成立 |

## 根本原因: クライアントはピアが実際に何を実行できるか見えていない

F12 / F14 / F15 / F16 は独立した不具合ではなく、**ひとつの構造的な穴の現れ**である。

1. ピア側のバックエンドには実行できない演算がある — 演算子が未実装 (F14)、またはテンソルが大きすぎる (F12)
2. しかし RPC デバイスは「何でも実行できる」と申告する (F15) ため、クライアントのスケジューラは判断材料を持たない
3. ピア側には CPU 退避が無い (F16) ため、届いた時点で行き止まりになる

つまり **「ピアが実行できない演算が、実行できないまま送られてくる」** のが本質。個別の演算子の話ではないので、`O0` はこの抽象度で追う。

### 現時点で分かっている具体例

- **MoE モデルは WebGPU ピアで動かない** (F14)。`DECISIONS.md` D8 の Qwen3.6-35B-A3B は MoE (F9) であり、**MoE を選ぶ理由 (活性3B なので遅い相互接続に有利) が、このバックエンドが唯一できないことと一致している**
- **単一テンソルが `maxStorageBufferBindingSize` を超えるモデルも同様に弾かれる** (F12)。こちらは MoE か dense かに関わらず起きうる

### 「ピアに CPU も登録すれば直る」は成り立たない

F18 の通り `rpc_server` 自体は複数バックエンドを持てるので、llmlet `main.cpp` にパッチを当てて WebGPU と CPU を両方登録することは可能に見える。**しかしこれだけでは直らない。** F15 によりクライアントは RPC デバイスの実サポートを知らないままなので、`MUL_MAT_ID` が WebGPU 側のデバイスへ割り当てられる可能性が残る。

実際に直すには **F15 (`supports_op` の TODO) も併せて実装する**必要がある。安い回避策は次の2つ。

- ピアを CPU バックエンドで動かす (`main.cpp` に `device_name == "cpu"` の分岐あり)。ただし F1 の 4GB 天井と CPU 速度が効く
- **dense モデルを選ぶ** — 現時点の推奨

### F8 の含意

ピアあたりメモリには**下限**がある。1層分を保持できない端末は何台増えても戦力にならない。

### F17 の含意 (ただし F21 で限定される)

「requester がモデル**全体**を保持するのでは」という懸念は、ピアが1台以上いれば構造的に発生しない。

**ただし requester のヒープ消費がゼロになるわけではない。** F21 により `token_embd.weight` は必ず requester の CPU に固定される。否定されたのは「全体が乗る」までであって、「モデル依存でスケールしない」ではない (O1)。

## 仮説

| 仮説 | 何を測れば決着するか |
|---|---|
| DataChannel (SCTP) の実効スループットが GB 級の重み配布のボトルネックになるのではないか | 1GB 転送を実測し線形外挿する。**デモ尺 (数分) に収まるかという製品制約に接続して判定する** |

## 未解決

| # | 問い | 何を測れば決着するか | 優先 |
|---|---|---|---|
| **O8** | **単一の LAN-IP URL を通常設定のブラウザから開かせる構成で、trusted secure origin をどう提供するか。** F24 より、その構成では TLS が要る。自己署名でサーバを立てること自体は確認済みだが (`--cert/--key`、curl 200、IP SAN)、**ブラウザ end-to-end は未検証** — 信頼していない証明書は警告で止まる。**自己署名を各参加者に信頼させる方式は、QR を読むだけのゼロ設定 BYOD と相性が悪い** (正当に信頼される証明書を用意できれば BYOD の道は残る) | 会場で使う端末の範囲を決める。なお **Runtime の 2PC 検証自体はこの問いを待たずに進められる** (各PCが自機の localhost を開けばよい) | **P1 (製品判断)** |
| **O0** | **対象モデルの全演算が、ピアのバックエンドで実行可能か** (上記「根本原因」節) | 実機の `maxStorageBufferBindingSize` を対象モデルの最大テンソルサイズと突き合わせる (F12)。MoE を使うなら F14 に該当。**デモに使うモデルを dense にするか、ピアを CPU で回すかの選択が必要** | **P0** |
| **O4** | `iceServers: []` で本当に繋がるか。Chrome は host candidate を `.local` (mDNS) へ難読化するため (F28 で実測)、mDNS 解決が失敗する環境 (ファイアウォール / マルチキャスト遮断) では疎通しない。AP isolation も同様 | 会場相当のネットワークで 2PC 接続を試す。**「LAN だからほぼ 100% 繋がる」は過信**。モデル不要・ブラウザ2台で検証でき、失敗時のインパクトが大きいので早期に着手する。⚠️ **2026-08-25 の 2PC 試行はこの問いに答えていない** — 2台が別 IPv4 subnet にあり PC-A から PC-B への直接経路が無かった (`EXPERIMENTS.md` 段3 の試行記録)。**失敗を O4 の否定として読まないこと** | **P0** |
| **O9** | **解決 (2026-08-26)。** 原因は cross-thread teardown (F42)、修正は `patches/0003` (F44)。graceful stop・peer 無再起動での世代交代・5 cycle 連続・実 Chrome まで abort 無しを実測。**残る未解決は O9 とは別件**: 1 つの peer が requester セッションを重ねるほど次の `ready` が遅くなる (patched で +約 8 s/cycle、**pre-fix でも +約 6 s/session** なので 0003 由来ではない)。peer を再起動すると 13.3 s へ戻る。Runtime 側の蓄積か harness ページ側 (peer タブのログ DOM が無制限に伸びる) かは**未切り分け** | 上記の切り分けを行う。O9 自体の再試験は不要 | P2 |
| O2 | GGUF 配信元が HTTP 206 Range を返すか。返さない場合のコストは、**4GB 天井ではなく** (F4 により WASM heap は増えない) 次の3つ: ①推論開始前に GGUF 全体を先読みするため起動が遅れる ②IndexedDB クォータを超えると `"failed to load model"` で即死 ③リロード時に途中再開できない | `curl -H 'Range: bytes=0-1' -i <url>` で 206 を確認。**`options.modelFile` (ローカルファイル選択) 経路を使えば回避できる** | P1 |
| O3 | generation 変更時の実再転送量。F3 (`chunk:`) と F5 (`rpcchunk:`) の2系統のキー空間がどれだけ効くか。**ストアは同一** (F5) なので、片方を消す手段は無い | 段2/3 で chunk cache の hit/miss と実転送バイト数を取る。⚠️ **`indexedDB.deleteDatabase('ChunkCache')` を挟むと両方消えて測定が変わる** (F26) | P1 |
| O5 | KV キャッシュのメモリ寄与。F7 より KV も配分対象 | **262,144 は対応上限であって使用義務ではない。** PoC では `n_ctx` を 2048〜4096 に明示指定して変数を減らす | P1 |
| **O7** | **層配分が壊れている可能性。** F7 の「available memory 比例配分」は、配分ロジックが各デバイスの `get_memory` を入力にしている。しかし WebGPU の実装は F20 の通り `maxBufferSize` を返すため、**配分の入力が実空きメモリではない**。

**実測 (同一GPU上の2タブ、両者とも 2048 MiB free と申告)**: 配分は等分にならず、layers 0-14 → RPC0 (129.37 MiB) / layers 15-23 → RPC1 (244.33 MiB)。出力テンソルが最終デバイスに載るため、層数もバイト数も偏る。`89.26 (CPU) + 129.37 + 244.33 = 462.96 MiB` でファイルサイズと一致するので取りこぼしは無い。

つまり「申告値が同一なら等分」という単純な予測は**成り立たない**。真のリスクは、`maxBufferSize` が実空きを超える端末で過剰割当 → ロード時 OOM になること | 段2 で各タブの `maxBufferSize` を出力し、`load_tensors: layer N assigned to device ...` のログと突き合わせる (10分)。回避策は `--tensor-split` だが、**`main.cpp` は `-ts` を parse していないので使うには改造が必要** | **P1** |
| O6 | フォークと upstream の差分がどれだけあるか。移植・upstream 追随の難度見積もり | サブモジュールに upstream remote を追加してから差分を数える。**upstream 追随を判断する時点で調べればよく、今すぐ必要ではない** | P1 |
| O1 | requester 側ヒープの下限。**F17 で否定されたのは「モデル全体が乗る」までで、ゼロにはならない** — F21 により `token_embd.weight` は必ず requester の CPU に乗り、大語彙モデル (Qwen 系は vocab 15万超) では数百MB になりうる。F1/F2 の 2〜4GB 天井と直接競合する | `gguf-dump` で `token_embd.weight` のサイズを見る (2分)。下限 = token_embd + ステージングバッファ + compute buffer | **P1** |

## セキュリティ

llama.cpp 公式は RPC について「Never run the RPC server on an open network or in a sensitive environment!」と警告し、実装を fragile かつ insecure な PoC と明記している (F7)。

この警告の実質は「**`ggml-rpc` は相手から来たテンソル記述子をデシリアライズして自プロセスのメモリを操作する**」という点にあり、「LAN だから安全」では解消しない。信頼できないピアから DataChannel を受け入れること自体がリスク面を持つ。

Runtime 側の最小限の防御として、**想定外のピアからの DataChannel を受け入れない**ことを前提にする。制御プレーン側の対応は `handoff/web-repo-corrections.md` を参照。

## 注意

`llmlet-mod.wasm` がビルドできることは、ブラウザ推論・WebGPU・多ピア RPC が動く証明ではない (llmlet README が明記)。この区別を崩さないこと。
