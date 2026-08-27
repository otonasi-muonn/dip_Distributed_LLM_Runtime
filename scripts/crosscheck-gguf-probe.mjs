#!/usr/bin/env node
/**
 * Check scripts/probe-gguf-header.mjs against an independent GGUF reader.
 *
 * The probe decides which Qwen3.6 build we can load, and every model-selection
 * conclusion rests on it - but it was written, tested and evaluated by the same
 * hand. Its own unit tests cannot catch a systematic misreading of the format.
 * So this diffs it against gguf-py, which is upstream's reader and shares no code
 * with ours.
 *
 * Two things are checked, not one:
 *
 *   1. the parser, against `gguf_dump.py --json --json-array` on local files;
 *   2. the adaptive Range acquisition path, by serving one of those files over
 *      HTTP and running the probe against the URL. Reading a local file exercises
 *      none of "fetch 1 MB -> decide it is short -> fetch 2 MB -> ... -> parse",
 *      which is the part that actually runs against Hugging Face.
 *
 * gguf-py needs numpy, which the host Python does not have. Rather than install into
 * the host, the reference runs from a virtualenv under .work/ - gitignored, created
 * once, and thrown away by deleting the directory.
 *
 * `--json-array` is not optional: without it gguf_dump omits the value of every
 * ARRAY-typed metadata field (gguf_dump.py:87-93), and the comparison would
 * silently skip them.
 *
 * Usage:
 *   node scripts/crosscheck-gguf-probe.mjs [model.gguf ...] [--http <model.gguf>] [--port 8899]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GGUF_PY = path.join(ROOT, ".work", "llmlet", "llama.cpp", "gguf-py");
const PROBE = path.join(HERE, "probe-gguf-header.mjs");
const SERVER = path.join(HERE, "serve-runtime.py");
const DOCROOT = path.join(ROOT, "harness", "runtime-only");
const VENV = path.join(ROOT, ".work", "gguf-venv");

/** Metadata whose value gguf-py reports differently by design, not by disagreement. */
const SKIP_KEYS = new Set([
  // Stored as a string in the file; both readers agree, but it is huge and the
  // probe deliberately does not keep it.
  "tokenizer.chat_template",
]);

