// A RuntimePeerManager for the Runtime-only harness.
//
// This exists to test the Runtime below the Web boundary: everything the Web repo
// owns (Hono signaling, RTCPeerConnection, DataChannel framing, backpressure) is
// replaced by a same-origin message bus. It implements the contract in
// docs/RUNTIME_INTERFACE.md and nothing else.
//
// It deliberately does NOT reimplement the Web repo's DataChannel wire format. That
// format exists to satisfy SCTP (1-byte header, 64 KiB frames, receive-queue caps);
// copying it here would test our copy of it, not the Runtime.
//
// It also has no releaseBuf hook: the receive buffer is owned by the WASM glue.

const DEFAULT_FD_MAX = 1024;

// How much one send() accepts, and therefore how big one structured clone gets.
//
// This is a harness number, not the Web repo's 64 KiB SCTP frame. It exists for two
// reasons: a single clone of a 100 MiB tensor would stall the sender's event loop,
// and returning a short count is what drives send_peer_retry() in ggml-rpc.cpp
// through its partial-send path (retry, advance the pointer, emscripten_sleep(0)).
// Always accepting everything would leave that path untested here.
export const SEND_CHUNK_BYTES = 256 * 1024;

/**
 * @param {object} options
 * @param {string} options.nodeId          this context's address on the bus
 * @param {object} options.transport       { post(message), onMessage(fn), close() }
 * @param {number} [options.fdMax]         fd numbers cycle below this. Lower it to make
 *                                         fd reuse observable within a short session.
 * @param {(event: object) => void} [options.onEvent]
 */
