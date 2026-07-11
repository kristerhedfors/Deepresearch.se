import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  DRC_PROVIDERS,
  buildDrcPayload,
  configuredDrcProviders,
  extractJson,
  drcChatStream,
  drcCompleteJson,
  drcEmbed,
  drcEmbedProvider,
  drcProvider,
  listDrcModels,
} from "./drc-providers.js";

test("the registry holds exactly the CORS-capable providers", () => {
  assert.deepEqual(DRC_PROVIDERS.map((p) => p.id), ["openai", "groq", "berget"]);
  assert.equal(drcProvider("openai").label, "OpenAI");
  assert.equal(drcProvider("groq").label, "Groq");
  assert.equal(drcProvider("berget").label, "Berget"); // CORS confirmed live 2026-07-11
  assert.equal(drcProvider("anthropic"), null); // no browser CORS — not in this registry
  for (const p of DRC_PROVIDERS) {
    assert.ok(p.jsonModel, p.id + " needs a JSON-phase default model");
    assert.ok(p.fallbackModels.length, p.id + " needs a fallback catalog");
  }
});

test("Berget's JSON-phase model mirrors the server's DEFAULT_MODEL choice", () => {
  // The client-side split-model-routing mirror keeps planning on the one
  // Berget model with an evidence trail (src/berget.js's DEFAULT_MODEL).
  assert.equal(drcProvider("berget").jsonModel, "mistralai/Mistral-Small-3.2-24B-Instruct-2506");
  assert.ok(drcProvider("berget").fallbackModels.includes("mistralai/Mistral-Small-3.2-24B-Instruct-2506"));
});

test("the embedding config is the SMALL, dimension-reduced choice", () => {
  // Latency + localStorage discipline: never the large embedding model.
  const openai = drcProvider("openai");
  assert.equal(openai.embed.model, "text-embedding-3-small");
  assert.equal(openai.embed.dimensions, 512);
  assert.equal(drcProvider("groq").embed, undefined); // Groq serves no /embeddings
  // Berget serves /embeddings (e5) but joining RAG needs the passage:/query:
  // prefix convention + 1024-dim storage — deliberately not declared yet.
  assert.equal(drcProvider("berget").embed, undefined);
});

test("drcEmbedProvider: the first embeddings-capable provider with a key", () => {
  assert.equal(drcEmbedProvider({}), null);
  assert.equal(drcEmbedProvider({ groq: "gsk" }), null); // a Groq-only session has no RAG
  assert.equal(drcEmbedProvider({ berget: "bk" }), null); // a Berget-only session too (no embed entry yet)
  assert.equal(drcEmbedProvider({ openai: "sk" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "sk", groq: "gsk" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "" }), null);
});

test("configuredDrcProviders follows the stored keys", () => {
  assert.deepEqual(configuredDrcProviders({}).map((p) => p.id), []);
  assert.deepEqual(configuredDrcProviders({ groq: "gsk" }).map((p) => p.id), ["groq"]);
  assert.deepEqual(configuredDrcProviders({ openai: "sk", groq: "gsk" }).map((p) => p.id), ["openai", "groq"]);
  assert.deepEqual(
    configuredDrcProviders({ openai: "sk", groq: "gsk", berget: "bk" }).map((p) => p.id),
    ["openai", "groq", "berget"],
  );
  assert.deepEqual(configuredDrcProviders({ berget: "bk" }).map((p) => p.id), ["berget"]);
  assert.deepEqual(configuredDrcProviders({ openai: "" }).map((p) => p.id), []);
});

test("buildDrcPayload carries each provider's wire quirks", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const openai = buildDrcPayload(drcProvider("openai"), "gpt-5.6-terra", msgs, { json: true, maxTokens: 500 });
  assert.equal(openai.max_completion_tokens, 500);
  assert.equal(openai.reasoning_effort, "none");
  assert.deepEqual(openai.response_format, { type: "json_object" });
  assert.equal(openai.stream, false);

  const groq = buildDrcPayload(drcProvider("groq"), "llama-3.3-70b-versatile", msgs, { stream: true });
  assert.equal(groq.max_tokens, 4096);
  assert.equal(groq.max_completion_tokens, undefined);
  assert.equal(groq.response_format, undefined);
  assert.equal(groq.stream, true);

  // Berget: the plain OpenAI wire, same params src/berget.js sends.
  const berget = buildDrcPayload(drcProvider("berget"), "mistralai/Mistral-Small-3.2-24B-Instruct-2506", msgs, {
    json: true,
    maxTokens: 1500,
  });
  assert.equal(berget.max_tokens, 1500);
  assert.equal(berget.max_completion_tokens, undefined);
  assert.equal(berget.reasoning_effort, undefined);
  assert.deepEqual(berget.response_format, { type: "json_object" });
});

test("extractJson forgives fences and prose, rejects garbage", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
});

