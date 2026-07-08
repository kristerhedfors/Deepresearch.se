import { chromium, devices } from "@playwright/test";
const AUTH = "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64");
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  ...(process.env.HTTPS_PROXY ? { args: ["--ssl-version-max=tls1.2"], proxy: { server: process.env.HTTPS_PROXY } } : {}),
});
const iphone = devices["iPhone 13"];
const ctx = await browser.newContext({
  ...iphone,
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { authorization: AUTH },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 400)));
page.on("console", (m) => { if (m.type() === "error" && !/beacon|cloudflareinsights/.test(m.text())) console.log("CONSOLE:", m.text().slice(0, 400)); });
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("NAVIGATED:", f.url()); });
await page.goto("https://deepresearch.se/", { waitUntil: "networkidle" });
if (await page.locator("#privacy:visible").count()) await page.locator("#privacy button").first().click();
await page.waitForTimeout(400);

async function send(text) {
  await page.locator("textarea").first().fill(text);
  await page.locator("#send").click();
  console.log("SENT:", text);
}
async function snap(tag) {
  const txt = (await page.locator("body").innerText()).replace(/\n+/g, " | ");
  console.log(tag, txt.slice(0, 140));
}
await send("What is the capital of France?");
await page.waitForTimeout(10000); await snap("q1 t+10s:");
await send("and of Germany?");
await page.waitForTimeout(10000); await snap("q2 t+10s:");
// reload mid-conversation (PWA resume) then follow-up again
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500); await snap("after reload:");
await send("and of Italy?");
await page.waitForTimeout(12000); await snap("q3 t+12s:");
await browser.close();
