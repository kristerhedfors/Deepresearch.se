import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  DRC_PROVIDERS,
  bergetCatalogFilter,
  buildDrcPayload,
  configuredDrcProviders,
  detectDrcProvider,
  extractJson,
  drcChatStream,
  drcCompleteJson,
  drcEmbed,
  drcEmbedProvider,
  drcProvider,
  drcToolRun,
  filterAndSortModels,
  foreignDrcKeyHint,
  listDrcModels,
  oaiChunksFromAnthropicEvent,
  openAiStreamFromAnthropic,
  POOL_LLM_PROVIDER_ID,
  poolLlmProvider,
  providerErrorDetail,
  proxyLlmProvider,
  SERVER_TOKEN_LLM_PROVIDER_ID,
  serverTokenLlmProvider,
  toDrcAnthropicPayload,
  toOpenAiTools,
} from "./drc-providers.js";

test("the registry holds the CORS-capable providers plus the keyless custom entry", () => {
  assert.deepEqual(DRC_PROVIDERS.map((p) => p.id), ["openai", "anthropic", "berget", "local"]);
  assert.equal(drcProvider("openai").label, "OpenAI");
  assert.equal(drcProvider("anthropic").label, "Anthropic"); // took Groq's slot 2026-07-26
  assert.equal(drcProvider("berget").label, "Berget"); // CORS confirmed live 2026-07-11
  // Only Anthropic speaks a foreign wire; the rest are OpenAI chat completions.
  assert.equal(drcProvider("anthropic").wire, "anthropic");
  for (const id of ["openai", "berget", "local"]) assert.equal(drcProvider(id).wire, undefined);
  // The keyless entry is the "arbitrary OpenAI-compatible endpoint" escape
  // hatch — the three named providers are shortcuts, not the boundary.
  assert.equal(drcProvider("local").keyless, true);
  assert.match(drcProvider("local").label, /OpenAI-compatible/);
  for (const p of DRC_PROVIDERS) {
    if (p.keyless) continue; // the local entry: no key, no fixed catalog (below)
    assert.ok(p.jsonModel, p.id + " needs a JSON-phase default model");
    assert.ok(p.fallbackModels.length, p.id + " needs a fallback catalog");
  }
});

test("the local entry is keyless, defaults to Ollama, and declares NO fixed models", () => {
  const local = drcProvider("local");
  assert.equal(local.keyless, true);
  assert.equal(local.keyPattern, null); // nothing to auto-detect — chosen explicitly
  assert.equal(local.base, "http://localhost:11434/v1"); // Ollama's default; user URL overrides
  // One local server serves BOTH pipeline roles: jsonModel null means the
  // planning phases fall back to the chosen model (drc-research.js).
  assert.equal(local.jsonModel, null);
  assert.deepEqual(local.fallbackModels, []); // a user's own catalog has no static stand-in
  assert.equal(local.embed, undefined); // local embeddings are a later, separate step
  // The curation drops the obvious non-chat modalities a local catalog lists.
  assert.equal(local.modelFilter("llama3.2:latest"), true);
  assert.equal(local.modelFilter("qwen2.5-coder:7b"), true);
  assert.equal(local.modelFilter("nomic-embed-text"), false);
  assert.equal(local.modelFilter("whisper-large-v3"), false);
});

test("detectDrcProvider identifies a pasted key by its prefix", () => {
  // OpenAI: sk-… in all its variants (hyphen).
  assert.equal(detectDrcProvider("sk-abc123").id, "openai");
  assert.equal(detectDrcProvider("sk-proj-abc123").id, "openai");
  assert.equal(detectDrcProvider("sk-svcacct-abc123").id, "openai");
  // Anthropic: sk-ant-… — the most specific sk- prefix.
  assert.equal(detectDrcProvider("sk-ant-abc123").id, "anthropic");
  // Berget: sk_ber_… (underscore — never collides with OpenAI's sk-).
  assert.equal(detectDrcProvider("sk_ber_abc123").id, "berget");
  // Whitespace from a paste is forgiven.
  assert.equal(detectDrcProvider("  sk_ber_abc123\n").id, "berget");
  // Unknown shapes stay the user's call — no guess.
  assert.equal(detectDrcProvider("sk_abc123"), null); // underscore but not Berget's
  assert.equal(detectDrcProvider("hf_abc123"), null);
  assert.equal(detectDrcProvider("gsk_abc123"), null); // Groq left the registry 2026-07-26
  assert.equal(detectDrcProvider(""), null);
  assert.equal(detectDrcProvider(null), null);
});

