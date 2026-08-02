// UI regression coverage added alongside a refactor of stream.js,
// activity.js, and the new shared public/js/notifications.js (see CLAUDE.md
// / the repo history for context): these areas previously had no dedicated
// e2e coverage. All mocked — free, fast, parallel.
import { expect, test } from "@playwright/test";
import { mockChat, openApp, send, waitForDone } from "./helpers.js";

test("a normal mocked reply completes and the activity bar collapses cleanly", async ({ page }) => {
  await openApp(page, { webSearch: false, budgetS: 15 });
  await mockChat(page, "This is a complete mock answer.");
  await send(page, "hi there");
  const turn = await waitForDone(page);
  await expect(turn).toContainText("This is a complete mock answer.");
});

test("a search step resolves to a checkmark and an expandable source list", async ({ page }) => {
  await openApp(page, { webSearch: true, budgetS: 60 });
  const events = [
    { status: { type: "step_start", id: "plan", label: "Analyzing request…" } },
    { status: { type: "step_done", id: "plan", label: "Planned 1 search angle", details: ["test query"] } },
    { status: { type: "search_start", round: 1, query: "test query" } },
    {
      status: {
        type: "search_done", round: 1, query: "test query", results: 2, duration_ms: 120,
        sources: [{ title: "Example Source", url: "https://example.com" }],
      },
    },
    { status: { type: "step_start", id: "synth", label: "Writing report…" } },
    { choices: [{ delta: { content: "The answer." } }] },
    { status: { type: "step_done", id: "synth", label: "Report drafted" } },
    { status: { type: "done", model: "mock-model", rounds: 1, searches: 1, duration_ms: 200, prompt_tokens: 5, completion_tokens: 5 } },
  ];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body }),
  );
  await send(page, "search something");
  const turn = await waitForDone(page);
  await turn.locator(".activity > summary").click(); // collapseActivity() folds it closed on completion
  // Wording since 2026-07-08: "<service> “query” · N results · X ms" (the
  // service falls back to "Web search" when the event carries no `service`).
  const searchStep = turn.locator(".step.finished.expandable", { hasText: "Web search" });
  await expect(searchStep).toBeVisible();
  await expect(searchStep.locator(".check")).toHaveText("✓");
  await searchStep.locator("summary").click();
  await expect(searchStep.locator("a", { hasText: "Example Source" })).toBeVisible();
});

test("admin notification center renders without a JS error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/admin");
  await expect(page.locator("#alerts-sec")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#alerts")).not.toHaveText("", { timeout: 10_000 });
  expect(errors, "no uncaught JS errors on /admin").toEqual([]);
});

// The Settings sub-view (one level below the account summary): cloud
// storage is IMPLICIT on the signed-in tier (no switch — 2026-07-16
// directive), so the panel renders a DISCLOSURE row ("always on") instead
// of a knob, and no PUT can carry a server_history flag. The mocks are
// registered before openApp so the boot-time reconcile (which runs when
// storage is available) exercises the same endpoints.
test("settings panel: cloud storage renders as an always-on disclosure row", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const puts = [];
  const json = (body) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await page.route("**/api/settings", (route) => {
    if (route.request().method() === "PUT") puts.push(route.request().postDataJSON());
    return route.fulfill(json({ available: { storage: true, rag: true } }));
  });
  await page.route("**/api/convos", (route) => route.fulfill(json({ conversations: [] })));
  await page.route("**/api/files", (route) => route.fulfill(json({ files: [] })));
  await page.route("**/api/rag/docs", (route) => route.fulfill(json({ docs: [] })));
  // The panel only offers settings to a signed-in account (the break-glass
  // identity the suite authenticates as has none), so mock a regular user.
  const win = { budget_pct: 0, searches: 0, searches_limit: 0, reset: null };
  await page.route("**/api/me", (route) =>
    route.fulfill(json({
      id: 1, email: "user@example.com", name: "Test User", role: "user",
      unlimited: false, enforced: true, db_configured: true,
      windows: { h5: win, day: win, week: win, month: win },
      notifications: { unread_messages: 0, total: 0 },
    })),
  );

  // This spec mocks /api/settings itself, so it owns the knob pinning
  // (its mock omits bash_lite_mcp/chat_mode = sandbox off, Deep Research).
  await openApp(page, { webSearch: false, budgetS: 15, pinSettings: false });
  await page.click("#accountbtn");
  await page.click("#settingsbtn");
  await expect(page.locator("#account-body")).toContainText("History is stored in the cloud");
  await expect(page.locator("#cloudrow")).toContainText("always on");
  // No switch to flip — the row is informational, and nothing PUT anything.
  await expect(page.locator("#cloudknob")).toHaveCount(0);
  expect(puts).toEqual([]);
  expect(errors, "no uncaught JS errors in the settings panel").toEqual([]);
});

