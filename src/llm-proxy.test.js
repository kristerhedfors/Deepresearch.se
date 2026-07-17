// Direct coverage of the shared LLM reverse-proxy forwarders (src/llm-proxy.js)
// — the leaf behind BOTH server-touching grant surfaces (src/proxy.js's bundle
// LLM proxy and src/server-grants.js's Se/rver-token LLM endpoint). The
// endpoint suites exercise these through their meters; this suite pins the
// forwarders' own contract: the server-key swap, the known-fields-only
// re-serialization + output clamp, and the refund-on-failure ladder.

import test from "node:test";
import assert from "node:assert/strict";
import { forwardLlmCompletion, forwardLlmModels } from "./llm-proxy.js";

const ENV = /** @type {any} */ ({ BERGET_URL: "https://berget.test/v1", BERGET_API_TOKEN: "srv-key" });
const log = /** @type {any} */ ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

/** Run fn with global fetch replaced; restores afterwards. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (impl);
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** A fresh opts object whose refund/remaining calls are counted. */
function meter(remaining = 7) {
  const m = { refunds: 0, reads: 0 };
  return {
    m,
    opts: {
      refund: async () => void m.refunds++,
      remainingAfter: async () => (m.reads++, remaining),
      tagPrefix: "test.llm",
      ids: { uid: "u1", jti: "j1" },
    },
  };
}

test("forwardLlmModels forwards the catalog on the SERVER key", async () => {
  /** @type {any} */ let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    },
    () => forwardLlmModels(ENV)
  );
  assert.equal(seen.url, "https://berget.test/v1/models");
  assert.equal(seen.init.headers.authorization, "Bearer srv-key");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, [{ id: "m" }]);
});

test("forwardLlmModels degrades to an empty 502 catalog on upstream failure", async () => {
  const res = await withFetch(
    async () => {
      throw new Error("boom");
    },
    () => forwardLlmModels(ENV)
  );
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { data: [] });
});

test("forwardLlmCompletion re-serializes ONLY known fields, swaps the key, clamps max_tokens", async () => {
  /** @type {any} */ let seen;
  const { m, opts } = meter(4);
  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 999_999, // above the clamp
    temperature: 0.5,
    authorization: "Bearer client-key", // hostile extra field — must not pass through
    stream_options: { include_usage: true }, // unknown field — must not pass through
  };
  const res = await withFetch(
    async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    },
    () => forwardLlmCompletion(ENV, log, body, opts)
  );
  assert.equal(seen.url, "https://berget.test/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer srv-key");
  assert.equal(seen.body.max_tokens, 8192); // the LLM_MAX_TOKENS ceiling
  assert.equal(seen.body.temperature, 0.5);
  assert.ok(!("authorization" in seen.body) && !("stream_options" in seen.body));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).remaining, 4); // remaining is appended
  assert.equal(m.refunds, 0); // success never refunds
});

test("forwardLlmCompletion refunds when the upstream never connects", async () => {
  const { m, opts } = meter();
  const res = await withFetch(
    async () => {
      throw new Error("connect timeout");
    },
    () => forwardLlmCompletion(ENV, log, { messages: [] }, opts)
  );
  assert.equal(res.status, 502);
  assert.equal(m.refunds, 1);
});

test("forwardLlmCompletion refunds when the upstream rejects", async () => {
  const { m, opts } = meter();
  const res = await withFetch(
    async () => new Response("bad key", { status: 401 }),
    () => forwardLlmCompletion(ENV, log, { messages: [] }, opts)
  );
  assert.equal(res.status, 502);
  assert.equal(m.refunds, 1);
  assert.equal((await res.json()).detail, "bad key");
});

test("forwardLlmCompletion pipes a streaming upstream straight back with the remaining header", async () => {
  const { m, opts } = meter(2);
  const res = await withFetch(
    async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response("data: {}\n\n", { status: 200 });
    },
    () => forwardLlmCompletion(ENV, log, { messages: [], stream: true }, opts)
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("x-proxy-remaining"), "2");
  assert.equal(await res.text(), "data: {}\n\n");
  assert.equal(m.refunds, 0); // connected OK — a mid-stream failure never refunds
});
