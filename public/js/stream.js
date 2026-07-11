// Sending & SSE consumption: owns the conversation history and drives one
// /api/chat request per send — user bubble, assistant turn, event dispatch
// to the turn/activity renderers, and the error paths (including iOS
// backgrounding, which suspends network for the tab mid-stream).
//
// The SSE protocol (text deltas + status events) is documented in CLAUDE.md.

import {
  collapseActivity,
  finishGenericStep,
  finishSearchStep,
  getMapView,
  getStreetViewPov,
  renderMapEmbed,
  renderStats,
  renderStreetViewEmbed,
  renderStreetViewFrames,
  resetStreetViewPov,
  sanitizeResearchEvent,
  settlePendingSteps,
  startGenericStep,
  startSearchStep,
  updateGenericStep,
} from "./activity.js";
import { bashLiteOn } from "./settings.js";
import { runShellLoop } from "./bash-agent.js";
import { ensureSandboxBooted, execInSandbox, sandboxSupported } from "./sandbox.js";
import {
  addAssistantTurn,
  addUserBubble,
  isTyping,
  renderStoredConversation,
  resetForRevision,
  setError,
  setText,
} from "./turns.js";
import { deleteConversation, listConversations, loadConversation, saveConversation } from "./history-store.js";
import { clearPending, readPending, writePending } from "./pending-answer.js";
import { indexChatTurns, siblingChatDocs } from "./chat-rag.js";
import {
  activeProjectId,
  getProject,
  projectCloudOn,
  setActiveProject,
} from "./projects.js";
import { buildProjectContext, projectDocIds } from "./project-context.js";
import {
  asksDeviceLocation,
  asksPhysicalLocation,
  conversationCopyText,
  deriveTitle,
  imageMetadataBlock,
  inlineDocBlock,
  isStreamStale,
  ragExcerptBlocks,
  splitUserContent,
  stripOldImages,
  STREAM_STALL_MS,
} from "./message-content.js";
import { firstChunks, retrieve } from "./rag.js";
import { renderQuiz } from "./quiz.js";
import { createSseParser } from "./sse.js";
import {
  capEmbedBytes,
  getEmbeds,
  initEmbeds,
  pruneEmbeds,
  quizHooks,
  recordEmbed,
  setEmbeds,
} from "./embeds.js";
import { ackAnswer, recoverAnswer } from "./recovery.js";

/**
 * Per-send options, captured from the composer (app.js) and threaded into
 * persistence so a stored conversation reopens with the settings it was
 * sent with.
 * @typedef {object} SendOpts
 * @property {object[]} [images]  pending image attachments ({name, dataUrl, gps, …})
 * @property {object[]} [docs]    pending document attachments ({name, text?, rag?, docId?, …})
 * @property {string} [model]     model id ("" = server default)
 * @property {?number} [budgetS]  research time budget in seconds
 * @property {boolean} [webSearch]
 */

/**
 * The stored conversation record (history-store.js encrypts and persists
 * it; history-ui.js/projects-ui.js reopen it via applyLoadedConversation).
 * @typedef {object} ConversationRecord
 * @property {string} title
 * @property {Array<{role: string, content: string|object[]}>} messages
 * @property {string} model
 * @property {?number} budgetS
 * @property {boolean} webSearch
 * @property {Array<{id: string, name: string}>} ragDocs
 * @property {import("./embeds.js").EmbedEntry[]} embeds
 * @property {?string} projectId
 * @property {number} createdAt
 * @property {number} updatedAt
 */

// ---- Conversation state -------------------------------------------------

const history = []; // {role, content} pairs sent to the API

// Large documents attached to this conversation (RAG-indexed — see
// public/js/rag.js): follow-up questions keep retrieving from them, so
// their ids/names are conversation state, persisted in the encrypted
// record (`ragDocs`) and restored on load.
let convRagDocs = []; // [{id, name}]

// ---- Embeds registry ----------------------------------------------------
// The pipeline-embedded elements' bookkeeping (recordEmbed / quizHooks /
// pruneEmbeds / capEmbedBytes and the registry itself) lives in
// public/js/embeds.js. Wired here with the live message array (`history` is
// a stable reference — cleared in place, never reassigned) and the persist
// hook a quiz completed after its stream ended needs; `lastSendOpts` is
// read at call time, so it always carries the latest send's metadata.
initEmbeds({ history, persist: () => persistConversation(lastSendOpts) });

// ---- Conversation identity & persistence ---------------------------------

// The project this conversation belongs to (null = none): adopted from the
// active project on the FIRST send of a fresh conversation, persisted in
// the encrypted record, restored on load. Project scope means: retrieval
// runs across the project's indexed docs too, the project-materials block
// (inventory + image EXIF) rides in each message, and persistence honors
// the project's cloud knob.
let convProjectId = null;

// The most recent send's persistence options (model/budget/webSearch) — a
// quiz answered AFTER its stream finished still needs to persist the
// conversation with the right metadata (quizHooks, embeds.js). Seeded from the
// record on load so a reload-then-finish doesn't clobber stored metadata.
let lastSendOpts = {};

let scrollDown = () => {};
let inFlight = false;
let controller = null; // AbortController of the in-flight request
// Bumped by clearHistory: a send that started under an older generation
// must never touch the new conversation's history or UI.
let generation = 0;

// Identity of the conversation currently in `history`, for the encrypted
// local-history sidebar (public/js/history-ui.js). Unset until the first
// exchange completes, so an abandoned empty chat never creates an entry.
let currentId = null;
let convTitle = null;
let convCreatedAt = null;
let onHistoryChange = () => {};

