"""Serve a directory with the headers the llmlet WASM runtime needs.

The runtime is built with -pthread / -sPROXY_TO_PTHREAD, so it needs
SharedArrayBuffer, which browsers only expose to cross-origin-isolated
pages. That requires COOP + COEP on every response.

Checking the headers is not sufficient - verify in the browser that
`crossOriginIsolated === true`.

This is a development helper for local runtime testing only. It is
deliberately not a production server, and in particular it does NOT
implement HTTP Range: if a GGUF is ever served from here, llmlet will
take its non-206 path and preload the whole file into IndexedDB before
inference starts (see docs/CONSTRAINTS.md F4 / O2).

Usage:
    python scripts/serve-runtime.py <docroot> [--port 8888]
"""

import argparse
import functools
import http.server
import mimetypes
import pathlib
import sys

# Python's mimetypes does not know .wasm on every platform, and a wrong
# type breaks WebAssembly streaming instantiation.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")


class CrossOriginIsolatedHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Same-origin subresources still need CORP under require-corp.
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docroot", help="directory to serve")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument(
        "--bind",
        default="127.0.0.1",
        help="bind address; use 0.0.0.0 to reach it from another machine "
        "(note: a plain http:// LAN IP is not a secure context, so "
        "navigator.gpu and SharedArrayBuffer will be unavailable there - "
        "see docs/EXPERIMENTS.md stage 2.5)",
    )
    args = parser.parse_args()

    root = pathlib.Path(args.docroot).resolve()
    if not root.is_dir():
        parser.error(f"docroot is not a directory: {root}")

    handler = functools.partial(CrossOriginIsolatedHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {root} at http://{args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
