// @ts-check
// Starter prompts — the DOM half. The logic (which four, in what order, and
// how the local pick-signal folds in) is all in starters-core.js; this module
// only renders the strip, remembers the rotation cursor, and reports a click
// back to the host page. Both tiers use it: the Se/rver app wires it in
// app.js, the Se/cure client in drc.js.
//
// The strip lives INSIDE the `.empty` element on purpose. Both tiers already
// drop `.empty` the moment a conversation gains its first turn (turns.js
// clearEmpty, drc.js's equivalent), so the chips disappear with it and no
// caller has to remember to tear them down.
//
// Persistence is localStorage and nothing else. The rotation cursor and the
// pick counts never leave the browser — not because it would be hard to send
// them, but because Se/cure's whole promise is that this page does not phone
// home, and a starter-analytics beacon would be exactly the kind of quiet
// exception that promise dies of. The offline eval battery
// (tests/starter-eval.mjs) is where ranking evidence comes from; the local
// signal only reorders one person's own strip.

import {
  SLOT_COUNT, agentForMode, resolveQueue, selectStarters, nextCursor, recordStarterUse,
  evalPool, selectEvalBatch, recordStartersSeen, MODE_AGENTS,
  starterTag, tagStarterText,
} from "./starters-core.js";
import { STARTERS, CANDIDATES } from "./starters-data.js";

/** localStorage key holding the explore-rotation cursor, per agent. */
const CURSOR_KEY = "dr_starter_cursor";
/** localStorage key holding this browser's pick counts (id → count). */
const SIGNAL_KEY = "dr_starter_signal";
/** localStorage key holding the evaluation-mode knob (Settings). */
export const EVAL_KEY = "dr_starter_eval";
/** localStorage key holding the evaluation batch cursor. */
const EVAL_CURSOR_KEY = "dr_starter_eval_cursor";
/** localStorage key holding which starters this browser has already been shown
 * in evaluation mode (id → count). This is what makes every batch new. */
const EVAL_SEEN_KEY = "dr_starter_eval_seen";
/** The retired 👍/👎 store. Read once to seed the seen ledger (a rated starter
 * was certainly shown), then deleted — an orphaned blob of verdicts nothing
 * reads would be worse than no record at all. */
const LEGACY_VERDICT_KEY = "dr_starter_verdicts";

/** What each band means, shown on the chip so a reviewer knows what they are
 * being asked to judge. Without this the batch is just four questions and the
 * reviewer has no way to tell "confirm this still works" from "we think this
 * is broken, is it?" */
/** @type {Record<string,string>} */
const BAND_LABEL = {
  proven: "known good",
  weak: "scored low",
  untried: "untested",
  candidate: "new idea",
};

/** True when the Settings knob "Starter prompt evaluation" is on. */
export function evalModeOn() {
  try {
    return localStorage.getItem(EVAL_KEY) === "on";
  } catch {
    return false;
  }
}

/** Persist the knob. Returns the value actually stored. */
export function setEvalMode(/** @type {boolean} */ on) {
  try {
    localStorage.setItem(EVAL_KEY, on ? "on" : "off");
  } catch {
    /* private mode — the knob simply will not persist across reloads */
  }
  return !!on;
}

/** Read a JSON blob from localStorage, failing soft to a default.
 * @param {string} key @param {any} fallback @returns {any} */
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Write a JSON blob to localStorage. Silent on quota/private-mode failures —
 * losing the rotation cursor degrades to "the same four chips again", which is
 * not worth an error path. */
function writeStore(/** @type {string} */ key, /** @type {any} */ value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota — the strip still works, it just stops rotating */
  }
}

/**
 * The reader's preferred language, as a starter lang code. Only "sv" is
 * distinguished; everything else takes the English pool, matching how the rest
 * of the product treats language.
 * @returns {"sv"|"en"}
 */
export function readerLang() {
  try {
    const langs = [navigator.language, ...(navigator.languages || [])];
    return langs.some((l) => typeof l === "string" && /^sv\b/i.test(l)) ? "sv" : "en";
  } catch {
    return "en";
  }
}

/**
 * Render the starter strip into a container.
 *
 * @param {Object} opts
 * @param {HTMLElement|null} opts.mount  the `.empty` element to append into
 * @param {(text: string) => void} opts.compose  called with the chosen starter's text
 * @param {string} [opts.mode]  the active chat mode id
 * @param {string} [opts.platform]  "client" for the Se/cure tier
 * @param {string} [opts.lang]  override the reader language (tests, settings)
 * @param {(mode: string) => void} [opts.setMode]  switch chat mode (evaluation mode)
 * @returns {number} how many chips were rendered (0 when there is nothing to show)
 */
