// Request-layer tests for `handleChat` (src/chat.js) — the /api/chat entry
// point, driven end to end against fakes.
//
// Why this file exists. `src/chat.js` is 1195 lines and `src/chat.test.js`
// covered three re-exported helpers, leaving `handleChat` itself — and with it
// the whole server-side request path — unexecuted by any test. Most of what
// that path is *promising* is stated in CLAUDE.md's load-bearing invariants,
// so the promises had no mechanical enforcement:
//
//   - invariant 4: "the server keeps a full-visibility interaction log
//     (chat_logs) UNLESS the request carries `incognito: true` — that API
//     promise must keep suppressing the row." A documented privacy promise,
//     implemented as one `if (!incognito)`, with no test on either side of it.
//   - invariant 4: "outbound requests to third parties carry the minimum —
//     never the conversation, filename, or identity", and "secrets never
//     appear in any log".
//   - invariant 2: helper phases fail soft; a failing helper degrades the
//     result rather than erroring the chat.
//   - invariant 3: the JSON planning phases always run on DEFAULT_MODEL,
//     whatever the user picked to answer with.
//
// None of that needs a browser, a credential, or the network — only a
// plausible `env`. The harness below is the shared test helpers
// (src/test-helpers/) plus a fake Berget: a models catalog and a
// chat-completions endpoint that answers JSON-mode calls with a planning
// object and streamed calls with an SSE body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { handleChat } from "./chat.js";
import { DEFAULT_MODEL } from "./berget.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { fakeFetch } from "./test-helpers/fetch.js";
import { fakeAdmin, fakeEnv, fakeLog, fakeIdentity, fakeCtx, jsonRequest } from "./test-helpers/env.js";

const BERGET = "https://berget.test/v1";
const ANSWER_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";
const SECOND_MODEL = "openai/gpt-oss-120b";

/** A Berget /models body carrying two streaming+json-mode text models. */
const MODELS_BODY = {
  data: [ANSWER_MODEL, SECOND_MODEL].map((id) => ({
    id,
    name: id,
    model_type: "text",
    capabilities: { streaming: true, json_mode: true },
    pricing: { input: 0.3, output: 0.3, unit: "€ / M Token" },
    status: { up: true },
  })),
};

/**
 * An OpenAI-style SSE body. `finish_reason` matters: without it the stream
 * reader reports a dropped connection (which is itself the fail-soft path
 * exercised in "a truncated provider stream").
 * @param {string} text
 * @param {{ finish?: boolean }} [opts]
 */
function sseBody(text, opts = {}) {
  const frames = [{ choices: [{ delta: { content: text } }] }];
  if (opts.finish !== false) frames.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  frames.push({ usage: { prompt_tokens: 120, completion_tokens: 40 } });
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
}

/**
 * Install a fake Berget as `globalThis.fetch` and return the recorder.
 *
 * The recorder is what makes the invariant-4 assertions possible: every
 * outbound request is captured with its body, so a test can ask what actually
 * left the Worker.
 *
 * @param {{ answer?: string, plan?: object, finish?: boolean }} [opts]
 */