// Incognito (the header's ghost toggle): while true, persistConversation
// is a no-op — the conversation exists only in this tab's memory, never
// written to the encrypted local store or the cloud copy — AND every send
// carries `incognito: true` so the server keeps the exchange out of its
// full-visibility interaction log too (src/chatlog.js). Set only before
// the first message of a fresh conversation (app.js locks the toggle once
// the conversation has started) and reset by clearHistory / loading a
// saved conversation, so a chat can't retroactively vanish and a
// supposedly-incognito one can't retroactively persist.
let convIncognito = false;

export function setIncognito(on) {
  convIncognito = !!on;
}

export function isIncognito() {
  return convIncognito;
}

// True once the current conversation has content (a message in flight or
// landed, or a saved conversation loaded) — the point past which the
// incognito choice is locked.
export function conversationStarted() {
  return history.length > 0 || currentId !== null;
}

/**
 * One-time wiring from app.js.
 * @param {(force?: boolean) => void} scrollFn  auto-follow scroll callback
 * @param {{onHistoryChange?: (id: string) => void}} [opts]  fires after every persist/delete
 */
export function initStream(scrollFn, opts = {}) {
  scrollDown = scrollFn;
  onHistoryChange = opts.onHistoryChange || onHistoryChange;
}

// The id of the conversation currently on screen, or null for a fresh,
// not-yet-saved chat — used by the sidebar to highlight the active entry.
export function currentConversationId() {
  return currentId;
}

// The on-screen conversation as plain text for the header's copy button
// (app.js): "User: …" / "Assistant: …" turns with images and appended
// context blocks reduced to references — message-content.js's pure
// conversationCopyText over this tab's live history.
export function conversationAsText() {
  return conversationCopyText(history, getEmbeds());
}

// Replaces the on-screen conversation with a stored record — the shared
// core of the sidebar "load" and the boot-time pending-answer resume.
// Aborts any in-flight request and bumps `generation` exactly like
// clearHistory, so a stream from the conversation being replaced can never
// write into the newly opened one; then adopts the record's state and
// re-renders. Returns the new generation for callers that keep polling.
function openConversationRecord(id, record) {
  controller?.abort();
  controller = null;
  generation++;
  history.length = 0;
  history.push(...record.messages);
  currentId = id;
  convTitle = record.title || null;
  convCreatedAt = record.createdAt || null;
  convRagDocs = Array.isArray(record.ragDocs) ? record.ragDocs : [];
  setEmbeds(record.embeds); // normalized inside (any non-array means none)
  convIncognito = false; // a saved conversation is by definition not incognito
  // Reopening a project conversation re-enters that project's context
  // (and leaving one, a plain conversation leaves it).
  convProjectId = record.projectId || null;
  setActiveProject(convProjectId);
  // Finishing a reloaded quiz re-persists the conversation — with the
  // record's own metadata, not a stale (or empty) previous send's.
  lastSendOpts = { model: record.model || "", budgetS: record.budgetS ?? null, webSearch: record.webSearch !== false };
  renderStoredConversation(record.messages, getEmbeds(), { quizHooks });
  return generation;
}

/**
 * Sidebar "load": replace the on-screen conversation with a previously
 * saved one.
 * @param {ConversationRecord & {id: string}} record
 */
export function applyLoadedConversation(record) {
  openConversationRecord(record.id, record);
  resetStreetViewPov(); // any on-screen panorama belongs to the conversation being left
  clearPending(); // opening another conversation cancels any pending-answer resume
  scrollDown(true);
}

// Persists the current conversation after every completed exchange
// (success, stopped-with-partial-answer, or recovered/cut-off-with-
// partial-answer — anywhere an assistant reply actually lands in
// `history`). Silently a no-op if encrypted history isn't available
// (server not configured, or IndexedDB blocked) — the conversation still
// works for this tab, it just won't survive a reload.
async function persistConversation(opts) {
  if (convIncognito) return; // ghost toggle: this conversation is never written anywhere
  if (!history.length) return;
  if (!currentId) currentId = crypto.randomUUID();
  if (!convTitle) convTitle = deriveTitle(history);
  const now = Date.now();
  if (!convCreatedAt) convCreatedAt = now;
  try {
    await saveConversation(
      currentId,
      {
        title: convTitle,
        messages: history,
        model: opts?.model || "",
        budgetS: opts?.budgetS ?? null,
        webSearch: opts?.webSearch !== false,
        ragDocs: convRagDocs,
        embeds: getEmbeds(),
        projectId: convProjectId,
        createdAt: convCreatedAt,
        updatedAt: now,
      },
      { cloud: projectCloudOn(convProjectId) },
    );
    onHistoryChange(currentId);
  } catch {
    // See comment above — history storage being unavailable must never
    // surface as a chat error.
  }
  // Project chats are RAG-indexed as they grow (chat-rag.js): only the
  // turns not yet indexed are embedded, so this is one small embed call
  // per exchange. Fire-and-forget and fail-soft — an indexing hiccup
  // leaves srcMsgs where it was and the same turns retry after the next
  // exchange; it must never surface as a chat error.
  if (convProjectId && currentId) {
    indexChatTurns({
      convId: currentId,
      title: convTitle,
      messages: history.slice(),
      cloud: projectCloudOn(convProjectId),
    }).catch(() => {});
  }
}

// True while a /api/chat stream is running — downloads must wait (on iOS
// a download-triggered navigation aborts the in-flight fetch).
export function isStreaming() {
  return inFlight;
}

