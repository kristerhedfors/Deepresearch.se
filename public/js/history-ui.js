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
  undecryptableConversations,
} from "./history-store.js";
import { renderProjectsList } from "./projects-ui.js";
import { loadSettings, serverHistoryOn, settingsLoaded, storageAvailable } from "./settings.js";
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

  // Diagnostic note under the list: an empty pane must SAY why it's empty
  // (records that won't decrypt, a cloud restore in progress) instead of
  // looking identical to "no chats saved" — that silent ambiguity cost
  // real debugging time on 2026-07-08.
  const note = document.createElement("p");
  note.className = "history-note";
  note.hidden = true;
  list.after(note);
  let baseNote = "";
  let pulling = false;
  let lastPull = null; // result of this pane-open's pullNewer, once it lands
  function updateNote() {
    const text = pulling ? "Checking the cloud for conversations…" : baseNote;
    note.textContent = text;
    note.hidden = !text;
  }

  async function refresh() {
    list.innerHTML = '<p class="muted">Loading…</p>';
    renderProjectsList().catch(() => {});
    const items = await listConversations();
    // Project conversations live inside their project's panel — the main
    // list shows plain chats only, so nothing appears twice.
    const plain = items.filter((c) => !c.projectId);
    renderList(plain);

    // An empty (or thinned) pane must explain itself — every silent branch
    // here has been mistaken for data loss at least once (2026-07-08).
    const parts = [];
    const skipped = undecryptableConversations();
    if (skipped) {
      parts.push(`${skipped} saved conversation${skipped === 1 ? "" : "s"} can't be decrypted on this device right now — not deleted, just unreadable with the current key. Reload the page (signed in) and reopen this panel to retry.`);
    }
    if (!plain.length) {
      const projectChats = items.length - plain.length;
      if (projectChats) parts.push(`${projectChats} conversation${projectChats === 1 ? " lives" : "s live"} inside projects — open the project to see them.`);
      if (!settingsLoaded()) parts.push("Account settings couldn't be loaded, so cloud copies weren't checked — reload the page to retry.");
      else if (!storageAvailable()) parts.push("Cloud storage isn't available for this account, so only this device's copies can be shown.");
      else if (!serverHistoryOn()) parts.push("Cloud backup is switched off in Settings, so only this device's copies can be shown.");
      else if (lastPull) {
        if (lastPull.failed) parts.push(`Cloud restore incomplete: ${lastPull.pulled} restored, ${lastPull.failed} failed — reopen this panel to retry.`);
        else if (lastPull.checked && lastPull.pulled) parts.push(`${lastPull.pulled} conversation${lastPull.pulled === 1 ? " was" : "s were"} restored from the cloud but this device's storage didn't keep them — fully close and reopen the app, then reopen this panel.`);
        else if (lastPull.checked) parts.push(`The cloud holds ${lastPull.checked} conversation${lastPull.checked === 1 ? "" : "s"} but none could be restored here — fully close and reopen the app, then reopen this panel.`);
      }
    }
    baseNote = parts.join(" ");
    updateNote();
  }

  const PENCIL_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  const TRASH_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  function renderList(items) {
    if (!items.length) {
      list.innerHTML = '<p class="muted">No saved conversations yet.</p>';
      return;
    }
    const activeId = currentConversationId();
    list.innerHTML = items
      .map(
        (c) => `
      <div class="history-item${c.id === activeId ? " active" : ""}" data-id="${c.id}">
        <div class="history-actions">
          <button type="button" class="history-rename" data-id="${c.id}" title="Rename" aria-label="Rename conversation">${PENCIL_SVG}</button>
          <button type="button" class="history-delete" data-id="${c.id}" title="Delete" aria-label="Delete conversation">${TRASH_SVG}</button>
        </div>
        <button type="button" class="history-open" data-id="${c.id}">
          <span class="history-title">${escapeHtml(c.title)}</span>
          <span class="history-when">${relativeTime(c.updatedAt)}</span>
        </button>
      </div>`,
      )
      .join("");

    list.querySelectorAll(".history-item").forEach(attachSwipe);
    list.querySelectorAll(".history-open").forEach((el) => {
      el.addEventListener("click", () => {
        // A tap on a swiped-open row (or right after a swipe gesture)
        // just closes the actions — it shouldn't also open the chat.
        const item = el.closest(".history-item");
        if (item.dataset.swipeLock === "1" || item.classList.contains("swiped")) {
          delete item.dataset.swipeLock;
          item.classList.remove("swiped");
          return;
        }
        openConversation(el.dataset.id);
      });
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

  // Touch swipe-to-reveal: dragging a row left slides it over by the
  // action strip's width, exposing rename + delete. Swiping back (or
  // tapping the row, or swiping any other row) closes it. Mouse users
  // keep the hover reveal (app.css); this only drives touch/pen.
  const REVEAL_PX = 88; // matches .history-actions width in app.css
  function attachSwipe(item) {
    const row = item.querySelector(".history-open");
    let startX = 0, startY = 0, axis = null, tracking = false;

    item.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      tracking = true;
      axis = null;
      startX = e.clientX;
      startY = e.clientY;
    });

    item.addEventListener("pointermove", (e) => {
      if (!tracking) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (axis === "x") {
          // Claim the gesture so a stray tap at the end doesn't open the chat.
          item.dataset.swipeLock = "1";
          // Close any other row that's sitting open.
          list.querySelectorAll(".history-item.swiped").forEach((other) => {
            if (other !== item) other.classList.remove("swiped");
          });
        }
      }
      if (axis !== "x") return;
      const from = item.classList.contains("swiped") ? -REVEAL_PX : 0;
      const offset = Math.max(-REVEAL_PX, Math.min(0, from + dx));
      row.style.transition = "none";
      row.style.transform = `translateX(${offset}px)`;
    });

    function settle(e) {
      if (!tracking) return;
      tracking = false;
      if (axis !== "x") return;
      const from = item.classList.contains("swiped") ? -REVEAL_PX : 0;
      const offset = from + (e.clientX - startX);
      // Hand the final position back to the CSS class + its transition.
      row.style.transition = "";
      row.style.transform = "";
      item.classList.toggle("swiped", offset < -REVEAL_PX / 2);
      // Let the click that follows this pointerup see the lock, then clear it.
      setTimeout(() => { delete item.dataset.swipeLock; }, 0);
    }
    item.addEventListener("pointerup", settle);
    item.addEventListener("pointercancel", settle);
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
    // Cloud-storage accounts: fetch anything newer written from another
    // device (no-op while the knob is off) and re-render if it actually
    // brought something down. Visible while it runs — a device restoring
    // its whole history pulls for several seconds and must not read as
    // "no saved conversations" meanwhile.
    lastPull = null;
    if (serverHistoryOn()) {
      pulling = true;
      updateNote();
      pullNewer()
        .then((res) => { lastPull = res; })
        .catch(() => { lastPull = { ran: true, checked: 0, pulled: 0, failed: 1 }; })
        .finally(() => {
          pulling = false;
          // Re-render regardless of the count: the note must reflect the
          // pull's outcome (including "nothing came down"), not just its
          // successes.
          if (!overlay.hidden) refresh();
          else updateNote();
        });
    } else if (settingsLoaded() === false) {
      // Settings never loaded (likely an auth/network failure at boot) —
      // retry now so a recovered session heals without a full reload.
      loadSettings(true)
        .then(() => { if (!overlay.hidden) open(); })
        .catch(() => { if (!overlay.hidden) refresh(); });
    }
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
