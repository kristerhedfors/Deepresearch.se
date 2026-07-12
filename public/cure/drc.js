// DRC page wiring — "deep research secure", C for CLIENT-side: the public
// tier of the site, served at /cure (the root redirects here), with saved
// projects at /my/project-<hash> and published replays at /cure/<slug>.
// Its remote sibling is DRS, "deep research server" (R as in remote
// cloud-server) — the signed-in app at /rver with the hosted pipeline,
// live web search, accounts and cloud storage.
//
// DRC is modular by definition, and this page is just the wiring layer
// over four self-contained, Node-tested modules:
//   /js/drc-core.js      — secret → derived ids/keys, the sealed state
//   /js/drc-providers.js — the CORS-capable provider registry (OpenAI, Groq, Berget)
//   /js/drc-research.js  — the client-side deep-research pipeline
//   /js/drc-store.js     — BROWSER-LOCAL sealed-state storage (the seam)
//
// The server's entire involvement in DRC: static files and the public
// replay JSONs (/api/pub). Model calls go straight from this browser to
// the provider; the sealed project state never leaves this machine.
//
// The flow is deliberately chat-first: a visitor can type immediately with
// nothing set up — the first send explains, helpfully, that DRC runs on
// their own API key (and opens the key panel). A session without a saved
// project lives in this tab's memory only; the Project panel seals it
// (chats AND keys) under a freshly generated secret into this browser's
// local storage. The old promotional landing is a first-visit glass pane
// over this page (the full version stays at /welcome/).
//
// Security posture recap (the page's whole point):
//   - the master secret lives in the password field and this module's
//     memory only — never stored anywhere, never sent anywhere;
//   - the provider API keys live INSIDE the sealed state: encrypted at
//     rest in this browser, and on the wire they go only to the provider;
//   - nothing project-derived reaches the Deepresearch server, in any
//     form. "No logging" is not a policy here — there is nothing to log.
//   - "Lock" just drops this tab's memory — a reload does the same.
//   (The plain localStorage items, dr_intro_seen and dr_umbrella_seen, are
//   UI flags — they carry nothing derived from secrets, keys, or content.)

import {
  deriveDrcProfile,
  deriveDrcTitle,
  emptyDrcState,
  drcSecretValid,
  generateDrcSecret,
  migrateDrcState,
  openDrcState,
  sealDrcState,
  validateDrcState,
} from "/js/drc-core.js";
import {
  DRC_PROVIDERS,
  configuredDrcProviders,
  detectDrcProvider,
  drcEmbed,
  drcEmbedProvider,
  drcProvider,
  listDrcModels,
} from "/js/drc-providers.js";
import { DRC_RECENT_TURNS, ensureDrcRag, indexDrcChatTurns, retrieveDrcContext } from "/js/drc-rag.js";
import { runDrcResearch } from "/js/drc-research.js";
import { drcStoreAvailable, getSealedProject, putSealedProject } from "/js/drc-store.js";
import { renderMarkdownInto } from "/js/markdown.js";

const $ = (id) => document.getElementById(id);

let profile = null; // {refHash, blobId, blobKey} — null while the session is unsaved
let state = emptyDrcState(); // the working state (keys included), from the first keystroke
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
  sandbox: "Running in the Linux sandbox…",
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
  loadIntroPublications();
}

// The pane doubles as the publication shelf: the latest /cure/<slug>
// replays, fetched fail-soft (an empty list just hides the section).
async function loadIntroPublications() {
  try {
    const res = await fetch("/api/pub");
    const items = (await res.json())?.publications?.slice(0, 5) || [];
    if (!items.length) return;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    $("introlist").innerHTML =
      "<p class='muted'>Published research to read — or continue yourself:</p>" +
      items
        .map((p) => `<a class="pub-item" href="/cure/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>`)
        .join("");
    $("introlist").hidden = false;
  } catch {
    // the shelf is decoration — the pane works without it
  }
}

