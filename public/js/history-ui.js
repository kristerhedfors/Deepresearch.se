// Left-side "chat history" drawer: lists this browser's locally-stored,
// encrypted past conversations (public/js/history-store.js) — labelled by
// their first question, clickable to reopen, renamable, deletable. The
// header's history button hides itself entirely when encrypted history
// isn't available (server not configured, or no IndexedDB) rather than
// offering a feature that silently can't persist anything.

import { escapeHtml } from "./notifications.js";
import {
  deleteConversation,
  historyAvailable,
  listConversations,
  loadConversation,
  saveConversation,
} from "./history-store.js";
import { renderProjectsList } from "./projects-ui.js";
import { applyLoadedConversation, currentConversationId } from "./stream.js";
import { pullNewer } from "./sync.js";

// opts: {onNew, onLoad(record)} — both provided by app.js, which owns the
// composer state (model/budget/search-toggle) this module has no access to.
export function initHistorySidebar(opts = {}) {
  const btn = document.getElementById("historybtn");
  const overlay = document.getElementById("historysidebar");
  const list = document.getElementById("historylist");
  const closeBtn = document.getElementById("historyclose");
  const newBtn = document.getElementById("historynewbtn");
  const onNew = opts.onNew || (() => {});
  const onLoad = opts.onLoad || (() => {});

  historyAvailable().then((ok) => { btn.hidden = !ok; });

  async function refresh() {
    list.innerHTML = '<p class="muted">Loading…</p>';
    renderProjectsList().catch(() => {});
    const items = await listConversations();
    // Project conversations live inside their project's panel — the main
    // list shows plain chats only, so nothing appears twice.
    renderList(items.filter((c) => !c.projectId));
  }

  function renderList(items) {
    if (!items.length) {
      list.innerHTML = '<p class="muted">No saved conversations yet.</p>';
      return;
    }
    const activeId = currentConversationId();
    list.innerHTML = items
      .map(
        (c) => `
      <div class="history-item${c.id === activeId ? " active" : ""}">
        <button type="button" class="history-open" data-id="${c.id}">
          <span class="history-title">${escapeHtml(c.title)}</span>
          <span class="history-when">${relativeTime(c.updatedAt)}</span>
        </button>
        <button type="button" class="history-rename" data-id="${c.id}" title="Rename" aria-label="Rename conversation">✎</button>
        <button type="button" class="history-delete" data-id="${c.id}" title="Delete" aria-label="Delete conversation">🗑</button>
      </div>`,
      )
      .join("");

    list.querySelectorAll(".history-open").forEach((el) => {
      el.addEventListener("click", () => openConversation(el.dataset.id));
    });
    list.querySelectorAll(".history-rename").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        renameConversation(el.dataset.id);
      });
    });
    list.querySelectorAll(".history-delete").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        removeConversation(el.dataset.id);
      });
    });
  }

  async function openConversation(id) {
    const record = await loadConversation(id);
    if (!record) return;
    applyLoadedConversation({ ...record, id });
    onLoad(record);
    close();
  }

  async function renameConversation(id) {
    const record = await loadConversation(id);
    if (!record) return;
    const name = prompt("Rename conversation", record.title);
    if (!name || !name.trim()) return;
    await saveConversation(id, { ...record, title: name.trim().slice(0, 60) });
    refresh();
  }

  async function removeConversation(id) {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    await deleteConversation(id);
    if (id === currentConversationId()) onNew();
    refresh();
  }

  // Pin the drawer's ✕ to the exact screen rect of the header's history
  // button, so on a phone the same tap position opens and closes the
  // drawer (the fixed-position styling lives in app.css).
  function placeCloseBtn() {
    const r = btn.getBoundingClientRect();
    if (!r.width) return; // button hidden/unlaid-out: keep the CSS fallback
    closeBtn.style.top = r.top + "px";
    closeBtn.style.left = r.left + "px";
    closeBtn.style.width = r.width + "px";
    closeBtn.style.height = r.height + "px";
  }

  // Slide animation (app.css): .open drives the panel/backdrop transition;
  // hidden is only flipped once the slide-out has finished so the drawer
  // animates instead of popping. Kept at ~180ms — fast, just not abrupt.
  const ANIM_MS = 200;
  let hideTimer = null;

  function open() {
    clearTimeout(hideTimer);
    placeCloseBtn();
    overlay.hidden = false;
    // Two frames so the browser paints the closed state first — adding
    // .open in the same frame would skip the transition entirely.
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("open")));
    refresh();
    // Cloud-storage accounts: quietly fetch anything newer written from
    // another device (no-op while the knob is off) and re-render if it
    // actually brought something down.
    pullNewer().then((n) => { if (n && !overlay.hidden) refresh(); }).catch(() => {});
  }
  function close() {
    overlay.classList.remove("open");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { overlay.hidden = true; }, ANIM_MS);
  }

  btn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  newBtn.addEventListener("click", () => {
    onNew();
    close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("resize", () => {
    if (!overlay.hidden) placeCloseBtn();
  });

  return {
    // stream.js calls this after every autosaved turn — refresh the list
    // (and the active highlight) only if the panel is actually open, so a
    // background chat doesn't do decrypt-everything work for no reason.
    onSaved: () => { if (!overlay.hidden) refresh(); },
  };
}

function relativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + "d ago";
  return new Date(ts).toLocaleDateString();
}
