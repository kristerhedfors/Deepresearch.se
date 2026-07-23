// Unit suite for the AgentSpec pure core (agent-spec-core.js): the closed
// control vocabulary, spec + registry validation, control/theme/quota/example
// resolution, snapshot loading, and text rendering. Also loads the REAL shipped
// registry (sdk/AGENTS.json) and asserts every agent validates and resolves —
// so a bad agent definition fails `npm test`, the same way a bad manifest does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTROL_TYPES,
  CONTROL_REGISTRY,
  PLATFORM_TYPES,
  QUOTA_WINDOWS,
  validateAgentSpec,
  validateAgentRegistry,
  resolveControl,
  resolveControls,
  resolveTheme,
  resolveQuota,
  resolveExamples,
  exampleGenPrompt,
  agentsFromSnapshot,
  findAgent,
  renderAgentList,
  renderAgentShow,
  composerMarkup,
  composerModel,
  controlMarkup,
  proveComposer,
  agentLinkPlan,
  AGENTS_PATH,
  BASE_THEME,
} from "./agent-spec-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const realRegistry = () => JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));

const minimalSpec = (over = {}) => ({
  id: "demo",
  name: "Demo",
  platform: "client",
  controls: [{ type: "prompt-input" }, { type: "send-button" }],
  ...over,
});

test("control vocabulary is closed and self-describing", () => {
  assert.ok(CONTROL_TYPES.includes("prompt-input"));
  assert.ok(CONTROL_TYPES.includes("depth-slider"));
  for (const t of CONTROL_TYPES) {
    assert.ok(CONTROL_REGISTRY[t], `${t} has a registry entry`);
    assert.ok("drives" in CONTROL_REGISTRY[t], `${t} declares what it drives`);
  }
});

test("a minimal spec validates", () => {
  assert.deepEqual(validateAgentSpec(minimalSpec()), []);
});

test("validation catches structural problems", () => {
  assert.ok(validateAgentSpec(null).length);
  assert.ok(validateAgentSpec({ id: "Bad Id", name: "x", platform: "client", controls: [{ type: "prompt-input" }] }).some((p) => /slug/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ platform: "nope" })).some((p) => /platform/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ controls: [{ type: "send-button" }] })).some((p) => /prompt-input/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ controls: [{ type: "bogus" }, { type: "prompt-input" }] })).some((p) => /unknown control/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ controls: [{ type: "prompt-input" }, { type: "toggle" }] })).some((p) => /needs an id/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ controls: [{ type: "prompt-input" }, { type: "depth-slider", min: 3, max: 1 }] })).some((p) => /min < max/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ quota: { window: "week" } })).some((p) => /quota.window/.test(p)));
  assert.ok(validateAgentSpec(minimalSpec({ quota: { requests: -1 } })).some((p) => /quota.requests/.test(p)));
});

test("registry validation flags duplicate ids", () => {
  const problems = validateAgentRegistry({ agents: [minimalSpec(), minimalSpec()] });
  assert.ok(problems.some((p) => /duplicate agent id/.test(p)));
});

test("resolveControl fills type defaults, label and drives", () => {
  const c = resolveControl({ type: "depth-slider" });
  assert.equal(c.min, 0);
  assert.equal(c.max, 3);
  assert.equal(c.drives, "depth");
  assert.equal(c.label, "Research depth");
  const t = resolveControl({ type: "toggle", id: "web_search", label: "Web search" });
  assert.equal(t.drives, "web_search"); // a toggle drives the flag named by its id
});

test("resolveControls guarantees a send-button", () => {
  const list = resolveControls({ controls: [{ type: "prompt-input" }] });
  assert.ok(list.some((c) => c.type === "send-button"));
});

test("theme overlays BASE_THEME", () => {
  const theme = resolveTheme({ theme: { "--agent-accent": "#123456" } });
  assert.equal(theme["--agent-accent"], "#123456");
  assert.equal(theme["--agent-fg"], BASE_THEME["--agent-fg"]);
});

test("quota resolves with safe fallbacks", () => {
  const q = resolveQuota({ quota: { window: "hour", requests: 5 } });
  assert.equal(q.window, "hour");
  assert.equal(q.requests, 5);
  const d = resolveQuota({});
  assert.ok(QUOTA_WINDOWS.includes(d.window));
  assert.equal(d.requests, 50);
});

test("examples resolve + dedupe, and a gen prompt is produced", () => {
  const { seed, generatable } = resolveExamples({ examples: ["a", "a", "b"] });
  assert.deepEqual(seed, ["a", "b"]);
  assert.equal(generatable, true);
  assert.equal(resolveExamples({ examples: [], generateExamples: false }).generatable, false);
  const prompt = exampleGenPrompt({ id: "x", name: "X", tagline: "does things", examples: ["a"] }, 3);
  assert.ok(/Write 3/.test(prompt));
  assert.ok(/ONE question per line/.test(prompt));
});

