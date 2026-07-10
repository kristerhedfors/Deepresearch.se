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
//   /js/drc-providers.js — the CORS-capable provider registry (OpenAI, Groq)
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
//   (The one plain localStorage item, dr_intro_seen, is a UI flag — it
//   carries nothing derived from secrets, keys, or content.)

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
import { configuredDrcProviders, drcProvider, listDrcModels } from "/js/drc-providers.js";
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

// ---- the DRS explainer: dimmed buttons stand where DRS features live ---------------

const DRS_FEATURES = {
  ghost: {
    title: "Ghost mode — you are here",
    text: "The ghost in the signed-in app brings you HERE: DRC is ghost mode. This site's server never receives your messages, keys, or projects — there is nothing to keep out of any log. (In DRS the server honors per-conversation incognito for its own log; here the question doesn't arise.)",
  },
  account: {
    title: "Account & usage",
    text: "Accounts, quotas, usage windows and the message center live in DRS — deep research server, the signed-in tier.",
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
        ". Ask a follow-up to continue it: replies run on YOUR API key (OpenAI or Groq), straight " +
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

function renderKeysPanel() {
  const have = [];
  for (const p of ["openai", "groq"]) {
    const el = $("key-" + p);
    el.value = "";
    el.placeholder = state.keys?.[p] ? "•••••• (saved)" : "not set";
    if (state.keys?.[p]) have.push(drcProvider(p).label);
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
      ? "Saved (encrypted in this browser)."
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
  // disabled, pointing at DRS.
  groups.push(
    '<optgroup label="DRS only — deepresearch.se/rver">' +
      '<option disabled>Berget — EU-hosted models</option>' +
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
      "Ask a research question to get started — it runs right here in your browser, on your own OpenAI or Groq API key.";
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

// ---- send: the client-side research pipeline -----------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending) return;
  const text = $("input").value.trim();
  if (!text) return;

  // The first-visit path: no key yet → a helpful pointer, never an error
  // wall. The message stays in the composer so nothing typed is lost.
  if (!configuredDrcProviders(state.keys).length) {
    openDrawer();
    $("keyspanel").open = true;
    $("key-groq").focus();
    workStatus(
      "One thing first: DRC runs on YOUR API key, sent straight from this browser to the " +
        "provider — this site's server never sees your key or your messages. Paste an OpenAI or " +
        "Groq key above (Groq has a free tier at console.groq.com), press Save keys, then send again.",
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

  let shown = "";
  let errMsg = null;
  let result = null;
  try {
    result = await runDrcResearch({
      providerId,
      apiKey: state.keys[providerId],
      model,
      messages: conv.messages.slice(-40),
      research: state.research,
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
  $("stamp").textContent = "d5 · " + (standalone ? "pwa" : "browser");
} catch {
  // the stamp is an instrument, never a breaker
}

const projectLinked = handleProjectLink();
renderKeysPanel();
renderConvPicker();
renderMessages();
// A replay deep link counts like a project link — no intro pane over it.
handlePublicationLink().then((opened) => maybeShowIntro(projectLinked || opened));

$("introstart").addEventListener("click", dismissIntro);
$("brand").addEventListener("click", () => {
  $("intro").hidden = false;
});
$("intro").addEventListener("click", (e) => {
  if (e.target === $("intro")) dismissIntro();
});
// The drawer (chats, project, keys).
$("historybtn").addEventListener("click", openDrawer);
$("drawerclose").addEventListener("click", closeDrawer);
$("drawer").addEventListener("click", (e) => {
  if (e.target === $("drawer")) closeDrawer();
});
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
