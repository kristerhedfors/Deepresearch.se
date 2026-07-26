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
} from "./starters-core.js";
import { STARTERS } from "./starters-data.js";

/** localStorage key holding the explore-rotation cursor, per agent. */
const CURSOR_KEY = "dr_starter_cursor";
/** localStorage key holding this browser's pick counts (id → count). */
const SIGNAL_KEY = "dr_starter_signal";

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
 * @returns {number} how many chips were rendered (0 when there is nothing to show)
 */
export function renderStarterStrip({ mount, compose, mode, platform, lang }) {
  if (!mount || typeof compose !== "function") return 0;
  mount.querySelector(".starters")?.remove();

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
 * @param {string} [opts.platform]
 * @returns {{ refresh: () => void }}
 */
export function initStarters({ chat, compose, getMode, platform }) {
  const refresh = () => {
    try {
      renderStarterStrip({
        mount: chat?.querySelector?.(".empty") || null,
        compose,
        mode: getMode ? getMode() : "normal",
        platform,
      });
    } catch {
      /* the strip is an enhancement: never let it break the chat surface */
    }
  };
  refresh();
  return { refresh };
}
