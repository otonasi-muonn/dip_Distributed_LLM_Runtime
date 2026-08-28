# L2 runbook — discrete GPU 機で MoE が WebGPU peer を通るか

**目的はひとつだけ。** 実 MoE モデル (granite 1B-A400M) が **discrete GPU の WebGPU peer で
first token に到達するか**を確かめる。開発機 (AMD Radeon 780M 統合GPU) では到達しなかった
(`CONSTRAINTS.md` O11)。**それが GPU 環境差なのか、WebGPU の MoE 経路一般の問題なのかを
決めるのがこの run。**

⚠️ **物理2PC にはしない。**`harness/runtime-only` の transport は same-origin
`BroadcastChannel` (`harness-peer-manager.js:376-378`) で別筐体には飛ばない。
そして今知りたいのは GPU の差なので、**1 台の 2 タブで足りる**。
物理2PC + WebRTC の検証は O11 を解いた後に Web repo 側で行う。

⚠️ **これで「変数が GPU だけ」になるわけではない。** 別の PC なので CPU / RAM / OS 状態 /
Chrome・Dawn のバージョン / power management も変わる。**同一にできるのは transport /
RPC topology / モデル / Runtime 構成**までで、そこまでは揃える。

---

## 持ち込むもの

| もの | 出どころ |
|---|---|
| `build/runtime-harness/` 一式 | `scripts/build-runtime-harness.ps1` の出力 (patch 0001-0005 入り) |
| `granite-3.0-1b-a400m-instruct-Q4_K_M.gguf` | `bartowski/granite-3.0-1b-a400m-instruct-GGUF` (821,845,024 bytes) |
| `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` | 対照用 dense (397,808,192 bytes) |
| `scripts/serve-runtime.py` | COOP/COEP と Range を付ける開発用サーバ |

Python が要る。`build/runtime-harness/BUILD_INFO.txt` に **patch が 5 本**載っていることを
先に確認すること (0005 が無いと trace が使えない)。

---

## 起動

```bash
python scripts/serve-runtime.py build/runtime-harness --port 8890 --model <granite の絶対パス>
```

その PC の Chrome で 2 タブ (**必ず `localhost`**。F24: LAN-IP の plain HTTP は
secure origin にならず SharedArrayBuffer / WebGPU が無効になる):

```text
Tab A (peer)      http://localhost:8890/?role=peer&id=peer-1&fdmax=4
Tab B (requester) http://localhost:8890/?role=requester&id=req-1&peers=peer-1&fdmax=4&model=/model.gguf
```

---

## Gate 0 — WebGPU が本当に discrete GPU を選んだか (**先にやる**)

OS に discrete GPU があるだけでは足りない。ノート PC では Chrome が iGPU の adapter を
選ぶことがある。**意図した adapter でなければ、その run は INVALID として結果に使わない。**

Tab A の DevTools コンソールで:

```js
(await navigator.gpu.requestAdapter()).info
```

`vendor` / `architecture` / `device` / `description` を記録する。
peer を start したあとログに出る次の行とも突き合わせる:

```text
ggml_webgpu: adapter_info: vendor_id: .. | vendor: .. | architecture: .. | device_id: .. | name: .. | device_desc: ..
```

⚠️ Chrome は `device` / `description` を空で返すことがある。その場合は `vendor` と
`architecture` で判断し、**判断できなければ INVALID 扱いにして、
`chrome://gpu` の "GPU0/GPU1" と合わせて確認する**。

参考 (開発機 = 到達しなかった側): `vendor: amd` / `architecture: rdna-3` / `device: ""`。

---

## Gate 1 — 環境の記録 (M1 / M2 / M3)

**本番の前に必ず取る。**後から「どの機で測ったか」を言えなくなる。

**M1 実ハードウェア** (PowerShell):

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,2)
Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*' |
  Where-Object { $_.'HardwareInformation.qwMemorySize' } |
  ForEach-Object { "{0} = {1} GB" -f $_.DriverDesc, [math]::Round($_.'HardwareInformation.qwMemorySize'/1GB,2) }
```

**M2 WebGPU limits** (Tab A のコンソール):

```js
(async () => { const L = (await navigator.gpu.requestAdapter()).limits; return {
  maxBufferSize: L.maxBufferSize,
  maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
  maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
  maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
  maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension,
  minStorageBufferOffsetAlignment: L.minStorageBufferOffsetAlignment }; })()
```

**M3 llama.cpp が見る値**: peer 起動ログの `WebGPU: WebGPU (NNNN MiB, NNNN MiB free)` と、
requester ログの `using device RPC0 (peer-1) ... - NNNN MiB free`。

⚠️ F20 のとおりこれは実空きではなく `maxBufferSize` である。開発機でも他機でも同じだった。
**実 VRAM と一致していなくても異常ではない** — そういう実装だという確認のために取る。

**開発機の値 (比較対象)**:

```text
M1  AMD Radeon 780M (統合GPU) / 専用VRAM 0.5GB / system RAM 31.29GB / discrete GPU なし
M2  maxBufferSize 2,147,483,648 / maxStorageBufferBindingSize 2,147,483,644
    maxComputeInvocationsPerWorkgroup 1024 / maxComputeWorkgroupStorageSize 32768
    maxComputeWorkgroupsPerDimension 65535 / minStorageBufferOffsetAlignment 256
