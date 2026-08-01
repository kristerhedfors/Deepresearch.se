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
 * @typedef {{ option: any, compatible: boolean, why: Bi|null, level: "error"|"warning"|null }} AnnotatedOption
 * `compatible: false` means picking it would put the build in ERROR. A `why`
 * can also come back on an option that IS compatible, carrying
 * `level: "warning"` — it fits, but something about it is worth saying.
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
 * The slot descriptor, or null. Uses the catalogue's own lookup when it has
 * one — that covers the orthogonal AXES too, which `SLOTS` alone does not.
 * @param {string} slotKey
 */
export function slotDef(slotKey) {
  if (typeof cat.slotDef === "function") return cat.slotDef(slotKey) || null;
  return core.SLOTS.find((s) => s.key === slotKey) || null;
}

/** Every choosable key: the base slots, then the axes that modify them. */
export function allSlots() {
  return /** @type {any[]} */ (Array.isArray(cat.ALL_SLOTS) ? cat.ALL_SLOTS : core.SLOTS);
}

/** The orthogonal axes, or an empty list on a catalogue without them. */
export function axisSlots() {
  return /** @type {any[]} */ (Array.isArray(cat.AXIS_SLOTS) ? cat.AXIS_SLOTS : []);
}

/** The free-text fields, or an empty list. */
export function textFields() {
  return /** @type {any[]} */ (Array.isArray(cat.TEXT_FIELDS) ? cat.TEXT_FIELDS : []);
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
  if (typeof cat.textFieldDef === "function" && cat.textFieldDef(slotKey)) return true;
  if (textFields().some((f) => f && f.key === slotKey)) return true;
  const slot = /** @type {any} */ (slotDef(slotKey));
  return !!(slot && (slot.text === true || slot.input === "text"));
}

/**
 * The free-text field descriptor for a key, or null.
 * @param {string} slotKey
 */
export function textFieldDef(slotKey) {
  if (typeof cat.textFieldDef === "function") return cat.textFieldDef(slotKey) || null;
  return textFields().find((f) => f && f.key === slotKey) || null;
}

/**
 * The synthetic "leave it out" option for an optional slot.
 * @param {string} slotKey
 */
