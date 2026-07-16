// @ts-check
// Project-chat RAG: conversations INSIDE a project are indexed into the
// same retrieval store as the project's documents and notes (rag.js), so
// an answer worked out in one project chat is retrievable context in every
// other chat of that project. The consequence — stated plainly because it
// is a deliberate storage-rule change — is that project chats follow the
// SAME readable-when-indexed exception as RAG-indexed documents: their
// records rest plaintext in both locations (history-store.js /
// src/storage.js), since the index already holds their text readable.
// Non-project chats are neither indexed nor affected — they keep the
// original encrypted-always posture.
//
// The index grows WITH the conversation: stream.js calls indexChatTurns
// after every persisted exchange, and only the not-yet-indexed messages
// are chunked and embedded (rag.js's appendToDoc; the doc row's `srcMsgs`
// counter remembers how far indexing got, so a failed embed simply retries
// on the next turn). One conversation = one doc, id `chat-<convId>`, named
// by the conversation's title.
//
// The pure helpers (chatDocId/chatConvId, messageIndexText, chatIndexText,
// and the sibling-chat scope picker) are unit-tested in Node — keep this
// module import-safe outside a browser, same as rag.js.

import { appendToDoc, deleteDoc, getDoc } from "./rag.js";
import { storageAvailable } from "./settings.js";

const CHAT_DOC_PREFIX = "chat-";

/**
 * One conversation message as history-store.js persists it. Multimodal
 * user turns carry an array of parts; only the text parts are indexable.
 * @typedef {{role?: string, content?: string | Array<{type?: string, text?: string}>}} ChatMessage
 */

// Retrieval scope cap: the server's /api/rag/query accepts at most 20
// docIds, and project docs + this conversation's own attachments come
// first — sibling chats fill what's left, newest first.
export const MAX_SIBLING_CHATS = 10;

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
// (message-content.js / project-context.js). They are stripped before
// indexing: their sources (documents, project materials, other chats,
// image metadata) are already indexed or carried elsewhere — re-indexing
// retrieval excerpts through the chat would echo them back into the index
// as duplicate, second-hand chunks.
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
 * retrieval can match on it — the same convention as project notes
 * (project-context.js's noteToText).
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

/**
 * The sibling chats a project conversation retrieves across: every OTHER
 * conversation of the same project (the current one is already in context),
 * newest first, capped. `conversations` is listConversations' output
 * (already newest-first).
 * @param {Array<{id: string, title?: string, projectId?: string, updatedAt?: number}> | null | undefined} conversations
 * @param {string | null | undefined} projectId
 * @param {string | null | undefined} currentConvId
 * @returns {Array<{id: string, name: string}>}
 */
export function siblingChatDocs(conversations, projectId, currentConvId) {
  if (!projectId) return [];
  return (conversations || [])
    .filter((c) => c.projectId === projectId && c.id !== currentConvId)
    .slice(0, MAX_SIBLING_CHATS)
    .map((c) => ({ id: chatDocId(c.id), name: c.title || "Untitled chat" }));
}

// ---- index maintenance (stream.js / projects.js) -----------------------------

/**
 * Index whatever this conversation has that isn't indexed yet. Called after
 * every persisted exchange; fail-soft by contract of the caller (a thrown
 * error just means the same turns are retried on the next persist, because
 * srcMsgs only advances on success).
 * @param {{convId?: string, title?: string, messages?: ChatMessage[]}} args
 * @returns {Promise<{chunkCount: number, appended: number} | null>} null when there was nothing new to index
 */
export async function indexChatTurns({ convId, title, messages }) {
  if (!convId || !messages?.length) return null;
  const docId = chatDocId(convId);
  const doc = await getDoc(docId);
  const fromMsg = doc?.srcMsgs || 0;
  if (messages.length <= fromMsg) return null; // nothing new since the last index pass
  const text = chatIndexText(messages, fromMsg, title);
  if (!text) return null;
  return appendToDoc(docId, String(title || "").trim() || "Untitled chat", text, {
    meta: { kind: "chat", srcMsgs: messages.length },
  });
}

/**
 * Remove a conversation's slice of the index, both rests — the chat-doc
 * counterpart of projects.js's removeFileFromProject cleanup. Harmless for
 * a conversation that was never indexed.
 * @param {string} convId
 */
export async function deleteChatIndex(convId) {
  const docId = chatDocId(convId);
  await deleteDoc(docId).catch(() => {});
  if (storageAvailable()) {
    fetch("/api/rag/docs/" + encodeURIComponent(docId), { method: "DELETE" }).catch(() => {});
  }
}
