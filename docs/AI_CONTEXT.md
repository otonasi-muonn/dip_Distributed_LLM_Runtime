# AI Context — dip_Distributed_LLM_Runtime

このドキュメントは、このリポジトリをAIエージェントや新しい開発者が短時間で把握するためのコンテキストです。

設計仕様を固定することが目的ではありません。実装・調査・実測によって前提が変わった場合は、この文書も更新していく想定です。

開発時の共通ルールや進め方は `AGENTS.md` を参照してください。このファイルでは、主に現在のプロジェクト状況・仮説・未確定事項を扱います。

## このリポジトリについて

`dip_Distributed_LLM_Runtime` は、複数のブラウザ上の計算資源を利用して `llama.cpp` による分散LLM推論を試すための Runtime 側リポジトリです。

Webアプリ本体（React / Hono / UI / Room管理など）は、別リポジトリ `RiTa-23/dip_Distributed_LLM` で開発しています。

このリポジトリでは主にRuntimeとそのbuild artifactを作り、Webアプリ側から利用する形を想定しています。Runtimeを独立して利用しやすい形にできるとよさそうですが、npm packageなどの具体的な配布形式はまだ決めていません。

## 現在目指している体験

現時点では、次のような体験を目指しています。

- ユーザーがブラウザから参加できる
- 複数PCの計算資源を利用する
- 1台では扱いにくい、より大きなLLMを複数PCで動かす
- Requesterが推論を開始し、Peerが計算資源を提供する

「PCが増えるほど必ず高速になる」ことは主目的ではなく、複数PCのメモリ・計算資源を利用できることを重視しています。

`Qwen3.6-35B-A3B` は現在の主要な検証候補です。モデル選定は、Runtimeの実装状況や実測結果によって変わる可能性があります。

## 現在確認できていること

- Webアプリ側とRuntime側は別リポジトリで開発している
- `llama.cpp` を推論エンジンとして利用する方向で検討している
- `llmlet` という、ブラウザ上で WASM / WebGPU / WebRTC / llama.cpp RPC を組み合わせた先行実装が存在する
- 分散方法やモデル配置について、`llama.cpp` が提供している機能をまず確認する価値がある

## 現在のアーキテクチャ仮説

現時点では、llmletを参考に次のような構成を考えています。

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
  └─ モデル情報の管理
```

データプレーンについては、重いRPCデータをHonoで中継せず、RequesterとPeer間のWebRTC DataChannelで扱う構成を候補にしています。

この構成は現時点の仮説であり、llmletや現行llama.cppを実際に動かした結果によって変更する可能性があります。

## Runtime側で扱いそうな領域

現時点では、主に次の領域をこのリポジトリで扱う想定です。

- `llama.cpp` のWASMビルド
- WebGPU backend
- `llama.cpp RPC` のブラウザ利用
- Requester / Peer Runtime
- WebRTC DataChannelとRPC transportの接続
- モデルロード
- llama.cppが提供する範囲でのモデル分散
- 推論・token生成
- Runtime内部の状態やエラーを外部へ伝えるための仕組み

一方、次の内容はWebアプリ側で扱う方が自然だと考えています。

- React UI
- RoomのUX
- Honoのロスター管理
- Hono WebSocket API
- ハッカソン向けの画面演出

RuntimeとWebアプリの境界も、実装を進めながら必要に応じて調整します。

## 既存技術との関係

### llama.cpp

分散推論の中心となる候補です。

モデル配置・RPC・デバイス管理などについて、まず既存機能で扱える範囲を確認します。既存機能が今回の用途に合わない場合は、その時点で追加実装や変更を検討します。

### llmlet

https://github.com/ktock/llmlet

ブラウザ上で WASM + WebGPU + WebRTC + llama.cpp RPC を組み合わせた先行実装で、このプロジェクトの重要な参考資料です。

llmletは固定したllama.cpp revisionを利用しているため、現在使いたいモデルや現行upstreamとの互換性は確認が必要です。

まず既存実装を動かし、どの部分がそのまま使えそうか、どこに差分が必要かを確認する方針です。

## 直近で試したいこと

これは固定ロードマップではなく、現在考えている探索順です。

1. llmletを手元でbuildし、小さいモデルで動作を確認する
2. 可能であれば2ブラウザ / 2PCで既存の分散推論を確認する
3. 現行upstream llama.cppのWASM / WebGPU周辺と、Qwen3.6対応状況を確認する
4. llmletと現行llama.cppの差分を見て、Browser RPCをどう扱うのがよいか判断する
5. 小さいモデルで2台の分散推論を成立させる方法を探る
6. その後、`Qwen3.6-35B-A3B` での検証へ進む

途中でより小さい検証や別の実装方法が必要になった場合は、順番を変更して構いません。

## 現時点で未確定のこと

次の内容はまだ調査・実測前です。

- LAN限定にするか、インターネット越し参加まで対象にするか
- STUN / TURN構成
- Runtimeの公開API
- packageとしての配布方式
- 使用するGGUFと量子化方式
- Requester自身のWebGPUをどう利用するか
- モデル配布・キャッシュ方式
- Peer増減時の挙動
- CPU fallbackをどこまで扱うか
- llmletの実装をどこまで流用し、どこから変更するか

必要になった時点で、既存コード・upstream仕様・実測結果を見ながら決めます。

## 関連リポジトリ

- Webアプリ: https://github.com/RiTa-23/dip_Distributed_LLM
- Runtime: https://github.com/otonasi-muonn/dip_Distributed_LLM_Runtime
- llmlet: https://github.com/ktock/llmlet
- llama.cpp: https://github.com/ggml-org/llama.cpp

---

この文書は「完成形」を定義するものではなく、現時点で分かっていること・考えていること・まだ分からないことを共有するためのものです。
