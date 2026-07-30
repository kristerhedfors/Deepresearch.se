// @ts-check
// The CAPABILITY-DEMO registry: the shared pure core (Node-tested,
// import-free apart from the space matcher it delegates to) that answers one
// question deterministically — "is this message asking to be SHOWN one of the
// site's own interactive surfaces, and which one?"
//
// WHY THIS EXISTS (feedback #49 + #50, 2026-07-29). A demo session asked
// "Seiko watch demo" and got a web-research pass that found nothing, while the
// NHxx watch builder that answers it exactly had shipped that same day; and
// asked "Space launch demo" → "Show me visually" and got an ASCII bar chart of
// invented launch data, while the rocket-launch wireframe animation sat one
// unmatched regex away. The generalising note came with them: *"All individual
// capabilities should be callable like this, show me x demo for instance."*
// So the routing from an ask to a built surface is a registry, not a
// per-feature afterthought — adding a demonstrable surface means adding an
// entry here, and every wiring below picks it up.
//
// THREE KINDS of surface, because they resolve differently:
//
//   kind: "space"  the /space/ archive — a scene renders INLINE above the
//                  reply (public/js/space-embed.js). Subject matching is
//                  delegated wholesale to space-core.js's SPACE_MATCHERS so
//                  there is exactly one space matcher and no drift.
//   kind: "watch"  the NHxx builder — a live 3D render mounts INLINE above the
//                  reply (public/js/watch-embed.js) and the conversation drives
//                  it with text commands (public/js/watch-chat-core.js).
//   kind: "page"   a standalone built surface — a link card mounts above the
//                  reply (public/js/demo-embed.js). No surface uses this today;
//                  it stays because the card is also the watch embed's
//                  no-WebGL fallback, and the next page-only surface needs it.
//
// The watch STARTED as kind "page" (feedback #49) and became inline on
// 2026-07-30, because the card was exactly the wrong shape: "i want the watch
// builder to be inline so I get the watch animation here and suggestions on
// what one can change through text commands … every new reply contains a new
// watch animation with text on what changed" (feedback #52). A link out of the
// conversation cannot be driven BY the conversation.
//
// The gate is DECORATIVE-ADDITIVE, exactly like the space embed it
// generalises: the research answer still streams below, so a false positive
// costs a card the user can ignore, never an answer. That is what lets the
// patterns be generous.
//
// Lives under public/js/ for the same reason space-core.js and bash-core.js
// do: the browser can only import served modules, the Worker bundler imports
// from anywhere — one implementation, two faces (façade: src/demos.js).
// EN+SV parity is invariant 6: every pattern set below carries Swedish forms
// with the same breadth as English, diacritic-typo tolerant via [åa]-style
// classes. Note the JS `\b` trap — a word boundary next to å/ä/ö never fires,
// because those are not ASCII word characters — so Swedish patterns here
// anchor on spaces and affixes rather than \b.

import { spaceIntentMatch } from "./space-core.js";

// ---------------------------------------------------------------------------
// "Show me" phrasing — the VERB half of a demo ask, independent of subject.
// A subject alone is a research question ("what is the NH35 movement?"); a
// subject with one of these is an ask to be shown the thing.

// "demo", "demonstration" and "animation" are the SAME word in Swedish and
// English, so they cannot decide which language a message is in — they are
// neutral, and the language comes from the subject instead. Keeping them in
// both lists made "Seiko watch demo" Swedish, purely because the Swedish set
// happened to be tested first.
const SHOW_VERBS = {
  neutral: [
    /\bdemos?\b/,
    /demonstration(en|er)?\b/,
    /animation(en|er|erna)?\b/,
  ],
  en: [
    /\bshow (me|us|it)\b/,
    /\bshow (me |us )?(a|an|the|your)\b/,
    /\bvisuali[sz]e\b/,
    /\bvisual\b/,
    /\banimate\b/,
    /\bsimulat(e|ion)\b/,
    /\bplay (with|around with)\b/,
    /\btry (it|out)\b/,
    /\bbuilder?\b/,
    /\bconfigurator\b/,
    /\blet me see\b/,
    /\bcan i see\b/,
    /\bwhat does it look like\b/,
  ],
  sv: [
    /\bvisa (mig|oss|det|den)\b/,
    /\bvisa (en|ett|din|ditt)\b/,
    /visualisera/,
    /visuell(t|a)?/,
    /animera/,
    /simulering(en|ar)?|simulera/,
    /\bleka? med\b/,
    /\bprova\b|\btesta\b/,
    /byggar(e|en)|bygg(verktyg|are)/,
    /\bhur ser (den|det) ut\b/,
    /\bf[åa]r jag se\b/,
    /\bl[åa]t mig se\b/,
  ],
};

