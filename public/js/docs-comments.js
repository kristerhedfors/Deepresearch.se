// Documentation COMMENT MODE (owner directive, 2026-07-25) — the Word
// convention: a mode control that switches between reading and commenting,
// and in comment mode you mark a passage and write a note against it.
//
// This module is the UI half; the format, the anchoring and the doc⇄code
// contract live in the pure core (docs-comments-core.js), and the storage is
// the feedback pipeline — a comment is a feedback entry with the "doc" scope,
// so it inherits the dialogue thread, the status lifecycle and the agent's
// replies without a second queue to keep alive. The reader shows all three
// back beside the passage: what the agent did (status), what it said (thread),
// and whether the text has been REPLACED since (the anchor going stale).
//
// SELF-CONTAINED BY DESIGN. The layer injects its own dropdown, rail and
// styles as fixed-position chrome, so it mounts on ANY documentation page
// without that page providing markup, CSS or a layout slot — /help/ (hand-
// written HTML, no other JS), /docs/ (the corpus viewer), and whatever comes
// next. The first cut hard-wired itself into one page's CSS grid, and the
// owner's actual documentation page went without it.
//
// THE PRICE OF THAT, AND WHAT IT COSTS THE READER (feedback #40, 2026-07-26).
// Taking no layout from the page means the rail cannot be a column beside the
// prose — it floats OVER it, and on a phone a 340px pane is most of the screen.
// It shipped opening by itself whenever the document had a comment on it, with
// no control to put it away: on an iPhone the reader got a dark pane over the
// documentation, in read-only mode, which they could not dismiss. So the rail
// is now something you OPEN — a ✕ in its head, the counter in the mode slot as
// the switch back in, a highlighted passage as the other way in, and read mode
// never opening it on its own (railVisible, in the core). Where it cannot avoid
// covering the prose it covers as little as it can: along the bottom on a
// phone, sized to its content, with the passage scrolled clear of it.
//
// Administrative: reached only through doc-comment-gate.js, which mounts this
// after /api/me returns an admin role. The module is deliberately NOT on the
// public asset allowlist.

import {
  buildDocCommentBody,
  docCommentsFor,
  isCommentableSelection,
  locateQuote,
  normalizeQuote,
  railVisible,
} from "./docs-comments-core.js";
import { docPageTag } from "./feedback-core.js";
import { escapeHtml } from "./markdown.js";

const STATUS_LABEL = {
  new: "sent",
  seen: "seen",
  in_progress: "being worked on",
  resolved: "done",
  declined: "declined",
};

