// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — the same reason the src/*.test.js files give.)
// Unit tests for the lifecycle board's pure core (public/js/models-core.js).
//
// These are the numbers and the verdicts on the cards. "See what it costs and
// what it passed before you rely on it" is only worth anything if both are
// right and legible, so what is pinned here is precision at the cheap end
// (where rounding would hide the whole point), the estimate always reading as
// an estimate, the three check states staying visibly distinct, and a blocked
// card always carrying its reason.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allowanceLine,
  badges,
  checkGlyph,
  checkTitle,
  estimateLine,
  filterRows,
  formatEur,
  groupByState,
  LIFECYCLE,
  primaryAction,
  providersLine,
  rateLine,
  verifyAction,
} from "./models-core.js";

/** A row as /api/models/catalog serves it. */
const ROW = {
  id: "hf:meta-llama/Llama-3.1-8B-Instruct@nebius",
  name: "Llama-3.1-8B-Instruct",
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
  url: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct",
  servedBy: "nebius",
  up: true,
  enableable: true,
  reason: null,
  checks: [
    { id: "reachable", label: "Answers", why: "does it answer", state: "pass", note: "answered in 420 ms", at: 1750000000000, ms: 420 },
    { id: "json", label: "JSON mode", why: "invariant 3", state: "fail", note: "parse mode: failed", at: 1750000000000, ms: 900 },
    { id: "swedish", label: "Swedish", why: "invariant 6", state: "untested", note: "", at: null, ms: null },
  ],
  verification: { pass: 1, fail: 1, untested: 1, total: 3, label: "1/3 verified, 1 failing, 1 untried" },
};

describe("formatEur", () => {
  test("keeps precision at the cheap end instead of rounding it away", () => {
    // A research turn on a cheap model costs fractions of a cent. Rounding that
    // to "€0.00" would hide exactly the difference the board exists to show.
    assert.equal(formatEur(0.000287), "<€0.001");
    assert.equal(formatEur(0.0123), "€0.012");
    assert.equal(formatEur(0.25), "€0.25");
    assert.equal(formatEur(3.5), "€3.50");
    assert.equal(formatEur(0), "€0");
  });

  test("an unknown number is a dash, never a zero", () => {
    assert.equal(formatEur(null), "—");
    assert.equal(formatEur(undefined), "—");
    assert.equal(formatEur(NaN), "—");
  });
});

describe("the cost lines", () => {
  test("the rate prefers the provider's own USD, and falls back to EUR", () => {
    // The USD number is the one you can go and check on a pricing page, so it
    // wins when it exists; a provider that publishes no USD still gets a line.
    assert.equal(rateLine(ROW), "$0.02 in / $0.06 out per 1M tokens");
    assert.equal(rateLine({ ...ROW, usd_in: null }), "? in / $0.06 out per 1M tokens");
    assert.equal(rateLine({ ...ROW, usd_out: null }), ROW.pricing);
    assert.equal(rateLine({ ...ROW, usd_out: null, pricing: null }), "no published price");
  });

  test("the estimate always says ≈ and always names the turn it assumes", () => {
    const line = estimateLine(ROW, { prompt: 12000, completion: 1200 });
    assert.match(line, /^≈ /);
    assert.match(line, /12k in \/ 1k out/);
    // No price → no estimate at all, rather than an estimate of zero.
    assert.equal(estimateLine({ ...ROW, turn_eur: null }), "");
  });
});

describe("badges", () => {
  test("capability first, then size, then who serves it", () => {
    assert.deepEqual(badges({ ...ROW, vision: true, tools: true }), ["vision", "tools", "131k ctx", "nebius"]);
    assert.deepEqual(badges({ ...ROW, context: null, servedBy: null }), []);
  });
});

describe("the lifecycle lanes", () => {
  test("board order is enabled, available, discovered", () => {
    assert.deepEqual(LIFECYCLE.map((l) => l.id), ["enabled", "available", "discovered"]);
    // Every lane explains what its state MEANS — someone opening the board for
    // the first time should not have to infer why a model is in one group.
    for (const l of LIFECYCLE) assert.ok(l.blurb.length > 20, l.id);
  });

  test("empty lanes are dropped, not rendered blank", () => {
    const groups = groupByState([ROW, { ...ROW, id: "b", state: "enabled" }]);
    assert.deepEqual(groups.map((g) => g.id), ["enabled", "discovered"]);
    assert.equal(groups[0].rows.length, 1);
    assert.deepEqual(groupByState([]), []);
  });
});

