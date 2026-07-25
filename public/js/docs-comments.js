// The documentation reader's COMMENT MODE (owner directive, 2026-07-25) —
// the Word convention: a mode switch between reading and commenting, and in
// comment mode you mark a passage and write a note against it.
//
// This module is the UI half; the format, the anchoring and the doc⇄code
// contract live in the pure core (docs-comments-core.js), and the storage is
// the feedback pipeline — a comment is a feedback entry with the "doc" scope,
// so it inherits the dialogue thread, the status lifecycle and the agent's
// replies without a second queue to keep alive. The reader shows all three
// back beside the passage: what the agent did (status), what it said (thread),
// and whether the text has been REPLACED since (the anchor going stale).
//
// Administrative: the mode switch only appears for an admin identity. It is
// loaded dynamically by docs-viewer.js for exactly that reason — /docs is a
// public page, and a signed-out visitor never fetches this module.

import { docCommentsFor, buildDocCommentBody, isCommentableSelection, locateQuote, normalizeQuote } from "./docs-comments-core.js";
import { docPageTag } from "./feedback-core.js";
import { escapeHtml } from "./markdown.js";

const STATUS_LABEL = {
  new: "sent",
  seen: "seen",
  in_progress: "being worked on",
  resolved: "done",
  declined: "declined",
};

/**
 * Mount comment mode onto the docs viewer.
 * @param {{
 *   docEl: HTMLElement, railEl: HTMLElement, toggleEl: HTMLElement,
 *   currentPath: () => string, currentText: () => string,
 * }} ctx
 */
