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
  setProjectCloud,
} from "./projects.js";
import { storageAvailable } from "./settings.js";
import { applyLoadedConversation } from "./stream.js";
import { drainProjectScope, pushProjectScope } from "./sync.js";

let onLoad = () => {};
let onNew = () => {};
let openPanelId = null;

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

  const overlay = document.getElementById("projectpanel");
  document.getElementById("projectclose").addEventListener("click", closePanel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePanel();
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
        <span class="history-when">${(p.files || []).length} file(s)${p.serverStorage === false ? " · local only" : ""}</span>
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

export async function openProjectPanel(id) {
  openPanelId = id;
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

  // The knob sits AT THE TOP of the open project — the same slide switch
  // as the account setting, scoped to this project. Below it, icon-only
  // controls: a speech bubble with a plus starts a chat in the project,
  // the trashcan (confirmed) deletes it; renaming is a double-tap on the
  // title in the header — no button.
  body.innerHTML = `
    <div class="settings-item project-knob">
      <div class="settings-row">
        <span class="settings-label">Store this project in the cloud</span>
        <label class="switch">
          <input type="checkbox" id="projectcloud"${p.serverStorage !== false ? " checked" : ""}${cloudUsable ? "" : " disabled"}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <p id="projectsyncstatus" class="muted setting-desc"${cloudUsable ? " hidden" : ""}>${cloudUsable ? "" : "Cloud storage isn't available on this account, so this project stays in this browser."}</p>
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

  // ---- the per-project cloud knob -------------------------------------
  const knob = document.getElementById("projectcloud");
  const kstatus = document.getElementById("projectsyncstatus");
  knob?.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    kstatus.hidden = false;
    const progress = (m) => { kstatus.textContent = m; };
    try {
      await setProjectCloud(p.id, on);
      if (on) {
        const r = await pushProjectScope(p.id, progress);
        kstatus.textContent =
          `This project is stored in the cloud — ${r.pushed} item(s) uploaded.` +
          (r.errors.length ? ` ${r.errors.length} failed (will retry on the next sync).` : "");
      } else {
        const r = await drainProjectScope(p.id, progress);
        kstatus.textContent = r.drained
          ? `This project now lives only in this browser — ${r.removed} cloud object(s) removed.`
          : "Some items couldn't be confirmed locally — their cloud copies were kept. Toggle again to retry.";
        if (!r.drained) {
          await setProjectCloud(p.id, true); // don't pretend it's local-only
          knob.checked = true;
        }
      }
      renderProjectsList();
    } catch (err) {
      knob.checked = !on;
      kstatus.textContent = err?.message || "Could not update the project setting.";
    } finally {
      knob.disabled = false;
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

