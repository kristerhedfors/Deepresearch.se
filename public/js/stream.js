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
  renderStats,
  startGenericStep,
  startSearchStep,
  updateGenericStep,
} from "./activity.js";
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
  deriveTitle,
  imageMetadataBlock,
  inlineDocBlock,
  isStreamStale,
  ragExcerptBlocks,
  stripOldImages,
  STREAM_STALL_MS,
} from "./message-content.js";
import { firstChunks, retrieve } from "./rag.js";

const history = []; // {role, content} pairs sent to the API

// Large documents attached to this conversation (RAG-indexed — see
// public/js/rag.js): follow-up questions keep retrieving from them, so
// their ids/names are conversation state, persisted in the encrypted
// record (`ragDocs`) and restored on load.
let convRagDocs = []; // [{id, name}]

// The project this conversation belongs to (null = none): adopted from the
// active project on the FIRST send of a fresh conversation, persisted in
// the encrypted record, restored on load. Project scope means: retrieval
// runs across the project's indexed docs too, the project-materials block
// (inventory + image EXIF) rides in each message, and persistence honors
// the project's cloud knob.
let convProjectId = null;

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
// written to the encrypted local store or the cloud copy. Set only before
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

export function initStream(scrollFn, opts = {}) {
  scrollDown = scrollFn;
  onHistoryChange = opts.onHistoryChange || onHistoryChange;
}

// The id of the conversation currently on screen, or null for a fresh,
// not-yet-saved chat — used by the sidebar to highlight the active entry.
export function currentConversationId() {
  return currentId;
}

