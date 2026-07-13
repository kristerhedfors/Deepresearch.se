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

// The Settings sub-view (one level below the account summary): there is NO
// cloud-storage knob anymore — Se/rver always stores in the cloud — so the
// panel opens cleanly and shows the remaining knobs (Shodan, Maps) but no
// "Store history in the cloud" row.
test("settings panel: no cloud-storage knob (Se/rver always stores in the cloud)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const json = (body) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await page.route("**/api/settings", (route) =>
    route.fulfill(json({ server_history: true, shodan_mcp: false, google_maps: false, available: { storage: true, rag: true, shodan: true, google_maps: true } })),
  );
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

  await openApp(page, { webSearch: false, budgetS: 15 });
  await page.click("#accountbtn");
  await page.click("#settingsbtn");
  await expect(page.locator("#account-body")).toContainText("Shodan host intelligence");
  await expect(page.locator("#account-body")).not.toContainText("Store history in the cloud");
  await expect(page.locator("#cloudknob")).toHaveCount(0);
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
