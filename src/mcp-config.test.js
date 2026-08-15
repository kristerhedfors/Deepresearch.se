// Unit tests for src/mcp-config.js — the per-account MCP exposure config.
//
// The load-bearing one is the MIRROR test: the catalog here and the tool list
// src/mcp.js serves must name exactly the same tools, so a tool can never ship
// on the MCP surface without a switch in Settings to turn it off. It imports
// mcp.js, which — per that module's file-layout rule — must still load without
// dragging the pipeline in, so this suite doubles as a second guard on it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_BUDGET_DEFAULT,
  MCP_BUDGET_MAX,
  MCP_BUDGET_MIN,
  MCP_TOOL_CATALOG,
  MCP_TOOL_IDS,
  MCP_VOICE_BUDGET_DEFAULT,
  applyConfigPatch,
  clampMcpBudget,
  defaultMcpConfig,
  filterMcpTools,
  isMcpEndpoint,
  isMcpHost,
  normalizeConfigPatch,
  normalizeStyle,
  parseMcpConfig,
  resolveResearchArgs,
  toolExposed,
} from "./mcp-config.js";
import { ALL_MCP_TOOLS, toolsListResult } from "./mcp.js";

test("the catalog mirrors the tool list src/mcp.js serves, exactly", () => {
  assert.deepEqual(
    [...MCP_TOOL_IDS].sort(),
    ALL_MCP_TOOLS.map((t) => t.name).sort(),
    "every exposable tool needs a catalog entry (and vice versa) — see src/mcp-config.js",
  );
  for (const entry of MCP_TOOL_CATALOG) {
    assert.ok(entry.group && entry.label && entry.blurb, `catalog entry ${entry.id} needs UI copy`);
  }
});

test("the default config exposes everything — the behaviour it replaced", () => {
  const config = defaultMcpConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.key, null);
  for (const id of MCP_TOOL_IDS) assert.equal(toolExposed(config, id), true);
  assert.deepEqual(toolsListResult(config).tools, ALL_MCP_TOOLS);
  assert.deepEqual(toolsListResult().tools, ALL_MCP_TOOLS, "no argument means the default config");
});

test("the ChatGPT adapter pair is catalogued, exposed by default, and switchable", () => {
  // docs/MCP-CONNECTOR.md §2a: ChatGPT refuses a server with no `search` and
  // `fetch`. So the two need catalog entries like every other tool (the mirror
  // test above already fails without them) AND they need to be on by default,
  // or a fresh account is one ChatGPT cannot connect to at all.
  const config = defaultMcpConfig();
  assert.equal(toolExposed(config, "search"), true);
  assert.equal(toolExposed(config, "fetch"), true);
  for (const id of ["search", "fetch"]) {
    const entry = /** @type {any} */ (MCP_TOOL_CATALOG.find((t) => t.id === id));
    // The blurb is what the Settings screen shows, and it is the ONLY place a
    // user can learn that this particular switch breaks a connector rather than
    // trimming a tool list. Discovering that as a failed connection instead is
    // the outcome this copy exists to prevent.
    assert.match(entry.blurb, /ChatGPT/);
  }
  // And the switch really does work: an account that turns `search` off has a
  // server ChatGPT will not accept — which is a supported choice, just one the
  // copy above has to name.
  const off = applyConfigPatch(defaultMcpConfig(), { tools: { search: false } });
  assert.equal(
    toolsListResult(off).tools.some((t) => t.name === "search"),
    false,
  );
});

test("parseMcpConfig degrades to the defaults on anything unreadable", () => {
  for (const bad of [null, undefined, "", "not json", "{}", '{"mcp":null}', '{"mcp":[]}', '{"mcp":42}']) {
    assert.deepEqual(parseMcpConfig(bad), defaultMcpConfig(), `should default on ${JSON.stringify(bad)}`);
  }
});

test("parseMcpConfig reads a stored config and ignores unknown tools", () => {
  const config = parseMcpConfig(
    JSON.stringify({
      bash_lite_mcp: true, // a neighbouring knob — must not disturb this half
      mcp: {
        enabled: true,
        tools: { deep_research: false, host_intel: true, not_a_tool: true },
        defaults: { time_budget_s: 300, web_search: false, model: " some-model " },
        allow_model_override: false,
        key: { jti: "abc", hint: "123456", label: "Laptop", created_at: 5, exp: 9 },
      },
    }),
  );
  assert.equal(config.tools.deep_research, false);
  assert.equal(config.tools.host_intel, true);
  assert.equal(config.tools.street_view_look, true, "an unmentioned tool keeps its default");
  assert.equal("not_a_tool" in config.tools, false);
  assert.deepEqual(config.defaults, { time_budget_s: 300, web_search: false, model: "some-model" });
  assert.equal(config.allow_model_override, false);
  assert.equal(config.allow_budget_override, true);
  assert.deepEqual(config.key, { jti: "abc", hint: "123456", label: "Laptop", created_at: 5, exp: 9 });
});