// New chat: forget the conversation AND abort any in-flight request —
// otherwise the invisible old stream keeps the send button hostage until
// it finishes, then leaks its answer into the fresh history.
export function clearHistory() {
  history.length = 0; // history lives only in this tab (encrypted copy aside)
  generation++;
  controller?.abort();
  controller = null;
  clearPending(); // "New chat" abandons any pending-answer resume too
  resetConversationMeta(); // the next send re-adopts whatever project is active
  convIncognito = false; // incognito is chosen per conversation, never inherited
  resetStreetViewPov(); // a fresh chat must not inherit the old panorama's view
}

// Forgets the identity/metadata of the current conversation (id, title,
// timestamps, RAG docs, embeds, project scope) — the messages themselves and
// the incognito flag are the caller's to handle.
function resetConversationMeta() {
  currentId = null;
  convTitle = null;
  convCreatedAt = null;
  convRagDocs = [];
  setEmbeds([]);
  convProjectId = null;
}

// Stop button: abort the in-flight request WITHOUT bumping `generation` —
// unlike clearHistory, the point here is to keep whatever streamed so far
// as normal context for a follow-up, not to discard it. sendMessage's
// catch block tells the two apart via `gen === generation`.
export function stopGeneration() {
  controller?.abort();
}

// ---- Answer recovery --------------------------------------------------
// The server parks every finished answer in a short-lived cache
// (src/answers.js) keyed by x-request-id: if our stream dies, we poll the
// completed answer back instead of asking the user to resend; if it
// arrives intact, we ack so the server purges its copy immediately.
// The transport half — the poll loop (recoverAnswer) and the ack — lives in
// public/js/recovery.js; this side owns what happens to a recovered answer,
// because all of it reads and writes this module's conversation state
// (history, identity, in-flight bookkeeping, persistence).

// A recovered answer landing in the conversation (boot-time resume, or
// in-session recovery after a dropped stream): render it — with its final
// stats when the server kept them — append it to history, purge the
// server's recovery copy, and persist.
async function deliverRecoveredAnswer(turn, recovered, requestId, opts) {
  setText(turn, recovered.text);
  if (recovered.stats) {
    turn.model = recovered.stats.model || "";
    turn.doneStats = recovered.stats;
    renderStats(turn, recovered.stats);
  }
  history.push({ role: "assistant", content: recovered.text });
  ackAnswer(requestId);
  await persistConversation(opts);
}

// A send that produced NO answer at all (empty completion, or a drop we
// couldn't recover): revert the unanswered question so a retry starts clean,
// and keep the encrypted record consistent with that. armPendingRecovery may
// have already persisted the question at stream start, so — unlike a plain
// pop — reconcile the stored record too: re-persist the reverted history for
// a follow-up, or delete the just-created record for a lone first message.
async function abandonUnanswered(opts) {
  clearPending();
  history.pop();
  pruneEmbeds(); // any embeds of the answer that never landed go with it
  if (!currentId) return; // nothing was persisted (incognito, or never armed)
  if (history.length) {
    await persistConversation(opts); // follow-up: store the reverted history
  } else {
    const id = currentId;
    resetConversationMeta(); // the discarded conversation is gone; next send starts fresh
    try { await deleteConversation(id); } catch { /* best effort */ }
    onHistoryChange(id);
  }
}

// Arm resume-across-relaunch for the in-flight send: persist the question to
// encrypted history NOW (so a cold boot after a PWA discard can show it) and
// drop a metadata-only pointer (pending-answer.js) the next boot polls the
// server-parked answer from. Incognito persists nothing anywhere, so it opts
// out entirely (no encrypted record to reopen, no pointer written). Both
// writes are fire-and-forget so the stream is never delayed.
function armPendingRecovery(requestId, opts) {
  if (convIncognito || !requestId) return;
  if (!currentId) currentId = crypto.randomUUID();
  persistConversation(opts).catch(() => {}); // question-only for now; re-persisted with the answer on completion
  writePending({
    convId: currentId,
    requestId,
    startedAt: Date.now(),
    model: opts.model || "",
    budgetS: opts.budgetS ?? null,
    webSearch: opts.webSearch !== false,
  });
}

