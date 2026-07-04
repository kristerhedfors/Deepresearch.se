// Deepresearch.se chat client — bootstrap and wiring.
//
// Module map:
//   timescale.js — slider position <-> seconds mapping (pure)
//   markdown.js  — sanitized markdown rendering (vendored marked+DOMPurify)
//   turns.js     — user bubbles + assistant turns (content, tools, typing)
//   activity.js  — live research step bars, stats footer, collapse
//
// This file owns the page state (history, attachments, models, budget,
// auto-follow) and the /api/chat SSE consumption, dispatching events to the
// turn/activity renderers.

import {
  collapseActivity,
  finishGenericStep,
  finishSearchStep,
  renderStats,
  startGenericStep,
  startSearchStep,
} from "./activity.js";
import { BUDGET_MAX_S, BUDGET_MIN_S, fmtBudget, posToSeconds, secondsToPos } from "./timescale.js";
import {
  addAssistantTurn,
  addUserBubble,
  clearChatDom,
  initTurns,
  isTyping,
  resetForRevision,
  setError,
  setText,
} from "./turns.js";

// ---- Elements & state -------------------------------------------------

const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const modelSel = document.getElementById("model");
const attachBtn = document.getElementById("attach");
const fileInput = document.getElementById("file");
const pendingBox = document.getElementById("pending");

const history = []; // {role, content} pairs sent to the API
let knownModels = []; // /api/models entries, for vision capability lookup
let attachments = []; // pending images: {name, dataUrl}

// ---- Auto-follow scrolling ---------------------------------------------
// Streaming pins the view to the bottom ONLY while the user is already
// there. Scrolling up detaches (no yank-back on the next token) and shows
// the jump-down button; pressing it — or scrolling back down yourself —
// re-attaches.

const jumpBtn = document.getElementById("jumpdown");
let autoFollow = true;
let immersive = false;

// Immersive reading: while scrolled up in the content, hide the header and
// the input/controls so the whole screen is content — only the jump-down
// button stays. Reaching the bottom again (scroll or button) brings the
// chrome back.
const chromeEls = [document.querySelector("header"), document.getElementById("footer")];
const chromeHeight = () => chromeEls.reduce((h, el) => h + (el?.offsetHeight || 0), 0);

function setImmersive(on) {
  if (immersive === on) return;
  immersive = on;
  document.body.classList.toggle("immersive", on);
}

// Leaving immersive mode slides the chrome back over ~200ms, shrinking the
// chat view a little each frame — so keep pinning to the true bottom until
// the animation settles, otherwise the returning footer covers the last
// lines the user just read.
function exitImmersiveToBottom() {
  setImmersive(false);
  // Keep the expanding chrome clipped for the duration of the slide-back
  // (overflow:hidden lives on this class, not permanently — see app.css).
  document.body.classList.add("chrome-restoring");
  setTimeout(() => document.body.classList.remove("chrome-restoring"), 260);
  autoFollow = true;
  jumpBtn.hidden = true;
  const until = performance.now() + 320;
  const pin = () => {
    chat.scrollTop = chat.scrollHeight;
    if (performance.now() < until && autoFollow) requestAnimationFrame(pin);
  };
  pin();
}

chat.addEventListener("scroll", () => {
  const fromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  const nearBottom = fromBottom < 48;
  autoFollow = nearBottom;
  jumpBtn.hidden = nearBottom;
  if (immersive) {
    if (nearBottom) exitImmersiveToBottom();
  } else if (fromBottom > chromeHeight() + 96) {
    // Hysteresis: hiding the chrome grows the chat view by chromeHeight(),
    // pulling the position that much closer to the bottom. Entering on a
    // smaller distance would land inside the exit threshold and flicker.
    setImmersive(true);
  }
});
jumpBtn.addEventListener("click", () => {
  // Instant, not smooth: a smooth animation fires intermediate scroll
  // events that read as "user scrolled away" and re-detach — and the
  // bottom keeps moving while content streams.
  if (immersive) {
    exitImmersiveToBottom();
    return;
  }
  autoFollow = true;
  chat.scrollTop = chat.scrollHeight;
  jumpBtn.hidden = true;
});
const scrollDown = (force = false) => {
  if (force) autoFollow = true;
  if (autoFollow) chat.scrollTop = chat.scrollHeight;
};
initTurns(chat, scrollDown);

