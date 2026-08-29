// The security seam, pinned (src/tool-admission.js).
//
// docs/WORKSPACES.md §4.7 claims that what a request can REACH is decided by
// code and registry data you can read, and that the model chooses only the
// ORDER of calls inside a fixed set. That is a security property, so it ships
// with this file or it is prose — the same standing this repository gives the
// roster claim in src/cyber-exclusivity.test.js.
//
// Every test below is one sentence of that claim.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MAX_QUERY_CHARS,
  MAX_SPENDING_CALLS,
  admitToolCall,
  clampText,
  extensionSliceOn,
  newToolBudget,
  scrubArgs,
  scrubQueries,
  scrubUrls,
  sourceDedupKey,
} from "./tool-admission.js";
import { AGENTS_PATH, findAgent, resolveCapability } from "./agent-spec.js";
import { EXTENSIONS } from "./extensions.js";
import { SEARCH_SOURCES } from "./search-sources.js";
import { RESEARCH_TOOLS } from "./research-tools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = () => JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));
/** @param {string} id */
const cap = (id) => resolveCapability(findAgent(registry(), id));

/**
 * A request state with everything the gates read and nothing they do not.
 * `ext` carries the extensions ON, so a refusal in these tests is never the
 * account knob unless the test says so.
 * @param {any} [over]
 */
function state(over = {}) {
  return {
    capability: null,
    startedAt: Date.now(),
    searchCount: 0,
    ranQueries: new Set(),
    plan: { maxSearches: 8, maxSources: 18, digestCap: 14_000, budgetMs: 120_000 },
    ext: Object.fromEntries(EXTENSIONS.map((e) => [e.id, { on: true }])),
    ...over,
  };
}

/** Everything shipped, i.e. "the toolbox resolution let this through". */
const ALL_TOOLS = RESEARCH_TOOLS;

/**
 * @param {string} name
 * @param {any} args
 * @param {any} [opts]
 */
function admit(name, args, opts = {}) {
  return admitToolCall(name, args, {
    state: opts.state || state(),
    budget: opts.budget || newToolBudget(),
    policy: opts.policy || { web: true, auxSources: true, maxQueries: null },
    tools: opts.tools === undefined ? ALL_TOOLS : opts.tools,
    ...opts,
  });
}

describe("1. the tool has to be in the toolbox", () => {
  test("a hallucinated tool name is refused in words, never thrown", () => {
    const r = admit("delete_everything", {});
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /no tool called/);
  });

  test("a real tool this run was not handed is refused too", () => {
    // The AND-gate at the call layer: declaration time is not the only place a
    // toolbox is enforced, because a model can name a tool it saw in an earlier
    // conversation.
    const r = admit("host_intel", { ip: "1.1.1.1" }, { state: state({ capability: cap("cyber") }), tools: [{ name: "web_search" }] });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /not part of this run's toolbox/);
  });
});

describe("2. the context block the answering agent must declare", () => {
  test("Deep Science is REFUSED host_intel at the call, not merely undeclared", () => {
    // The roster claim, enforced twice. The registry never hands `scholar` the
    // host-intelligence class; this asserts what happens when a call for it
    // arrives anyway — which is the only version of the claim an attacker-shaped
    // question can test.
    const r = admit("host_intel", { ip: "8.8.8.8" }, { state: state({ capability: cap("scholar") }) });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /host-intel/);
    assert.match(/** @type {any} */ (r).message, /retrying will not help/i);
  });

  test("the Cyber agent, which declares the block, is admitted", () => {
    const r = admit("host_intel", { ip: "8.8.8.8" }, { state: state({ capability: cap("cyber") }) });
    assert.equal(r.ok, true);
  });

  test("the corpus tool follows its own block, not its owner's name", () => {
    assert.equal(admit("ancient_samples", { near: "Gotland" }, { state: state({ capability: cap("palaeogenomics") }) }).ok, true);
    assert.equal(admit("ancient_samples", { near: "Gotland" }, { state: state({ capability: cap("scholar") }) }).ok, false);
  });

  test("the NULL capability DROPS every declared block", () => {
    // Half one of the asymmetry. "No agent was resolved" must never widen into
    // third-party reach: an unaddressed request reaches no extension, exactly as
    // src/enrichment.js's enrichmentApplies decides it.
    for (const name of ["host_intel", "street_view_look", "ancient_samples"]) {
      const r = admit(name, { ip: "8.8.8.8", near: "Gotland" }, { state: state({ capability: null }) });
      assert.equal(r.ok, false, `${name} was admitted for an unresolved agent`);
    }
  });
});

