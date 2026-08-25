// Observation probe for the LAN-only constraint (docs/DECISIONS.md D1 / D2)
// and for ICE failure diagnosis (docs/CONSTRAINTS.md O4).
//
// Copied into a bundle by scripts/make-lan-bundle.py --probe. Purely
// observational: it records, it never blocks or rewrites a request.
//
// LOAD ORDER MATTERS. This must run AFTER peerjs.min.js and BEFORE
// llmlet.js, and make-lan-bundle.py injects the <script> tag there.
//
// PeerJS 1.5.5 runs a feature-detection IIFE at module load:
//
//     e = new RTCPeerConnection(eu)                 // eu = DEFAULT_CONFIG
//     n = e.createDataChannel("_PEERJSTEST", ...)   // then closes both
//
// and its DEFAULT_CONFIG carries Google STUN plus the PeerJS TURN servers.
// Loading this probe earlier would capture that config and report the
// bundle as using STUN/TURN when it does not. The IIFE never calls
// createOffer or setLocalDescription, so no ICE gathering starts and no
// packet leaves the machine - the earlier position can only manufacture a
// false positive, never catch a real one.
//
// Loading after peerjs is also what actually works: peerjs resolves the
// bare global `RTCPeerConnection` at call time inside
// `_startPeerConnection()`, and webrtc-adapter (bundled inside peerjs)
// installs its own shim on `window.RTCPeerConnection` while it loads. We
// want to wrap the shim the application will really call.
//
// Loading before llmlet.js is what makes the peer-id association work:
// llmlet drives both directions through Peer, so wrapping Peer.prototype
// here catches the calls llmlet is about to make.
(function () {
  "use strict";

  const iceConfigs = [];
  const candidateTypes = new Set();
  const connections = [];
  const byPc = new WeakMap();
  let constructed = 0;

  const Native = window.RTCPeerConnection;
  if (typeof Native !== "function") {
    console.warn("[lan-probe] no RTCPeerConnection to wrap");
    return;
  }

  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);

  function clone(value) {
    if (value === undefined) return "(constructed with no argument)";
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return String(value);
    }
  }

  // An mDNS-obfuscated host candidate carries a <uuid>.local name instead of
  // the LAN address. That name only resolves inside the same multicast
  // domain, so its presence is the single most useful bit when a 2PC
  // DataChannel fails (docs/CONSTRAINTS.md O4). RTCIceCandidate.address is
  // not populated everywhere, so fall back to the SDP candidate line, whose
  // 5th whitespace-separated field is the connection address.
  // Chrome reports "" (not undefined) for the address of an mDNS candidate in
  // getStats(), so a plain `a || b` chain silently yields an empty string.
  function nonEmpty(value) {
    return typeof value === "string" && value !== "" ? value : null;
  }

  function isMdnsName(address) {
    return typeof address === "string" && /\.local$/i.test(address);
  }

  function numOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // An SDP candidate line is
  //   candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
  // Parsed as the fallback whenever the RTCIceCandidate attributes are absent,
  // which is the case for the plain init dicts PeerJS hands to
  // addIceCandidate().
  //
  // `component` is deliberately NOT extracted: it is absent from Chrome's
  // candidate stats (measured on 151), and RTCIceCandidate spells it
  // "rtp"/"rtcp" rather than 1/2, so it cannot join the two sides. `priority`
  // and `foundation` exist on both and are used instead.
  function describeSignaled(candidate) {
    const line = String(candidate.candidate || "");
    const p = line.split(/\s+/);
    const foundation =
      nonEmpty(candidate.foundation) ||
      (p.length > 0 ? nonEmpty(p[0].replace(/^candidate:/, "")) : null);
    const priority =
      numOrNull(candidate.priority) !== null
        ? numOrNull(candidate.priority)
        : p.length > 3
          ? numOrNull(p[3])
          : null;
    const address = nonEmpty(candidate.address) || (p.length > 4 ? p[4] : null);
    const port =
      numOrNull(candidate.port) !== null
        ? numOrNull(candidate.port)
        : p.length > 5
          ? numOrNull(p[5])
          : null;
    const protocol =
      nonEmpty(candidate.protocol) || (p.length > 2 ? p[2].toLowerCase() : null);
    const type =
      nonEmpty(candidate.type) || (p.length > 7 && p[6] === "typ" ? p[7] : null);
    return {
      atMs: ms(),
      candidate: line,
      type: type,
      address: address,
      port: port,
      protocol: protocol,
      foundation: foundation,
      priority: priority,
      isMdns: isMdnsName(address),
    };
  }

  // getStats() redacts the address of an mDNS candidate, so recover it from
  // the candidate we saw signalled, joining on port+protocol. Without this the
  // failing pairs in a 2PC run come back with no addresses at all, which is
  // precisely the information O4 needs.
  const STRONG_KEY = "foundation+protocol+port+type+priority";
  const WEAK_KEY = "protocol+port+type";

  function sameBase(signaled, stat) {
    return (
      signaled.port === numOrNull(stat.port) &&
      signaled.protocol === (stat.protocol || null) &&
      signaled.type === (stat.candidateType || null)
    );
  }

  function matchSignaled(pool, stat) {
    // Strong tier first. It only applies to entries where both sides actually
    // carry foundation and priority; anything missing them is not silently
    // treated as a match.
    const statFoundation = nonEmpty(stat.foundation);
    const statPriority = numOrNull(stat.priority);
    if (statFoundation !== null && statPriority !== null) {
      const strong = pool.filter(
        (c) =>
          sameBase(c, stat) &&
          c.foundation !== null &&
          c.priority !== null &&
          String(c.foundation) === String(statFoundation) &&
          c.priority === statPriority
      );
      if (strong.length > 0) return { matches: strong, matchedOn: STRONG_KEY };
    }
    const weak = pool.filter((c) => sameBase(c, stat));
    return { matches: weak, matchedOn: weak.length > 0 ? WEAK_KEY : null };
  }

  function describeStatCandidate(stat, rec) {
    if (!stat) return null;
    const direct = nonEmpty(stat.address) || nonEmpty(stat.ip);

    let address = direct;
    let addressSource = direct ? "stats" : null;
    let matchedOn = null;
    let candidateMatches = null;

    if (!address) {
      const isRemote =
        stat.isRemote !== undefined
          ? !!stat.isRemote
          : stat.type === "remote-candidate";
      const pool = isRemote ? rec.remoteCandidates : rec.candidates;
      const found = matchSignaled(pool, stat);
      candidateMatches = found.matches.length;
      if (found.matches.length === 1) {
        address = found.matches[0].address;
        addressSource = "signaled";
        matchedOn = found.matchedOn;
      } else if (found.matches.length > 1) {
        // Do NOT guess. Reporting one of several plausible addresses is worse
        // than reporting none, because it reads as a fact downstream.
        addressSource = "ambiguous-signaled";
        matchedOn = found.matchedOn;
      }
    }

    return {
      type: stat.candidateType || null,
      // NOTE: when addressSource is "signaled" this is the address as it was
      // SIGNALLED. If it ends in .local it is still an mDNS name - the real IP
      // has not been recovered and cannot be, from here.
      address: address,
      addressSource: addressSource,
      addressRedactedByStats: !direct,
      matchedOn: matchedOn,
      candidateMatches: candidateMatches,
      port: numOrNull(stat.port),
      protocol: stat.protocol || null,
      foundation: nonEmpty(stat.foundation),
      priority: numOrNull(stat.priority),
      isMdns: isMdnsName(address),
    };
  }

  // Prefer transport.selectedCandidatePairId: it is what the browser actually
  // chose. A `nominated && succeeded` scan can match more than one pair
  // across an ICE restart, so it is only the fallback.
  function digestStats(statsReport, rec) {
    const byId = new Map();
    statsReport.forEach((s) => byId.set(s.id, s));

    let selectedId = null;
    statsReport.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) {
        selectedId = s.selectedCandidatePairId;
      }
    });

    const pairs = [];
    statsReport.forEach((s) => {
      if (s.type !== "candidate-pair") return;
      pairs.push({
        id: s.id,
        state: s.state || null,
        nominated: !!s.nominated,
        selected: selectedId != null && s.id === selectedId,
        local: describeStatCandidate(byId.get(s.localCandidateId), rec),
        remote: describeStatCandidate(byId.get(s.remoteCandidateId), rec),
      });
    });

    let selected = pairs.find((p) => p.selected) || null;
    let selectedVia = selected ? "transport.selectedCandidatePairId" : null;
    if (!selected) {
      selected = pairs.find((p) => p.state === "succeeded" && p.nominated) || null;
      if (selected) {
        selected.selected = true;
        selectedVia = "fallback(nominated+succeeded)";
      }
    }
    return { pairs: pairs, selected: selected, selectedVia: selectedVia };
  }

  // getStats() is async, but report() is not and must stay that way - the
  // 段2.6 / 段2.7 procedures call it synchronously. So snapshots are taken in
  // the background on state changes and report() returns what landed.
  //
  // `checking` is included because a pair that fails early can be gone from
  // the stats by the time `failed` arrives.
  const SNAPSHOT_STATES = [
    "checking",
    "connecting",
    "connected",
    "completed",
    "failed",
    "disconnected",
  ];

  // Two getStats() calls can be in flight at once (e.g. checking then
  // connected), and they are NOT guaranteed to settle in the order they were
  // issued. Without a sequence guard a late-returning `checking` digest would
  // overwrite the newer `connected` one and rec.stats would travel backwards
  // in time. Only a request at least as new as the last applied one may write.
  let statsSeq = 0;

  function snapshot(pc, rec, trigger) {
    const seq = ++statsSeq;
    const entry = {
      seq: seq,
      trigger: trigger || "manual",
      requestedAtMs: ms(),
      completedAtMs: null,
      digest: null,
      error: null,
    };
    // Pushed at request time, so the array is in seq order by construction and
    // a still-pending request is visible rather than invisible.
    rec.statsSnapshots.push(entry);

    const settle = (digest, error) => {
      entry.completedAtMs = ms();
      entry.digest = digest;
      entry.error = error;
      if (digest && seq >= rec.latestStatsSeq) {
        rec.latestStatsSeq = seq;
        rec.stats = digest;
        rec.statsAtMs = entry.completedAtMs;
      }
      if (digest) mergeObserved(rec, digest, seq);
    };

    let p;
    try {
      p = pc.getStats();
    } catch (e) {
      settle(null, String(e));
      return Promise.resolve();
    }
    return Promise.resolve(p)
      .then((statsReport) => settle(digestStats(statsReport, rec), null))
      // A connection torn down mid-flight rejects here. Record it; never let
      // observation break the page.
      .catch((e) => settle(null, String(e)));
  }

  // Union of the candidate-pairs seen across snapshots.
  //
  // NOT "every pair that was tried": with no polling, a pair created and
  // discarded between two snapshots is never observed at all. This is the
  // observation history, and it is named so that nobody reads more into it.
  // Snapshots can settle out of order, so this splits into two kinds of fact:
  //
  //   order-independent - "was this pair ever observed / ever nominated / seen
  //     in this state at all". A digest that settles late is still a real
  //     observation and must not be discarded just because a newer one landed
  //     first, or the aggregate silently loses what the earlier snapshot saw.
  //   latest-wins - "what did it look like most recently". Only a request at
  //     least as new as the last applied one may write these.
  //
  // `statesSeen` is a set, not a timeline: with out-of-order settling the
  // arrival order is not the observation order, so it is deliberately not
  // named in a way that implies sequence.
  function mergeObserved(rec, digest, seq) {
    if (!digest || !digest.pairs) return;
    digest.pairs.forEach((pair) => {
      let prev = rec.pairsEverObserved[pair.id];
      if (!prev) {
        prev = rec.pairsEverObserved[pair.id] = {
          id: pair.id,
          firstSeenSeq: seq,
          lastSeenSeq: -Infinity,
          statesSeen: [],
          lastState: null,
          everNominated: false,
          everSelected: false,
          local: null,
          remote: null,
        };
      }

      // --- order-independent ---
      if (seq < prev.firstSeenSeq) prev.firstSeenSeq = seq;
      if (prev.statesSeen.indexOf(pair.state) === -1) {
        prev.statesSeen.push(pair.state);
      }
      prev.everNominated = prev.everNominated || !!pair.nominated;
      prev.everSelected = prev.everSelected || !!pair.selected;

      // --- latest-wins ---
      if (seq >= prev.lastSeenSeq) {
        prev.lastSeenSeq = seq;
        prev.lastState = pair.state;
        prev.local = pair.local;
        prev.remote = pair.remote;
      }
    });
  }

  function Probed(config) {
    constructed += 1;
    iceConfigs.push(clone(config));

    const pc = new Native(...arguments);
    const rec = {
      connectionId: constructed,
      createdAtMs: ms(),
      // Filled in by the Peer.prototype wrappers below. Stays null when the
      // association could not be made - a sequence number on its own does
      // NOT tell you which physical peer this was.
      peerId: null,
      direction: null,
      config: clone(config),
      candidates: [],
      remoteCandidates: [],
      candidateErrors: [],
      transitions: [],
      // Latest successfully applied digest, guarded by latestStatsSeq so a
      // late-settling older request cannot overwrite a newer one.
      stats: null,
      statsAtMs: null,
      latestStatsSeq: 0,
      statsSnapshots: [],
      pairsEverObserved: {},
    };
    // Non-enumerable so JSON.stringify(report()) does not choke on the cycle.
    Object.defineProperty(rec, "pc", { value: pc, enumerable: false });
    connections.push(rec);
    byPc.set(pc, rec);

    function note(kind, value) {
      rec.transitions.push({ atMs: ms(), kind: kind, value: value });
    }

    function maybeSnapshot(kind, state) {
      if (SNAPSHOT_STATES.indexOf(state) === -1) return;
      snapshot(pc, rec, kind + ":" + state);
    }

    pc.addEventListener("icecandidate", (event) => {
      // A null candidate is the end-of-gathering signal, not a candidate.
      if (!event.candidate) {
        candidateTypes.add("(gathering-complete)");
        note("icecandidate", "(gathering-complete)");
        return;
      }
      const described = describeSignaled(event.candidate);
      candidateTypes.add(described.type);
      rec.candidates.push(described);
    });

    // The remote side's candidates never surface as events, and getStats()
    // redacts their addresses too. addIceCandidate() is where PeerJS hands
    // them over, so that is the only place we can see whether the OTHER
    // machine sent an mDNS name.
    const origAddIceCandidate = pc.addIceCandidate;
    if (typeof origAddIceCandidate === "function") {
      pc.addIceCandidate = function (candidate) {
        try {
          if (candidate && candidate.candidate) {
            rec.remoteCandidates.push(describeSignaled(candidate));
          }
        } catch (e) {
          /* observation must never break the connection */
        }
        return origAddIceCandidate.apply(pc, arguments);
      };
    }

    pc.addEventListener("icecandidateerror", (event) => {
      rec.candidateErrors.push({
        atMs: ms(),
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url,
        address: event.address,
        port: event.port,
      });
    });

    pc.addEventListener("icegatheringstatechange", () => {
      note("iceGatheringState", pc.iceGatheringState);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      note("iceConnectionState", pc.iceConnectionState);
      maybeSnapshot("iceConnectionState", pc.iceConnectionState);
    });
    pc.addEventListener("connectionstatechange", () => {
      note("connectionState", pc.connectionState);
      maybeSnapshot("connectionState", pc.connectionState);
    });

    return pc;
  }
  Probed.prototype = Native.prototype;
  Object.setPrototypeOf(Probed, Native); // keeps generateCertificate etc.
  window.RTCPeerConnection = Probed;

  // ---- peer id association ------------------------------------------------
  //
  // The RTCPeerConnection wrapper alone cannot see which PeerJS peer is on
  // the far end. llmlet drives both directions through Peer, so wrap that:
  //   outgoing: peer.connect(dst)         <- llmlet.js connectPeer()
  //   incoming: peer.on('connection', cb) <- llmlet.js newPeerManager()
  // DataConnection.peerConnection may not exist yet at the instant we get
  // control, so retry across a few macrotasks before giving up.
  function associate(conn, peerId, direction, attempt) {
    if (!conn || !peerId) return;
    const pc = conn.peerConnection;
    if (pc) {
      const rec = byPc.get(pc);
      if (rec) {
        rec.peerId = peerId;
        rec.direction = direction;
      }
      return;
    }
    if ((attempt || 0) >= 10) return;
    setTimeout(() => associate(conn, peerId, direction, (attempt || 0) + 1), 0);
  }

  const PeerCtor = window.Peer;
  if (typeof PeerCtor === "function" && PeerCtor.prototype) {
    const origConnect = PeerCtor.prototype.connect;
    if (typeof origConnect === "function") {
      PeerCtor.prototype.connect = function (dst) {
        const conn = origConnect.apply(this, arguments);
        associate(conn, dst, "outgoing", 0);
        return conn;
      };
    }

    const origOn = PeerCtor.prototype.on;
    if (typeof origOn === "function") {
      PeerCtor.prototype.on = function (event, cb) {
        if (event === "connection" && typeof cb === "function") {
          const wrapped = function (conn) {
            associate(conn, conn && conn.peer, "incoming", 0);
            return cb.apply(this, arguments);
          };
          return origOn.call(this, event, wrapped);
        }
        return origOn.apply(this, arguments);
      };
    }
  } else {
    console.warn(
      "[lan-probe] window.Peer not found; peer-id association is off. " +
        "This script must load after peerjs.min.js."
    );
  }

  function isLocalOrigin(url) {
    try {
      const host = new URL(url).hostname;
      return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      );
    } catch (e) {
      return false;
    }
  }

  function preflight() {
    const row = {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      gpu: !!navigator.gpu,
      sab: typeof SharedArrayBuffer,
    };
    console.table([row]);
    console.log("[lan-probe] `gpu: true` only means the API exists; run await __lanProbe.gpu() for the adapter");
    return row;
  }

  // Kept separate from preflight() so preflight can stay synchronous and run
  // at load. `navigator.gpu` being present says nothing about whether an
  // adapter can actually be acquired, and the limits differ per machine - on
  // a second machine this is what separates "its GPU" from "the transport".
  async function gpu() {
    const row = {
      api: !!navigator.gpu,
      adapter: false,
      maxStorageBufferBindingSize: null,
      maxBufferSize: null,
    };
    if (navigator.gpu) {
      let adapter = null;
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (e) {
        row.error = String(e);
      }
      if (adapter) {
        row.adapter = true;
        row.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
        row.maxBufferSize = adapter.limits.maxBufferSize;
        // GPUAdapterInfo exposes its fields as prototype getters, so a spread
        // copies nothing - name them.
        if (adapter.info) {
          row.info = {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          };
        }
      }
    }
    console.table([row]);
    return row;
  }

  // Force a fresh snapshot on every connection. Async on purpose; report()
  // stays synchronous so the existing procedures keep working.
  async function refreshStats() {
    await Promise.all(connections.map((rec) => snapshot(rec.pc, rec, "manual")));
    return report();
  }

  function report() {
    const external = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => !isLocalOrigin(name));
    const unassociated = connections.filter((c) => c.peerId == null).length;
    const result = {
      externalResources: external,
      externalResourceCount: external.length,
      rtcPeerConnectionsConstructed: constructed,
      iceConfigs: iceConfigs,
      candidateTypes: Array.from(candidateTypes).sort(),
      // Split local vs remote: "we obfuscate" and "the other machine
      // obfuscates" are different findings for O4.
      mdnsLocalCandidateCount: connections.reduce(
        (n, c) => n + c.candidates.filter((x) => x.isMdns).length,
        0
      ),
      mdnsRemoteCandidateCount: connections.reduce(
        (n, c) => n + c.remoteCandidates.filter((x) => x.isMdns).length,
        0
      ),
      connectionsWithoutPeerId: unassociated,
      // Pairs whose address could not be pinned to exactly one signalled
      // candidate. Their addresses are deliberately null - see
      // describeStatCandidate.
      ambiguousAddressCount: connections.reduce(
        (n, c) =>
          n +
          Object.keys(c.pairsEverObserved).reduce((m, id) => {
            const p = c.pairsEverObserved[id];
            const l = p.local && p.local.addressSource === "ambiguous-signaled";
            const r = p.remote && p.remote.addressSource === "ambiguous-signaled";
            return m + (l ? 1 : 0) + (r ? 1 : 0);
          }, 0),
        0
      ),
      connections: connections,
    };
    console.log("[lan-probe] report", result);
    console.log(
      "[lan-probe] pairsEverObserved = pairs seen in SOME stats snapshot. " +
        "Not every pair that was tried: with no polling, a pair created and " +
        "discarded between two snapshots is never observed."
    );
    if (constructed === 0) {
      console.warn(
        "[lan-probe] no RTCPeerConnection was constructed through the probe. " +
          "Either no connection was attempted yet, or something captured the " +
          "constructor before this script ran - do not read empty ICE data as a pass."
      );
    }
    if (unassociated > 0) {
      console.warn(
        "[lan-probe] " +
          unassociated +
          " connection(s) have peerId: null. Correlate them by createdAtMs " +
          "against llmlet's `connecting to <peer>` / `received connection: <peer>` " +
          "lines - connectionId alone does NOT identify the peer."
      );
    }
    return result;
  }

  window.__lanProbe = { preflight, gpu, report, refreshStats, isLocalOrigin, connections };
  console.log("[lan-probe] installed; call __lanProbe.preflight() / await __lanProbe.gpu() / __lanProbe.report()");
  console.log("[lan-probe] hand off one blob per tab: copy(JSON.stringify(__lanProbe.report(), null, 2))");
  preflight();
})();
