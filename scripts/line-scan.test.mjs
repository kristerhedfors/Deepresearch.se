// Unit tests for the refactor survey's line-run scanner (scripts/line-scan.mjs),
// the sibling of scripts/dup-scan.test.mjs. The scan is advisory, so what has to
// hold is that it cannot INVENT a match and cannot bury a real one: identical
// runs group, near-identical ones do not, a run inside one file alone is not a
// finding, and one shared stretch reports once rather than once per window.

import { test } from "node:test";
import assert from "node:assert/strict";

import { groupLineRuns, significantLines } from "./line-scan.mjs";

const lines = (text) => significantLines(text);
const file = (path, text) => ({ path, lines: lines(text) });

test("significantLines drops blanks, comments and pure closers, keeping line numbers", () => {
  const out = significantLines(["const a = 1;", "", "// a comment", "  }", "b();  // trailing"].join("\n"));
  assert.deepEqual(out, [
    { s: "const a = 1;", line: 1 },
    { s: "b();", line: 5 },
  ]);
});

test("significantLines drops a whole JSDoc block, so a drifted doc comment still matches", () => {
  const body = ["/**", " * docs", " */", "function f() {", "  return 1;"].join("\n");
  assert.deepEqual(significantLines(body).map((x) => x.s), ["function f() {", "return 1;"]);
});

test("an identical run in two files groups, and reports both sites", () => {
  const text = ["a();", "b();", "c();", "d();"].join("\n");
  const groups = groupLineRuns([file("src/one.js", text), file("src/two.js", "x();\n" + text)], 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sites, [
    { path: "src/one.js", line: 1 },
    { path: "src/two.js", line: 2 },
  ]);
  assert.deepEqual(groups[0].text, ["a();", "b();", "c();", "d();"]);
});

test("a run repeated inside ONE file only is not a finding", () => {
  const text = ["a();", "b();", "c();", "d();"].join("\n");
  assert.deepEqual(groupLineRuns([file("src/one.js", text + "\ne();\n" + text)], 4), []);
});

test("one line differing breaks the run — the scan cannot invent a match", () => {
  const a = ["a();", "b();", "c();", "d();"].join("\n");
  const b = ["a();", "b();", "C();", "d();"].join("\n");
  assert.deepEqual(groupLineRuns([file("src/one.js", a), file("src/two.js", b)], 4), []);
});

test("runs shorter than the bar are skipped", () => {
  const text = ["a();", "b();", "c();"].join("\n");
  assert.deepEqual(groupLineRuns([file("src/one.js", text), file("src/two.js", text)], 4), []);
});

test("one shared stretch reports ONCE, not once per sliding window", () => {
  const text = ["a();", "b();", "c();", "d();", "e();", "f();"].join("\n");
  const groups = groupLineRuns([file("src/one.js", text), file("src/two.js", text)], 4);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text[0], "a();");
});

test("two shared stretches separated by differing code both report", () => {
  const shared = (mid) => ["a();", "b();", "c();", "d();", ...mid, "p();", "q();", "r();", "s();"].join("\n");
  const groups = groupLineRuns(
    [file("src/one.js", shared(["one();", "one();", "one();"])), file("src/two.js", shared(["two();", "two();", "two();"]))],
    4,
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.text[0]), ["a();", "p();"]);
});

test("comments differing between two copies do not stop them grouping", () => {
  const a = ["a();", "// why we do this here", "b();", "c();", "d();"].join("\n");
  const b = ["a();", "// a completely different note", "b();", "c();", "d();"].join("\n");
  assert.equal(groupLineRuns([file("src/one.js", a), file("src/two.js", b)], 4).length, 1);
});
