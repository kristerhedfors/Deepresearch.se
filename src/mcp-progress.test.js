// Unit tests for PROGRESS over SSE on POST /mcp (src/mcp.js).
//
// The defect these pin, observed 2026-08-13 in Workers Logs on
// mcp.deepresearch.se: a voice session's two `deep_research` calls ran 86.5 s
// and 50.5 s, both finished `ok` server-side, and the connector immediately
// tore the connection down and re-`initialize`d — a client giving up on a
// server that had sent it nothing at all since the POST. Nothing was logged as
// an error because nothing failed on this side; the whole failure lived in the
// silence.
//
// What must hold:
//
//   * a tools/call from a client that accepts text/event-stream is answered as
//     an SSE stream whose LAST frame is the JSON-RPC response it would have
//     got as plain JSON — the envelope is unchanged, only the transport moved;
//   * while the tool runs, the stream carries keepalive comments and (only
//     when the caller supplied a progressToken) notifications/progress whose
//     `progress` INCREASES, which is what lets a client reset its timeout;
//   * a client that does not accept SSE keeps the buffered JSON response, byte
//     for byte — that is every existing caller;
//   * initialize / tools/list stay plain JSON: they answer in milliseconds, and
//     an SSE frame there buys nothing and risks a client that reads the body
//     as JSON.
//
// The suite drives the real handleMcp with a controllable slow tool (a fake
// Vectorize index whose describe() hangs until the test releases it) and
// node:test's timer mocks, so the ticking is exercised without waiting
// PROGRESS_INTERVAL_MS for real. Nothing here reaches the network or the
// pipeline.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_INTERVAL_MS,
  acceptsEventStream,
  handleMcp,
  progressMessage,
  progressNotification,
  progressTokenOf,
  sseFrame,
} from "./mcp.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = /** @type {any} */ ({ waitUntil() {} });
const user = /** @type {any} */ ({ id: "u1", role: "admin", email: "u@example.com", name: "U", user: null });

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

describe("acceptsEventStream", () => {
  test("accepts the header the MCP spec requires a client to send", () => {
    assert.equal(acceptsEventStream("application/json, text/event-stream"), true);
    assert.equal(acceptsEventStream("TEXT/EVENT-STREAM"), true);
  });

  test("refuses anything that did not ask for a stream", () => {
    for (const bad of ["application/json", "*/*", "", null, undefined, 42]) {
      assert.equal(acceptsEventStream(/** @type {any} */ (bad)), false, `should refuse ${bad}`);
    }
  });
});

describe("progressTokenOf", () => {
  test("reads a string or integer token out of params._meta", () => {
    assert.equal(progressTokenOf({ _meta: { progressToken: "abc123" } }), "abc123");
    assert.equal(progressTokenOf({ _meta: { progressToken: 7 } }), 7);
    assert.equal(progressTokenOf({ _meta: { progressToken: 0 } }), 0);
  });

  test("degrades to no-progress rather than guessing at a malformed token", () => {
    // The spec allows exactly a string or an integer, and forbids referencing a
    // token that was never provided — so anything else means "send none".
    for (const bad of [undefined, null, "", {}, [], true, Number.NaN]) {
      assert.equal(progressTokenOf({ _meta: { progressToken: bad } }), null, `should refuse ${JSON.stringify(bad)}`);
    }
    assert.equal(progressTokenOf({}), null);
    assert.equal(progressTokenOf(undefined), null);
  });
});

describe("progressNotification", () => {
  test("is a JSON-RPC notification — no id — carrying the caller's token", () => {
    const n = progressNotification("abc123", 3, null, "Searching the web (30s)");
    assert.deepEqual(n, {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "abc123", progress: 3, message: "Searching the web (30s)" },
    });
    assert.ok(!("id" in n), "a notification must carry no id");
  });

  test("omits total when there is none to report", () => {
    const n = progressNotification(1, 1, null);
    assert.ok(!("total" in n.params));
    assert.ok(!("message" in n.params));
  });

  test("includes total when one is given", () => {
    assert.equal(progressNotification(1, 1, 10).params.total, 10);
  });
});

test("sseFrame serializes one JSON-RPC message as an SSE data frame", () => {
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
});

describe("progressMessage", () => {
  test("names the phase the pipeline reported, with elapsed seconds", () => {
    assert.equal(progressMessage("Searching the web", 35), "Searching the web (35s)");
  });

  test("still says something true before any phase has started", () => {
    assert.equal(progressMessage("", 5), "Researching… (5s)");
  });
});

// ---------------------------------------------------------------------------
// The transport, driven through the real handler
// ---------------------------------------------------------------------------

/**
 * A fake Vectorize index whose describe() hangs until the test releases it —
 * the controllable "slow tool" the ticking tests need.
 * @param {{ hang?: Promise<void> }} [opts]
 */
function fakeIndex({ hang } = {}) {
  return {
    async query() {
      return { matches: [] };
    },
    async getByIds() {
      return [];
    },
    async describe() {
      if (hang) await hang;
      return { vectorCount: 772658, dimensions: 1024 };
    },
  };
}

