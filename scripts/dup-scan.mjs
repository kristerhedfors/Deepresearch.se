#!/usr/bin/env node
// The refactor survey's duplicate scanner (see the **refactor-clarity** skill).
// Hashes normalized function bodies across the git-tracked JS of this repo and
// reports the ones that appear in more than one file.
//
// WHY this exists as a tool and not a prompt: the 2026-07-23 pass (eighth
// worked example) ran three reasoning fan-outs that ALL returned "nothing
// left", then found two real cuts with an ad-hoc hash scan. Agents reason about
// which duplications SHOULD exist; the scan finds the ones that DO. Every pass
// since re-improvised the scan, so it is committed here instead.
//
//   node scripts/dup-scan.mjs                # duplicate bodies, ≥4 lines
//   node scripts/dup-scan.mjs --min-lines 8  # only the big ones
//   node scripts/dup-scan.mjs --collisions   # ALSO same-name-different-body
//   node scripts/dup-scan.mjs --json         # machine-readable
//
// Output is ADVISORY. A hit is a survey candidate, never a verdict: the skill's
// five gates (purity, verbatim, home, tier, bar) decide whether it may be cut,
// and references/STANDING-DECLINES.md records the ones already ruled out.
//
// The parser is deliberately dumb — a brace matcher with a string/comment/regex
// skipper, no AST, no dependency (invariant 5: no added runtime deps). It can
// miss an exotic declaration; it cannot invent a match, because two bodies only
// group when their normalized text is byte-identical.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Both tiers plus the SDK. Tests are excluded (duplicate arrange/assert blocks
// are expected there and drown the signal); so are vendored libs and the
// generated introspection artifacts.
const INCLUDE = /^(src|public\/js|public\/cure|sdk|scripts)\/.*\.(js|mjs)$/;
const EXCLUDE = [/\.test\.(js|mjs)$/, /^public\/vendor\//, /^public\/introspect\//];

/**
 * Walk a JS source string and return the index of the character after the block
 * that opens at `openIdx` (which must be a `{`), skipping over strings,
 * template literals, comments, and regex literals. Returns -1 if unbalanced.
 * @param {string} src
 * @param {number} openIdx
 */
export function matchBrace(src, openIdx) {
  let depth = 0;
  // Tracks whether a `/` here can start a regex literal: true right after an
  // operator/punctuator, false after a value (identifier, `)`, `]`, literal).
  let regexOk = true;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i);
      if (i === -1) return -1;
      regexOk = false;
      continue;
    }
    if (c === "/" && regexOk) {
      const end = skipRegex(src, i);
      if (end !== -1) {
        i = end;
        regexOk = false;
        continue;
      }
    }
    if (c === "{") {
      depth++;
      regexOk = true;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
      regexOk = true;
      continue;
    }
    if (!/\s/.test(c)) regexOk = /[-+*/%=<>!&|^~?:;,(\[{]/.test(c);
  }
  return -1;
}

/** Index of the closing quote of the string/template starting at `i`. */
function skipQuoted(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    // A template's ${...} can nest arbitrary code, braces included.
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      const close = matchBrace(src, j + 1);
      if (close === -1) return -1;
      j = close - 1;
      continue;
    }
    if (src[j] === q) return j;
  }
  return -1;
}

/** Index of the closing `/` of a regex literal starting at `i`, or -1. */
function skipRegex(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") {
      // A character class may contain an unescaped `/`.
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      continue;
    }
    if (c === "/") return j;
  }
  return -1;
}

// `function foo(`, `const foo = (…) =>`, `async` variants, `export` prefixes,
// and object/class methods `foo(a, b) {`. Anchored at a line start so a call
// expression mid-line never registers as a declaration.
const DECL = new RegExp(
  [
    "^\\s*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)",
    "^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*[\\w$]*\\s*)?\\(",
    "^\\s{0,4}(?:static\\s+)?(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*\\([^;]*\\)\\s*\\{\\s*$",
  ].join("|"),
);

// Keywords that look like a method declaration to the regex above.
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "function", "return", "do", "else"]);

/**
 * Extract top-levelish function bodies from one file.
 * @param {string} src
 * @param {string} path
 * @returns {{path: string, name: string, line: number, lines: number, body: string}[]}
 */
export function extractFunctions(src, path = "") {
  const out = [];
  const lines = src.split("\n");
  let offset = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const lineStart = offset;
    offset += line.length + 1;
    const m = DECL.exec(line);
    if (!m) continue;
    const name = m[1] || m[2] || m[3];
    if (!name || NOT_A_NAME.has(name)) continue;
    // The body opens at the first `{` at or after this line that is not inside
    // the parameter list; scanning from the declaration start is enough because
    // matchBrace skips strings and comments on the way.
    const open = findBodyBrace(src, lineStart + line.length - line.trimStart().length);
    if (open === -1) continue;
    const end = matchBrace(src, open);
    if (end === -1) continue;
    const body = src.slice(open, end);
    const count = body.split("\n").length;
    out.push({ path, name, line: ln + 1, lines: count, body });
    // Skip past the body so nested helpers are not double-counted as their own
    // declarations — a nested pure helper still shows up when its PARENT is
    // compared, and counting it twice would inflate every group.
    while (offset < end && ln < lines.length - 1) {
      ln++;
      offset += lines[ln].length + 1;
    }
  }
  return out;
}

