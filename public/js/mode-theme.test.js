// Node tests for the mode-theme registry (mode-theme.js): every chat mode has
// a complete descriptor, the selectors resolve + fall back safely, SDK is the
// plant/green identity, and the two tier reference entries keep Se/cure first.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODE_IDS,
  MODE_THEMES,
  TIER_THEMES,
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
  for (const t of Object.values(MODE_THEMES)) {
    assert.ok(typeof t.label === "string" && t.label);
    assert.ok(t.rootClass === null || typeof t.rootClass === "string");
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.accent), `accent for ${t.id}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.check), `check for ${t.id}`);
    assert.ok(typeof t.checkVar === "string" && t.checkVar.startsWith("--"));
    assert.ok(spinners.has(t.spinner), `spinner for ${t.id}`);
    assert.ok(chars.has(t.character), `character for ${t.id}`);
    assert.ok(panels.has(t.panel), `panel for ${t.id}`);
    assert.ok(typeof t.depthSlider === "boolean", `depthSlider for ${t.id}`);
    assert.ok(typeof t.symbol === "string" && t.symbol);
    assert.ok(typeof t.blurb === "string" && t.blurb);
  }
});

test("depth slider is an optional theme feature: off for Introspection + SDK", () => {
  assert.equal(showsDepthSlider("normal"), true);
  assert.equal(showsDepthSlider("introspection"), false);
  assert.equal(showsDepthSlider("sdk"), false);
  assert.equal(MODE_THEMES.introspection.depthSlider, false);
  assert.equal(MODE_THEMES.sdk.depthSlider, false);
  assert.equal(showsDepthSlider("nope"), true, "unknown → Normal (shows it)");
});

test("SDK is the plant / green / showcase identity", () => {
  const sdk = MODE_THEMES.sdk;
  assert.equal(sdk.rootClass, "sdk-mode");
  assert.equal(sdk.spinner, "plant");
  assert.equal(sdk.character, "plant");
  assert.equal(sdk.panel, "showcase");
  assert.equal(sdk.checkVar, "--check-green");
});

test("introspection keeps the balloon spinner but its own character + class", () => {
  const i = MODE_THEMES.introspection;
  assert.equal(i.rootClass, "dev-mode");
  assert.equal(i.spinner, "balloon");
  assert.equal(i.character, "tin");
  // Its ✓ matches the spinner it mounts, so canvas/real checks agree.
  assert.equal(i.check, MODE_THEMES.normal.check);
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
