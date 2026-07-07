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
  mockEmbed,
  mockEmbedFail,
  openApp,
  selectModel,
  send,
  SENTINEL,
  textOfMessage,
  waitForDone,
} from "./helpers.js";

// An over-cap document now goes through RAG (chunk + embed + retrieve)
// instead of truncation — but when the embedding endpoint is unavailable
// the client must degrade to exactly the old behavior: first 9K chars
// inline, marked truncated.
test("oversized txt falls back to per-doc-cap truncation when indexing is unavailable", async ({ page }) => {
  await openApp(page);
  await mockEmbedFail(page);
  const payloads = await mockChat(page);
  await attach(page, ["big.txt"], 1);
  await expect(page.locator("#pending .att-card .sub")).toContainText("truncated", { timeout: 30_000 });
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

test("oversized txt is RAG-indexed and sends retrieved excerpts, not the whole text", async ({ page }) => {
  await openApp(page);
  await mockEmbed(page);
  const payloads = await mockChat(page);
  await attach(page, ["big.txt"], 1);
  await expect(page.locator("#pending .att-card .sub")).toContainText("indexed", { timeout: 30_000 });
  await send(page, "Summarize.");
  await waitForDone(page);

  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).toContain("large document, indexed for retrieval"); // excerpt block, not the inline block
  expect(text).not.toContain(docHeader("big.txt", true));
  expect(text).toContain(SENTINEL.bigtxt); // head chunk is among the (tied-score) top-k
  expect(text).not.toContain(SENTINEL.bigtail); // tail chunk didn't make the top-k
  // Excerpts stay within the retrieval budget, far under the message cap.
  expect(text.length).toBeLessThanOrEqual(16_000);
});

// Attached originals rest ENCRYPTED (OPFS here, R2 in cloud mode): the
// stored bytes of a normal attachment must not contain its plaintext.
// The one deliberate exception is a RAG-indexed document — its search
// index needs readable text anyway, so its original stays readable.
test("attached originals rest encrypted in OPFS — except RAG-indexed docs", async ({ page }) => {
  await openApp(page);
  await mockEmbed(page);
  await attach(page, ["sample.txt"], 1); // small doc → encrypted original
  await attach(page, ["big.txt"], 2); // large doc → RAG-indexed, readable original
  await expect(page.locator("#pending .att-card .sub").nth(1)).toContainText("indexed", { timeout: 30_000 });

  const readOpfs = () =>
    page.evaluate(async ([txtSent, bigSent]) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("originals");
        const out = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== "file") continue;
          const text = await (await handle.getFile()).text();
          out.push({ name, txt: text.includes(txtSent), big: text.includes(bigSent) });
        }
        return out;
      } catch {
        return [];
      }
    }, [SENTINEL.txt, SENTINEL.bigtxt]);
  await expect.poll(readOpfs, { timeout: 15_000 }).toHaveLength(2); // archival is fire-and-forget
  const files = await readOpfs();
  expect(files.some((f) => f.big), "RAG doc's original stays readable").toBeTruthy();
  expect(files.some((f) => f.txt), "small doc's original must be ciphertext").toBeFalsy();
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
