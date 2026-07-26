// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — the same reason the src/*.test.js files give.)
// Unit tests for the model picker's pure core (public/js/hf-models-core.js).
//
// These are the numbers on the cards. "Cost info before starting the model" is
// only worth anything if the cost is right and legible, so what is pinned here
// is precision at the cheap end (where rounding would hide the whole point),
// the estimate always reading as an estimate, and a blocked card always
// carrying its reason.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  acceptedLabel,
  allowanceLine,
  badges,
  estimateLine,
  filterRows,
  formatEur,
  primaryAction,
  rateLine,
} from "./hf-models-core.js";

/** @type {any} */
const ROW = {
  id: "hf:meta-llama/Llama-3.1-8B-Instruct@nebius",
  hfId: "meta-llama/Llama-3.1-8B-Instruct",
  name: "Llama-3.1-8B-Instruct",
  provider: "nebius",
  context: 131072,
  usd_in: 0.02,
  usd_out: 0.06,
  turn_eur: 0.000287,
  vision: false,
  tools: false,
  accepted: false,
  allowed: true,
  reason: null,
};

describe("formatEur", () => {
  test("keeps precision at the cheap end instead of rounding it away", () => {
    // A research turn on a cheap model costs fractions of a cent. Rounding that
    // to "€0.00" would hide exactly the difference the picker exists to show.
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
  test("the rate is quoted in the provider's own USD per 1M", () => {
    // The number you can go and check on huggingface.co — so it must match
    // their unit, not ours.
    assert.equal(rateLine(ROW), "$0.02 in / $0.06 out per 1M tokens");
    assert.equal(rateLine({ ...ROW, usd_out: null }), "no published price");
    assert.equal(rateLine({ ...ROW, usd_in: null }), "? in / $0.06 out per 1M tokens");
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
    assert.deepEqual(badges({ ...ROW, context: null, provider: null }), []);
  });
});

describe("primaryAction", () => {
  test("an enabled model offers removal, not a dead 'enabled' label", () => {
    const a = primaryAction({ ...ROW, accepted: true });
    assert.equal(a.action, "remove");
    assert.equal(a.disabled, false);
    assert.match(a.label, /Enabled/);
  });

  test("a blocked model carries the server's reason on the button itself", () => {
    // A greyed-out button with no explanation is the thing this avoids.
    const a = primaryAction({ ...ROW, allowed: false, reason: "Above your model allowance ($3.00 per 1M output tokens)." });
    assert.equal(a.disabled, true);
    assert.match(a.title, /Above your model allowance/);
  });

  test("an enableable model says what enabling actually does", () => {
    const a = primaryAction(ROW);
    assert.equal(a.action, "accept");
    assert.equal(a.disabled, false);
    assert.match(a.title, /every chat mode/);
  });
});

describe("allowanceLine", () => {
  test("names the ceiling AND that it is a starting one", () => {
    const line = allowanceLine({ max_output_usd: 3, max_accepted: 6, used: 2 });
    assert.match(line, /2\/6 models enabled/);
    assert.match(line, /\$3\/1M output tokens/);
    assert.match(line, /starts here and an admin can raise it/);
  });

  test("an uncapped allowance does not invent a ceiling", () => {
    const line = allowanceLine({ max_output_usd: 0, max_accepted: 0, used: 9 });
    assert.match(line, /9 models enabled/);
    assert.doesNotMatch(line, /\$0/);
    assert.equal(allowanceLine(null), "");
  });
});

describe("filterRows", () => {
  const rows = /** @type {any[]} */ ([
    ROW,
    { ...ROW, hfId: "Qwen/Qwen3.6-27B", provider: "together" },
    { ...ROW, hfId: "google/gemma-4-31B-it", provider: "nebius" },
  ]);

  test("every term must match — the id and the serving provider are both fair game", () => {
    assert.deepEqual(filterRows(rows, "qwen").map((r) => r.hfId), ["Qwen/Qwen3.6-27B"]);
    assert.equal(filterRows(rows, "nebius").length, 2);
    assert.deepEqual(filterRows(rows, "qwen nebius"), []);
    assert.equal(filterRows(rows, "").length, 3);
  });
});

test("an accepted model wears the hub's mark in the dropdown", () => {
  assert.equal(acceptedLabel({ name: "Llama-3.1-8B-Instruct", hfId: "meta-llama/Llama-3.1-8B-Instruct" }), "🤗 Llama-3.1-8B-Instruct");
  assert.equal(acceptedLabel(/** @type {any} */ ({ hfId: "o/m" })), "🤗 o/m");
});
