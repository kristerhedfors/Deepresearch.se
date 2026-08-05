// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the phase-0 image read (src/image-read.js).
//
// What is pinned here is the contract the pipeline depends on, not the quality
// of a transcription (that is a model property, verified live):
//
//   - silence on a turn without an image — no step, no model call, the same
//     conversation object back, so an ordinary text turn costs nothing;
//   - the labeled block on a turn with one, appended to the message the images
//     are on, with the image parts still intact beside it;
//   - fail-soft in EVERY branch (invariant 2): a provider error, a stalled
//     stream, a thrown fetch and an empty completion all leave the conversation
//     unchanged, say so visibly, and never throw;
//   - the call goes to the ANSWER model (invariant 3's planning phases are the
//     three JSON ones; this is deliberately not one of them), carries the
//     IMAGE_READ_PROMPT as its system turn, and is made exactly once.
//
// The provider seam is stubbed at globalThis.fetch — the house pattern (see
// scholar-metrics.test.js) — so nothing here touches the network.

import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_READ_GUARDS,
  IMAGE_READ_MAX_TOKENS,
  imageReadBlock,
  readImages,
  runImageReadEnrichment,
} from "./image-read.js";
import { IMAGE_READ_PROMPT } from "./prompts.js";

const IMG = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const TRANSCRIPT =
  "TEXT: Ada Nordin — Founder & CEO at Vindkraft AB. Stockholm, Sweden.\n" +
  "SUBJECT: Ada Nordin; Vindkraft AB\n" +
  "KIND: a screenshot of a LinkedIn profile page";

