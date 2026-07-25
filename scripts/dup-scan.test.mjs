// Unit tests for the refactor survey's duplicate scanner (scripts/dup-scan.mjs).
// The scan is advisory, but its two failure modes are not equally cheap: a MISS
// costs a pass a candidate, while a FALSE GROUP costs a session arguing about a
// cut that isn't verbatim. These pin the second one hard — bodies only group
// when their normalized text is identical, identifiers included.
import test from "node:test";
import assert from "node:assert/strict";
import { extractFunctions, normalizeBody, groupDuplicates, nameCollisions, matchBrace } from "./dup-scan.mjs";

test("extractFunctions: finds declarations, arrows, and exported forms", () => {
  const src = [
    "function alpha(a) {",
    "  return a + 1;",
    "}",
    "export const beta = (b) => {",
    "  return b * 2;",
    "};",
    "export async function gamma() {",
    "  await x();",
    "}",
  ].join("\n");
  const names = extractFunctions(src, "f.js").map((f) => f.name);
  assert.deepEqual(names, ["alpha", "beta", "gamma"]);
});

test("extractFunctions: a brace inside a string or comment does not end the body", () => {
  const src = ['function a() {', '  const s = "} not the end {";', "  // } neither is this", "  return s;", "}", "const after = 1;"].join(
    "\n",
  );
  const [fn] = extractFunctions(src, "f.js");
  assert.equal(fn.name, "a");
  assert.match(fn.body, /return s;/);
  assert.doesNotMatch(fn.body, /const after/);
});

test("matchBrace: a regex literal containing a brace does not unbalance the scan", () => {
  const src = "{ const re = /\\{[a-z]+\\}/g; }";
  assert.equal(matchBrace(src, 0), src.length);
});

test("matchBrace: template literals with ${} interpolation nest correctly", () => {
  const src = "{ const t = `a ${ { k: 1 }.k } b`; }";
  assert.equal(matchBrace(src, 0), src.length);
});

test("normalizeBody: comments and whitespace are ignored, identifiers are not", () => {
  const a = normalizeBody("{\n  // a comment\n  return x + 1;\n}");
  const b = normalizeBody("{ return x + 1; /* other comment */ }");
  const c = normalizeBody("{ return y + 1; }");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("groupDuplicates: same body in two files groups; same body twice in ONE file does not", () => {
  const body = ["{", "  const m = { a: 1 };", "  const n = m.a + 2;", "  return n;", "}"].join("\n");
  const fns = [
    { path: "src/one.js", name: "f", line: 1, lines: 5, body },
    { path: "src/two.js", name: "g", line: 9, lines: 5, body },
    { path: "src/one.js", name: "h", line: 20, lines: 5, body },
  ];
  const groups = groupDuplicates(fns, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].names].sort(), ["f", "g", "h"]);

  const oneFileOnly = groupDuplicates([fns[0], fns[2]], 4);
  assert.equal(oneFileOnly.length, 0);
});

test("groupDuplicates: bodies differing only in a free variable do NOT group", () => {
  // The verbatim gate in code form: near-copies bound to different module-local
  // constants (the spinner finale trap) must never look like a de-dup candidate.
  const mk = (constant) => ["{", `  const t = ${constant} * 2;`, "  const u = t + 1;", "  return u;", "}"].join("\n");
  const groups = groupDuplicates(
    [
      { path: "a.js", name: "f", line: 1, lines: 5, body: mk("MARKS") },
      { path: "b.js", name: "f", line: 1, lines: 5, body: mk("FLEET") },
    ],
    4,
  );
  assert.equal(groups.length, 0);
});

test("groupDuplicates: bodies below the line bar are skipped", () => {
  const body = "{\n  return 1;\n}";
  const fns = [
    { path: "a.js", name: "f", line: 1, lines: 3, body },
    { path: "b.js", name: "f", line: 1, lines: 3, body },
  ];
  assert.equal(groupDuplicates(fns, 4).length, 0);
});

test("nameCollisions: same name + different bodies across files is reported", () => {
  const fns = [
    { path: "a.js", name: "normalizeStatus", line: 1, lines: 5, body: "{\n  const a = 1;\n  const b = 2;\n  return a;\n}" },
    { path: "b.js", name: "normalizeStatus", line: 1, lines: 5, body: "{\n  const a = 1;\n  const b = 2;\n  return b;\n}" },
    { path: "c.js", name: "same", line: 1, lines: 5, body: "{\n  const a = 1;\n  const b = 2;\n  return a;\n}" },
    { path: "d.js", name: "same", line: 1, lines: 5, body: "{\n  const a = 1;\n  const b = 2;\n  return a;\n}" },
  ];
  const collisions = nameCollisions(fns, 4);
  assert.deepEqual(
    collisions.map((c) => c.name),
    ["normalizeStatus"],
  );
});