test("parseMcpConfig drops a key record with no jti — there is nothing to verify against", () => {
  assert.equal(parseMcpConfig('{"mcp":{"key":{"hint":"abc123"}}}').key, null);
  assert.equal(parseMcpConfig('{"mcp":{"key":"a-token"}}').key, null);
});

test("a stored out-of-range budget default is clamped, not honoured", () => {
  assert.equal(parseMcpConfig('{"mcp":{"defaults":{"time_budget_s":99999}}}').defaults.time_budget_s, MCP_BUDGET_MAX);
  assert.equal(parseMcpConfig('{"mcp":{"defaults":{"time_budget_s":1}}}').defaults.time_budget_s, MCP_BUDGET_MIN);
  assert.equal(clampMcpBudget(Number.NaN), MCP_BUDGET_DEFAULT);
});

test("the master switch wins over every individual tool row", () => {
  const config = { ...defaultMcpConfig(), enabled: false };
  for (const id of MCP_TOOL_IDS) assert.equal(toolExposed(config, id), false);
  assert.deepEqual(toolsListResult(config).tools, []);
});

test("filterMcpTools narrows the list and drops uncatalogued names", () => {
  const config = applyConfigPatch(defaultMcpConfig(), { tools: { host_intel: false, place_nearby: false } });
  const names = filterMcpTools(config, ALL_MCP_TOOLS).map((t) => t.name);
  assert.ok(names.includes("deep_research"));
  assert.ok(!names.includes("host_intel"));
  assert.deepEqual(filterMcpTools(config, [{ name: "ghost_tool" }]), []);
});

// ---- the research tool's effective arguments --------------------------------

test("resolveResearchArgs falls back to the account's defaults", () => {
  const config = applyConfigPatch(defaultMcpConfig(), {
    defaults: { time_budget_s: 45, web_search: true, model: "house-model" },
  });
  assert.deepEqual(resolveResearchArgs(config, {}), {
    time_budget_s: 45,
    web_search: true,
    model: "house-model",
    agent: "",
    style: "text",
  });
});

test("voice style lowers the DEFAULT budget and nothing else", () => {
  const config = applyConfigPatch(defaultMcpConfig(), { defaults: { time_budget_s: 300 } });
  // A spoken exchange cannot wait five minutes, so the default drops…
  assert.equal(resolveResearchArgs(config, { style: "voice" }).time_budget_s, MCP_VOICE_BUDGET_DEFAULT);
  // …but a caller that names a budget gets the one it named, in either style.
  assert.equal(resolveResearchArgs(config, { style: "voice", time_budget_s: 240 }).time_budget_s, 240);
  // An account whose own default is already shorter keeps it — this lowers, never raises.
  const brief = applyConfigPatch(defaultMcpConfig(), { defaults: { time_budget_s: 30 } });
  assert.equal(resolveResearchArgs(brief, { style: "voice" }).time_budget_s, 30);
  assert.equal(resolveResearchArgs(config, {}).time_budget_s, 300, "text style is untouched");
});

test("style and agent are carried through, and junk degrades rather than fails", () => {
  const config = defaultMcpConfig();
  assert.equal(resolveResearchArgs(config, { style: "VOICE" }).style, "voice");
  assert.equal(resolveResearchArgs(config, { style: "interpretive dance" }).style, "text");
  assert.equal(resolveResearchArgs(config, { style: 7 }).style, "text");
  assert.equal(resolveResearchArgs(config, { agent: "  cyber " }).agent, "cyber");
  assert.equal(resolveResearchArgs(config, { agent: 42 }).agent, "");
  assert.equal(normalizeStyle("voice"), "voice");
});

test("a caller may narrow the budget and model when the account allows it", () => {
  const config = defaultMcpConfig();
  const r = resolveResearchArgs(config, { time_budget_s: 30, model: "caller-model" });
  assert.equal(r.time_budget_s, 30);
  assert.equal(r.model, "caller-model");
});

test("override policy off: the caller's budget and model are ignored", () => {
  const config = applyConfigPatch(defaultMcpConfig(), {
    allow_model_override: false,
    allow_budget_override: false,
    defaults: { time_budget_s: 60, web_search: true, model: "house-model" },
  });
  const r = resolveResearchArgs(config, { time_budget_s: 600, model: "caller-model" });
  assert.equal(r.time_budget_s, 60);
  assert.equal(r.model, "house-model");
});

