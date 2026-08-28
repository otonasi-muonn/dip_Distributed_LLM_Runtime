#!/usr/bin/env node
/**
 * Answer "would this model load, and could a WebGPU RPC peer execute it?" without
 * downloading the model.
 *
 * A Qwen3.6-35B-A3B GGUF is 13.5 GB, but everything that decides whether the pinned
 * Runtime can load it - architecture, tokenizer pre-type, tensor names, shapes and
 * quantisation types - lives in the header.
 *
 * The read is adaptive, not a fixed prefix: the header ends wherever the tensor
 * descriptors end, which depends on tensor count and metadata size. The probe keeps
 * asking for more bytes until the descriptors parse to completion, and reports how
 * many bytes that took. "Fetched a few MB" is not the success condition; "parsed the
 * descriptors" is.
 *
 * Because the end of the header is only known once it has been parsed, the last
 * doubling can overshoot into the tensor data. The report prints that overshoot
 * rather than claiming there is none - for a 13.5 GB model it is single-digit MB,
 * about 0.1% of the file, and no weights are ever decoded.
 *
 * Usage:
 *   node scripts/probe-gguf-header.mjs <url-or-path> [--json] [--tensors[=N]]
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { readGgufHeader, metaValue } from "./lib/gguf-header.mjs";

const FIRST_READ = 1 << 20; // 1 MiB, then doubling
const MAX_READ = 512 << 20; // refuse to slurp a whole model if parsing goes wrong

/**
 * Which src0 types each WebGPU path accepts, so the probe can say directly whether a
 * peer could execute this model rather than leaving it to be discovered at runtime.
 *
 * MUL_MAT: ggml-webgpu.cpp supports_op in the pinned fork (llama.cpp c4b18b39d).
 * MUL_MAT_ID: upstream d0a6dfeb28a09831d904fc4d910ddb740da82834
 *   ("ggml-webgpu: Add the support of MUL_MAT_ID", #21147) - notably no IQ types.
 * Keep both in sync with patches/ when either changes.
 */
const WEBGPU_MUL_MAT_TYPES = new Set([
  "F32", "F16",
  "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0",
  "Q2_K", "Q3_K", "Q4_K", "Q5_K", "Q6_K",
  "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ3_XXS", "IQ3_S", "IQ1_S", "IQ1_M", "IQ4_NL", "IQ4_XS",
]);
const WEBGPU_MUL_MAT_ID_TYPES = new Set([
  "F32", "F16",
  "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0",
  "Q2_K", "Q3_K", "Q4_K", "Q5_K", "Q6_K",
]);

/** Tensors routed through GGML_OP_MUL_MAT_ID: the MoE expert weights. */
const EXPERT_TENSOR = /\.ffn_(gate|up|down|gate_up)_exps(\.|$)/;

class HttpSource {
  constructor(url) {
    this.url = url;
    this.bytes = new Uint8Array(0);
    this.size = undefined;
    this.requests = 0;
    this.mode = "range";
    this.stream = null;
  }

  async ensure(end) {
    if (end <= this.bytes.length) return this.bytes;
    if (end > MAX_READ) {
      throw new Error(`header parse wanted ${end} bytes; refusing to read past ${MAX_READ}`);
    }
    let target = Math.max(end, FIRST_READ, this.bytes.length * 2);
    if (this.size !== undefined) target = Math.min(target, this.size);
    if (target < end) throw new Error(`file ends at ${this.size} bytes but the header needs ${end}`);

    if (this.mode === "range") await this.fetchRange(target);
    else await this.pump(target);

    if (this.bytes.length < end) {
      throw new Error(`could not read ${end} bytes (got ${this.bytes.length})`);
    }
    return this.bytes;
  }

  async fetchRange(target) {
    const from = this.bytes.length;
    const response = await fetch(this.url, { headers: { Range: `bytes=${from}-${target - 1}` } });
    this.requests += 1;

    if (response.status === 206) {
      const range = response.headers.get("content-range");
      const total = range ? Number(range.split("/")[1]) : undefined;
      if (Number.isFinite(total)) this.size = total;
      this.append(new Uint8Array(await response.arrayBuffer()));
      return;
    }
    if (response.status === 200) {
      // No Range support: fall back to one streaming GET that we abandon as soon as
      // the descriptors parse, so the body stops at the same bounded overshoot.
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length)) this.size = length;
      if (from !== 0) throw new Error("server ignored Range mid-parse; cannot resume");
      this.mode = "stream";
      this.stream = response.body.getReader();
      await this.pump(target);
      return;
    }
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${this.url}`);
  }

  async pump(target) {
    while (this.bytes.length < target) {
      const { done, value } = await this.stream.read();
      if (done) break;
      this.append(value);
    }
  }

  append(chunk) {
    const merged = new Uint8Array(this.bytes.length + chunk.length);
    merged.set(this.bytes, 0);
    merged.set(chunk, this.bytes.length);
    this.bytes = merged;
  }

  async close() {
    if (this.stream) await this.stream.cancel().catch(() => {});
  }
}

class FileSource {
  constructor(path, size) {
    this.path = path;
    this.size = size;
    this.bytes = new Uint8Array(0);
    this.requests = 0;
  }

  async ensure(end) {
    if (end <= this.bytes.length) return this.bytes;
    if (end > MAX_READ) {
      throw new Error(`header parse wanted ${end} bytes; refusing to read past ${MAX_READ}`);
    }
    const target = Math.min(Math.max(end, FIRST_READ, this.bytes.length * 2), this.size);
    if (target < end) throw new Error(`file ends at ${this.size} bytes but the header needs ${end}`);

    const chunks = [];
    for await (const chunk of createReadStream(this.path, { start: this.bytes.length, end: target - 1 })) {
      chunks.push(chunk);
    }
    this.requests += 1;
    const merged = new Uint8Array(this.bytes.length + chunks.reduce((n, c) => n + c.length, 0));
    merged.set(this.bytes, 0);
    let at = this.bytes.length;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.length;
    }
    this.bytes = merged;
    if (this.bytes.length < end) throw new Error(`could not read ${end} bytes from ${this.path}`);
    return this.bytes;
  }

  async close() {}
}

async function openSource(target) {
  if (/^https?:\/\//i.test(target)) return new HttpSource(target);
  const info = await stat(target);
  return new FileSource(target, info.size);
}

function mib(bytes) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(2)} MiB`;
}

