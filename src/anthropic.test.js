import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  anthropicModels,
  anthropicToolRun,
  isAnthropicModel,
  oaiChunksFromEvent,
  openAiStreamFromAnthropic,
  toAnthropicPayload,
} from "./anthropic.js";
import { consumeChatStream } from "./berget.js";

// Builds a mock Anthropic SSE body from event objects (the shape the
// Messages API streams), so the adapter can be tested end-to-end through
// berget.js's consumeChatStream — the exact composition production uses.
function anthropicSseBody(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  return new ReadableStream({
    pull(controller) {
      if (!chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks.shift()));
    },
  });
}

const messageStart = (input = 12) => ({
  type: "message_start",
  message: { usage: { input_tokens: input, output_tokens: 1 } },
});
const textDelta = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const messageDelta = (stop = "end_turn", output = 7) => ({
  type: "message_delta",
  delta: { stop_reason: stop },
  usage: { output_tokens: output },
});

describe("isAnthropicModel", () => {
  test("claude-* ids route to Anthropic; Berget paths and junk do not", () => {
    assert.equal(isAnthropicModel("claude-opus-4-8"), true);
    assert.equal(isAnthropicModel("claude-sonnet-5"), true);
    assert.equal(isAnthropicModel("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), false);
    assert.equal(isAnthropicModel(undefined), false);
    assert.equal(isAnthropicModel(null), false);
  });
});

describe("anthropicModels", () => {
  test("empty without the ANTHROPIC_API_KEY secret (feature invisible)", () => {
    assert.deepEqual(anthropicModels({}), []);
  });

  test("with the key: opus/sonnet/haiku in ModelCatalogEntry shape, EUR-priced, vision, up", () => {
    const models = anthropicModels({ ANTHROPIC_API_KEY: "k" });
    assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
    for (const m of models) {
      assert.equal(m.up, true);
      assert.equal(m.vision, true);
      assert.equal(m.provider, "anthropic");
      assert.ok(m.price_in > 0 && m.price_out > m.price_in, `${m.id} priced`);
      assert.match(m.pricing, /€.* in \/ €.* out per 1M tokens/);
    }
    // Relative pricing sanity: opus > sonnet > haiku.
    const [opus, sonnet, haiku] = models;
    assert.ok(opus.price_out > sonnet.price_out && sonnet.price_out > haiku.price_out);
  });
});

describe("toAnthropicPayload", () => {
  test("system turns become the top-level system field; user/assistant pass through", () => {
    const p = toAnthropicPayload(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
      { model: "claude-opus-4-8" },
    );
    assert.equal(p.model, "claude-opus-4-8");
    assert.equal(p.system, "You are helpful.");
    assert.deepEqual(
      p.messages.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.deepEqual(p.messages[0].content, [{ type: "text", text: "hi" }]);
  });

  test("consecutive same-role messages merge into one alternating turn", () => {
    const p = toAnthropicPayload(
      [
        { role: "user", content: "part one" },
        { role: "user", content: "part two" },
      ],
      { model: "claude-haiku-4-5" },
    );
    assert.equal(p.messages.length, 1);
    assert.deepEqual(p.messages[0].content.map((b) => b.text), ["part one", "part two"]);
  });

  test("image data URLs convert to base64 source blocks; malformed parts are dropped", () => {
    const p = toAnthropicPayload(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
        },
      ],
      { model: "claude-opus-4-8" },
    );
    assert.deepEqual(p.messages[0].content, [
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
  });

  test("sonnet-5 gets thinking explicitly disabled (adaptive-by-default model); others omit it", () => {
    // Sonnet 5 runs ADAPTIVE thinking when the param is omitted — hidden
    // token spend inside max_tokens and a long silent pause before the
    // first delta, both bad for the budget planner and the idle guard.
    const sonnet = toAnthropicPayload([{ role: "user", content: "q" }], { model: "claude-sonnet-5" });
    assert.deepEqual(sonnet.thinking, { type: "disabled" });
    const opus = toAnthropicPayload([{ role: "user", content: "q" }], { model: "claude-opus-4-8" });
    assert.equal("thinking" in opus, false);
    const haiku = toAnthropicPayload([{ role: "user", content: "q" }], { model: "claude-haiku-4-5" });
    assert.equal("thinking" in haiku, false);
  });

  test("stream flag and max_tokens ride through", () => {
    const p = toAnthropicPayload([{ role: "user", content: "q" }], {
      model: "claude-opus-4-8",
      stream: true,
      maxTokens: 900,
    });
    assert.equal(p.stream, true);
    assert.equal(p.max_tokens, 900);
  });
});

describe("openAiStreamFromAnthropic → consumeChatStream (the production composition)", () => {
  test("text deltas, usage and finish_reason arrive in the OpenAI shape", async () => {
    const body = openAiStreamFromAnthropic(
      anthropicSseBody([
        messageStart(12),
        { type: "ping" },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        textDelta("Hel"),
        textDelta("lo"),
        { type: "content_block_stop", index: 0 },
        messageDelta("end_turn", 7),
        { type: "message_stop" },
      ]),
    );
    const seen = [];
    const out = await consumeChatStream(body, (t) => seen.push(t));
    assert.equal(out.text, "Hello");
    assert.deepEqual(seen, ["Hel", "lo"]);
    assert.equal(out.finishReason, "stop"); // end_turn mapped
    assert.equal(out.usage.prompt_tokens, 12);
    assert.equal(out.usage.completion_tokens, 7);
  });

  test("max_tokens stop_reason maps to finish_reason length", async () => {
    const body = openAiStreamFromAnthropic(
      anthropicSseBody([messageStart(), textDelta("x"), messageDelta("max_tokens", 3), { type: "message_stop" }]),
    );
    const out = await consumeChatStream(body, () => {});
    assert.equal(out.finishReason, "length");
  });

  test("a missing message_delta yields NO finish_reason — the dropped-connection tell survives adaptation", async () => {
    // pipeline.js throws on a falsy finishReason; a Claude stream that dies
    // before message_delta must present the same signature.
    const body = openAiStreamFromAnthropic(anthropicSseBody([messageStart(), textDelta("partial")]));
    const out = await consumeChatStream(body, () => {});
    assert.equal(out.text, "partial");
    assert.equal(out.finishReason, null);
  });

  test("an Anthropic error event errors the stream (catchable by the pipeline's retry path)", async () => {
    const body = openAiStreamFromAnthropic(
      anthropicSseBody([messageStart(), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]),
    );
    await assert.rejects(consumeChatStream(body, () => {}), /Anthropic stream error: Overloaded/);
  });

  test("thinking deltas are dropped — only text reaches the client", async () => {
    const body = openAiStreamFromAnthropic(
      anthropicSseBody([
        messageStart(),
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
        textDelta("answer"),
        messageDelta(),
        { type: "message_stop" },
      ]),
    );
    const out = await consumeChatStream(body, () => {});
    assert.equal(out.text, "answer");
  });
});

describe("oaiChunksFromEvent", () => {
  test("message_delta without a stop_reason emits nothing but still accumulates usage", () => {
    const usage = { prompt_tokens: 5, completion_tokens: 0 };
    const chunks = oaiChunksFromEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 4 } }, usage);
    assert.deepEqual(chunks, []);
    assert.equal(usage.completion_tokens, 4);
  });

  test("unknown future event types are ignored (forward compatibility)", () => {
    assert.deepEqual(oaiChunksFromEvent({ type: "some_future_event" }, { prompt_tokens: 0, completion_tokens: 0 }), []);
  });
});

