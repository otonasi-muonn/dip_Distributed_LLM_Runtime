# 技術制約

`AGENTS.md` の分類に従い「検証済み / 仮説 / 未解決」を区別する。**検証済み項目には、それが何の実装について確認された事実かを併記する** — llmlet 参照実装で成り立つことが、移植後の自分たちの Runtime でも成り立つとは限らないため。

## 対象リビジョン

- **llmlet**: `730bad2f5b4d6598f55b09eb22d54b5bf2a467ed` (`scripts/build-llmlet-reference.ps1` の pin。確認時点で `main` と identical)
- **llama.cpp**: ⚠️ llmlet が pin しているのは **upstream ではなく `ktock/llama.cpp` フォーク**。`c4b18b39dbebb29d2f9f934dd0b136a9493a962e` (branch `rebase-20260401`)。`.work/llmlet/.gitmodules` で確認

**この2点は上流が更新されたら再確認が必要。** 特に llama.cpp がフォークである点は、upstream のドキュメントに書いてある挙動をそのまま前提にできないことを意味する。

## 検証済み

### メモリ

| # | 事実 | 対象実装 |
|---|---|---|
| F1 | `MEMORY64=2` は「wasm64 for clang/lld だが Binaryen で wasm32 に lowering し、wasm32 エンジン上で動かす」モード。`MAXIMUM_MEMORY` の既定は 2GB で、llmlet は 4GB を明示指定。**4GB が天井であり、超えるには `MEMORY64=1` (真の wasm64) が必要** | llmlet build 設定 / Emscripten 公式 |
| F2 | llmlet README は「CPU backend の available heap は最大 2GB」「Wasm module の maximum heap は 2GB」と書いているが、**Makefile は 4GB を指定しており矛盾している**。実効値は未測定 | llmlet README / `Makefile` |
| F12 | WebGPU のバッファは `maxStorageBufferBindingSize` で上限が決まる (`ggml_backend_webgpu_buffer_type_get_max_size` がこの値をそのまま返す)。この値はデバイス依存で、内蔵GPU/モバイルでは 128MiB のこともある | llama.cpp フォーク `ggml-webgpu.cpp` |

### モデルロード

| # | 事実 | 対象実装 |
|---|---|---|
| F3 | モデルファイルは MEMFS に丸ごと常駐しない。`addRemoteFile()` が `FS.createDataFile(..., new Uint8Array(0), ...)` で空ファイルを作り `node.size = size` を設定、`stream_ops.read` オーバーライドでオンデマンド取得する。`chunkMax = 100000000` (100MB)、`maxEntries = 5`。HTTP は `Range: bytes=0-1` で 206 を判定してレンジ取得し、`"chunk:" + fileID + ...` キーで IndexedDB へキャッシュ | llmlet `llmlet.js` |
| F4 | **`status != 206` の場合、`fetchModel()` が `response.body.getReader()` でストリーム読みし、100MB の `Uint8Array` を1本使い回して IndexedDB へ順次 `put` する。**その後 `addRemoteFile()` は通常通り設置され、読み出しは chunkcache から行われる。**WASM linear memory は増えない** | llmlet `llmlet.js` |
| F13 | モデルサイズは `fetch(modelURL, { method: 'HEAD' })` の `content-length` から取得し `node.size` に設定する。**HEAD が Content-Length を返さないと `size` が `NaN` になり、以降が静かに壊れる** | llmlet `llmlet.js` |

### 分散・演算子

| # | 事実 | 対象実装 |
|---|---|---|
| F14 | **`ggml-webgpu` に `GGML_OP_MUL_MAT_ID` の実装が存在しない** (backend 全体で grep 0 件、`mul_mat_id.wgsl` も無し)。`supports_op` の switch にも case が無く `default` 落ちする。比較: CUDA 6 / Vulkan 9 / Metal 4 / CPU 2 ファイルに実装あり。**`MUL_MAT_ID` は MoE のエキスパート FFN そのもの** | llama.cpp フォーク `ggml-webgpu.cpp` |
| F15 | `ggml_backend_rpc_device_supports_op` は `op` を見ずに**無条件 `true` を返す** (コード内に `//TODO: call the remote backend and cache the results`)。client 側スケジューラは未対応 op でも RPC ピアへ投げる | llama.cpp フォーク `ggml-rpc.cpp` |
| F16 | `rpc_server::graph_compute` は `ggml_backend_graph_compute(backends[device], graph)` を**単一バックエンドに対して直接呼ぶ**。`ggml_backend_sched` を通さないため、**ピア側に CPU フォールバックは無い** | llama.cpp フォーク `ggml-rpc.cpp` |
| F17 | `main.cpp` は RPC デバイスがあればそれだけを `model_params.devices` に入れ、ローカルデバイスは `devices.empty()` のときのみ使う。**ピアが1台でも繋がっていれば、requester のローカルデバイスは配置対象に入らない** | llmlet `main.cpp` |
| F7 | RPC は重みと KV キャッシュの両方を "in proportion to each device's available memory" で自動配分。`--tensor-split` で手動化可。公式に「Never run the RPC server on an open network or in a sensitive environment!」と明記 | ⚠️ **upstream llama.cpp のドキュメント**。実際にビルドされるのはフォークなので、挙動の一致は未確認 |
| F8 | 層粒度で分割されるため、**各ピアは最低1層分を保持できる必要がある**。並列化は未対応で各ピアは逐次評価。1サーバは同時に1クライアントのみ | llmlet README |
| F5 | RPC チャンク用に別系統の IndexedDB キャッシュが存在。`Module.ChunkCache.get/put`、キー `"rpcchunk:" + rawkey` | llmlet `libllmlet.js` |

