// Live visual verification of the NHxx watch builder against production.
// Loads /watch/ with specific builds via the permalink hash and screenshots the
// canvas, so the feedback #56 complaints can actually be LOOKED at.
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.env.OUT || "/tmp/claude-0/-home-user-Deepresearch-se/d4b51738-b1f6-5334-b3bb-54dbcb637fef/scratchpad/shots";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || "http://127.0.0.1:8099";

// Each case targets a specific complaint from feedback #56.
const CASES = [
  ["01-default-skx-oyster", "the default build: case solidity, metal reflections, oyster bracelet",
    { case: "skx007", strap: "oyster" }],
  ["02-jubilee", "jubilee must look structurally different from the oyster",
    { case: "skx007", strap: "jubilee" }],
  ["03-leather", "leather must not be shiny like a mirror",
    { case: "62mas", strap: "leather" }],
  ["04-nato", "NATO construction",
    { case: "skx007", strap: "nato" }],
  ["05-daydate", "day must not clip into date",
    { case: "skx007", dial: "daydate-black", movement: "nh36" }],
  ["06-flat-sapphire", "flat sapphire must be flat",
    { case: "skx007", crystal: "flat-sapphire" }],
  ["07-box-sapphire", "box crystal must differ from the domes",
    { case: "skx007", crystal: "box-sapphire" }],
  ["08-turtle", "a cushion case must not look like the SKX",
    { case: "srp-turtle", strap: "waffle" }],
  ["09-tuna", "the shrouded case must read as a Tuna",
    { case: "tuna", strap: "tropic" }],
  ["10-dress", "a dress case must read slim and distinct",
    { case: "explorer", strap: "leather" }],
];

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  // Outbound goes through the agent proxy; the browser NSS store already
  // trusts its CA, so this needs the server address and nothing else.
  proxy: undefined,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

// Build the permalink the same way the page does, using the deployed module.
await page.goto(`${BASE}/watch/`, { waitUntil: "networkidle" });
const report = [];

for (const [name, why, parts] of CASES) {
  const code = await page.evaluate(async (p) => {
    const m = await import("/js/watch-core.js");
    return encodeURIComponent(m.encodeBuild(m.normalizeBuild({ ...m.DEFAULT_BUILD, ...p })));
  }, parts);

  await page.goto(`${BASE}/watch/#${code}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800); // let the render settle

  const info = await page.evaluate(() => {
    const c = document.getElementById("view");
    const gl = c && (c.getContext("webgl") || c.getContext("experimental-webgl"));
    const nogl = !!document.querySelector(".nogl");
    // Is anything actually drawn? Sample the canvas via a 2D copy.
    let nonBlank = null;
    try {
      const t = document.createElement("canvas");
      t.width = 160; t.height = 160;
      const g = t.getContext("2d");
      g.drawImage(c, 0, 0, 160, 160);
      const d = g.getImageData(0, 0, 160, 160).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
      nonBlank = lit / (160 * 160);
    } catch (e) { nonBlank = "ERR:" + e.message; }
    return { hasCanvas: !!c, hasGl: !!gl, nogl, litFraction: nonBlank };
  });

  const el = await page.$("#view");
  if (el) await el.screenshot({ path: `${OUT}/${name}.png` });
  report.push({ name, why, ...info });
  console.log(`${name.padEnd(22)} gl=${info.hasGl} nogl=${info.nogl} lit=${typeof info.litFraction === "number" ? info.litFraction.toFixed(3) : info.litFraction}`);
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, consoleErrors }, null, 2));
console.log("\nconsole errors:", consoleErrors.length);
for (const e of consoleErrors.slice(0, 15)) console.log("  -", e);
await browser.close();