export function mountDocComments(ctx) {
  const { docEl, railEl, toggleEl } = ctx;
  let commenting = false;
  /** @type {any[]} */
  let comments = [];
  /** @type {{ quote: string, section: string } | null} */
  let pending = null;

  toggleEl.hidden = false;
  toggleEl.innerHTML = `
    <span class="mode-label">Mode</span>
    <button type="button" class="mode-btn active" data-mode="read">Read only</button>
    <button type="button" class="mode-btn" data-mode="comment">Comment</button>`;

  toggleEl.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("button.mode-btn");
    if (!btn) return;
    setMode(btn.getAttribute("data-mode") === "comment");
  });

  /** @param {boolean} on */
  function setMode(on) {
    commenting = on;
    for (const b of toggleEl.querySelectorAll("button.mode-btn")) {
      b.classList.toggle("active", (b.getAttribute("data-mode") === "comment") === on);
    }
    document.body.classList.toggle("commenting", on);
    if (!on) closeComposer();
    renderRail();
  }

  // ---- selection → composer ------------------------------------------------

  docEl.addEventListener("mouseup", onSelect);
  docEl.addEventListener("touchend", onSelect);

  function onSelect() {
    if (!commenting) return;
    // Let the browser settle the selection before reading it.
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      if (!isCommentableSelection(text) || !sel || !docEl.contains(sel.anchorNode)) return;
      pending = { quote: text, section: headingAbove(sel.anchorNode) };
      openComposer();
    }, 0);
  }

  /**
   * The nearest heading at or above a node — the section a passage lives in.
   * Stored with the comment so a quote that occurs more than once still lands
   * in the right place.
   * @param {Node | null} node
   * @returns {string}
   */
  function headingAbove(node) {
    /** @type {Element | null} */
    let el = node instanceof Element ? node : node?.parentElement || null;
    while (el && el !== docEl) {
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
        <span class="dc-msg"></span>
      </div>`;
    railEl.prepend(box);
    const ta = /** @type {HTMLTextAreaElement} */ (box.querySelector("textarea"));
    ta.focus();
    box.querySelector(".dc-cancel")?.addEventListener("click", closeComposer);
    box.querySelector(".dc-send")?.addEventListener("click", () => submit(box, ta));
  }

  function closeComposer() {
    railEl.querySelector(".dc-composer")?.remove();
  }

  /**
   * @param {HTMLElement} box
   * @param {HTMLTextAreaElement} ta
   */
  async function submit(box, ta) {
    const note = ta.value.trim();
    const msg = /** @type {HTMLElement} */ (box.querySelector(".dc-msg"));
    if (!note) {
      msg.textContent = "Write a comment first.";
      return;
    }
    const btn = /** @type {HTMLButtonElement} */ (box.querySelector(".dc-send"));
    btn.disabled = true;
    msg.textContent = "Sending…";
    const path = ctx.currentPath();
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          comment: buildDocCommentBody({ path, section: pending?.section || "", quote: pending?.quote || "", note }),
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
    const path = ctx.currentPath();
    if (!path) {
      comments = [];
      renderRail();
      return;
    }
    try {
      const res = await fetch(`/api/feedback?page=${encodeURIComponent(docPageTag(path))}`);
      const entries = res.ok ? (await res.json()).feedback || [] : [];
      comments = docCommentsFor(entries, { path, text: ctx.currentText() });
    } catch {
      comments = [];
    }
    renderRail();
  }

  function renderRail() {
    // The rail claims layout space only when it has something to show:
    // reading a document with no comments looks exactly as it did before.
    railEl.hidden = !commenting && !comments.length;
    document.body.classList.toggle("has-rail", !railEl.hidden);
    const composer = railEl.querySelector(".dc-composer");
    const head = `<p class="dc-railhead">Comments${comments.length ? ` (${comments.length})` : ""}</p>`;
    const body = comments.length
      ? comments.map(renderComment).join("")
      : `<p class="dc-empty">${
          commenting
            ? "Mark a passage in the document to comment on it."
            : "No comments on this document."
        }</p>`;
    railEl.innerHTML = head + body;
    if (composer) railEl.prepend(composer);
    wireCards();
    paintHighlights();
  }

  /** @param {any} c */
  function renderComment(c) {
    const status = STATUS_LABEL[c.status] || c.status;
    const stale =
      c.hit.match === "stale"
        ? `<p class="dc-stale">The text this comments on has been replaced. Read the reply below against the current wording.</p>`
        : c.hit.match === "partial"
          ? `<p class="dc-stale dc-partial">The commented text has been edited since — only part of it still matches.</p>`
          : "";
    const thread = (c.messages || [])
      .map(
        (m) => `
        <div class="dc-msg ${m.author === "agent" ? "agent" : "user"}">
          <span class="dc-who">${m.author === "agent" ? "Agent" : "You"}</span>
          ${escapeHtml(m.body)}
        </div>`,
      )
      .join("");
    return `
      <div class="dc-card${c.hit.match === "stale" ? " stale" : ""}" data-cid="${c.id}">
        <div class="dc-cardhead">
          <span class="dc-status ${c.status}">${escapeHtml(status)}</span>
          <span class="dc-date">${escapeHtml(new Date(c.created_at).toLocaleDateString())}</span>
        </div>
        ${c.anchor.quote ? `<div class="dc-quote">${escapeHtml(c.anchor.quote)}</div>` : ""}
        ${stale}
        <div class="dc-note">${escapeHtml(c.anchor.note)}</div>
        ${thread}
        <div class="dc-cardactions">
          <button type="button" class="dc-replybtn" data-reply="${c.id}">Reply</button>
          <button type="button" class="dc-delbtn" data-del="${c.id}">Delete</button>
        </div>
      </div>`;
  }

  function wireCards() {
    for (const card of railEl.querySelectorAll(".dc-card")) {
      card.addEventListener("click", (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest("button")) return;
        focusComment(Number(card.getAttribute("data-cid")));
      });
    }
    for (const btn of railEl.querySelectorAll("[data-reply]")) {
      btn.addEventListener("click", () => openReply(/** @type {HTMLElement} */ (btn)));
    }
    for (const btn of railEl.querySelectorAll("[data-del]")) {
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
    box.innerHTML = `<textarea rows="2" placeholder="Reply…"></textarea>
      <div class="dc-actions"><button type="button" class="dc-send">Send</button><span class="dc-msg"></span></div>`;
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
        /** @type {HTMLElement} */ (box.querySelector(".dc-msg")).textContent = "Could not send.";
      }
    });
  }

  /** @param {number} id */
  function focusComment(id) {
    const mark = docEl.querySelector(`mark.dc-mark[data-cid="${id}"]`);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.classList.add("flash");
    setTimeout(() => mark.classList.remove("flash"), 1200);
  }

  // ---- highlighting the commented passages ---------------------------------

  /**
   * Wrap each located quote in the rendered document. Works over the
   * document's TEXT NODES with the same whitespace normalization the core
   * matches with, so a quote taken from rendered text still lands when the
   * Markdown wrapped it across lines.
   */
  function paintHighlights() {
    for (const m of docEl.querySelectorAll("mark.dc-mark")) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent || ""), m);
      parent.normalize();
    }
    if (!comments.length) return;
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
    // Walk the text nodes once, building the same normalized string the core
    // searched, and remember which node each normalized offset came from.
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
    let norm = "";
    /** @type {Array<{node: Text, offset: number}>} */
    const map = [];
    let node;
    let lastWasSpace = true;
    while ((node = /** @type {Text} */ (walker.nextNode()))) {
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
    // Trailing space in the normalized string has no counterpart in the
    // core's trimmed search string; the leading one was skipped above.
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

  return { onDocRendered: load };
}
