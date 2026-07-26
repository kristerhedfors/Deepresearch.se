// Unit tests for provider-region.js — the country-of-processing flag mapping
// shared by every model / provider selector.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_REGIONS,
  flagForProvider,
  labelWithFlag,
  regionForModelEntry,
  regionForProvider,
} from "./provider-region.js";

test("Berget is Sweden; OpenAI/Anthropic/Groq are the US", () => {
  assert.equal(regionForProvider("berget").country, "Sweden");
  assert.equal(regionForProvider("berget").flag, "🇸🇪");
  for (const id of ["openai", "anthropic", "groq"]) {
    assert.equal(regionForProvider(id).country, "United States");
    assert.equal(regionForProvider(id).flag, "🇺🇸");
  }
});

test("provider key match is case-insensitive", () => {
  assert.equal(flagForProvider("Berget"), "🇸🇪");
  assert.equal(flagForProvider("OPENAI"), "🇺🇸");
});

test("an unknown or local provider gets no region and no flag", () => {
  assert.equal(regionForProvider("local"), null);
  assert.equal(regionForProvider(""), null);
  assert.equal(regionForProvider(undefined), null);
  assert.equal(regionForProvider(42), null);
  assert.equal(flagForProvider("local"), "");
  assert.equal(flagForProvider(null), "");
});

test("regionForModelEntry: explicit secondary provider vs Berget default", () => {
  assert.equal(regionForModelEntry({ provider: "anthropic" }).flag, "🇺🇸");
  assert.equal(regionForModelEntry({ provider: "openai" }).flag, "🇺🇸");
  // A Berget catalog entry carries no provider field → defaults to Berget.
  assert.equal(regionForModelEntry({ id: "mistralai/x" }).flag, "🇸🇪");
  assert.equal(regionForModelEntry({}).flag, "🇸🇪");
  assert.equal(regionForModelEntry(null).flag, "🇸🇪");
});

test("labelWithFlag prefixes a flag, or returns the name unchanged when local", () => {
  assert.equal(labelWithFlag("🇸🇪", "Mistral Small"), "🇸🇪 Mistral Small");
  assert.equal(labelWithFlag("", "Local model"), "Local model");
});

test("every registered region has a country and a flag", () => {
  for (const [id, r] of Object.entries(PROVIDER_REGIONS)) {
    assert.ok(r.country, `${id} has a country`);
    assert.ok(r.flag, `${id} has a flag`);
  }
});