/** One OpenAI-style SSE body carrying `text`, then a usage chunk and [DONE]. */
function sseBody(text, usage = { prompt_tokens: 900, completion_tokens: 120 }) {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/** A body that opens and then never says anything — the accepted-then-hung
 * backend the stream guards exist for. */
function stalledBody() {
  return new ReadableStream({ start() {} });
}

/** Installs a fetch stub for the duration of `fn`, recording every request. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return handler(calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

/** The enrichment ctx, with the steps and warnings it produced. */
function ctx(content, { model = "mistralai/Pixtral-12B" } = {}) {
  const steps = [];
  const warnings = [];
  const conversation = [{ role: "user", content }];
  const state = { model, totals: { prompt_tokens: 0, completion_tokens: 0 } };
  return {
    steps,
    warnings,
    state,
    conversation,
    c: {
      env: { BERGET_API_TOKEN: "test-token" },
      log: {
        info() {},
        debug() {},
        error() {},
        warn: (event, meta) => warnings.push([event, meta]),
      },
      emit() {},
      step: (id, label) => steps.push(["start", id, label]),
      stepDone: (id, label) => steps.push(["done", id, label]),
      conversation,
      state,
    },
  };
}

test("a turn without an image is completely silent", async () => {
  // No step, no model call, and the SAME conversation back — the cost of this
  // phase on an ordinary text turn has to be zero.
  await withFetch(
    () => assert.fail("no provider call may be made without an image"),
    async () => {
      const { c, steps, conversation } = ctx("Write a report about this founder");
      const out = await runImageReadEnrichment(c);
      assert.equal(out, conversation);
      assert.deepEqual(steps, []);
    },
  );

  // Also silent for a multipart message that carries only text parts.
  await withFetch(
    () => assert.fail("no provider call may be made without an image"),
    async () => {
      const { c, steps, conversation } = ctx([{ type: "text", text: "hello" }]);
      const out = await runImageReadEnrichment(c);
      assert.equal(out, conversation);
      assert.deepEqual(steps, []);
    },
  );
});

test("an attached image is transcribed into a labeled block", async () => {
  await withFetch(
    () => new Response(sseBody(TRANSCRIPT), { status: 200 }),
    async (calls) => {
      const { c, steps, state } = ctx([
        { type: "text", text: "Write a report about what you can find on this founder" },
        IMG,
      ]);
      const out = await runImageReadEnrichment(c);

      // Exactly ONE call, on the ANSWER model, with the shipped prompt as its
      // system turn and the image part forwarded verbatim.
      assert.equal(calls.length, 1);
      const sent = calls[0].body;
      assert.equal(sent.model, "mistralai/Pixtral-12B");
      assert.equal(sent.max_tokens, IMAGE_READ_MAX_TOKENS);
      assert.equal(sent.messages[0].role, "system");
      assert.equal(sent.messages[0].content, IMAGE_READ_PROMPT);
      assert.deepEqual(sent.messages[1].content[1], IMG);
      // Invariant 1: a plain completion — no tools offered, none expected back.
      assert.equal(sent.tools, undefined);
      assert.equal(sent.tool_choice, undefined);

      // The block lands on the user message as a NEW text part, so the image
      // and the question both survive it.
      const parts = out[0].content;
      assert.equal(parts.length, 3);
      assert.deepEqual(parts[1], IMG);
      assert.match(parts[2].text, /Ada Nordin/);
      assert.match(parts[2].text, /transcribed by this system's vision pass/);
      assert.match(parts[2].text, /USING THIS BLOCK/);

      // Counters for chat_logs — the shape, and the answer model's tokens
      // billed in the answer model's bucket.
      assert.deepEqual(state.imageRead, { images: 1, chars: TRANSCRIPT.length });
      assert.deepEqual(state.totals, { prompt_tokens: 900, completion_tokens: 120 });

      assert.deepEqual(steps, [
        ["start", "image_read", "Reading the attached image…"],
        ["done", "image_read", `Read 1 image (${TRANSCRIPT.length} characters of text)`],
      ]);
    },
  );
});

test("string content and several images are handled", async () => {
  await withFetch(
    () => new Response(sseBody(TRANSCRIPT), { status: 200 }),
    async (calls) => {
      const { c, steps } = ctx([{ type: "text", text: "who are these?" }, IMG, IMG]);
      const out = await runImageReadEnrichment(c);
      assert.equal(calls[0].body.messages[1].content.length, 3); // instruction + 2 images
      assert.match(out[0].content[3].text, /2 images attached to this message/);
      assert.deepEqual(steps[0], ["start", "image_read", "Reading the attached 2 images…"]);
    },
  );
});

test("a provider error leaves the conversation unchanged and says so", async () => {
  await withFetch(
    () => new Response("model is overloaded", { status: 503 }),
    async () => {
      const { c, steps, state, conversation, warnings } = ctx([{ type: "text", text: "who?" }, IMG]);
      const out = await runImageReadEnrichment(c);
      assert.deepEqual(out, conversation, "the conversation comes back unchanged");
      assert.deepEqual(steps, [
        ["start", "image_read", "Reading the attached image…"],
        ["done", "image_read", "The attached image could not be read"],
      ]);
      assert.deepEqual(state.imageRead, { images: 1, chars: 0 });
      assert.equal(warnings[0][0], "image_read.failed");
      assert.equal(warnings[0][1].status, 503);
      // The warning carries the SHAPE and the provider's own words — never the
      // transcription and never the question.
      assert.equal(warnings[0][1].images, 1);
    },
  );
});

test("a thrown fetch — the connect timeout's shape — never breaks the turn", async () => {
  await withFetch(
    () => {
      // What chatCompletion's AbortController produces when the backend never
      // returns headers.
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    },
    async () => {
      const { c, steps, conversation, warnings } = ctx([{ type: "text", text: "who?" }, IMG]);
      const out = await runImageReadEnrichment(c);
      assert.deepEqual(out, conversation);
      assert.equal(steps[1][2], "The attached image could not be read");
      assert.equal(warnings[0][1].error, "The operation was aborted");
    },
  );
});

test("an accepted-then-stalled stream is cut by the bound, not waited out", async () => {
  // The real guard, exercised with a small budget so the test costs
  // milliseconds instead of the shipped 20 s. The shipped values are asserted
  // separately below.
  await withFetch(
    () => new Response(stalledBody(), { status: 200 }),
    async () => {
      const { c, steps, conversation, state, warnings } = ctx([{ type: "text", text: "who?" }, IMG]);
      const started = Date.now();
      const out = await runImageReadEnrichment(c, { idleMs: 30, maxMs: 60 });
      assert.ok(Date.now() - started < 2000, "the read must not wait out a hung backend");
      assert.deepEqual(out, conversation);
      assert.deepEqual(state.imageRead, { images: 1, chars: 0 });
      assert.equal(steps[1][2], "The attached image could not be read");
      assert.match(warnings[0][1].error, /hung/);
    },
  );
});

test("the shipped guards actually bound the call", () => {
  // A phase that blocks triage must not be able to hang the request: both a
  // per-chunk and a total budget, each well under a research turn.
  assert.ok(IMAGE_READ_GUARDS.idleMs > 0 && IMAGE_READ_GUARDS.idleMs <= 30_000);
  assert.ok(IMAGE_READ_GUARDS.maxMs > IMAGE_READ_GUARDS.idleMs);
  assert.ok(IMAGE_READ_GUARDS.maxMs <= 60_000);
});

test("an empty completion is treated as no read at all", async () => {
  await withFetch(
    () => new Response(sseBody("   "), { status: 200 }),
    async () => {
      const { c, steps, conversation, state, warnings } = ctx([{ type: "text", text: "who?" }, IMG]);
      const out = await runImageReadEnrichment(c);
      assert.deepEqual(out, conversation, "no block is appended for an empty reply");
      assert.equal(steps[1][2], "The attached image could not be read");
      assert.deepEqual(state.imageRead, { images: 1, chars: 0 });
      assert.equal(warnings[0][1].error, "empty completion");
    },
  );
});

test("readImages returns a string on every path and never throws", async () => {
  // The seam the runner is built on: whatever the provider does, the caller
  // gets a string back (invariant 2), and a failed read spends nothing.
  const state = { model: "mistralai/Pixtral-12B", totals: { prompt_tokens: 0, completion_tokens: 0 } };
  const env = { BERGET_API_TOKEN: "t" };
  const log = { warn() {}, info() {} };
  for (const handler of [
    () => new Response(null, { status: 500 }),
    () => new Response("", { status: 200 }), // ok but no body to consume
    () => {
      throw new Error("socket hang up");
    },
  ]) {
    await withFetch(handler, async () => {
      assert.equal(await readImages(env, log, state, [IMG], { idleMs: 30, maxMs: 60 }), "");
    });
  }
  assert.deepEqual(state.totals, { prompt_tokens: 0, completion_tokens: 0 });
});

test("the block tells later phases it is NOT a source", () => {
  // The whole point of the trailing paragraph. These three instructions are
  // what stop a transcription being cited as if it were research: it is the
  // user's own attachment, the NAMES are what to search, and a name read off a
  // picture is unverified until a source confirms it.
  const block = imageReadBlock(1, "SUBJECT: Ada Nordin");
  assert.match(block, /do not cite them as sources/i);
  assert.match(block, /Research the NAMES/);
  assert.match(block, /UNVERIFIED/);
  assert.match(block, /No web source was consulted/i);
});
