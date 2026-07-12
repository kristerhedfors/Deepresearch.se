import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  DRC_PROVIDERS,
  buildDrcPayload,
  configuredDrcProviders,
  detectDrcProvider,
  drcBaseFor,
  drcBaseValid,
  extractJson,
  drcChatStream,
  drcCompleteJson,
  drcEmbed,
  drcEmbedProvider,
  drcProvider,
  listDrcModels,
  normalizeDrcBase,
} from "./drc-providers.js";

test("the registry holds exactly the three boundary choices", () => {
  // 2026-07-12 directive: OpenAI, Berget, or a user-supplied Local
  // endpoint — the places the tier's ONE external dataflow may point.
  assert.deepEqual(DRC_PROVIDERS.map((p) => p.id), ["openai", "berget", "local"]);
  assert.equal(drcProvider("openai").label, "OpenAI");
  assert.equal(drcProvider("berget").label, "Berget"); // CORS confirmed live 2026-07-11
  assert.equal(drcProvider("local").label, "Local");
  assert.equal(drcProvider("groq"), null); // dropped 2026-07-12
  assert.equal(drcProvider("anthropic"), null); // no browser CORS — not in this registry
  for (const p of DRC_PROVIDERS) {
    if (p.requiresBase) continue; // Local: catalog and planning model come from the user's server
    assert.ok(p.jsonModel, p.id + " needs a JSON-phase default model");
    assert.ok(p.fallbackModels.length, p.id + " needs a fallback catalog");
  }
});

test("the Local entry is the user-supplied-endpoint shape", () => {
  const local = drcProvider("local");
  assert.equal(local.requiresBase, true);
  assert.equal(local.keyOptional, true); // most local servers ignore auth
  assert.equal(local.keyPattern, null); // nothing to auto-detect
  assert.equal(local.jsonModel, null); // planning degrades to the chosen model
  assert.deepEqual(local.fallbackModels, []); // the live /models list is the only catalog
  assert.equal(local.base, "");
  assert.equal(local.embed, undefined); // a Local-only session runs without RAG
});

test("detectDrcProvider identifies a pasted key by its prefix", () => {
  // OpenAI: sk-… in all its variants (hyphen).
  assert.equal(detectDrcProvider("sk-abc123").id, "openai");
  assert.equal(detectDrcProvider("sk-proj-abc123").id, "openai");
  assert.equal(detectDrcProvider("sk-svcacct-abc123").id, "openai");
  // Berget: sk_ber_… (underscore — never collides with OpenAI's sk-).
  assert.equal(detectDrcProvider("sk_ber_abc123").id, "berget");
  // Whitespace from a paste is forgiven.
  assert.equal(detectDrcProvider("  sk_ber_abc123\n").id, "berget");
  // Unknown shapes stay the user's call — no guess. Groq keys are one of
  // them now (the provider left the registry 2026-07-12).
  assert.equal(detectDrcProvider("gsk_abc123"), null);
  assert.equal(detectDrcProvider("sk_abc123"), null); // underscore but not Berget's
  assert.equal(detectDrcProvider("hf_abc123"), null);
  assert.equal(detectDrcProvider(""), null);
  assert.equal(detectDrcProvider(null), null);
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
  // Berget serves /embeddings (e5) but joining RAG needs the passage:/query:
  // prefix convention + 1024-dim storage — deliberately not declared yet.
  assert.equal(drcProvider("berget").embed, undefined);
});

test("drcEmbedProvider: the first embeddings-capable provider with a key", () => {
  assert.equal(drcEmbedProvider({}), null);
  assert.equal(drcEmbedProvider({ berget: "bk" }), null); // a Berget-only session has no RAG (no embed entry yet)
  assert.equal(drcEmbedProvider({ local: "lk" }), null); // a Local-only session too
  assert.equal(drcEmbedProvider({ openai: "sk" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "sk", berget: "bk" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "" }), null);
});

test("configuredDrcProviders: keys for hosted entries, an endpoint for Local", () => {
  assert.deepEqual(configuredDrcProviders({}).map((p) => p.id), []);
  assert.deepEqual(configuredDrcProviders({ openai: "sk" }).map((p) => p.id), ["openai"]);
  assert.deepEqual(
    configuredDrcProviders({ openai: "sk", berget: "bk" }).map((p) => p.id),
    ["openai", "berget"],
  );
  assert.deepEqual(configuredDrcProviders({ berget: "bk" }).map((p) => p.id), ["berget"]);
  assert.deepEqual(configuredDrcProviders({ openai: "" }).map((p) => p.id), []);
  // Local is configured by its BASE URL, not a key (the key is optional).
  assert.deepEqual(
    configuredDrcProviders({}, { local: "http://localhost:11434/v1" }).map((p) => p.id),
    ["local"],
  );
  assert.deepEqual(
    configuredDrcProviders({ openai: "sk", local: "ignored-key" }, { local: "https://gw.example/v1" }).map((p) => p.id),
    ["openai", "local"],
  );
  // A stored local KEY without an endpoint configures nothing.
  assert.deepEqual(configuredDrcProviders({ local: "some-key" }).map((p) => p.id), []);
  assert.deepEqual(configuredDrcProviders({}, { local: "not a url" }).map((p) => p.id), []);
});