describe("3. the account knob that consents to a third party", () => {
  test("a tool whose extension is switched off is refused with the standing message", () => {
    const off = state({ capability: cap("cyber"), ext: { shodan: { on: false }, maps: { on: true } } });
    const r = admit("host_intel", { ip: "8.8.8.8" }, { state: off });
    assert.equal(r.ok, false);
    // Reuses src/extension-tools.js's own wording: it must not read as a bug, a
    // rate limit, or something a retry fixes.
    assert.match(/** @type {any} */ (r).message, /switched off for this account/);
  });

  test("a state with no ext bag reaches no third party at all", () => {
    const r = admit("host_intel", { ip: "8.8.8.8" }, { state: state({ capability: cap("cyber"), ext: undefined }) });
    assert.equal(r.ok, false);
  });

  test("the knob is read the same way every extension descriptor reads it", () => {
    // extensionSliceOn duplicates one field of src/extensions.js so admission
    // can answer synchronously. This is the pin that stops the two drifting.
    for (const e of EXTENSIONS) {
      assert.equal(e.enabled({ on: true }), extensionSliceOn({ ext: { [e.id]: { on: true } } }, e.id), e.id);
      assert.equal(e.enabled({ on: false }), extensionSliceOn({ ext: { [e.id]: { on: false } } }, e.id), e.id);
    }
  });
});

describe("4. the request's search policy", () => {
  test("web:false kills web_search", () => {
    const r = admit("web_search", { queries: ["anything"] }, { policy: { web: false, auxSources: true } });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /switched off for this request/);
  });

  test("…and leaves the other sources alone", () => {
    const r = admit("source_search", { source: "hf", query: "open model weights" }, { policy: { web: false, auxSources: true } });
    assert.equal(r.ok, true);
  });

  test("auxSources:false kills source_search", () => {
    const r = admit("source_search", { source: "hf", query: "x" }, { policy: { web: true, auxSources: false } });
    assert.equal(r.ok, false);
  });

  test("an agent-declared maxQueries narrows the fan-out", () => {
    const r = admit("web_search", { queries: ["a", "b", "c", "d"] }, { policy: { web: true, auxSources: true, maxQueries: 2 } });
    assert.equal(r.ok, true);
    assert.equal(/** @type {any} */ (r).args.queries.length, 2);
  });
});

describe("5. may this agent consult the source it named?", () => {
  test("a requiresContext source is refused to a capability lacking the block", () => {
    // arXiv declares `literature-arxiv`, which the Cyber agent does not carry.
    const r = admit("source_search", { source: "arxiv", query: "diffusion models" }, { state: state({ capability: cap("cyber") }) });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /belongs to another agent/);
  });

  test("…and admitted to the agent that owns it", () => {
    const r = admit("source_search", { source: "arxiv", query: "diffusion models" }, { state: state({ capability: cap("scholar") }) });
    assert.equal(r.ok, true);
  });

  test("the NULL capability KEEPS every source", () => {
    // Half two of the asymmetry, and the direction that looks wrong until you
    // read why: an MCP call naming no agent resolves no capability, and the
    // ground-truth batteries reach both corpora that way. Closing this door
    // makes an outage look like an empty answer.
    for (const source of SEARCH_SOURCES) {
      const r = admit("source_search", { source: source.id, query: "a question" }, { state: state({ capability: null }) });
      assert.equal(r.ok, true, `${source.id} was refused for an unresolved agent`);
    }
  });

  test("an unknown source names the ones that exist", () => {
    const r = admit("source_search", { source: "pubmed_central", query: "x" });
    assert.equal(r.ok, false);
    for (const s of SEARCH_SOURCES) assert.ok(/** @type {any} */ (r).message.includes(s.id), s.id);
  });
});

