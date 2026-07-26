// The landing page at `/` (public/welcome/index.html) — the two surfaces that
// only exist once a browser has parsed the page's inline modules, so there is
// nothing for the Node unit runner to drive:
//
//   * the FIRST-VISIT OVERLAY, which must introduce the site (name, then
//     tagline) BEFORE it contrasts what the site does and doesn't do — the
//     overlay opens over a page nobody has read yet, so a does/doesn't with no
//     subject lands on nothing (feedback #32);
//   * the compact FEATURE-FOCUS card under the promo video, whose whole point
//     is turning an individual feature's graph on and off.
//
// Both live in the free "mocked" project: /welcome/ is the signed-out front
// door and /pulse/timeline.json is on the public allowlist, so nothing here
// touches /api/chat. `src/landing.test.js` pins the STRUCTURE (order, the
// shared core, the fail-soft hide); this pins the BEHAVIOUR.

import { expect, test } from "@playwright/test";

const PATH = "/welcome/";
const curves = (page) => page.locator("#focuschart .series-line");
const chipsOn = (page) => page.locator('#fclegend .fcchip[aria-pressed="true"]');

// The overlay is shown once per device (localStorage dr_welcome_seen) and the
// ghost mascot that follows it swallows the next click anywhere on the page —
// so every card test dismisses both before touching anything.
async function openPastIntro(page) {
  await page.goto(PATH);
  await page.locator("#wintro").waitFor({ state: "visible" });
  await page.locator("#wintrook").click();
  await page.locator("#wintro").waitFor({ state: "hidden" });
  await page.locator("#focuscard").waitFor({ state: "visible" });
  await page.locator("#focuschart svg").waitFor();
  // Retire the mascot bubble if it has already danced in.
  await page.evaluate(() => {
    const m = document.getElementById("mascot"), b = document.getElementById("mbubble");
    if (m) m.hidden = true;
    if (b) b.hidden = true;
  });
}

test("the overlay introduces the site before contrasting what it does", async ({ page }) => {
  await page.goto(PATH);
  const card = page.locator("#wintro .wcard");
  await expect(card).toBeVisible();

  await expect(page.locator("#wintro .wname")).toHaveText("DeepResearch.se");
  await expect(page.locator("#wintro .wlede")).toContainText("deep-research AI assistant");

  // Order on screen, not merely in the markup.
  const name = await page.locator("#wintro .wname").boundingBox();
  const lede = await page.locator("#wintro .wlede").boundingBox();
  const grid = await page.locator("#wintro .dodont").boundingBox();
  expect(name.y).toBeLessThan(lede.y);
  expect(lede.y).toBeLessThan(grid.y);

  // Short enough to read at a glance — it is a doorway, not the page.
  expect(await page.locator("#wintro .dodont li").count()).toBeLessThanOrEqual(6);
  // Exact — "It does" is a prefix of "It doesn't".
  await expect(page.locator("#wintro").getByRole("heading", { name: "It does", exact: true })).toBeVisible();
  await expect(page.locator("#wintro").getByRole("heading", { name: "It doesn't", exact: true })).toBeVisible();
});

test("the overlay fits a phone without its own scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PATH);
  const card = page.locator("#wintro .wcard");
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("\"Got it\" dismisses the overlay and does not bring it back", async ({ page }) => {
  await page.goto(PATH);
  await page.locator("#wintrook").click();
  await expect(page.locator("#wintro")).toBeHidden();
  await page.reload();
  await expect(page.locator("#wintro")).toBeHidden();
});

test("the feature-focus card sits under the video, high on the page", async ({ page }) => {
  await openPastIntro(page);
  const video = await page.locator("video").boundingBox();
  const card = await page.locator("#focuscard").boundingBox();
  const purpose = await page.locator('h2:text("What this project is for")').boundingBox();
  expect(card.y).toBeGreaterThan(video.y);
  expect(card.y).toBeLessThan(purpose.y);
});

test("it opens on the busiest six curves, with the rest one tap away", async ({ page }) => {
  await openPastIntro(page);
  await expect(curves(page)).toHaveCount(6);
  await expect(chipsOn(page)).toHaveCount(6);

  const total = await page.locator("#fclegend .fcchip").count();
  expect(total).toBeGreaterThan(12);
  expect(await page.locator("#fclegend .fcchip:visible").count()).toBe(12);

  await page.locator("#fcMore").click();
  expect(await page.locator("#fclegend .fcchip:visible").count()).toBe(total);
  await page.locator("#fcMore").click();
  expect(await page.locator("#fclegend .fcchip:visible").count()).toBe(12);
});

test("tapping a feature turns its graph on and off", async ({ page }) => {
  await openPastIntro(page);

  // Pin each chip by its subject key — the aria-pressed sets change under a
  // click, so an [aria-pressed=…].first() locator re-resolves to another chip.
  const onKey = await chipsOn(page).first().getAttribute("data-k");
  const onChip = page.locator(`#fclegend .fcchip[data-k="${onKey}"]`);
  await onChip.click();
  await expect(curves(page)).toHaveCount(5);
  await expect(onChip).toHaveAttribute("aria-pressed", "false");

  await onChip.click();
  await expect(curves(page)).toHaveCount(6);
  await expect(onChip).toHaveAttribute("aria-pressed", "true");

  const offKey = await page.locator('#fclegend .fcchip[aria-pressed="false"]:visible').first().getAttribute("data-k");
  await page.locator(`#fclegend .fcchip[data-k="${offKey}"]`).click();
  await expect(curves(page)).toHaveCount(7);
});

test("Busiest 6 / All / None reset the whole set", async ({ page }) => {
  await openPastIntro(page);
  const total = await page.locator("#fclegend .fcchip").count();

  await page.locator("#fcNone").click();
  await expect(curves(page)).toHaveCount(0);
  await expect(page.locator("#focuschart .empty-note")).toBeVisible();

  await page.locator("#fcAll").click();
  await expect(curves(page)).toHaveCount(total);
  // Nothing may be ON behind the fold — the strip is the only state readout.
  expect(await page.locator("#fclegend .fcchip:visible").count()).toBe(total);

  await page.locator("#fcTop").click();
  await expect(curves(page)).toHaveCount(6);
});

test("the card removes itself when the dataset cannot be read", async ({ page }) => {
  // A broken chart on the front door is worse than no chart.
  await page.route("**/pulse/timeline.json", (route) => route.fulfill({ status: 500, body: "nope" }));
  await page.goto(PATH);
  await page.locator("#wintrook").click();
  await page.waitForTimeout(800);
  await expect(page.locator("#focuscard")).toBeHidden();
  // …and the rest of the front door is unharmed.
  await expect(page.locator('h2:text("What this project is for")')).toBeVisible();
  await expect(page.locator("video")).toBeVisible();
});

test("a coarse pointer gets 44px chips", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await openPastIntro(page);
  const box = await page.locator("#fclegend .fcchip").first().boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await ctx.close();
});