function installBerget(opts = {}) {
  const plan = opts.plan || { needs_search: false, queries: [], sufficient: true, verdict: "ok", ok: true };
  const stub = fakeFetch([
    [/\/models$/, MODELS_BODY],
    [
      /\/chat\/completions$/,
      (r) => {
        const body = JSON.parse(r.body || "{}");
        // JSON-mode planning phases are non-streaming; synthesis streams.
        if (body.stream !== true) {
          return {
            choices: [{ message: { content: JSON.stringify(plan) } }],
            usage: { prompt_tokens: 90, completion_tokens: 20 },
          };
        }
        return new Response(sseBody(opts.answer ?? "The answer.", { finish: opts.finish }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    ],
  ]);
  globalThis.fetch = /** @type {any} */ (stub);
  return stub;
}

/**
 * Drive one full /api/chat request: send it, drain the SSE response, and
 * settle the background work the handler defers with `waitUntil` (the
 * chat-log write among it).
 *
 * @param {object} [body] request body overrides
 * @param {object} [opts]
 * @param {any} [opts.db]
 * @param {any} [opts.identity]
 * @param {any} [opts.env] extra env overrides
 * @param {object} [opts.berget] installBerget options
 */
async function runChat(body = {}, opts = {}) {
  const stub = installBerget(opts.berget);
  const db = opts.db || fakeD1();
  const env = fakeEnv({ DB: db, BERGET_URL: BERGET, ...(opts.env || {}) });
  const log = fakeLog();
  const ctx = fakeCtx();
  const request = jsonRequest("https://deepresearch.test/api/chat", {
    messages: [{ role: "user", content: "what is the capital of Sweden" }],
    web_search: false,
    ...body,
  });
  const response = await handleChat(request, env, log, opts.identity || fakeIdentity(), ctx, "req-test-1");
  const text = response.headers.get("content-type")?.includes("event-stream")
    ? await response.text()
    : await response.text();
  await ctx.settle();
  return { response, text, db, log, env, ctx, stub };
}

/** The statement family the incognito promise is about. */
const CHAT_LOG_INSERT = /INSERT INTO chat_logs/;

describe("handleChat — the incognito promise (invariant 4)", () => {
  test("a normal request WRITES the full-visibility chat_logs row", async () => {
    const { db, response } = await runChat({ incognito: false });
    assert.equal(response.status, 200);
    assert.equal(db.ran(CHAT_LOG_INSERT), true, "the interaction log row must be written by default");
  });

  test("incognito: true SUPPRESSES the chat_logs row entirely", async () => {
    const { db, response } = await runChat({ incognito: true });
    assert.equal(response.status, 200, "the request still succeeds");
    assert.equal(db.ran(CHAT_LOG_INSERT), false, "no chat_logs row may be written for a ghost conversation");
  });

  test("suppression is exact — only chat_logs goes; quota accounting still runs", async () => {
    // The promise is about the interaction LOG, not about becoming invisible:
    // usage still has to be accounted or the quota model breaks. This pins the
    // boundary, so a future "fix" that suppresses more (or less) fails here.
    const { db } = await runChat({ incognito: true });
    assert.equal(db.ran(CHAT_LOG_INSERT), false);
    assert.equal(db.ran(/INSERT INTO usage_events/), true, "usage accounting is not suppressed");
  });

  test("the promise keys on `true` exactly, not on truthiness", async () => {
    // `incognito` arrives over the wire. Anything but the boolean true is a
    // malformed request, and a malformed request must not silently buy
    // suppression the user did not ask for — nor lose it.
    for (const value of ["true", 1, {}, [], "yes"]) {
      const { db } = await runChat({ incognito: /** @type {any} */ (value) });
      assert.equal(db.ran(CHAT_LOG_INSERT), true, `incognito: ${JSON.stringify(value)} must not suppress the row`);
    }
  });

  test("an absent incognito field logs, matching the documented default", async () => {
    const { db } = await runChat({});
    assert.equal(db.ran(CHAT_LOG_INSERT), true);
  });

  test("the written row carries the question and answer it promises", async () => {
    const { db } = await runChat({ incognito: false }, { berget: { answer: "Stockholm is the capital." } });
    const [call] = db.callsMatching(CHAT_LOG_INSERT);
    assert.ok(call, "a chat_logs INSERT ran");
    const bound = call.bindings.map((b) => (typeof b === "string" ? b : ""));
    assert.ok(
      bound.some((b) => b.includes("capital of Sweden")),
      "the question is in the row",
    );
    assert.ok(
      bound.some((b) => b.includes("Stockholm is the capital.")),
      "the answer is in the row",
    );
  });

  test("incognito is reported in the metadata log line, so the choice stays auditable", async () => {
    const { log } = await runChat({ incognito: true });
    assert.match(log.text(), /"incognito":true/);
  });
});

describe("handleChat — outbound minimum disclosure (invariant 4)", () => {
  test("no provider request carries the user's identity", async () => {
    const identity = fakeIdentity({ id: "user-secret-42" });
    const { stub } = await runChat({}, { identity });
    stub.assertNoneCarry([identity.id, identity.email, identity.name], (m) => assert.fail(m));
  });

  test("every outbound request goes to the configured provider and nowhere else", async () => {
    const { stub } = await runChat({});
    assert.deepEqual(stub.hosts(), ["berget.test"], "web_search off ⇒ the provider is the only host contacted");
  });

  test("the provider secret never reaches a log line", async () => {
    const { log, env } = await runChat({});
    log.assertNoneLogged([env.BERGET_API_TOKEN], (m) => assert.fail(m));
  });

  test("the secret DOES go to the provider, in the auth header only", async () => {
    // The mirror of the test above: minimum disclosure is not "send nothing".
    const { stub, env } = await runChat({});
    const calls = stub.matching(/berget\.test/);
    assert.ok(calls.length > 0);
    assert.equal(calls[0].headers.authorization, `Bearer ${env.BERGET_API_TOKEN}`);
    for (const c of calls) assert.ok(!c.url.includes(env.BERGET_API_TOKEN), "never in a URL");
  });
});

describe("handleChat — split model routing (invariant 3)", () => {
  test("the JSON planning phases run on DEFAULT_MODEL even when the answer model differs", async () => {
    const { stub, text } = await runChat({ model: SECOND_MODEL, web_search: true });
    const completions = stub.matching(/chat\/completions/).map((r) => JSON.parse(r.body || "{}"));
    const planning = completions.filter((b) => b.stream !== true);
    const streamed = completions.filter((b) => b.stream === true);
    assert.ok(planning.length > 0, "at least one JSON planning call was made");
    for (const p of planning) {
      assert.equal(p.model, DEFAULT_MODEL, "every planning phase pins the fixed reliable model");
    }
    assert.ok(streamed.length > 0, "synthesis streamed");
    for (const s of streamed) assert.equal(s.model, SECOND_MODEL, "synthesis uses the user's pick");
    assert.match(text, /"model":"openai\/gpt-oss-120b"/);
  });

  test("the completion event reports the answer model, not the planning model", async () => {
    const { text } = await runChat({ model: SECOND_MODEL });
    const done = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6));
        } catch {
          return null;
        }
      })
      .find((e) => e?.status?.type === "done");
    assert.ok(done, "a done event was emitted");
    assert.equal(done.status.model, SECOND_MODEL);
  });
});