export function noneOption(slotKey) {
  const key = /** @type {keyof typeof NONE_NAMES} */ (
    slotKey in NONE_NAMES ? slotKey : "default"
  );
  const blurb = NONE_BLURBS[/** @type {keyof typeof NONE_BLURBS} */ (key)];
  // The catalogue words "none" per slot when it can — it knows what the case
  // ships with. Take its wording and keep the page's explanatory blurb, which
  // is what the chip's tooltip shows.
  if (typeof cat.noneOption === "function") {
    const own = cat.noneOption(slotKey);
    if (own && own.id === NONE_ID && own.name && own.name.en && own.name.sv) {
      return { ...own, blurb: own.blurb || blurb };
    }
  }
  return { id: NONE_ID, none: true, name: NONE_NAMES[key], blurb };
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
// The orthogonal AXES (#56: "dials come in so many shapes, colours and sizes
// that the current fixed-variable system needs replacement"). The catalogue
// carries them as its own registry; the page's job is to file them under a
// heading, hide the ones that cannot apply to this build, and otherwise render
// them exactly like a slot.

/** The order the fine-tuning groups appear in, and what to call each. */
export const AXIS_GROUPS = [
  { id: "dial", name: { en: "Dial detail", sv: "Urtavlans detaljer" } },
  { id: "dialText", name: { en: "Dial text and logo", sv: "Urtavlans text och logga" } },
  { id: "wheels", name: { en: "Date and day wheels", sv: "Datum- och veckodagshjul" } },
  { id: "hands", name: { en: "Hand detail", sv: "Visarnas detaljer" } },
  { id: "bezel", name: { en: "Bezel insert detail", sv: "Lünettinläggets detaljer" } },
  { id: "crystal", name: { en: "Crystal detail", sv: "Glasets detaljer" } },
  { id: "chapterRing", name: { en: "Chapter ring detail", sv: "Chapter ringens detaljer" } },
  { id: "caseback", name: { en: "Case back detail", sv: "Boettbottnens detaljer" } },
  { id: "strap", name: { en: "Strap detail", sv: "Bandets detaljer" } },
];

const GROUP_FALLBACK = { en: "More detail", sv: "Fler detaljer" };

/**
 * Whether an axis has anything to say about THIS build.
 *
 * Two ways it can have nothing: it modifies a part that was left out (there is
 * no insert profile to choose when there is no insert), or it is written for a
 * strap family this build is not on (a NATO weave under a steel bracelet). The
 * second is not silently dropped by the compatibility engine — it raises a
 * real issue — but showing the user a row whose every option is warned is
 * noise, not a choice.
 *
 * @param {any} axis
 * @param {Record<string,string>} ids
 */
function axisApplies(axis, ids) {
  if (!axis) return false;
  if (axis.over && ids[axis.over] === NONE_ID) return false;
  if (!axis.kind) return true;
  try {
    const strap = core.part("strap", ids.strap);
    return !!strap && strap.kind === axis.kind;
  } catch {
    return true;
  }
}

/**
 * The fine-tuning groups to render for a build: the axes and free-text fields
 * that apply, filed under their heading, empty groups dropped.
 * @param {Record<string,string>|null|undefined} build
 * @returns {{ id: string, name: Bi, axes: any[], texts: any[] }[]}
 */
export function axisGroupsFor(build) {
  const ids = core.normalizeBuild(build);
  const axes = axisSlots().filter((a) => axisApplies(a, ids));
  const texts = textFields();
  const seen = new Set([...axes.map((a) => a.group || "other"), ...texts.map((t) => t.group || "other")]);
  const ordered = [
    ...AXIS_GROUPS.filter((g) => seen.has(g.id)),
    ...[...seen].filter((id) => !AXIS_GROUPS.some((g) => g.id === id)).map((id) => ({ id, name: GROUP_FALLBACK })),
  ];
  return ordered
    .map((g) => ({
      id: g.id,
      name: g.name,
      axes: axes.filter((a) => (a.group || "other") === g.id),
      texts: texts.filter((t) => (t.group || "other") === g.id),
    }))
    .filter((g) => g.axes.length || g.texts.length);
}

// ---------------------------------------------------------------------------
// WHERE THE FINE TUNING LIVES (feedback #59).
//
// The axes above shipped with #56 and were filed under one "Fine tuning"
// heading at the BOTTOM of the picker. The next round of feedback asked for
// every one of them as though none existed: "please add separate selections
// for the different aspects of a dial such as color, style (sunburst
// excetera), indices … And strap, I need to be able to choose strap color."
//
// Nothing was missing. What was missing was any way to FIND it: the words
// "colour", "index style" and "strap colour" appeared nowhere on the page
// until two disclosures had been opened, and the group that held them sat
// several screens below the dial row it modified — on a phone, below the
// sourcing table's worth of scrolling.
//
// So the groups are addressed to their PART (`slotForGroup` / `axisGroupsBySlot`)
// and each collapsed group states, by name, every variable inside it
// (`axisSummary`). The collapse itself stays — #56 asked for the picker to open
// on the eleven decisions a build is made of, and re-expanding everything by
// default would trade one report for the other.

/**
 * Which base slot a fine-tuning group belongs under, for groups whose members
 * do not name it themselves. An AXIS always names its slot (`over`); a group of
 * free-text fields has no such field, so the group id maps.
 * @type {Record<string,string>}
 */
export const GROUP_SLOT = {
  dial: "dial",
  dialText: "dial",
  wheels: "movement",
  bezel: "insert",
  crystal: "crystal",
  chapterRing: "chapterRing",
  caseback: "caseback",
  strap: "strap",
};

/**
 * The slot a group hangs off, or null when nothing in the catalogue says.
 * The axes' own `over` wins, because it is the catalogue's statement rather
 * than this module's table — a group the catalogue grows later lands correctly
 * without an edit here.
 * @param {{ id?: string, axes?: any[] }} group
 * @returns {string|null}
 */
export function slotForGroup(group) {
  for (const a of (group && group.axes) || []) if (a && a.over) return String(a.over);
  const id = group && group.id ? String(group.id) : "";
  if (id && Object.prototype.hasOwnProperty.call(GROUP_SLOT, id)) return GROUP_SLOT[id];
  return null;
}

/**
 * The fine-tuning groups filed under the part row each of them modifies.
 * `orphans` holds any group whose slot is unknown — they still get rendered,
 * under their own heading, so a catalogue that grows a group this module has
 * never heard of cannot make its axes disappear.
 * @param {Record<string,string>|null|undefined} build
 * @returns {{ bySlot: Record<string, any[]>, orphans: any[] }}
 */
export function axisGroupsBySlot(build) {
  const known = new Set(core.SLOTS.map((s) => s.key));
  /** @type {Record<string, any[]>} */
  const bySlot = {};
  /** @type {any[]} */
  const orphans = [];
  for (const g of axisGroupsFor(build)) {
    const key = slotForGroup(g);
    if (key && known.has(key)) (bySlot[key] = bySlot[key] || []).push(g);
    else orphans.push(g);
  }
  return { bySlot, orphans };
}

/**
 * The subject each group's axes are named after, so a list of eight of them
 * does not read as the word "dial" eight times. EN and SV both, because the
 * Swedish forms are genitive ("Urtavlans färg") and a regex written for one
 * language silently leaves the other unshortened (invariant 6).
 * @type {Record<string, { en: RegExp[], sv: RegExp[] }>}
 */
const GROUP_PREFIX = {
  dial: { en: [/^dial\s+/i], sv: [/^urtavlans\s+/i] },
  dialText: { en: [/^dial\s+/i], sv: [/^urtavlans\s+/i] },
  // Deliberately anchored: "Seconds-hand colour" / "Sekundvisarens färg" must
  // survive intact, or the two colour axes in this group become one word twice.
  hands: { en: [/^hand\s+/i], sv: [/^visarnas\s+/i] },
  bezel: { en: [/^insert\s+/i], sv: [/^inläggets\s+/i] },
  crystal: { en: [/^crystal\s+/i], sv: [/^glasets\s+/i] },
  chapterRing: { en: [/^chapter ring\s+/i], sv: [/^chapter ringens\s+/i] },
  caseback: { en: [/^case ?back\s+/i], sv: [/^boettbottnens\s+/i] },
  strap: { en: [/^strap\s+/i], sv: [/^bandets\s+/i] },
};

/**
 * @param {string} text
 * @param {RegExp[]|null} res
 */
function trimSubject(text, res) {
  let out = String(text || "");
  if (res) {
    for (const re of res) {
      const cut = out.replace(re, "");
      if (cut && cut !== out) {
        out = cut;
        break;
      }
    }
  }
  return out ? out.charAt(0).toLocaleUpperCase() + out.slice(1) : out;
}

/**
 * An axis's name with its group's subject taken off the front — "Dial colour"
 * under the dial's group is just "Colour". Bilingual, and total: an unknown
 * group or a nameless axis gives back what it was handed.
 * @param {any} axis
 * @param {string} [groupId]
 * @returns {Bi}
 */
export function shortAxisName(axis, groupId) {
  const name = axis && axis.name ? axis.name : null;
  if (!name) return { en: "", sv: "" };
  const pre = GROUP_PREFIX[String(groupId || "")] || null;
  const en = trimSubject(name.en || name.sv || "", pre ? pre.en : null);
  const sv = trimSubject(name.sv || name.en || "", pre ? pre.sv : null);
  return { en, sv };
}

/**
 * What a COLLAPSED fine-tuning group says about itself: one entry per variable
 * inside it, named, plus the value where the user has actually chosen one.
 *
 * This is the whole of feedback #59's fix. The reporter went looking for
 * "colour", "style", "indices" and "strap colour" and reported them absent —
 * so those words have to be readable on the page with nothing opened.
 *
 * A build carries an axis key only once it has been moved off its default
 * (`normalizeBuild`), which is exactly the test for "the user chose this".
 *
 * @param {{ id?: string, axes?: any[], texts?: any[] }} group
 * @param {Record<string,string>|null|undefined} build
 * @returns {{ items: { key: string, label: Bi, value: Bi|null, set: boolean }[], setCount: number }}
 */
export function axisSummary(group, build) {
  const ids = core.normalizeBuild(build);
  const gid = group && group.id ? String(group.id) : "";
  /** @type {{ key: string, label: Bi, value: Bi|null, set: boolean }[]} */
  const items = [];
  for (const a of [...((group && group.axes) || []), ...((group && group.texts) || [])]) {
    if (!a || !a.key) continue;
    const raw = ids[a.key];
    const chosen = typeof raw === "string" && raw !== "";
    /** @type {Bi|null} */
    let value = null;
    if (chosen) {
      if (slotIsText(a.key)) {
        value = { en: raw, sv: raw };
      } else {
        let opt = null;
        try {
          opt = core.part(a.key, raw);
        } catch {
          opt = null;
        }
        if (opt && opt.name) {
          value = { en: String(opt.name.en || opt.name.sv || ""), sv: String(opt.name.sv || opt.name.en || "") };
        }
      }
    }
    items.push({ key: String(a.key), label: shortAxisName(a, gid), value, set: !!value });
  }
  return { items, setCount: items.filter((i) => i.set).length };
}

// ---------------------------------------------------------------------------
// Compatibility annotation (#56: "designs that can not be found in versions
// suited to the currently selected movement should be in a dropdown menu with
// a warning symbol"). Nothing is filtered out — an incompatible option is
// still offered, just behind the warning, because it is the user's build.

/**
 * Whether an issue names a slot. The catalogue grew a `slots` ARRAY (one clash
 * is usually visible from both ends of it — hands AND movement) while keeping
 * the single `slot` for the primary one; read both.
 * @param {any} issue
 * @param {string} slotKey
 */
function errNames(issue, slotKey) {
  if (!issue) return false;
  if (String(issue.slot) === slotKey) return true;
  return Array.isArray(issue.slots) && issue.slots.includes(slotKey);
}

/** @param {any} row @returns {AnnotatedOption|null} */
function tidyRow(row) {
  if (!row || typeof row !== "object" || !row.option) return null;
  const why =
    row.why && typeof row.why === "object" && (row.why.en || row.why.sv)
      ? { en: String(row.why.en || row.why.sv), sv: String(row.why.sv || row.why.en) }
      : null;
  const compatible = row.compatible !== false;
  const level = row.level === "error" || row.level === "warning" ? row.level : compatible ? (why ? "warning" : null) : "error";
  return { option: row.option, compatible, why, level: /** @type {any} */ (level) };
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
  return [{ option: noneOption(slotKey), compatible: true, why: null, level: null }, ...rows];
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
    const mine = errs.filter((e) => errNames(e, slotKey) || !unavoidable.has(String(e.slot)));
    const first = mine[0];
    return {
      option: opt,
      compatible: mine.length === 0,
      why: first ? { en: String(first.en), sv: String(first.sv || first.en) } : null,
      level: /** @type {any} */ (first ? "error" : null),
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
      // An error blocks only when EVERY slot it names is already settled (this
      // one included). One that also names a slot still to come can be fixed
      // by that later pick, and treating it as fatal here is what used to make
      // whole movements unreachable: the NH34's "this hand set has only three"
      // names hands AND movement, so judging it while the hands are still at
      // their placeholder rejected the movement itself.
      const blocking = errs.some((e) => {
        const named = new Set([String(e.slot), ...(Array.isArray(e.slots) ? e.slots.map(String) : [])]);
        for (const n of named) if (n !== key && !decided.has(n)) return false;
        return true;
      });
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
    const norm = core.normalizeBuild(twistAxes(b, r));
    if (isValid(norm)) return norm;
  }
  return core.normalizeBuild(core.DEFAULT_BUILD);
}

/**
 * Twist a few of the orthogonal axes, sometimes. A build with every knob moved
 * is noise rather than a surprise, so each applicable axis gets a small chance
 * and only options that raise nothing at all are eligible.
 * @param {Record<string,string>} build
 * @param {() => number} rand
 */
function twistAxes(build, rand) {
  const axes = axisSlots();
  if (!axes.length) return build;
  let out = build;
  const ids = core.normalizeBuild(out);
  for (const axis of axes) {
    if (rand() > 0.28) continue;
    if (!axisApplies(axis, ids)) continue;
    const clean = annotateOptions(axis.key, out).filter((a) => a.compatible && !a.why);
    if (clean.length < 2) continue;
    const chosen = clean[Math.min(clean.length - 1, Math.floor(Math.abs(rand()) * clean.length))];
    const trial = { ...out, [axis.key]: chosen.option.id };
    if (isValid(core.normalizeBuild(trial))) out = trial;
  }
  return out;
}

/**
 * A random build that is guaranteed to pass `checkBuild(build).ok` — what the
 * "surprise me" button calls (feedback #57).
 *
 * VALIDITY IS NOT THE WHOLE JOB. The catalogue also ships a `surpriseBuild`,
 * and everything it returns does pass the fit check — but it judges each slot
 * against a build whose later slots are still at their defaults, so a movement
 * whose default dial clashes is rejected on step one. Measured over 3000
 * draws it returned the NH35 every single time: valid, and not a surprise.
 * The page's own picker (which defers an error that also names an undecided
 * slot instead of treating it as fatal) reaches all five movements, every case
 * and every dial, so it leads here. The catalogue's is the fallback, and the
 * unit suite pins the coverage of whichever one is in front.
 *
 * @param {() => number} [rand]
 * @returns {Record<string,string>}
 */
export function surpriseBuild(rand = Math.random) {
  const r = typeof rand === "function" ? rand : Math.random;
  const own = pageSurpriseBuild(r);
  if (isValid(own) && core.encodeBuild(own) !== core.encodeBuild(core.DEFAULT_BUILD)) return own;
  if (typeof cat.surpriseBuild === "function") {
    try {
      const b = core.normalizeBuild(cat.surpriseBuild(r));
      if (isValid(b)) return b;
    } catch {
      /* keep whatever the page's own picker produced */
    }
  }
  return own;
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
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeTextValue(value, max) {
  const limit = Number.isFinite(max) && Number(max) > 0 ? Number(max) : TEXT_SLOT_MAXLEN;
  return String(value == null ? "" : value)
    .replace(/[;:]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
