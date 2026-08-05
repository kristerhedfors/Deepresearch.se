// Pure core for the ground-truth deep-research eval sets (`tests/evalsets/`).
//
// Everything here is deterministic and network-free so `npm test` can pin it:
// CSV parsing (the upstream benchmarks ship as CSV with quoted, newline-
// bearing fields), seeded sampling (a re-run of scripts/dr-evalset.mjs must
// select the SAME questions or a before/after comparison is measuring the
// sample, not the change), the BrowseComp XOR decryption, and the answer
// normalisation the objective grader matches on.
//
// The runner is tests/dr-eval.mjs; the builder is scripts/dr-evalset.mjs.

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC-4180 CSV → array of row objects keyed by the header row.
 *
 * Hand-rolled because the repo carries zero runtime deps and this is 40 lines.
 * Handles quoted fields containing commas, newlines and doubled quotes — all
 * three occur in SimpleQA's `metadata` column, which is a Python dict literal.
 *
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  // Strip a UTF-8 BOM; Excel-exported benchmark CSVs carry one.
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Swallow CRLF as one terminator; ignore a blank trailing line.
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((v) => v !== "")).map((r) => {
    /** @type {Record<string,string>} */
    const o = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
}

// ---------------------------------------------------------------------------
// Seeded sampling
// ---------------------------------------------------------------------------

/** mulberry32 — a small, well-distributed seeded PRNG. @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `n` indices out of `total`, deterministically for a given seed, and
 * return them in ASCENDING order so the built set reads in upstream order.
 *
 * Partial Fisher-Yates rather than "sort by random key": the latter is O(n log n)
 * and its output shifts when the corpus grows even by one row.
 *
 * @param {number} total @param {number} n @param {number} seed
 * @returns {number[]}
 */
export function sampleIndices(total, n, seed) {
  const take = Math.max(0, Math.min(n, total));
  const rand = mulberry32(seed);
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (total - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, take).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// BrowseComp obfuscation
// ---------------------------------------------------------------------------
//
// BrowseComp ships XOR-obfuscated so its answers cannot be scraped into a
// training corpus, with each row's own canary as the password. We keep the
// CIPHERTEXT in the committed set and decrypt at load time, so this repo does
// not become one of the leaks the scheme exists to prevent.
// Scheme mirrors openai/simple-evals `browsecomp_eval.py`.

/** @param {string} password @param {number} length */
export function deriveKey(password, length) {
  const key = crypto.createHash("sha256").update(password, "utf8").digest();
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = key[i % key.length];
  return out;
}

/** @param {string} ciphertextB64 @param {string} password @returns {string} */
export function xorDecrypt(ciphertextB64, password) {
  const enc = Buffer.from(ciphertextB64, "base64");
  const key = deriveKey(password, enc.length);
  const out = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ key[i];
  return out.toString("utf8");
}

// ---------------------------------------------------------------------------
// Answer normalisation (the objective grader's cheap first pass)
// ---------------------------------------------------------------------------

const ARTICLES = /\b(?:a|an|the)\b/g;

/**
 * Lowercase, strip punctuation/articles/diacritics, collapse whitespace.
 *
 * Deliberately conservative: this is the FAST path that resolves the easy
 * majority. Anything it does not resolve goes to the LLM grader rather than
 * being scored wrong — a normaliser that tries to be clever ("Jane Ballou" vs
 * "Ms. Jane Ballou-Smith") silently manufactures both false positives and
 * false negatives, and the judge is cheap next to a research run.
 *
 * @param {string} s
 */
export function normalizeAnswer(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9%.\-/ ]+/g, " ")
    .replace(ARTICLES, " ")
    .replace(/\s+/g, " ")
    .trim()
    // `.` `-` `/` survive the class above because they carry meaning INSIDE a
    // token (3.14, 2024-05, and/or). At the edges they are just punctuation,
    // and leaving them there made "Warner Music Group." unequal to its own
    // gold answer.
    .replace(/^[.\-/]+|[.\-/]+$/g, "")
    .trim();
}

/**
 * Numeric-aware equality: "1,234" == "1234", "12.0" == "12", "45%" == "45 %".
 * Returns null when either side is not a number, so the caller falls through.
 * @param {string} a @param {string} b @returns {boolean|null}
 */
export function numericEqual(a, b) {
  const num = (/** @type {string} */ s) => {
    const m = String(s).replace(/[, ]/g, "").match(/^-?\d+(?:\.\d+)?%?$/);
    if (!m) return null;
    return parseFloat(m[0]);
  };
  const x = num(a);
  const y = num(b);
  if (x === null || y === null) return null;
  return Math.abs(x - y) < 1e-9;
}

/**
 * The objective pre-grade. `hit` means the gold answer is present in the
 * response verbatim enough that no judge call is warranted; `miss` is never
 * asserted — an un-hit item returns "unknown" and the judge decides.
 *
 * @param {string} response @param {string} gold
 * @returns {"hit"|"unknown"}
 */
export function objectiveGrade(response, gold) {
  const g = normalizeAnswer(gold);
  if (!g) return "unknown";
  const r = normalizeAnswer(response);
  if (!r) return "unknown";
  if (numericEqual(g, r) === true) return "hit";
  // Substring on the normalised forms, guarded by word boundaries so "12"
  // does not hit inside "2012".
  const esc = g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(r)) return "hit";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

