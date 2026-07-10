// Free mode page wiring (/free, /free/project-<hash>). All rules live in
// the pure modules: /js/free-core.js (secret → derived ids/keys, the
// sealed state), /js/free-providers.js (the CORS-capable provider
// registry — OpenAI + Groq), /js/free-research.js (the client-side
// deep-research pipeline). This module only renders, and the only server
// endpoint it ever touches is the dumb ciphertext store
// (/api/free/blob/:id) — every model call goes straight from this browser
// to the provider.
//
// Security posture recap (the page's whole point):
//   - the master secret lives in the password field and this module's
//     memory only — never in localStorage/IndexedDB, never sent anywhere;
//   - the provider API keys live INSIDE the sealed state: encrypted at
//     rest, and on the wire they go only to the provider itself;
//   - the Deepresearch server sees exactly one thing: an opaque encrypted
//     blob. It cannot log message content — it never receives any.
//   - "Lock" just drops this tab's memory — a reload does the same.

import {
  deriveFreeProfile,
  deriveFreeTitle,
  emptyFreeState,
  freeSecretValid,
  generateFreeSecret,
  migrateFreeState,
  openFreeState,
  sealFreeState,
  validateFreeState,
} from "/js/free-core.js";
import { configuredFreeProviders, freeProvider, listFreeModels } from "/js/free-providers.js";
import { runFreeResearch } from "/js/free-research.js";
import { renderMarkdownInto } from "/js/markdown.js";

const $ = (id) => document.getElementById(id);

let profile = null; // {refHash, blobId, blobKey}
let state = null; // the decrypted project state (keys included)
let convId = null; // active conversation id
let sending = false;

const PHASE_LABELS = {
  triage: "Analyzing the question…",
  clarify: "Asking for a detail…",
  harvest: "Harvesting knowledge…",
  gap: "Auditing coverage…",
  synth: "Writing the answer…",
  validate: "Reviewing the draft…",
  answer: "Answering…",
};

// ---- status lines ---------------------------------------------------------------

function gateStatus(msg) {
  const el = $("gatestatus");
  el.hidden = !msg;
  el.textContent = msg || "";
}

function workStatus(msg) {
  const el = $("workstatus");
  el.hidden = !msg;
  el.textContent = msg || "";
}