// Called once on boot (app.js): if a previous session left an in-flight
// answer that a full app relaunch interrupted, reopen that conversation and
// poll the server-parked answer back. This is what lets a long research run
// survive the PWA being discarded while backgrounded — it finished on the
// server, and here the next launch collects it. Returns true if it resumed
// something. Fail-soft: any problem clears the pointer and returns false so
// boot proceeds normally.
export async function resumePendingAnswer({ onLoad } = {}) {
  if (inFlight) return false; // a live send is already going — don't fight it
  const pending = readPending();
  if (!pending) return false;

  let record = null;
  try {
    record = await loadConversation(pending.convId);
  } catch {
    record = null;
  }
  // The record must exist and still be awaiting its answer (a trailing user
  // turn, no assistant reply). If it already carries the answer, or is gone,
  // there's nothing to resume.
  const msgs = record?.messages;
  const awaiting = Array.isArray(msgs) && msgs.length > 0 && msgs[msgs.length - 1]?.role === "user";
  if (!awaiting) {
    clearPending();
    return false;
  }

  // Reopen the conversation — the pending pointer, not the sidebar, chose
  // it, and it stays armed until recovery settles below.
  const gen = openConversationRecord(pending.convId, record);
  if (onLoad) {
    try { onLoad(record); } catch { /* settings restore is best-effort */ }
  }

  const { text, imageUrls } = splitUserContent(msgs[msgs.length - 1].content);
  const turn = addAssistantTurn(text, imageUrls);
  scrollDown(true);

  const opts = { model: pending.model, budgetS: pending.budgetS, webSearch: pending.webSearch };
  // Mark the app as streaming while polling so the composer treats a click
  // as Stop, not a competing send that would race the recovered answer —
  // and give that Stop something to reach: this controller ends the wait.
  inFlight = true;
  controller = new AbortController();
  let recovered = null;
  let reason = "timeout";
  try {
    ({ data: recovered, reason } = await recoverAnswer(
      turn, pending.requestId, pending.budgetS, () => gen === generation, "Resuming your research…", controller.signal,
    ));
  } finally {
    inFlight = false;
    collapseActivity(turn);
  }
  if (gen !== generation || reason === "aborted") return false; // user navigated away while polling
  clearPending();
  if (recovered) {
    await deliverRecoveredAnswer(turn, recovered, pending.requestId, opts);
    return true;
  }
  if (reason === "stopped") {
    // The user chose not to wait. The question stays on screen as sent;
    // resending it is the retry path.
    setError(turn, "Stopped waiting for the previous answer. Your question is still here; send it again to re-run.");
    return false;
  }
  setError(
    turn,
    reason === "lost"
      ? "Your previous research was interrupted on the server before it finished — a long " +
        "time budget can exceed the hosting plan's per-request limit. Your question is still " +
        "here; try again, lowering the time budget if it recurs."
      : "Couldn't resume your previous research — it either finished after the 15-minute " +
        "recovery window closed or was interrupted. Your question is still here; just send it again.",
  );
  return false;
}

// ---- SSE event dispatch ---------------------------------------------------

// Dispatch one SSE event to the turn/activity renderers. Returns the updated
// text accumulator. Unknown status types fall through untouched — the
// protocol's forward-compatibility rule (see the sse-protocol skill).
function handleEvent(turn, evt, acc) {
  if (evt.error) {
    setError(turn, evt.error); // setError records it into researchLog
    return acc;
  }
  if (evt.status) {
    const s = evt.status;
    recordResearchEvent(turn, s);
    if (s.type === "search_start") startSearchStep(turn, s);
    else if (s.type === "search_done") finishSearchStep(turn, s);
    else if (s.type === "step_start") startGenericStep(turn, s.id, s.label || "");
    else if (s.type === "step_done") finishGenericStep(turn, s);
    else if (s.type === "streetview_embed") {
      renderStreetViewEmbed(turn, s);
      recordEmbed({ kind: "streetview_embed", lat: s.lat, lng: s.lng, heading: s.heading, pitch: s.pitch });
    } else if (s.type === "map_embed") {
      renderMapEmbed(turn, s);
      recordEmbed({ kind: "map_embed", lat: s.lat, lng: s.lng, zoom: s.zoom, q: s.q || "" });
    } else if (s.type === "streetview_frames") {
      renderStreetViewFrames(turn, s);
      recordEmbed({
        kind: "streetview_frames",
        query: s.query || "",
        directions: (Array.isArray(s.frames) ? s.frames : []).map((f) => f?.dir || f?.label || "").filter(Boolean),
        // The actual frame images (data URLs), so a conversation reopened
        // from history shows the imagery again instead of losing it
        // (reported: "all images are gone") — stored in the encrypted
        // record like user-attached images, size-capped by capEmbedBytes.
        frames: (Array.isArray(s.frames) ? s.frames : [])
          .filter((f) => typeof f?.url === "string")
          .map((f) => ({ dir: f.dir || "", label: f.label || "", url: f.url })),
      });
      capEmbedBytes();
    } else if (s.type === "quiz" && Array.isArray(s.quiz?.questions) && s.quiz.questions.length) {
      // The inline quiz (src/pipeline.js runQuizGeneration): the full
      // question set arrives in one event; the interaction — sequential
      // questions, alternatives + free-text, grading, the verdict — runs
      // entirely in quiz.js against the embeds-registry entry recorded
      // here, so the quiz (and its answers) survives reload like the
      // Street View elements do.
      const embed = recordEmbed({ kind: "quiz", quiz: s.quiz, answers: [] });
      renderQuiz(turn, s.quiz, quizHooks(embed));
    }
    else if (s.type === "done") {
      turn.model = s.model || ""; // titles the PDF report metadata
      turn.doneStats = s; // final stats for the debug-JSON export
      renderStats(turn, s);
    }
    else if (s.type === "discard_text") {
      resetForRevision(turn);
      return "";
    }
    // Unknown status types: ignore (forward compatibility).
    scrollDown();
    return acc;
  }
  const chunk = evt.choices?.[0]?.delta?.content;
  if (chunk) {
    acc += chunk;
    setText(turn, acc);
  }
  return acc;
}

// Append one research event to the turn's structured log, stamped with a
// relative timestamp (ms since the turn started). Text deltas are NOT
// recorded — this log is the research PROCESS (which services were queried,
// with what, in what order, how long each took), the source for the
// "Copy research JSON" debug button (activity.js). Bulky payloads (Street
// View frame data URLs) are compacted first (sanitizeResearchEvent).
function recordResearchEvent(turn, entry) {
  if (!turn.researchLog) return;
  turn.researchLog.push({ t: Date.now() - (turn.startedAt || Date.now()), ...sanitizeResearchEvent(entry) });
}

// ---- Send path ------------------------------------------------------------

