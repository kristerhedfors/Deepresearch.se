// Unit tests for the LLM provider router (src/llm.js): dispatch by model id
// and the merged catalog. Network is stubbed via globalThis.fetch — the
// routing decision is what's under test, not the providers.

import assert from "node:assert/strict";
import { test } from "node:test";

import { completeJson, listModels } from "./llm.js";

const ENV = { ANTHROPIC_API_KEY: "ak", BERGET_API_TOKEN: "bt" };

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => (globalThis.fetch = orig);
}

test("listModels merges the Berget catalog with the Anthropic models", async () => {
  const restore = stubFetch(async (url) => {
    assert.match(String(url), /api\.berget\.ai\/v1\/models/);
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
            name: "Mistral Small",
            model_type: "text",
            capabilities: { streaming: true, json_mode: true, vision: false },
            pricing: { input: 3e-7, output: 3e-7, currency: "EUR" },
            status: { up: true },
          },
        ],
      }),
      { status: 200 },
    );
  });
  try {
    const models = await listModels(ENV);
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("mistralai/Mistral-Small-3.2-24B-Instruct-2506"));
    assert.ok(ids.includes("claude-opus-4-8"));
    assert.ok(ids.includes("claude-sonnet-5"));
    assert.ok(ids.includes("claude-haiku-4-5"));
    // Berget entries come first: the dropdown keeps its familiar order and
    // the default model stays at the top of the list.
    assert.ok(ids.indexOf("mistralai/Mistral-Small-3.2-24B-Instruct-2506") < ids.indexOf("claude-opus-4-8"));
  } finally {
    restore();
  }
});

test("completeJson routes claude-* to Anthropic and everything else to Berget", async () => {
  const urls = [];
  const restore = stubFetch(async (url, init) => {
    urls.push(String(url));
    if (String(url).includes("api.anthropic.com")) {
      // Anthropic must be called with its native auth + version headers.
      assert.equal(init.headers["x-api-key"], "ak");
      assert.equal(init.headers["anthropic-version"], "2023-06-01");
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"provider":"anthropic"}' }],
          usage: { input_tokens: 7, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    }
    assert.equal(init.headers.authorization, "Bearer bt");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"provider":"berget"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200 },
    );
  });
  try {
    const a = await completeJson(ENV, [{ role: "user", content: "x" }], { model: "claude-haiku-4-5" });
    assert.equal(a.value.provider, "anthropic");
    assert.deepEqual(a.usage, { prompt_tokens: 7, completion_tokens: 3 });
    assert.equal(a.diagnostics.parse_mode, "strict");
    assert.equal(a.diagnostics.finish_reason, "stop");

    const b = await completeJson(ENV, [{ role: "user", content: "x" }], {
      model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    });
    assert.equal(b.value.provider, "berget");

    assert.match(urls[0], /api\.anthropic\.com\/v1\/messages/);
    assert.match(urls[1], /api\.berget\.ai\/v1\/chat\/completions/);
  } finally {
    restore();
  }
});
