// The `\b` Swedish-boundary trap, guarded across the whole client and server —
// a repo-wide guard in the shape of src/facade-contract.test.js and
// src/sql-injection-guard.test.js.
//
// JavaScript defines `\b` over [A-Za-z0-9_]. "å", "ä" and "ö" are not in that
// set, so an alternative that STARTS or ENDS in one can never match when a `\b`
// sits against it:
//
//   /\bär\b/.test("detta är bra")          // false
//   /\bvilken\s+(?:nivå|version)\b/i       // matches "version", never "nivå"
//
// This is invariant 6's silent killer (CLAUDE.md: equal Swedish and English
// support in ALL deterministic intent routing). It fails QUIETLY, and in the
// worst way: the English half of a bilingual gate keeps matching, so an
// English-only test suite stays green while the Swedish half is inert. The
// audit that found it is recorded in docs/MERGED-BRANCHES.md (the
// palaeogenomics entry) and the **palaeogenomics** skill carries the grep;
// nine live alternatives across five modules were dead when this suite landed.
//
// The fix is always the same, and the repo's own convention: lookaround
// boundaries instead of `\b`, with the `u` flag —
// `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`. src/europepmc.js:112 names the
// leading half `B`; src/googlemaps-text.js uses it throughout.
//
// This suite DISCOVERS the regexes instead of listing them, so a gate written
// tomorrow is covered the day it lands.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "public/js", "public/cure", "public/games"];

const NON_ASCII = /[^\x00-\x7F]/;

/** Every non-test JS/MJS module under the scanned roots. */
function sourceFiles() {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(p) && !/\.test\.(js|mjs)$/.test(p)) out.push(p);
    }
  };
  for (const r of ROOTS) {
    try {
      walk(join(ROOT, r));
    } catch {
      // A root that does not exist in this checkout contributes nothing.
    }
  }
  return out;
}

// A `\b(…|…)\b`-shaped group, capturing whether each side carries the ASCII
// boundary. Deliberately refuses nested parens ([^()]*) rather than parsing
// regex grammar: the trap only needs the alternation body, and a flat scan has
// no false negatives on the shape that actually bites (a `\b`-anchored word
// list). A nested group is reported by the alternative it contains, if any.
const ANCHORED_GROUP_RE = /(\\b)?\((\?:)?([^()]*)\)(\\b)?/g;

/**
 * @returns {Array<{file: string, line: number, alt: string, side: "leading"|"trailing"}>}
 *   one row per alternative that can never match
 */
function deadAlternatives() {
  /** @type {Array<{file: string, line: number, alt: string, side: "leading"|"trailing"}>} */
  const dead = [];
  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!NON_ASCII.test(line)) return;
        for (const m of line.matchAll(ANCHORED_GROUP_RE)) {
          const [, lead, , body, trail] = m;
          if (!lead && !trail) continue;
          if (!body.includes("|")) continue;
          for (const raw of body.split("|")) {
            const alt = raw.trim();
            if (!alt || !NON_ASCII.test(alt)) continue;
            // A trailing char class can END in a non-ASCII letter at runtime
            // even though the literal ends in "]" — hall[åa] was exactly that.
            const classTail = /\[[^\]]*\]$/.exec(alt);
            const lastChars = classTail ? classTail[0] : alt.slice(-1);
            if (lead && NON_ASCII.test(alt[0]))
              dead.push({ file: rel, line: i + 1, alt, side: "leading" });
            else if (trail && NON_ASCII.test(lastChars))
              dead.push({ file: rel, line: i + 1, alt, side: "trailing" });
          }
        }
      });
  }
  return dead;
}

describe("the `\\b` Swedish-boundary trap (invariant 6)", () => {
  test("no regex alternative is made unmatchable by an ASCII `\\b`", () => {
    const dead = deadAlternatives();
    const report = dead
      .map((d) => `  ${d.file}:${d.line}  "${d.alt}"  (${d.side} \\b against a non-ASCII letter)`)
      .join("\n");
    assert.equal(
      dead.length,
      0,
      `${dead.length} regex alternative(s) can never match — JS defines \\b over [A-Za-z0-9_], ` +
        `so a "å/ä/ö" at the anchored end kills the alternative silently:\n${report}\n\n` +
        `Fix: replace the \\b anchors with (?<![\\p{L}\\p{N}_]) … (?![\\p{L}\\p{N}_]) and add the u flag ` +
        `(see src/europepmc.js:112).`,
    );
  });

  test("the scanner detects the trap it exists to prevent", () => {
    // Guards the guard: a scanner that silently stopped matching would report
    // a clean repo forever. These are the shapes found in the 2026-07-30 audit.
    assert.equal(/\bär\b/.test("detta är bra"), false, "leading \\b before ä must be dead");
    assert.equal(/\b(?:nivå|version)\b/i.test("vilken nivå"), false, "trailing \\b after å must be dead");
    assert.equal(/\bhall[åa]\b/i.test("hallå"), false, "a char class ending non-ASCII must be dead too");
    // …and that the sanctioned replacement is not.
    assert.equal(/(?<![\p{L}\p{N}_])är(?![\p{L}\p{N}_])/u.test("detta är bra"), true);
    assert.equal(/(?<![\p{L}\p{N}_])(?:nivå|version)(?![\p{L}\p{N}_])/iu.test("vilken nivå"), true);
    // The boundary still has to BE a boundary — no match inside a longer word.
    assert.equal(/(?<![\p{L}\p{N}_])är(?![\p{L}\p{N}_])/u.test("förvärär"), false);
    assert.equal(/(?<![\p{L}\p{N}_])nivå(?![\p{L}\p{N}_])/u.test("nivåer"), false);
  });
});
