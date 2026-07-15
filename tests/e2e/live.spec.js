// Full-stack tests against the LIVE pipeline (real Berget completions;
// the tagged test also runs real Exa searches). Kept few and cheap: short
// prompts, minimum time budget, web search off except where Exa itself is
// under test. The model's exact wording varies, so assertions target
// sentinel echoes and structural UI state, and the project retries once.

import { expect, test } from "@playwright/test";
import {
  attach,
  bubbleImageJpegs,
  docHeader,
  downloadReportPdf,
  openApp,
  selectModel,
  send,
  SENTINEL,
  sniffChat,
  waitForDone,
} from "./helpers.js";

const ANSWER_TIMEOUT = 240_000;

test("@live txt document: parsed text reaches the model, which echoes the sentinel; follow-up sees it too", async ({ page }) => {
  await openApp(page, { webSearch: false });
  const payloads = sniffChat(page);
  await attach(page, ["sample.txt"], 1);
  await send(
    page,
    "The attached document contains a sentinel code of the form TXT-SENTINEL-<digits>. Reply with that exact code and nothing else.",
  );
  const turn = await waitForDone(page, 0, ANSWER_TIMEOUT);

  expect(payloads[0].web_search).toBe(false);
  const sent = payloads[0].messages.at(-1);
  expect(sent.content).toContain(docHeader("sample.txt"));
  expect(sent.content).toContain(SENTINEL.txt);

  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);
  await expect(turn.locator(".content")).toContainText(SENTINEL.txt);
  await expect(turn.locator(".stats")).toContainText("tokens");

  // Follow-up turn: the document text lives in the resent history, so the
  // model can still quote it without re-attaching.
  await send(page, "Repeat that sentinel code once more, exactly, nothing else.");
  const turn2 = await waitForDone(page, 1, ANSWER_TIMEOUT);
  await expect(turn2.locator(".content")).toContainText(SENTINEL.txt);
});

test("@live pdf + docx documents together: model sees both sentinels", async ({ page }) => {
  await openApp(page, { webSearch: false });
  const payloads = sniffChat(page);
  await attach(page, ["sample.pdf", "sample.docx"], 2);
  await send(
    page,
    "Each attached document contains one sentinel code (PDF-SENTINEL-<digits>, DOCX-SENTINEL-<digits>). Reply with both codes, nothing else.",
  );
  const turn = await waitForDone(page, 0, ANSWER_TIMEOUT);

  const sent = payloads[0].messages.at(-1);
  expect(sent.content).toContain(SENTINEL.pdf);
  expect(sent.content).toContain(SENTINEL.docx);
  await expect(turn.locator(".content")).toContainText(SENTINEL.pdf);
  await expect(turn.locator(".content")).toContainText(SENTINEL.docx);
});

test("@live image input: vision model reads it and the PDF report embeds it", async ({ page }) => {
  await openApp(page, { webSearch: false });
  await selectModel(page, { wantVision: true });
  await attach(page, ["red.png"], 1);
  await send(page, "In one word: what color fills the attached image?");
  const turn = await waitForDone(page, 0, ANSWER_TIMEOUT);

  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);
  await expect(turn.locator(".content")).toContainText(/red/i);

  const [jpeg] = await bubbleImageJpegs(page);
  const pdf = await downloadReportPdf(page, turn);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdf.includes(jpeg), "live report must embed the input image").toBeTruthy();
  const raw = pdf.toString("latin1");
  expect(raw).toContain("In one word: what color fills the attached image?");
  expect(raw).toContain("DeepResearch.se");
});

test("@live web search ON with doc + image: Exa searches run and the answer arrives", async ({ page }) => {
  await openApp(page, { webSearch: true, budgetS: 30 });
  await selectModel(page, { wantVision: true });
  const payloads = sniffChat(page);
  await attach(page, ["sample.md", "blue.png"], 2);
  await send(
    page,
    "Research the current state of EU-hosted AI inference providers in 2026 and summarize briefly. Use the attached trip notes and image only as context.",
  );
  const turn = await waitForDone(page, 0, ANSWER_TIMEOUT);

  // The doc text and the image both rode along on the multimodal message.
  const sent = payloads[0].messages.at(-1);
  expect(payloads[0].web_search).toBe(true);
  const text = sent.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  expect(text).toContain(SENTINEL.md);
  expect(sent.content.filter((p) => p.type === "image_url")).toHaveLength(1);

  // At least one real Exa search step resolved in the activity panel.
  await expect(turn.locator(".step", { hasText: /Web search “/ })).not.toHaveCount(0);
  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);
  await expect(turn.locator(".content.md")).not.toHaveText("");
  await expect(turn.locator(".stats")).toContainText("search");
});

