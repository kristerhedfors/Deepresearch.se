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
import { flagForProvider, labelWithFlag } from "/js/provider-region.js";
import { DRC_RECENT_TURNS, ensureDrcRag, indexDrcChatTurns, retrieveDrcContext } from "/js/drc-rag.js";
import { runDrcResearch } from "/js/drc-research.js";
import {
  OWASP_CORPUS_PATH,
  SNAPSHOT_PATH,
  buildIntrospectionBlock,
  buildOwaspReferenceBlock,
  introspectionActive,
  lexicalRetrieveOwasp,
  securityAssessmentIntent,
  validateSnapshot,
} from "/js/introspect-core.js";
import { engageIntrospection, initIntrospectUi, noteIntrospectionText } from "/js/introspect-ui.js";
import { drcStoreAvailable, getSealedProject, putSealedProject } from "/js/drc-store.js";
import { matchCanned } from "/js/canned-faq.js";
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
  source: "Investigating the site's own source…",
};

// ---- status lines ----------------------------------------------------------------

function gateStatus(msg) {
  const el = $("gatestatus");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// Render prose we build for innerHTML with the Se/cure & Se/rver wordmark
// slash tightened (the .sl rule) so it reads closer to "secure"/"server".
// Escapes &<> FIRST, so any plain string stays safe as markup.
function wmHtml(s) {
  return String(s)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
    .replace(/(se)\/(cure|rver)/gi, '$1<span class="sl">/</span>$2');
}

function workStatus(msg) {
  const el = $("workstatus");
  el.hidden = !msg;
  el.innerHTML = msg ? wmHtml(msg) : "";
}

function phaseLine(msg) {
  const el = $("phaseline");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// ---- the first-visit glass pane ----------------------------------------------------

// After the first-visit umbrella intro, new users go STRAIGHT to the chat
// input (2026-07-12 onboarding directive) — the promotional glass pane no
// longer auto-pops. It stays reachable any time by tapping the wordmark
// (the #brand handler), and the publication shelf is still prefetched here
// so the pane is populated whenever it IS opened. Deep links (a project or a
// published replay) keep their own status messaging and are never touched.
function afterUmbrella(deepLinked) {
  loadIntroPublications();
  if (!deepLinked) {
    $("intro").hidden = true;
    // Mark the pane "seen" so nothing re-pops it, and land in the composer.
    try {
      localStorage.setItem("dr_intro_seen", "1");
    } catch {
      // storage blocked — nothing auto-shows the pane anyway
    }
    $("input").focus();
  }
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
// (never over a deep link, and never when the OS asks to reduce motion),
// before the intro pane. `?anim=1` is the explicit REPLAY/verification path:
// it forces the intro through EVERY gate — the seen flag, a deep link, AND
// prefers-reduced-motion — so "just show me the animation" always works (the
// automatic first-visit play still honors reduce-motion; only this explicit
// opt-in overrides it). Entirely fail-soft: any import or play failure
// resolves straight through to the intro pane.
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
  // `force` (the explicit ?anim=1 replay) wins over all three gates; without
  // it, reduce-motion / already-seen / a deep link each suppress the intro.
  if (!force && (reduced || seen || deepLinked)) return Promise.resolve();
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
  $("devmode").checked = state.developerMode === true;
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
    text: "The ghost in the signed-in app brings you HERE: Se/cure is ghost mode. This site's server never receives your messages, keys, or projects — there is nothing to keep out of any log. (In Se/rver the server honors per-conversation incognito for its own log; here the question doesn't arise.)",
  },
  attach: {
    title: "Attachments & documents",
    text: "Attaching PDFs, DOCX and images — with full-document indexing for retrieval — is a Se/rver feature: the hosted pipeline parses and indexes your documents for cited answers.",
  },
  camera: {
    title: "Photos",
    text: "Taking a photo (with EXIF location flowing into Maps/Street View research) is a Se/rver feature of the hosted pipeline.",
  },
  budget: {
    title: "Research time target",
    text: "The time slider steers how long the hosted pipeline researches — search rounds, coverage audits, validation depth. Se/cure's client-side phases run without a time budget; live web search itself is also a Se/rver feature.",
  },
};

function showDrs(feature) {
  const f = DRS_FEATURES[feature];
  if (!f) return;
  $("drspop-title").innerHTML = wmHtml(feature === "ghost" ? f.title : f.title + " — a Se/rver feature");
  $("drspop-text").innerHTML = wmHtml(f.text);
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
    $("devmode").checked = state.developerMode === true;
    applyIntrospectionTheme(state.developerMode === true);
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
        `<optgroup label="${esc(labelWithFlag(flagForProvider(p.id), p.label))}">` +
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
    '<optgroup label="Se/rver only — DeepResearch.Se/rver">' +
      '<option disabled>🇺🇸 Anthropic Claude</option>' +
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

// The prepackaged NON-LLM helper (canned-faq.js): before any provider key is
// configured there is no model to answer, so instead of a dead composer a
// visitor gets a short, honest, prewritten reply to the common questions. It
// is rendered EPHEMERALLY (never pushed into a conversation or the sealed
// state — these are onboarding help, not research) and carries a visible
// "canned, not the AI" badge so it can't be mistaken for the model. The user's
// message shows as a normal bubble above it.
function renderCannedExchange(userText, reply) {
  const box = $("chat");
  box.querySelector(".empty")?.remove();
  box.appendChild(messageEl("user", userText));
  const el = document.createElement("div");
  el.className = "msg assistant canned";
  const badge = document.createElement("div");
  badge.className = "canned-label";
  badge.textContent = "🤖 " + reply.label;
  el.appendChild(badge);
  const body = document.createElement("div");
  renderMarkdownInto(body, reply.answer);
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
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

// Introspection mode (the developer-mode knob): when this conversation asks
// about the site's own implementation, fetch the deployed source snapshot —
// a PUBLIC static file, so the server still sees none of the conversation —
// and build the context block + the sandbox /src mount provider from it.
// Shared deterministic logic (EN+SV gate, block builder) is introspect-core.js;
// the snapshot is fetched once per page load. Fail-soft: any problem means an
// empty block and no mount, never a broken send.
let snapshotCache = null;
async function loadSnapshotOnce() {
  if (!snapshotCache) {
    snapshotCache = fetch(SNAPSHOT_PATH)
      .then(async (res) => (res.ok ? validateSnapshot(await res.json()) : null))
      .catch(() => null);
  }
  return snapshotCache;
}

// The OWASP Top 10 reference corpus, fetched once per page load as a PUBLIC
// static file (server still in no data path). It grounds a security assessment
// so DRC can quote the actual OWASP text — retrieved OFFLINE with the
// embedding-free lexical path (the browser has no Berget e5), which is why no
// dense index is needed here. Fail-soft: any problem → no OWASP block, and the
// prompt-level default (buildIntrospectionBlock / research prompts) still holds.
let owaspCorpusCache = null;
async function loadOwaspCorpusOnce() {
  if (!owaspCorpusCache) {
    owaspCorpusCache = fetch(OWASP_CORPUS_PATH)
      .then(async (res) => {
        if (!res.ok) return null;
        const raw = await res.json();
        const snapshot = validateSnapshot(raw);
        return snapshot ? { snapshot, sources: raw && raw.sources ? raw.sources : {} } : null;
      })
      .catch(() => null);
  }
  return owaspCorpusCache;
}

// Build the OWASP reference block for a security-assessment conversation
// (lexical retrieval over the corpus → several categories). "" when not a
// security assessment or the corpus is unavailable.
async function owaspBlockFor(texts, latestText) {
  if (!texts.some((t) => securityAssessmentIntent(t))) return "";
  const corpus = await loadOwaspCorpusOnce();
  if (!corpus) return "";
  const hits = lexicalRetrieveOwasp(corpus.snapshot, latestText, { k: 8, perCat: 2 });
  return buildOwaspReferenceBlock(hits, corpus.sources);
}

async function introspectionContext(conv, latestText) {
  // Developer mode on = always give the model the site's own source, so any
  // phrasing ("code examples from the site") works — no brittle intent gate.
  // (DRC has no dense server index; it injects the orientation + file index +
  // named files from the snapshot the browser already fetches. The client-side
  // provider embedder can't cheaply re-embed the whole codebase, so retrieval
  // stays a DRS feature; the snapshot block still lets the model answer.)
  if (state.developerMode !== true) return { block: "", fileProvider: null, snapshot: null };
  try {
    const texts = conv.messages.filter((m) => m.role === "user").map((m) => m.content);
    phaseLine("Reading the site's own source…");
    const snap = await loadSnapshotOnce();
    if (!snap) return { block: "", fileProvider: null, snapshot: null };
    engageIntrospection(); // TIN slides in — the mode's visible marker
    // The full file index is worth its tokens only for strong "how are you
    // built / list files" asks; otherwise orientation + named files carry it.
    let block = buildIntrospectionBlock(snap, {
      latestText,
      includeIndex: introspectionActive(texts, snap),
      sandboxMounted: state.bashLite === true,
    });
    // Security assessment: also append the OWASP Top 10 reference (retrieved
    // OFFLINE via lexical TF-IDF over the committed corpus), so DRC classifies
    // findings against — and quotes — the real OWASP text with no server call.
    const owasp = await owaspBlockFor(texts, latestText);
    if (owasp) block += owasp;
    // The sandbox boots lazily; if it does, the whole tree lands at /src.
    const fileProvider = async () => ({ session: [], project: null, source: { files: snap.files } });
    // The snapshot itself rides along: with a tool-capable provider, DRC drives
    // a native grep_source/read_file/list_files (+ run_bash) tool loop over it
    // — the client-side twin of the server's runSourceResearchTools — instead of
    // only injecting the `block`. The block stays as the fail-soft fallback.
    return { block, fileProvider, snapshot: snap };
  } catch {
    return { block: "", fileProvider: null, snapshot: null };
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

  // The first-visit path: no key yet → the prepackaged non-LLM helper answers
  // the common get-started questions right in the chat (clearly badged as
  // canned, not the model), never an error wall. The question is echoed as a
  // normal bubble; nothing typed is lost. For an explicit get-started ask (or
  // an unrecognized one) also surface the key panel so setup is one tap away.
  if (!configuredDrcProviders(state.keys).length) {
    const reply = matchCanned(text, { tier: "drc" });
    renderCannedExchange(text, reply);
    $("input").value = "";
    if (!reply.matched || reply.id === "apikey" || reply.id === "access") {
      openSettings();
      $("keyspanel").open = true;
      $("key-input").focus();
    } else {
      workStatus("Prepackaged help shown above. Add your own API key under the gear (Settings) to research for real.");
    }
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
  const intro = await introspectionContext(conv, text);

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
      introspection: intro.block,
      snapshot: intro.snapshot,
      bash: state.bashLite === true,
      fileProvider: intro.fileProvider,
      onStatus: (s) => {
        if (s.type === "tool") {
          // Developer-mode native tool call — show the tool + its argument live
          // (which file / pattern / command), not a bare counter.
          phaseLine("🔧 " + s.headline);
        } else if (s.type === "phase") {
          // `label` carries a live line (e.g. a rotating sandbox-boot quip);
          // otherwise fall back to the phase's static label.
          phaseLine(s.label || PHASE_LABELS[s.phase] || s.phase);
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

// Introspection cue: toggle `dev-mode` on the root so the composer pane picks
// up the WHITE TITANIUM glass tint (drc.css `:root.dev-mode #composer`) and the
// small "introspection" wordmark tag appears — the shared introspection cue
// across both tiers. The khaki background and the iOS status-bar tint are
// deliberately left alone — only the input pane and the tag change, matching
// the Se/rver twin. developerMode lives in the sealed project state, so the
// tint settles once that state loads (no PWA cold-relaunch flash — a DRC
// session always opens its project first).
function applyIntrospectionTheme(on) {
  document.documentElement.classList.toggle("dev-mode", !!on);
}

// Build marker (on-device-trace convention): kept OFF the visible header —
// carried in the brand tooltip so a long-press still answers "which build,
// PWA or Safari" without cluttering the wordmark. Bump on every DRC deploy.
try {
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const brand = $("brand");
  brand.title = "About Se/cure · d23 · " + (standalone ? "pwa" : "browser");
} catch {
  // the marker is an instrument, never a breaker
}

const projectLinked = handleProjectLink();
renderKeysPanel();
renderConvPicker();
renderMessages();
// A replay deep link counts like a project link — no intro over it.
// On a genuine first visit the umbrella intro plays first (over the bare
// page); when it finishes, new users land straight in the chat input rather
// than on the promotional pane (afterUmbrella), which stays a tap on the
// wordmark away.
handlePublicationLink().then((opened) => {
  const deepLinked = projectLinked || opened;
  maybePlayUmbrella(deepLinked).then(() => afterUmbrella(deepLinked));
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
// The settings knobs' ⓘ info popovers (the Se/rver settings-pane component,
// ported here). Click or press-and-hold a ⓘ to open that knob's detail
// popover; opening one closes the others, and any click outside a popover or
// its ⓘ closes them all — the shared bubble-dismissal behaviour (UX-1).
(() => {
  const view = $("settingsview");
  const closeAllPops = () => view.querySelectorAll(".setting-pop").forEach((p) => (p.hidden = true));
  view.querySelectorAll(".setting-info").forEach((btn) => {
    const pop = view.querySelector(`#${btn.dataset.pop}`);
    if (!pop) return;
    let holdTimer = 0;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = pop.hidden;
      closeAllPops();
      pop.hidden = !wasHidden;
    });
    btn.addEventListener("pointerdown", () => {
      holdTimer = setTimeout(() => {
        closeAllPops();
        pop.hidden = false;
      }, 500);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
      btn.addEventListener(ev, () => clearTimeout(holdTimer));
    }
  });
  view.addEventListener("click", (e) => {
    if (!e.target.closest(".setting-pop") && !e.target.closest(".setting-info")) closeAllPops();
  });
})();
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
// Introspection mode's mascot (developer mode): TIN, the titanium robot,
// slides in when what the user is TYPING reads as an ask about this site's
// own implementation — here it explains that DRC is already the private
// route (own key, browser-direct). Debounced; no-op with the knob off.
initIntrospectUi({ tier: "drc" });
let introTypeTimer = 0;
$("input").addEventListener("input", () => {
  clearTimeout(introTypeTimer);
  introTypeTimer = setTimeout(() => {
    if (state.developerMode === true) noteIntrospectionText($("input").value);
  }, 350);
});
// Introspection knob (client-local, persisted in the sealed project state):
// unlocks introspection mode for this browser's conversations, and tints the
// composer pane WHITE TITANIUM (drc.css :root.dev-mode #composer) so the tier's
// mode is unmistakable — the same shared introspection cue the Se/rver twin
// uses.
$("devmode").checked = state.developerMode === true;
applyIntrospectionTheme(state.developerMode === true);
$("devmode").addEventListener("change", () => {
  state.developerMode = $("devmode").checked;
  applyIntrospectionTheme(state.developerMode === true);
  const st = $("devmodestatus");
  st.textContent = state.developerMode
    ? "Introspection is on — the composer pane turns white titanium; ask about this site's own source code to answer from the deployed source."
    : "Introspection is off.";
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
