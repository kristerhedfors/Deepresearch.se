// Node tests for the mode-theme registry (mode-theme.js): every chat mode has
// a complete descriptor, the selectors resolve + fall back safely, SDK is the
// plant/green identity, and the two tier reference entries keep Se/cure first.

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHAT_MODE_IDS,
  MODE_ROOT_CLASSES,
  MODE_THEMES,
  TIER_THEMES,
  backdropKind,
  barTint,
  checkColor,
  modeCharacter,
  modeRootClass,
  modeTheme,
  panelFlavour,
  showsDepthSlider,
  spinnerKind,
} from "./mode-theme.js";
import { CHAT_MODES } from "./chat-mode.js";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

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
  // Three side-panel flavours: plain chat history, SDK mode's build-idea
  // library, and the Models agent's lifecycle board.
  const panels = new Set(["history", "showcase", "models"]);
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

// THE THREE PLACES A THEME CLASS LIVES, pinned against each other. A mode's
// root class is DECLARED here, APPLIED at parse time by the inline script in
// public/index.html, re-applied on every switch by chat-mode.js, and PAINTED by
// public/css/app.css. Deep Science shipped declared, applied at parse time and
// painted — but chat-mode.js's hand-written toggles never learned about it
// (2026-08-02), so it could be turned on only by a reload and never turned off:
// the header showed two mode tags at once and the palette, the composer pane
// and the dropdown text came from two different themes. The tests below make
// each of the four places answer to the registry.
test("MODE_ROOT_CLASSES is every declared root class, once each", () => {
  const declared = CHAT_MODES.map((m) => MODE_THEMES[m].rootClass).filter(Boolean);
  assert.deepEqual(MODE_ROOT_CLASSES, declared);
  assert.equal(new Set(MODE_ROOT_CLASSES).size, MODE_ROOT_CLASSES.length, "two modes share a root class");
  assert.equal(modeRootClass("science"), "sci-mode");
  assert.equal(modeRootClass("normal"), null);
  assert.equal(modeRootClass("nope"), null, "unknown → Normal, which carries none");
});

test("index.html's parse-time script applies every mode's class and bar tint", () => {
  const html = readFileSync(here("../index.html"), "utf8");
  const boot = html.match(/<script data-devtheme>[\s\S]*?<\/script>/)?.[0];
  assert.ok(boot, "the data-devtheme first-paint script is missing from public/index.html");
  for (const mode of CHAT_MODES) {
    const t = MODE_THEMES[mode];
    if (!t.rootClass) continue;
    assert.ok(boot.includes(`"${mode}"`), `the first-paint script never tests for mode ${mode}`);
    assert.ok(boot.includes(`"${t.rootClass}"`), `the first-paint script never adds ${t.rootClass}`);
    assert.ok(boot.includes(t.bar), `the first-paint script never sets ${mode}'s bar tint ${t.bar}`);
  }
});

test("app.css paints a palette for every declared root class", () => {
  const css = readFileSync(here("../css/app.css"), "utf8");
  for (const cls of MODE_ROOT_CLASSES) {
    const block = css.match(new RegExp(`:root\\.${cls}\\s*\\{[^}]*\\}`))?.[0];
    assert.ok(block, `app.css has no :root.${cls} palette block`);
    assert.match(block, /--bg:/, `:root.${cls} does not remap the field colour`);
    assert.match(block, /--text:/, `:root.${cls} does not remap the text colour`);
  }
});

// The one DARK mode. Its `--text` is near-white, so the composer's default
// white glass (#composer at .3, and the chips inside it at another .35) put
// light text on a light chip — 2.58:1, measured on production with
// tests/theme-contrast.mjs. Every widget that carries text inside the pane
// needs the dark treatment; this pins that the override exists rather than
// re-measuring colour, which the audit script does properly in a browser.
test("the dark Deep Science theme overrides the composer's white glass", () => {
  const css = readFileSync(here("../css/app.css"), "utf8");
  for (const sel of ["#composer", "#model", "#modesel", "#attach", "#camera", ".att-card"]) {
    assert.ok(
      css.includes(`:root.sci-mode ${sel}`),
      `sci-mode does not override ${sel}, so its near-white text lands on white glass`,
    );
  }
});

// Text drawn ON an --accent fill. Two of the seven accents are gold, where
// white lands near 3:1 — so `--on-accent` exists and those themes override it.
// This is arithmetic over the declared palettes rather than a browser
// measurement (tests/theme-contrast.mjs does the real thing, but it samples the
// CHAT chrome and never signs in, so it cannot see the account panel where the
// first --on-accent control lives). What it buys is that an EIGHTH theme with a
// light accent fails here instead of shipping unreadable.
test("every theme's --on-accent clears AA against that theme's --accent", () => {
  const css = readFileSync(here("../css/app.css"), "utf8");
  const relLum = (hex) => {
    const ch = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const [x, y] = [relLum(a), relLum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const expand = (h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h);

  // Every palette block, root first, in declaration order — each inherits the
  // root's --on-accent unless it declares its own, exactly as the cascade does.
  const blocks = [...css.matchAll(/:root(\.[a-z-]+)?\s*\{([^}]*)\}/g)];
  const rootOn = blocks[0][2].match(/--on-accent:\s*(#[0-9a-f]{3,8})/i)?.[1];
  assert.ok(rootOn, "app.css declares no default --on-accent");
  let checked = 0;
  for (const [, cls, body] of blocks) {
    const accent = body.match(/--accent:\s*(#[0-9a-f]{3,8})/i)?.[1];
    if (!accent) continue;
    const on = body.match(/--on-accent:\s*(#[0-9a-f]{3,8})/i)?.[1] || rootOn;
    const r = ratio(expand(accent), expand(on));
    // 4.3, not 4.5: the SDK green sits at 4.38 with white and at 4.44 with
    // near-black, so no text colour clears AA on it and picking one is a
    // wash. The floor is set to catch a genuinely unreadable fill — the two
    // golds were at 3.1 before they got their override — not to relitigate a
    // colour where both choices are equally marginal.
    assert.ok(
      r >= 4.3,
      `${cls || ":root"}: --on-accent ${on} on --accent ${accent} is ${r.toFixed(2)}:1`,
    );
    checked++;
  }
  assert.ok(checked >= 7, `expected every palette to declare an accent, checked ${checked}`);
});

test("depth slider is an optional theme feature: off for Introspection + SDK + Orchestrator", () => {
  assert.equal(showsDepthSlider("normal"), true);
  assert.equal(showsDepthSlider("introspection"), false);
  assert.equal(showsDepthSlider("sdk"), false);
  assert.equal(showsDepthSlider("orchestrator"), false);
  assert.equal(MODE_THEMES.introspection.depthSlider, false);
  assert.equal(MODE_THEMES.sdk.depthSlider, false);
  assert.equal(MODE_THEMES.orchestrator.depthSlider, false);
  // Outrospection answers from the outward feed, not from web research.
  assert.equal(MODE_THEMES.outrospection.depthSlider, false);
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