// The first-visit umbrella intro (public/cure/umbrella.js): the logo vortex
// untwisting into wireframe umbrellas. Plays ONCE, on a genuine first visit
// (never over a deep link), before the intro pane; `?anim=1` replays it for
// demos and on-device verification. Entirely fail-soft: any import or play
// failure resolves straight through to the intro pane.
function maybePlayUmbrella(deepLinked) {
  const force = /[?&]anim=1\b/.test(location.search);
  let seen = false;
  try {
    seen = localStorage.getItem("dr_umbrella_seen") === "1";
  } catch {
    // storage blocked — treat as unseen, the flag below just won't stick
  }
  let reduced = false;
  try {
    reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // no matchMedia — animate
  }
  if (reduced || (!force && (seen || deepLinked))) return Promise.resolve();
  try {
    localStorage.setItem("dr_umbrella_seen", "1");
  } catch {
    // fine — it may play again next visit
  }
  // The admin-set speed multiplier (site config, GET /api/anim — public and
  // edge/browser-cacheable). Time-boxed so a slow server can only ever cost
  // ~900 ms before the intro runs at the default speed instead.
  const speedFetch = Promise.race([
    fetch("/api/anim")
      .then((r) => r.json())
      .then((j) => Number(j?.speed) || 1),
    new Promise((res) => setTimeout(() => res(1), 900)),
  ]).catch(() => 1);
  return Promise.all([import("./umbrella.js"), speedFetch])
    .then(([m, speed]) => new Promise((res) => m.playUmbrellaIntro({ onDone: res, speed })))
    .catch(() => {
      // decoration only — never block the page over it
    });
}

function dismissIntro() {
  $("intro").hidden = true;
  try {
    localStorage.setItem("dr_intro_seen", "1");
  } catch {
    // fine — it'll show again next visit
  }
  $("input").focus();
}

// ---- the left drawer (the app's history sidebar, mirrored) -------------------------

function openDrawer() {
  $("drawer").hidden = false;
}

function closeDrawer() {
  $("drawer").hidden = true;
}

// ---- the account view (right drawer): the all-client-side explainer ---------------

function openAccount() {
  closeDrawer();
  closeSettings();
  $("accountview").hidden = false;
}

function closeAccount() {
  $("accountview").hidden = true;
}

// ---- the settings view (right drawer, the gear): keys + sandbox -------------------

function openSettings() {
  closeDrawer();
  closeAccount();
  $("bashlite").checked = state.bashLite === true; // reflect current state
  renderKeysPanel();
  $("settingsview").hidden = false;
}

function closeSettings() {
  $("settingsview").hidden = true;
}

// ---- the DRS explainer: dimmed buttons stand where DRS features live ---------------

const DRS_FEATURES = {
  ghost: {
    title: "Ghost mode — you are here",
    text: "The ghost in the signed-in app brings you HERE: DRC is ghost mode. This site's server never receives your messages, keys, or projects — there is nothing to keep out of any log. (In DRS the server honors per-conversation incognito for its own log; here the question doesn't arise.)",
  },
  attach: {
    title: "Attachments & documents",
    text: "Attaching PDFs, DOCX and images — with full-document indexing for retrieval — is a DRS feature: the hosted pipeline parses and indexes your documents for cited answers.",
  },
  camera: {
    title: "Photos",
    text: "Taking a photo (with EXIF location flowing into Maps/Street View research) is a DRS feature of the hosted pipeline.",
  },
  budget: {
    title: "Research time target",
    text: "The time slider steers how long the hosted pipeline researches — search rounds, coverage audits, validation depth. DRC's client-side phases run without a time budget; live web search itself is also DRS.",
  },
};

function showDrs(feature) {
  const f = DRS_FEATURES[feature];
  if (!f) return;
  $("drspop-title").textContent = feature === "ghost" ? f.title : f.title + " — a DRS feature";
  $("drspop-text").textContent = f.text;
  $("drspop").hidden = false;
}

// ---- deep links ---------------------------------------------------------------------

// /my/project-<hash> (or the legacy /free/project-…) prefills the
// reference so the password manager (which files the secret under that
// username) matches the entry, and opens the panel ready for the secret.
function handleProjectLink() {
  const m = location.pathname.match(/^\/(?:my|free)\/(project-[0-9a-z]+)/i);
  if (!m) return false;
  $("refname").value = m[1];
  openDrawer();
  $("projpanel").open = true;
  gateStatus("Enter (or autofill) this project's secret to open it.");
  return true;
}

