# AI Context — dip_Distributed_LLM_Runtime

このドキュメントは、このリポジトリをAIエージェントや新しい開発者が短時間で把握するための入口です。

設計仕様を固定することが目的ではありません。実装・調査・実測によって前提が変わった場合は、この文書も更新していく想定です。

開発時の共通ルールや進め方は `AGENTS.md` を参照してください。

## ドキュメント構成

| 文書 | 内容 |
|---|---|
| [DECISIONS.md](DECISIONS.md) | チームで確定した決定事項。製品判断と技術的事実を区別して記録 |
| [RUNTIME_INTERFACE.md](RUNTIME_INTERFACE.md) | Runtime と Web repo の現在の接合点。**次の実装の正本** |
| [CONSTRAINTS.md](CONSTRAINTS.md) | 技術制約を「検証済み / 仮説 / 未解決」で分類。技術的事実の詳細 |
| [EXPERIMENTS.md](EXPERIMENTS.md) | モデルサイズの梯子と過去の実験計画・失敗記録 |
| [STAGE3_RESULT_2026-08-25.md](STAGE3_RESULT_2026-08-25.md) | **最新の物理2PC実験結果**。Stage 3 の現行ステータスはこちらを優先 |
| [QWEN36_RESULT_2026-08-28.md](QWEN36_RESULT_2026-08-28.md) | **Qwen3.6 / MoE 対応の結果**。`MUL_MAT_ID` backport と残 blocker O11 |
| [handoff/web-repo-corrections.md](handoff/web-repo-corrections.md) | Web アプリ側リポジトリへの指摘 |

## このリポジトリについて

`dip_Distributed_LLM_Runtime` は、複数のブラウザ上の計算資源を利用して `llama.cpp` による分散LLM推論を動かす Runtime 側リポジトリです。

Webアプリ本体（React / Hono / UI / Room管理など）は、別リポジトリ `RiTa-23/dip_Distributed_LLM` で開発しています。

このリポジトリの責務は主に:

- pin 済み llmlet / llama.cpp の再現ビルド
- WASM / WebGPU / llama.cpp RPC
- browser-side Runtime glue
- model / prompt / Runtime lifecycle
- Web repo が消費できる Runtime build artifact
- Runtime を単独検証するための harness

です。

## 目指している体験

- ユーザーがブラウザから参加できる
- 複数PCの計算資源を利用する
- 1台では扱いにくい、より大きなLLMを複数PCで動かす
- Requesterが推論を開始し、Peerが計算資源を提供する

「PCが増えるほど必ず高速になる」ことは主目的ではありません。pin 済み llmlet / llama.cpp RPC の現在の構成は各ピアをまたぐ通信・評価コストがあり、ピア追加 = 高速化とは言えません。

**プロダクトの本命証明は「1台に載らない dense model を複数PCなら動かせる」こと。** 物理2PCで小モデルを分散できたことは大きな前進ですが、この最終証明とは分けて扱います。

## 2026-08-25 現在の到達点

### Runtime reference path

達成済み:

- pin 済み llmlet reference build 再現
- 1タブで local WebGPU inference
- 同一PC 3タブで requester + RPC peer 2つへ layer 分割
- LAN-only bundle (`iceServers: []`, local PeerJS/Bootstrap, runtime external HTTP 0)
- **物理2PCで requester + PC-A peer + PC-B peer の分散推論を完走**

物理2PCの成功 run では PC-A `192.168.1.107` と PC-B `192.168.1.106` の raw host candidate が UDP で `selected / succeeded` になり、PC-B peer を使ったRPC通信の後に実際のモデル回答まで生成されました。

詳細: [STAGE3_RESULT_2026-08-25.md](STAGE3_RESULT_2026-08-25.md)

### Web repo

Web repo `develop` 側にはすでに:

- Hono WebSocket の roster / generation / signaling
- requester ↔ peer の RTCPeerConnection / DataChannel
- llmlet の `Module.PeerManager` 契約を DataChannel 上に実装する `apps/web/src/webrtc/peerManager.ts`
- React の requester / peer UI

があります。

したがって Runtime 側で **PeerJS の代替 signaling をもう1つ作る必要はない**。

現在の不足は、Web repo のその接続層へ **real `llmlet-mod.js` / `.wasm` と model / prompt / cache / lifecycle glue を差すこと**。

接合点の正本は [RUNTIME_INTERFACE.md](RUNTIME_INTERFACE.md)。

## 現在のアーキテクチャ

