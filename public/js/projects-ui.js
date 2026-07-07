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
      return `
      <div class="project-file" data-id="${f.id}">
        <span class="icon">${KIND_ICON[f.kind] || "📎"}</span>
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

  // The knob sits AT THE TOP of the open project — the same slide switch
  // as the account setting, scoped to this project.
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
      <button type="button" id="pchat">New chat in project</button>
      <button type="button" id="pfiles">Add files</button>
      <button type="button" id="ptext">Add text</button>
      <button type="button" id="prename">Rename</button>
      <button type="button" id="pdelete" class="danger">Delete project</button>
    </div>
    <input type="file" id="pfileinput" multiple hidden>
    <div id="ptextform" hidden>
      <input type="text" id="ptexttitle" placeholder="Title" maxlength="120">
      <textarea id="ptextcontent" rows="5" placeholder="Content"></textarea>
      <div class="project-actions">
        <button type="button" id="ptextsave">Save note</button>
        <button type="button" id="ptextcancel">Cancel</button>
      </div>
    </div>
    <p id="pstatus" class="muted" hidden></p>
    <p class="section-lbl">Files &amp; notes</p>
    <div id="pdrop" class="project-drop">${filesHtml || '<p class="muted">No files yet — add some, or drop them here.</p>'}</div>
    <p class="section-lbl">Chats in this project</p>
    ${convHtml || '<p class="muted">No chats yet — "New chat in project" starts one.</p>'}
  `;
  wirePanel(p);
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
  document.getElementById("prename").addEventListener("click", async () => {
    const name = prompt("Rename project", p.name);
    if (!name || !name.trim()) return;
    await renameProject(p.id, name);
    await renderPanel();
    renderProjectsList();
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

  // ---- add text (title + content) ----------------------------------------
  const form = document.getElementById("ptextform");
  document.getElementById("ptext").addEventListener("click", () => {
    form.hidden = false;
    document.getElementById("ptexttitle").focus();
  });
  document.getElementById("ptextcancel").addEventListener("click", () => { form.hidden = true; });
  document.getElementById("ptextsave").addEventListener("click", async () => {
    const title = document.getElementById("ptexttitle").value;
    const content = document.getElementById("ptextcontent").value;
    if (!content.trim() && !title.trim()) return;
    status("Indexing note…");
    try {
      await addTextToProject(p.id, title, content);
      status("");
      await renderPanel();
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

