// A minimal in-memory IndexedDB, just enough for openChunkCache().
//
// The point is not fidelity to the spec but control over the failure modes the
// Runtime has to survive: a get that errors, a transaction that aborts, and a
// database connection that was closed while the WASM side still uses it.

const later = (fn) => setTimeout(fn, 0);

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.result = undefined;
    this.error = null;
  }

  succeed(result) {
    this.result = result;
    later(() => this.onsuccess?.());
  }

  fail(error) {
    this.error = error;
    later(() => this.onerror?.());
  }
}

class FakeObjectStore {
  constructor(data, tx, failures) {
    this.data = data;
    this.tx = tx;
    this.failures = failures;
  }

  get(key) {
    const req = new FakeRequest();
    if (this.failures.get) {
      const error = new Error("simulated IndexedDB get failure");
      req.fail(error);
      this.tx.abortLater(error);
    } else {
      req.succeed(this.data.get(key));
      this.tx.completeLater();
    }
    return req;
  }

  put(value, key) {
    const req = new FakeRequest();
    if (this.failures.put) {
      const error = new Error("simulated IndexedDB put failure");
      req.fail(error);
      this.tx.abortLater(error);
    } else {
      this.data.set(key, value);
      req.succeed(undefined);
      this.tx.completeLater();
    }
    return req;
  }
}

class FakeTransaction {
  constructor(connection, storeName) {
    this.connection = connection;
    this.storeName = storeName;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
  }

  objectStore() {
    return new FakeObjectStore(
      this.connection.stores.get(this.storeName),
      this,
      this.connection.failures,
    );
  }

  completeLater() {
    later(() => this.oncomplete?.());
  }

  abortLater(error) {
    this.error = error;
    later(() => this.onabort?.());
  }
}

/** One open() result. Data is shared between connections; closing affects only this one. */
class FakeConnection {
  constructor(stores, failures) {
    this.stores = stores;
    this.failures = failures;
    this.closed = false;
    this.objectStoreNames = {
      contains: (name) => this.stores.has(name),
    };
  }

  createObjectStore(name) {
    this.stores.set(name, new Map());
  }

  transaction(storeName) {
    // Matches the browser: touching a closed connection throws synchronously.
    if (this.closed) {
      const error = new Error("InvalidStateError: the database connection is closing");
      error.name = "InvalidStateError";
      throw error;
    }
    if (!this.stores.has(storeName)) throw new Error(`no such store: ${storeName}`);
    return new FakeTransaction(this, storeName);
  }

  close() {
    this.closed = true;
  }
}

export function createFakeIndexedDB() {
  const failures = { open: false, get: false, put: false };
  /** @type {Map<string, Map<string, Map<string, unknown>>>} name -> stores */
  const contents = new Map();
  /** @type {FakeConnection[]} every connection handed out, so tests can inspect close() */
  const connections = [];

  const indexedDB = {
    open(name) {
      const req = new FakeRequest();
      later(() => {
        if (failures.open) {
          req.error = new Error("simulated IndexedDB open failure");
          req.onerror?.();
          return;
        }
        const isNew = !contents.has(name);
        if (isNew) contents.set(name, new Map());
        const connection = new FakeConnection(contents.get(name), failures);
        connections.push(connection);
        req.result = connection;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  return { indexedDB, failures, contents, connections };
}
