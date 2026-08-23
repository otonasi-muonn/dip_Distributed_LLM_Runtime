// Observation probe for the LAN-only constraint (docs/DECISIONS.md D1 / D2).
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
(function () {
  "use strict";

  const iceConfigs = [];
  const candidateTypes = new Set();
  let constructed = 0;

  const Native = window.RTCPeerConnection;
  if (typeof Native !== "function") {
    console.warn("[lan-probe] no RTCPeerConnection to wrap");
    return;
  }

  function clone(value) {
    if (value === undefined) return "(constructed with no argument)";
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return String(value);
    }
  }

  function Probed(config) {
    constructed += 1;
    iceConfigs.push(clone(config));
    const pc = new Native(...arguments);
    pc.addEventListener("icecandidate", (event) => {
      // A null candidate is the end-of-gathering signal, not a candidate.
      candidateTypes.add(event.candidate ? event.candidate.type : "(gathering-complete)");
    });
    return pc;
  }
  Probed.prototype = Native.prototype;
  Object.setPrototypeOf(Probed, Native); // keeps generateCertificate etc.
  window.RTCPeerConnection = Probed;

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

  function report() {
    const external = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => !isLocalOrigin(name));
    const result = {
      externalResources: external,
      externalResourceCount: external.length,
      rtcPeerConnectionsConstructed: constructed,
      iceConfigs: iceConfigs,
      candidateTypes: Array.from(candidateTypes).sort(),
    };
    console.log("[lan-probe] report", result);
    if (constructed === 0) {
      console.warn(
        "[lan-probe] no RTCPeerConnection was constructed through the probe. " +
          "Either no connection was attempted yet, or something captured the " +
          "constructor before this script ran - do not read empty ICE data as a pass."
      );
    }
    return result;
  }

  window.__lanProbe = { preflight, gpu, report, isLocalOrigin };
  console.log("[lan-probe] installed; call __lanProbe.preflight() / await __lanProbe.gpu() / __lanProbe.report()");
  preflight();
})();
