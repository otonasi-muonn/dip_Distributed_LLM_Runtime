/**
 * GGUF header reader.
 *
 * Reads only the header, metadata KV block and tensor descriptors of a GGUF file -
 * never the tensor data. That is what lets us answer "will this model load?" for a
 * 13.5 GB remote file without downloading it.
 *
 * The header has no length prefix: where the tensor descriptors end depends on the
 * tensor count and on how big the metadata is (a 151k-entry tokenizer is several MB
 * on its own). So the reader never assumes "the first N MB is enough" - it asks the
 * byte source for more whenever a read runs past what it has, and success means the
 * descriptors parsed to completion, not that some fixed prefix arrived.
 *
 * Layout (gguf-py/docs/gguf.md):
 *   magic u32 "GGUF" | version u32 | tensor_count u64 | kv_count u64
 *   kv_count   x { key:string, type:u32, value }
 *   tensor_cnt x { name:string, n_dims:u32, dims:u64[n_dims], type:u32, offset:u64 }
 *   padding to general.alignment, then tensor data
 */

export const GGUF_MAGIC = 0x46554747; // "GGUF" read as little-endian u32

export const GGUF_VALUE_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
};

const SCALAR_WIDTH = new Map([
  [GGUF_VALUE_TYPE.UINT8, 1],
  [GGUF_VALUE_TYPE.INT8, 1],
  [GGUF_VALUE_TYPE.UINT16, 2],
  [GGUF_VALUE_TYPE.INT16, 2],
  [GGUF_VALUE_TYPE.UINT32, 4],
  [GGUF_VALUE_TYPE.INT32, 4],
  [GGUF_VALUE_TYPE.FLOAT32, 4],
  [GGUF_VALUE_TYPE.BOOL, 1],
  [GGUF_VALUE_TYPE.UINT64, 8],
  [GGUF_VALUE_TYPE.INT64, 8],
  [GGUF_VALUE_TYPE.FLOAT64, 8],
]);

/**
 * blck_size / type_size per ggml type.
 *
 * Transcribed from the tables in the pinned fork itself, so that byte accounting
 * matches what llama.cpp will compute rather than what we remember:
 *   .work/llmlet/llama.cpp/gguf-py/gguf/constants.py
 *     GGMLQuantizationType (enum values) and GGML_QUANT_SIZES (QK_K = 256)
 * at llama.cpp c4b18b39dbebb29d2f9f934dd0b136a9493a962e.
 */
export const GGML_TYPES = new Map([
  [0, { name: "F32", blck: 1, size: 4 }],
  [1, { name: "F16", blck: 1, size: 2 }],
  [2, { name: "Q4_0", blck: 32, size: 18 }],
  [3, { name: "Q4_1", blck: 32, size: 20 }],
  [6, { name: "Q5_0", blck: 32, size: 22 }],
  [7, { name: "Q5_1", blck: 32, size: 24 }],
  [8, { name: "Q8_0", blck: 32, size: 34 }],
  [9, { name: "Q8_1", blck: 32, size: 40 }],
  [10, { name: "Q2_K", blck: 256, size: 84 }],
  [11, { name: "Q3_K", blck: 256, size: 110 }],
  [12, { name: "Q4_K", blck: 256, size: 144 }],
  [13, { name: "Q5_K", blck: 256, size: 176 }],
  [14, { name: "Q6_K", blck: 256, size: 210 }],
  [15, { name: "Q8_K", blck: 256, size: 292 }],
  [16, { name: "IQ2_XXS", blck: 256, size: 66 }],
  [17, { name: "IQ2_XS", blck: 256, size: 74 }],
  [18, { name: "IQ3_XXS", blck: 256, size: 98 }],
  [19, { name: "IQ1_S", blck: 256, size: 50 }],
  [20, { name: "IQ4_NL", blck: 32, size: 18 }],
  [21, { name: "IQ3_S", blck: 256, size: 110 }],
  [22, { name: "IQ2_S", blck: 256, size: 82 }],
  [23, { name: "IQ4_XS", blck: 256, size: 136 }],
  [24, { name: "I8", blck: 1, size: 1 }],
  [25, { name: "I16", blck: 1, size: 2 }],
  [26, { name: "I32", blck: 1, size: 4 }],
  [27, { name: "I64", blck: 1, size: 8 }],
  [28, { name: "F64", blck: 1, size: 8 }],
  [29, { name: "IQ1_M", blck: 256, size: 56 }],
  [30, { name: "BF16", blck: 1, size: 2 }],
  [34, { name: "TQ1_0", blck: 256, size: 54 }],
  [35, { name: "TQ2_0", blck: 256, size: 66 }],
  [39, { name: "MXFP4", blck: 32, size: 17 }],
  [40, { name: "NVFP4", blck: 64, size: 36 }],
]);