function summarise(header, source) {
  const arch = metaValue(header, "general.architecture");
  const hparams = [];
  for (const [key, entry] of header.metadata) {
    if (arch && key.startsWith(`${arch}.`) && entry.kind !== "array") {
      hparams.push([key, entry.value]);
    }
  }

  const byType = new Map();
  let totalBytes = 0n;
  let largest = null;
  for (const tensor of header.tensors) {
    byType.set(tensor.typeName, (byType.get(tensor.typeName) ?? 0) + 1);
    totalBytes += tensor.bytes;
    if (!largest || tensor.bytes > largest.bytes) largest = tensor;
  }

  const experts = header.tensors.filter((t) => EXPERT_TENSOR.test(t.name));
  const expertTypes = new Set(experts.map((t) => t.typeName));
  const nonExpertTypes = new Set(
    header.tensors.filter((t) => !EXPERT_TENSOR.test(t.name)).map((t) => t.typeName),
  );

  let largestExpert = null;
  for (const tensor of experts) {
    if (!largestExpert || tensor.bytes > largestExpert.bytes) largestExpert = tensor;
  }

  return {
    arch,
    hparams,
    byType,
    totalBytes,
    largest,
    largestExpert,
    nextn: header.tensors.filter((t) => t.name.includes("nextn")),
    experts,
    expertTypes,
    nonExpertTypes,
    fused: header.tensors.some((t) => t.name.includes("ffn_gate_up_exps")),
    split: header.tensors.some((t) => t.name.includes("ffn_gate_exps")),
    expertBias: header.tensors.filter((t) => EXPERT_TENSOR.test(t.name) && t.name.endsWith(".bias")),
    unsupportedForMulMatId: [...expertTypes].filter((t) => !WEBGPU_MUL_MAT_ID_TYPES.has(t)),
    unsupportedForMulMat: [...nonExpertTypes].filter((t) => !WEBGPU_MUL_MAT_TYPES.has(t)),
    bytesFetched: source.bytes.length,
    requests: source.requests,
  };
}

