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
  resetForRevision,
  setError,
  setText,
} from "./turns.js";

const history = []; // {role, content} pairs sent to the API

let scrollDown = () => {};

export function initStream(scrollFn) {
  scrollDown = scrollFn;
}

export function clearHistory() {
  history.length = 0; // history lives only in this tab
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
  // multimodal parts.
  let apiText = text;
  for (const d of opts.docs) {
    apiText +=
      `\n\n--- Attached document: ${d.name}${d.truncated ? " (truncated)" : ""} ---\n` +
      d.text +
      "\n--- End of document ---";
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
  addUserBubble(text, opts.images.map((a) => a.dataUrl), opts.docs.map((d) => d.name));
  const turn = addAssistantTurn(text);
  let acc = "";

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
    });
    requestId = res.headers.get("x-request-id") || "";

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    if (!res.ok || !res.body || isJson) {
      const err = await res.json().catch(() => ({ error: "Request failed (" + res.status + ")" }));
      setError(turn, err.error || "Something went wrong.");
      history.pop();
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

    if (acc) {
      history.push({ role: "assistant", content: acc });
    } else if (isTyping(turn)) {
      setError(turn, "No response received.");
      history.pop();
    }
  } catch (e) {
    // Tell the server why the client's side died — it often can't know
    // (a download-triggered navigation or backgrounded tab kills the fetch
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
    } else {
      // Nothing arrived at all — drop the question so a retry starts clean.
      history.pop();
    }
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
    collapseActivity(turn); // research done → fold the step bars away
  }
}
