import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  freeContext,
  freeDirectPrompt,
  freeGapPrompt,
  freeHarvestPrompt,
  freeSynthPrompt,
  freeTriagePrompt,
  freeValidatePrompt,
  normalizeFreeNotes,
  normalizeFreeTriage,
  renderFreeNotes,
  runFreeResearch,
} from "./free-research.js";

// ---- normalizers ------------------------------------------------------------------

test("normalizeFreeTriage hardens every action and degrades garbage", () => {
  assert.deepEqual(normalizeFreeTriage({ action: "direct" }), { action: "direct", subquestions: [] });
  assert.deepEqual(normalizeFreeTriage({ action: "clarify", question: " Which year? " }), {
    action: "clarify",
    question: "Which year?",
    subquestions: [],
  });
  const r = normalizeFreeTriage({ action: "research", complexity: "comparison", subquestions: ["a", " b ", "", 7] });
  assert.deepEqual(r, { action: "research", complexity: "comparison", subquestions: ["a", "b"] });
  // research with no usable subquestions degrades to direct
  assert.equal(normalizeFreeTriage({ action: "research", subquestions: [] }).action, "direct");
  assert.equal(normalizeFreeTriage({ action: "explode" }), null);
  assert.equal(normalizeFreeTriage(null), null);
  // more than the cap is truncated
  const many = normalizeFreeTriage({ action: "research", subquestions: ["1", "2", "3", "4", "5", "6"] });
  assert.equal(many.subquestions.length, 4);
});

test("normalizeFreeNotes never returns null and caps the lists", () => {
  assert.deepEqual(normalizeFreeNotes(null), { facts: [], uncertain: [] });
  assert.deepEqual(normalizeFreeNotes({ facts: [" a ", 3, ""], uncertain: ["u"] }), {
    facts: ["a"],
    uncertain: ["u"],
  });
  assert.equal(normalizeFreeNotes({ facts: Array(30).fill("f") }).facts.length, 12);
});

test("renderFreeNotes marks empty harvests honestly", () => {
  const text = renderFreeNotes([
    { subquestion: "Q1", notes: { facts: ["f1"], uncertain: ["u1"] } },
    { subquestion: "Q2", notes: { facts: [], uncertain: [] } },
  ]);
  assert.match(text, /Sub-question 1: Q1/);
  assert.match(text, /- fact: f1/);
  assert.match(text, /- uncertain: u1/);
  assert.match(text, /no confident facts harvested/);
});

test("freeContext keeps the last turns inside the budget", () => {
  const messages = [
    { role: "user", content: "x".repeat(20_000) },
    { role: "assistant", content: "middle" },
    { role: "user", content: "latest" },
  ];
  const ctx = freeContext(messages);
  assert.match(ctx, /USER: latest/);
  assert.match(ctx, /ASSISTANT: middle/);
  assert.equal(ctx.includes("x".repeat(100)), false); // the oversized old turn dropped
});

// ---- prompt structure (the server's prompts.test.js discipline) ---------------------

test("every prompt keeps the offline-mode honesty and JSON discipline", () => {
  for (const p of [freeTriagePrompt(), freeHarvestPrompt(), freeGapPrompt(["a"]), freeValidatePrompt()]) {
    assert.match(p, /JSON/);
  }
  for (const p of [freeTriagePrompt(), freeHarvestPrompt(), freeSynthPrompt(), freeDirectPrompt()]) {
    assert.match(p, /never (follow|invent)/i);
  }
  assert.match(freeTriagePrompt(), /NO web search/i);
  assert.match(freeHarvestPrompt(), /Never invent sources, URLs/);
  assert.match(freeSynthPrompt(), /never invent citations/i);
  assert.match(freeSynthPrompt(), /training cutoff/);
  assert.match(freeGapPrompt(["q1", "q2"]), /1\. q1[\s\S]*2\. q2/);
  assert.match(freeValidatePrompt(), /"verdict":"revise"/);
});

// ---- the full flow against a mock provider ------------------------------------------

// The mock provider routes by the system prompt's opening words — the same
// deterministic phase identity the pipeline itself relies on.
function phaseOf(body) {
  const system = body.messages[0]?.content || "";
  if (system.includes("research planner")) return "triage";
  if (system.includes("extract research notes")) return "harvest";
  if (system.includes("audit research coverage")) return "gap";
  if (system.includes("strict reviewer")) return "validate";
  if (system.includes("free-mode assistant")) return "direct";
  return "synth";
}

const sse = (chunks) =>
  chunks.map((c) => `data: {"choices":[{"delta":{"content":${JSON.stringify(c)}}}]}`).join("\n\n") +
  "\n\ndata: [DONE]\n\n";

