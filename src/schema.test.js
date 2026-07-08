import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { string, boolean, number, stringEnum, arrayOf, object, oneOf, validate } from "./schema.js";

describe("string", () => {
  test("accepts and trims a string", () => {
    assert.deepEqual(validate(string(), "  hi  "), { ok: true, value: "hi", errors: [] });
  });
  test("rejects a non-string by default", () => {
    assert.equal(validate(string(), 42).ok, false);
  });
  test("allowEmpty:false rejects the empty (or whitespace) string", () => {
    assert.equal(validate(string({ allowEmpty: false }), "   ").ok, false);
    assert.equal(validate(string({ allowEmpty: false }), "x").ok, true);
  });
  test("coerce:true turns numbers/booleans/null into their String() form", () => {
    assert.equal(validate(string({ coerce: true }), 42).value, "42");
    assert.equal(validate(string({ coerce: true }), true).value, "true");
    assert.equal(validate(string({ coerce: true }), null).value, "null");
  });
});

describe("boolean", () => {
  test("accepts real booleans", () => {
    assert.deepEqual(validate(boolean(), false), { ok: true, value: false, errors: [] });
  });
  test('coerces "true"/"false" strings', () => {
    assert.equal(validate(boolean(), "true").value, true);
    assert.equal(validate(boolean(), "false").value, false);
  });
  test("rejects other values", () => {
    assert.equal(validate(boolean(), "yes").ok, false);
    assert.equal(validate(boolean(), 1).ok, false);
  });
});

describe("number", () => {
  test("accepts finite numbers and numeric strings", () => {
    assert.equal(validate(number(), 3.5).value, 3.5);
    assert.equal(validate(number(), "7").value, 7);
  });
  test("rejects NaN/Infinity/non-numeric", () => {
    assert.equal(validate(number(), NaN).ok, false);
    assert.equal(validate(number(), Infinity).ok, false);
    assert.equal(validate(number(), "abc").ok, false);
  });
});

describe("stringEnum", () => {
  test("accepts a listed value", () => {
    assert.equal(validate(stringEnum(["a", "b"]), "b").value, "b");
  });
  test("trims a whitespace-padded match", () => {
    assert.equal(validate(stringEnum(["pass", "revise"]), " pass ").value, "pass");
  });
  test("rejects an unlisted value", () => {
    assert.equal(validate(stringEnum(["a"]), "z").ok, false);
  });
});

describe("arrayOf", () => {
  test("keeps valid items, drops invalid ones (lenient)", () => {
    const r = validate(arrayOf(string({ allowEmpty: false })), ["a", "", 42, "  b  ", null]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ["a", "b"]);
  });
  test("a non-array fails", () => {
    assert.equal(validate(arrayOf(string()), "not an array").ok, false);
  });
  test("an empty array is valid and stays empty", () => {
    assert.deepEqual(validate(arrayOf(string()), []).value, []);
  });
});

describe("object", () => {
  test("drops unknown keys, keeps declared ones", () => {
    const s = object({ a: string() });
    const r = validate(s, { a: "x", extra: 99 });
    assert.deepEqual(r.value, { a: "x" });
  });
  test("a missing required key fails", () => {
    assert.equal(validate(object({ a: string() }), {}).ok, false);
  });
  test("an optional key may be absent", () => {
    const s = object({ a: string(), b: string() }, { optional: ["b"] });
    assert.deepEqual(validate(s, { a: "x" }).value, { a: "x" });
  });
  test("an optional-but-invalid key is dropped without failing the object", () => {
    const s = object({ a: string(), b: arrayOf(string()) }, { optional: ["b"] });
    const r = validate(s, { a: "x", b: "not an array" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: "x" });
  });
  test("a null value counts as absent (required → fail, optional → dropped)", () => {
    assert.equal(validate(object({ a: string() }), { a: null }).ok, false);
    assert.deepEqual(validate(object({ a: string() }, { optional: ["a"] }), { a: null }).value, {});
  });
  test("a non-object fails", () => {
    assert.equal(validate(object({ a: string() }), [1, 2]).ok, false);
    assert.equal(validate(object({ a: string() }), "str").ok, false);
  });
});

describe("oneOf", () => {
  const triage = oneOf([
    object({ action: stringEnum(["direct"]) }),
    object({ action: stringEnum(["clarify"]), question: string({ allowEmpty: false }) }),
    object({ action: stringEnum(["research"]), queries: arrayOf(string({ allowEmpty: false })) }, { optional: ["queries"] }),
  ]);

  test("matches the correct variant and normalizes it", () => {
    assert.deepEqual(validate(triage, { action: "direct", junk: 1 }).value, { action: "direct" });
    assert.deepEqual(validate(triage, { action: "clarify", question: " which region? " }).value, {
      action: "clarify",
      question: "which region?",
    });
    assert.deepEqual(validate(triage, { action: "research", queries: ["a", "", 3, "b"] }).value, {
      action: "research",
      queries: ["a", "b"],
    });
  });

  test("fails when no variant matches", () => {
    const r = validate(triage, { action: "clarify" }); // clarify needs a question
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });
});

describe("validate — never throws", () => {
  test("an invalid schema returns ok:false, not a throw", () => {
    assert.equal(validate(null, {}).ok, false);
    assert.equal(validate({}, {}).ok, false);
  });
  test("a schema whose _run throws is caught and reported", () => {
    const boom = { _run: () => { throw new Error("boom"); } };
    const r = validate(boom, {});
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /boom/);
  });
  test("undefined / weird inputs never throw", () => {
    assert.doesNotThrow(() => validate(string(), undefined));
    assert.doesNotThrow(() => validate(arrayOf(number()), undefined));
    assert.doesNotThrow(() => validate(object({ a: string() }), undefined));
  });
});
