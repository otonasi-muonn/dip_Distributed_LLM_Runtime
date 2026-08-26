// A stand-in for the Emscripten factory in llmlet-mod.js.
//
// It reproduces the parts of the real module the adapter actually talks to:
// preRun with run dependencies, FS, ENV, TTY, release_conn and
// _emscripten_force_exit. It never calls pending_prompt itself - the test plays the
// part of main.cpp, so the C++ call order stays visible in the test body.
//
// The adapter imports this file by URL; a test importing the same path gets the same
// module instance, which is how `control` reaches the test.

const modules = [];
let waiters = [];

export const control = {
  modules,
  releaseConnCalls: [],
  forceExits: [],
  /** fullPath -> the FS node the adapter configured */
  files: new Map(),
  /** set to an Error to make the factory reject */
  failWith: null,

  reset() {
    modules.length = 0;
    waiters = [];
    control.releaseConnCalls.length = 0;
    control.forceExits.length = 0;
    control.files.clear();
    control.failWith = null;
  },

  /** Resolves once the adapter has handed a Module to the factory. */
  waitForModule(index = 0) {
    if (modules[index]) return Promise.resolve(modules[index]);
    return new Promise((resolve) => {
      waiters.push(() => {
        if (modules[index]) resolve(modules[index]);
      });
    });
  },
};

function publish(Module) {
  modules.push(Module);
  const pending = waiters;
  waiters = [];
  for (const fn of pending) fn();
}

class ErrnoError extends Error {
  constructor(errno) {
    super(`ErrnoError ${errno}`);
    this.name = "ErrnoError";
    this.errno = errno;
  }
}

function createFakeFS() {
  return {
    ErrnoError,
    mkdirTree() {},
    createDataFile(dir, name) {
      const node = { name, size: 0, stream_ops: null };
      control.files.set(`${dir}/${name}`, node);
    },
    lookupPath(fullPath) {
      const node = control.files.get(fullPath);
      if (!node) throw new Error(`no such path: ${fullPath}`);
      return { node };
    },
  };
}

export default async function factory(Module) {
  Module.ENV = {};
  Module.FS = createFakeFS();
  Module.TTY = { default_tty_ops: { put_char() {} } };
  Module.release_conn = (ptr) => control.releaseConnCalls.push(ptr);
  Module._emscripten_force_exit = (code) => {
    control.forceExits.push(code);
    // The real runtime routes force exit through _proc_exit, which calls onExit.
    Module.onExit?.(code);
  };

  let dependencies = 0;
  let onDependenciesDone = null;
  Module.addRunDependency = () => {
    dependencies += 1;
  };
  Module.removeRunDependency = () => {
    dependencies -= 1;
    if (dependencies === 0 && onDependenciesDone) onDependenciesDone();
  };

  publish(Module);

  if (control.failWith) throw control.failWith;

  // Emscripten passes Module as the first argument to every preRun callback.
  for (const callback of Module.preRun ?? []) callback(Module);
  if (dependencies > 0) {
    await new Promise((resolve) => {
      onDependenciesDone = resolve;
    });
  }

  Module.onRuntimeInitialized?.();
  return Module;
}
