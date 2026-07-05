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
import { docExt, isParsableDoc, parseDocFile } from "./docs.js";
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

// The chrome (header items, composer) floats as fixed glass panes over
// the content — nothing hides or slides; the chat scrolls beneath and
// shows through the translucency and the gaps between items.
const jumpBtn = document.getElementById("jumpdown");
let autoFollow = true;

chat.addEventListener("scroll", () => {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  autoFollow = nearBottom;
  jumpBtn.hidden = nearBottom;
});
jumpBtn.addEventListener("click", () => {
  // Instant, not smooth: a smooth animation fires intermediate scroll
  // events that read as "user scrolled away" and re-detach — and the
  // bottom keeps moving while content streams.
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
  document.getElementById("composer").classList.toggle("nosearch", !webSearchBox.checked);
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

// ---- Account & usage panel (/api/me: quota bars, admin link, logout) -------

const accountOverlay = document.getElementById("account");
const accountBody = document.getElementById("account-body");
document.getElementById("accountbtn").addEventListener("click", async () => {
  accountOverlay.hidden = false;
  accountBody.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const res = await fetch("/api/me");
    if (!res.ok) throw new Error("HTTP " + res.status);
    renderAccount(await res.json());
  } catch {
    accountBody.innerHTML = '<p class="muted">Could not load account info.</p>';
  }
});
document.getElementById("accountclose").addEventListener("click", () => {
  accountOverlay.hidden = true;
});
accountOverlay.addEventListener("click", (e) => {
  if (e.target === accountOverlay) accountOverlay.hidden = true;
});

// Users see: an OPAQUE research-budget bar (cost-backed server-side, but
// only a percentage ever reaches the client — never amounts) and plain
// search counts. Currency is the admin's concern.
function usageBlock(label, win, rolling) {
  const fmtN = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
    return String(n);
  };
  const track = (pct) =>
    `<div class="usage-track"><div class="usage-fill${pct >= 90 ? " hot" : ""}" style="width:${Math.min(100, pct)}%"></div></div>`;
  const budgetPct = win.budget_pct;
  const budgetBar =
    budgetPct == null
      ? `<div class="usage-row"><span>Research budget</span><span>no cap</span></div>${track(0)}`
      : `<div class="usage-row"><span>Research budget</span><span>${budgetPct}%</span></div>${track(budgetPct)}`;
  const sPct = win.searches_limit > 0 ? (win.searches / win.searches_limit) * 100 : 0;
  const searchBar =
    `<div class="usage-row"><span>Web searches · ${fmtN(win.searches)}${win.searches_limit > 0 ? " of " + fmtN(win.searches_limit) : ""}</span>
      <span>${win.searches_limit > 0 ? Math.round(sPct) + "%" : ""}</span></div>${track(sPct)}`;
  const reset = win.reset
    ? `${rolling ? "frees up" : "resets"} ${new Date(win.reset).toLocaleString()}`
    : "";
  return `<div class="usage-block"><div class="lbl">${label}${reset ? " · " + reset : ""}</div>
    ${budgetBar}
    ${searchBar}
  </div>`;
}

function renderAccount(me) {
  const who = me.email
    ? `${me.name && me.name !== me.email ? me.name + " · " : ""}${me.email}`
    : "Site administrator";
  const periods = [
    ["Last 5 hours", "h5"],
    ["Today", "day"],
    ["This week", "week"],
    ["This month", "month"],
  ];
  const blocks = periods
    .map(([label, p]) => usageBlock(label, me.windows[p], p === "h5"))
    .join("");
  accountBody.innerHTML = `
    <p class="who">${who}<span class="role-badge">${me.unlimited ? "admin · unlimited" : me.role}</span></p>
    ${me.unlimited ? '<p class="muted">Break-glass admin session — usage is tracked under the shared "admin" identity with no personal quota. Sign in with Google to see your own bars.</p>' : ""}
    ${!me.unlimited && !me.enforced ? '<p class="muted">Admin account: bars are shown for reference and keep counting past 100% — nothing blocks you.</p>' : ""}
    ${blocks}
    ${me.db_configured ? "" : '<p class="muted">Accounts database not configured yet — usage tracking and quotas are off.</p>'}
    <div class="account-actions">
      <a href="/help/">Documentation</a>
      ${me.role === "admin" ? '<a href="/admin">Admin interface</a>' : ""}
      <button id="logoutbtn" type="button">Sign out</button>
    </div>`;
  document.getElementById("logoutbtn").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    location.href = "/login";
  });
}

// ---- First-visit privacy notice (acknowledgement kept in a cookie) --------

const privacy = document.getElementById("privacy");
if (!/(?:^|;\s*)dr_privacy_ack=1/.test(document.cookie)) privacy.hidden = false;
document.getElementById("privacyok").addEventListener("click", () => {
  document.cookie = "dr_privacy_ack=1; max-age=31536000; path=/; SameSite=Lax; Secure";
  privacy.hidden = true;
});

// ---- Attachments: images (vision models) + documents (pdf/docx/md/txt) -----

