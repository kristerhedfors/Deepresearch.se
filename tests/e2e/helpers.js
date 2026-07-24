// Shared plumbing for the e2e specs: opening the app in a known state,
// attaching fixtures, selecting models, mocking the /api/chat SSE stream,
// and waiting for a turn to finish.

import { expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const fx = (name) => path.join(FIXTURES, name);

// Sentinels baked into the fixtures by make_fixtures.py.
export const SENTINEL = {
  txt: "TXT-SENTINEL-93417",
  md: "MD-SENTINEL-58221",
  pdf: "PDF-SENTINEL-31337",
  docx: "DOCX-SENTINEL-64502",
  bigtxt: "BIGTXT-SENTINEL-77401",
  bigtail: "TAIL-MARKER-99999",
};

// Open the app signed in (Basic Auth rides on every request via the
// context), privacy notice pre-acknowledged, web-search knob and time
// budget in a known state, and dialogs auto-accepted + recorded.
export async function openApp(page, { webSearch = false, budgetS = 15 } = {}) {
  const base = process.env.BASE_URL || "https://deepresearch.se";
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: base }]);
  await page.addInitScript(
    ([ws, budget]) => {
      localStorage.setItem("web_search", ws);
      localStorage.setItem("budget_s", budget);
    },
    [webSearch ? "on" : "off", String(budgetS)],
  );
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    d.accept().catch(() => {});
  });
  await page.goto("/");
  await expect(page.locator("#form")).toBeVisible();
  await expect(page.locator("#privacy")).toBeHidden();
  return { dialogs };
}

// Pick a model from the dropdown. `wantVision` selects the first up
// vision-capable model (needed to attach images without the confirm()
// detour). Returns the selected model id.
export async function selectModel(page, { wantVision = false } = {}) {
  await expect(page.locator("#model")).toBeVisible({ timeout: 20_000 });
  const res = await page.request.get("/api/models");
  expect(res.ok()).toBeTruthy();
  const { models } = await res.json();
  const pick = models.find((m) => m.up !== false && (!wantVision || m.vision));
  expect(pick, wantVision ? "an up vision-capable model must exist" : "an up model must exist").toBeTruthy();
  await page.selectOption("#model", pick.id);
  return pick.id;
}

// Attach fixture files through the real <input type=file> and wait for the
// expected number of pending cards.
export async function attach(page, names, expectedCards) {
  await page.setInputFiles("#file", names.map(fx));
  await expect(page.locator("#pending .att-card")).toHaveCount(expectedCards, { timeout: 30_000 });
}

// Build a minimal-but-faithful /api/chat SSE body: plan step, two text
// deltas, done stats.
export function sseBody(answer, { model = "mock-model", searches = 0 } = {}) {
  const half = Math.ceil(answer.length / 2);
  const events = [
    { status: { type: "step_start", id: "plan", label: "Web search off" } },
    { status: { type: "step_done", id: "plan", label: "Web search off — answering from model knowledge", details: [] } },
    { choices: [{ delta: { content: answer.slice(0, half) } }] },
    { choices: [{ delta: { content: answer.slice(half) } }] },
    {
      status: {
        type: "done", model, rounds: 1, searches,
        duration_ms: 42, prompt_tokens: 10, completion_tokens: 20,
      },
    },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

// Intercept /api/chat, record every request payload, answer from the mock.
export async function mockChat(page, answer = "MOCK ANSWER") {
  const payloads = [];
  await page.route("**/api/chat", async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseBody(answer),
    });
  });
  return payloads;
}

// Mock POST /api/embed (the document-RAG embedding proxy) with a
// deterministic unit vector per text. Equal vectors → equal cosine scores
// → retrieval returns chunks in original order (Array.sort is stable), so
// assertions about which excerpts survive are deterministic.
export async function mockEmbed(page) {
  // Float32Array([1]) → base64
  const UNIT = Buffer.from(new Float32Array([1]).buffer).toString("base64");
  await page.route("**/api/embed", async (route) => {
    const { texts } = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vectors: texts.map(() => UNIT), dims: 1, model: "mock-embed" }),
    });
  });
}

