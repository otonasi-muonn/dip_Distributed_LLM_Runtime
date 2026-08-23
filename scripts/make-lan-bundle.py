"""Assemble a LAN-only llmlet bundle: no requests leave the machine.

The stock llmlet example pulls peerjs and bootstrap from CDNs, and PeerJS
falls back to Google STUN plus a PeerJS TURN server when no ICE
configuration is given. Any of those breaks the "LAN only, no internet"
constraint even after the model is served locally, so this script
vendors the assets and pins `iceServers: []`.

Vendoring needs network access once; the resulting bundle does not.

Usage:
    python scripts/make-lan-bundle.py <output-dir> [--model path/to.gguf]

Then:
    npx --package=peer peerjs --port 9000
    python scripts/serve-runtime.py <output-dir> --port 8888

Open three tabs at http://localhost:8888 - one client and two servers,
since the client excludes only its own peer id and a single remote peer
would hold every layer (docs/CONSTRAINTS.md F22).
"""

import argparse
import pathlib
import re
import shutil
import sys
import urllib.request

PEERJS_URL = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"
BOOTSTRAP_URL = "https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css"

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


def patch_index(html: str) -> str:
    """Point the example at local assets and disable PeerJS's default ICE."""
    before = html

    html = re.sub(
        r'<link href="https://cdn\.jsdelivr\.net/npm/bootstrap[^>]*>',
        '<link href="./bootstrap.min.css" rel="stylesheet">',
        html,
        count=1,
    )
    html = html.replace(
        '<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>',
        '<script src="./peerjs.min.js"></script>',
        1,
    )
    html = html.replace(
        "      var peerOptions = {\n          debug: 2,\n      };",
        "      var peerOptions = {\n"
        "          debug: 2,\n"
        "          // LAN-only: PeerJS otherwise defaults to Google STUN + PeerJS TURN\n"
        "          config: { iceServers: [] },\n"
        "      };",
        1,
    )

    if html == before:
        sys.exit("index.html did not match any known pattern; llmlet may have changed")
    if "https://" in re.sub(r"^\s*//.*$", "", html, flags=re.M):
        leftover = sorted(set(re.findall(r'https://[^"\')\s]+', html)))
        print(f"  warning: external references remain: {leftover}", file=sys.stderr)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="directory to build the bundle into")
    parser.add_argument("--model", help="GGUF to copy in as model.gguf (optional)")
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

    missing = [
        p
        for p in (
            build_dir / "llmlet-mod.js",
            build_dir / "llmlet-mod.wasm",
            llmlet_dir / "llmlet.js",
            llmlet_dir / "examples" / "simple" / "index.html",
        )
        if not p.exists()
    ]
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

    index_src = llmlet_dir / "examples" / "simple" / "index.html"
    (out / "index.html").write_text(
        patch_index(index_src.read_text(encoding="utf-8")), encoding="utf-8"
    )
    print("  patched index.html (local assets, iceServers: [])")

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
