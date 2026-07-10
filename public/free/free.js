// Free mode page wiring — the site's DEFAULT face: unauthenticated / serves
// this page, chat-first, with /my/project-<hash> as the saved-project deep
// link. All rules live in the pure modules: /js/free-core.js (secret →
// derived ids/keys, the sealed state), /js/free-providers.js (the
// CORS-capable provider registry — OpenAI + Groq), /js/free-research.js
// (the client-side deep-research pipeline). This module only renders, and
// the only server endpoint it ever touches is the dumb ciphertext store
// (/api/free/blob/:id) — every model call goes straight from this browser
// to the provider.
//
// The flow is deliberately chat-first: a visitor can type immediately with
// nothing set up — the first send explains, helpfully, that free mode runs
// on their own API key (and opens the key panel). A session without a
// saved project lives in this tab's memory only; the Project panel seals
// it (chats AND keys) under a freshly generated secret and gives it a
// /my/project-<hash> home. The old promotional landing is a first-visit
// glass pane over this page (the full version stays at /welcome/).
//
// Security posture recap (the page's whole point):
//   - the master secret lives in the password field and this module's
//     memory only — never in localStorage/IndexedDB, never sent anywhere;
//   - the provider API keys live INSIDE the sealed state: encrypted at
//     rest, and on the wire they go only to the provider itself;
//   - the Deepresearch server sees exactly one thing: an opaque encrypted
//     blob. It cannot log message content — it never receives any.
//   - "Lock" just drops this tab's memory — a reload does the same.
//   (The one localStorage item, dr_intro_seen, is a UI flag — it carries
//   nothing derived from secrets, keys, or content.)

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

let profile = null; // {refHash, blobId, blobKey} — null while the session is unsaved
let state = emptyFreeState(); // the working state (keys included), from the first keystroke
let convId = null; // active conversation id
let sending = false;
let unsavedHintShown = false;

const PHASE_LABELS = {
  triage: "Analyzing the question…",
  clarify: "Asking for a detail…",
  harvest: "Harvesting knowledge…",
  gap: "Auditing coverage…",
  synth: "Writing the answer…",
  validate: "Reviewing the draft…",
  answer: "Answering…",
};

// ---- status lines ----------------------------------------------------------------

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

// ---- the first-visit glass pane ----------------------------------------------------

function maybeShowIntro(deepLinked) {
  let seen = false;
  try {
    seen = localStorage.getItem("dr_intro_seen") === "1";
  } catch {
    // storage blocked — show it this once
  }
  if (!seen && !deepLinked) $("intro").hidden = false;
}

function dismissIntro() {
  $("intro").hidden = true;
  try {
    localStorage.setItem("dr_intro_seen", "1");
  } catch {
    // fine — it'll show again next visit
  }
  $("prompt").focus();
}

// ---- project panel ------------------------------------------------------------------

// Deep link: /my/project-<hash> (or the legacy /free/project-…) prefills
// the reference so the password manager (which files the secret under that
// username) matches the entry, and opens the panel ready for the secret.
function handleDeepLink() {
  const m = location.pathname.match(/^\/(?:my|free)\/(project-[0-9a-z]+)/i);
  if (!m) return false;
  $("refname").value = m[1];
  $("projpanel").open = true;
  gateStatus("Enter (or autofill) this project's secret to open it.");
  return true;
}

async function generateNew() {
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

function projectOpened() {
  $("projref").textContent = "project-" + profile.refHash;
  $("projbadge").textContent = "— project-" + profile.refHash;
  $("lockbtn").hidden = false;
  $("secret").value = "";
  $("secret").setAttribute("autocomplete", "current-password");
  $("newsecret").hidden = true;
  $("projpanel").open = false;
  history.replaceState(null, "", "/my/project-" + profile.refHash);
}

// Open OR create, one submit: the blob exists → open it (merging anything
// already done in this tab); 404 → seal the current session under the new
// secret. Either way the password manager sees a normal form submit.
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
    const derived = await deriveFreeProfile(secret);

    gateStatus("Checking for a stored project…");
    const res = await fetch("/api/free/blob/" + encodeURIComponent(derived.blobId));
    if (res.ok) {
      const opened = await openFreeState(new Uint8Array(await res.arrayBuffer()), derived.blobKey).catch(() => null);
      if (!opened || !validateFreeState(opened)) {
        throw new Error("That secret found a stored project, but it could not be decrypted — it may be corrupted.");
      }
      const loaded = migrateFreeState(opened);
      // Carry this tab's unsaved work INTO the opened project: conversations
      // with content, and any keys typed here that the project lacks.
      const known = new Set(loaded.conversations.map((c) => c.id));
      for (const c of state.conversations) {
        if (c.messages.length && !known.has(c.id)) loaded.conversations.push(c);
      }
      loaded.keys = { ...state.keys, ...loaded.keys };
      profile = derived;
      state = loaded;
      gateStatus("");
    } else if (res.status === 404) {
      profile = derived;
      gateStatus("");
      workStatus("Project created — this session (chats and keys) is now sealed under your secret.");
    } else {
      throw new Error("Storage unavailable (" + res.status + ").");
    }

    projectOpened();
    await saveState(); // create, or persist the merge
    $("researchmode").checked = state.research !== false;
    renderKeysPanel();
    renderConvPicker();
    renderMessages();
    if (configuredFreeProviders(state.keys).length) await refreshModels();
  } catch (err) {
    gateStatus(err?.message || "Could not open the project.");
  } finally {
    $("openbtn").disabled = false;
  }
}

