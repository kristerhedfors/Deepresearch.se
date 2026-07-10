// Free mode page wiring (/free, /free/project-<hash>). All rules and
// crypto live in the pure core (/js/free-core.js, built on /js/vault.js);
// this module only renders and talks to /api/free/* (src/free.js).
//
// Security posture recap (the page's whole point):
//   - the master secret lives in the password field and this module's
//     memory only — never in localStorage/IndexedDB, never sent anywhere;
//   - the project state is sealed client-side before it is PUT anywhere;
//   - provider API keys are sealed client-side; the derived unlock key
//     rides on chat/models requests so the server can use the keys
//     transiently in memory (never at rest, never logged);
//   - "Lock" just drops this tab's memory — a reload does the same.

import {
  deriveFreeProfile,
  deriveFreeTitle,
  emptyFreeState,
  freeSecretValid,
  generateFreeSecret,
  openFreeState,
  openKeyBundleLocal,
  sealFreeState,
  sealKeyBundle,
  validateFreeState,
} from "/js/free-core.js";
import { createSseParser } from "/js/sse.js";
import { renderMarkdownInto } from "/js/markdown.js";

const $ = (id) => document.getElementById(id);

let profile = null; // {refHash, blobId, blobKey, keysId, unlock}
let state = null; // the decrypted project state
let keys = null; // decrypted key bundle (local display/merge only)
let convId = null; // active conversation id
let sending = false;

// ---- gate ---------------------------------------------------------------------

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
      state = opened && validateFreeState(opened) ? opened : emptyFreeState();
    } else if (res.status === 404) {
      state = emptyFreeState(); // a fresh project
    } else {
      throw new Error("Storage unavailable (" + res.status + ").");
    }

    const kres = await fetch("/api/free/keys/" + encodeURIComponent(profile.keysId));
    keys = kres.ok ? await openKeyBundleLocal(await kres.json().catch(() => null), profile.unlock) : null;

    // The secret's job is done for this tab; keep the field from lingering.
    $("secret").value = "";
    history.replaceState(null, "", "/free/project-" + profile.refHash);
    $("projref").textContent = "project-" + profile.refHash;
    $("gate").hidden = true;
    $("work").hidden = false;
    renderKeysPanel();
    renderConvPicker();
    renderMessages();
    if (keys) await refreshModels();
    else $("keyspanel").open = true; // first thing a new project needs
    gateStatus("");
  } catch (err) {
    gateStatus(err?.message || "Could not open the project.");
  } finally {
    $("openbtn").disabled = false;
  }
}

// ---- persistence ----------------------------------------------------------------

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
    if (!res.ok) workStatus("Saving failed (" + res.status + ") — your chats stay in this tab only.");
  } catch {
    workStatus("Saving failed — your chats stay in this tab only.");
  }
}

// ---- provider keys ---------------------------------------------------------------

function renderKeysPanel() {
  const have = [];
  for (const p of ["berget", "anthropic", "openai"]) {
    const el = $("key-" + p);
    el.value = "";
    el.placeholder = keys?.[p] ? "•••••• (saved)" : "not set";
    if (keys?.[p]) have.push(p);
  }
  $("keysbadge").textContent = have.length ? "— " + have.join(", ") + " set" : "— none set yet";
}

async function saveKeys() {
  if (!profile) return;
  // Blank field = keep the stored key; typed field = replace; the word
  // "clear" (or a single "-") removes it.
  const next = { ...(keys || {}) };
  for (const p of ["berget", "anthropic", "openai"]) {
    const v = $("key-" + p).value.trim();
    if (!v) continue;
    if (v === "-" || v.toLowerCase() === "clear") delete next[p];
    else next[p] = v;
  }
  $("savekeys").disabled = true;
  $("keysstatus").textContent = "Saving…";
  try {
    const sealed = await sealKeyBundle(next, profile.unlock);
    const res = await fetch("/api/free/keys/" + encodeURIComponent(profile.keysId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sealed),
    });
    if (!res.ok) throw new Error("Storing the keys failed (" + res.status + ").");
    keys = next;
    renderKeysPanel();
    $("keysstatus").textContent = "Saved (encrypted).";
    await refreshModels();
  } catch (err) {
    $("keysstatus").textContent = err?.message || "Storing the keys failed.";
  } finally {
    $("savekeys").disabled = false;
  }
}

async function refreshModels() {
  if (!profile) return;
  const pick = $("modelpick");
  try {
    const res = await fetch("/api/free/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keysId: profile.keysId, unlock: profile.unlock }),
    });
    const data = await res.json().catch(() => null);
    const models = data?.models || [];
    pick.innerHTML = models.length
      ? models
          .map(
            (m) =>
              `<option value="${m.id.replace(/"/g, "&quot;")}"${m.up === false ? " disabled" : ""}>${(m.name || m.id).replace(/</g, "&lt;")}</option>`,
          )
          .join("")
      : '<option value="">— add an API key first —</option>';
    // Restore the project's remembered model when it's still available.
    if (state?.model && models.some((m) => m.id === state.model)) pick.value = state.model;
    else if (models.length) state.model = pick.value;
  } catch {
    pick.innerHTML = '<option value="">— models unavailable —</option>';
  }
}

// ---- conversations ----------------------------------------------------------------

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

// ---- send -----------------------------------------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending || !profile) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  const model = $("modelpick").value;
  if (!model) {
    workStatus("Pick a model first — add an API key under 'Model API keys'.");
    return;
  }
  state.model = model;

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

  let answer = "";
  let errMsg = null;
  try {
    const res = await fetch("/api/free/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keysId: profile.keysId,
        unlock: profile.unlock,
        model,
        messages: conv.messages,
      }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "The request failed (" + res.status + ").");
    }
    const parser = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
        if (typeof evt.delta === "string") {
          answer += evt.delta;
          live.textContent = answer;
          $("msgs").scrollTop = $("msgs").scrollHeight;
        } else if (evt.error) {
          errMsg = String(evt.error);
        }
      }
    }
  } catch (err) {
    errMsg = err?.message || "The request failed.";
  }

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

// ---- boot -----------------------------------------------------------------------

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
  if (state) {
    state.model = $("modelpick").value || null;
    saveState();
  }
});
$("composer").addEventListener("submit", send);
