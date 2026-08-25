# Runtime 公開インターフェース

このリポジトリ (Runtime) が Web アプリ側 (`RiTa-23/dip_Distributed_LLM`) に提供する境界を定義する。

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

したがって **`release_conn` を追加 export するためのビルド変更は不要**。既存成果物に含まれる。

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

これは **実装対象の契約**。ブラウザ実測が通るまでは確定済み API と扱わない。

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

これを同一PCで実測してから generation 再編成へ使う。

Peer server は generation ごとに再起動しない。Web 側 `PeerManager` の接続を貼り替えながら同じ RPC backend を待機させる方向を優先する。

## model source

### local `File`

物理2PC Runtime PoC で成功済み。requester だけが File を持てばよく、peer は GGUF を事前保持しない。

### HTTP URL

既存 llmlet の URL 経路を使う場合:

- **HEAD + `Content-Length` は必須**
- `Range: bytes=...` に対する **206 は強く推奨**
- 206 非対応なら全体を IndexedDB へ先読みする fallback に入る

Web repo の `/models/*` を使う場合、この条件は実測してから UI の既定経路にする。

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
