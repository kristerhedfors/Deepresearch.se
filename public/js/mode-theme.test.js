// Node tests for the mode-theme registry (mode-theme.js): every chat mode has
// a complete descriptor, the selectors resolve + fall back safely, SDK is the
// plant/green identity, and the two tier reference entries keep Se/cure first.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODE_IDS,
  MODE_THEMES,
  TIER_THEMES,
  backdropKind,
  barTint,
  checkColor,
  modeCharacter,
  modeTheme,
  panelFlavour,
  showsDepthSlider,
  spinnerKind,
} from "./mode-theme.js";
import { CHAT_MODES } from "./chat-mode.js";

test("registry covers exactly the chat modes, in the same order", () => {
  assert.deepEqual(CHAT_MODE_IDS, CHAT_MODES);
  for (const id of CHAT_MODES) {
    assert.ok(MODE_THEMES[id], `missing descriptor for ${id}`);
    assert.equal(MODE_THEMES[id].id, id);
  }
});

test("every descriptor declares all distinguishing axes", () => {
  const spinners = new Set(["balloon", "plant"]);
  const chars = new Set(["balloon", "tin", "plant"]);
  const panels = new Set(["history", "showcase"]);
  const backdrops = new Set(["terminal", "graph"]);
  for (const t of Object.values(MODE_THEMES)) {
    assert.ok(typeof t.label === "string" && t.label);
    assert.ok(t.rootClass === null || typeof t.rootClass === "string");
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.accent), `accent for ${t.id}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.bar), `bar for ${t.id}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.check), `check for ${t.id}`);
    assert.ok(typeof t.checkVar === "string" && t.checkVar.startsWith("--"));
    assert.ok(spinners.has(t.spinner), `spinner for ${t.id}`);
    assert.ok(chars.has(t.character), `character for ${t.id}`);
    assert.ok(panels.has(t.panel), `panel for ${t.id}`);
    assert.ok(backdrops.has(t.backdrop), `backdrop for ${t.id}`);
    assert.ok(typeof t.depthSlider === "boolean", `depthSlider for ${t.id}`);
    assert.ok(typeof t.symbol === "string" && t.symbol);
    assert.ok(typeof t.blurb === "string" && t.blurb);
  }
});

test("depth slider is an optional theme feature: off for Introspection + SDK + Orchestrator", () => {
  assert.equal(showsDepthSlider("normal"), true);
  assert.equal(showsDepthSlider("introspection"), false);
  assert.equal(showsDepthSlider("sdk"), false);
  assert.equal(showsDepthSlider("orchestrator"), false);
  assert.equal(MODE_THEMES.introspection.depthSlider, false);
  assert.equal(MODE_THEMES.sdk.depthSlider, false);
  assert.equal(MODE_THEMES.orchestrator.depthSlider, false);
  assert.equal(showsDepthSlider("nope"), true, "unknown → Normal (shows it)");
});

test("Orchestrator is the violet baton / balloon-recolour identity", () => {
  const o = MODE_THEMES.orchestrator;
  assert.equal(o.rootClass, "orch-mode");
  assert.equal(o.label, "Orchestrator");
  assert.equal(o.tag, "orchestrator");
  assert.equal(o.spinner, "balloon"); // a recolour (mode-spinner.js), not a new figure
  assert.equal(o.panel, "history");
  assert.equal(o.checkVar, "--check-violet");
  assert.equal(barTint("orchestrator"), "#c3aaf2");
});

test("backdrop is a declared axis: graph for Orchestrator, terminal elsewhere", () => {
  assert.equal(backdropKind("orchestrator"), "graph");
  assert.equal(backdropKind("normal"), "terminal");
  assert.equal(backdropKind("introspection"), "terminal");
  assert.equal(backdropKind("sdk"), "terminal");
  assert.equal(backdropKind("nope"), "terminal", "unknown → Normal");
});

test("SDK is the Agent Studio plant / green / showcase identity", () => {
  const sdk = MODE_THEMES.sdk;
  assert.equal(sdk.rootClass, "sdk-mode");
  assert.equal(sdk.label, "Agent Studio"); // renamed from "Agent Builder", 2026-07-23
  assert.equal(sdk.tag, "agent studio");
  assert.equal(sdk.spinner, "plant");
  assert.equal(sdk.character, "plant");
  assert.equal(sdk.panel, "showcase");
  assert.equal(sdk.checkVar, "--check-green");
});

test("bar tint resolves per mode (the status-bar field color)", () => {
  assert.equal(barTint("normal"), "#6fc3fd");
  assert.equal(barTint("introspection"), "#ccd2d8");
  assert.equal(barTint("sdk"), "#66cc92");
  assert.equal(barTint("nope"), "#6fc3fd", "unknown → Normal");
  // Each bar matches nothing but a hex — the descriptor axis test covers shape.
});

test("introspection wears the titanium balloon: recoloured spinner + slate ✓", () => {
  const i = MODE_THEMES.introspection;
  assert.equal(i.rootClass, "dev-mode");
  // The spinner KIND stays balloon (a titanium recolour, not a new figure)…
  assert.equal(i.spinner, "balloon");
  assert.equal(i.character, "tin");
  // …but its ✓ is titanium slate, not the tier blue — and points at --check-tin
  // so the canvas fold and the CSS .check span agree.
  assert.notEqual(i.check, MODE_THEMES.normal.check);
  assert.equal(i.check, "#5f6b78");
  assert.equal(i.checkVar, "--check-tin");
});

test("normal has no theme class and mounts the balloon", () => {
  const n = MODE_THEMES.normal;
  assert.equal(n.rootClass, null);
  assert.equal(n.tag, null);
  assert.equal(n.spinner, "balloon");
});

test("selectors resolve known modes and fall back to Normal on garbage", () => {
  assert.equal(spinnerKind("sdk"), "plant");
  assert.equal(spinnerKind("normal"), "balloon");
  assert.equal(spinnerKind("introspection"), "balloon");
  assert.equal(spinnerKind("nope"), "balloon", "unknown → normal");
  assert.equal(spinnerKind(null), "balloon", "defensive");
  assert.equal(checkColor("sdk"), "#1f8a4c");
  assert.equal(modeCharacter("sdk"), "plant");
  assert.equal(panelFlavour("sdk"), "showcase");
  assert.equal(panelFlavour("normal"), "history");
  assert.equal(modeTheme(undefined).id, "normal");
});

test("tier reference entries exist and keep Se/cure first", () => {
  const keys = Object.keys(TIER_THEMES);
  assert.deepEqual(keys, ["secure", "server"], "secure-first");
  assert.equal(TIER_THEMES.secure.checkVar, "--check-pink");
  assert.equal(TIER_THEMES.server.checkVar, "--check-blue");
});