const STYLES = `
/* BOTTOM right, not top right (fixed 2026-07-26). The top-right corner is
   already taken on every documentation page that mounts this layer — /help/ and
   /cure/help/ put their title and "← Back to the app" there, /docs/ its header
   bar — and since the layer deliberately requires no layout cooperation from
   the page, it cannot know to dodge. Measured at a real viewport, the slot
   overlapped the page header at EVERY width: 267×29px at 390, 366×13px at 820,
   136×13px at 1280 (covering the back button). The bottom-right corner is free
   on both pages, and a mode switch that stays reachable while scrolling wants
   to be there anyway. Keep the rail's bottom padding below in step with it. */
.dc-slot { position: fixed; bottom: .6rem; right: .6rem; z-index: 40;
  font: 400 .78rem/1.4 system-ui, -apple-system, sans-serif;
  display: flex; align-items: center; gap: .35rem;
  background: rgba(127,127,127,.14); border-radius: 999px; padding: .2rem .5rem .2rem .7rem;
  backdrop-filter: blur(6px); }
.dc-slot label { opacity: .7; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; }
.dc-slot select { font: inherit; padding: .16rem 1.3rem .16rem .4rem; border-radius: 999px;
  border: 1px solid rgba(127,127,127,.4); background: rgba(255,255,255,.9); color: #16202c;
  cursor: pointer; -webkit-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7'><path d='M1 1l4 4 4-4' stroke='%23555' fill='none' stroke-width='1.6'/></svg>");
  background-repeat: no-repeat; background-position: right .45rem center; }
/* The counter is the way BACK IN after the rail is closed, so it is a button,
   not a label (feedback #40). It carries the open/closed state itself — pressed
   look while the rail is up — because on a phone the rail may be the only thing
   the press visibly changed. */
.dc-count { font: inherit; font-variant-numeric: tabular-nums; cursor: pointer;
  border: 1px solid transparent; border-radius: 999px; padding: .1rem .45rem;
  background: rgba(127,127,127,.18); color: inherit; opacity: .85; }
.dc-count[hidden] { display: none; }
.dc-count[aria-expanded="true"] { background: rgba(37,99,235,.22); border-color: rgba(37,99,235,.5); opacity: 1; }

body.dc-commenting .dc-root { cursor: text; }
body.dc-commenting .dc-root a { pointer-events: none; }
.dc-root mark.dc-mark { background: rgba(240,173,78,.35); color: inherit;
  border-bottom: 2px solid #f0ad4e; border-radius: 2px; padding: 0 1px; cursor: pointer; }
.dc-root mark.dc-mark.dc-flash { background: rgba(240,173,78,.85); transition: background .3s; }

/* The rail is a HEAD + a scrolling BODY, not one scrolling box: the ✕ has to
   stay on screen however far down the comments you are — a control you can only
   reach by scrolling back up is the "no clear way to close it" of feedback #40.
   The body's padding clears the floating slot, which sits at the BOTTOM of this
   column rather than the top — so the generous end goes last. */
.dc-rail { position: fixed; top: 0; right: 0; bottom: 0; width: min(340px, 88vw); z-index: 39;
  display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
  /* OPAQUE. At .97 the prose underneath still read through the pane as grey
     ghost lines — 3% of black over a dark background is a visible difference,
     and this pane exists to be read on top of text. */
  background: #f8f9fb; border-left: 1px solid rgba(127,127,127,.3);
  font: 400 .82rem/1.5 system-ui, -apple-system, sans-serif; color: #16202c; }
.dc-rail[hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  .dc-rail { background: #121821; color: #dbe4ee; }
  .dc-slot select { background-color: rgba(30,38,50,.95); color: #dbe4ee; }
}
/* On a phone the rail can only be an overlay — the layer takes no layout from
   the page — so it sits along the BOTTOM instead of down the side, sized to its
   content up to two-thirds of the screen. The document stays legible above it,
   which is what a passage you are about to mark needs (feedback #40). */
@media (max-width: 700px) {
  .dc-rail { top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 66vh;
    border-left: none; border-top: 1px solid rgba(127,127,127,.3);
    border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(0,0,0,.18);
    overscroll-behavior: contain; }
}
.dc-railhead { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  gap: .5rem; padding: .6rem .7rem .5rem; border-bottom: 1px solid rgba(127,127,127,.2); }
.dc-railtitle { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
/* Sized for a thumb, not for a mouse pointer. */
.dc-close { font: inherit; font-size: .95rem; line-height: 1; cursor: pointer;
  min-width: 2rem; min-height: 2rem; padding: .3rem .5rem; border-radius: 8px;
  border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.12); color: inherit; }
.dc-railbody { flex: 1 1 auto; overflow-y: auto; padding: .7rem .7rem 3.5rem; }
@media (max-width: 700px) {
  .dc-railbody { padding-bottom: calc(3.2rem + env(safe-area-inset-bottom, 0px)); }
}
.dc-empty { opacity: .7; }
.dc-card, .dc-composer { background: rgba(127,127,127,.09); border: 1px solid rgba(127,127,127,.25);
  border-radius: 10px; padding: .6rem .7rem; margin-bottom: .7rem; }
.dc-card { cursor: pointer; }
.dc-card.dc-flash { border-color: #f0ad4e; background: rgba(240,173,78,.22); transition: background .3s; }
.dc-card.dc-stale-card { border-style: dashed; opacity: .85; }
.dc-composer { border-color: #2563eb; cursor: auto; }
.dc-cardhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: .4rem; }
.dc-status { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
  padding: .08rem .38rem; border-radius: 999px; background: rgba(37,99,235,.16); color: #2563eb; }
.dc-status.resolved, .dc-status.declined { background: rgba(90,160,110,.2); color: #3d8f5b; }
.dc-date { font-size: .7rem; opacity: .6; }
.dc-quote { border-left: 3px solid #f0ad4e; padding: .1rem .5rem; margin: 0 0 .45rem;
  opacity: .8; font-style: italic; }
.dc-hint { font-size: .74rem; opacity: .7; margin: .1rem 0 .5rem; }
.dc-note { white-space: pre-wrap; }
.dc-stale { font-size: .74rem; color: #b4690e; margin: .2rem 0 .45rem; }
.dc-msg { margin-top: .5rem; padding: .4rem .5rem; border-radius: 8px;
  background: rgba(127,127,127,.12); white-space: pre-wrap; }
.dc-msg.dc-agent { background: rgba(37,99,235,.12); }
.dc-who { display: block; font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
.dc-composer textarea, .dc-reply textarea { width: 100%; font: inherit; padding: .4rem .5rem;
  resize: vertical; box-sizing: border-box; border: 1px solid rgba(127,127,127,.4);
  border-radius: 8px; background: rgba(255,255,255,.75); color: inherit; }
@media (prefers-color-scheme: dark) {
  .dc-composer textarea, .dc-reply textarea { background: rgba(0,0,0,.25); }
}
.dc-actions { display: flex; align-items: center; gap: .4rem; margin-top: .4rem; flex-wrap: wrap; }
.dc-actions button { font: inherit; font-size: .76rem; padding: .22rem .6rem; cursor: pointer;
  border: 1px solid rgba(127,127,127,.4); border-radius: 7px;
  background: rgba(127,127,127,.12); color: inherit; }
.dc-actions .dc-send { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.dc-actions .dc-msgline { font-size: .74rem; opacity: .7; background: none; padding: 0; margin: 0; }
.dc-reply { margin-top: .5rem; }
`;

