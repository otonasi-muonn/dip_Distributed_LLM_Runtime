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
  /** accept() handed this fd to the Runtime this many times. */
  /** @type {Map<number, number>} */
  const acceptedCounts = new Map();
  /** The Runtime called close_connection() on this fd this many times. */
  /** @type {Map<number, number>} */
  const runtimeCloseCounts = new Map();

  const bump = (counter, fd) => {
    const next = (counter.get(fd) ?? 0) + 1;
    counter.set(fd, next);
    return next;
  };

  let nextFd = 0;

  // conns holds tombstones as well as live connections, so a number stays reserved
  // until the Runtime releases it.
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

  /**
   * Tombstone a connection: it stops carrying data, but its fd number stays reserved.
   *
   * The Runtime still owns that fd after the transport drops - ggml-rpc closes the
   * socket from socket_t's destructor, or from the server loop after
   * rpc_serve_client() returns, both well after the peer went away. Handing the same
   * number to a new connection in the meantime would make the Runtime's close_peer()
   * tear down somebody else's connection, which is a harness bug that looks exactly
   * like a Runtime bug.
   */
  const tombstone = (conn) => {
    if (conn.closed) return;
    conn.closed = true;
    // Leave conn in `conns` so newFd() cannot reuse the number.
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
    // one connection per remote is alive at a time. The old one is tombstoned, not
    // released: its fd still belongs to the Runtime.
    if (previous) tombstone(previous);
    const conn = {
      fd,
      remoteId,
      closed: false,
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
    if (!conn || conn.closed) return false;
    post(conn.remoteId, "accepted");
    done(fd);
    emit({ type: "accept", fd, remoteId: conn.remoteId, accepted: bump(acceptedCounts, fd) });
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
        if (conn) tombstone(conn);
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
      if (!conn || conn.closed) return -1;
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
      if (!conn || conn.closed) {
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
        if (conns.get(fd) !== conn || conn.closed) {
          doneCB(false);
          return;
        }
        drain();
        doneCB(true);
      };
    },

    // The Runtime closing the fd is the only thing that releases the number for
    // reuse. Counting these calls is how the harness observes patches/0002: the RPC
    // server has to close the fd it accepted, or this never fires on the peer side.
    close_connection(fd) {
      const conn = conns.get(fd);
      if (!conn) return -1;
      if (!conn.closed) {
        post(conn.remoteId, "close");
        tombstone(conn);
      }
      conns.delete(fd);
      emit({
        type: "runtime_close",
        fd,
        remoteId: conn.remoteId,
        runtimeCloses: bump(runtimeCloseCounts, fd),
      });
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

    // Tombstones everything but releases nothing: the Runtime is still up and will
    // close its fds itself. Releasing here would re-open the reuse race.
    close() {
      for (const conn of [...conns.values()]) tombstone(conn);
      byRemote.clear();
      readyFds.length = 0;
      // acceptWaiters survive on purpose: a peer parks in accept() before anyone
      // connects, and dropping that callback strands the RPC thread in Atomics.wait().
      emit({ type: "closed", pendingAccepts: acceptWaiters.length });
    },

    // Harness introspection, not part of the Runtime contract.
    openFds() {
      return [...conns.keys()].filter((fd) => !conns.get(fd).closed);
    },

    /** fd numbers held by the harness, live or tombstoned. */
    reservedFds() {
      return [...conns.keys()];
    },

    /**
     * Per fd number, across every connection that used it.
     *
     * accepted vs runtimeCloses separates the two patches: runtimeCloses only keeps
     * up with accepted if the RPC server closes what it accepted (0002), and
     * registrations only keeps up if close_peer() cleared Module._connbuf (0001).
     */
    fdStats() {
      const fds = new Set([
        ...connectionCounts.keys(),
        ...registrationCounts.keys(),
        ...acceptedCounts.keys(),
        ...runtimeCloseCounts.keys(),
      ]);
      return [...fds]
        .sort((a, b) => a - b)
        .map((fd) => {
          const conn = conns.get(fd);
          return {
            fd,
            connections: connectionCounts.get(fd) ?? 0,
            accepted: acceptedCounts.get(fd) ?? 0,
            registrations: registrationCounts.get(fd) ?? 0,
            runtimeCloses: runtimeCloseCounts.get(fd) ?? 0,
            state: conn === undefined ? "released" : conn.closed ? "closed" : "live",
          };
        });
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