M3  WebGPU: WebGPU (2048 MiB, 2048 MiB free)
```

---

## 本番 — MoE × WebGPU peer

1. Tab A で **start**。`Starting RPC server` と `Devices: WebGPU:` が出るまで待つ
2. Tab B で prompt を `What is the capital of France? Reply with only the city name.` にして **start**
3. ログが `ready` になるまで待つ。次を記録する:
   ```text
   print_info: arch = granitemoe / n_expert = 32 / n_expert_used = 8
   load_tensors:          CPU model buffer size =  ... MiB
   load_tensors: RPC0[peer-1] model buffer size =  ... MiB
   sched_reserve: RPC0[peer-1] compute buffer size = ... MiB
   sched_reserve: graph splits = ...
   ```
4. **generate** を押して時刻を控える

### 合否

| | 判定 |
|---|---|
| **first token が出る** | **PASS**。完走までの所要時間も記録する |
| **5 分経っても 1 文字も出ない** | **FAIL**。下の trace 手順へ |

⚠️ **待っている間にマシンをスリープさせない。** 開発機の最初の 9 分試行は
`net::ERR_NETWORK_IO_SUSPENDED` を伴っていて**無効だった**。DevTools のコンソールに
そのエラーが出ていないことを確認すること。出ていたらその run は INVALID。

参考: **CPU peer なら同じモデルが 30 秒未満で完答する**。5 分は十分に長い。

---

## FAIL したとき — trace を取る

両タブを閉じ、`&trace=1` を付けて開き直す:

```text
Tab A  http://localhost:8890/?role=peer&id=peer-1&fdmax=4&trace=1
Tab B  http://localhost:8890/?role=requester&id=req-1&peers=peer-1&fdmax=4&model=/model.gguf
```

`webgpu-trace:` 行が peer のログに出る。**止まった位置の直前 30 行を保存する。**

読み方:

| 最後に出た行 | 意味 |
|---|---|
| `encode node=i/N` で止まる | **encode 中**。追加の node/MUL_MAT/lifecycle marker が無ければ、特定 op の pipeline 生成・buffer・binding などのどこで止まったかは未確定 |
| `submit #k after node=i` の直後で止まる | submit 自体が返らない |
| `wait(partial) begin` で止まる | 中間 submit の完了待ち |
| `wait(final) begin` + `WaitAny #n status=TimedOut` が増え続ける | **完了しない submission を無限に待っている** |
| `WaitAny ... status=Error` が増え続ける | 同上だが原因はエラー。`handle_wait_status` は Error でも false を返して回り続ける |
| `graph_compute end` が出ているのに token が出ない | 止まっているのは WebGPU ではない。RPC か requester 側 |

⚠️ **trace を on / off で 1 回ずつ回して、止まり方が変わらないことも確認する。**
変わるなら観測が症状を動かしている (Heisenbug) ので、その trace は根拠に使えない。

---

## 対照 (同じ機で 1 回ずつ)

本番の結果がどちらでも取る。**同じ機での比較でないと意味が薄い。**

| # | 構成 | 期待 |
|---|---|---|
| C1 | dense (Qwen2.5-0.5B) × WebGPU peer | 完走するはず (開発機でも完走した) |
| C2 | MoE (granite) × **CPU peer** — Tab A で `run this peer on CPU` にチェック | 完走するはず (開発機で 30 秒未満) |

C1 が落ちるなら **その機の WebGPU 経路そのものが疑わしい**ので、MoE の結論を出す前に
そちらを追う。C2 が落ちるなら持ち込んだ artifact / モデルを疑う。

---

## 結果の読み方 (**先に決めておく**)

| 結果 | 言えること | 次 |
|---|---|---|
| **PASS** | O11 は **WebGPU MoE 経路に普遍的な問題ではなく、開発機 (780M) 環境との差に依存する**ところまで縮小。⚠️ **780M 固有 / iGPU 一般 / AMD driver / WebGPU limits / Chrome・Dawn / power management / その PC 固有環境 のどれかまでは特定できない** | Memory Gate (M4/M5) → Qwen3.6 12.93GB の取得へ進んでよい |
| **FAIL** | 780M 以外でも再現。**特定 GPU 固有ではなく、共通する WebGPU / RPC full-graph 経路の問題である可能性が大幅に上がる** | **Qwen3.6 のダウンロードは延期。**両機の trace を突き合わせて切り分けを続ける |

⚠️ **どちらでも「MoE WebGPU inference が使える」とはまだ言わない。**PASS が意味するのは
「小さい MoE が 1 台の discrete GPU で通った」ことまでで、Qwen3.6 の規模でも
物理分散でも通ることは別に証明が要る。

---

## 記録して持ち帰るもの

- Gate 0 の adapter info (と INVALID 判定の有無)
- M1 / M2 / M3
- 本番の合否と所要時間、`load_tensors` / `sched_reserve` の行
- FAIL なら trace の末尾 30 行 (trace on / off 両方)
- C1 / C2 の結果
- コンソールに `ERR_NETWORK_IO_SUSPENDED` が無かったこと
