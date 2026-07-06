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
  await expect(turn.locator(".step", { hasText: /Searched “/ })).not.toHaveCount(0);
  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);
  await expect(turn.locator(".content.md")).not.toHaveText("");
  await expect(turn.locator(".stats")).toContainText("search");
});
