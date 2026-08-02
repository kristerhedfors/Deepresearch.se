// THEME CONTRAST + THEME SWITCHING audit — the instrument behind the
// 2026-08-02 mode-theme fixes.
//
// Two things it measures, per chat mode, in a real browser:
//
//   1. SWITCHING. Boot in every mode, then switch to every other mode, and
//      assert <html> ends up carrying EXACTLY the target mode's root class and
//      the header shows EXACTLY one mode tag. This is what caught Deep Science:
//      `sci-mode` was applied by index.html's parse-time script but never by
//      applyChatModeTheme, so it could not be switched on or off — a browser
//      that had booted in Science carried the class into every other agent, and
//      the header showed two tags.
//   2. CONTRAST. Composite every text-bearing chrome element against what is
//      actually painted behind it (walking up the ancestor chain, alpha-mixing
//      as it goes) and report the WCAG contrast ratio. Eyeballing a translucent
//      chip is exactly how a double-stacked white glass on a dark field went
//      unnoticed: the CSS says `color: var(--text)` and looks right in the six
//      light themes.
//
// Run against a local Worker (nothing spent, no credentials):
//
//   cd tests && npm install
//   npx wrangler@4.118.0 dev -c ../wrangler.dev.toml --local --enable-containers=false --port 8787 &
//   node theme-contrast.mjs
//
// Or point it elsewhere: BASE_URL=… BASIC_AUTH_USER=… BASIC_AUTH_PASS=… node theme-contrast.mjs
//
// Exits non-zero when a switch leaves the wrong classes on the root, when two
// mode tags show at once, or when a sampled element falls under the AA floor.
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { CHAT_MODES } from "../public/js/chat-mode-core.js";
import { MODE_THEMES } from "../public/js/mode-theme.js";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
// Credentials follow the TARGET, the way playwright.config.js resolves them. A
// dev container may carry the production break-glass pair in its environment;
// against a Worker on loopback those are simply the wrong password, and the
// Worker then serves the signed-out landing — which has no #form, so the run
// dies 30 s later on a selector timeout that says nothing about the cause.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
const USER = LOOPBACK ? "e2e" : process.env.BASIC_AUTH_USER;
const PASS = LOOPBACK ? "e2e-local-worker-no-secret" : process.env.BASIC_AUTH_PASS;
if (!USER || !PASS) throw new Error("Remote target needs BASIC_AUTH_USER / BASIC_AUTH_PASS.");
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

/** WCAG AA for normal-size text. The chips sampled here are .78–.9rem. */
const AA = 4.5;

/** Every root class the registry declares. */
const ROOT_CLASSES = Object.values(MODE_THEMES).map((t) => t.rootClass).filter(Boolean);

/** The chrome a user reads on every turn, and must therefore be legible. */
const SAMPLES = [
  "#modesel",
  "#model",
  "#input",
  "#budgetval",
  "#historybtn",
  "#accountbtn",
  ".brand",
];

// Composite an element's text colour against everything painted behind it, then
// return the WCAG ratio. Runs in the page: it needs getComputedStyle and the
// live ancestor chain.
const PROBE = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  // Walk up collecting the stack of backgrounds, then paint them front-to-back
  // onto an opaque base.
  const stack = [];
  for (let n = el; n; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) stack.push(c);
  }
  const rootBg = parse(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) ||
    parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  let bg = { ...rootBg, a: 1 };
  for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
  const fg = over(parse(getComputedStyle(el).color) || { r: 0, g: 0, b: 0, a: 1 }, bg);
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  const rgb = (c) => "rgb(" + [c.r, c.g, c.b].map((v) => Math.round(v)).join(",") + ")";
  return { ratio: (a + 0.05) / (b + 0.05), fg: rgb(fg), bg: rgb(bg) };
}`;

function themeState() {
  const root = document.documentElement;
  const tags = [...document.querySelectorAll(".introspection-tag,.sdk-tag,.orch-tag,.outro-tag,.models-tag,.sci-tag")]
    .filter((e) => getComputedStyle(e).display !== "none")
    .map((e) => e.textContent.trim());
  return { classes: [...root.classList], tags };
}

// Same proxy/TLS handling as playwright.config.js: outbound HTTPS in this
// repo's dev containers goes through an agent proxy that re-signs TLS and
// resets Chromium's TLS 1.3 ClientHello. None of it applies on loopback.
const PROXIED = !LOOPBACK && process.env.HTTPS_PROXY;
const browser = await chromium.launch({
  ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
  args: PROXIED ? ["--ssl-version-max=tls1.2"] : [],
});
const ctx = await browser.newContext({
  extraHTTPHeaders: { authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") },
  viewport: { width: 430, height: 932 },
  ...(PROXIED ? { proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true } : {}),
});
await ctx.addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);

const failures = [];

async function checkMode(page, mode, how) {
  const state = await page.evaluate(themeState);
  const want = MODE_THEMES[mode].rootClass;
  const carried = state.classes.filter((c) => ROOT_CLASSES.includes(c));
  const okClasses = want ? carried.length === 1 && carried[0] === want : carried.length === 0;
  if (!okClasses) {
    failures.push(`${how} ${mode}: root carries [${carried}], expected ${want || "no theme class"}`);
  }
  if (state.tags.length > 1) failures.push(`${how} ${mode}: ${state.tags.length} header tags at once — [${state.tags}]`);
  for (const sel of SAMPLES) {
    const r = await page.evaluate(new Function("return " + PROBE)(), sel);
    if (!r) continue;
    const label = `${how} ${mode} ${sel}`;
    if (r.ratio < AA) failures.push(`${label}: contrast ${r.ratio.toFixed(2)}:1 (${r.fg} on ${r.bg}) < ${AA}`);
    if (process.env.VERBOSE) console.log(`  ${label.padEnd(46)} ${r.ratio.toFixed(2)}:1  ${r.fg} on ${r.bg}`);
  }
}

for (const start of CHAT_MODES) {
  const page = await ctx.newPage();
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    try {
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      await route.fulfill({ response: res, json: { ...body, bash_lite_mcp: false, chat_mode: start } });
    } catch {
      /* page closed mid-flight */
    }
  });
  await page.addInitScript((m) => {
    localStorage.setItem("dr_chat_mode", m);
    localStorage.setItem("dr_rver_intro_plays", "9");
  }, start);
  await page.goto(BASE + "/");
  await page.waitForSelector("#form", { timeout: 60_000 });
  await page.waitForTimeout(400);
  await page.mouse.click(215, 466); // dismiss the intro animation if it is playing
  await page.waitForTimeout(600);
  console.log(`boot ${start}`);
  await checkMode(page, start, "boot");
  for (const to of CHAT_MODES) {
    if (to === start) continue;
    await page.selectOption("#modesel", to);
    await page.waitForTimeout(220);
    await checkMode(page, to, `${start}→`);
  }
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} failures:`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nAll modes: one theme class, one header tag, every sampled element at or above AA.");
