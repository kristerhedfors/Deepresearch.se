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
    // Always-on one-line status: which build this is and what this device
    // actually holds — the ground truth that a screenshot of the pane can
    // carry to a debugging session (a stale cached client, the leading
    // suspect for "works in tests, empty on the phone", outs itself by
    // showing no stamp at all).
    const pullBit = lastPull
      ? ` · cloud: ${lastPull.checked} checked, ${lastPull.pulled} restored${lastPull.failed ? `, ${lastPull.failed} failed` : ""}`
      : pulling ? " · cloud: checking…" : "";
    parts.push(`[h11 · ${plain.length} here${items.length - plain.length ? ` + ${items.length - plain.length} in projects` : ""}${skipped ? ` + ${skipped} unreadable` : ""}${pullBit}${cssBit()}]`);
    baseNote = parts.join(" ");
    updateNote();
  }

  // Stylesheet freshness — checked HERE (not only in app.js) because a
  // wedged device can hold a stale module MIX where app.js (and its
  // handshake) is old while this module is current. A mismatched
  // stylesheet gets one force-refresh per page load, and the stamp
  // shows what was seen so the state is visible in any report.
  const CSS_WANT = "h9";
  let cssFixTried = false;
  function cssBit() {
    let seen = "";
    try {
      seen = getComputedStyle(document.documentElement).getPropertyValue("--css-version").trim();
    } catch { /* leave empty */ }
    if (seen === CSS_WANT) return "";
    if (!cssFixTried) {
      cssFixTried = true;
      fetch("/css/app.css", { cache: "reload" })
        .then(() => {
          const link = document.querySelector('link[rel="stylesheet"][href*="app.css"]');
          if (link) link.href = "/css/app.css?v=" + CSS_WANT;
          setTimeout(() => { if (!overlay.hidden) refresh(); }, 400);
        })
        .catch(() => {});
    }
    return ` · css ${seen || "old"}→refreshing`;
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
    // At REST a chat row contains ONLY the open button — the exact
    // structure of a project row. That's load-bearing on iOS: rows that
    // permanently carry an absolutely-positioned (even invisible) action
    // strip inside the backdrop-filtered panel render INVISIBLE on real
    // iOS Safari (2026-07-08 device incident; Linux WebKit can't
    // reproduce it). The strip is mounted lazily by attachSwipe when a
    // swipe or hover actually happens, and removed again on close.
    list.innerHTML = items
      .map(
        (c) => `
      <div class="history-item${c.id === activeId ? " active" : ""}" data-id="${c.id}">
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
          closeActions(item);
          return;
        }
        openConversation(el.dataset.id);
      });
    });
  }

  // Mount the rename/delete strip into a row on demand (see renderList's
  // comment for why it can't live in the markup permanently). EVERY
  // style the interaction depends on is INLINE: a device wedged on a
  // stale cached stylesheet (2026-07-08: one had a pre-swipe app.css
  // that knew no .history-actions layout — the strip rendered as a
  // plain block and shoved the card downward, with the buttons hidden
  // by an old opacity rule) must still get a working, correctly-laid-
  // out swipe. The classes remain for fresh-CSS cosmetics only.
  const BTN_CSS =
    "flex:none;width:36px;height:36px;border-radius:10px;display:grid;" +
    "place-items:center;padding:0;background:rgba(255,255,255,.45);" +
    "border:1px solid rgba(255,255,255,.55);opacity:1;";
  function mountActions(item) {
    let strip = item.querySelector(".history-actions");
    if (strip) return strip;
    strip = document.createElement("div");
    strip.className = "history-actions";
    strip.style.cssText =
      "position:absolute;top:0;right:0;bottom:0;width:88px;display:flex;" +
      "align-items:center;justify-content:flex-end;gap:.35rem;" +
      "padding-right:.2rem;margin:0;opacity:0;pointer-events:none;";
    strip.innerHTML =
      `<button type="button" class="history-rename" style="${BTN_CSS}color:#2f5d8e;" title="Rename" aria-label="Rename conversation">${PENCIL_SVG}</button>` +
      `<button type="button" class="history-delete" style="${BTN_CSS}color:#d64545;" title="Delete" aria-label="Delete conversation">${TRASH_SVG}</button>`;
    const id = item.dataset.id;
    strip.querySelector(".history-rename").addEventListener("click", (e) => {
      e.stopPropagation();
      renameConversation(id);
    });
    strip.querySelector(".history-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      removeConversation(id);
    });
    item.insertBefore(strip, item.firstChild);
    return strip;
  }
  function showStrip(strip, on) {
    if (!strip) return;
    strip.style.opacity = on ? "1" : "0";
    strip.style.pointerEvents = on ? "auto" : "none";
  }

  // Slide the card back (if it's out) and restore the rest-state DOM
  // once the settle animation has finished. All inline styles — see
  // mountActions for why nothing here may depend on the stylesheet.
  function closeActions(item) {
    const row = item.querySelector(".history-open");
    showStrip(item.querySelector(".history-actions"), false);
    if (item.classList.contains("swiped")) {
      item.classList.remove("swiped");
      row.style.transition = "margin-left .18s ease";
      row.style.marginLeft = "0px";
    }
    setTimeout(() => {
      if (item.classList.contains("swiped")) return; // re-opened meanwhile
      item.classList.remove("swiping");
      row.style.transition = "";
      row.style.marginLeft = "";
      item.style.overflow = "";
      const strip = item.querySelector(".history-actions");
      if (strip && !item.matches(":hover")) strip.remove();
    }, 200);
  }

  // Touch swipe-to-reveal: dragging a row left slides it over by the
  // action strip's width, exposing rename + delete. Swiping back (or
  // tapping the row, or swiping any other row) closes it. Mouse users
  // keep the hover reveal; this only drives touch/pen. The card follows
  // the finger via inline margin-left — pure layout, NEVER transform
  // (transforms on these rows break painting on real iOS, see app.css) —
  // then settles parked at -REVEAL_PX (.swiped) or back at rest, where
  // every interaction artifact (strip, clip, margin) is removed again.
  //
  // GESTURE PLUMBING (2026-07-08, real-device iteration 5): on real iOS
  // Safari the drag must be driven by TOUCH events with preventDefault()
  // once horizontal intent is detected. Pointer events + touch-action:
  // pan-y are NOT honored for a horizontal drag inside this vertically
  // scrollable panel — iOS starts a native scroll (the list visibly
  // nudges a few px), fires pointercancel, and never delivers the moves,
  // so the card never slides. Synthetic-event tests can't catch this
  // (they bypass native gesture arbitration); only a real device shows it.
  const REVEAL_PX = 88; // matches .history-actions width in app.css
  function attachSwipe(item) {
    const row = item.querySelector(".history-open");
    let startX = 0, startY = 0, axis = null, tracking = false;

    function claim() {
      // Mark the gesture so the tap that may follow doesn't open the chat.
      item.dataset.swipeLock = "1";
      mountActions(item);
      item.classList.add("swiping");
      item.style.overflow = "hidden";
      // Close any other card that's sitting open.
      list.querySelectorAll(".history-item.swiped").forEach((other) => {
        if (other !== item) closeActions(other);
      });
    }

    function drag(dx) {
      const from = item.classList.contains("swiped") ? -REVEAL_PX : 0;
      const offset = Math.max(-REVEAL_PX, Math.min(0, from + dx));
      row.style.transition = "none"; // follow the finger, no easing lag
      row.style.marginLeft = offset + "px";
      // The strip (painting above the static card) fades in as the gap opens.
      const strip = item.querySelector(".history-actions");
      if (strip) strip.style.opacity = String(Math.min(1, -offset / REVEAL_PX));
    }

    function finish(dx, aborted) {
      const from = item.classList.contains("swiped") ? -REVEAL_PX : 0;
      const offset = aborted ? 0 : from + dx;
      if (offset < -REVEAL_PX / 2) {
        row.style.transition = "margin-left .18s ease";
        row.style.marginLeft = -REVEAL_PX + "px";
        item.classList.add("swiped");
        showStrip(item.querySelector(".history-actions"), true);
        setTimeout(() => { item.classList.remove("swiping"); }, 200);
      } else {
        closeActions(item);
      }
      // Let the click that follows the gesture see the lock, then clear it.
      setTimeout(() => { delete item.dataset.swipeLock; }, 0);
    }

    function moveLogic(dx, dy, preventDefaultFn) {
      if (!axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (axis === "x") claim();
      }
      if (axis !== "x") return;
      preventDefaultFn(); // keep iOS from stealing the gesture for scroll
      drag(dx);
    }

    if ("ontouchstart" in window) {
      // iOS choreography (real-device iteration 6): ALL DOM/style
      // mutations happen at TOUCHSTART — mounting the strip or toggling
      // overflow once the finger is moving makes iOS CANCEL the active
      // touch (h7–h10: strip flashed, card snapped back, list nudged).
      // The axis is decided at ~4px of movement — before iOS's own
      // ~10px scroll slop commits — and the first claimed move calls
      // preventDefault() so the panel never starts scrolling. A
      // touchcancel after the claim honors the drag done so far
      // instead of snapping back.
      let lastDx = 0;
      // Undo the touchstart pre-mutations for a gesture that turned out
      // to be a tap or a vertical scroll — nothing visible ever changed.
      function releaseRest() {
        if (item.classList.contains("swiped") || item.classList.contains("swiping")) return;
        item.style.overflow = "";
        const strip = item.querySelector(".history-actions");
        if (strip && !item.matches(":hover")) strip.remove();
      }
      item.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        tracking = true;
        axis = null;
        lastDx = 0;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        mountActions(item);
        item.style.overflow = "hidden";
      }, { passive: true });
      // passive: false — preventDefault() must actually work here.
      item.addEventListener("touchmove", (e) => {
        if (!tracking || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (!axis) {
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
          if (axis === "x") {
            item.dataset.swipeLock = "1";
            item.classList.add("swiping");
            list.querySelectorAll(".history-item.swiped").forEach((other) => {
              if (other !== item) closeActions(other);
            });
          } else {
            releaseRest(); // vertical: hand the gesture back to the scroller
          }
        }
        if (axis !== "x") return;
        if (e.cancelable) e.preventDefault();
        lastDx = dx;
        drag(dx);
      }, { passive: false });
      const end = () => {
        if (!tracking) return;
        tracking = false;
        if (axis === "x") finish(lastDx, false);
        else releaseRest();
      };
      item.addEventListener("touchend", end);
      item.addEventListener("touchcancel", end);
    } else {
      item.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        tracking = true;
        axis = null;
        startX = e.clientX;
        startY = e.clientY;
      });
      item.addEventListener("pointermove", (e) => {
        if (!tracking) return;
        moveLogic(e.clientX - startX, e.clientY - startY, () => {});
      });
      const settle = (e) => {
        if (!tracking) return;
        tracking = false;
        if (axis !== "x") return;
        // pointercancel's coordinates are unreliable: treat as aborted.
        finish(e.clientX - startX, e.type === "pointercancel");
      };
      item.addEventListener("pointerup", settle);
      item.addEventListener("pointercancel", settle);
    }

    // Mouse hover shows the strip as an overlay (no slide); leaving
    // removes it again (unless swiped open).
    item.addEventListener("mouseenter", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      showStrip(mountActions(item), true);
    });
    item.addEventListener("mouseleave", () => {
      if (!item.classList.contains("swiped")) closeActions(item);
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
          // successes. But NEVER rebuild the list mid-interaction — a
          // re-render destroys the card the finger is dragging (observed
          // as the card "switching places" on a real device).
          if (!overlay.hidden && !list.querySelector(".swiping, .swiped")) refresh();
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
    // (and the active highlight) only if the panel is actually open (and
    // no card is mid-swipe — a rebuild would destroy it under the finger),
    // so a background chat doesn't do decrypt-everything work for no reason.
    onSaved: () => {
      if (!overlay.hidden && !list.querySelector(".swiping, .swiped")) refresh();
    },
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
