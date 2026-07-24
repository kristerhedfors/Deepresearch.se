// Projects UI: the projects section at the top of the history sidebar, the
// project panel overlay (knob at the top, add-files/add-text, dropzone,
// file inventory, the project's conversations), and the header chip that
// shows which project the current chat belongs to.
//
// Data and rules live in public/js/projects.js; bulk cloud moves in
// public/js/sync.js. This module only renders and wires.

import { escapeHtml } from "./notifications.js";
import { loadConversation } from "./history-store.js";
import {
  activeProjectId,
  addFilesToProject,
  addTextToProject,
  conversationsOfProject,
  createProject,
  deleteProject,
  ensureThumb,
  getProject,
  listProjects,
  onProjectsChange,
  removeFileFromProject,
  renameProject,
  setActiveProject,
} from "./projects.js";
import { storageAvailable } from "./settings.js";
import { applyLoadedConversation } from "./stream.js";
import { loadProjectFromVault, storeProjectToVault, vaultSecretValid } from "./vault.js";

let onLoad = () => {};
let onNew = () => {};
let openPanelId = null;

/**
 * One-time wiring from app.js: the create form, the panel overlay, the
 * header chip, and the title-rename gesture.
 * @param {{onNew?: (keepProject?: boolean) => void,
 *   onLoad?: (record: object) => void}} [opts]  same callbacks the history
 *   sidebar gets — onNew(true) keeps the active project for the fresh chat
 */
export function initProjectsUi(opts = {}) {
  onLoad = opts.onLoad || onLoad;
  onNew = opts.onNew || onNew;

  // Inline create form (prompt() is hostile on mobile and untestable).
  const createBox = document.getElementById("projectcreate");
  const createName = document.getElementById("projectcreatename");
  document.getElementById("projectnewbtn").addEventListener("click", () => {
    createBox.hidden = !createBox.hidden;
    if (!createBox.hidden) createName.focus();
  });
  document.getElementById("projectcreatego").addEventListener("click", async () => {
    const name = createName.value.trim();
    if (!name) return;
    createName.value = "";
    createBox.hidden = true;
    const p = await createProject(name);
    renderProjectsList();
    openProjectPanel(p.id);
  });

  wireVaultLoad();

  const overlay = document.getElementById("projectpanel");
  document.getElementById("projectclose").addEventListener("click", closePanel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePanel();
  });
  window.addEventListener("resize", () => {
    if (!overlay.hidden) placeCloseBtn();
  });

  const chip = document.getElementById("projectchip");
  chip.addEventListener("click", () => {
    if (activeProjectId()) openProjectPanel(activeProjectId());
  });
  onProjectsChange(updateChip);
  updateChip();
  wireTitleRename();
}

// Rename is a double-click on the project name in the header (no button).
// Desktop fires dblclick natively; iOS historically doesn't, so a manual
// two-taps-within-350ms detector covers touch. The name swaps to an input
// in place: Enter or blur saves, Escape cancels.
function wireTitleRename() {
  const title = document.getElementById("projecttitle");
  title.title = "Double-tap to rename";
  let lastTap = 0;
  let editing = false;

  async function commit(input, cancel) {
    if (!editing) return;
    editing = false;
    const p = getProject(openPanelId);
    const name = input.value.trim();
    input.remove();
    if (!cancel && p && name && name !== p.name) {
      await renameProject(p.id, name);
      renderProjectsList();
      updateChip();
    }
    title.textContent = getProject(openPanelId)?.name || title.textContent;
  }

  function startEdit() {
    if (editing || !openPanelId) return;
    const p = getProject(openPanelId);
    if (!p) return;
    editing = true;
    title.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "projectrename";
    input.maxLength = 80;
    input.value = p.name;
    title.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(input, false);
      else if (e.key === "Escape") commit(input, true);
    });
    input.addEventListener("blur", () => commit(input, false));
  }

  title.addEventListener("dblclick", startEdit);
  title.addEventListener("pointerup", () => {
    if (editing) return;
    const now = Date.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      startEdit();
    } else {
      lastTap = now;
    }
  });
}