/** First `{` that opens a body (skips the parameter list), or -1. */
function findBodyBrace(src, from) {
  let depth = 0;
  for (let i = from; i < src.length && i < from + 4000; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth <= 0) return i;
    else if (c === ";" && depth <= 0) return -1;
  }
  return -1;
}

/**
 * Normalize a body for comparison: drop comments, collapse whitespace. Names
 * are NOT stripped — two bodies that differ only in an identifier are not a
 * verbatim move (the skill's verbatim gate), so they must not group.
 * @param {string} body
 */
export function normalizeBody(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Group functions whose normalized bodies are identical across ≥2 files.
 * @param {{path: string, name: string, line: number, lines: number, body: string}[]} fns
 * @param {number} minLines
 */
export function groupDuplicates(fns, minLines = 4) {
  /** @type {Map<string, {hash: string, lines: number, names: Set<string>, sites: {path: string, name: string, line: number}[]}>} */
  const byHash = new Map();
  for (const fn of fns) {
    if (fn.lines < minLines) continue;
    const norm = normalizeBody(fn.body);
    if (norm.length < 40) continue;
    const hash = createHash("sha256").update(norm).digest("hex").slice(0, 12);
    let g = byHash.get(hash);
    if (!g) byHash.set(hash, (g = { hash, lines: fn.lines, names: new Set(), sites: [] }));
    g.names.add(fn.name);
    g.sites.push({ path: fn.path, name: fn.name, line: fn.line });
  }
  return [...byHash.values()]
    .filter((g) => new Set(g.sites.map((s) => s.path)).size > 1)
    .sort((a, b) => b.lines - a.lines || a.hash.localeCompare(b.hash));
}

/**
 * Same name in ≥2 files with DIFFERENT bodies — the `normalizeStatus` trap:
 * they look like a de-dup candidate and unifying them changes behavior.
 * @param {{path: string, name: string, line: number, lines: number, body: string}[]} fns
 * @param {number} minLines
 */
export function nameCollisions(fns, minLines = 4) {
  /** @type {Map<string, {path: string, line: number, hash: string}[]>} */
  const byName = new Map();
  for (const fn of fns) {
    if (fn.lines < minLines) continue;
    const hash = createHash("sha256").update(normalizeBody(fn.body)).digest("hex").slice(0, 12);
    const list = byName.get(fn.name) || [];
    list.push({ path: fn.path, line: fn.line, hash });
    byName.set(fn.name, list);
  }
  const out = [];
  for (const [name, sites] of byName) {
    const paths = new Set(sites.map((s) => s.path));
    const hashes = new Set(sites.map((s) => s.hash));
    if (paths.size > 1 && hashes.size > 1) out.push({ name, sites });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function trackedJs() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => INCLUDE.test(p))
    .filter((p) => !EXCLUDE.some((re) => re.test(p)))
    .sort();
}

function main(argv) {
  const minLines = Number(argv[argv.indexOf("--min-lines") + 1]) || 4;
  const asJson = argv.includes("--json");
  const withCollisions = argv.includes("--collisions");
  const fns = [];
  for (const p of trackedJs()) {
    try {
      fns.push(...extractFunctions(readFileSync(join(ROOT, p), "utf8"), p));
    } catch {
      // Unreadable or exotic file: the scan is advisory, so skip it silently
      // rather than failing a survey over one parse.
    }
  }
  const groups = groupDuplicates(fns, minLines);
  const collisions = withCollisions ? nameCollisions(fns, minLines) : [];
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          scanned: fns.length,
          groups: groups.map((g) => ({ ...g, names: [...g.names] })),
          collisions,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`scanned ${fns.length} function bodies (min ${minLines} lines)\n`);
  console.log(`— ${groups.length} duplicate bodies across files —`);
  for (const g of groups) {
    console.log(`\n[${g.lines} lines] ${[...g.names].join(" / ")}`);
    for (const s of g.sites) console.log(`    ${s.path}:${s.line}  ${s.name}`);
  }
  if (withCollisions) {
    console.log(`\n— ${collisions.length} same-name-different-body (do NOT unify blind) —`);
    for (const c of collisions) {
      console.log(`\n${c.name}`);
      for (const s of c.sites) console.log(`    ${s.path}:${s.line}  #${s.hash}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("dup-scan.mjs")) main(process.argv.slice(2));
