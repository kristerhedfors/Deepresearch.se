// DOM glue for the chat client (baseplate-client / secure-tier). Imports ONLY
// pure, Node-tested modules (sse.js, markdown.js). Verified live, not
// unit-tested itself. Holds the conversation in memory; posts the history to
// /api/chat and renders the streamed SSE events.

import { createSseParser } from "/js/sse.js";
import { renderMarkdown } from "/js/markdown.js";

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const searchBadge = document.getElementById("searchbadge");

/** @type {{role:string, content:string}[]} */
const history = [];
let busy = false;

// Probe /api/me for the search badge (fail-soft — the chat works regardless).
fetch("/api/me")
  .then((r) => (r.ok ? r.json() : null))
  .then((me) => { if (me && me.search) searchBadge.hidden = false; })
  .catch(() => {});

input.addEventListener("input", autogrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener("submit", onSubmit);

function autogrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
}

async function onSubmit(e) {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  autogrow();
  setBusy(true);

  addBubble("user", renderMarkdown(text));
  history.push({ role: "user", content: text });

  const bubble = addBubble("assistant", "");
  const steps = document.createElement("div");
  steps.className = "steps";
  bubble.appendChild(steps);
  const body = document.createElement("div");
  body.className = "body cursor";
  bubble.appendChild(body);

  let answer = "";
  let sources = [];
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    if (!resp.ok || !resp.body) throw new Error("request failed");
    const parser = createSseParser();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        if (ev.type === "status") addStep(steps, ev.phase === "triage" ? "Planning…" : "Writing…");
        else if (ev.type === "search_start") addStep(steps, `Searching: ${ev.query}`);
        else if (ev.type === "search_done") addStep(steps, `Found ${ev.results} result(s) for “${ev.query}”`);
        else if (ev.type === "delta") { answer += ev.text; body.innerHTML = renderMarkdown(answer); scrollDown(); }
        else if (ev.type === "done") sources = ev.sources || sources;
      }
    }
  } catch {
    answer = answer || "Something went wrong. Please try again.";
    body.innerHTML = renderMarkdown(answer);
  }

  body.classList.remove("cursor");
  if (sources.length) body.appendChild(renderSources(sources));
  history.push({ role: "assistant", content: answer });
  setBusy(false);
  scrollDown();
}

function setBusy(v) { busy = v; sendBtn.disabled = v; input.disabled = v; if (!v) input.focus(); }

function addBubble(role, html) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = html;
  chat.appendChild(el);
  scrollDown();
  return el;
}

function addStep(steps, label) {
  const s = document.createElement("div");
  s.className = "step";
  s.innerHTML = `<span class="dot">●</span><span></span>`;
  s.lastElementChild.textContent = label;
  steps.appendChild(s);
  scrollDown();
}

function renderSources(sources) {
  const d = document.createElement("details");
  d.className = "sources";
  const items = sources
    .map((s) => `<li><a href="${encodeURI(s.url)}" target="_blank" rel="noopener noreferrer"></a></li>`)
    .join("");
  d.innerHTML = `<summary>${sources.length} source(s)</summary><ol>${items}</ol>`;
  // Set link text safely (avoid injecting title markup).
  d.querySelectorAll("a").forEach((a, i) => { a.textContent = sources[i].title || sources[i].url; });
  return d;
}

function scrollDown() { chat.scrollTop = chat.scrollHeight; }