// Sidebar "load": replace the on-screen conversation with a previously
// saved one. Aborts any in-flight request and bumps `generation` exactly
// like clearHistory, so a stream from the conversation being replaced can
// never write into the newly loaded one.
export function applyLoadedConversation(record) {
  controller?.abort();
  controller = null;
  generation++;
  history.length = 0;
  history.push(...record.messages);
  currentId = record.id;
  convTitle = record.title;
  convCreatedAt = record.createdAt;
  convRagDocs = Array.isArray(record.ragDocs) ? record.ragDocs : [];
  convIncognito = false; // a saved conversation is by definition not incognito
  clearPending(); // opening another conversation cancels any pending-answer resume
  // Reopening a project conversation re-enters that project's context
  // (and leaving one, a plain conversation leaves it).
  convProjectId = record.projectId || null;
  setActiveProject(convProjectId);
  renderStoredConversation(record.messages);
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
  currentId = null;
  convTitle = null;
  convCreatedAt = null;
  convRagDocs = [];
  convProjectId = null; // the next send re-adopts whatever project is active
  convIncognito = false; // incognito is chosen per conversation, never inherited
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ackAnswer(requestId) {
  if (!requestId) return;
  fetch("/api/chat/answer?id=" + encodeURIComponent(requestId), { method: "DELETE" }).catch(() => {});
}

// The pipeline may still be researching when our connection dies (it runs
// to completion server-side), so keep polling until well past the time
// budget. Repeated 404s mean recovery isn't available (no DB, or expired).
// `gen` ends the poll early if the user starts a new chat meanwhile.
// Polls the server-parked answer. Returns { data, reason } where reason is:
//   "done"    — data holds the recovered answer
//   "lost"    — the server confirmed the run died (stale heartbeat)
//   "gone"    — no recovery row (no DB, or already expired/purged)
//   "empty"   — the run finished but produced nothing
//   "timeout" — still running when the deadline passed
//   "aborted" — a new chat/load ended the poll
// Once the server confirms the run is still going, the step shows a live
// elapsed counter so a long research run reads as progress, not a frozen
// app.
//
// `startLabel` null → SILENT recovery: poll WITHOUT adding any banner, so an
// in-session drop keeps showing exactly the research banners already on
// screen (plan ✓, search ✓, gap check spinning…) — the research genuinely
// continued on the server, so "the same view as before" is the honest one,
// no "connection lost" overlay. The turn's own typing icon already signals
// in-progress. A banner is shown only for a boot RESUME, where the page
// reloaded and there are NO existing banners to keep; there its counter is
// driven by its own 1-second ticker, decoupled from the (slower,
// latency-variable) network poll so it ticks evenly instead of lurching by
// the poll interval.
async function recoverAnswer(turn, requestId, budgetS, gen, startLabel = null) {
  if (!requestId) return { data: null, reason: "gone" };
  const showStep = !!startLabel;
  if (showStep) startGenericStep(turn, "recover", startLabel);
  const startedAt = Date.now();
  const deadline = startedAt + ((budgetS || 60) + 120) * 1000;
  let misses = 0;
  let reason = "timeout";
  let running = false; // flips true once the server confirms it's still researching

  const ticker = showStep
    ? setInterval(() => {
        if (running) {
          updateGenericStep(turn, "recover", `Still researching on the server… (${Math.round((Date.now() - startedAt) / 1000)}s)`);
        }
      }, 1000)
    : null;

  try {
    // Poll immediately first: on a boot resume the server usually finished
    // while we were away, so the answer is already parked and the very first
    // poll returns it — no wait. Only if it's still running do we sleep/re-poll.
    while (Date.now() < deadline && gen === generation) {
      try {
        const res = await fetch("/api/chat/answer?id=" + encodeURIComponent(requestId));
        if (res.status === 404) {
          if (++misses >= 3) { reason = "gone"; break; }
        } else if (res.ok) {
          const data = await res.json();
          if (data.status === "done") {
            if (!data.text) { reason = "empty"; break; }
            if (showStep) finishGenericStep(turn, { id: "recover", label: "Answer recovered after connection loss" });
            return { data, reason: "done" };
          }
          if (data.status === "lost") { reason = "lost"; break; } // server run died
          misses = 0; // still researching
          running = true;
        }
      } catch {
        // still offline — keep trying until the deadline
      }
      await sleep(4000);
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
  if (gen !== generation) reason = "aborted";
  if (showStep) {
    finishGenericStep(turn, {
      id: "recover",
      label: reason === "lost" ? "Research was interrupted on the server" : "Could not recover the answer",
    });
  }
  return { data: null, reason };
}

// Arm resume-across-relaunch for the in-flight send: persist the question to
// encrypted history NOW (so a cold boot after a PWA discard can show it) and
// drop a metadata-only pointer (pending-answer.js) the next boot polls the
// server-parked answer from. Incognito persists nothing anywhere, so it opts
// out entirely (no encrypted record to reopen, no pointer written). Both
// writes are fire-and-forget so the stream is never delayed.
// A send that produced NO answer at all (empty completion, or a drop we
// couldn't recover): revert the unanswered question so a retry starts clean,
// and keep the encrypted record consistent with that. armPendingRecovery may
// have already persisted the question at stream start, so — unlike a plain
// pop — reconcile the stored record too: re-persist the reverted history for
// a follow-up, or delete the just-created record for a lone first message.
async function abandonUnanswered(opts) {
  clearPending();
  history.pop();
  if (!currentId) return; // nothing was persisted (incognito, or never armed)
  if (history.length) {
    await persistConversation(opts); // follow-up: store the reverted history
  } else {
    const id = currentId;
    currentId = null;
    convTitle = null;
    convCreatedAt = null;
    convRagDocs = [];
    convProjectId = null; // the discarded conversation is gone; next send starts fresh
    try { await deleteConversation(id); } catch { /* best effort */ }
    onHistoryChange(id);
  }
}

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

// The user's latest message split into display text + image data URLs, for
// re-hydrating the assistant turn on a boot resume (so its PDF report keeps
// the title/images a live turn would have had).
function lastUserParts(content) {
  if (typeof content === "string") return { text: content, imageUrls: [] };
  if (Array.isArray(content)) {
    return {
      text: content.filter((p) => p?.type === "text").map((p) => p.text).join("\n"),
      imageUrls: content.filter((p) => p?.type === "image_url").map((p) => p.image_url?.url).filter(Boolean),
    };
  }
  return { text: "", imageUrls: [] };
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

  // Reopen the conversation, mirroring applyLoadedConversation.
  controller?.abort();
  controller = null;
  generation++;
  const gen = generation;
  history.length = 0;
  history.push(...msgs);
  currentId = pending.convId;
  convTitle = record.title || null;
  convCreatedAt = record.createdAt || Date.now();
  convRagDocs = Array.isArray(record.ragDocs) ? record.ragDocs : [];
  convIncognito = false;
  convProjectId = record.projectId || null;
  setActiveProject(convProjectId);
  renderStoredConversation(msgs);
  if (onLoad) {
    try { onLoad(record); } catch { /* settings restore is best-effort */ }
  }

  const { text, imageUrls } = lastUserParts(msgs[msgs.length - 1].content);
  const turn = addAssistantTurn(text, imageUrls);
  scrollDown(true);

  const opts = { model: pending.model, budgetS: pending.budgetS, webSearch: pending.webSearch };
  // Mark the app as streaming while polling so the composer treats a click
  // as Stop, not a competing send that would race the recovered answer.
  inFlight = true;
  let recovered = null;
  let reason = "timeout";
  try {
    ({ data: recovered, reason } = await recoverAnswer(turn, pending.requestId, pending.budgetS, gen, "Resuming your research…"));
  } finally {
    inFlight = false;
    collapseActivity(turn);
  }
  if (gen !== generation || reason === "aborted") return false; // user navigated away while polling
  clearPending();
  if (recovered) {
    setText(turn, recovered.text);
    if (recovered.stats) {
      turn.model = recovered.stats.model || "";
      turn.doneStats = recovered.stats;
      renderStats(turn, recovered.stats);
    }
    history.push({ role: "assistant", content: recovered.text });
    ackAnswer(pending.requestId);
    await persistConversation(opts);
    return true;
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

// Dispatch one SSE event to the turn/activity renderers. Returns the updated
// text accumulator.
function handleEvent(turn, evt, acc) {
  if (evt.error) {
    setError(turn, evt.error); // setError records it into researchLog
    return acc;
  }
  if (evt.status) {
    const s = evt.status;
    recordResearchEvent(turn, s);
    if (s.type === "search_start") startSearchStep(turn, s.query || "");
    else if (s.type === "search_done") finishSearchStep(turn, s);
    else if (s.type === "step_start") startGenericStep(turn, s.id, s.label || "");
    else if (s.type === "step_done") finishGenericStep(turn, s);
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
// "Copy research JSON" debug button (activity.js).
function recordResearchEvent(turn, entry) {
  if (!turn.researchLog) return;
  turn.researchLog.push({ t: Date.now() - (turn.startedAt || Date.now()), ...entry });
}

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

// One send: text plus attachments already collected by the composer.
// opts: {images, docs, model, budgetS, webSearch}
export async function sendMessage(text, opts) {
  // Build message content. Documents become labeled text blocks in the
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
  // message is sent; after that the conversation's own projectId rules.
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
  history.push({ role: "user", content });
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
    const payload = {
      messages: stripOldImages(history),
      time_budget_s: opts.budgetS,
      web_search: opts.webSearch,
    };
    if (opts.model) payload.model = opts.model;
    // Raw GPS coordinates ride separately from the message text — the
    // Worker resolves them to a place name (src/geocode.js) and appends
    // that as its own context block, rather than the client guessing.
    const imageLocations = opts.images
      .filter((a) => a.gps)
      .map((a) => ({ name: a.name, lat: a.gps.lat, lon: a.gps.lon }));
    if (imageLocations.length) payload.imageLocations = imageLocations;
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
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      lastByteAt = Date.now(); // any read (data, keepalive, or EOF) proves the socket is live
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          acc = handleEvent(turn, JSON.parse(data), acc);
        } catch { /* ignore keep-alive / non-JSON lines */ }
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
  // before bothering the user.
  const { data: recovered, reason } = await recoverAnswer(turn, requestId, opts.budgetS, gen);
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
    acc = recovered.text;
    setText(turn, acc);
    if (recovered.stats) {
      turn.model = recovered.stats.model || "";
      turn.doneStats = recovered.stats;
      renderStats(turn, recovered.stats);
    }
    history.push({ role: "assistant", content: acc });
    ackAnswer(requestId);
    await persistConversation(opts);
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
