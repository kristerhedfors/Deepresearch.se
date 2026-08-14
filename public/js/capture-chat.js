// @ts-check
// THE CHAT BEHIND A CAPTURE — the app-side half of the video→chat link (owner
// directive, 2026-08-14: "link from captured agent videos to the actual chat so
// one can continue and explore from there. Let those recorded chats appear in
// admin's chat history panel under its own expandable").
//
// A capture is a recorded research run edited into a short clip (the
// video-capture skill). Until now the run itself died with the browser that
// made it: the clip showed an answer nobody could open, follow up on, or check
// a citation in. The recorder now files the conversation with the row, and this
// module is what turns it back into a live chat. Two doors, one path:
//
//   * `/?capture=<id>` — followed from a card on the /captures/ review feed.
//     app.js calls `openCaptureChat` during boot.
//   * The **Recorded runs** group in the chat-history drawer, rendered by
//     `renderCaptureChatGroup` and opening the same way.
//
// THE CONVERSATION BECOMES THE READER'S. It is written into local encrypted
// history under a stable id (`capture-<id>`), so it sits in the drawer beside
// their own chats and continues like any other. That stable id is also why
// following the same link twice does not produce two copies — and why an
// ALREADY-OPENED capture reopens the reader's version, follow-ups and all,
// rather than resetting it to the recording. A capture is a starting point, not
// a document that keeps overwriting the work done from it.
//
// Fail-soft throughout (invariant 2). A non-admin, an older Worker with no
// endpoint, a browser with no IndexedDB: each ends as a hidden group or a
// composer prefilled with the question, never as a thrown boot.

import { captureChatRows, captureChatSeed } from "./captures-core.js";
import { historyAvailable, loadConversation, saveConversation } from "./history-store.js";
import { applyLoadedConversation } from "./stream.js";

const API = "/api/admin/captures";

/** How many recorded runs the drawer's group lists. The whole archive is the
 * review feed's job; the drawer shows what was recorded lately. */
const GROUP_LIMIT = 30;

/**
 * Wiring from app.js — this module cannot reach the composer, the model select
 * or the mode dropdown, all of which app.js owns.
 * @type {{ onRecord: (record: any) => void, onMode: (mode: string) => void,
 *   onPrefill: (text: string) => void }}
 */
const hooks = {
  onRecord: () => {},
  onMode: () => {},
  onPrefill: () => {},
};

/**
 * One-time wiring from app.js.
 * @param {Partial<typeof hooks>} [opts]
 */
export function initCaptureChats(opts = {}) {
  if (typeof opts.onRecord === "function") hooks.onRecord = opts.onRecord;
  if (typeof opts.onMode === "function") hooks.onMode = opts.onMode;
  if (typeof opts.onPrefill === "function") hooks.onPrefill = opts.onPrefill;
}

/**
 * The local history id a capture's chat lives under. Deterministic on purpose
 * — see the header: it is what makes the link idempotent and what lets a
 * reader come back to their own continued conversation.
 * @param {number|string} id
 * @returns {string}
 */
export function captureConversationId(id) {
  return `capture-${id}`;
}

/**
 * Admin JSON GET. Returns null on ANY failure — a non-admin's 403, a Worker
 * with no such endpoint, a network blip. The caller hides its surface; nothing
 * here is worth an error message to somebody who was not looking for it.
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The seed for one capture: its recorded conversation, plus the agent, model
 * and question it ran with.
 * @param {number|string} id
 * @returns {Promise<any>} null when it cannot be read
 */
export async function fetchCaptureChat(id) {
  const data = await getJson(`${API}/${encodeURIComponent(String(id))}/chat`);
  if (!data || typeof data !== "object" || !data.chat) return null;
  // Normalised again on arrival rather than trusted: the same pure core the
  // server built it with, so a body from an older (or newer) Worker still
  // lands in the shape applyLoadedConversation can restore.
  return captureChatSeed(data.chat, data.chat.messages);
}

/**
 * OPEN A CAPTURE'S RUN AS A LIVE CHAT.
 *
 * Three outcomes, all of them success from the reader's side:
 *  - `resumed` — the reader had already opened this capture and continued it;
 *    their conversation comes back, not the recording.
 *  - `restored` — the recorded conversation is now on screen and can be
 *    continued.
 *  - `prefilled` — the capture predates transcripts, so the composer is loaded
 *    with the same question under the same agent and model. Not a failure: it
 *    is what the card's own wording promised.
 *
 * @param {number|string} id
 * @returns {Promise<{ ok: boolean, outcome: "resumed"|"restored"|"prefilled"|"none", seed: any }>}
 */