// Builds the labeled excerpt blocks for every RAG-indexed document in this
// conversation: semantic retrieval against the question, a positional
// fallback for a newly attached doc retrieval missed entirely (a doc the
// user JUST attached must never be silently absent from its own turn),
// and a hard total-size budget.
async function buildRagBlocks(questionText, newRagDocs) {
  const project = convProjectId ? getProject(convProjectId) : null;
  const names = new Map(convRagDocs.map((d) => [d.id, d.name]));
  for (const f of project?.files || []) names.set(f.id, f.name);
  // Sibling chats: the project's OTHER conversations are indexed too
  // (chat-rag.js), so what was worked out in one project chat is
  // retrievable in this one. The current conversation is excluded — it's
  // already the context.
  let chatDocs = [];
  if (project) {
    try {
      chatDocs = siblingChatDocs(await listConversations(), convProjectId, currentId);
      for (const d of chatDocs) names.set(d.id, d.name);
    } catch {
      chatDocs = []; // sibling chats are optional context, never a blocker
    }
  }
  // Retrieval scope: this conversation's attached docs PLUS its project's
  // indexed material (documents, notes, sibling chats) — and nothing else
  // (no other project can leak in; the docId list IS the scope). Capped at
  // the server query's 20-docId limit, project material first.
  const docIds = [
    ...new Set([
      ...convRagDocs.map((d) => d.id),
      ...projectDocIds(project),
      ...chatDocs.map((d) => d.id),
    ]),
  ].slice(0, 20);
  const metaByDoc = new Map(newRagDocs.filter((d) => d.metadata).map((d) => [d.docId, d.metadata]));
  let matches = [];
  try {
    matches = await retrieve(docIds, questionText || "the attached document", 8);
  } catch {
    matches = [];
  }
  for (const d of newRagDocs) {
    if (!matches.some((m) => m.docId === d.docId)) {
      matches = matches.concat(await firstChunks(d.docId, 3).catch(() => []));
    }
  }
  if (!matches.length) return "";
  return ragExcerptBlocks(matches, names, metaByDoc, undefined, new Set(chatDocs.map((d) => d.id)));
}

// Build one outgoing user message's content (string, or multimodal parts
// when images ride along). Documents become labeled text blocks in the
// API message (never shown in the bubble); images become OpenAI-style
// multimodal parts. Extracted metadata (EXIF for images, docProps/
// tracked-changes/comments for docx, Info dict for pdf — see exif.js /
// docs.js) rides along as its own labeled block so it's research
// material, not silently dropped or silently blended into the main text.
//
// Large documents don't ride inline: they were RAG-indexed at attach
// time (attachments.js / rag.js) and contribute retrieved excerpts here
// instead — on this turn and on every follow-up in this conversation.
// A fresh conversation adopts the project that's active when its first
// message is sent; after that the conversation's own projectId rules —
// this is also where that adoption (convProjectId) and the conversation's
// RAG-doc roster (convRagDocs) are updated.
async function buildOutgoingUserContent(text, opts) {
  if (!currentId && !convProjectId) convProjectId = activeProjectId();
  const project = convProjectId ? getProject(convProjectId) : null;

  const newRagDocs = (opts.docs || []).filter((d) => d.rag && d.docId);
  for (const d of newRagDocs) {
    if (!convRagDocs.some((r) => r.id === d.docId)) {
      convRagDocs.push({ id: d.docId, name: d.name });
    }
  }
  let apiText = text;
  for (const d of opts.docs) {
    if (d.rag) continue; // excerpts appended below
    apiText += inlineDocBlock(d);
  }
  // Project materials: inventory + extracted image metadata (EXIF) as
  // context, then the same retrieval mechanism attachments use pulls the
  // relevant excerpts out of the project's indexed docs/notes.
  if (project) {
    apiText += buildProjectContext(project);
  }
  if (convRagDocs.length || project) {
    apiText += await buildRagBlocks(text, newRagDocs);
  }
  for (const a of opts.images) {
    apiText += imageMetadataBlock(a);
  }
  let content = apiText;
  if (opts.images.length) {
    content = [];
    if (apiText) content.push({ type: "text", text: apiText });
    for (const a of opts.images) {
      content.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  return content;
}

// The typed text of every user turn, oldest first (string or multimodal
// parts) — the device-location prefilter needs the EARLIER turns too: a
// short "My location" only reads as a here-ask because an earlier turn
// said "street view" (see asksDeviceLocation in message-content.js).
const userTexts = (msgs) =>
  msgs
    .filter((m) => m?.role === "user")
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.find((p) => p?.type === "text")?.text || "";
      return "";
    });

// One-shot device geolocation for "street view here" asks: resolves null
// on any failure (no API, permission denied, timeout) — never throws, so
// the send path is never blocked by it. Coordinates rounded (~1m), the
// same cache-friendly precision the map view uses.
const deviceLocation = () =>
  new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: Math.round(pos.coords.latitude * 1e5) / 1e5,
            lng: Math.round(pos.coords.longitude * 1e5) / 1e5,
          }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
      );
    } catch {
      resolve(null);
    }
  });

