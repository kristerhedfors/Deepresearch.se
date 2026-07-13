// Projects: collections of chats and files with their own retrieval scope.
// A project is ALWAYS stored in the cloud (like everything on Se/rver —
// there is no per-project storage knob). Everything mocked (/api/embed,
// /api/chat, and — for the always-cloud test — the whole storage surface),
// exercising the real UI, the real chunk/index/retrieve pipeline, and the
// real EXIF extraction.

import { expect, test } from "@playwright/test";
import { fx, mockChat, mockEmbed, openApp, send, SENTINEL, textOfMessage, waitForDone } from "./helpers.js";

const NOTE_A = "NOTE-SENTINEL-AAA111";
const NOTE_B = "NOTEB-SENTINEL-BBB222";

async function createProject(page, name) {
  await expect(page.locator("#historybtn")).toBeVisible({ timeout: 20_000 });
  await page.click("#historybtn");
  await page.click("#projectnewbtn");
  await page.fill("#projectcreatename", name);
  await page.click("#projectcreatego");
  await expect(page.locator("#projectpanel")).toBeVisible();
  await expect(page.locator("#projecttitle")).toHaveText(name);
}

async function addNote(page, title, content) {
  // The note form is always open in the panel — no toggle button.
  await page.fill("#ptexttitle", title);
  await page.fill("#ptextcontent", content);
  await page.click("#ptextsave");
  const row = page.locator(".project-file", { hasText: title });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator(".sub")).toContainText("indexed", { timeout: 20_000 });
}

async function openProjectFromSidebar(page, name) {
  await page.click("#historybtn");
  await page.locator("#projectslist .history-open", { hasText: name }).click();
  await expect(page.locator("#projectpanel")).toBeVisible();
  await expect(page.locator("#projecttitle")).toHaveText(name);
}

test("a project ingests notes, documents and images — indexables indexed, EXIF extracted — and survives a reload", async ({ page }) => {
  await openApp(page);
  await mockEmbed(page);
  await createProject(page, "Fieldwork");

  await addNote(page, "Alpha note", `Observations from the field. ${NOTE_A} end of note.`);
  await page.setInputFiles("#pfileinput", fx("big.txt"));
  const docRow = page.locator(".project-file", { hasText: "big.txt" });
  await expect(docRow.locator(".sub")).toContainText("indexed", { timeout: 30_000 });
  await page.setInputFiles("#pfileinput", fx("photo.jpg"));
  const imgRow = page.locator(".project-file", { hasText: "photo.jpg" });
  await expect(imgRow.locator(".sub")).toContainText("image", { timeout: 20_000 });
  await expect(imgRow.locator(".att-meta-badge")).toBeVisible(); // EXIF found
  // The row shows the actual (downscaled) picture, not just a kind icon.
  await expect(imgRow.locator("img.pf-thumb")).toBeVisible();
  const thumbSrc = await imgRow.locator("img.pf-thumb").getAttribute("src");
  expect(thumbSrc).toMatch(/^data:image\/jpeg;base64,/);

  // Everything persists across a reload (encrypted project record +
  // IndexedDB index + OPFS originals).
  await page.reload();
  await mockEmbed(page);
  await openProjectFromSidebar(page, "Fieldwork");
  await expect(page.locator(".project-file")).toHaveCount(3);
  await expect(page.locator(".project-file", { hasText: "Alpha note" }).locator(".sub")).toContainText("indexed");
  await expect(
    page.locator(".project-file", { hasText: "photo.jpg" }).locator("img.pf-thumb"),
  ).toBeVisible(); // the preview rides inside the encrypted record

  // Rename: double-click the title in the header — no button.
  await page.dblclick("#projecttitle");
  await page.fill("#projectrename", "Fieldwork 2026");
  await page.keyboard.press("Enter");
  await expect(page.locator("#projecttitle")).toHaveText("Fieldwork 2026");
  await page.click("#projectclose");
  await page.click("#historybtn");
  await expect(page.locator("#projectslist")).toContainText("Fieldwork 2026");
});