// ---- Model dropdown ------------------------------------------------------
// Populated from /api/models, selection kept in localStorage. If the
// catalog can't load, the dropdown stays hidden and the server default
// applies.

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) return;
    const data = await res.json();
    const models = data.models || [];
    if (models.length === 0) return;
    knownModels = models;
    modelSel.replaceChildren();
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.up === false ? m.name + " (unavailable)" : m.name;
      if (m.up === false) opt.disabled = true;
      if (m.pricing) opt.title = m.pricing;
      modelSel.appendChild(opt);
    }
    const usable = (m) => m.up !== false;
    const saved = localStorage.getItem("model");
    const pick = models.some((m) => m.id === saved && usable(m)) ? saved
      : models.some((m) => m.id === data.default && usable(m)) ? data.default
      : (models.find(usable) || models[0]).id;
    modelSel.value = pick;
    modelSel.hidden = false;
    updateAttachState();
  } catch { /* keep dropdown hidden; server default applies */ }
}
modelSel.addEventListener("change", () => {
  localStorage.setItem("model", modelSel.value);
  updateAttachState();
});
loadModels();

// ---- Research time-target slider ----------------------------------------
// Persisted as seconds; sent as time_budget_s with each request (the server
// plans the spend — src/budget.js). Position mapping in timescale.js.

const budgetSlider = document.getElementById("budget");
const budgetVal = document.getElementById("budgetval");
let budgetS = 60;
const savedBudget = parseInt(localStorage.getItem("budget_s"), 10);
if (savedBudget >= BUDGET_MIN_S && savedBudget <= BUDGET_MAX_S) budgetS = savedBudget;
budgetSlider.value = secondsToPos(budgetS);
const updateBudgetVal = () => { budgetVal.textContent = fmtBudget(budgetS); };
budgetSlider.addEventListener("input", () => {
  budgetS = posToSeconds(Number(budgetSlider.value));
  updateBudgetVal();
  localStorage.setItem("budget_s", String(budgetS));
});
updateBudgetVal();

// ---- Web-search knob ------------------------------------------------------
// Default on. Off = the answer comes from the model only; the time slider
// is moot then, so it dims.

const webSearchBox = document.getElementById("websearch");
webSearchBox.checked = localStorage.getItem("web_search") !== "off";
const syncSearchToggle = () => {
  budgetSlider.disabled = !webSearchBox.checked;
  document.getElementById("budgetbar").classList.toggle("nosearch", !webSearchBox.checked);
};
webSearchBox.addEventListener("change", () => {
  localStorage.setItem("web_search", webSearchBox.checked ? "on" : "off");
  syncSearchToggle();
});
syncSearchToggle();

// 🔍 symbol: tap/click for a popover explaining the web-search knob
// (title tooltips don't exist on touch devices).
const searchPop = document.getElementById("searchpop");
document.getElementById("searchinfo").addEventListener("click", (e) => {
  e.stopPropagation();
  searchPop.hidden = !searchPop.hidden;
});
document.addEventListener("click", (e) => {
  if (!searchPop.hidden && !searchPop.contains(e.target)) searchPop.hidden = true;
});

// ---- Header: clear chat ----------------------------------------------------

document.getElementById("clearbtn").addEventListener("click", () => {
  history.length = 0; // history lives only in this tab
  clearChatDom();
  input.focus();
});

// ---- First-visit privacy notice (acknowledgement kept in a cookie) --------

const privacy = document.getElementById("privacy");
if (!/(?:^|;\s*)dr_privacy_ack=1/.test(document.cookie)) privacy.hidden = false;
document.getElementById("privacyok").addEventListener("click", () => {
  document.cookie = "dr_privacy_ack=1; max-age=31536000; path=/; SameSite=Lax; Secure";
  privacy.hidden = true;
});

// ---- Image attachments (vision-capable models only) ------------------------

const MAX_ATTACH = 4;
const MAX_RAW_BYTES = 25 * 1024 * 1024; // sanity cap on input files
// The LLM provider rejects request bodies over ~1 MB, so images are
// downscaled to JPEG data URLs within these budgets before attaching.
const PER_IMAGE_CHARS = 280000;
const TOTAL_IMAGE_CHARS = 700000;

function currentModel() {
  return knownModels.find((m) => m.id === modelSel.value);
}