// The sidebar's "Load project from secret" flow (public/js/vault.js): the
// button reveals a one-line secret form; a valid secret fetches the
// encrypted archive, decrypts it in this browser, and imports the project —
// a local-only project loads as local-only.
function wireVaultLoad() {
  const btn = document.getElementById("projectloadbtn");
  const box = document.getElementById("projectload");
  const input = document.getElementById("projectloadsecret");
  const status = document.getElementById("projectloadstatus");
  const setStatus = (msg) => {
    status.hidden = !msg;
    status.textContent = msg || "";
  };
  btn.addEventListener("click", () => {
    box.hidden = !box.hidden;
    setStatus("");
    if (!box.hidden) input.focus();
  });
  async function go() {
    const secret = input.value;
    if (!vaultSecretValid(secret)) {
      setStatus("That doesn't look like a vault secret — expected DR1- followed by 32 characters.");
      return;
    }
    if (!storageAvailable()) {
      setStatus("Cloud storage isn't available on this account.");
      return;
    }
    const goBtn = document.getElementById("projectloadgo");
    goBtn.disabled = true;
    try {
      const r = await loadProjectFromVault(secret, setStatus);
      input.value = "";
      box.hidden = true;
      setStatus("");
      await renderProjectsList();
      openProjectPanel(r.projectId);
    } catch (err) {
      setStatus(err?.message || "Loading the project failed.");
    } finally {
      goBtn.disabled = false;
    }
  }
  document.getElementById("projectloadgo").addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

function updateChip() {
  const chip = document.getElementById("projectchip");
  const p = activeProjectId() ? getProject(activeProjectId()) : null;
  if (p) {
    chip.textContent = "📁 " + p.name;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

// The projects section inside the history sidebar — history-ui.js calls
// this on every sidebar refresh.
export async function renderProjectsList() {
  const box = document.getElementById("projectslist");
  if (!box) return;
  const projects = await listProjects();
  if (!projects.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = projects
    .map(
      (p) => `
    <div class="history-item${p.id === activeProjectId() ? " active" : ""}">
      <button type="button" class="history-open" data-id="${p.id}">
        <span class="history-title">📁 ${escapeHtml(p.name)}</span>
        <span class="history-when">${(p.files || []).length} file(s)</span>
      </button>
    </div>`,
    )
    .join("");
  box.querySelectorAll(".history-open").forEach((el) => {
    el.addEventListener("click", () => openProjectPanel(el.dataset.id));
  });
}

function closePanel() {
  document.getElementById("projectpanel").hidden = true;
  openPanelId = null;
}

// Pin a pane's floating close chevron to the screen rect of the header's
// history button, so on a phone the same tap spot opens and closes the
// pane. Shared by the project panel's ✕ and (via history-ui.js) the
// history drawer's ✕, so the close button doesn't jump when moving
// between the two panes. In Introspection / Agent Studio the header's
// mode-tag row pushes the live button down far enough that a pinned
// chevron would sit on the pane's "Chat history" head — subtract the
// visible tag row (its box + the header column's gap) so the chevron
// lands at the Deep Research position, the same spot in all three modes.
export function pinPaneClose(closeBtn) {
  const r = document.getElementById("historybtn").getBoundingClientRect();
  if (!r.width) return; // button hidden/unlaid-out: keep the CSS fallback
  let top = r.top;
  const tag = [".introspection-tag", ".sdk-tag"]
    .map((sel) => document.querySelector(sel))
    .find((el) => el && el.offsetHeight > 0);
  if (tag) {
    const cs = getComputedStyle(tag);
    const gap = parseFloat(getComputedStyle(tag.parentElement).rowGap) || 0;
    top -= tag.getBoundingClientRect().height
      + (parseFloat(cs.marginTop) || 0)
      + (parseFloat(cs.marginBottom) || 0)
      + gap;
  }
  closeBtn.style.top = top + "px";
  closeBtn.style.left = r.left + "px";
  closeBtn.style.width = r.width + "px";
  closeBtn.style.height = r.height + "px";
}

function placeCloseBtn() {
  pinPaneClose(document.getElementById("projectclose"));
}

export async function openProjectPanel(id) {
  openPanelId = id;
  placeCloseBtn();
  document.getElementById("projectpanel").hidden = false;
  document.getElementById("historysidebar").hidden = true;
  await renderPanel();
}

const KIND_ICON = { image: "🖼", doc: "📄", text: "📝", file: "📎" };

async function renderPanel() {
  const p = getProject(openPanelId);
  const body = document.getElementById("projectbody");
  if (!p) {
    body.innerHTML = '<p class="muted">Project not found.</p>';
    return;
  }
  document.getElementById("projecttitle").textContent = p.name;

  const conversations = await conversationsOfProject(p.id);
  const cloudUsable = storageAvailable();
  const filesHtml = (p.files || [])
    .map((f) => {
      const sub =
        f.kind === "image"
          ? "image"
          : f.indexed
            ? `${f.kind === "text" ? "note" : f.ext || "doc"} · indexed (${f.chunkCount} parts)`
            : f.kind === "text"
              ? "note"
              : (f.ext || "file") + " · not indexed";
      const badge = f.metadata
        ? `<span class="att-meta-badge" title="${escapeHtml(f.metadata)}">ℹ️ metadata</span>`
        : "";
      // Images show their actual (tiny, record-embedded) preview — the
      // same look as an attachment card — falling back to the kind icon
      // only when no thumbnail could be made.
      const visual =
        f.kind === "image" && f.thumb
          ? `<img class="pf-thumb" src="${f.thumb}" alt="">`
          : `<span class="icon">${KIND_ICON[f.kind] || "📎"}</span>`;
      return `
      <div class="project-file" data-id="${f.id}">
        ${visual}
        <div class="meta"><div class="name">${escapeHtml(f.name)}</div>
          <div class="sub">${escapeHtml(sub)} ${badge}</div></div>
        <button type="button" class="pf-remove" data-id="${f.id}" aria-label="Remove ${escapeHtml(f.name)}">✕</button>
      </div>`;
    })
    .join("");
  const convHtml = conversations
    .map(
      (c) => `
    <div class="history-item">
      <button type="button" class="history-open pconv" data-id="${c.id}">
        <span class="history-title">${escapeHtml(c.title)}</span>
        <span class="history-when">${new Date(c.updatedAt).toLocaleDateString()}</span>
      </button>
    </div>`,
    )
    .join("");

  const CHAT_PLUS_ICON =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/></svg>';
  const TRASH_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  const ADD_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';

  // Projects are cloud-stored implicitly, like everything on this tier —
  // no per-project switch (2026-07-16 directive). Icon-only controls: a
  // speech bubble with a plus starts a chat in the project, the trashcan
  // (confirmed) deletes it; renaming is a double-tap on the title in the
  // header — no button.
  body.innerHTML = `
    ${cloudUsable ? "" : `<p class="muted setting-desc">Cloud storage isn't available on this account, so this project stays in this browser.</p>`}
    <div class="settings-item project-vault"${cloudUsable ? "" : " hidden"}>
      <div class="settings-row">
        <span class="settings-label">Encrypted copy, keyed by a secret</span>
        <button type="button" id="pvaultstore">${p.vaultId ? "Store again" : "Store"}</button>
      </div>
      <p class="muted setting-desc">Packs this project — chats, files, and its search index — and encrypts
        everything in this browser with a new one-time secret before storing the unreadable archive in the
        cloud. Unlike the regular cloud copy, the server can never locate or read this one — only the
        secret loads it back.${p.vaultId ? " Storing again replaces the copy — the previous secret stops working." : ""}</p>
      <div id="pvaultsecret" hidden>
        <p class="muted setting-desc vault-warn">Copy the secret now — it is shown only this once and is the
          ONLY way to load this copy. Anyone holding it (on this account) can load the project.</p>
        <div class="vault-secret-row">
          <code id="pvaultsecrettext" class="vault-secret"></code>
          <button type="button" id="pvaultcopy">Copy</button>
        </div>
      </div>
      <p id="pvaultstatus" class="muted setting-desc" hidden></p>
    </div>
    <div class="project-actions">
      <button type="button" id="pchat" class="icon-btn" title="New chat in project" aria-label="New chat in project">${CHAT_PLUS_ICON}</button>
      <span class="flex-spacer"></span>
      <button type="button" id="pdelete" class="icon-btn danger" title="Delete project" aria-label="Delete project">${TRASH_ICON}</button>
    </div>
    <input type="file" id="pfileinput" multiple hidden>
    <p id="pstatus" class="muted" hidden></p>
    <p class="section-lbl">Files &amp; notes</p>
    <div id="pdrop" class="project-drop">
      ${filesHtml}
      <button type="button" id="pfiles" class="pf-add" title="Add files" aria-label="Add files">${ADD_ICON}${filesHtml ? "" : '<span class="pf-add-hint">Add files — or drop them here</span>'}</button>
    </div>
    <div id="ptextform">
      <input type="text" id="ptexttitle" placeholder="Note title" maxlength="120">
      <textarea id="ptextcontent" rows="3" placeholder="Write a note — it's indexed like a document"></textarea>
      <div class="project-actions">
        <button type="button" id="ptextsave">Save note</button>
      </div>
    </div>
    <p class="section-lbl">Chats in this project</p>
    ${convHtml || '<p class="muted">No chats yet — the 💬+ button starts one.</p>'}
  `;
  wirePanel(p);

  // Images added before thumbnails existed: rebuild previews from the
  // OPFS originals in the background and re-render once if any appeared.
  const missing = (p.files || []).filter((f) => f.kind === "image" && !f.thumb);
  if (missing.length) {
    Promise.all(missing.map((f) => ensureThumb(p.id, f.id).catch(() => false))).then((made) => {
      if (made.some(Boolean) && openPanelId === p.id) renderPanel();
    });
  }
}

function status(msg) {
  const el = document.getElementById("pstatus");
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
}

function wirePanel(p) {
  const body = document.getElementById("projectbody");

  // ---- the encrypted vault copy (public/js/vault.js) --------------------
  const vaultBtn = document.getElementById("pvaultstore");
  const vaultStatus = document.getElementById("pvaultstatus");
  const setVaultStatus = (msg) => {
    vaultStatus.hidden = !msg;
    vaultStatus.textContent = msg || "";
  };
  vaultBtn?.addEventListener("click", async () => {
    vaultBtn.disabled = true;
    document.getElementById("pvaultsecret").hidden = true;
    try {
      const r = await storeProjectToVault(p.id, setVaultStatus);
      const summary = `Stored: ${r.counts.conversations} chat(s), ${r.counts.files} file(s), ${r.counts.docs} index document(s).`;
      setVaultStatus(
        r.missingFiles.length
          ? `${summary} ${r.missingFiles.length} file(s) had no local original and were left out: ${r.missingFiles.join(", ")}.`
          : summary,
      );
      // The one and only display of the secret — it is never persisted.
      document.getElementById("pvaultsecrettext").textContent = r.secret;
      document.getElementById("pvaultsecret").hidden = false;
      vaultBtn.textContent = "Store again";
    } catch (err) {
      setVaultStatus(err?.message || "Storing the encrypted copy failed.");
    } finally {
      vaultBtn.disabled = false;
    }
  });
  document.getElementById("pvaultcopy")?.addEventListener("click", async () => {
    const text = document.getElementById("pvaultsecrettext").textContent;
    const btn = document.getElementById("pvaultcopy");
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied ✓";
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 2000);
    } catch {
      // Clipboard API denied (some in-app browsers): select the secret so a
      // manual copy is one keystroke away.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("pvaultsecrettext"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = "Select + copy manually";
    }
  });

  // ---- chat / rename / delete ------------------------------------------
  document.getElementById("pchat").addEventListener("click", () => {
    setActiveProject(p.id);
    onNew(true); // keepProject: fresh chat, first send adopts the active project
    closePanel();
  });
  document.getElementById("pdelete").addEventListener("click", async () => {
    if (!confirm(`Delete "${p.name}" with its files and chats? This can't be undone.`)) return;
    status("Deleting project…");
    await deleteProject(p.id);
    renderProjectsList();
    closePanel();
    onNew();
  });

  // ---- add files (picker + drag-and-drop) --------------------------------
  const input = document.getElementById("pfileinput");
  document.getElementById("pfiles").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    await ingest(files);
  });
  const drop = document.getElementById("pdrop");
  for (const evt of ["dragover", "dragenter"]) {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
  }
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("dragging");
    await ingest([...(e.dataTransfer?.files || [])]);
  });

  async function ingest(files) {
    if (!files.length) return;
    status("Adding files…");
    const { errors } = await addFilesToProject(p.id, files, status);
    status(errors.length ? "Some files failed: " + errors.join("; ") : "");
    await renderPanel();
    renderProjectsList();
  }

  // ---- the note form (always open — no toggle button) ----------------------
  document.getElementById("ptextsave").addEventListener("click", async () => {
    const title = document.getElementById("ptexttitle").value;
    const content = document.getElementById("ptextcontent").value;
    if (!content.trim() && !title.trim()) return;
    status("Indexing note…");
    try {
      await addTextToProject(p.id, title, content);
      status("");
      await renderPanel(); // also clears the form for the next note
      renderProjectsList();
    } catch (err) {
      status(err?.message || "Could not save the note.");
    }
  });

  // ---- file removal + opening chats ---------------------------------------
  body.querySelectorAll(".pf-remove").forEach((el) => {
    el.addEventListener("click", async () => {
      if (!confirm("Remove this file from the project?")) return;
      await removeFileFromProject(p.id, el.dataset.id);
      await renderPanel();
      renderProjectsList();
    });
  });
  body.querySelectorAll(".history-open.pconv").forEach((el) => {
    el.addEventListener("click", async () => {
      const record = await loadConversation(el.dataset.id);
      if (!record) return;
      applyLoadedConversation({ ...record, id: el.dataset.id });
      onLoad(record);
      closePanel();
    });
  });
}

