import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildFreeEnv,
  freeIdOk,
  handleFreeApi,
  missingKeyFor,
  validateFreeMessages,
} from "./free.js";

// ---- helpers -----------------------------------------------------------------

function mockBucket() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v
        ? {
            body: v.bytes,
            customMetadata: v.meta,
            text: async () => new TextDecoder().decode(v.bytes instanceof Uint8Array ? v.bytes : new Uint8Array(v.bytes)),
          }
        : null;
    },
    async put(key, bytes, opts) {
      const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
      store.set(key, { bytes: buf, meta: opts?.customMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
  };
}

// A capturing logger so tests can assert what free mode does NOT log.
function captureLog() {
  const lines = [];
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), lines };
}

const VALID_ID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function call(env, log, method, path, body, headers = {}) {
  const url = new URL("https://example.test" + path);
  const request = new Request(url, { method, body, headers });
  return handleFreeApi(request, env, url, log);
}

// Seal a provider-key bundle the way the client does (free-core.js), so the
// server-side transient decrypt is exercised against the real client form.
async function sealBundle(keys, unlockBytes) {
  const key = await crypto.subtle.importKey("raw", unlockBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(keys)));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(cipher)) };
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

// ---- pure helpers ---------------------------------------------------------------

test("freeIdOk mirrors the vault id shape", () => {
  assert.equal(freeIdOk(VALID_ID), true);
  assert.equal(freeIdOk("short"), false);
  assert.equal(freeIdOk("a/b----------------"), false);
  assert.equal(freeIdOk(null), false);
});

test("buildFreeEnv contains ONLY user keys — operator credentials are unreachable", () => {
  const env = {
    BERGET_API_TOKEN: "operator-berget",
    ANTHROPIC_API_KEY: "operator-anthropic",
    OPENAI_API_KEY: "operator-openai",
    SESSION_SECRET: "sss",
    HISTORY_KEY_SECRET: "hhh",
    STORAGE: {},
  };
  const freeEnv = buildFreeEnv(env, { berget: "user-berget" });
  assert.equal(freeEnv.BERGET_API_TOKEN, "user-berget");
  assert.equal(freeEnv.ANTHROPIC_API_KEY, "");
  assert.equal(freeEnv.OPENAI_API_KEY, "");
  // Nothing else from the real env leaks through.
  assert.equal(freeEnv.SESSION_SECRET, undefined);
  assert.equal(freeEnv.HISTORY_KEY_SECRET, undefined);
  assert.equal(freeEnv.STORAGE, undefined);
  assert.equal(JSON.stringify(freeEnv).includes("operator"), false);
});

test("missingKeyFor routes by model-id namespace", () => {
  assert.equal(missingKeyFor("claude-sonnet-x", { anthropic: "k" }), null);
  assert.match(missingKeyFor("claude-sonnet-x", { berget: "k" }) || "", /Anthropic/);
  assert.equal(missingKeyFor("gpt-5.6-terra", { openai: "k" }), null);
  assert.match(missingKeyFor("gpt-5.6-terra", { anthropic: "k" }) || "", /OpenAI/);
  assert.equal(missingKeyFor("mistralai/Mistral-Small", { berget: "k" }), null);
  // The Berget-hosted lookalike keeps its Berget routing.
  assert.match(missingKeyFor("openai/gpt-oss-120b", {}) || "", /Berget/);
});