function updateAttachState() {
  const vision = !!currentModel()?.vision;
  // Never disable: on touch devices a disabled button gives no feedback
  // (title tooltips don't exist there). Dim it instead; the tap handler
  // explains and offers to switch models.
  attachBtn.classList.toggle("dim", !vision);
  attachBtn.title = vision
    ? "Attach images"
    : "Image input needs a vision-capable model — tap to switch";
  if (!vision && attachments.length) {
    attachments = [];
    renderPending();
  }
}

function renderPending() {
  pendingBox.replaceChildren();
  attachments.forEach((a, i) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.alt = a.name;
    img.title = a.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      attachments.splice(i, 1);
      renderPending();
    });
    wrap.append(img, rm);
    pendingBox.appendChild(wrap);
  });
}

attachBtn.addEventListener("click", () => {
  if (currentModel()?.vision) {
    fileInput.click();
    return;
  }
  // Non-vision model selected: explain and offer a one-tap switch.
  const alt = knownModels.find((m) => m.vision && m.up !== false);
  if (!alt) {
    alert(knownModels.length
      ? "No vision-capable models are currently available."
      : "The model list is still loading — try again in a moment.");
    return;
  }
  if (confirm("Image attachments need a vision-capable model.\nSwitch to " + alt.name + "?")) {
    modelSel.value = alt.id;
    localStorage.setItem("model", alt.id);
    updateAttachState();
    // Some mobile browsers consume the user gesture on confirm(); if the
    // picker doesn't open now, the button is active for the next tap.
    fileInput.click();
  }
});

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  for (const file of files) {
    if (attachments.length >= MAX_ATTACH) {
      alert("Max " + MAX_ATTACH + " images per message.");
      break;
    }
    if (file.size > MAX_RAW_BYTES) {
      alert(file.name + " is too large.");
      continue;
    }
    const used = attachments.reduce((s, a) => s + a.dataUrl.length, 0);
    const budget = Math.min(PER_IMAGE_CHARS, TOTAL_IMAGE_CHARS - used);
    if (budget < 60000) {
      alert("Image size budget for this message is full — send these first.");
      break;
    }
    try {
      const dataUrl = await downscaleImage(file, budget);
      if (!dataUrl) {
        alert("Could not compress " + file.name + " enough to send.");
        continue;
      }
      attachments.push({ name: file.name, dataUrl });
      renderPending();
    } catch {
      alert("Could not read " + file.name + " as an image.");
    }
  }
});

// Phone photos are several MB but the LLM provider rejects request bodies
// over ~1 MB — resize to max 1280px and walk JPEG quality (then dimensions)
// down until the data URL fits the budget.
async function downscaleImage(file, budgetChars) {
  const img = await loadImage(file);
  const iw = img.width || img.naturalWidth;
  const ih = img.height || img.naturalHeight;
  if (!iw || !ih) return null;
  let edge = 1280;
  while (edge >= 320) {
    const scale = Math.min(1, edge / Math.max(iw, ih));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(iw * scale));
    canvas.height = Math.max(1, Math.round(ih * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.65, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= budgetChars) return url;
    }
    edge = Math.round(edge * 0.7);
  }
  return null;
}

function loadImage(file) {
  return createImageBitmap(file).catch(
    () =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      }),
  );
}

// ---- Sending & SSE consumption ---------------------------------------------

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
    else if (s.type === "done") renderStats(turn, s);
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

async function sendMessage(text) {
  // Build message content: plain string, or a multimodal array when images
  // are attached (OpenAI-style parts).
  const images = attachments.slice();
  attachments = [];
  renderPending();
  let content = text;
  if (images.length) {
    content = [];
    if (text) content.push({ type: "text", text });
    for (const a of images) {
      content.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  history.push({ role: "user", content });
  addUserBubble(text, images.map((a) => a.dataUrl));
  const turn = addAssistantTurn();
  let acc = "";

  try {
    const payload = {
      messages: messagesForApi(),
      time_budget_s: budgetS,
      web_search: webSearchBox.checked,
    };
    if (!modelSel.hidden && modelSel.value) payload.model = modelSel.value;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

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
    setError(turn, "Network error: " + e.message);
    history.pop();
  } finally {
    collapseActivity(turn); // research done → fold the step bars away
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && attachments.length === 0) return;
  input.value = "";
  send.disabled = true;
  await sendMessage(text);
  send.disabled = false;
  input.focus();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