test("a chat inside a project retrieves the project's material, carries image EXIF, and is scoped to that project only", async ({ page }) => {
  await openApp(page);
  await mockEmbed(page);
  const payloads = await mockChat(page);

  await createProject(page, "Proj A");
  await addNote(page, "Alpha note", `Key fact for retrieval: ${NOTE_A}.`);
  await page.setInputFiles("#pfileinput", fx("photo.jpg"));
  await expect(page.locator(".project-file", { hasText: "photo.jpg" })).toBeVisible({ timeout: 20_000 });
  await page.click("#projectclose");

  await createProject(page, "Proj B");
  await addNote(page, "Beta note", `Different fact entirely: ${NOTE_B}.`);
  await page.click("#projectclose");

  // Chat in Proj A.
  await openProjectFromSidebar(page, "Proj A");
  await page.click("#pchat");
  await expect(page.locator("#projectchip")).toBeVisible();
  await expect(page.locator("#projectchip")).toContainText("Proj A");
  await send(page, "What does the note say?");
  await waitForDone(page);

  const text = textOfMessage(payloads[0].messages.at(-1));
  expect(text).toContain("--- Project: Proj A ---"); // project materials block
  expect(text).toMatch(/GPS location/); // photo.jpg's EXIF in context
  expect(text).toContain(NOTE_A); // retrieved excerpt from the project note
  expect(text).not.toContain(NOTE_B); // Proj B's material must NOT leak in

  // Follow-up keeps retrieving without re-attaching anything.
  await send(page, "And what else?");
  await waitForDone(page, 1);
  expect(textOfMessage(payloads[1].messages.at(-1))).toContain(NOTE_A);

  // A plain chat outside the project has no project context at all.
  await page.click("#clearbtn");
  await expect(page.locator("#projectchip")).toBeHidden();
  await send(page, "Plain question.");
  await waitForDone(page);
  const plain = textOfMessage(payloads[2].messages.at(-1));
  expect(plain).not.toContain("--- Project:");
  expect(plain).not.toContain(NOTE_A);
});

test("a project is always stored in the cloud — record, file, and index all mirror; no storage knob", async ({ page }) => {
  const calls = [];
  const json = (b, s = 200) => ({ status: s, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const track = (route) => calls.push(route.request().method() + " " + new URL(route.request().url()).pathname);
  await page.route("**/api/settings", (r) => {
    track(r);
    return r.fulfill(json({ server_history: true, available: { storage: true, rag: true } }));
  });
  for (const family of ["projects", "convos"]) {
    await page.route(`**/api/${family}**`, (r) => {
      track(r);
      const m = r.request().method();
      if (m === "GET" && r.request().url().endsWith(`/api/${family}`)) {
        return r.fulfill(json(family === "projects" ? { projects: [] } : { conversations: [] }));
      }
      if (m === "GET") return r.fulfill(json({ error: "nf" }, 404));
      if (m === "PUT") return r.fulfill(json({ ok: true }));
      return r.fulfill({ status: 204 });
    });
  }
  await page.route("**/api/files**", (r) => {
    track(r);
    const m = r.request().method();
    if (m === "GET" && r.request().url().endsWith("/api/files")) return r.fulfill(json({ files: [] }));
    if (m === "GET") return r.fulfill(json({ error: "nf" }, 404));
    if (m === "PUT") return r.fulfill(json({ ok: true }));
    return r.fulfill({ status: 204 });
  });
  await page.route("**/api/rag/**", (r) => {
    track(r);
    const url = r.request().url();
    const m = r.request().method();
    if (url.includes("/api/rag/index")) return r.fulfill(json({ ok: true }));
    if (url.includes("/api/rag/query")) return r.fulfill(json({ matches: [] }));
    if (m === "GET" && url.endsWith("/api/rag/docs")) return r.fulfill(json({ docs: [] }));
    if (m === "GET") return r.fulfill(json({ error: "nf" }, 404));
    return r.fulfill({ status: 204 });
  });
  await openApp(page);
  await mockEmbed(page);

  await createProject(page, "CloudProj");
  await addNote(page, "Cloud note", "Content that gets indexed and mirrored.");
  // Record + file + index all reach the cloud automatically — no toggle.
  await expect
    .poll(() => calls.filter((c) => c.startsWith("PUT /api/projects/")).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => calls.filter((c) => c.startsWith("PUT /api/files/")).length).toBeGreaterThan(0);
  await expect.poll(() => calls.filter((c) => c === "POST /api/rag/index").length).toBeGreaterThan(0);

  // There is NO per-project storage knob in the panel (only the vault's
  // "Store" button remains as a storage-related control).
  await expect(page.locator("#projectcloud")).toHaveCount(0);
  await expect(page.locator("#projectpanel")).not.toContainText("Store this project in the cloud");
});
