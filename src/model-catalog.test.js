// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the cross-provider model catalog (src/model-catalog.js): the
// lifecycle, the allowance, the ranking, and the context block.
//
// The property worth defending hardest is that this layer names no provider.
// The tests below therefore use rows from several, and the one that would catch
// a regression to a Hugging-Face-shaped assumption is "the allowance governs
// only the discovered → enabled transition".

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyAllowance,
  catalogBlock,
  DEFAULT_ALLOWANCE,
  enableVerdict,
  modelAllowance,
  rankCatalog,
  TYPICAL_TURN,
  turnCostEur,
} from "./model-catalog.js";

/** @param {object} over */
const row = (over = {}) => ({
  id: "hf:a/b@nebius",
  name: "b",
  provider: "huggingface",
  providerLabel: "Hugging Face",
  state: "discovered",
  usable: false,
  vision: false,
  tools: false,
  context: 131072,
  price_in: 1.84e-8,
  price_out: 5.52e-8,
  usd_in: 0.02,
  usd_out: 0.06,
  pricing: "€0.02 in / €0.06 out per 1M tokens",
  turn_eur: 0.000287,
  url: null,
  servedBy: "nebius",
  up: true,
  enableable: false,
  reason: null,
  checks: [],
  verification: { pass: 0, fail: 0, untested: 0, total: 0, label: "not verified yet" },
  ...over,
});

describe("the allowance", () => {
  test("defaults apply with no config, and admin values extend them", () => {
    assert.deepEqual(modelAllowance(undefined), DEFAULT_ALLOWANCE);
    assert.deepEqual(modelAllowance({ models: { max_output_usd: 12, max_enabled: 20 } }), {
      maxOutputUsd: 12,
      maxEnabled: 20,
    });
    // Junk falls back rather than uncapping by accident.
    assert.deepEqual(modelAllowance({ models: { max_output_usd: "lots", max_enabled: 1.5 } }), DEFAULT_ALLOWANCE);
  });

  test("it governs ONLY the discovered → enabled transition", () => {
    // The load-bearing generalisation. A curated provider's model is available
    // by construction; an allowance that "blocked" it would be claiming to
    // gate something it does not control, and would read as an outage.
    const anthropic = row({ id: "claude-opus-5", provider: "anthropic", providerLabel: "Anthropic", state: "available", usable: true, usd_out: 25 });
    const v = enableVerdict(anthropic, { maxOutputUsd: 3, maxEnabled: 1 }, 99);
    assert.equal(v.enableable, false); // nothing to enable…
    assert.equal(v.reason, null); // …and therefore nothing to explain
  });

  test("an unpriced model is never enableable — an unknown rate cannot be budgeted", () => {
    const v = enableVerdict(row({ price_in: 0, price_out: 0, usd_in: null, usd_out: null }), DEFAULT_ALLOWANCE, 0);
    assert.equal(v.enableable, false);
    assert.match(String(v.reason), /can't be budgeted/);
  });

  test("a model above the output ceiling is blocked, with the ceiling named", () => {
    const v = enableVerdict(row({ usd_out: 5 }), { maxOutputUsd: 3, maxEnabled: 6 }, 0);
    assert.equal(v.enableable, false);
    assert.match(String(v.reason), /\$3\.00 per 1M output tokens/);
  });

  test("a full allowance blocks a new model and says how to make room", () => {
    const v = enableVerdict(row(), { maxOutputUsd: 3, maxEnabled: 2 }, 2);
    assert.equal(v.enableable, false);
    assert.match(String(v.reason), /Remove one/);
  });

  test("applyAllowance counts what is already enabled across the whole set", () => {
    const rows = [row({ id: "a", state: "enabled", usable: true }), row({ id: "b" }), row({ id: "c" })];
    applyAllowance(rows, { maxOutputUsd: 3, maxEnabled: 1 });
    assert.equal(rows[0].enableable, false); // already enabled — nothing to do
    assert.equal(rows[1].enableable, false); // the one enabled model fills the cap
    assert.match(String(rows[1].reason), /allowance holds 1 enabled model/);
  });
});

describe("ranking", () => {
  const rows = [
    row({ id: "hf:x/cheap", usd_out: 0.05, price_out: 4.6e-8, state: "discovered" }),
    row({ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", providerLabel: "Anthropic", state: "available", usable: true, price_out: 2.3e-5, usd_out: 25, servedBy: null }),
    row({ id: "hf:y/enabled", name: "Enabled One", state: "enabled", usable: true, price_out: 1e-7, usd_out: 0.1 }),
  ];

  test("an empty query orders by lifecycle first, price second", () => {
    // The board's own order: what you turned on, then what you can already use,
    // then the marketplace.
    assert.deepEqual(rankCatalog(rows, "").map((r) => r.state), ["enabled", "available", "discovered"]);
  });

  test("a query matches id, name and provider label, and drops non-matches", () => {
    assert.deepEqual(rankCatalog(rows, "anthropic").map((r) => r.id), ["claude-opus-5"]);
    assert.deepEqual(rankCatalog(rows, "opus").map((r) => r.id), ["claude-opus-5"]);
    assert.deepEqual(rankCatalog(rows, "nothingmatches"), []);
  });
});

describe("the context block", () => {
  test("quotes real rates, the lifecycle state, and the verification verdict", () => {
    const block = catalogBlock([
      row({
        id: "hf:a/b@nebius",
        state: "enabled",
        checks: [{ id: "json", label: "JSON mode", why: "", state: "fail", note: "", at: 1, ms: 1 }],
        verification: { pass: 2, fail: 1, untested: 0, total: 3, label: "2/3 verified, 1 failing" },
      }),
    ]);
    assert.match(block, /\$0\.02 in \/ \$0\.06 out per 1M tokens/);
    assert.match(block, /131k context/);
    assert.match(block, /ENABLED, 2\/3 verified, 1 failing — failing: JSON mode/);
  });

  test("it spells out what each lifecycle state MEANS", () => {
    // The model is being asked to reason about states it has never seen; a bare
    // "DISCOVERED" would be guessed at rather than used.
    const block = catalogBlock([row()]);
    assert.match(block, /DISCOVERED = listed by an open provider/);
    assert.match(block, /AVAILABLE = already selectable/);
    assert.match(block, /ENABLED = this account turned it on/);
  });

  test("it tells the model the checks are NOT blockers", () => {
    // The one thing an answer must not do is present a failing check as a ban.
    const block = catalogBlock([row()]);
    assert.match(block, /NOT blockers/);
    assert.match(block, /a failing check is a known limitation, not a ban/);
    assert.match(block, /Enabling and verifying are the USER's actions/);
  });

  test("no rows means no block at all — never an empty heading", () => {
    assert.equal(catalogBlock([]), "");
  });
});

test("the comparison turn is one shared definition", () => {
  // Two models from two providers must be comparable on one number, which only
  // holds while there is exactly one definition of the turn.
  assert.equal(TYPICAL_TURN.prompt, 12000);
  assert.equal(turnCostEur(1e-8, 2e-8), 1e-8 * 12000 + 2e-8 * 1200);
});