function report(header, s) {
  const lines = [];
  const push = (...parts) => lines.push(parts.join(""));

  push("== parse ==");
  push(`  fully parsed      : yes (${header.kvCount} metadata keys, ${header.tensorCount} tensor descriptors)`);
  push(`  bytes fetched     : ${s.bytesFetched} (${mib(s.bytesFetched)}) in ${s.requests} request(s)`);
  push(`  descriptors end   : ${header.descriptorsEnd}`);
  push(`  tensor data starts: ${header.dataStart} (alignment ${header.alignment})`);
  const overshoot = Math.max(0, s.bytesFetched - header.dataStart);
  push(`  overshoot into data: ${overshoot} (${mib(overshoot)}) - fetched past the header, not parsed`);

  push("");
  push("== identity ==");
  push(`  general.architecture : ${s.arch ?? "(absent)"}`);
  push(`  gguf version         : ${header.version}`);
  push(`  tokenizer.ggml.model : ${metaValue(header, "tokenizer.ggml.model") ?? "(absent)"}`);
  const pre = metaValue(header, "tokenizer.ggml.pre");
  push(`  tokenizer.ggml.pre   : ${pre ?? "(absent -> llama.cpp uses the default pre-type)"}`);
  push(`  chat template        : ${header.metadata.has("tokenizer.chat_template") ? "present" : "absent"}`);

  push("");
  push("== hparams ==");
  for (const [key, value] of s.hparams) push(`  ${key.padEnd(44)} ${value}`);

  push("");
  push("== tensors ==");
  push(`  count            : ${header.tensorCount}`);
  push(`  tensor bytes     : ${s.totalBytes} (${mib(s.totalBytes)})`);
  push(`  largest tensor   : ${s.largest.name} ${s.largest.typeName} [${s.largest.dims.join(", ")}] = ${s.largest.bytes} (${mib(s.largest.bytes)})`);
  push(`  types            : ${[...s.byType].map(([t, n]) => `${t}x${n}`).join(", ")}`);

  push("");
  push("== MoE ==");
  if (s.experts.length === 0) {
    push("  expert tensors   : none (dense model)");
  } else {
    push(`  expert tensors   : ${s.experts.length} (${s.fused ? "fused ffn_gate_up_exps" : ""}${s.fused && s.split ? " + " : ""}${s.split ? "split gate/up" : ""})`);
    push(`  expert types     : ${[...s.expertTypes].join(", ")}`);
    push(`  expert bias      : ${s.expertBias.length > 0 ? `${s.expertBias.length} tensors -> GGML_OP_ADD_ID needed` : "none -> GGML_OP_ADD_ID not needed"}`);
    push(`  largest expert   : ${s.largestExpert.name} = ${s.largestExpert.bytes} (${mib(s.largestExpert.bytes)})`);
  }

  push("");
  push("== MTP / NextN ==");
  push(`  nextn tensors    : ${s.nextn.length === 0 ? "none" : `${s.nextn.length} present`}`);
  for (const tensor of s.nextn.slice(0, 6)) push(`      ${tensor.name} ${tensor.typeName} [${tensor.dims.join(", ")}]`);
  if (s.nextn.length > 6) push(`      ... and ${s.nextn.length - 6} more`);
  const predict = metaValue(header, `${s.arch}.nextn_predict_layers`);
  push(`  nextn_predict_layers : ${predict ?? "(absent)"}`);

  push("");
  push("== WebGPU executability (type gate only) ==");
  push(`  MUL_MAT types unsupported     : ${s.unsupportedForMulMat.length === 0 ? "none" : s.unsupportedForMulMat.join(", ")}`);
  push(`  MUL_MAT_ID types unsupported  : ${s.experts.length === 0 ? "n/a (no expert tensors)" : s.unsupportedForMulMatId.length === 0 ? "none" : s.unsupportedForMulMatId.join(", ")}`);
  push("  note: this checks quantisation types only. Tensor size against");
  push("        maxStorageBufferBindingSize is a per-device limit - compare the largest");
  push("        tensor above with the value measured on the actual peer.");

  return lines.join("\n");
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: node scripts/probe-gguf-header.mjs <url-or-path> [--json] [--tensors[=N]]");
    process.exitCode = 2;
    return;
  }
  const wantJson = args.includes("--json");
  const tensorArg = args.find((a) => a.startsWith("--tensors"));
  const tensorLimit = tensorArg === undefined
    ? 0
    : tensorArg.includes("=") ? Number(tensorArg.split("=")[1]) : Number.POSITIVE_INFINITY;

  const source = await openSource(target);
  try {
    const header = await readGgufHeader(source);
    const s = summarise(header, source);

    if (wantJson) {
      console.log(JSON.stringify({
        source: target,
        version: header.version,
        architecture: s.arch,
        tokenizerPre: metaValue(header, "tokenizer.ggml.pre") ?? null,
        hasChatTemplate: header.metadata.has("tokenizer.chat_template"),
        hparams: Object.fromEntries(s.hparams),
        tensorCount: header.tensorCount,
        totalTensorBytes: s.totalBytes,
        largestTensor: s.largest,
        largestExpertTensor: s.largestExpert,
        typeHistogram: Object.fromEntries(s.byType),
        expertTensorCount: s.experts.length,
        expertTypes: [...s.expertTypes],
        expertLayout: s.fused ? "fused" : s.split ? "split" : "none",
        expertBiasCount: s.expertBias.length,
        nextnTensorCount: s.nextn.length,
        nextnTensorNames: s.nextn.map((t) => t.name),
        unsupportedForMulMat: s.unsupportedForMulMat,
        unsupportedForMulMatId: s.unsupportedForMulMatId,
        bytesFetched: s.bytesFetched,
        overshootIntoTensorData: Math.max(0, s.bytesFetched - header.dataStart),
        requests: s.requests,
        dataStart: header.dataStart,
        // Everything above is this reader's own summary. The two fields below are
        // the raw material an independent reader can be diffed against, which is
        // what scripts/crosscheck-gguf-probe.mjs does - a parser whose only check
        // is its own tests is a parser nobody has checked.
        tensors: tensorLimit > 0 ? header.tensors : undefined,
        arrayFields: Object.fromEntries(
          [...header.metadata]
            .filter(([, entry]) => entry.kind === "array")
            .map(([key, entry]) => [key, { itemType: entry.itemType, length: entry.length, sample: entry.sample }]),
        ),
      }, jsonReplacer, 2));
    } else {
      console.log(`# ${target}`);
      console.log(report(header, s));
      if (tensorLimit > 0) {
        console.log("");
        console.log("== tensor list ==");
        for (const t of header.tensors.slice(0, tensorLimit)) {
          console.log(`  ${t.name.padEnd(44)} ${t.typeName.padEnd(8)} [${t.dims.join(", ")}] ${t.bytes}`);
        }
      }
    }
  } finally {
    await source.close();
  }
}

await main();