test("an Anthropic sk-ant-… key is NEVER claimed by OpenAI's sk- pattern", () => {
  // The feedback-#6 regression (2026-07-23): sk-ant-… matched /^sk-/ and
  // was routed to OpenAI's wire, which 401s. The most specific prefix owns
  // the key — now that Anthropic is a real entry, sk-ant-… must land on IT
  // and never on OpenAI.
  assert.equal(detectDrcProvider("sk-ant-api03-abc123").id, "anthropic");
  assert.equal(detectDrcProvider("  sk-ant-api03-abc123\n").id, "anthropic");
  // …and the patterns stay mutually exclusive by construction, so no
  // future reordering of DRC_PROVIDERS can bring the collision back.
  const key = "sk-ant-api03-abc123";
  const claimants = DRC_PROVIDERS.filter((p) => p.keyPattern && p.keyPattern.test(key));
  assert.deepEqual(claimants.map((p) => p.id), ["anthropic"]);
  // OpenAI's own variants are untouched by the exclusion.
  assert.equal(detectDrcProvider("sk-abc123").id, "openai");
  assert.equal(detectDrcProvider("sk-proj-abc123").id, "openai");
});

test("foreignDrcKeyHint names a recognized-but-not-built-in key shape", () => {
  // Groq: no longer a registry entry, but it speaks the OpenAI wire — the
  // hint has to point at the custom endpoint rather than say "impossible".
  assert.match(foreignDrcKeyHint("gsk_abc123"), /Groq/);
  assert.match(foreignDrcKeyHint("gsk_abc123"), /OpenAI-compatible/);
  assert.match(foreignDrcKeyHint("  gsk_abc123\n"), /Groq/);
  assert.match(foreignDrcKeyHint("hf_abc123"), /Hugging Face/);
  // Supported and unknown shapes get NO foreign hint — Anthropic is a real
  // provider now, so its key must NOT be waved off as foreign.
  assert.equal(foreignDrcKeyHint("sk-ant-api03-abc123"), null);
  assert.equal(foreignDrcKeyHint("sk-abc123"), null);
  assert.equal(foreignDrcKeyHint("sk_ber_abc123"), null);
  assert.equal(foreignDrcKeyHint("something-else"), null);
  assert.equal(foreignDrcKeyHint(""), null);
  assert.equal(foreignDrcKeyHint(null), null);
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
  assert.equal(drcProvider("anthropic").embed, undefined); // Anthropic serves no /embeddings
  // Berget serves /embeddings (e5) but joining RAG needs the passage:/query:
  // prefix convention + 1024-dim storage — deliberately not declared yet.
  assert.equal(drcProvider("berget").embed, undefined);
});

test("drcEmbedProvider: the first embeddings-capable provider with a key", () => {
  assert.equal(drcEmbedProvider({}), null);
  assert.equal(drcEmbedProvider({ anthropic: "sk-ant" }), null); // an Anthropic-only session has no RAG
  assert.equal(drcEmbedProvider({ berget: "bk" }), null); // a Berget-only session too (no embed entry yet)
  assert.equal(drcEmbedProvider({ openai: "sk" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "sk", anthropic: "sk-ant" }).id, "openai");
  assert.equal(drcEmbedProvider({ openai: "" }), null);
});

test("configuredDrcProviders follows the stored keys", () => {
  assert.deepEqual(configuredDrcProviders({}).map((p) => p.id), []);
  assert.deepEqual(configuredDrcProviders({ anthropic: "sk-ant" }).map((p) => p.id), ["anthropic"]);
  assert.deepEqual(configuredDrcProviders({ openai: "sk", anthropic: "sk-ant" }).map((p) => p.id), ["openai", "anthropic"]);
  assert.deepEqual(
    configuredDrcProviders({ openai: "sk", anthropic: "sk-ant", berget: "bk" }).map((p) => p.id),
    ["openai", "anthropic", "berget"],
  );
  assert.deepEqual(configuredDrcProviders({ berget: "bk" }).map((p) => p.id), ["berget"]);
  assert.deepEqual(configuredDrcProviders({ openai: "" }).map((p) => p.id), []);
});

