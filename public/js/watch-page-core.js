// @ts-check
// Page logic for the NHxx builder (/watch/) that does NOT need a DOM.
//
// The builder page itself (public/watch/watch.js) is DOM glue: it turns the
// values here into elements and listens for clicks. Everything it has to get
// RIGHT — which options are offered, which are offered with a warning, which
// spec rows a buyer sees before expanding, and what "surprise me" is allowed
// to produce — lives here so `node --test` can check it in a terminal. That is
// the same split watch-core.js/watch-render.js already use, one layer up.
//
// This module is PURE: no DOM, no fetch, no timers, no module-level state.
//
// It reads the catalogue through a NAMESPACE import and feature-detects the
// newer parts of the catalogue contract (`compatibleOptions`, `surpriseBuild`,
// a slot marked `optional` or free-text). That is deliberate: the page must
// keep working against a catalogue that has not grown them yet, and the
// fallbacks below are real implementations rather than throw-stubs — a random
// build is still guaranteed buildable and incompatible options are still
// annotated, just with the page's own reasoning instead of the catalogue's.

import * as core from "./watch-core.js";

/** The catalogue seen loosely, so feature detection is not a type error. */
const cat = /** @type {any} */ (core);

/**
 * @typedef {{ en: string, sv: string }} Bi
 * @typedef {{ option: any, compatible: boolean, why: Bi|null }} AnnotatedOption
 */

// ---------------------------------------------------------------------------
// Optional slots (#56: "chapter ring, separately bought crystal and separately
// bought bezel insert have no reason to be mandatory").

/** The id an optional slot takes when the buyer leaves it out. */
export const NONE_ID = "none";

/** What "leave it out" is called, per slot, in both languages. */
const NONE_NAMES = {
  insert: {
    en: "None — the case's own bezel",
    sv: "Ingen — boettets egen lünett",
  },
  chapterRing: {
    en: "None — no chapter ring",
    sv: "Ingen — ingen chapter ring",
  },
  crystal: {
    en: "None — comes with the case",
    sv: "Ingen — följer med boettet",
  },
  default: {
    en: "None",
    sv: "Ingen",
  },
};

const NONE_BLURBS = {
  insert: {
    en: "Skip the separately bought insert and keep whatever bezel the case ships with.",
    sv: "Hoppa över det separat köpta inlägget och behåll lünetten som följer med boettet.",
  },
  chapterRing: {
    en: "Leave the chapter ring out. Plenty of mod builds never fit one.",
    sv: "Utelämna chapter ringen. Många moddbyggen monterar aldrig någon.",
  },
  crystal: {
    en: "Keep the crystal the case set came with instead of buying one separately.",
    sv: "Behåll glaset som följde med boettsatsen i stället för att köpa ett separat.",
  },
  default: {
    en: "Leave this part out of the build.",
    sv: "Utelämna den här delen ur bygget.",
  },
};

/**
 * The slot descriptor, or null.
 * @param {string} slotKey
 */
export function slotDef(slotKey) {
  return core.SLOTS.find((s) => s.key === slotKey) || null;
}

/**
 * Whether a slot may be left empty. Feature-detected from the catalogue: a
 * slot is optional exactly when the catalogue says so, so the page never
 * offers a "none" the catalogue would normalise straight back to a default.
 * @param {string} slotKey
 */
export function slotIsOptional(slotKey) {
  const slot = /** @type {any} */ (slotDef(slotKey));
  return !!(slot && slot.optional);
}

/**
 * Whether a slot takes typed text rather than a pick from a list — the dial's
 * custom text and logo (#56). Also feature-detected; a catalogue without any
 * text slot simply never reports one.
 * @param {string} slotKey
 */
export function slotIsText(slotKey) {
  const slot = /** @type {any} */ (slotDef(slotKey));
  return !!(slot && (slot.text === true || slot.input === "text"));
}

/**
 * The synthetic "leave it out" option for an optional slot.
 * @param {string} slotKey
 */
