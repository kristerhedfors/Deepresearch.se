// @ts-check
// The introspection feature's SHARED pure core — the one implementation
// behind the DRS server enrichment (src/introspect.js re-imports from here,
// the bash-core.js pattern: the Worker bundler can import from any repo path,
// the browser only from served modules) and both client tiers (DRS
// public/js/stream.js, DRC public/cure/drc.js).
//
// Introspection mode: with the developer_mode knob on, a conversation that
// asks about THIS SITE's own implementation gets the deployed source snapshot
// (public/introspect/source-snapshot.json — see scripts/bundle-source.mjs)
// as structured context: a complete file index, an orientation excerpt
// (CLAUDE.md), and the full text of any repo files the message names. When
// the execution sandbox is also on, the whole tree is mounted at /src in the
// in-browser Linux VM so the model can explore it with real commands.
//
// Everything here is deterministic and I/O-free (Node-tested in
// introspect-core.test.js): the intent gate (EN+SV parity per invariant 6),
// snapshot validation, path-mention extraction, and the context-block
// builder with its caps. Fetching the snapshot and appending the block are
// the callers' jobs.

// Where the committed snapshot artifact is served from (same-origin).
export const SNAPSHOT_PATH = "/introspect/source-snapshot.json";
// The committed DENSE source-RAG index (scripts/bundle-source-rag.mjs).
export const RAG_PATH = "/introspect/source-rag.json";

// ---- caps -------------------------------------------------------------------

// The block rides inside the conversation through EVERY phase — including the
// JSON planning phases on the fixed reliable model — so it must stay a small
// fraction of a ~32k-token context. Depth beyond these caps comes from the
// sandbox mount, not from inlining more text.
export const ORIENTATION_CHARS = 6_000; // CLAUDE.md excerpt
export const MAX_INLINE_FILE_CHARS = 30_000; // one named file, truncated beyond
export const MAX_INLINE_TOTAL_CHARS = 60_000; // all inlined files together
export const MAX_INLINE_FILES = 6; // named-file inlining stops here

// ---- the intent gate (EN + SV, deterministic) --------------------------------

