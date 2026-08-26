"""Serve a directory with the headers the llmlet WASM runtime needs.

The runtime is built with -pthread / -sPROXY_TO_PTHREAD, so it needs
SharedArrayBuffer, which browsers only expose to cross-origin-isolated
pages. That requires COOP + COEP on every response.

Checking the headers is not sufficient - verify in the browser that
`crossOriginIsolated === true`.

This is a development helper for local runtime testing only. It is
deliberately not a production server.

It does implement HTTP Range. It used to refuse to, but the Runtime harness
needs the 206 path for two reasons: it is the path the Web application's Hono
server will use, and without it the adapter re-downloads the whole GGUF into
IndexedDB on every start (docs/CONSTRAINTS.md F4 / F26), which makes repeated
connect/disconnect runs impractical.

`--model` mounts a single GGUF from anywhere on disk at /model.gguf, so a
491 MB file does not have to be copied into the served directory.

Usage:
    python scripts/serve-runtime.py <docroot> [--port 8888]
    python scripts/serve-runtime.py build/runtime-harness --model D:/models/x.gguf
"""

import argparse
import functools
import http.server
import mimetypes
import os
import pathlib
import sys

# Python's mimetypes does not know .wasm on every platform, and a wrong
# type breaks WebAssembly streaming instantiation.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/octet-stream", ".gguf")

MODEL_MOUNT = "/model.gguf"
COPY_CHUNK = 256 * 1024


def parse_byte_range(value, size):
    """Return an inclusive (start, end) pair, or None when unsatisfiable.

    Anything we cannot parse returns "not a range request" so the caller falls
    back to a normal 200 - refusing would be worse than ignoring it.
    """
    if not value.startswith("bytes="):
        return "ignore"
    spec = value[len("bytes="):].strip()
    if "," in spec:
        # Multipart ranges are legal but nothing here sends them.
        return "ignore"
    first, sep, last = spec.partition("-")
    if not sep:
        return "ignore"

    try:
        if not first:
            # Suffix form: the last N bytes.
            length = int(last)
            if length <= 0:
                return None
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
    except ValueError:
        return "ignore"

    if start >= size or start < 0 or end < start:
        return None
    return start, min(end, size - 1)


class RuntimeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, model_path=None, **kwargs):
        self.model_path = model_path
        self._range_remaining = None
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Same-origin subresources still need CORP under require-corp.
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if self.model_path and clean == MODEL_MOUNT:
            return self.model_path
        return super().translate_path(path)

    def send_head(self):
        self._range_remaining = None
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        raw_range = self.headers.get("Range")
        if not raw_range:
            return super().send_head()

        size = os.path.getsize(path)
        parsed = parse_byte_range(raw_range, size)
        if parsed == "ignore":
            return super().send_head()
        if parsed is None:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        start, end = parsed
        try:
            stream = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        stream.seek(start)
        self._range_remaining = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(self._range_remaining))
        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
        self.end_headers()
        return stream

    def copyfile(self, source, outputfile):
        remaining = self._range_remaining
        if remaining is None:
            super().copyfile(source, outputfile)
            return
        while remaining > 0:
            chunk = source.read(min(COPY_CHUNK, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docroot", help="directory to serve")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument(
        "--model",
        help="GGUF to expose at %s, from anywhere on disk" % MODEL_MOUNT,
    )
    parser.add_argument(
        "--bind",
        default="127.0.0.1",
        help="bind address; use 0.0.0.0 to reach it from another machine",
    )
    parser.add_argument(
        "--cert",
        help="PEM certificate; serves HTTPS when given. A plain http:// LAN "
        "IP is NOT a secure context, so navigator.gpu and SharedArrayBuffer "
        "are unavailable and COOP is ignored there (docs/CONSTRAINTS.md F24). "
        "Reaching this server from another machine therefore requires TLS.",
    )
    parser.add_argument("--key", help="PEM private key for --cert")
    args = parser.parse_args()

    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key must be given together")

    root = pathlib.Path(args.docroot).resolve()
    if not root.is_dir():
        parser.error(f"docroot is not a directory: {root}")

    model = None
    if args.model:
        model = pathlib.Path(args.model).resolve()
        if not model.is_file():
            parser.error(f"model is not a file: {model}")
        model = str(model)

    handler = functools.partial(RuntimeHandler, directory=str(root), model_path=model)
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler)

    scheme = "http"
    if args.cert:
        import ssl

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=args.cert, keyfile=args.key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    print(f"serving {root} at {scheme}://{args.bind}:{args.port}", flush=True)
    if model:
        size = os.path.getsize(model)
        print(f"  {MODEL_MOUNT} -> {model} ({size} bytes)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
