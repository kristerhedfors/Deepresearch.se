// Browser check of the /watch/ PICKER — the half `verify-watch.mjs` does not
// cover, since that one screenshots the 3D canvas. This drives the real
// controls and reads the build back through the permalink, so it measures what
// the page actually holds rather than what the page says.
//
// Run: serve public/ with `python3 -m http.server 8099 --bind 127.0.0.1`,
// then `node verify-picker.mjs` from tests/.
//
// TWO TRAPS, both hit while writing it:
//   1. Chromium in the agent containers cannot reach the public internet at
//      all — connection reset even to example.com, proxy or not. curl can.
//      Point it at a local server.
//   2. Playwright's actionability click TIMES OUT on the surprise button: the
//      handler blocks the main thread for ~120 ms and the canvas runs a rAF
//      loop, so the element never reads as "stable". Dispatch the event
//      in-page instead. A timeout here is not a broken button.
//
// And one measurement trap: do NOT grep the issues panel for words like "does
// not fit". The builder deliberately SHOWS incompatible options with their
// reason (feedback #56), so that text is expected on a perfectly valid build.
// Ask `checkBuild()` instead — that is the difference between an error and a
// note, and grepping conflated them.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://127.0.0.1:8099";
const PRESSES = Number(process.env.PRESSES || 60);

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`${BASE}/watch/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const layout = await page.evaluate(() => {
  const top = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; };
  const details = [...document.querySelectorAll("details")];
  return {
    specsTop: top("specs"), pickerTop: top("picker"), sourcingTop: top("sourcing"),
    detailsTotal: details.length,
    detailsOpen: details.filter((d) => d.open).length,
    warningSummaries: details.filter((d) => /⚠/.test(d.querySelector("summary")?.textContent || "")).length,
  };
});

const surprise = await page.evaluate(async (n) => {
  const core = await import("/js/watch-core.js");
  const el = document.getElementById("b-random");
  const movements = new Set(); const cases = new Set();
  let hardErrors = 0, warned = 0; const bad = [];
  for (let i = 0; i < n; i++) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));
    const build = core.normalizeBuild(core.decodeBuild(decodeURIComponent(location.hash.slice(1))));
    const verdict = core.checkBuild(build);
    movements.add(build.movement); cases.add(build.case);
    if (!verdict.ok) { hardErrors++; if (bad.length < 3) bad.push(build); }
    else if ((verdict.issues || []).some((x) => x.level === "warning")) warned++;
  }
  return { presses: n, hardErrors, warned, movements: [...movements], cases: cases.size, bad };
}, PRESSES);

console.log(JSON.stringify({ layout, surprise, consoleErrors: errors.length }, null, 2));
for (const e of errors.slice(0, 8)) console.log("  -", e);

// The one assertion that IS feedback #57.
if (surprise.hardErrors > 0) { console.error(`FAIL: ${surprise.hardErrors}/${PRESSES} surprise builds fail the fit check`); process.exit(1); }
console.log(`\nOK: ${PRESSES} presses, 0 invalid builds, ${surprise.movements.length} distinct movements, ${surprise.cases} distinct cases.`);
await browser.close();