/**
 * Mount comment mode onto a documentation page.
 * @param {{ rootEl: HTMLElement, pathOf: () => string, textOf: () => string }} ctx
 */
export function mountDocComments(ctx) {
  const { rootEl } = ctx;
  let commenting = false;
  let composing = false;
  /** Explicit open/close by the reader; null until they touch it, and reset by
   *  a mode change so the mode's own default applies again. */
  /** @type {boolean | null} */
  let requested = null;
  /** @type {any[]} */
  let comments = [];
  /** @type {{ quote: string, section: string } | null} */
  let pending = null;

  rootEl.classList.add("dc-root");
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);

  // The mode control is a DROPDOWN (owner, 2026-07-25) — it matches the chat
  // mode selector's shape, and a native <select> is the one control that is
  // comfortable on a phone.
  const slot = document.createElement("div");
  slot.className = "dc-slot";
  slot.innerHTML =
    '<label for="dc-mode">Mode</label>' +
    '<select id="dc-mode"><option value="read">Read only</option><option value="comment">Comment</option></select>' +
    '<button type="button" class="dc-count" aria-controls="dc-rail" aria-expanded="false" hidden></button>';
  document.body.appendChild(slot);
  const select = /** @type {HTMLSelectElement} */ (slot.querySelector("select"));
  const countEl = /** @type {HTMLButtonElement} */ (slot.querySelector(".dc-count"));

  const rail = document.createElement("aside");
  rail.className = "dc-rail";
  rail.id = "dc-rail";
  rail.hidden = true;
  rail.innerHTML =
    '<div class="dc-railhead"><span class="dc-railtitle">Comments</span>' +
    '<button type="button" class="dc-close" aria-label="Close comments" title="Close">✕</button></div>' +
    '<div class="dc-railbody"></div>';
  document.body.appendChild(rail);
  const railTitle = /** @type {HTMLElement} */ (rail.querySelector(".dc-railtitle"));
  const railBody = /** @type {HTMLElement} */ (rail.querySelector(".dc-railbody"));

  select.addEventListener("change", () => setMode(select.value === "comment"));
  // Closing is not leaving comment mode: you can close the rail, keep marking
  // passages, and the next selection brings it back with the composer in it.
  rail.querySelector(".dc-close")?.addEventListener("click", () => setRail(false));
  countEl.addEventListener("click", () => setRail(rail.hidden));

  /** @param {boolean} on */
  function setMode(on) {
    commenting = on;
    select.value = on ? "comment" : "read";
    document.body.classList.toggle("dc-commenting", on);
    // A mode change is the reader saying what they are doing now, so it clears
    // whatever they asked of the rail under the previous mode.
    requested = null;
    if (!on) closeComposer();
    renderRail();
  }

  /**
   * Open or close the rail on the reader's explicit say-so.
   * @param {boolean} open
   */
  function setRail(open) {
    requested = open;
    if (!open) closeComposer();
    renderRail();
  }

  // ---- selection → composer ------------------------------------------------

  rootEl.addEventListener("mouseup", onSelect);
  rootEl.addEventListener("touchend", onSelect);

  function onSelect() {
    if (!commenting) return;
    // Let the browser settle the selection before reading it.
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      if (!isCommentableSelection(text) || !sel || !rootEl.contains(sel.anchorNode)) return;
      pending = { quote: text, section: headingAbove(sel.anchorNode) };
      const where = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      openComposer();
      keepPassageVisible(where);
    }, 0);
  }

  /**
   * Scroll the passage back into view when the rail opened over it.
   *
   * Only the bottom-anchored rail (the phone sheet) can cover the text you just
   * marked; the side rail leaves it where it was. Measuring the rail's own top
   * rather than the viewport width is what makes that distinction — a rail that
   * starts at y=0 is beside the prose, never over it.
   * @param {DOMRect | null} rect where the passage was before the rail opened
   */
  function keepPassageVisible(rect) {
    if (!rect || !rect.height || rail.hidden) return;
    requestAnimationFrame(() => {
      const top = rail.getBoundingClientRect().top;
      if (top <= 0) return; // the side rail — nothing was covered
      const overlap = rect.bottom - top + 12;
      if (overlap > 0) window.scrollBy({ top: overlap, behavior: "smooth" });
    });
  }

  /**
   * The nearest heading at or above a node — the section a passage lives in,
   * stored so a quote occurring twice still lands in the right place.
   * @param {Node | null} node
   * @returns {string}
   */
  function headingAbove(node) {
    /** @type {Element | null} */
    let el = node instanceof Element ? node : node?.parentElement || null;
    while (el && el !== rootEl) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName)) return normalizeQuote(sib.textContent);
      }
      el = el.parentElement;
    }
    return "";
  }

  // ---- the composer --------------------------------------------------------

  function openComposer() {
    closeComposer();
    if (!pending) return;
    composing = true;
    renderRail();
    const box = document.createElement("div");
    box.className = "dc-composer";
    box.innerHTML = `
      <div class="dc-quote">${escapeHtml(pending.quote.slice(0, 400))}</div>
      <p class="dc-hint">A comment here is an instruction for the documentation
        <b>and</b> the implementation it describes.</p>
      <textarea rows="4" placeholder="What should be true instead?"></textarea>
      <div class="dc-actions">
        <button type="button" class="dc-send">Comment</button>
        <button type="button" class="dc-cancel">Cancel</button>
        <span class="dc-msgline"></span>
      </div>`;
    railBody.prepend(box);
    const ta = /** @type {HTMLTextAreaElement} */ (box.querySelector("textarea"));
    ta.focus();
    box.querySelector(".dc-cancel")?.addEventListener("click", () => { closeComposer(); renderRail(); });
    box.querySelector(".dc-send")?.addEventListener("click", () => submit(box, ta));
  }

  // Also what the rail's ✕ does while a comment is being written: one press
  // gets the pane off the text, and a half-written note is not worth making the
  // reader press twice for that.
  function closeComposer() {
    composing = false;
    railBody.querySelector(".dc-composer")?.remove();
  }

  /**
   * @param {HTMLElement} box
   * @param {HTMLTextAreaElement} ta
   */
  async function submit(box, ta) {
    const note = ta.value.trim();
    const msg = /** @type {HTMLElement} */ (box.querySelector(".dc-msgline"));
    if (!note) {
      msg.textContent = "Write a comment first.";
      return;
    }
    const btn = /** @type {HTMLButtonElement} */ (box.querySelector(".dc-send"));
    btn.disabled = true;
    msg.textContent = "Sending…";
    const path = ctx.pathOf();
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          comment: buildDocCommentBody({
            path,
            section: pending?.section || "",
            quote: pending?.quote || "",
            note,
          }),
          page: docPageTag(path),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "HTTP " + res.status);
      pending = null;
      closeComposer();
      window.getSelection()?.removeAllRanges();
      await load();
    } catch (err) {
      btn.disabled = false;
      msg.textContent = /** @type {Error} */ (err)?.message || "Could not send — try again.";
    }
  }

  // ---- the rail ------------------------------------------------------------

  async function load() {
    const path = ctx.pathOf();
    if (!path) {
      comments = [];
      renderRail();
      return;
    }
    try {
      const res = await fetch(`/api/feedback?page=${encodeURIComponent(docPageTag(path))}`);
      const entries = res.ok ? (await res.json()).feedback || [] : [];
      comments = docCommentsFor(entries, { path, text: ctx.textOf() });
    } catch {
      comments = [];
    }
    renderRail();
  }

  function renderRail() {
    const open = railVisible({ commenting, composing, requested });
    rail.hidden = !open;
    // The counter is both the count and the switch, so it stays on screen
    // whenever the rail COULD be opened — in comment mode with nothing in it
    // yet, that button is the only sign the rail exists at all.
    countEl.hidden = !comments.length && !commenting;
    countEl.textContent = comments.length ? `💬 ${comments.length}` : "💬";
    countEl.setAttribute("aria-expanded", open ? "true" : "false");
    countEl.title = open ? "Hide comments" : "Show comments";
    const composer = railBody.querySelector(".dc-composer");
    railTitle.textContent = `Comments${comments.length ? ` (${comments.length})` : ""}`;
    railBody.innerHTML = comments.length
      ? comments.map(renderComment).join("")
      : `<p class="dc-empty">${
          commenting
            ? "Mark a passage in the page to comment on it."
            : "No comments on this document."
        }</p>`;
    if (composer) railBody.prepend(composer);
    wireCards();
    paintHighlights();
  }

  /** @param {any} c */
  function renderComment(c) {
    const status = STATUS_LABEL[c.status] || c.status;
    const stale =
      c.hit.match === "stale"
        ? '<p class="dc-stale">The text this comments on has been replaced. Read the reply below against the current wording.</p>'
        : c.hit.match === "partial"
          ? '<p class="dc-stale">The commented text has been edited since — only part of it still matches.</p>'
          : "";
    const thread = (c.messages || [])
      .map(
        (m) => `
        <div class="dc-msg ${m.author === "agent" ? "dc-agent" : ""}">
          <span class="dc-who">${m.author === "agent" ? "Agent" : "You"}</span>
          ${escapeHtml(m.body)}
        </div>`,
      )
      .join("");
    return `
      <div class="dc-card${c.hit.match === "stale" ? " dc-stale-card" : ""}" data-cid="${c.id}">
        <div class="dc-cardhead">
          <span class="dc-status ${c.status}">${escapeHtml(status)}</span>
          <span class="dc-date">${escapeHtml(new Date(c.created_at).toLocaleDateString())}</span>
        </div>
        ${c.anchor.quote ? `<div class="dc-quote">${escapeHtml(c.anchor.quote)}</div>` : ""}
        ${stale}
        <div class="dc-note">${escapeHtml(c.anchor.note)}</div>
        ${thread}
        <div class="dc-actions">
          <button type="button" data-reply="${c.id}">Reply</button>
          <button type="button" data-del="${c.id}">Delete</button>
        </div>
      </div>`;
  }

  function wireCards() {
    for (const card of railBody.querySelectorAll(".dc-card")) {
      card.addEventListener("click", (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest("button")) return;
        focusComment(Number(card.getAttribute("data-cid")));
      });
    }
    for (const btn of railBody.querySelectorAll("[data-reply]")) {
      btn.addEventListener("click", () => openReply(/** @type {HTMLElement} */ (btn)));
    }
    for (const btn of railBody.querySelectorAll("[data-del]")) {
      btn.addEventListener("click", async () => {
        /** @type {HTMLButtonElement} */ (btn).disabled = true;
        try {
          await fetch(`/api/feedback/${btn.getAttribute("data-del")}`, { method: "DELETE" });
        } catch { /* the reload shows whatever the server now has */ }
        await load();
      });
    }
  }

  /** @param {HTMLElement} btn */
  function openReply(btn) {
    const card = btn.closest(".dc-card");
    if (!card || card.querySelector(".dc-reply")) return;
    const box = document.createElement("div");
    box.className = "dc-reply";
    box.innerHTML =
      '<textarea rows="2" placeholder="Reply…"></textarea>' +
      '<div class="dc-actions"><button type="button" class="dc-send">Send</button><span class="dc-msgline"></span></div>';
    card.appendChild(box);
    const ta = /** @type {HTMLTextAreaElement} */ (box.querySelector("textarea"));
    ta.focus();
    box.querySelector(".dc-send")?.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return;
      const send = /** @type {HTMLButtonElement} */ (box.querySelector(".dc-send"));
      send.disabled = true;
      try {
        const res = await fetch(`/api/feedback/${card.getAttribute("data-cid")}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await load();
      } catch {
        send.disabled = false;
        /** @type {HTMLElement} */ (box.querySelector(".dc-msgline")).textContent = "Could not send.";
      }
    });
  }

  /** @param {number} id */
  function focusComment(id) {
    const mark = rootEl.querySelector(`mark.dc-mark[data-cid="${id}"]`);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.classList.add("dc-flash");
    setTimeout(() => mark.classList.remove("dc-flash"), 1200);
  }

  // The other direction: a highlighted passage is a tap target that brings its
  // thread back. With the rail closed by default in read mode, the highlight in
  // the prose is what tells you a comment is there — so it has to be the way to
  // open it, or closing the rail would be a one-way door.
  rootEl.addEventListener("click", (e) => {
    const mark = /** @type {HTMLElement} */ (e.target)?.closest?.("mark.dc-mark");
    if (!mark) return;
    // In comment mode the same gesture may be the end of a selection; marking a
    // new passage wins over revisiting an old comment.
    if (commenting && isCommentableSelection(window.getSelection()?.toString())) return;
    setRail(true);
    focusCard(Number(mark.getAttribute("data-cid")));
  });

  /** @param {number} id */
  function focusCard(id) {
    const card = /** @type {HTMLElement | null} */ (railBody.querySelector(`.dc-card[data-cid="${id}"]`));
    if (!card) return;
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.classList.add("dc-flash");
    setTimeout(() => card.classList.remove("dc-flash"), 1200);
  }

  // ---- highlighting the commented passages ---------------------------------

  /**
   * Wrap each located quote in the rendered document. Works over the page's
   * TEXT NODES with the same whitespace normalization the core matches with,
   * so a quote taken from rendered text still lands when the source wrapped it
   * across lines.
   */
  function paintHighlights() {
    for (const m of rootEl.querySelectorAll("mark.dc-mark")) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent || ""), m);
      parent.normalize();
    }
    for (const c of comments) {
      if (c.hit.match === "stale") continue;
      const range = rangeForQuote(c.anchor.quote, c.anchor.section, c.hit.length);
      if (!range) continue;
      try {
        const mark = document.createElement("mark");
        mark.className = "dc-mark";
        mark.setAttribute("data-cid", String(c.id));
        range.surroundContents(mark);
      } catch {
        // A selection spanning element boundaries can't be wrapped in one
        // node. The card still carries the quote — losing the highlight is a
        // cosmetic degradation, never a lost comment.
      }
    }
  }

  /**
   * A DOM Range over the located quote, or null.
   * @param {string} quote
   * @param {string} section
   * @param {number} length how much of the quote actually matched
   * @returns {Range | null}
   */
  function rangeForQuote(quote, section, length) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let norm = "";
    /** @type {Array<{node: Text, offset: number}>} */
    const map = [];
    let node;
    let lastWasSpace = true;
    while ((node = /** @type {Text} */ (walker.nextNode()))) {
      // The rail lives outside rootEl, but a highlight must never be painted
      // into our own injected chrome if a page ever nests it.
      if (node.parentElement?.closest(".dc-rail, .dc-slot")) continue;
      const raw = node.data;
      for (let i = 0; i < raw.length; i++) {
        const isSpace = /\s/.test(raw[i]);
        if (isSpace) {
          if (lastWasSpace) continue;
          norm += " ";
        } else {
          norm += raw[i];
        }
        map.push({ node, offset: i });
        lastWasSpace = isSpace;
      }
    }
    const hit = locateQuote(norm, quote, { section });
    if (hit.match === "stale") return null;
    const start = map[hit.index];
    const end = map[Math.min(hit.index + Math.min(hit.length, length || hit.length) - 1, map.length - 1)];
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  }

  load();
  return { onDocRendered: load };
}
