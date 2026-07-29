#!/usr/bin/env node
// A stand-in for the LLM provider, for LOCAL end-to-end runs.
//
// The mocked Playwright project intercepts `/api/chat` in the BROWSER, which
// covers the specs that drive the UI. It does not cover the ones that call the
// Worker directly through Playwright's request context (tests/e2e/api.spec.js),
// and it does not cover the model catalog: `/api/models` is never intercepted,
// so the app fetches a real catalog on every page load and the whole UI fails
// to render without one. Against the deployed site that catalog comes from
// Berget. Locally there is no key, and there should not need to be one.
//
// So this serves the OpenAI-compatible surface `src/berget.js` speaks —
// `/v1/models`, `/v1/chat/completions`, `/v1/embeddings` — on loopback, and
// wrangler.dev.toml points `BERGET_URL` at it (a test-only override that
// already exists for exactly this purpose). Nothing leaves the machine and
// nothing is spent.
//
// Deliberately dependency-free (node:http only), matching the repo's
// minimal-dependency stance: it is started by Playwright's `webServer`, so it
// must run with no install step of its own.
//
// The catalog carries BOTH a vision-capable and a non-vision model because the
// specs discover their fixtures from it — `api.spec.js` skips its image-
// rejection case when no non-vision model exists, and `helpers.js`
// `selectModel({wantVision:true})` fails outright when no vision model does.
// Keeping both here keeps those cases exercised rather than silently skipped.

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PROVIDER_PORT || 8799);

/** Mirrors Berget's catalog shape, including the `€ / M Token` pricing unit. */
const MODELS = [
  {
    id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    name: "Mistral Small 3.2 24B (local fake)",
    model_type: "text",
    capabilities: { streaming: true, json_mode: true, vision: true },
    pricing: { input: 0.3, output: 0.3, unit: "€ / M Token" },
    status: { up: true },
  },
  {
    id: "local-fake/text-only-8b",
    name: "Text Only 8B (local fake)",
    model_type: "text",
    capabilities: { streaming: true, json_mode: true, vision: false },
    pricing: { input: 0.1, output: 0.1, unit: "€ / M Token" },
    status: { up: true },
  },
  {
    // A DOWN model, so the "skips catalog models that are DOWN" cases have
    // something to skip.
    id: "local-fake/offline-model",
    name: "Offline Model (local fake)",
    model_type: "text",
    capabilities: { streaming: true, json_mode: true, vision: false },
    pricing: { input: 0.1, output: 0.1, unit: "€ / M Token" },
    status: { up: false },
  },
];

/** The planning phases are JSON-mode; anything they cannot parse fails soft. */
const PLAN = {
  needs_search: false,
  queries: [],
  sufficient: true,
  verdict: "ok",
  ok: true,
  complete: true,
};

const ANSWER = "This is a local fake provider answer.";

/** @param {import('node:http').ServerResponse} res */
function json(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** An OpenAI-style SSE completion, ending with a finish_reason and [DONE]. */
function stream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  frame({ choices: [{ delta: { role: "assistant", content: ANSWER } }] });
  frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
  frame({ usage: { prompt_tokens: 120, completion_tokens: 40 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/^\/v1/, "");

  if (path === "/models" && req.method === "GET") return json(res, { data: MODELS });
  if (path === "/health") return json(res, { ok: true });

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (path === "/chat/completions" && req.method === "POST") {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        /* fall through to the JSON branch */
      }
      if (parsed.stream === true) return stream(res);
      return json(res, {
        choices: [{ message: { role: "assistant", content: JSON.stringify(PLAN) } }],
        usage: { prompt_tokens: 90, completion_tokens: 20 },
      });
    }
    if (path === "/embeddings" && req.method === "POST") {
      let input = [];
      try {
        const parsed = JSON.parse(body || "{}");
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      } catch {
        input = [""];
      }
      // A constant unit vector: retrieval stays deterministic, and no test
      // asserts on semantic ordering from this server.
      return json(res, {
        data: input.map((_, index) => ({ index, embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)) })),
        usage: { prompt_tokens: 8, total_tokens: 8 },
      });
    }
    json(res, { error: { message: `fake-provider: no route for ${req.method} ${url.pathname}` } }, 404);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-provider listening on http://127.0.0.1:${PORT}/v1 (${MODELS.length} models)`);
});
