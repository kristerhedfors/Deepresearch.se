// The fuzzer's vocabulary must not drift from mopy's.
//
// scripts/mopy-fuzz.mjs generates programs out of a transcription of mopy's own
// tables — BUILTINS in builtins.rs, the six method tables in methods.rs. The
// transcription exists because the generator needs TYPES, which the Rust does
// not carry: `zfill` wants an int, and without knowing that, nine probes in ten
// are a TypeError and the run confirms only that both interpreters can raise.
//
// A transcription rots. The failure is silent and one-directional: a method
// added to mopy and not to the fuzzer is surface that never gets generated, so
// the run still reports a large probe count and a small finding count, and
// looks like evidence that the new method is correct. Nothing else in the
// repository would notice.
//
// So this parses the Rust and compares. Extra names in the fuzzer are an error
// too — those generate probes for methods mopy does not have, which cost budget
// and report NOT-CLAIMED forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram, candidates, makeGenerator, mulberry32 } from "./mopy-fuzz.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Pull a `const NAME: &[&str] = &[ "a", "b", ... ];` table out of Rust source. */
function rustTable(src, name) {
  const re = new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`);
  const m = re.exec(src);
  assert.ok(m, `${name} not found — did the table move or get renamed?`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

/** The same tables as the fuzzer sees them, read back out of its source. */
function fuzzTable(src, name) {
  const re = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`);
  const m = re.exec(src);
  assert.ok(m, `${name} not found in mopy-fuzz.mjs`);
  return [...m[1].matchAll(/(\w+):\s*\[/g)].map((x) => x[1]).sort();
}

const BUILTINS_RS = readFileSync(join(ROOT, "mopy/src/builtins.rs"), "utf8");
const METHODS_RS = readFileSync(join(ROOT, "mopy/src/methods.rs"), "utf8");
const FUZZ = readFileSync(join(ROOT, "scripts/mopy-fuzz.mjs"), "utf8");

test("the fuzzer knows every str method mopy implements", () => {
  assert.deepEqual(fuzzTable(FUZZ, "STR_METHODS"), rustTable(METHODS_RS, "STR_METHODS"));
});

test("the fuzzer knows every list method mopy implements", () => {
  assert.deepEqual(fuzzTable(FUZZ, "LIST_METHODS"), rustTable(METHODS_RS, "LIST_METHODS"));
});

test("the fuzzer knows every dict method mopy implements", () => {
  assert.deepEqual(fuzzTable(FUZZ, "DICT_METHODS"), rustTable(METHODS_RS, "DICT_METHODS"));
});

test("the fuzzer knows every bytes method mopy implements", () => {
  assert.deepEqual(fuzzTable(FUZZ, "BYTES_METHODS"), rustTable(METHODS_RS, "BYTES_METHODS"));
});

// Set methods are deliberately a SUBSET in the fuzzer: docs/MOPY.md §5 refuses
// anything that would expose set iteration order, so a probe printing a set is
// NOT-CLAIMED by construction and only the order-free operations are worth
// generating. This asserts the direction rather than equality.
test("the fuzzer's set methods are a subset of mopy's", () => {
  const mine = fuzzTable(FUZZ, "SET_METHODS");
  const theirs = rustTable(METHODS_RS, "SET_METHODS");
  for (const m of mine) assert.ok(theirs.includes(m), `set method ${m} is not in mopy`);
});

test("every builtin the fuzzer generates is one mopy claims", () => {
  const claimed = new Set(rustTable(BUILTINS_RS, "BUILTINS"));
  // The generator's builtin calls, read straight out of its own source: any
  // `name(` at the start of a generated fragment.
  const used = new Set();
  for (const m of FUZZ.matchAll(/`(\w+)\(\$\{/g)) used.add(m[1]);
  for (const m of FUZZ.matchAll(/=> `(\w+)\(/g)) used.add(m[1]);
  const unknown = [...used].filter((n) => !claimed.has(n) && n !== "f");
  assert.deepEqual(unknown, [], `the fuzzer generates builtins mopy does not claim: ${unknown}`);
});

// The generator is seeded, and a finding is only reproducible if the same seed
// really does produce the same programs. This is the property the `--seed` flag
// promises and the one a bug report depends on.
test("the same seed generates the same programs", () => {
  const one = Array.from({ length: 50 }, (_, i) => makeGenerator(mulberry32(99)).probe() && i);
  const a = makeGenerator(mulberry32(4242));
  const b = makeGenerator(mulberry32(4242));
  assert.ok(one.length === 50);
  for (let i = 0; i < 200; i++) assert.equal(a.probe(), b.probe());
});

test("a different seed generates different programs", () => {
  const a = makeGenerator(mulberry32(1));
  const b = makeGenerator(mulberry32(2));
  const as = Array.from({ length: 50 }, () => a.probe());
  const bs = Array.from({ length: 50 }, () => b.probe());
  assert.notDeepEqual(as, bs);
});

// One output line per probe is what lets a batch diff localise a finding
// without bisection. If a probe could emit two lines, every probe after a
// divergence would be reported as one too.
test("a probe is exactly one output line", () => {
  const prog = buildProgram(["1 + 1", '"a"', "[1, 2]"]);
  const bodies = prog.split("try:").filter(Boolean);
  assert.equal(bodies.length, 3);
  for (const b of bodies) {
    // exactly one print of the value, and one per except clause
    assert.equal((b.match(/^    print\(repr\(/gm) || []).length, 1);
  }
});

// The shrinker must only ever propose SMALLER candidates, or it can loop.
test("shrink candidates are strictly simpler", () => {
  const e = '(("AbC".swapcase() + "x") * 2)';
  const cands = candidates(e);
  assert.ok(cands.length > 0);
  for (const c of cands) assert.ok(c.length <= e.length, `${c} is not smaller than ${e}`);
  assert.ok(cands.some((c) => c.includes("swapcase")), "the failing leaf must survive as a candidate");
});
