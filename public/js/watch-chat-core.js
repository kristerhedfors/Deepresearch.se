// @ts-check
// The CONVERSATIONAL layer over the NHxx watch builder: the pure core that
// turns plain-text chat messages into builds, and a build into the text that
// goes back — what changed, what is worth changing next, and the block the
// answer model is told about.
//
// WHY THIS EXISTS (feedback #52, 2026-07-30). Feedback #49 wired "Seiko watch
// demo" to the builder, but only as a CARD: a link out of the conversation.
// The reply to that was precise about what was actually wanted:
//
//   "i want the watch builder to be inline so I get the watch animation here
//    and suggestions on what one can change through text commands. Make it an
//    mcp server with a bunch of tools and every new reply contains a new watch
//    animation with text on what changed"
//
// So the builder moves INTO the turn. Three deterministic jobs live here, and
// every one of them is the same function whether it is called by the browser
// embed (public/js/watch-embed.js), by the answer prompt (src/pipeline.js via
// the src/watch-chat.js façade), or by an external agent over MCP
// (src/watch-tools.js):
//
//   1. parseWatchCommand  — one message → a build delta ("pepsi bezel",
//      "svart urtavla och jubilee-band", "lights out", "randomize").
//   2. watchThread        — the WHOLE conversation → the build as it stands at
//      the turn being answered, plus what the last message changed. Derived,
//      never stored, so a reloaded conversation rebuilds the identical watch
//      from the identical messages (the same rule the space embed and the demo
//      card follow — no embeds-registry entry, no drift).
//   3. changeSummary / suggestCommands / watchPromptBlock — the text sides.
//
// NO FUNCTION CALLING (invariant 1): the command parser is regex + a scored
// alias index over the catalogue, not a model call. It runs identically on the
// client, in the Worker and in a Node test, and it cannot fail a request.
//
// EN + SV PARITY (invariant 6): every slot word and every option alias carries
// Swedish with the same breadth as English. Mind the JS `\b` trap that
// public/js/demo-core.js documents — a word boundary next to å/ä/ö never fires,
// because those are not ASCII word characters — so Swedish patterns anchor on
// affixes and spaces rather than a trailing \b.
//
// Lives under public/js/ for the reason watch-core.js does: the browser can
// only import served modules, the Worker bundler imports from anywhere — one
// implementation, two faces (façade: src/watch-chat.js).

import { demoIntent } from "./demo-core.js";
import {
  SLOTS,
  DEFAULT_BUILD,
  slotOptions,
  part,
  normalizeBuild,
  checkBuild,
  buildSpec,
  encodeBuild,
  mm,
} from "./watch-core.js";

/**
 * @typedef {{ slot: string, slotName: {en: string, sv: string},
 *             from: {id: string, name: {en: string, sv: string}},
 *             to: {id: string, name: {en: string, sv: string}} }} WatchChange
 */
/**
 * @typedef {{ lume?: boolean, top?: boolean, reset?: boolean }} WatchView
 */

// ---------------------------------------------------------------------------
// Slot words — the NOUN that says which family a value belongs to. A value
// whose alias is ambiguous across slots ("black", "blue", "steel") only counts
// when one of these sits near it, which is what keeps "blue dial and green
// bezel" from setting the dial twice.

/** @type {Record<string, RegExp[]>} */
const SLOT_WORDS = {
  movement: [/\bmovements?\b/, /\bcalib(er|re)s?\b/, /\bmvmt\b/, /urverk(et)?/, /kaliber(n)?/],
  case: [/\bcases?\b/, /\bhousing\b/, /boett(et|en)?/, /\bkåp(a|an)/],
  finish: [/\bfinish(es)?\b/, /\bcoating\b/, /\bplating\b/, /ytbehandling(en)?/, /\bfinish/, /belägg(ning|ningen)/],
  insert: [/\bbezels?\b/, /\binserts?\b/, /\bl[üu]nett(en|inl[äa]gg(et)?)?/, /\binl[äa]gg(et)?/],
  dial: [/\bdials?\b/, /\bfaces?\b/, /urtavl(a|an|or|orna)/, /\btavl(a|an|or)/],
  chapterRing: [/\bchapter ?rings?\b/, /\bminute track\b/, /kapitelring(en)?/, /minutskal(a|an)/],
  hands: [/\bhands?\b/, /\bhandsets?\b/, /visar(e|en|na)/, /visarset(et)?/],
  // Swedish compounds the noun onto the material — "safirglas", "mineralglas",
  // "urglas" — and a leading \b cannot see inside a compound, so each has to be
  // listed. Left as its own class rather than a bare /glas/, which would also
  // fire on "glasögon".
  crystal: [/\bcrystals?\b/, /\bglass\b/, /\bglas(et)?\b/, /(safir|mineral|ur|sapphire)glas(et)?/, /kristall(en)?/],
  crown: [/\bcrowns?\b/, /kron(a|an)/],
  caseback: [/\bcase ?backs?\b/, /\bbacks?\b/, /boettbotten/, /bakboett(et)?/, /\bbaksid(a|an)/],
  strap: [/\bstraps?\b/, /\bbracelets?\b/, /\bband(et)?\b/, /armband(et)?/, /\blänk(en)?/],
};

// ---------------------------------------------------------------------------
// The alias index. Two tiers, because the two behave differently:
//
//   strong — unique enough across the WHOLE catalogue to set its slot with no
//            slot word anywhere ("pepsi", "jubilee", "snowflake", "62MAS").
//   weak   — real names for the option but ambiguous on their own, above all
//            the colours ("black" is a dial, an insert AND a finish). Counts
//            only within NEAR_CHARS of one of its slot's words.
//
// Every option's own catalogue name (EN and SV) is folded in automatically as a
// weak term by buildTermIndex below, so this table only carries what a person
// would actually TYPE that the name does not already cover. Longest match wins,
// which is what resolves "mini turtle" against "turtle" without an ordering
// rule (see scoreOptions).