test("an overriding caller's budget is still clamped to the schema window", () => {
  const r = resolveResearchArgs(defaultMcpConfig(), { time_budget_s: 99999 });
  assert.equal(r.time_budget_s, MCP_BUDGET_MAX);
});

test("web search: a caller may decline it, but may not switch it back on", () => {
  const on = defaultMcpConfig();
  assert.equal(resolveResearchArgs(on, { web_search: false }).web_search, false);
  const off = applyConfigPatch(defaultMcpConfig(), { defaults: { web_search: false } });
  assert.equal(resolveResearchArgs(off, { web_search: true }).web_search, false);
  assert.equal(resolveResearchArgs(off, {}).web_search, false);
});

test("resolveResearchArgs tolerates junk arguments", () => {
  for (const bad of [null, undefined, "nope", 42]) {
    const r = resolveResearchArgs(defaultMcpConfig(), bad);
    assert.equal(r.time_budget_s, MCP_BUDGET_DEFAULT);
    assert.equal(r.web_search, true);
  }
});

// ---- the PUT body ------------------------------------------------------------

test("normalizeConfigPatch accepts a partial, well-formed body", () => {
  const r = normalizeConfigPatch({ enabled: false, tools: { host_intel: false }, defaults: { time_budget_s: 90 } });
  assert.ok(r.ok);
  assert.deepEqual(r.patch, { enabled: false, tools: { host_intel: false }, defaults: { time_budget_s: 90 } });
});

test("normalizeConfigPatch rejects rather than coerces", () => {
  const bad = [
    null,
    "hello",
    [],
    {},
    { enabled: "yes" },
    { tools: [] },
    { tools: { deep_research: "on" } },
    { tools: { imaginary_tool: true } },
    { defaults: { time_budget_s: 5 } },
    { defaults: { time_budget_s: 10_000 } },
    { defaults: { time_budget_s: "fast" } },
    { defaults: { web_search: 1 } },
    { defaults: { model: 42 } },
    { allow_model_override: "no" },
  ];
  for (const body of bad) {
    const r = normalizeConfigPatch(body);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(body)}`);
    assert.ok(r.error);
  }
});

test("applyConfigPatch merges tools and defaults key-by-key and never touches the key record", () => {
  const config = { ...defaultMcpConfig(), key: { jti: "j", hint: "h", label: "l", created_at: 1, exp: 2 } };
  const next = applyConfigPatch(config, { tools: { host_intel: false }, defaults: { web_search: false } });
  assert.equal(next.tools.host_intel, false);
  assert.equal(next.tools.deep_research, true, "unmentioned tools survive");
  assert.equal(next.defaults.time_budget_s, MCP_BUDGET_DEFAULT, "unmentioned defaults survive");
  assert.equal(next.defaults.web_search, false);
  assert.deepEqual(next.key, config.key, "the key is not editable through the config patch");
});

// ---- host / endpoint recognition ---------------------------------------------

test("isMcpHost matches the mcp. subdomain only", () => {
  assert.equal(isMcpHost("mcp.deepresearch.se"), true);
  assert.equal(isMcpHost("MCP.deepresearch.se"), true);
  assert.equal(isMcpHost("mcp.example.test"), true, "a fork or preview behaves the same way");
  assert.equal(isMcpHost("deepresearch.se"), false);
  assert.equal(isMcpHost("www.deepresearch.se"), false);
  assert.equal(isMcpHost("notmcp.deepresearch.se"), false);
  assert.equal(isMcpHost(""), false);
  assert.equal(isMcpHost(null), false);
});

test("isMcpEndpoint: POST /mcp anywhere, plus the bare origin on the mcp host", () => {
  const at = (u) => new URL(u);
  assert.equal(isMcpEndpoint(at("https://deepresearch.se/mcp"), "POST"), true);
  assert.equal(isMcpEndpoint(at("https://mcp.deepresearch.se/mcp"), "POST"), true);
  assert.equal(isMcpEndpoint(at("https://mcp.deepresearch.se/"), "POST"), true);
  assert.equal(isMcpEndpoint(at("https://deepresearch.se/"), "POST"), false, "the apex root is the app");
  assert.equal(isMcpEndpoint(at("https://mcp.deepresearch.se/api/chat"), "POST"), false);
  assert.equal(isMcpEndpoint(at("https://mcp.deepresearch.se/mcp"), "GET"), false);
});
