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
  evalPool, selectEvalBatch, recordVerdict, verdictReport, MODE_AGENTS,
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
/** localStorage key holding the reviewer's verdicts (id → {v, at, note}). */
const VERDICT_KEY = "dr_starter_verdicts";

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
 * The evaluation strip: one starter per band, drawn across every agent, with
 * 👍/👎 on each chip and a copy-the-report footer.
 *
 * Two behaviours differ from the visitor strip, both deliberate:
 *
 *  1. **The batch is STICKY until something in it is rated.** The visitor strip
 *     rotates on every showing because a visitor who read four chips has seen
 *     them. A reviewer has not finished with a chip until they have run it and
 *     judged the answer, which takes a round trip through a whole conversation
 *     — rotating underneath them would lose the item they were half-way
 *     through. So the cursor advances on a RATING, not on a render.
 *  2. **Clicking a chip switches the chat mode to that starter's agent.** The
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
  const verdicts = readStore(VERDICT_KEY, {});
  const batch = selectEvalBatch(pool, { cursor, rated: verdicts, count: SLOT_COUNT });
  if (!batch.length) return 0;

  const wrap = document.createElement("div");
  wrap.className = "starter-eval";

  const head = document.createElement("p");
  head.className = "starter-eval-head";
  head.textContent = "Evaluation mode — try one, then rate the answer. Turn it off in Settings.";
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

    const tag = document.createElement("span");
    tag.className = `starter-band band-${entry.band}`;
    tag.textContent = `${entry.agent} · ${BAND_LABEL[entry.band] || entry.band}`;
    chip.appendChild(tag);
    chip.appendChild(document.createTextNode(entry.text));

    chip.addEventListener("click", () => {
      // Follow the starter to its agent before sending it.
      const targetMode = Object.keys(MODE_AGENTS).find((m) => MODE_AGENTS[m] === entry.agent);
      if (setMode && targetMode) setMode(targetMode);
      writeStore(SIGNAL_KEY, recordStarterUse(readStore(SIGNAL_KEY, {}), entry.id));
      compose(entry.text);
    });

    const rate = document.createElement("div");
    rate.className = "starter-rate";
    const current = verdicts[entry.id]?.v || "";
    for (const [v, glyph, title] of [
      ["good", "👍", "Good opener — the answer showed what this agent is for"],
      ["bad", "👎", "Bad opener — vague answer, a clarifying question, or an error"],
      ["unclear", "•", "Not sure / skip"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `starter-vote${current === v ? " on" : ""}`;
      b.textContent = glyph;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // Tapping the active verdict again clears it — the only undo a
        // one-tap control can offer.
        const next = current === v ? "" : v;
        writeStore(VERDICT_KEY, recordVerdict(readStore(VERDICT_KEY, {}), entry.id, next, { at: Date.now() }));
        // A rating is what retires this batch: advance so the next render
        // brings fresh material.
        writeStore(EVAL_CURSOR_KEY, { c: cursor + 1 });
        rerender();
      });
      rate.appendChild(b);
    }

    cell.appendChild(chip);
    cell.appendChild(rate);
    strip.appendChild(cell);
  }
  wrap.appendChild(strip);

  // --- footer: how far along, and how to hand the findings back ------------
  const foot = document.createElement("div");
  foot.className = "starter-eval-foot";
  const n = Object.keys(verdicts).length;
  const count = document.createElement("span");
  count.textContent = `${n} rated of ${pool.length}`;
  foot.appendChild(count);

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "starter-eval-btn";
  skip.textContent = "Next batch →";
  skip.addEventListener("click", () => {
    writeStore(EVAL_CURSOR_KEY, { c: cursor + 1 });
    rerender();
  });
  foot.appendChild(skip);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "starter-eval-btn";
  copy.textContent = "Copy report";
  copy.disabled = !n;
  copy.addEventListener("click", async () => {
    const text = verdictReport(pool, readStore(VERDICT_KEY, {}));
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy report"; }, 1500);
    } catch {
      // Clipboard blocked (permissions, insecure context): fall back to
      // showing the report so it can still be selected by hand. Losing the
      // findings to a silent failure would be the worst outcome here.
      const pre = document.createElement("pre");
      pre.className = "starter-eval-report";
      pre.textContent = text;
      wrap.appendChild(pre);
    }
  });
  foot.appendChild(copy);
  wrap.appendChild(foot);

  mount.appendChild(wrap);
  return batch.length;
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