/** @type {Record<string, Record<string, {strong?: (string|RegExp)[], weak?: (string|RegExp)[]}>>} */
const ALIASES = {
  movement: {
    nh35: { strong: [/\bnh ?35\b/], weak: ["date", "datum"] },
    nh36: { strong: [/\bnh ?36\b/], weak: [/\bday ?\+? ?date\b/, /veckodag/, /\bdag ?\+? ?datum\b/] },
    nh34: { strong: [/\bnh ?34\b/], weak: [/\bgmt\b/, /andra tidszon/, /second time ?zone/] },
    nh38: { strong: [/\bnh ?38\b/], weak: [/open ?heart/, /öppet hj[äa]rta/, /\bno date\b/, /utan datum/] },
    nh70: { strong: [/\bnh ?70\b/], weak: [/skelett(erad|urverk)?/, /skeleton movement/] },
  },
  case: {
    skx007: { strong: [/\bskx ?007\b/, /\bskx\b(?! ?013)/, /\bsrpd\b/], weak: [] },
    "skx-ncg": { strong: [/no crown ?guards?/, /utan kronskydd/, /\bncg\b/], weak: [] },
    "skx-c3": { strong: [/crown at 3/, /krona vid 3/, /\bc3 crown\b/], weak: [] },
    sub: { strong: [/\bsub(mariner)?[- ]?(style|dyk)?\b/], weak: [] },
    // "slim" and "tunn" are unique to this case in the whole catalogue, so they
    // fire alone — but the LONGER phrase has to be listed too, or the plain
    // "sub" pattern above out-scores it on "sub-style slim" (longest match wins).
    "sub-slim": { strong: [/sub[- ]?(style|dykare)?,? ?slim/, /sub[- ]?dykare,? ?tunn/, /slim sub/, /tunn sub/, /\bslim\b/, /\btunn(a)?\b/], weak: [] },
    "turtle-skx": { strong: [/\bturtle\b/, /\bsköldpadd(a|an)/], weak: [] },
    "srp-turtle": { strong: [/\bsrp ?77[0-9]?\b/, /\bsrp turtle\b/, /native turtle/], weak: [] },
    "mini-turtle": { strong: [/\bmini ?turtle\b/, /\bmini ?sköldpadd(a|an)/, /\bskx ?013 turtle\b/], weak: [] },
    skx013: { strong: [/\bskx ?013\b/, /\bsmall diver\b/, /\bliten dykare\b/], weak: [] },
    "62mas": { strong: [/\b62 ?mas\b/, /vintage diver/, /vintagedykare/], weak: [] },
    willard: { strong: [/\bwillard\b/, /\b6105\b/, /\bturtle 6105\b/], weak: [] },
    samurai: { strong: [/\bsamurai\b/], weak: [] },
    sumo: { strong: [/\bsumo\b/], weak: [] },
    tuna: { strong: [/\btuna\b/, /\bshrouded\b/, /\btonfisk(en)?/], weak: [] },
    mm300: { strong: [/\bmm ?300\b/, /marinemaster/, /marine ?master/], weak: [] },
    "planet-ocean": { strong: [/planet ?ocean/, /\bpo ?case\b/], weak: [] },
    // The "3" lookahead was there for the 3-6-9 DIAL; "ii" and "2" join it now
    // that an Explorer II case exists, or "explorer" out-scores the longer name
    // and "change the case to Explorer II style" quietly fits an Explorer I.
    explorer: { strong: [/\bexplorer\b(?! ?(3|ii\b|2\b))/], weak: [] },
    "explorer-2": { strong: [/\bexplorer ?(ii|2)\b/, /\bexp ?(ii|2)\b/, /24[- ]?(hour|timmar)s? bezel/], weak: [] },
    alpinist: { strong: [/\balpinist\b/], weak: [] },
    // The two integrated-bracelet cases. "royal oak" and "prx" are unmistakable
    // in this catalogue; "ap" alone is not (it is two letters), so it needs the
    // word case beside it.
    "royal-oak": { strong: [/\broyal ?oak\b/, /\bap ?(style|case|royal)/, /\boctagon(al)?\b/, /\b[åa]ttakant(ig|ad)?/], weak: [] },
    prx: { strong: [/\bprx\b/, /super ?player/, /integrated ?bracelet/, /integrerad ?l[äa]nk/], weak: [] },
    field: { strong: [/\bfield ?(38|watch)?\b/, /f[äa]ltklock(a|an)/, /f[äa]ltur(et)?/], weak: [] },
    monster: { strong: [/\bmonster\b/], weak: [] },
  },
  finish: {
    brushed: { strong: [], weak: [/brushed/, /borstat|borstad/, /\bsatin\b/] },
    polished: { strong: [], weak: [/polished/, /polerat|polerad/, /\bshiny\b/, /\bblank(t)?\b/] },
    blasted: { strong: [/bead ?blast(ed)?/], weak: [/blasted/, /bl[äa]strat/, /\bmatte case\b/] },
    "pvd-black": { strong: [/\bpvd\b/, /\bdlc\b/, /murdered ?out/], weak: [/black/, /svart/, /\bmörk(t)?\b/] },
    gold: { strong: [/gold ?plated/, /guldpl[äa]terad/], weak: [/\bgold\b/, /\bguld/] },
    bronze: { strong: [/\bbronze\b/, /\bbrons\b/], weak: [] },
    titanium: { strong: [/\btitanium\b/, /\btitan\b/], weak: [] },
  },
  insert: {
    "alu-black": { strong: [/alumin(i)?um/], weak: [/black/, /svart/] },
    "ceramic-black": { strong: [/ceramic black/, /keramik svart/], weak: [/ceramic/, /keramik/, /black/, /svart/] },
    pepsi: { strong: [/\bpepsi\b/, /blue ?\/? ?red/, /bl[åa] ?\/? ?röd/], weak: [] },
    batman: { strong: [/\bbatman\b/, /blue ?\/? ?black/, /bl[åa] ?\/? ?svart/], weak: [] },
    green: { strong: [/\bhulk\b/, /ceramic green/, /keramik grön/], weak: [/green/, /grön(t)?/] },
    "gmt-24": { strong: [/24[- ]?hour/, /24[- ]?h(our)? ?(gmt|scale)/, /24[- ]?timmars/], weak: [/\bgmt\b/] },
    "steel-plain": { strong: [/no insert/, /utan inl[äa]gg/, /plain steel bezel/], weak: [/plain/, /\bsteel\b/, /\bst[åa]l\b/, /\bblank/] },
  },
  dial: {
    "skx-black": { strong: [/matte black dial/, /matt svart urtavla/], weak: [/black/, /svart/, /\bmatte\b/, /\bmatt(a)?\b/] },
    "sub-black": { strong: [/gloss black dial/, /blank svart urtavla/], weak: [/gloss/, /blank(t)?/, /\bshiny\b/] },
    // NOTE the lookahead instead of a trailing \b. "blå" ends in a non-ASCII
    // letter, so `\bblå\b` NEVER fires — the JS word-boundary trap invariant 6
    // warns about. `(?![a-zà-ÿ])` is the boundary that actually works in
    // Swedish, and it still keeps "blå" out of the middle of a longer word.
    "sunburst-blue": { strong: [/sunburst blue/, /solstr[åa]lebl[åa]/], weak: [/\bblue\b/, /\bbl[åa](tt|a)?(?![a-zà-ÿ])/, /sunburst/, /solstr[åa]le/] },
    "sunburst-green": { strong: [/sunburst green/, /solstr[åa]legrön/], weak: [/green/, /grön(t)?/] },
    "gilt-black": { strong: [/\bgilt\b/, /vintage gilt/], weak: [/\bgold text\b/, /guldtext/] },
    "62mas-cream": { strong: [/\bcream\b/, /gr[äa]ddvit/, /\bpatina dial\b/], weak: [/\bwhite\b/, /\bvit(t)?\b/] },
    california: { strong: [/california/, /\bcali dial\b/], weak: [/split dial/, /halv romerska/] },
    "explorer-369": { strong: [/3[- ]?6[- ]?9/, /explorer dial/], weak: [] },
    "gs-white": { strong: [/snowflake dial/, /snöflings?(urtavla|tavla)/, /\bgs white\b/], weak: [/\bwhite\b/, /\bvit(t)?\b/, /textur(ed|erad)/] },
    // Same non-ASCII boundary as sunburst-blue above: "grå" cannot use \b.
    "fume-grey": { strong: [/fum[eé]/], weak: [/\bgrey\b/, /\bgray\b/, /\bgr[åa](tt|a)?(?![a-zà-ÿ])/] },
    salmon: { strong: [/\bsalmon\b/, /\blax(rosa|f[äa]rgad)?\b/], weak: [/\bpink\b/, /\brosa\b/, /dress dial/, /kl[äa]dtavl(a|an)/] },
    "daydate-black": { strong: [/day[- ]?date dial/, /veckodag(s)?(urtavla|tavla)/], weak: [] },
    "gmt-black": { strong: [/gmt dial/, /gmt[- ]?urtavla/], weak: [] },
    openheart: { strong: [/open ?heart/, /öppet hj[äa]rta/, /skeleton dial/, /skelett(urtavla|tavla)/], weak: [] },
  },
  chapterRing: {
    "black-minutes": { strong: [], weak: [/black/, /svart/] },
    "white-minutes": { strong: [], weak: [/\bwhite\b/, /\bvit(t)?\b/] },
    "red-accent": { strong: [/red 15/, /röd 15/, /red accent/, /röd accent/], weak: [/\bred\b/, /\bröd(t)?\b/] },
    steel: { strong: [/bare steel ring/, /rent st[åa]l/], weak: [/\bsteel\b/, /\bst[åa]l\b/, /\bnone\b/, /\bingen\b/] },
  },
  hands: {
    "skx-dive": { strong: [/skx (dive )?hands/, /skx[- ]?dykarvisare/], weak: [/dive/, /dykar/, /\bstock\b/, /original/] },
    mercedes: { strong: [/mercedes/], weak: [] },
    snowflake: { strong: [/snowflake hands/, /snöflingsvisare/, /\bsnowflake\b/, /snöflinga/], weak: [] },
    plongeur: { strong: [/plongeur/, /\bpencil hands\b/], weak: [] },
    cathedral: { strong: [/cathedral/, /katedral/], weak: [] },
    dauphine: { strong: [/dauphine/], weak: [] },
    baton: { strong: [/\bbaton(s)?\b/, /\bbatong(er)?\b/, /\bstick hands\b/], weak: [/\bplain\b/, /\benkla\b/] },
    "gmt-arrow": { strong: [/gmt arrow/, /gmt[- ]?pil(set)?/, /arrow hand/, /pilvisare/], weak: [] },
  },
  crystal: {
    "dd-sapphire": { strong: [/double ?dom(e|ed) sapphire/, /dubbelkupad safir/], weak: [/sapphire/, /safir/, /dom(e|ed)/, /kupa(d|t)/] },
    // Same longest-match rule as sub-slim: without the full phrase, the clear-AR
    // sibling's longer name wins on "double-dome sapphire blue AR".
    "dd-sapphire-blue": { strong: [/double ?dom(e|ed) sapphire,? ?blue/, /dubbelkupad safir,? ?bl[åa]/, /blue ?ar/, /bl[åa] ?ar/, /blue anti[- ]?refl/, /bl[åa] antireflex/], weak: [] },
    "flat-sapphire": { strong: [/flat sapphire/, /plan(t|a)? ?(safir|sapphire)(glas(et)?)?/], weak: [/\bflat\b/, /\bplan(t)?\b/] },
    "box-sapphire": { strong: [/box sapphire/, /boxsafir/, /\bbox crystal\b/], weak: [/\bbox\b/, /vintage glas/] },
    "domed-hardlex": { strong: [/hardlex/], weak: [/mineral/, /\bstock glass\b/, /originalglas/] },
  },
  crown: {
    "signed-screw": { strong: [/signed crown/, /signerad kron(a|an)/], weak: [/signed/, /signerad/] },
    "plain-screw": { strong: [/unsigned crown/, /osignerad kron(a|an)/], weak: [/unsigned/, /osignerad/, /\bplain\b/] },
    fluted: { strong: [/fluted/, /r[äa]fflad/], weak: [] },
    onion: { strong: [/\bonion\b/, /lökkron(a|an)/], weak: [/dress crown/] },
  },
  caseback: {
    "solid-engraved": { strong: [/engraved (case ?)?back/, /graverad (boettbotten|baksida)/], weak: [/engraved/, /graverad/, /\bsolid\b/, /massiv/] },
    display: { strong: [/display (case ?)?back/, /exhibition (case ?)?back/, /genomskinlig (boettbotten|baksida)/, /utst[äa]llningsboett/], weak: [/\bdisplay\b/, /\bsee[- ]?through\b/, /\bglass back\b/] },
    "solid-brushed": { strong: [/brushed (case ?)?back/, /borstad (boettbotten|baksida)/], weak: [] },
  },
  strap: {
    oyster: { strong: [/oyster/], weak: [/bracelet/, /\bl[äa]nk(en)?\b/, /\bsteel band\b/, /st[åa]lband/] },
    jubilee: { strong: [/jubilee/], weak: [] },
    waffle: { strong: [/waffle/, /v[åa]ffel/], weak: [/rubber/, /gummi/, /silicone/, /silikon/] },
    tropic: { strong: [/tropic/], weak: [] },
    nato: { strong: [/\bnato\b/, /\bzulu\b/], weak: [/fabric/, /tyg/, /canvas/] },
    leather: { strong: [/leather/, /l[äa]der/], weak: [] },
    mesh: { strong: [/milanese/, /\bmesh\b/], weak: [] },
  },
};

