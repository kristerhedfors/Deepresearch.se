import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  FREE_PROVIDERS,
  buildFreePayload,
  configuredFreeProviders,
  extractJson,
  freeChatStream,
  freeCompleteJson,
  freeProvider,
  listFreeModels,
} from "./free-providers.js";

test("the registry holds exactly the CORS-capable providers", () => {
  assert.deepEqual(FREE_PROVIDERS.map((p) => p.id), ["openai", "groq"]);
  assert.equal(freeProvider("openai").label, "OpenAI");
  assert.equal(freeProvider("groq").label, "Groq");
  assert.equal(freeProvider("anthropic"), null); // no browser CORS — not in this registry
  for (const p of FREE_PROVIDERS) {
    assert.ok(p.jsonModel, p.id + " needs a JSON-phase default model");
    assert.ok(p.fallbackModels.length, p.id + " needs a fallback catalog");
  }
});

test("configuredFreeProviders follows the stored keys", () => {
  assert.deepEqual(configuredFreeProviders({}).map((p) => p.id), []);
  assert.deepEqual(configuredFreeProviders({ groq: "gsk" }).map((p) => p.id), ["groq"]);
  assert.deepEqual(configuredFreeProviders({ openai: "sk", groq: "gsk" }).map((p) => p.id), ["openai", "groq"]);
  assert.deepEqual(configuredFreeProviders({ openai: "" }).map((p) => p.id), []);
});

test("buildFreePayload carries each provider's wire quirks", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const openai = buildFreePayload(freeProvider("openai"), "gpt-5.6-terra", msgs, { json: true, maxTokens: 500 });
  assert.equal(openai.max_completion_tokens, 500);
  assert.equal(openai.reasoning_effort, "none");
  assert.deepEqual(openai.response_format, { type: "json_object" });
  assert.equal(openai.stream, false);

  const groq = buildFreePayload(freeProvider("groq"), "llama-3.3-70b-versatile", msgs, { stream: true });
  assert.equal(groq.max_tokens, 4096);
  assert.equal(groq.max_completion_tokens, undefined);
  assert.equal(groq.response_format, undefined);
  assert.equal(groq.stream, true);
});

test("extractJson forgives fences and prose, rejects garbage", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
});

test("model filters keep chat models, drop the rest", () => {
  const openai = freeProvider("openai");
  assert.equal(openai.modelFilter("gpt-5.6-terra"), true);
  assert.equal(openai.modelFilter("gpt-4o-audio-preview"), false);
  assert.equal(openai.modelFilter("text-embedding-3-large"), false);
  const groq = freeProvider("groq");
  assert.equal(groq.modelFilter("llama-3.3-70b-versatile"), true);
  assert.equal(groq.modelFilter("whisper-large-v3"), false);
  assert.equal(groq.modelFilter("llama-guard-3-8b"), false);
});

describe("provider calls over mock HTTP", () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url.endsWith("/models")) {
        if (req.headers.authorization !== "Bearer good-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "llama-3.3-70b-versatile" }, { id: "whisper-large-v3" }, { id: "llama-3.1-8b-instant" }],
          }),
        );
        return;
      }
      const body = JSON.parse(raw);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n');
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("listFreeModels: live list filtered; fallback catalog on a rejected key", async () => {
    const groq = freeProvider("groq");
    const live = await listFreeModels(groq, "good-key", { baseUrl });
    assert.deepEqual(live, ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]); // whisper filtered, sorted
    const fallback = await listFreeModels(groq, "bad-key", { baseUrl });
    assert.deepEqual(fallback, groq.fallbackModels);
  });

  test("freeCompleteJson: bearer auth, JSON mode requested, fenced JSON parsed", async () => {
    const groq = freeProvider("groq");
    const value = await freeCompleteJson(groq, "good-key", "llama-3.1-8b-instant", [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    const req = requests.at(-1);
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.model, "llama-3.1-8b-instant");
  });

  test("freeChatStream: returns the provider's SSE response as-is", async () => {
    const groq = freeProvider("groq");
    const res = await freeChatStream(groq, "good-key", "llama-3.3-70b-versatile", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    assert.equal(requests.at(-1).body.stream, true);
  });
});
