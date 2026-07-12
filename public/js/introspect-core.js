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

/**
 * Build the labeled introspection context block appended to the conversation
 * (the Shodan-block convention: plain text, explicit begin/end markers, and
 * the material is CONTEXT — with one capability line so the model doesn't
 * deny having its own source, the hasShell lesson).
 * @param {Snapshot} snapshot
 * @param {{
 *   latestText?: string,        // the latest user message — drives named-file inlining
 *   sandboxMounted?: boolean,   // the /src tree will be available in the Linux VM
 * }} [opts]
 * @returns {string}
 */
export function buildIntrospectionBlock(snapshot, opts = {}) {
  const lines = [];
  lines.push("--- Introspection: deepresearch.se source snapshot (developer mode) ---");
  lines.push(
    `This conversation is in INTROSPECTION MODE. Below is the structured snapshot of the EXACT source code of the deepresearch.se deployment answering right now (${snapshot.count} files, ${snapshot.bytes} bytes` +
      (snapshot.digest ? `, digest ${snapshot.digest.slice(0, 12)}` : "") +
      "). You DO have access to this site's own implementation here — answer implementation questions from this material, citing file paths.",
  );
  if (opts.sandboxMounted) {
    lines.push(
      "The complete tree is ALSO mounted at /src inside the Linux sandbox (e.g. /src/src/pipeline.js) — shell commands over it (ls, cat, grep -rn) are the way to read anything not inlined below.",
    );
  } else {
    lines.push(
      "Only the files inlined below are fully readable here. To read others, the user can name a repo path from the index, or enable the execution sandbox (the tree is then mounted at /src for real shell exploration).",
    );
  }
  lines.push("");
  lines.push("# File index (path\tbytes)");
  lines.push(snapshotIndex(snapshot));

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
  lines.push("--- End of introspection snapshot ---");
  return "\n\n" + lines.join("\n");
}

/** @param {string} t @param {number} max */
function clip(t, max) {
  return t.length <= max ? t : t.slice(0, max) + "\n… [truncated — full file in the snapshot/sandbox]";
}
