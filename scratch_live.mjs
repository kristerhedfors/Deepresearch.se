import pkg from "/tmp/claude-0/-home-user-Deepresearch-se/f2285302-9977-510b-b47c-1ee36da09f34/scratchpad/node_modules/playwright-core/index.js";
const { chromium } = pkg;
const PROXY = process.env.HTTPS_PROXY;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--ssl-version-max=tls1.2", `--proxy-server=${PROXY}`],
});

async function run(label, { reduced, url }) {
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2,
    ignoreHTTPSErrors: true, reducedMotion: reduced ? "reduce" : "no-preference",
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e)=>errs.push("GOTO: "+e.message));
  // let the intro run; canvas is added synchronously-ish after module import
  await page.waitForTimeout(1600);
  const hasCanvas = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find(x => x.style.position === "fixed" && +x.style.zIndex >= 30);
    return !!c;
  });
  await page.screenshot({ path: `/home/user/Deepresearch.se/scratch_live_${label}.png` });
  console.log(`[${label}] intro canvas present: ${hasCanvas}${errs.length ? " | " + errs.slice(0,3).join(" ; ") : ""}`);
  await ctx.close();
}

await run("1-normal", { reduced: false, url: "https://deepresearch.se/cure" });
await run("2-reduced", { reduced: true, url: "https://deepresearch.se/cure" });
await run("3-reduced-anim", { reduced: true, url: "https://deepresearch.se/cure?anim=1" });
await browser.close();