export function createHarnessPeerManager(options) {
  const nodeId = options.nodeId;
  const transport = options.transport;
  const fdMax = options.fdMax ?? DEFAULT_FD_MAX;
  const emit = (event) => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      console.error("harness onEvent failed", error);
    }
  };

  /** @type {Map<number, object>} */
  const conns = new Map();
  /** @type {Map<string, object>} */
  const byRemote = new Map();
  /** @type {number[]} */
  const readyFds = [];
  /** @type {((fd: number) => void)[]} */
  const acceptWaiters = [];

  // Per fd number, not per connection: these have to survive the connection so a
  // reused fd shows up as a second entry rather than starting over.
  /** @type {Map<number, number>} */
  const connectionCounts = new Map();
  /** @type {Map<number, number>} */
  const registrationCounts = new Map();

  const bump = (counter, fd) => {
    const next = (counter.get(fd) ?? 0) + 1;
    counter.set(fd, next);
    return next;
  };

  let nextFd = 0;

  const newFd = () => {
    for (let i = 0; i < fdMax; i += 1) {
      if (nextFd >= fdMax) nextFd = 0;
      const fd = nextFd;
      nextFd += 1;
      if (!conns.has(fd)) return fd;
    }
    emit({ type: "error", message: `no free fd below ${fdMax}` });
    return null;
  };

  const post = (to, kind, bytes) => {
    transport.post({ from: nodeId, to, kind, bytes });
  };

  const destroy = (conn) => {
    // Drop the registration before waking anyone, so a parked recv cannot mistake a
    // dead connection for a live one.
    if (conns.get(conn.fd) === conn) conns.delete(conn.fd);
    if (byRemote.get(conn.remoteId) === conn) byRemote.delete(conn.remoteId);
    const queued = readyFds.indexOf(conn.fd);
    if (queued >= 0) readyFds.splice(queued, 1);
    conn.queue = [];
    conn.queuedBytes = 0;

    const wake = conn.wake;
    conn.wake = null;
    if (wake) wake();

    const accepted = conn.accepted;
    conn.accepted = null;
    if (accepted) accepted(false);

    emit({ type: "close", fd: conn.fd, remoteId: conn.remoteId });
  };

  const createConn = (fd, remoteId) => {
    const previous = byRemote.get(remoteId);
    // The C side opens and closes sockets repeatedly over one logical link, so only
    // one connection per remote is alive at a time.
    if (previous) destroy(previous);
    const conn = {
      fd,
      remoteId,
      queue: [],
      queuedBytes: 0,
      wake: null,
      accepted: null,
      moduleBuf: null,
    };
    conns.set(fd, conn);
    byRemote.set(remoteId, conn);
    emit({ type: "open", fd, remoteId, connection: bump(connectionCounts, fd) });
    return conn;
  };

  const settleAccept = (fd, done) => {
    const conn = conns.get(fd);
    if (!conn) return false;
    post(conn.remoteId, "accepted");
    done(fd);
    emit({ type: "accept", fd, remoteId: conn.remoteId });
    return true;
  };

  const handleConnect = (remoteId) => {
    const fd = newFd();
    if (fd === null) return;
    createConn(fd, remoteId);
    const waiter = acceptWaiters.shift();
    if (waiter) {
      if (!settleAccept(fd, waiter)) acceptWaiters.unshift(waiter);
      return;
    }
    readyFds.push(fd);
  };

  const handleData = (remoteId, bytes) => {
    const conn = byRemote.get(remoteId);
    if (!conn || bytes.byteLength === 0) return;
    conn.queue.push(bytes);
    conn.queuedBytes += bytes.byteLength;
    const wake = conn.wake;
    conn.wake = null;
    if (wake) wake();
  };

  transport.onMessage((message) => {
    if (!message || message.to !== nodeId) return;
    switch (message.kind) {
      case "connect":
        handleConnect(message.from);
        return;
      case "accepted": {
        const conn = byRemote.get(message.from);
        if (!conn) return;
        const accepted = conn.accepted;
        conn.accepted = null;
        if (accepted) accepted(true);
        return;
      }
      case "data":
        handleData(message.from, message.bytes);
        return;
      case "close": {
        const conn = byRemote.get(message.from);
        if (conn) destroy(conn);
        return;
      }
      default:
        emit({ type: "error", message: `unknown frame: ${String(message.kind)}` });
    }
  });

  return {
    connect(remoteId, done) {
      const fd = newFd();
      if (fd === null) {
        done(-1);
        return;
      }
      const conn = createConn(fd, remoteId);
      conn.accepted = (ok) => done(ok ? fd : -1);
      post(remoteId, "connect");
    },

    accept(done) {
      while (readyFds.length > 0) {
        const fd = readyFds.shift();
        if (fd === undefined) break;
        if (settleAccept(fd, done)) return;
      }
      acceptWaiters.push(done);
    },

    // Accepts at most SEND_CHUNK_BYTES and reports how much it took, the way a
    // socket does. send_peer_retry() advances the pointer and calls back, so large
    // tensors go out as several bounded messages instead of one huge clone.
    send(fd, data) {
      const conn = conns.get(fd);
      if (!conn) return -1;
      if (data.byteLength === 0) return 0;
      const take = Math.min(SEND_CHUNK_BYTES, data.byteLength);
      try {
        // slice(), never subarray(). data is a window into the WASM heap, which is a
        // SharedArrayBuffer in the pthread build: structured-cloning a view of it would
        // hand the other tab live access to this Runtime's memory, and the sender is
        // free to reuse those bytes the moment send() returns. slice() copies into a
        // fresh, non-shared ArrayBuffer of exactly `take` bytes.
        post(conn.remoteId, "data", data.slice(0, take));
      } catch (error) {
        emit({ type: "error", message: `send failed on fd ${fd}: ${String(error)}` });
        return -1;
      }
      return take;
    },

    recv(fd, len, writeCB, doneCB) {
      const conn = conns.get(fd);
      if (!conn) {
        doneCB(false);
        return;
      }
      const drain = () => {
        let written = 0;
        let remaining = len;
        while (conn.queue.length > 0 && remaining > 0) {
          const head = conn.queue[0];
          const take = Math.min(remaining, head.byteLength);
          writeCB(head.subarray(0, take));
          if (take < head.byteLength) conn.queue[0] = head.subarray(take);
          else conn.queue.shift();
          conn.queuedBytes -= take;
          written += take;
          remaining -= take;
        }
        return written;
      };

      if (drain() > 0) {
        doneCB(true);
        return;
      }
      // Nothing buffered: park until data arrives or the connection dies. Calling
      // doneCB(true) with zero bytes would look like a closed peer to recv_data().
      conn.wake = () => {
        if (conns.get(fd) !== conn) {
          doneCB(false);
          return;
        }
        drain();
        doneCB(true);
      };
    },

    close_connection(fd) {
      const conn = conns.get(fd);
      if (!conn) return -1;
      post(conn.remoteId, "close");
      destroy(conn);
      return 0;
    },

    // Recording only. The buffer belongs to the WASM glue, which frees it in
    // close_peer() on the thread that allocated it (patches/0001-*).
    //
    // The observable for that patch is the registration *count* per fd: recv_peer()
    // only calls register_buf() while Module._connbuf[fd] is empty, so a reused fd
    // registering again proves the slot was cleared. The pointer value says nothing -
    // malloc is free to hand back the address it just released - so epoch, not ptr,
    // is what the browser check looks at.
    register_buf(fd, ptr) {
      const conn = conns.get(fd);
      if (conn) conn.moduleBuf = ptr;
      emit({
        type: "register_buf",
        fd,
        ptr,
        epoch: bump(registrationCounts, fd),
        remoteId: conn ? conn.remoteId : null,
      });
    },

    close() {
      for (const conn of [...conns.values()]) destroy(conn);
      byRemote.clear();
      readyFds.length = 0;
      // acceptWaiters survive on purpose: a peer parks in accept() before anyone
      // connects, and dropping that callback strands the RPC thread in Atomics.wait().
      emit({ type: "closed", pendingAccepts: acceptWaiters.length });
    },

    // Harness introspection, not part of the Runtime contract.
    openFds() {
      return [...conns.keys()];
    },

    /** Per fd: how many connections used it, and how many buffers it registered. */
    fdStats() {
      const fds = new Set([...connectionCounts.keys(), ...registrationCounts.keys()]);
      return [...fds]
        .sort((a, b) => a - b)
        .map((fd) => ({
          fd,
          connections: connectionCounts.get(fd) ?? 0,
          registrations: registrationCounts.get(fd) ?? 0,
        }));
    },
  };
}

/** BroadcastChannel transport for the browser harness. */
export function createBroadcastTransport(name) {
  const channel = new BroadcastChannel(name);
  return {
    post(message) {
      channel.postMessage(message);
    },
    onMessage(handler) {
      channel.onmessage = (event) => handler(event.data);
    },
    close() {
      channel.close();
    },
  };
}
