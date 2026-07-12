// @ts-check
// Chat-RAG pure core: the text/id conventions for indexing a CONVERSATION
// as a retrieval document ("one conversation = one doc, id `chat-<convId>`,
// named by the chat's title", growing with the conversation — only the
// not-yet-indexed turns embed, tracked by a `srcMsgs` counter that advances
// on success only).
//
// This module is deliberately dependency-free and import-safe outside a
// browser (Node-tested). Its consumer is DRC's client-side RAG
// (public/js/drc-rag.js); the DRS project-chat indexing that originally
// lived here was removed with the DRS projects feature (2026-07-12) — in
// DRS, conversations are no longer RAG-indexed at all.

const CHAT_DOC_PREFIX = "chat-";

/**
 * One conversation message as the stores persist it. Multimodal user turns
 * carry an array of parts; only the text parts are indexable.
 * @typedef {{role?: string, content?: string | Array<{type?: string, text?: string}>}} ChatMessage
 */

// ---- pure helpers (unit-tested) ---------------------------------------------

/**
 * @param {string} convId
 * @returns {string}
 */
export function chatDocId(convId) {
  return CHAT_DOC_PREFIX + convId;
}

/**
 * The conversation id behind a chat doc id, or null for any other doc.
 * @param {unknown} docId
 * @returns {string | null}
 */
export function chatConvId(docId) {
  return typeof docId === "string" && docId.startsWith(CHAT_DOC_PREFIX)
    ? docId.slice(CHAT_DOC_PREFIX.length)
    : null;
}

// Context blocks the client appends to the outgoing user message
// (message-content.js). They are stripped before indexing: their sources
// (documents, other chats, image metadata) are already indexed or carried
// elsewhere — re-indexing retrieval excerpts through the chat would echo
// them back into the index as duplicate, second-hand chunks. The
// Project/Related-project-chat variants match legacy DRS blocks that may
// still sit inside old stored conversations.
const APPENDED_BLOCK = /\n\n--- (Attached document:|Project:|Related project chat:|Image metadata:)/;

/**
 * The indexable text of one message: the text itself for assistant turns,
 * the user's actual question (appended context blocks stripped, text parts
 * of multimodal content joined) for user turns.
 * @param {ChatMessage | null | undefined} message
 * @returns {string}
 */
export function messageIndexText(message) {
  const c = message?.content;
  let text =
    typeof c === "string"
      ? c
      : (Array.isArray(c) ? c : [])
          .filter((p) => p?.type === "text")
          .map((p) => p.text || "")
          .join("\n");
  const cut = text.search(APPENDED_BLOCK);
  if (cut >= 0) text = text.slice(0, cut);
  return text.trim();
}

/**
 * The indexable text of messages[fromMsg..]: labeled turns, empty ones
 * skipped. The title leads the very first increment (fromMsg 0) so
 * retrieval can match on it.
 * @param {ChatMessage[] | null | undefined} messages
 * @param {number} [fromMsg]
 * @param {string} [title]
 * @returns {string}
 */
export function chatIndexText(messages, fromMsg = 0, title = "") {
  const parts = [];
  for (const m of (messages || []).slice(fromMsg)) {
    const text = messageIndexText(m);
    if (!text) continue;
    parts.push((m?.role === "assistant" ? "Assistant:" : "User:") + "\n" + text);
  }
  if (!parts.length) return "";
  const head = fromMsg === 0 && String(title || "").trim() ? "Conversation: " + String(title).trim() + "\n\n" : "";
  return head + parts.join("\n\n");
}
