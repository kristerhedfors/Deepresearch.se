import pkg from "/tmp/claude-0/-home-user-Deepresearch-se/f2285302-9977-510b-b47c-1ee36da09f34/scratchpad/node_modules/playwright-core/index.js";
const { chromium } = pkg;
const PROXY = process.env.HTTPS_PROXY;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--ssl-version-max=tls1.2", `--proxy-server=${PROXY}`],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 640 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const bad = [], umb = [];
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400) bad.push(r.status() + " " + u);
  if (/umbrella\.js|\/api\/anim/.test(u)) umb.push(r.status() + " " + u);
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("https://deepresearch.se/cure", { waitUntil: "domcontentloaded", timeout: 30000 });
// poll for the fixed intro canvas every 200ms up to 4s
let seenCanvas = false;
for (let i = 0; i < 20; i++) {
  const has = await page.evaluate(() => [...document.querySelectorAll("canvas")].some(x => getComputedStyle(x).position === "fixed" && +x.style.zIndex >= 30));
  if (has) { seenCanvas = true; console.log("CANVAS appeared at ~" + (i*200) + "ms"); break; }
  await page.waitForTimeout(200);
}
const state = await page.evaluate(() => ({
  seenFlag: (() => { try { return localStorage.getItem("dr_umbrella_seen"); } catch { return "err"; } })(),
  path: location.pathname + location.search,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  introHidden: document.getElementById("intro")?.hidden,
}));
console.log("canvas ever seen:", seenCanvas);
console.log("state:", JSON.stringify(state));
console.log("umbrella/anim requests:", umb.length ? umb.join(" | ") : "(NONE requested!)");
console.log("4xx/5xx:", bad.length ? bad.slice(0,6).join(" | ") : "none");
await browser.close();