export function renderStarterStrip({ mount, compose, mode, platform, lang, setMode }) {
  if (!mount || typeof compose !== "function") return 0;
  mount.querySelector(".starters")?.remove();
  mount.querySelector(".starter-eval")?.remove();

  if (evalModeOn()) return renderEvalBatch({ mount, compose, platform, setMode });

  const agent = agentForMode(mode, { platform });
  const queue = resolveQueue(STARTERS, agent);
  if (!queue.length) return 0;

  const cursors = readStore(CURSOR_KEY, {});
  const signal = readStore(SIGNAL_KEY, {});
  const cursor = Number(cursors[agent]) || 0;
  const picked = selectStarters(queue, {
    cursor,
    signal,
    lang: lang || readerLang(),
    count: SLOT_COUNT,
  });
  if (!picked.length) return 0;

  const strip = document.createElement("div");
  strip.className = "starters";
  // The strip is supplementary to the empty-state prose, which already says
  // what to do — so it is a list of shortcuts, not a landmark to navigate to.
  strip.setAttribute("role", "list");

  for (const entry of picked) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "starter";
    chip.textContent = entry.text;
    chip.title = entry.text;
    chip.setAttribute("role", "listitem");
    chip.dataset.starter = entry.id;
    chip.dataset.aspect = entry.aspect;
    chip.lang = entry.lang;
    chip.addEventListener("click", () => {
      // Record the pick BEFORE composing: compose may clear the empty state
      // (and therefore this element) synchronously.
      writeStore(SIGNAL_KEY, recordStarterUse(readStore(SIGNAL_KEY, {}), entry.id));
      compose(entry.text);
    });
    strip.appendChild(chip);
  }

  mount.appendChild(strip);

  // Advance the cursor as soon as the strip is SHOWN, not when something is
  // clicked. A visitor who reads four chips and types their own question has
  // still seen those four — showing them again next time wastes the strip.
  cursors[agent] = nextCursor(cursor, picked);
  writeStore(CURSOR_KEY, cursors);

  return picked.length;
}

/**
 * The evaluation strip: one starter per band, drawn across every agent.
 *
 * Three behaviours differ from the visitor strip, all deliberate:
 *
 *  1. **New questions every time** (owner directive, 2026-07-29). Every render
 *     records the four it showed and advances the cursor, and the scheduler
 *     serves least-seen first — so opening a second empty chat hands the
 *     reviewer four they have not read, all the way through the pool. The
 *     batch used to be sticky until something was rated, which was the right
 *     rule when a rating was what retired it; with the rating gone, sticky
 *     would just mean the same four forever.
 *  2. **No 👍/👎.** The reviewer's verdict is a sentence, not a glyph, and it
 *     belongs in the one queue a human already reads: they start a message
 *     with "feedback" and say what was wrong. The chip has already put the
 *     starter's #XP tag in the opening turn, so `src/chat.js` files that tag
 *     on the feedback entry and the report names the exact starter.
 *  3. **Clicking a chip switches the chat mode to that starter's agent.** The
 *     batch is cross-agent by design; sending an Agent Studio starter while the
 *     app sits in Deep Research would measure the wrong thing entirely and
 *     look like the starter's fault.
 *
 * @param {{mount: HTMLElement, compose: (t: string) => void, platform?: string,
 *   setMode?: (mode: string) => void}} opts
 * @returns {number}
 */