/** @param {{ accept?: string | null, method?: string, params?: any, id?: unknown }} opts */
function rpcRequest({ accept, method = "tools/call", params, id = 42 } = {}) {
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (accept) headers.accept = accept;
  return new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const SSE_ACCEPT = "application/json, text/event-stream";

/** Split an SSE body into its comment lines and its parsed data frames. */
function readFrames(text) {
  const comments = [];
  const messages = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line) continue;
    if (line.startsWith(":")) comments.push(line);
    else if (line.startsWith("data: ")) messages.push(JSON.parse(line.slice(6)));
  }
  return { comments, messages };
}

describe("tools/call over SSE", () => {
  test("answers text/event-stream and ends with the same JSON-RPC response", async () => {
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() });
    const res = await handleMcp(
      rpcRequest({ accept: SSE_ACCEPT, params: { name: "literature_corpora", arguments: {} } }),
      env,
      /** @type {any} */ (silentLog),
      user,
      ctx,
      "req-sse",
    );
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const { messages } = readFrames(await res.text());
    const last = messages[messages.length - 1];
    assert.equal(last.jsonrpc, "2.0");
    assert.equal(last.id, 42);
    assert.ok(last.result.content[0].text.includes("arxiv"), "the real tool result travelled");
    assert.equal(last.result.isError, false);
  });

  test("a client that did not ask for a stream keeps the buffered JSON response", async () => {
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() });
    const res = await handleMcp(
      rpcRequest({ accept: "application/json", params: { name: "literature_corpora", arguments: {} } }),
      env,
      /** @type {any} */ (silentLog),
      user,
      ctx,
      "req-json",
    );
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.id, 42);
    assert.ok(body.result.content[0].text.includes("arxiv"));
  });

  test("a tool-level failure still travels as an isError result, not a broken stream", async () => {
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t" });
    const res = await handleMcp(
      rpcRequest({ accept: SSE_ACCEPT, params: { name: "literature_invent", arguments: {} } }),
      env,
      /** @type {any} */ (silentLog),
      user,
      ctx,
      "req-unknown",
    );
    const { messages } = readFrames(await res.text());
    const last = messages[messages.length - 1];
    assert.equal(last.id, 42);
    assert.equal(last.error.code, -32602, "unknown tool is still invalid-params");
  });

  test("initialize and tools/list stay plain JSON — they answer in milliseconds", async () => {
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t" });
    for (const method of ["initialize", "tools/list"]) {
      const res = await handleMcp(
        rpcRequest({ accept: SSE_ACCEPT, method }),
        env,
        /** @type {any} */ (silentLog),
        user,
        ctx,
        `req-${method}`,
      );
      assert.match(res.headers.get("content-type") || "", /application\/json/, `${method} must not stream`);
    }
  });
});

describe("while the tool runs", () => {
  test("sends keepalives and increasing progress notifications before the response", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let release = () => {};
    const hang = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ hang }) });

    const res = await handleMcp(
      rpcRequest({
        accept: SSE_ACCEPT,
        params: { name: "literature_corpora", arguments: {}, _meta: { progressToken: "tok-1" } },
      }),
      env,
      /** @type {any} */ (silentLog),
      user,
      ctx,
      "req-progress",
    );

    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body.getReader());
    const decoder = new TextDecoder();
    let seen = "";
    // Two ticks while the tool is still hanging: each writes a keepalive
    // comment and one progress notification.
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(PROGRESS_INTERVAL_MS);
      const a = await reader.read();
      const b = await reader.read();
      seen += decoder.decode(a.value) + decoder.decode(b.value);
    }

    const during = readFrames(seen);
    assert.equal(during.comments.length, 2, "one keepalive comment per tick");
    assert.equal(during.messages.length, 2, "one progress notification per tick");
    for (const m of during.messages) {
      assert.equal(m.method, "notifications/progress");
      assert.equal(m.params.progressToken, "tok-1");
      assert.ok(!("id" in m), "progress is a notification, never a response");
    }
    assert.ok(
      during.messages[1].params.progress > during.messages[0].params.progress,
      "progress MUST increase with each notification",
    );
    assert.match(during.messages[0].params.message, /\(\d+s\)/, "the message says how long it has been running");

    // Now let the tool finish: the response is the next frame, then the stream
    // closes — nothing is sent after the response.
    release();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    const after = readFrames(rest);
    assert.equal(after.messages.length, 1, "exactly one response frame, and nothing after it");
    assert.equal(after.messages[0].id, 42);
    assert.ok(after.messages[0].result, "the tool result, unchanged by the transport");
  });

  test("without a progressToken it keeps the connection alive but sends no progress", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let release = () => {};
    const hang = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ hang }) });

    const res = await handleMcp(
      rpcRequest({ accept: SSE_ACCEPT, params: { name: "literature_corpora", arguments: {} } }),
      env,
      /** @type {any} */ (silentLog),
      user,
      ctx,
      "req-no-token",
    );
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body.getReader());
    const decoder = new TextDecoder();

    t.mock.timers.tick(PROGRESS_INTERVAL_MS);
    const first = await reader.read();
    const tick = readFrames(decoder.decode(first.value));
    assert.equal(tick.comments.length, 1, "the keepalive comment still flows");
    assert.equal(tick.messages.length, 0, "no token means no progress notification — the spec forbids inventing one");

    release();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    assert.equal(readFrames(rest).messages.length, 1, "the response still arrives");
  });
});
