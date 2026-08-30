// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// The provider-agnostic tool loop. What is pinned is the OpenAI dialect (the
// new half — the Anthropic one is pinned by src/anthropic.test.js) and the two
// properties that make a wrong turn survivable: a tool that throws still gets
// a reply, and a model that cannot drive tools is a null rather than a crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolDialectFor, canDriveTools, toOpenAiTools, openAiToolRun, openAiWireFor,
  DEFAULT_MAX_ROUNDS,
} from "./tool-run.js";

const TOOLS = [
  {
    name: "grep_source",
    description: "Search the source.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  { name: "no_args", description: "Takes nothing." },
];

/** A fetch stand-in that replays scripted responses and records what was sent. */
function fakeFetch(responses) {
  const sent = [];
  let i = 0;
  const fn = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const body = responses[Math.min(i++, responses.length - 1)];
    if (body instanceof Error) throw body;
    if (body.__status) {
      return { ok: false, status: body.__status, text: async () => body.__text || "" };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  fn.sent = sent;
  return fn;
}

const assistant = (content, toolCalls) => ({
  choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

const WIRE = { chatUrl: "https://example.invalid/v1/chat/completions", headers: { "content-type": "application/json" } };

test("tool definitions are written once, Anthropic-shaped, and renamed at the wire", () => {
  const wire = toOpenAiTools(TOOLS);
  assert.equal(wire[0].type, "function");
  assert.equal(wire[0].function.name, "grep_source");
  // input_schema and parameters are the same JSON Schema under two names.
  assert.deepEqual(wire[0].function.parameters, TOOLS[0].input_schema);
  // A tool with no schema gets the empty object, not `undefined` — some
  // providers reject a function with no `parameters` at all.
  assert.deepEqual(wire[1].function.parameters, { type: "object", properties: {} });
});

test("a model on an unconfigured provider gets null, not a throw", () => {
  assert.equal(toolDialectFor({}, "claude-opus-5"), null);
  assert.equal(toolDialectFor({}, "some/berget-model"), null);
  assert.equal(canDriveTools({}, "some/berget-model"), false);
});

test("dialect follows the provider registry", () => {
  assert.equal(toolDialectFor({ ANTHROPIC_API_KEY: "k" }, "claude-opus-5"), "anthropic");
  assert.equal(toolDialectFor({ OPENAI_API_KEY: "k" }, "gpt-5"), "openai");
  // Berget is the fall-through: a model this file has never heard of is a
  // Berget catalog model until something says otherwise.
  assert.equal(toolDialectFor({ BERGET_API_TOKEN: "k" }, "mistralai/Whatever-New"), "openai");
});

test("images disqualify a run regardless of the model", () => {
  const env = { BERGET_API_TOKEN: "k" };
  assert.equal(canDriveTools(env, "mistralai/X"), true);
  // The loop is non-streaming and re-sends the whole conversation every round,
  // so images would be re-uploaded up to maxRounds times.
  assert.equal(canDriveTools(env, "mistralai/X", { hasImages: true }), false);
});

test("a straight answer costs one round and no tools", async (t) => {
  const fetchMock = fakeFetch([assistant("The answer.")]);
  t.mock.method(globalThis, "fetch", fetchMock);
  const out = await openAiToolRun({}, {
    model: "m", system: "sys", userContent: "q", tools: TOOLS, execTool: async () => "unused", ...WIRE,
  });
  assert.equal(out.text, "The answer.");
  assert.equal(out.rounds, 1);
  assert.equal(out.toolCalls, 0);
  assert.equal(fetchMock.sent.length, 1);
  assert.equal(fetchMock.sent[0].body.messages[0].role, "system");
  assert.equal(fetchMock.sent[0].body.tools.length, 2);
});

test("a tool round pairs every call with a reply, by id", async (t) => {
  const fetchMock = fakeFetch([
    assistant(null, [call("c1", "grep_source", { pattern: "x" }), call("c2", "no_args", {})]),
    assistant("Found it."),
  ]);
  t.mock.method(globalThis, "fetch", fetchMock);
  const seen = [];
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE,
    execTool: async (name, input) => { seen.push([name, input]); return `result for ${name}`; },
  });
  assert.equal(out.text, "Found it.");
  assert.equal(out.toolCalls, 2);
  assert.deepEqual(seen, [["grep_source", { pattern: "x" }], ["no_args", {}]]);
  const second = fetchMock.sent[1].body.messages;
  const toolMsgs = second.filter((m) => m.role === "tool");
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ["c1", "c2"]);
  assert.equal(toolMsgs[0].content, "result for grep_source");
});

test("the echoed assistant turn carries ONLY role, content and tool_calls", async (t) => {
  // Measured against the live Berget catalog on 2026-08-29: echoing the
  // provider's own message back verbatim makes three of its seven chat models
  // reject it — "body/messages/1/function_call Invalid input: expected object,
  // received null" — because they return function_call:null and then refuse
  // that null on the way back in. One of the three is Mistral-Small, the fixed
  // planning model. Invisible until round two, so it is pinned here.
  const fetchMock = fakeFetch([
    {
      choices: [{
        message: {
          role: "assistant", content: null, reasoning: null, refusal: null,
          annotations: null, audio: null, function_call: null,
          tool_calls: [call("c1", "no_args", {})],
        },
        finish_reason: "tool_calls",
      }],
    },
    assistant("done"),
  ]);
  t.mock.method(globalThis, "fetch", fetchMock);
  await openAiToolRun({}, { model: "m", userContent: "q", tools: TOOLS, ...WIRE, execTool: async () => "r" });
  const echoed = fetchMock.sent[1].body.messages.find((m) => m.role === "assistant");
  assert.deepEqual(Object.keys(echoed).sort(), ["content", "role", "tool_calls"]);
  assert.equal(echoed.content, "", "a null content must go back as a string, not as null");
  assert.equal(echoed.tool_calls.length, 1);
});

test("a tool that THROWS still gets a reply — an unpaired call is rejected outright", async (t) => {
  const fetchMock = fakeFetch([
    assistant(null, [call("c1", "grep_source", { pattern: "x" })]),
    assistant("Recovered."),
  ]);
  t.mock.method(globalThis, "fetch", fetchMock);
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE,
    execTool: async () => { throw new Error("snapshot unreadable"); },
  });
  assert.equal(out.text, "Recovered.");
  const toolMsg = fetchMock.sent[1].body.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "c1");
  // The model is TOLD what failed, which is usually enough for it to recover.
  assert.match(toolMsg.content, /Tool error: snapshot unreadable/);
});

