// Install the browser globals requireBrowserRuntime() checks for, plus a fake
// IndexedDB. Node already provides SharedArrayBuffer, crypto.subtle, TextEncoder
// and File, so only the page-level globals are missing.

import { createFakeIndexedDB } from "./fake-indexeddb.mjs";

export function installBrowserEnv() {
  const fake = createFakeIndexedDB();

  globalThis.window = {
    isSecureContext: true,
    crossOriginIsolated: true,
  };
  globalThis.document = { baseURI: "file:///runtime-tests/" };
  globalThis.indexedDB = fake.indexedDB;

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  return {
    ...fake,
    warnings,
    restore() {
      console.warn = realWarn;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.indexedDB;
    },
  };
}
