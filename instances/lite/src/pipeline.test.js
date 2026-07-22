// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, renumberDigest } from "./pipeline.js";
import { JSON_MODEL } from "./config.js";

const env = { SESSION_SECRET: "s", EXA_API_KEY: "k", SEARCH_ENABLED: "true", BERGET_API_TOKEN: "t" };
const log = { debug() {}, info() {}, warn() {}, error() {} };

/** Drain the SSE ReadableStream into an array of parsed events. */
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]") { events.push({ type: "__done__" }); continue; }
      events.push(JSON.parse(p));
    }
  }
  return events;
}

const streamOf = (...deltas) => async function* () { for (const d of deltas) yield d; };

test("direct path: no search, streams an answer", async () => {
  let searched = false;
  const deps = {
    jsonCompletion: async () => ({ mode: "direct", queries: [] }),
    streamCompletion: streamOf("Hello", " world"),
    webSearch: async () => { searched = true; return { content: "", sources: [], resultCount: 0 }; },
  };
  const events = await drain(runPipeline(env, log, { messages: [{ role: "user", content: "hi friend how are you" }] }, deps));
  assert.equal(searched, false, "direct mode must not search");
  const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.equal(answer, "Hello world");
  assert.ok(events.some((e) => e.type === "done"));
  assert.equal(events[events.length - 1].type, "__done__", "[DONE] always terminates");
});

test("research path: emits search events, then the answer with sources", async () => {
  const deps = {
    jsonCompletion: async () => ({ mode: "research", queries: ["stockholm population"] }),
    streamCompletion: streamOf("Answer with ", "[1]"),
    webSearch: async () => ({ content: "[1] Stockholm\nhttp://x\nfacts", sources: [{ title: "Stockholm", url: "http://x" }], resultCount: 1 }),
  };
  const events = await drain(runPipeline(env, log, { messages: [{ role: "user", content: "what is the population of Stockholm" }] }, deps));
  assert.ok(events.some((e) => e.type === "search_start" && e.query === "stockholm population"));
  const doneSearch = events.find((e) => e.type === "search_done");
  assert.equal(doneSearch.results, 1);
  const done = events.find((e) => e.type === "done");
  assert.equal(done.searches, 1);
  assert.deepEqual(done.sources, [{ title: "Stockholm", url: "http://x" }]);
});

test("split routing: triage uses the fixed JSON_MODEL, synthesis the answer model", async () => {
  let triageModel = null;
  let synthModel = null;
  const deps = {
    jsonCompletion: async (_e, _l, req) => { triageModel = req.model; return { mode: "direct", queries: [] }; },
    streamCompletion: async function* (_e, _l, req) { synthModel = req.model; yield "ok"; },
    webSearch: async () => ({ content: "", sources: [], resultCount: 0 }),
  };
  await drain(runPipeline(env, log, { messages: [{ role: "user", content: "a real question here" }], model: "some/answer-model" }, deps));
  assert.equal(triageModel, JSON_MODEL);
  assert.equal(synthModel, "some/answer-model");
});

test("fail-soft: a throwing search still yields an answer", async () => {
  const deps = {
    jsonCompletion: async () => ({ mode: "research", queries: ["q"] }),
    streamCompletion: streamOf("still answered"),
    webSearch: async () => { throw new Error("exa down"); },
  };
  const events = await drain(runPipeline(env, log, { messages: [{ role: "user", content: "some research question" }] }, deps));
  const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.equal(answer, "still answered");
  assert.ok(events.some((e) => e.type === "done"));
});

test("fail-soft: a failed triage (null) still answers via the model-free fallback", async () => {
  const deps = {
    jsonCompletion: async () => null, // model call failed entirely
    streamCompletion: streamOf("fallback answer"),
    webSearch: async () => ({ content: "[1] x\nhttp://x", sources: [{ title: "x", url: "http://x" }], resultCount: 1 }),
  };
  const events = await drain(runPipeline(env, log, { messages: [{ role: "user", content: "a substantial question about physics" }] }, deps));
  // model-free fallback classifies a substantial message as research
  assert.ok(events.some((e) => e.type === "search_start"));
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "fallback answer");
});

test("empty synthesis degrades to an honest message, never an empty bubble", async () => {
  const deps = {
    jsonCompletion: async () => ({ mode: "direct", queries: [] }),
    streamCompletion: async function* () {}, // yields nothing
    webSearch: async () => ({ content: "", sources: [], resultCount: 0 }),
  };
  const events = await drain(runPipeline(env, log, { messages: [{ role: "user", content: "a real question" }] }, deps));
  const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.ok(answer.length > 0);
});

test("search disabled => direct even for a research-shaped question", async () => {
  const noSearch = { ...env, SEARCH_ENABLED: "false" };
  let searched = false;
  const deps = {
    jsonCompletion: async () => ({ mode: "research", queries: ["q"] }),
    streamCompletion: streamOf("direct answer"),
    webSearch: async () => { searched = true; return { content: "", sources: [], resultCount: 0 }; },
  };
  const events = await drain(runPipeline(noSearch, log, { messages: [{ role: "user", content: "what is the population of Stockholm" }] }, deps));
  assert.equal(searched, false);
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "direct answer");
});

test("renumberDigest makes citation numbers contiguous across waves", () => {
  const out = renumberDigest(["[1] a\nhttp://a\n\n[2] b\nhttp://b", "[1] c\nhttp://c"]);
  assert.match(out, /\[1\] a/);
  assert.match(out, /\[2\] b/);
  assert.match(out, /\[3\] c/);
});