/**
 * ggml_nbytes() for a contiguous GGUF tensor:
 * ggml_row_size(type, ne0) * ne1 * ne2 * ne3, with row_size = type_size*ne0/blck_size.
 */
export function tensorBytes(typeId, dims) {
  const trait = GGML_TYPES.get(typeId);
  if (!trait) throw new Error(`unknown ggml type id ${typeId}`);
  const ne0 = dims.length > 0 ? dims[0] : 1n;
  if (ne0 % BigInt(trait.blck) !== 0n) {
    throw new Error(`${trait.name} tensor row ${ne0} is not a multiple of block size ${trait.blck}`);
  }
  let bytes = (ne0 / BigInt(trait.blck)) * BigInt(trait.size);
  for (let i = 1; i < dims.length; i++) bytes *= dims[i];
  return bytes;
}

/**
 * Arrays are skipped past rather than materialised: tokenizer.ggml.tokens alone is
 * ~151k strings. We keep a short sample so a report can show what is in there, plus
 * the length, which is all any caller has needed so far.
 */
const ARRAY_SAMPLE = 4;

class Cursor {
  constructor(source) {
    this.source = source;
    this.offset = 0;
  }

  async view(length) {
    const bytes = await this.source.ensure(this.offset + length);
    return new DataView(bytes.buffer, bytes.byteOffset + this.offset, length);
  }

  async u32() {
    const value = (await this.view(4)).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  async u64() {
    const value = (await this.view(8)).getBigUint64(0, true);
    this.offset += 8;
    return value;
  }

  async scalar(type) {
    const width = SCALAR_WIDTH.get(type);
    if (width === undefined) throw new Error(`not a scalar gguf value type: ${type}`);
    const view = await this.view(width);
    this.offset += width;
    switch (type) {
      case GGUF_VALUE_TYPE.UINT8: return view.getUint8(0);
      case GGUF_VALUE_TYPE.INT8: return view.getInt8(0);
      case GGUF_VALUE_TYPE.UINT16: return view.getUint16(0, true);
      case GGUF_VALUE_TYPE.INT16: return view.getInt16(0, true);
      case GGUF_VALUE_TYPE.UINT32: return view.getUint32(0, true);
      case GGUF_VALUE_TYPE.INT32: return view.getInt32(0, true);
      case GGUF_VALUE_TYPE.FLOAT32: return view.getFloat32(0, true);
      case GGUF_VALUE_TYPE.BOOL: return view.getUint8(0) !== 0;
      case GGUF_VALUE_TYPE.UINT64: return view.getBigUint64(0, true);
      case GGUF_VALUE_TYPE.INT64: return view.getBigInt64(0, true);
      case GGUF_VALUE_TYPE.FLOAT64: return view.getFloat64(0, true);
      default: throw new Error(`unreachable scalar type ${type}`);
    }
  }

  async string() {
    const length = Number(await this.u64());
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`implausible gguf string length at offset ${this.offset - 8}`);
    }
    const bytes = await this.source.ensure(this.offset + length);
    const slice = bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder("utf-8").decode(slice);
  }

  /** Advance without materialising, but still force the bytes to be fetched. */
  async skip(length) {
    await this.source.ensure(this.offset + length);
    this.offset += length;
  }

  async value(type) {
    if (type === GGUF_VALUE_TYPE.STRING) {
      return { kind: "string", value: await this.string() };
    }
    if (type !== GGUF_VALUE_TYPE.ARRAY) {
      return { kind: "scalar", value: await this.scalar(type) };
    }

    const itemType = await this.u32();
    const length = Number(await this.u64());
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`implausible gguf array length at offset ${this.offset - 8}`);
    }

    const sample = [];
    if (itemType === GGUF_VALUE_TYPE.STRING) {
      for (let i = 0; i < length; i++) {
        if (i < ARRAY_SAMPLE) {
          sample.push(await this.string());
        } else {
          await this.skip(Number(await this.u64()));
        }
      }
    } else if (itemType === GGUF_VALUE_TYPE.ARRAY) {
      // Nested arrays are legal in the format but unused by llama.cpp. Refuse rather
      // than skip the wrong number of bytes and mis-parse everything after it.
      throw new Error("nested gguf arrays are not supported");
    } else {
      const width = SCALAR_WIDTH.get(itemType);
      if (width === undefined) throw new Error(`unknown gguf array item type: ${itemType}`);
      const taken = Math.min(length, ARRAY_SAMPLE);
      for (let i = 0; i < taken; i++) sample.push(await this.scalar(itemType));
      await this.skip((length - taken) * width);
    }
    return { kind: "array", itemType, length, sample };
  }
}