// Assemble the /api/chat request body from the module's conversation state
// (history, incognito) plus this send's options and the live view anchors.
// May await the device's geolocation — only for the exact ask shapes
// documented inline, so the permission prompt never fires gratuitously.
async function buildChatPayload(opts) {
  const payload = {
    messages: stripOldImages(history),
    time_budget_s: opts.budgetS,
    web_search: opts.webSearch,
  };
  if (opts.model) payload.model = opts.model;
  // Ghost toggle: tells the server to keep this exchange out of the
  // server-side interaction log too (src/chatlog.js) — the same choice
  // that keeps it out of local/cloud chat history.
  if (convIncognito) payload.incognito = true;
  // Raw GPS coordinates ride separately from the message text — the
  // Worker resolves them to a place name (src/geocode.js) and appends
  // that as its own context block, rather than the client guessing.
  const imageLocations = opts.images
    .filter((a) => a.gps)
    .map((a) => ({ name: a.name, lat: a.gps.lat, lon: a.gps.lon }));
  if (imageLocations.length) payload.imageLocations = imageLocations;
  // The user's CURRENT view in the inline Street View panorama (they may
  // have panned/moved it) — the server captures exactly that frame when a
  // follow-up refers back to the imagery (src/enrichment.js). Null when no
  // live panorama exists this session.
  const streetViewPov = getStreetViewPov();
  if (streetViewPov) payload.street_view_pov = streetViewPov;
  // The map sibling: the center/zoom of the live interactive MAP (shown
  // when a location has no Street View coverage) — the server captures a
  // road-map image of exactly that area on a map-referencing follow-up.
  const mapView = getMapView();
  if (mapView) payload.map_view = mapView;
  // A here-ask ("street view here", a plain "where am I?", or a short
  // "my location" answer to an earlier street-view turn) with NO live
  // view on screen to anchor to: ask the browser for the device's
  // location (the permission prompt fires for exactly these asks,
  // nothing else) and send it as the jump anchor. EXCEPTION: an explicit
  // PHYSICAL-location ask ("my actual location", "min faktiska plats")
  // sends it even while a live view exists — the user has navigated the
  // view elsewhere and means their real position, and the server flips
  // the anchor precedence accordingly (pickLookup). Fail-soft:
  // denied/unavailable/timeout sends nothing and the server honestly
  // asks for location access instead.
  const texts = userTexts(history);
  const latestText = texts[texts.length - 1] || "";
  if (asksPhysicalLocation(latestText) || (!streetViewPov && !mapView && asksDeviceLocation(texts))) {
    const loc = await deviceLocation();
    if (loc) payload.user_location = loc;
  }
  return payload;
}

// The experimental bash-lite sandbox pre-pass (the `bash_lite_mcp` knob). When
// the knob is on and the sandbox can run here (cross-origin isolated), the
// MODEL — not a client-side keyword gate — decides whether this message needs a
// shell: the agentic loop (public/js/bash-agent.js) asks it cold, and it
// returns done immediately for anything that doesn't. So "list files", "run la
// -la", or any phrasing the old regex missed now work, because the model makes
// the call. The Linux VM boots LAZILY (bootOnce) — only once the model actually
// proposes a command — so ordinary chat with the knob on pays one cheap model
// call and never boots the VM. Returns the transcript for stream.js to attach
// as `shell_transcript`; the pipeline folds it into the answer as ground truth.
// Fully fail-soft: any problem returns [] and the answer proceeds normally.
/**
 * @param {object} turn the assistant turn (activity target)
 * @returns {Promise<Array<{command: string, exitCode: number, stdout: string, stderr: string}>>}
 */
async function maybeRunShellLoop(turn) {
  try {
    if (!bashLiteOn()) return []; // knob off — feature disabled, nothing to do
    // Knob on but the page isn't cross-origin isolated (COEP): the sandbox
    // cannot boot. app.js self-heals by reloading once; if we still land here,
    // tell the user plainly instead of silently answering "I can't run code".
    if (!sandboxSupported()) {
      startGenericStep(turn, "sandbox", "Starting sandbox…");
      finishGenericStep(turn, {
        id: "sandbox",
        label: "Sandbox is enabled but this page isn't isolated yet — reload the page to start it.",
      });
      return [];
    }

    let booted = false;
    let ran = 0;
    // Boot the VM the first (and only the first) time the model asks to run
    // something — surfaced as a turn step so the user sees the (slow) first
    // boot. Returns whether the sandbox is usable.
    const bootOnce = async () => {
      startGenericStep(turn, "sandbox", "Booting Linux sandbox…");
      booted = await ensureSandboxBooted();
      if (!booted) finishGenericStep(turn, { id: "sandbox", label: "Sandbox unavailable — answering normally" });
      return booted;
    };
    const transcript = await runShellLoop({
      messages: stripOldImages(history),
      exec: execInSandbox,
      ensureReady: bootOnce,
      onResult: () => {
        ran++;
        updateGenericStep(turn, "sandbox", `Running in sandbox — ${ran} command${ran === 1 ? "" : "s"}…`);
      },
    });
    // Only report a finished step if we actually booted and ran (a message the
    // model judged not to need a shell shows no sandbox activity at all).
    if (booted && transcript.length) {
      finishGenericStep(turn, {
        id: "sandbox",
        label: `Ran ${transcript.length} command${transcript.length === 1 ? "" : "s"} in the Linux sandbox`,
        details: transcript.map((r) => `$ ${r.command}`),
      });
    }
    return transcript;
  } catch (err) {
    try { finishGenericStep(turn, { id: "sandbox", label: "Sandbox error — answering normally" }); } catch {}
    return [];
  }
}

/**
 * One send: text plus attachments already collected by the composer.
 * Pushes the user turn, streams /api/chat into a fresh assistant turn, and
 * settles every outcome (done / stopped / dropped-and-recovered / failed).
 * @param {string} text  the typed message
 * @param {SendOpts} opts
 * @returns {Promise<void>} resolves when the exchange has fully settled
 */