// How far a WEAK alias may sit from one of its slot's words and still count.
// Wide enough for "make the dial sunburst blue" and "urtavlan ska vara blå",
// narrow enough that "blue dial and green bezel" does not set the dial twice.
const NEAR_CHARS = 30;

// ---------------------------------------------------------------------------
// View + whole-build commands. These change what you SEE or reroll everything
// rather than setting one slot.

const VIEW_COMMANDS = {
  lumeOn: [/lights? out/, /\blume\b/, /\bglow\b/, /in the dark/, /sl[äa]ck lampor(na)?/, /lysmass(a|an)/, /i mörkret/, /\bmörkt\b/],
  lumeOff: [/lights? on/, /\bdaylight\b/, /t[äa]nd lampor(na)?/, /\bdagsljus\b/],
  top: [/top[- ]?(down|view)/, /straight down/, /from above/, /ovanifr[åa]n/, /rakt ovanifr[åa]n/, /\bplanvy\b/],
  reset: [/reset (the )?view/, /\bre-?centre\b/, /\bre-?center\b/, /[åa]terst[äa]ll (vyn|kameran)/, /\bnollst[äa]ll vyn\b/],
};

const RESET_BUILD = [
  /reset (the )?(build|watch|everything)/, /start over/, /back to (the )?default/,
  /b[öo]rja om/, /[åa]terst[äa]ll (bygget|klockan|allt)/, /tillbaka till standard/,
];