/**
 * Parse the GGUF header from a byte source.
 *
 * `source` must expose `ensure(end)` returning a Uint8Array holding at least `end`
 * bytes counted from the start of the file, or throwing if the file ends first.
 */
export async function readGgufHeader(source) {
  const cursor = new Cursor(source);

  const magic = await cursor.u32();
  if (magic !== GGUF_MAGIC) {
    throw new Error(`not a GGUF file: magic 0x${magic.toString(16).padStart(8, "0")}`);
  }
  const version = await cursor.u32();
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported GGUF version ${version} (this reader handles 2 and 3)`);
  }

  const tensorCount = Number(await cursor.u64());
  const kvCount = Number(await cursor.u64());
  if (!Number.isSafeInteger(tensorCount) || !Number.isSafeInteger(kvCount)) {
    throw new Error("implausible GGUF tensor/metadata counts");
  }

  const metadata = new Map();
  for (let i = 0; i < kvCount; i++) {
    const key = await cursor.string();
    const type = await cursor.u32();
    metadata.set(key, await cursor.value(type));
  }
  const metadataEnd = cursor.offset;

  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = await cursor.string();
    const nDims = await cursor.u32();
    if (nDims > 4) {
      throw new Error(`tensor ${name} claims ${nDims} dimensions (ggml allows at most 4)`);
    }
    const dims = [];
    for (let d = 0; d < nDims; d++) dims.push(await cursor.u64());
    const type = await cursor.u32();
    const offset = await cursor.u64();
    tensors.push({
      name,
      dims,
      type,
      typeName: GGML_TYPES.get(type)?.name ?? `type${type}`,
      offset,
      bytes: tensorBytes(type, dims),
    });
  }

  const alignmentEntry = metadata.get("general.alignment");
  const alignment = alignmentEntry ? Number(alignmentEntry.value) : 32;
  const descriptorsEnd = cursor.offset;

  return {
    version,
    tensorCount,
    kvCount,
    metadata,
    tensors,
    alignment,
    metadataEnd,
    descriptorsEnd,
    dataStart: Math.ceil(descriptorsEnd / alignment) * alignment,
  };
}

/** Unwrap a metadata entry to a plain value, or undefined when the key is absent. */
export function metaValue(header, key) {
  const entry = header.metadata.get(key);
  if (entry === undefined) return undefined;
  return entry.kind === "array" ? entry : entry.value;
}
