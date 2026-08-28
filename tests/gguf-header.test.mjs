// Tests for scripts/lib/gguf-header.mjs.
//
// The reader exists so we can decide whether a 13.5 GB remote model would load
// without downloading it, which means two properties matter more than parsing speed:
// it must pull more bytes when a read runs past what it holds (never assume a fixed
// prefix is enough), and it must stop before the tensor data. Both are asserted here
// against synthetic GGUF files built in memory.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GGUF_VALUE_TYPE,
  GGML_TYPES,
  readGgufHeader,
  metaValue,
  tensorBytes,
} from "../scripts/lib/gguf-header.mjs";

/** Minimal little-endian GGUF writer, enough to exercise every branch of the reader. */
class GgufWriter {
  constructor() {
    this.parts = [];
  }

  raw(bytes) {
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }

  u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    return this.raw(b);
  }

  u64(value) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
    return this.raw(b);
  }

  f32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    return this.raw(b);
  }

  str(text) {
    const bytes = new TextEncoder().encode(text);
    return this.u64(bytes.length).raw(bytes);
  }

  bytes() {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/**
 * Build a GGUF file whose metadata is deliberately large, so a reader that grabbed a
 * fixed prefix would stop in the middle of the tensor descriptors.
 * @param {object} [options]
 */
function buildGguf(options = {}) {
  const {
    version = 3,
    magic = "GGUF",
    alignment = undefined,
    vocabSize = 5000,
    tensors = [
      { name: "token_embd.weight", dims: [256, 128], type: 10 }, // Q2_K
      { name: "blk.0.ffn_gate_exps.weight", dims: [256, 512, 4], type: 12 }, // Q4_K
      { name: "output_norm.weight", dims: [64], type: 0 }, // F32
    ],
    extraKv = () => {},
  } = options;

  const w = new GgufWriter();
  w.raw(new TextEncoder().encode(magic));
  w.u32(version);
  w.u64(tensors.length);

  const kv = [];
  const push = (fn) => kv.push(fn);

  push(() => w.str("general.architecture").u32(GGUF_VALUE_TYPE.STRING).str("qwen35moe"));
  push(() => w.str("tokenizer.ggml.pre").u32(GGUF_VALUE_TYPE.STRING).str("qwen35"));
  push(() => w.str("tokenizer.chat_template").u32(GGUF_VALUE_TYPE.STRING).str("{{ x }}"));
  push(() => w.str("qwen35moe.block_count").u32(GGUF_VALUE_TYPE.UINT32).u32(40));
  push(() => w.str("qwen35moe.rms_eps").u32(GGUF_VALUE_TYPE.FLOAT32).f32(1e-6));
  push(() => w.str("qwen35moe.big").u32(GGUF_VALUE_TYPE.UINT64).u64(262144));
  if (alignment !== undefined) {
    push(() => w.str("general.alignment").u32(GGUF_VALUE_TYPE.UINT32).u32(alignment));
  }
  // A vocab-sized string array plus a matching i32 array: this is what makes real
  // headers megabytes long, and what the reader has to skip past rather than keep.
  push(() => {
    w.str("tokenizer.ggml.tokens").u32(GGUF_VALUE_TYPE.ARRAY).u32(GGUF_VALUE_TYPE.STRING).u64(vocabSize);
    for (let i = 0; i < vocabSize; i++) w.str(`token_${i}_padding_to_make_this_big`);
  });
  push(() => {
    w.str("tokenizer.ggml.token_type").u32(GGUF_VALUE_TYPE.ARRAY).u32(GGUF_VALUE_TYPE.UINT32).u64(vocabSize);
    for (let i = 0; i < vocabSize; i++) w.u32(i % 4);
  });
  extraKv(w, push);

  w.u64(kv.length);
  for (const fn of kv) fn();

  for (const t of tensors) {
    w.str(t.name).u32(t.dims.length);
    for (const d of t.dims) w.u64(d);
    w.u32(t.type).u64(0);
  }

  const header = w.bytes();
  // Pad out to something that looks like a file with tensor data after the header.
  const file = new Uint8Array(header.length + 4096);
  file.set(header, 0);
  return file;
}

/**
 * Byte source that hands back only what was asked for and counts the calls, so a test
 * can tell how the reader grew its window instead of trusting that it did.
 */
function stingySource(bytes, { chunk = 1024 } = {}) {
  const state = { served: 0, calls: 0, size: bytes.length };
  return {
    size: bytes.length,
    state,
    async ensure(end) {
      if (end > bytes.length) throw new Error(`read past end of file: ${end} > ${bytes.length}`);
      if (end > state.served) {
        state.calls += 1;
        state.served = Math.min(bytes.length, Math.max(end, state.served + chunk));
      }
      // Return only what has actually been "fetched", so an over-read is caught here.
      return bytes.subarray(0, state.served);
    },
  };
}

test("parses a synthetic GGUF end to end", async () => {
  const file = buildGguf();
  const source = stingySource(file);
  const header = await readGgufHeader(source);

  assert.equal(header.version, 3);
  assert.equal(header.tensorCount, 3);
  assert.equal(metaValue(header, "general.architecture"), "qwen35moe");
  assert.equal(metaValue(header, "tokenizer.ggml.pre"), "qwen35");
  assert.equal(metaValue(header, "qwen35moe.block_count"), 40);
  assert.equal(metaValue(header, "qwen35moe.big"), 262144n);
  assert.equal(header.metadata.has("tokenizer.chat_template"), true);
});

test("keeps arrays as length plus a sample instead of materialising them", async () => {
  const header = await readGgufHeader(stingySource(buildGguf({ vocabSize: 3000 })));

  const tokens = header.metadata.get("tokenizer.ggml.tokens");
  assert.equal(tokens.kind, "array");
  assert.equal(tokens.length, 3000);
  assert.equal(tokens.sample.length, 4, "only a sample is kept, not 3000 strings");
  assert.equal(tokens.sample[0], "token_0_padding_to_make_this_big");

  const types = header.metadata.get("tokenizer.ggml.token_type");
  assert.equal(types.length, 3000);
  assert.deepEqual(types.sample, [0, 1, 2, 3]);
});

test("grows the read window instead of assuming a fixed prefix", async () => {
  // 20k tokens puts the tensor descriptors well past any plausible first read.
  const file = buildGguf({ vocabSize: 20000 });
  const source = stingySource(file, { chunk: 4096 });
  const header = await readGgufHeader(source);

  assert.equal(header.tensorCount, 3);
  assert.ok(source.state.calls > 1, "a single read cannot have been enough");
  assert.ok(
    header.descriptorsEnd > 4096,
    `descriptors must end past the first chunk (ended at ${header.descriptorsEnd})`,
  );
});

test("stops at the tensor descriptors and never reads the tensor data", async () => {
  const file = buildGguf();
  const source = stingySource(file, { chunk: 64 });
  const header = await readGgufHeader(source);

  assert.ok(
    source.state.served <= header.descriptorsEnd + 64,
    `read ${source.state.served} bytes for a header ending at ${header.descriptorsEnd}`,
  );
  assert.ok(header.dataStart < file.length, "the synthetic file has data after the header");
});

test("reports tensor shapes, types and ggml byte sizes", async () => {
  const header = await readGgufHeader(stingySource(buildGguf()));
  const byName = new Map(header.tensors.map((t) => [t.name, t]));

  const embd = byName.get("token_embd.weight");
  assert.equal(embd.typeName, "Q2_K");
  assert.deepEqual(embd.dims, [256n, 128n]);
  // Q2_K rows must be a whole number of 256-element blocks; see the block-alignment
  // test below for what happens when they are not.
  assert.equal(embd.bytes, tensorBytes(10, [256n, 128n]));

  const exps = byName.get("blk.0.ffn_gate_exps.weight");
  assert.equal(exps.typeName, "Q4_K");
  assert.deepEqual(exps.dims, [256n, 512n, 4n]);

  assert.equal(byName.get("output_norm.weight").bytes, 64n * 4n);
});

test("honours general.alignment when locating the tensor data", async () => {
  const defaulted = await readGgufHeader(stingySource(buildGguf()));
  assert.equal(defaulted.alignment, 32);
  assert.equal(defaulted.dataStart % 32, 0);

  const aligned = await readGgufHeader(stingySource(buildGguf({ alignment: 4096 })));
  assert.equal(aligned.alignment, 4096);
  assert.equal(aligned.dataStart % 4096, 0);
  assert.ok(aligned.dataStart >= aligned.descriptorsEnd);
});

test("tensorBytes matches ggml_row_size semantics", () => {
  // F32: plain element size.
  assert.equal(tensorBytes(0, [2048n]), 2048n * 4n);
  // Q2_K: 256-element blocks of 84 bytes, multiplied over the higher dimensions.
  assert.equal(tensorBytes(10, [2048n, 512n, 256n]), (2048n / 256n) * 84n * 512n * 256n);
  // Q4_0: 32-element blocks of 18 bytes.
  assert.equal(tensorBytes(2, [4096n, 2n]), (4096n / 32n) * 18n * 2n);
});

test("rejects a row that is not a whole number of blocks", () => {
  assert.throws(() => tensorBytes(10, [100n, 4n]), /not a multiple of block size 256/);
});

test("rejects an unknown ggml type rather than guessing its size", () => {
  assert.equal(GGML_TYPES.has(99), false);
  assert.throws(() => tensorBytes(99, [32n]), /unknown ggml type id 99/);
});

test("rejects a file that is not GGUF", async () => {
  const file = buildGguf({ magic: "GGUJ" });
  await assert.rejects(readGgufHeader(stingySource(file)), /not a GGUF file/);
});

test("rejects a GGUF version it cannot parse", async () => {
  const file = buildGguf({ version: 1 });
  await assert.rejects(readGgufHeader(stingySource(file)), /unsupported GGUF version 1/);
});

test("rejects nested arrays rather than skipping the wrong number of bytes", async () => {
  const file = buildGguf({
    extraKv: (w, push) => {
      push(() => {
        w.str("weird.nested").u32(GGUF_VALUE_TYPE.ARRAY).u32(GGUF_VALUE_TYPE.ARRAY).u64(1);
        w.u32(GGUF_VALUE_TYPE.UINT32).u64(1).u32(7);
      });
    },
  });
  await assert.rejects(readGgufHeader(stingySource(file)), /nested gguf arrays are not supported/);
});

test("rejects an unknown array item type", async () => {
  const file = buildGguf({
    extraKv: (w, push) => {
      push(() => w.str("weird.items").u32(GGUF_VALUE_TYPE.ARRAY).u32(77).u64(1).u32(1));
    },
  });
  await assert.rejects(readGgufHeader(stingySource(file)), /unknown gguf array item type: 77/);
});

test("rejects a tensor claiming more than four dimensions", async () => {
  const file = buildGguf({
    tensors: [{ name: "too.many.dims", dims: [32, 2, 2, 2, 2], type: 0 }],
  });
  await assert.rejects(readGgufHeader(stingySource(file)), /ggml allows at most 4/);
});

test("surfaces a truncated file as a read error, not a silent short parse", async () => {
  const file = buildGguf().subarray(0, 200);
  await assert.rejects(readGgufHeader(stingySource(file)), /read past end of file/);
});

test("parses a header with no metadata and no tensors", async () => {
  const w = new GgufWriter();
  w.raw(new TextEncoder().encode("GGUF")).u32(3).u64(0).u64(0);
  const header = await readGgufHeader(stingySource(w.bytes()));

  assert.equal(header.tensorCount, 0);
  assert.equal(header.kvCount, 0);
  assert.deepEqual(header.tensors, []);
  assert.equal(header.dataStart, 32, "24 header bytes rounded up to the default alignment");
  assert.equal(metaValue(header, "general.architecture"), undefined);
});