// Mock POST /api/embed as unavailable — exercises the client's fallback:
// a large document degrades to the pre-RAG inline truncation.
export async function mockEmbedFail(page) {
  await page.route("**/api/embed", (route) =>
    route.fulfill({
      status: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Embedding service unavailable." }),
    }),
  );
}

// Record real /api/chat payloads without intercepting them.
export function sniffChat(page) {
  const payloads = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") {
      payloads.push(req.postDataJSON());
    }
  });
  return payloads;
}

export async function send(page, text) {
  await page.fill("#input", text);
  await page.click("#send");
}

// A turn is complete when the `done` stats land in the footer. Returns the
// assistant-turn locator.
export async function waitForDone(page, nth = 0, timeout = 30_000) {
  const turn = page.locator(".msg.assistant").nth(nth);
  await expect(turn.locator(".stats")).not.toHaveText("", { timeout });
  return turn;
}

// Click the turn's PDF button and return the downloaded file's bytes.
export async function downloadReportPdf(page, turn) {
  const btn = turn.locator(".msg-tools button", { hasText: "PDF" });
  const [download] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  await expect(btn).toHaveText("PDF ✓", { timeout: 20_000 });
  const file = await download.path();
  return fs.readFileSync(file);
}

// The JPEG bytes of every image shown in the LAST user bubble (what was
// actually sent to the model, post-downscale).
export async function bubbleImageJpegs(page) {
  const srcs = await page
    .locator(".msg.user")
    .last()
    .locator(".imgs img")
    .evaluateAll((els) => els.map((e) => e.src));
  return srcs.map((src) => {
    expect(src).toMatch(/^data:image\/jpeg;base64,/);
    return Buffer.from(src.split(",")[1], "base64");
  });
}

// Doc-block header the client wraps extracted text in.
export const docHeader = (name, truncated = false) =>
  `--- Attached document: ${name}${truncated ? " (truncated)" : ""} ---`;

// The text carried by a message whose content may be a string or parts.
export function textOfMessage(m) {
  if (typeof m.content === "string") return m.content;
  return m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

export const imagesOfMessage = (m) =>
  Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : [];

// Strip the break-glass `Authorization` header from CROSS-ORIGIN requests
// (2026-07-24).
//
// The live configs authenticate with `extraHTTPHeaders`, which is what makes
// `/` resolve to the signed-in `/rver` app — an unauthenticated `/` just 302s
// to the anonymous `/cure` tier, where `window.__appReady` is never set. But
// Playwright attaches those headers to EVERY request the context makes,
// cross-origin ones included, which has two consequences:
//
//   1. It hands the admin password to third-party hosts.
//   2. It breaks the execution sandbox outright. The CheerpX runtime is loaded
//      with `import("https://cxrtnc.leaningtech.com/…/cx.esm.js")`; with an
//      `authorization` header on it that fetch fails (net::ERR_FAILED), so the
//      VM dies at the "loading CheerpX…" stage every time and the spec silently
//      exercises only the fail-soft fallback. Measured: boot failed at 3.2 s
//      with `Failed to fetch dynamically imported module`.
//
// Stripping the header for any origin that is not the site under test fixes
// both. Verified against the alternative (re-fetching cross-origin responses
// Node-side and re-serving them with CORP headers): both work, this one is
// cheaper since it never leaves the browser's own network path.
//
// Call this on the CONTEXT before navigating, in any spec that boots the
// sandbox or otherwise touches a cross-origin resource.
export async function stripCrossOriginAuth(context, base = process.env.BASE_URL || "https://deepresearch.se") {
  const siteOrigin = new URL(base).origin;
  await context.route(
    (url) => {
      try {
        return new URL(url).origin !== siteOrigin;
      } catch {
        return false;
      }
    },
    async (route) => {
      const headers = { ...route.request().headers() };
      delete headers.authorization;
      delete headers.Authorization;
      await route.continue({ headers });
    },
  );
}
