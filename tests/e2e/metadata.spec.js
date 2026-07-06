// Attachment metadata extraction (public/js/exif.js, public/js/docs.js),
// asserted end-to-end through the real upload/parse flow: a photo carrying
// EXIF (GPS + camera info), a docx carrying core properties, unaccepted
// tracked changes, and a reviewer comment — plus regression checks that
// plain attachments with no metadata stay exactly as before.

import { expect, test } from "@playwright/test";
import { attach, mockChat, openApp, selectModel, send, waitForDone } from "./helpers.js";

test("a JPEG's EXIF (GPS, camera, capture time) reaches the payload and is flagged before sending", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);
  await attach(page, ["photo.jpg"], 1);

  // Transparency badge shown on the pending chip before the user hits send.
  const badge = page.locator(".att-card .att-meta-badge");
  await expect(badge).toHaveText("📍 location data included");
  await expect(badge).toHaveAttribute("title", /GPS location: 40\.7128, -74\.006/);

  await send(page, "What can you tell me about this photo?");
  await waitForDone(page);

  expect(payloads).toHaveLength(1);
  const msg = payloads[0].messages.at(-1);
  const textPart = msg.content.find((p) => p.type === "text");
  expect(textPart.text).toContain("--- Image metadata: photo.jpg ---");
  expect(textPart.text).toContain("Camera: Apple iPhone 14 Pro");
  expect(textPart.text).toContain("Captured: 2024-05-01 14:32:00");
  expect(textPart.text).toContain("GPS location: 40.7128, -74.006");
  expect(textPart.text).toContain("--- End of image metadata ---");
  expect(msg.content.filter((p) => p.type === "image_url")).toHaveLength(1);

  // Raw coordinates also ride separately, for the Worker to reverse-geocode
  // (src/geocode.js) — never resolved client-side.
  expect(payloads[0].imageLocations).toEqual([{ name: "photo.jpg", lat: 40.7128, lon: -74.006 }]);
});

test("a docx's tracked changes, comments, and core properties reach the payload and are flagged", async ({ page }) => {
  await openApp(page, { webSearch: false });
  const payloads = await mockChat(page);
  await attach(page, ["metadata.docx"], 1);

  const badge = page.locator(".att-card .att-meta-badge");
  await expect(badge).toHaveText("⚠️ tracked changes included");
  await expect(badge).toHaveClass(/att-meta-sensitive/);

  await send(page, "Summarize this document.");
  await waitForDone(page);

  const msg = payloads[0].messages.at(-1);
  expect(typeof msg.content).toBe("string");
  expect(msg.content).toContain("[Document metadata]");
  expect(msg.content).toContain("Author: Jane Doe");
  expect(msg.content).toContain("Last modified by: John Smith");
  expect(msg.content).toContain("Revision: 3");
  expect(msg.content).toContain("Company: Acme Corp");

  // The deleted content is surfaced explicitly in the metadata block...
  expect(msg.content).toContain("Unaccepted tracked deletions");
  expect(msg.content).toContain("DELETED-SENTINEL-88420");
  // ...but must NOT appear anywhere as if it were regular document text
  // (i.e. it shouldn't show up a second time outside the metadata block).
  const occurrences = msg.content.split("DELETED-SENTINEL-88420").length - 1;
  expect(occurrences).toBe(1);

  expect(msg.content).toContain("Unaccepted tracked insertions");
  expect(msg.content).toContain("INSERTED-SENTINEL-33210");
  expect(msg.content).toContain("Reviewer comments");
  expect(msg.content).toContain("COMMENT-SENTINEL-55510");

  // The insertion IS part of the normal document text too (Word renders
  // an unaccepted insertion as ordinary visible content).
  expect(msg.content).toContain("METADOC-SENTINEL-71190");
});

test("a plain PNG with no EXIF shows no metadata badge and adds no metadata block", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);
  await attach(page, ["red.png"], 1);

  await expect(page.locator(".att-card .att-meta-badge")).toHaveCount(0);

  await send(page, "What color is this?");
  await waitForDone(page);

  const msg = payloads[0].messages.at(-1);
  const textPart = msg.content.find((p) => p.type === "text");
  expect(textPart?.text || "").not.toContain("Image metadata");
});

test("a plain docx with no docProps/tracked changes shows no badge and adds no metadata block", async ({ page }) => {
  await openApp(page, { webSearch: false });
  const payloads = await mockChat(page);
  await attach(page, ["sample.docx"], 1);

  await expect(page.locator(".att-card .att-meta-badge")).toHaveCount(0);

  await send(page, "Summarize the attached document.");
  await waitForDone(page);

  const msg = payloads[0].messages.at(-1);
  expect(msg.content).not.toContain("[Document metadata]");
});