export function noneOption(slotKey) {
  const key = /** @type {keyof typeof NONE_NAMES} */ (
    slotKey in NONE_NAMES ? slotKey : "default"
  );
  return {
    id: NONE_ID,
    none: true,
    name: NONE_NAMES[key],
    blurb: NONE_BLURBS[/** @type {keyof typeof NONE_BLURBS} */ (key)],
  };
}

/**
 * Every option the picker offers for a slot: the catalogue's list, preceded by
 * the "none" choice when the slot is optional.
 * @param {string} slotKey
 * @returns {any[]}
 */
export function optionsForSlot(slotKey) {
  const opts = core.slotOptions(slotKey);
  if (!slotIsOptional(slotKey)) return opts;
  // If the catalogue already carries its own "none" entry, don't double it.
  if (opts.some((o) => o && o.id === NONE_ID)) return opts;
  return [noneOption(slotKey), ...opts];
}

// ---------------------------------------------------------------------------
// Compatibility annotation (#56: "designs that can not be found in versions
// suited to the currently selected movement should be in a dropdown menu with
// a warning symbol"). Nothing is filtered out — an incompatible option is
// still offered, just behind the warning, because it is the user's build.

/** @param {any} row @returns {AnnotatedOption|null} */
function tidyRow(row) {
  if (!row || typeof row !== "object" || !row.option) return null;
  const why =
    row.why && typeof row.why === "object" && (row.why.en || row.why.sv)
      ? { en: String(row.why.en || row.why.sv), sv: String(row.why.sv || row.why.en) }
      : null;
  return { option: row.option, compatible: row.compatible !== false, why };
}

/**
 * Guarantee the "leave it out" row on an optional slot, wherever the annotated
 * list came from. Leaving a part out can never be incompatible.
 * @param {string} slotKey
 * @param {AnnotatedOption[]} rows
 * @returns {AnnotatedOption[]}
 */
function withNoneRow(slotKey, rows) {
  if (!slotIsOptional(slotKey)) return rows;
  if (rows.some((r) => r.option && r.option.id === NONE_ID)) return rows;
  return [{ option: noneOption(slotKey), compatible: true, why: null }, ...rows];
}

/**
 * Every option for a slot, annotated against the REST of the current build.
 *
 * Prefers the catalogue's own `compatibleOptions` when it exists; otherwise
 * reasons from `checkBuild` directly (see `localAnnotate`).
 *
 * @param {string} slotKey
 * @param {Record<string,string>|null|undefined} build
 * @returns {AnnotatedOption[]}
 */
export function annotateOptions(slotKey, build) {
  if (typeof cat.compatibleOptions === "function") {
    let rows = null;
    try {
      rows = cat.compatibleOptions(slotKey, build);
    } catch {
      rows = null;
    }
    if (Array.isArray(rows) && rows.length) {
      const tidy = /** @type {AnnotatedOption[]} */ (rows.map(tidyRow).filter(Boolean));
      if (tidy.length) return withNoneRow(slotKey, tidy);
    }
  }
  return withNoneRow(slotKey, localAnnotate(slotKey, build));
}

/**
 * The fallback annotator. Swap each candidate into the build and ask
 * `checkBuild` what breaks.
 *
 * The subtlety is attribution: a build that is ALREADY broken somewhere else
 * would otherwise mark every candidate in every slot incompatible. So an error
 * counts against a candidate only when it names THIS slot, or when it names a
 * slot that at least one other candidate manages to avoid. An error every
 * candidate provokes in some third slot is the build's problem, not this
 * option's.
 *
 * @param {string} slotKey
 * @param {Record<string,string>|null|undefined} build
 * @returns {AnnotatedOption[]}
 */