test("configuredDrcProviders: the keyless local entry is configured by its base URL", () => {
  // No key exists for the local provider — a stored `keys.local` never counts…
  assert.deepEqual(configuredDrcProviders({ local: "anything" }).map((p) => p.id), []);
  // …the base URL is the whole configuration…
  assert.deepEqual(
    configuredDrcProviders({}, { localBaseUrl: "http://localhost:11434/v1" }).map((p) => p.id),
    ["local"],
  );
  // …blank/whitespace URLs leave it out, and keyed providers are unaffected.
  assert.deepEqual(configuredDrcProviders({}, { localBaseUrl: "  " }).map((p) => p.id), []);
  assert.deepEqual(
    configuredDrcProviders({ openai: "sk" }, { localBaseUrl: "http://localhost:1234/v1" }).map((p) => p.id),
    ["openai", "local"],
  );
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
});

test("toDrcAnthropicPayload bridges the three shape differences", () => {
  const payload = toDrcAnthropicPayload(
    [
      { role: "system", content: "rule one" },
      { role: "system", content: "rule two" },
      { role: "user", content: "first" },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }],
      },
    ],
    { model: "claude-opus-5", maxTokens: 900 },
  );
  // 1. system turns are hoisted to a top-level field and joined.
  assert.equal(payload.system, "rule one\n\nrule two");
  // 2. consecutive same-role turns are merged (the pipeline appends context
  //    blocks that routinely produce them).
  assert.deepEqual(payload.messages[0], {
    role: "user",
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  });
  assert.deepEqual(payload.messages[1], { role: "assistant", content: [{ type: "text", text: "ok" }] });
  // 3. data-URL image parts become base64 source blocks.
  assert.deepEqual(payload.messages[2].content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
  assert.equal(payload.max_tokens, 900);
  assert.equal(payload.stream, false);
  assert.equal(payload.tools, undefined);
  // A malformed image part is skipped, never thrown on — and an empty turn
  // is dropped rather than sent as an empty content array.
  const junk = toDrcAnthropicPayload([
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] },
    { role: "user", content: "real" },
  ]);
  assert.deepEqual(junk.messages, [{ role: "user", content: [{ type: "text", text: "real" }] }]);
  assert.equal(junk.system, undefined);
});

test("oaiChunksFromAnthropicEvent re-emits the Anthropic vocabulary as OpenAI chunks", () => {
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  // message_start carries usage but emits nothing.
  assert.deepEqual(oaiChunksFromAnthropicEvent({ type: "message_start", message: { usage: { input_tokens: 11 } } }, usage), []);
  assert.equal(usage.prompt_tokens, 11);
  // text deltas become choices[0].delta.content.
  assert.deepEqual(
    oaiChunksFromAnthropicEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, usage).map(JSON.parse),
    [{ choices: [{ delta: { content: "hi" } }] }],
  );
  // thinking deltas are dropped — text only.
  assert.deepEqual(
    oaiChunksFromAnthropicEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } }, usage),
    [],
  );
  // message_delta maps stop_reason and merges the usage totals.
  const [final] = oaiChunksFromAnthropicEvent(
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4 } },
    usage,
  );
  assert.deepEqual(JSON.parse(final), {
    choices: [{ delta: {}, finish_reason: "length" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  });
  assert.deepEqual(oaiChunksFromAnthropicEvent({ type: "message_stop" }, usage), ["[DONE]"]);
  // ping and unknown future events are ignored, never fatal.
  assert.deepEqual(oaiChunksFromAnthropicEvent({ type: "ping" }, usage), []);
  assert.deepEqual(oaiChunksFromAnthropicEvent({ type: "content_block_start" }, usage), []);
  assert.deepEqual(oaiChunksFromAnthropicEvent(null, usage), []);
});

