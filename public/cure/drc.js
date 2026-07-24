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
//   (The plain localStorage items, dr_intro_seen and dr_umbrella_seen_v2, are
//   UI flags — they carry nothing derived from secrets, keys, or content.)

import {
  deriveDrcProfile,
  deriveDrcTitle,
  drcBackupFileName,
  emptyDrcState,
  drcSecretValid,
  generateDrcSecret,
  migrateDrcState,
  openDrcBackup,
  openDrcState,
  sealDrcState,
  validateDrcState,
} from "/js/drc-core.js";
import {
  DRC_PROVIDERS,
  POOL_LLM_PROVIDER_ID,
  PROXY_LLM_PROVIDER_ID,
  SERVER_TOKEN_LLM_PROVIDER_ID,
  configuredDrcProviders,
  detectDrcProvider,
  drcEmbed,
  drcEmbedProvider,
  drcProvider,
  foreignDrcKeyHint,
  listDrcModels,
  poolLlmProvider,
  proxyLlmProvider,
  serverTokenLlmProvider,
} from "/js/drc-providers.js";
import { poolDataFlowNotice } from "/js/pool-core.js";
import { createPoolProvider } from "/js/pool-provider.js";
import {
  KNOWLEDGE_FILE_EXT,
  buildConclusion,
  buildKnowledgeBundle,
  curate,
  curationState,
  finalizeConclusion,
  sealKnowledge,
  summarizeContext,
} from "/js/knowledge-core.js";
import { openBundle, validateBundle } from "/js/proxy-bundle.js";
import {
  applyWorkspacePayload,
  buildWorkspacePayload,
  workspacePayloadCarries,
  generateWorkspacePassword,
  isWorkspacePath,
  openWorkspace,
  parseWorkspaceHash,
  sealWorkspace,
  validateWorkspacePayload,
  workspaceLink,
} from "/js/workspace-core.js";
import { flagForProvider, labelWithFlag } from "/js/provider-region.js";
import { wireBarTint } from "/js/bar-tint.js";
import { DRC_RECENT_TURNS, ensureDrcRag, indexDrcChatTurns, retrieveDrcContext } from "/js/drc-rag.js";
import { runDrcResearch } from "/js/drc-research.js";
import { runBackendSearch as runDirectBackendSearch } from "/js/websearch-backends-core.js";
import { ensureSandboxBooted, sandboxIdle, sandboxSupported, setSandboxImage } from "/js/sandbox.js";
import { hideTerminalIcon, showTerminalIcon } from "/js/agent-backdrop.js";
import {
  DOCS_CORPUS_PATH,
  OWASP_CORPUS_PATH,
  SNAPSHOT_PATH,
  buildHelpDocsBlock,
  buildIntrospectionBlock,
  buildOwaspReferenceBlock,
  docsCorpusMeta,
  helpIntent,
  introspectionActive,
  lexicalRetrieveCorpus,
  lexicalRetrieveOwasp,
  securityAssessmentIntent,
  validateSnapshot,
} from "/js/introspect-core.js";
import { engageIntrospection, initIntrospectUi, noteIntrospectionText } from "/js/introspect-ui.js";
import { initSourcePeek, wireSourcePeek } from "/js/source-peek.js";
import { drcStoreAvailable, getSealedProject, putSealedProject } from "/js/drc-store.js";
import { BUDGET_MAX_S, BUDGET_MIN_S, budgetTier, fmtBudget, posToSeconds, secondsToPos } from "/js/timescale.js";
import {
  drcFeedbackContext,
  grantFlagEnabled,
  grantLive,
  grantMeterLine,
  normalizeSearchBackend,
  parseProjectPath,
  parsePublicationRef,
  privacyNoticeLines,
  providerVisibilityNote,
  serverTokenLive,
  serverTokenService,
  unlockCelebrationSize,
  wmHtml,
} from "/js/drc-page-core.js";
import { matchCanned } from "/js/canned-faq.js";
import { feedbackIntent, feedbackPageTag, feedbackScopeOfPrior } from "/js/feedback-core.js";
import { spaceIntentMatch } from "/js/space-core.js";
import { renderMarkdownInto } from "/js/markdown.js";
import { mountUmbrellaSpinner } from "/js/umbrella-spinner.js";

const $ = (id) => document.getElementById(id);

// The first-visit umbrella intro's once-per-browser flag. Versioned (…_v2)
// so a fix to the intro can re-show it to browsers that recorded the previous,
// broken version as "seen". The head script in index.html reads the SAME key
// to decide whether to hold the chrome hidden for the play — keep them in sync.
const UMBRELLA_SEEN_KEY = "dr_umbrella_seen_v2";

let profile = null; // {refHash, blobId, blobKey} — null while the session is unsaved
let state = emptyDrcState(); // the working state (keys included), from the first keystroke
let convId = null; // active conversation id
let sending = false;
let unsavedHintShown = false;

// The local (keyless) provider's configured base URL — normalized on read so a
// pasted trailing slash never doubles a "/" on the wire.
const localUrl = () => (state?.localBaseUrl || "").trim().replace(/\/+$/, "");
// The providers this session can call: keyed ones, plus Local when a server
// URL is configured (the keyless generalization in drc-providers.js).
const configuredProviders = () => configuredDrcProviders(state.keys, { localBaseUrl: localUrl() });

const PHASE_LABELS = {
  triage: "Analyzing the question…",
  clarify: "Asking for a detail…",
  search: "Searching the web…",
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

function workStatus(msg) {
  const el = $("workstatus");
  el.hidden = !msg;
  el.innerHTML = msg ? wmHtml(msg) : "";
  updateNoticesClose();
}

// The footer notices' shared dismiss × (owner request, 2026-07-16): shown only
// while either notice is visible. Dismissing clears the workstatus line and
// hides the provider disclosure for THIS text only — a model change (new text)
// or a reload brings the disclosure back, so the invariant-4 "which APIs are
// connected" posture is unchanged.
let provNoteDismissed = "";
function updateNoticesClose() {
  const btn = $("noticesclose");
  if (btn) btn.hidden = $("provnote").hidden && $("workstatus").hidden;
}

// ---- the research step list --------------------------------------------------------
//
// The DRC research phases render as a live STEP LIST — the /cure analog of the
// DRS app's activity steps (public/js/activity.js makeStepDom/markFinished):
// each phase shows a spinning pink UMBRELLA (mountUmbrellaSpinner, the very
// module the DRS app mounts — it's tier-agnostic, so no duplication) while it
// runs, then swaps to a pink ✓ the moment the next phase starts (or the run
// ends). A repeated event for the SAME phase — a rotating sandbox-boot quip, a
// harvest count ticking — updates the running step's label in place and keeps
// its spinner. Fail-soft by construction: if the umbrella can't mount
// (reduced-motion, no canvas) the row still shows its label and ✓, exactly the
// way the DRS steps degrade. The finished ✓ list stays until the next send
// clears it (resetPhaseSteps), the DRC analog of the app's persistent activity.
//
// The step list lives INLINE in the conversation (#chat), inserted just above
// the streaming answer for the current send — NOT in the composer footer.
// (Before 2026-07-14 it rendered into a static #phaseline inside #composer, so
// the steps appeared down in the input pane where questions are typed instead
// of in the conversation flow; the DRS app renders its activity inline, so the
// tiers now match.) `beginPhaseSteps` builds a fresh host per send; the module
// keeps a handle to it so phaseStep/finish/reset don't have to thread it.

let curPhaseStep = null; // { key, details, summary, label, spin, spinner, body } — running step, or null
let phaseHost = null; // the .phasesteps container for the current send, inside #chat
let phaseStepSeq = 0; // rotates the spinner STYLE so adjacent steps differ

// Start a fresh step list inside the conversation flow. `beforeEl` is the live
// answer element the steps should sit above (matching DRS, where activity
// precedes the answer); with none the host is appended to the end of #chat.
function beginPhaseSteps(beforeEl) {
  resetPhaseSteps();
  const host = document.createElement("div");
  host.className = "phasesteps";
  if (beforeEl) beforeEl.before(host);
  else $("chat").appendChild(host);
  phaseHost = host;
  return host;
}

// Finish the running step with the umbrella spinner's COMPLETION FINALE: it
// speed-runs into the fully-bloomed PINK umbrella and folds into the pink ✓
// (the tier's own symbol on every step — what the session sends where lives
// in the ℹ privacy notice, not in per-step badges). Fail-soft: a no-op mount
// fires the callback at once. Detached from curPhaseStep immediately so a
// new step can start over the ~1 s finale.
function finishCurPhaseStep() {
  if (!curPhaseStep) return;
  const step = curPhaseStep;
  curPhaseStep = null;
  const settle = () => {
    if (!step.summary.querySelector(".check")) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      step.summary.prepend(check);
    }
    step.spinner?.stop?.();
    step.spin?.remove();
  };
  if (step.spinner?.finish) step.spinner.finish(settle);
  else settle();
}

// Start (or update-in-place) the step for `key`. A new key finishes the
// previous step first; the same key just re-labels the running one.
//
// Each step is a <details> (a tappable, expandable summary + body) — the /cure
// analog of the DRS app's <details class="step"> (public/js/activity.js
// makeStepDom). It starts NOT expandable (toggling is preventDefault'd until an
// `expandable` class appears — there's nothing inside yet); the moment detail is
// added (a tool call's command + output, a sandbox command's transcript, a
// research phase's outcome lines or a web search's linked sources) the
// body is created and the step becomes tappable, so a visitor can open it to
// see exactly WHAT each phase decided, searched, ran and returned — matching
// Se/rver, where every research step expands (2026-07-16 parity request).
function phaseStep(key, label) {
  const host = phaseHost;
  if (!host) return;
  if (curPhaseStep && curPhaseStep.key === key) {
    curPhaseStep.label.textContent = label || "";
    return;
  }
  finishCurPhaseStep();
  const details = document.createElement("details");
  details.className = "phase-step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const lab = document.createElement("span");
  lab.className = "phase-label";
  lab.textContent = label || "";
  summary.append(spin, lab);
  details.appendChild(summary);
  // Block the toggle until there's a body to show (the `expandable` gate,
  // mirroring DRS activity.js makeStepDom).
  details.addEventListener("click", (e) => {
    if (!details.classList.contains("expandable")) e.preventDefault();
  });
  host.appendChild(details);
  // The step wears the tier's own symbol — the pink UMBRELLA (docs/
  // SYMBOL-LANGUAGE.md §6, 2026-07-16). Best-effort, and the spinner stops
  // itself when finishCurPhaseStep removes the `.spin` host.
  const spinner = mountUmbrellaSpinner(spin, { style: (phaseStepSeq++ * 3) % 6, size: 30 });
  curPhaseStep = { key, details, summary, label: lab, spin, spinner, body: null };
}

// Re-label the running step WITHOUT starting a new one — for the live tool
// headlines and the post-validation revision note. Starts a step if none runs.
function phaseNote(text) {
  if (curPhaseStep) curPhaseStep.label.textContent = text || "";
  else phaseStep("_note", text);
}

// Lazily create the running step's expandable body and mark the step tappable.
// Returns null when no step is running (so callers no-op safely).
function phaseStepBody() {
  if (!curPhaseStep) return null;
  if (!curPhaseStep.body) {
    const body = document.createElement("div");
    body.className = "phase-detail";
    curPhaseStep.details.appendChild(body);
    curPhaseStep.details.classList.add("expandable");
    curPhaseStep.body = body;
  }
  return curPhaseStep.body;
}

// Append one tool call (developer-mode source investigation: grep_source /
// read_file / list_files / run_bash) to the running step's expandable body —
// the command/argument headline plus the first lines of its REAL result, so the
// step opens to show what the model actually ran and read (the /cure twin of the
// DRS step's `details` bullets). `lines` is drc-research.js's toolResultLines().
function appendToolDetail(headline, lines) {
  const body = phaseStepBody();
  if (!body) return;
  const item = document.createElement("div");
  item.className = "tool-call";
  const head = document.createElement("div");
  head.className = "tool-head";
  head.textContent = "🔧 " + (headline || "");
  const out = document.createElement("pre");
  out.className = "tool-out";
  out.textContent = (Array.isArray(lines) ? lines : []).join("\n");
  item.append(head, out);
  body.appendChild(item);
}

// Append one sandbox command's full transcript (command line, non-zero exit
// badge, clamped output) to the running step's expandable body — the bash-lite
// shell pass's counterpart of appendToolDetail, mirroring the DRS sandbox step's
// renderShellRun (public/js/activity.js). Untrusted throughout: textContent
// only, never HTML.
function appendShellRun(run) {
  const r = run && typeof run === "object" ? run : null;
  if (!r || !r.command) return;
  const body = phaseStepBody();
  if (!body) return;
  const wrap = document.createElement("div");
  wrap.className = "shell-run";
  const cmd = document.createElement("div");
  cmd.className = "shell-cmd";
  const prompt = document.createElement("span");
  prompt.className = "shell-prompt";
  prompt.textContent = "$";
  const text = document.createElement("span");
  text.className = "shell-cmd-text";
  text.textContent = String(r.command || "");
  cmd.append(prompt, text);
  const exit = Number.isFinite(Number(r.exitCode)) ? Math.trunc(Number(r.exitCode)) : 1;
  if (exit !== 0) {
    const badge = document.createElement("span");
    badge.className = "shell-exit";
    badge.textContent = "exit " + exit;
    cmd.appendChild(badge);
  }
  const out = document.createElement("pre");
  out.className = "shell-out";
  const stdout = typeof r.stdout === "string" ? r.stdout.replace(/\s+$/, "") : "";
  const stderr = typeof r.stderr === "string" ? r.stderr.replace(/\s+$/, "") : "";
  out.textContent = stdout && stderr ? "stdout:\n" + stdout + "\n\nstderr:\n" + stderr : stdout || stderr || "(no output)";
  wrap.append(cmd, out);
  body.appendChild(wrap);
}

// Append plain outcome lines (planned sub-questions, per-angle fact counts,
// follow-up questions, fact-check issues) to the running step's expandable
// body — the /cure twin of the DRS app's finishGenericStep <ul> bullets
// (public/js/activity.js). textContent only: the lines quote model output.
function appendDetailLines(lines) {
  const items = (Array.isArray(lines) ? lines : []).filter((s) => typeof s === "string" && s.trim());
  if (!items.length) return;
  const body = phaseStepBody();
  if (!body) return;
  const ul = document.createElement("ul");
  ul.className = "phase-lines";
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = it;
    ul.appendChild(li);
  }
  body.appendChild(ul);
}

// Append one live web search's result group (the query headline + its linked
// sources) to the running step's expandable body — the /cure twin of the DRS
// search step's expandable source list (public/js/activity.js
// finishSearchStep). Titles via textContent (untrusted), links restricted to
// http(s), opened in a new tab with rel=noopener like the DRS list.
function appendSourceGroup(query, items) {
  const list = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.url === "string" && /^https?:\/\//i.test(it.url),
  );
  if (!list.length) return;
  const body = phaseStepBody();
  if (!body) return;
  const wrap = document.createElement("div");
  wrap.className = "search-group";
  const head = document.createElement("div");
  head.className = "search-head";
  head.textContent = "“" + (query || "") + "” · " + list.length + (list.length === 1 ? " result" : " results");
  const ul = document.createElement("ul");
  ul.className = "phase-lines";
  for (const it of list) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = it.url;
    a.textContent = typeof it.title === "string" && it.title ? it.title : it.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.appendChild(a);
    ul.appendChild(li);
  }
  wrap.append(head, ul);
  body.appendChild(wrap);
}

// Settle the last step to a ✓ at run end (the list stays visible until the
// next send resets it).
function finishPhaseSteps() {
  finishCurPhaseStep();
}

