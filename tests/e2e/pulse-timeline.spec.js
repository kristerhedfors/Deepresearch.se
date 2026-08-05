// The Feature focus timeline's CURVE PICKER (public/pulse/timeline.html).
//
// The page is a self-contained static asset with no server code and no build
// step, so there is nothing for the Node unit runner to import — its logic
// only exists once a browser has parsed the inline module. That puts it here,
// in the free "mocked" project: /pulse/ is on the public (no-auth) allowlist
// in src/assets.js, so these run without touching /api/chat at all.
//
// What is guarded is the interaction contract, not the pixels: a tap chooses
// a curve, a hold isolates one, a drag never selects, the chips stay tappable
// while the chart is being panned (they used to be re-rendered on every frame
// of a gesture), and the choice survives a reload.

import { expect, test } from "@playwright/test";

const PATH = "/pulse/timeline.html";
const chips = (page) => page.locator(".legchip");
const pressedCount = (page) =>
  page.locator('.legchip[aria-pressed="true"]').count();

async function open(page) {
  await page.goto(PATH);
  await page.locator(".legchip").first().waitFor();
  await page.locator("#mainsvg").waitFor();
}

// A real long-press: Chrome/Android kills a setTimeout timer at the
// long-press threshold and fires contextmenu instead, so the page listens for
// BOTH (UX-10's event-path trap). Driving pointerdown → wait → pointerup +
// click exercises the timer path and the click-swallowing together.
async function hold(page, key) {
  await page.evaluate((k) => {
    document.querySelector(`.legchip[data-k="${k}"]`)
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  }, key);
  await page.waitForTimeout(650);
  await page.evaluate((k) => {
    const el = document.querySelector(`.legchip[data-k="${k}"]`);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, key);
  await page.waitForTimeout(150);
}

test("the picker opens on the busiest six and says so", async ({ page }) => {
  await open(page);
  const total = await chips(page).count();
  expect(total).toBeGreaterThan(6);
  expect(await pressedCount(page)).toBe(6);
  await expect(page.locator("#pickCount")).toHaveText(`6 of ${total} shown`);
});

test("tapping a subject adds and removes its curve", async ({ page }) => {
  await open(page);
  const off = page.locator('.legchip[aria-pressed="false"]').first();
  const key = await off.getAttribute("data-k");
  const chip = page.locator(`.legchip[data-k="${key}"]`);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip.locator(".mk")).toHaveText("✓");
  expect(await pressedCount(page)).toBe(7);
  await expect(page.locator(`.series-hit[data-k="${key}"]`)).toHaveCount(1);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(chip.locator(".mk")).toHaveText("○");
  expect(await pressedCount(page)).toBe(6);
  await expect(page.locator(`.series-hit[data-k="${key}"]`)).toHaveCount(0);
});

test("holding a subject shows only that curve; holding again brings the rest back", async ({ page }) => {
  await open(page);
  const key = await page.locator('.legchip[aria-pressed="true"]').first().getAttribute("data-k");

  await hold(page, key);
  expect(await pressedCount(page)).toBe(1);
  await expect(page.locator(`.legchip[data-k="${key}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pickCount")).toContainText("only ");

  await hold(page, key);
  expect(await pressedCount(page)).toBe(6);
  await expect(page.locator("#pickCount")).toContainText("of");
});

test("clicking a curve in the chart isolates it; dragging to pan selects nothing", async ({ page }) => {
  await open(page);
  // Click a point ON the curve, sampled from the path's own geometry. The
  // bounding box CENTRE is not a point on the path — for a curve that dips in
  // the middle it is empty plot — so aiming there passes or fails on the shape
  // of whatever the dataset currently holds. It went red on a routine
  // `npm run pulse:timeline` refresh, with nothing wrong but the data.
  const point = await page.locator(".series-hit").first().evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() / 2);
    const { x, y } = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
    return { x, y };
  });
  await page.mouse.click(point.x, point.y);
  expect(await pressedCount(page)).toBe(1);

  await page.locator("#legTop").click();
  expect(await pressedCount(page)).toBe(6);

  const plot = await page.locator("#mainsvg").boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.6, plot.y + plot.height / 2);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height / 2, { steps: 15 });
  await page.mouse.up();
  expect(await pressedCount(page)).toBe(6);
});

test("Top 6 / All / None / Invert reset the whole set", async ({ page }) => {
  await open(page);
  const total = await chips(page).count();

  await page.locator("#legAll").click();
  expect(await pressedCount(page)).toBe(total);
  await page.locator("#legInvert").click();
  expect(await pressedCount(page)).toBe(0);
  await page.locator("#legNone").click();
  expect(await pressedCount(page)).toBe(0);
  await page.locator("#legTop").click();
  expect(await pressedCount(page)).toBe(6);
});

test("the chosen curves survive a reload", async ({ page }) => {
  await open(page);
  await page.locator('.legchip[aria-pressed="false"]').first().click();
  await page.locator('.legchip[aria-pressed="false"]').first().click();
  const chosen = await page.locator('.legchip[aria-pressed="true"]')
    .evaluateAll((els) => els.map((e) => e.dataset.k).sort());
  expect(chosen).toHaveLength(8);

  await page.reload();
  await page.locator(".legchip").first().waitFor();
  const after = await page.locator('.legchip[aria-pressed="true"]')
    .evaluateAll((els) => els.map((e) => e.dataset.k).sort());
  expect(after).toEqual(chosen);
});

test("the chips stay tappable while the chart is being driven", async ({ page }) => {
  await open(page);
  // Pan hard, then immediately tap a chip. The picker used to be rebuilt from
  // innerHTML inside every redraw, so a chip could be destroyed under the
  // pointer mid-gesture.
  const plot = await page.locator("#mainsvg").boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.7, plot.y + plot.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) {
    await page.mouse.move(plot.x + plot.width * 0.7 - i * 8, plot.y + plot.height / 2);
  }
  await page.mouse.up();

  const off = page.locator('.legchip[aria-pressed="false"]').first();
  const key = await off.getAttribute("data-k");
  await off.click();
  await expect(page.locator(`.legchip[data-k="${key}"]`)).toHaveAttribute("aria-pressed", "true");
});

test("a coarse pointer gets 44px tap targets", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await open(page);
  const box = await chips(page).first().boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await ctx.close();
});