describe("6. the source's caps, the dedup and the query budget", () => {
  test("a source's per-request ceiling is its own, and the refusal says why", () => {
    // arXiv's cap is 2 because arXiv publishes one request per three seconds
    // and sells no way past it.
    const arxiv = SEARCH_SOURCES.find((s) => s.id === "arxiv");
    const s = state({ capability: cap("scholar") });
    const budget = newToolBudget();
    // Genuinely distinct angles: the source's OWN normalizer decides what
    // counts as a repeat (arxivTermKey reduces to the topic terms), so
    // "angle 1" and "angle 2" would collapse into one key and this test would
    // measure the dedup instead of the cap.
    const angles = ["transformer attention mechanisms", "diffusion model sampling schedules", "graph neural network expressivity"];
    for (let i = 0; i < (arxiv?.maxPerRequest ?? 2); i++) {
      assert.equal(admit("source_search", { source: "arxiv", query: angles[i] }, { state: s, budget }).ok, true, angles[i]);
    }
    const over = admit("source_search", { source: "arxiv", query: angles[angles.length - 1] }, { state: s, budget });
    assert.equal(over.ok, false);
    assert.match(/** @type {any} */ (over).message, /rate limit/);
  });

  test("the same source query twice is refused rather than re-fetched", () => {
    const s = state();
    const budget = newToolBudget();
    assert.equal(admit("source_search", { source: "hf", query: "quantized llama" }, { state: s, budget }).ok, true);
    const again = admit("source_search", { source: "hf", query: "quantized llama" }, { state: s, budget });
    assert.equal(again.ok, false);
    assert.match(/** @type {any} */ (again).message, /already run/);
  });

  test("an admitted source search commits its key so the runner can build skipKeys", () => {
    const s = state();
    const source = /** @type {any} */ (SEARCH_SOURCES.find((x) => x.id === "hf"));
    admit("source_search", { source: "hf", query: "Quantized Llama" }, { state: s });
    assert.ok(s.aux.hf.ran.has(sourceDedupKey(source, "Quantized Llama")));
    assert.equal(s.aux.hf.count, 1);
  });

  test("web queries already run on this request are dropped, and an all-duplicate call is refused", () => {
    const s = state();
    const first = admit("web_search", { queries: ["swedish energy policy", "nuclear phase-out"] }, { state: s });
    assert.equal(first.ok, true);
    s.searchCount += /** @type {any} */ (first).args.queries.length; // the runner's commit
    const repeat = admit("web_search", { queries: ["Swedish Energy Policy"] }, { state: s });
    assert.equal(repeat.ok, false);
    assert.match(/** @type {any} */ (repeat).message, /already searched/);
  });

  test("the plan's search ceiling stops the run and names what is left", () => {
    const s = state({ plan: { maxSearches: 2, maxSources: 18, digestCap: 14_000, budgetMs: 120_000 } });
    const first = admit("web_search", { queries: ["a", "b"] }, { state: s });
    assert.equal(first.ok, true);
    s.searchCount = 2;
    const over = admit("web_search", { queries: ["c"] }, { state: s });
    assert.equal(over.ok, false);
    assert.match(/** @type {any} */ (over).message, /2 of 2/);
  });
});

