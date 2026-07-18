// The account panel's "feedback" view — the user's feedback dialogue
// threads. Feedback is filed straight from the chat now (a message that opens
// with the word "feedback" is routed to the feedback pipeline — src/feedback.js
// feedbackIntent, src/pipeline.js runFeedbackCapture), so this view is where the
// resulting threads live and where the developers' replies come back. The panel
// shell (showView) lives in account.js.

import { renderNotifBadge } from "./account-views.js";
import { createFeedbackAttach } from "./feedback-attach.js";
import { escapeHtml } from "./notifications.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// The Feedback view: the user's submitted entries as dialogue threads —
// the user-facing half of the development loop (the agent's half is the
// feedback-loop skill working /api/admin/feedback). Reply boxes keep the
// dialogue going (text and/or screenshots); Withdraw deletes an entry,
// thread included. Opening the view marks the agent's replies read
// server-side (GET does it), so the badge clears like the message center's
// does.
export async function loadFeedbackView(ctx) {
  ctx.body.innerHTML = `
    <button id="fbbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Feedback</p>
    <p class="muted">Loading…</p>`;
  document.getElementById("fbbackbtn").addEventListener("click", () => ctx.show("summary"));
  let entries = null;
  try {
    const res = await fetch("/api/feedback");
    if (res.ok) entries = (await res.json()).feedback || [];
  } catch { /* entries stays null → error note below */ }
  if (ctx.me?.notifications) {
    ctx.me.notifications.total -= ctx.me.notifications.unread_feedback || 0;
    ctx.me.notifications.unread_feedback = 0;
    renderNotifBadge(ctx);
  }
  const list =
    entries === null
      ? '<p class="muted">Could not load feedback — try again in a moment.</p>'
      : entries.length
        ? entries.map(renderFeedbackEntry).join("")
        : `<p class="muted">No feedback yet. To start a dialogue with the developers,
           just begin a chat message with the word <b>“feedback”</b> — for example
           “feedback: the map view was cut off”. It's sent to the developers, and
           their replies show up here.</p>`;
  ctx.body.innerHTML = `
    <button id="fbbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Feedback</p>
    ${list}`;
  document.getElementById("fbbackbtn").addEventListener("click", () => ctx.show("summary"));
  // Each reply box gets its own screenshot-attach widget (a DOM component,
  // mounted after the innerHTML render above).
  const attachWidgets = new Map();
  ctx.body.querySelectorAll("[data-fb-att]").forEach((slot) => {
    const w = createFeedbackAttach();
    attachWidgets.set(slot.dataset.fbAtt, w);
    slot.appendChild(w.el);
  });
  ctx.body.querySelectorAll("[data-fb-reply]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.fbReply;
      const ta = ctx.body.querySelector(`textarea[data-fb-ta="${id}"]`);
      const text = ta?.value.trim();
      const attach = attachWidgets.get(id);
      if (attach?.busy()) {
        btn.textContent = "Compressing image…";
        return;
      }
      const images = attach?.getImages() || [];
      if (!text && !images.length) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/feedback/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text || "", images: images.length ? images : undefined }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "HTTP " + res.status);
        await loadFeedbackView(ctx);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = err?.message || "Failed — try again";
      }
    });
  });
  ctx.body.querySelectorAll("[data-fb-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/feedback/${btn.dataset.fbDel}`, { method: "DELETE" });
      } catch { /* the reload below shows whatever the server now has */ }
      await loadFeedbackView(ctx);
    });
  });
}

// User-facing status labels for a feedback entry — friendlier than the raw
// lifecycle enums (src/feedback.js).
const FB_STATUS = {
  new: ["received", "new"],
  seen: ["seen", "seen"],
  in_progress: ["being worked on", "working"],
  resolved: ["resolved", "done"],
  declined: ["declined", "done"],
};

// A message's attached screenshots as thumbnails — the src points at the
// per-image endpoint (the API projects metadata only), each opening full
// size in a new tab.
function renderMsgImages(entryId, images) {
  if (!images?.length) return "";
  const thumbs = images
    .map(
      (i) => `
      <a href="/api/feedback/${entryId}/images/${i.id}" target="_blank" rel="noopener">
        <img src="/api/feedback/${entryId}/images/${i.id}" alt="${escapeHtml(i.name || "screenshot")}" title="${escapeHtml(i.name || "screenshot")}" loading="lazy">
      </a>`,
    )
    .join("");
  return `<div class="fb-msg-imgs">${thumbs}</div>`;
}

// One feedback entry: status + date header, the context line (which reply it
// was about), the dialogue (the original comment is the first user message —
// entry-level screenshots render with it; a reply's render with the reply),
// a reply box with its own screenshot attach, and Withdraw. All user/agent
// text is escaped — same posture as the message center.
function renderFeedbackEntry(e) {
  const [statusLabel, statusClass] = FB_STATUS[e.status] || [e.status, "new"];
  const about = e.question
    ? `<div class="muted fb-about">About: “${escapeHtml(e.question.length > 120 ? e.question.slice(0, 120) + "…" : e.question)}”</div>`
    : "";
  const thread = [
    { author: "user", body: e.comment, created_at: e.created_at, images: e.images || [] },
    ...e.messages,
  ]
    .map(
      (m) => `
      <div class="fb-msg ${m.author === "agent" ? "agent" : "user"}">
        <div class="fb-msg-head muted">${m.author === "agent" ? "DeepResearch.se" : "You"} · ${escapeHtml(new Date(m.created_at).toLocaleString())}</div>
        <div>${escapeHtml(m.body)}</div>
        ${renderMsgImages(e.id, m.images)}
      </div>`,
    )
    .join("");
  return `
    <div class="fb-entry">
      <div class="fb-head">
        <span class="fb-status ${statusClass}">${statusLabel}</span>
        <span class="muted">${escapeHtml(new Date(e.created_at).toLocaleString())}</span>
      </div>
      ${about}
      ${thread}
      <div class="fb-replybox">
        <textarea data-fb-ta="${e.id}" rows="2" placeholder="Reply…"></textarea>
        <div data-fb-att="${e.id}"></div>
        <div class="fb-actions">
          <button type="button" data-fb-reply="${e.id}">Send reply</button>
          <button type="button" class="fb-del" data-fb-del="${e.id}" title="Delete this feedback and its whole dialogue">Withdraw</button>
        </div>
      </div>
    </div>`;
}