```text
Requester browser (Web repo)
  ├─ React UI
  ├─ Hono signaling client
  ├─ RTCPeerConnection
  ├─ Web PeerManager (DataChannel framing)
  └─ Runtime adapter
       ├─ Module.PeerManager = Web PeerManager
       ├─ ChunkCache / model virtual file
       ├─ prompt queue / text stream
       └─ llmlet-mod.js / wasm
            └─ patched llama.cpp RPC client
                 ├─ RPC peer A
                 └─ RPC peer B

Peer browser (Web repo)
  ├─ RTCPeerConnection
  ├─ Web PeerManager
  └─ Runtime adapter
       └─ llmlet-mod.js / wasm
            └─ patched llama.cpp RPC backend / WebGPU

Hono
  ├─ Room / roster / generation
  ├─ WebRTC signaling relay
  ├─ static Web/WASM/model serving
  └─ 重い RPC data は中継しない
```

制御プレーン = Hono WebSocket、データプレーン = requester ↔ peer の WebRTC DataChannel という分離は維持します。

## 今いちばん重要な未解決

### P0-A — real WASM と Web repo の縦切り統合

**2026-08-26 に前進**: Runtime-only harness (PeerJS / WebRTC / Hono なし、injected
`Module.PeerManager`) で **接続 → RPC → 実推論 → 切断 → 再接続 → 再推論** が実 Chrome で
通りました。詳細は [EXPERIMENTS.md](EXPERIMENTS.md) の Gate A。

つまり **Web 境界より下の Runtime は単独で動く**ことが確定しました。残っているのは
Web repo の custom `PeerManager` (DataChannel 実装) を差した状態の実測です。

次の成功条件は **同一PCで Hono signaling → Web PeerManager → real WASM RPC → real model
generation が1 prompt完走すること**。

これを通すまで UI polish / 大モデル / BYOD 問題を同時に触らない。

### ~~P0-B — lifecycle / generation 切替 (O9)~~ → 2026-08-26 解決

Requester の RPC peer list は process 起動時の `-rpc` 引数で固定されるため、generation の顔ぶれが変わると requester Runtime の再起動が必要です。

その graceful stop (prompt 待ちに空文字を返して `main.cpp` の chat loop を自然終了させる) が
WebGPU teardown で abort していたのが O9。**原因は cross-thread teardown で、`patches/0003` で解消しました。**

emdawnwebgpu の JS handle table は Emscripten module instance ごとに存在するのに、
`___funcs_on_exit()` (C++ static destructor) は browser main thread でだけ走るため、
handle を作った pthread とは別の thread が `Destroy()` を呼んでいました。詳細は
[CONSTRAINTS.md](CONSTRAINTS.md) F42 / F44。

in-app pane と実 Chrome の両方で、graceful stop → peer 無再起動で次の requester →
5 cycle 連続まで abort 無しを実測済み。

⚠️ **別件の未解決 (O10)**: 1 つの peer が requester セッションを重ねると次の `ready` が
遅くなります。**`patches/0003` 由来ではありません** (pre-fix でも増加しました)。
peer を再起動すると戻ります。**原因は未切り分け** — 観測負荷を落とした診断では線形の蓄積が
再現せず、Runtime / harness / Chrome / WebGPU のどこかは判定できていません。
**Runtime 内部の追加調査は打ち切り、Web 統合フェーズで実運用の世代交代に効くと分かった時点で
切り分けます。** 詳細は [CONSTRAINTS.md](CONSTRAINTS.md) O10。

### P0-C — default Chrome の mDNS host candidate

物理2PCでは Chrome の通常設定で `.local` candidate が使われた際、PC-B が PC-A の mDNS 名を解決できず candidate pair が作られませんでした。

診断用に WebRTC mDNS anonymization を無効化すると raw LAN IP pair が即座に接続し、RPC推論まで成功しました。

これは「host-only WebRTCが動く」証明であって、**BYODの解決ではありません**。Hono統合の今の2台テストは診断設定で進められるが、デモ完成条件にはしない。

### P1 — 本命モデル / memory pooling

**2026-08-28 更新。**「WebGPU backend が `MUL_MAT_ID` を持たない」という制約は**解消しました** —
upstream から backport し (`patches/0004`)、WebGPU 上で CPU 参照と 455/455 一致することまで
確認済みです。Qwen3.6 の architecture / tokenizer / tensor 構造も pin がそのまま扱えます。

**残っているのは別の問題**: 実 MoE モデルを WebGPU peer で走らせると生成が返りません (O11)。
カーネルの正しさでも単純な遅さでも説明が付いておらず、**測定は統合GPU 1 台のみ**なので、
まず実 peer 機で再現するか確かめる必要があります。
詳細: [QWEN36_RESULT_2026-08-28.md](QWEN36_RESULT_2026-08-28.md)