const RANDOM_BUILD = [
  /\brandom(i[sz]e|ise)?\b/, /surprise me/, /\bshuffle\b/, /\breroll\b/, /pick for me/,
  /\bslump(a|mässig|mässigt)?\b/, /överraska mig/, /v[äa]lj (åt|for) mig/, /\bblanda\b/,
];

// ---------------------------------------------------------------------------
// Building the searchable index once, at module load. Auto-folds every
// catalogue name (EN + SV) in as a weak term so ALIASES above only carries
// what a person types that the name does not already cover.

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A catalogue name reduced to the phrases worth matching: the whole thing, and
 * each comma/dash-separated part of it. "NH35 — date" gives "nh35" and "date";
 * "Ceramic, black" gives "ceramic black", "ceramic" and "black". Parentheticals
 * go — "(NH36)" and "(shrouded)" are annotations, not what anyone types.
 *
 * Separator commas and em-dashes flatten; an INTRA-WORD hyphen does not.
 * "Unsigned, screw-down" has to keep its hyphen, because flattening it made the
 * whole-name pattern miss the very command that names it — and the shorter
 * "signed" then matched inside "unsigned" and set the opposite crown.
 * @param {string} name
 * @returns {string[]}
 */
function namePhrases(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return [];
  const out = new Set();
  const whole = base.replace(/[,—–]+/g, " ").replace(/\s+/g, " ").trim();
  if (whole) out.add(whole);
  for (const piece of base.split(/[,—–]|\s-\s/)) {
    const p = piece.replace(/\s+/g, " ").trim();
    if (p && p.length >= 3) out.add(p);
  }
  return [...out];
}

/**
 * A literal phrase as a tolerant pattern: spaces optional, and a hyphen
 * interchangeable with a space, so "sub-style" and "sub style" are one term.
 * @param {string} phrase
 */
function phrasePattern(phrase) {
  return new RegExp(escapeRe(phrase).replace(/ /g, " ?").replace(/-/g, "[- ]?"));
}

/** @param {string|RegExp} term */
function toRegExp(term) {
  return term instanceof RegExp ? term : new RegExp(escapeRe(term));
}

/**
 * The index every parse runs against: per slot, per option, the strong and
 * weak patterns. Built once — the catalogue is committed data, so there is
 * nothing to invalidate.
 * @returns {Record<string, Array<{id: string, strong: RegExp[], weak: RegExp[]}>>}
 */
function buildTermIndex() {
  /** @type {Record<string, Array<{id: string, strong: RegExp[], weak: RegExp[]}>>} */
  const index = {};
  for (const slot of SLOTS) {
    /** @type {Array<{id: string, strong: RegExp[], weak: RegExp[]}>} */
    const rows = [];
    for (const option of slotOptions(slot.key)) {
      const curated = (ALIASES[slot.key] || {})[option.id] || {};
      const weak = new Set(/** @type {RegExp[]} */ ([]));
      // The id itself, hyphens as optional separators: "sunburst-blue" typed
      // as "sunburst blue" or "sunburst_blue" is the same ask.
      weak.add(new RegExp(escapeRe(option.id).replace(/-/g, "[- _]?")));
      for (const lang of ["en", "sv"]) {
        for (const phrase of namePhrases(option.name ? option.name[lang] : "")) {
          weak.add(phrasePattern(phrase));
        }
      }
      for (const t of curated.weak || []) weak.add(toRegExp(t));
      rows.push({
        id: option.id,
        strong: (curated.strong || []).map(toRegExp),
        weak: [...weak],
      });
    }
    index[slot.key] = rows;
  }
  return index;
}

const TERM_INDEX = buildTermIndex();

/** Every slot key, for callers that want the vocabulary without SLOTS. */
export const WATCH_SLOT_KEYS = SLOTS.map((s) => s.key);

/**
 * The command vocabulary as data — what a UI or an MCP tool can tell a caller
 * is sayable. One row per slot: its bilingual name, its slot words, and every
 * option with the phrases that select it.
 * @returns {Array<{slot: string, name: {en: string, sv: string}, words: string[],
 *                  options: Array<{id: string, name: {en: string, sv: string}, terms: string[]}>}>}
 */
