// The SECURE-RESEARCH-SPACE borrowed session, end to end — the regression
// suite for test point #10 (2026-07-15): a visitor opening a shared
// /cure?rp=…#rk= bundle link got "Secure research space rejected the request
// (502)" on every send, because Berget's catalog listed a model that was DOWN
// for maintenance (zai-org/GLM-5.2, status.up false), the newest-first sort
// put it FIRST, and the borrowed session defaulted to it.
//
// These tests drive the REAL arrival path — a genuinely sealed bundle in the
// URL (sealed here in Node with the same public/js/proxy-bundle.js the server
// uses), opened and exchanged by the real /cure client — with the server
// endpoints mocked, so the repro is deterministic and free. The @live
// borrowed-session test (live.spec.js) covers the same flow against the real
// mint + Berget.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealBundle } from "../../public/js/proxy-bundle.js";

// The two client modules under test are served from the WORKING TREE (the
// rest of the page comes from the live site), so this regression suite runs
// — and must pass — BEFORE a deploy, not only after.
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const serveLocal = (rel) => (route) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/javascript" },
    body: fs.readFileSync(path.join(PUB, rel), "utf8"),
  });

// A Berget-shaped /models catalog with the incident's exact poison: the model
// that sorts FIRST (newest-first) is marked down for maintenance.
const CATALOG = {
  data: [
    { id: "zai-org/GLM-5.2", model_type: "text", status: { up: false }, lifecycle_state: "maintenance" },
    { id: "zai-org/GLM-4.7-FP8", model_type: "text", status: { up: true }, lifecycle_state: "stable" },
    { id: "moonshotai/Kimi-K2.6", model_type: "text", status: { up: true }, lifecycle_state: "stable" },
    { id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", model_type: "text", status: { up: true }, lifecycle_state: "stable" },
  ],
};

// Open /cure carrying a freshly sealed bundle, with the exchange + catalog
// endpoints mocked. Returns after the page has connected the borrowed space.
async function openBorrowedCure(page) {
  await page.route("**/js/drc-providers.js", serveLocal("js/drc-providers.js"));
  await page.route("**/js/drc-research.js", serveLocal("js/drc-research.js"));
  // A granted WEB search must never leave the mock either: empty result,
  // which the client treats fail-soft (offline direct prompt, unchanged).
  await page.route("**/api/proxy/web", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "", items: [], sources: [], resultCount: 0, remaining: null }),
    }),
  );
  const { blob, key } = await sealBundle({
    v: 1,
    bundleId: "e2e-bundle",
    grants: [
      { svc: "web", token: "prg1.e2e-web-grant" },
      { svc: "api", token: "prg1.e2e-api-grant" },
    ],
  });

  await page.route("**/api/proxy/exchange", async (route) => {
    const { token } = route.request().postDataJSON();
    const svc = token.includes("api") ? "api" : "web";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jti: "e2e-" + svc,
        svc,
        quota: 40,
        used: 0,
        remaining: 40,
        expiresAt: Date.now() + 24 * 3600 * 1000,
        proxyToken: "prx1.e2e-" + svc,
      }),
    });
  });
  await page.route("**/api/proxy/llm/models", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CATALOG),
    }),
  );

  // Skip the first-visit umbrella intro + welcome pane so the chat is live.
  await page.addInitScript(() => {
    localStorage.setItem("dr_umbrella_seen_v2", "1");
    localStorage.setItem("dr_secure_intro_seen", "1");
  });
  await page.goto(`/cure?rp=${encodeURIComponent(blob)}#rk=${encodeURIComponent(key)}`);
  await expect(page.locator("#proxybanner")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#proxybanner")).toContainText("Secure research space connected");
}

test("a borrowed session's model dropdown skips catalog models that are DOWN", async ({ page }) => {
  await openBorrowedCure(page);

  const options = await page
    .locator("#model option")
    .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
  // The down model must not be offered at all…
  expect(options).not.toContain("proxy::zai-org/GLM-5.2");
  // …while the up models are, through the borrowed provider.
  expect(options).toContain("proxy::zai-org/GLM-4.7-FP8");
  expect(options).toContain("proxy::mistralai/Mistral-Small-3.2-24B-Instruct-2506");
  // The DEFAULT pick (what the verdict's visitor got burned by) is the newest
  // UP model — not the maintenance one that sorts above it.
  expect(await page.locator("#model").inputValue()).toBe("proxy::zai-org/GLM-4.7-FP8");
});

test("a proxied 502 shows the upstream reason, not just the status code", async ({ page }) => {
  await openBorrowedCure(page);
  // The upstream failure the incident produced, verbatim from src/proxy.js's
  // 502 shape: {error, detail} with Berget's OpenAI-wire error text inside.
  await page.route("**/api/proxy/llm/chat/completions", (route) =>
    route.fulfill({
      status: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "The upstream model rejected the request.",
        detail:
          '{"error":{"message":"Model \'zai-org/GLM-5.2\' is currently undergoing maintenance and is not available for inference","type":"invalid_request_error","code":null}}',
      }),
    }),
  );

  await page.locator("#websearch").evaluate((el) => {
    el.checked = false; // the styled knob overlay intercepts real clicks
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }); // one direct call, no research fan-out
  await page.fill("#input", "hello");
  await page.click("#send");

  const status = page.locator("#workstatus");
  await expect(status).toContainText("rejected the request (502)", { timeout: 30_000 });
  // The actionable part: the user must see WHY, so they can pick another model.
  await expect(status).toContainText("currently undergoing maintenance");
});

test("a borrowed session completes a chat on the lent API (mocked upstream)", async ({ page }) => {
  await openBorrowedCure(page);
  await page.route("**/api/proxy/llm/chat/completions", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"choices":[{"delta":{"content":"PROXY-OK: borrowed "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"session works."}}]}\n\n' +
        "data: [DONE]\n\n",
    }),
  );

  await page.locator("#websearch").evaluate((el) => {
    el.checked = false; // the styled knob overlay intercepts real clicks
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.fill("#input", "Say PROXY-OK.");
  await page.click("#send");

  await expect(page.locator(".msg.assistant").last()).toContainText("PROXY-OK: borrowed session works.", {
    timeout: 30_000,
  });
  await expect(page.locator("#workstatus")).not.toContainText("rejected the request");
});