test("validateFreeMessages accepts plain turns and rejects everything else", () => {
  assert.deepEqual(validateFreeMessages([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
  assert.equal(validateFreeMessages([]), null);
  assert.equal(validateFreeMessages([{ role: "tool", content: "x" }]), null);
  assert.equal(validateFreeMessages([{ role: "user", content: ["parts"] }]), null);
  assert.equal(validateFreeMessages([{ role: "user", content: "" }]), null);
  assert.equal(validateFreeMessages("nope"), null);
});

// ---- storage endpoints -------------------------------------------------------------

test("503 without the R2 binding", async () => {
  const res = await call({}, captureLog(), "GET", "/api/free/blob/" + VALID_ID);
  assert.equal(res.status, 503);
});

test("blob PUT/GET/DELETE round-trip; caps enforced", async () => {
  const env = { STORAGE: mockBucket() };
  const log = captureLog();
  const blob = crypto.getRandomValues(new Uint8Array(64));

  const put = await call(env, log, "PUT", "/api/free/blob/" + VALID_ID, blob);
  assert.equal(put.status, 200);
  const get = await call(env, log, "GET", "/api/free/blob/" + VALID_ID);
  assert.equal(get.status, 200);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), blob);
  assert.ok(get.headers.get("x-free-updated"));

  const tiny = await call(env, log, "PUT", "/api/free/blob/" + VALID_ID, new Uint8Array(5));
  assert.equal(tiny.status, 400);
  const badId = await call(env, log, "GET", "/api/free/blob/short");
  assert.equal(badId.status, 400);

  const del = await call(env, log, "DELETE", "/api/free/blob/" + VALID_ID);
  assert.equal(del.status, 204);
  assert.equal((await call(env, log, "GET", "/api/free/blob/" + VALID_ID)).status, 404);
});

test("keys PUT validates the client-encrypted shape", async () => {
  const env = { STORAGE: mockBucket() };
  const log = captureLog();
  const bad = await call(env, log, "PUT", "/api/free/keys/" + VALID_ID, JSON.stringify({ plaintext: "sk-nope" }), {
    "content-type": "application/json",
  });
  assert.equal(bad.status, 400);
  const ok = await call(env, log, "PUT", "/api/free/keys/" + VALID_ID, JSON.stringify({ iv: "aaa", ciphertext: "bbb" }), {
    "content-type": "application/json",
  });
  assert.equal(ok.status, 200);
});

// ---- models + chat over a real mock provider ----------------------------------------

describe("free chat end to end (mock Berget over node:http)", () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "mistralai/Mock-Model",
                name: "Mock Model",
                model_type: "text",
                capabilities: { streaming: true, json_mode: true },
                pricing: { input: 1e-7, output: 2e-7, unit: "token" },
                status: { up: true },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          'data: {"choices":[{"delta":{"content":"Hello "}}]}',
          'data: {"choices":[{"delta":{"content":"from mock"},"finish_reason":"stop"}]}',
          'data: {"usage":{"prompt_tokens":7,"completion_tokens":3},"choices":[]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
    });
  });

  const unlock = crypto.getRandomValues(new Uint8Array(32));
  const env = { STORAGE: mockBucket() };

  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.BERGET_URL = `http://127.0.0.1:${server.address().port}/v1`;
    const sealed = await sealBundle({ berget: "user-berget-key" }, unlock);
    const put = await call(env, captureLog(), "PUT", "/api/free/keys/" + VALID_ID, JSON.stringify(sealed), {
      "content-type": "application/json",
    });
    assert.equal(put.status, 200);
  });
  after(() => server.close());

  test("models: listed from the user's own key", async () => {
    const res = await call(env, captureLog(), "POST", "/api/free/models", JSON.stringify({ keysId: VALID_ID, unlock: b64(unlock) }), { "content-type": "application/json" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.models.some((m) => m.id === "mistralai/Mock-Model"));
    const catalogReq = requests.find((r) => r.url.endsWith("/models"));
    assert.equal(catalogReq.headers.authorization, "Bearer user-berget-key");
  });

  test("chat: streams deltas, uses the USER key upstream, logs no content", async () => {
    const log = captureLog();
    const res = await call(
      env,
      log,
      "POST",
      "/api/free/chat",
      JSON.stringify({
        keysId: VALID_ID,
        unlock: b64(unlock),
        model: "mistralai/Mock-Model",
        messages: [{ role: "user", content: "VERY-PRIVATE-QUESTION-SENTINEL" }],
      }),
      { "content-type": "application/json" },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const raw = await res.text();
    assert.match(raw, /data: \{"delta":"Hello "\}/);
    assert.match(raw, /data: \[DONE\]/);
    assert.match(raw, /"finish_reason":"stop"/);

    // Upstream call carried the USER's key, and the full conversation.
    const chatReq = requests.find((r) => r.url.endsWith("/chat/completions"));
    assert.equal(chatReq.headers.authorization, "Bearer user-berget-key");
    assert.equal(chatReq.body.messages[0].content, "VERY-PRIVATE-QUESTION-SENTINEL");

    // THE promise: nothing content-derived, nothing key-derived in the logs.
    const logged = JSON.stringify(log.lines);
    assert.equal(logged.includes("VERY-PRIVATE-QUESTION-SENTINEL"), false);
    assert.equal(logged.includes("user-berget-key"), false);
    assert.equal(logged.includes(b64(unlock)), false);
    assert.equal(logged.includes("Hello "), false);
    // ...while the metadata trail exists.
    assert.ok(log.lines.some((l) => l.msg === "free.chat"));
    assert.ok(log.lines.some((l) => l.msg === "free.chat_complete"));
  });

  test("chat: a wrong unlock key cannot open the bundle", async () => {
    const res = await call(
      env,
      captureLog(),
      "POST",
      "/api/free/chat",
      JSON.stringify({
        keysId: VALID_ID,
        unlock: b64(crypto.getRandomValues(new Uint8Array(32))),
        model: "mistralai/Mock-Model",
        messages: [{ role: "user", content: "x" }],
      }),
      { "content-type": "application/json" },
    );
    assert.equal(res.status, 404);
  });

  test("chat: a model whose provider has no stored key is refused", async () => {
    const res = await call(
      env,
      captureLog(),
      "POST",
      "/api/free/chat",
      JSON.stringify({
        keysId: VALID_ID,
        unlock: b64(unlock),
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "x" }],
      }),
      { "content-type": "application/json" },
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /OpenAI/);
  });
});
