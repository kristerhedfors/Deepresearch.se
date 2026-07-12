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

import { regionForModelEntry, regionForProvider } from "./provider-region.js";

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

// ---- external-source intent (EN + SV, deterministic) -------------------------

// Whether a message EXPLICITLY wants outside material — web search, cited
// sources, current/recent facts, or a comparison against something external.
// In developer mode the pipeline answers from the site's OWN injected source by
// default (leaning toward pure introspection), and only runs the web/HF search
// wave when this gate fires — so it is deliberately CONSERVATIVE (clear signals
// only). Anchored away from introspection false-friends: "current"/"latest"
// alone don't count (a question about the site's CURRENT code is still
// introspection), only their outward-facing phrasings ("latest news", "up to
// date") do. Swedish forms carry the same breadth (invariant 6).
const EXTERNAL_SOURCE_PATTERNS = [
  // Explicit web / internet search requests.
  /\b(?:search|look)\s+(?:it\s+|them\s+)?(?:up\s+)?(?:on|in|across|the)?\s*(?:the\s+)?(?:web|internet|online)\b/i,
  /\bweb\s+search\b/i,
  /\bgoogle\s+(?:it|this|that|for|search)\b/i,
  /\bon\s+the\s+(?:web|internet)\b/i,
  /\bfrom\s+the\s+(?:web|internet)\b/i,
  // Sources / references / citations from outside.
  /\b(?:find|fetch|get|cite|with|use|external|provide|include|add)\s+(?:me\s+)?(?:some\s+|real\s+|actual\s+)?(?:web\s+|online\s+|external\s+)?(?:sources?|references?|citations?|links?)\b/i,
  /\bexternal\s+(?:sources?|references?|links?|docs?|documentation|material)\b/i,
  // Currency / recency, outward-facing only (not bare "current"/"latest").
  /\b(?:latest|recent|newest|current)\s+(?:news|developments?|updates?|research|papers?|articles?|releases?|trends?)\b/i,
  /\bup[\s-]?to[\s-]?date\b/i,
  /\bwhat'?s\s+new\b/i,
  /\bcurrent\s+events?\b/i,
  // Comparison against something external ("compare [our X] with/to/against …").
  /\bcompared?\b(?:\s+\S+){0,4}?\s+(?:with|to|against)\b/i,
  /\bversus\b|\bvs\.?\b/i,
  // Swedish parity.
  /\bsök(?:er|ning(?:ar)?)?\s+(?:på\s+|i\s+)?(?:nätet|webben|internet|online|google)\b/i,
  /\bwebbsökning(?:ar)?\b/i,
  /\bgoogla\b/i,
  /\bpå\s+(?:nätet|internet|webben)\b/i,
  /\b(?:hitta|ange|ge|använd|med|externa|inkludera)\s+(?:mig\s+)?(?:några\s+|riktiga\s+)?(?:web[b]?\s+|online\s+|externa\s+)?källor\b/i,
  /\bexterna\s+(?:källor|referenser|länkar)\b/i,
  /\b(?:senaste|aktuella?|nyaste)\s+(?:nyheter(?:na)?|nytt|utveckling(?:en|ar)?|forskning(?:en)?|uppdateringar(?:na)?|artiklar(?:na)?|släpp(?:en)?|trender(?:na)?)\b/i,
  /\bjämför[t]?\b(?:\s+\S+){0,4}?\s+(?:med|mot)\b/i,
];

/**
 * Deterministic "the user explicitly wants outside material" gate for ONE
 * message — the switch that re-enables the web/HF search wave in developer
 * mode. Conservative by design (see EXTERNAL_SOURCE_PATTERNS).
 * @param {unknown} text
 * @returns {boolean}
 */
