# AI Context — dip_Distributed_LLM_Runtime

このドキュメントは、このリポジトリをAIエージェントや新しい開発者が短時間で理解するための最小コンテキストです。

## このリポジトリは何か

`dip_Distributed_LLM_Runtime` は、複数のブラウザ上の計算資源を束ねて `llama.cpp` による分散LLM推論を行うための **Runtime / Package 側のリポジトリ**です。

Webアプリ本体（React / Hono / UI / Room管理）は別リポジトリ `RiTa-23/dip_Distributed_LLM` で開発します。

このRuntimeは最終的に、Webアプリ側から利用できる再利用可能なパッケージとして扱う想定です。ただし npm package などの具体的な配布形式はまだ固定しません。

## 最終的に実現したい体験

- ユーザーはブラウザだけで参加できる
- 複数PCの計算資源を使って、1台では載らない大きなLLMを動かす
- Requester（部屋を作った人）が推論の親Clientになる
- Peerは自分のブラウザ上の計算資源を提供する
- 最終ターゲットモデルは `Qwen3.6-35B-A3B`

「PCが増えるほど必ず高速になる」ことは目的ではありません。
主目的は **複数PCのメモリ・計算資源を利用して、より大きなモデルを動かせること** です。

## 基本アーキテクチャ（現時点の仮説）

```text
Requester Browser
  ├─ llama.cpp client / orchestrator
  ├─ local WebGPU（可能なら利用）
  └─ WebRTC DataChannel
       ├─ Peer A → llama.cpp RPC server / WebGPU
       ├─ Peer B → llama.cpp RPC server / WebGPU
       └─ Peer C → llama.cpp RPC server / WebGPU

Hono（別リポジトリ）
  ├─ Room / Peer管理
  ├─ WebRTC signaling
  ├─ 状態監視・UIへの通知
  └─ モデル情報の管理
```

Honoは原則としてLLMの計算データを中継しません。
重いRPCデータはRequesterとPeer間のWebRTC DataChannelで直接扱う方向です。

## Runtime側の責務

このリポジトリで扱うもの：

- `llama.cpp` のWASMビルド
- WebGPU backend
- `llama.cpp RPC` のブラウザ利用
- Requester / Peer Runtime
- WebRTC DataChannelとRPC transportの接続
- モデルロード
- llama.cppが提供する範囲でのモデル分散
- 推論とtoken生成
- Runtime内部の状態・エラーの外部通知

このリポジトリで原則扱わないもの：

- React UI
- RoomのUX
- Honoのロスター管理
- Hono WebSocket APIそのもの
- ハッカソン向けの画面演出

RuntimeがHonoの具体的なURLやメッセージ形式に強く依存しないようにすることを優先します。

## 既存技術との関係

### llama.cpp

分散推論の本体として利用します。
モデルのLayer/Tensor配置など、llama.cppが既に解決している問題は可能な限り再実装しません。

### llmlet

https://github.com/ktock/llmlet

ブラウザ上で WASM + WebGPU + WebRTC + llama.cpp RPC を組み合わせた先行実装です。
このプロジェクトの重要な参考実装です。

ただし、llmletが固定している llama.cpp は古いため、最終的にQwen3.6を扱う場合は現行のupstream llama.cppとの統合・移植が必要になる可能性があります。

**最初から全部書き直さず、まずllmletを動かして理解してから差分を作ること。**

## 開発方針

このプロジェクトでは、未来の仕様を細かく決めすぎません。

1. 既存実装を動かす
2. 実際の挙動を確認する
3. 必要な差分だけ実装する
4. そこで分かった事実をドキュメントへ反映する

「たぶん必要になる」機能を先回りして大量に実装しないでください。

特に以下は、実測・PoC前に独自実装しないこと：

- 独自のLayer割り当てアルゴリズム
- Expert Parallelism
- Tensor Parallelism
- 独自のモデル分割形式
- 複雑なPeer再構成
- 完璧なキャッシュ戦略
- 大規模な抽象化レイヤ

## 直近の開発順

### Milestone 1 — 既存実装を動かす

- llmletを無改造でbuild
- 小さいGGUFモデルでブラウザ推論
- 可能なら2ブラウザ / 2PCで分散推論まで確認

### Milestone 2 — 現行 llama.cpp を確認

- 現行upstream llama.cppのWASM + WebGPU buildを確認
- Qwen3.6対応箇所を確認

### Milestone 3 — Browser RPCを統合

- llmletのBrowser RPC / WebRTC transportの実装を理解
- 必要な部分を現行llama.cppへ移植
- 2台で分散推論を成立させる

### Milestone 4 — 本命モデル

- `Qwen3.6-35B-A3B` のGGUFを利用
- 複数PCでモデルをロード・推論できることを確認

その後に3台以上、Peer増減、性能改善、モデル配布最適化などを進めます。

## 現時点で未確定のもの

以下はAIが勝手に決定しないでください。

- LAN限定にするか、インターネット越し参加まで必須にするか
- STUN / TURN構成
- Runtimeの最終公開API
- npm等での配布方式
- 本番GGUFの量子化方式
- Host自身のWebGPUをどのように組み込むかの詳細
- モデルキャッシュ方式
- Peer増減時の最終仕様
- CPU fallbackをP0に含めるか

必要になった時点で、既存コード・upstream仕様・実測結果を見て決めます。

## AIエージェントへのルール

- このファイルを「絶対仕様」ではなく、現在の方向性として扱う
- 実装済みコードとupstreamの仕様を最優先する
- 不明点を想像で埋めず、まず関連コード・llama.cpp・llmletを読む
- llama.cppに既存機能がある場合は自作しない方向を優先する
- 一度に大きく作らず、小さい検証可能な変更を行う
- 新しい抽象化は、実際に2箇所以上で必要になってから検討する
- 変更後は「何が実測できたか」を残す
- ハッカソンであるため、完成度よりも動く縦切りのPoCを優先する

## 関連リポジトリ

- Webアプリ: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
- llmlet: https://github.com/ktock/llmlet
- llama.cpp: https://github.com/ggml-org/llama.cpp

---

このドキュメントは、設計を固定するためではなく、AIや開発者が「今どこを目指しているか」を見失わないためのものです。
