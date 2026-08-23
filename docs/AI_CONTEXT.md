# AI Context — dip_Distributed_LLM_Runtime

このドキュメントは、このリポジトリをAIエージェントや新しい開発者が短時間で把握するための入口です。

設計仕様を固定することが目的ではありません。実装・調査・実測によって前提が変わった場合は、この文書も更新していく想定です。

開発時の共通ルールや進め方は `AGENTS.md` を参照してください。

## ドキュメント構成

| 文書 | 内容 |
|---|---|
| [DECISIONS.md](DECISIONS.md) | チームで確定した決定事項。製品判断と技術的事実を区別して記録 |
| [RUNTIME_INTERFACE.md](RUNTIME_INTERFACE.md) | Runtime が Web アプリ側に提供する境界と API。**P0 未解決あり** |
| [CONSTRAINTS.md](CONSTRAINTS.md) | 技術制約を「検証済み / 仮説 / 未解決」で分類。**技術的事実の正本はここ** — 他文書の説明が食い違ったらこちらを優先する |
| [EXPERIMENTS.md](EXPERIMENTS.md) | モデルサイズの梯子と実験計画 |
| [handoff/web-repo-corrections.md](handoff/web-repo-corrections.md) | Web アプリ側リポジトリへの指摘 |

## このリポジトリについて

`dip_Distributed_LLM_Runtime` は、複数のブラウザ上の計算資源を利用して `llama.cpp` による分散LLM推論を試すための Runtime 側リポジトリです。

Webアプリ本体（React / Hono / UI / Room管理など）は、別リポジトリ `RiTa-23/dip_Distributed_LLM` で開発しています。

このリポジトリでは主にRuntimeとそのbuild artifactを作り、Webアプリ側から利用する形を想定しています。npm packageなどの具体的な配布形式はまだ決めていません。

## 現在目指している体験

- ユーザーがブラウザから参加できる
- 複数PCの計算資源を利用する
- 1台では扱いにくい、より大きなLLMを複数PCで動かす
- Requesterが推論を開始し、Peerが計算資源を提供する

「PCが増えるほど必ず高速になる」ことは主目的ではありません。むしろ llmlet は並列化未対応で各ピアが逐次評価するため、ピアを増やしても速くはなりません (`CONSTRAINTS.md` F8)。**複数PCのメモリを利用して、1台に載らないモデルを動かせること**を重視しています。

## 現在のアーキテクチャ仮説

```text
Requester Browser
  ├─ llama.cpp client / orchestrator
  ├─ local WebGPU（利用方法は要検証）
  └─ WebRTC DataChannel
       ├─ Peer A → llama.cpp RPC server / WebGPU
       ├─ Peer B → llama.cpp RPC server / WebGPU
       └─ Peer C → llama.cpp RPC server / WebGPU

Hono（別リポジトリ）
  ├─ Room / Peer管理
  ├─ WebRTC signaling
  ├─ 状態管理・UIへの通知
  └─ モデル配信（GGUF。HTTP Range 対応が前提条件 → CONSTRAINTS.md O2）
```

重いRPCデータはHonoで中継せず、RequesterとPeer間のWebRTC DataChannelで扱います (`DECISIONS.md` D5)。

この構成は現時点の仮説であり、実測結果によって変更する可能性があります。

## 最大のリスク

`CONSTRAINTS.md` の **O0** と **O4** が現時点の中核リスクです。

- **O0 (モデル選定に直結)**: **ピアが実行できない演算が、実行できないまま送られてくる**という構造的な穴があります。RPC デバイスは「何でも実行できる」と申告する (F15) 一方、ピア側には CPU 退避が無い (F16) ためです。具体例は2つ — WebGPU に `MUL_MAT_ID` が無いため **MoE は動かない** (F14)、および **単一テンソルが `maxStorageBufferBindingSize` を超えるモデル**も弾かれる (F12)。`DECISIONS.md` D8 の Qwen3.6-35B-A3B は MoE です。**デモは dense モデルで組む必要があります**
- **O4 (接続性)**: `iceServers: []` でも同一 LAN なら繋がるという想定ですが、Chrome は host candidate を `.local` (mDNS) へ難読化するため、mDNS 解決が失敗する環境では疎通しません。AP isolation も同様。モデル不要・ブラウザ2台で検証でき、失敗すると全段が止まります

当初こちらが中核リスクと考えていた「requester がモデル全体をメモリに保持するのでは」という懸念は、**実コードを読んで否定されました**。`addRemoteFile()` がチャンク単位のストリーミングをしており (F3/F4)、また RPC ピアが1台でもいれば requester のローカルデバイスは配置対象に入りません (F17)。

いずれも `EXPERIMENTS.md` の段0.5 と段3 で確認します。

## Runtime側で扱う領域

`llama.cpp` のWASMビルド / WebGPU backend / `llama.cpp RPC` のブラウザ利用 / Requester・Peer Runtime / WebRTC DataChannelとRPC transportの接続 / モデルロード / 推論・token生成 / Runtime内部の状態やエラーを外部へ伝える仕組み。

React UI・RoomのUX・Honoのロスター管理・WebSocket APIはWebアプリ側で扱います。境界の詳細は `RUNTIME_INTERFACE.md` を参照。

## 既存技術との関係

### llama.cpp

分散推論の中心となる候補。モデル配置・RPC・デバイス管理は既存機能で扱える範囲を優先します (`DECISIONS.md` D6)。

### llmlet

https://github.com/ktock/llmlet — ブラウザ上で WASM + WebGPU + WebRTC + llama.cpp RPC を組み合わせた先行実装で、本プロジェクトの重要な参考資料です。MIT ライセンス (`CONSTRAINTS.md` F10)。

llmletは固定したllama.cpp revisionを利用しているため、現在使いたいモデルや現行upstreamとの互換性は確認が必要です。

## まだ決めていないこと

- Runtimeの公開API (`RUNTIME_INTERFACE.md` の P0-1〜P0-4)
- packageとしての配布方式
- 使用するGGUFと量子化方式
- Requester自身のWebGPUをどう利用するか
- Peer増減時の挙動の詳細
- CPU fallbackをどこまで扱うか
- llmletの実装をどこまで流用し、どこから変更するか

なお「LAN限定にするか」「STUN/TURN構成」は決定済みです (`DECISIONS.md` D1 / D7)。

## 関連リポジトリ

- Webアプリ: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
- llmlet: https://github.com/ktock/llmlet
- llama.cpp: https://github.com/ggml-org/llama.cpp

---

この文書は「完成形」を定義するものではなく、現時点で分かっていること・考えていること・まだ分からないことを共有するためのものです。
