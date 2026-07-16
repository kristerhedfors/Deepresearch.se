// The ON-DEVICE inference tier's PURE core (import-free, Node-tested) — the
// phone-local Bonsai models (docs/BONSAI-27B-PHONE-INFERENCE.md): everything
// the engine glue (ondevice-engine.js), the worker (ondevice-worker.js), and
// the /cure page need that has no DOM, no WebGPU, and no network in it.
//
// The runtime is the VENDORED transformers.js (public/vendor/transformers/,
// invariant 7 — SHA-256 pins recorded in ondevice-engine.js); the weights are
// PrismML's 1-bit Bonsai family (Apache 2.0) in the onnx-community
// conversions, downloaded straight from huggingface.co into a browser-local
// OPFS cache — the server is in NO path here (no new invariant-4 exception:
// not even the weights touch it). Nothing in this module (or the feature)
// loads until the user flips the settings knob, and no download starts
// without the explicit consent popup — the bandwidth guarantee.

// ---- the model catalog ----------------------------------------------------------
//
// Data-driven so a new conversion is one entry. `repo` is the onnx-community
// transformers.js conversion; `dtype` names the quantized weight variant the
// engine requests (the repo's onnx/model_<dtype>.onnx). `approxBytes` is the
// consent line's fallback only — the popup shows the EXACT total computed
// from the repo's live file listing before anything downloads.
//
// Bonsai 27B (released 2026-07-14, the 3.9 GB 1-bit build of Qwen3.6-27B) is
// the headline entry: its ONNX conversion is NOT yet published (2026-07-16 —
// only GGUF/MLX exist, and the official 27B browser demo is a closed
// single-file kernel bundle), so the entry sits pre-wired behind the runtime
// availability probe and lights up the day onnx-community ships it, exactly
// like 1.7B–8B did. The smaller sizes are published and work today.
export const ONDEVICE_MODELS = [
  {
    id: "bonsai-27b-1bit",
    label: "Bonsai 27B · 1-bit",
    repo: "onnx-community/Bonsai-27B-ONNX",
    dtype: "q1f16",
    approxBytes: 4_200_000_000,
    minDeviceMemoryGb: 6, // PrismML's guidance: 6 GB RAM minimum incl. KV cache
  },
  {
    id: "bonsai-8b-1bit",
    label: "Bonsai 8B · 1-bit",
    repo: "onnx-community/Bonsai-8B-ONNX",
    dtype: "q1f16", // 1.11 GiB (probed 2026-07-16: onnx/model_q1f16.onnx + one shard)
    approxBytes: 1_200_000_000,
    minDeviceMemoryGb: 4,
  },
  {
    id: "bonsai-1_7b-1bit",
    label: "Bonsai 1.7B · 1-bit",
    repo: "onnx-community/Bonsai-1.7B-ONNX",
    dtype: "q1", // the 1.7B repo ships no q1f16 variant (278 MB q1, probed 2026-07-16)
    approxBytes: 300_000_000,
    minDeviceMemoryGb: 2,
  },
];

/** @param {string} id */
export function onDeviceModel(id) {
  return ONDEVICE_MODELS.find((m) => m.id === id) || null;
}

// ---- Hugging Face wire shapes ---------------------------------------------------

// The tree API lists every file with its size and (for LFS files) the sha256
// — the integrity anchor the download manager verifies each fetched file
// against. Revision stays "main": the 27B repo doesn't exist yet, so there is
// no sha to pin ahead of time; the per-file sha256 from the SAME listing the
// plan was built from is the effective pin (a mid-download force-push shows
// up as a hash mismatch, not silently).
/** @param {string} repo */
export function hfTreeUrl(repo) {
  return "https://huggingface.co/api/models/" + repo + "/tree/main?recursive=true";
}

/** @param {string} repo @param {string} path */
export function hfFileUrl(repo, path) {
  return "https://huggingface.co/" + repo + "/resolve/main/" + path;
}

// The tokenizer/config side files a transformers.js text-generation load
// reads. Optional ones (a repo without chat_template.jinja bakes the template
// into tokenizer_config.json) are simply absent from the plan when absent
// from the tree.
const SIDE_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
];

/**
 * The exact file set one model variant needs, from the repo's tree listing:
 * the side files plus onnx/model_<dtype>.onnx and its external-data shards
 * (onnx/model_<dtype>.onnx_data, _1, _2 …). Returns null when the listing
 * doesn't carry the variant (the "conversion not yet published" state — the
 * 27B today), so callers can show that instead of a broken download.
 * @param {Array<{path?: string, size?: number, lfs?: {oid?: string}}>} tree
 * @param {string} dtype
 * @returns {?Array<{path: string, size: number, sha256: ?string}>}
 */
