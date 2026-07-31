// Unit tests for berget.js: consumeChatStream (OpenAI-style SSE parsing and
// the opt-in idle/total stream guards) and the catalog price normalization
// that keeps quota/cost accounting in EUR per token.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  bergetPricingPerToken,
  consumeChatStream,
  eurPerTokenFromBerget,
  formatPricing,
  jsonCompletionResult,
} from "./berget.js";

// Builds an SSE body from chunks; a `null` chunk means "stall forever from
// here" (the stream never produces another read and never closes) — the
// accepted-then-hung backend shape the idle/total guards exist for.
function sseBody(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      if (!chunks.length) return controller.close();
      const next = chunks.shift();
      if (next === null) return new Promise(() => {}); // hang: pull never settles
      controller.enqueue(encoder.encode(next));
    },
  });
}

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
const doneChunk = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\ndata: [DONE]\n`;

describe("consumeChatStream", () => {
  test("accumulates deltas, usage and finish_reason (no guards — unchanged default)", async () => {
    const seen = [];
    const out = await consumeChatStream(sseBody([delta("Hel"), delta("lo"), doneChunk]), (t) => seen.push(t));
    assert.equal(out.text, "Hello");
    assert.deepEqual(seen, ["Hel", "lo"]);
    assert.equal(out.finishReason, "stop");
    assert.equal(out.usage.completion_tokens, 2);
  });

  test("idleMs converts an accepted-then-stalled stream into a catchable error", async () => {
    // Production shape (2026-07-08): headers arrive (connect timeout cleared),
    // some or no content streams, then the backend goes silent forever —
    // without the guard the read loop hangs the whole request.
    await assert.rejects(
      consumeChatStream(sseBody([delta("partial"), null]), () => {}, { idleMs: 50 }),
      /produced nothing for 50ms/,
    );
  });

  test("maxMs bounds total consumption even while chunks keep trickling in", async () => {
    // A stream that never stalls long enough to trip idleMs but never ends
    // either: emit a chunk every ~10ms forever.
    const encoder = new TextEncoder();
    const trickle = new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 10));
        controller.enqueue(encoder.encode(delta("x")));
      },
    });
    await assert.rejects(
      consumeChatStream(trickle, () => {}, { idleMs: 1000, maxMs: 80 }),
      /treating as hung/,
    );
  });

  test("guards do not fire on a healthy stream that finishes in time", async () => {
    const out = await consumeChatStream(sseBody([delta("ok"), doneChunk]), () => {}, { idleMs: 1000, maxMs: 5000 });
    assert.equal(out.text, "ok");
    assert.equal(out.finishReason, "stop");
  });

  test("maxChars overrides the runaway-generation safety cap (report tiers raise it)", async () => {
    // The default STREAM_MAX_CHARS stays for callers that pass nothing; the
    // answer stream passes a cap scaled to the report tier's max_tokens so a
    // legitimate full report isn't cut off while a runaway still is.
    await assert.rejects(
      consumeChatStream(sseBody([delta("x".repeat(30)), doneChunk]), () => {}, { maxChars: 10 }),
      /exceeded the 10-char safety cap/,
    );
    const out = await consumeChatStream(sseBody([delta("x".repeat(30)), doneChunk]), () => {}, { maxChars: 100 });
    assert.equal(out.text.length, 30);
  });
});

// ---- catalog price normalization -------------------------------------------
// Berget's catalog changed the UNIT of its prices under us on 2026-07-17
// (EUR per token -> EUR per MILLION tokens, tagged `unit: "€ / M Token"`).
// Stored raw, that overstated every Berget model's cost by 1e6: ~€500k of
// phantom spend on the admin usage panel, and every real user pushed past
// their EUR budget cap on the first request. These pin the normalization.

describe("eurPerTokenFromBerget", () => {
  test("divides an explicit per-MILLION unit by 1e6 (the 2026-07-17 catalog)", () => {
    const p = { currency: "EUR", input: 0.3, output: 0.3, unit: "€ / M Token" };
    assert.equal(eurPerTokenFromBerget(p, "input"), 3e-7);
    assert.equal(eurPerTokenFromBerget(p, "output"), 3e-7);
  });

  test("passes a genuine per-token price through untouched (the pre-2026-07-17 catalog)", () => {
    const p = { currency: "EUR", input: 3e-7, output: 9e-7 };
    assert.equal(eurPerTokenFromBerget(p, "input"), 3e-7);
    assert.equal(eurPerTokenFromBerget(p, "output"), 9e-7);
  });

  test("the magnitude bound catches a per-million price wearing no (or a wrong) unit", () => {
    // The unit signal is not trusted alone — this is what stops the same 1e6
    // inflation from coming back silently if the tag changes again.
    assert.equal(eurPerTokenFromBerget({ input: 1.5 }, "input"), 1.5e-6);
    assert.equal(eurPerTokenFromBerget({ input: 0.75, unit: "€ / token" }, "input"), 7.5e-7);
    // ...and it does not touch a plausible per-token price just under the bound.
    assert.equal(eurPerTokenFromBerget({ input: 1.4e-5 }, "input"), 1.4e-5);
  });

  test("a per-SECOND unit (speech-to-text) has no token price", () => {
    assert.equal(eurPerTokenFromBerget({ input: 3.3e-5, unit: "€ / second" }, "input"), 0);
  });

  test("missing / non-numeric / non-positive prices are 0, never NaN", () => {
    assert.equal(eurPerTokenFromBerget(null, "input"), 0);
    assert.equal(eurPerTokenFromBerget({}, "input"), 0);
    assert.equal(eurPerTokenFromBerget({ input: "0.3" }, "input"), 0);
    assert.equal(eurPerTokenFromBerget({ input: 0 }, "input"), 0);
  });
});

describe("bergetPricingPerToken", () => {
  test("normalizes a whole pricing block, keeping the currency", () => {
    const p = bergetPricingPerToken({ currency: "EUR", input: 1.5, output: 5, unit: "€ / M Token" });
    assert.deepEqual(p, { input: 1.5e-6, output: 5e-6, currency: "EUR" });
  });

  test("an unpriced entry stays null, so its tooltip stays absent (not a bogus €0)", () => {
    assert.equal(bergetPricingPerToken(null), null);
    assert.equal(bergetPricingPerToken({ currency: "EUR" }), null);
    assert.equal(formatPricing(bergetPricingPerToken(undefined)), null);
  });

  test("the dropdown tooltip reads back the catalog's own per-1M figures", () => {
    // formatPricing multiplies per-token prices back up by 1e6, so a correct
    // normalization round-trips to exactly what Berget published.
    const tip = formatPricing(bergetPricingPerToken({ currency: "EUR", input: 0.3, output: 0.3, unit: "€ / M Token" }));
    assert.equal(tip, "€0.3 in / €0.3 out per 1M tokens");
  });
});

// The adapter three provider clients now share (berget.js, openai.js,
// hf-inference.js). It was a hand-copy in each until refactor pass 14; the
// properties below are the ones the pipeline's helper phases rely on, and the
// ones a drifting copy would have broken silently.
describe("jsonCompletionResult", () => {
  const body = (content, extra = {}) => ({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
    ...extra,
  });

  test("a clean JSON object parses strict and carries usage through", () => {
    const r = jsonCompletionResult(body('{"needsSearch":true}'));
    assert.deepEqual(r.value, { needsSearch: true });
    assert.equal(r.diagnostics.parse_mode, "strict");
    assert.equal(r.diagnostics.finish_reason, "stop");
    assert.equal(r.diagnostics.content_length, 20);
    assert.deepEqual(r.usage, { prompt_tokens: 11, completion_tokens: 4 });
  });

  test("prose-wrapped JSON is repaired, not failed — the fail-soft path", () => {
    const r = jsonCompletionResult(body('Sure! {"needsSearch":false} — hope that helps'));
    assert.deepEqual(r.value, { needsSearch: false });
    assert.equal(r.diagnostics.parse_mode, "repaired");
  });

  // Invariant 2: a helper phase degrades, it never throws. value null is the
  // signal every caller falls back on.
  test("unparseable output yields value null rather than throwing", () => {
    const r = jsonCompletionResult(body("I cannot answer that."));
    assert.equal(r.value, null);
    assert.equal(r.diagnostics.parse_mode, "failed");
  });

  test("a truncated completion reports its finish_reason for per-model observability", () => {
    const data = body('{"a":1');
    data.choices[0].finish_reason = "length";
    const r = jsonCompletionResult(data);
    assert.equal(r.diagnostics.finish_reason, "length");
    assert.equal(r.value, null);
  });

  test("an empty or malformed envelope degrades instead of throwing", () => {
    const r = jsonCompletionResult({});
    assert.equal(r.value, null);
    assert.equal(r.usage, null);
    assert.equal(r.diagnostics.finish_reason, null);
    assert.equal(r.diagnostics.content_length, 0);
  });
});