export function externalSourceIntent(text) {
  const s = String(text || "");
  return EXTERNAL_SOURCE_PATTERNS.some((re) => re.test(s));
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

// ---- back-reference resolution -----------------------------------------------
//
// A follow-up like "read those" / "do that" (EN+SV) names no files itself — the
// files it points at were listed in a PRIOR assistant turn ("I have not re-read
// src/db.js, src/quota.js, …"). The source-read-loop PLANNER decides reads from
// the latest user message, so a contentless "those" anchors it on nothing: it
// reads no files and the answer degrades to a hallucinated "I read them" reply.
// So the source-research path resolves the referent DETERMINISTICALLY — detect
// the back-reference, then pull the paths the most recent prior turn named and
// seed them into the read loop. Fail-soft: no gate match, or no named paths, and
// the normal planner behavior is untouched.

// Demonstrative/continuation follow-ups. Anchored to an explicit demonstrative
// ("those/them/these/the rest") or a bare continuation verb so an ordinary new
// question never trips it.
const BACK_REFERENCE_PATTERNS = [
  // A verb + an explicit demonstrative — safe anywhere in the message.
  /\b(?:read|open|look\s+at|check|go\s+through|review|show\s+me|pull\s+up)\s+(?:those|them|these|the\s+(?:rest|others?|remaining|ones))\b/i,
  /\b(?:do|try|run)\s+(?:that|those|it|so)\b/i,
  /\b(?:those\s+files?|them\s+all|all\s+of\s+(?:them|those))\b/i,
  // Bare continuations — anchored to the START of the message so a long real
  // question that merely CONTAINS "continue" / "the rest" doesn't trip.
  /^\s*(?:go\s+on|go\s+ahead|carry\s+on|keep\s+going|continue|proceed|the\s+rest)\b/i,
  /^\s*(?:read|do|them|those)\b/i,
  // Swedish parity (invariant 6).
  /\b(?:läs|öppna|kolla(?:\s+på)?|titta\s+på|gå\s+igenom|granska|visa)\s+(?:dem|de(?:\s+där)?|dessa|resten|de\s+andra|de\s+(?:kvarvarande|återstående))\b/i,
  /\b(?:gör|prova|kör)\s+(?:det|de(?:t\s+där)?|så|dem)\b/i,
  /\b(?:de\s+där\s+filerna|alla\s+(?:dem|dessa))\b/i,
  /^\s*(?:fortsätt|kör\s+(?:på|vidare)|gå\s+vidare|resten)\b/i,
];

/**
 * Deterministic "this is a back-reference to a prior turn" gate (EN+SV). Kept to
 * short-ish follow-ups so a long message that merely contains "continue" or
 * "review" isn't mistaken for a bare back-reference.
 * @param {unknown} text
 * @returns {boolean}
 */
export function backReferenceIntent(text) {
  const s = String(text || "");
  if (s.trim().length > 200) return false;
  return BACK_REFERENCE_PATTERNS.some((re) => re.test(s));
}

/**
 * The snapshot paths a back-reference points at: the paths named by the most
 * recent prior text that names any (walking the given texts in order — pass
 * them MOST RECENT FIRST), bounded to `cap`. [] when nothing prior names a
 * snapshot path.
 * @param {string[]} priorTexts prior message texts, MOST RECENT FIRST
 * @param {Snapshot} snapshot
 * @param {number} [cap]
 * @returns {string[]}
 */
export function resolveReferencedPaths(priorTexts, snapshot, cap = 8) {
  for (const t of Array.isArray(priorTexts) ? priorTexts : []) {
    const paths = mentionedSnapshotPaths(t, snapshot);
    if (paths.length) return paths.slice(0, Math.max(1, cap));
  }
  return [];
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

// ---- the agentic source-read loop (the "read files as it wants" tool) --------
//
// For an introspection question, the pipeline does REAL research in the actual
// source instead of a single RAG-retrieved reply: the model is given a SITEMAP
// (every file + a one-line description) and, round by round, asks to READ the
// files it needs; the loop resolves each request against the snapshot, feeds
// the file text back, and loops until the model has gathered enough to answer.
// This is the source-code counterpart of the bash-lite agent (bash-core.js):
// NO function calling (invariant 1) — the read request is a plain JSON object,
// so it works on any catalog model — and fully fail-soft (a bad step, an empty
// proposal, or a missing file all just end the round with what was gathered).
//
// Everything here is pure and I/O-free (Node-tested): WHO answers the step and
// HOW the file bytes are fetched are injected, so the server (src/pipeline.js
// via the snapshot the enrichment loaded) and any future client tier share one
// driver.

// Caps — the loop is bounded so a runaway (or hostile) model can't blow the
// context window or spin forever. Sized so the gathered source fits alongside
// the sitemap on the reliable JSON model that drives the loop. This whole read
// loop only runs in developer mode (the introspection-first source-research
// path, src/pipeline.js runSourceResearch), so these caps ARE the developer
// exploration profile — leaned generously so the model gets several rounds to
// follow its own curiosity through the tree (reading files as it wants) before
// we make it answer regardless, rather than forcing a verdict after a glance.
export const MAX_SOURCE_READ_ROUNDS = 6; // agentic read rounds before we answer regardless
export const MAX_FILES_PER_ROUND = 6; // file paths accepted from one model turn
export const MAX_READ_FILE_CHARS = 16_000; // one file's text kept, truncated beyond
export const MAX_READ_TOTAL_CHARS = 60_000; // all files read together

/**
 * A one-line, human-readable description of a source file, extracted from its
 * own leading comment (this codebase opens almost every file with a `//` or
 * `/* *\/` header describing it) or, for Markdown, its first line. Deterministic
 * and best-effort — "" when the file has no usable header. Powers the sitemap.
 * @param {string} path
 * @param {string} text
 * @returns {string}
 */
export function fileSummary(path, text) {
  const p = String(path || "");
  const t = String(text || "");
  if (!t) return "";
  if (/\.md$/i.test(p)) {
    // The first PROSE line describes the doc; a leading heading is usually just
    // the title (often the filename) — keep it only as a fallback.
    let fallback = "";
    for (const line of t.split("\n")) {
      const raw = line.trim();
      if (!raw) continue;
      if (raw.startsWith("#")) {
        if (!fallback) fallback = clipSummary(raw.replace(/^#+\s*/, ""));
        continue;
      }
      if (raw.startsWith(">") || raw.startsWith("<!--")) continue;
      return clipSummary(raw);
    }
    return fallback;
  }
  const lines = t.split("\n");
  /** @type {string[]} */
  const parts = [];
  let inBlock = false;
  for (let i = 0; i < lines.length && i < 30; i++) {
    let line = lines[i].trim();
    if (!line) {
      if (parts.length) break; // blank line ends the header once we have content
      continue;
    }
    if (inBlock) {
      const end = line.includes("*/");
      const body = line.replace(/\*\//, "").replace(/^\*+\s?/, "").trim();
      if (body && !isSeparator(body)) parts.push(body);
      if (end) break;
      continue;
    }
    if (line === "// @ts-check" || line === "/* @ts-check */" || /^\/\/\s*@ts-check/.test(line)) continue;
    if (line.startsWith("//")) {
      const body = line.replace(/^\/\/+/, "").trim();
      if (!body || isSeparator(body)) {
        if (parts.length) break;
        continue;
      }
      parts.push(body);
      continue;
    }
    if (line.startsWith("/*")) {
      const oneLine = /\*\//.test(line);
      const body = line.replace(/^\/\*+/, "").replace(/\*\/.*/, "").trim();
      if (body && !isSeparator(body)) parts.push(body);
      if (oneLine) break;
      inBlock = true;
      continue;
    }
    break; // first real code line — no header
  }
  return clipSummary(parts.join(" "));
}

/** @param {string} s @returns {boolean} a comment rule/separator line, not prose */
function isSeparator(s) {
  return /^[-=*_#>\s]+$/.test(s) || /^-{2,}/.test(s);
}

/** @param {string} s first sentence, collapsed and clipped to ~160 chars */
function clipSummary(s) {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  // First sentence if it ends reasonably early, else a hard clip.
  const dot = clean.search(/[.:]\s/);
  const first = dot > 20 && dot < 170 ? clean.slice(0, dot) : clean;
  return first.length <= 180 ? first : first.slice(0, 177) + "…";
}

/**
 * The SITEMAP: every file in the snapshot as `path — one-line description`, the
 * "full list of files with brief explanations" the read loop chooses from. Files
 * with no extractable summary list their path alone.
 * @param {Snapshot} snapshot
 * @returns {string}
 */
export function buildSourceSitemap(snapshot) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  return files
    .map((f) => {
      const d = fileSummary(f.p, f.t);
      return d ? `${f.p} — ${d}` : f.p;
    })
    .join("\n");
}

/**
 * The model's parsed read step: the file paths to read this round, whether it
 * has declared itself done, and its one-line reasoning. Tolerant — never throws;
 * an empty/absent read list means done (nothing more to read is the natural
 * terminator, mirroring parseShellRequest).
 * @typedef {{ read: string[], done: boolean, reasoning: string }} ReadProposal
 */

/**
 * Normalize one raw read-step object ({read:[...], reasoning, done}) into a
 * ReadProposal. Requesting files ALWAYS continues the loop (read them, next
 * round decides); no files means done.
 * @param {any} raw
 * @returns {ReadProposal}
 */
export function normalizeReadStep(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const paths = (Array.isArray(r.read) ? r.read : [])
    .filter((/** @type {any} */ x) => typeof x === "string" && x.trim())
    .map((/** @type {string} */ x) => x.trim())
    .slice(0, MAX_FILES_PER_ROUND);
  const reasoning = typeof r.reasoning === "string" ? r.reasoning.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  return { read: paths, done: paths.length === 0, reasoning };
}

/**
 * Resolve requested file paths to ACTUAL snapshot paths: exact match first
 * (case-insensitive, leading `./` stripped), then a unique basename match
 * ("auth.js" → "src/auth.js" when only one file has that basename). Ambiguous
 * or unknown requests resolve to null. Returns one entry per request, in order.
 * @param {Snapshot} snapshot
 * @param {string[]} requested
 * @returns {Array<{ requested: string, path: string | null }>}
 */
export function resolveReadPaths(snapshot, requested) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  /** @type {Map<string, string>} */
  const byPath = new Map();
  /** @type {Map<string, string | null>} */
  const byBase = new Map();
  for (const f of files) {
    byPath.set(f.p.toLowerCase(), f.p);
    const base = f.p.slice(f.p.lastIndexOf("/") + 1).toLowerCase();
    byBase.set(base, byBase.has(base) ? null : f.p); // second sighting → ambiguous
  }
  return (Array.isArray(requested) ? requested : []).map((raw) => {
    const norm = String(raw || "").trim().replace(/^\.?\//, "").toLowerCase();
    let path = byPath.get(norm) || null;
    if (!path) {
      const base = norm.slice(norm.lastIndexOf("/") + 1);
      const hit = byBase.get(base);
      if (hit) path = hit;
    }
    return { requested: String(raw || ""), path };
  });
}

/**
 * Read the requested files out of the snapshot, honoring the running char
 * budget and skipping ones already read. Each file's text is clamped to
 * MAX_READ_FILE_CHARS, the whole gathered set to MAX_READ_TOTAL_CHARS.
 * @param {Snapshot} snapshot
 * @param {string[]} requested
 * @param {Set<string>} alreadyRead file paths gathered in earlier rounds
 * @param {{ used: number }} budget mutated: total chars gathered so far
 * @returns {Array<{ p: string, text: string, bytes: number, truncated: boolean }>}
 */
export function readSnapshotFiles(snapshot, requested, alreadyRead, budget) {
  const files = (snapshot && Array.isArray(snapshot.files)) ? snapshot.files : [];
  const resolved = resolveReadPaths(snapshot, requested);
  const out = [];
  for (const r of resolved) {
    if (!r.path || (alreadyRead && alreadyRead.has(r.path))) continue;
    const f = files.find((x) => x.p === r.path);
    if (!f) continue;
    if (budget.used >= MAX_READ_TOTAL_CHARS) break; // budget spent — stop this round
    const cap = Math.min(MAX_READ_FILE_CHARS, MAX_READ_TOTAL_CHARS - budget.used);
    const truncated = f.t.length > cap;
    const text = truncated ? f.t.slice(0, cap) + "\n… [truncated]" : f.t;
    // Charge the budget by the SOURCE chars kept (the "\n… [truncated]" marker
    // is bookkeeping, not content), so the total cap is honored exactly.
    budget.used += truncated ? cap : f.t.length;
    out.push({ p: r.path, text, bytes: f.s, truncated });
  }
  return out;
}

/**
 * The labeled context block of the files gathered by the read loop — appended
 * to the synthesis input as ground truth (the enrichment-block convention).
 * Empty string when nothing was read (so the input is byte-identical to a run
 * that only used the retrieved excerpts).
 * @param {Array<{ p: string, text: string, truncated?: boolean }>} reads
 * @returns {string}
 */
export function buildSourceResearchBlock(reads) {
  const list = (Array.isArray(reads) ? reads : []).filter((r) => r && r.p && typeof r.text === "string");
  if (!list.length) return "";
  const body = list.map((r) => `# ${r.p}${r.truncated ? " (truncated)" : ""}\n${r.text}`).join("\n\n");
  return (
    "Source files read from the project's own code during this research (ground " +
    "truth — quote from these and cite their file paths in the answer):\n\n" +
    body
  );
}

/**
 * The per-round USER message the loop's step sees: the question, the
 * conversation context, the sitemap to choose files from, and the files read so
 * far (round 2+). Shared so the server and any client tier ask identically.
 * @param {{ question: string, context: string, sitemap: string, priorBlock?: string }} params
 * @returns {string}
 */
export function buildSourceStepMessage({ question, context, sitemap, priorBlock = "" }) {
  return (
    `Research question (latest user message):\n${question}\n\n` +
    `Conversation context:\n${context}\n\n` +
    `Sitemap — every file in this project's source, with a one-line description. Choose the files to READ from this list:\n${sitemap}\n\n` +
    (priorBlock
      ? `${priorBlock}\n\nList the NEXT files you need to read to answer thoroughly (follow imports/references you saw), or reply {"done":true} if you have read enough of the actual code.`
      : `List the files you need to READ FIRST to research this from the actual source code, or reply {"done":true} if reading the source is not needed for this message.`)
  );
}

/**
 * Run the agentic source-read loop: repeatedly ask the MODEL which files to read
 * (via the injected `step`) and resolve them from the snapshot (via the injected
 * `read`), until the model is done or the round cap is hit. Generic over WHO
 * answers the step and HOW bytes are read, so the server and any client tier
 * share one driver. Never throws — a failing step or read ends the loop with
 * whatever was gathered (fail-soft).
 * @param {{
 *   step: (priorReads: Array<{ p: string, text: string, truncated?: boolean }>, round: number) => Promise<any>,
 *   read: (paths: string[], alreadyRead: Set<string>) => Promise<Array<{ p: string, text: string, truncated?: boolean }>>,
 *   maxRounds?: number,
 *   onRound?: (info: { round: number, reasoning: string, requested: string[], got: Array<{ p: string }> }) => void,
 *   initial?: Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>,
 * }} params
 * @returns {Promise<Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>>}
 */
export async function runSourceReadLoop({ step, read, maxRounds = MAX_SOURCE_READ_ROUNDS, onRound, initial = [] }) {
  /** @type {Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>} */
  const reads = [];
  /** @type {Set<string>} */
  const readPaths = new Set();
  // Pre-seeded reads (e.g. a "read those" back-reference resolved to the files
  // the prior turn named): counted as already-read so the planner continues
  // from them (round 1 sees a non-empty priorReads) and they ground the answer.
  for (const r of Array.isArray(initial) ? initial : []) {
    if (r && r.p && !readPaths.has(r.p)) {
      readPaths.add(r.p);
      reads.push(r);
    }
  }
  for (let round = 1; round <= maxRounds; round++) {
    /** @type {ReadProposal} */
    let proposal;
    try {
      proposal = normalizeReadStep(await step(reads, round));
    } catch {
      break; // a failing step ends the loop with what we have (fail-soft)
    }
    if (proposal.done || !proposal.read.length) break;
    /** @type {Array<{ p: string, text: string, truncated?: boolean }>} */
    let got;
    try {
      got = await read(proposal.read, readPaths);
    } catch {
      got = [];
    }
    const fresh = (Array.isArray(got) ? got : []).filter((g) => g && g.p && !readPaths.has(g.p));
    for (const g of fresh) readPaths.add(g.p);
    reads.push(...fresh);
    if (onRound) onRound({ round, reasoning: proposal.reasoning, requested: proposal.read, got: fresh });
    if (!fresh.length) break; // nothing new resolved → stop rather than spin
  }
  return reads;
}

// ---- native tool-use executors (the invariant-1 exception) --------------------
//
// The three source-investigation TOOLS the ANSWER model drives with real
// function calls when it supports tool use — grep_source (≈ `grep -rn`),
// read_file (≈ `cat`), list_files (≈ `ls`) — executed against the deployed
// source snapshot. This is the owner-authorized 2026-07-12 exception to
// invariant 1, and it lives in this SHARED core so BOTH tiers use one
// implementation: the DRS server runs them in the Worker
// (src/introspect-tools.js re-exports these; src/pipeline.js drives the loop via
// src/anthropic.js), and DRC runs them in the BROWSER (public/js/drc-research.js
// drives the loop against the user's own tool-capable provider, and adds a real
// run_bash tool over the CheerpX sandbox, which only the browser can reach).
//
// Everything here is PURE (operates on a passed snapshot) and NEVER throws — a
// bad tool input returns an explanatory string, matching the fail-soft posture.

// Output bounds — one tool result is clamped so a broad grep or a huge file
// can't blow the model's context window or the loop's token budget.
export const MAX_GREP_MATCHES = 80; // matching lines returned from one grep
export const MAX_GREP_OUTPUT_CHARS = 6000; // total chars of grep output
export const MAX_LIST_ENTRIES = 300; // paths returned from one list_files
export const MAX_LIST_OUTPUT_CHARS = 6000;
export const MAX_PATTERN_CHARS = 300; // a grep pattern is clamped to this
export const MAX_LINE_CHARS = 240; // one matched line is clamped to this

// The provider-neutral tool definitions (name / description / JSON input
// schema). The DRS loop maps these onto Anthropic's `tools` shape and DRC onto
// the OpenAI/Groq `tools` shape — the fields line up with both. read_file /
// grep_source / list_files are source-only; DRC ADDS a run_bash entry at its
// call site (the sandbox is browser-only), so it is not declared here.
export const INTROSPECTION_TOOLS = [
  {
    name: "grep_source",
    description:
      "Search the site's own deployed source code with a regular expression, like `grep -rn`. Returns matching lines as `path:line: text`. Use this FIRST to locate where something is implemented before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "A JavaScript regular expression. Case-sensitive unless you prefix it with (?i), e.g. (?i)session_secret.",
        },
        path_glob: {
          type: "string",
          description: "Optional substring to limit which files are searched, e.g. 'src/', '.js', or 'auth'.",
        },
        max_matches: { type: "integer", description: `Max matching lines to return (default ${MAX_GREP_MATCHES}).` },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the full contents of one or more source files by exact repo path (like `cat`), e.g. 'src/auth.js'. Use paths from grep_source or list_files.",
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative file paths to read." },
      },
      required: ["paths"],
    },
  },
  {
    name: "list_files",
    description:
      "List repo file paths (optionally filtered by a substring) with byte sizes, so you know what exists before grepping or reading.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring to filter paths, e.g. 'src/' or '.test.js'." },
      },
      required: [],
    },
  },
];