### その他

| # | 事実 | 対象実装 |
|---|---|---|
| F9 | Qwen3.6-35B-A3B は実在。Apache-2.0、35B総/**3B活性 MoE**、native context 262,144、Q4_K_M ≈ 20.4GB。vision は `mmproj` 別ファイル | Qwen 公式 / ggml-org |
| F10 | llmlet は MIT (`Copyright 2025 The LLMlet authors`)。改変・配布可だが著作権表示とライセンス文の保持が条件 | llmlet `LICENSE` |

### F14 + F15 + F16 の合成 — 最重要

**MoE モデルは、WebGPU バックエンドのピアでは動かない。**

1. WebGPU に `MUL_MAT_ID` が無い (F14)
2. RPC デバイスは何でも対応していると申告する (F15) ので、client は構わず MoE の op をピアへ送る
3. ピア側は単一バックエンド直呼びで CPU 退避が無い (F16)

`DECISIONS.md` D8 の Qwen3.6-35B-A3B は MoE (F9) であり、**MoE を選ぶ理由 (活性3B なので遅い相互接続に有利) が、このバックエンドが唯一できないことと一致している。**

回避策は「ピアを CPU バックエンドで動かす」(`main.cpp` に `device_name == "cpu"` の分岐あり) だが、その場合 F1 の 4GB 天井と CPU 速度が効く。**dense モデルを選べばこの問題は発生しない。**

### F8 の含意

ピアあたりメモリには**下限**がある。1層分を保持できない端末は何台増えても戦力にならない。

### F17 の含意

「requester がモデル全体を保持するのでは」という懸念は、**ピアが1台以上いれば構造的に発生しない**。

## 仮説

| 仮説 | 何を測れば決着するか |
|---|---|
| DataChannel (SCTP) の実効スループットが GB 級の重み配布のボトルネックになるのではないか | 1GB 転送を実測し線形外挿する。**デモ尺 (数分) に収まるかという製品制約に接続して判定する** |
| ピア各機の `maxStorageBufferBindingSize` が、対象モデルの最大テンソルサイズを下回るのではないか (F12) | 実機で `(await navigator.gpu.requestAdapter()).limits.maxStorageBufferBindingSize` を出力し、`gguf-dump` の最大テンソルバイト数と突き合わせる (5分) |

## 未解決

| # | 問い | 何を測れば決着するか | 優先 |
|---|---|---|---|
| **O0** | 対象モデルの op を、ピアのバックエンドが実行できるか | F14/F15/F16 より **MoE は WebGPU ピアで不可**とほぼ確定。デモに使うモデルを dense にするか、ピアを CPU で回すかの**選択が必要** | **P0** |
| **O2** | GGUF 配信元が HTTP 206 Range を返すか。返さない場合のコストは、**4GB 天井ではなく** (F4 により WASM heap は増えない) 次の3つ: ①推論開始前に GGUF 全体を先読みするため起動が遅れる ②IndexedDB クォータを超えると `"failed to load model"` で即死 ③リロード時に途中再開できない | `curl -H 'Range: bytes=0-1' -i <url>` で 206 を確認。**`options.modelFile` (ローカルファイル選択) 経路を使えば回避できる** | P1 |
| O3 | generation 変更時の実再転送量。F3 / F5 の2系統キャッシュがどれだけ効くか | 段2/3 で chunk cache の hit/miss と実転送バイト数を取る | P1 |
| O4 | `iceServers: []` で本当に繋がるか。Chrome は host candidate を `.local` (mDNS) へ難読化するため、mDNS 解決が失敗する環境 (ファイアウォール / マルチキャスト遮断) では疎通しない。AP isolation も同様 | 会場相当のネットワークで 2PC 接続を試す。**「LAN だからほぼ 100% 繋がる」は過信**。モデル不要・ブラウザ2台で検証でき、失敗時のインパクトが大きいので早期に着手する | **P0** |
| O5 | KV キャッシュのメモリ寄与。F7 より KV も配分対象 | **262,144 は対応上限であって使用義務ではない。** PoC では `n_ctx` を 2048〜4096 に明示指定して変数を減らす | P1 |
| O1 | モデルロード中の requester 側 peak linear memory | **F17 によりほぼ決着済み** (ピアがいればローカルデバイスは配置対象外)。残るのは loader のステージングバッファと compute buffer で、これはモデル総サイズではなく最大テンソルサイズと `n_ctx` に比例する。段2 の device 割当ログで確認するに留める | P2 |
| O6 | フォークと upstream の差分がどれだけあるか。移植の難度見積もり | `git log --oneline origin/rebase-20260401 ^upstream/master` でコミット数を数える | P1 |

## セキュリティ

llama.cpp 公式は RPC について「Never run the RPC server on an open network or in a sensitive environment!」と警告し、実装を fragile かつ insecure な PoC と明記している (F7)。

この警告の実質は「**`ggml-rpc` は相手から来たテンソル記述子をデシリアライズして自プロセスのメモリを操作する**」という点にあり、「LAN だから安全」では解消しない。信頼できないピアから DataChannel を受け入れること自体がリスク面を持つ。

Runtime 側の最小限の防御として、**想定外のピアからの DataChannel を受け入れない**ことを前提にする。制御プレーン側の対応は `handoff/web-repo-corrections.md` を参照。

## 注意

`llmlet-mod.wasm` がビルドできることは、ブラウザ推論・WebGPU・多ピア RPC が動く証明ではない (llmlet README が明記)。この区別を崩さないこと。