// A BARE visual ask — "show me visually", "visa visuellt" — names no subject
// at all. On its own it matches nothing; its subject is the turn before it,
// which is what makes feedback #50's real sequence work ("Space launch demo"
// → "Show me visually"). Deliberately narrow: only messages that are almost
// nothing BUT the ask inherit, so a fresh question is never answered with the
// previous turn's surface.
const BARE_SHOW = {
  en: [
    /^(please |now |ok(ay)? )?(show|visuali[sz]e|animate|draw|render|display)( me| us| it| that| this)*( visually| graphically| in 3d| as (an? )?(animation|visual|graphic|picture|image))?[.!?]?$/,
    /^(a |the )?(visual|animation|demo|graphic|picture)( of (it|that|this))?( please)?[.!?]?$/,
    /^what does (it|that) look like[.!?]?$/,
  ],
  sv: [
    /^(snälla |nu |ok(ej)? )?(visa|visualisera|animera|rita|rendera)( mig| oss| det| den| detta| det där)*( visuellt| grafiskt| i 3d| som (en |ett )?(animation|visualisering|bild))?[.!?]?$/,
    /^(en |ett |den |det )?(visualisering|animation|demo|bild)( av (det|den|detta))?( tack)?[.!?]?$/,
    /^hur ser (det|den) ut[.!?]?$/,
  ],
};

// ---------------------------------------------------------------------------
// The registry. One entry per demonstrable surface. `subject` is the NOUN half
// of the ask; `always` are phrasings so specific to the surface that they need
// no verb alongside ("watch builder" is never a research question about
// horology).

export const DEMOS = [
  {
    id: "space",
    kind: "space",
    path: "/space/",
    title: { en: "Space animations", sv: "Rymdanimationer" },
    blurb: {
      en: "Playable wireframe animations — rotate, zoom, and read the real distances.",
      sv: "Spelbara wireframe-animationer — rotera, zooma och läs de verkliga avstånden.",
    },
    // Subject matching is space-core.js's job (SPACE_MATCHERS). Listed here
    // only so the registry is the complete picture of what can be demoed.
    subject: { en: [], sv: [] },
    always: { en: [], sv: [] },
  },
  {
    id: "watch",
    kind: "watch",
    path: "/watch/",
    title: { en: "The NHxx watch builder", sv: "NHxx-klockbyggaren" },
    blurb: {
      en: "Pick a case, dial and hands — the watch assembles in 3D. Rotate it, zoom it, kill the lights to see the lume, and check the fit before you buy the parts.",
      sv: "Välj boett, urtavla och visare — klockan byggs ihop i 3D. Rotera, zooma, släck lamporna för att se lysmassan och kontrollera passformen innan du köper delarna.",
    },
    // `watch` is a common English verb ("watch out for…"), so the bare noun
    // never qualifies on its own — it needs a build/mod word or a SHOW_VERB
    // beside it. The movement families and "watch mod" are unambiguous.
    subject: {
      en: [
        /\bnh ?3[568]\b/,
        /\bnhxx\b/,
        /\bseiko\b/,
        /\bwatch(es)?\b/,
        /\bwrist ?watch(es)?\b/,
        /\bwatch (mod|modding|movement|case|dial|bezel|lume)\b/,
      ],
      sv: [
        /\bnh ?3[568]\b/,
        /\bnhxx\b/,
        /\bseiko\b/,
        /klock(a|an|or|orna)/,
        /armbandsur|\bur\b/,
        /urtavl(a|an|or)|\bboett(et)?\b|visar(e|na)/,
      ],
    },
    always: {
      en: [
        /\bwatch (builder|configurator|designer)\b/,
        /\bbuild (a|your|my|the) (own )?watch\b/,
        /\bwatch mod(ding)?\b/,
        /\bnh ?3[568] (mod|build)/,
      ],
      sv: [
        /klockbyggar(e|en)|klock-?byggare/,
        /bygg(a)? (en |din |min )?(egen )?klocka/,
        /klockmod(ding)?|moddad? klocka/,
      ],
    },
  },
];

/** @param {string} id */
export function demoById(id) {
  return DEMOS.find((d) => d.id === id) || null;
}