⚠️ **モデル選定に制約があります。** backport した `MUL_MAT_ID` は **IQ 系量子化に非対応**なので、
expert が IQ で量子化された GGUF (unsloth の UD 系など) は WebGPU peer で実行できません。
また MTP 層を含む GGUF は `block_count` が 1 増えるため pin では load できません。
`scripts/probe-gguf-header.mjs` がどちらもモデルごとに判定します。

引き続き dense model で「単一 peer では載らず、複数 peer なら載る」を先に証明する。

また WebGPU RPC device の `free memory` は実空きではなく `maxBufferSize` を返すため、自動配分は実メモリ比例ではありません。異種端末での OOM リスクは残ります。

## Runtime adapter で忘れてはいけないもの

`Module.PeerManager` だけ差せば完成ではありません。pin 済み llmlet の実コード上、adapter には次が必要です。

- `Module.PeerManager`
- **`Module.ChunkCache`** — RPC cache bridge が直接 `.get/.put` を呼ぶ
- model File / URL を `/work/model.gguf` に見せる remote-file bridge
- requester `pending_prompt` / `pending_system_prompt`
- `isDecodingCancel`
- stdout TTY streaming / stderr log
- `onExit` / `onAbort`
- `locateFile`
- requester の順序付き `-rpc <peerId>` args
- peer の `-rpcbackend`

既存 llmlet `startClient` / `startServer` からこの glue を再利用し、`newPeerManager()` だけを注入式へ変えるのが最小変更です。

**`release_conn` は使わないこと。** pin 済み Makefile は export していますが、受信バッファは
それを malloc した pthread の `Module._connbuf[fd]` に残り続けるため、main thread から free すると
fd 再利用時に use-after-free になります。`patches/0001` で `close_peer()` 側の解放に直しました
(詳細と Web 側への影響は [RUNTIME_INTERFACE.md](RUNTIME_INTERFACE.md) の「受信バッファの所有権」)。

## 出力 API の注意

C++ は sampled token を `llama_token_to_piece()` → `printf()` していますが、JS 側 TTY hook で見える単位は文字出力です。

そのため Web UI の API 名を `onToken` と断定せず、MVP は `onText(delta)` とします。真の token event が必要になったら C++ callback を追加します。

## モデルについて

デモ既定は dense model。

現時点で小さい reference test に Qwen2.5-0.5B Q4_K_M を使い、単一PC・同一PC複数peer・物理2PCで動作を確認済み。

次の model-size 実験は Web統合を通した後。先に大モデルへ移ると「モデル制約」と「integration bug」が混ざります。

## 共有URL / secure origin

LAN IP の plain HTTP origin は実測で trustworthy origin にならず、`crossOriginIsolated` / SharedArrayBuffer / WebGPU を満たせませんでした。

物理2PC Runtime PoC は各PCの `localhost` を使って成功。

Web repo には開発用 TLS の足場がありますが、飛び入り参加者の端末で証明書警告なしに使える secure origin は別問題です。これは real WASM integration の後に扱います。

## 次にやること

1. ~~[RUNTIME_INTERFACE.md](RUNTIME_INTERFACE.md) の最小 adapter を実装~~
   → `runtime/llmlet-runtime.js`。敵対的レビュー済み、Node lifecycle テスト 36 本通過。
   **実ブラウザでも Gate A で実測済み**
2. ~~`patches/` 込みで reference build を再ビルドする~~
   → 完了。`build/reference-llmlet/` は patch 適用済みで `BUILD_INFO.txt` に
   commit / patch / artifact の SHA-256 が入っている
3. ~~Runtime-only harness を実ブラウザで通す~~
   → **完了 (Gate A)。実 Chrome で実推論・再接続・fd 再利用まで確認**。
   残課題だった graceful stop の abort (O9 / F42) も `patches/0003` で解消し、
   in-app pane と実 Chrome で再実測済み (F44)
4. **← 今ここ。** reference build artifact + adapter を Web repo の静的配信先へ渡す
   (`scripts/export-web-runtime.ps1` → `build/web-runtime/`)
5. **← 今ここ。** 同一PCで **Hono → real PeerManager → real WASM → 1 prompt** を通す
6. 物理2PCで同じ統合 path を通す
7. ~~graceful requester restart を検証~~
   → **完了 (2026-08-26)。** `patches/0003` で O9 を解消し、in-app pane と実 Chrome で実測
8. dense model で「1台に載らない → 複数台で動く」を証明
9. mDNS / shared HTTPS / consent を demo gate として解決

## 関連リポジトリ

- Webアプリ: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
- llmlet: https://github.com/ktock/llmlet
- llama.cpp: https://github.com/ggml-org/llama.cpp

---

この文書は「完成形」を定義するものではなく、現時点で分かっていること・次に壊すべきリスクを共有するためのものです。
