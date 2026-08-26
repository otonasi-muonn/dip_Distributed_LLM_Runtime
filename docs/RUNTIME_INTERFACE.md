# Runtime 公開インターフェース

このリポジトリ (Runtime) が Web アプリ側 (`RiTa-23/dip_Distributed_LLM`) に提供する境界を定義する。

---

## 引き渡しサマリ (2026-08-26)

**Runtime 側は Web 境界より下を実ブラウザで通した。** Web 側はこの節の 8 点だけ押さえれば統合を始められる。

| # | 項目 | 要点 | 詳細 |
|---|---|---|---|
| 1 | **成果物** | `build/web-runtime/` の `llmlet-mod.js` / `llmlet-mod.wasm` / `llmlet-runtime.js` を静的配信先へコピー。`BUILD_INFO.txt` / `SHA256SUMS.txt` も同梱される | [reference build](#reference-build--pin-済み-commit--patch) |
| 2 | **Runtime 起動 API** | `startRequester(options)` / `startPeer(options)`。両方 `ready` / `stop()` を持ち、requester は `generate()` / `cancel()` を持つ | [最小 API](#runtime-adapter-の最小-api) |
| 3 | **PeerManager 契約** | `connect` / `accept` / `send` / `recv` / `close_connection` / `register_buf` / `close` の 7 メソッド。Web repo の `apps/web/src/webrtc/peerManager.ts` が該当 | [PeerManager](#peermanager) |
| 4 | **モデル配信** | HEAD の `Content-Length` は必須。**Range 206 は実質必須** — 非対応だと起動のたびに GGUF 全体を IndexedDB へ先読みする | [model source](#model-source) |
| 5 | **`releaseBuf` を渡さない** | 受信バッファの所有権は WASM glue にある。free する callback を渡すと double free | [所有権](#受信バッファの所有権--peermanager-は-free-しない) |
| 6 | **timeout 後は Runtime を作り直す** | `generate()` に watchdog は無い。timeout したら `generate()` を再試行せず `stop()` → 新しい `startRequester()` | [watchdog](#generate-に-watchdog-は無い) |
| 7 | **既知欠陥 O9** | requester の graceful stop が WebGPU teardown で abort する。**peer は無傷で次の requester は正常に繋がる**が、stop はクリーンではない | [O9](#既知欠陥-o9--graceful-stop-が-webgpu-teardown-で-abort-する) |
| 8 | **確認済みの範囲** | 実 Chrome + WebGPU + 実 GGUF + RPC 推論 + fd 再利用 cleanup まで確認済み。**Web 側の DataChannel / signaling は未確認** | [Gate A](#gate-a-で確認できたこと--できていないこと) |

### Gate A で確認できたこと / できていないこと

Runtime-only harness (PeerJS / WebRTC / Hono を使わず、同一 origin 2 タブ + BroadcastChannel) での実測。
詳細は [EXPERIMENTS.md](EXPERIMENTS.md)。

**確認済み**

- 実 Chrome で `crossOriginIsolated` / `SharedArrayBuffer` / `navigator.gpu` が揃う
- WebGPU peer (NVIDIA Turing) が RPC server として起動する
- requester が Qwen2.5-0.5B-Instruct Q4_K_M を **206 Range 経由**でロードし、
  `load_tensors: layer 0..24 assigned to device RPC0` で peer へ layer が乗る
- **実際の日本語生成が完走する**
- requester を作り直しても **peer は無再起動で次のセッションを受ける**
- **fd 再利用時の cleanup が効く** — peer 側 4 fd で accepted=175 / registrations=175 /
  runtimeCloses=175 (lag 0)

**未確認 — ここを「動く」と読まないこと**

- Web repo の `peerManager.ts` (DataChannel 実装) を差した状態
- SCTP backpressure / MTU / mDNS / TLS / Hono signaling
- **実 Chrome での graceful stop** (O9 のため未実行)
- 長時間 soak、メモリ傾向、複数 peer での layer 分割

---

## 2026-08-25 時点の結論

以前想定していた次の3関数は、現在の責務分担ではそのまま実装しない。

```ts
startWasmClient(dataChannels: Record<string, RTCDataChannel>): Promise<void>
onToken(callback: (token: string, done: boolean) => void): void
startWasmPeerServer(onDataChannel: (channel: RTCDataChannel) => void): Promise<void>
```

Web repo 側ではすでに Hono signaling / `RTCPeerConnection` / `RTCDataChannel` の確立と、llmlet の C/JS bridge が要求する `Module.PeerManager` の実装まで存在する。

したがって Runtime は **WebRTC 接続そのものを作らない**。Web 側が開いた DataChannel を載せた `PeerManager` を Runtime の Emscripten Module に注入する。

```text
Web repo
  Hono signaling
      ↓
  RTCPeerConnection / RTCDataChannel
      ↓
  apps/web/src/webrtc/peerManager.ts
      ↓ inject
Runtime
  Module.PeerManager
      ↓
  libllmlet.js bridge
      ↓
  patched llama.cpp RPC
```

この境界なら、PeerJS は参照実装・実験 harness にだけ残し、本番 Web アプリのデータプレーンには持ち込まない。

## Runtime が Web 側へ渡すもの

最低限の成果物は次の3つ。

```text
llmlet-mod.js
llmlet-mod.wasm
Runtime adapter (本書の契約を実装する薄い JS glue)
```

`llmlet-mod.js` / `.wasm` は pin 済み llmlet commit `730bad2f5b4d6598f55b09eb22d54b5bf2a467ed` の再現ビルドを基準にする。

pin 済み Makefile はすでに以下を満たす。

- `-sEXPORT_ES6=1`
- `-sMEMORY64=2`
- `-sPROXY_TO_PTHREAD`
- `-sASYNCIFY=1`
- `-sEXPORTED_FUNCTIONS=_main,_emscripten_force_exit`
- `-sEXPORTED_RUNTIME_METHODS=FS,PThread,ENV,release_conn,TTY`

### reference build = pin 済み commit + patch

Runtime は **素の llmlet を配らない**。`patches/` に置いた最小 patch を当てたものが reference build。

| patch | 対象 | 内容 |
|---|---|---|
| `0001-llmlet-close-peer-free-connbuf.patch` | `libllmlet.js` | `close_peer()` が `Module._connbuf[fd]` を free して entry も削除する |
| `0002-ggml-rpc-close-accepted-fd.patch` | `ggml-rpc.cpp` | RPC server が accept した fd を `close_peer()` で閉じる |

理由は「受信バッファの所有権」節を参照。

`scripts/build-llmlet-reference.ps1` は pin へ `reset --hard` してから patch を当て、
**staging ディレクトリでビルドしてから成功時だけ出力先へ差し替える**。`BUILD_INFO.txt` は
最後に書かれ、llmlet commit / llama.cpp commit / 各 patch の SHA-256 に加えて
**生成された `llmlet-mod.js` / `.wasm` 自身の SHA-256** を記録する。

したがって:

- **docker build が失敗すると staging ごと消え、以前の成果物はそのまま残る。**
  失敗した run が valid な provenance を書き残すことはない
- **古い `.js` / `.wasm` と新しい `BUILD_INFO.txt` を並べても検証を通らない** —
  artifact hash が一致しない
- provenance だけ揃った不完全な成果物も通らない (`artifact=` 行の無い旧形式も拒否)

⚠️ ビルドが途中で失敗すると `.work/llmlet` は patch が当たった状態で残る。次回 run 冒頭の
`git reset --hard` が戻すので放置してよい (失敗の調査用にわざと残している)。

`scripts/export-web-runtime.ps1` は `build/web-runtime/` へ出力する **Runtime-only export** で、
`BUILD_INFO.txt` が pin と `patches/` に一致しない成果物を **拒否する**。patch 前の WASM を
誤って Web 側へ渡さないための gate なので、外さないこと。

```text
build/web-runtime/
  llmlet-mod.js
  llmlet-mod.wasm
  llmlet-runtime.js
  BUILD_INFO.txt
  SHA256SUMS.txt
```

## Web 側から Runtime に渡すもの

### `PeerManager`

Runtime が必要とする最小契約は llmlet `libllmlet.js` と同じ。

```ts
export type RuntimePeerManager = {
  connect(nodeId: string, done: (fd: number) => void): void
  accept(done: (fd: number) => void): void
  send(fd: number, data: Uint8Array): number
  recv(
    fd: number,
    len: number,
    writeCB: (chunk: Uint8Array) => void,
    doneCB: (ok: boolean) => void,
  ): void
  close_connection(fd: number): number
  register_buf(fd: number, ptr: number): void
  close(): void
}
```

Web repo `develop` の `apps/web/src/webrtc/peerManager.ts` がこの役を持つ。

DataChannel の signaling / SDP / ICE / framing / backpressure は Web 側の責務。Runtime adapter は `RTCDataChannel` を直接管理しない。

### 受信バッファの所有権 — PeerManager は free しない

`register_buf(fd, ptr)` は **記録のみ**に使うこと。**WASM buffer を free する callback を渡してはいけない。**

pin 済み glue の実挙動:

- `recv_peer()` は RPC を回している **pthread 上**で 1MiB を `malloc` し、その thread の
  `Module._connbuf[fd]` にキャッシュする。`register_buf()` は **slot が空のときだけ**呼ばれる。
- `_close_peer` は同じ thread で走る (`close_peer_inner` だけが main thread へ proxy される)。
- main thread の adapter から pthread の `Module._connbuf` には**到達できない** (worker ごとに別の
  `Module` オブジェクト)。

したがって main thread から `Module.release_conn(ptr)` を呼ぶと、`_connbuf[fd]` が free 済み領域を
指したまま残り、fd 番号が再利用された時点で use-after-free になる。Web repo の `newFd()` は
`FD_MAX = 1024` を巡回するので、これは理論上の話ではない。

解決は `patches/0001` — **buffer を確保した thread の `close_peer()` で free する**。所有権は
WASM glue の中だけにある。

- adapter の `releaseConn(ptr)` は **deprecated な no-op**。呼んでも安全だが意味は無い。
- `releaseBuf: Module.release_conn` のように**実際に free する関数**を渡すと **double free** になる。

### Peer IDs

Requester 起動時に、その generation で使う peer ID の**順序付き配列**を渡す。

```ts
peerIds: string[]
```

adapter はこれを llama.cpp の引数へ変換する。

```text
-rpc <peerIds[0]> -rpc <peerIds[1]> ...
```

この順序が RPC device の登録順になるため、Set や object の暗黙順序に任せない。

## Runtime adapter の最小 API

最初の統合では API を増やさない。必要なのは requester と peer の2役だけ。

```ts
export type ModelSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string }

export type RequesterRuntimeOptions = {
  peerManager: RuntimePeerManager
  peerIds: string[]
  model: ModelSource
  systemPrompt?: string
  args?: string[]
  onText?: (delta: string) => void
  onLog?: (line: string) => void
  onError?: (error: unknown) => void
}

export type RequesterRuntime = {
  generate(prompt: string): Promise<void>
  cancel(): void
  stop(): Promise<void>
  releaseConn(ptr: number): void
}

export type PeerRuntimeOptions = {
  peerManager: RuntimePeerManager
  onLog?: (line: string) => void
  onError?: (error: unknown) => void
  disableWebGPU?: boolean
}

export type PeerRuntime = {
  stop(): void
  releaseConn(ptr: number): void
}

export function startRequester(options: RequesterRuntimeOptions): RequesterRuntime
export function startPeer(options: PeerRuntimeOptions): PeerRuntime
```

実装は `runtime/llmlet-runtime.js`。Node 上の lifecycle テスト (`tests/`) は通っているが、
**real WASM / WebGPU でのブラウザ実測はまだ通していない**。確定済み API と扱わない。

### 実装済みシグネチャとの差分

```ts
export type RequesterRuntime = {
  ready: Promise<void>          // モデルロード完了 & C++ が prompt 待ちになった時点
  generate(prompt: string): Promise<void>
  cancel(): void
  stop(): Promise<void>
  releaseConn(ptr: number): void   // deprecated no-op
}

export type PeerRuntime = {
  ready: Promise<void>
  stop(): Promise<void>
  releaseConn(ptr: number): void   // deprecated no-op
}
```

共通 option として `baseUrl?: string` (既定は adapter 自身の URL) と
`stopTimeoutMs?: number` (既定 5000) がある。

### prompt のバイト長制限

`get_next_prompt()` / `get_system_prompt()` は `malloc(n_ctx)` のバッファへコピーしたあと
`buffer[min(bytes, n_ctx)]` に NUL を書くので、**ちょうど `n_ctx` バイトで 1 バイトはみ出す**。
バイト境界で切るため multibyte 文字も割れる。

adapter は `prompt` / `systemPrompt` の **UTF-8 バイト長 < n_ctx** を検証して、超えたら投げる。
`n_ctx` は `args` の `-c` から読む (既定 4096)。

### `args` の位置

`options.args` は `Module.arguments` の**先頭**へ入る。`main.cpp` の parser は未知の token を
「ここから prompt」と解釈して打ち切るので、**flag 以外を入れない**こと。

## `onToken` ではなく `onText`

現行 `main.cpp` は各 sampled token を `llama_token_to_piece()` した後 `printf()` する。

しかし JS 側で観測できるストリームは TTY の文字出力であり、**callback 1回 = tokenizer token とは限らない**。

そのため UI への公開名を `onToken` にすると意味が嘘になる。MVP は `onText(delta)` とする。UI のストリーミング表示にはこれで十分。

将来「token 数」そのものが必要なら C++ 側に明示的な token callback を追加する。

## `Module.PeerManager` だけでは足りない

Web repo 側の接合点として `Module.PeerManager` と `Module.release_conn` が重要なのは正しいが、**実 Runtime 起動にはそれ以外の llmlet glue も必要**。

### 必須: `Module.ChunkCache`

pin 済み `libllmlet.js` の RPC cache bridge は直接

```js
Module.ChunkCache.get(...)
Module.ChunkCache.put(...)
```

を呼ぶ。

したがって requester **だけでなく peer server にも** IndexedDB `ChunkCache` wrapper を設定してから Emscripten Module を起動する必要がある。

既存 llmlet の `chunkCache()` を adapter へ移植するのが最小変更。

### Requester に必要なもの

既存 `startClient()` / `runClient()` から PeerJS 依存だけを外し、次を残す。

- `Module.PeerManager = options.peerManager`
- `Module.ChunkCache`
- `Module.arguments = ['-d', '-rpc', peerId, ...]`
- local `File` または HTTP URL を `/work/model.gguf` として見せる remote-file bridge
- `Module.pending_prompt`
- `Module.pending_system_prompt`
- `Module.isDecodingCancel`
- stdout / TTY → `onText`
- stderr → `onLog`
- `onExit` / `onAbort`
- `locateFile` (特に `llmlet-mod.wasm`)

### Peer server に必要なもの

- `Module.PeerManager = options.peerManager`
- `Module.ChunkCache`
- `Module.arguments = ['-d', '-rpcbackend']`
- stdout / stderr logging
- `onExit` / `onAbort`
- `locateFile`

つまり、**既存 llmlet のモデル・prompt・cache・lifecycle glue を再利用し、`newPeerManager()` だけを Web 側から注入された実装へ差し替える**のが正攻法。

## prompt / generation の境界

`main.cpp` は1回の generation が終わると、次の `get_next_prompt()` を呼んで待つ。

adapter はこの性質を利用できる。

1. `Module.pending_prompt(cb)` が最初に呼ばれたら requester は入力待ち
2. `generate(prompt)` がその callback に prompt を渡す
3. sampled pieces は `onText` へ流す
4. generation が終わり `pending_prompt` が再び呼ばれた時点で `generate()` の Promise を resolve

出力末尾の改行を解析して generation 完了を推測する必要はない。

同時に複数 `generate()` は受け付けない。

### `cancel()` と `stop()` の違い

| | generation の扱い | Runtime |
|---|---|---|
| `cancel()` | **resolve**。呼び出し側が短い答えを要求しただけ | 次の generation を受けられる |
| `stop()` | **reject** (`generation was interrupted by stop()`)。出力は途中で切れている | 終了する |

途中で切れた出力を「完了」として resolve すると、UI が不完全な答えを確定表示してしまう。

### `generate()` に watchdog は無い

peer が DataChannel を閉じずに死ぬと、RPC 呼び出しは `Atomics.wait()` の中で止まる。これは
adapter からは観測できない。したがって:

1. **呼び出し側が timeout を持つ。**
2. timeout が発火したら Runtime の状態は不明なので、**`generate()` を再試行してはいけない**。
3. `stop()` (失敗しても force-exit へ落ちる) を呼び、**新しい `startRequester()` を作って**
   次の generation へ移る。

### exit の解釈

- **requester**: `main()` が 0 を返すのは `get_next_prompt()` が空 prompt を返したときだけで、
  空 prompt を送るのは `stop()` 中の adapter だけ。したがって **stop を要求していない exit は、
  code に関わらず失敗**として `onError` と `generate()` の reject に落とす。
- **peer**: `ggml_backend_rpc_start_server` は健全なかぎり `accept_peer()` を回して戻らない。
  一方 **backend device の初期化に失敗すると early return して main が exit 0 になる**。
  したがって **peer の exit は常に異常**。`onError` を必ず UI / roster に繋ぐこと。

## lifecycle — まだ P0

### Requester の peer 増減

RPC device は process 起動時の `-rpc` 引数で登録する。したがって peer roster が変わる generation では requester Runtime の再起動が必要。

既存 llmlet の `/restart` は `_emscripten_force_exit(0)` を使うが、実測で次の cleanup exception を再現している。

```text
RuntimeError: unreachable
WGPUBufferImpl::Destroy()
wgpuBufferDestroy
webgpu_buf_pool::cleanup()
```

同じ run ではその後再接続・再生成できたが、これは「安全に restart できる」証明ではない。

最初に試すべき最小修正は **requester が prompt 待ちのとき `pending_prompt` へ空文字を返し、C++ の chat loop を自然終了させてから新 Module を作る graceful stop**。`main.cpp` は prompt length 0 で loop を抜け `llama_free` / `llama_model_free` を通る。

adapter はこれを実装済み (`stop()` → `pending_prompt` で空文字 → `main.cpp` の loop 終了 →
`onExit(0)`)。`_emscripten_force_exit(0)` への fallback も残してある (既定 5 秒待ってから)。

### 既知欠陥 O9 — graceful stop が WebGPU teardown で abort する

**2026-08-26 に実測して原因を特定した。**

```text
WGPUBufferImpl::Destroy()
  -> _emwgpuBufferDestroy
    -> WebGPU.getJsObject
      -> assert(ptr in WebGPU.Internals.jsObjects)   <- 失敗
        -> abort("Assertion failed") -> ___trap() -> RuntimeError: unreachable
```

`~llama_context` がバッファ解放を完了したログの直後に起きる。**WebGPU buffer の二重破棄**であり、

- `/restart` 固有ではない。**空 prompt による graceful stop でも起きる**
- adapter の force-exit fallback が原因ではない。`stopTimeoutMs = 120000` にして
  fallback が発火しないことを確認したうえで再現した (stop は 49.5 秒で resolve)

**Web 側から見た挙動 (ここが実務上重要)**

- `onError` に `requester Runtime aborted: Assertion failed` が来る
- `stop()` は **resolve する** (hang しない)
- **peer は無傷**で、そのまま次の requester を受け付ける
- **次の `startRequester()` は正常に接続・生成できる**

したがって **generation 切替は成立するが、stop をクリーンな成功として扱ってはいけない**。
一方で **stop 中の `onError` を一律に無視するのも誤り**である。

**非致命扱いにしてよいのは、次の 2 つを両方満たすときだけ。**

1. **アプリが明示的に `stop()` を呼んでいる最中**である (自発的な世代交代であって、
   生成中・ロード中・アイドル中の abort ではない)
2. **既知 O9 シグネチャと一致する** cleanup abort である —
   `requester Runtime aborted: Assertion failed` で、かつスタックに
   `WGPUBufferImpl::Destroy()` / `_emwgpuBufferDestroy` / `WebGPU.getJsObject` を含む
   (console 側は `RuntimeError: unreachable`)

**それ以外の abort は一律で障害として扱うこと。** 生成中・ロード中に来たもの、`stop()` を
呼んでいないときに来たもの、シグネチャが違うものを stop 中の既知事象と混ぜてはいけない。

⚠️ **条件を満たす場合でもログと観測は必ず残す。** 「無視」ではなく「世代全体の致命的障害
として扱わない」であって、発生頻度やシグネチャが変わったら upstream の状況が変わった合図になる。

⚠️ **実 Chrome では stop を実行していない**ので、上記は in-app Browser pane の実測に基づく。

`Module.onExit` がそもそも呼ばれるかは生成後の `llmlet-mod.js` で確認済み: `_proc_exit` は
main thread で `Module["onExit"]?.(code)` を呼び、`callMain` が積んだ keepalive は
`exitOnMainThread` が pop する。したがって main の return / force exit のどちらでも発火する。

Peer server は generation ごとに再起動しない。Web 側 `PeerManager` の接続を貼り替えながら同じ RPC backend を待機させる方向を優先する。

## Runtime-only harness

Web 側を触らずに「Web 境界より下の Runtime が単独で正しいか」を確かめるための最小 harness。

- `harness/runtime-only/` — role 切替の1ページと、BroadcastChannel 上の `RuntimePeerManager`
- PeerJS / WebRTC / Hono を使わない。**Web repo の DataChannel wire format も複製しない**
  (あれは SCTP の都合であって Runtime の契約ではない)
- `releaseBuf` を持たない (上記の所有権契約どおり)
- **fd churn を real WASM で観測できる** — `FD_MAX` を `?fdmax=` で可変にし (既定 1024、検証時は 4)、
  connect / close / `register_buf` をログに出して **fd ごとの connection 数と registration 数 (epoch)**
  を表示する。決定的な観測は「再利用された fd が **もう一度 register される**か」。ptr の値は見ない
- **`send()` は 1 回で全部は受け取らない** — harness 独自の chunk 上限 (256 KiB) で受理し、
  受理したバイト数を戻り値にする。これで巨大テンソルが 1 回の structured clone にならず、
  `ggml-rpc.cpp` の `send_peer_retry()` の**部分送信リトライ経路も実際に通る**。
  Web repo の 64 KiB SCTP framing とは無関係の、harness 固有の数字

```bash
pwsh -NoProfile -File scripts/build-llmlet-reference.ps1   # patch 込みで再ビルド
pwsh -NoProfile -File scripts/export-web-runtime.ps1
pwsh -NoProfile -File scripts/build-runtime-harness.ps1
python scripts/serve-runtime.py build/runtime-harness --port 8888
```

| tab | URL |
|---|---|
| peer | `http://localhost:8888/?role=peer&id=peer-1&fdmax=4` |
| requester | `http://localhost:8888/?role=requester&id=req-1&peers=peer-1&fdmax=4` |

### 手順と合格条件

1. peer タブ: 環境チェックが全部 OK (`isSecureContext` / `crossOriginIsolated` /
   `SharedArrayBuffer` / `navigator.gpu`)、start 後に RPC server の banner がログに出る
2. requester タブ: 小さい dense GGUF (Qwen2.5-0.5B-Instruct Q4_K_M) を File で選び start。
   `load_tensors: layer N assigned to device RPC0` が出て `ready` が解決する
3. 日本語 prompt を投げる → `onText` に生成文字が流れ、`generate()` が resolve する
4. 連続 generate / 生成中 cancel / `stop()` を試し、exit code と
   `WGPUBufferImpl::Destroy()` 例外の有無 (O9) を記録する
5. **`patches/0001` の実測**: `fdmax=4` で generate と stop/再接続を繰り返し、
   fd 番号が 0..3 を巡回した後に **「fd usage」表の `registrations` が `connections` に
   追随して増える**ことを確認する。

   **合格条件**: 再利用された fd (`connections >= 2`) について `registrations >= 2`。
   events 欄では同じ fd に対する `registration #2` 以降として出る。

   ⚠️ **この A/B が再現するのは「fd 再利用時に stale な `Module._connbuf[fd]` slot が残り、
   `register_buf` が再発火しないこと」であって、use-after-free そのものの再現ではない。**
   patch 前のバンドルでは slot が残るため `registrations` が 1 のまま止まる — 観測できるのは
   そこまで。実際に free 済み領域へ読み書きが起きるかどうかは、PeerManager が buffer を
   free するかどうか (Web repo の `releaseBuf`) と allocator の再利用タイミングに依存し、
   この harness では条件を作っていない。

   ⚠️ **ptr の値は合否条件にしない。** `free()` 直後の `malloc()` が同じアドレスを返すのは正常で、
   ptr の一致/不一致は `_connbuf[fd]` が消えたかどうかを何も語らない。見るのは
   **fd ごとの registration count (epoch)** だけ。

### この harness が証明しないこと

BroadcastChannel は SCTP ではない。**backpressure / MTU / mDNS / TLS / Hono signaling は一切
試験していない。** ここが通っても Web 統合が通る証明にはならない。

**use-after-free 自体も再現しない。** 手順5で見えるのは `_connbuf` slot が再利用時に
クリアされるかどうかだけで、free 済み領域へのアクセスやメモリ破壊を観測する仕掛けは無い。

自動テスト (`node --test "tests/**/*.test.mjs"`) が押さえているのは adapter の promise / error handling と
harness PeerManager の挙動だけで、pthread・`Module._connbuf`・WebGPU は fake では再現できない。

## model source

### local `File`

物理2PC Runtime PoC で成功済み。requester だけが File を持てばよく、peer は GGUF を事前保持しない。

### HTTP URL

- **HEAD が `Content-Length` を返すこと (必須)**。返らないと `Number(null) === 0` で
  0 バイトの仮想ファイルになり、ロードが失敗する (F13)
- **`Range: bytes=...` に 206 を返すこと (実質必須)**

**206 非対応だと adapter は起動のたびに GGUF 全体を IndexedDB へ先読みする。**
キャッシュヒット判定なしで毎回やり直すので (F26)、世代交代のたびに数百 MB を書き直すことになる。
Qwen2.5-0.5B (469 MiB) でも反復運用には重すぎる。

Runtime 側の `scripts/serve-runtime.py` は Range を実装済みで、Gate A はこの 206 経路で通した。
Hono 側も同じ条件を満たすこと。確認は curl ではなく**実際のページから** (curl は CORS を試験しない)。

```bash
curl -I http://localhost:3000/models/your-model.gguf                  # Content-Length
curl -H 'Range: bytes=0-1' -i http://localhost:3000/models/your.gguf  # 206 + Content-Range
```

期待値: `206 Partial Content` / `Content-Range: bytes 0-1/<size>` / `Accept-Ranges: bytes`、
範囲外は `416` + `Content-Range: bytes */<size>`。

local `File` 経路を使う場合は Range 要件そのものが無くなるが、ページをリロードするたびに
ユーザーがファイルを選び直す必要がある。

## ホストページ要件

| 要件 | 合格条件 |
|---|---|
| secure context | `window.isSecureContext === true` |
| COOP / COEP | `crossOriginIsolated === true` |
| SharedArrayBuffer | `typeof SharedArrayBuffer === 'function'` |
| WebGPU | `await navigator.gpu.requestAdapter()` が非 null |

LAN IP の plain HTTP origin は実測で trustworthy origin にならず、WebGPU / cross-origin isolation を満たせなかった。

物理2PC PoC は各PCの `localhost` で成功した。共有URL / BYOD は別の secure-origin 問題として扱う。

## ICE / mDNS の既知問題

物理2PC PoC では、Chrome の通常設定で host candidate が `.local` に匿名化された際、PC-B が PC-A の mDNS candidate を解決できず candidate pair が作られなかった。

Chrome の mDNS anonymization を診断用に無効化すると raw LAN IP の host pair が `selected / succeeded` になり、RPC 推論まで完走した。

したがって `iceServers: []` の Hono signaling 統合テストは、**現在の2台では同じ診断設定を使えば進められるが、それを BYOD の完成条件にしてはいけない**。

詳細は [STAGE3_RESULT_2026-08-25.md](STAGE3_RESULT_2026-08-25.md)。

## 責務境界

| 領域 | Runtime | Web |
|---|---|---|
| WASM llama.cpp build | ✅ | |
| patched llama.cpp RPC | ✅ | |
| WebGPU backend | ✅ | |
| model virtual file / ChunkCache glue | ✅ | |
| prompt / stdout / Runtime lifecycle glue | ✅ | |
| Hono WebSocket | | ✅ |
| SDP / ICE signaling | | ✅ |
| RTCPeerConnection / DataChannel | | ✅ |
| DataChannel 上の `PeerManager` framing / backpressure | | ✅ |
| roster / generation UI state | | ✅ |
| GGUF HTTP serving | | ✅ |

## 次の executable step

1. Runtime repo に PeerJS 非依存の adapter を実装する
2. reference build の `llmlet-mod.js` / `.wasm` と adapter を Web repo の `/wasm/` へ置く
3. Web repo の `rpc.manager` を adapter に注入する
4. **同一PC**で Hono signaling → real PeerManager → real WASM → token text 生成を通す
5. 同じものを物理2PCで再実証する

この段階では大モデル・BYOD・UI演出を同時に触らない。まず「Web repo の現在の接続層に real WASM を差したら実際に1 prompt 通るか」だけを答える。
