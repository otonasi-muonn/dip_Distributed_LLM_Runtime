"""Assemble a LAN-only llmlet bundle: no requests leave the machine.

The stock llmlet example pulls peerjs and bootstrap from CDNs, and PeerJS
falls back to Google STUN plus a PeerJS TURN server when no ICE
configuration is given. Any of those breaks the "LAN only, no internet"
constraint even after the model is served locally, so this script
vendors the assets and pins `iceServers: []`.

Vendoring needs network access once; the resulting bundle does not.

Usage:
    python scripts/make-lan-bundle.py <output-dir> [--model path/to.gguf]
                                      [--peerserver HOST:PORT] [--probe]

Then, from the repository root:
    npm --prefix tools/peerserver run start
    python scripts/serve-runtime.py <output-dir> --port 8888

The PeerServer dependency is pinned in tools/peerserver so that starting
it does not reach npm; run `npm install` there once while online. That
makes the demo offline at run time, not offline from a fresh clone.

Open three tabs at http://localhost:8888 - one client and two servers,
since the client excludes only its own peer id and a single remote peer
would hold every layer (docs/CONSTRAINTS.md F22).
"""

import argparse
import json
import pathlib
import re
import shutil
import sys
import urllib.request

PEERJS_URL = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"
BOOTSTRAP_URL = "https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css"

DEFAULT_PEERSERVER = "127.0.0.1:9000"

PEERJS_TAG = '<script src="./peerjs.min.js"></script>'
PROBE_TAG = '<script src="./lan-probe.js"></script>'

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# .work/ and build/ are gitignored, so they exist only in the checkout that
# actually ran the build. From a git worktree they are somewhere else, hence
# the overrides.
DEFAULT_LLMLET_DIR = REPO_ROOT / ".work" / "llmlet"
DEFAULT_BUILD_DIR = REPO_ROOT / "build" / "reference-llmlet"


def fetch(url: str, dest: pathlib.Path) -> None:
    print(f"  fetching {url}")
    with urllib.request.urlopen(url, timeout=120) as r:
        dest.write_bytes(r.read())


def replace_once(html: str, pattern: str, replacement: str, what: str) -> str:
    """Apply one substitution, insisting it matched exactly once.

    Checking the patches as a group would let a later one fail silently
    once an earlier one had already changed the text - and the one that
    matters most here is the `iceServers: []` injection, whose silent
    absence would send the bundle to Google STUN and PeerJS TURN with no
    visible sign (docs/DECISIONS.md D1 / D2).
    """
    # A lambda replacement keeps backslashes and group refs in the text literal.
    new_html, count = re.subn(pattern, lambda _m: replacement, html)
    if count != 1:
        sys.exit(
            f"index.html: expected exactly 1 match for {what}, found {count}. "
            "The llmlet example may have changed; re-check the patterns in "
            "make-lan-bundle.py before trusting this bundle."
        )
    return new_html