export async function openCaptureChat(id) {
  const seed = await fetchCaptureChat(id);
  if (!seed) return { ok: false, outcome: "none", seed: null };

  // The AGENT first, whatever else happens. A recorded Cyber run continued
  // under Deep Science is a different agent answering the follow-up, and the
  // reader has no way to see that the mode moved under them.
  if (seed.mode) hooks.onMode(seed.mode);

  const convId = captureConversationId(seed.id ?? id);

  // Their own continued copy wins over the recording (see the header).
  const existing = /** @type {any} */ (
    (await historyAvailable().catch(() => false))
      ? await loadConversation(convId).catch(() => null)
      : null
  );
  if (existing && Array.isArray(existing.messages) && existing.messages.length) {
    applyLoadedConversation({ ...existing, id: convId });
    hooks.onRecord(existing);
    return { ok: true, outcome: "resumed", seed };
  }

  if (!seed.messages.length) {
    // No transcript — the question, under the right agent and model. The model
    // rides in on a bare record so app.js's own settings hook applies it the
    // same way it does for a loaded conversation.
    hooks.onRecord({ model: seed.model || "", budgetS: null, webSearch: true });
    hooks.onPrefill(seed.prompt);
    return { ok: true, outcome: "prefilled", seed };
  }

  const now = Date.now();
  const record = {
    title: seed.title,
    messages: seed.messages,
    model: seed.model || "",
    budgetS: null,
    webSearch: true,
    // The agent that produced it, so the follow-up is answered by the same one
    // after a reload (stream.js openConversationRecord reads this).
    ...(seed.mode ? { chatMode: seed.mode } : {}),
    ragDocs: [],
    embeds: [],
    projectId: null,
    // `createdAt` is WHEN THE RUN WAS RECORDED, not when it was opened here:
    // the drawer sorts by recency and a batch of old captures opened in one
    // sitting would otherwise bury the reader's own recent chats.
    createdAt: seed.recorded_at || now,
    updatedAt: now,
  };
  // Written before it is shown: a reader who follows the link and closes the
  // tab should still find the run in their history.
  await saveConversation(convId, record).catch(() => {});
  applyLoadedConversation({ ...record, id: convId });
  hooks.onRecord(record);
  return { ok: true, outcome: "restored", seed };
}

// ---- the drawer's own group ------------------------------------------------

/** Whether the recorded-runs endpoint answered for this reader. null = not
 * asked yet; false = it did not (a non-admin, an older Worker), and the group
 * stays hidden without asking again for the rest of the page's life. */
let available = /** @type {boolean|null} */ (null);

/**
 * Render the **Recorded runs** group into a `<details>` element in the history
 * drawer. Hidden entirely — not shown empty — when there is nothing to list or
 * the reader is not an admin: an expandable that opens onto "nothing here"
 * teaches the reader to stop opening it.
 *
 * The list is fetched on every render rather than cached: a capture recorded
 * ten minutes ago is exactly the one somebody opens the drawer looking for.
 *
 * @param {HTMLElement} box the <details id="capturechats"> element
 * @param {(id: number) => void} [onOpen] called after a row opens its chat
 *   (app.js closes the drawer)
 * @returns {Promise<number>} how many rows were rendered
 */
export async function renderCaptureChatGroup(box, onOpen) {
  if (!box) return 0;
  if (available === false) {
    box.hidden = true;
    return 0;
  }
  const data = await getJson(`${API}/chats?limit=${GROUP_LIMIT}`);
  available = !!data;
  const rows = captureChatRows(data);
  if (!rows.length) {
    box.hidden = true;
    return 0;
  }
  box.hidden = false;

  const summary = box.querySelector("summary");
  if (summary) {
    summary.textContent = "";
    summary.append("Recorded runs");
    const hint = document.createElement("span");
    hint.className = "capchats-hint";
    hint.textContent = `${rows.length} on video`;
    summary.appendChild(hint);
  }

  const body = box.querySelector(".capchats-body") || box;
  body.textContent = "";
  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "capchat-row";
    btn.dataset.id = String(row.id);
    // The number leads, the same as on the card: #CAP-12 is how a clip is
    // referred to, and a row that cannot be matched back to its video is a row
    // whose provenance the reader has to guess.
    const head = document.createElement("span");
    head.className = "capchat-head";
    if (row.tag) {
      const tag = document.createElement("span");
      tag.className = "capchat-tag";
      tag.textContent = row.tag;
      head.appendChild(tag);
    }
    const title = document.createElement("span");
    title.className = "capchat-title";
    title.textContent = row.title;
    head.appendChild(title);
    btn.appendChild(head);

    const sub = document.createElement("span");
    sub.className = "capchat-sub";
    // "the agent · what it was asked" — and, when the run predates transcripts,
    // the fact that this one opens as a question rather than a conversation.
    // Saying so here is the same honesty the card's wording carries: a row that
    // silently opened an empty chat would read as a bug.
    sub.textContent = [row.agent, row.resumable ? "" : "question only"].filter(Boolean).join(" · ");
    btn.appendChild(sub);
    btn.title = row.prompt || row.title;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await openCaptureChat(row.id);
        if (res.ok && typeof onOpen === "function") onOpen(row.id);
      } finally {
        btn.disabled = false;
      }
    });
    body.appendChild(btn);
  }
  return rows.length;
}