describe("7. the run's budget and its deadline", () => {
  test("the (N+1)th metered call is refused, naming what is left", () => {
    const budget = newToolBudget();
    const s = state();
    for (let i = 0; i < MAX_SPENDING_CALLS; i++) {
      assert.equal(admit("web_search", { queries: [`angle ${i}`] }, { state: s, budget }).ok, true, `call ${i}`);
    }
    assert.equal(budget.spendCalls, MAX_SPENDING_CALLS);
    const over = admit("web_search", { queries: ["one more angle"] }, { state: s, budget });
    assert.equal(over.ok, false);
    assert.match(/** @type {any} */ (over).message, new RegExp(`${MAX_SPENDING_CALLS} of ${MAX_SPENDING_CALLS}`));
    // …and a free tool still works, which is what makes the refusal an
    // instruction rather than a dead end.
    assert.equal(admit("run_python", { source: "print(1)" }, { state: s, budget }).ok, true);
  });

  test("a refused call spends nothing", () => {
    // The commit happens once, after the last check. A call refused late must
    // not have charged the ledger a call refused early would have kept.
    const s = state({ capability: cap("scholar") });
    const budget = newToolBudget();
    admit("host_intel", { ip: "8.8.8.8" }, { state: s, budget });
    assert.equal(budget.spendCalls, 0);
    assert.equal(s.ranQueries.size, 0);
  });

  test("a spent time budget stops further lookups without erroring", () => {
    // Past the budget plus fitsDeadline's 15% grace, which is the point the
    // wave path stops planning further work too.
    const s = state({ startedAt: Date.now() - 200_000, plan: { maxSearches: 8, maxSources: 18, digestCap: 14_000, budgetMs: 120_000 } });
    const r = admit("web_search", { queries: ["still curious"] }, { state: s });
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).message, /time budget/);
  });

  test("an unknown deadline does not stop a run that was going to finish", () => {
    // Invariant 2: absent budget information is not a reason to refuse.
    const r = admit("web_search", { queries: ["anything"] }, { state: state({ startedAt: undefined, plan: { maxSearches: 8, maxSources: 18 } }) });
    assert.equal(r.ok, true);
  });
});

describe("8. the arguments themselves (invariant 4 at the argument layer)", () => {
  test("a 4000-character query is truncated, not forwarded", () => {
    // The mechanism this check exists for: on the deterministic path a query was
    // written by a planner into a fixed schema, so "outbound requests carry the
    // minimum" was structurally true. A model composing arguments out of the
    // conversation is the layer that can paste the conversation into a query,
    // and nothing else in the system checks it.
    const conversation = "min hemliga fråga ".repeat(240);
    assert.ok(conversation.length > 4000);
    const r = admit("web_search", { queries: [conversation] });
    assert.equal(r.ok, true);
    const sent = /** @type {any} */ (r).args.queries[0];
    // At most the cap — one short when the cut lands on a space, because the
    // trailing space is trimmed rather than sent.
    assert.ok([...sent].length <= MAX_QUERY_CHARS && [...sent].length >= MAX_QUERY_CHARS - 1, sent.length);
    assert.ok(conversation.startsWith(sent.slice(0, 50)));
  });

  test("the clamp is by code point, so a query never ends in half a character", () => {
    const emoji = "🧬".repeat(400);
    const cut = clampText(emoji, MAX_QUERY_CHARS);
    assert.equal([...cut].length, MAX_QUERY_CHARS);
    assert.equal(cut.includes("�"), false);
    assert.equal(cut, "🧬".repeat(MAX_QUERY_CHARS));
  });

  test("newlines collapse, so a pasted document cannot ride out as one query", () => {
    assert.equal(clampText("line one\n\nline two\t\tend", 100), "line one line two end");
  });

  test("a program is bounded for size, not scrubbed for content", () => {
    // run_python's source never reaches a third party — it runs in the sandbox
    // bound to this request — so collapsing its newlines would break the
    // program while protecting nothing.
    const program = "for i in range(3):\n    print(i)\n";
    const args = scrubArgs("run_python", { source: program, stdin: "a\nb\n" });
    assert.equal(args.source, program.trim());
    assert.equal(args.stdin, "a\nb");
  });

  test("read_pages takes absolute http(s) URLs only, deduped and capped", () => {
    assert.deepEqual(
      scrubUrls(["https://a.example/1", "https://a.example/1", "javascript:alert(1)", "/relative", "http://b.example"]),
      ["https://a.example/1", "http://b.example"],
    );
    assert.equal(scrubUrls(Array.from({ length: 12 }, (_, i) => `https://x.example/${i}`)).length, 4);
  });

  test("ancient_samples arguments are clamped to the corpus's own ranges", () => {
    const args = scrubArgs("ancient_samples", { limit: 10_000, radius_km: -5, sex: "male", include_ignored: "yes", group: "y".repeat(500) });
    assert.equal(args.limit, 100);
    assert.equal(args.radius_km, 1);
    assert.equal(args.sex, "", "an unparseable sex is dropped rather than guessed");
    assert.equal(args.include_ignored, false, "only a real boolean turns the Ignore_ rows on");
    assert.equal(args.group.length, 80);
  });

  test("a family with its own parser still gets the outbound clamp", () => {
    const args = scrubArgs("literature_search", { queries: ["q".repeat(900)], corpus: "both", limit: 8 });
    assert.equal(args.queries[0].length, MAX_QUERY_CHARS);
    assert.equal(args.corpus, "both");
    assert.equal(args.limit, 8, "a number the family parses is passed through untouched");
  });
});

