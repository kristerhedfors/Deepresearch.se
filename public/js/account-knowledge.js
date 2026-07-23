// The account panel's "Workspace knowledge" view — the WORKSPACE OWNER's
// import surface for curated conclusions (docs/COMPUTE-SHARING.md §9b).
// Participants in the owner's shared-compute workspace 👍-curate replies in
// Se/cure and pass them along SEALED (knowledge-core.js drskn envelopes,
// sealed to the site's import-agent key). They arrive here two ways:
//   · the server inbox (POST /api/knowledge/submit) — listed below, ciphertext
//     at rest until the owner taps Import;
//   · a .drskn file handed over out-of-band — the upload box, which opens
//     only blobs addressed to this account (src/knowledge.js's gate).
// Importing decrypts server-side (the agent holds the key) and shows the
// conclusions with their context; "Copy as context" yields the text block
// (summary + question + key points) ready to paste into any chat or project.
// The panel shell (showView) lives in account.js.

import { conclusionToContext } from "./knowledge-core.js";
import { escapeHtml } from "./notifications.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

/** @param {number} ts */
const when = (ts) => (ts ? new Date(ts).toLocaleString() : "");

/** @param {any} bundle @returns {string} rendered conclusions */
function bundleHtml(bundle) {
  const conclusions = Array.isArray(bundle?.conclusions) ? bundle.conclusions : [];
  if (!conclusions.length) return '<p class="muted">The envelope opened but carried no conclusions.</p>';
  return conclusions
    .map((c, i) => {
      const blocks = (Array.isArray(c.blocks) ? c.blocks : []).filter((b) => b.tag !== "minus");
      const plus = blocks.filter((b) => b.tag === "plus");
      return `
        <div class="kn-conclusion">
          ${bundle.workspace ? `<p class="muted">Workspace: ${escapeHtml(bundle.workspace)}</p>` : ""}
          ${c.summary ? `<p class="muted">${escapeHtml(c.summary)}</p>` : ""}
          <p><b>Q:</b> ${escapeHtml(c.query || "")}</p>
          ${plus.length ? `<p class="kn-key"><b>Key points:</b></p>` + plus.map((b) => `<p class="kn-key">${escapeHtml(b.text)}</p>`).join("") : ""}
          ${blocks.filter((b) => b.tag !== "plus").map((b) => `<p>${escapeHtml(b.text)}</p>`).join("")}
          <div class="account-actions">
            <button type="button" class="kn-copy" data-idx="${i}">Copy as context</button>
          </div>
        </div>`;
    })
    .join("");
}

/** Wire the "Copy as context" buttons of a rendered bundle. @param {HTMLElement} host @param {any} bundle */
function wireCopyButtons(host, bundle) {
  for (const btn of host.querySelectorAll(".kn-copy")) {
    btn.addEventListener("click", async () => {
      const c = bundle.conclusions[Number(btn.dataset.idx)];
      try {
        await navigator.clipboard.writeText(conclusionToContext(c));
        btn.textContent = "Copied ✓";
        setTimeout(() => (btn.textContent = "Copy as context"), 1500);
      } catch {
        btn.textContent = "Copy failed";
      }
    });
  }
}

/** @param {PanelCtx} ctx */
export async function loadKnowledgeView(ctx) {
  ctx.body.innerHTML = `
    <button id="knbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Workspace knowledge</p>
    <p class="muted">Loading…</p>`;
  document.getElementById("knbackbtn").addEventListener("click", () => ctx.show("summary"));

  let entries = null;
  try {
    const res = await fetch("/api/knowledge");
    if (res.ok) entries = (await res.json()).entries || [];
  } catch {
    /* entries stays null → error note below */
  }

  const list =
    entries === null
      ? '<p class="muted">Could not load the inbox — try again in a moment.</p>'
      : entries.length
        ? entries
            .map(
              (e) => `
      <div class="kn-entry" data-id="${escapeHtml(e.id)}">
        <p>
          <b>${e.state === "imported" ? "Imported" : "Sealed conclusion"}</b>
          ${e.tokenLabel ? " · " + escapeHtml(e.tokenLabel) : ""}
          <span class="muted"> · ${when(e.createdAt)} · ${Math.round(e.size / 1024) || 1} kB</span>
        </p>
        <div class="account-actions">
          <button type="button" class="kn-import">${e.state === "imported" ? "Open again" : "Import (decrypt)"}</button>
          <button type="button" class="kn-delete">Delete</button>
        </div>
        <div class="kn-opened" hidden></div>
      </div>`,
            )
            .join("")
        : '<p class="muted">Nothing waiting. Workspace members pass conclusions here with the 👍 on a reply in Se/cure.</p>';

  ctx.body.innerHTML = `
    <button id="knbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Workspace knowledge</p>
    <p class="muted">Curated conclusions your workspace members passed along — sealed until you import them.
      Everything rests encrypted; importing decrypts an entry for your eyes.</p>
    ${list}
    <p class="section-lbl" style="margin-top:1rem">Import a downloaded blob</p>
    <p class="muted">Got a <code>.drskn</code> file handed over outside the site? It opens only if it is
      addressed to your account.</p>
    <input type="file" id="kn-file" accept=".drskn,application/json">
    <div id="kn-file-result"></div>
    <span id="kn-status" class="muted"></span>`;
  document.getElementById("knbackbtn").addEventListener("click", () => ctx.show("summary"));
  const status = (m) => (document.getElementById("kn-status").textContent = m);

  for (const entry of ctx.body.querySelectorAll(".kn-entry")) {
    const id = entry.dataset.id;
    entry.querySelector(".kn-import").addEventListener("click", async () => {
      status("Decrypting…");
      try {
        const res = await fetch("/api/knowledge/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          status((await res.json().catch(() => ({}))).error || "Import failed (" + res.status + ").");
          return;
        }
        const { bundle } = await res.json();
        const box = entry.querySelector(".kn-opened");
        box.innerHTML = bundleHtml(bundle);
        box.hidden = false;
        wireCopyButtons(box, bundle);
        status("");
      } catch {
        status("Import failed — try again.");
      }
    });
    entry.querySelector(".kn-delete").addEventListener("click", async () => {
      await fetch("/api/knowledge/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
      await loadKnowledgeView(ctx);
    });
  }

  document.getElementById("kn-file").addEventListener("change", async (ev) => {
    const file = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
    if (!file) return;
    status("Opening…");
    try {
      const envelope = JSON.parse(await file.text());
      const res = await fetch("/api/knowledge/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
      });
      if (!res.ok) {
        status((await res.json().catch(() => ({}))).error || "Could not open the blob (" + res.status + ").");
        return;
      }
      const { bundle } = await res.json();
      const box = document.getElementById("kn-file-result");
      box.innerHTML = bundleHtml(bundle);
      wireCopyButtons(box, bundle);
      status("");
    } catch {
      status("That file is not a drskn envelope.");
    }
  });
}
