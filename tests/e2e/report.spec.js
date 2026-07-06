// The downloadable PDF report: generated fully client-side (jsPDF), must
// embed the images the user attached to the question. jsPDF stores JPEGs
// verbatim (DCTDecode), so the downscaled JPEG bytes shown in the bubble
// must appear byte-for-byte inside the PDF file.

import { expect, test } from "@playwright/test";
import {
  attach,
  bubbleImageJpegs,
  downloadReportPdf,
  mockChat,
  openApp,
  selectModel,
  send,
  waitForDone,
} from "./helpers.js";

const ANSWER = "# Findings\n\nThe images show **two solid colors**.\n\n- first: red\n- second: blue\n";

test("report embeds every attached input image", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  await mockChat(page, ANSWER);
  await attach(page, ["red.png", "blue.png"], 2);
  await send(page, "What is in these images?");
  const turn = await waitForDone(page);

  const jpegs = await bubbleImageJpegs(page);
  expect(jpegs).toHaveLength(2);

  const pdf = await downloadReportPdf(page, turn);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  for (const jpeg of jpegs) {
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // SOI
    expect(pdf.includes(jpeg), "PDF must contain the attached JPEG verbatim").toBeTruthy();
  }
  // Title (the question), model line, branding and body text all render as
  // plain strings in the uncompressed content stream.
  const raw = pdf.toString("latin1");
  expect(raw).toContain("What is in these images?");
  expect(raw).toContain("Model: mock-model");
  expect(raw).toContain("DeepResearch.se");
  expect(raw).toContain("Findings");
});

test("report without images still downloads fine", async ({ page }) => {
  await openApp(page);
  await mockChat(page, "Plain text answer with no attachments.");
  await send(page, "Just a question.");
  const turn = await waitForDone(page);

  const pdf = await downloadReportPdf(page, turn);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const raw = pdf.toString("latin1");
  expect(raw).toContain("Just a question.");
  expect(raw).not.toContain("DCTDecode"); // no stray image objects
});

test("second turn's report carries only that turn's images", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  await mockChat(page, "Answer.");

  await attach(page, ["red.png"], 1);
  await send(page, "First, the red one.");
  await waitForDone(page, 0);
  const redJpeg = (await bubbleImageJpegs(page))[0];

  await attach(page, ["blue.png"], 1);
  await send(page, "Now the blue one.");
  const turn2 = await waitForDone(page, 1);
  const blueJpeg = (await bubbleImageJpegs(page))[0];

  const pdf = await downloadReportPdf(page, turn2);
  expect(pdf.includes(blueJpeg)).toBeTruthy();
  expect(pdf.includes(redJpeg)).toBeFalsy();
});
