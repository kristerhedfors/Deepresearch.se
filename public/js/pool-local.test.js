// Unit tests for pool-local.js — the local-model half of shared compute,
// shared by BOTH tiers (feedback #31, 2026-07-26: a Se/rver tab lends the same
// pool a Se/cure tab does). The contract: normalize what the user typed, never
// throw while merely listing, always throw on a failed job so the provider
// loop reports upstream_error and the consumer's unit is refunded.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listLocalPoolModels, normalizePoolLocalUrl, runLocalPoolJob } from "./pool-local.js";

/** A fetch double: hand it a handler, get the calls back. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe("normalizePoolLocalUrl", () => {
  it("trims and drops trailing slashes", () => {
    assert.equal(normalizePoolLocalUrl("  http://localhost:11434/v1/  "), "http://localhost:11434/v1");
    assert.equal(normalizePoolLocalUrl("http://localhost:11434/v1///"), "http://localhost:11434/v1");
  });

  it("collapses every empty shape to one falsy value", () => {
    for (const v of ["", "   ", null, undefined, "/"]) assert.equal(normalizePoolLocalUrl(v), "");
  });
});

describe("listLocalPoolModels", () => {
  it("reads OpenAI-shaped catalogs and curates non-chat modalities out", async () => {
    const { fn, calls } = fakeFetch(async () =>
      ok({ data: [{ id: "llama3" }, { id: "nomic-embed-text" }, { id: "qwen2.5" }, { id: "whisper-1" }] }),
    );
    assert.deepEqual(await listLocalPoolModels("http://localhost:11434/v1/", fn), ["llama3", "qwen2.5"]);
    assert.equal(calls[0].url, "http://localhost:11434/v1/models");
  });

  it("accepts a bare array of ids too (not every local server is strict)", async () => {
    const { fn } = fakeFetch(async () => ok(["a", "b-embed"]));
    assert.deepEqual(await listLocalPoolModels("http://x", fn), ["a"]);
  });

  it("advertises NOTHING rather than throwing when the server is unreachable", async () => {
    // An empty advertisement is what the broker reads as "accepts anything";
    // a throw here would abort registration and take the sharer offline.
    const { fn } = fakeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.deepEqual(await listLocalPoolModels("http://x", fn), []);
    const bad = fakeFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.deepEqual(await listLocalPoolModels("http://x", bad.fn), []);
    assert.deepEqual(await listLocalPoolModels("", bad.fn), []);
  });
});

describe("runLocalPoolJob", () => {
  it("POSTs the body verbatim to the local server's chat endpoint", async () => {
    const body = { model: "llama3", messages: [{ role: "user", content: "hi" }], stream: false };
    const { fn, calls } = fakeFetch(async () => ok({ choices: [{ message: { content: "yo" } }], usage: { total_tokens: 7 } }));
    const out = await runLocalPoolJob("http://localhost:11434/v1", body, { fetchFn: fn });

    assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    // Nothing is added on the way to a user's own machine: what the broker
    // relayed is exactly what runs.
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
    assert.deepEqual(out.usage, { total_tokens: 7 });
    assert.equal(out.response.choices[0].message.content, "yo");
  });

  it("throws on a non-OK response so the job is reported and refunded", async () => {
    const { fn } = fakeFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(() => runLocalPoolJob("http://x", {}, { fetchFn: fn }), /503/);
  });

  it("throws instead of silently serving nothing when no URL is set", async () => {
    await assert.rejects(() => runLocalPoolJob("", {}, { fetchFn: fakeFetch(async () => ok({})).fn }), /local server url/i);
  });
});