test("openAiStreamFromAnthropic drains events that map to zero output", async () => {
  // The pull loop must keep reading past message_start/ping/block events —
  // a pull that enqueues nothing is not re-invoked, so a naive adapter
  // deadlocks on exactly this sequence.
  const source = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const line of [
        '{"type":"message_start","message":{"usage":{"input_tokens":2}}}',
        '{"type":"ping"}',
        '{"type":"content_block_start"}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"one "}}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"two"}}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        '{"type":"message_stop"}',
      ]) {
        c.enqueue(enc.encode("data: " + line + "\n\n"));
      }
      c.close();
    },
  });
  const text = await new Response(openAiStreamFromAnthropic(source)).text();
  assert.match(text, /"content":"one "/);
  assert.match(text, /"content":"two"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.trim().endsWith("data: [DONE]"));
});

test("openAiStreamFromAnthropic surfaces an error event as a stream error", async () => {
  const source = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"message":"overloaded"}}\n\n'));
      c.close();
    },
  });
  await assert.rejects(new Response(openAiStreamFromAnthropic(source)).text(), /overloaded/);
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
  // Anthropic's /v1/models returns dated ids for the current generation and
  // every legacy family beside them — only the current generation shows.
  const anthropic = drcProvider("anthropic");
  assert.equal(anthropic.modelFilter("claude-opus-5"), true);
  assert.equal(anthropic.modelFilter("claude-sonnet-5"), true);
  assert.equal(anthropic.modelFilter("claude-haiku-4-5"), true);
  assert.equal(anthropic.modelFilter("claude-haiku-4-5-20251001"), true); // dated id
  assert.equal(anthropic.modelFilter("claude-opus-4-1-20250805"), false); // superseded
  assert.equal(anthropic.modelFilter("claude-sonnet-4-5"), false);
  assert.equal(anthropic.modelFilter("claude-3-5-sonnet-20241022"), false);
  assert.equal(anthropic.modelFilter("gpt-5.6-terra"), false);

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