describe("runFreeResearch end to end (mock provider)", () => {
  const requests = [];
  let gapAlreadyAsked = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const phase = phaseOf(body);
      requests.push({ phase, headers: req.headers, body });
      const json = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
      };
      if (phase === "triage") {
        json({ action: "research", complexity: "comparison", subquestions: ["What is A?", "What is B?"] });
      } else if (phase === "harvest") {
        json({ facts: ["fact about " + (body.messages[1].content.match(/Sub-question: (.*)$/)?.[1] || "?")], uncertain: ["maybe"] });
      } else if (phase === "gap") {
        if (gapAlreadyAsked) json({ complete: true });
        else {
          gapAlreadyAsked = true;
          json({ complete: false, missing: ["What changed recently?"] });
        }
      } else if (phase === "validate") {
        json({ verdict: "revise", issues: ["overclaimed"], revised_answer: "REVISED final answer." });
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(["DRAFT ", "answer."]));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("research flow: triage → parallel harvest → gap round → synth → validate/revise", async () => {
    requests.length = 0;
    gapAlreadyAsked = false;
    const phases = [];
    let discarded = false;
    let streamed = "";
    const result = await runFreeResearch({
      providerId: "groq",
      apiKey: "user-groq-key",
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      onStatus: (s) => {
        if (s.type === "phase") phases.push(s.phase);
        if (s.type === "discard_text") {
          discarded = true;
          streamed = "";
        }
      },
      onDelta: (c) => (streamed += c),
      baseUrl,
    });

    assert.deepEqual(phases, ["triage", "harvest", "gap", "harvest", "synth", "validate"]);
    assert.equal(result.action, "research");
    assert.equal(result.validated, true);
    // The gap round's follow-up joined the harvest.
    assert.deepEqual(result.subquestions, ["What is A?", "What is B?", "What changed recently?"]);
    // The validated revision replaced the draft, via discard_text + re-emit.
    assert.equal(discarded, true);
    assert.equal(result.answer, "REVISED final answer.");
    assert.equal(streamed, "REVISED final answer.");

    // Split model routing, client-side: planning phases on the provider's
    // fixed jsonModel, synthesis on the user's chosen model — all with the
    // user's own key.
    for (const r of requests) {
      assert.equal(r.headers.authorization, "Bearer user-groq-key");
      if (r.phase === "synth") assert.equal(r.body.model, "llama-3.3-70b-versatile");
      else assert.equal(r.body.model, "llama-3.1-8b-instant");
    }
    // Harvest ran once per subquestion (2 + 1 gap follow-up).
    assert.equal(requests.filter((r) => r.phase === "harvest").length, 3);
    // Synthesis carried the harvested notes.
    const synth = requests.find((r) => r.phase === "synth");
    assert.match(synth.body.messages.at(-1).content, /Harvested notes/);
    assert.match(synth.body.messages.at(-1).content, /fact about What is A\?/);
  });

  test("research toggle off goes straight to a direct streamed answer", async () => {
    const phases = [];
    let streamed = "";
    const result = await runFreeResearch({
      providerId: "groq",
      apiKey: "user-groq-key",
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hello" }],
      research: false,
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      onDelta: (c) => (streamed += c),
      baseUrl,
    });
    assert.deepEqual(phases, ["answer"]);
    assert.equal(result.action, "direct");
    assert.equal(streamed, "DRAFT answer.");
  });

  test("a clarify verdict short-circuits into the clarifying question", async () => {
    const server2 = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (phaseOf(body) === "triage") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"action":"clarify","question":"For which region?"}' } }] }));
        } else {
          res.writeHead(500);
          res.end();
        }
      });
    });
    await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
    try {
      let streamed = "";
      const result = await runFreeResearch({
        providerId: "groq",
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "best prices?" }],
        onDelta: (c) => (streamed += c),
        baseUrl: `http://127.0.0.1:${server2.address().port}/v1`,
      });
      assert.equal(result.action, "clarify");
      assert.equal(streamed, "For which region?");
    } finally {
      server2.close();
    }
  });

  test("a broken triage fails soft into a direct answer", async () => {
    const server3 = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse(["fallback answer"]));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise((resolve) => server3.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runFreeResearch({
        providerId: "openai",
        apiKey: "k",
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "anything" }],
        baseUrl: `http://127.0.0.1:${server3.address().port}/v1`,
      });
      assert.equal(result.action, "direct");
      assert.equal(result.answer, "fallback answer");
    } finally {
      server3.close();
    }
  });
});
