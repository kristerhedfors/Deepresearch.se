// Unit tests for the pygram conformance runner — everything in
// tests/pygram/conformance.mjs that is a function of its arguments: corpus
// parsing and dedup, the three-way verdict, the build-order plan, and the tag
// coverage roll-up.
//
// The runner itself shells out to two interpreters, so nothing here runs
// pygram (it does not exist yet) or CPython. That is deliberate: this file is
// run by the ROOT `npm test` on any checkout, including one where the pygram
// binary has never been built.
//
// What these tests are actually protecting is the DISTINCTION between the three
// verdicts (docs/PYGRAM.md §6). UNSUPPORTED means "we have not built this yet"
// and is fine; MISMATCH means "pygram disagrees with Python" and is the one
// outcome that would make a subset runtime a liability. Anything that let the
// second be reported as the first would hide exactly the bug we care about.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UNSUPPORTED_EXIT,
  buildPlan,
  classify,
  firstDiff,
  isNondeterministic,
  loadCorpus,
  normalizeProgram,
  parseJsonl,
  tagCoverage,
} from "./pygram/conformance.mjs";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (over = {}) => ({ stdout: "", stderr: "", code: 0, ms: 1, ...over });

test("the unsupported exit code stays clear of every code that already means something", () => {
  // 0/1/2 are python's own, 126/127 are the shell's, 128+n are signals. If this
  // ever collides, a caller can no longer tell "pygram is too small" from
  // "your program is wrong" — which is the entire purpose of the code.
  assert.equal(UNSUPPORTED_EXIT, 90);
  for (const taken of [0, 1, 2, 126, 127, 128, 130, 137, 143]) {
    assert.notEqual(UNSUPPORTED_EXIT, taken);
  }
});

test("parseJsonl skips blank lines and names the line number on bad JSON", () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parseJsonl('{"a":1}\nnot json\n', "corpus.jsonl"), /corpus\.jsonl:2:/);
});

test("normalizeProgram only trims edges and trailing semicolons", () => {
  assert.equal(normalizeProgram("  print(1)  "), "print(1)");
  assert.equal(normalizeProgram("print(1);"), "print(1)");
  assert.equal(normalizeProgram("print(1)\r\n"), "print(1)");
  // Two programs that differ in ways pygram must handle differently stay
  // distinct — a cleverer normalizer would merge them and hide a gap.
  assert.notEqual(normalizeProgram("print(1)"), normalizeProgram("print( 1 )"));
  assert.notEqual(normalizeProgram("a=1\nb=2"), normalizeProgram("a=1;b=2"));
});

test("loadCorpus merges the two files and lets an observed entry win over a written one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pygram-corpus-"));
  const seed = join(dir, "seed-corpus.jsonl");
  const harvested = join(dir, "corpus.jsonl");
  writeFileSync(seed, [
    JSON.stringify({ id: "s1", program: "print(1)", tags: ["print"] }),
    JSON.stringify({ id: "s2", program: "import json", tags: ["json"] }),
    "",
  ].join("\n"));
  // The same program, later seen for real. It must not become a second entry,
  // and the merged entry must carry the stronger provenance.
  writeFileSync(harvested, JSON.stringify({ id: "h1", program: "  print(1);  " }) + "\n");

  const entries = loadCorpus([
    { path: seed, defaultProvenance: "experience" },
    { path: harvested, defaultProvenance: "observed" },
  ]);

  assert.equal(entries.length, 2, "the duplicate program must not be counted twice");
  const merged = entries.find((e) => e.id === "s1");
  assert.equal(merged.provenance, "observed", "an observed sighting outranks a written guess");
  assert.equal(merged.corroborated, true);
  assert.equal(entries.find((e) => e.id === "s2").provenance, "experience");
});