function renderEvalBatch({ mount, compose, platform, setMode }) {
  const pool = evalPool(STARTERS, { candidates: CANDIDATES, platform });
  if (!pool.length) return 0;

  const cursor = Number(readStore(EVAL_CURSOR_KEY, { c: 0 }).c) || 0;
  const seen = migrateSeenLedger();
  const batch = selectEvalBatch(pool, { cursor, seen, count: SLOT_COUNT });
  if (!batch.length) return 0;

  const wrap = document.createElement("div");
  wrap.className = "starter-eval";

  const head = document.createElement("p");
  head.className = "starter-eval-head";
  head.textContent =
    "Evaluation mode — four new questions every time. Try one, then say what you thought " +
    "by starting a message with “feedback”: each chip sends with its #XP tag, so your note " +
    "names the exact starter. Turn it off in Settings.";
  wrap.appendChild(head);

  const strip = document.createElement("div");
  strip.className = "starters";
  strip.setAttribute("role", "list");

  const rerender = () => renderStarterStrip({ mount, compose, platform, setMode });

  for (const entry of batch) {
    const cell = document.createElement("div");
    cell.className = "starter-cell";
    cell.setAttribute("role", "listitem");

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "starter";
    chip.title = entry.note || entry.text;
    chip.dataset.starter = entry.id;
    chip.lang = entry.lang;

    const xpTag = starterTag(entry.xp);
    const tag = document.createElement("span");
    tag.className = `starter-band band-${entry.band}`;
    // The #XP tag leads the band label because it is the identity that will
    // travel: the chip prepends it to the message, so a reviewer who later
    // sends "feedback …" has it sitting in the first turn of the conversation
    // and never has to describe which chip they meant (feedback #37).
    tag.textContent = [xpTag, entry.agent, BAND_LABEL[entry.band] || entry.band]
      .filter(Boolean).join(" · ");
    chip.appendChild(tag);
    chip.appendChild(document.createTextNode(entry.text));

    chip.addEventListener("click", () => {
      // Follow the starter to its agent before sending it.
      const targetMode = Object.keys(MODE_AGENTS).find((m) => MODE_AGENTS[m] === entry.agent);
      if (setMode && targetMode) setMode(targetMode);
      writeStore(SIGNAL_KEY, recordStarterUse(readStore(SIGNAL_KEY, {}), entry.id));
      // Tagged ONLY here, never on the visitor strip below: the pipeline
      // strips the tag before any model call, so what the agent answers is
      // still exactly the starter's text.
      compose(tagStarterText(entry.xp, entry.text));
    });

    cell.appendChild(chip);
    strip.appendChild(cell);
  }
  wrap.appendChild(strip);

  // --- footer: how far through the pool this browser has read --------------
  const foot = document.createElement("div");
  foot.className = "starter-eval-foot";
  const readSoFar = pool.filter((e) => (Number(seen[e.id]) || 0) > 0).length;
  const count = document.createElement("span");
  // Seen, not rated: the count of what has been READ is the only progress this
  // browser can honestly report now that the verdicts live in the feedback
  // queue instead of here.
  count.textContent = `${readSoFar} of ${pool.length} seen in this browser`;
  foot.appendChild(count);

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "starter-eval-btn";
  skip.textContent = "Four more →";
  skip.addEventListener("click", () => rerender());
  foot.appendChild(skip);
  wrap.appendChild(foot);

  mount.appendChild(wrap);

  // Record and advance AFTER rendering, so the next render — this session's
  // "Four more", a new chat, or tomorrow's visit — cannot reach for these four
  // again while anything unseen is left. This is the whole "new questions every
  // time" mechanism; the visitor strip advances on the same principle.
  writeStore(EVAL_SEEN_KEY, recordStartersSeen(seen, batch));
  writeStore(EVAL_CURSOR_KEY, { c: cursor + 1 });

  return batch.length;
}

/**
 * The seen ledger, with one-time migration off the retired verdict store: a
 * starter someone rated 👍/👎 was certainly shown to them, so it seeds as seen
 * rather than coming back around as if it were new. The old key is then
 * removed — leaving a blob nothing reads would be a small lie about where the
 * verdicts went.
 * @returns {Record<string, number>}
 */
function migrateSeenLedger() {
  const seen = readStore(EVAL_SEEN_KEY, {});
  let legacy = null;
  try {
    legacy = readStore(LEGACY_VERDICT_KEY, null);
  } catch {
    legacy = null;
  }
  if (!legacy || typeof legacy !== "object") return seen;
  const merged = recordStartersSeen(seen, Object.keys(legacy));
  writeStore(EVAL_SEEN_KEY, merged);
  try {
    localStorage.removeItem(LEGACY_VERDICT_KEY);
  } catch {
    /* private mode — the merge already happened, the stale key is harmless */
  }
  return merged;
}

/**
 * Wire the strip to a chat container so it appears on every empty state.
 *
 * Returns a `refresh()` the host calls when the empty state is rebuilt (a new
 * chat) or when the agent changes (the mode dropdown) — the strip has to
 * follow the mode, since a Deep Research opener in Agent Studio would be
 * actively misleading about what that mode does.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.chat  the scrolling chat container
 * @param {(text: string) => void} opts.compose
 * @param {() => string} [opts.getMode]
 * @param {(mode: string) => void} [opts.setMode]  switch chat mode (evaluation mode)
 * @param {string} [opts.platform]
 * @returns {{ refresh: () => void }}
 */
export function initStarters({ chat, compose, getMode, setMode, platform }) {
  const refresh = () => {
    try {
      renderStarterStrip({
        mount: chat?.querySelector?.(".empty") || null,
        compose,
        mode: getMode ? getMode() : "normal",
        setMode,
        platform,
      });
    } catch {
      /* the strip is an enhancement: never let it break the chat surface */
    }
  };
  refresh();
  return { refresh };
}