/** @param {Snapshot} snapshot @returns {Array<{p:string,s:number,t:string}>} */
function toolFilesOf(snapshot) {
  return snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
}

/** @param {any} s @param {number} max @returns {string} */
function clipTool(s, max) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length <= max ? str : str.slice(0, max) + `\n…[truncated ${str.length - max} chars]`;
}

// Compile the model-supplied pattern into a per-line RegExp. Supports a leading
// (?i) for case-insensitivity (JS has no inline flag). Returns null on an
// invalid or empty pattern — the caller reports it rather than throwing.
/** @param {unknown} raw @returns {RegExp | null} */
function compileToolPattern(raw) {
  let pat = String(raw || "").slice(0, MAX_PATTERN_CHARS);
  if (!pat.trim()) return null;
  let flags = "";
  if (pat.startsWith("(?i)")) {
    flags = "i";
    pat = pat.slice(4);
  }
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

/**
 * grep_source: scan every snapshot file (optionally filtered by a path
 * substring) for the pattern, line by line, returning `path:line: text` up to
 * the match/char caps. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function grepSource(snapshot, input) {
  const re = compileToolPattern(input?.pattern);
  if (!re) return `Invalid or empty regular expression: ${JSON.stringify(input?.pattern ?? null)}`;
  const glob = String(input?.path_glob || "").toLowerCase();
  const cap = Math.max(1, Math.min(MAX_GREP_MATCHES, Number(input?.max_matches) || MAX_GREP_MATCHES));
  /** @type {string[]} */
  const out = [];
  let total = 0;
  let truncated = false;
  for (const f of toolFilesOf(snapshot)) {
    if (glob && !f.p.toLowerCase().includes(glob)) continue;
    const lines = String(f.t || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      out.push(`${f.p}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
      total++;
      if (total >= cap) {
        truncated = true;
        break;
      }
    }
    if (total >= cap) break;
  }
  if (!out.length) return `No matches for /${input?.pattern}/${glob ? ` in files matching '${glob}'` : ""}.`;
  const header = `${total} match${total === 1 ? "" : "es"}${truncated ? ` (capped at ${cap})` : ""}:`;
  return clipTool([header, ...out].join("\n"), MAX_GREP_OUTPUT_CHARS);
}

/**
 * read_file: resolve the requested paths against the snapshot and return their
 * full text (clamped by the shared read budget). Accepts {paths:[...]} or a
 * single {path:"..."}. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @param {{ used: number }} budget shared across the loop to bound total bytes
 * @returns {string}
 */
export function readFileTool(snapshot, input, budget) {
  const requested = Array.isArray(input?.paths)
    ? input.paths
    : typeof input?.path === "string"
      ? [input.path]
      : [];
  const paths = requested.filter((/** @type {any} */ p) => typeof p === "string" && p.trim()).slice(0, 8);
  if (!paths.length) return "read_file needs a non-empty 'paths' array of repo-relative file paths.";
  const reads = readSnapshotFiles(snapshot, paths, new Set(), budget);
  if (!reads.length) {
    return `No files resolved for ${JSON.stringify(paths)}. Use list_files or grep_source to find exact paths (e.g. src/auth.js).`;
  }
  const body = reads.map((r) => `# ${r.p}${r.truncated ? " (truncated)" : ""}\n${r.text}`).join("\n\n");
  const missing = paths.filter(
    (/** @type {string} */ p) => !reads.some((r) => r.p.toLowerCase() === String(p).toLowerCase().replace(/^\.?\//, "")),
  );
  const note = missing.length ? `\n\n(not found / already at budget: ${missing.join(", ")})` : "";
  return body + note;
}

/**
 * list_files: the repo file paths (optionally substring-filtered) with byte
 * sizes. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function listFilesTool(snapshot, input) {
  const filter = String(input?.filter || "").toLowerCase();
  const matched = toolFilesOf(snapshot).filter((f) => !filter || f.p.toLowerCase().includes(filter));
  if (!matched.length) return `No files${filter ? ` matching '${filter}'` : ""}.`;
  const shown = matched.slice(0, MAX_LIST_ENTRIES);
  const header = `${matched.length} file${matched.length === 1 ? "" : "s"}${
    shown.length < matched.length ? ` (showing ${shown.length})` : ""
  }:`;
  return clipTool([header, ...shown.map((f) => `${f.p}\t${f.s}`)].join("\n"), MAX_LIST_OUTPUT_CHARS);
}

/**
 * Dispatch one native SOURCE tool call to its executor. The seam both tiers'
 * tool loops call for the source tools; returns the tool result STRING the
 * model sees next round. Never throws. (DRC handles run_bash separately, at its
 * sandbox call site.)
 * @param {Snapshot} snapshot
 * @param {string} name
 * @param {any} input
 * @param {{ used: number }} budget
 * @returns {string}
 */
export function runIntrospectionTool(snapshot, name, input, budget) {
  try {
    switch (name) {
      case "grep_source":
        return grepSource(snapshot, input);
      case "read_file":
        return readFileTool(snapshot, input, budget);
      case "list_files":
        return listFilesTool(snapshot, input);
      default:
        return `Unknown tool "${name}". Available tools: grep_source, read_file, list_files.`;
    }
  } catch (/** @type {any} */ err) {
    return `Tool "${name}" failed: ${err?.message || String(err)}`;
  }
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
 * @param {Array<{ id: string, name?: string, up?: boolean, provider?: string }>} serverModels /api/models entries ([] on DRC)
 * @returns {{ groups: Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>, recommended: string }}
 */
export function groupIntrospectionModels(privateProviders, serverModels) {
  /** @type {Array<{ kind: "private" | "remote", label: string, options: Array<{ value: string, label: string, disabled?: boolean }> }>} */
  const groups = [];
  // A flag prefix (with trailing space) marks where each route's data is
  // processed; a local/unknown provider yields "" (no flag) — see
  // provider-region.js.
  const priv = (Array.isArray(privateProviders) ? privateProviders : []).flatMap((p) => {
    const pr = regionForProvider(p?.id);
    const pf = pr ? pr.flag + " " : "";
    return (Array.isArray(p?.models) ? p.models : []).map((m) => ({
      value: `p:${p.id}:${m}`,
      label: `🔒 ${pf}${m} — ${p.label}, your key (private)`,
    }));
  });
  if (priv.length) {
    groups.push({ kind: "private", label: "Private — your key, straight from this browser", options: priv });
  }
  const remote = (Array.isArray(serverModels) ? serverModels : [])
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => {
      const r = regionForModelEntry(m);
      const rf = r ? r.flag + " " : "";
      return {
        value: `s:${m.id}`,
        label: `☁ ${rf}${m.name || m.id} — remote (this site's server)`,
        disabled: m.up === false,
      };
    });
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