test("the Berget catalog filter has ONE definition, shared by the proxy provider", () => {
  const berget = drcProvider("berget");
  // The registry entry and the wire-identical secure-research-space proxy both
  // reference the same predicate — no drift-prone copy of the regex.
  assert.equal(berget.modelFilter, bergetCatalogFilter);
  assert.equal(proxyLlmProvider("https://x").modelFilter, bergetCatalogFilter);
  assert.equal(bergetCatalogFilter("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), true);
  assert.equal(bergetCatalogFilter("intfloat/multilingual-e5-large"), false);
});

test("the Se/rver-token LLM provider is a two-field respin of the proxy provider", () => {
  const st = serverTokenLlmProvider("https://x");
  const px = proxyLlmProvider("https://x");
  // Its own identity + the token subsystem's endpoint, the JWT as the bearer.
  assert.equal(st.id, SERVER_TOKEN_LLM_PROVIDER_ID);
  assert.equal(st.id, "servertoken");
  assert.equal(st.base, "https://x/api/server-token/llm");
  assert.match(st.label, /Se\/rver token/);
  // Everything wire-shaped is SHARED with the proxy provider (one definition):
  // Berget catalog filter, JSON model, fallbacks, params, the proxied marker.
  assert.equal(st.modelFilter, bergetCatalogFilter);
  assert.equal(st.jsonModel, px.jsonModel);
  assert.deepEqual(st.fallbackModels, px.fallbackModels);
  assert.equal(st.proxied, true);
  // Never in the static registry — it exists only while a token is live.
  assert.equal(drcProvider("servertoken"), null);
});

test("filterAndSortModels curates by the predicate and orders newest-first", () => {
  const data = [
    { id: "gpt-5.4-mini" },
    { id: "gpt-5.6-terra" },
    { id: "text-embedding-3-large" }, // dropped by the filter
    { id: 42 }, // non-string id dropped
    null, // junk entry dropped
    { id: "gpt-5.6-sol" },
  ];
  const openai = drcProvider("openai");
  assert.deepEqual(filterAndSortModels(data, openai.modelFilter), [
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
  ]);
  // Fail-soft over a non-array (a bad /models body) → empty list, never a throw.
  assert.deepEqual(filterAndSortModels(null, openai.modelFilter), []);
  assert.deepEqual(filterAndSortModels(undefined, () => true), []);
});

test("filterAndSortModels drops models the catalog marks DOWN (status.up false)", () => {
  // The live incident (2026-07-15, test point #10): Berget kept listing
  // zai-org/GLM-5.2 while it was dark for maintenance, the newest-first sort
  // put it FIRST, and a borrowed workspace session defaulted to it — every
  // call 502'd. Down models must never reach the dropdown.
  const data = [
    { id: "zai-org/GLM-5.2", status: { up: false }, lifecycle_state: "maintenance" },
    { id: "zai-org/GLM-4.7-FP8", status: { up: true } },
    { id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", status: { up: true } },
  ];
  assert.deepEqual(filterAndSortModels(data, bergetCatalogFilter), [
    "zai-org/GLM-4.7-FP8",
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  ]);
  // Fail-OPEN when the field is absent — OpenAI/Anthropic entries carry no status.
  assert.deepEqual(
    filterAndSortModels([{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra", status: {} }], drcProvider("openai").modelFilter),
    ["gpt-5.6-terra", "gpt-5.6-sol"],
  );
});

test("providerErrorDetail reads both failure wire shapes (direct + proxied)", async () => {
  const asRes = (body) => new Response(JSON.stringify(body), { status: 502 });
  // The direct OpenAI-wire shape.
  assert.equal(await providerErrorDetail(asRes({ error: { message: "Invalid API key" } })), "Invalid API key");
  // The secure-research-space proxy shape: {error, detail} with the UPSTREAM
  // OpenAI-wire error text inside detail (src/proxy.js's 502).
  assert.equal(
    await providerErrorDetail(
      asRes({
        error: "The upstream model rejected the request.",
        detail: '{"error":{"message":"Model \'zai-org/GLM-5.2\' is currently undergoing maintenance and is not available for inference","type":"invalid_request_error","code":null}}',
      }),
    ),
    "Model 'zai-org/GLM-5.2' is currently undergoing maintenance and is not available for inference",
  );
  // A plain string error, an unreadable body, junk detail — all degrade to "".
  assert.equal(await providerErrorDetail(asRes({ error: "quota exhausted" })), "quota exhausted");
  assert.equal(await providerErrorDetail(new Response("not json", { status: 502 })), "");
  assert.equal(await providerErrorDetail(asRes({ error: { message: 42 }, detail: "junk" })), "");
});

describe("provider calls over mock HTTP", () => {
  const requests = [];
  let toolRoundDone = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url.endsWith("/models")) {
        // Both auth shapes: Bearer for the OpenAI wire, x-api-key for Anthropic's.
        if (req.headers.authorization !== "Bearer good-key" && req.headers["x-api-key"] !== "good-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "gpt-5.6-terra" },
              { id: "gpt-5.4-mini" },
              { id: "text-embedding-3-small" },
              { id: "claude-opus-5" },
              { id: "claude-haiku-4-5-20251001" },
              { id: "claude-3-5-sonnet-20241022" },
            ],
          }),
        );
        return;
      }
      // The Anthropic Messages API: a different path, a different request and
      // response shape — everything the wire adapter has to bridge.
      if (req.url.endsWith("/messages")) {
        const body = JSON.parse(raw);
        if (body.tools && !toolRoundDone) {
          toolRoundDone = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              stop_reason: "tool_use",
              content: [{ type: "tool_use", id: "tu_1", name: "grep_source", input: { pattern: "x" } }],
            }),
          );
          return;
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n' +
              'data: {"type":"ping"}\n\n' +
              'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"streamed"}}\n\n' +
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
              'data: {"type":"message_stop"}\n\n',
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: '```json\n{"ok":true}\n```' }],
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
    const openai = drcProvider("openai");
    const live = await listDrcModels(openai, "good-key", { baseUrl });
    assert.deepEqual(live, ["gpt-5.6-terra", "gpt-5.4-mini"]); // embeddings filtered, newest first
    const fallback = await listDrcModels(openai, "bad-key", { baseUrl });
    assert.deepEqual(fallback, openai.fallbackModels);
  });

  test("listDrcModels: Anthropic lists over x-api-key, curated to the current generation", async () => {
    const anthropic = drcProvider("anthropic");
    const live = await listDrcModels(anthropic, "good-key", { baseUrl });
    assert.deepEqual(live, ["claude-opus-5", "claude-haiku-4-5-20251001"]); // claude-3-5 filtered out
    // The listing carried Anthropic's auth headers, never a Bearer.
    const req = requests.at(-1);
    assert.equal(req.headers["x-api-key"], "good-key");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    const fallback = await listDrcModels(anthropic, "bad-key", { baseUrl });
    assert.deepEqual(fallback, anthropic.fallbackModels);
  });

  test("the pool provider sends stream:false and gets back a synthesized SSE Response", async () => {
    const pool = { ...poolLlmProvider(""), base: baseUrl };
    assert.equal(pool.id, POOL_LLM_PROVIDER_ID);
    assert.equal(pool.whole, true);
    assert.equal(pool.jsonModel, null); // like `local`: no static catalog, no split routing
    const res = await drcChatStream(pool, "pt1.claims.sig", "llama3", [{ role: "user", content: "hi" }], { baseUrl });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const body = await res.text();
    // The mock answers stream:false with a whole JSON completion; the adapter
    // re-emits it as the one-chunk SSE every downstream consumer parses.
    assert.ok(body.includes('"delta"'));
    assert.ok(body.trim().endsWith("data: [DONE]"));
    const req = requests.at(-1);
    assert.equal(req.body.stream, false);
    assert.equal(req.headers.authorization, "Bearer pt1.claims.sig");
  });

  test("drcCompleteJson: bearer auth, JSON mode requested, fenced JSON parsed", async () => {
    const berget = drcProvider("berget");
    const value = await drcCompleteJson(berget, "good-key", berget.jsonModel, [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    const req = requests.at(-1);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer good-key");
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.model, berget.jsonModel);
  });

  test("drcCompleteJson on the Anthropic wire: /messages, no response_format, text blocks parsed", async () => {
    const anthropic = drcProvider("anthropic");
    const value = await drcCompleteJson(anthropic, "good-key", anthropic.jsonModel, [
      { role: "system", content: "be terse" },
      { role: "user", content: "x" },
    ], { baseUrl });
    assert.deepEqual(value, { ok: true }); // fenced JSON out of a content block
    const req = requests.at(-1);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "good-key");
    // The browser opt-in header — without it the preflight fails and Se/cure's
    // browser-direct promise cannot hold on Claude.
    assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(req.body.system, "be terse"); // hoisted out of messages
    assert.equal(req.body.response_format, undefined); // Anthropic has no such param
    assert.equal(req.body.stream, false);
    assert.equal(req.body.max_tokens, 1500);
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
    await assert.rejects(drcEmbed(drcProvider("anthropic"), "k", ["x"], { baseUrl }), /no embeddings/);
  });

  test("drcEmbed: the proxy provider embeds on Berget e5 — passage:/query: prefix, no dimensions param", async () => {
    const px = { ...proxyLlmProvider(""), base: baseUrl }; // point at the mock
    // Indexing (passage) — the e5 prefix is prepended, dimensions is omitted.
    await drcEmbed(px, "proxy-token", ["hello", "world"], { baseUrl, kind: "passage" });
    let req = requests.at(-1);
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer proxy-token"); // the borrowed api token
    assert.equal(req.body.model, "intfloat/multilingual-e5-large");
    assert.equal(req.body.dimensions, undefined); // e5 has fixed 1024-dim, no projection param
    assert.deepEqual(req.body.input, ["passage: hello", "passage: world"]);
    // Retrieval (query) — the query prefix instead.
    await drcEmbed(px, "proxy-token", ["what is x"], { baseUrl, kind: "query" });
    req = requests.at(-1);
    assert.deepEqual(req.body.input, ["query: what is x"]);
    // The Se/rver-token provider inherits the same embed entry.
    assert.deepEqual(serverTokenLlmProvider("https://x").embed, proxyLlmProvider("https://x").embed);
  });

  test("drcChatStream: returns the provider's SSE response as-is", async () => {
    const berget = drcProvider("berget");
    const res = await drcChatStream(berget, "good-key", "moonshotai/Kimi-K2.6", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    assert.equal(requests.at(-1).body.stream, true);
  });

  test("drcChatStream on the Anthropic wire: Messages in, OpenAI-shaped SSE out", async () => {
    const anthropic = drcProvider("anthropic");
    const res = await drcChatStream(anthropic, "good-key", "claude-opus-5", [
      { role: "system", content: "be terse" },
      { role: "user", content: "x" },
    ], { baseUrl });
    assert.equal(res.ok, true);
    const body = await res.text();
    // Downstream consumers only ever see the OpenAI shape — that is the whole
    // point of adapting at the wire instead of forking the pipeline.
    assert.match(body, /"content":"streamed"/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.ok(body.trim().endsWith("data: [DONE]"));
    const req = requests.at(-1);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.system, "be terse");
    assert.deepEqual(req.body.messages, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
  });

  test("drcToolRun on the Anthropic wire: tool_use round, then the answer", async () => {
    const anthropic = drcProvider("anthropic");
    const seen = [];
    const out = await drcToolRun(anthropic, "good-key", "claude-opus-5", {
      system: "investigate",
      userContent: "what does X do?",
      tools: [{ name: "grep_source", description: "search", input_schema: { type: "object" } }],
      execTool: (name, args) => {
        seen.push([name, args]);
        return "match at line 4";
      },
      baseUrl,
    });
    assert.equal(out.toolCalls, 1);
    assert.equal(out.rounds, 2);
    assert.deepEqual(seen, [["grep_source", { pattern: "x" }]]);
    // The provider-neutral tool defs go out UNMAPPED — they are already the
    // Anthropic shape (unlike the OpenAI wire, which wraps them).
    const first = requests.find((r) => r.body?.tools);
    assert.equal(first.body.tools[0].name, "grep_source");
    assert.deepEqual(first.body.tools[0].input_schema, { type: "object" });
    // The result came back as a paired tool_result block.
    const second = requests.at(-1);
    assert.equal(second.body.messages.at(-1).content[0].type, "tool_result");
    assert.equal(second.body.messages.at(-1).content[0].tool_use_id, "tu_1");
  });

  test("the keyless local provider sends NO Authorization header", async () => {
    // "Bearer undefined" makes some local servers 401 — a keyless call must
    // omit the header outright, on both wire shapes.
    const local = drcProvider("local");
    const res = await drcChatStream(local, "", "llama3.2:latest", [{ role: "user", content: "x" }], { baseUrl });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /"content":"streamed"/);
    const streamReq = requests.at(-1);
    assert.equal(streamReq.headers.authorization, undefined);
    assert.equal(streamReq.body.max_tokens, 4096); // the plain OpenAI wire

    const value = await drcCompleteJson(local, "", "llama3.2:latest", [{ role: "user", content: "x" }], { baseUrl });
    assert.deepEqual(value, { ok: true });
    assert.equal(requests.at(-1).headers.authorization, undefined);
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

// The native TOOL-USE loop (drcToolRun) over a mock OpenAI-compatible server:
// round 1 returns a tool_call, we execute it, round 2 sees the role:"tool"
// result and returns the final content. Verifies the OpenAI tools mapping, the
// tool_call_id pairing, execution, and the returned answer/counters.
describe("drcToolRun over mock HTTP", () => {
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
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "grep_source", arguments: '{"pattern":"SESSION_SECRET"}' } },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Found it in src/auth.js." } }] }));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("toOpenAiTools maps the provider-neutral defs to function tools", () => {
    const [t] = toOpenAiTools([{ name: "grep_source", description: "d", input_schema: { type: "object" } }]);
    assert.equal(t.type, "function");
    assert.equal(t.function.name, "grep_source");
    assert.deepEqual(t.function.parameters, { type: "object" });
  });

  test("drives a tool call, feeds the result back, and returns the final answer", async () => {
    const executed = [];
    const result = await drcToolRun(drcProvider("openai"), "good-key", "gpt-5.6-terra", {
      system: "investigate",
      userContent: "assess auth",
      tools: [{ name: "grep_source", description: "grep", input_schema: { type: "object", properties: {} } }],
      execTool: (name, input) => {
        executed.push({ name, input });
        return "src/auth.js:3: if (!env.SESSION_SECRET) return [];";
      },
      baseUrl,
    });

    assert.deepEqual(executed, [{ name: "grep_source", input: { pattern: "SESSION_SECRET" } }]);
    assert.match(result.text, /Found it in src\/auth\.js/);
    assert.equal(result.toolCalls, 1);

    // Round 1 carried the OpenAI function-tool shape.
    assert.equal(requests[0].tools[0].type, "function");
    assert.equal(requests[0].tools[0].function.name, "grep_source");
    // Round 2 echoed the assistant tool_calls turn + a paired role:"tool" result.
    const roles = requests[1].messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);
    const toolMsg = requests[1].messages[3];
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.match(toolMsg.content, /SESSION_SECRET/);
  });
});