export function commandVocabulary() {
  return SLOTS.map((slot) => ({
    slot: slot.key,
    name: slot.name,
    words: (SLOT_WORDS[slot.key] || []).map((re) => re.source),
    options: slotOptions(slot.key).map((o) => ({
      id: o.id,
      name: o.name,
      terms: [
        ...(TERM_INDEX[slot.key].find((r) => r.id === o.id)?.strong || []),
        ...(TERM_INDEX[slot.key].find((r) => r.id === o.id)?.weak || []),
      ].map((re) => re.source),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Parsing.

/** @param {unknown} text */
function normalize(text) {
  if (typeof text !== "string" || !text) return "";
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** @param {RegExp[]} patterns @param {string} t */
function anyMatch(patterns, t) {
  for (const re of patterns) if (re.test(t)) return true;
  return false;
}

/**
 * Every index in `t` where one of this slot's words appears.
 * @param {string} slotKey @param {string} t @returns {number[]}
 */
function slotWordPositions(slotKey, t) {
  /** @type {number[]} */
  const at = [];
  for (const re of SLOT_WORDS[slotKey] || []) {
    const m = re.exec(t);
    if (m && m.index >= 0) at.push(m.index + m[0].length / 2);
  }
  return at;
}

/**
 * The best option for one slot in this message, or null. Strong terms fire on
 * their own and break ties on the LONGEST matched substring, which is how "mini
 * turtle" beats "turtle" and "sunburst blue" beats "blue" without an ordering
 * rule to maintain. Weak terms need a slot word within NEAR_CHARS and are
 * scored by PROXIMITY to it as well as length — in "blue dial and green bezel"
 * both colours sit inside the dial's window, and only the distance says which
 * one the dial was meant to be.
 * @param {string} slotKey
 * @param {string} t
 * @returns {{id: string, score: number, tier: "strong"|"weak"} | null}
 */
function bestOption(slotKey, t) {
  const near = slotWordPositions(slotKey, t);
  /** @type {{id: string, score: number, tier: "strong"|"weak"} | null} */
  let best = null;
  for (const row of TERM_INDEX[slotKey] || []) {
    for (const re of row.strong) {
      const m = re.exec(t);
      if (!m) continue;
      const score = 1000 + m[0].length;
      if (!best || score > best.score) best = { id: row.id, score, tier: "strong" };
    }
    if (!near.length) continue;
    for (const re of row.weak) {
      const m = re.exec(t);
      if (!m) continue;
      const mid = m.index + m[0].length / 2;
      const dist = Math.min(...near.map((p) => Math.abs(p - mid)));
      if (dist > NEAR_CHARS) continue;
      const score = 100 + m[0].length - dist;
      if (!best || score > best.score) best = { id: row.id, score, tier: "weak" };
    }
  }
  return best;
}

/**
 * A deterministic pseudo-random build. Deterministic is the whole point: a
 * reloaded conversation must rebuild the same watch from the same messages, so
 * "surprise me" cannot reach for Math.random(). The seed is the turn index
 * plus a hash of the message, both of which the transcript already carries.
 * @param {number} seed
 * @returns {Record<string, string>}
 */
export function randomBuild(seed) {
  // xorshift32 — small, deterministic, and good enough to pick list indices.
  let s = (seed | 0) || 1;
  const next = () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return Math.abs(s) / 2147483647;
  };
  /** @type {Record<string, string>} */
  let out = {};
  for (const slot of SLOTS) {
    const options = slotOptions(slot.key);
    out[slot.key] = options[Math.floor(next() * options.length) % options.length].id;
  }
  // A rerolled build that cannot be assembled is a bad demo, so repair the slots
  // the compatibility engine rejects — almost always the dial or the hands
  // against the movement it rolled. Rerolling the offending slot at RANDOM does
  // not converge (a GMT movement needs the one four-hand set, which a coin flip
  // finds about never), so this SCANS the slot for an option that strictly
  // reduces the error count. That is monotonic, so it terminates, and it stays
  // deterministic — which the reload contract requires. The scan starts at a
  // seeded offset so repairs still vary between seeds.
  /** @param {Record<string, string>} candidate */
  const errorCount = (candidate) => checkBuild(candidate).issues.filter((x) => x.level === "error").length;
  for (let round = 0; round < SLOTS.length * 2; round++) {
    const remaining = errorCount(out);
    if (!remaining) break;
    const bad = checkBuild(out).issues.find((x) => x.level === "error");
    if (!bad) break;
    const options = slotOptions(bad.slot);
    const start = Math.floor(next() * Math.max(1, options.length));
    let repaired = false;
    for (let k = 0; k < options.length; k++) {
      const trial = { ...out, [bad.slot]: options[(start + k) % options.length].id };
      if (errorCount(trial) < remaining) {
        out = trial;
        repaired = true;
        break;
      }
    }
    if (!repaired) break;
  }
  return normalizeBuild(out);
}

/** @param {string} s @returns {number} */
function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) | 0;
  }
  return Math.abs(h);
}

/**
 * ONE message against ONE build. Never throws, no side effects: junk in gives
 * an empty delta, which is what lets every caller run it unconditionally.
 *
 * @param {unknown} text the user message
 * @param {Record<string, string> | null | undefined} build the build so far
 * @param {{ seed?: number }} [opts] `seed` makes "randomize" reproducible
 * @returns {{ build: Record<string, string>, changes: WatchChange[], view: WatchView,
 *             reset: boolean, randomized: boolean, touched: boolean }}
 */
export function parseWatchCommand(text, build, opts = {}) {
  const before = normalizeBuild(build);
  const t = normalize(text);
  /** @type {WatchView} */
  const view = {};
  if (!t) return { build: before, changes: [], view, reset: false, randomized: false, touched: false };

  if (anyMatch(VIEW_COMMANDS.lumeOn, t)) view.lume = true;
  else if (anyMatch(VIEW_COMMANDS.lumeOff, t)) view.lume = false;
  if (anyMatch(VIEW_COMMANDS.top, t)) view.top = true;
  if (anyMatch(VIEW_COMMANDS.reset, t)) view.reset = true;

  const reset = anyMatch(RESET_BUILD, t);
  const randomized = !reset && anyMatch(RANDOM_BUILD, t);

  /** @type {Record<string, string>} */
  let after;
  if (reset) {
    after = normalizeBuild(DEFAULT_BUILD);
  } else if (randomized) {
    after = randomBuild(hashText(t) + (opts.seed || 0) * 7919);
  } else {
    after = { ...before };
    for (const slot of SLOTS) {
      const hit = bestOption(slot.key, t);
      if (hit && hit.id !== after[slot.key]) after[slot.key] = hit.id;
    }
  }

  /** @type {WatchChange[]} */
  const changes = [];
  for (const slot of SLOTS) {
    if (after[slot.key] === before[slot.key]) continue;
    const from = part(slot.key, before[slot.key]);
    const to = part(slot.key, after[slot.key]);
    if (!from || !to) continue;
    changes.push({ slot: slot.key, slotName: slot.name, from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } });
  }

  const touched = changes.length > 0 || reset || randomized || Object.keys(view).length > 0;
  return { build: after, changes, view, reset, randomized, touched };
}

/**
 * Does this message read as WATCH talk at all — a slot word, an option term, a
 * view command, or a reset/reroll? This is what keeps the inline builder alive
 * across a follow-up that changed nothing ("what does the lug width mean?")
 * while letting an unrelated question end the thread.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isWatchTalk(text) {
  const t = normalize(text);
  if (!t) return false;
  if (anyMatch(RESET_BUILD, t) || anyMatch(RANDOM_BUILD, t)) return true;
  for (const key of Object.keys(VIEW_COMMANDS)) {
    if (anyMatch(VIEW_COMMANDS[/** @type {keyof typeof VIEW_COMMANDS} */ (key)], t)) return true;
  }
  for (const slot of SLOTS) {
    if (anyMatch(SLOT_WORDS[slot.key] || [], t)) return true;
    for (const row of TERM_INDEX[slot.key] || []) if (anyMatch(row.strong, t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CONTINUATION. A thread has to survive the turn a clarifying question
// produces, and that turn is watch talk in intent but not in vocabulary.
//
// WHY (feedback #55, 2026-07-30). The logged session ran: "Build me a fancy
// seiko watch" → (the assistant asks: features, or looks?) → "Features". Even
// with the widened gate opening turn 1, `isWatchTalk("features")` is false and
// the thread would close on the very turn the user was complaining about — *"I
// see no watch animation"*. But the close rule earns its keep (an unrelated
// question must never be answered with a watch bolted onto it), so it is not
// loosened: instead a bare FRAGMENT — an answer, not a new question — buys the
// thread exactly ONE turn of grace, and a second non-watch turn closes it.
//
// Deterministic and deliberately narrow, the same shape as demo-core.js's
// isBareShowAsk: short, no question mark, no interrogative or imperative
// opener, and not an ask for some OTHER surface. EN + SV at equal breadth
// (invariant 6), with the diacritic-dropped spellings and no trailing \b next
// to å/ä/ö.

const CONTINUATION_MAX_WORDS = 5;
const CONTINUATION_MAX_CHARS = 44;

// A message that OPENS like a new question or a new instruction is a topic
// change however short it is — "compare both", "hitta källor".
const NEW_TOPIC_OPENERS =
  /^(what|whats|why|how|when|where|who|whose|which|can|could|would|should|do|does|did|is|are|was|were|tell|explain|compare|search|find|list|give|show|write|draw|summari[sz]e|translate|define|calculate|check|help|make|build|design|create|open|go|continue|stop|thanks?|thank you)\b/;
const NEW_TOPIC_OPENERS_SV =
  /^(vad|vem|vems|vilken|vilket|vilka|varf[öo]r|hur|n[äa]r|var|kan|kunde|skulle|[äa]r|var det|ber[äa]tta|f[öo]rklara|j[äa]mf[öo]r|s[öo]k|hitta|lista|ge|visa|skriv|rita|sammanfatta|[öo]vers[äa]tt|definiera|r[äa]kna|kolla|hj[äa]lp|g[öo]r|bygg|designa|skapa|[öo]ppna|forts[äa]tt|sluta|tack)\b/;

/**
 * Is this message a bare CONTINUATION of the exchange in progress — an answer
 * to what was just asked ("Features", "the blue one", "båda två") rather than a
 * new subject? Only ever consulted while a thread is already open, and only
 * once in a row.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isContinuationFragment(text) {
  const t = normalize(text).replace(/[.!,;:]+$/g, "").trim();
  if (!t || t.length > CONTINUATION_MAX_CHARS) return false;
  if (t.includes("?")) return false;
  if (t.split(" ").filter(Boolean).length > CONTINUATION_MAX_WORDS) return false;
  if (NEW_TOPIC_OPENERS.test(t) || NEW_TOPIC_OPENERS_SV.test(t)) return false;
  // An ask for a different surface ends this one — "show me visually" after a
  // space scene is that scene's, not the watch's.
  const other = demoIntent(t);
  if (other && other.id !== "watch") return false;
  return true;
}

// ---------------------------------------------------------------------------
// The conversation. DERIVED state, never stored — the same rule the space
// embed and the demo card follow, so a reloaded conversation rebuilds the
// identical watch from the identical messages and no registry can drift.

/**
 * @typedef {{ active: boolean, lang: "en"|"sv", build: Record<string, string>,
 *             changes: WatchChange[], view: WatchView, code: string,
 *             turn: number, opened: boolean, recognized: boolean,
 *             reset: boolean, randomized: boolean }} WatchThreadState
 */

/**
 * Walk the conversation's user messages in order and return the builder's state
 * at the LAST one — which is the turn being answered.
 *
 * The thread OPENS on a watch demo ask (demo-core.js's gate, so "Seiko watch
 * demo" and "visa mig klockbyggaren" open it exactly as they opened the card),
 * carries forward while each following message is watch talk, and CLOSES on a
 * message that is neither. Closing matters as much as opening: an unrelated
 * question must not be answered with a watch bolted on top of it.
 *
 * @param {unknown} userTexts the user messages, oldest first
 * @returns {WatchThreadState}
 */
export function watchThread(userTexts) {
  const texts = Array.isArray(userTexts) ? userTexts.map((x) => (typeof x === "string" ? x : "")) : [];
  /** @type {WatchThreadState} */
  let state = {
    active: false, lang: "en", build: normalizeBuild(DEFAULT_BUILD), changes: [],
    view: {}, code: "", turn: 0, opened: false, recognized: false,
    reset: false, randomized: false,
  };
  // Whether the PREVIOUS turn already spent the one continuation grace. Any
  // real watch talk hands it back.
  let graceSpent = false;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const m = demoIntent(text, i > 0 ? texts[i - 1] : "");
    const isAsk = !!m && m.id === "watch";
    const talk = isWatchTalk(text);
    if (!state.active && !isAsk) continue;
    if (!isAsk && !talk) {
      if (state.active && !graceSpent && isContinuationFragment(text)) {
        // A clarifying answer ("Features"). The build is untouched and the
        // reply says so; the render stays on screen (feedback #55).
        graceSpent = true;
        state = {
          ...state, changes: [], view: {}, turn: state.turn + 1,
          opened: false, recognized: false, reset: false, randomized: false,
        };
        continue;
      }
      // The thread ends here — and stays ended until another explicit ask.
      graceSpent = false;
      state = {
        ...state, active: false, changes: [], view: {},
        opened: false, recognized: false, reset: false, randomized: false,
      };
      continue;
    }
    graceSpent = false;
    const opening = isAsk && !state.active;
    const parsed = parseWatchCommand(text, opening ? DEFAULT_BUILD : state.build, { seed: i + 1 });
    state = {
      active: true,
      lang: isAsk && m ? (m.lang === "sv" ? "sv" : "en") : state.lang,
      build: parsed.build,
      changes: parsed.changes,
      view: parsed.view,
      code: encodeBuild(parsed.build),
      turn: state.turn + 1,
      opened: opening,
      recognized: parsed.touched,
      reset: parsed.reset,
      randomized: parsed.randomized,
    };
  }
  if (state.active && !state.code) state.code = encodeBuild(state.build);
  return state;
}

// ---------------------------------------------------------------------------
// The text sides: what changed, what to try next, and the answer-prompt block.

const SUMMARY_UI = {
  opened: {
    en: "Built to the default SKX007 spec — say what to change.",
    sv: "Byggd enligt standardspecen för SKX007 — säg vad du vill ändra.",
  },
  unchanged: {
    en: "Nothing changed — the build is as it was.",
    sv: "Inget ändrades — bygget är som det var.",
  },
  reset: { en: "Reset to the default build", sv: "Återställd till standardbygget" },
  random: { en: "Rerolled the whole build", sv: "Slumpade om hela bygget" },
  lumeOn: { en: "lights out", sv: "släckta lampor" },
  lumeOff: { en: "lights on", sv: "tända lampor" },
  top: { en: "straight down on the dial", sv: "rakt ovanifrån" },
};

/**
 * "Dial → Sunburst blue · Strap → Jubilee bracelet" — the what-changed line
 * the embed captions itself with and the MCP tools return.
 * @param {WatchChange[]} changes
 * @param {"en"|"sv"} [lang]
 * @param {{ reset?: boolean, randomized?: boolean, view?: WatchView, opened?: boolean }} [flags]
 * @returns {string}
 */
export function changeSummary(changes, lang = "en", flags = {}) {
  const l = lang === "sv" ? "sv" : "en";
  /** @type {string[]} */
  const parts = [];
  if (flags.reset) parts.push(SUMMARY_UI.reset[l]);
  else if (flags.randomized) parts.push(SUMMARY_UI.random[l]);
  for (const c of Array.isArray(changes) ? changes : []) {
    parts.push(`${c.slotName[l]} → ${c.to.name[l]}`);
  }
  if (flags.view) {
    if (flags.view.lume === true) parts.push(SUMMARY_UI.lumeOn[l]);
    if (flags.view.lume === false) parts.push(SUMMARY_UI.lumeOff[l]);
    if (flags.view.top) parts.push(SUMMARY_UI.top[l]);
  }
  if (parts.length) return parts.join(" · ");
  if (flags.opened) return SUMMARY_UI.opened[l];
  return SUMMARY_UI.unchanged[l];
}

// The command phrasings suggested back to the user. Deliberately UNIFORM —
// "change the <slot> to <part>" / "byt <slot> till <part>" — for two reasons:
// it sidesteps the article and definite-form grammar that per-slot phrasings
// need in both languages, and it puts the slot word right next to the value, so
// a suggestion is always a command the parser above accepts. That round trip is
// unit-tested over the WHOLE catalogue, both languages.
const SUGGEST_TEMPLATES = {
  en: {
    movement: "the movement", case: "the case", finish: "the finish",
    insert: "the bezel insert", dial: "the dial", chapterRing: "the chapter ring",
    hands: "the hands", crystal: "the crystal", crown: "the crown",
    caseback: "the case back", strap: "the strap",
  },
  sv: {
    movement: "urverk", case: "boett", finish: "ytbehandling",
    insert: "lünettinlägg", dial: "urtavla", chapterRing: "chapter ring",
    hands: "visare", crystal: "glas", crown: "krona",
    caseback: "boettbotten", strap: "band",
  },
};

/**
 * A catalogue name as a person would TYPE it in a command: parentheticals gone
 * (they are annotations — "(NH36)", "(shrouded)"), commas and dashes flattened
 * to spaces so the whole-name alias matches. "Ceramic, green" → "Ceramic green".
 * @param {string} name
 * @returns {string}
 */
function commandName(name) {
  return String(name || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[,—–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One slot + one option as a typeable command, in `lang`.
 * @param {string} slotKey @param {{name: {en: string, sv: string}}} option @param {"en"|"sv"} lang
 * @returns {string}
 */
export function commandFor(slotKey, option, lang = "en") {
  const l = lang === "sv" ? "sv" : "en";
  const slotWord = SUGGEST_TEMPLATES[l][/** @type {keyof typeof SUGGEST_TEMPLATES["en"]} */ (slotKey)];
  if (!slotWord || !option) return "";
  const name = commandName(option.name ? option.name[l] : "");
  return l === "sv" ? `byt ${slotWord} till ${name}` : `change ${slotWord} to ${name}`;
}

const VIEW_SUGGESTIONS = [
  { en: "lights out", sv: "släck lamporna" },
  { en: "show it straight down", sv: "visa den rakt ovanifrån" },
  { en: "surprise me", sv: "överraska mig" },
];

/**
 * Four commands worth trying next, rotated so consecutive replies do not
 * suggest the same things. A candidate is only offered when applying it would
 * NOT introduce a new compatibility error, so the tool never talks the user
 * into a build it will then complain about.
 *
 * @param {Record<string, string> | null | undefined} build
 * @param {"en"|"sv"} [lang]
 * @param {number} [turn] the turn number, for the rotation
 * @returns {string[]}
 */
export function suggestCommands(build, lang = "en", turn = 0) {
  const l = lang === "sv" ? "sv" : "en";
  const current = normalizeBuild(build);
  const baseErrors = checkBuild(current).issues.filter((x) => x.level === "error").length;
  /** @type {string[]} */
  const out = [];
  const order = SLOTS.map((_, i) => SLOTS[(i + (turn | 0)) % SLOTS.length]);
  for (const slot of order) {
    if (out.length >= 3) break;
    const options = slotOptions(slot.key);
    if (options.length < 2) continue;
    const at = options.findIndex((o) => o.id === current[slot.key]);
    // Walk forward from the current pick so the suggestion always changes
    // something, and skip any option that would break the build.
    for (let step = 1; step < options.length; step++) {
      const candidate = options[(at + step + (turn | 0)) % options.length];
      if (!candidate || candidate.id === current[slot.key]) continue;
      const trial = { ...current, [slot.key]: candidate.id };
      if (checkBuild(trial).issues.filter((x) => x.level === "error").length > baseErrors) continue;
      const command = commandFor(slot.key, candidate, l);
      if (!command) break;
      out.push(command);
      break;
    }
  }
  out.push(VIEW_SUGGESTIONS[(turn | 0) % VIEW_SUGGESTIONS.length][l]);
  return out.slice(0, 4);
}

/**
 * The permalink into the FULL builder for a build — the app door.
 *
 * WHY IT IS ITS OWN FUNCTION (feedback #56, 2026-07-30): *"building through the
 * chatbot interface is unavoidably clunky and the wrong approach — send user to
 * the app immediately."* The owner kept both surfaces, so the inline card LEADS
 * with this link rather than trailing it, and the hash carries the build the
 * turn is showing, so the app opens on that exact watch and nothing is retyped.
 * Same shape `/watch/` writes back into its own address bar (public/watch/
 * watch.js), so the round trip is a fact rather than a convention.
 *
 * @param {Record<string, string> | string | null | undefined} build a build, or an
 *   already-encoded permalink code
 * @returns {string}
 */
export function builderLink(build) {
  const code = typeof build === "string" ? build : encodeBuild(normalizeBuild(build));
  return code ? `/watch/#${encodeURIComponent(code)}` : "/watch/";
}

/**
 * The one-line spec a caption can carry: case diameter × lug-to-lug × thick,
 * lug width, and the parts-cost band.
 * @param {Record<string, string> | null | undefined} build
 * @param {"en"|"sv"} [lang]
 * @returns {string}
 */
export function specLine(build, lang = "en") {
  const sv = lang === "sv";
  const spec = buildSpec(normalizeBuild(build));
  const a = spec.approxDims;
  return [
    `${mm(spec.caseDia, a)} × ${mm(spec.l2l, a)} ${sv ? "horn-till-horn" : "lug-to-lug"}`,
    `${mm(spec.thick, a)} ${sv ? "tjock" : "thick"}`,
    `${mm(spec.lugW, a)} ${sv ? "hornbredd" : "lugs"}`,
    `${spec.wr} m ${sv ? "vattentät" : "WR"}`,
    `USD ${spec.priceUsd.low}–${spec.priceUsd.high}`,
  ].join(" · ");
}

/**
 * The block fed to the ANSWER prompt when the inline builder is on screen
 * (src/pipeline.js `watchBuild`). English, because it is a prompt input and not
 * UI copy — the embed captions itself in the matched language.
 *
 * It carries the three things the model cannot see: that a live render is
 * already displayed, what the build currently is, and what this turn changed.
 * Without it the capabilities line has the model researching the open web for a
 * capability it is sitting on top of — feedback #49's failure, one layer in.
 *
 * @param {WatchThreadState} state
 * @returns {string}
 */
export function watchPromptBlock(state) {
  if (!state || !state.active) return "";
  const spec = buildSpec(state.build);
  const fit = checkBuild(state.build);
  const rows = SLOTS.map((slot) => {
    const p = part(slot.key, state.build[slot.key]);
    return `${slot.name.en}: ${p ? p.name.en : state.build[slot.key]}`;
  }).join("; ");
  const changed = state.changes.length
    ? state.changes.map((c) => `${c.slotName.en}: ${c.from.name.en} → ${c.to.name.en}`).join("; ")
    : state.opened
      ? "(nothing yet — this is the opening build)"
      : "(this message changed nothing in the build)";
  const problems = fit.issues.length
    ? fit.issues.map((x) => `${x.level}/${x.slot}: ${x.en}`).join(" | ")
    : "none — every part fits";
  return [
    "INLINE WATCH BUILDER — a live, rotatable 3D render of THIS build is ALREADY displayed with your reply, and the user changes it by typing plain-language commands into the chat. It is generated from the catalogue's real millimetres (Seiko/TMI NHxx mod parts).",
    `Current build — ${rows}.`,
    `Dimensions — case ${mm(spec.caseDia, spec.approxDims)}, lug-to-lug ${mm(spec.l2l, spec.approxDims)}, thickness ${mm(spec.thick, spec.approxDims)}, lug width ${mm(spec.lugW, spec.approxDims)}, ${spec.wr} m water resistance, movement ${spec.movement} (${spec.bph} A/h, ${spec.reserveH} h reserve), parts cost about USD ${spec.priceUsd.low}–${spec.priceUsd.high}.`,
    `Changed by this message — ${changed}.`,
    `Fit check — ${problems}.`,
    // Deliberately NOT the URL itself: the permalink code is one long opaque
    // string per slot, and a model told the URL pastes the URL. The card
    // already carries it as a button; the model only needs to know it exists.
    "Full builder — the card LEADS with an \"Open the full builder\" button that opens THIS exact build in the standalone app, with every slot, the sources and where to buy the parts. Point at that button by name (never print a URL) if the user sounds like they want more control than typing gives them; never say they have to leave the chat to change something.",
    "OPEN by saying what this turn changed (or, on the first turn, what the render shows), in one or two sentences. Then answer whatever else was asked, and close by offering two or three further commands the user could type — name real parts from the build list above. If the fit check reports an error, say so plainly and say which part to change. NEVER say you cannot show, render, build or animate a watch: the render is on screen.",
  ].join("\n");
}