function phaseLine(msg) {
  const el = $("phaseline");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// ---- gate -------------------------------------------------------------------------

// Deep link: /free/project-<hash> prefills the reference so the password
// manager (which files the secret under that username) matches the entry.
function prefillFromUrl() {
  const m = location.pathname.match(/^\/free\/(project-[0-9a-z]+)/i);
  if (m) $("refname").value = m[1];
}

async function createNew() {
  const secret = generateFreeSecret();
  $("secret").value = secret;
  // A NEW credential: switching the autocomplete hint makes Safari/iCloud
  // Keychain and 1Password treat the submit as "save this new password".
  $("secret").setAttribute("autocomplete", "new-password");
  const { refHash } = await deriveFreeProfile(secret);
  $("refname").value = "project-" + refHash;
  $("newsecrettext").textContent = secret;
  $("newsecret").hidden = false;
  gateStatus("");
}

async function unlock(ev) {
  ev.preventDefault();
  const secret = $("secret").value;
  if (!freeSecretValid(secret)) {
    gateStatus("That doesn't look like a valid secret (DR1-… with 32 characters).");
    return;
  }
  $("openbtn").disabled = true;
  gateStatus("Deriving keys…");
  try {
    profile = await deriveFreeProfile(secret);

    gateStatus("Fetching your encrypted project…");
    const res = await fetch("/api/free/blob/" + encodeURIComponent(profile.blobId));
    if (res.ok) {
      const opened = await openFreeState(new Uint8Array(await res.arrayBuffer()), profile.blobKey).catch(() => null);
      state = opened && validateFreeState(opened) ? migrateFreeState(opened) : emptyFreeState();
    } else if (res.status === 404) {
      state = emptyFreeState(); // a fresh project
    } else {
      throw new Error("Storage unavailable (" + res.status + ").");
    }

    // The secret's job is done for this tab; keep the field from lingering.
    $("secret").value = "";
    history.replaceState(null, "", "/free/project-" + profile.refHash);
    $("projref").textContent = "project-" + profile.refHash;
    $("gate").hidden = true;
    $("work").hidden = false;
    $("researchmode").checked = state.research !== false;
    renderKeysPanel();
    renderConvPicker();
    renderMessages();
    if (configuredFreeProviders(state.keys).length) await refreshModels();
    else $("keyspanel").open = true; // first thing a new project needs
    gateStatus("");
  } catch (err) {
    gateStatus(err?.message || "Could not open the project.");
  } finally {
    $("openbtn").disabled = false;
  }
}

// ---- persistence ---------------------------------------------------------------

async function saveState() {
  if (!profile || !state) return;
  state.updatedAt = Date.now();
  try {
    const bytes = await sealFreeState(state, profile.blobKey);
    const res = await fetch("/api/free/blob/" + encodeURIComponent(profile.blobId), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) workStatus("Saving failed (" + res.status + ") — changes stay in this tab only.");
  } catch {
    workStatus("Saving failed — changes stay in this tab only.");
  }
}

// ---- provider keys ----------------------------------------------------------------

function renderKeysPanel() {
  const have = [];
  for (const p of ["openai", "groq"]) {
    const el = $("key-" + p);
    el.value = "";
    el.placeholder = state.keys?.[p] ? "•••••• (saved)" : "not set";
    if (state.keys?.[p]) have.push(freeProvider(p).label);
  }
  $("keysbadge").textContent = have.length ? "— " + have.join(", ") + " set" : "— none set yet";
}

async function saveKeys() {
  // Blank field = keep the stored key; typed = replace; "clear" removes it.
  for (const p of ["openai", "groq"]) {
    const v = $("key-" + p).value.trim();
    if (!v) continue;
    if (v === "-" || v.toLowerCase() === "clear") delete state.keys[p];
    else state.keys[p] = v;
  }
  $("savekeys").disabled = true;
  $("keysstatus").textContent = "Saving…";
  try {
    await saveState(); // the keys ride inside the sealed blob — nothing else is stored
    renderKeysPanel();
    $("keysstatus").textContent = "Saved (encrypted in your project blob).";
    await refreshModels();
  } catch (err) {
    $("keysstatus").textContent = err?.message || "Saving failed.";
  } finally {
    $("savekeys").disabled = false;
  }
}

// One grouped dropdown across the configured providers; option values are
// "provider::model" so the send knows where to route.
async function refreshModels() {
  const pick = $("modelpick");
  const providers = configuredFreeProviders(state.keys);
  if (!providers.length) {
    pick.innerHTML = '<option value="">— add an API key first —</option>';
    return;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const groups = await Promise.all(
    providers.map(async (p) => {
      const ids = await listFreeModels(p, state.keys[p.id]);
      return (
        `<optgroup label="${esc(p.label)}">` +
        ids.map((id) => `<option value="${esc(p.id + "::" + id)}">${esc(id)}</option>`).join("") +
        "</optgroup>"
      );
    }),
  );
  pick.innerHTML = groups.join("");
  const remembered = state.providerId && state.model ? state.providerId + "::" + state.model : null;
  if (remembered && [...pick.options].some((o) => o.value === remembered)) {
    pick.value = remembered;
  } else if (pick.options.length) {
    const [pid, ...rest] = pick.value.split("::");
    state.providerId = pid;
    state.model = rest.join("::");
  }
}

// ---- conversations -----------------------------------------------------------------

function activeConv() {
  return state?.conversations.find((c) => c.id === convId) || null;
}

function renderConvPicker() {
  const pick = $("convpick");
  const convs = [...(state?.conversations || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!convs.length) {
    pick.innerHTML = "<option value=''>New chat</option>";
    convId = null;
    return;
  }
  if (!convId || !convs.some((c) => c.id === convId)) convId = convs[0].id;
  pick.innerHTML = convs
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === convId ? " selected" : ""}>${(c.title || "Chat").replace(/</g, "&lt;")}</option>`,
    )
    .join("");
}

function renderMessages() {
  const box = $("msgs");
  box.innerHTML = "";
  for (const m of activeConv()?.messages || []) {
    box.appendChild(messageEl(m.role, m.content));
  }
  box.scrollTop = box.scrollHeight;
}

function messageEl(role, content) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "assistant") renderMarkdownInto(el, content);
  else el.textContent = content;
  return el;
}

function newChat() {
  convId = null;
  $("convpick").value = "";
  renderMessages();
}

// ---- send: the client-side research pipeline ----------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending || !profile) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  const picked = $("modelpick").value;
  if (!picked || !picked.includes("::")) {
    workStatus("Pick a model first — add an API key under 'Provider API keys'.");
    return;
  }
  const [providerId, ...rest] = picked.split("::");
  const model = rest.join("::");
  state.providerId = providerId;
  state.model = model;
  state.research = $("researchmode").checked;

  let conv = activeConv();
  if (!conv) {
    conv = { id: crypto.randomUUID(), title: "", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.conversations.push(conv);
    convId = conv.id;
  }
  conv.messages.push({ role: "user", content: text });
  conv.title = conv.title || deriveFreeTitle(conv.messages);
  conv.updatedAt = Date.now();
  $("prompt").value = "";
  renderConvPicker();
  renderMessages();

  sending = true;
  $("sendbtn").disabled = true;
  workStatus("");
  const live = document.createElement("div");
  live.className = "msg assistant streaming";
  $("msgs").appendChild(live);

  let shown = "";
  let errMsg = null;
  let result = null;
  try {
    result = await runFreeResearch({
      providerId,
      apiKey: state.keys[providerId],
      model,
      messages: conv.messages.slice(-40),
      research: state.research,
      onStatus: (s) => {
        if (s.type === "phase") {
          phaseLine(PHASE_LABELS[s.phase] || s.phase);
        } else if (s.type === "discard_text") {
          shown = ""; // the validated revision replaces the draft, server-SSE style
          live.textContent = "";
          phaseLine("Applying the reviewed revision…");
        }
      },
      onDelta: (chunk) => {
        shown += chunk;
        live.textContent = shown;
        $("msgs").scrollTop = $("msgs").scrollHeight;
      },
    });
  } catch (err) {
    errMsg = err?.message || "The request failed.";
  }
  phaseLine("");

  const answer = result?.answer || shown;
  live.classList.remove("streaming");
  if (answer) {
    renderMarkdownInto(live, answer);
    conv.messages.push({ role: "assistant", content: answer });
    conv.updatedAt = Date.now();
    await saveState(); // sealed client-side; the server stores ciphertext
  } else {
    live.remove();
  }
  if (errMsg) workStatus(errMsg);
  sending = false;
  $("sendbtn").disabled = false;
}

// ---- boot ------------------------------------------------------------------------

prefillFromUrl();
$("unlockform").addEventListener("submit", unlock);
$("newbtn").addEventListener("click", () => createNew().catch((e) => gateStatus(e?.message || "Failed.")));
$("copysecret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("newsecrettext").textContent);
    $("copysecret").textContent = "Copied ✓";
  } catch {
    $("copysecret").textContent = "Select and copy manually";
  }
});
$("lockbtn").addEventListener("click", () => location.assign("/free/project-" + (profile?.refHash || "")));
$("savekeys").addEventListener("click", saveKeys);
$("newchat").addEventListener("click", newChat);
$("convpick").addEventListener("change", () => {
  convId = $("convpick").value || null;
  renderMessages();
});
$("modelpick").addEventListener("change", () => {
  const [pid, ...rest] = $("modelpick").value.split("::");
  if (state && pid && rest.length) {
    state.providerId = pid;
    state.model = rest.join("::");
    saveState();
  }
});
$("researchmode").addEventListener("change", () => {
  if (state) {
    state.research = $("researchmode").checked;
    saveState();
  }
});
$("composer").addEventListener("submit", send);
