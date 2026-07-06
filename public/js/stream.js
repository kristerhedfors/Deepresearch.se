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

const history = []; // {role, content} pairs sent to the API

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
  renderStoredConversation(record.messages);
  scrollDown(true);
}

function deriveTitle(hist) {
  const first = hist.find((m) => m.role === "user");
  const text =
    typeof first?.content === "string"
      ? first.content
      : (first?.content || []).find((p) => p.type === "text")?.text || "";
  return text.trim().slice(0, 60) || "New conversation";
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
    await saveConversation(currentId, {
      title: convTitle,
      messages: history,
      model: opts?.model || "",
      budgetS: opts?.budgetS ?? null,
      webSearch: opts?.webSearch !== false,
      createdAt: convCreatedAt,
      updatedAt: now,
    });
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
    setError(turn, evt.error);
    return acc;
  }
  if (evt.status) {
    const s = evt.status;
    if (s.type === "search_start") startSearchStep(turn, s.query || "");
    else if (s.type === "search_done") finishSearchStep(turn, s);
    else if (s.type === "step_start") startGenericStep(turn, s.id, s.label || "");
    else if (s.type === "step_done") finishGenericStep(turn, s);
    else if (s.type === "done") {
      turn.model = s.model || ""; // titles the PDF report metadata
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

// Keep images only on the latest message when sending: history is resent
// every turn and would otherwise re-inflate each request past the
// provider's ~1 MB body limit. Older turns keep their text plus a marker.
function messagesForApi() {
  return history.map((m, i) => {
    if (i === history.length - 1 || m.role !== "user" || typeof m.content === "string") return m;
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return {
      role: "user",
      content: (text ? text + "\n" : "") + "[image was attached earlier in this conversation]",
    };
  });
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
  let apiText = text;
  for (const d of opts.docs) {
    apiText +=
      `\n\n--- Attached document: ${d.name}${d.truncated ? " (truncated)" : ""} ---\n` +
      (d.metadata ? `[Document metadata]\n${d.metadata}\n\n` : "") +
      d.text +
      "\n--- End of document ---";
  }
  for (const a of opts.images) {
    if (a.metadata) {
      apiText += `\n\n--- Image metadata: ${a.name} ---\n${a.metadata}\n--- End of image metadata ---`;
    }
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
      messages: messagesForApi(),
      time_budget_s: opts.budgetS,
      web_search: opts.webSearch,
    };
    if (opts.model) payload.model = opts.model;
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
