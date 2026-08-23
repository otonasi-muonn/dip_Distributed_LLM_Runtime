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
| F5 | RPC チャンク用に別系統の IndexedDB キャッシュが存在。`Module.ChunkCache.get/put`、キー `"rpcchunk:" + rawkey` | llmlet `libllmlet.js` |

### その他

| # | 事実 | 対象実装 |
|---|---|---|
| F9 | Qwen3.6-35B-A3B は実在。Apache-2.0、35B総/**3B活性 MoE**、native context 262,144、Q4_K_M ≈ 20.4GB。vision は `mmproj` 別ファイル | Qwen 公式 / ggml-org |
| F10 | llmlet は MIT (`Copyright 2025 The LLMlet authors`)。改変・配布可だが著作権表示とライセンス文の保持が条件 | llmlet `LICENSE` |

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
| **O4** | `iceServers: []` で本当に繋がるか。Chrome は host candidate を `.local` (mDNS) へ難読化するため、mDNS 解決が失敗する環境 (ファイアウォール / マルチキャスト遮断) では疎通しない。AP isolation も同様 | 会場相当のネットワークで 2PC 接続を試す。**「LAN だからほぼ 100% 繋がる」は過信**。モデル不要・ブラウザ2台で検証でき、失敗時のインパクトが大きいので早期に着手する | **P0** |
| O2 | GGUF 配信元が HTTP 206 Range を返すか。返さない場合のコストは、**4GB 天井ではなく** (F4 により WASM heap は増えない) 次の3つ: ①推論開始前に GGUF 全体を先読みするため起動が遅れる ②IndexedDB クォータを超えると `"failed to load model"` で即死 ③リロード時に途中再開できない | `curl -H 'Range: bytes=0-1' -i <url>` で 206 を確認。**`options.modelFile` (ローカルファイル選択) 経路を使えば回避できる** | P1 |
| O3 | generation 変更時の実再転送量。F3 / F5 の2系統キャッシュがどれだけ効くか | 段2/3 で chunk cache の hit/miss と実転送バイト数を取る | P1 |
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