// The native TOOL-USE loop (anthropicToolRun) over a real node:http mock of the
// Messages API: round 1 returns a tool_use block, we execute it, round 2 sees
// the tool_result and returns the final text (end_turn). Verifies the loop
// executes tools, pairs tool_result by id, sums usage across rounds, and returns
// the answer — the invariant-1 exception path (src/introspect-tools.js).
describe("anthropicToolRun over mock HTTP", () => {
  const requests = [];
  let round = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      round++;
      res.writeHead(200, { "content-type": "application/json" });
      if (round === 1) {
        res.end(
          JSON.stringify({
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "let me look" },
              { type: "tool_use", id: "tu_1", name: "grep_source", input: { pattern: "SESSION_SECRET" } },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Final: SESSION_SECRET gates auth in src/auth.js." }],
            usage: { input_tokens: 20, output_tokens: 8 },
          }),
        );
      }
    });
  });
  const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.ANTHROPIC_URL = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test("drives tool calls, feeds results back, and returns the final answer", async () => {
    const executed = [];
    const result = await anthropicToolRun(env, {
      model: "claude-sonnet-5",
      system: "investigate",
      userContent: "assess auth",
      tools: [{ name: "grep_source", description: "grep", input_schema: { type: "object", properties: {} } }],
      execTool: (name, input) => {
        executed.push({ name, input });
        return "src/auth.js:3: if (!env.SESSION_SECRET) return [];";
      },
    });

    // The tool was executed with the model's requested input.
    assert.deepEqual(executed, [{ name: "grep_source", input: { pattern: "SESSION_SECRET" } }]);
    // Final answer + counters.
    assert.match(result.text, /SESSION_SECRET gates auth/);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.rounds, 2);
    // Usage summed across both rounds.
    assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 12 });

    // Round 2's request echoed the assistant tool_use turn and a paired
    // tool_result keyed by the tool_use id.
    const second = requests.at(-1);
    const roles = second.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "user"]);
    const toolResult = second.messages[2].content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "tu_1");
    assert.match(toolResult.content, /SESSION_SECRET/);
    // Auth + system carried on every call.
    assert.equal(requests[0].system, "investigate");
    assert.equal(requests.at(-1).model, "claude-sonnet-5");
  });
});