test("agentsFromSnapshot loads, or degrades to null (never throws)", () => {
  const snap = { files: [{ p: AGENTS_PATH, t: JSON.stringify({ agents: [minimalSpec()] }) }] };
  assert.equal(agentsFromSnapshot(snap).agents.length, 1);
  assert.equal(agentsFromSnapshot({ files: [{ p: AGENTS_PATH, t: "{bad json" }] }), null);
  assert.equal(agentsFromSnapshot(null), null);
});

// ---- the REAL shipped registry ------------------------------------------------

test("sdk/AGENTS.json is a valid registry", () => {
  const reg = realRegistry();
  assert.deepEqual(validateAgentRegistry(reg), []);
});

test("the four shipped agents are present with the expected identities", () => {
  const reg = realRegistry();
  const ids = reg.agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ["agent-builder", "research", "secure", "under-construction"]);
  assert.equal(findAgent(reg, "research").platform, "server");
  assert.equal(findAgent(reg, "secure").platform, "client");
  assert.equal(findAgent(reg, "agent-builder").mode, "agent-builder");
});

test("every shipped agent resolves controls, theme and quota", () => {
  const reg = realRegistry();
  for (const a of reg.agents) {
    const controls = resolveControls(a);
    assert.ok(controls.some((c) => c.type === "prompt-input"), `${a.id} has a prompt-input`);
    assert.ok(controls.some((c) => c.type === "send-button"), `${a.id} has a send-button`);
    assert.ok(Object.keys(resolveTheme(a)).length >= 4, `${a.id} has a theme`);
    const q = resolveQuota(a);
    assert.ok(q.requests >= 0 && QUOTA_WINDOWS.includes(q.window), `${a.id} has a resolvable quota`);
    assert.ok(PLATFORM_TYPES.includes(a.platform));
  }
});

test("composerMarkup renders every declared control (XSS-safe)", () => {
  const spec = minimalSpec({
    controls: [
      { type: "prompt-input", placeholder: '<script>"x"' },
      { type: "depth-slider" },
      { type: "toggle", id: "web_search", label: "Web search" },
      { type: "model-select" },
      { type: "attachments" },
      { type: "mode-select", modes: ["normal", "introspection"] },
      { type: "send-button" },
    ],
  });
  const html = composerMarkup(spec);
  assert.ok(html.includes('data-control="depth-slider"'));
  assert.ok(html.includes('data-drives="depth"'));
  assert.ok(html.includes('data-drives="web_search"'));
  assert.ok(html.includes('data-control="mode-select"'));
  assert.ok(!html.includes("<script>"), "placeholder is escaped");
  // controlMarkup is the per-control unit
  assert.ok(controlMarkup({ type: "send-button", label: "Go" }).includes(">Go<"));
});

test("composerModel exposes the resolved pane", () => {
  const m = composerModel(minimalSpec({ theme: { "--agent-accent": "#abc" } }));
  assert.equal(m.theme["--agent-accent"], "#abc");
  assert.ok(Array.isArray(m.controls));
});

test("agentLinkPlan derives perms + quota from the spec", () => {
  const plan = agentLinkPlan({
    id: "x", platform: "server",
    controls: [{ type: "prompt-input" }, { type: "model-select" }, { type: "toggle", id: "web_search", label: "W" }],
    quota: { window: "hour", requests: 12 },
  });
  assert.ok(plan.perms.includes("llm"));
  assert.ok(plan.perms.includes("search"));
  assert.equal(plan.quota.requests, 12);
  assert.equal(plan.quota.window, "hour");
  // an agent with no search toggle gets no search perm
  const noSearch = agentLinkPlan({ id: "y", platform: "client", controls: [{ type: "prompt-input" }] });
  assert.ok(!noSearch.perms.includes("search"));
  assert.ok(noSearch.perms.includes("llm"));
});

test("every shipped agent produces a link plan", () => {
  const reg = realRegistry();
  for (const a of reg.agents) {
    const plan = agentLinkPlan(a);
    assert.equal(plan.agent, a.id);
    assert.ok(plan.quota.requests >= 0);
  }
});

test("proveComposer passes for every shipped agent (the visual-proof gate)", () => {
  const reg = realRegistry();
  for (const a of reg.agents) {
    const p = proveComposer(a);
    assert.ok(p.ok, `${a.id} missing controls: ${p.missing.join(", ")}`);
    assert.ok(p.html.includes(`data-agent="${a.id}"`));
  }
});

test("rendering helpers produce readable text", () => {
  const reg = realRegistry();
  const list = renderAgentList(reg);
  assert.ok(/research/.test(list) && /Agent Builder/.test(list));
  const show = renderAgentShow(reg, "research");
  assert.ok(/drives `depth`/.test(show));
  assert.ok(/quota \(share link\)/.test(show));
  assert.equal(renderAgentShow(reg, "nope"), "unknown agent: nope");
});
