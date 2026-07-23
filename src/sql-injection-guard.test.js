// SQL-injection regression guard (whole-of-src).
//
// Every D1 query in this codebase is parameterised: values go through
// `.prepare(sql).bind(...)` with `?` / `?N` placeholders, and the ONLY things
// ever interpolated into a SQL string are code-controlled *identifiers*
// (constant table/column names, whitelisted patch keys, generated `?,?`
// placeholder lists, or numeric timestamps) — never a value taken from a
// request. That invariant is what keeps the site free of SQL injection
// (SECURITY-RISKS.md lists "parameterised SQL" as a standing control), and this
// test enforces it so a future edit can't quietly break it.
//
// How it works: scan every src/*.js file, find each template literal that IS a
// SQL statement/clause, and collect every `${…}` interpolation inside it. Each
// interpolation must appear in ALLOWED_INTERPOLATIONS below — a hand-audited
// list where each entry is provably an identifier/constant/placeholder/number,
// not user data. Bound values (`?`) never appear here because they are not
// interpolated.
//
// If this test fails, someone added a new `${…}` inside SQL. Do NOT just append
// it to the allowlist. First prove the interpolated expression can only ever be
// a code-controlled identifier — if it can carry a request value, it is an
// injection: pass it as a `?` bind parameter instead. Only genuine identifiers
// (which SQL cannot bind) belong on the allowlist, each with a note on why it
// is safe.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// A template literal is SQL when its STATIC text begins with a statement /
// clause keyword (or a SQL aggregate, for the per-window column builder in
// quota.js). Anchoring at the start excludes prose / CSS / HTML that merely
// contains a word like "from" or "set".
const SQL_START =
  /^\s*(SELECT\s|INSERT\s+INTO\s|UPDATE\s|DELETE\s+FROM\s|WHERE\s|VALUES\s*\(|ON\s+CONFLICT|SET\s|SUM\s*\(|COALESCE\s*\()/i;

// Verified-safe interpolations (normalized whitespace). Every entry is a
// code-controlled identifier, NOT a request value.
const ALLOWED_INTERPOLATIONS = new Set([
  // Table name — always a module-level string constant chosen by the board's
  // own code ("security_reviews" / "features_reviews" / "panels_reviews").
  "table",
  // `"col = ?"` assignment fragments built from a fixed/whitelisted key set;
  // the values are bound, only the hardcoded column text is interpolated.
  'sets.join(", ")',
  // Hardcoded `"col = ?"` / `"col LIKE ? ESCAPE '\\'"` predicate fragments;
  // again only the fixed column text is joined in, values are bound.
  'where.join(" AND ")',
  // A constant list of column names (chatlog.js LIST_COLUMNS).
  "LIST_COLUMNS",
  // Generated `?,?,…` placeholder strings for IN (...) clauses — one `?` per
  // bound id, never a value.
  "placeholders",
  "marks",
  // quota.js per-window aggregate columns: `cols`/`bucketCols(...)` expand
  // constant SQL expressions (USAGE_EXPRS) over the fixed PERIODS list, and
  // `starts.*`/`starts[p]` are computed numeric epoch-ms window boundaries.
  "cols",
  "bucketCols(starts, USAGE_EXPRS)",
  "starts.h5",
  "starts.month",
  "starts[p]",
  "p",
  "alias",
  "expr",
]);

/**
 * Extract every `${…}` interpolation that appears inside a SQL template
 * literal in `code`. Skips comments, ordinary strings, and regex literals so a
 * stray backtick inside them cannot desync the scan.
 * @param {string} code
 * @returns {string[]}
 */
function extractSqlInterpolations(code) {
  const out = [];
  const n = code.length;

  function parseTemplate(start) {
    let j = start + 1;
    let stat = "";
    const exprs = [];
    while (j < n) {
      const c = code[j];
      if (c === "\\") { stat += (code[j] || "") + (code[j + 1] || ""); j += 2; continue; }
      if (c === "`") return { end: j, stat, exprs };
      if (c === "$" && code[j + 1] === "{") {
        let depth = 1, k = j + 2, expr = "";
        while (k < n && depth > 0) {
          const d = code[k];
          if (d === "`") { const r = parseTemplate(k); expr += code.slice(k, r.end + 1); k = r.end + 1; continue; }
          if (d === "'" || d === '"') { let m = k + 1; while (m < n && code[m] !== d) { if (code[m] === "\\") m++; m++; } expr += code.slice(k, m + 1); k = m + 1; continue; }
          if (d === "{") { depth++; expr += d; k++; continue; }
          if (d === "}") { depth--; if (depth === 0) { k++; break; } expr += d; k++; continue; }
          expr += d; k++;
        }
        exprs.push(expr.trim());
        j = k; continue;
      }
      stat += c; j++;
    }
    return { end: n, stat, exprs };
  }

  let i = 0;
  let prevSig = ""; // last significant char — disambiguates regex from divide
  while (i < n) {
    const c = code[i];
    if (c === "`") {
      const r = parseTemplate(i);
      if (SQL_START.test(r.stat)) out.push(...r.exprs);
      i = r.end + 1; prevSig = "`"; continue;
    }
    if (c === "'" || c === '"') { const q = c; i++; while (i < n && code[i] !== q) { if (code[i] === "\\") i++; i++; } i++; prevSig = q; continue; }
    if (c === "/" && code[i + 1] === "/") { while (i < n && code[i] !== "\n") i++; continue; }
    if (c === "/" && code[i + 1] === "*") { i += 2; while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/" && (prevSig === "" || "([{,;=:!&|?+-*%^~<>".includes(prevSig) || /\b(return|typeof|case|in|of|do|else|void|delete|instanceof)$/.test(code.slice(Math.max(0, i - 12), i)))) {
      i++; let inClass = false;
      while (i < n) { const d = code[i]; if (d === "\\") { i += 2; continue; } if (d === "[") inClass = true; else if (d === "]") inClass = false; else if (d === "/" && !inClass) { i++; break; } else if (d === "\n") break; i++; }
      prevSig = "/"; continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

test("no request value is ever interpolated into SQL (parameterised queries only)", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  assert.ok(files.length > 20, "sanity: expected to scan the whole src/ tree");

  /** @type {Map<string, Set<string>>} normalized interpolation -> files */
  const found = new Map();
  for (const f of files) {
    for (const raw of extractSqlInterpolations(readFileSync(join(SRC_DIR, f), "utf8"))) {
      const k = norm(raw);
      if (!found.has(k)) found.set(k, new Set());
      found.get(k).add(f);
    }
  }

  const offenders = [];
  for (const [expr, where] of found) {
    if (!ALLOWED_INTERPOLATIONS.has(expr)) {
      offenders.push(`  ${JSON.stringify(expr)}  in ${[...where].sort().join(", ")}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    "New/unreviewed `${…}` interpolation(s) inside SQL — if any can carry a request " +
      "value it is SQL injection; bind it as `?` instead. Only prove-safe identifiers " +
      "belong on ALLOWED_INTERPOLATIONS:\n" + offenders.join("\n"),
  );

  // The allowlist is a canary: keep it tight so an entry going unused (its call
  // site removed) is noticed rather than masking the next real change.
  const unused = [...ALLOWED_INTERPOLATIONS].filter((e) => !found.has(e));
  assert.equal(unused.length, 0, "Allowlisted interpolation(s) no longer present — prune them: " + unused.join(", "));
});

// Guard the guard: the scanner itself must recognise SQL literals and skip
// regex/comment/string backticks (a real regression that hid src/server-errors.js
// interpolations during development).
test("scanner recognises SQL literals and is not desynced by regex literals", () => {
  const sample = [
    'const re = /["\'`][^"\'`]*["\'`]/g;', // stray backticks inside a regex
    "// a `backtick` in a comment",
    'const s = "a `backtick` in a string";',
    "db.prepare(`UPDATE t SET ${cols} WHERE id = ?`).bind(v, id);",
    "const q = `SELECT * FROM ${table}`;",
    "const prose = `just some ${notSql} text without keywords`;",
  ].join("\n");
  const got = extractSqlInterpolations(sample).map(norm).sort();
  assert.deepEqual(got, ["cols", "table"]);
});
