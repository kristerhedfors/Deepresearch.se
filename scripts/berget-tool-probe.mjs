#!/usr/bin/env node
// Does Berget serve OpenAI-style tool calling, and on which models?
//
// This exists because the answer is not in any capability field: Berget's
// /v1/models says nothing about tools, and the only honest way to know is to
// run the loop. It is a TWO-ROUND probe on purpose — the first round tells you
// a model will emit a tool call, and only the second tells you the loop
// CLOSES. Three of the seven chat models measured on 2026-08-29 passed round
// one and failed round two, including the fixed planning model.
//
// Findings and the trap they exposed: docs/BERGET-TOOL-CALLING.md.
//
//   BERGET_API_KEY=… node scripts/berget-tool-probe.mjs            # whole catalog
//   BERGET_API_KEY=… node scripts/berget-tool-probe.mjs <model> …  # named models
//
// Costs a handful of tokens per model. Never run in CI: it spends real money
// against a live provider, and a catalog that moved is a finding to write down
// rather than a build to fail.

const KEY = process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;
const BASE = (process.env.BERGET_URL || "https://api.berget.ai/v1").replace(/\/$/, "");

if (!KEY) {
  console.error("Set BERGET_API_KEY (or the older BERGET_API_TOKEN).");
  process.exit(2);
}

const TOOLS = [{
  type: "function",
  function: {
    name: "get_population",
    description: "Return the population of a named city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}];

const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };

/** @param {any} body */
async function post(body) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

/** Every chat model in the catalog — embedders and speech models filtered out
 * by what they are, not by a hard-coded list that would go stale. */
async function chatModels() {
  const r = await fetch(`${BASE}/models`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`/models ${r.status}`);
  const j = /** @type {any} */ (await r.json());
  return (j.data || [])
    .map((/** @type {any} */ m) => m.id)
    .filter((/** @type {string} */ id) => !/e5-|bge-|whisper/i.test(id));
}

/**
 * `verbatim` replays the provider's own assistant message unchanged — the
 * obvious implementation. `narrowed` sends only role + content + tool_calls,
 * which is what src/tool-run.js does. Running BOTH is the point: the gap
 * between the two columns IS the defect.
 */
async function probe(model) {
  const first = { model, max_tokens: 300, tools: TOOLS, messages: [
    { role: "user", content: "What is the population of Gothenburg? Use the tool." },
  ]};
  const r1 = await post(first);
  if (!r1.ok) return { model, emits: `HTTP ${r1.status}`, verbatim: "-", narrowed: "-", note: r1.text.slice(0, 120) };
  const msg = JSON.parse(r1.text).choices?.[0]?.message || {};
  const calls = msg.tool_calls || [];
  if (!calls.length) {
    return { model, emits: "no", verbatim: "-", narrowed: "-", note: String(msg.content || "").replace(/\s+/g, " ").slice(0, 90) };
  }
  const results = calls.map((/** @type {any} */ c) => ({ role: "tool", tool_call_id: c.id, content: "587549" }));
  const round2 = async (/** @type {any} */ assistantTurn) => {
    const r = await post({ model, max_tokens: 300, tools: TOOLS, messages: [first.messages[0], assistantTurn, ...results] });
    return r.ok ? "ok" : `HTTP ${r.status}`;
  };
  const verbatim = await round2(msg);
  const narrowed = await round2({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
  return { model, emits: "yes", verbatim, narrowed, note: verbatim === narrowed ? "" : "narrowing is what saves it" };
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : await chatModels();
console.log(`${"model".padEnd(50)} ${"emits".padEnd(8)} ${"verbatim".padEnd(10)} ${"narrowed".padEnd(10)} note`);
for (const m of models) {
  try {
    const r = await probe(m);
    console.log(`${r.model.padEnd(50)} ${r.emits.padEnd(8)} ${r.verbatim.padEnd(10)} ${r.narrowed.padEnd(10)} ${r.note}`);
  } catch (/** @type {any} */ err) {
    console.log(`${m.padEnd(50)} ${"ERROR".padEnd(8)} ${"-".padEnd(10)} ${"-".padEnd(10)} ${String(err.message).slice(0, 100)}`);
  }
}
