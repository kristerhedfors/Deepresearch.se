// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { S, validate, hardenJson } from "./schema.js";

test("primitives validate and coerce fallbacks without throwing", () => {
  assert.deepEqual(validate(S.string(), "x"), { ok: true, value: "x", errors: [] });
  assert.equal(validate(S.string(), 5).ok, false);
  assert.equal(validate(S.number(), NaN).ok, false);
  assert.equal(validate(S.boolean(), "true").ok, false);
});

test("stringEnum falls back to first allowed", () => {
  const r = validate(S.stringEnum(["a", "b"]), "z");
  assert.equal(r.ok, false);
  assert.equal(r.value, "a");
});

test("object + arrayOf compose and never throw on junk", () => {
  const schema = S.object({ mode: S.stringEnum(["direct", "research"]), queries: S.arrayOf(S.string()) });
  assert.equal(validate(schema, null).ok, false);
  assert.equal(validate(schema, { mode: "research", queries: ["a", 3] }).ok, false);
  assert.equal(validate(schema, { mode: "research", queries: ["a", "b"] }).ok, true);
});

test("hardenJson passes clean values, falls through on junk", () => {
  const schema = S.object({ mode: S.stringEnum(["direct", "research"]), queries: S.arrayOf(S.string()) });
  const clean = { mode: "direct", queries: [] };
  assert.deepEqual(hardenJson(schema, clean), clean);
  const junk = { mode: "banana", queries: "nope" };
  assert.deepEqual(hardenJson(schema, junk), junk, "a miss returns the original for the normalizer to handle");
});