describe("handleChat — request validation", () => {
  test("a missing provider secret is a 500 that names the missing config", async () => {
    installBerget();
    const env = fakeEnv({ BERGET_API_TOKEN: null, BERGET_URL: BERGET });
    const resp = await handleChat(
      jsonRequest("https://deepresearch.test/api/chat", { messages: [{ role: "user", content: "hi" }] }),
      env,
      fakeLog(),
      fakeIdentity(),
      fakeCtx(),
      "req-1",
    );
    assert.equal(resp.status, 500);
    assert.match((await resp.json()).error, /BERGET_API_TOKEN/);
  });

  test("a non-JSON body is a 400, not a crash", async () => {
    installBerget();
    const request = new Request("https://deepresearch.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const resp = await handleChat(request, fakeEnv({ BERGET_URL: BERGET }), fakeLog(), fakeIdentity(), fakeCtx(), "r");
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /valid JSON/i);
  });

  test("an invalid messages array is a 400 carrying the reason", async () => {
    installBerget();
    for (const messages of [undefined, [], "hello", [{ role: "user" }]]) {
      const resp = await handleChat(
        jsonRequest("https://deepresearch.test/api/chat", { messages }),
        fakeEnv({ BERGET_URL: BERGET }),
        fakeLog(),
        fakeIdentity(),
        fakeCtx(),
        "r",
      );
      assert.equal(resp.status, 400, `messages: ${JSON.stringify(messages)}`);
      assert.equal(typeof (await resp.json()).error, "string");
    }
  });

  test("a rejected request never reaches the provider or the log", async () => {
    const stub = installBerget();
    const db = fakeD1();
    await handleChat(
      jsonRequest("https://deepresearch.test/api/chat", { messages: [] }),
      fakeEnv({ DB: db, BERGET_URL: BERGET }),
      fakeLog(),
      fakeIdentity(),
      fakeCtx(),
      "r",
    );
    assert.equal(stub.matching(/chat\/completions/).length, 0);
    assert.equal(db.ran(CHAT_LOG_INSERT), false);
  });
});

