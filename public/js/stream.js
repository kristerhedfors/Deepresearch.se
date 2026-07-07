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
import { saveConversation } from "./history-store.js";
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
  ragExcerptBlocks,
  stripOldImages,
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
  currentId = null;
  convTitle = null;
  convCreatedAt = null;
  convRagDocs = [];
  convProjectId = null; // the next send re-adopts whatever project is active
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
async function recoverAnswer(turn, requestId, budgetS, gen) {
  if (!requestId) return null;
  startGenericStep(turn, "recover", "Connection lost — recovering the answer…");
  const deadline = Date.now() + (budgetS + 120) * 1000;
  let misses = 0;
  while (Date.now() < deadline && gen === generation) {
    await sleep(4000);
    try {
      const res = await fetch("/api/chat/answer?id=" + encodeURIComponent(requestId));
      if (res.status === 404) {
        if (++misses >= 3) break;
        continue;
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === "done") {
        if (!data.text) break; // pipeline produced nothing — treat as failed
        finishGenericStep(turn, { id: "recover", label: "Answer recovered after connection loss" });
        return data;
      }
      misses = 0; // still researching — keep waiting
    } catch {
      // still offline — keep trying until the deadline
    }
  }
  finishGenericStep(turn, { id: "recover", label: "Could not recover the answer" });
  return null;
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
  // Retrieval scope: this conversation's attached docs PLUS its project's
  // indexed material — and nothing else (no other project can leak in;
  // the docId list IS the scope).
  const docIds = [...new Set([...convRagDocs.map((d) => d.id), ...projectDocIds(project)])];
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
  return ragExcerptBlocks(matches, names, metaByDoc);
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
  if (convRagDocs.length || projectDocIds(project).length) {
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

  // iOS suspends network for backgrounded apps/PWAs — the most common
  // cause of mid-stream drops. Track it so the error can say so.
  let wasHidden = document.hidden;
  const onVisibility = () => { if (document.hidden) wasHidden = true; };
  document.addEventListener("visibilitychange", onVisibility);

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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
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
      await persistConversation(opts);
    } else if (isTyping(turn)) {
      setError(turn, "No response received.");
      history.pop();
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
      await handleStopped(turn, acc, requestId, opts);
      return;
    }
    await handleNetworkFailure(turn, e, acc, requestId, wasHidden, gen, opts);
  } finally {
    inFlight = false;
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
  const recovered = await recoverAnswer(turn, requestId, opts.budgetS, gen);
  recordResearchEvent(turn, {
    event: "stream_dropped",
    error: String(e?.message || e),
    was_hidden: wasHidden,
    received_chars: acc.length,
    recovered: !!recovered,
  });
  if (gen !== generation) {
    // Chat was cleared while recovery was polling — drop the result.
    ackAnswer(requestId);
    return;
  }
  if (recovered) {
    acc = recovered.text;
    setText(turn, acc);
    if (recovered.stats) {
      turn.model = recovered.stats.model || "";
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
    wasHidden
      ? "Connection lost while the app was in the background — the phone pauses " +
        "network for backgrounded apps. Keep the app open while research runs. " +
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
    // Nothing arrived at all — drop the question so a retry starts clean.
    history.pop();
  }
}