export function planModelFiles(tree, dtype) {
  if (!Array.isArray(tree) || !dtype) return null;
  const entry = (f) => ({
    path: String(f.path),
    size: typeof f.size === "number" && f.size >= 0 ? f.size : 0,
    sha256: typeof f?.lfs?.oid === "string" && /^[0-9a-f]{64}$/.test(f.lfs.oid) ? f.lfs.oid : null,
  });
  const graph = "onnx/model_" + dtype + ".onnx";
  const byPath = new Map();
  for (const f of tree) {
    if (f && typeof f.path === "string") byPath.set(f.path, f);
  }
  if (!byPath.has(graph)) return null;
  const files = [];
  for (const name of SIDE_FILES) {
    if (byPath.has(name)) files.push(entry(byPath.get(name)));
  }
  files.push(entry(byPath.get(graph)));
  const shardPrefix = graph + "_data";
  const shards = [...byPath.keys()]
    .filter((p) => p === shardPrefix || p.startsWith(shardPrefix + "_"))
    // _2 sorts after _10 lexically; order numerically so progress and any
    // future resume bookkeeping stay stable.
    .sort((a, b) => shardIndex(a) - shardIndex(b));
  for (const p of shards) files.push(entry(byPath.get(p)));
  return files;
}

/** @param {string} path */
function shardIndex(path) {
  const m = path.match(/_data(?:_(\d+))?$/);
  return m ? (m[1] ? parseInt(m[1], 10) : 0) : -1;
}

/** @param {Array<{size: number}>} files */
export function downloadTotalBytes(files) {
  return (Array.isArray(files) ? files : []).reduce((n, f) => n + (f?.size || 0), 0);
}

// Decimal units, one decimal — the user-facing "3.9 GB" convention the
// announcement itself uses (and matching what a phone's storage UI shows).
/** @param {number} n */
export function fmtBytes(n) {
  if (!(n > 0)) return "0 B";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return Math.round(n / 1e6) + " MB";
  if (n >= 1e3) return Math.round(n / 1e3) + " kB";
  return Math.round(n) + " B";
}

// ---- capability verdict -----------------------------------------------------------
//
// The self-explaining device gate (the on-device-trace lesson): the settings
// row states WHY a model can't run here instead of failing silently at send
// time. Inputs are collected by the engine glue (navigator.gpu probe result,
// navigator.deviceMemory where it exists); this stays pure so the ladder is
// unit-testable.
/**
 * @param {{hasWebGpu: boolean, deviceMemoryGb?: ?number, maxBufferBytes?: ?number}} probe
 * @param {{minDeviceMemoryGb?: number, approxBytes?: number}} model
 * @returns {{verdict: "ok"|"marginal"|"unsupported", reason: string}}
 */
export function capabilityVerdict(probe, model) {
  if (!probe?.hasWebGpu) {
    return { verdict: "unsupported", reason: "This browser has no WebGPU — on-device models can't run here." };
  }
  // navigator.deviceMemory is Chrome-only and CAPPED at 8, so it can prove
  // "too little" but never "plenty"; absent (Safari/Firefox) means unknown,
  // which is not a reason to block.
  const mem = typeof probe.deviceMemoryGb === "number" ? probe.deviceMemoryGb : null;
  const need = model?.minDeviceMemoryGb || 0;
  if (mem !== null && need && mem < need) {
    return {
      verdict: "marginal",
      reason: "This device reports ~" + mem + " GB RAM; this model wants " + need + " GB+ — it may run slowly or fail to load.",
    };
  }
  const buf = typeof probe.maxBufferBytes === "number" ? probe.maxBufferBytes : null;
  if (buf !== null && buf < 1 << 30) {
    return {
      verdict: "marginal",
      reason: "This GPU caps buffers below 1 GB — large models may fail to load.",
    };
  }
  return { verdict: "ok", reason: "" };
}

// The wasm pair the vendored runtime should load: transformers.js's own
// selection logic (Safari gets the plain build, everything else the asyncify
// build), pointed at OUR vendor directory instead of its CDN default.
/** @param {boolean} isSafari @param {string} [base] */
export function wasmPathsFor(isSafari, base = "/vendor/transformers/") {
  const stem = base + "ort-wasm-simd-threaded" + (isSafari ? "" : ".asyncify");
  return { mjs: stem + ".mjs", wasm: stem + ".wasm" };
}

// ---- streamed generation shaping ---------------------------------------------------

// Bonsai (a Qwen3.6 derivative) carries built-in reasoning that streams
// <think>…</think> spans before the answer. The filter drops those spans —
// across arbitrary chunk boundaries — so neither the visible answer nor the
// JSON extraction sees them. Stateful by necessity; create one per stream.
export function createThinkFilter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inside = false;
  let buf = ""; // the tail that might be a partial tag
  const longestTagPrefixAt = (s) => {
    // The longest suffix of s that is a proper prefix of the tag we're
    // scanning for — what must be held back until the next chunk decides.
    const tag = inside ? CLOSE : OPEN;
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
      if (s.endsWith(tag.slice(0, k))) return k;
    }
    return 0;
  };
  return {
    /** @param {string} chunk @returns {string} the text safe to emit now */
    push(chunk) {
      buf += chunk;
      let out = "";
      for (;;) {
        const tag = inside ? CLOSE : OPEN;
        const i = buf.indexOf(tag);
        if (i === -1) break;
        if (!inside) out += buf.slice(0, i);
        buf = buf.slice(i + tag.length);
        inside = !inside;
      }
      const hold = longestTagPrefixAt(buf);
      if (inside) {
        buf = buf.slice(buf.length - hold); // thinking text is dropped, keep only a possible tag start
        return out;
      }
      out += buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
      return out;
    },
    /** Flush at stream end: a dangling partial tag outside a span is real text. */
    finalize() {
      const out = inside ? "" : buf;
      buf = "";
      return out;
    },
  };
}