describe("handleChat — fail soft (invariant 2)", () => {
  test("a failing chat_logs write does not break the answer", async () => {
    const db = fakeD1().failOn(CHAT_LOG_INSERT);
    const { response, text } = await runChat({}, { db });
    assert.equal(response.status, 200);
    assert.match(text, /The answer\./, "the user still got their answer");
  });

  test("no D1 binding at all still answers", async () => {
    // The DOCUMENTED degraded mode (types.d.ts: "DB? — optional; absent means
    // break-glass-auth-only, no quotas"). Absent is not an error.
    const { response, text } = await runChat({}, { env: { DB: null } });
    assert.equal(response.status, 200);
    assert.match(text, /The answer\./);
  });

  test("a per-statement D1 failure degrades — the row is lost, the answer is not", async () => {
    // Every helper that writes through D1 during a request (usage accounting,
    // the chat log, the answer cache) is individually wrapped. This is the
    // fail-soft ladder invariant 2 describes, and it holds.
    const db = fakeD1().failOn(/INSERT INTO/);
    const { response, text } = await runChat({}, { db });
    assert.equal(response.status, 200);
    assert.match(text, /The answer\./);
  });

  test("a TOTAL D1 outage is REFUSED — 503, and never a silent answer", async () => {
    // This test used to pin the same DIRECTION with a worse mechanism: the
    // throw from `getDb`'s uncaught schema `batch(...)` escaped the handler and
    // index.js turned it into a generic 500 with a request id. Its comment
    // asked whoever changed it to think about the quota-bypass consequence
    // first, so: the direction is KEPT (an unreadable usage store must never
    // degrade to "no quota enforcement" — that is free spend at exactly the
    // moment the spend also cannot be recorded), and only the mechanism moved
    // from an unhandled rejection to a chosen refusal. 2026-08-05, alongside
    // the matching decision on /mcp (src/mcp-inflight.test.js).
    //
    // 503, deliberately: a 500 reads as a crash, and a 429 would claim a limit
    // the user has not reached. The reasoning — including why the concurrency
    // reservation next to this gate keeps failing the OTHER way — is above
    // QUOTA_UNAVAILABLE_STATUS in quota.js.
    const db = fakeD1().failOn(/.*/);
    const { response, text } = await runChat({}, { db });
    assert.equal(response.status, 503);
    const body = JSON.parse(text);
    assert.equal(body.quota_unavailable, true);
    assert.match(body.error, /not a limit on your account/i);
    assert.ok(!/D1_ERROR/.test(body.error), "the raw database error stays in the logs");
  });

  test("an ADMIN still gets through a total D1 outage", async () => {
    // Admins are exempt from the quota gate, so the refusal above is the gate
    // deciding rather than the request path collapsing: with nothing to verify,
    // the same dead database answers normally.
    const db = fakeD1().failOn(/.*/);
    const { response, text } = await runChat({}, { db, identity: fakeAdmin() });
    assert.equal(response.status, 200);
    assert.match(text, /The answer\./);
  });

  test("a truncated provider stream degrades to an error event, not a failed request", async () => {
    const { response, text } = await runChat({}, { berget: { finish: false } });
    assert.equal(response.status, 200, "the SSE response itself still completes");
    assert.match(text, /"error"/, "the drop is reported in-band");
    assert.match(text, /\[DONE\]/, "and the stream is closed properly");
  });

  test("an unparseable planning response degrades rather than erroring the chat", async () => {
    const stub = fakeFetch([
      [/\/models$/, MODELS_BODY],
      [
        /\/chat\/completions$/,
        (r) => {
          const body = JSON.parse(r.body || "{}");
          if (body.stream !== true) return { choices: [{ message: { content: "not json at all" } }] };
          return new Response(sseBody("Answered anyway."), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      ],
    ]);
    globalThis.fetch = /** @type {any} */ (stub);
    const ctx = fakeCtx();
    const resp = await handleChat(
      jsonRequest("https://deepresearch.test/api/chat", {
        messages: [{ role: "user", content: "hello" }],
        web_search: true,
      }),
      fakeEnv({ DB: fakeD1(), BERGET_URL: BERGET }),
      fakeLog(),
      fakeIdentity(),
      ctx,
      "r",
    );
    const text = await resp.text();
    await ctx.settle();
    assert.equal(resp.status, 200);
    assert.match(text, /Answered anyway\./);
  });
});

describe("handleChat — the SSE contract", () => {
  test("the response is an event-stream that ends with [DONE]", async () => {
    const { response, text } = await runChat({});
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(text, /data: \[DONE\]\s*$/);
  });

  test("every frame is a `data: ` line carrying parseable JSON (or [DONE])", async () => {
    const { text } = await runChat({});
    const lines = text.split("\n").filter((l) => l.trim());
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.match(line, /^data: /, `unexpected frame: ${line}`);
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      assert.doesNotThrow(() => JSON.parse(payload), `unparseable frame: ${line}`);
    }
  });

  test("the answer text reaches the client in delta frames", async () => {
    const { text } = await runChat({}, { berget: { answer: "Stockholm." } });
    assert.match(text, /"content":"Stockholm\."/);
  });

  test("a done event closes the stream with the run's stats", async () => {
    const { text } = await runChat({});
    const done = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.includes('"done"'))
      .map((l) => JSON.parse(l.slice(6)))
      .find((e) => e?.status?.type === "done");
    assert.ok(done, "a done status event was emitted");
    for (const key of ["model", "rounds", "duration_ms", "prompt_tokens", "completion_tokens"]) {
      assert.ok(key in done.status, `done event carries ${key}`);
    }
  });

  test("web_search: false takes the search-off route and runs no search", async () => {
    const { text } = await runChat({ web_search: false });
    assert.match(text, /"route":"search_off"/);
    const done = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6));
        } catch {
          return null;
        }
      })
      .find((e) => e?.status?.type === "done");
    assert.equal(done.status.searches, 0);
  });
});
