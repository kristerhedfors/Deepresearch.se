// Does setScene(id) actually produce that scene's stated background?
import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto("http://127.0.0.1:8124/watch/", { waitUntil: "load" });
await page.waitForTimeout(3000);

const out = await page.evaluate(async () => {
  const mats = await import("/js/watch-materials.js");
  const c = document.querySelector("canvas");
  const res = [];
  // Sample the top-left corner, which is always background.
  const sample = () => {
    const t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    t.getContext("2d").drawImage(c, 0, 0);
    const d = t.getContext("2d").getImageData(4, 4, 1, 1).data;
    return [d[0], d[1], d[2]].map((v) => +(v / 255).toFixed(3));
  };
  res.push(["as-loaded", sample()]);
  const stage = window.__watchStage || null;
  for (const s of mats.SCENES) {
    res.push([s.id + " (stated bg)", (s.bg || []).map((v) => +v.toFixed(3))]);
  }
  return { res, hasStage: !!stage };
});
console.log("sampled/stated:");
for (const [k, v] of out.res) console.log("  " + k.padEnd(26), JSON.stringify(v));

// Now drive the real picker, which is the path a user takes.
for (const id of ["studio-dark", "studio-grey", "studio-light"]) {
  await page.selectOption("#scene", id).catch(() => {});
  await page.waitForTimeout(1400);
  const px = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    t.getContext("2d").drawImage(c, 0, 0);
    const d = t.getContext("2d").getImageData(4, 4, 1, 1).data;
    return [d[0], d[1], d[2]].map((v) => +(v / 255).toFixed(3));
  });
  console.log("  picker ->", id.padEnd(16), JSON.stringify(px));
}
await browser.close();