export async function sendMessage(text, opts) {
  const content = await buildOutgoingUserContent(text, opts);
  history.push({ role: "user", content });
  // Captured for out-of-band persistence (a quiz finished after this stream
  // ends re-persists with the same metadata — see quizHooks).
  lastSendOpts = { model: opts.model, budgetS: opts.budgetS, webSearch: opts.webSearch };
  const imageUrls = opts.images.map((a) => a.dataUrl);
  addUserBubble(text, imageUrls, opts.docs.map((d) => d.name));
  const turn = addAssistantTurn(text, imageUrls);
  let acc = "";
  inFlight = true;
  const gen = generation;
  controller = new AbortController();
  const signal = controller.signal;

  // iOS suspends network for backgrounded apps/PWAs — the most common cause
  // of mid-stream drops. On return the torn-down socket frequently makes the
  // next reader.read() HANG with no error, so a plain try/catch would never
  // notice; the watchdog below detects the silence and switches to recovery.
  let wasHidden = document.hidden;
  let lastByteAt = Date.now(); // last time the stream produced ANY bytes (incl. keepalives)
  let staleAbort = false; // set when the watchdog (not the user) aborts, so the catch recovers
  const onVisibility = () => {
    if (document.hidden) {
      wasHidden = true;
    } else {
      // Back in the foreground: grant a fresh full stall window for the
      // connection to resume before the watchdog judges it dead (elapsed
      // time spent hidden must not count as silence — see isStreamStale).
      lastByteAt = Date.now();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  const reqController = controller; // capture: clearHistory may reassign the module-level one
  const watchdog = setInterval(() => {
    if (isStreamStale(lastByteAt, Date.now(), document.hidden, STREAM_STALL_MS)) {
      staleAbort = true;
      try { reqController.abort(); } catch { /* already settled */ }
    }
  }, 5000);

  let requestId = "";
  try {
    const payload = await buildChatPayload(opts);
    // Experimental bash-lite sandbox: when the message wants a shell, run the
    // in-browser Linux agent loop first and attach its transcript so the
    // answer is written from the real command output. No-op (empty) unless the
    // knob is on and the sandbox can run — see maybeRunShellLoop.
    const shellTranscript = await maybeRunShellLoop(turn);
    if (shellTranscript.length) payload.shell_transcript = shellTranscript;
    // Diagnostic: report the client's sandbox-readiness so a not-running
    // sandbox can be diagnosed from the chat log (src/chatlog.js meta) —
    // crossOriginIsolated is the gate the loop needs, and it can only be
    // observed in the actual browser session.
    payload.client_diag = {
      coi: typeof crossOriginIsolated !== "undefined" ? !!crossOriginIsolated : null,
      bl: bashLiteOn(),
      sb: sandboxSupported(),
      ran: shellTranscript.length,
      css: (() => { try { return getComputedStyle(document.documentElement).getPropertyValue("--css-version").trim(); } catch { return ""; } })(),
      // Browser capability probe: is SharedArrayBuffer even defined (the thing
      // cross-origin isolation gates), and which browser/version — so a
      // coi:false with the header served can be pinned to browser support.
      sab: typeof SharedArrayBuffer !== "undefined",
      ua: (() => { try { return (navigator.userAgent || "").slice(0, 140); } catch { return ""; } })(),
    };
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    requestId = res.headers.get("x-request-id") || "";

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    if (!res.ok || !res.body || isJson) {
      const err = await res.json().catch(() => ({ error: "Request failed (" + res.status + ")" }));
      if (gen === generation) {
        setError(turn, err.error || "Something went wrong.");
        history.pop();
        pruneEmbeds();
      }
      return;
    }

    // The stream is live and the server will finish + park this answer even
    // if we vanish. Make it resumable after a FULL app relaunch (iOS can
    // discard a backgrounded PWA, losing all in-memory state): persist the
    // question to encrypted history now and drop a metadata-only pointer the
    // next boot polls from. Fire-and-forget — never delays the stream.
    armPendingRecovery(requestId, opts);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser(); // line buffering + [DONE]/keepalive filtering (sse.js)
    while (true) {
      const { done, value } = await reader.read();
      lastByteAt = Date.now(); // any read (data, keepalive, or EOF) proves the socket is live
      if (done) break;
      for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
        acc = handleEvent(turn, evt, acc);
      }
    }

    if (gen !== generation) {
      // Chat was cleared while the tail streamed in: nothing to render or
      // remember; purge the server's copy of an answer nobody will read.
      ackAnswer(requestId);
      return;
    }
    if (acc) {
      history.push({ role: "assistant", content: acc });
      ackAnswer(requestId); // delivered intact — purge the server's recovery copy
      clearPending(); // delivered — no relaunch resume needed
      await persistConversation(opts);
    } else if (isTyping(turn)) {
      setError(turn, "No response received.");
      await abandonUnanswered(opts);
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      if (gen !== generation) {
        // New chat cleared history while this stream was still running:
        // nothing to keep, no error UI, no beacon, no recovery — just
        // purge the abandoned server copy.
        ackAnswer(requestId);
        return;
      }
      if (staleAbort) {
        // The watchdog aborted a silent/hung stream (typically a socket
        // torn down while the app was backgrounded), NOT the user pressing
        // Stop — the server is still finishing, so recover the answer
        // rather than treating the partial as a deliberate stop.
        await handleNetworkFailure(turn, new Error("stream stalled — connection went silent"), acc, requestId, wasHidden, gen, opts);
        return;
      }
      await handleStopped(turn, acc, requestId, opts);
      return;
    }
    await handleNetworkFailure(turn, e, acc, requestId, wasHidden, gen, opts);
  } finally {
    inFlight = false;
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", onVisibility);
    collapseActivity(turn); // research done → fold the step bars away
  }
}

// The user pressed Stop mid-stream: keep whatever streamed so far as
// normal (non-error) context — that's the whole point of stopping instead
// of just waiting, the partial answer is still there for a follow-up
// question. The server finishes the research in the background regardless
// (src/chat.js's ctx.waitUntil), so purge its recovery copy — nobody will
// poll for it.
async function handleStopped(turn, acc, requestId, opts) {
  recordResearchEvent(turn, { event: "stopped", received_chars: acc.length });
  ackAnswer(requestId);
  clearPending(); // user stopped deliberately — no relaunch resume
  if (acc) {
    const stopped = acc + "\n\n*(Stopped.)*";
    setText(turn, stopped);
    history.push({ role: "assistant", content: stopped });
    await persistConversation(opts);
  } else {
    setError(turn, "Stopped before any response arrived.");
    history.pop();
    pruneEmbeds();
  }
}

// Any non-abort exception (dropped connection, backgrounded-tab network
// suspension, etc): tell the server why the client's side died, try to
// recover the finished answer from the short-lived server cache, and only
// fall back to a visible error once recovery comes up empty.
async function handleNetworkFailure(turn, e, acc, requestId, wasHidden, gen, opts) {
  // Tell the server why the client's side died — it often can't know (a
  // download-triggered navigation or backgrounded tab kills the fetch
  // without a clean disconnect). sendBeacon survives page teardown.
  try {
    navigator.sendBeacon?.(
      "/api/client-error",
      new Blob(
        [JSON.stringify({
          request_id: requestId,
          error: String(e?.message || e).slice(0, 200),
          was_hidden: wasHidden,
          received_chars: acc.length,
        })],
        { type: "application/json" },
      ),
    );
  } catch { /* reporting must never mask the real error */ }

  // The server finishes the research even when our connection dies and
  // parks the answer in a short-lived recovery cache — poll it back
  // before bothering the user. Settle whatever spinner the dead stream left
  // behind (it can never receive its step_done) and show a live ticking
  // banner instead — a frozen "Checking Google Maps…" spinner reads as
  // stuck forever (reported), while "Still researching… (Ns)" reads as the
  // progress it actually is.
  settlePendingSteps(turn);
  // The wait must be STOPPABLE (reported 2026-07-08: a run stuck at "Still
  // researching… (120s)" with a Stop button that did nothing — the original
  // request's controller was already aborted, so stopGeneration() had
  // nothing left to reach). A fresh controller in the module slot puts the
  // Stop button back in charge of THIS wait; the server run itself can't be
  // cancelled (it finishes and parks its answer regardless — waitUntil), but
  // the user gets their composer and conversation buttons back immediately.
  // Claimed only while this send still owns the conversation (gen check) —
  // a stale failure path must never grab a newer send's Stop button.
  const recoveryController = new AbortController();
  if (gen === generation) controller = recoveryController;
  const { data: recovered, reason } = await recoverAnswer(
    turn, requestId, opts.budgetS, () => gen === generation,
    "Connection dropped — research continues on the server…",
    recoveryController.signal,
  );
  recordResearchEvent(turn, {
    event: "stream_dropped",
    error: String(e?.message || e),
    was_hidden: wasHidden,
    received_chars: acc.length,
    recovered: !!recovered,
    recover_reason: reason,
  });
  if (gen !== generation || reason === "aborted") {
    // Chat was cleared while recovery was polling — drop the result.
    ackAnswer(requestId);
    return;
  }
  // Reaching here means this tab is alive and handled the drop in-session
  // (the PWA-discard case never runs any of this — the page is gone — so
  // its pointer survives untouched for the next boot to resume). Either way
  // the outcome is now decided here, so the pointer has done its job.
  clearPending();
  if (recovered) {
    await deliverRecoveredAnswer(turn, recovered, requestId, opts);
    return;
  }
  if (reason === "stopped") {
    // The user pressed Stop during the wait: settle exactly like stopping a
    // live stream — keep any partial answer as normal context, no error UI.
    await handleStopped(turn, acc, requestId, opts);
    return;
  }

  const ref = requestId ? " (ref " + requestId.slice(0, 8) + ")" : "";
  setError(
    turn,
    reason === "lost"
      ? "The research was interrupted on the server before it could finish — a long time " +
        "budget can exceed the hosting plan's per-request limit. Please try again, and if it " +
        "keeps happening, lower the time budget (the slider). " +
        (acc ? "The partial answer above stays in context." : "") + ref
      : wasHidden
        ? "The connection dropped while the app was in the background — phones pause " +
          "network for backgrounded apps, and this one stayed away long enough that the " +
          "finished answer could no longer be retrieved. The research still completed on " +
          "the server; a shorter switch away recovers automatically. " +
          (acc ? "The partial answer above stays in context — just ask a follow-up." : "Please send again.") + ref
        : "Network error: " + e.message + ref,
  );
  if (acc) {
    // Keep whatever streamed before the connection dropped: the partial
    // answer is visible in the bubble, so it must be in the context of
    // follow-up questions too. The marker tells the model (and reader)
    // that it ends abruptly.
    history.push({
      role: "assistant",
      content: acc + "\n\n[This answer was cut off by a connection error.]",
    });
    await persistConversation(opts);
  } else {
    // Nothing arrived at all — drop the question so a retry starts clean
    // (and reconcile the record armPendingRecovery may have persisted).
    await abandonUnanswered(opts);
  }
}