describe("Swedish and English are admitted alike (invariant 6)", () => {
  test("a Swedish query survives scrubbing byte for byte", () => {
    // The trap this is written against is the one in the invariant: JS `\b` is
    // ASCII-only, so a gate written with `/\bmått\b/` matches inside "måttet"
    // and misses what it was written for. Nothing here uses a word boundary —
    // asserted by behaviour: the Swedish query must arrive at the provider
    // exactly as the model composed it.
    const sv = "Hur påverkar kärnkraftens avveckling elpriset i södra Sverige?";
    const r = admit("web_search", { queries: [sv] });
    assert.equal(/** @type {any} */ (r).args.queries[0], sv);
  });

  test("case folding is Unicode-aware, so Swedish duplicates dedup like English ones", () => {
    assert.deepEqual(scrubQueries(["Kärnkraft i Sverige", "kärnkraft i sverige"]), ["Kärnkraft i Sverige"]);
    assert.deepEqual(scrubQueries(["Nuclear Power", "nuclear power"]), ["Nuclear Power"]);
  });

  test("the same question in either language is admitted the same way", () => {
    for (const q of ["What does the ancient DNA record say about Gotland?", "Vad säger det gamla DNA-materialet om Gotland?"]) {
      const r = admit("source_search", { source: "europepmc", query: q }, { state: state({ capability: cap("palaeogenomics") }) });
      assert.equal(r.ok, true, q);
      assert.equal(/** @type {any} */ (r).args.query, q);
    }
  });
});

test("a refusal is always a sentence, never an exception", () => {
  // The property the tool loop depends on: an exception mid-answer costs the
  // whole turn, a sentence is something the model routes around. Swept over
  // every tool with junk arguments and a capability that declares nothing.
  const junk = [undefined, null, "", 0, [], { queries: null }, { source: 1 }, { urls: "no" }];
  for (const tool of RESEARCH_TOOLS) {
    for (const args of junk) {
      const r = admitToolCall(tool.name, args, { state: state({ capability: { context: [], tools: [] } }), budget: newToolBudget() });
      assert.equal(typeof r.ok, "boolean", tool.name);
      if (!r.ok) assert.ok(/** @type {any} */ (r).message.length > 20, `${tool.name} refusal is too terse to act on`);
    }
  }
});