test("@live stop button keeps the partial answer as normal follow-up context", async ({ page }) => {
  await openApp(page, { webSearch: false, budgetS: 15 });
  await send(page, "Write a very long, detailed 500-word essay about the history of tea.");
  await page.locator("#send").click(); // click Stop the instant it appears mid-stream
  const turn = page.locator(".msg.assistant").last();
  await expect(turn).toContainText("Stopped", { timeout: 15_000 });
});

test("@live photo GPS EXIF gets reverse-geocoded server-side and reaches the model", async ({ page }) => {
  // photo.jpg's EXIF (tests/make_fixtures.py) encodes 40.7128, -74.0060 —
  // Manhattan. The client never resolves this itself (src/geocode.js does,
  // server-side, via OpenStreetMap Nominatim) — this is the one check that
  // the resolved place name actually reaches the model, not just that the
  // raw coordinates were sent (already covered by the mocked spec).
  await openApp(page, { webSearch: false, budgetS: 15 });
  await selectModel(page, { wantVision: true });
  await attach(page, ["photo.jpg"], 1);
  await send(page, "Based only on this photo's metadata (not its visual content), what city was it taken in?");
  const turn = await waitForDone(page, 0, ANSWER_TIMEOUT);
  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);
  await expect(turn.locator(".content")).toContainText(/new york|manhattan/i);
});

// The borrowed-visitor scenario needs a page WITHOUT the suite's Basic Auth:
// a real visitor sends none, and the config's extraHTTPHeaders CLOBBER the
// page's own `Authorization: Bearer <proxy token>` on /api/proxy/llm/*,
// 403-ing every proxied call (observed 2026-07-15 — note that in
// @playwright/test even browser.newContext() inherits the config's `use`
// options, so opting out takes a scoped test.use). The admin mint/revoke use
// a manually-authed API context instead of the (now header-free) request
// fixture.
test.describe("borrowed visitor (no Basic Auth on the page)", () => {
  test.use({ extraHTTPHeaders: {} });

  test("@live secure research space: a shared bundle link researches on the lent API", async ({ page, playwright }) => {
    // The end-to-end repro of test point #10 (2026-07-15): mint a REAL bundle
    // on the admin surface, open the shareable /cure?rp=…#rk= link like a
    // visitor, and complete a chat on the borrowed LLM API. Before the fix
    // this 502'd whenever Berget's catalog put a maintenance-dark model first
    // (the borrowed session's default pick).
    const admin = await playwright.request.newContext({
      baseURL: process.env.BASE_URL || "https://deepresearch.se",
      extraHTTPHeaders: {
        authorization:
          "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64"),
      },
    });
    const mintRes = await admin.post("/api/admin/proxy/mint", { data: { label: "e2e proxy-space" } });
    expect(mintRes.ok()).toBeTruthy();
    const minted = await mintRes.json();
    expect(minted.link).toBeTruthy();

    try {
      await page.addInitScript(() => {
        localStorage.setItem("dr_umbrella_seen_v2", "1");
        localStorage.setItem("dr_secure_intro_seen", "1");
      });
      const u = new URL(minted.link);
      await page.goto(u.pathname + u.search + u.hash);
      await expect(page.locator("#proxybanner")).toBeVisible({ timeout: 30_000 });

      // The default pick is the borrowed provider — and never a model the live
      // catalog marks down (status.up false), the incident's root cause.
      expect(await page.locator("#model").inputValue()).toMatch(/^proxy::/);
      const api = await page.evaluate(() => JSON.parse(localStorage.getItem("dr_proxy_api") || "null"));
      expect(api?.token).toBeTruthy();
      const catRes = await page.request.get("/api/proxy/llm/models", {
        headers: { authorization: "Bearer " + api.token },
      });
      expect(catRes.ok()).toBeTruthy();
      const { data } = await catRes.json();
      const down = (data || []).filter((m) => m?.status?.up === false).map((m) => m.id);
      const options = await page
        .locator("#model option")
        .evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
      for (const id of down) expect(options, `down model ${id} must not be offered`).not.toContain("proxy::" + id);

      // One real completion through the proxy (research off = a single call).
      await page.locator("#websearch").evaluate((el) => {
        el.checked = false; // the styled knob overlay intercepts real clicks
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.fill("#input", "Reply with exactly the code PROXY-SENTINEL-4471 and nothing else.");
      await page.click("#send");
      await expect(page.locator(".msg.assistant").last()).toContainText("PROXY-SENTINEL-4471", {
        timeout: ANSWER_TIMEOUT,
      });
      await expect(page.locator("#workstatus")).not.toContainText("rejected the request");
    } finally {
      // Revoke so e2e grants never pile onto the global outstanding budget.
      if (minted.bundleId) await admin.delete("/api/admin/proxy/" + minted.bundleId).catch(() => {});
      await admin.dispose().catch(() => {});
    }
  });
});
