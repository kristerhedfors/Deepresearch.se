// The PLATFORM family driven through the REAL handleMcp — the wiring, not the
// pieces. src/platform-tools.test.js covers the schemas and the map runner in
// isolation; this suite exists because everything that can actually go wrong
// with a new tool family lives between those pieces:
//
//   * a tool that lists but does not dispatch (a name in ALL_MCP_TOOLS with no
//     branch) answers "Unknown tool" to a client that just read it off the
//     listing — the single most confusing failure this surface can produce;
//   * an exposure switch that filters the LISTING but not the CALL leaves a
//     switched-off tool reachable by any client that cached an older list;
//   * the free tool taking the quota path, or an answering tool skipping it,
//     is invisible until a bill or a support report says so;
//   * and the arguments the answering tools FORCE — the introspection agent, no
//     web search, voice by default — are the whole behaviour of the family, so
//     they are pinned where they are actually applied rather than where they
//     are declared.
//
// Nothing here reaches the network or a provider. The two answering tools are
// observed at the point they hand off to the pipeline, by giving the env no
// BERGET_API_TOKEN: runDeepResearch's first act is to refuse without one, which
// lands after argument resolution and before any spend — so the call proves the
// branch routed and the gates ran, and costs nothing.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { ALL_MCP_TOOLS, handleMcp } from "./mcp.js";
import {
  defaultMcpConfig,
  parseMcpConfig,
  resolveIntrospectArgs,
  resolveResearchArgs,
  toolExposed,
} from "./mcp-config.js";
import { PLATFORM_AGENT } from "./platform-tools.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = /** @type {any} */ ({ waitUntil() {} });

/** An admin, so the quota gate's admin bypass keeps D1 out of these tests. */
const admin = /** @type {any} */ ({ id: "adm", role: "admin", email: "a@example.com", name: "A", user: null });
/** An ordinary user, for the one test that wants the gate to actually run. */
const user = /** @type {any} */ ({ id: "u1", role: "user", email: "u@example.com", name: "U", user: null });

/** A snapshot the map runner can describe. */
const SNAPSHOT = (() => {
  const skill = (name, description) => {
    const t = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
    return { p: `.claude/skills/${name}/SKILL.md`, s: t.length, t };
  };
  const files = [
    { p: "src/mcp.js", s: 4, t: "code" },
    skill("cache-helper", "Every cache layer and the stale-site playbook."),
  ];
  return { v: 1, digest: "d", count: files.length, bytes: files.reduce((n, f) => n + f.s, 0), files };
})();

/** An env serving the source snapshot and nothing else. No DB binding at all,
 * which is a supported configuration (quota.js: nothing throws, so nothing is
 * refused) and keeps these tests off D1 entirely. */
