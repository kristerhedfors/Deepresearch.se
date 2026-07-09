// Unit tests for the Anthropic provider client (src/anthropic.js): the pure
// request-shape conversion, the static catalog, and the SSE transcoder —
// verified end-to-end against berget.js's consumeChatStream, since "the
// existing consumer works unchanged on Anthropic streams" is the module's
// whole contract. Node's built-in test runner; no network.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anthropicToOpenAiSse,
  chatCompletion,
  isAnthropicModel,
  listAnthropicModels,
  toAnthropicRequest,
} from "./anthropic.js";
import { consumeChatStream } from "./berget.js";

// ---- catalog ----------------------------------------------------------------

test("listAnthropicModels is empty without the API key", () => {
  assert.deepEqual(listAnthropicModels({}), []);
});

test("listAnthropicModels exposes the catalog shape validation and pricing consume", () => {
  const models = listAnthropicModels({ ANTHROPIC_API_KEY: "k" });
  assert.equal(models.length, 3);
  const opus = models.find((m) => m.id === "claude-opus-4-8");
  assert.ok(opus);
  assert.equal(opus.name, "Claude Opus 4.8");
  assert.equal(opus.up, true);
  assert.equal(opus.vision, true);
  assert.match(opus.pricing, /\$5 in \/ \$25 out per 1M tokens/);
  // EUR-per-token prices for quota accounting: $5/1M in, $25/1M out at the
  // documented 1:1 USD→EUR over-count.
  assert.ok(Math.abs(opus.price_in - 5e-6) < 1e-12);
  assert.ok(Math.abs(opus.price_out - 25e-6) < 1e-12);
  assert.ok(models.some((m) => m.id === "claude-sonnet-5"));
  assert.ok(models.some((m) => m.id === "claude-haiku-4-5"));
});

test("isAnthropicModel matches exactly the catalog ids", () => {
  assert.equal(isAnthropicModel("claude-opus-4-8"), true);
  assert.equal(isAnthropicModel("claude-sonnet-5"), true);
  assert.equal(isAnthropicModel("claude-haiku-4-5"), true);
  assert.equal(isAnthropicModel("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), false);
  assert.equal(isAnthropicModel("claude-fable-5"), false); // not offered
  assert.equal(isAnthropicModel(""), false);
});

// ---- request conversion ------------------------------------------------------

test("toAnthropicRequest hoists system messages into the top-level system string", () => {
  const { system, messages } = toAnthropicRequest([
    { role: "system", content: "You are a researcher." },
    { role: "user", content: "hello" },
  ]);
  assert.equal(system, "You are a researcher.");
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("toAnthropicRequest merges consecutive same-role messages (strict alternation)", () => {
  const { messages } = toAnthropicRequest([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.deepEqual(
    messages[0].content.map((b) => b.text),
    ["a", "b"],
  );
});

test("toAnthropicRequest converts data-URL images to base64 source blocks", () => {
  const { messages } = toAnthropicRequest([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);
  const img = messages[0].content[1];
  assert.deepEqual(img, {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
});

test("toAnthropicRequest drops empty text parts, unknown parts, and non-data-URL images", () => {
  const { system, messages } = toAnthropicRequest([
    { role: "user", content: [{ type: "text", text: "" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
    { role: "user", content: "real question" },
  ]);
  assert.equal(system, undefined);
  // The first message had no usable blocks and is dropped; the second stands.
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].text, "real question");
});

// ---- SSE transcoding, verified through the shared consumer -------------------

function anthropicSse(events) {
  const encoder = new TextEncoder();
  const body = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      // Split into a couple of chunks to exercise the line-buffer carry.
      const mid = Math.floor(body.length / 2);
      controller.enqueue(encoder.encode(body.slice(0, mid)));
      controller.enqueue(encoder.encode(body.slice(mid)));
      controller.close();
    },
  });
}

test("anthropicToOpenAiSse output satisfies consumeChatStream: text, usage, finish_reason", async () => {
  const stream = anthropicSse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]).pipeThrough(anthropicToOpenAiSse());

  const chunks = [];
  const { text, usage, finishReason } = await consumeChatStream(stream, (t) => chunks.push(t));
  assert.equal(text, "Hello world");
  assert.deepEqual(chunks, ["Hello", " world"]);
  assert.equal(finishReason, "stop");
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 15);
});

test("anthropicToOpenAiSse maps max_tokens to finish_reason length and ignores thinking deltas", async () => {
  const stream = anthropicSse([
    { type: "message_start", message: { usage: { input_tokens: 4 } } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial" } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } },
    { type: "message_stop" },
  ]).pipeThrough(anthropicToOpenAiSse());

  const { text, finishReason } = await consumeChatStream(stream, () => {});
  assert.equal(text, "partial");
  assert.equal(finishReason, "length");
});

test("a dropped Anthropic stream (no message_stop) yields no finish_reason — the dropped-connection tell", async () => {
  const stream = anthropicSse([
    { type: "message_start", message: { usage: { input_tokens: 4 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "trunc" } },
  ]).pipeThrough(anthropicToOpenAiSse());

  const { text, finishReason } = await consumeChatStream(stream, () => {});
  assert.equal(text, "trunc");
  assert.equal(finishReason, null);
});

test("an Anthropic error event fails the stream with a catchable Error", async () => {
  const stream = anthropicSse([
    { type: "message_start", message: { usage: { input_tokens: 4 } } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  ]).pipeThrough(anthropicToOpenAiSse());

  await assert.rejects(() => consumeChatStream(stream, () => {}), /Overloaded/);
});

// ---- chatCompletion error passthrough ----------------------------------------

test("chatCompletion passes non-2xx responses through untransformed for diagnostics", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
      status: 401,
    });
  try {
    const resp = await chatCompletion(
      { ANTHROPIC_API_KEY: "bad" },
      [{ role: "user", content: "x" }],
      { model: "claude-haiku-4-5" },
    );
    assert.equal(resp.ok, false);
    assert.equal(resp.status, 401);
    assert.match(await resp.text(), /invalid x-api-key/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