// Clear the whole list at the start of a fresh send: drop the previous run's
// inline host (it lived in #chat) so the new send builds its own.
function resetPhaseSteps() {
  curPhaseStep = null;
  if (phaseHost) {
    phaseHost.remove();
    phaseHost = null;
  }
  phaseStepSeq = 0;
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
    // The ghost greets a first-time visitor and points at the account button.
    showGhostSay();
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
  // `?anim=rev` forces the REVERSE easter-egg play (which normally fires once
  // every 40 plays on its own); like `?anim=1` it also forces through every
  // suppression gate so "show me the backwards one" always works.
  const rev = /[?&]anim=rev\b/.test(location.search);
  const force = rev || /[?&]anim=1\b/.test(location.search);
  let seen = false;
  try {
    // Versioned key (2026-07-14): the earlier `dr_umbrella_seen` was set BEFORE
    // the intro played, so anyone who first-visited during the stuck-canvas bug
    // (the RAF stall that froze a bare khaki field — since fixed) recorded the
    // intro as "seen" while actually seeing nothing, and it never replayed.
    // Bumping the key gives every existing browser the now-fixed intro exactly
    // once. (Old key intentionally left unread — no cleanup needed.)
    seen = localStorage.getItem(UMBRELLA_SEEN_KEY) === "1";
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
  // Resolves with whether the intro actually PLAYED so the caller can chain
  // the ambient strolling ghost (ghostwalk.js) onto a real play, and force it
  // through reduced-motion on the ?anim=1 path exactly as the intro is.
  if (!force && (reduced || seen || deepLinked)) return Promise.resolve(false);
  // Mark the intro "seen" only once it has actually RUN (in the completion
  // handler below), not here before the play. If the module fails to even load
  // (the .catch path) the flag stays unset so the one-and-only first-visit
  // intro retries next time instead of being silently burned. `?anim=1`/deep
  // links never reach here, so the replay path never touches the flag.
  const markUmbrellaSeen = () => {
    try {
      localStorage.setItem(UMBRELLA_SEEN_KEY, "1");
    } catch {
      // fine — it may play again next visit
    }
  };
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
    .then(([m, speed]) =>
      new Promise((res) =>
        m.playUmbrellaIntro({ onDone: res, speed, reverse: rev ? true : undefined })
      )
    )
    .then(() => {
      markUmbrellaSeen(); // it ran (played through, was skipped, or self-healed)
      return true;
    })
    .catch(() => {
      // decoration only — never block the page over it
      return false;
    });
}

// The ambient strolling ghost (public/cure/ghostwalk.js): after the intro the
// little ghost ambles across the page carrying a pink umbrella and saying
// things. Dynamically imported and fully fail-soft — a load failure is a
// no-op, exactly like the intro. `force` is the ?anim=1 replay, which pushes
// it through reduced-motion just as it does the intro.
function startGhostStroll(force) {
  import("./ghostwalk.js")
    .then((m) => m.startGhostWalk({ force: !!force }))
    .catch(() => {
      // decoration only — never block the page over it
    });
}

// The ambient stroll is HELD while the first-visit greeter popover (#ghostsay)
// is up — otherwise the ghost runs around underneath the info box, competing
// for attention the moment the user lands. When a stroll is queued behind the
// popover, `hideGhostSay` releases it (any dismissal: the ×, an outside tap, or
// opening the account menu). If the popover was never shown (returning visitor
// / replay) the stroll starts immediately at the call site instead.
let pendingGhostStroll = null;
function runPendingGhostStroll() {
  const fn = pendingGhostStroll;
  pendingGhostStroll = null;
  if (fn) fn();
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

// ---- the "little fella" greeter: the ghost explains the Se/cure tier ---------------

// On a genuine first visit (after the umbrella intro), the ghost mascot
// explains that you're on the client-side Se/cure tier and points at the
// account button — the menu holding the door to Se/rver. Shown once (dr_secure_intro_seen);
// dismisses on its close button or any outside tap (UX-1).
function showGhostSay() {
  let seen = false;
  try {
    seen = localStorage.getItem("dr_secure_intro_seen") === "1";
  } catch {
    // storage blocked — it just may greet again next visit
  }
  if (seen) return;
  try {
    localStorage.setItem("dr_secure_intro_seen", "1");
  } catch {
    // fine
  }
  $("ghostsay").hidden = false;
  $("accountbtn").classList.add("nudge"); // briefly draw the eye to the target
}

function hideGhostSay() {
  if ($("ghostsay").hidden) return;
  $("ghostsay").hidden = true;
  $("accountbtn").classList.remove("nudge");
  // The ambient ghost stroll waits behind the greeter popover so it doesn't run
  // around underneath the info box; releasing the popover releases the stroll.
  runPendingGhostStroll();
}

// ---- the account view (right drawer, the person icon) -----------------------------

// Se/cure has no accounts, so the account button opens a MENU rather than the
// old straight-to-/login redirect: the documentation links every visitor can
// read (all public pages) and, where account specifics would sit, the sign-in
// link to the hosted tier. Static markup in index.html — nothing to render.
function openAccount() {
  closeDrawer();
  hideGhostSay(); // the greeter points AT this button — opening the menu completes its job
  $("accountview").hidden = false;
}

function closeAccount() {
  $("accountview").hidden = true;
}

// ---- the settings view (right drawer, the gear): keys + sandbox -------------------

function openSettings() {
  closeDrawer();
  $("bashlite").checked = state.bashLite === true; // reflect current state
  $("devmode").checked = state.developerMode === true;
  $("ondevice").checked = state.onDevice === true;
  renderOnDeviceRows().catch(() => {}); // reflect the on-device model states
  renderKeysPanel();
  renderLocalRow(); // reflect the local model server URL (if any)
  renderWsRow(); // reflect the web-search grant (if any)
  renderStRow(); // reflect the consolidated Se/rver token (if any)
  renderProxyRow(); // reflect the secure-research-space bundle (if any)
  renderSearchBackend(); // reflect the per-user web-search backend
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
};

function showDrs(feature) {
  const f = DRS_FEATURES[feature];
  if (!f) return;
  $("drspop-title").innerHTML = wmHtml(feature === "ghost" ? f.title : f.title + " — a Se/rver feature");
  $("drspop-text").innerHTML = wmHtml(f.text);
  $("drspop").hidden = false;
}

// ---- the privacy notice (ℹ) ----------------------------------------------------------
//
// The read-up on privacy in detail (owner directive, 2026-07-16): the
// animations are tier identity — every /cure step wears the umbrella — and
// WHAT this session sends WHERE lives here instead: an information notice
// always one tap away on the header's ℹ button, and popped up automatically
// the moment a shared secure workspace opens (the arriving user should not
// have to go looking for the privacy story of what they were just handed).
// The text itself is pure (privacyNoticeLines, drc-page-core.js), built from
// the session's CURRENT configuration via the same accessors the send path
// resolves — provider route, borrowed allowances, web-search route, recall.

// Set when a shared workspace link opened this session: the workspace's name,
// or true for an unnamed one (privacyNoticeLines renders both).
let sharedWorkspace = false;
// Set when THAT workspace link bundled a borrowed allowance (a "research
// token"), to `{ llm, search }` naming EXACTLY which services it carried —
// mapped to the two share-menu grant families and nothing else: the `api`
// grant (server-proxied Berget for the model + embeddings) → llm, the web /
// legacy web-search grant (server-proxied Exa, query only) → search. These are
// the ONLY third parties a link can borrow (never Shodan/Maps/etc.), so the
// notice can state the exact routes AND the ceiling. Based on what the payload
// CARRIED (independent of hydration success) — the token still phones home
// once it works. `false` when no allowance was bundled.
let sharedWorkspaceGrants = false;

function privacyCtx() {
  const [pid] = ($("model").value || "").split("::");
  // The Se/rver-token LLM path shares the proxy's semantics: the conversation
  // routes through this site's server to Berget, borrowed and metered.
  const viaProxy = pid === PROXY_LLM_PROVIDER_ID || pid === SERVER_TOKEN_LLM_PROVIDER_ID;
  const grantSearch = stWebUsable() || webProxyUsable() || (wsGrantActive() && wsEnabled());
  const embedP = drcEmbedProvider(state?.keys || {});
  // Project recall (RAG) embeds either on the user's OWN key or — when a
  // borrowed `api` grant is the active provider — through the server on Berget
  // (see embedHookup). Disclose which, so the borrowed case (the question text
  // touches the server) is never silent.
  const embedBorrowed = !embedP && viaProxy && (apiProxyUsable() || stApiUsable());
  return {
    provider: viaProxy ? "Berget (borrowed)" : pid === ONDEVICE_ID ? "On-device" : drcProvider(pid)?.label || pid,
    viaProxy,
    local: pid === "local" || pid === ONDEVICE_ID,
    search: state?.research === false ? "off" : directSearchActive() ? "self" : grantSearch ? "grant" : "off",
    embedProvider: embedP?.label || (embedBorrowed ? "Berget (borrowed)" : ""),
    embedBorrowed,
    grantsConnected: grantSearch || apiProxyUsable() || stApiUsable(),
    workspaceName: sharedWorkspace,
    workspaceGrants: sharedWorkspaceGrants,
  };
}

function showPrivacyNotice() {
  const lines = privacyNoticeLines(privacyCtx()).map((p) => "<p>" + wmHtml(p) + "</p>");
  // Shared compute present (a pool token in this browser): append its
  // data-flow disclosure — ONE source of truth (pool-core.js), shown to every
  // workspace participant, not just whoever flipped a knob.
  if (poolGrant && poolGrant.token) {
    lines.push(
      ...poolDataFlowNotice().map(
        (p) => '<p class="privacy-pool">🤝 ' + wmHtml(p) + "</p>",
      ),
    );
  }
  $("privacypop-text").innerHTML = lines.join("");
  $("privacypop").hidden = false;
}

// ---- deep links ---------------------------------------------------------------------

// /my/project-<hash> (or the legacy /free/project-…) prefills the
// reference so the password manager (which files the secret under that
// username) matches the entry, and opens the panel ready for the secret.
function handleProjectLink() {
  const ref = parseProjectPath(location.pathname); // drc-page-core.js
  if (!ref) return false;
  $("refname").value = ref;
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
  const ref = parsePublicationRef(location.pathname, location.search); // drc-page-core.js
  if (!ref) return false;
  const { slug, fromPath } = ref;
  try {
    const res = await fetch("/api/pub/" + encodeURIComponent(slug.toLowerCase()));
    if (!res.ok) {
      if (fromPath) workStatus("No publication at /cure/" + slug + " — starting fresh.");
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
  $("exportbtn").hidden = false; // an open project has bytes to back up
  $("secret").value = "";
  $("secret").setAttribute("autocomplete", "current-password");
  $("newsecret").hidden = true;
  $("projpanel").open = false;
  closeDrawer();
  history.replaceState(null, "", "/my/project-" + profile.refHash);
}

// ---- the research time slider (the Se/rver slider, mirrored) --------------------
//
// The Se/rver composer's time slider, mirrored here as closely as the tier
// allows (owner directive, 2026-07-16): the same quadratic 15 s–10 min scale
// and the same time-stacked-over-tier readout (public/js/timescale.js —
// budgetTier names the report the setting BUYS, not just the duration). The
// seconds persist in the sealed state (`budgetS`, the DRS `budget_s`
// counterpart) and ride into runDrcResearch, where they are the wall-clock
// ROOF on the client-side research (drc-research.js drcPlanForBudget + the
// deadline guards) exactly as src/budget.js plans the hosted pipeline.

/** Repaints the time/tier readout from the slider's position; returns seconds. */
function renderBudgetReadout() {
  const s = posToSeconds(Number($("budget").value));
  const tier = budgetTier(s);
  $("budgettime").textContent = fmtBudget(s);
  $("budgettier").textContent = tier.label;
  $("budgetval").title = "Research time target · " + tier.desc;
  return s;
}

/** Points the slider at the state's stored seconds (absent reads as 60 s). */
function reflectBudget() {
  const s = Number(state.budgetS);
  $("budget").value = String(secondsToPos(s >= BUDGET_MIN_S && s <= BUDGET_MAX_S ? s : 60));
  // The web-search knob gates web search ONLY; the slider stays active either
  // way (owner directive 2026-07-18, the Se/rver twin's coupling dropped).
  // Depth still buys OUTPUT depth with the knob off: drc-research.js's offline
  // path already scales the answer by the report tier (drcSynthPrompt). So the
  // slider no longer disables/dims when search is off.
  renderBudgetReadout();
}

// Web search is REACHABLE only when the session actually has a search source:
// the user's own browser-direct backend (SearXNG / Exa-compatible), or a live,
// enabled server grant/token (consolidated `web`, proxy bundle, or the legacy
// web-search grant). A plain fresh arrival — "from nowhere", no previous
// session — has none of these, so it has no web search.
function webSearchAvailable() {
  return directSearchActive() || stWebUsable() || webProxyUsable() || (wsGrantActive() && wsEnabled());
}

// Point the web-search knob at REALITY. It shows ON only when research is
// desired (state.research, default true) AND web search is actually reachable —
// so arriving with no credentials shows OFF instead of promising a capability
// the session doesn't have, while a configured backend or an incoming grant/
// token flips it back on. The send path copies the knob into state.research at
// submit time, so the pipeline follows whatever the knob honestly shows.
function reflectResearchKnob() {
  $("websearch").checked = state.research !== false && webSearchAvailable();
}

// Reflect a freshly opened/restored state everywhere the UI shows it — the
// shared tail of unlock() and importBackup().
async function reflectOpenedState() {
  reflectResearchKnob();
  reflectBudget();
  $("bashlite").checked = state.bashLite === true;
  $("devmode").checked = state.developerMode === true;
  applyIntrospectionTheme(state.developerMode === true);
  renderKeysPanel();
  renderConvPicker();
  renderMessages();
  if (configuredProviders().length) await refreshModels();
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
    await reflectOpenedState();
  } catch (err) {
    gateStatus(err?.message || "Could not open the project.");
  } finally {
    $("openbtn").disabled = false;
  }
}

// ---- encrypted backup: the sealed blob as a .drc file --------------------------------
//
// Export = the stored ciphertext, byte for byte, as a download — the guard
// against the browser evicting site data (a Se/cure project's only copy lives
// in this browser's localStorage). Import = the same bytes + the project's
// secret, restorable on any device; a local copy that is NEWER than the backup
// is never clobbered — the newer state wins and the other's chats merge in
// (the unlock() merge, applied to files).

async function exportBackup() {
  if (!profile) return;
  await saveState(); // the file mirrors what's stored, freshest state included
  const bytes = getSealedProject(profile.blobId);
  if (!bytes) {
    gateStatus("Nothing is stored to export yet — storage may be blocked in this browser.");
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  a.download = drcBackupFileName(profile.refHash);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  gateStatus("Backup downloaded. It stays encrypted — only this project's secret opens it.");
}

/** @param {File} file */
async function importBackup(file) {
  const secret = $("secret").value;
  if (!drcSecretValid(secret)) {
    $("projpanel").open = true;
    gateStatus("Enter this backup's secret (DR1-…) in the Secret field first, then pick the file again.");
    return;
  }
  gateStatus("Opening the backup…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await openDrcBackup(bytes, secret);
  if (!res) {
    gateStatus("That backup could not be opened with this secret — wrong secret, or a damaged file.");
    return;
  }
  let next = res.state;
  const existing = drcStoreAvailable() ? getSealedProject(res.profile.blobId) : null;
  if (existing) {
    const cur = await openDrcState(existing, res.profile.blobKey).catch(() => null);
    if (cur && validateDrcState(cur)) {
      const local = migrateDrcState(cur);
      const [base, other] = (local.updatedAt || 0) >= (next.updatedAt || 0) ? [local, next] : [next, local];
      const known = new Set(base.conversations.map((c) => c.id));
      for (const c of other.conversations) {
        if (c.messages?.length && !known.has(c.id)) base.conversations.push(c);
      }
      base.keys = { ...other.keys, ...base.keys };
      next = base;
    }
  }
  profile = res.profile;
  state = next;
  projectOpened();
  await saveState();
  await reflectOpenedState();
  gateStatus("");
  workStatus("Backup restored — project-" + profile.refHash + " is open and saved in this browser.");
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
// A recognized-but-unsupported shape (an Anthropic sk-ant-… key) says so
// honestly instead of showing nothing — see FOREIGN_KEY_SHAPES.
function syncKeyDetection() {
  const raw = $("key-input").value;
  const detected = detectDrcProvider(raw);
  if (detected) {
    /** @type {HTMLSelectElement} */ ($("key-provider")).value = detected.id;
    $("keydetect").textContent = "— detected: " + detected.label;
  } else {
    const foreign = foreignDrcKeyHint(raw);
    $("keydetect").textContent = foreign ? "— " + foreign : "";
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

// ---- the local model server (the keyless provider) ----------------------------------

function renderLocalRow() {
  $("local-url").value = state.localBaseUrl || "";
}

// Save the URL, then probe it (GET {base}/models — listDrcModels is already
// the probe: it never throws, and the local entry has no static fallback, so
// an empty list means "nothing answered"). The URL lives in the sealed state
// like the keys; an empty URL removes the provider from the dropdown.
async function saveLocalUrl() {
  const url = $("local-url").value.trim().replace(/\/+$/, "");
  state.localBaseUrl = url;
  const status = (m) => ($("local-status").textContent = m);
  $("local-save").disabled = true;
  try {
    await saveState();
    if (!url) {
      status("Local model server removed.");
      return;
    }
    status("Checking " + url + " …");
    const ids = await listDrcModels(drcProvider("local"), "", { baseUrl: url });
    status(
      ids.length
        ? "✓ Server found — " + ids.length + " model" + (ids.length === 1 ? "" : "s") + ". Nothing leaves this device."
        : "Saved, but no server answered at " + url + " — is it running, and does it allow this origin? " +
          "(Ollama needs OLLAMA_ORIGINS=" + location.origin + ")",
    );
  } finally {
    $("local-save").disabled = false;
  }
  await refreshModels().catch(() => {});
}

// ---- ON-DEVICE models (phone-local Bonsai — ondevice-engine.js) ---------------------
//
// The strongest privacy mode after `local`: the model runs INSIDE this
// browser on WebGPU (docs/BONSAI-27B-PHONE-INFERENCE.md), so after the
// one-time weight download research needs no network at all. The engine
// module itself loads LAZILY and only while the knob is on — the contract is
// "off means zero bytes for the feature" — and weights download ONLY through
// the explicit consent popup (#odconsent): its dismissal is a NO; only the
// size-labeled Download button starts a fetch.

const ONDEVICE_ID = "ondevice";
let odEngineModule = null;
async function odEngine() {
  if (!odEngineModule) odEngineModule = await import("/js/ondevice-engine.js");
  return odEngineModule;
}
const odDownloading = new Set(); // modelIds with a download in flight (UI state)
// modelId → the last download failure, shown IN the model's row: the footer
// workstatus line is covered by the settings drawer on a phone, so an error
// that only landed there read as "confirmed, flickered, nothing happened"
// (the 2026-07-17 iPhone report). Cleared on the next attempt.
const odErrors = new Map();

// The settings section: one row per catalog model with its true state —
// on this device (Delete) / downloadable (Download → consent) / not yet
// published (the 27B today) / unsupported here (the self-explaining verdict).
async function renderOnDeviceRows() {
  const wrap = $("odmodels");
  const on = state.onDevice === true;
  wrap.hidden = !on;
  if (!on) {
    wrap.innerHTML = "";
    $("odstatus").textContent = "";
    return;
  }
  $("odstatus").textContent = "";
  if (!wrap.childElementCount) wrap.innerHTML = '<span class="muted setting-note">Checking this device…</span>';
  try {
    const eng = await odEngine();
    const probe = await eng.probeOnDevice();
    const cached = await eng.listCachedModels();
    wrap.innerHTML = "";
    for (const m of eng.ONDEVICE_MODELS) {
      const entry = cached.find((c) => c.id === m.id);
      const verdict = eng.capabilityVerdict(probe, m);
      const row = document.createElement("div");
      row.className = "od-model";
      row.dataset.od = m.id;
      const label = document.createElement("span");
      label.className = "od-label";
      label.textContent = m.label;
      const note = document.createElement("span");
      note.className = "od-note muted setting-note";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btnlike od-btn";
      if (odDownloading.has(m.id)) {
        note.textContent = "Downloading…";
        btn.textContent = "Cancel";
        btn.onclick = async () => (await odEngine()).cancelDownload(m.id);
      } else if (entry?.cachedBytes) {
        note.textContent = "On this device · " + eng.fmtBytes(entry.cachedBytes) + " — pick it in the model dropdown.";
        btn.textContent = "Delete";
        btn.onclick = async () => {
          btn.disabled = true;
          // A failed delete must not strand a disabled button — re-render
          // either way; the row then shows the model's true current state.
          await (await odEngine()).deleteModel(m.id).catch(() => {});
          await renderOnDeviceRows();
          await refreshModels().catch(() => {});
        };
      } else if (verdict.verdict === "unsupported") {
        note.textContent = verdict.reason;
        btn.hidden = true;
      } else {
        const fail = odErrors.get(m.id);
        if (fail) {
          note.textContent = fail;
          note.classList.add("od-fail");
        } else {
          note.textContent =
            "~" + eng.fmtBytes(m.approxBytes) + " one-time download" +
            (verdict.verdict === "marginal" ? " — " + verdict.reason : "");
        }
        btn.textContent = fail ? "Retry download…" : "Download…";
        btn.onclick = () => odOpenConsent(m).catch(() => {});
      }
      row.append(label, note, btn);
      wrap.appendChild(row);
    }
  } catch (err) {
    // The engine's deadline errors NAME the failing stage (the on-device-
    // trace convention: this line is the remote debugger on a real phone) —
    // show them verbatim. textContent, never innerHTML: the message can
    // carry a worker error string.
    wrap.innerHTML = '<span class="muted setting-note"></span>';
    wrap.firstElementChild.textContent =
      err?.message || "The on-device engine failed to load — try reloading the page.";
  }
  renderOdTrace().catch(() => {});
}

// The visible, copyable engine trace (the on-device-trace method's overlay):
// rendered under the on-device rows whenever the debug switch is on
// (?oddebug=1 / dr_ondevice_debug) — phones have no console, so this pane IS
// the console. Crash lines are recorded by the engine even with the switch
// off, so turning it on after a failure still shows the tail that mattered.
let odTraceWired = false;
async function renderOdTrace() {
  const wrap = $("odtracewrap");
  if (state.onDevice !== true) {
    wrap.hidden = true;
    return;
  }
  const eng = await odEngine();
  if (!eng.onDeviceDebug?.()) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const pre = $("odtrace");
  pre.textContent = eng.onDeviceTrace().join("\n");
  if (!odTraceWired) {
    odTraceWired = true;
    eng.onDeviceTraceHook((line) => {
      pre.textContent += (pre.textContent ? "\n" : "") + line;
      pre.scrollTop = pre.scrollHeight;
    });
    $("odtracecopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("Se/cure build " + BUILD + "\n" + pre.textContent);
        $("odtracecopy").textContent = "Copied ✓";
        setTimeout(() => ($("odtracecopy").textContent = "Copy trace"), 1500);
      } catch {
        // Clipboard denied (http, permissions) — select the text so a manual
        // long-press copy still works.
        getSelection()?.selectAllChildren(pre);
      }
    });
  }
}

// The consent popup: states the EXACT one-time size (from the repo's live
// file listing — never a guess), where it's stored, and the free-space and
// connection context; only the size-labeled button downloads (UX-4:
// dismissing a consent dialog is a NO, never a YES).
async function odOpenConsent(m) {
  const eng = await odEngine();
  $("odc-title").textContent = "Download " + m.label + "?";
  $("odc-body").textContent = "Checking the exact size…";
  const yes = $("odc-yes");
  yes.disabled = true;
  yes.textContent = "Download";
  yes.onclick = null;
  $("odconsent").hidden = false;
  const plan = await eng
    .planModelDownload(m.id)
    .catch((err) => ({ published: false, reason: "engine", message: err?.message || "" }));
  if ($("odconsent").hidden) return; // dismissed while the listing loaded
  if (!plan?.published || !plan.totalBytes) {
    // Three different truths need three different messages: "not published"
    // is about the model, "couldn't reach" is about the connection, and an
    // engine failure (crash or deadline) is about this device — its message
    // names the failing stage.
    $("odc-body").textContent =
      plan?.reason === "network"
        ? "Couldn't reach huggingface.co to compute the download size — check your connection and try again. Nothing was downloaded."
        : plan?.reason === "engine"
          ? (plan.message || "The on-device engine failed.") + " Nothing was downloaded."
          : m.label + "'s browser build isn't published yet — this entry lights up the moment onnx-community ships it. Nothing was downloaded.";
    return;
  }
  const size = eng.fmtBytes(plan.totalBytes);
  let freeLine = "";
  try {
    const est = await navigator.storage.estimate();
    if (est?.quota) freeLine = " Free space available here: ~" + eng.fmtBytes(Math.max(0, est.quota - (est.usage || 0))) + ".";
  } catch {
    /* estimate unavailable — the line is optional */
  }
  const cellular = /** @type {any} */ (navigator).connection?.type === "cellular";
  $("odc-body").textContent =
    "This downloads the model ONCE (" + size + ") and stores it only on this device — delete it any time in Settings." +
    freeLine +
    (cellular ? " You appear to be on CELLULAR data — Wi-Fi is strongly recommended." : " Wi-Fi recommended.") +
    " After the download, this model answers with no network at all.";
  yes.textContent = "Download " + size;
  yes.disabled = false;
  yes.onclick = () => {
    $("odconsent").hidden = true;
    odRunDownload(m).catch(() => {});
  };
}

// The download itself (post-consent): worker-side fetch → streaming SHA-256
// → OPFS, resumable — a cancel or lost connection keeps the verified bytes
// and the next Download continues where it stopped.
async function odRunDownload(m) {
  const eng = await odEngine();
  odErrors.delete(m.id);
  odDownloading.add(m.id);
  await renderOnDeviceRows();
  let sawBytes = false;
  try {
    await eng.downloadModel(m.id, (p) => {
      sawBytes = sawBytes || p.loaded > 0;
      const el = document.querySelector('[data-od="' + m.id + '"] .od-note');
      if (el) el.textContent = "Downloading… " + p.pct + "% · " + eng.fmtBytes(p.loaded) + " of " + eng.fmtBytes(p.total);
    });
    workStatus(m.label + " is on this device — pick it in the model dropdown. Nothing you ask it will leave this browser.");
  } catch (err) {
    const raw = err?.message || "The download failed.";
    if (/cancel|abort/i.test(raw)) {
      // A user-initiated stop is not a failure — say what the Cancel kept.
      workStatus("Download stopped — verified parts are kept; Download again to resume.");
    } else {
      // The resume hint is true only once some bytes actually landed.
      const msg = raw + (sawBytes ? " Already-verified parts are kept — Download again to resume." : "");
      odErrors.set(m.id, msg);
      workStatus(msg);
    }
  } finally {
    odDownloading.delete(m.id);
    await renderOnDeviceRows();
    await refreshModels().catch(() => {});
  }
}

// The dropdown group: ONLY models already on this device — picking a model
// in the dropdown must never trigger a multi-GB surprise download; downloads
// live in Settings behind the consent popup.
async function odDropdownGroup(esc) {
  if (state.onDevice !== true) return "";
  try {
    const eng = await odEngine();
    const cached = (await eng.listCachedModels()).filter((c) => c.cachedBytes);
    if (!cached.length) return "";
    return (
      '<optgroup label="📱 On-device — nothing leaves this device">' +
      cached
        .map((c) => {
          const m = eng.onDeviceModel(c.id);
          return `<option value="${esc(ONDEVICE_ID + "::" + c.id)}">${esc(m?.label || c.id)}</option>`;
        })
        .join("") +
      "</optgroup>"
    );
  } catch {
    return ""; // engine unavailable — the dropdown just goes without
  }
}

// One grouped dropdown across the configured providers; option values are
// "provider::model" so the send knows where to route.
async function refreshModels() {
  const pick = $("model");
  const providers = configuredProviders();
  const proxyOn = apiProxyUsable();
  const stOn = stApiUsable();
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  // A downloaded on-device model is a configured provider in its own right —
  // a session with ONLY it (no key, no grant) still gets a working dropdown.
  const odGroup = await odDropdownGroup(esc);
  const poolOn = poolUsable();
  if (!providers.length && !proxyOn && !stOn && !odGroup && !poolOn) {
    pick.innerHTML = '<option value="">— add an API key first —</option>';
    return;
  }
  const groups = await Promise.all(
    providers.map(async (p) => {
      // The keyless local provider lists models from the user's OWN server (the
      // configured URL overrides the registry default); everyone else from
      // their key. An unreachable local server has no static fallback, so its
      // group says so instead of sitting silently empty.
      const ids = await listDrcModels(p, state.keys[p.id], p.keyless ? { baseUrl: localUrl() } : {});
      const opts = ids.length
        ? ids.map((id) => `<option value="${esc(p.id + "::" + id)}">${esc(id)}</option>`).join("")
        : p.keyless
          ? "<option disabled>— no local server answered —</option>"
          : "";
      return `<optgroup label="${esc(labelWithFlag(flagForProvider(p.id), p.label))}">` + opts + "</optgroup>";
    }),
  );
  // The SECURE-RESEARCH-SPACE provider (the account-connected LLM proxy), first
  // so a keyless borrowed session lands on it by default. Its "key" is the api
  // proxy token; its models are the Berget catalog the proxy forwards.
  if (proxyOn) {
    const pp = proxyLlmProvider(location.origin);
    let ids = [];
    try {
      ids = await listDrcModels(pp, proxyGrants.api.token);
    } catch {
      ids = [...pp.fallbackModels];
    }
    groups.unshift(
      `<optgroup label="🔒 Secure research space — connected">` +
        ids.map((id) => `<option value="${esc(pp.id + "::" + id)}">${esc(id)}</option>`).join("") +
        "</optgroup>",
    );
  }
  // SHARED COMPUTE (the pool): another user's machine, reached through the
  // blind relay on the pt1 token. Its catalog is whatever the sharer's local
  // server pulled; an empty list means no shared machine is online right now
  // (the row still shows, honestly, instead of vanishing).
  if (poolOn) {
    const gp = poolLlmProvider(location.origin);
    let ids = [];
    try {
      ids = await listDrcModels(gp, poolGrant.token);
    } catch {
      ids = [];
    }
    groups.unshift(
      `<optgroup label="🤝 Shared compute — another user's machine">` +
        (ids.length
          ? ids.map((id) => `<option value="${esc(gp.id + "::" + id)}">${esc(id)}</option>`).join("")
          : "<option disabled>— no shared machine online right now —</option>") +
        "</optgroup>",
    );
  }
  // The consolidated Se/rver TOKEN's LLM permission (one ticket, one JWT):
  // the same Berget reverse proxy, the JWT itself as the bearer. Unshifted
  // after the bundle group so it lands FIRST — the going-forward grant.
  if (stOn) {
    const sp = serverTokenLlmProvider(location.origin);
    let ids = [];
    try {
      ids = await listDrcModels(sp, stGrant.token);
    } catch {
      ids = [...sp.fallbackModels];
    }
    groups.unshift(
      `<optgroup label="🎫 Se/rver token — connected">` +
        ids.map((id) => `<option value="${esc(sp.id + "::" + id)}">${esc(id)}</option>`).join("") +
        "</optgroup>",
    );
  }
  // The ON-DEVICE group (downloaded models only) lands FIRST: the most
  // private option a session can hold outranks every borrowed/keyed one.
  if (odGroup) groups.unshift(odGroup);
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
  renderProviderNote();
}

// The standing "where your words go" line under the composer (drc-page-core's
// providerVisibilityNote): follows the model pick — the chosen provider can
// read the conversation, this site's server can't; a local model flips it to
// "nothing leaves this device". Hidden until a model is picked.
function renderProviderNote() {
  const note = $("provnote");
  if (!note) return;
  const [pid] = ($("model").value || "").split("::");
  const text = providerVisibilityNote(pid, drcProvider(pid)?.label);
  note.textContent = text;
  note.hidden = !text || text === provNoteDismissed;
  if (text !== provNoteDismissed) provNoteDismissed = "";
  updateNoticesClose();
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
      "Hi — I'm an AI research assistant that runs right here in your browser, on your own OpenAI, Groq " +
      "or Berget API key (or a local model you run yourself). My replies are model-generated, so verify " +
      "anything critical. Ask a research question to get started.";
    box.appendChild(empty);
    return;
  }
  const conv = activeConv();
  let prevUserText = "";
  messages.forEach((m, i) => {
    // A space-visual ask re-mounts its wireframe scene above the stored
    // answer (feedback #18) — deterministic re-detection from the question,
    // the same rule the live send path applies, so reloads keep the canvas.
    if (m.role === "assistant") mountDrcSpaceEmbed(box, prevUserText);
    if (m.role === "user") prevUserText = typeof m.content === "string" ? m.content : "";
    box.appendChild(messageEl(m.role, m.content, { conv, index: i }));
  });
  box.scrollTop = box.scrollHeight;
}

// A space-visual ask ("show a moonshot from space between earth and moon",
// "visa jorden och månen") mounts the /space/ archive's playable wireframe
// scene across the response area, above the answer text (feedback #18) — the
// Se/cure twin of the Se/rver app's turns.js mountSpaceEmbed. The renderer is
// dynamic-imported so the module graph only pays for it when a scene actually
// matches; it's a same-origin static asset, so the server stays out of the
// data path. Fail-soft: never breaks a message render.
function mountDrcSpaceEmbed(host, questionText, { before = null } = {}) {
  try {
    const m = spaceIntentMatch(questionText || "");
    if (!m) return;
    const box = document.createElement("div");
    box.className = "space-embed-host";
    if (before && before.parentNode) before.parentNode.insertBefore(box, before);
    else host.appendChild(box);
    import("/js/space-embed.js")
      .then(({ mountSpaceScene }) => {
        if (!mountSpaceScene(box, m.id, { lang: m.lang, caption: true, moreLink: true })) box.remove();
      })
      .catch(() => box.remove());
  } catch { /* decorative — never break the chat */ }
}

function messageEl(role, content, { conv, index } = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "assistant") {
    renderMarkdownInto(el, content);
    // Developer mode: inline-code repo paths open the file from the source
    // snapshot in a popover (source-peek.js; gated on state.developerMode).
    wireSourcePeek(el);
  } else el.textContent = content;
  // WORKSPACE KNOWLEDGE: while a shared-compute workspace token is present,
  // every stored assistant reply carries a 👍 — "pass this along to the
  // workspace" — opening the curation pane (±blocks, undo/redo) over it.
  if (role === "assistant" && conv && index != null && poolGrant && poolGrant.token) {
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "msg-thumb";
    up.textContent = "👍";
    up.title = "Pass this reply along to the secure workspace (curate first)";
    up.addEventListener("click", () => openCuration(conv, index));
    acts.appendChild(up);
    el.appendChild(acts);
  }
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

// ---- Se/cure feedback (the "feedback" keyword → confirm → send) ----------------
//
// Se/cure normally never contacts the server. But a message opening with the
// word "feedback" (feedbackIntent, EN+SV — the SAME gate the Se/rver pipeline
// uses, shared from feedback-core.js) is a report to the developers, not a
// research question. So instead of researching it we ECHO it, PROMPT for
// confirmation (UX-4: dismissing a consent dialog is a NO, never a YES), and
// only on an explicit Send do we POST it to /api/server-token/feedback over the
// SAME DeepResearch token used for LLM / Exa access (the token's write-only
// third exception to the SERVER-TOKEN GUARANTEE). No live token → we explain
// and open Settings. Nothing is ever sent silently.

// Any LIVE permission on the DeepResearch token is enough to send feedback —
// the per-send confirmation is the consent, so the token's research on/off
// toggle doesn't gate this separate, explicit action.
function feedbackTokenLive() {
  return !!(stGrant && stGrant.token) && (serverTokenLive(stGrant, "web") || serverTokenLive(stGrant, "api"));
}

// drcFeedbackContext (the prior-turn question/answer the feedback comments
// on) lives in drc-page-core.js with the other pure page fragments.

// A transient note bubble — same footing as the canned-help exchange: it echoes
// in the DOM but never enters conv.messages (feedback is not a research turn).
function renderFeedbackNote(text) {
  const box = $("chat");
  const el = document.createElement("div");
  el.className = "msg assistant canned";
  const badge = document.createElement("div");
  badge.className = "canned-label";
  badge.textContent = "📨 Feedback";
  el.appendChild(badge);
  const body = document.createElement("div");
  body.textContent = text;
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// The feedback entry point (called from send() before any research routing).
function startFeedback(text) {
  const box = $("chat");
  box.querySelector(".empty")?.remove();
  box.appendChild(messageEl("user", text));
  $("input").value = "";
  box.scrollTop = box.scrollHeight;

  if (!feedbackTokenLive()) {
    renderFeedbackNote(
      "To send feedback from Se/cure, connect a DeepResearch token — the same token you use for web search or the LLM API. " +
        "It's the one deliberate, confirmed exception where Se/cure contacts the server. Opening Settings so you can add one…",
    );
    openSettings();
    $("strow")?.scrollIntoView({ block: "center" });
    return;
  }
  // SCOPE (feedback-core feedbackScopeOfPrior — the SAME classification the
  // Se/rver pipeline applies): feedback typed into an empty chat is generic
  // developer feedback, a suggestion, not a report about a session. Se/cure
  // never enters the feedback text into the conversation, so the conv's
  // messages ARE the prior turns.
  const conv = activeConv();
  openFeedbackConsent(text, drcFeedbackContext(conv), feedbackScopeOfPrior(conv && conv.messages));
}

// The confirmation dialog (#fbconsent): states EXACTLY what leaves the browser
// and over which credential; only the labeled Send button transmits.
function openFeedbackConsent(text, ctx, scope) {
  const hasContext = !!(ctx.question || ctx.answer_excerpt);
  $("fbc-body").textContent =
    "Se/cure normally never contacts the server. Sending feedback is one of the few confirmed exceptions: your message" +
    (hasContext ? ", plus the previous question and answer for context," : "") +
    " goes to deepresearch.se over your DeepResearch token (the same token used for web search / LLM access). " +
    "Nothing else — no other conversation, no files, no identity — is sent." +
    // A first-message note is filed as a general suggestion; say so, since the
    // developers will read it without any session behind it.
    (scope === "standalone"
      ? " This chat is empty, so it goes as a general suggestion — your message and nothing more."
      : "");
  const yes = $("fbc-yes");
  const no = $("fbc-no");
  const close = () => {
    $("fbconsent").hidden = true;
    yes.onclick = null;
    no.onclick = null;
  };
  no.onclick = () => {
    close();
    renderFeedbackNote("Not sent — nothing left your browser.");
  };
  yes.onclick = async () => {
    close();
    await submitFeedback(text, ctx, scope);
  };
  $("fbconsent").hidden = false;
}

// The one transmission: POST the confirmed feedback with the DeepResearch token
// as bearer. Fail-soft — every failure becomes a plain-language note, never an
// error wall.
async function submitFeedback(text, ctx, scope) {
  const model = $("model").value || "";
  try {
    const res = await fetch("/api/server-token/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: stGrant.token,
        comment: text,
        question: ctx.question || undefined,
        answer_excerpt: ctx.answer_excerpt || undefined,
        model: model || undefined,
        // "se/cure" or "se/cure/standalone" — the scope tag the Se/rver queue
        // reads (feedback-core feedbackPageTag).
        page: feedbackPageTag("se/cure", scope),
      }),
    });
    if (res.ok) {
      renderFeedbackNote("✓ Sent to the developers — thank you. They read every one.");
      return;
    }
    if (res.status === 403) {
      renderFeedbackNote(
        "Couldn't send: your DeepResearch token is invalid or expired. Reconnect it under Settings and try again.",
      );
      return;
    }
    const data = await res.json().catch(() => null);
    renderFeedbackNote(
      "Couldn't send your feedback" + (data && data.error ? ": " + data.error : " — please try again in a moment."),
    );
  } catch {
    renderFeedbackNote("Couldn't reach the server to send your feedback — check your connection and try again.");
  }
}

function newChat() {
  convId = null;
  renderConvPicker();
  renderMessages();
  closeDrawer();
}

// ---- client-side RAG (drc-rag.js): recall before the pipeline, index after ------------

// The embedding hookup for client-side RAG. Two ways to get one:
//   1. A stored OWN key that serves embeddings (OpenAI today — Groq has none).
//   2. A borrowed `api` grant on the proxy / Se/rver-token provider — the
//      SAME grant that lends completions now proxies /embeddings to Berget's
//      e5 model on the server key (owner directive, 2026-07-17), so a keyless
//      borrowed workspace runs the same RAG the signed-in tier does. This
//      engages only while that borrowed provider is the SELECTED model, so a
//      borrowed grant isn't silently spent when the user is on their own key.
// Returns null otherwise: every caller degrades to the plain recent-turns
// context, silently (RAG is a helper, never a reason a send breaks).
function embedHookup() {
  const own = drcEmbedProvider(state.keys);
  if (own) {
    return {
      embedder: { provider: own.id, model: own.embed.model, dims: own.embed.dimensions },
      embed: async (texts, kind) => (await drcEmbed(own, state.keys[own.id], texts, { kind })).vectors,
    };
  }
  const [pid] = ($("model").value || "").split("::");
  if (pid === SERVER_TOKEN_LLM_PROVIDER_ID && stApiUsable() && stGrant?.token) {
    return borrowedEmbedHookup(serverTokenLlmProvider(location.origin), stGrant.token);
  }
  if (pid === PROXY_LLM_PROVIDER_ID && apiProxyUsable() && proxyGrants.api?.token) {
    return borrowedEmbedHookup(proxyLlmProvider(location.origin), proxyGrants.api.token);
  }
  return null;
}

// The borrowed-grant embedder: embed through the same-origin server proxy on
// the `api` grant token (Berget e5, 1024-dim; the e5 passage:/query: prefix is
// applied by drcEmbed via `kind`).
function borrowedEmbedHookup(prov, token) {
  return {
    embedder: { provider: prov.id, model: prov.embed.model, dims: prov.embed.dimensions },
    embed: async (texts, kind) => (await drcEmbed(prov, token, texts, { kind })).vectors,
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
    phaseStep("recall", "Recalling project context…");
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

// The HELP documentation corpus (the docs-first layer of help mode), fetched
// once per page load as a PUBLIC static file — the server stays in no data
// path. Same self-contained arrangement as the OWASP corpus: retrieval is the
// embedding-free lexical path (no Berget e5 in the browser). Fail-soft: any
// problem → no docs block, and the prompt-level guidance still holds.
let docsCorpusCache = null;
async function loadDocsCorpusOnce() {
  if (!docsCorpusCache) {
    docsCorpusCache = fetch(DOCS_CORPUS_PATH)
      .then(async (res) => {
        if (!res.ok) return null;
        const raw = await res.json();
        const snapshot = validateSnapshot(raw);
        return snapshot ? { snapshot, meta: docsCorpusMeta(raw) } : null;
      })
      .catch(() => null);
  }
  return docsCorpusCache;
}

// Build the help documentation block: always on in dev mode (the same
// no-brittle-gate rule as the source injection); a help-shaped ask (helpIntent,
// sticky over the conversation) widens the retrieval. "" when the corpus is
// unavailable or nothing matches.
async function helpDocsBlockFor(texts, latestText) {
  const corpus = await loadDocsCorpusOnce();
  if (!corpus) return "";
  const helpAsk = texts.some((t) => helpIntent(t));
  const hits = lexicalRetrieveCorpus(corpus.snapshot, latestText, { k: helpAsk ? 8 : 4, perCat: 2 });
  return buildHelpDocsBlock(hits, {
    sources: corpus.meta.sources,
    symbols: corpus.meta.symbols,
    repo: corpus.meta.repo,
    helpAsk,
  });
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
    phaseStep("introspect", "Reading the site's own source…");
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
    // HELP layer: the documentation passages relevant to this question (the
    // docs-first layer of help mode — retrieved OFFLINE via lexical TF-IDF over
    // the committed docs corpus), with symbol references resolved to the source.
    const helpDocs = await helpDocsBlockFor(texts, latestText);
    if (helpDocs) block += helpDocs;
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

// ---- server-proxied web search (the temporary grant) --------------------------------
//
// Se/cure is normally server-less. But a SIGNED-IN Se/rver user who crosses over
// via the ghost button can be handed a short-lived, quota-metered token
// (src/websearch.js): it lets THIS session run a bounded number of LIVE web
// searches through the server's Exa key — e.g. to get fresh web results while
// running your own (local) model. This is the ONE place Se/cure touches the
// server in a data path, and it is opt-in and bounded: only a search QUERY ever
// leaves (never the conversation), it is off for anyone who did not cross over
// signed-in (no grant), and the toggle here turns it off. The grant is stored in
// this browser's localStorage (a temporary credential, not part of the sealed
// project state), so it survives a reload within the session.
const WS_INTENT_KEY = "dr_ws_grant_intent"; // the DRS ghost button sets this before navigating here
const WS_GRANT_KEY = "dr_ws_grant"; // { token, quota, used, remaining, expiresAt }
const WS_ENABLED_KEY = "dr_ws_enabled"; // "1"/"0" — the user's per-browser toggle

let wsGrant = readJson(WS_GRANT_KEY);

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function wsGrantActive() {
  return grantLive(wsGrant); // drc-page-core.js: the shared liveness check
}
function wsEnabled() {
  return grantFlagEnabled(localStorage.getItem(WS_ENABLED_KEY)); // default ON when a grant is present
}

// Populates the web-search grant from either a SHARED LINK (/cure?ws=<token>,
// admin-minted — src/websearch.js) or the ghost-crossover INTENT marker. A
// plain visitor with neither never pings the server. Fail-soft throughout.
async function maybeRequestWsGrant() {
  // 1) A shared link carries a grant token directly. Read its live status
  //    (non-consuming), store it, and strip the token from the URL so it isn't
  //    left in history/referrer.
  let linkToken = "";
  try {
    linkToken = new URLSearchParams(location.search).get("ws") || "";
  } catch {
    /* no search params */
  }
  if (linkToken) {
    try {
      const res = await fetch("/api/websearch/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: linkToken }),
      });
      if (res.ok) {
        wsGrant = await res.json();
        persistWsGrant();
      }
    } catch {
      /* invalid/expired link — no server web search */
    }
    try {
      const u = new URL(location.href);
      u.searchParams.delete("ws");
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    } catch {
      /* history API blocked — harmless */
    }
    renderWsRow();
    return;
  }

  // 2) The ghost-crossover intent marker.
  let intent = false;
  try {
    intent = localStorage.getItem(WS_INTENT_KEY) === "1";
    if (intent) localStorage.removeItem(WS_INTENT_KEY);
  } catch {
    /* storage blocked — treat as no intent */
  }
  if (intent) {
    try {
      const res = await fetch("/api/websearch/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        wsGrant = await res.json();
        try {
          localStorage.setItem(WS_GRANT_KEY, JSON.stringify(wsGrant));
        } catch {
          /* ignore quota */
        }
      }
    } catch {
      /* offline / not signed in — no server web search this session */
    }
  } else if (wsGrant && !wsGrantActive()) {
    // A stored grant that has expired or been used up: forget it.
    wsGrant = null;
    try {
      localStorage.removeItem(WS_GRANT_KEY);
    } catch {
      /* ignore */
    }
  }
  renderWsRow();
}

// The webSearch fn handed to runDrcResearch. Fail-soft: quota exhausted (429),
// any error, or the toggle off → null, and the pipeline falls back to the
// offline harvest. Keeps `remaining` fresh from each server response.
async function drcServerWebSearch(query) {
  // Source priority: (1) the consolidated Se/rver token's web permission
  // ("one ticket, one JWT" — the preferred, going-forward path), (2) the
  // secure-research-space WEB proxy, (3) the legacy web-search grant. All
  // fail-soft — any problem returns null and the pipeline uses the offline
  // harvest instead.
  if (stWebUsable()) {
    try {
      const res = await fetch("/api/server-token/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: stGrant.token, query }),
      });
      if (res.status === 429) {
        setStRemaining("web", 0);
        return null;
      }
      if (res.ok) {
        const data = await res.json();
        if (typeof data.remaining === "number") setStRemaining("web", data.remaining);
        return Array.isArray(data.items) && data.items.length
          ? { items: data.items, content: data.content, sources: data.sources, resultCount: data.resultCount }
          : null;
      }
    } catch {
      /* fail-soft — the offline harvest takes over */
    }
    return null;
  }
  if (webProxyUsable()) {
    try {
      const res = await fetch("/api/proxy/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: proxyGrants.web.token, query }),
      });
      if (res.status === 429) {
        proxyGrants.web.remaining = 0;
        persistProxyGrants();
        renderProxyRow();
        return null;
      }
      if (res.ok) {
        const data = await res.json();
        if (typeof data.remaining === "number") {
          proxyGrants.web.remaining = data.remaining;
          persistProxyGrants();
          renderProxyRow();
        }
        return Array.isArray(data.items) && data.items.length
          ? { items: data.items, content: data.content, sources: data.sources, resultCount: data.resultCount }
          : null;
      }
    } catch {
      // fall through to the legacy grant below
    }
    return null;
  }
  if (!wsGrantActive() || !wsEnabled()) return null;
  try {
    const res = await fetch("/api/websearch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: wsGrant.token, query }),
    });
    if (res.status === 429) {
      wsGrant.remaining = 0;
      persistWsGrant();
      renderWsRow();
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.remaining === "number") {
      wsGrant.remaining = data.remaining;
      persistWsGrant();
      renderWsRow();
    }
    return Array.isArray(data.items) && data.items.length
      ? { items: data.items, content: data.content, sources: data.sources, resultCount: data.resultCount }
      : null;
  } catch {
    return null;
  }
}

function persistWsGrant() {
  try {
    if (wsGrant) localStorage.setItem(WS_GRANT_KEY, JSON.stringify(wsGrant));
  } catch {
    /* ignore */
  }
}

// Reflects the grant into the settings row: shown only when a grant exists, the
// remaining count and toggle state kept live.
function renderWsRow() {
  const row = $("wsrow");
  if (!row) return;
  const has = !!(wsGrant && wsGrant.token);
  row.hidden = !has;
  if (!has) return;
  const toggle = /** @type {HTMLInputElement} */ ($("websearchserver"));
  const active = wsGrantActive();
  toggle.checked = wsEnabled() && active;
  toggle.disabled = !active;
  const remaining = wsGrant.remaining == null ? wsGrant.quota : wsGrant.remaining;
  $("wsstatus").textContent = !active
    ? "This session's web-search allowance is used up (or expired)."
    : (wsEnabled() ? "On" : "Off") + " — " + remaining + " of " + wsGrant.quota + " server web searches left this session.";
}

// ---- the consolidated Se/rver TOKEN ("one ticket, one JWT") --------------------------
//
// The CONSOLIDATED grant (src/server-token.js + src/server-grants.js,
// docs/SERVER-TOKENS.md): ONE JWT carrying a PERMISSION SET over the site's
// UPSTREAM APIs — `web` (metered Exa searches, query-only) and `api` (metered
// LLM completions on the server's Berget key). THE SERVER-TOKEN GUARANTEE:
// the token only ever opens doors that lead OUT of the site — it can never
// read any Se/rver data (no projects, no chats), and it is never a login.
// Arrives via a shared `…/cure?st=<jwt>` link (admin-minted) or the ghost
// crossover — which now asks for the consolidated token FIRST, leaving the
// intent marker in place for the legacy web-search grant if that fails (an
// older deploy, offline). Stored in localStorage like the legacy grants (a
// temporary credential, not part of the sealed project state).
const ST_GRANT_KEY = "dr_st_grant"; // { token, perms, services: [{svc,quota,used,remaining}], expiresAt }
const ST_ENABLED_KEY = "dr_st_enabled"; // "1"/"0" — the master toggle

let stGrant = readJson(ST_GRANT_KEY);

function stEnabled() {
  return grantFlagEnabled(localStorage.getItem(ST_ENABLED_KEY)); // default ON while a token is present
}
function stWebUsable() {
  return serverTokenLive(stGrant, "web") && stEnabled(); // drc-page-core.js: per-permission liveness
}
function stApiUsable() {
  return serverTokenLive(stGrant, "api") && stEnabled();
}
function persistStGrant() {
  try {
    if (stGrant && stGrant.token) localStorage.setItem(ST_GRANT_KEY, JSON.stringify(stGrant));
    else localStorage.removeItem(ST_GRANT_KEY);
  } catch {
    /* storage blocked — the token just won't survive a reload */
  }
}
function setStRemaining(svc, remaining) {
  const s = serverTokenService(stGrant, svc);
  if (!s) return;
  s.remaining = remaining;
  persistStGrant();
  renderStRow();
}

// Non-consuming status read (POST /api/server-token/status) → the stored shape.
async function fetchStStatus(token) {
  const res = await fetch("/api/server-token/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return null;
  const v = await res.json();
  return { token, perms: v.perms, services: v.services, expiresAt: v.expiresAt };
}

// Populates the Se/rver token from either a SHARED LINK (/cure?st=<jwt>) or
// the ghost-crossover INTENT marker. The intent is only PEEKED here — it is
// consumed on success and left in place otherwise, so the legacy web-search
// grant request that runs after this can still serve it (fallback against an
// older deploy). A plain visitor with neither never pings the server.
// Fail-soft throughout; returns true when a token connected.
async function maybeRequestServerToken() {
  let linkToken = "";
  try {
    linkToken = new URLSearchParams(location.search).get("st") || "";
  } catch {
    /* no search params */
  }
  if (linkToken) {
    try {
      const v = await fetchStStatus(linkToken);
      if (v) {
        stGrant = v;
        persistStGrant();
      }
    } catch {
      /* invalid/expired/revoked link — nothing borrowed */
    }
    // Strip the token from the URL so it isn't left in history/referrer.
    try {
      const u = new URL(location.href);
      u.searchParams.delete("st");
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    } catch {
      /* history API blocked — harmless */
    }
    if (stGrant && stGrant.token) {
      if (stApiUsable()) await refreshModels().catch(() => {});
      announceStConnected();
    }
    renderStRow();
    return !!(stGrant && stGrant.token);
  }

  let intent = false;
  try {
    intent = localStorage.getItem(WS_INTENT_KEY) === "1";
  } catch {
    /* storage blocked — treat as no intent */
  }
  if (intent) {
    try {
      const res = await fetch("/api/server-token/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const v = await res.json();
        stGrant = { token: v.token, perms: v.perms, services: v.services, expiresAt: v.expiresAt };
        persistStGrant();
        try {
          localStorage.removeItem(WS_INTENT_KEY); // consumed — the legacy path stands down
        } catch {
          /* ignore */
        }
        if (stApiUsable()) await refreshModels().catch(() => {});
        announceStConnected();
        renderStRow();
        return true;
      }
    } catch {
      /* offline / not signed in — the legacy grant path follows */
    }
    return false;
  }

  if (stGrant && !serverTokenLive(stGrant, "web") && !serverTokenLive(stGrant, "api")) {
    // A stored token with nothing left on any permission (or expired): forget it.
    stGrant = null;
    persistStGrant();
  }
  renderStRow();
  return false;
}

// The prominent "which APIs are connected" notice — the same disclosure
// requirement (and banner element) as the proxy bundle.
function announceStConnected() {
  const parts = [];
  if (serverTokenLive(stGrant, "web")) parts.push("🔎 Web search");
  if (serverTokenLive(stGrant, "api")) parts.push("🤖 LLM API (Berget)");
  if (!parts.length) return;
  const banner = $("proxybanner");
  if (banner) {
    $("proxybannertext").innerHTML = wmHtml(
      "<b>Se/rver token connected.</b> One ticket, one JWT — this session borrowed: " +
        parts.join(" + ") +
        ". Upstream APIs only (the token can never read any Se/rver data); the LLM API routes your messages through the server. Manage it under ⚙ Settings.",
    );
    banner.hidden = false;
  }
  workStatus(
    "Se/rver token connected — " +
      parts.join(" + ") +
      ". Bounded, temporary, upstream-only. (The LLM API routes your conversation through the server; turn it off under Settings to stay client-side.)",
  );
}

// Reflects the token into its settings row: per-permission remaining + the
// master toggle. One permission running dry never hides the other.
function renderStRow() {
  const row = $("strow");
  if (!row) return;
  const has = !!(stGrant && stGrant.token);
  row.hidden = !has;
  if (!has) return;
  const toggle = /** @type {HTMLInputElement} */ ($("stenabled"));
  const anyLive = serverTokenLive(stGrant, "web") || serverTokenLive(stGrant, "api");
  toggle.checked = stEnabled() && anyLive;
  toggle.disabled = !anyLive;
  const line = (label, svc) => {
    const s = serverTokenService(stGrant, svc);
    return s ? grantMeterLine(label, s, serverTokenLive(stGrant, svc)) : null;
  };
  const bits = [line("🔎 Web search", "web"), line("🤖 LLM API (Berget)", "api")].filter(Boolean);
  $("ststatus").textContent = !anyLive
    ? "This token's allowances are used up (or expired)."
    : (stEnabled() ? "On" : "Off") + " — " + bits.join(" · ");
}

// ---- web search SERVICE: the expert, browser-direct backend --------------------------
//
// Se/cure is the expert tier, so it can point live web search at the user's OWN
// self-hosted service (SearXNG or an Exa-compatible endpoint), called STRAIGHT
// from this browser — no query touches Deepresearch's server (stronger than the
// server grant, which routes through the server's Exa key). The config (URL +
// optional key + results) lives inside the sealed project state, like the
// provider keys. The service must send CORS headers to be reachable from here.
// Fail-soft: a misconfigured/unreachable service returns null and the pipeline
// degrades to the offline harvest (or the server grant, if that's selected).

function searchBackendCfg() {
  return normalizeSearchBackend(state && state.searchBackend); // drc-page-core.js
}

// True when a browser-direct self-hosted backend is configured AND usable.
function directSearchActive() {
  const c = searchBackendCfg();
  return (c.backend === "searxng" || c.backend === "exa_compatible") && !!c.baseUrl;
}

// The webSearch fn handed to runDrcResearch for the direct path. Same {items,…}
// shape drcServerWebSearch returns, so the pipeline consumes it identically.
async function drcDirectWebSearch(query) {
  const c = searchBackendCfg();
  try {
    const r = await runDirectBackendSearch(console, c, query, { numResults: c.results });
    return r && Array.isArray(r.items) && r.items.length ? r : null;
  } catch {
    return null; // fail-soft: a lost search, not a lost answer
  }
}

// Reflects the sealed backend config into the settings section and wires edits.
function renderSearchBackend() {
  const sel = /** @type {HTMLSelectElement} */ ($("ws-backend"));
  if (!sel) return;
  const c = searchBackendCfg();
  sel.value = c.backend;
  const direct = $("ws-direct");
  const urlEl = /** @type {HTMLInputElement} */ ($("ws-url"));
  const keyEl = /** @type {HTMLInputElement} */ ($("ws-key"));
  const resEl = /** @type {HTMLInputElement} */ ($("ws-results"));
  urlEl.value = c.baseUrl;
  keyEl.value = c.key;
  resEl.value = String(c.results);
  const isDirect = c.backend === "searxng" || c.backend === "exa_compatible";
  direct.hidden = !isDirect;
  const status = $("ws-svc-status");
  status.textContent = !isDirect
    ? ""
    : c.baseUrl
      ? "Web search will call your " + (c.backend === "searxng" ? "SearXNG instance" : "service") + " directly from this browser."
      : "Enter your service URL to enable browser-direct web search.";

  // Save on any change (guarded so we only bind once per open — the elements
  // persist across opens, so use onchange assignment, not addEventListener).
  const persist = async () => {
    state.searchBackend = normalizeSearchBackend({
      backend: sel.value,
      baseUrl: urlEl.value,
      key: keyEl.value,
      results: resEl.value,
    });
    renderSearchBackend();
    // Configuring (or clearing) a browser-direct backend changes whether web
    // search is reachable — keep the knob honest about it.
    reflectResearchKnob();
    await saveState();
  };
  sel.onchange = persist;
  urlEl.onchange = persist;
  keyEl.onchange = persist;
  resEl.onchange = persist;
}

// ---- secure research space: the account-connected proxy BUNDLE ----------------------
//
// The richer sibling of the web-search grant above (src/proxy.js). A signed-in
// Se/rver user crossing over via the ghost — or an admin-minted shareable link —
// hands this browser a BUNDLE of temporary, account-connected proxy grants, one
// per service:
//   • web → proxied Exa web search (query only leaves, like the grant above)
//   • api → proxied LLM completions through the server's Berget key (this one
//           DOES route the conversation through the server — opt-in, bounded,
//           and disclosed to the user; it's what makes a keyless session able to
//           actually research)
// The bundle arrives ENCRYPTED: ciphertext in the URL query (?rp=), decryption
// key in the URL ANCHOR (#rk=, never sent to any server). We open it, EXCHANGE
// each "token-granting token" for a working PROXY TOKEN (kept out of the URL),
// and store the proxy tokens in localStorage (temporary credentials, not part of
// the sealed project state). The user is told CLEARLY which APIs are connected.
const PROXY_WEB_KEY = "dr_proxy_web"; // { token, quota, remaining, expiresAt }
const PROXY_API_KEY = "dr_proxy_api"; // { token, quota, remaining, expiresAt }
const PROXY_ENABLED_KEY = "dr_proxy_enabled"; // "1"/"0" — the master toggle
// The re-shareable GRANT tokens ({ web?, api? } — prg1.…, the tokens that
// travel in URLs), kept so a secure workspace built here can pass its
// borrowed allowances on. Working proxy tokens above never enter a link.
const PROXY_GRANT_TOKENS_KEY = "dr_proxy_grant_tokens";

const proxyGrants = { web: readJson(PROXY_WEB_KEY), api: readJson(PROXY_API_KEY) };

function proxyLive(p) {
  return grantLive(p); // drc-page-core.js: the shared liveness check (same shape as wsGrant)
}
function proxyEnabled() {
  return grantFlagEnabled(localStorage.getItem(PROXY_ENABLED_KEY)); // default ON while a bundle is present
}
function webProxyUsable() {
  return proxyLive(proxyGrants.web) && proxyEnabled();
}
function apiProxyUsable() {
  return proxyLive(proxyGrants.api) && proxyEnabled();
}
function anyProxyPresent() {
  return !!((proxyGrants.web && proxyGrants.web.token) || (proxyGrants.api && proxyGrants.api.token));
}
function persistProxyGrants() {
  try {
    for (const [svc, key] of [["web", PROXY_WEB_KEY], ["api", PROXY_API_KEY]]) {
      if (proxyGrants[svc] && proxyGrants[svc].token) localStorage.setItem(key, JSON.stringify(proxyGrants[svc]));
      else localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked — the grants just won't survive a reload */
  }
}

// Exchange a list of { svc, token } GRANT tokens ("token-granting tokens",
// prg1.…) for working proxy tokens — the shared connector behind BOTH arrival
// paths: the encrypted ?rp=/#rk= bundle and a secure workspace's embedded
// grants (workspace-core.js). The GRANT tokens are kept too (they are the
// URL-safe, re-shareable form — exchanging is non-consuming and idempotent),
// so this session can re-package its borrowed allowances into a workspace
// link of its own. Fail-soft per service; true when anything connected.
async function connectProxyGrants(grantsList) {
  let opened = false;
  const grantTokens = readJson(PROXY_GRANT_TOKENS_KEY) || {};
  for (const g of grantsList || []) {
    try {
      const res = await fetch("/api/proxy/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: g.token }),
      });
      if (!res.ok) continue;
      const v = await res.json(); // { svc, proxyToken, quota, used, remaining, expiresAt }
      if (v.svc !== "web" && v.svc !== "api") continue;
      proxyGrants[v.svc] = {
        token: v.proxyToken,
        quota: v.quota,
        remaining: typeof v.remaining === "number" ? v.remaining : v.quota,
        expiresAt: v.expiresAt,
      };
      grantTokens[v.svc] = g.token;
      opened = true;
    } catch {
      /* one service failed to exchange — keep any others */
    }
  }
  if (opened) {
    persistProxyGrants();
    try {
      localStorage.setItem(PROXY_GRANT_TOKENS_KEY, JSON.stringify(grantTokens));
      localStorage.setItem(PROXY_ENABLED_KEY, "1");
    } catch {
      /* ignore */
    }
  }
  return opened;
}

// Reads an encrypted bundle from THIS page's own URL (ciphertext `?rp=`, key
// `#rk=`), decrypts it locally, and exchanges each grant token for its working
// proxy token. Then strips both from the URL so no token lingers in history or a
// referrer. Fail-soft throughout: any problem simply means no borrowed space.
async function maybeOpenProxyBundle() {
  let blob = "";
  let key = "";
  try {
    blob = new URLSearchParams(location.search).get("rp") || "";
  } catch {
    /* no search params */
  }
  try {
    key = new URLSearchParams(location.hash.replace(/^#/, "")).get("rk") || "";
  } catch {
    /* no hash */
  }
  if (!blob || !key) return false;

  let opened = false;
  try {
    const bundle = await openBundle(blob, key);
    if (bundle && validateBundle(bundle)) {
      opened = await connectProxyGrants(bundle.grants);
    }
  } catch {
    /* bad bundle — nothing borrowed */
  }

  // Always strip the ciphertext + key from the address bar (dropping the hash
  // by rebuilding the URL without it).
  try {
    const u = new URL(location.href);
    u.searchParams.delete("rp");
    history.replaceState(null, "", u.pathname + (u.search || ""));
  } catch {
    /* history API blocked — harmless */
  }

  if (opened) {
    if (configuredProviders().length || apiProxyUsable() || stApiUsable()) await refreshModels().catch(() => {});
    announceProxyConnected();
    renderProxyRow();
  }
  return opened;
}

// The prominent "which APIs are connected" notice — the owner's explicit
// requirement. Names each connected service and where the allowance came from.
function announceProxyConnected() {
  const parts = [];
  if (proxyGrants.web && proxyGrants.web.token) parts.push("🔎 Web search");
  if (proxyGrants.api && proxyGrants.api.token) parts.push("🤖 LLM API (Berget)");
  if (!parts.length) return;
  const banner = $("proxybanner");
  if (banner) {
    // wmHtml escapes <> (it renders prose, not markup) — the <b> wrapper must
    // be added AROUND the escaped text, never inside the string it escapes.
    $("proxybannertext").innerHTML =
      "<b>" +
      wmHtml("Secure research space connected.") +
      "</b> " +
      wmHtml(
        "A Se/rver account lent this session: " +
          parts.join(" + ") +
          ". Bounded & temporary — the LLM API routes your messages through the server; manage it under ⚙ Settings.",
      );
    banner.hidden = false;
  }
  workStatus(
    "Secure research space connected — " +
      parts.join(" + ") +
      ". You can research right away, no key needed. (The LLM API routes your conversation through the server; turn it off under Settings to stay client-side.)",
  );
}

// Reflects the bundle into the settings row: which APIs are connected, remaining
// counts, and the master on/off toggle.
function renderProxyRow() {
  const row = $("proxyrow");
  if (!row) return;
  row.hidden = !anyProxyPresent();
  if (row.hidden) return;
  const toggle = /** @type {HTMLInputElement} */ ($("proxyenabled"));
  const on = proxyEnabled();
  toggle.checked = on;
  const line = (label, p) => (p && p.token ? grantMeterLine(label, p, proxyLive(p)) : null);
  const bits = [line("🔎 Web search", proxyGrants.web), line("🤖 LLM API (Berget)", proxyGrants.api)].filter(Boolean);
  $("proxystatus").textContent =
    (on ? "Connected — " : "Off (fully client-side) — ") + bits.join(" · ");
}

// ---- SHARED COMPUTE (the pool): peer compute + workspace knowledge ---------------------
//
// Two halves, both scoped to secure workspaces (docs/COMPUTE-SHARING.md):
//   CONSUMING — a pt1 POOL TOKEN (from a workspace's grants.pool or a ?pt=
//   link) puts "Shared compute" in the model dropdown: completions run on the
//   pool owner's machine (often their localhost Ollama), relayed by the
//   server's blind job queue under the strict DRSC/1 wire. The data-flow
//   notice (pool-core.js) is shown to EVERY participant on arrival.
//   PROVIDING — a signed-in sharer flips "Share my compute" on the local-
//   model row: this tab long-polls for jobs and runs them locally
//   (pool-provider.js). Oversight (who used it, block, revoke) lives in the
//   sharer's Se/rver panel.
// Plus WORKSPACE KNOWLEDGE: 👍 on any reply opens the curation pane
// (±blocks, undo/redo — knowledge-core.js) and passes the sealed conclusion
// to the workspace owner (server inbox by default, a .drskn download as the
// out-of-band migration path).

const POOL_GRANT_KEY = "dr_pool_grant"; // { token, pool, quota, used, remaining, expiresAt }
const POOL_ENABLED_KEY = "dr_pool_enabled"; // "1"/"0" — the consumer master toggle
const POOL_SHARE_KEY = "dr_pool_share"; // "1" — the sharer's own toggle (auto-resumes)

let poolGrant = readJson(POOL_GRANT_KEY);

function poolEnabled() {
  return grantFlagEnabled(localStorage.getItem(POOL_ENABLED_KEY));
}
function poolUsable() {
  return grantLive(poolGrant) && poolEnabled();
}
function persistPoolGrant() {
  try {
    if (poolGrant && poolGrant.token) localStorage.setItem(POOL_GRANT_KEY, JSON.stringify(poolGrant));
    else localStorage.removeItem(POOL_GRANT_KEY);
  } catch {
    /* storage blocked — the grant just won't survive a reload */
  }
}

// Connect a pool token through the non-consuming status read (the same
// fail-soft intake shape as the other grant families). True when it verified.
async function connectPoolGrant(token) {
  if (!token) return false;
  try {
    const res = await fetch("/api/pool/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const v = await res.json(); // { jti, pool, quota, used, remaining, expiresAt }
    poolGrant = { token, pool: v.pool, quota: v.quota, used: v.used, remaining: v.remaining, expiresAt: v.expiresAt };
    persistPoolGrant();
    try {
      localStorage.setItem(POOL_ENABLED_KEY, "1");
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

// A ?pt=<pool token> arrival (the sharer's dashboard mints these links).
// Connect, strip the token from the URL, surface the row + the notice.
async function maybeOpenPoolToken() {
  let token = "";
  try {
    token = new URLSearchParams(location.search).get("pt") || "";
  } catch {
    /* no search params */
  }
  if (!token) return false;
  const opened = await connectPoolGrant(token);
  try {
    const u = new URL(location.href);
    u.searchParams.delete("pt");
    history.replaceState(null, "", u.pathname + (u.search || "") + (u.hash || ""));
  } catch {
    /* history API blocked — harmless */
  }
  if (opened) {
    renderPoolRow();
    await refreshModels().catch(() => {});
    workStatus(
      "Shared compute connected — another user's machine will answer for the shared models. " +
        "Read how your prompts travel under the (i) on the wordmark before using it.",
    );
    showPrivacyNotice();
  }
  return opened;
}

// The settings row: connected state + meter + the master toggle.
function renderPoolRow() {
  const row = $("poolrow");
  if (!row) return;
  row.hidden = !(poolGrant && poolGrant.token);
  if (row.hidden) return;
  /** @type {HTMLInputElement} */ ($("poolenabled")).checked = poolEnabled();
  const live = grantLive(poolGrant);
  const meter =
    poolGrant.remaining == null
      ? "unmetered (counted by the owner)"
      : poolGrant.remaining + " of " + poolGrant.quota + " request" + (poolGrant.quota === 1 ? "" : "s") + " left";
  $("poolstatus").textContent =
    (poolEnabled() ? (live ? "Connected — " : "Expired/used up — ") : "Off — ") +
    "🤝 another user's machine · " + meter;
}

// ---- the sharer's side: "Share my compute" on the local-model row ----------------------

let poolShareLoop = null; // created lazily; survives toggle round-trips

function poolShareStatus(s) {
  const el = $("poolshare-status");
  if (!el) return;
  if (s.state === "off") el.textContent = "";
  else if (s.state === "error") el.textContent = "⚠ " + (s.detail || "sharing stopped");
  else if (s.state === "job") el.textContent = "Sharing — running a job for the workspace…";
  else el.textContent = "Sharing — waiting for work" + (s.jobs ? " · " + s.jobs + " job" + (s.jobs === 1 ? "" : "s") + " served" : "");
}

function poolShareProvider() {
  if (poolShareLoop) return poolShareLoop;
  poolShareLoop = createPoolProvider({
    label: "Se/cure local model",
    listModels: async () => listDrcModels(drcProvider("local"), "", { baseUrl: localUrl() }),
    runJob: async (body) => {
      // The job runs against the sharer's OWN local server (Ollama / LM
      // Studio / llama.cpp) — the same URL the `local` provider uses.
      const res = await fetch(localUrl() + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("local server answered " + res.status);
      const data = await res.json();
      return { response: data, usage: data?.usage };
    },
    onStatus: poolShareStatus,
  });
  return poolShareLoop;
}

async function setPoolSharing(on) {
  const box = /** @type {HTMLInputElement} */ ($("poolshare"));
  if (on && !localUrl()) {
    box.checked = false;
    $("poolshare-status").textContent = "Set a local server URL first — sharing lends THAT model.";
    return;
  }
  try {
    localStorage.setItem(POOL_SHARE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (on) {
    const ok = await poolShareProvider().start();
    box.checked = ok;
    if (ok)
      $("poolshare-status").textContent =
        "Sharing is ON — workspace members' prompts will run on your machine. Oversee and revoke in your Se/rver account panel.";
  } else if (poolShareLoop) {
    await poolShareLoop.stop();
  }
}

// ---- workspace knowledge: 👍 → curate (±blocks, undo/redo) → seal → pass along ----------

let curation = null; // { state (knowledge-core curationState), conclusion, overlay }

// The 👍 action on an assistant reply: build the conclusion (context summary +
// query + reply, blocks split) and open the curation pane over it.
function openCuration(conv, index) {
  const messages = conv?.messages || [];
  const reply = messages[index];
  if (!reply || reply.role !== "assistant") return;
  // The query is the nearest user turn before the reply; the context summary
  // compresses everything before THAT (deterministic — no model call).
  let qi = index - 1;
  while (qi >= 0 && messages[qi].role !== "user") qi--;
  const conclusion = buildConclusion({
    query: qi >= 0 ? messages[qi].content : "",
    reply: reply.content,
    contextSummary: summarizeContext(messages.slice(0, Math.max(0, qi))),
    model: state.model || undefined,
    workspace: typeof sharedWorkspace === "string" ? sharedWorkspace : undefined,
  });
  curation = { state: curationState(conclusion), conclusion };
  renderCuration();
  $("curateview").hidden = false;
}

function closeCuration() {
  curation = null;
  $("curateview").hidden = true;
}

// Render the curation pane from the reducer state: summary (editable), query,
// then one row per block — ＋ tags it along as key context, − removes it
// entirely (hidden here too; undo brings it back).
function renderCuration() {
  if (!curation) return;
  const c = curation.state.conclusion;
  /** @type {HTMLTextAreaElement} */ ($("curate-summary")).value = c.summary;
  $("curate-query").textContent = c.query;
  const list = $("curate-blocks");
  list.innerHTML = "";
  for (const b of c.blocks) {
    if (b.tag === "minus") continue; // removed — not shown here, not included
    const row = document.createElement("div");
    row.className = "curate-block" + (b.tag === "plus" ? " plus" : "");
    const text = document.createElement("div");
    text.className = "curate-text";
    text.textContent = b.text;
    const acts = document.createElement("div");
    acts.className = "curate-acts";
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = b.tag === "plus" ? "＋ context" : "＋";
    plus.title = "Tag this block along as key context (tap again to untag)";
    plus.addEventListener("click", () => {
      curate(curation.state, { type: "plus", blockId: b.id });
      renderCuration();
    });
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.title = "Remove this block entirely (Undo brings it back)";
    minus.addEventListener("click", () => {
      curate(curation.state, { type: "minus", blockId: b.id });
      renderCuration();
    });
    acts.append(plus, minus);
    row.append(text, acts);
    list.appendChild(row);
  }
  $("curate-undo").disabled = !curation.state.past.length;
  $("curate-redo").disabled = !curation.state.future.length;
  const kept = c.blocks.filter((b) => b.tag !== "minus").length;
  $("curate-count").textContent =
    kept + " of " + c.blocks.length + " block" + (c.blocks.length === 1 ? "" : "s") + " kept";
}

// Seal the curated conclusion to the site's import-agent key, addressed to
// the workspace owner (the pool the token names). One envelope, two routes.
async function sealCuratedBundle() {
  const c = curation.state.conclusion;
  c.summary = /** @type {HTMLTextAreaElement} */ ($("curate-summary")).value.slice(0, 2000);
  const keyRes = await fetch("/api/knowledge/key");
  if (!keyRes.ok) throw new Error("The import key is unavailable right now.");
  const { publicKey } = await keyRes.json();
  const bundle = buildKnowledgeBundle({
    owner: poolGrant?.pool || undefined,
    workspace: typeof sharedWorkspace === "string" ? sharedWorkspace : undefined,
    conclusions: [finalizeConclusion(c)],
  });
  return sealKnowledge(bundle, publicKey);
}

async function sendCuration() {
  if (!curation) return;
  const status = (m) => ($("curate-status").textContent = m);
  if (!poolUsable()) {
    status("No live workspace compute token — download the blob instead and hand it to the owner.");
    return;
  }
  $("curate-send").disabled = true;
  status("Sealing…");
  try {
    const envelope = await sealCuratedBundle();
    status("Passing along…");
    const res = await fetch("/api/knowledge/submit", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + poolGrant.token },
      body: JSON.stringify({ envelope }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status("Could not pass it along — " + (err.error || "the server refused (" + res.status + ")."));
      return;
    }
    closeCuration();
    workStatus("Conclusion passed along — sealed, resting encrypted until the workspace owner imports it.");
  } catch (e) {
    status(e?.message || "Sealing failed.");
  } finally {
    $("curate-send").disabled = false;
  }
}

// The MIGRATION route: the same sealed envelope as a downloadable .drskn file,
// delivered out-of-band, imported by the owner in their Se/rver panel.
async function downloadCuration() {
  if (!curation) return;
  const status = (m) => ($("curate-status").textContent = m);
  $("curate-download").disabled = true;
  status("Sealing…");
  try {
    const envelope = await sealCuratedBundle();
    const blob = new Blob([JSON.stringify(envelope)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "conclusions-" + new Date().toISOString().slice(0, 10) + KNOWLEDGE_FILE_EXT;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status("Downloaded — hand the file to the workspace owner (it opens only for their account).");
  } catch (e) {
    status(e?.message || "Sealing failed.");
  } finally {
    $("curate-download").disabled = false;
  }
}

// ---- SECURE WORKSPACES: the /cure/workspace surface -----------------------------------
//
// A workspace is this session's whole configuration — keys, settings, chats,
// any borrowed grants — sealed into ONE OFFLINE LINK: ciphertext riding the
// URL ANCHOR (`/cure/workspace#w=<blob>`), which browsers never send to any
// server. The mechanism is cloned from github.com/kristerhedfors/hacka.re
// (owner directive, 2026-07-15) — the crypto and payload logic live in the
// pure core /js/workspace-core.js; this is only the pane wiring. Every user
// "has" a workspace by construction: /cure/workspace with no fragment opens
// the share composer over THIS session; a #w= fragment opens the unlock flow.
// The embedded grant tokens stay quota-bound and live-administered: the
// minter can raise/lower/revoke each token's allowance server-side while the
// link itself never changes.

let pendingWorkspaceBlob = null; // the #w= blob awaiting its password

function openWorkspaceView(mode) {
  $("wkopen").hidden = mode !== "open";
  $("wkshare").hidden = mode === "open";
  if (mode !== "open") renderWorkspaceShare();
  $("workspaceview").hidden = false;
  if (mode === "open") $("wkpassword").focus();
}
function closeWorkspaceView() {
  $("workspaceview").hidden = true;
}

// The share composer is a MULTISTEP wizard (2026-07-20): one decision per
// step, each step a full information card with a beginner recommendation.
// The step order is fixed; the grants step only appears when this session
// actually holds something re-shareable. Choices persist in the checkboxes
// across steps (and across reopenings — the pane is never reset mid-session),
// so Back/Next lose nothing.
const WORKSPACE_STEPS = ["keys", "settings", "chats", "grants", "secure"];
let workspaceStep = 0;
let workspaceGrantsAvailable = false;

function workspaceVisibleSteps() {
  return WORKSPACE_STEPS.filter((s) => s !== "grants" || workspaceGrantsAvailable);
}

// Show exactly one step card; the nav row swaps Next for Create on the last
// step; the result block is hidden whenever the wizard is in steps mode.
function renderWorkspaceStep() {
  const steps = workspaceVisibleSteps();
  workspaceStep = Math.max(0, Math.min(workspaceStep, steps.length - 1));
  const cur = steps[workspaceStep];
  for (const el of document.querySelectorAll("#wkshare .wk-step")) el.hidden = el.dataset.step !== cur;
  const last = workspaceStep === steps.length - 1;
  $("wk-back").hidden = workspaceStep === 0;
  $("wk-next").hidden = last;
  $("wk-create").hidden = !last;
  $("wk-nav").hidden = false;
  $("wk-result").hidden = true;
  $("wk-progress").textContent = "Step " + (workspaceStep + 1) + " of " + steps.length;
  $("wk-status").textContent = "";
}

// The share composer's dynamic bits: register whether the borrowed-allowances
// step applies, prefill a generated password, and start from the first step.
function renderWorkspaceShare() {
  const g = shareableGrants();
  const bits = [];
  if (g.ws) bits.push("web search");
  for (const p of g.proxy) bits.push(p.svc === "api" ? "LLM API" : "web search (research space)");
  if (g.pool || localStorage.getItem(POOL_SHARE_KEY) === "1") bits.push("shared compute");
  workspaceGrantsAvailable = bits.length > 0;
  if (bits.length) $("wk-grants-desc").textContent = "(" + bits.join(" + ") + " — quota-bound, minter-controlled)";
  if (!$("wk-pass").value) $("wk-pass").value = generateWorkspacePassword();
  workspaceStep = 0;
  renderWorkspaceStep();
}

// What this session can pass on: the web-search grant token (wsk1.…, the same
// token a ?ws= link carries) and the proxy GRANT tokens (prg1.…, the
// URL-safe tier — never the working proxy tokens). Only live allowances.
function shareableGrants() {
  const out = { ws: null, proxy: [], pool: null };
  if (wsGrant && wsGrant.token && wsGrantActive()) out.ws = wsGrant.token;
  const grantTokens = readJson(PROXY_GRANT_TOKENS_KEY) || {};
  for (const svc of ["web", "api"]) {
    if (grantTokens[svc] && proxyLive(proxyGrants[svc])) out.proxy.push({ svc, token: grantTokens[svc] });
  }
  // A live pool token re-shares as-is (pool tokens are single-tier and
  // URL-safe); a SHARER minting a fresh one for the workspace happens at
  // create time (workspacePoolToken) since it needs a server round-trip.
  if (poolGrant && poolGrant.token && grantLive(poolGrant)) out.pool = poolGrant.token;
  return out;
}

// The pool token a new workspace should carry: the borrowed one this session
// already holds, or — when this browser IS sharing its compute (a signed-in
// sharer) — a freshly minted workspace token from the sharer's own pool.
// Null when neither applies (the grants step just won't mention compute).
async function workspacePoolToken(label) {
  if (poolGrant && poolGrant.token && grantLive(poolGrant)) return poolGrant.token;
  if (localStorage.getItem(POOL_SHARE_KEY) !== "1") return null;
  try {
    const res = await fetch("/api/pool/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "workspace", label: label || "workspace" }),
    });
    if (!res.ok) return null;
    const v = await res.json();
    return typeof v.token === "string" ? v.token : null;
  } catch {
    return null;
  }
}

// Recognize a workspace arrival at boot: a #w=<blob> fragment (any /cure
// path) opens the unlock flow; the bare /cure/workspace page opens YOUR
// workspace — the share composer. Returns true when either pane opened, so
// the boot sequence treats it as a deep link (no intro over it).
function handleWorkspaceLink() {
  const blob = parseWorkspaceHash(location.hash);
  if (blob) {
    pendingWorkspaceBlob = blob;
    openWorkspaceView("open");
    return true;
  }
  if (isWorkspacePath(location.pathname)) {
    openWorkspaceView("share");
    return true;
  }
  return false;
}

// The unlock CELEBRATION (owner directive, 2026-07-15): the moment the correct
// password opens a shared workspace, ONE LARGE umbrella plays the intro's whole
// arc FAST, full-screen — the umbrella spinner's completion finale (the
// speed-run through vortex → untwist → wireframe → tilt → the pink bloom, then
// the fold into the pink ✓) on a viewport-sized canvas over the intro's own
// khaki stage. mountUmbrellaSpinner is reused as-is: finish() straight after
// mount speed-runs the compressed intro in ~0.9 s, so the two renderings can
// never drift. Entirely decoration and entirely fail-soft: reduced-motion and
// no-canvas browsers skip it, a tap dismisses it (like the intro), and a
// watchdog clears the overlay even if RAF stalls (the umbrella.js iOS lesson)
// — the unlock itself never waits on any of this.
const CELEBRATION_HOLD_MS = 650; // living a beat as the full-screen ✓
const CELEBRATION_WATCHDOG_MS = 6000; // finale ≈ 0.9+0.24+0.42 s + holds; wide margin
function playUnlockCelebration() {
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!document.createElement("canvas").getContext) return;
    const overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:30;background:#c3b091;cursor:pointer;" +
      "transition:opacity .3s ease;";
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:50%;top:50%;width:0;height:0;";
    overlay.appendChild(host);
    document.body.appendChild(overlay);
    let gone = false;
    const remove = () => {
      if (gone) return;
      gone = true;
      clearTimeout(watchdog);
      overlay.remove();
    };
    const fadeOut = () => {
      if (gone) return;
      overlay.style.opacity = "0";
      setTimeout(remove, 350);
    };
    overlay.addEventListener("pointerdown", remove); // tap skips, like the intro
    const watchdog = setTimeout(remove, CELEBRATION_WATCHDOG_MS);
    const spinner = mountUmbrellaSpinner(host, {
      size: unlockCelebrationSize(window.innerWidth, window.innerHeight),
      style: 0, // the fleet's deep-rose lead umbrella
    });
    // finish() immediately: the whole intro compressed into the finale's
    // speed-run + the pink beat + the ✓ — the "fast final" of the intro.
    spinner.finish(() => setTimeout(fadeOut, CELEBRATION_HOLD_MS));
  } catch {
    /* decoration — must never cost the unlock */
  }
}

// The unlock submit: decrypt the blob LOCALLY (workspace-core's 8192-round
// KDF + AES-GCM — wrong password just fails soft), apply the payload onto
// this session, hydrate any embedded grants through the existing fail-soft
// paths, then strip the fragment so the ciphertext doesn't linger in the
// address bar / history beyond the open.
async function unlockWorkspace(ev) {
  ev.preventDefault();
  const pw = $("wkpassword").value;
  if (!pendingWorkspaceBlob || !pw) return;
  const status = (m) => ($("wkopenstatus").textContent = m);
  $("wkunlock").disabled = true;
  status("Deriving keys…");
  try {
    const opened = await openWorkspace(pendingWorkspaceBlob, pw);
    if (!opened || !validateWorkspacePayload(opened.payload)) {
      status("Wrong password — or the link is damaged.");
      return;
    }
    const { grants, note, name } = applyWorkspacePayload(state, opened.payload);
    pendingWorkspaceBlob = null;
    // The password checked out — celebrate over everything that follows (the
    // grant hydration and re-renders run underneath the animation).
    playUnlockCelebration();

    // Hydrate embedded grants (all optional and fail-soft — the workspace
    // itself is already fully applied, offline).
    if (grants.ws) {
      try {
        const res = await fetch("/api/websearch/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: grants.ws }),
        });
        if (res.ok) {
          wsGrant = await res.json();
          persistWsGrant();
        }
      } catch {
        /* offline / revoked — no server web search */
      }
    }
    if (grants.proxy.length) await connectProxyGrants(grants.proxy).catch(() => false);
    if (grants.pool) await connectPoolGrant(grants.pool).catch(() => false);

    // Reflect the applied workspace everywhere.
    renderKeysPanel();
    renderConvPicker();
    renderMessages();
    renderSearchBackend();
    renderWsRow();
    renderProxyRow();
    renderStRow();
    renderPoolRow();
    reflectResearchKnob();
    reflectBudget();
    $("bashlite").checked = state.bashLite === true;
    $("devmode").checked = state.developerMode === true;
    $("ondevice").checked = state.onDevice === true;
    applyIntrospectionTheme(state.developerMode === true);
    if (configuredProviders().length || apiProxyUsable() || stApiUsable()) await refreshModels().catch(() => {});
    await saveState().catch(() => {});

    // Drop the ciphertext from the address bar (the pane is open; the link
    // holder can always revisit the original link).
    try {
      history.replaceState(null, "", location.pathname + (location.search || ""));
    } catch {
      /* history API blocked — harmless */
    }
    closeWorkspaceView();
    workStatus(
      "Secure workspace opened" +
        (name ? ": " + name : "") +
        " — applied entirely in this browser." +
        (note ? " Note from the sender: " + note : "") +
        " Save it as a project (drawer → Project) to keep it on this device.",
    );
    // A shared workspace pops the privacy notice open (owner directive,
    // 2026-07-16): the arriving user reads what THIS workspace's
    // configuration sends where — and can reopen it any time from the (i)
    // on the header wordmark.
    sharedWorkspace = name || true;
    // Map the carried grants to the exact share-menu families (nothing else is
    // shareable): `api` proxy grant → Berget model + embeddings; web / legacy
    // web-search grant → Exa web search.
    const proxySvcs = new Set((grants.proxy || []).map((p) => p.svc));
    const gotLlm = proxySvcs.has("api");
    const gotSearch = !!grants.ws || proxySvcs.has("web");
    sharedWorkspaceGrants = gotLlm || gotSearch ? { llm: gotLlm, search: gotSearch } : false;
    // Shared compute carried: EVERY participant sees the data-flow notice
    // (owner requirement) — showPrivacyNotice appends the pool lines while a
    // pool token is present, and the notice pops open right here on arrival.
    showPrivacyNotice();
  } finally {
    $("wkunlock").disabled = false;
    if (!pendingWorkspaceBlob) $("wkpassword").value = "";
  }
}

// The share submit: project the ticked sections of THIS session's state into
// a payload (workspace-core buildWorkspacePayload), seal it under the
// password, and present the /cure/workspace#w= link. All local — nothing
// about the workspace touches the server at any point.
async function createWorkspaceLink() {
  const status = (m) => ($("wk-status").textContent = m);
  const password = $("wk-pass").value.trim();
  if (!password) {
    status("Set (or generate) a password first.");
    return;
  }
  const include = {
    keys: $("wk-inc-keys").checked,
    settings: $("wk-inc-settings").checked,
    conversations: $("wk-inc-chats").checked,
    grants: $("wk-inc-grants").checked && workspaceGrantsAvailable ? shareableGrants() : null,
    name: $("wk-name").value.trim(),
  };
  if (include.grants && !include.grants.pool) {
    // A sharing sharer mints a fresh pool token for this workspace (server
    // round-trip; fail-soft — the workspace still seals without it).
    include.grants.pool = await workspacePoolToken(include.name).catch(() => null);
  }
  const payload = buildWorkspacePayload(state, include);
  if (!workspacePayloadCarries(payload)) {
    status("Tick at least one thing to include (go Back to revisit the choices).");
    return;
  }
  $("wk-create").disabled = true;
  status("Sealing…");
  try {
    const blob = await sealWorkspace(payload, password);
    const link = workspaceLink(location.origin, blob);
    $("wk-link").value = link;
    // Result mode: the wizard steps and nav give way to the finished link.
    // The "Open workspace ↗" anchor carries the REAL link (new tab — opening
    // in place would tear down this session under the composer): the minter
    // can immediately open what they just sealed — e.g. to verify it, or to
    // debug a workspace built around an embedded feedback/grant token.
    for (const el of document.querySelectorAll("#wkshare .wk-step")) el.hidden = true;
    $("wk-nav").hidden = true;
    $("wk-progress").textContent = "";
    $("wk-result").hidden = false;
    $("wk-openlink").href = link;
    $("wk-result-note").textContent =
      (link.length > 2000
        ? "⚠ This link is " + link.length + " characters — long links can break in some chat apps; consider fewer conversations. "
        : "") +
      "Share the link and the password through DIFFERENT channels. Anyone with both gets everything the workspace carries" +
      (include.keys ? " — including your API keys" : "") +
      ".";
    status("");
  } catch {
    status("Sealing failed — try again.");
  } finally {
    $("wk-create").disabled = false;
  }
}

// ---- send: the client-side research pipeline -----------------------------------------

async function send(ev) {
  ev.preventDefault();
  if (sending) return;
  const text = $("input").value.trim();
  if (!text) return;

  // Feedback keyword (EN+SV, the shared gate) → confirm-then-send to the
  // developers over the DeepResearch token, never researched. Handled BEFORE
  // provider routing so it works even with no LLM configured.
  if (feedbackIntent(text)) {
    startFeedback(text);
    return;
  }

  // The first-visit path: no key yet → the prepackaged non-LLM helper answers
  // the common get-started questions right in the chat (clearly badged as
  // canned, not the model), never an error wall. The question is echoed as a
  // normal bubble; nothing typed is lost. For an explicit get-started ask (or
  // an unrecognized one) also surface the key panel so setup is one tap away.
  // A live secure-research-space LLM proxy — or a Se/rver token carrying the
  // api permission — counts as "has a provider": a borrowed session with no
  // key of its own can research on the lent API.
  if (!configuredProviders().length && !apiProxyUsable() && !stApiUsable() && !poolUsable()) {
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
  state.budgetS = posToSeconds(Number($("budget").value));

  // Resolve the answer provider + credential: normally a user-key provider, but
  // when the pick is the secure-research-space proxy it's the proxy provider
  // object with the api PROXY TOKEN as its "key" (runDrcResearch takes a
  // provider override so this needs no registry entry).
  const usingApiProxy = providerId === PROXY_LLM_PROVIDER_ID;
  const usingStApi = providerId === SERVER_TOKEN_LLM_PROVIDER_ID;
  const usingPool = providerId === POOL_LLM_PROVIDER_ID;
  const usingLocal = providerId === "local";
  // The on-device engine provider is built on demand exactly like the proxy
  // providers (drc-providers.js has no registry entry for it) — its wire IS
  // the in-browser engine, so the pipeline runs with no network at all.
  const usingOnDevice = providerId === ONDEVICE_ID;
  const providerOverride = usingApiProxy
    ? proxyLlmProvider(location.origin)
    : usingStApi
      ? serverTokenLlmProvider(location.origin)
      : usingPool
        ? poolLlmProvider(location.origin)
        : usingOnDevice
          ? (await odEngine()).onDeviceProvider()
          : null;
  const answerKey = usingApiProxy
    ? proxyGrants.api?.token
    : usingStApi
      ? stGrant?.token
      : usingPool
        ? poolGrant?.token
        : state.keys[providerId];

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
  // A space-visual ask mounts its playable wireframe scene above the incoming
  // answer (feedback #18); the research answer still streams below it.
  mountDrcSpaceEmbed($("chat"), text, { before: live });
  // The research steps render inline, just above this send's answer (matching
  // the DRS app's activity placement) — not in the composer footer.
  beginPhaseSteps(live);

  const retrieved = await recallContext(conv, text);
  const intro = await introspectionContext(conv, text);

  let shown = "";
  let errMsg = null;
  let result = null;
  try {
    result = await runDrcResearch({
      providerId,
      provider: providerOverride,
      apiKey: answerKey,
      model,
      messages: conv.messages.slice(-DRC_RECENT_TURNS),
      research: state.research,
      budgetS: state.budgetS,
      retrieved,
      introspection: intro.block,
      snapshot: intro.snapshot,
      bash: state.bashLite === true,
      fileProvider: intro.fileProvider,
      // The local provider's whole wire config is its user-set base URL —
      // every pipeline call already threads baseUrl down (the trajectory
      // doc's one-line send-path edit; other providers keep their registry base).
      baseUrl: usingLocal ? localUrl() : undefined,
      // Web search source, in priority order: (1) the user's OWN self-hosted
      // service called browser-direct (the expert setting — no query touches
      // this server); (2) the secure-research-space web proxy OR the legacy
      // grant, whichever is live + enabled, both via drcServerWebSearch;
      // (3) null → the offline harvest, unchanged.
      webSearch: directSearchActive()
        ? drcDirectWebSearch
        : stWebUsable() || webProxyUsable() || (wsGrantActive() && wsEnabled())
          ? drcServerWebSearch
          : null,
      onStatus: (s) => {
        if (s.type === "tool") {
          // Developer-mode native tool call — show the tool + its argument live
          // (which file / pattern / command) on the running step, not a bare
          // counter and not a new step per call. Also file the full call (the
          // headline + its real result lines) into the step's expandable body,
          // so the run stays inspectable: tap to see WHICH command ran and what
          // it returned (matching Se/rver's step details).
          phaseNote("🔧 " + s.headline);
          appendToolDetail(s.headline, s.result);
        } else if (s.type === "exec") {
          // A bash-lite sandbox command finished — append its full transcript
          // (command + exit + output) to the running (sandbox) step's body.
          appendShellRun(s.run);
        } else if (s.type === "phase") {
          // A new phase starts a new step (✓-ing the previous); the same phase
          // re-labels in place. `label` carries a live line (e.g. a rotating
          // sandbox-boot quip); otherwise the phase's static label.
          phaseStep(s.phase, s.label || PHASE_LABELS[s.phase] || s.phase);
        } else if (s.type === "detail") {
          // A phase finished with an OUTCOME: rewrite the running step's label
          // to it (Se/rver's step_done relabel — "Planned 3 research angles",
          // "Coverage sufficient") and file the detail lines (sub-questions,
          // fact counts, fact-check issues) into its expandable body, so every
          // research phase opens to what it actually decided — matching
          // Se/rver's expandable activity steps.
          if (s.label) phaseNote(s.label);
          appendDetailLines(s.lines);
        } else if (s.type === "sources") {
          // One live web search finished — file the query + its linked results
          // into the running step's expandable body (Se/rver's search-step
          // source list).
          appendSourceGroup(s.query, s.items);
        } else if (s.type === "discard_text") {
          shown = ""; // the validated revision replaces the draft
          live.textContent = "";
          phaseNote("Applying the reviewed revision…");
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
  finishPhaseSteps();

  const answer = result?.answer || shown;
  live.classList.remove("streaming");
  if (answer) {
    renderMarkdownInto(live, answer);
    wireSourcePeek(live);
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
// over a khaki page (reported live 2026-07-10; RECURRED 2026-07-17 with the
// bottom toolbar blue too — the one early flip fires inside Safari's own
// navigation chrome transition and gets swallowed). The shared helper now
// layers the changed-then-target nudge across first frame, load, pageshow
// (bfcache restores), visibility, and two lagged timers; harmless everywhere
// else. Se/rver boots the same helper for the reverse crossing.
wireBarTint("#c3b091");

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

// Build marker (on-device-trace convention). Bump on every DRC deploy.
// TWO placements from the ONE constant: the brand tooltip (hover, desktop)
// AND a visible line at the settings drawer's foot — title-attribute
// tooltips never display on touch devices (field-confirmed 2026-07-16: a
// long-press shows nothing), so the stamp must be READABLE exactly where
// remote debugging needs it, on a phone.
const BUILD = "d36";
try {
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const brand = $("brand");
  brand.title = "About Se/cure · " + BUILD + " · " + (standalone ? "pwa" : "browser");
  $("buildstamp").textContent = "Se/cure build " + BUILD + " · " + (standalone ? "pwa" : "browser");
} catch {
  // the marker is an instrument, never a breaker
}

const projectLinked = handleProjectLink();
// A secure-workspace arrival (a #w= fragment, or the bare /cure/workspace
// page) opens its pane immediately — and counts as a deep link below.
const workspaceLinked = handleWorkspaceLink();
renderKeysPanel();
renderConvPicker();
renderMessages();
reflectBudget(); // the time slider's readout (the 60 s default until a state loads)
reflectResearchKnob(); // the web-search knob DEFAULTS to reality: off unless a
// search source (own backend, or a grant/token already in this browser) exists
// A replay deep link counts like a project link — no intro over it.
// On a genuine first visit the umbrella intro plays first (over the bare
// page); when it finishes, new users land straight in the chat input rather
// than on the promotional pane (afterUmbrella), which stays a tap on the
// wordmark away.
handlePublicationLink().then((opened) => {
  const deepLinked = projectLinked || workspaceLinked || opened;
  maybePlayUmbrella(deepLinked).then((played) => {
    // The app chrome is ALWAYS painted (the intro is a canvas overlay on top of
    // it, never a gate in front of it) — so a stalled or failed animation can
    // never leave the site blank. The overlay removes itself when it ends or via
    // its own watchdog (umbrella.js); nothing here has to un-hide the app.
    afterUmbrella(deepLinked);
    // Extend the intro: when it actually played (first visit, or the ?anim=1
    // replay), send the little ghost strolling across the page with a pink
    // umbrella. Gated on a real play so returning visitors get a clean page.
    // But if afterUmbrella just raised the first-visit greeter popover, HOLD the
    // stroll behind it — the ghost only ambles out once the user has read and
    // dismissed the info box (hideGhostSay releases the queued stroll).
    if (played) {
      const force = /[?&]anim=(1|rev)\b/.test(location.search);
      if (!$("ghostsay").hidden) {
        pendingGhostStroll = () => startGhostStroll(force);
      } else {
        startGhostStroll(force);
      }
    }
  });
});

$("introstart").addEventListener("click", dismissIntro);
$("brand").addEventListener("click", (e) => {
  // The privacy (i) lives INSIDE the brand (right after the wordmark) — its
  // tap opens the privacy notice, not the intro replay.
  if (e.target.closest("#privacybtn")) return;
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
// The account button opens the account MENU (like the signed-in app's account
// panel) rather than redirecting to sign-in (2026-07-15 directive): the public
// documentation pages plus — instead of account specifics — the door to
// Se/rver, since Se/cure itself has no accounts.
$("accountbtn").addEventListener("click", openAccount);
$("accountclose").addEventListener("click", closeAccount);
$("accountview").addEventListener("click", (e) => {
  if (e.target === $("accountview")) closeAccount();
});
// The greeter's close button + dismiss-on-outside-tap (UX-1).
$("ghostsayclose").addEventListener("click", hideGhostSay);
document.addEventListener("click", (e) => {
  if (!$("ghostsay").hidden && !$("ghostsay").contains(e.target) && e.target !== $("accountbtn")) {
    hideGhostSay();
  }
});
// The settings view (the gear): API keys + sandbox — all configuration.
$("gearbtn").addEventListener("click", openSettings);
$("settingsclose").addEventListener("click", closeSettings);
$("settingsview").addEventListener("click", (e) => {
  if (e.target === $("settingsview")) closeSettings();
});
// The secure-workspace pane (header share icon / settings row → share
// composer; #w= → unlock). The header icon (2026-07-15 owner directive) is
// the first-class door — it sits where the ghost used to, ghost one step
// left; the settings row stays as the explained entry next to the ⓘ.
$("sharebtn").addEventListener("click", () => {
  closeSettings();
  openWorkspaceView("share");
});
$("wkopenbtn").addEventListener("click", () => {
  closeSettings();
  openWorkspaceView("share");
});
$("wkclose").addEventListener("click", closeWorkspaceView);
$("workspaceview").addEventListener("click", (e) => {
  if (e.target === $("workspaceview")) closeWorkspaceView();
});
$("wkopenform").addEventListener("submit", (ev) => {
  unlockWorkspace(ev).catch(() => {
    $("wkopenstatus").textContent = "Opening failed — try again.";
    $("wkunlock").disabled = false;
  });
});
$("wk-genpass").addEventListener("click", () => {
  $("wk-pass").value = generateWorkspacePassword();
});
$("wk-back").addEventListener("click", () => {
  workspaceStep -= 1;
  renderWorkspaceStep();
});
$("wk-next").addEventListener("click", () => {
  workspaceStep += 1;
  renderWorkspaceStep();
});
// From the result back into the wizard (last step), keeping every choice and
// the sealed link intact — Create again re-seals with whatever changed.
$("wk-again").addEventListener("click", () => {
  workspaceStep = workspaceVisibleSteps().length - 1;
  renderWorkspaceStep();
});
$("wk-create").addEventListener("click", createWorkspaceLink);

// Copy buttons NOTIFY briefly and RETURN to their original label (2026-07-20
// owner directive — the user goes back and forth; a checkmark that never
// clears reads as stale state). flashButton restores after a beat; re-clicks
// reset the timer instead of stacking reverts.
function flashButton(btn, text, revertMs = 1500) {
  if (btn._origLabel === undefined) btn._origLabel = btn.textContent;
  if (btn._flashTimer) clearTimeout(btn._flashTimer);
  btn.textContent = text;
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn._origLabel;
    btn._flashTimer = null;
  }, revertMs);
}
$("wk-copylink").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("wk-link").value);
    flashButton($("wk-copylink"), "Copied ✓");
  } catch {
    // Clipboard denied (permissions) — select the text so a manual copy is
    // one keystroke, and say so briefly.
    $("wk-link").focus();
    $("wk-link").select();
    flashButton($("wk-copylink"), "Select and copy manually", 2500);
  }
});
$("wk-copypass").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("wk-pass").value);
    flashButton($("wk-copypass"), "Copied ✓");
  } catch {
    flashButton($("wk-copypass"), "Copy manually", 2500);
  }
});
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
// Boot a bare Linux VM straight away when the sandbox is enabled, so "enabled"
// means the system is already running (its terminal drifting faintly behind the
// chat) rather than waiting for a message to need it. Best-effort + idempotent
// (gated on sandboxIdle); the /cure page is always cross-origin isolated.
// Point sandbox.js at the admin's selected self-hosted image (or "" = built-in
// default) BEFORE any boot. Public endpoint, no user data — DRC may read it just
// like /api/anim (the image bytes stream from our same-origin R2, no third party,
// no account). Fail-soft: any error leaves the built-in default. See
// docs/SANDBOX-LOCAL-IMAGE.md.
let _drcSandboxImageApplied = null;
function applyDrcSandboxImage() {
  if (_drcSandboxImageApplied) return _drcSandboxImageApplied;
  _drcSandboxImageApplied = fetch("/api/sandbox-image")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg && typeof cfg.url === "string") setSandboxImage(cfg.url, !!cfg.prefetch); })
    .catch(() => {});
  return _drcSandboxImageApplied;
}
applyDrcSandboxImage();

function prewarmDrcSandbox() {
  try {
    if (state.bashLite !== true || !sandboxSupported()) return;
    // Sandbox is enabled → show the header terminal icon straight away, so its
    // presence signals "Linux is starting" the moment the page opens (even
    // before the VM prints). Independent of the idle/dev-mode boot gates below.
    showTerminalIcon();
    if (!sandboxIdle()) return;
    // Skip when developer mode is on: that path mounts the source snapshot at
    // /src at boot, and a bare pre-warm would be adopted (idempotent boot) and
    // lose the mount. It boots on the first source-tool call instead.
    if (state.developerMode === true) return;
    // Ensure the selected image is applied before the boot chooses its disk.
    applyDrcSandboxImage().finally(() => {
      if (!sandboxIdle()) return;
      ensureSandboxBooted(async () => ({ session: [], project: null, source: null }), () => {});
    });
  } catch { /* best-effort — never disturb the page */ }
}
prewarmDrcSandbox();
$("bashlite").addEventListener("change", () => {
  state.bashLite = $("bashlite").checked;
  const st = $("sandboxstatus");
  st.textContent = state.bashLite
    ? "Sandbox enabled — a message that asks to run a shell will boot Linux here."
    : "Sandbox disabled.";
  saveState().catch(() => {});
  if (state.bashLite) prewarmDrcSandbox(); // enabling now → start Linux immediately + show icon
  else hideTerminalIcon(); // disabling → drop the header terminal icon
});
// ON-DEVICE knob: reveals the model section in Settings (downloads stay
// behind the per-model consent popup — flipping this never fetches weights).
$("ondevice").addEventListener("change", () => {
  state.onDevice = $("ondevice").checked;
  saveState().catch(() => {});
  renderOnDeviceRows().catch(() => {});
  refreshModels().catch(() => {});
});
// The consent popup's NO paths: the explicit button and the backdrop tap
// both just close it (dismissal is never consent — only the size-labeled
// Download button acts).
$("odc-no").addEventListener("click", () => ($("odconsent").hidden = true));
$("odconsent").addEventListener("click", (e) => {
  if (e.target === $("odconsent")) $("odconsent").hidden = true;
});
// Introspection mode's mascot (developer mode): TIN, the titanium robot,
// slides in when what the user is TYPING reads as an ask about this site's
// own implementation — here it explains that DRC is already the private
// route (own key, browser-direct). Debounced; no-op with the knob off.
initIntrospectUi({ tier: "drc" });
initSourcePeek({ enabled: () => state.developerMode === true });
let introTypeTimer = 0;
$("input").addEventListener("input", () => {
  clearTimeout(introTypeTimer);
  introTypeTimer = setTimeout(() => {
    if (state.developerMode === true) noteIntrospectionText($("input").value);
  }, 350);
});
// Enter sends; Shift+Enter inserts a newline — the near-universal chat-composer
// convention, matching the Se/rver twin (public/js/app.js). Guarded against IME
// candidate commits (e.isComposing / keyCode 229) and touch-primary devices
// (coarse pointer), where Enter stays a newline and the ↑ button sends.
$("input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.isComposing || e.keyCode === 229) return;
  try {
    if (window.matchMedia("(pointer: coarse)").matches) return; // touch → newline
  } catch {
    /* no matchMedia → assume a physical keyboard, fall through to send */
  }
  e.preventDefault();
  $("form").requestSubmit();
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
  // The privacy notice dismisses the same way (UX-1): any outside interaction
  // closes it, the text inside stays selectable.
  if (!$("privacypop").hidden && !$("privacypop").contains(e.target) && !e.target.closest("#privacybtn")) {
    $("privacypop").hidden = true;
  }
});
// The privacy (i) on the header wordmark: the privacy notice, available for
// pop-up at any time.
$("privacybtn").addEventListener("click", () => {
  if ($("privacypop").hidden) showPrivacyNotice();
  else $("privacypop").hidden = true;
});
$("unlockform").addEventListener("submit", unlock);
$("newbtn").addEventListener("click", () => generateNew().catch((e) => gateStatus(e?.message || "Failed.")));
$("exportbtn").addEventListener("click", () => exportBackup().catch((e) => gateStatus(e?.message || "Export failed.")));
$("importbtn").addEventListener("click", () => $("importfile").click());
$("importfile").addEventListener("change", async () => {
  const file = /** @type {HTMLInputElement} */ ($("importfile")).files?.[0];
  /** @type {HTMLInputElement} */ ($("importfile")).value = ""; // re-picking the same file must re-fire
  if (file) await importBackup(file).catch((e) => gateStatus(e?.message || "Restore failed."));
});
$("local-save").addEventListener("click", () => saveLocalUrl().catch(() => ($("local-status").textContent = "Saving failed.")));
$("copysecret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("newsecrettext").textContent);
    flashButton($("copysecret"), "Copied ✓");
  } catch {
    flashButton($("copysecret"), "Select and copy manually", 2500);
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
  renderProviderNote();
});
$("websearch").addEventListener("change", () => {
  state.research = $("websearch").checked;
  // The knob gates web search ONLY; the slider stays active either way — depth
  // still buys the answer's output depth offline (DRS twin, owner directive
  // 2026-07-18).
  saveState();
});
// The web-knob popover (UX-10): hovering (desktop) or long-pressing (touch)
// the research knob answers "where does live web search come from?" with a
// small card linking the local-browsing-agent setup page
// (/cure/local-search/ — one-liner recipes for a self-hosted service). The
// knob's tap/click behaviour is untouched: a completed long-press swallows
// the click so the knob doesn't toggle underneath the card (the same 500 ms
// hold the settings ⓘ pops use).
(() => {
  const knob = $("searchtoggle");
  const pop = $("knobpop");
  let hoverShow = 0;
  let hoverHide = 0;
  let holdTimer = 0;
  let held = false;
  const show = () => (pop.hidden = false);
  const hide = () => (pop.hidden = true);
  // Hover intent, only where hover is a real gesture (desktop pointers) — on
  // touch, mouseenter is synthesized from taps and would fight the toggle.
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
    knob.addEventListener("mouseenter", () => {
      clearTimeout(hoverHide);
      hoverShow = setTimeout(show, 300);
    });
    const disarm = () => {
      clearTimeout(hoverShow);
      hoverHide = setTimeout(hide, 250); // grace to travel into the card
    };
    knob.addEventListener("mouseleave", disarm);
    pop.addEventListener("mouseenter", () => clearTimeout(hoverHide));
    pop.addEventListener("mouseleave", disarm);
  }
  knob.addEventListener("pointerdown", () => {
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      show();
    }, 500);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    knob.addEventListener(ev, () => clearTimeout(holdTimer));
  }
  knob.addEventListener("click", (e) => {
    if (held) {
      e.preventDefault(); // the hold opened the card; don't ALSO flip the knob
      held = false;
    }
  });
  // Chrome/Android take over the touch at the long-press threshold: they fire
  // pointercancel (killing the timer above) and contextmenu. So contextmenu IS
  // the long-press signal there — claim it for the card. iOS never fires it
  // (the CSS touch-callout is off) and rides the timer instead; a desktop
  // right-click lands here too, which is harmless on a toggle. Verified
  // against headless Chromium with touch: timer-only missed the gesture.
  knob.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearTimeout(holdTimer);
    held = true;
    show();
  });
  // Dismissal is UX-1: any outside interaction closes it; the link inside
  // stays clickable.
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("#searchtoggle")) hide();
  });
})();
// The time slider: live readout while dragging; persist the seconds on
// release (change), not per input tick — sealing the state is not free.
$("budget").addEventListener("input", renderBudgetReadout);
$("budget").addEventListener("change", () => {
  state.budgetS = renderBudgetReadout();
  saveState();
});
// The server-proxied web-search toggle (only meaningful when a grant is live).
$("websearchserver").addEventListener("change", () => {
  try {
    localStorage.setItem(WS_ENABLED_KEY, $("websearchserver").checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  renderWsRow();
  reflectResearchKnob(); // enabling/disabling the grant changes web-search reach
});
// The secure-research-space master toggle: turn the whole borrowed space off to
// go fully client-side, or back on. Refreshes the model dropdown (the proxy
// provider appears/disappears) and the row.
$("proxyenabled").addEventListener("change", () => {
  try {
    localStorage.setItem(PROXY_ENABLED_KEY, $("proxyenabled").checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  renderProxyRow();
  reflectResearchKnob(); // enabling/disabling the bundle changes web-search reach
  refreshModels().catch(() => {});
});
// The Se/rver-token master toggle: turn the whole borrowed token off to go
// fully client-side, or back on. Refreshes the model dropdown (the token's
// LLM provider appears/disappears) and the row.
$("stenabled").addEventListener("change", () => {
  try {
    localStorage.setItem(ST_ENABLED_KEY, $("stenabled").checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  renderStRow();
  reflectResearchKnob(); // enabling/disabling the token changes web-search reach
  refreshModels().catch(() => {});
});
$("proxybannerclose")?.addEventListener("click", () => {
  $("proxybanner").hidden = true;
});
// The footer notices' × — clears the workstatus line and hides the provider
// disclosure until its text changes (model switch) or the page reloads.
$("noticesclose")?.addEventListener("click", () => {
  provNoteDismissed = $("provnote").textContent || "";
  $("provnote").hidden = true;
  workStatus("");
});
// Borrowed-capability arrival chain, consolidated-first: (1) a Se/rver token
// (?st= link, or the ghost intent — which the token path consumes on success
// and leaves for the legacy path otherwise); (2) an encrypted proxy bundle
// (?rp=/#rk=); (3) the legacy web-search grant. All fire-and-forget/fail-soft.
// After the chain settles, re-point the web-search knob at reality: a grant/
// token that just arrived makes web search reachable, so the knob turns ON
// (unless a stored project already fixed the choice — reflectResearchKnob reads
// state.research either way).
maybeRequestServerToken().then(() => {
  maybeOpenProxyBundle().then((opened) => {
    if (!opened) return maybeRequestWsGrant();
  }).finally(reflectResearchKnob);
});
// Shared compute joins the arrival chain independently: a ?pt= pool-token
// link connects it (fail-soft), and the settings row reflects any stored one.
maybeOpenPoolToken().catch(() => false).then(() => renderPoolRow());
// The consumer master toggle: shared compute on/off (the provider group
// appears/disappears in the dropdown).
$("poolenabled")?.addEventListener("change", () => {
  try {
    localStorage.setItem(POOL_ENABLED_KEY, $("poolenabled").checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  renderPoolRow();
  refreshModels().catch(() => {});
});
// The SHARER toggle on the local-model row — and its auto-resume: a sharer
// who left it on gets their tab lending again on the next visit (their
// explicit, revocable choice; stop() posts unregister on toggle-off).
$("poolshare")?.addEventListener("change", () => setPoolSharing($("poolshare").checked));
if (localStorage.getItem(POOL_SHARE_KEY) === "1" && localUrl()) {
  const box = /** @type {HTMLInputElement} */ ($("poolshare"));
  if (box) box.checked = true;
  setPoolSharing(true).catch(() => {});
}
// The curation pane's chrome.
$("curate-undo")?.addEventListener("click", () => {
  if (curation) {
    curate(curation.state, { type: "undo" });
    renderCuration();
  }
});
$("curate-redo")?.addEventListener("click", () => {
  if (curation) {
    curate(curation.state, { type: "redo" });
    renderCuration();
  }
});
$("curate-send")?.addEventListener("click", sendCuration);
$("curate-download")?.addEventListener("click", downloadCuration);
$("curate-close")?.addEventListener("click", closeCuration);
$("curateview")?.addEventListener("click", (e) => {
  if (e.target === $("curateview")) closeCuration();
});
$("form").addEventListener("submit", send);

// Keep the chat's bottom inset matched to the FIXED footer glass so the last
// lines of a reply always clear the composer pane. The footer's real footprint
// (composer height + margins + the iPhone safe-area inset) is more than the
// old fixed 9rem, which left the tail of a slightly-over-one-page reply buried
// behind the glass — reachable only by an iOS rubber-band drag that snapped
// back on release. Measuring from the composer's top edge to the viewport
// bottom captures that footprint exactly, regardless of safe-area or margin
// collapsing; +14px is a small breathing gap. Fail-soft; re-runs whenever the
// composer resizes or the viewport changes (iOS toolbar show/hide, rotation).
function syncChatInset() {
  try {
    const composer = $("composer");
    const chat = $("chat");
    if (!composer || !chat) return;
    const overlap = window.innerHeight - composer.getBoundingClientRect().top;
    if (overlap > 0) chat.style.setProperty("--chat-pad-bottom", Math.round(overlap + 14) + "px");
  } catch {
    /* best-effort — the CSS 9rem fallback still applies */
  }
}
if (window.ResizeObserver) {
  try {
    new ResizeObserver(syncChatInset).observe($("composer"));
  } catch {
    /* no ResizeObserver support — the resize/orientation listeners still fire */
  }
}
window.addEventListener("resize", syncChatInset);
window.addEventListener("orientationchange", syncChatInset);
syncChatInset();