// ---- persistence ---------------------------------------------------------------------

async function saveState() {
  if (!state) return;
  state.updatedAt = Date.now();
  if (!profile) return; // unsaved session — memory only, by design
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

// ---- provider keys ---------------------------------------------------------------------

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
    await saveState();
    renderKeysPanel();
    $("keysstatus").textContent = profile
      ? "Saved (encrypted in your project blob)."
      : "Kept in this tab — save a project (Project panel) to store them encrypted.";
    await refreshModels();
    workStatus("");
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

// ---- conversations ------------------------------------------------------------------

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

// ---- send: the client-side research pipeline -----------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending) return;
  const text = $("prompt").value.trim();
  if (!text) return;

  // The first-visit path: no key yet → a helpful pointer, never an error
  // wall. The message stays in the composer so nothing typed is lost.
  if (!configuredFreeProviders(state.keys).length) {
    $("keyspanel").open = true;
    $("key-groq").focus();
    workStatus(
      "One thing first: this chat runs on YOUR API key, sent straight from this browser to the " +
        "provider — this site's server never sees your key or your messages. Paste an OpenAI or " +
        "Groq key above (Groq has a free tier at console.groq.com), press Save keys, then send again.",
    );
    return;
  }
  const picked = $("modelpick").value;
  if (!picked || !picked.includes("::")) {
    await refreshModels();
    if (!$("modelpick").value.includes("::")) {
      workStatus("Pick a model in the dropdown, then send again.");
      return;
    }
  }
  const [providerId, ...rest] = $("modelpick").value.split("::");
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
    if (!profile && !unsavedHintShown) {
      unsavedHintShown = true;
      workStatus(
        "This conversation lives only in this tab. Open the Project panel to seal it (chats and " +
          "keys) under a secret and get a /my/project-… link that works on any device.",
      );
    }
  } else {
    live.remove();
  }
  if (errMsg) workStatus(errMsg);
  sending = false;
  $("sendbtn").disabled = false;
}

// ---- boot --------------------------------------------------------------------------

const deepLinked = handleDeepLink();
maybeShowIntro(deepLinked);
renderKeysPanel();
renderConvPicker();
renderMessages();

$("introstart").addEventListener("click", dismissIntro);
$("aboutbtn").addEventListener("click", () => {
  $("intro").hidden = false;
});
$("intro").addEventListener("click", (e) => {
  if (e.target === $("intro")) dismissIntro();
});
$("unlockform").addEventListener("submit", unlock);
$("newbtn").addEventListener("click", () => generateNew().catch((e) => gateStatus(e?.message || "Failed.")));
$("copysecret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("newsecrettext").textContent);
    $("copysecret").textContent = "Copied ✓";
  } catch {
    $("copysecret").textContent = "Select and copy manually";
  }
});
$("lockbtn").addEventListener("click", () => location.assign("/my/project-" + (profile?.refHash || "")));
$("savekeys").addEventListener("click", saveKeys);
$("newchat").addEventListener("click", newChat);
$("convpick").addEventListener("change", () => {
  convId = $("convpick").value || null;
  renderMessages();
});
$("modelpick").addEventListener("change", () => {
  const [pid, ...rest] = $("modelpick").value.split("::");
  if (pid && rest.length) {
    state.providerId = pid;
    state.model = rest.join("::");
    saveState();
  }
});
$("researchmode").addEventListener("change", () => {
  state.research = $("researchmode").checked;
  saveState();
});
$("composer").addEventListener("submit", send);