function run(command, args, { capture = true, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}\n${err.slice(-2000)}`));
      else resolve(out);
    });
  });
}

async function probeJson(target) {
  // --tensors makes the probe emit the full descriptor list, which is what there
  // is to compare; the human-readable report only shows the largest one.
  const out = await run(process.execPath, [PROBE, target, "--json", "--tensors=999999"]);
  return JSON.parse(out);
}

function venvPython() {
  const win = path.join(VENV, "Scripts", "python.exe");
  return existsSync(win) ? win : path.join(VENV, "bin", "python");
}

/**
 * Find an interpreter numpy actually ships wheels for.
 *
 * Under Git Bash on Windows, `python` is the MSYS2 build, and numpy has no wheels for
 * it - pip falls back to compiling from source and fails on the ninja build. The Windows
 * launcher points at the native install, which does have wheels.
 */
async function findHostPython() {
  const candidates = [
    ["py", ["-3", "-c", "import sys; print(sys.executable)"]],
    ["python3", ["-c", "import sys; print(sys.executable)"]],
    ["python", ["-c", "import sys; print(sys.executable)"]],
  ];
  for (const [command, args] of candidates) {
    try {
      const found = (await run(command, args)).trim();
      if (found) return found;
    } catch {
      // try the next one
    }
  }
  throw new Error("no python interpreter found for the reference reader");
}

let venvReady = false;

/** Create the reference environment once; later runs reuse it. */
async function ensureVenv() {
  if (venvReady) return;
  if (!existsSync(venvPython())) {
    const host = await findHostPython();
    console.log(`creating ${path.relative(ROOT, VENV)} from ${host} (one-off, needs network)`);
    await run(host, ["-m", "venv", VENV]);
    // --only-binary keeps a missing wheel a fast, legible failure instead of a long
    // source build that ends in a compiler error.
    // gguf-py imports all of these on the way to GGUFReader; see its pyproject.toml.
    await run(venvPython(), [
      "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
      "--only-binary=:all:", "numpy", "pyyaml", "tqdm", "requests",
    ]);
  }
  venvReady = true;
}

async function ggufPyJson(modelPath) {
  await ensureVenv();
  // --json-array is not optional: without it gguf_dump omits the value of every
  // ARRAY-typed field (gguf_dump.py:87-93) and the arrays would go unchecked.
  const out = await run(venvPython(), [
    path.join(GGUF_PY, "gguf", "scripts", "gguf_dump.py"),
    path.resolve(modelPath),
    "--json",
    "--json-array",
  ], { env: { ...process.env, PYTHONPATH: GGUF_PY } });
  return JSON.parse(out);
}

/** Numbers cross the two readers through JSON and BigInt; compare by value. */
function sameNumber(a, b) {
  const x = typeof a === "string" ? Number(a) : a;
  const y = typeof b === "string" ? Number(b) : b;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x === y) return true;
  // f32 metadata (rms_eps and friends) round-trips through two different
  // decoders; allow a relative slack far tighter than any real disagreement.
  const scale = Math.max(Math.abs(x), Math.abs(y));
  return Math.abs(x - y) <= scale * 1e-9;
}

function compare(label, probe, dump) {
  const problems = [];
  const note = (msg) => problems.push(msg);

  // --- identity ---
  const dumpArch = dump.metadata["general.architecture"]?.value;
  if (probe.architecture !== dumpArch) {
    note(`architecture: probe=${probe.architecture} gguf-py=${dumpArch}`);
  }
  const dumpPre = dump.metadata["tokenizer.ggml.pre"]?.value ?? null;
  if ((probe.tokenizerPre ?? null) !== dumpPre) {
    note(`tokenizer.ggml.pre: probe=${probe.tokenizerPre} gguf-py=${dumpPre}`);
  }
  const dumpHasTemplate = "tokenizer.chat_template" in dump.metadata;
  if (probe.hasChatTemplate !== dumpHasTemplate) {
    note(`chat template presence: probe=${probe.hasChatTemplate} gguf-py=${dumpHasTemplate}`);
  }

  // --- tensors ---
  const dumpNames = Object.keys(dump.tensors);
  if (probe.tensorCount !== dumpNames.length) {
    note(`tensor count: probe=${probe.tensorCount} gguf-py=${dumpNames.length}`);
  }
  if (!Array.isArray(probe.tensors)) {
    note("probe did not emit a tensor list (pass --tensors)");
  } else {
    const probeByName = new Map(probe.tensors.map((t) => [t.name, t]));
    for (const name of dumpNames) {
      const p = probeByName.get(name);
      if (!p) {
        note(`tensor missing from probe: ${name}`);
        continue;
      }
      const d = dump.tensors[name];
      if (p.typeName !== d.type) note(`tensor ${name}: type probe=${p.typeName} gguf-py=${d.type}`);
      const pd = p.dims.map(Number);
      const dd = d.shape.map(Number);
      if (pd.length !== dd.length || pd.some((v, i) => v !== dd[i])) {
        note(`tensor ${name}: shape probe=[${pd}] gguf-py=[${dd}]`);
      }
    }
    for (const name of probeByName.keys()) {
      if (!(name in dump.tensors)) note(`tensor only in probe: ${name}`);
    }
  }

  // --- scalar hparams ---
  for (const [key, value] of Object.entries(probe.hparams ?? {})) {
    if (SKIP_KEYS.has(key)) continue;
    const field = dump.metadata[key];
    if (!field) {
      note(`hparam missing from gguf-py: ${key}`);
      continue;
    }
    const dv = field.value;
    const ok = typeof value === "boolean" || typeof dv === "boolean" || typeof dv === "string"
      ? String(value) === String(dv)
      : sameNumber(value, dv);
    if (!ok) note(`hparam ${key}: probe=${value} gguf-py=${dv}`);
  }

  // --- array metadata ---
  // Values are compared by type, length and the leading elements only: the probe
  // keeps a short sample on purpose (tokenizer.ggml.tokens alone is 248k strings),
  // so an element-by-element diff would be comparing against something the probe
  // never claimed to hold.
  for (const [key, arr] of Object.entries(probe.arrayFields ?? {})) {
    const field = dump.metadata[key];
    if (!field) {
      note(`array field missing from gguf-py: ${key}`);
      continue;
    }
    if (field.type !== "ARRAY") {
      note(`array field ${key}: gguf-py reports type ${field.type}`);
      continue;
    }
    if (!Array.isArray(field.value)) {
      note(`array field ${key}: gguf-py emitted no value (was --json-array passed?)`);
      continue;
    }
    if (field.value.length !== arr.length) {
      note(`array ${key}: length probe=${arr.length} gguf-py=${field.value.length}`);
    }
    arr.sample.forEach((sampled, i) => {
      const expected = field.value[i];
      const ok = typeof sampled === "string" || typeof expected === "string"
        ? String(sampled) === String(expected)
        : sameNumber(sampled, expected);
      if (!ok) note(`array ${key}[${i}]: probe=${JSON.stringify(sampled)} gguf-py=${JSON.stringify(expected)}`);
    });
  }

  const ok = problems.length === 0;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  console.log(`       ${probe.tensorCount} tensors, arch ${probe.architecture}, pre ${probe.tokenizerPre}`);
  for (const p of problems) console.log(`       - ${p}`);
  return ok;
}

/** Serve one model over HTTP so the probe exercises its Range path, not a file read. */
async function withHttpModel(modelPath, port, fn) {
  const server = spawn(
    "python",
    [SERVER, DOCROOT, "--port", String(port), "--model", path.resolve(modelPath)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  server.stderr.on("data", (c) => (stderr += c));
  try {
    const url = `http://localhost:${port}/model.gguf`;
    // Wait for the mount to answer a Range request rather than sleeping blindly.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch(url, { headers: { Range: "bytes=0-1" } });
        if (res.status === 206) {
          await res.arrayBuffer();
          return await fn(url);
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not serve ${url} with 206\n${stderr.slice(-1000)}`);
  } finally {
    server.kill();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8899;
  const httpArg = args.indexOf("--http");
  const httpModel = httpArg >= 0 ? args[httpArg + 1] : undefined;
  const models = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (portArg >= 0 && i === portArg + 1) return false;
    if (httpArg >= 0 && i === httpArg + 1) return false;
    return true;
  });

  if (models.length === 0) {
    console.error("usage: node scripts/crosscheck-gguf-probe.mjs <model.gguf ...> [--http <model.gguf>] [--port N]");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(GGUF_PY)) {
    console.error(`gguf-py not found at ${GGUF_PY}. Run scripts/build-llmlet-reference.ps1 first.`);
    process.exitCode = 2;
    return;
  }

  let allOk = true;
  const dumps = new Map();

  for (const model of models) {
    if (!existsSync(model)) {
      console.log(`FAIL ${model} (not found)`);
      allOk = false;
      continue;
    }
    const [probe, dump] = await Promise.all([probeJson(model), ggufPyJson(model)]);
    dumps.set(path.resolve(model), dump);
    allOk = compare(`${path.basename(model)} (local file)`, probe, dump) && allOk;
  }

  if (httpModel) {
    const resolved = path.resolve(httpModel);
    const dump = dumps.get(resolved) ?? (await ggufPyJson(httpModel));
    const probe = await withHttpModel(httpModel, port, (url) => probeJson(url));
    console.log(`       (over HTTP: ${probe.bytesFetched} bytes in ${probe.requests} Range request(s))`);
    allOk = compare(`${path.basename(httpModel)} (HTTP Range)`, probe, dump) && allOk;
  }

  console.log("");
  console.log(allOk ? "crosscheck passed" : "crosscheck FAILED");
  process.exitCode = allOk ? 0 : 1;
}

await main();