/**
 * Pull the `[n]` markers and the trailing "- [n] Title — URL" source list out
 * of a deep_research answer. The MCP tool returns ONE text blob (no structured
 * sources), so citation quality has to be read back off the prose.
 *
 * @param {string} text
 * @returns {{markers:number[], sources:{n:number,title:string,url:string}[], body:string}}
 */
export function parseCitations(text) {
  const s = String(text ?? "");
  // The same heading shapes src/sources.js recognises, for the same reason:
  // models write `### Sources:`, `**Sources:**`, `- Sources:` and, in Swedish,
  // `Källor:`. Matching only the bare form counts the whole source list as
  // body prose and every metric downstream shifts.
  const srcHeadIdx = s.search(
    /\n[ \t]*(?:[#>*_\-–—]|\d+[.)])*[ \t]*\**[ \t]*(?:Sources|Källor|Kallor)\b[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*\n/i,
  );
  const body = srcHeadIdx >= 0 ? s.slice(0, srcHeadIdx) : s;
  const tail = srcHeadIdx >= 0 ? s.slice(srcHeadIdx) : "";
  /** @type {number[]} */
  const markers = [];
  for (const m of body.matchAll(/\[(\d{1,3})\]/g)) markers.push(Number(m[1]));
  /** @type {{n:number,title:string,url:string}[]} */
  const sources = [];
  // One entry per line: a bracketed number, a title, and a URL somewhere after
  // it. Deliberately tolerant about what sits between them, because the list
  // is the ANSWER MODEL's own formatting and it varies — `— https://…`,
  // `- [1] Title — [https://…](https://…)` (markdown link, which cost this
  // parser a whole run before it was handled), bold titles, no dash at all.
  // A parser that insists on one layout silently reports zero sources for an
  // answer that cited a dozen, and every citation metric built on it lies.
  for (const line of tail.split("\n")) {
    const head = line.match(/^\s*(?:(?:[-*+]|\d{1,3}[.)])\s*)*\[(\d{1,3})\]\s*(.*)$/);
    if (!head) continue;
    const rest = head[2];
    const urlAt = rest.search(/https?:\/\//);
    if (urlAt < 0) continue;
    // Trim the wrappers a markdown link leaves on either side.
    const url = rest
      .slice(urlAt)
      .split(/[\s)\]]/)[0]
      .replace(/[.,;]+$/, "");
    const title = rest
      .slice(0, urlAt)
      .replace(/[[(]\s*$/, "")
      .replace(/\s*(?:—|--|–|-|:)\s*$/, "")
      .replace(/\*\*/g, "")
      .trim();
    sources.push({ n: Number(head[1]), title, url });
  }
  return { markers, sources, body };
}

/** @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Citation metrics for one answer.
 *
 * - `dangling`: markers in the prose with no entry in the source list. This is
 *   the failure that matters — a `[7]` pointing at nothing is a citation the
 *   reader cannot check, and it is indistinguishable from a fabricated one.
 * - `unused`: listed sources never cited in the prose (padding).
 * - `coverage`: share of body paragraphs carrying at least one marker.
 * - `domains`: distinct hosts among the listed sources.
 *
 * @param {string} text
 */
export function citationMetrics(text) {
  const { markers, sources, body } = parseCitations(text);
  const listed = new Set(sources.map((s) => s.n));
  const used = new Set(markers);
  const dangling = [...used].filter((n) => !listed.has(n));
  const unused = [...listed].filter((n) => !used.has(n));
  // Substantive prose blocks only: headings carry no claims, and a one-line
  // bold lead is a restatement of the answer rather than a sourced assertion.
  // The floor is deliberately LOW (40 chars): set it high and a short cited
  // sentence is excluded while a long uncited one is counted, which biases
  // coverage down for exactly the answers that cite most tightly.
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !/^#{1,6}\s/.test(p));
  const cited = paras.filter((p) => /\[\d{1,3}\]/.test(p)).length;
  const domains = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean));
  return {
    markerCount: markers.length,
    sourceCount: sources.length,
    danglingCount: dangling.length,
    dangling,
    unusedCount: unused.length,
    coverage: paras.length ? cited / paras.length : null,
    paragraphs: paras.length,
    domainCount: domains.size,
    domains: [...domains],
  };
}

/**
 * Did the answer actually use the sources the benchmark says hold the answer?
 * FRAMES ships the Wikipedia pages a question is built from; a run that
 * answers correctly WITHOUT retrieving any of them answered from memory.
 *
 * @param {string} text @param {string[]} goldUrls
 */
export function goldSourceOverlap(text, goldUrls) {
  const { sources } = parseCitations(text);
  const got = new Set(sources.map((s) => s.url.toLowerCase()));
  const gotHosts = new Set(sources.map((s) => hostOf(s.url)));
  let pathHits = 0;
  const goldPaths = goldUrls
    .map((u) => {
      try {
        return decodeURIComponent(new URL(u).pathname).toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  for (const p of goldPaths) {
    if ([...got].some((u) => decodeURIComponent(u).includes(p))) pathHits++;
  }
  return {
    goldCount: goldPaths.length,
    hits: pathHits,
    recall: goldPaths.length ? pathHits / goldPaths.length : null,
    sameHost: gotHosts.has("en.wikipedia.org"),
  };
}