test("endpoint validation and normalization (the Local base URL)", () => {
  assert.equal(drcBaseValid("http://localhost:11434"), true);
  assert.equal(drcBaseValid("https://gw.example/openai/v1"), true);
  assert.equal(drcBaseValid("ftp://x"), false);
  assert.equal(drcBaseValid("localhost:11434"), false); // scheme required
  assert.equal(drcBaseValid("http://a b"), false);
  assert.equal(drcBaseValid(""), false);
  assert.equal(drcBaseValid(null), false);

  // A bare host means the conventional /v1 surface (Ollama, LM Studio…).
  assert.equal(normalizeDrcBase("http://localhost:11434"), "http://localhost:11434/v1");
  assert.equal(normalizeDrcBase("http://localhost:11434/"), "http://localhost:11434/v1");
  // An explicit path is the user's own routing — kept verbatim.
  assert.equal(normalizeDrcBase("https://gw.example/openai/v1"), "https://gw.example/openai/v1");
  assert.equal(normalizeDrcBase("http://192.168.1.5:8080/api/"), "http://192.168.1.5:8080/api");
  assert.equal(normalizeDrcBase("  http://localhost:8080/v1  "), "http://localhost:8080/v1");
  assert.equal(normalizeDrcBase("garbage"), "");

  // drcBaseFor: hosted providers keep their fixed host; Local reads the
  // sealed state's bases map.
  assert.equal(drcBaseFor(drcProvider("openai"), {}), "https://api.openai.com/v1");
  assert.equal(drcBaseFor(drcProvider("berget"), { local: "http://x" }), "https://api.berget.ai/v1");
  assert.equal(drcBaseFor(drcProvider("local"), { local: "http://localhost:11434" }), "http://localhost:11434/v1");
  assert.equal(drcBaseFor(drcProvider("local"), {}), "");
});

test("buildDrcPayload carries each provider's wire quirks", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const openai = buildDrcPayload(drcProvider("openai"), "gpt-5.6-terra", msgs, { json: true, maxTokens: 500 });
  assert.equal(openai.max_completion_tokens, 500);
  assert.equal(openai.reasoning_effort, "none");
  assert.deepEqual(openai.response_format, { type: "json_object" });
  assert.equal(openai.stream, false);

  // Berget: the plain OpenAI wire, same params src/berget.js sends.
  const berget = buildDrcPayload(drcProvider("berget"), "mistralai/Mistral-Small-3.2-24B-Instruct-2506", msgs, {
    json: true,
    maxTokens: 1500,
  });
  assert.equal(berget.max_tokens, 1500);
  assert.equal(berget.max_completion_tokens, undefined);
  assert.equal(berget.reasoning_effort, undefined);
  assert.deepEqual(berget.response_format, { type: "json_object" });

  // Local: the plain OpenAI wire too — the least-assuming shape.
  const local = buildDrcPayload(drcProvider("local"), "qwen3:8b", msgs, { stream: true });
  assert.equal(local.max_tokens, 4096);
  assert.equal(local.max_completion_tokens, undefined);
  assert.equal(local.response_format, undefined);
  assert.equal(local.stream, true);
});

test("extractJson forgives fences and prose, rejects garbage", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
});

test("model filters are CURATED for hosted providers, open for Local", () => {
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

  // Local: whatever the user chose to serve, they meant — no curation.
  const local = drcProvider("local");
  assert.equal(local.modelFilter("qwen3:8b"), true);
  assert.equal(local.modelFilter("my-finetune-v2"), true);
});

describe("provider calls over mock HTTP", () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url.endsWith("/models")) {
        if (req.headers.authorization && req.headers.authorization !== "Bearer good-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506" },
              { id: "KBLab/kb-whisper-large" },
              { id: "moonshotai/Kimi-K2.6" },
            ],
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
    const berget = drcProvider("berget");
    const live = await listDrcModels(berget, "good-key", { baseUrl });
    // whisper filtered out, remainder sorted newest-ish first
    assert.deepEqual(live, ["moonshotai/Kimi-K2.6", "mistralai/Mistral-Small-3.2-24B-Instruct-2506"]);
    const fallback = await listDrcModels(berget, "bad-key", { baseUrl });
    assert.deepEqual(fallback, berget.fallbackModels);
  });

  test("Local: the live list is unfiltered and needs no key at all", async () => {
    const local = drcProvider("local");
    const live = await listDrcModels(local, "", { baseUrl });
    assert.deepEqual(live, [
      "moonshotai/Kimi-K2.6",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      "KBLab/kb-whisper-large",
    ]);
    // The keyless request carried NO Authorization header — a bare
    // "Bearer " trips some local servers.
    assert.equal(requests.at(-1).headers.authorization, undefined);
  });

  test("drcCompleteJson: bearer auth, JSON mode requested, fenced JSON parsed", async () => {
    const berget = drcProvider("berget");
    const value = await drcCompleteJson(berget, "good-key", berget.jsonModel, [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    const req = requests.at(-1);
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.model, berget.jsonModel);
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
    await assert.rejects(drcEmbed(drcProvider("berget"), "k", ["x"], { baseUrl }), /no embeddings/);
  });

  test("drcChatStream: returns the provider's SSE response as-is", async () => {
    const berget = drcProvider("berget");
    const res = await drcChatStream(berget, "good-key", "moonshotai/Kimi-K2.6", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    assert.equal(requests.at(-1).body.stream, true);
  });

  test("Local over mock HTTP: keyless chat works, plain OpenAI wire", async () => {
    const local = drcProvider("local");
    const res = await drcChatStream(local, "", "qwen3:8b", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    const req = requests.at(-1);
    assert.equal(req.headers.authorization, undefined); // no key → no header
    assert.equal(req.body.max_tokens, 4096);
    assert.equal(req.body.max_completion_tokens, undefined);

    // …and a gateway key IS sent when the user stored one.
    await (await drcChatStream(local, "gw-key", "qwen3:8b", [{ role: "user", content: "x" }], { baseUrl })).text();
    assert.equal(requests.at(-1).headers.authorization, "Bearer gw-key");

    const value = await drcCompleteJson(local, "", "qwen3:8b", [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(requests.at(-1).body.response_format, { type: "json_object" });
  });
});
