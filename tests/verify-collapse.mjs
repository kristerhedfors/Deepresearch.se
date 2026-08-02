// Does the DEFAULT build still look like a watch after the slot collapse?
// The collapse agent reported the SKX007 now draws a bare steel bezel, because
// no listing publishes which insert is in a case set and KEEP_STANDINS refuses
// to invent one. That is honest, and it is also the first thing a visitor sees.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "/tmp/claude-0/-home-user-Deepresearch-se/ef632ec5-e467-58f4-874e-b23897f1bc6c/scratchpad/collapse";
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:8231";

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

async function shot(name) {
  await page.waitForTimeout(2600);
  const d = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? c.toDataURL("image/png") : null;
  });
  if (d) writeFileSync(`${OUT}/${name}.png`, Buffer.from(d.split(",")[1], "base64"));
  return !!d;
}

// 1. The bare default — what a first-time visitor meets.
await page.goto(`${BASE}/watch/`, { waitUntil: "load" });
console.log("default: " + await shot("01-default"));

// 2. The same build with an insert deliberately named, for comparison.
const code = await page.evaluate(async () => {
  const m = await import("/js/watch-core.js");
  return encodeURIComponent(m.encodeBuild(m.normalizeBuild({ ...m.DEFAULT_BUILD, insert: "ceramic-black" })));
});
await page.goto("about:blank");
await page.goto(`${BASE}/watch/#${code}`, { waitUntil: "load" });
console.log("named-insert: " + await shot("02-named-insert"));

console.log("\nconsole errors: " + (errors.length ? "\n" + errors.join("\n") : "NONE"));
await browser.close();
