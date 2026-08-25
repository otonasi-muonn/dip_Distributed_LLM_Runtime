# Stage 3 result — physical 2-PC distributed inference

Date: 2026-08-25

This is the latest result for the physical 2-PC experiment. The earlier failed attempt in `EXPERIMENTS.md` remains useful as a failure record, but it is no longer the current Stage 3 status.

## Result

**Stage 3 passed as a Runtime PoC.**

A requester browser on PC-A connected to one server tab on PC-A and one server tab on PC-B, and llama.cpp RPC used both peers while generation completed and produced a response.

Topology used for the successful run:

```text
PC-A 192.168.1.107/24
├─ requester  (localhost Runtime page)
├─ server A   (localhost Runtime page)
└─ PeerServer :9000

PC-B 192.168.1.106/24
└─ server B   (localhost Runtime page)

Requester ── WebRTC DataChannel ── server A
          └─ WebRTC DataChannel ── server B
```

The Runtime bundle was generated once on PC-A with `iceServers: []`, copied to PC-B, and SHA-256 checked byte-for-byte before the run.

## Evidence from the successful cross-PC connection

Requester → PC-B selected pair:

```text
local  = 192.168.1.107:50555 / udp / host
remote = 192.168.1.106:54210 / udp / host
state = succeeded
nominated = true
selected = true
```

PC-B observed the exact reverse pair and also reported `succeeded / nominated / selected`.

Across the probe reports:

```text
iceServers: []
actual candidate type: host only
mdnsLocalCandidateCount: 0
mdnsRemoteCandidateCount: 0
externalResourceCount: 0
connectionsWithoutPeerId: 0
ambiguousAddressCount: 0
```

The requester log repeatedly reused the PC-B peer connection during model/RPC traffic and the chat produced a normal answer (`Hello` → assistant response). This is evidence of real cross-machine RPC use, not only signaling or DataChannel establishment.

## Failure found before the successful run: Chrome mDNS host candidates

With Chrome's normal WebRTC host-candidate anonymization enabled, the same physical LAN did **not** establish the PC-A ↔ PC-B DataChannel.

Observed failure:

- signaling reached PC-B (`received connection`)
- both sides exchanged host candidates
- candidates were `.local` mDNS names
- PC-A could resolve PC-B's `.local` name to `192.168.1.106`
- PC-B could **not** resolve PC-A's `.local` name
- the failed PC-B connection had `pairs: []`, `selected: null`, and never entered ICE `checking`
- adding an inbound Windows Firewall rule for UDP/5353 on PC-A did not make PC-B resolve the name

For the successful diagnostic run, Chrome's `WebRtcHideLocalIpsWithMdns` behavior was disabled on both machines. Candidates then contained the raw LAN addresses and ICE immediately progressed through `checking → connected`.

Therefore the strongest supported conclusion is:

> In this test environment, Chrome's mDNS-obfuscated host-candidate resolution was the blocker. Host-only WebRTC itself works across the two physical PCs when the raw LAN candidates are usable.

This is **not** a product solution. Requiring every participant to change a Chrome flag is unacceptable for BYOD. Default-browser connectivity remains an integration/demo risk.

## Windows Firewall observation

Before the successful run, PC-B could not connect to PC-A's PeerServer even though it listened on `0.0.0.0:9000`.

After adding a Private-profile inbound TCP/9000 rule on PC-A:

```text
PC-B 192.168.1.106 → PC-A 192.168.1.107:9000
TcpTestSucceeded: True
```

So PeerServer reachability must be checked separately from same-host tests.

## `/restart` / cleanup observation (O9)

The separate same-PC restart check reproduced:

```text
RuntimeError: unreachable
WGPUBufferImpl::Destroy()
wgpuBufferDestroy
webgpu_buf_pool::cleanup()
```

on a restart path. The Runtime subsequently reconnected and another prompt still produced an answer, so the observed exception was not fatal in that run. It remains a lifecycle defect and must not be treated as fixed.

## What Stage 3 proves — and does not prove

Proved:

- two physical PCs can participate in one browser-side llama.cpp RPC inference
- the data plane can be direct WebRTC DataChannel traffic on the LAN
- STUN/TURN is not required for the successful measured path
- runtime HTTP dependencies can remain local during the run

Not proved yet:

- default Chrome settings work on arbitrary venue/BYOD networks
- Hono signaling + the Web application's custom `PeerManager` works with the real WASM
- a model that cannot fit on one participant machine can run when memory is pooled
- requester/runtime restart and peer-generation changes are robust

## Next critical path

Do not spend more time instrumenting the PeerJS reference path unless a new failure requires it.

The next vertical slice is:

1. expose the real WASM Runtime to the Web repository without PeerJS
2. inject the Web repository's `Module.PeerManager` implementation into the Emscripten module
3. run real prompt/model/output handling through that adapter
4. prove the Hono-signaled path first on one machine, then on the same physical two PCs
5. after integration works, move to the product proof: a dense model that does not fit on one peer but runs across multiple peers