// ---- the engine provider seam (the on-device tier) ------------------------------------
//
// An ENGINE provider (ondevice-engine.js's onDeviceProvider) has no wire:
// drcChatStream/drcCompleteJson branch to its callables instead of fetch.
// The mock engine here mirrors the real provider's shape — the real one is
// browser glue (Worker/WebGPU) and deliberately not Node-importable, like
// sandbox.js.

import { completionEnvelope, sseDeltaLine, sseDoneLine } from "./ondevice-core.js";

function mockEngineProvider(overrides = {}) {
  const calls = [];
  const provider = {
    id: "ondevice",
    label: "On-device",
    base: "",
    keyless: true,
    jsonModel: null,
    fallbackModels: [],
    modelFilter: () => true,
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    jsonTimeoutMs: 600_000,
    streamIdleMs: 300_000,
    serialize: true,
    engine: {
      chatStream: async (model, messages, opts) => {
        calls.push({ kind: "stream", model, messages, opts });
        const body = new TextEncoder().encode(sseDeltaLine("on-") + sseDeltaLine("device") + sseDoneLine());
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
      complete: async (model, messages, opts) => {
        calls.push({ kind: "complete", model, messages, opts });
        return completionEnvelope('{"action":"direct"}');
      },
    },
    ...overrides,
  };
  return { provider, calls };
}

test("drcChatStream routes an engine provider to its callable — no fetch, SSE wire out", async () => {
  const { provider, calls } = mockEngineProvider();
  const res = await drcChatStream(provider, "", "bonsai-8b-1bit", [{ role: "user", content: "hej" }], {
    maxTokens: 512,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "stream");
  assert.equal(calls[0].model, "bonsai-8b-1bit");
  assert.equal(calls[0].opts.maxTokens, 512);
  // The Response body is the exact OpenAI SSE the pipeline's readStream parses.
  const text = await res.text();
  assert.match(text, /"delta":\{"content":"on-"\}/);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("drcCompleteJson routes an engine provider to complete() with json + its OWN deadline", async () => {
  const { provider, calls } = mockEngineProvider();
  const value = await drcCompleteJson(provider, "", "bonsai-8b-1bit", [{ role: "user", content: "plan" }]);
  assert.deepEqual(value, { action: "direct" });
  assert.equal(calls[0].kind, "complete");
  assert.equal(calls[0].opts.json, true);
  // The per-provider deadline rides in as the abort signal (never the hosted
  // 45 s default): an already-aborted signal proves which one was wired.
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
});

test("drcCompleteJson: engine JSON still goes through the lenient extraction", async () => {
  const { provider } = mockEngineProvider();
  provider.engine.complete = async () => completionEnvelope('```json\n{"a":1}\n```');
  assert.deepEqual(await drcCompleteJson(provider, "", "m", []), { a: 1 });
  provider.engine.complete = async () => completionEnvelope("no json at all");
  await assert.rejects(() => drcCompleteJson(provider, "", "m", []), /no usable JSON/);
});
