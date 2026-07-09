import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  isOpenAiModel,
  openaiChatCompletion,
  openaiCompleteJson,
  openaiModels,
  toOpenAiPayload,
} from "./openai.js";
import { consumeChatStream } from "./berget.js";

// Builds a mock OpenAI Chat Completions SSE body (the native wire format —
// no adapter exists for this provider, so what these chunks assert is the
// no-adapter assumption itself: the raw body must satisfy berget.js's
// consumeChatStream, the exact composition production uses).
function openaiSseLines(chunks) {
  return chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
}

function sseBody(chunks) {
  const encoder = new TextEncoder();
  const payload = encoder.encode(openaiSseLines(chunks));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
}

const contentChunk = (text) => ({ choices: [{ delta: { content: text } }] });
const finishChunk = (reason = "stop") => ({ choices: [{ delta: {}, finish_reason: reason }] });
// With stream_options.include_usage, OpenAI ends with an empty-choices
// usage chunk — the same shape as Berget's, which consumeChatStream merges.
const usageChunk = (p = 12, c = 7) => ({
  choices: [],
  usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});

describe("isOpenAiModel", () => {
  test("bare gpt-* ids route to OpenAI; Berget's openai/-path lookalikes do not", () => {
    assert.equal(isOpenAiModel("gpt-5.6-sol"), true);
    assert.equal(isOpenAiModel("gpt-5.4-mini"), true);
    assert.equal(isOpenAiModel("openai/gpt-oss-120b"), false); // Berget-hosted, vendor-path id
    assert.equal(isOpenAiModel("claude-sonnet-5"), false);
    assert.equal(isOpenAiModel("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), false);
    assert.equal(isOpenAiModel(undefined), false);
    assert.equal(isOpenAiModel(null), false);
  });
});

describe("openaiModels", () => {
  test("empty without the OPENAI_API_KEY secret (feature invisible)", () => {
    assert.deepEqual(openaiModels({}), []);
  });

  test("with the key: the GPT lineup in ModelCatalogEntry shape, EUR-priced, vision, up", () => {
    const models = openaiModels({ OPENAI_API_KEY: "k" });
    assert.deepEqual(
      models.map((m) => m.id),
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"],
    );
    for (const m of models) {
      assert.equal(m.up, true);
      assert.equal(m.vision, true);
      assert.equal(m.provider, "openai");
      assert.ok(m.price_in > 0 && m.price_out > m.price_in, `${m.id} priced`);
      assert.match(m.pricing, /€.* in \/ €.* out per 1M tokens/);
    }
    // Relative pricing sanity: sol > terra > luna > mini.
    const outs = models.map((m) => m.price_out);
    assert.deepEqual([...outs].sort((a, b) => b - a), outs);
  });
});

describe("toOpenAiPayload", () => {
  test("GPT-5-era wire params: max_completion_tokens (never max_tokens), reasoning pinned off", () => {
    const p = toOpenAiPayload([{ role: "user", content: "q" }], { model: "gpt-5.6-terra" });
    assert.equal(p.model, "gpt-5.6-terra");
    assert.equal(p.max_completion_tokens, 4096);
    assert.equal("max_tokens" in p, false);
    // Hidden reasoning spends output tokens inside max_completion_tokens and
    // stalls the first delta — pinned off, the same call anthropic.js makes
    // for Sonnet 5's adaptive thinking.
    assert.equal(p.reasoning_effort, "none");
  });

  test("messages pass through untouched — the project's arrays are already OpenAI-shaped", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        ],
      },
    ];
    const p = toOpenAiPayload(messages, { model: "gpt-5.6-sol" });
    assert.equal(p.messages, messages);
  });

  test("streaming requests the usage chunk; non-streaming does not", () => {
    const streaming = toOpenAiPayload([{ role: "user", content: "q" }], { model: "gpt-5.6-luna", stream: true });
    assert.equal(streaming.stream, true);
    assert.deepEqual(streaming.stream_options, { include_usage: true });
    const plain = toOpenAiPayload([{ role: "user", content: "q" }], { model: "gpt-5.6-luna" });
    assert.equal("stream_options" in plain, false);
  });

  test("json flag requests json_object; maxTokens rides through", () => {
    const p = toOpenAiPayload([{ role: "user", content: "q" }], { model: "gpt-5.4-mini", maxTokens: 900, json: true });
    assert.equal(p.max_completion_tokens, 900);
    assert.deepEqual(p.response_format, { type: "json_object" });
    assert.equal("response_format" in toOpenAiPayload([], { model: "gpt-5.4-mini" }), false);
  });
});

