// Attachment caps, truncation, and rejection paths — all client-side rules
// that protect the provider's request-size limit and the server's 32K
// message cap.

import { expect, test } from "@playwright/test";
import {
  attach,
  docHeader,
  fx,
  imagesOfMessage,
  mockChat,
  openApp,
  selectModel,
  send,
  SENTINEL,
  textOfMessage,
  waitForDone,
} from "./helpers.js";

test("oversized txt truncates to the per-doc cap with a visible marker", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["big.txt"], 1);
  await expect(page.locator("#pending .att-card .sub")).toContainText("truncated");
  await send(page, "Summarize.");
  await waitForDone(page);

  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).toContain(docHeader("big.txt", true)); // "(truncated)" label
  expect(text).toContain(SENTINEL.bigtxt); // head survives
  expect(text).not.toContain(SENTINEL.bigtail); // tail was cut
  // The embedded doc slice respects the 9K per-doc cap.
  const block = text.split(docHeader("big.txt", true))[1].split("--- End of document ---")[0];
  expect(block.trim().length).toBeLessThanOrEqual(9000);
});

test("image cap: 5th image is rejected with an explanation", async ({ page }) => {
  const { dialogs } = await openApp(page);
  await selectModel(page, { wantVision: true });
  await attach(page, ["red.png", "blue.png", "green.png", "yellow.png", "purple.png"], 4);
  expect(dialogs.some((d) => d.message.includes("Max 4 images"))).toBeTruthy();
});

test("doc cap: 4th document is rejected with an explanation", async ({ page }) => {
  const { dialogs } = await openApp(page);
  await attach(page, ["sample.txt", "sample.md", "sample.pdf", "sample.docx"], 3);
  expect(dialogs.some((d) => d.message.includes("Max 3 documents"))).toBeTruthy();
});

test("unsupported file type is rejected with guidance", async ({ page }) => {
  const { dialogs } = await openApp(page);
  await page.setInputFiles("#file", fx("notes.csv"));
  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0].message).toContain("unsupported type");
  await expect(page.locator("#pending .att-card")).toHaveCount(0);
});

test("full house: 4 images + 3 docs send as one message", async ({ page }) => {
  const { dialogs } = await openApp(page);
  await selectModel(page, { wantVision: true });
  const payloads = await mockChat(page);
  await attach(page, ["red.png", "blue.png", "green.png", "yellow.png"], 4);
  await attach(page, ["sample.txt", "sample.md", "sample.docx"], 7);
  await send(page, "Everything at once.");
  await waitForDone(page);

  expect(dialogs).toHaveLength(0); // all within caps — no complaints
  const msg = payloads[0].messages.at(-1);
  expect(imagesOfMessage(msg)).toHaveLength(4);
  const text = textOfMessage(msg);
  expect(text).toContain(SENTINEL.txt);
  expect(text).toContain(SENTINEL.md);
  expect(text).toContain(SENTINEL.docx);
  // Under the server's 32K message cap.
  expect(text.length).toBeLessThanOrEqual(32_000);
});

test("removing a pending attachment keeps it out of the payload", async ({ page }) => {
  await openApp(page);
  const payloads = await mockChat(page);
  await attach(page, ["sample.txt", "sample.md"], 2);
  // Remove the first card (sample.txt).
  await page.locator("#pending .att-card .att-remove").first().click();
  await expect(page.locator("#pending .att-card")).toHaveCount(1);
  await send(page, "Only one doc should remain.");
  await waitForDone(page);
  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).not.toContain(SENTINEL.txt);
  expect(text).toContain(SENTINEL.md);
});
