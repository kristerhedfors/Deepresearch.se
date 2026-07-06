// Client-side attachment parsing, asserted on the real /api/chat request
// payload (the stream itself is mocked — parsing happens entirely in the
// browser, so this is the ground truth of what the server would receive).

import { expect, test } from "@playwright/test";
import {
  attach,
  docHeader,
  imagesOfMessage,
  mockChat,
  openApp,
  selectModel,
  send,
  SENTINEL,
  textOfMessage,
  waitForDone,
} from "./helpers.js";

test.describe("single document types", () => {
  for (const [name, sentinel] of [
    ["sample.txt", SENTINEL.txt],
    ["sample.md", SENTINEL.md],
    ["sample.pdf", SENTINEL.pdf],
    ["sample.docx", SENTINEL.docx],
  ]) {
    test(`${name} parses and lands in the payload`, async ({ page }) => {
      await openApp(page);
      const payloads = await mockChat(page);
      await attach(page, [name], 1);
      await send(page, "Summarize the attached document.");
      await waitForDone(page);

      expect(payloads).toHaveLength(1);
      const msg = payloads[0].messages.at(-1);
      expect(typeof msg.content).toBe("string");
      expect(msg.content).toContain(docHeader(name));
      expect(msg.content).toContain(sentinel);
      expect(msg.content).toContain("--- End of document ---");

      // The bubble shows a chip, never the document text.
      const bubble = page.locator(".msg.user").last();
      await expect(bubble.locator(".doc-chip")).toHaveText("📄 " + name);
      await expect(bubble).not.toContainText(sentinel);
      // Mock answer rendered as markdown, stats footer filled.
      await expect(page.locator(".msg.assistant .content.md")).toContainText("MOCK ANSWER");
    });
  }
});

test("docx entity unescaping, tabs and breaks survive extraction", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["sample.docx"], 1);
  await send(page, "Read it.");
  await waitForDone(page);
  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).toContain('Budget & scope: "approved" — final.');
  expect(text).toContain("Col A\tCol B\nSecond line");
});

test("stored (uncompressed) docx parses too", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["stored.docx"], 1);
  await send(page, "Read it.");
  await waitForDone(page);
  expect(textOfMessage(payloads[0].messages.at(-1))).toContain(SENTINEL.docx);
});

test("three documents of different types in one message", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["sample.txt", "sample.md", "sample.pdf"], 3);
  await send(page, "Compare the attached documents.");
  await waitForDone(page);

  const text = textOfMessage(payloads[0].messages.at(-1));
  for (const name of ["sample.txt", "sample.md", "sample.pdf"]) {
    expect(text).toContain(docHeader(name));
  }
  expect(text).toContain(SENTINEL.txt);
  expect(text).toContain(SENTINEL.md);
  expect(text).toContain(SENTINEL.pdf);
  // Documents embed in attach order.
  expect(text.indexOf(SENTINEL.txt)).toBeLessThan(text.indexOf(SENTINEL.md));
  expect(text.indexOf(SENTINEL.md)).toBeLessThan(text.indexOf(SENTINEL.pdf));
  await expect(page.locator(".msg.user .doc-chip")).toHaveCount(3);
});

test("docx + txt + md combination", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["sample.docx", "sample.txt", "sample.md"], 3);
  await send(page, "Merge these notes.");
  await waitForDone(page);
  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).toContain(SENTINEL.docx);
  expect(text).toContain(SENTINEL.txt);
  expect(text).toContain(SENTINEL.md);
});

test("documents + images combine into multimodal content", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);
  await attach(page, ["sample.pdf", "red.png", "blue.png"], 3);
  await send(page, "Relate the images to the document.");
  await waitForDone(page);

  const msg = payloads[0].messages.at(-1);
  expect(Array.isArray(msg.content)).toBeTruthy();
  const text = textOfMessage(msg);
  expect(text).toContain("Relate the images to the document.");
  expect(text).toContain(SENTINEL.pdf);
  const imgs = imagesOfMessage(msg);
  expect(imgs).toHaveLength(2);
  for (const part of imgs) {
    expect(part.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  }
});

test("image-only send (no text) produces image-only parts", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);
  await attach(page, ["green.png"], 1);
  await page.click("#send"); // empty input, pending attachment allows send
  await waitForDone(page);

  const msg = payloads[0].messages.at(-1);
  expect(Array.isArray(msg.content)).toBeTruthy();
  expect(imagesOfMessage(msg)).toHaveLength(1);
  expect(msg.content.some((p) => p.type === "text")).toBeFalsy();
});

test("history resend strips images from older turns", async ({ page }) => {
  await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);

  await attach(page, ["red.png"], 1);
  await send(page, "Look at this image.");
  await waitForDone(page, 0);

  await send(page, "And a follow-up question.");
  await waitForDone(page, 1);

  expect(payloads).toHaveLength(2);
  // First request: multimodal.
  expect(imagesOfMessage(payloads[0].messages.at(-1))).toHaveLength(1);
  // Second request: the older user message is flattened to a string with
  // the marker; only 8 images/request are allowed so history must not
  // re-inflate.
  const [first, , last] = payloads[1].messages;
  expect(typeof first.content).toBe("string");
  expect(first.content).toContain("Look at this image.");
  expect(first.content).toContain("[image was attached earlier in this conversation]");
  expect(typeof last.content).toBe("string");
  expect(last.content).toContain("And a follow-up question.");
});