test("account message center renders without a JS error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openApp(page, { webSearch: false, budgetS: 15 });
  await page.click("#accountbtn");
  await page.click("#messagesbtn");
  await expect(page.locator("#account-body")).toContainText(/Message center/, { timeout: 10_000 });
  expect(errors, "no uncaught JS errors in the message center").toEqual([]);
});

// AGENT SWITCHING leaves exactly one theme on the page (2026-08-02).
//
// The unit suite pins the class algebra (chat-mode.test.js walks every ordered
// pair against a stubbed classList); this is the same claim in a real browser,
// where the OTHER half of the mechanism lives: index.html's parse-time script
// applies a class BEFORE any module loads, so a mode the switcher does not
// manage gets stuck on the root and cannot be cleared. That is how Deep Science
// shipped — `sci-mode` painted from the cache on boot, never toggled after —
// and a browser that had booted in Science showed two header tags at once with
// the palette, the composer pane and the dropdown text coming from different
// themes. Booting IN Science and switching away is therefore the case that
// matters, and it is exactly what a stubbed classList cannot reproduce.
const MODE_ROOT_CLASS = {
  normal: null,
  science: "sci-mode",
  introspection: "dev-mode",
  sdk: "sdk-mode",
  orchestrator: "orch-mode",
  outrospection: "outro-mode",
  models: "models-mode",
};
const ALL_ROOT_CLASSES = Object.values(MODE_ROOT_CLASS).filter(Boolean);
const MODE_TAGS = ".introspection-tag,.sdk-tag,.orch-tag,.outro-tag,.models-tag,.sci-tag";

async function themeState(page) {
  return page.evaluate(
    (sel) => ({
      classes: [...document.documentElement.classList],
      tags: [...document.querySelectorAll(sel)]
        .filter((e) => getComputedStyle(e).display !== "none")
        .map((e) => e.textContent.trim()),
    }),
    MODE_TAGS,
  );
}

// app.js adopts the account's stored mode when loadSettings() resolves — once,
// at boot, and NOT awaited, so `openApp` can return (on #form) while that
// promise is still in flight. Switching before it lands means the adoption
// arrives afterwards and re-applies the mode the test just switched away from.
// Wait for the settings GET, then let its .then() chain run.
async function bootSettled(page, open) {
  const settled = page
    .waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/settings", {
      timeout: 20_000,
    })
    .catch(() => null); // cached or already answered — the settle below still covers it
  await open();
  await settled;
  await page.waitForTimeout(300);
}

for (const from of Object.keys(MODE_ROOT_CLASS)) {
  test(`switching out of ${from} carries no theme class into the next agent`, async ({ page }) => {
    await bootSettled(page, () => openApp(page, { webSearch: false, budgetS: 15, chatMode: from }));
    for (const to of Object.keys(MODE_ROOT_CLASS)) {
      await page.selectOption("#modesel", to);
      const { classes, tags } = await themeState(page);
      const want = MODE_ROOT_CLASS[to];
      expect(
        classes.filter((c) => ALL_ROOT_CLASSES.includes(c)),
        `${from} → ${to} must leave exactly ${want || "no theme class"} on <html>`,
      ).toEqual(want ? [want] : []);
      // The header names ONE agent. Two tags is the visible face of a stuck class.
      expect(tags.length, `${from} → ${to} shows ${tags.length} mode tags: ${tags.join(", ")}`).toBeLessThan(2);
    }
  });
}

// The one DARK theme: Deep Science's near-white --text over the composer's
// default white glass measured 2.58:1 on production (tests/theme-contrast.mjs),
// which is the "white text on white background in the dropdowns" report. The
// declared fill is not the thing to assert — sci-mode's chips are still white,
// at .08 rather than .35 — so this composites each element against everything
// painted behind it and checks the WCAG ratio the reader actually gets.
test("Deep Science's composer text clears AA over what is painted behind it", async ({ page }) => {
  await bootSettled(page, () => openApp(page, { webSearch: false, budgetS: 15, chatMode: "science" }));
  await expect(page.locator("html")).toHaveClass(/sci-mode/);
  const ratios = await page.evaluate((sels) => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (f, b) => ({
      r: f.r * f.a + b.r * (1 - f.a),
      g: f.g * f.a + b.g * (1 - f.a),
      b: f.b * f.a + b.b * (1 - f.a),
      a: 1,
    });
    const lum = (c) => {
      const f = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    return sels.map((sel) => {
      const el = document.querySelector(sel);
      const stack = [];
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) stack.push(c);
      }
      // html paints `background: var(--bg)`, so its COMPUTED backgroundColor is
      // the field as an rgb() — the custom property itself is a hex string.
      let bg = { ...parse(getComputedStyle(document.documentElement).backgroundColor), a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { sel, ratio: (hi + 0.05) / (lo + 0.05) };
    });
  }, ["#modesel", "#model", "#input"]);
  for (const { sel, ratio } of ratios) {
    expect(ratio, `${sel} reads at ${ratio.toFixed(2)}:1 in Deep Science`).toBeGreaterThanOrEqual(4.5);
  }
});