// Whether one message asks about this site's own implementation. Same
// discipline as quizIntent/hfIntent: phrased-as-a-request patterns, never a
// model call, and Swedish forms with the same breadth as English (definite
// forms included — "källkoden", "arkitekturen"). Deliberately anchored to
// SELF-reference ("your …", "din …", "the code behind this site") so ordinary
// research about source code in general ("find the Linux kernel source")
// never triggers it.
const INTROSPECTION_PATTERNS = [
  /\bintrospect(?:ions?)?\b/i, // the mode's own name, EN ("introspect", "introspection")
  /\bintrospekt(?:ions?(?:läge(?:t)?)?|era)\b/i, // SV: "introspektion", "introspektionsläge(t)", "introspektera"
  // "your / this site's / deepresearch's source code | codebase | implementation | architecture"
  /\b(?:your|this\s+site'?s?|the\s+site'?s?|deepresearch(?:\.se)?'?s?)\s+(?:own\s+)?(?:source\s*(?:code|files?|tree)|code\s?base|implementation|architecture)\b/i,
  // SV counterpart: "din/er/sajtens/webbplatsens källkod(en)/kodbas(en)/implementation(en)/arkitektur(en)"
  /\b(?:din|dina|er|era|sajtens|sidans|webbplatsens|deepresearch(?:\.se)?s?)\s+(?:egen\s+)?(?:källkod(?:en)?|kodbas(?:en)?|implementation(?:en)?|implementering(?:en)?|arkitektur(?:en)?)\b/i,
  /\bhow\s+(?:are|were)\s+you\s+(?:built|implemented|coded|programmed|written)\b/i,
  /\bhur\s+är\s+du\s+(?:byggd|implementerad|kodad|programmerad|skriven)\b/i,
  /\bthe\s+code\s+behind\s+(?:you|this\s+site|the\s+site)\b/i,
  /\b(?:koden|källkoden)\s+bakom\s+(?:dig|sajten|siten|sidan|webbplatsen)\b/i,
];

/**
 * Deterministic "asks about this site's own source" gate for ONE message.
 * @param {unknown} text
 * @returns {boolean}
 */
export function introspectionIntent(text) {
  const s = String(text || "");
  return INTROSPECTION_PATTERNS.some((re) => re.test(s));
}

// Cheap pre-filter before fetching/parsing the (multi-MB) snapshot just for
// the exact-path trigger: the text must carry something path-shaped from this
// repo's top levels, or a distinctive root file. Shared by the server
// enrichment (src/introspect.js) and the client mount gate (stream.js/drc.js).
const MAYBE_REPO_PATH_RE =
  /(?:^|[\s`'"(])(?:src|public|scripts|docs|tests|\.claude)\/[\w./-]+\.\w+|CLAUDE\.md|SECURITY-RISKS\.md|wrangler\.toml/i;

/**
 * @param {unknown} text
 * @returns {boolean} whether the text might name a snapshot path at all
 */
export function maybeRepoPathMention(text) {
  return MAYBE_REPO_PATH_RE.test(String(text || ""));
}

/**
 * Introspection is a MODE: once any user message in the conversation engaged
 * it, follow-ups ("what does that function do?") stay in it — the caller
 * passes every user text. A directory-qualified snapshot path named in any
 * message engages it too ("read src/pipeline.js"); bare basenames don't
 * (too generic — "index.js" appears in ordinary questions).
 * @param {string[]} userTexts every user message's text, oldest first
 * @param {Snapshot | null} [snapshot] optional — enables the path trigger
 * @returns {boolean}
 */
export function introspectionActive(userTexts, snapshot = null) {
  const texts = Array.isArray(userTexts) ? userTexts : [];
  if (texts.some((t) => introspectionIntent(t))) return true;
  if (!snapshot) return false;
  return texts.some((t) => mentionedSnapshotPaths(t, snapshot, { exactOnly: true }).length > 0);
}

// ---- snapshot validation -------------------------------------------------------

/**
 * @typedef {{ p: string, s: number, t: string }} SnapshotFile
 * @typedef {{ v: number, digest: string, count: number, bytes: number, files: SnapshotFile[] }} Snapshot
 */

/**
 * Tolerant validation of a fetched snapshot payload: returns the typed
 * snapshot or null (callers fail soft — introspection simply reports the
 * snapshot unavailable).
 * @param {unknown} value
 * @returns {Snapshot | null}
 */
export function validateSnapshot(value) {
  const v = /** @type {any} */ (value);
  if (!v || typeof v !== "object" || v.v !== 1 || !Array.isArray(v.files)) return null;
  const files = v.files.filter(
    (/** @type {any} */ f) => f && typeof f.p === "string" && f.p && typeof f.t === "string" && Number.isFinite(f.s),
  );
  if (!files.length) return null;
  return {
    v: 1,
    digest: typeof v.digest === "string" ? v.digest : "",
    count: files.length,
    bytes: files.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (f.s || 0), 0),
    files,
  };
}

// ---- path mentions ---------------------------------------------------------------

// Candidate file-ish tokens in a message ("src/pipeline.js", "CLAUDE.md").
const PATH_TOKEN_RE = /[\w./-]*\w\.(?:js|mjs|cjs|css|html|md|json|toml|txt|sh|py|webmanifest|yml|yaml|ts)\b/gi;

/**
 * The snapshot paths a message names. Exact repo paths always match;
 * bare basenames ("pipeline.js") match only when `exactOnly` is false —
 * used for choosing what to INLINE once the mode is active, never for
 * activating it. Returns unique paths in snapshot (sorted) order.
 * @param {unknown} text
 * @param {Snapshot} snapshot
 * @param {{ exactOnly?: boolean }} [opts]
 * @returns {string[]}
 */
export function mentionedSnapshotPaths(text, snapshot, opts = {}) {
  const tokens = String(text || "").match(PATH_TOKEN_RE) || [];
  if (!tokens.length) return [];
  const lower = new Set(tokens.map((t) => t.toLowerCase().replace(/^\.?\//, "")));
  /** @type {string[]} */
  const out = [];
  for (const f of snapshot.files) {
    const p = f.p.toLowerCase();
    const base = p.slice(p.lastIndexOf("/") + 1);
    const exact = lower.has(p);
    // A unique root-level file (CLAUDE.md, wrangler.toml) IS its basename.
    const rootFile = !p.includes("/") && lower.has(base);
    const byBase = !opts.exactOnly && lower.has(base);
    if (exact || rootFile || byBase) out.push(f.p);
  }
  return out;
}

// ---- the context block -------------------------------------------------------------

/**
 * @param {Snapshot} snapshot
 * @returns {string} the complete file index, one `path<TAB>bytes` row per file
 */
export function snapshotIndex(snapshot) {
  return snapshot.files.map((f) => `${f.p}\t${f.s}`).join("\n");
}

// ---- source RAG: deterministic chunking + int8 vector index -----------------------
//
// A committed DENSE index of the source (public/introspect/source-rag.json,
// built by scripts/bundle-source-rag.mjs) lets the DRS enrichment RETRIEVE the
// chunks relevant to a question instead of relying on a brittle intent regex.
// The index stores one int8-quantized embedding per (file, chunk index) — NOT
// the chunk text: retrieval RE-CHUNKS the snapshot with the SAME deterministic
// chunker below and maps (p, ci) → text, so the vectors and the text can never
// silently drift (the freshness check enforces the chunk counts still line up).

// e5's sequence window is ~512 tokens; these mirror public/js/rag.js so a chunk
// never overflows the embedder. Kept here (not imported) so the ONE chunker is
// shared by the builder and the server with no browser-only dependency.
export const SOURCE_CHUNK_TARGET = 1400;
export const SOURCE_CHUNK_OVERLAP = 200;
const SOURCE_MAX_CHUNKS_PER_FILE = 40;

/**
 * Deterministic source chunker — the SAME algorithm public/js/rag.js chunkText
 * uses, self-contained. Both the index builder and retrieval call this, so a
 * chunk's vector always corresponds to the same slice of text.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkSourceText(text) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < SOURCE_MAX_CHUNKS_PER_FILE) {
    let end = Math.min(start + SOURCE_CHUNK_TARGET, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const brk = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (brk > SOURCE_CHUNK_TARGET * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - SOURCE_CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/**
 * Every (file, chunk) of the snapshot, in a stable order — the index is built
 * against this order and retrieval maps back through it.
 * @param {Snapshot} snapshot
 * @returns {Array<{ p: string, ci: number, text: string }>}
 */
export function snapshotChunks(snapshot) {
  const out = [];
  for (const f of snapshot.files) {
    const pieces = chunkSourceText(f.t);
    for (let ci = 0; ci < pieces.length; ci++) out.push({ p: f.p, ci, text: pieces[ci] });
  }
  return out;
}

// int8 quantization. Cosine similarity is scale-invariant, so we quantize each
// embedding by its own max-abs to int8 (÷ that scalar) and DON'T store the
// scale — it cancels in the cosine. A 1024-d vector loses ~1/127 relative
// precision per component, far below what changes top-k ranking.
/**
 * @param {ArrayLike<number>} vec
 * @returns {Int8Array}
 */
export function quantizeInt8(vec) {
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > max) max = a;
  }
  const out = new Int8Array(vec.length);
  if (!max) return out;
  const s = 127 / max;
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round(vec[i] * s);
    if (q > 127) q = 127;
    else if (q < -127) q = -127;
    out[i] = q;
  }
  return out;
}

/** @param {Int8Array} arr @returns {string} */
export function int8ToB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa exists in browsers AND Node ≥16 (global) — the whole module is
  // written to run in both, like the rest of introspect-core.
  return btoa(bin);
}

/** @param {string} b64 @returns {Int8Array} */
export function b64ToInt8(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24; // to signed
  return out;
}

/**
 * Cosine similarity between a float query vector and an int8 chunk vector. The
 * int8's arbitrary per-vector scale cancels, so the result matches the cosine
 * of the original float vectors to within quantization noise.
 * @param {ArrayLike<number>} q
 * @param {Int8Array} c
 * @returns {number}
 */
export function cosineF32Int8(q, c) {
  let dot = 0;
  let nq = 0;
  let nc = 0;
  const n = Math.min(q.length, c.length);
  for (let i = 0; i < n; i++) {
    dot += q[i] * c[i];
    nq += q[i] * q[i];
    nc += c[i] * c[i];
  }
  const denom = Math.sqrt(nq) * Math.sqrt(nc);
  return denom ? dot / denom : 0;
}

/**
 * @typedef {{ v: number, model: string, dims: number, target: number, overlap: number, hashes: Record<string, string>, vectors: string[], map: Array<{ p: string, ci: number }> }} RagIndex
 */

/**
 * Tolerant validation of a fetched source-rag index. Returns the typed index
 * or null (callers fail soft to snapshot-only introspection). `hashes` (per-
 * file content hash) is used only by the builder for DELTA rebuilds — it
 * re-embeds a file's chunks only when its hash changed — so it's optional and
 * retrieval ignores it.
 * @param {unknown} value
 * @returns {RagIndex | null}
 */
export function validateRagIndex(value) {
  const v = /** @type {any} */ (value);
  if (!v || typeof v !== "object" || v.v !== 1) return null;
  if (!Array.isArray(v.vectors) || !Array.isArray(v.map)) return null;
  if (v.vectors.length !== v.map.length || !v.vectors.length) return null;
  if (!v.map.every((/** @type {any} */ m) => m && typeof m.p === "string" && Number.isInteger(m.ci))) return null;
  return {
    v: 1,
    model: typeof v.model === "string" ? v.model : "",
    dims: Number(v.dims) || 0,
    target: Number(v.target) || SOURCE_CHUNK_TARGET,
    overlap: Number(v.overlap) || SOURCE_CHUNK_OVERLAP,
    hashes: v.hashes && typeof v.hashes === "object" && !Array.isArray(v.hashes) ? v.hashes : {},
    vectors: v.vectors,
    map: v.map,
  };
}

/**
 * Retrieve the top-k source chunks most similar to the query embedding.
 * Re-chunks the snapshot (via the shared chunker) to resolve each indexed
 * (p, ci) back to its text — so the returned text is always the CURRENT
 * source. A (p, ci) that no longer resolves (source shrank) is skipped.
 * @param {RagIndex} index
 * @param {Snapshot} snapshot
 * @param {ArrayLike<number>} queryVec
 * @param {number} [k]
 * @returns {Array<{ p: string, ci: number, text: string, score: number }>}
 */
export function retrieveSourceChunks(index, snapshot, queryVec, k = 6) {
  if (!index || !snapshot || !queryVec || !queryVec.length) return [];
  // file path → its ordered chunk texts (chunked lazily, once per retrieval).
  /** @type {Map<string, string[] | null>} */
  const byFile = new Map();
  for (const f of snapshot.files) byFile.set(f.p, null); // lazy
  /** @param {string} p @returns {string[]} */
  const chunksOf = (p) => {
    let c = byFile.get(p);
    if (c === null || c === undefined) {
      const f = snapshot.files.find((x) => x.p === p);
      c = f ? chunkSourceText(f.t) : [];
      byFile.set(p, c);
    }
    return c || [];
  };
  const scored = [];
  for (let i = 0; i < index.vectors.length; i++) {
    const m = index.map[i];
    const texts = chunksOf(m.p);
    if (m.ci >= texts.length) continue; // source changed under this vector
    const c = b64ToInt8(index.vectors[i]);
    scored.push({ p: m.p, ci: m.ci, text: texts[m.ci], score: cosineF32Int8(queryVec, c) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

/**
 * Build the labeled introspection context block appended to the conversation
 * (the Shodan-block convention: plain text, explicit begin/end markers, and
 * the material is CONTEXT — with one capability line so the model doesn't
 * deny having its own source, the hasShell lesson).
 * @param {Snapshot} snapshot
 * @param {{
 *   latestText?: string,        // the latest user message — drives named-file inlining
 *   sandboxMounted?: boolean,   // the /src tree will be available in the Linux VM
 *   retrieved?: Array<{ p: string, text: string, score?: number }>, // RAG-retrieved source chunks
 *   includeIndex?: boolean,     // include the full file index (default true) — off keeps the always-on block lean
 * }} [opts]
 * @returns {string}
 */
export function buildIntrospectionBlock(snapshot, opts = {}) {
  const lines = [];
  lines.push("--- Introspection: deepresearch.se source (developer mode) ---");
  lines.push(
    `This conversation is in INTROSPECTION MODE. You are given the ACTUAL source code of the deepresearch.se deployment answering right now (${snapshot.count} files, ${snapshot.bytes} bytes` +
      (snapshot.digest ? `, digest ${snapshot.digest.slice(0, 12)}` : "") +
      "). You DO have this site's own source here — when the user asks about how the site works, what its code does, or for code examples FROM this project, answer from the material below, quoting real snippets and citing file paths. Never say you have no access to the source or that this isn't a coding tool: in this mode you do and it is.",
  );
  if (opts.sandboxMounted) {
    lines.push(
      "The complete tree is ALSO mounted at /src inside the Linux sandbox (e.g. /src/src/pipeline.js) — shell commands over it (ls, cat, grep -rn) read anything not shown below.",
    );
  }

  // RAG: the source chunks most relevant to THIS question (dense retrieval over
  // the committed source-rag index). This is what makes the mode work for any
  // phrasing — the model gets the pertinent code without the user naming files.
  const retrieved = Array.isArray(opts.retrieved) ? opts.retrieved.filter((r) => r && r.text) : [];
  if (retrieved.length) {
    lines.push("");
    lines.push("# Source excerpts most relevant to this question (retrieved from the project's own code):");
    for (const r of retrieved) {
      lines.push("");
      lines.push(`## ${r.p}`);
      lines.push("```");
      lines.push(r.text);
      lines.push("```");
    }
  }

  if (opts.includeIndex !== false) {
    lines.push("");
    lines.push("# Full file index (path\tbytes) — ask for any of these by name for its full contents:");
    lines.push(snapshotIndex(snapshot));
  } else {
    lines.push("");
    lines.push(`# The full project is ${snapshot.count} files; name any file path (e.g. src/pipeline.js) and its complete contents are provided.`);
  }

  // Orientation: CLAUDE.md is the repo's own structured architecture map —
  // its opening (project description + code layout) is the best fixed-cost
  // orientation the block can carry.
  const claude = snapshot.files.find((f) => f.p === "CLAUDE.md");
  if (claude) {
    lines.push("");
    lines.push(`# CLAUDE.md — architecture orientation (first ${ORIENTATION_CHARS} chars)`);
    lines.push(clip(claude.t, ORIENTATION_CHARS));
  }

  // Named files: inline in full (capped) what the latest message points at.
  const named = mentionedSnapshotPaths(opts.latestText, snapshot).slice(0, MAX_INLINE_FILES);
  let inlined = 0;
  for (const p of named) {
    if (p === "CLAUDE.md") continue; // already carried above
    const f = snapshot.files.find((x) => x.p === p);
    if (!f) continue;
    if (inlined >= MAX_INLINE_TOTAL_CHARS) {
      lines.push("");
      lines.push(`# ${p} — not inlined (block budget reached; read it at /src/${p} in the sandbox)`);
      continue;
    }
    const budget = Math.min(MAX_INLINE_FILE_CHARS, MAX_INLINE_TOTAL_CHARS - inlined);
    const text = clip(f.t, budget);
    inlined += text.length;
    lines.push("");
    lines.push(`# ${p} (${f.s} bytes${text.length < f.t.length ? ", truncated" : ""})`);
    lines.push(text);
  }

  lines.push("");
  lines.push("--- End of introspection source ---");
  return "\n\n" + lines.join("\n");
}

/** @param {string} t @param {number} max */
function clip(t, max) {
  return t.length <= max ? t : t.slice(0, max) + "\n… [truncated — full file in the snapshot/sandbox]";
}

// ---- the introspection model picker (pure grouping) ---------------------------

// Introspection mode lets the user choose WHO answers: their own provider key
// (browser-direct — the site's server never sees the conversation; the
// private, recommended choice) or this site's server pipeline (remote). The
// picker's grouping/labeling is pure so it's Node-tested; the DOM lives in
// introspect-ui.js.

/**
 * @typedef {{ kind: "private", providerId: string, model: string } | { kind: "server", model: string }} IntrospectionChoice
 */

/**
 * Group the available answer routes for the introspection picker. Private
 * (user-key, browser-direct) options come FIRST and carry the recommendation
 * — the privacy-obvious choice; server models are labeled as remote so
 * nobody mistakes them for local.
 * @param {Array<{ id: string, label: string, models: string[] }>} privateProviders configured (key present) providers
 * @param {Array<{ id: string, name?: string, up?: boolean }>} serverModels /api/models entries ([] on DRC)
 * @returns {{ groups: Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>, recommended: string }}
 */
export function groupIntrospectionModels(privateProviders, serverModels) {
  /** @type {Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>} */
  const groups = [];
  const priv = (Array.isArray(privateProviders) ? privateProviders : []).flatMap((p) =>
    (Array.isArray(p?.models) ? p.models : []).map((m) => ({
      value: `p:${p.id}:${m}`,
      label: `🔒 ${m} — ${p.label}, your key (private)`,
    })),
  );
  if (priv.length) {
    groups.push({ kind: "private", label: "Private — your key, straight from this browser", options: priv });
  }
  const remote = (Array.isArray(serverModels) ? serverModels : [])
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => ({
      value: `s:${m.id}`,
      label: `☁ ${m.name || m.id} — remote (this site's server)`,
      disabled: m.up === false,
    }));
  if (remote.length) {
    groups.push({ kind: "remote", label: "Remote — this site's server pipeline", options: remote });
  }
  return { groups, recommended: priv.length ? priv[0].value : "" };
}

/**
 * Parse a picker value back into a routing choice. Null for junk (callers
 * fall back to the server default).
 * @param {unknown} value
 * @returns {IntrospectionChoice | null}
 */
export function parseIntrospectionChoice(value) {
  const s = String(value || "");
  if (s.startsWith("p:")) {
    const rest = s.slice(2);
    const colon = rest.indexOf(":");
    if (colon > 0 && colon < rest.length - 1) {
      return { kind: "private", providerId: rest.slice(0, colon), model: rest.slice(colon + 1) };
    }
    return null;
  }
  if (s.startsWith("s:") && s.length > 2) return { kind: "server", model: s.slice(2) };
  return null;
}