test("unparseable arguments are reported, never executed", async (t) => {
  const fetchMock = fakeFetch([
    { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "grep_source", arguments: "{not json" } }] }, finish_reason: "tool_calls" }] },
    assistant("Retried."),
  ]);
  t.mock.method(globalThis, "fetch", fetchMock);
  let ran = false;
  await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE,
    execTool: async () => { ran = true; return "should not happen"; },
  });
  assert.equal(ran, false, "a call with unparseable arguments was executed anyway");
  const toolMsg = fetchMock.sent[1].body.messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /not valid JSON/);
});

test("the round cap forces an answer with the tools removed", async (t) => {
  // Every round asks for a tool. The loop must stop and make it answer rather
  // than looping forever or returning empty.
  const fetchMock = fakeFetch([assistant(null, [call("c", "no_args", {})])]);
  let n = 0;
  const wrapped = async (url, init) => {
    n++;
    const body = JSON.parse(init.body);
    if (!body.tools) return { ok: true, status: 200, json: async () => assistant("Forced answer.") };
    return fetchMock(url, init);
  };
  t.mock.method(globalThis, "fetch", wrapped);
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, maxRounds: 3, ...WIRE,
    execTool: async () => "again",
  });
  assert.equal(out.text, "Forced answer.");
  assert.equal(out.rounds, 3);
  assert.equal(n, 4, "three tool rounds plus one forced answer");
});