/** @param {unknown} text */
function normalize(text) {
  if (typeof text !== "string" || !text) return "";
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Does this message read as a request to be SHOWN something? Returns the
 * language the ask was phrased in — or "neutral" when the only thing that
 * fired is a word both languages share ("demo"), in which case the subject
 * decides. "" when it is not a demo ask at all.
 * @param {unknown} text
 * @returns {""|"en"|"sv"|"neutral"}
 */
export function showVerbLang(text) {
  const t = normalize(text);
  if (!t) return "";
  for (const re of SHOW_VERBS.sv) if (re.test(t)) return "sv";
  for (const re of SHOW_VERBS.en) if (re.test(t)) return "en";
  for (const re of SHOW_VERBS.neutral) if (re.test(t)) return "neutral";
  return "";
}

/**
 * Is this message a BARE visual ask — one that carries the request but no
 * subject, so its subject is the previous turn? ("Show me visually.")
 * @param {unknown} text
 * @returns {boolean}
 */
export function isBareShowAsk(text) {
  const t = normalize(text).replace(/[,;]/g, "");
  if (!t || t.length > 60) return false;
  for (const re of BARE_SHOW.sv) if (re.test(t)) return true;
  for (const re of BARE_SHOW.en) if (re.test(t)) return true;
  return false;
}

/**
 * The single-message gate: does this text ask for one of the registry's
 * surfaces? Returns a resolved match or null. Never throws, no side effects.
 *
 * Space wins ties: its scenes render inline and are the more specific answer
 * whenever both fire ("show me a rocket launch watch" is not a real ask, but
 * the ordering has to be defined).
 *
 * @param {unknown} text
 * @returns {{id: string, kind: string, lang: "en"|"sv", path: string,
 *            title: {en: string, sv: string}, blurb: {en: string, sv: string},
 *            sceneId?: string} | null}
 */
export function demoIntentMatch(text) {
  const t = normalize(text);
  if (!t) return null;

  // 1. The /space/ archive, through its own matcher — one space gate, no drift.
  const space = spaceIntentMatch(t);
  if (space) {
    const entry = demoById("space");
    if (entry) {
      return {
        id: entry.id,
        kind: entry.kind,
        lang: space.lang,
        path: entry.path,
        title: entry.title,
        blurb: entry.blurb,
        sceneId: space.id,
      };
    }
  }

  // 2. Non-space surfaces: an unmistakable phrase, or a subject with a show verb.
  // A verb that named its language ("visa mig") is the strongest signal the
  // user gave, so its language is tried first and kept; otherwise the language
  // is whichever pattern set the SUBJECT matched, English preferred on a tie
  // (both sets carry "seiko", only the Swedish one carries "urtavlan").
  const verbLang = showVerbLang(t);
  const order = verbLang === "sv" ? /** @type {const} */ (["sv", "en"]) : /** @type {const} */ (["en", "sv"]);
  for (const d of DEMOS) {
    if (d.kind === "space") continue;
    for (const lang of order) {
      const always = d.always[lang].some((re) => re.test(t));
      const subject = d.subject[lang].some((re) => re.test(t));
      if (!always && !(subject && verbLang)) continue;
      return {
        id: d.id,
        kind: d.kind,
        lang: verbLang === "en" || verbLang === "sv" ? verbLang : lang,
        path: d.path,
        title: d.title,
        blurb: d.blurb,
      };
    }
  }
  return null;
}

/**
 * The gate the chat clients and the pipeline actually call: `text` with the
 * PREVIOUS user message behind it. A bare visual ask ("Show me visually")
 * inherits the turn before it — the exact sequence feedback #50 reported —
 * and nothing else does, so a subject-carrying message is always resolved on
 * its own terms.
 *
 * @param {unknown} text the current user message
 * @param {unknown} [priorText] the user message before it, if any
 * @returns {ReturnType<typeof demoIntentMatch>}
 */
export function demoIntent(text, priorText = "") {
  const direct = demoIntentMatch(text);
  if (direct) return direct;
  if (!isBareShowAsk(text)) return null;
  return demoIntentMatch(priorText);
}

/**
 * The English title fed to the answer prompts when a NON-SPACE surface is
 * mounted, or "" — the `demoSurface` prompt input, the twin of `spaceScene`.
 * English because it feeds a prompt, not the UI (every mount captions itself in
 * the matched language).
 *
 * @param {unknown} text
 * @param {unknown} [priorText]
 * @returns {string}
 */
export function demoSurfaceTitle(text, priorText = "") {
  const m = demoIntent(text, priorText);
  return m && m.kind !== "space" ? m.title.en : "";
}
