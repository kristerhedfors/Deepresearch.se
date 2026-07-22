// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeParseJson } from "./berget.js";

test("parses clean JSON", () => {
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
});

test("strips code fences", () => {
  assert.deepEqual(safeParseJson('```json\n{"a":1}\n```'), { a: 1 });
});

test("salvages a wrapped object from chatty output", () => {
  assert.deepEqual(safeParseJson('Sure! Here you go: {"mode":"direct","queries":[]} — hope that helps'), {
    mode: "direct",
    queries: [],
  });
});

test("returns null on unsalvageable junk", () => {
  assert.equal(safeParseJson("not json at all"), null);
});
