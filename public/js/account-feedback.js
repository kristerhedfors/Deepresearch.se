// The account panel's "feedback" view — the user's feedback dialogue
// threads. The panel shell (showView) lives in account.js; the summary's
// Feedback-mode knob lives with the summary in account-views.js.

import { renderNotifBadge } from "./account-views.js";
import { escapeHtml } from "./notifications.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// The Feedback view: the user's submitted entries as dialogue threads —
// the user-facing half of the development loop (the agent's half is the
// feedback-loop skill working /api/admin/feedback). Reply boxes keep the
// dialogue going; Withdraw deletes an entry, thread included. Opening the
// view marks the agent's replies read server-side (GET does it), so the
// badge clears like the message center's does.
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
        : `<p class="muted">No feedback yet. Switch on Feedback mode, then press
           <b>Feedback</b> under any reply to start a dialogue with the developers.</p>`;
  ctx.body.innerHTML = `
    <button id="fbbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Feedback</p>
    ${list}`;
  document.getElementById("fbbackbtn").addEventListener("click", () => ctx.show("summary"));
  ctx.body.querySelectorAll("[data-fb-reply]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.fbReply;
      const ta = ctx.body.querySelector(`textarea[data-fb-ta="${id}"]`);
      const text = ta?.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/feedback/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
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

// One feedback entry: status + date header, the context line (which reply it
// was about), the dialogue (the original comment is the first user message,
// then the thread), a reply box, and Withdraw. All user/agent text is
// escaped — same posture as the message center.
function renderFeedbackEntry(e) {
  const [statusLabel, statusClass] = FB_STATUS[e.status] || [e.status, "new"];
  const about = e.question
    ? `<div class="muted fb-about">About: “${escapeHtml(e.question.length > 120 ? e.question.slice(0, 120) + "…" : e.question)}”</div>`
    : "";
  const thread = [{ author: "user", body: e.comment, created_at: e.created_at }, ...e.messages]
    .map(
      (m) => `
      <div class="fb-msg ${m.author === "agent" ? "agent" : "user"}">
        <div class="fb-msg-head muted">${m.author === "agent" ? "DeepResearch.se" : "You"} · ${escapeHtml(new Date(m.created_at).toLocaleString())}</div>
        <div>${escapeHtml(m.body)}</div>
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
        <div class="fb-actions">
          <button type="button" data-fb-reply="${e.id}">Send reply</button>
          <button type="button" class="fb-del" data-fb-del="${e.id}" title="Delete this feedback and its whole dialogue">Withdraw</button>
        </div>
      </div>
    </div>`;
}
