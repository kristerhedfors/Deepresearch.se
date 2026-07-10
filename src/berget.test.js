// Unit tests for berget.js's consumeChatStream: OpenAI-style SSE parsing and
// the opt-in idle/total stream guards.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { consumeChatStream } from "./berget.js";

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
});
