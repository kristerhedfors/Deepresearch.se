// SECURE WORKSPACES end-to-end, against the LIVE site — the reproduction the
// owner asked for in try-it point #10 ("the link we open cannot use its
// shared llm provider keys … Secure research space rejected the request
// (502)"): a Se/rver-minted workspace link carrying borrowed proxy grants
// must open in a fresh browser and produce a real answer on the borrowed
// LLM. The 2026-07-15 root cause was NOT the workspace mechanism: Berget's
// catalog listed a model in maintenance (zai-org/GLM-5.2, status.up:false),
// it sorted newest-first, became the keyless dropdown DEFAULT, and the first
// send hit "rejected the request (502)". The fix filters unavailable entries
// client-side (drc-providers.js modelAvailable); this test drives the WHOLE
// flow — mint → seal → unlock → borrowed completion on the DEFAULT model —
// so a recurrence (or any regression in the workspace path) fails it.
//
// HARNESS NOTE: this file CLEARS the suite's global `extraHTTPHeaders` Basic
// auth for the page (test.use below). /cure and /api/proxy/* are PUBLIC (no
// identity), and the borrowed-LLM call authorizes with a `Bearer <proxyToken>`
// header the client sets itself; the global Basic header overrides that and
// the proxy 403s ("Invalid or expired API proxy token") — a false failure
// that masks the real 502/answer. The admin mint/revoke (which DO need Basic
// auth) run on a dedicated APIRequestContext with an explicit header.

import { expect, request as apiRequest, test } from "@playwright/test";
import { openBundle } from "../../public/js/proxy-bundle.js";
import { buildWorkspacePayload, sealWorkspace } from "../../public/js/workspace-core.js";

const ANSWER_TIMEOUT = 240_000;
const BASE = process.env.BASE_URL || "https://deepresearch.se";
const AUTH = "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64");
const PROXY = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

// The page must NOT carry the global Basic header (see the harness note) so
// the client's own Bearer proxy token reaches /api/proxy/llm intact.
test.use({ extraHTTPHeaders: {} });

test("@live workspace link → unlock → borrowed LLM answers on the default model", async ({ page }) => {
  // Admin API context (explicit Basic auth) — mint + revoke only.
  const admin = await apiRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { authorization: AUTH },
    ignoreHTTPSErrors: true,
    ...(PROXY ? { proxy: PROXY } : {}),
  });

  // 1. MINT a secure-research-space bundle and open it locally — exactly what
  //    the Se/rver share row does client-side.
  const mint = await admin.post("/api/admin/proxy", { data: { label: "e2e-workspace-live" } });
  expect(mint.ok()).toBe(true);
  const bundle = await mint.json();
  const opened = await openBundle(bundle.blob, bundle.key);
  expect(opened && Array.isArray(opened.grants)).toBeTruthy();
  const grants = opened.grants.filter((g) => g.svc === "web" || g.svc === "api");
  expect(grants.some((g) => g.svc === "api")).toBe(true);

  try {
    // 2. SEAL the workspace link (the pure core, same call the UI makes).
    const password = "E2eWs" + Math.random().toString(36).slice(2, 10);
    const payload = buildWorkspacePayload({}, { grants: { ws: null, proxy: grants }, name: "E2E workspace" });
    const blob = await sealWorkspace(payload, password);

    // 3. OPEN the link in the browser: the unlock pane must appear.
    await page.goto("/cure/workspace#w=" + blob);
    await expect(page.locator("#wkopen")).toBeVisible();
    await page.fill("#wkpassword", password);
    await page.click("#wkunlock");

    // 4. The workspace applies (status names it) and the borrowed space
    //    connects: the model dropdown holds proxy models with a proxy option
    //    SELECTED by default (keyless session → the group is first).
    await expect(page.locator("#workstatus")).toContainText("Secure workspace opened", { timeout: 60_000 });
    await expect(page.locator("#model option[value^='proxy::']").first()).toBeAttached({ timeout: 30_000 });
    const defaultPick = await page.locator("#model").inputValue();
    expect(defaultPick.startsWith("proxy::")).toBe(true);

    // 5. SEND on the DEFAULT model, research off (the one-pass direct path —
    //    the exact first-send a link recipient makes). The reply must be a
    //    real completion, not the error line of point #10.
    if (await page.locator("#websearch").isChecked()) await page.click("#searchtoggle");
    await expect(page.locator("#websearch")).not.toBeChecked();
    await page.fill("#input", "Reply with exactly: WORKSPACE-E2E-OK");
    await page.click("#send");

    const answer = page.locator("#chat .msg.assistant").last();
    await expect(answer).toContainText("WORKSPACE-E2E-OK", { timeout: ANSWER_TIMEOUT });
    await expect(page.locator("#workstatus")).not.toContainText("rejected the request");
  } finally {
    // 6. REVOKE the minted bundle — the test never leaves a live allowance.
    await admin.delete("/api/admin/proxy/" + bundle.bundleId).catch(() => {});
    await admin.dispose();
  }
});