test("model filters are CURATED: recent language models only", () => {
  const openai = drcProvider("openai");
  assert.equal(openai.modelFilter("gpt-5.6-terra"), true);
  assert.equal(openai.modelFilter("gpt-5.5"), true);
  assert.equal(openai.modelFilter("gpt-5.4-mini"), true);
  assert.equal(openai.modelFilter("gpt-5.5-nano"), true);
  // legacy generations and non-chat modalities never show
  assert.equal(openai.modelFilter("gpt-4o"), false);
  assert.equal(openai.modelFilter("gpt-4o-mini"), false);
  assert.equal(openai.modelFilter("gpt-3.5-turbo"), false);
  assert.equal(openai.modelFilter("o3-mini"), false);
  assert.equal(openai.modelFilter("gpt-5.5-audio-preview"), false);
  assert.equal(openai.modelFilter("text-embedding-3-large"), false);
  const groq = drcProvider("groq");
  assert.equal(groq.modelFilter("llama-3.3-70b-versatile"), true);
  assert.equal(groq.modelFilter("llama-3.1-8b-instant"), true);
  assert.equal(groq.modelFilter("openai/gpt-oss-120b"), true);
  assert.equal(groq.modelFilter("moonshotai/kimi-k2-instruct"), true);
  assert.equal(groq.modelFilter("llama-3.1-70b-versatile"), false); // superseded generation
  assert.equal(groq.modelFilter("whisper-large-v3"), false);
  assert.equal(groq.modelFilter("llama-guard-3-8b"), false);
  assert.equal(groq.modelFilter("gemma2-9b-it"), false);

  // Berget's catalog is small and already curated — the filter's job is
  // excluding its non-chat modalities (ids from the live catalog 2026-07-11).
  const berget = drcProvider("berget");
  assert.equal(berget.modelFilter("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), true);
  assert.equal(berget.modelFilter("moonshotai/Kimi-K2.6"), true);
  assert.equal(berget.modelFilter("zai-org/GLM-4.7-FP8"), true);
  assert.equal(berget.modelFilter("openai/gpt-oss-120b"), true);
  assert.equal(berget.modelFilter("meta-llama/Llama-3.3-70B-Instruct"), true);
  assert.equal(berget.modelFilter("KBLab/kb-whisper-large"), false);
  assert.equal(berget.modelFilter("Systran/faster-whisper-large-v3"), false);
  assert.equal(berget.modelFilter("BAAI/bge-reranker-v2-m3"), false);
  assert.equal(berget.modelFilter("intfloat/multilingual-e5-large-instruct"), false);
  assert.equal(berget.modelFilter("intfloat/multilingual-e5-large"), false);
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
      if (req.url.endsWith("/embeddings")) {
        const body = JSON.parse(raw);
        // deliberately out of order — drcEmbed must sort by index
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: body.input
              .map((_, i) => ({ index: i, embedding: [i + 0.5, 0, 0] }))
              .reverse(),
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

  test("listDrcModels: live list filtered; fallback catalog on a rejected key", async () => {
    const groq = drcProvider("groq");
    const live = await listDrcModels(groq, "good-key", { baseUrl });
    assert.deepEqual(live, ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]); // whisper filtered, newest first
    const fallback = await listDrcModels(groq, "bad-key", { baseUrl });
    assert.deepEqual(fallback, groq.fallbackModels);
  });

  test("drcCompleteJson: bearer auth, JSON mode requested, fenced JSON parsed", async () => {
    const groq = drcProvider("groq");
    const value = await drcCompleteJson(groq, "good-key", "llama-3.1-8b-instant", [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    const req = requests.at(-1);
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.model, "llama-3.1-8b-instant");
  });

  test("drcEmbed: small model + dimensions on the wire, vectors back in input order", async () => {
    const openai = drcProvider("openai");
    const { vectors, dims, model } = await drcEmbed(openai, "good-key", ["one", "two", "three"], { baseUrl });
    assert.equal(model, "text-embedding-3-small");
    assert.equal(dims, 3);
    // the mock returned them reversed; drcEmbed re-sorts by index
    assert.deepEqual(vectors.map((v) => v[0]), [0.5, 1.5, 2.5]);
    const req = requests.at(-1);
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.equal(req.body.model, "text-embedding-3-small");
    assert.equal(req.body.dimensions, 512);
    assert.equal(req.body.encoding_format, "float");
    assert.deepEqual(req.body.input, ["one", "two", "three"]);
    // a provider without an embed entry refuses up front
    await assert.rejects(drcEmbed(drcProvider("groq"), "k", ["x"], { baseUrl }), /no embeddings/);
  });

  test("drcChatStream: returns the provider's SSE response as-is", async () => {
    const groq = drcProvider("groq");
    const res = await drcChatStream(groq, "good-key", "llama-3.3-70b-versatile", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    assert.equal(requests.at(-1).body.stream, true);
  });

  test("Berget over mock HTTP: bearer auth + the plain OpenAI wire", async () => {
    const berget = drcProvider("berget");
    const res = await drcChatStream(
      berget,
      "good-key",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      [{ role: "user", content: "x" }],
      { baseUrl },
    );
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    const req = requests.at(-1);
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.equal(req.body.max_tokens, 4096);
    assert.equal(req.body.max_completion_tokens, undefined);

    const value = await drcCompleteJson(berget, "good-key", berget.jsonModel, [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(requests.at(-1).body.response_format, { type: "json_object" });
  });
});