export function localAnnotate(slotKey, build) {
  const base = core.normalizeBuild(build);
  const opts = optionsForSlot(slotKey);
  const trials = opts.map((opt) => {
    /** @type {any[]} */
    let errs = [];
    try {
      errs = core.checkBuild({ ...base, [slotKey]: opt.id }).issues.filter((i) => i.level === "error");
    } catch {
      errs = [];
    }
    return { opt, errs };
  });

  // Slots that EVERY candidate provokes an error in are not this slot's doing.
  /** @type {Set<string>|null} */
  let universal = null;
  for (const t of trials) {
    const slots = new Set(t.errs.map((e) => String(e.slot)));
    if (universal === null) universal = slots;
    else for (const s of [...universal]) if (!slots.has(s)) universal.delete(s);
  }
  const unavoidable = universal || new Set();

  return trials.map(({ opt, errs }) => {
    const mine = errs.filter((e) => String(e.slot) === slotKey || !unavoidable.has(String(e.slot)));
    const first = mine[0];
    return {
      option: opt,
      compatible: mine.length === 0,
      why: first ? { en: String(first.en), sv: String(first.sv || first.en) } : null,
    };
  });
}

/**
 * Split an annotated list into the options offered normally and the ones that
 * go behind the warning control.
 * @param {AnnotatedOption[]} rows
 */
export function groupOptions(rows) {
  /** @type {AnnotatedOption[]} */
  const fits = [];
  /** @type {AnnotatedOption[]} */
  const clashes = [];
  for (const r of rows || []) (r && r.compatible ? fits : clashes).push(r);
  return { fits, clashes };
}

// ---------------------------------------------------------------------------
// Surprise me (#57: "the surprise me button should not pair incompatible
// parts"). The old implementation picked each slot independently and patched
// the dial and hands afterwards, which left roughly seven builds in ten with
// at least one hard error. This one is allowed to return only a build that
// passes checkBuild.

/**
 * Fisher–Yates with an injected source of randomness.
 * @template T
 * @param {T[]} list
 * @param {() => number} rand
 * @returns {T[]}
 */
function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1)) % (i + 1);
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/**
 * DEPENDENCY order for the random picker, which is not the display order.
 *
 * Every compatibility rule in the catalogue runs between a slot and one of
 * these six: the movement (dial, hands), or the case's platform (bezel insert,
 * chapter ring, crystal). Deciding a slot only after the slot it depends on
 * means each pick is judged against something already fixed, never against a
 * placeholder. Slots the catalogue grows later fall through to the tail in
 * catalogue order.
 */
const PICK_ORDER = ["movement", "dial", "hands", "case", "insert", "chapterRing", "crystal"];

/** @returns {string[]} the slot keys, dependencies first. */
function pickOrder() {
  const keys = core.SLOTS.map((s) => s.key);
  const head = PICK_ORDER.filter((k) => keys.includes(k));
  return [...head, ...keys.filter((k) => !head.includes(k))];
}

/**
 * Fill the slots in dependency order, keeping every pick free of errors that
 * name a slot already decided. Returns null on a dead end so the caller can
 * try again from a different movement.
 *
 * The subtlety that makes this correct: a partial build still has to be a
 * COMPLETE build for `checkBuild` to read it, so the undecided slots sit at
 * their default values. An error naming an undecided slot is therefore about a
 * placeholder, not about this pick, and must not block — otherwise a no-date
 * movement is rejected on step one because the default dial has a date window,
 * and "surprise me" silently never offers the NH38 or the NH70.
 *
 * @param {() => number} rand
 * @returns {Record<string,string>|null}
 */