function env(overrides = {}) {
  return /** @type {any} */ ({
    ASSETS: {
      async fetch(request) {
        const url = new URL(typeof request === "string" ? request : request.url);
        if (url.pathname === "/introspect/source-snapshot.json") {
          return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    },
    ...overrides,
  });
}

async function callTool(name, args, { identity = admin, bindings = {} } = {}) {
  const request = new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcp(request, env(bindings), /** @type {any} */ (silentLog), identity, ctx, "req-1");
  return { res, body: await res.json() };
}

/** The text of a tools/call result, whatever its isError flag. */
function textOf(body) {
  return String(body?.result?.content?.[0]?.text ?? "");
}

// ---------------------------------------------------------------------------
// Listed and reachable
// ---------------------------------------------------------------------------

describe("the family is both listed and dispatched", () => {
  test("every platform tool appears in the served list", () => {
    const served = ALL_MCP_TOOLS.map((t) => t.name);
    for (const name of ["explain_internals", "improvement_areas", "platform_map"]) {
      assert.ok(served.includes(name), `${name} is served`);
    }
  });

  test("every listed platform tool has a dispatch branch — none answers Unknown tool", async () => {
    // The failure this catches: a name in the listing with no branch behind it.
    // A client reads the tool off tools/list, calls it, and is told it does not
    // exist. Each call below is driven with arguments that make it FAIL for its
    // own reason, so what is asserted is only that the branch was reached.
    for (const name of ["explain_internals", "improvement_areas", "platform_map"]) {
      const { res, body } = await callTool(name, {});
      assert.equal(res.status, 200, `${name} answers on the transport`);
      assert.equal(body.error, undefined, `${name} is not a JSON-RPC error`);
      assert.doesNotMatch(textOf(body), /Unknown tool/, `${name} has a dispatch branch`);
    }
  });
});

// ---------------------------------------------------------------------------
// platform_map — the free one
// ---------------------------------------------------------------------------

describe("platform_map", () => {
  test("answers from the committed snapshot with no provider and no key", async () => {
    // No BERGET_API_TOKEN and no DB in this env: a tool that answers here is
    // one that reached neither.
    const { body } = await callTool("platform_map", {});
    assert.equal(body.result.isError, false);
    assert.match(textOf(body), /deep research platform/);
    assert.match(textOf(body), /1 documented area\b/, "counts agree with their nouns");
  });

  test("narrows to an area", async () => {
    const { body } = await callTool("platform_map", { area: "cache" });
    assert.equal(body.result.isError, false);
    assert.match(textOf(body), /cache helper/);
  });

  test("is refused when the account switches it off, not just hidden from the listing", async () => {
    // Exposure is enforced on the CALL as well as the listing, so a client that
    // cached an older tools/list still cannot reach it. The config travels on
    // the identity's account row, which is what makes narrowing take effect on
    // the next call for every outstanding key with nothing to re-issue.
    const off = /** @type {any} */ ({
      ...admin,
      user: { settings_json: JSON.stringify({ mcp: { tools: { platform_map: false } } }) },
    });
    const { body } = await callTool("platform_map", {}, { identity: off });
    assert.ok(body.error, "an unexposed tool is a JSON-RPC error");
    assert.match(String(body.error.message), /Unknown tool/);
  });

  test("switching the map off leaves the answering tools reachable", async () => {
    // One switch per tool, not one per family: an account that wants the
    // capability without the index should get exactly that.
    const off = /** @type {any} */ ({
      ...admin,
      user: { settings_json: JSON.stringify({ mcp: { tools: { platform_map: false } } }) },
    });
    const { body } = await callTool("explain_internals", { question: "x" }, { identity: off });
    assert.equal(body.error, undefined);
    assert.match(textOf(body), /BERGET_API_TOKEN/, "reached the pipeline hand-off");
  });

  test("an ordinary user is NOT quota-gated — the map is free", async () => {
    // It reads committed artifacts of this deploy. Gating it would mean an
    // agent that has run out of budget cannot even learn what exists, which is
    // the same reason literature_corpora sits outside the gate.
    const { body } = await callTool("platform_map", {}, { identity: user });
    assert.equal(body.result.isError, false);
    assert.match(textOf(body), /deep research platform/);
  });
});

// ---------------------------------------------------------------------------
// The two answering tools
// ---------------------------------------------------------------------------

describe("explain_internals / improvement_areas", () => {
  test("a missing question is refused in the family's own words, before any spend", async () => {
    for (const name of ["explain_internals", "improvement_areas"]) {
      const { body } = await callTool(name, {});
      assert.equal(body.result.isError, true, `${name} refuses`);
      const text = textOf(body);
      assert.match(text, /`question`/, `${name} names the argument to send`);
      assert.match(text, /nothing was spent/i, `${name} says nothing was spent`);
      // deep_research's own wording would tell the caller to send a research
      // question, which is the wrong next move for a caller asking about this
      // server.
      assert.doesNotMatch(text, /must be a non-empty string/);
    }
  });

  test("a real question reaches the pipeline hand-off — the branch routes", async () => {
    // With no BERGET_API_TOKEN, runDeepResearch refuses at its first line. That
    // refusal is the observation: it can only be produced by a call that got
    // through argument resolution and the quota gate into the research path.
    for (const name of ["explain_internals", "improvement_areas"]) {
      const { body } = await callTool(name, { question: "how does the gap check work" });
      assert.equal(body.result.isError, true, `${name} surfaces the failure as a result`);
      assert.match(textOf(body), /BERGET_API_TOKEN/, `${name} reached runDeepResearch`);
      assert.match(textOf(body), /Research failed/, `${name} shares deep_research's failure path`);
    }
  });

  test("the forced arguments are what the family IS", () => {
    // Pinned on the resolver rather than only in the schema: the schema is what
    // a caller reads, this is what actually runs.
    const config = defaultMcpConfig();
    const resolved = resolveIntrospectArgs(config, { question: "x" });
    assert.equal(resolved.agent, PLATFORM_AGENT, "the introspection agent answers");
    assert.equal(resolved.web_search, false, "grounded in this source, never the web");
    assert.equal(resolved.style, "voice", "built for a caller who is listening");
  });

  test("a caller may not switch the web back on, or answer as another agent", () => {
    const config = defaultMcpConfig();
    const resolved = resolveIntrospectArgs(config, {
      question: "x",
      web_search: true,
      agent: "cyber",
    });
    assert.equal(resolved.web_search, false, "an introspection answer stays in this codebase");
    assert.equal(resolved.agent, PLATFORM_AGENT, "a specialist for another domain is not offered");
  });

  test("style is honoured when named, in both directions", () => {
    const config = defaultMcpConfig();
    assert.equal(resolveIntrospectArgs(config, { style: "text" }).style, "text");
    assert.equal(resolveIntrospectArgs(config, { style: "voice" }).style, "voice");
    // An unrecognized style is the SCREEN one, matching normalizeStyle — a
    // caller inventing a style gets the answer it can read rather than a
    // refusal. Only ABSENCE means voice here.
    assert.equal(resolveIntrospectArgs(config, { style: "sung" }).style, "text");
    assert.equal(resolveIntrospectArgs(config, {}).style, "voice");
  });

  test("voice lowers the DEFAULT budget but never overrides a named one", () => {
    const config = defaultMcpConfig();
    const spoken = resolveIntrospectArgs(config, { question: "x" });
    const written = resolveIntrospectArgs(config, { question: "x", style: "text" });
    assert.ok(spoken.time_budget_s <= written.time_budget_s, "a spoken exchange dies in silence");
    assert.equal(resolveIntrospectArgs(config, { question: "x", time_budget_s: 240 }).time_budget_s, 240);
  });

  test("the account's model-override policy still applies", () => {
    const open = defaultMcpConfig();
    open.allow_model_override = true;
    assert.equal(resolveIntrospectArgs(open, { question: "x", model: "some/model" }).model, "some/model");
    const closed = defaultMcpConfig();
    closed.allow_model_override = false;
    closed.defaults.model = "house/model";
    assert.equal(resolveIntrospectArgs(closed, { question: "x", model: "some/model" }).model, "house/model");
  });
});

// ---------------------------------------------------------------------------
// The grounding guard
// ---------------------------------------------------------------------------

describe("an ungrounded run is refused, not answered", () => {
  test("resolveIntrospectArgs asks for the refusal; deep_research does not", () => {
    // The asymmetry IS the guard. resolveMcpAgent fails soft, which is right for
    // deep_research (the run still searches) and wrong here (web_search is
    // forced off, so an agent miss leaves nothing but the model's weights — and
    // a voice answer has no Sources list for the absence to show up in).
    assert.equal(resolveIntrospectArgs(defaultMcpConfig(), { question: "x" }).require_agent, true);
    assert.equal(
      /** @type {any} */ (resolveResearchArgs(defaultMcpConfig(), { question: "x" })).require_agent,
      undefined,
      "deep_research keeps its fail-soft degradation",
    );
  });

  test("a run whose agent does not resolve says so instead of answering from memory", async () => {
    // The registry is served from ASSETS; this env serves the snapshot and 404s
    // everything else, so the agent cannot resolve. BERGET_API_TOKEN is present
    // so the guard is what refuses, not the missing-key check above it.
    const { body } = await callTool(
      "explain_internals",
      { question: "how does the gap check work" },
      { bindings: { BERGET_API_TOKEN: "test-token" } },
    );
    assert.equal(body.result.isError, true);
    const text = textOf(body);
    assert.match(text, /own source is not available/i);
    assert.match(text, /would be from memory rather than from the code/i);
    assert.match(text, /Nothing was spent/);
    // And it must not read as a limit on the account, or the client's model
    // stops instead of retrying.
    assert.doesNotMatch(text, /quota/i);
  });
});

// ---------------------------------------------------------------------------
// The upgrade path for an account that already had a stored config
// ---------------------------------------------------------------------------

describe("adding spending tools to an existing account", () => {
  test("an account that switched deep_research OFF does not get them switched on", async () => {
    // The finding this closes: parseMcpConfig starts from "everything exposed"
    // and only overrides ids the stored row names, so two brand-new tools that
    // run the SAME pipeline against the SAME quota would arrive ON for an
    // account that had deliberately turned the pipeline off — usually while
    // handing a long-lived key to someone else.
    const config = parseMcpConfig(JSON.stringify({ mcp: { tools: { deep_research: false } } }));
    assert.equal(toolExposed(config, "deep_research"), false);
    assert.equal(toolExposed(config, "explain_internals"), false, "inherits the choice");
    assert.equal(toolExposed(config, "improvement_areas"), false, "inherits the choice");
    // The FREE one still arrives on: it spends nothing, so the reasoning above
    // does not reach it, and an agent should still be able to learn what exists.
    assert.equal(toolExposed(config, "platform_map"), true);
    // Nothing else is touched.
    assert.equal(toolExposed(config, "literature_search"), true);
  });

  test("an explicit ON in the stored row always wins over the inheritance", async () => {
    const config = parseMcpConfig(
      JSON.stringify({ mcp: { tools: { deep_research: false, explain_internals: true } } }),
    );
    assert.equal(toolExposed(config, "explain_internals"), true, "the account said so");
    assert.equal(toolExposed(config, "improvement_areas"), false, "still unmentioned");
  });

  test("an account with deep_research ON is unaffected, as is one with no stored row", async () => {
    for (const settings of [
      JSON.stringify({ mcp: { tools: { literature_fetch: false } } }),
      JSON.stringify({ mcp: {} }),
      "",
      null,
    ]) {
      const config = parseMcpConfig(settings);
      assert.equal(toolExposed(config, "explain_internals"), true, `on for ${String(settings)}`);
      assert.equal(toolExposed(config, "improvement_areas"), true);
    }
  });

  test("the inheritance is visible end to end, not just in the parser", async () => {
    const narrowed = /** @type {any} */ ({
      ...admin,
      user: { settings_json: JSON.stringify({ mcp: { tools: { deep_research: false } } }) },
    });
    const { body } = await callTool("explain_internals", { question: "x" }, { identity: narrowed });
    assert.ok(body.error, "refused as an unexposed tool");
    assert.match(String(body.error.message), /Unknown tool/);
    // The free one still answers.
    const map = await callTool("platform_map", {}, { identity: narrowed });
    assert.equal(map.body.result.isError, false);
  });
});

// ---------------------------------------------------------------------------
// Source-first routing
// ---------------------------------------------------------------------------

describe("the caller's own phrasing cannot route the answer away from the source", () => {
  test("the utterances that trip externalSourceIntent are ordinary things to ask a platform", async () => {
    // src/pipeline.js runResearch hands a source-carrying turn BACK to the web
    // wave when the message asks for outside material. Right for a chat turn.
    // Broken for these tools, which force web_search:false — there is no wave to
    // be handed back to, so the turn falls to triage and answers from the
    // pre-loaded excerpt block alone: the doc-recap failure runSourceResearch
    // exists to prevent, wearing a tool description that promises the opposite.
    const { externalSourceIntent } = await import("../public/js/introspect-core.js");
    const trips = [
      "how does your sandbox compare to Docker",
      "whats new in the research pipeline",
      "is the model catalog up to date",
      "introspection vs outrospection, how do they differ",
      "what are the latest developments in your sandbox",
    ];
    for (const q of trips) {
      assert.equal(externalSourceIntent(q), true, `"${q}" trips the gate`);
    }
    // And it is the CALLER's phrasing, not the lens or the voice note — those
    // must stay neutral or they would route every call.
    const { EXPLAIN_NOTE, IMPROVE_NOTE } = await import("./platform-tools.js");
    const { VOICE_NOTE } = await import("./voice-answer.js");
    for (const note of [EXPLAIN_NOTE, IMPROVE_NOTE, VOICE_NOTE]) {
      assert.equal(externalSourceIntent(note), false, "an appended note must not route the turn");
    }
  });

  test("require_agent sets the source-first flag the pipeline gate reads", async () => {
    // Pinned at the seam rather than through a full pipeline run: the flag is
    // what pipeline.js:runResearch consults, and the alternative — asserting on
    // an answer — needs a live provider.
    const { readFileSync } = await import("node:fs");
    const mcp = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
    assert.match(mcp, /if \(args\.require_agent\)[^\n]*sourceFirst = true/);
    const pipeline = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
    assert.match(pipeline, /sourceFirst === true/, "the gate reads the flag");
  });
});

test("the server's own instructions name the family", async () => {
  // SERVER_INSTRUCTIONS is the paragraph `server/discover` hands a modern client
  // — the one place the surface describes itself in prose. It enumerates the
  // families, and nothing else pinned it, so a family added without touching it
  // is invisible to exactly the callers the stateless revision was built for.
  const { SERVER_INSTRUCTIONS } = await import("./mcp.js");
  for (const name of ["explain_internals", "improvement_areas", "platform_map"]) {
    assert.match(SERVER_INSTRUCTIONS, new RegExp(name), `${name} is described to a client`);
  }
});