test("loadCorpus tolerates a missing file and drops entries with no program", () => {
  const dir = mkdtempSync(join(tmpdir(), "pygram-corpus-"));
  const seed = join(dir, "seed-corpus.jsonl");
  writeFileSync(seed, [
    JSON.stringify({ id: "a", program: "print(1)" }),
    JSON.stringify({ id: "b", program: "" }),
    JSON.stringify({ id: "c", note: "no program at all" }),
    "",
  ].join("\n"));
  const entries = loadCorpus([
    { path: seed, defaultProvenance: "experience" },
    { path: join(dir, "does-not-exist.jsonl"), defaultProvenance: "observed" },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ["a"]);
});

test("classify calls an exact agreement a MATCH", () => {
  const ref = ok({ stdout: "hello\n" });
  assert.equal(classify(ref, ok({ stdout: "hello\n" })).verdict, "MATCH");
});

test("classify reads the unsupported contract off stderr, not off the exit code alone", () => {
  const ref = ok({ stdout: "x\n" });
  const got = classify(ref, ok({ code: UNSUPPORTED_EXIT, stderr: "pygram: unsupported: module: subprocess\n" }));
  assert.equal(got.verdict, "UNSUPPORTED");
  assert.equal(got.kind, "module");
  assert.equal(got.detail, "subprocess");

  // Exit 90 with no contract line is a crash wearing a coverage badge. If this
  // were accepted, an interpreter that segfaulted its way to 90 would report
  // as a clean coverage gap forever.
  const bare = classify(ref, ok({ code: UNSUPPORTED_EXIT, stderr: "Segmentation fault\n" }));
  assert.equal(bare.verdict, "MISMATCH");
  assert.match(bare.why, /without a .*unsupported/);
});

test("classify catches the divergences that matter: stdout, exit code, and a swallowed error", () => {
  const ref = ok({ stdout: "1\n2\n3\n" });

  const wrongOut = classify(ref, ok({ stdout: "1\n9\n3\n" }));
  assert.equal(wrongOut.verdict, "MISMATCH");
  assert.match(wrongOut.diff, /line 2/);

  assert.equal(classify(ref, ok({ stdout: "1\n2\n3\n", code: 3 })).verdict, "MISMATCH");

  // A program that fails under CPython must fail under pygram. Silently
  // succeeding where Python raised is the worst divergence in the set: the
  // agent reads exit 0 and believes the work happened.
  const swallowed = classify(ok({ stderr: "Traceback…\nKeyError: 'k'\n", code: 1 }), ok({ code: 1 }));
  assert.equal(swallowed.verdict, "MISMATCH");
  assert.match(swallowed.why, /silent/);
});

test("classify does not demand byte-identical tracebacks", () => {
  // CPython's stderr carries file paths, line numbers and interpreter
  // internals. Requiring pygram to reproduce them would fail every error case
  // for no benefit — the exit code is what a pipeline and an agent consume.
  const ref = ok({ stdout: "", stderr: 'Traceback (most recent call last):\n  File "<string>", line 1\nKeyError: 1\n', code: 1 });
  const got = ok({ stdout: "", stderr: "pygram: KeyError: 1\n", code: 1 });
  assert.equal(classify(ref, got).verdict, "MATCH");
});

test("a wall-clock or seeded entry is compared on exit code, not stdout", () => {
  // `datetime.now()` and a seeded PRNG differ between two runs of the SAME
  // interpreter, so comparing stdout would fail them forever and bury the real
  // signal under permanent noise. The corpus tags them; we do not guess.
  assert.equal(isNondeterministic({ tags: ["datetime", "nondeterministic"] }), true);
  assert.equal(isNondeterministic({ tags: ["random", "seeded"] }), true);
  assert.equal(isNondeterministic({ tags: ["json"] }), false);
  assert.equal(isNondeterministic({}), false);

  const entry = { tags: ["nondeterministic"] };
  const ref = ok({ stdout: "2026-08-13T21:16:05.679036\n" });
  const got = ok({ stdout: "2026-08-13T21:16:05.696864\n" });
  const verdict = classify(ref, got, entry);
  assert.equal(verdict.verdict, "MATCH");
  assert.equal(verdict.stdoutUncompared, true, "the exemption must be visible in the result");

  // The exemption is narrow: it covers stdout only. A wrong exit code is still
  // a mismatch, or a program that crashed would pass as long as it was tagged.
  assert.equal(classify(ref, ok({ stdout: "x", code: 1 }), entry).verdict, "MISMATCH");
  // And the same stdout difference on an untagged entry is still caught.
  assert.equal(classify(ref, got, { tags: ["datetime"] }).verdict, "MISMATCH");
});

test("classify treats a timeout and a failed spawn as hard failures", () => {
  const ref = ok({ stdout: "x\n" });
  assert.equal(classify(ref, { stdout: "", stderr: "<timeout>", code: null, timedOut: true }).verdict, "MISMATCH");
  assert.equal(classify(ref, { stdout: "", stderr: "ENOENT", code: null, spawnFailed: true }).verdict, "MISMATCH");
});

test("buildPlan ranks missing features by how many entries they unblock", () => {
  const results = [
    { id: "a", verdict: "UNSUPPORTED", kind: "module", detail: "re" },
    { id: "b", verdict: "UNSUPPORTED", kind: "module", detail: "re" },
    { id: "c", verdict: "UNSUPPORTED", kind: "module", detail: "re" },
    { id: "d", verdict: "UNSUPPORTED", kind: "syntax", detail: "decorator" },
    { id: "e", verdict: "MATCH" },
    { id: "f", verdict: "MISMATCH" },
  ];
  const plan = buildPlan(results);
  assert.deepEqual(plan.map((p) => [p.feature, p.blocks]), [
    ["module: re", 3],
    ["syntax: decorator", 1],
  ]);
  assert.deepEqual(plan[0].ids, ["a", "b", "c"]);
});

test("buildPlan is empty when nothing is unsupported", () => {
  assert.deepEqual(buildPlan([{ id: "a", verdict: "MATCH" }, { id: "b", verdict: "MISMATCH" }]), []);
});

test("tagCoverage counts an entry once per tag and buckets untagged entries", () => {
  const cov = tagCoverage([
    { verdict: "MATCH", tags: ["json", "stdin"] },
    { verdict: "UNSUPPORTED", tags: ["json"] },
    { verdict: "MISMATCH", tags: ["json"] },
    { verdict: "MATCH", tags: [] },
  ]);
  const json = cov.find((c) => c.tag === "json");
  assert.deepEqual([json.total, json.match, json.unsupported, json.mismatch], [3, 1, 1, 1]);
  assert.equal(cov.find((c) => c.tag === "stdin").total, 1);
  assert.equal(cov.find((c) => c.tag === "<untagged>").match, 1);
  // Sorted by how much of the corpus a tag covers, so the biggest gap reads first.
  assert.equal(cov[0].tag, "json");
});

test("firstDiff points at the first differing line and clips long ones", () => {
  assert.match(firstDiff("a\nb\nc", "a\nX\nc"), /line 2: want "b", got "X"/);
  assert.match(firstDiff("a", "a\nb"), /line 2: want <no line>/);
  assert.match(firstDiff("x".repeat(200), "y".repeat(200)), /…/);
  assert.equal(firstDiff("a\n", "a\n"), "trailing whitespace only");
});