const MAX_IMAGES = 4;
const MAX_DOCS = 3;
const MAX_RAW_BYTES = 25 * 1024 * 1024; // sanity cap on input files
// The LLM provider rejects request bodies over ~1 MB, so images are
// downscaled to JPEG data URLs within these budgets before attaching.
const PER_IMAGE_CHARS = 280000;
const TOTAL_IMAGE_CHARS = 700000;
// Documents become extracted text inside the message; the server caps a
// message at 32K chars, so each doc gets a slice of that.
const PER_DOC_CHARS = 9000;

const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
const images = () => attachments.filter((a) => a.kind === "image");
const docs = () => attachments.filter((a) => a.kind === "doc");

function currentModel() {
  return knownModels.find((m) => m.id === modelSel.value);
}

function updateAttachState() {
  // Documents attach on every model; images need vision. Keep the button
  // fully active either way — the vision question is handled per-file.
  const vision = !!currentModel()?.vision;
  attachBtn.title = vision
    ? "Attach images or documents (pdf, docx, md, txt)"
    : "Attach documents (pdf, docx, md, txt) — images need a vision model";
  if (!vision && images().length) {
    attachments = attachments.filter((a) => a.kind !== "image");
    renderPending();
  }
}

// Each attachment renders as a rounded card (thumb or file icon + name)
// with a white circular × in its upper-right corner — on their own line
// at the bottom of the glass pane.
function renderPending() {
  pendingBox.replaceChildren();
  attachments.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "att-card";
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name;
      card.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "📄";
      card.appendChild(icon);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = a.name;
    name.title = a.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = a.kind === "image" ? "image" : a.ext + (a.truncated ? " · truncated" : "");
    meta.append(name, sub);
    card.appendChild(meta);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "att-remove";
    rm.textContent = "✕";
    rm.title = "Remove attachment";
    rm.setAttribute("aria-label", "Remove " + a.name);
    rm.addEventListener("click", () => {
      attachments.splice(i, 1);
      renderPending();
    });
    card.appendChild(rm);
    pendingBox.appendChild(card);
  });
}

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  for (const file of files) {
    if (file.size > MAX_RAW_BYTES) {
      alert(file.name + " is too large.");
      continue;
    }
    if (isImageFile(file)) await addImageFile(file);
    else if (isParsableDoc(file)) await addDocFile(file);
    else alert(file.name + ": unsupported type. Use images or pdf, docx, md, txt.");
  }
});

async function addImageFile(file) {
  if (!currentModel()?.vision) {
    // Explain and offer a one-tap switch to a vision-capable model.
    const alt = knownModels.find((m) => m.vision && m.up !== false);
    if (!alt) {
      alert("Images need a vision-capable model and none is available right now.");
      return;
    }
    if (!confirm("Image attachments need a vision-capable model.\nSwitch to " + alt.name + "?")) return;
    modelSel.value = alt.id;
    localStorage.setItem("model", alt.id);
    updateAttachState();
  }
  if (images().length >= MAX_IMAGES) {
    alert("Max " + MAX_IMAGES + " images per message.");
    return;
  }
  const used = images().reduce((s, a) => s + a.dataUrl.length, 0);
  const budget = Math.min(PER_IMAGE_CHARS, TOTAL_IMAGE_CHARS - used);
  if (budget < 60000) {
    alert("Image size budget for this message is full — send these first.");
    return;
  }
  try {
    const dataUrl = await downscaleImage(file, budget);
    if (!dataUrl) {
      alert("Could not compress " + file.name + " enough to send.");
      return;
    }
    attachments.push({ kind: "image", name: file.name, dataUrl });
    renderPending();
  } catch {
    alert("Could not read " + file.name + " as an image.");
  }
}

async function addDocFile(file) {
  if (docs().length >= MAX_DOCS) {
    alert("Max " + MAX_DOCS + " documents per message.");
    return;
  }
  try {
    const { text, truncated } = await parseDocFile(file, PER_DOC_CHARS);
    attachments.push({ kind: "doc", name: file.name, ext: docExt(file), text, truncated });
    renderPending();
  } catch (err) {
    alert(err?.message || "Could not read " + file.name + ".");
  }
}

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

async function sendMessage(text) {
  // Build message content. Documents become labeled text blocks in the
  // API message (never shown in the bubble); images become OpenAI-style
  // multimodal parts.
  const sentImages = images();
  const sentDocs = docs();
  attachments = [];
  renderPending();
  let apiText = text;
  for (const d of sentDocs) {
    apiText +=
      `\n\n--- Attached document: ${d.name}${d.truncated ? " (truncated)" : ""} ---\n` +
      d.text +
      "\n--- End of document ---";
  }
  let content = apiText;
  if (sentImages.length) {
    content = [];
    if (apiText) content.push({ type: "text", text: apiText });
    for (const a of sentImages) {
      content.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  history.push({ role: "user", content });
  addUserBubble(text, sentImages.map((a) => a.dataUrl), sentDocs.map((d) => d.name));
  const turn = addAssistantTurn(text);
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

// Single-line composer that grows with content (Shift+Enter) up to the
// CSS max-height, then scrolls internally.
const autogrow = () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
};
input.addEventListener("input", autogrow);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && attachments.length === 0) return;
  input.value = "";
  autogrow();
  send.disabled = true;
  await sendMessage(text);
  send.disabled = false;
  input.focus();
});

// Enter inserts a line break — nothing is sent until the arrow is tapped
// (form submit). The input just grows via the autogrow handler above.