describe("the verification checkboxes", () => {
  test("three states get three distinct glyphs", () => {
    // The load-bearing one: an untested check must never render as a failure.
    // "Nobody asked yet" and "we asked and it failed" are different facts.
    assert.equal(checkGlyph("pass"), "✓");
    assert.equal(checkGlyph("fail"), "✕");
    assert.equal(checkGlyph("untested"), "·");
    assert.notEqual(checkGlyph("untested"), checkGlyph("fail"));
  });

  test("a tooltip says what happened, when, and what the check proves", () => {
    const passed = checkTitle(ROW.checks[0]);
    assert.match(passed, /Answers — passed/);
    assert.match(passed, /answered in 420 ms/);
    assert.match(passed, /does it answer/); // the `why`
    assert.match(passed, /\(\d{4}-\d{2}-\d{2}\)/); // the recorded date
    const untried = checkTitle(ROW.checks[2]);
    assert.match(untried, /not run yet/);
    assert.doesNotMatch(untried, /failed/);
  });
});

describe("primaryAction", () => {
  test("an enabled model offers removal, not a dead label", () => {
    const a = primaryAction({ ...ROW, state: "enabled", usable: true });
    assert.equal(a.action, "disable");
    assert.equal(a.disabled, false);
    assert.match(a.title, /verification results are kept/);
  });

  test("an available model has no action at all, and says why", () => {
    // A curated provider's model is already selectable everywhere. Offering
    // "Enable" would promise a state change that does not exist.
    const a = primaryAction({ ...ROW, state: "available", usable: true, providerLabel: "Anthropic" });
    assert.equal(a.action, "none");
    assert.equal(a.disabled, true);
    assert.match(a.title, /Anthropic ships this model/);
  });

  test("a blocked discovered model carries the server's reason on the button", () => {
    const a = primaryAction({ ...ROW, enableable: false, reason: "Above your model allowance ($3.00 per 1M output tokens)." });
    assert.equal(a.disabled, true);
    assert.match(a.title, /Above your model allowance/);
  });

  test("an enableable model says what enabling actually does", () => {
    const a = primaryAction(ROW);
    assert.equal(a.action, "enable");
    assert.equal(a.disabled, false);
    assert.match(a.title, /every chat mode/);
  });
});

describe("verifyAction", () => {
  test("verification is offered only for a model that can actually be run", () => {
    // The checks send real requests, so a discovered model — which has no route
    // until it is enabled — must not offer the button.
    assert.equal(verifyAction(ROW).shown, false);
    assert.match(verifyAction(ROW).title, /Enable this model first/);
    assert.equal(verifyAction({ ...ROW, usable: true }).shown, true);
  });

  test("the button says whether this would be a first run or a re-run", () => {
    const fresh = verifyAction({ ...ROW, usable: true, verification: { pass: 0, fail: 0, untested: 3, total: 3, label: "" } });
    assert.match(fresh.title, /Run all 3 checks/);
    const rerun = verifyAction({ ...ROW, usable: true });
    assert.match(rerun.title, /Re-run all 3 checks/);
    assert.match(rerun.title, /1 have never been run/);
  });
});

describe("allowanceLine", () => {
  test("names the ceiling AND that it is a starting one", () => {
    const line = allowanceLine({ max_output_usd: 3, max_enabled: 6, used: 2 });
    assert.match(line, /2\/6 models enabled/);
    assert.match(line, /\$3\/1M output tokens/);
    assert.match(line, /starts here and an admin can raise it/);
  });

  test("an uncapped allowance does not invent a ceiling", () => {
    const line = allowanceLine({ max_output_usd: 0, max_enabled: 0, used: 9 });
    assert.match(line, /9 models enabled/);
    assert.doesNotMatch(line, /\$0/);
    assert.equal(allowanceLine(null), "");
  });
});

describe("providersLine", () => {
  test("names who is reachable, who has an open catalog, and who is not configured", () => {
    // Answers "why is nothing from X showing" before it is asked.
    const line = providersLine([
      { id: "berget", label: "Berget", open: false, configured: true, count: 12 },
      { id: "huggingface", label: "Hugging Face", open: true, configured: true, count: 129 },
      { id: "openai", label: "OpenAI", open: false, configured: false, count: 0 },
    ]);
    assert.match(line, /Berget \(12\)/);
    assert.match(line, /Hugging Face \(129, open catalog\)/);
    assert.match(line, /not configured here: OpenAI/);
  });

  test("a server with nothing configured says so rather than showing an empty list", () => {
    const line = providersLine([{ id: "berget", label: "Berget", open: false, configured: false, count: 0 }]);
    assert.match(line, /No provider is configured/);
    assert.equal(providersLine([]), "");
  });
});

describe("filterRows", () => {
  const rows = [
    ROW,
    { ...ROW, id: "b", name: "Qwen3.6-27B", providerLabel: "Hugging Face", servedBy: "together" },
    { ...ROW, id: "c", name: "Claude Opus 5", providerLabel: "Anthropic", servedBy: null },
  ];

  test("every term must match — id, name, provider and serving host are all fair game", () => {
    assert.deepEqual(filterRows(rows, "qwen").map((r) => r.id), ["b"]);
    assert.deepEqual(filterRows(rows, "anthropic").map((r) => r.id), ["c"]);
    assert.equal(filterRows(rows, "hugging").length, 2);
    assert.deepEqual(filterRows(rows, "qwen anthropic"), []);
    assert.equal(filterRows(rows, "").length, 3);
  });
});