def patch_index(html: str, peerserver: str, probe: bool) -> str:
    """Point the example at local assets and disable PeerJS default ICE."""
    html = replace_once(
        html,
        r'<link href="https://cdn\.jsdelivr\.net/npm/bootstrap[^>]*>',
        '<link href="./bootstrap.min.css" rel="stylesheet">',
        "the bootstrap stylesheet link",
    )
    html = replace_once(
        html,
        re.escape(
            '<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>'
        ),
        PEERJS_TAG,
        "the peerjs script tag",
    )
    html = replace_once(
        html,
        re.escape("      var peerOptions = {\n          debug: 2,\n      };"),
        "      var peerOptions = {\n"
        "          debug: 2,\n"
        "          // LAN-only: PeerJS otherwise defaults to Google STUN + PeerJS TURN\n"
        "          config: { iceServers: [] },\n"
        "      };",
        "the peerOptions block (iceServers injection)",
    )
    html = replace_once(
        html,
        r'const peerserverAddress = "[^"]*";',
        f"const peerserverAddress = {json.dumps(peerserver)};",
        "the peerserverAddress constant",
    )

    if probe:
        # Deliberately after peerjs and before llmlet.js - the header comment
        # in scripts/lan-probe.js explains why the order is load-bearing.
        html = replace_once(
            html,
            re.escape(PEERJS_TAG),
            PEERJS_TAG + "\n" + PROBE_TAG,
            "the probe injection point",
        )

    uncommented = re.sub(r"^\s*//.*$", "", html, flags=re.M)
    leftover = sorted(set(re.findall(r'https://[^"\')\s]+', uncommented)))
    if leftover:
        print(f"  warning: external references remain: {leftover}", file=sys.stderr)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="directory to build the bundle into")
    parser.add_argument("--model", help="GGUF to copy in as model.gguf (optional)")
    parser.add_argument(
        "--peerserver",
        default=DEFAULT_PEERSERVER,
        help="HOST:PORT the page uses for signalling. Point this at the "
        "PeerServer machine's LAN address when another machine has to reach "
        f"it (default: {DEFAULT_PEERSERVER})",
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="inject scripts/lan-probe.js to record external requests, ICE "
        "configuration, and candidate types (docs/EXPERIMENTS.md)",
    )
    parser.add_argument(
        "--llmlet-dir",
        type=pathlib.Path,
        default=DEFAULT_LLMLET_DIR,
        help=f"llmlet checkout (default: {DEFAULT_LLMLET_DIR})",
    )
    parser.add_argument(
        "--build-dir",
        type=pathlib.Path,
        default=DEFAULT_BUILD_DIR,
        help=f"reference build output (default: {DEFAULT_BUILD_DIR})",
    )
    args = parser.parse_args()

    llmlet_dir = args.llmlet_dir.resolve()
    build_dir = args.build_dir.resolve()

    out = pathlib.Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    probe_src = REPO_ROOT / "scripts" / "lan-probe.js"
    required = [
        build_dir / "llmlet-mod.js",
        build_dir / "llmlet-mod.wasm",
        llmlet_dir / "llmlet.js",
        llmlet_dir / "examples" / "simple" / "index.html",
    ]
    if args.probe:
        required.append(probe_src)
    missing = [p for p in required if not p.exists()]
    if missing:
        sys.exit(
            "missing inputs:\n  "
            + "\n  ".join(str(p) for p in missing)
            + "\nrun scripts/build-llmlet-reference.ps1 first, or point "
            "--llmlet-dir / --build-dir at the checkout that did "
            "(both paths are gitignored, so a git worktree will not have them)"
        )

    print(f"building bundle in {out}")
    for src in (
        build_dir / "llmlet-mod.js",
        build_dir / "llmlet-mod.wasm",
        llmlet_dir / "llmlet.js",
    ):
        shutil.copy2(src, out / src.name)
        print(f"  copied {src.name}")

    fetch(PEERJS_URL, out / "peerjs.min.js")
    fetch(BOOTSTRAP_URL, out / "bootstrap.min.css")

    if args.probe:
        shutil.copy2(probe_src, out / "lan-probe.js")
        print("  copied lan-probe.js")

    index_src = llmlet_dir / "examples" / "simple" / "index.html"
    (out / "index.html").write_text(
        patch_index(index_src.read_text(encoding="utf-8"), args.peerserver, args.probe),
        encoding="utf-8",
    )
    print(
        "  patched index.html (local assets, iceServers: [], "
        f"peerserver {args.peerserver}" + (", probe" if args.probe else "") + ")"
    )

    if args.model:
        model = pathlib.Path(args.model).resolve()
        if not model.is_file():
            sys.exit(f"model not found: {model}")
        shutil.copy2(model, out / "model.gguf")
        print(f"  copied model.gguf ({model.stat().st_size} bytes)")
    else:
        print("  no --model given; pick a local GGUF in the page, or serve one yourself")

    print("done")


if __name__ == "__main__":
    main()