describe("native OpenAI SSE → consumeChatStream (the no-adapter assumption)", () => {
  test("text deltas, finish_reason and the trailing usage chunk arrive intact", async () => {
    const body = sseBody([contentChunk("Hel"), contentChunk("lo"), finishChunk("stop"), usageChunk(12, 7), "[DONE]"]);
    const seen = [];
    const out = await consumeChatStream(body, (t) => seen.push(t));
    assert.equal(out.text, "Hello");
    assert.deepEqual(seen, ["Hel", "lo"]);
    assert.equal(out.finishReason, "stop");
    assert.equal(out.usage.prompt_tokens, 12);
    assert.equal(out.usage.completion_tokens, 7);
  });

  test("a stream that dies early yields NO finish_reason — the dropped-connection tell", async () => {
    // pipeline.js throws on a falsy finishReason; a GPT stream cut before
    // its closing chunk must present the same signature as Berget's.
    const body = sseBody([contentChunk("partial")]);
    const out = await consumeChatStream(body, () => {});
    assert.equal(out.text, "partial");
    assert.equal(out.finishReason, null);
  });
});

// Mock-HTTP smoke (rung 2 of the add-llm-provider validation ladder): a
// real node:http server behind the OPENAI_URL override, driven end to end
// through openaiChatCompletion → consumeChatStream and openaiCompleteJson —
// verifies auth headers, the wire payload, and the stream plumbing over
// real HTTP, not just in-memory streams.
describe("openai client over mock HTTP", () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(openaiSseLines([contentChunk("live "), contentChunk("answer"), finishChunk("stop"), usageChunk(20, 4), "[DONE]"]));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"queries":["a"]}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 9, completion_tokens: 5 },
          }),
        );
      }
    });
  });
  const env = { OPENAI_API_KEY: "sk-test" };
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.OPENAI_URL = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("openaiChatCompletion: bearer auth, GPT wire params, and a body consumeChatStream reads", async () => {
    const resp = await openaiChatCompletion(env, [{ role: "user", content: "hi" }], { model: "gpt-5.6-terra" });
    assert.equal(resp.ok, true);
    const out = await consumeChatStream(resp.body, () => {});
    assert.equal(out.text, "live answer");
    assert.equal(out.finishReason, "stop");
    assert.deepEqual(out.usage, { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });

    const req = requests.at(-1);
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.equal(req.body.model, "gpt-5.6-terra");
    assert.equal(req.body.max_completion_tokens, 4096);
    assert.equal(req.body.reasoning_effort, "none");
    assert.deepEqual(req.body.stream_options, { include_usage: true });
  });

  test("openaiCompleteJson: json_object requested, { value, usage, diagnostics } returned", async () => {
    const out = await openaiCompleteJson(env, [{ role: "user", content: "plan" }], { model: "gpt-5.4-mini", maxTokens: 300 });
    assert.deepEqual(out.value, { queries: ["a"] });
    assert.deepEqual(out.usage, { prompt_tokens: 9, completion_tokens: 5 });
    assert.equal(out.diagnostics.parse_mode, "strict");
    assert.equal(out.diagnostics.finish_reason, "stop");

    const req = requests.at(-1);
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.max_completion_tokens, 300);
    assert.equal(req.body.stream, false);
  });
});
