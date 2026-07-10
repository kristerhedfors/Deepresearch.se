// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers search-sources.js: the SEARCH_SOURCES entry contract, the
// concatenated planner prompt notes, and platform diversity keying.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_SOURCES, platformDiversityKey, sourcePromptNotes } from "./search-sources.js";

// The registry is the parallel-work seam: every source integrates as data
// here, and the pipeline/prompts/sources modules only iterate. These tests
// pin the entry CONTRACT so a mis-shaped entry from any session fails fast
// in CI instead of silently never firing (or crashing a wave) in production.
describe("SEARCH_SOURCES registry contract", () => {
  test("every entry declares the required interface", () => {
    assert.ok(SEARCH_SOURCES.length >= 1);
    const ids = new Set();
    for (const s of SEARCH_SOURCES) {
      assert.match(s.id, /^[a-z][a-z0-9_-]*$/, `bad id: ${s.id}`);
      assert.ok(!ids.has(s.id), `duplicate id: ${s.id}`);
      ids.add(s.id);
      assert.equal(typeof s.intent, "function", `${s.id}: intent`);
      assert.equal(typeof s.search, "function", `${s.id}: search`);
      assert.equal(typeof s.service, "string", `${s.id}: service display name`);
      assert.ok(s.service.trim().length >= 2, `${s.id}: service must be a real display name`);
      if (s.dedupKey) assert.equal(typeof s.dedupKey, "function", `${s.id}: dedupKey`);
      if (s.maxPerRequest != null) assert.ok(Number.isInteger(s.maxPerRequest) && s.maxPerRequest >= 1, `${s.id}: maxPerRequest`);
      if (s.promptNote) {
        assert.equal(typeof s.promptNote, "string", `${s.id}: promptNote`);
        assert.match(s.promptNote, /^ /, `${s.id}: promptNote must start with a space (it is concatenated after other prompt rules)`);
      }
      // diversityHost and diversityKeyOf come as a pair.
      assert.equal(!!s.diversityHost, typeof s.diversityKeyOf === "function", `${s.id}: diversityHost/diversityKeyOf pair`);
    }
  });

  test("intent predicates are safe on junk input", () => {
    for (const s of SEARCH_SOURCES) {
      assert.equal(typeof s.intent(""), "boolean");
      assert.equal(typeof s.intent(null), "boolean");
    }
  });
});

describe("sourcePromptNotes", () => {
  test("concatenates every declared note (hf's referent note included)", () => {
    const notes = sourcePromptNotes();
    assert.match(notes, /"HF"\/"hf" in a user message means Hugging Face/);
  });
});

describe("platformDiversityKey", () => {
  test("returns the declared key for a claimed platform host", () => {
    assert.equal(
      platformDiversityKey("huggingface.co", "https://huggingface.co/KBLab/kb-whisper-large"),
      "huggingface.co/KBLab",
    );
  });

  test("returns null for unclaimed hosts (→ hostname keying)", () => {
    assert.equal(platformDiversityKey("bbc.com", "https://bbc.com/news"), null);
  });
});