test("usage is summed across every round", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch([
    assistant(null, [call("c1", "no_args", {})]),
    assistant("done"),
  ]));
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE, execTool: async () => "r",
  });
  assert.deepEqual(out.usage, { prompt_tokens: 20, completion_tokens: 10 });
});

test("an HTTP failure throws so the caller can take its deterministic path", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch([{ __status: 503, __text: "upstream down" }]));
  await assert.rejects(
    () => openAiToolRun({}, { model: "m", userContent: "q", tools: TOOLS, ...WIRE, execTool: async () => "r" }),
    /tool call failed \(503\)/,
  );
});

test("the wire carries each provider's own endpoint and token field", () => {
  assert.equal(openAiWireFor({}, "berget"), null);
  const berget = openAiWireFor({ BERGET_API_TOKEN: "b" }, "berget");
  assert.match(berget.chatUrl, /api\.berget\.ai\/v1\/chat\/completions$/);
  assert.equal(berget.maxTokensField, "max_tokens");
  // GPT-5-era models reject the legacy max_tokens on Chat Completions.
  const openai = openAiWireFor({ OPENAI_API_KEY: "o" }, "openai");
  assert.equal(openai.maxTokensField, "max_completion_tokens");
  assert.match(openai.headers.authorization, /^Bearer o$/);
  // A configured override wins, and a trailing slash does not produce a double.
  const overridden = openAiWireFor({ BERGET_API_TOKEN: "b", BERGET_URL: "https://local.invalid/v1/" }, "berget");
  assert.equal(overridden.chatUrl, "https://local.invalid/v1/chat/completions");
});

test("the round cap has a default rather than running unbounded", () => {
  assert.ok(DEFAULT_MAX_ROUNDS > 0 && DEFAULT_MAX_ROUNDS <= 16);
});

test("the wall clock stops the gathering, and the answer is still written", async (t) => {
  // A round cap bounds how many times the model may ask for tools; it does not
  // bound TIME, and the two diverge on exactly the requests that need the bound
  // most — a slow provider, a tool sitting near its own ceiling, a deep tier
  // that bought more rounds. Passing the deadline must mean "stop gathering",
  // never "fail": the caller still gets an answer written from what it has.
  let clock = 1_000;
  const fetchMock = fakeFetch([assistant(null, [call("c", "no_args", {})])]);
  const wrapped = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.tools) return { ok: true, status: 200, json: async () => assistant("Written from what I had.") };
    clock += 400; // each round burns time
    return fetchMock(url, init);
  };
  t.mock.method(globalThis, "fetch", wrapped);
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE,
    execTool: async () => "r",
    maxRounds: 20,
    deadlineAt: 2_000,
    now: () => clock,
  });
  assert.equal(out.text, "Written from what I had.");
  assert.equal(out.stoppedBy, "deadline");
  assert.ok(out.rounds < 20, "the deadline, not the round cap, ended it");
});

test("no deadline passed means no wall clock, as before", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch([assistant("straight answer")]));
  const out = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE, execTool: async () => "r",
  });
  assert.equal(out.text, "straight answer");
  assert.equal(out.stoppedBy, "answered");
});

test("a failed round still reports the tokens it already spent", async (t) => {
  // The usage accumulator is a closure local, so it dies with the throw. A
  // caller that catches and falls back to another engine would then bill
  // NOTHING for the rounds that did run — and it runs a whole second engine on
  // top of them, so the request under-reports its cost by exactly the expensive
  // part.
  const fetchMock = fakeFetch([
    assistant(null, [call("c1", "no_args", {})]),
    { __status: 502, __text: "upstream gone" },
  ]);
  t.mock.method(globalThis, "fetch", fetchMock);
  const err = await openAiToolRun({}, {
    model: "m", userContent: "q", tools: TOOLS, ...WIRE, execTool: async () => "r",
  }).then(() => null, (e) => e);
  assert.ok(err, "the failure must still throw — the caller decides what to do");
  assert.deepEqual(err.usage, { prompt_tokens: 10, completion_tokens: 5 }, "the first round's tokens");
});