// The OpenAI wire shapes the provider seam expects — the engine re-emits its
// tokens as this SSE so drc-research.js's readStream (and every stall guard
// on it) works unchanged: the src/anthropic.js adapt-at-the-wire pattern,
// client-side.
/** @param {string} text */
export function sseDeltaLine(text) {
  return "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n";
}

export function sseDoneLine() {
  return "data: [DONE]\n\n";
}

/** The non-streaming completion envelope drcCompleteJson reads. @param {string} text */
export function completionEnvelope(text) {
  return { choices: [{ message: { content: text } }] };
}

// JSON mode has no response_format enforcement on a local engine — the
// planning prompts already demand JSON-only, and this appends one final
// reminder to the LAST user turn (never a second system message: Qwen chat
// templates render one system slot).
/** @param {Array<{role: string, content: string}>} messages */
export function withJsonReminder(messages) {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      out[i].content += "\n\nRespond ONLY with the JSON object — no prose, no code fences.";
      return out;
    }
  }
  out.push({ role: "user", content: "Respond ONLY with the JSON object — no prose, no code fences." });
  return out;
}

// Phone-speed output cap: a 4096-token synthesis at ~10 tok/s is a seven-
// minute wait — the tier trades tail length for a usable turnaround. Applied
// in the provider entry's params() so every phase inherits it.
export const ONDEVICE_MAX_TOKENS = 1280;

// ---- download progress ---------------------------------------------------------------

/**
 * Overall progress across the planned file set. `doneFiles` maps path →
 * fully-downloaded bytes (verified files); `current` is the in-flight file's
 * {path, loaded}. Pure math for the settings row's percent line.
 * @param {Array<{path: string, size: number}>} files
 * @param {Record<string, number>} doneFiles
 * @param {{path?: string, loaded?: number}} [current]
 */
export function downloadProgress(files, doneFiles, current = {}) {
  const total = downloadTotalBytes(files);
  let loaded = 0;
  for (const f of files) {
    if (doneFiles[f.path] !== undefined) loaded += f.size;
    else if (current.path === f.path) loaded += Math.min(current.loaded || 0, f.size);
  }
  const pct = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
  return { loaded, total, pct };
}

// ---- streaming SHA-256 -----------------------------------------------------------------
//
// SubtleCrypto.digest needs the whole buffer in memory — a non-starter for
// multi-GB weight shards on a phone — so verification streams through this
// compact incremental SHA-256 instead (tested against node:crypto). Runs in
// the download worker path, off the UI thread; throughput is far above the
// network rate that feeds it.
export function createSha256() {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const block = new Uint8Array(64);
  let blockLen = 0;
  let bytesLo = 0; // total length as two 32-bit halves (files exceed 2^32 bits)
  let bytesHi = 0;

  function compress(bytes, off) {
    for (let i = 0; i < 16; i++) {
      W[i] = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      off += 4;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  return {
    /** @param {Uint8Array} data */
    update(data) {
      const n = data.length;
      bytesLo += n;
      if (bytesLo >= 0x100000000) {
        bytesHi += Math.floor(bytesLo / 0x100000000);
        bytesLo = bytesLo >>> 0;
      }
      let off = 0;
      if (blockLen) {
        const take = Math.min(64 - blockLen, n);
        block.set(data.subarray(0, take), blockLen);
        blockLen += take;
        off = take;
        if (blockLen === 64) {
          compress(block, 0);
          blockLen = 0;
        }
      }
      while (off + 64 <= n) {
        compress(data, off);
        off += 64;
      }
      if (off < n) {
        block.set(data.subarray(off), 0);
        blockLen = n - off;
      }
      return this;
    },
    /** @returns {string} lowercase hex digest; the instance is spent afterwards */
    digestHex() {
      const bitsHi = (bytesHi * 8 + Math.floor((bytesLo * 8) / 0x100000000)) >>> 0;
      const bitsLo = (bytesLo * 8) >>> 0;
      block[blockLen++] = 0x80;
      if (blockLen > 56) {
        block.fill(0, blockLen);
        compress(block, 0);
        blockLen = 0;
      }
      block.fill(0, blockLen);
      block[56] = bitsHi >>> 24; block[57] = (bitsHi >>> 16) & 0xff; block[58] = (bitsHi >>> 8) & 0xff; block[59] = bitsHi & 0xff;
      block[60] = bitsLo >>> 24; block[61] = (bitsLo >>> 16) & 0xff; block[62] = (bitsLo >>> 8) & 0xff; block[63] = bitsLo & 0xff;
      compress(block, 0);
      let hex = "";
      for (let i = 0; i < 8; i++) hex += ("00000000" + (H[i] >>> 0).toString(16)).slice(-8);
      return hex;
    },
  };
}