// /cure/<slug> — a published replay (src/pub.js), opened right in the app:
// the frozen session becomes a normal conversation, so "continue" is just
// typing a follow-up (on the visitor's own key). /?continue=<slug> is the
// legacy handoff form.
async function handlePublicationLink() {
  const m = location.pathname.match(/^\/cure\/([a-z0-9-]+)$/i);
  const slug = m ? m[1] : new URLSearchParams(location.search).get("continue");
  if (!slug || !/^[a-z0-9-]{1,80}$/i.test(slug)) return false;
  try {
    const res = await fetch("/api/pub/" + encodeURIComponent(slug.toLowerCase()));
    if (!res.ok) {
      if (m) workStatus("No publication at /cure/" + slug + " — starting fresh.");
      return false;
    }
    const pub = await res.json();
    const messages = (pub?.messages || []).filter(
      (msg) => (msg?.role === "user" || msg?.role === "assistant") && typeof msg?.content === "string",
    );
    if (!messages.length) return false;
    const conv = {
      id: crypto.randomUUID(),
      title: (pub.title || deriveDrcTitle(messages)).slice(0, 80),
      messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.conversations.push(conv);
    convId = conv.id;
    if (pub.title) document.title = pub.title + " — Deepresearch";
    renderConvPicker();
    renderMessages();
    workStatus(
      "This is a published research replay" +
        (pub.description ? " — " + pub.description : "") +
        ". Ask a follow-up to continue it: replies run on YOUR API key (OpenAI, Groq or Berget), straight " +
        "from this browser.",
    );
    return true;
  } catch {
    return false;
  }
}

// ---- project open/create --------------------------------------------------------------

async function generateNew() {
  const secret = generateDrcSecret();
  $("secret").value = secret;
  // A NEW credential: switching the autocomplete hint makes Safari/iCloud
  // Keychain and 1Password treat the submit as "save this new password".
  $("secret").setAttribute("autocomplete", "new-password");
  const { refHash } = await deriveDrcProfile(secret);
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
  closeDrawer();
  history.replaceState(null, "", "/my/project-" + profile.refHash);
}

// Open OR create, one submit: a sealed state exists in THIS BROWSER under
// the secret's id → open it (merging anything already done in this tab);
// nothing there → seal the current session under the new secret. Either
// way the password manager sees a normal form submit. Note what "open"
// means for DRC: projects are browser-local, so a /my/… link opens only
// on a device that already holds the project — the secret alone carries
// nothing across devices (cross-device sync is DRS territory).
async function unlock(ev) {
  ev.preventDefault();
  const secret = $("secret").value;
  if (!drcSecretValid(secret)) {
    gateStatus("That doesn't look like a valid secret (DR1-… with 32 characters).");
    return;
  }
  if (!drcStoreAvailable()) {
    gateStatus("This browser blocks local storage, so projects can't be saved here — chats stay in this tab.");
    return;
  }
  $("openbtn").disabled = true;
  gateStatus("Deriving keys…");
  try {
    const derived = await deriveDrcProfile(secret);
    const stored = getSealedProject(derived.blobId);
    if (stored) {
      const opened = await openDrcState(stored, derived.blobKey).catch(() => null);
      if (!opened || !validateDrcState(opened)) {
        throw new Error("A stored project was found, but it could not be decrypted — it may be corrupted.");
      }
      const loaded = migrateDrcState(opened);
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
    } else {
      profile = derived;
      gateStatus("");
      workStatus("Project created — this session (chats and keys) is now sealed in this browser under your secret.");
    }

    projectOpened();
    await saveState(); // create, or persist the merge
    $("websearch").checked = state.research !== false;
    $("bashlite").checked = state.bashLite === true;
    renderKeysPanel();
    renderConvPicker();
    renderMessages();
    if (configuredDrcProviders(state.keys).length) await refreshModels();
  } catch (err) {
    gateStatus(err?.message || "Could not open the project.");
  } finally {
    $("openbtn").disabled = false;
  }
}

// ---- persistence (browser-local, via the drc-store seam) ---------------------------

async function saveState() {
  if (!state) return;
  state.updatedAt = Date.now();
  if (!profile) return; // unsaved session — memory only, by design
  try {
    const bytes = await sealDrcState(state, profile.blobKey);
    if (!putSealedProject(profile.blobId, bytes)) {
      workStatus("Saving locally failed (storage full or blocked) — changes stay in this tab only.");
    }
  } catch {
    workStatus("Saving locally failed — changes stay in this tab only.");
  }
}

// ---- provider keys ---------------------------------------------------------------------

// ONE input for the key + a provider dropdown that follows the pasted
// key's prefix automatically (sk-… OpenAI, gsk_… Groq, sk_ber_… Berget —
// detectDrcProvider); unknown prefixes leave the dropdown to the user.
// Saved keys are listed below with per-provider remove buttons.
function renderKeysPanel() {
  const have = DRC_PROVIDERS.filter((p) => state.keys?.[p.id]);
  $("keysbadge").textContent = have.length ? "— " + have.map((p) => p.label).join(", ") + " set" : "— none set yet";
  $("savedkeys").innerHTML = have.length
    ? have
        .map(
          (p) =>
            `<div class="saved-key-row"><span>${p.label} <span class="muted">••••••</span></span>` +
            `<button type="button" class="key-remove" data-provider="${p.id}">Remove</button></div>`,
        )
        .join("")
    : "";
  for (const btn of $("savedkeys").querySelectorAll(".key-remove")) {
    btn.addEventListener("click", async () => {
      delete state.keys[/** @type {HTMLElement} */ (btn).dataset.provider];
      await saveState();
      renderKeysPanel();
      await refreshModels();
    });
  }
}

// The dropdown follows the key as it's typed/pasted; the hint says when
// the provider was recognized (and the choice is therefore automatic).
function syncKeyDetection() {
  const detected = detectDrcProvider($("key-input").value);
  if (detected) {
    /** @type {HTMLSelectElement} */ ($("key-provider")).value = detected.id;
    $("keydetect").textContent = "— detected: " + detected.label;
  } else {
    $("keydetect").textContent = "";
  }
}

async function saveKeys() {
  const v = $("key-input").value.trim();
  if (!v) {
    $("keysstatus").textContent = "Paste an API key first.";
    return;
  }
  const provider = /** @type {HTMLSelectElement} */ ($("key-provider")).value;
  state.keys[provider] = v;
  $("savekeys").disabled = true;
  $("keysstatus").textContent = "Saving…";
  try {
    await saveState();
    $("key-input").value = "";
    syncKeyDetection();
    renderKeysPanel();
    $("keysstatus").textContent =
      drcProvider(provider).label +
      " key " +
      (profile ? "saved (encrypted in this browser)." : "kept in this tab — save a project (Project panel) to store it encrypted.");
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
  const pick = $("model");
  const providers = configuredDrcProviders(state.keys);
  if (!providers.length) {
    pick.innerHTML = '<option value="">— add an API key first —</option>';
    return;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const groups = await Promise.all(
    providers.map(async (p) => {
      const ids = await listDrcModels(p, state.keys[p.id]);
      return (
        `<optgroup label="${esc(p.label)}">` +
        ids.map((id) => `<option value="${esc(p.id + "::" + id)}">${esc(id)}</option>`).join("") +
        "</optgroup>"
      );
    }),
  );
  // The tier's provider limit, made visible: only CORS-capable providers
  // can serve DRC (direct browser calls); the hosted ones stay listed,
  // disabled, pointing at DRS. Berget graduated OFF this list 2026-07-11
  // when api.berget.ai started serving browser CORS — it's a real
  // provider above now.
  groups.push(
    '<optgroup label="DRS only — deepresearch.se/rver">' +
      '<option disabled>Anthropic Claude</option>' +
      "</optgroup>",
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
  const box = $("convlist");
  const convs = [...(state?.conversations || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!convs.length) {
    box.innerHTML = "";
    convId = null;
    return;
  }
  if (!convId || !convs.some((c) => c.id === convId)) convId = convs[0].id;
  box.innerHTML = convs
    .map(
      (c) =>
        `<button type="button" class="conv-item${c.id === convId ? " active" : ""}" data-id="${c.id}">${(c.title || "Chat").replace(/</g, "&lt;")}</button>`,
    )
    .join("");
  box.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", () => {
      convId = el.dataset.id;
      renderConvPicker();
      renderMessages();
      closeDrawer();
    });
  });
}

function renderMessages() {
  const box = $("chat");
  box.innerHTML = "";
  const messages = activeConv()?.messages || [];
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "Ask a research question to get started — it runs right here in your browser, on your own OpenAI, Groq or Berget API key.";
    box.appendChild(empty);
    return;
  }
  for (const m of messages) {
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
  renderConvPicker();
  renderMessages();
  closeDrawer();
}

// ---- client-side RAG (drc-rag.js): recall before the pipeline, index after ------------

// The embedding hookup, when a key that can serve embeddings is stored
// (OpenAI today — Groq has no embeddings endpoint). Returns null otherwise:
// every caller degrades to the plain recent-turns context, silently.
function embedHookup() {
  const p = drcEmbedProvider(state.keys);
  if (!p) return null;
  return {
    embedder: { provider: p.id, model: p.embed.model, dims: p.embed.dimensions },
    embed: async (texts) => (await drcEmbed(p, state.keys[p.id], texts)).vectors,
  };
}

// Top-k excerpts from the project's OTHER indexed chats (and this chat's
// turns older than the context window) — one small embed call on the send
// path; recall is a helper, so any failure means an empty block, never a
// broken send.
async function recallContext(conv, query) {
  const hookup = embedHookup();
  if (!hookup || !state.rag?.docs?.length) return "";
  try {
    phaseLine("Recalling project context…");
    const rag = ensureDrcRag(state, hookup.embedder);
    const { block } = await retrieveDrcContext({
      rag,
      convId: conv.id,
      messageCount: conv.messages.length,
      query,
      embed: hookup.embed,
    });
    return block;
  } catch {
    return "";
  }
}

// Index this conversation's not-yet-indexed turns into the sealed state —
// runs AFTER the answer is rendered (perceived latency untouched) and
// before the save, so vectors persist with the turns they index.
async function indexExchange(conv) {
  const hookup = embedHookup();
  if (!hookup) return;
  try {
    const rag = ensureDrcRag(state, hookup.embedder);
    await indexDrcChatTurns({ rag, conv, embed: hookup.embed });
  } catch {
    // srcMsgs only advances on success — the same turns retry next exchange
  }
}

// ---- send: the client-side research pipeline -----------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending) return;
  const text = $("input").value.trim();
  if (!text) return;

  // The first-visit path: no key yet → a helpful pointer, never an error
  // wall. The message stays in the composer so nothing typed is lost.
  if (!configuredDrcProviders(state.keys).length) {
    openSettings();
    $("keyspanel").open = true;
    $("key-input").focus();
    workStatus(
      "One thing first: DRC runs on YOUR API key, sent straight from this browser to the " +
        "provider — this site's server never sees your key or your messages. Paste an OpenAI, Groq " +
        "or Berget key above (Groq has a free tier at console.groq.com; Berget is EU-hosted), press " +
        "Save keys, then send again.",
    );
    return;
  }
  const picked = $("model").value;
  if (!picked || !picked.includes("::")) {
    await refreshModels();
    if (!$("model").value.includes("::")) {
      workStatus("Pick a model in the dropdown, then send again.");
      return;
    }
  }
  const [providerId, ...rest] = $("model").value.split("::");
  const model = rest.join("::");
  state.providerId = providerId;
  state.model = model;
  state.research = $("websearch").checked;

  let conv = activeConv();
  if (!conv) {
    conv = { id: crypto.randomUUID(), title: "", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.conversations.push(conv);
    convId = conv.id;
  }
  conv.messages.push({ role: "user", content: text });
  conv.title = conv.title || deriveDrcTitle(conv.messages);
  conv.updatedAt = Date.now();
  $("input").value = "";
  renderConvPicker();
  renderMessages();

  sending = true;
  $("send").disabled = true;
  workStatus("");
  $("chat").querySelector(".empty")?.remove();
  const live = document.createElement("div");
  live.className = "msg assistant streaming";
  $("chat").appendChild(live);

  const retrieved = await recallContext(conv, text);

  let shown = "";
  let errMsg = null;
  let result = null;
  try {
    result = await runDrcResearch({
      providerId,
      apiKey: state.keys[providerId],
      model,
      messages: conv.messages.slice(-DRC_RECENT_TURNS),
      research: state.research,
      retrieved,
      bash: state.bashLite === true,
      onStatus: (s) => {
        if (s.type === "phase") {
          phaseLine(PHASE_LABELS[s.phase] || s.phase);
        } else if (s.type === "discard_text") {
          shown = ""; // the validated revision replaces the draft
          live.textContent = "";
          phaseLine("Applying the reviewed revision…");
        }
      },
      onDelta: (chunk) => {
        shown += chunk;
        live.textContent = shown;
        $("chat").scrollTop = $("chat").scrollHeight;
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
    await indexExchange(conv); // vectors join the state before it seals
    await saveState(); // sealed, browser-local
    if (!profile && !unsavedHintShown) {
      unsavedHintShown = true;
      workStatus(
        "This conversation lives only in this tab. Open the Project panel to seal it (chats and " +
          "keys) under a secret, stored encrypted in this browser.",
      );
    }
  } else {
    live.remove();
  }
  if (errMsg) workStatus(errMsg);
  sending = false;
  $("send").disabled = false;
}

// ---- boot --------------------------------------------------------------------------

// iOS bar tint: arriving here by same-window navigation (the app's ghost
// button), WebKit can keep the PREVIOUS page's theme-color — the DRS blue
// over a khaki page (reported live 2026-07-10). Re-asserting the meta with
// a changed-then-target value after load forces a re-evaluation of the
// bar tint; harmless everywhere else.
const themeMeta = document.querySelector('meta[name="theme-color"]');
if (themeMeta) {
  requestAnimationFrame(() => {
    themeMeta.setAttribute("content", "#c3b092");
    requestAnimationFrame(() => themeMeta.setAttribute("content", "#c3b091"));
  });
}

// Build stamp (on-device-trace convention): the brand line shows the DRC
// build marker + the display mode, so any screenshot answers "which build,
// PWA or Safari" — bump the d-number on every DRC deploy.
try {
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  $("stamp").textContent = "d13 · " + (standalone ? "pwa" : "browser");
} catch {
  // the stamp is an instrument, never a breaker
}

const projectLinked = handleProjectLink();
renderKeysPanel();
renderConvPicker();
renderMessages();
// A replay deep link counts like a project link — no intro pane over it.
// On a genuine first visit the umbrella intro plays first (over the bare
// page), then the intro pane appears when it finishes or is tapped away.
handlePublicationLink().then((opened) => {
  const deepLinked = projectLinked || opened;
  maybePlayUmbrella(deepLinked).then(() => maybeShowIntro(deepLinked));
});

$("introstart").addEventListener("click", dismissIntro);
$("brand").addEventListener("click", () => {
  $("intro").hidden = false;
});
$("intro").addEventListener("click", (e) => {
  if (e.target === $("intro")) dismissIntro();
});
// The drawer (chats + project only).
$("historybtn").addEventListener("click", openDrawer);
$("drawerclose").addEventListener("click", closeDrawer);
$("drawer").addEventListener("click", (e) => {
  if (e.target === $("drawer")) closeDrawer();
});
// The account view (the client-side explainer).
$("accountbtn").addEventListener("click", openAccount);
$("accountclose").addEventListener("click", closeAccount);
$("accountview").addEventListener("click", (e) => {
  if (e.target === $("accountview")) closeAccount();
});
// The settings view (the gear): API keys + sandbox — all configuration.
$("gearbtn").addEventListener("click", openSettings);
$("settingsclose").addEventListener("click", closeSettings);
$("settingsview").addEventListener("click", (e) => {
  if (e.target === $("settingsview")) closeSettings();
});
$("opensettings").addEventListener("click", openSettings);
$("key-input").addEventListener("input", syncKeyDetection);
$("clearbtn").addEventListener("click", newChat);
$("newchatbtn").addEventListener("click", newChat);
// Experimental in-browser Linux sandbox knob (client-local, persisted in the
// sealed project state). No reload needed here — the DRC page is always served
// cross-origin isolated, so the sandbox can boot the moment a message needs it.
$("bashlite").checked = state.bashLite === true;
$("bashlite").addEventListener("change", () => {
  state.bashLite = $("bashlite").checked;
  const st = $("sandboxstatus");
  st.textContent = state.bashLite
    ? "Sandbox enabled — a message that asks to run a shell will boot Linux here."
    : "Sandbox disabled.";
  saveState().catch(() => {});
});
// Dimmed DRS-feature buttons: the tap explains and points to /rver.
for (const el of document.querySelectorAll("[data-feature]")) {
  el.addEventListener("click", () => showDrs(el.dataset.feature));
}
document.addEventListener("click", (e) => {
  if (!$("drspop").hidden && !$("drspop").contains(e.target) && !e.target.closest("[data-feature]")) {
    $("drspop").hidden = true;
  }
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
$("model").addEventListener("change", () => {
  const [pid, ...rest] = $("model").value.split("::");
  if (pid && rest.length) {
    state.providerId = pid;
    state.model = rest.join("::");
    saveState();
  }
});
$("websearch").addEventListener("change", () => {
  state.research = $("websearch").checked;
  saveState();
});
$("form").addEventListener("submit", send);