function greedyBuild(rand) {
  /** @type {Record<string,string>} */
  const build = { ...core.DEFAULT_BUILD };
  /** @type {Set<string>} */
  const decided = new Set();
  for (const key of pickOrder()) {
    if (slotIsText(key)) {
      // Free text can never be incompatible; leave whatever the default is.
      decided.add(key);
      continue;
    }
    let picked = "";
    for (const opt of shuffled(optionsForSlot(key), rand)) {
      /** @type {any[]} */
      let errs = [];
      try {
        errs = core.checkBuild({ ...build, [key]: opt.id }).issues.filter((i) => i.level === "error");
      } catch {
        errs = [];
      }
      const blocking = errs.some(
        (e) => decided.has(String(e.slot)) || (String(e.slot) === key && decided.size > 0),
      );
      if (!blocking) {
        picked = opt.id;
        break;
      }
    }
    if (!picked) return null;
    build[key] = picked;
    decided.add(key);
  }
  return build;
}

/**
 * `checkBuild(b).ok`, but a throwing catalogue counts as "not ok" rather than
 * as an exception out of the surprise button.
 * @param {Record<string,string>} b
 */
function isValid(b) {
  try {
    return core.checkBuild(b).ok === true;
  } catch {
    return false;
  }
}

/**
 * The PAGE's own guaranteed-valid random build — the fallback, and the one the
 * unit suite holds to a coverage bar. Exported separately from `surpriseBuild`
 * so the page's reasoning stays testable even once the catalogue ships its own.
 * @param {() => number} [rand]
 * @returns {Record<string,string>}
 */
export function pageSurpriseBuild(rand = Math.random) {
  const r = typeof rand === "function" ? rand : Math.random;
  for (let attempt = 0; attempt < 80; attempt++) {
    const b = greedyBuild(r);
    if (!b) continue;
    // normalizeBuild may rewrite an id the catalogue does not know, so check
    // AFTER normalising rather than before.
    const norm = core.normalizeBuild(b);
    if (isValid(norm)) return norm;
  }
  return core.normalizeBuild(core.DEFAULT_BUILD);
}

/**
 * A random build that is guaranteed to pass `checkBuild(build).ok`.
 *
 * Prefers the catalogue's own `surpriseBuild` when it exists — but still
 * verifies it, because the promise this function makes to the button is
 * unconditional and a button that contradicts the fit check beside it is the
 * bug this replaced (feedback #57).
 *
 * @param {() => number} [rand]
 * @returns {Record<string,string>}
 */
export function surpriseBuild(rand = Math.random) {
  const r = typeof rand === "function" ? rand : Math.random;
  if (typeof cat.surpriseBuild === "function") {
    try {
      const b = core.normalizeBuild(cat.surpriseBuild(r));
      if (isValid(b)) return b;
    } catch {
      /* fall through to the page's own picker */
    }
  }
  return pageSurpriseBuild(r);
}

// ---------------------------------------------------------------------------
// The spec sheet's basic/expanded split (#56: "make spec sheet only contain
// most basic information until expanded").

/**
 * The rows shown before the buyer expands anything: the numbers that decide
 * whether a watch fits a wrist and a parts drawer, plus what drives it and
 * what covers it. Everything else is real but secondary.
 */
export const BASIC_SPEC_KEYS = ["dia", "l2l", "thick", "lugW", "mvt", "crystal"];

/**
 * @template {{ key: string }} R
 * @param {R[]} rows
 * @returns {{ basic: R[], more: R[] }}
 */
export function splitSpecRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const order = new Map(BASIC_SPEC_KEYS.map((k, i) => [k, i]));
  const basic = list.filter((r) => r && order.has(r.key));
  basic.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const more = list.filter((r) => r && !order.has(r.key));
  return { basic, more };
}

// ---------------------------------------------------------------------------
// Free-text slots and the permalink codec.
//
// encodeBuild joins the slots as `key:value` pairs separated by `;`, so a
// typed value containing either character would split into nonsense on the way
// back. The page sanitises on the way IN — one place, before the value ever
// reaches the build — rather than trying to repair a broken hash later.

/** Longest custom dial text the page accepts. Real printed dials run shorter. */
export const TEXT_SLOT_MAXLEN = 24;

/**
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function sanitizeTextValue(value) {
  return String(value == null ? "" : value)
    .replace(/[;:]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_SLOT_MAXLEN);
}
