// Unit tests for the research-notes representation (src/notes.js): note
// normalization/extraction, cross-wave merging, and the bounded digest.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeNote, extractNotes, mergeNotes, notesEntities, notesDigest } from "./notes.js";

describe("normalizeNote", () => {
  test("canonicalizes a well-formed note", () => {
    const n = normalizeNote({
      claim: "  EVs hit 90% share  ",
      source_ids: [1, 2],
      entities: ["Norway"],
    });
    assert.deepEqual(n, { claim: "EVs hit 90% share", source_ids: [1, 2], entities: ["Norway"] });
  });
  test("returns null without a usable claim", () => {
    assert.equal(normalizeNote({ claim: "   ", source_ids: [1] }), null);
    assert.equal(normalizeNote({ source_ids: [1] }), null);
    assert.equal(normalizeNote(null), null);
    assert.equal(normalizeNote("nope"), null);
    assert.equal(normalizeNote([1, 2]), null);
  });
  test("coerces numeric-string source ids and drops junk / <1 / duplicates", () => {
    const n = normalizeNote({ claim: "x", source_ids: ["3", 3, 0, -1, "abc", 2.9] });
    assert.deepEqual(n.source_ids, [3, 2]); // "3"/3 dedup, 0/-1/abc dropped, 2.9→2
  });
  test("dedupes entities case-insensitively and drops blanks/non-strings", () => {
    const n = normalizeNote({ claim: "x", entities: ["Tesla", "tesla", "", 5, "  BYD "] });
    assert.deepEqual(n.entities, ["Tesla", "BYD"]);
  });
  test("carries contradicts only when present", () => {
    assert.equal("contradicts" in normalizeNote({ claim: "x" }), false);
    assert.deepEqual(normalizeNote({ claim: "x", contradicts: ["S4"] }).contradicts, ["S4"]);
  });
});

describe("extractNotes", () => {
  test("reads a {notes:[...]} envelope, dropping invalid notes", () => {
    const out = extractNotes({ notes: [{ claim: "a" }, { claim: "" }, null, { claim: "b", source_ids: [1] }] });
    assert.deepEqual(out.map((n) => n.claim), ["a", "b"]);
  });
  test("accepts a bare array too", () => {
    assert.deepEqual(extractNotes([{ claim: "z" }]).map((n) => n.claim), ["z"]);
  });
  test("anything else yields an empty list, never throws", () => {
    assert.deepEqual(extractNotes(null), []);
    assert.deepEqual(extractNotes("garbage"), []);
    assert.deepEqual(extractNotes({ foo: 1 }), []);
  });
});

describe("mergeNotes", () => {
  test("dedupes by claim and unions source ids / entities", () => {
    const existing = [{ claim: "Battery prices fell", source_ids: [1], entities: ["CATL"] }];
    const incoming = [
      { claim: "battery prices fell", source_ids: [2, 1], entities: ["BYD"] }, // same claim, different case
      { claim: "New gigafactory opened", source_ids: [3], entities: [] },
    ];
    const merged = mergeNotes(existing, incoming);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], { claim: "Battery prices fell", source_ids: [1, 2], entities: ["CATL", "BYD"] });
    assert.equal(merged[1].claim, "New gigafactory opened");
  });
  test("does not mutate or share references with the inputs", () => {
    const existing = [{ claim: "a", source_ids: [1], entities: ["X"] }];
    const merged = mergeNotes(existing, [{ claim: "a", source_ids: [2], entities: ["Y"] }]);
    assert.deepEqual(existing[0].source_ids, [1], "input left untouched");
    assert.notEqual(merged[0].source_ids, existing[0].source_ids);
  });
  test("merges contradicts across duplicates", () => {
    const merged = mergeNotes(
      [{ claim: "a", contradicts: ["S1"] }],
      [{ claim: "a", contradicts: ["S2", "s1"] }],
    );
    assert.deepEqual(merged[0].contradicts, ["S1", "S2"]);
  });
  test("handles empty / missing inputs", () => {
    assert.deepEqual(mergeNotes(undefined, undefined), []);
    assert.deepEqual(mergeNotes([], [{ claim: "solo" }]).map((n) => n.claim), ["solo"]);
  });
});

describe("notesEntities", () => {
  test("unions entities across notes, case-insensitively deduped", () => {
    const ents = notesEntities([
      { claim: "a", entities: ["Norway", "EU"] },
      { claim: "b", entities: ["norway", "China"] },
    ]);
    assert.deepEqual(ents, ["Norway", "EU", "China"]);
  });
  test("empty for no notes", () => {
    assert.deepEqual(notesEntities([]), []);
    assert.deepEqual(notesEntities(undefined), []);
  });
});

describe("notesDigest", () => {
  test("renders claims with cited sources, entities, and contradictions", () => {
    const text = notesDigest([
      { claim: "EVs at 90%", source_ids: [1, 3], entities: ["Norway"] },
      { claim: "Prices up", source_ids: [2], entities: [], contradicts: ["S1"] },
    ]);
    assert.match(text, /- EVs at 90% \[S1, S3\] \(entities: Norway\)/);
    assert.match(text, /- Prices up \[S2\] \(contradicts: S1\)/);
  });
  test("stops at the character cap", () => {
    const notes = Array.from({ length: 50 }, (_, i) => ({ claim: "claim " + i, source_ids: [i + 1], entities: [] }));
    const text = notesDigest(notes, 40);
    assert.ok(text.length <= 40 + 20); // roughly capped; not all 50 rendered
    assert.ok(text.split("\n").length < 50);
  });
  test("empty for no notes", () => {
    assert.equal(notesDigest([]), "");
    assert.equal(notesDigest(undefined), "");
  });
});
