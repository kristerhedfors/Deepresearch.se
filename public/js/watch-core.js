// @ts-check
// The NHxx WATCH-BUILDER domain's shared pure core (Node-tested, import-free).
// One module owns everything deterministic about the mix-and-match builder at
// /watch/: the parts catalog (cases, dials, hands, bezel inserts, chapter
// rings, crystals, crowns, casebacks, straps and the NHxx movements they all
// hang off), the PRE-INDEXED AliExpress sourcing table that says where each
// case family is actually bought, the compatibility engine that decides
// whether a chosen combination is buildable, the spec sheet it computes, the
// permalink codec, and the parametric geometry builders the renderer revolves
// into a solid watch.
//
// Lives under public/js/ for the same reason bash-core.js and space-core.js
// do: the browser can only import served modules, while the Worker bundler
// can import from anywhere — so the one implementation sits here and
// src/watch.js re-exports it.
//
// TWO RULES THIS FILE KEEPS.
//
// 1. NO INVENTED MILLIMETRES. Every dimension carries a `src` naming where it
//    came from, and anything measured off a marketing page rather than a spec
//    sheet is flagged `approx: true` so the UI can render it as "≈". Watch
//    modding is a domain where a tenth of a millimetre is the difference
//    between a case that closes and one that does not, so a confident wrong
//    number is worse than an honest range. Where sources disagree (they do,
//    often) the disagreement is carried in `note` rather than averaged away.
// 2. PURE. No DOM, no fetch, no timers. The geometry builders return plain
//    typed arrays; the renderer (public/js/watch-render.js) owns every WebGL
//    call and every canvas. That split is what lets `node --test` check the
//    shapes without a browser.
//
// Everything user-facing is EN + SV (invariant 6's spirit: Swedish carried at
// the same breadth as English, not bolted on later).

// ---------------------------------------------------------------------------
// Sources. Referenced by id from every dimension in the catalog so a number
// can always be traced back to the page it was read off.

export const SOURCES = {
  tmi: {
    label: "TMI/Seiko NH-series movement data, as published by mod-parts retailers",
    url: "https://assemble.watch/blog/nh35-movement-guide",
  },
  assemble: {
    label: "Assemble Watches — NH35 compatible parts guide",
    url: "https://assemble.watch/blog/nh35-compatible-parts",
  },
  dlw: {
    label: "DLW Watches — case size comparison chart",
    url: "https://www.dlwwatches.com/pages/case-size-comparison",
  },
  strapcode: {
    label: "Strapcode — Seiko divers watch dimensions",
    url: "https://www.strapcode.com/pages/seiko-divers-watch-dimension",
  },
  crystaltimes: {
    label: "CrystalTimes — Seiko mod cases catalogue",
    url: "https://usa.crystaltimes.net/product-category/cases/",
  },
  watchandstyle: {
    label: "Watch&Style — SKX007/SRPD bezel inserts and crystals",
    url: "https://watchandstyle.net/products/skx007-double-dome-sapphire-crystal-for-flat-insert",
  },
  namoki: {
    label: "namokiMODS — case and parts catalogue",
    url: "https://www.namokimods.com/",
  },
  seikomods: {
    label: "seikomods.com / CrystalTimes CT714 mini-turtle conversion listing",
    url: "https://www.seikomods.com/shop/ct714-skx013-to-mini-turtle-conversion-case-crown-at-3/",
  },
  thorn: {
    label: "Thorn Watches — 62MAS 40 mm NH35 case listing",
    url: "https://www.thornwatches.com/products/62mas-diving-40mm-silver-sterile-watch-case-domed-sapphire-glass-fit-nh35-nh36-movement",
  },
  wrwatches: {
    label: "WR Watches — 62MAS case set for Seiko mod",
    url: "https://wrwatches.com/products/62mas-case-set-for-seiko-mod",
  },
  karajan: {
    label: "KARAJAN / diywatchmod — silver Tuna case for NH35/NH36",
    url: "https://diywatchmod.com/products/silver-tuna-case-for-nh35-nh36-movement",
  },
  tandorio: {
    label: "Tandorio — titanium Turtle diver NH35 listing",
    url: "https://tandoriowatch.com/products/tandorio-titanium-turtle-diver",
  },
  aliwiki: {
    label: "AliExpress — \"Seiko NH35 size watch cases\" reference article",
    url: "https://www.aliexpress.com/s/wiki-ssr/article/seiko-nh35-size",
  },
  exquisite: {
    label: "Exquisite Timepieces — the Seiko 6105 \"Willard\"",
    url: "https://www.exquisitetimepieces.com/blog/all-about-the-seiko-willard/",
  },
  community: {
    label: "Modding-community consensus (multiple listings agreeing); treat as approximate",
    url: "",
  },
  // --- strap and bracelet construction (read 2026-07-30) -------------------
  // None of these is a spec sheet — nobody publishes a drawing of an
  // aftermarket bracelet — so every dimension that cites one is `approx`.
  dupewatch: {
    label: "dupe.watch — aftermarket metal bracelet guides (Oyster three-link, Jubilee five-link, mesh)",
    url: "https://dupe.watch/guides/metal-watch-bracelets",
  },
  watchwiki: {
    label: "Watch Wiki — bracelet link layouts (beads-of-rice, President, Engineer)",
    url: "https://www.watch-wiki.net/doku.php?id=bracelet",
  },
  crownbuckle: {
    label: "Crown & Buckle — how a NATO strap is built (double pass under the case, keepers, hardware)",
    url: "https://www.crownandbuckle.com/about-nato-straps",
  },
  unclestraps: {
    label: "Uncle Straps / Strapcode — Seiko-style waffle and tropic rubber strap listings",
    url: "https://unclestraps.com/products/standard-waffle-strap",
  },
  dryden: {
    label: "Dryden Watch Co — padded and tapered leather strap listings",
    url: "https://drydenwatchco.com/products/18mm-20mm-22mm-quick-release-padded-leather-watch-strap-dark-brown",
  },
  strapcodebuckle: {
    label: "Strapcode — #64/#65 classic tang buckle parts listings",
    url: "https://www.strapcode.com/products/parts-nt-acc-bu-065b",
  },
};

// ---------------------------------------------------------------------------
// Movements. The whole builder hangs off these: the NHxx family is one
// footprint with different complications, which is exactly why the mod market
// exists — one case, one dial size, many movements.
//
// The published movement figures vary between retailers restating the same TMI
// datasheet (27.40 mm outside diameter / 5.32 mm height is the most commonly
// republished pair; some pages quote 28.4 mm, which is the DIAL seat rather
// than the movement). We carry the 27.40/5.32 pair and say so.

/** Hand-tube (hand hole) diameters shared by the whole NH family, in mm. */
export const HAND_TUBES = { hour: 1.5, minute: 0.9, second: 0.2 };

/** The dial diameter the whole NHxx mod market is built around, in mm. */
export const DIAL_DIA = 28.5;

export const MOVEMENTS = [
  {
    id: "nh35",
    caliber: "NH35A",
    name: { en: "NH35 — date", sv: "NH35 — datum" },
    blurb: {
      en: "The default. Automatic, hacking, hand-winding, a single date wheel at 3.",
      sv: "Standardvalet. Automatiskt, sekundstopp, handuppdrag, ett datumhjul vid 3.",
    },
    dia: 27.4,
    casingDia: 29.36,
    height: 5.32,
    bph: 21600,
    jewels: 24,
    reserveH: 41,
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    hacking: true,
    handwind: true,
    src: "tmi",
  },
  {
    id: "nh36",
    caliber: "NH36A",
    name: { en: "NH36 — day + date", sv: "NH36 — veckodag + datum" },
    blurb: {
      en: "Same footprint as the NH35 with a day wheel added above the date.",
      sv: "Samma mått som NH35 men med veckodagshjul ovanför datumet.",
    },
    dia: 27.4,
    casingDia: 29.36,
    height: 5.32,
    bph: 21600,
    jewels: 24,
    reserveH: 41,
    date: "3",
    day: true,
    gmt: false,
    openHeart: false,
    hacking: true,
    handwind: true,
    src: "tmi",
    note: {
      en: "Retailer pages disagree on whether the day module makes the NH36 taller; most restate the NH35's 5.32 mm. Check clearance before ordering a slim case.",
      sv: "Återförsäljarnas sidor är oense om veckodagsmodulen gör NH36 högre; de flesta anger NH35:ans 5,32 mm. Kontrollera höjden innan du beställer ett tunt boett.",
    },
  },
  {
    id: "nh34",
    caliber: "NH34A",
    name: { en: "NH34 — GMT", sv: "NH34 — GMT" },
    blurb: {
      en: "Adds an independent 24-hour hand. Needs a GMT hand set and a 24-hour scale to be readable.",
      sv: "Har en fristående 24-timmarsvisare. Kräver GMT-visarset och en 24-timmarsskala för att kunna avläsas.",
    },
    dia: 27.4,
    casingDia: 29.36,
    height: 5.32,
    bph: 21600,
    jewels: 24,
    reserveH: 41,
    date: "3",
    day: false,
    gmt: true,
    openHeart: false,
    hacking: true,
    handwind: true,
    src: "tmi",
  },
  {
    id: "nh38",
    caliber: "NH38A",
    name: { en: "NH38 — open heart, no date", sv: "NH38 — öppet hjärta, utan datum" },
    blurb: {
      en: "No date wheel, decorated bridge — built for skeleton and open-heart dials.",
      sv: "Inget datumhjul, dekorerad brygga — gjort för skelett- och öppet-hjärta-urtavlor.",
    },
    dia: 27.4,
    casingDia: 29.36,
    height: 5.32,
    bph: 21600,
    jewels: 24,
    reserveH: 41,
    date: null,
    day: false,
    gmt: false,
    openHeart: true,
    hacking: true,
    handwind: true,
    src: "tmi",
  },
  {
    id: "nh70",
    caliber: "NH70A",
    name: { en: "NH70 — no date", sv: "NH70 — utan datum" },
    blurb: {
      en: "A drop-in NH35 without the date wheel, for dials with no aperture.",
      sv: "En NH35 utan datumhjul, för urtavlor helt utan datumfönster.",
    },
    dia: 27.4,
    casingDia: 29.36,
    height: 5.32,
    bph: 21600,
    jewels: 24,
    reserveH: 41,
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    hacking: true,
    handwind: true,
    src: "assemble",
  },
];

// ---------------------------------------------------------------------------
// Fitment platforms. What actually decides whether a crystal, a bezel insert
// or a chapter ring fits is not the case's LOOK, it is which parts family the
// case was machined for. The SKX007/SRPD platform dominates the mod market —
// most of the "conversion" cases sold as a Willard, a Tuna or a Planet Ocean
// are SKX-platform cases wearing a different shell.

export const PLATFORMS = {
  skx: {
    id: "skx",
    name: { en: "SKX007 / SRPD", sv: "SKX007 / SRPD" },
    dialDia: DIAL_DIA,
    crystalDia: 31.5,
    insert: { od: 38, id: 31.8 },
    chapterRing: true,
    src: "watchandstyle",
  },
  skx013: {
    id: "skx013",
    name: { en: "SKX013 (mini)", sv: "SKX013 (mini)" },
    dialDia: DIAL_DIA,
    crystalDia: 27.5,
    insert: { od: 33.5, id: 27.8 },
    chapterRing: true,
    approx: true,
    src: "community",
  },
  srp: {
    id: "srp",
    name: { en: "SRP Turtle", sv: "SRP Turtle" },
    dialDia: DIAL_DIA,
    crystalDia: 33.6,
    insert: { od: 40.5, id: 33.8 },
    chapterRing: true,
    approx: true,
    src: "community",
  },
  native: {
    id: "native",
    name: { en: "case-specific", sv: "boettspecifik" },
    dialDia: DIAL_DIA,
    crystalDia: 0,
    insert: null,
    chapterRing: false,
    src: "community",
  },
};

// ---------------------------------------------------------------------------
// CASES — the pre-indexed catalogue. `shell` picks the parametric silhouette
// the geometry builder revolves; `dims` is millimetres; `ali` is the sourcing
// index (search terms that actually return the part, the brands that make it,
// and the price band to expect).
//
// Reading the dims: dia = case diameter excluding the crown, l2l = lug tip to
// lug tip, thick = total case thickness including the crystal, lugW = strap
// width between the lugs.

export const CASES = [
  {
    id: "skx007",
    name: { en: "SKX007 diver", sv: "SKX007-dykare" },
    homage: "Seiko SKX007 / SRPD",
    shell: "diver",
    platform: "skx",
    dims: { dia: 42.5, l2l: 46, thick: 13.25, lugW: 22 },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "dlw",
    blurb: {
      en: "The platform the whole mod market is built on. Crown at 4 with guards, 120-click bezel, chapter ring, 22 mm lugs.",
      sv: "Plattformen hela modmarknaden vilar på. Krona vid 4 med kronskydd, 120-klicks lünett, chapter ring, 22 mm bandinfästning.",
    },
    ali: {
      queries: ["NH35 SKX007 case", "SKX007 mod case sapphire", "SRPD case NH36"],
      brands: ["Miuksi", "Sharkey", "Tandorio", "Steeldive"],
      priceUsd: [22, 70],
      watchFor: {
        en: "Cheap listings ship a mineral crystal and a hollow bezel; \"sapphire\" in the title is not always sapphire in the box.",
        sv: "Billiga annonser levereras med mineralglas och en ihålig lünett; \"sapphire\" i rubriken är inte alltid safir i paketet.",
      },
    },
  },
  {
    id: "skx-ncg",
    name: { en: "SKX007, no crown guards", sv: "SKX007, utan kronskydd" },
    homage: "Seiko SKX007 / SRPD (CT707B)",
    shell: "diver",
    platform: "skx",
    dims: { dia: 42.5, l2l: 46, thick: 13, lugW: 22, approx: true },
    crown: { hour: 4, guards: false, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "crystaltimes",
    blurb: {
      en: "The SKX with the crown guards machined away — the same internals, a cleaner flank.",
      sv: "SKX:en med bortfrästa kronskydd — samma innanmäte, renare boettsida.",
    },
    ali: {
      queries: ["SKX007 case no crown guard NH35", "NH35 case crown at 4 no guards"],
      brands: ["Miuksi", "Sharkey"],
      priceUsd: [25, 70],
    },
  },
  {
    id: "skx-c3",
    name: { en: "SKX007, crown at 3", sv: "SKX007, krona vid 3" },
    homage: "Seiko SKX007 / SRPD (CT713)",
    shell: "diver",
    platform: "skx",
    dims: { dia: 42.5, l2l: 46, thick: 13, lugW: 22, approx: true },
    crown: { hour: 3, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "crystaltimes",
    blurb: {
      en: "SKX internals with the stem moved to 3 — the conversion that makes a Sub-style build read right.",
      sv: "SKX-innanmäte med stiftet flyttat till 3 — konverteringen som får ett Sub-bygge att se rätt ut.",
    },
    ali: {
      queries: ["SKX007 case crown at 3 NH35", "NH35 case 3 o'clock crown SKX"],
      brands: ["Miuksi", "Sharkey", "Tandorio"],
      priceUsd: [28, 75],
    },
  },
  {
    id: "sub",
    name: { en: "Sub-style diver", sv: "Sub-dykare" },
    homage: "Submariner-style, SKX platform",
    shell: "diver",
    platform: "skx",
    dims: { dia: 41, l2l: 46, thick: 12.8, lugW: 22, approx: true },
    crown: { hour: 3, guards: true, signed: true },
    bezel: "dive120",
    finish: "polished",
    wr: 200,
    src: "dlw",
    blurb: {
      en: "The most-sold shape on AliExpress: 41 mm, crown at 3, polished flanks, ceramic insert.",
      sv: "Den mest sålda formen på AliExpress: 41 mm, krona vid 3, polerade sidor, keramikinlägg.",
    },
    ali: {
      queries: ["NH35 case 41mm sub", "submariner case NH35 sapphire ceramic bezel", "41mm diver case NH35 200m"],
      brands: ["Sharkey", "Steeldive", "San Martin", "Addiesdive", "Tandorio"],
      priceUsd: [30, 120],
      watchFor: {
        en: "41 mm listings vary from 40.5 to 41.5 mm between batches; measure before ordering a bracelet.",
        sv: "41 mm-annonser varierar mellan 40,5 och 41,5 mm mellan batcher; mät innan du beställer ett stållänk.",
      },
    },
  },
  {
    id: "sub-slim",
    name: { en: "Sub-style, slim", sv: "Sub-dykare, tunn" },
    homage: "Submariner-style slim, SKX platform",
    shell: "diver",
    platform: "skx",
    dims: { dia: 40, l2l: 45.5, thick: 12, lugW: 22, approx: true },
    crown: { hour: 3, guards: false, signed: false },
    bezel: "dive120",
    finish: "polished",
    wr: 100,
    src: "dlw",
    blurb: {
      en: "40 mm and no crown guards — the smallest the SKX platform gets without changing crystal.",
      sv: "40 mm och utan kronskydd — det minsta SKX-plattformen blir utan att byta glas.",
    },
    ali: {
      queries: ["NH35 case 40mm slim diver", "40mm no crown guard case NH35"],
      brands: ["Sharkey", "Steeldive", "Baltany"],
      priceUsd: [30, 110],
    },
  },
  {
    id: "turtle-skx",
    name: { en: "Turtle (SKX conversion)", sv: "Turtle (SKX-konvertering)" },
    homage: "Seiko 6309/SRP Turtle on the SKX platform",
    shell: "cushion",
    platform: "skx",
    dims: { dia: 44, l2l: 46.5, thick: 13.4, lugW: 22, approx: true },
    crown: { hour: 4, guards: false, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "dlw",
    blurb: {
      en: "The cushion shell over SKX internals: wide across, short lug to lug, wears smaller than the number.",
      sv: "Kuddformad boett över SKX-innanmäte: bred men kort mellan hornen — bär mindre än siffran antyder.",
    },
    ali: {
      queries: ["turtle case NH35 SKX", "cushion case NH35 44mm turtle mod"],
      brands: ["Miuksi", "Sharkey", "Steeldive"],
      priceUsd: [30, 85],
    },
  },
  {
    id: "srp-turtle",
    name: { en: "SRP Turtle (native)", sv: "SRP Turtle (original­mått)" },
    homage: "Seiko SRP777",
    shell: "cushion",
    platform: "srp",
    dims: { dia: 44.3, l2l: 48, thick: 13.4, lugW: 22 },
    crown: { hour: 4, guards: false, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "tandorio",
    blurb: {
      en: "Turtle dimensions as Seiko built them — its own crystal and insert family, not SKX parts.",
      sv: "Turtle-mått som Seiko gjorde dem — egen glas- och inläggsfamilj, inte SKX-delar.",
    },
    ali: {
      queries: ["SRP777 turtle case NH35", "turtle case 44mm NH36 sapphire"],
      brands: ["Tandorio", "Steeldive", "Sharkey"],
      priceUsd: [40, 140],
      watchFor: {
        en: "SRP crystals and inserts are NOT interchangeable with SKX ones — order the insert with the case.",
        sv: "SRP-glas och -inlägg passar INTE SKX — beställ inlägget tillsammans med boetten.",
      },
    },
  },
  {
    id: "mini-turtle",
    name: { en: "Mini Turtle (SKX013)", sv: "Mini Turtle (SKX013)" },
    homage: "SKX013 → mini turtle conversion (CT714)",
    shell: "cushion",
    platform: "skx013",
    dims: { dia: 39, l2l: 43.5, thick: 12.6, lugW: 20, approx: true },
    crown: { hour: 3, guards: false, signed: true },
    bezel: "dive120",
    finish: "polished",
    wr: 200,
    src: "seikomods",
    blurb: {
      en: "The small cushion: 39 mm without the crown, 43.5 mm lug to lug, 20 mm strap.",
      sv: "Den lilla kudden: 39 mm utan kronan, 43,5 mm mellan hornen, 20 mm band.",
    },
    ali: {
      queries: ["SKX013 mini turtle case NH35", "38mm cushion case NH35 mod"],
      brands: ["Miuksi", "Sharkey"],
      priceUsd: [30, 90],
    },
  },
  {
    id: "skx013",
    name: { en: "SKX013 diver", sv: "SKX013-dykare" },
    homage: "Seiko SKX013",
    shell: "diver",
    platform: "skx013",
    dims: { dia: 37, l2l: 41, thick: 13, lugW: 20 },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "strapcode",
    blurb: {
      en: "The SKX shrunk: same layout, 20 mm lugs, a genuinely small diver.",
      sv: "SKX i miniatyr: samma upplägg, 20 mm horn, en verkligt liten dykare.",
    },
    ali: {
      queries: ["SKX013 case NH35", "37mm diver case NH35 mod"],
      brands: ["Miuksi", "Sharkey"],
      priceUsd: [28, 80],
      watchFor: {
        en: "Sources quote 37–38 mm for this case depending on where the caliper sits; treat 37 as the low end.",
        sv: "Källor anger 37–38 mm beroende på var skjutmåttet sätts; behandla 37 som den nedre gränsen.",
      },
    },
  },
  {
    id: "62mas",
    name: { en: "62MAS vintage diver", sv: "62MAS vintagedykare" },
    homage: "Seiko 62MAS",
    shell: "diver",
    platform: "native",
    dims: { dia: 41, l2l: 49.5, thick: 11.2, lugW: 20, approx: true },
    crystal: { dia: 30.5, approx: true },
    crown: { hour: 3, guards: false, signed: false },
    bezel: "dive120",
    finish: "brushed",
    wr: 100,
    src: "wrwatches",
    blurb: {
      en: "Seiko's first diver, endlessly re-cut for NH35. Slim, long-lugged, domed crystal.",
      sv: "Seikos första dykare, ändlöst omgjord för NH35. Tunn, långa horn, kupat glas.",
    },
    ali: {
      queries: ["62MAS case NH35", "62mas 40mm case NH35 domed sapphire", "vintage diver case NH35 20mm lug"],
      brands: ["Heimdallr", "Thorn", "San Martin", "Proxima", "Baltany"],
      priceUsd: [45, 160],
      watchFor: {
        en: "Two families circulate: a 40 mm/15 mm-thick version (Thorn) and a 41 mm/11.2 mm one (WR). They take different crystals.",
        sv: "Två familjer cirkulerar: en 40 mm/15 mm tjock (Thorn) och en 41 mm/11,2 mm (WR). De tar olika glas.",
      },
    },
  },
  {
    id: "willard",
    name: { en: "Captain Willard 6105", sv: "Captain Willard 6105" },
    homage: "Seiko 6105-8110",
    shell: "cushion",
    platform: "skx",
    dims: { dia: 44, l2l: 47.5, thick: 13, lugW: 20, approx: true },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "exquisite",
    blurb: {
      en: "The asymmetric 1970 cushion from Apocalypse Now — the crown guard is part of the case, not an add-on.",
      sv: "Den asymmetriska kudden från 1970 och Apocalypse Now — kronskyddet är en del av boetten, inte ett tillbehör.",
    },
    note: {
      en: "The 1970 original is 19 mm between the lugs; SKX-platform conversion cases are commonly 20 mm. Confirm on the listing before buying a strap.",
      sv: "Originalet från 1970 har 19 mm mellan hornen; SKX-baserade konverteringsboetter är oftast 20 mm. Kontrollera annonsen innan du köper band.",
    },
    ali: {
      queries: ["willard case NH35", "6105 case NH35 mod", "captain willard case SKX NH36"],
      brands: ["Heimdallr", "Proxima", "Sharkey", "San Martin"],
      priceUsd: [45, 150],
    },
  },
  {
    id: "samurai",
    name: { en: "Samurai", sv: "Samurai" },
    homage: "Seiko SRPB Samurai",
    shell: "tonneau",
    platform: "skx",
    dims: { dia: 44, l2l: 46, thick: 13, lugW: 22 },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "strapcode",
    blurb: {
      en: "All facets and hard edges — the angular one. Listings also quote 43.8 × 47.3 mm for the mod conversion.",
      sv: "Fasetter och skarpa kanter — den kantiga. Annonser anger även 43,8 × 47,3 mm för konverteringsboetten.",
    },
    ali: {
      queries: ["samurai case NH35", "seiko samurai mod case 43.8mm NH35"],
      brands: ["Miuksi", "Sharkey", "Tandorio"],
      priceUsd: [35, 110],
    },
  },
  {
    id: "sumo",
    name: { en: "Sumo", sv: "Sumo" },
    homage: "Seiko SBDC031 Sumo",
    shell: "diver",
    platform: "native",
    dims: { dia: 45, l2l: 47, thick: 14, lugW: 20 },
    crystal: { dia: 32.5, approx: true },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "strapcode",
    blurb: {
      en: "Big, heavy, and famous for its wide polished bezel edge. 20 mm lugs despite the 45 mm case.",
      sv: "Stor, tung och känd för sin breda polerade lünettkant. 20 mm horn trots 45 mm boett.",
    },
    ali: {
      queries: ["sumo case NH35", "45mm diver case NH35 sumo mod"],
      brands: ["Heimdallr", "Proxima", "Steeldive"],
      priceUsd: [50, 150],
    },
  },
  {
    id: "tuna",
    name: { en: "Tuna (shrouded)", sv: "Tuna (med skydd)" },
    homage: "Seiko Tuna, SKX conversion (CT719)",
    shell: "shroud",
    platform: "skx",
    dims: { dia: 47, l2l: 44.5, thick: 15, lugW: 22, approx: true },
    crown: { hour: 4, guards: false, signed: true },
    bezel: "dive120",
    finish: "blasted",
    wr: 300,
    src: "karajan",
    blurb: {
      en: "A shroud bolted over the case: 47 mm across but only 44.5 mm lug to lug, so it wears far smaller than it sounds.",
      sv: "Ett skydd fastskruvat över boetten: 47 mm brett men bara 44,5 mm mellan hornen — bär mycket mindre än det låter.",
    },
    ali: {
      queries: ["tuna case NH35", "tuna shroud case NH35 47mm", "NH35 tuna mod case"],
      brands: ["Sharkey", "Steeldive", "Proxima"],
      priceUsd: [45, 140],
    },
  },
  {
    id: "mm300",
    name: { en: "Marinemaster 300", sv: "Marinemaster 300" },
    homage: "Seiko SBDX017 MM300, SKX conversion (CT724)",
    shell: "diver",
    platform: "skx",
    dims: { dia: 44, l2l: 45, thick: 15, lugW: 20 },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 300,
    src: "strapcode",
    blurb: {
      en: "Monobloc-look slab sides and a very short lug to lug for its diameter.",
      sv: "Monoblockskänsla med raka sidor och mycket kort avstånd mellan hornen i förhållande till diametern.",
    },
    ali: {
      queries: ["MM300 case NH35", "marinemaster case NH35 mod"],
      brands: ["Heimdallr", "Proxima", "Sharkey"],
      priceUsd: [55, 170],
    },
  },
  {
    id: "planet-ocean",
    name: { en: "Planet Ocean style", sv: "Planet Ocean-stil" },
    homage: "Seamaster Planet Ocean style, SKX platform (CT722)",
    shell: "diver",
    platform: "skx",
    dims: { dia: 43, l2l: 48, thick: 13.5, lugW: 22, approx: true },
    crown: { hour: 3, guards: true, signed: false },
    bezel: "dive120",
    finish: "polished",
    wr: 200,
    src: "crystaltimes",
    blurb: {
      en: "Twisted lugs and a helium-valve flank on SKX internals.",
      sv: "Vridna horn och heliumventilsida på SKX-innanmäte.",
    },
    ali: {
      queries: ["planet ocean case NH35", "seamaster style case NH35 mod"],
      brands: ["Sharkey", "Steeldive", "Corgeut"],
      priceUsd: [40, 130],
    },
  },
  {
    id: "explorer",
    name: { en: "Explorer style", sv: "Explorer-stil" },
    homage: "Explorer-style case set (CT720EXP)",
    shell: "dress",
    platform: "skx",
    dims: { dia: 39, l2l: 47, thick: 12, lugW: 20, approx: true },
    crown: { hour: 3, guards: false, signed: false },
    bezel: "fixed",
    finish: "brushed",
    wr: 100,
    src: "crystaltimes",
    blurb: {
      en: "No rotating bezel, a thin fixed one instead — the sports-dress crossover.",
      sv: "Ingen roterande lünett, en tunn fast i stället — sport och elegans i samma boett.",
    },
    ali: {
      queries: ["explorer case NH35", "39mm case NH35 fixed bezel mod"],
      brands: ["Corgeut", "Bliger", "Baltany", "San Martin"],
      priceUsd: [30, 110],
    },
  },
  {
    id: "alpinist",
    name: { en: "Alpinist", sv: "Alpinist" },
    homage: "Seiko SARB017 Alpinist",
    shell: "dress",
    platform: "native",
    dims: { dia: 38, l2l: 43, thick: 12, lugW: 20 },
    crystal: { dia: 30, approx: true },
    crown: { hour: 3, guards: false, signed: true },
    bezel: "fixed",
    finish: "polished",
    wr: 200,
    src: "strapcode",
    blurb: {
      en: "The field-dress classic, with the second crown at 4 that turns the inner compass ring.",
      sv: "Fält- och klädklassikern, med den andra kronan vid 4 som vrider den inre kompassringen.",
    },
    ali: {
      queries: ["alpinist case NH35", "SARB017 case NH35 mod", "38mm dress case NH35 inner bezel"],
      brands: ["San Martin", "Baltany", "Merkur", "Bliger"],
      priceUsd: [40, 160],
    },
  },
  {
    id: "field",
    name: { en: "Field 38", sv: "Fältklocka 38" },
    homage: "SRPE-style field case",
    shell: "field",
    platform: "skx",
    dims: { dia: 38, l2l: 44.5, thick: 11.5, lugW: 20, approx: true },
    crown: { hour: 3, guards: false, signed: false },
    bezel: "none",
    finish: "blasted",
    wr: 100,
    src: "dlw",
    blurb: {
      en: "No bezel at all — the whole top is crystal, so the dial reads as large as the case.",
      sv: "Ingen lünett alls — hela ovansidan är glas, så urtavlan ser lika stor ut som boetten.",
    },
    ali: {
      queries: ["field watch case NH35 38mm", "NH35 case no bezel 38mm"],
      brands: ["Baltany", "Corgeut", "Bliger"],
      priceUsd: [28, 95],
    },
  },
  {
    id: "monster",
    name: { en: "Monster", sv: "Monster" },
    homage: "Seiko SRP307 Monster",
    shell: "diver",
    platform: "native",
    dims: { dia: 42.5, l2l: 47.5, thick: 12.4, lugW: 20, approx: true },
    crystal: { dia: 31, approx: true },
    crown: { hour: 4, guards: true, signed: true },
    bezel: "dive120",
    finish: "brushed",
    wr: 200,
    src: "community",
    blurb: {
      en: "Serrated bezel, huge lume, unmistakable. Sources cluster around 42–42.5 mm.",
      sv: "Sågtandad lünett, enorm lysmassa, omisskännlig. Källor samlas kring 42–42,5 mm.",
    },
    ali: {
      queries: ["monster case NH35", "seiko monster mod case NH35"],
      brands: ["Sharkey", "Miuksi"],
      priceUsd: [35, 110],
    },
  },
];

// ---------------------------------------------------------------------------
// DIALS. `date` is where the aperture sits (null = none), `day` a day window,
// `gmt` a 24-hour track, `openHeart` a balance-wheel cut-out. Marker geometry
// is described declaratively so the renderer paints it and the compatibility
// engine can reason about it.

export const DIALS = [
  {
    id: "skx-black",
    name: { en: "SKX matte black", sv: "SKX matt svart" },
    base: "#0d0f12",
    finish: "matte",
    markers: "skx",
    markerColor: "#e9eef5",
    lume: "c3",
    textColor: "#e9eef5",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC", "200m"],
    ali: { queries: ["NH35 dial 28.5mm SKX"], priceUsd: [8, 30] },
  },
  {
    id: "sub-black",
    name: { en: "Sub gloss black", sv: "Sub blank svart" },
    base: "#08090c",
    finish: "gloss",
    markers: "sub",
    markerColor: "#f2f5fa",
    lume: "bgw9",
    textColor: "#f2f5fa",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["NH35 dial submariner 28.5"], priceUsd: [8, 35] },
  },
  {
    id: "sunburst-blue",
    name: { en: "Sunburst blue", sv: "Solstråleblå" },
    base: "#12386e",
    finish: "sunburst",
    markers: "sub",
    markerColor: "#eef3fb",
    lume: "bgw9",
    textColor: "#eef3fb",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["NH35 sunburst blue dial 28.5mm"], priceUsd: [10, 40] },
  },
  {
    id: "sunburst-green",
    name: { en: "Sunburst green", sv: "Solstrålegrön" },
    base: "#12523a",
    finish: "sunburst",
    markers: "alpinist",
    markerColor: "#f0d99a",
    lume: "c3",
    textColor: "#f0d99a",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["NH35 green sunburst dial alpinist 28.5"], priceUsd: [10, 45] },
  },
  {
    id: "gilt-black",
    name: { en: "Vintage gilt black", sv: "Vintage gilt svart" },
    base: "#0a0a0a",
    finish: "gloss",
    markers: "sub",
    markerColor: "#cfa75a",
    lume: "old-radium",
    textColor: "#cfa75a",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC", "200m"],
    ali: { queries: ["NH35 gilt dial 28.5mm vintage"], priceUsd: [10, 40] },
  },
  {
    id: "62mas-cream",
    name: { en: "62MAS cream, no date", sv: "62MAS gräddvit, utan datum" },
    base: "#efe6d2",
    finish: "matte",
    markers: "62mas",
    markerColor: "#2b2620",
    lume: "old-radium",
    textColor: "#2b2620",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["62mas dial 28.5 no date NH35"], priceUsd: [10, 40] },
  },
  {
    id: "california",
    name: { en: "California split dial", sv: "California-tavla" },
    base: "#101216",
    finish: "matte",
    markers: "california",
    markerColor: "#f3ead6",
    lume: "old-radium",
    textColor: "#f3ead6",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    ali: { queries: ["california dial NH35 28.5"], priceUsd: [10, 35] },
  },
  {
    id: "explorer-369",
    name: { en: "Explorer 3-6-9", sv: "Explorer 3-6-9" },
    base: "#0b0c0e",
    finish: "matte",
    markers: "explorer",
    markerColor: "#f5f7fa",
    lume: "bgw9",
    textColor: "#f5f7fa",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["explorer dial NH35 28.5 369"], priceUsd: [9, 35] },
  },
  {
    id: "gs-white",
    name: { en: "Snowflake textured white", sv: "Snöflinga, texturerad vit" },
    base: "#f4f6f8",
    finish: "textured",
    markers: "gs",
    markerColor: "#7e8894",
    lume: "none",
    textColor: "#5d6672",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["snowflake dial NH35 28.5 GS"], priceUsd: [12, 45] },
  },
  {
    id: "fume-grey",
    name: { en: "Fumé grey", sv: "Fumé grå" },
    base: "#4a5058",
    finish: "fume",
    markers: "sub",
    markerColor: "#eef1f5",
    lume: "bgw9",
    textColor: "#eef1f5",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["fume dial NH35 28.5 grey"], priceUsd: [12, 45] },
  },
  {
    id: "salmon",
    name: { en: "Salmon dress", sv: "Laxrosa klädtavla" },
    base: "#d99274",
    finish: "sunburst",
    markers: "roman",
    markerColor: "#3a2b24",
    lume: "none",
    textColor: "#3a2b24",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    ali: { queries: ["salmon dial NH35 28.5"], priceUsd: [12, 45] },
  },
  {
    id: "daydate-black",
    name: { en: "Day-date black (NH36)", sv: "Veckodag/datum svart (NH36)" },
    base: "#0d0f12",
    finish: "matte",
    markers: "sub",
    markerColor: "#eef3fb",
    lume: "bgw9",
    textColor: "#eef3fb",
    date: "3",
    day: true,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    ali: { queries: ["NH36 day date dial 28.5"], priceUsd: [10, 40] },
  },
  {
    id: "gmt-black",
    name: { en: "GMT 24-hour black (NH34)", sv: "GMT 24-timmars svart (NH34)" },
    base: "#0b0d10",
    finish: "matte",
    markers: "sub",
    markerColor: "#eef3fb",
    lume: "bgw9",
    textColor: "#eef3fb",
    date: "3",
    day: false,
    gmt: true,
    openHeart: false,
    text: ["GMT"],
    ali: { queries: ["NH34 GMT dial 28.5"], priceUsd: [14, 50] },
  },
  {
    id: "openheart",
    name: { en: "Open heart skeleton (NH38)", sv: "Öppet hjärta, skelett (NH38)" },
    base: "#15181d",
    finish: "matte",
    markers: "baton",
    markerColor: "#dfe5ee",
    lume: "c3",
    textColor: "#dfe5ee",
    date: null,
    day: false,
    gmt: false,
    openHeart: true,
    text: ["AUTOMATIC"],
    ali: { queries: ["NH38 open heart dial 28.5"], priceUsd: [12, 45] },
  },
];

/** Lume compound colours (daylight tint, glow tint). */
export const LUMES = {
  c3: { name: { en: "C3 green", sv: "C3 grön" }, day: "#d9e6b8", glow: "#8dff6a" },
  bgw9: { name: { en: "BGW9 blue", sv: "BGW9 blå" }, day: "#e7eef5", glow: "#7fd0ff" },
  "old-radium": { name: { en: "Old radium", sv: "Old radium" }, day: "#c9ab74", glow: "#a9ff86" },
  none: { name: { en: "No lume", sv: "Ingen lysmassa" }, day: "#dfe4ea", glow: "#dfe4ea" },
};

// ---------------------------------------------------------------------------
// HANDS. Every NHxx takes the same tubes (1.50 / 0.90 / 0.20 mm), so hand sets
// are interchangeable across the whole movement family — the only real
// constraint is LENGTH against the dial, plus the GMT hand the NH34 needs.
// `len` is a fraction of the dial radius.

export const HAND_SETS = [
  {
    id: "skx-dive",
    name: { en: "SKX dive", sv: "SKX dykarvisare" },
    shapes: { hour: "arrow", minute: "sword", second: "lollipop" },
    len: { hour: 0.56, minute: 0.86, second: 0.9 },
    color: "#e8edf4",
    secondColor: "#e8edf4",
    lume: true,
    ali: { queries: ["NH35 hands SKX007 set"], priceUsd: [6, 25] },
  },
  {
    id: "mercedes",
    name: { en: "Mercedes", sv: "Mercedes" },
    shapes: { hour: "mercedes", minute: "sword", second: "lollipop" },
    len: { hour: 0.55, minute: 0.87, second: 0.92 },
    color: "#eef2f8",
    secondColor: "#eef2f8",
    lume: true,
    ali: { queries: ["NH35 mercedes hands 28.5 dial"], priceUsd: [6, 28] },
  },
  {
    id: "snowflake",
    name: { en: "Snowflake", sv: "Snöflinga" },
    shapes: { hour: "snowflake", minute: "snowflake", second: "needle" },
    len: { hour: 0.54, minute: 0.85, second: 0.93 },
    color: "#dfe6ef",
    secondColor: "#5c94d6",
    lume: true,
    ali: { queries: ["NH35 snowflake hands"], priceUsd: [8, 30] },
  },
  {
    id: "plongeur",
    name: { en: "Plongeur", sv: "Plongeur" },
    shapes: { hour: "plongeur", minute: "sword", second: "needle" },
    len: { hour: 0.5, minute: 0.88, second: 0.9 },
    color: "#e9eef5",
    secondColor: "#e05a4a",
    lume: true,
    ali: { queries: ["NH35 plongeur hands"], priceUsd: [7, 28] },
  },
  {
    id: "cathedral",
    name: { en: "Cathedral", sv: "Katedral" },
    shapes: { hour: "cathedral", minute: "cathedral", second: "needle" },
    len: { hour: 0.52, minute: 0.84, second: 0.9 },
    color: "#d9c9a4",
    secondColor: "#d9c9a4",
    lume: true,
    ali: { queries: ["NH35 cathedral hands vintage"], priceUsd: [7, 30] },
  },
  {
    id: "dauphine",
    name: { en: "Dauphine", sv: "Dauphine" },
    shapes: { hour: "dauphine", minute: "dauphine", second: "needle" },
    len: { hour: 0.55, minute: 0.86, second: 0.92 },
    color: "#cfd6df",
    secondColor: "#cfd6df",
    lume: false,
    ali: { queries: ["NH35 dauphine hands dress"], priceUsd: [6, 26] },
  },
  {
    id: "baton",
    name: { en: "Baton", sv: "Batong" },
    shapes: { hour: "baton", minute: "baton", second: "needle" },
    len: { hour: 0.55, minute: 0.87, second: 0.93 },
    color: "#e4e9f0",
    secondColor: "#e4e9f0",
    lume: true,
    ali: { queries: ["NH35 baton hands"], priceUsd: [5, 22] },
  },
  {
    id: "gmt-arrow",
    name: { en: "GMT arrow set (NH34)", sv: "GMT-pilset (NH34)" },
    shapes: { hour: "mercedes", minute: "sword", second: "needle", gmt: "gmtarrow" },
    len: { hour: 0.55, minute: 0.87, second: 0.9, gmt: 0.78 },
    color: "#eef2f8",
    secondColor: "#eef2f8",
    gmtColor: "#e2504a",
    lume: true,
    gmt: true,
    ali: { queries: ["NH34 GMT hands set"], priceUsd: [9, 35] },
  },
];

// ---------------------------------------------------------------------------
// BEZEL INSERTS, CHAPTER RINGS, CRYSTALS, CROWNS, CASEBACKS, STRAPS.
// `fits` is a list of platform ids — this is what the compatibility engine
// actually checks, rather than the case's silhouette.

export const INSERTS = [
  {
    id: "alu-black",
    name: { en: "Aluminium, black", sv: "Aluminium, svart" },
    scale: "dive60",
    base: "#111318",
    mark: "#eceff4",
    pip: "c3",
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["SKX007 bezel insert aluminium"], priceUsd: [4, 15] },
  },
  {
    id: "ceramic-black",
    name: { en: "Ceramic, black", sv: "Keramik, svart" },
    scale: "dive60",
    base: "#0a0b0e",
    mark: "#f3f6fa",
    pip: "bgw9",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["SKX007 ceramic bezel insert"], priceUsd: [10, 30] },
  },
  {
    id: "pepsi",
    name: { en: "Pepsi (blue / red)", sv: "Pepsi (blå/röd)" },
    scale: "dive60",
    base: "#123a72",
    base2: "#9d2029",
    mark: "#f4f7fb",
    pip: "c3",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["pepsi bezel insert SKX007 ceramic"], priceUsd: [10, 32] },
  },
  {
    id: "batman",
    name: { en: "Batman (blue / black)", sv: "Batman (blå/svart)" },
    scale: "dive60",
    base: "#16335f",
    base2: "#0b0c10",
    mark: "#f2f5fa",
    pip: "bgw9",
    gloss: true,
    fits: ["skx", "srp"],
    ali: { queries: ["batman bezel insert SKX007"], priceUsd: [10, 32] },
  },
  {
    id: "green",
    name: { en: "Ceramic, green", sv: "Keramik, grön" },
    scale: "dive60",
    base: "#0f4a2c",
    mark: "#f0f6f2",
    pip: "c3",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["green ceramic bezel insert SKX007"], priceUsd: [10, 32] },
  },
  {
    id: "gmt-24",
    name: { en: "24-hour GMT", sv: "24-timmars GMT" },
    scale: "hours24",
    base: "#101319",
    base2: "#1d3f6d",
    mark: "#f1f4f9",
    pip: "bgw9",
    gloss: true,
    gmt: true,
    fits: ["skx", "srp"],
    ali: { queries: ["24 hour GMT bezel insert SKX007"], priceUsd: [10, 34] },
  },
  {
    id: "steel-plain",
    name: { en: "Plain steel (no insert)", sv: "Blank stål (utan inlägg)" },
    scale: "none",
    base: "#8d949d",
    mark: "#5d646d",
    pip: "none",
    fits: ["skx", "skx013", "srp", "native"],
    ali: { queries: ["steel bezel insert SKX007 sterile"], priceUsd: [5, 20] },
  },
];

export const CHAPTER_RINGS = [
  {
    id: "black-minutes",
    name: { en: "Black, minute track", sv: "Svart, minutskala" },
    base: "#0c0e12",
    mark: "#e6ebf2",
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["SKX007 chapter ring black"], priceUsd: [4, 14] },
  },
  {
    id: "white-minutes",
    name: { en: "White, minute track", sv: "Vit, minutskala" },
    base: "#e9edf3",
    mark: "#1a1d22",
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["SKX007 chapter ring white"], priceUsd: [4, 14] },
  },
  {
    id: "red-accent",
    name: { en: "Black with red 15", sv: "Svart med röd 15" },
    base: "#0c0e12",
    mark: "#e6ebf2",
    accent: "#d8453c",
    fits: ["skx", "srp"],
    ali: { queries: ["SKX007 chapter ring red"], priceUsd: [4, 16] },
  },
  {
    id: "steel",
    name: { en: "Bare steel", sv: "Rent stål" },
    base: "#9aa1aa",
    mark: "#6b727b",
    fits: ["skx", "skx013", "srp"],
    ali: { queries: ["SKX007 chapter ring steel"], priceUsd: [4, 14] },
  },
];

export const CRYSTALS = [
  {
    id: "dd-sapphire",
    name: { en: "Double-dome sapphire, clear AR", sv: "Dubbelkupad safir, klar AR" },
    material: "sapphire",
    dome: 1.0,
    tint: "#dfe9f5",
    ar: "clear",
    fits: ["skx", "skx013", "srp", "native"],
    src: "watchandstyle",
    note: {
      en: "31.5 mm on the SKX platform, ~5.1–5.3 mm through the middle.",
      sv: "31,5 mm på SKX-plattformen, ca 5,1–5,3 mm genom mitten.",
    },
    ali: { queries: ["SKX007 double dome sapphire crystal 31.5"], priceUsd: [12, 45] },
  },
  {
    id: "dd-sapphire-blue",
    name: { en: "Double-dome sapphire, blue AR", sv: "Dubbelkupad safir, blå AR" },
    material: "sapphire",
    dome: 1.0,
    tint: "#9fc4ee",
    ar: "blue",
    fits: ["skx", "skx013", "srp", "native"],
    ali: { queries: ["SKX007 sapphire crystal blue AR"], priceUsd: [12, 45] },
  },
  {
    id: "flat-sapphire",
    name: { en: "Flat sapphire", sv: "Plan safir" },
    material: "sapphire",
    dome: 0.15,
    tint: "#e3ecf6",
    ar: "clear",
    fits: ["skx", "skx013", "srp", "native"],
    ali: { queries: ["SKX007 flat sapphire crystal"], priceUsd: [10, 35] },
  },
  {
    id: "box-sapphire",
    name: { en: "Box sapphire (vintage)", sv: "Boxsafir (vintage)" },
    material: "sapphire",
    dome: 1.6,
    tint: "#e6eef7",
    ar: "clear",
    fits: ["skx", "srp", "native"],
    ali: { queries: ["box sapphire crystal SKX007 vintage"], priceUsd: [18, 60] },
  },
  {
    id: "domed-hardlex",
    name: { en: "Domed Hardlex (stock)", sv: "Kupad Hardlex (original)" },
    material: "hardlex",
    dome: 0.6,
    tint: "#e0e7ef",
    ar: "none",
    fits: ["skx", "skx013", "srp", "native"],
    note: {
      en: "Hardlex is ~300–400 HV against sapphire's ~2200 HV — it scratches.",
      sv: "Hardlex ligger på ca 300–400 HV mot safirens ca 2200 HV — det repas.",
    },
    src: "aliwiki",
    ali: { queries: ["SKX007 hardlex crystal"], priceUsd: [5, 18] },
  },
];

export const CROWNS = [
  {
    id: "signed-screw",
    name: { en: "Signed, screw-down", sv: "Signerad, skruvkrona" },
    style: "coin",
    signed: true,
    ali: { queries: ["SKX007 crown screw down NH35"], priceUsd: [5, 20] },
  },
  {
    id: "plain-screw",
    name: { en: "Unsigned, screw-down", sv: "Osignerad, skruvkrona" },
    style: "coin",
    signed: false,
    ali: { queries: ["NH35 crown sterile screw down"], priceUsd: [4, 18] },
  },
  {
    id: "fluted",
    name: { en: "Fluted", sv: "Räfflad" },
    style: "fluted",
    signed: false,
    ali: { queries: ["NH35 fluted crown"], priceUsd: [4, 18] },
  },
  {
    id: "onion",
    name: { en: "Onion (dress)", sv: "Lökkrona (klädklocka)" },
    style: "onion",
    signed: false,
    ali: { queries: ["NH35 onion crown vintage"], priceUsd: [5, 22] },
  },
];

export const CASEBACKS = [
  {
    id: "solid-engraved",
    name: { en: "Solid, engraved", sv: "Massiv, graverad" },
    display: false,
    ali: { queries: ["SKX007 case back engraved NH35"], priceUsd: [6, 22] },
  },
  {
    id: "display",
    name: { en: "Display (exhibition)", sv: "Genomskinlig (utställningsboett)" },
    display: true,
    src: "community",
    ali: { queries: ["transparent case back SKX007 NH35 NH36"], priceUsd: [12, 25] },
    note: {
      en: "Adds height. Listings for the SKX/Turtle/Samurai display back cluster around USD 16–21.",
      sv: "Ökar höjden. Annonser för SKX/Turtle/Samurai-glasbotten ligger kring 16–21 USD.",
    },
  },
  {
    id: "solid-brushed",
    name: { en: "Solid, brushed", sv: "Massiv, borstad" },
    display: false,
    ali: { queries: ["SKX007 case back sterile"], priceUsd: [6, 20] },
  },
];

export const STRAPS = [
  { id: "oyster", name: { en: "Oyster bracelet", sv: "Oyster-länk" }, kind: "bracelet", color: "#9aa2ab", ali: { queries: ["oyster bracelet 22mm solid"], priceUsd: [12, 45] } },
  { id: "jubilee", name: { en: "Jubilee bracelet", sv: "Jubilee-länk" }, kind: "bracelet", color: "#a5adb6", ali: { queries: ["jubilee bracelet 22mm solid"], priceUsd: [14, 50] } },
  { id: "waffle", name: { en: "Rubber waffle", sv: "Gummi, våffelmönster" }, kind: "rubber", color: "#15171b", ali: { queries: ["waffle rubber strap 22mm seiko"], priceUsd: [8, 25] } },
  { id: "tropic", name: { en: "Rubber tropic", sv: "Gummi, tropic" }, kind: "rubber", color: "#101216", ali: { queries: ["tropic rubber strap 22mm"], priceUsd: [8, 25] } },
  { id: "nato", name: { en: "NATO", sv: "NATO" }, kind: "nato", color: "#2b3038", ali: { queries: ["nato strap 22mm seatbelt"], priceUsd: [5, 20] } },
  { id: "leather", name: { en: "Leather", sv: "Läder" }, kind: "leather", color: "#4a3226", ali: { queries: ["leather strap 20mm vintage watch"], priceUsd: [8, 30] } },
  { id: "mesh", name: { en: "Milanese mesh", sv: "Milanese mesh" }, kind: "bracelet", color: "#98a0a9", ali: { queries: ["milanese mesh bracelet 22mm"], priceUsd: [10, 30] } },
];

/** Case finishes, applied to the case and (where steel) the bracelet. */
export const FINISHES = [
  { id: "brushed", name: { en: "Brushed steel", sv: "Borstat stål" }, color: "#a8b0b9", rough: 0.45, metal: 1 },
  { id: "polished", name: { en: "Polished steel", sv: "Polerat stål" }, color: "#c3cad2", rough: 0.08, metal: 1 },
  { id: "blasted", name: { en: "Bead-blasted", sv: "Blästrat" }, color: "#9aa1a9", rough: 0.75, metal: 1 },
  { id: "pvd-black", name: { en: "PVD black", sv: "PVD svart" }, color: "#2b2f34", rough: 0.5, metal: 1 },
  { id: "gold", name: { en: "Gold plated", sv: "Guldpläterad" }, color: "#c8a253", rough: 0.2, metal: 1 },
  { id: "bronze", name: { en: "Bronze", sv: "Brons" }, color: "#b08356", rough: 0.55, metal: 1 },
  { id: "titanium", name: { en: "Titanium", sv: "Titan" }, color: "#8f949a", rough: 0.6, metal: 1 },
];

/** Every slot the builder fills, in the order the UI shows them. */
export const SLOTS = [
  { key: "movement", list: "MOVEMENTS", name: { en: "Movement", sv: "Urverk" } },
  { key: "case", list: "CASES", name: { en: "Case", sv: "Boett" } },
  { key: "finish", list: "FINISHES", name: { en: "Finish", sv: "Ytbehandling" } },
  { key: "insert", list: "INSERTS", name: { en: "Bezel insert", sv: "Lünettinlägg" } },
  { key: "dial", list: "DIALS", name: { en: "Dial", sv: "Urtavla" } },
  { key: "chapterRing", list: "CHAPTER_RINGS", name: { en: "Chapter ring", sv: "Chapter ring" } },
  { key: "hands", list: "HAND_SETS", name: { en: "Hands", sv: "Visare" } },
  { key: "crystal", list: "CRYSTALS", name: { en: "Crystal", sv: "Glas" } },
  { key: "crown", list: "CROWNS", name: { en: "Crown", sv: "Krona" } },
  { key: "caseback", list: "CASEBACKS", name: { en: "Case back", sv: "Boettbotten" } },
  { key: "strap", list: "STRAPS", name: { en: "Strap", sv: "Band" } },
];

const CATALOG = {
  MOVEMENTS,
  CASES,
  FINISHES,
  INSERTS,
  DIALS,
  CHAPTER_RINGS,
  HAND_SETS,
  CRYSTALS,
  CROWNS,
  CASEBACKS,
  STRAPS,
};

/**
 * Every option for one slot.
 * @param {string} slotKey
 * @returns {any[]}
 */
export function slotOptions(slotKey) {
  const slot = SLOTS.find((s) => s.key === slotKey);
  if (!slot) return [];
  return /** @type {any[]} */ (CATALOG[/** @type {keyof typeof CATALOG} */ (slot.list)]) || [];
}

/**
 * One option by slot + id, or null. Never throws — an unknown id is a miss,
 * not an error (a stale permalink must degrade, not break the page).
 * @param {string} slotKey
 * @param {string} id
 */
export function part(slotKey, id) {
  return slotOptions(slotKey).find((o) => o && o.id === id) || null;
}

/** The build the page opens on. */
export const DEFAULT_BUILD = {
  movement: "nh35",
  case: "skx007",
  finish: "brushed",
  insert: "ceramic-black",
  dial: "skx-black",
  chapterRing: "black-minutes",
  hands: "skx-dive",
  crystal: "dd-sapphire",
  crown: "signed-screw",
  caseback: "solid-engraved",
  strap: "oyster",
};

/**
 * Fill in any missing/unknown slot from the default build. Total: every input
 * produces a complete, renderable build.
 * @param {Record<string, string> | null | undefined} build
 * @returns {Record<string, string>}
 */
export function normalizeBuild(build) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const slot of SLOTS) {
    const wanted = build && typeof build[slot.key] === "string" ? build[slot.key] : "";
    out[slot.key] = part(slot.key, wanted) ? wanted : DEFAULT_BUILD[/** @type {keyof typeof DEFAULT_BUILD} */ (slot.key)];
  }
  return out;
}

/**
 * Resolve a build's ids into the catalog objects, defaults filled in.
 * @param {Record<string, string> | null | undefined} build
 */
export function resolveBuild(build) {
  const ids = normalizeBuild(build);
  /** @type {Record<string, any>} */
  const parts = {};
  for (const slot of SLOTS) parts[slot.key] = part(slot.key, ids[slot.key]);
  return { ids, parts };
}

// ---------------------------------------------------------------------------
// Compatibility. ERRORS mean the build cannot be assembled as specified;
// WARNINGS mean it can, but something will look or work oddly. Nothing here
// throws and nothing here blocks rendering — an impossible build still draws,
// with the problems listed beside it. That is the honest posture for a tool
// whose whole point is showing you what a combination looks like.

/**
 * @typedef {{ level: "error"|"warning"|"note", slot: string, en: string, sv: string }} Issue
 */

/**
 * @param {Record<string, string> | null | undefined} build
 * @returns {{ ok: boolean, issues: Issue[] }}
 */
export function checkBuild(build) {
  const { parts } = resolveBuild(build);
  /** @type {Issue[]} */
  const issues = [];
  const mv = parts.movement;
  const cs = parts.case;
  const dl = parts.dial;
  const hs = parts.hands;
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)] || PLATFORMS.native;

  // --- date / day apertures: the single most common mod-build mistake.
  if (mv.date && !dl.date) {
    issues.push({
      level: "error",
      slot: "dial",
      en: `${mv.caliber} has a date wheel but "${dl.name.en}" has no date window — the wheel would sit behind a solid dial. Use a no-date movement (NH70/NH38) or a dial with an aperture.`,
      sv: `${mv.caliber} har ett datumhjul men "${dl.name.sv}" saknar datumfönster — hjulet hamnar bakom en heltäckande urtavla. Välj ett urverk utan datum (NH70/NH38) eller en tavla med fönster.`,
    });
  }
  if (!mv.date && dl.date) {
    issues.push({
      level: "error",
      slot: "movement",
      en: `"${dl.name.en}" has a date window but ${mv.caliber} has no date wheel — you would see the movement through the aperture.`,
      sv: `"${dl.name.sv}" har datumfönster men ${mv.caliber} saknar datumhjul — du skulle se urverket genom fönstret.`,
    });
  }
  if (mv.day && !dl.day) {
    issues.push({
      level: "error",
      slot: "dial",
      en: `${mv.caliber} drives a day wheel; this dial has no day window. Pair the NH36 with a day-date dial, or use the NH35.`,
      sv: `${mv.caliber} driver ett veckodagshjul; den här tavlan har inget veckodagsfönster. Kombinera NH36 med en veckodags-/datumtavla, eller använd NH35.`,
    });
  }
  if (!mv.day && dl.day) {
    issues.push({
      level: "error",
      slot: "movement",
      en: `This dial has a day window but ${mv.caliber} has no day wheel — the window would be blank. The NH36 is the day-date movement.`,
      sv: `Den här tavlan har veckodagsfönster men ${mv.caliber} saknar veckodagshjul — fönstret blir tomt. NH36 är veckodags-/datumurverket.`,
    });
  }
  if (mv.openHeart && !dl.openHeart) {
    issues.push({
      level: "warning",
      slot: "dial",
      en: `${mv.caliber} is built to be seen — a solid dial hides the open balance it exists for.`,
      sv: `${mv.caliber} är gjort för att synas — en heltäckande tavla döljer den öppna balansen den finns för.`,
    });
  }
  if (dl.openHeart && !mv.openHeart) {
    issues.push({
      level: "warning",
      slot: "movement",
      en: `An open-heart dial over ${mv.caliber} shows an undecorated bridge rather than the balance wheel.`,
      sv: `En öppet-hjärta-tavla över ${mv.caliber} visar en odekorerad brygga i stället för balanshjulet.`,
    });
  }

  // --- GMT: three parts have to agree.
  if (mv.gmt && !hs.gmt) {
    issues.push({
      level: "error",
      slot: "hands",
      en: `${mv.caliber} drives a fourth (24-hour) hand — this hand set has only three.`,
      sv: `${mv.caliber} driver en fjärde visare (24-timmars) — det här visarsetet har bara tre.`,
    });
  }
  if (!mv.gmt && hs.gmt) {
    issues.push({
      level: "warning",
      slot: "movement",
      en: `The GMT hand has nothing to drive it on ${mv.caliber}; only the NH34 has a 24-hour wheel.`,
      sv: `GMT-visaren har inget som driver den på ${mv.caliber}; bara NH34 har ett 24-timmarshjul.`,
    });
  }
  if (mv.gmt && !dl.gmt && !(parts.insert && parts.insert.gmt)) {
    issues.push({
      level: "warning",
      slot: "insert",
      en: "A GMT movement with no 24-hour scale — on the dial or the bezel — is unreadable in the second time zone.",
      sv: "Ett GMT-urverk utan 24-timmarsskala — på tavlan eller lünetten — går inte att avläsa i den andra tidszonen.",
    });
  }

  // --- platform fitment for the ring parts.
  for (const [key, label] of /** @type {[string, {en:string,sv:string}][]} */ ([
    ["insert", { en: "bezel insert", sv: "lünettinlägget" }],
    ["chapterRing", { en: "chapter ring", sv: "chapter ringen" }],
    ["crystal", { en: "crystal", sv: "glaset" }],
  ])) {
    const p = parts[key];
    if (!p || !Array.isArray(p.fits) || p.fits.includes(cs.platform)) continue;
    if (cs.platform === "native") {
      // A case outside the three shared platforms takes its own ring parts,
      // sold with the case. That is not a mistake to block on — it is a
      // sourcing fact, so the render shows the chosen pattern and says where
      // the part has to come from.
      issues.push({
        level: "note",
        slot: key,
        en: `The ${cs.name.en} uses a case-specific ${label.en} rather than a shared-platform one — buy it with the case. The render shows the pattern you picked.`,
        sv: `${cs.name.sv} använder ett boettspecifikt ${label.sv} i stället för ett från en delad plattform — köp det med boetten. Bilden visar mönstret du valt.`,
      });
      continue;
    }
    issues.push({
      level: "error",
      slot: key,
      en: `This ${label.en} is not made for the ${plat.name.en} platform that the ${cs.name.en} uses.`,
      sv: `Det här ${label.sv} är inte gjort för ${plat.name.sv}-plattformen som ${cs.name.sv} använder.`,
    });
  }

  // --- a case with no rotating bezel has nowhere to put an insert.
  if (cs.bezel !== "dive120" && parts.insert && parts.insert.scale !== "none") {
    issues.push({
      level: "warning",
      slot: "insert",
      en: `The ${cs.name.en} has no rotating bezel, so the insert is not fitted — the render shows the case as it ships.`,
      sv: `${cs.name.sv} har ingen roterande lünett, så inlägget monteras inte — bilden visar boetten som den levereras.`,
    });
  }
  if (!plat.chapterRing && parts.chapterRing) {
    issues.push({
      level: "note",
      slot: "chapterRing",
      en: `${cs.name.en} has no separate chapter ring; its minute track is printed on the dial or the case.`,
      sv: `${cs.name.sv} har ingen separat chapter ring; minutskalan är tryckt på tavlan eller boetten.`,
    });
  }

  // --- hand length against the dial. All NHxx share the tubes, so this is the
  //     only geometric constraint hands actually have.
  const dialR = plat.dialDia / 2;
  const minuteMm = hs.len.minute * dialR;
  if (minuteMm > dialR * 0.95) {
    issues.push({
      level: "warning",
      slot: "hands",
      en: "The minute hand reaches past the printed minute track — it will overhang the chapter ring.",
      sv: "Minutvisaren når förbi minutskalan — den kommer att hänga över chapter ringen.",
    });
  }
  if (minuteMm < dialR * 0.7) {
    issues.push({
      level: "warning",
      slot: "hands",
      en: "The minute hand stops well short of the minute track, which reads as a mismatched set.",
      sv: "Minutvisaren når långt ifrån minutskalan, vilket ser ut som ett felmatchat set.",
    });
  }
  if (dl.lume === "none" && hs.lume) {
    issues.push({
      level: "note",
      slot: "dial",
      en: "Lumed hands over a dial with no lume: it will glow as four floating marks in the dark.",
      sv: "Lysande visare över en tavla utan lysmassa: i mörkret lyser bara visarna, som lösa märken.",
    });
  }

  // --- height budget. A display back and a tall crystal both add height.
  const spec = buildSpec(build);
  if (spec.stackMm > cs.dims.thick + 1.2) {
    issues.push({
      level: "warning",
      slot: "crystal",
      en: `The chosen crystal and case back add up to about ${spec.stackMm.toFixed(1)} mm against the case's ${cs.dims.thick} mm — expect the back to sit proud.`,
      sv: `Valt glas och boettbotten summerar till ca ${spec.stackMm.toFixed(1)} mm mot boettens ${cs.dims.thick} mm — räkna med att botten sticker ut.`,
    });
  }

  const ok = !issues.some((i) => i.level === "error");
  return { ok, issues };
}

// ---------------------------------------------------------------------------
// The spec sheet. Everything here is derived, never stored, so it cannot drift
// from the catalogue.

/**
 * @param {Record<string, string> | null | undefined} build
 */
export function buildSpec(build) {
  const { ids, parts } = resolveBuild(build);
  const cs = parts.case;
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)] || PLATFORMS.native;
  const crystalDia = cs.crystal ? cs.crystal.dia : plat.crystalDia || cs.dims.dia - 11;
  // Movement + dial + hands + crystal dome + case back: the vertical budget a
  // modder actually runs out of.
  const domeMm = 2.2 + parts.crystal.dome * 1.9;
  const stackMm = parts.movement.height + 0.9 + domeMm + (parts.caseback.display ? 2.6 : 1.6);
  const price = priceBand(ids);
  return {
    ids,
    caseDia: cs.dims.dia,
    l2l: cs.dims.l2l,
    thick: cs.dims.thick,
    lugW: cs.dims.lugW,
    approxDims: !!cs.dims.approx,
    dialDia: plat.dialDia,
    crystalDia,
    insert: plat.insert,
    platform: plat.id,
    crownHour: cs.crown.hour,
    wr: cs.wr,
    movement: parts.movement.caliber,
    bph: parts.movement.bph,
    reserveH: parts.movement.reserveH,
    jewels: parts.movement.jewels,
    stackMm: Math.round(stackMm * 10) / 10,
    domeMm: Math.round(domeMm * 10) / 10,
    handTubes: HAND_TUBES,
    priceUsd: price,
  };
}

/**
 * Sum the AliExpress price bands of every part that carries one.
 * @param {Record<string, string>} ids
 * @returns {{ low: number, high: number, parts: number }}
 */
export function priceBand(ids) {
  let low = 0;
  let high = 0;
  let counted = 0;
  for (const slot of SLOTS) {
    const p = part(slot.key, ids[slot.key]);
    const band = p && p.ali && Array.isArray(p.ali.priceUsd) ? p.ali.priceUsd : null;
    if (!band) continue;
    low += band[0];
    high += band[1];
    counted += 1;
  }
  // The movement itself is not in a slot band; NH35s run about USD 18–45.
  low += 18;
  high += 45;
  return { low: Math.round(low), high: Math.round(high), parts: counted + 1 };
}

// ---------------------------------------------------------------------------
// The AliExpress sourcing index. AliExpress listing pages are not machine
// readable from a server (they answer bots with a 503), so this is a curated
// SEARCH index rather than a scrape: the query strings that actually return
// the part, the brands that make it, and the price band to expect. That also
// keeps the privacy posture intact — nothing here calls out to anyone, and the
// user's build never leaves the page.

export const ALI_BRANDS = [
  { id: "san-martin", name: "San Martin", tier: "premium", known: { en: "Best finishing of the AliExpress makers; complete watches and case sets.", sv: "Bäst finish av AliExpress-tillverkarna; hela klockor och boettsatser." } },
  { id: "steeldive", name: "Steeldive", tier: "mid", known: { en: "Budget divers and dive-case sets, widely distributed.", sv: "Budgetdykare och dykarboettsatser, brett distribuerade." } },
  { id: "heimdallr", name: "Heimdallr", tier: "mid", known: { en: "Vintage-diver homages — 62MAS, Willard, MM300 shapes.", sv: "Vintagedykarhommager — 62MAS, Willard, MM300." } },
  { id: "proxima", name: "Proxima", tier: "mid", known: { en: "Sister brand to Heimdallr; overlapping case catalogue.", sv: "Systermärke till Heimdallr; överlappande boettkatalog." } },
  { id: "sharkey", name: "Sharkey", tier: "budget", known: { en: "Very broad case range at low prices; QC varies by batch.", sv: "Mycket brett boettsortiment till låga priser; kvaliteten varierar mellan batcher." } },
  { id: "tandorio", name: "Tandorio", tier: "mid", known: { en: "Complete NH35 divers, including titanium turtles.", sv: "Kompletta NH35-dykare, inklusive turtles i titan." } },
  { id: "addiesdive", name: "Addiesdive", tier: "budget", known: { en: "Pre-modded NH35 watches rather than loose parts.", sv: "Färdigmodade NH35-klockor snarare än lösa delar." } },
  { id: "miuksi", name: "Miuksi", tier: "budget", known: { en: "Parts-first store: the widest variation, the lowest prices, the most variance.", sv: "Delbutik: störst variation, lägst priser, störst spridning i kvalitet." } },
  { id: "corgeut", name: "Corgeut", tier: "budget", known: { en: "Dress and pilot cases, often with mineral crystals.", sv: "Kläd- och pilotboetter, ofta med mineralglas." } },
  { id: "bliger", name: "Bliger", tier: "budget", known: { en: "Long-running parts brand; dress and field cases.", sv: "Långlivat delmärke; kläd- och fältboetter." } },
  { id: "baltany", name: "Baltany", tier: "mid", known: { en: "Field and vintage-dress cases, often 38–39 mm.", sv: "Fält- och vintageklädboetter, ofta 38–39 mm." } },
  { id: "merkur", name: "Merkur", tier: "mid", known: { en: "Vintage reissues, including hand-wound platforms.", sv: "Vintagenyutgåvor, även handuppdragna plattformar." } },
  { id: "thorn", name: "Thorn", tier: "mid", known: { en: "62MAS and vintage-diver case sets.", sv: "62MAS- och vintagedykarboettsatser." } },
];

/**
 * Turn a search phrase into the AliExpress search URL form their own results
 * use (`/w/wholesale-<slug>.html`).
 * @param {string} query
 * @returns {string}
 */
export function aliSearchUrl(query) {
  const slug = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "https://www.aliexpress.com/";
  return `https://www.aliexpress.com/w/wholesale-${slug}.html`;
}

/**
 * The sourcing rows for one build: every slot that carries an `ali` block,
 * with its search links resolved. This IS the pre-index — one lookup, no
 * network, deterministic order.
 * @param {Record<string, string> | null | undefined} build
 */
export function sourcingFor(build) {
  const { ids, parts } = resolveBuild(build);
  const rows = [];
  for (const slot of SLOTS) {
    const p = parts[slot.key];
    if (!p || !p.ali) continue;
    const queries = /** @type {string[]} */ (Array.isArray(p.ali.queries) ? p.ali.queries : []);
    rows.push({
      slot: slot.key,
      slotName: slot.name,
      id: ids[slot.key],
      name: p.name,
      brands: Array.isArray(p.ali.brands) ? p.ali.brands : [],
      priceUsd: p.ali.priceUsd || null,
      watchFor: p.ali.watchFor || null,
      links: queries.map((q) => ({ q, url: aliSearchUrl(q) })),
    });
  }
  return rows;
}

/** The whole case index, flattened for the catalogue endpoint and the docs. */
export function caseIndex() {
  return CASES.map((c) => ({
    id: c.id,
    name: c.name,
    homage: c.homage,
    shell: c.shell,
    platform: c.platform,
    dims: c.dims,
    crown: c.crown,
    bezel: c.bezel,
    wr: c.wr,
    src: c.src,
    srcUrl: (SOURCES[/** @type {keyof typeof SOURCES} */ (c.src)] || {}).url || "",
    ali: {
      brands: c.ali.brands,
      priceUsd: c.ali.priceUsd,
      links: c.ali.queries.map((q) => ({ q, url: aliSearchUrl(q) })),
      watchFor: c.ali.watchFor || null,
    },
  }));
}

// ---------------------------------------------------------------------------
// Permalink codec. A build is eleven short ids; the whole thing fits in a URL
// hash with room to spare. Unknown ids decode to the default rather than
// throwing, so an old link from a previous catalogue still opens.

/**
 * @param {Record<string, string> | null | undefined} build
 * @returns {string}
 */
export function encodeBuild(build) {
  const ids = normalizeBuild(build);
  return SLOTS.map((s) => `${s.key}:${ids[s.key]}`).join(";");
}

/**
 * @param {string | null | undefined} code
 * @returns {Record<string, string>}
 */
export function decodeBuild(code) {
  /** @type {Record<string, string>} */
  const raw = {};
  for (const pair of String(code || "").split(";")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    raw[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return normalizeBuild(raw);
}

// ---------------------------------------------------------------------------
// GEOMETRY. Watches are almost entirely solids of revolution — case flank,
// bezel, crystal, chapter ring, crown, case back — so one lathe builder plus a
// radius modulation (round / cushion / tonneau) covers the whole silhouette.
// Hands and lugs are extruded outlines. Everything below returns plain arrays;
// the renderer uploads them and never computes geometry itself.

/**
 * @typedef {{ r: number, y: number, s?: boolean }} ProfilePoint
 * A point on the 2D silhouette that gets revolved: `r` is the distance from
 * the axis, `y` the height, `s` true when the surface should shade smoothly
 * into the next segment (a dome) rather than creasing (a machined edge).
 */

/**
 * @typedef {{ positions: number[], normals: number[], uvs: number[], indices: number[] }} Mesh
 */

/** @returns {Mesh} */
function emptyMesh() {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Merge `b` into `a` in place, offsetting b's indices.
 * @param {Mesh} a
 * @param {Mesh} b
 * @returns {Mesh}
 */
export function mergeMesh(a, b) {
  const base = a.positions.length / 3;
  for (const v of b.positions) a.positions.push(v);
  for (const v of b.normals) a.normals.push(v);
  for (const v of b.uvs) a.uvs.push(v);
  for (const i of b.indices) a.indices.push(i + base);
  return a;
}

/**
 * The outline shape functions: given an angle, how far out the surface sits
 * relative to a circle of the same nominal radius. A watch case is a circle
 * (a diver), a superellipse (a cushion/Turtle), or a flattened superellipse
 * with corner facets (a Samurai).
 * @param {string} shell
 * @returns {(theta: number) => number}
 */
export function outlineFor(shell) {
  if (shell === "cushion") {
    // Superellipse |cos|^n + |sin|^n = 1 with n≈3.4 — square-ish with soft
    // corners, which is exactly what a 6309/Turtle case is.
    const n = 3.4;
    return (t) => {
      const c = Math.abs(Math.cos(t));
      const s = Math.abs(Math.sin(t));
      return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
    };
  }
  if (shell === "tonneau") {
    // Samurai: superelliptical but narrower across the 3–9 axis, with a
    // faceted flat where the crown guard slab sits.
    const n = 4.2;
    return (t) => {
      const c = Math.abs(Math.cos(t)) / 0.94;
      const s = Math.abs(Math.sin(t));
      const base = 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
      return base * (1 - 0.02 * Math.cos(4 * t));
    };
  }
  if (shell === "shroud") {
    // Tuna: round, with the shroud's four bolt lobes.
    return (t) => 1 + 0.012 * Math.cos(4 * t);
  }
  return () => 1;
}

/**
 * Revolve a silhouette. Creased points (no `s`) emit two rings so the two
 * adjacent faces keep their own normals; smooth points emit one shared ring.
 * @param {ProfilePoint[]} profile
 * @param {number} segments radial subdivisions
 * @param {(theta: number) => number} [radiusAt] outline modulation, default round
 * @returns {Mesh}
 */
export function lathe(profile, segments, radiusAt) {
  const mesh = emptyMesh();
  if (!Array.isArray(profile) || profile.length < 2 || segments < 3) return mesh;
  const shape = radiusAt || (() => 1);

  /**
   * The outward normal of segment [a, b] in the (r, y) half-plane. Valid
   * because every profile in this file is traversed counter-clockwise —
   * bottom centre, out, up, back in — so (dy, -dr) always points away from
   * the solid.
   * @param {ProfilePoint} a
   * @param {ProfilePoint} b
   */
  const segNormal = (a, b) => {
    const dr = b.r - a.r;
    const dy = b.y - a.y;
    const len = Math.hypot(dr, dy) || 1;
    return { nr: dy / len, ny: -dr / len };
  };
  /**
   * The shading normal at profile point `i`: averaged across the two adjacent
   * segments when the point is marked smooth (a dome), otherwise the normal of
   * the segment being emitted (a machined crease).
   * @param {number} i
   * @param {{ nr: number, ny: number }} fallback
   */
  const pointNormal = (i, fallback) => {
    const p = profile[i];
    if (!p.s || i === 0 || i === profile.length - 1) return fallback;
    const a = segNormal(profile[i - 1], p);
    const b = segNormal(p, profile[i + 1]);
    const nr = a.nr + b.nr;
    const ny = a.ny + b.ny;
    const len = Math.hypot(nr, ny) || 1;
    return { nr: nr / len, ny: ny / len };
  };

  // One BAND per profile segment, two rings per band. Smooth points get the
  // averaged normal in both bands that touch them, which shades identically to
  // sharing the vertices while keeping the index arithmetic trivial.
  /** @type {{ p: ProfilePoint, nr: number, ny: number }[]} */
  const rings = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    const sn = segNormal(a, b);
    const na = pointNormal(i, sn);
    const nb = pointNormal(i + 1, sn);
    rings.push({ p: a, nr: na.nr, ny: na.ny });
    rings.push({ p: b, nr: nb.nr, ny: nb.ny });
  }
  const cols = segments + 1;
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    for (let c = 0; c < cols; c++) {
      const t = (c / segments) * Math.PI * 2;
      const k = shape(t);
      const ct = Math.cos(t);
      const st = Math.sin(t);
      mesh.positions.push(ring.p.r * k * ct, ring.p.y, ring.p.r * k * st);
      // The modulation tilts the surface; approximating the normal with the
      // unmodulated one is within a couple of degrees for k within ±20 %,
      // which is all a cushion case uses.
      mesh.normals.push(ring.nr * ct, ring.ny, ring.nr * st);
      mesh.uvs.push(c / segments, ri / Math.max(1, rings.length - 1));
    }
  }
  for (let ri = 0; ri + 1 < rings.length; ri += 2) {
    // Rings come in pairs (end of one segment, start of the next); the quad
    // band spans a pair.
    for (let c = 0; c < segments; c++) {
      const a = ri * cols + c;
      const b = a + 1;
      const d = (ri + 1) * cols + c;
      const e = d + 1;
      mesh.indices.push(a, d, b, b, d, e);
    }
  }
  return mesh;
}

/**
 * A flat annulus (dial, chapter ring seat, insert face, case-back disc),
 * facing +y when `up`.
 * @param {number} rInner
 * @param {number} rOuter
 * @param {number} y
 * @param {number} segments
 * @param {boolean} [up]
 * @returns {Mesh}
 */
export function annulus(rInner, rOuter, y, segments, up = true) {
  const mesh = emptyMesh();
  const ny = up ? 1 : -1;
  const cols = segments + 1;
  for (let ring = 0; ring < 2; ring++) {
    const r = ring === 0 ? rInner : rOuter;
    for (let c = 0; c < cols; c++) {
      const t = (c / segments) * Math.PI * 2;
      mesh.positions.push(r * Math.cos(t), y, r * Math.sin(t));
      mesh.normals.push(0, ny, 0);
      // Radial UV so a dial/insert texture maps as a disc: centre at 0.5,0.5.
      const u = 0.5 + (r * Math.cos(t)) / (rOuter * 2);
      const v = 0.5 + (r * Math.sin(t)) / (rOuter * 2);
      mesh.uvs.push(u, v);
    }
  }
  for (let c = 0; c < segments; c++) {
    const a = c;
    const b = c + 1;
    const d = cols + c;
    const e = d + 1;
    if (up) mesh.indices.push(a, b, d, b, e, d);
    else mesh.indices.push(a, d, b, b, d, e);
  }
  return mesh;
}

/**
 * A cone band — a ring that rises as it goes outward, with the same radial
 * (disc) UVs as `annulus` so one disc texture maps onto either. This is the
 * chapter ring: a printed minute track angled up toward the crystal.
 * @param {number} rInner
 * @param {number} yInner
 * @param {number} rOuter
 * @param {number} yOuter
 * @param {number} segments
 * @returns {Mesh}
 */
export function cone(rInner, yInner, rOuter, yOuter, segments) {
  const mesh = emptyMesh();
  const dr = rOuter - rInner;
  const dy = yOuter - yInner;
  const len = Math.hypot(dr, dy) || 1;
  // Perpendicular to the slope, pointing up: the face you actually see.
  const nr = -dy / len;
  const ny = dr / len;
  const cols = segments + 1;
  for (let ring = 0; ring < 2; ring++) {
    const r = ring === 0 ? rInner : rOuter;
    const y = ring === 0 ? yInner : yOuter;
    for (let c = 0; c < cols; c++) {
      const t = (c / segments) * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);
      mesh.positions.push(r * ct, y, r * st);
      mesh.normals.push(nr * ct, ny, nr * st);
      mesh.uvs.push(0.5 + (r * ct) / (rOuter * 2), 0.5 + (r * st) / (rOuter * 2));
    }
  }
  for (let c = 0; c < segments; c++) {
    const a = c;
    const b = c + 1;
    const d = cols + c;
    const e = d + 1;
    mesh.indices.push(a, b, d, b, e, d);
  }
  return mesh;
}

/**
 * A closed box, used for lugs and strap links.
 * @param {number} w x extent
 * @param {number} h y extent
 * @param {number} d z extent
 * @param {[number, number, number]} at centre
 * @returns {Mesh}
 */
export function box(w, h, d, at) {
  const mesh = emptyMesh();
  const c = at;
  const half = [w / 2, h / 2, d / 2];
  // Each face names its normal plus two in-plane axes chosen so u × v = n,
  // which makes the quad wind counter-clockwise seen from outside.
  /** @type {{ n: [number,number,number], u: [number,number,number], v: [number,number,number] }[]} */
  const faces = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  for (const f of faces) {
    const base = mesh.positions.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      for (let axis = 0; axis < 3; axis++) {
        mesh.positions.push(
          c[axis] +
            f.n[axis] * half[axis] +
            f.u[axis] * su * half[axis] +
            f.v[axis] * sv * half[axis],
        );
      }
      mesh.normals.push(f.n[0], f.n[1], f.n[2]);
      mesh.uvs.push((su + 1) / 2, (sv + 1) / 2);
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh;
}

/**
 * Extrude a closed 2D outline (x, z) to a thickness in y. Used for hands.
 * The outline is expected counter-clockwise; the cap triangulation is a fan
 * from the first vertex, which is valid because every hand outline here is
 * convex-per-half by construction.
 * @param {[number, number][]} outline
 * @param {number} thickness
 * @param {number} y
 * @returns {Mesh}
 */
export function extrude(outline, thickness, y) {
  const mesh = emptyMesh();
  if (!outline || outline.length < 3) return mesh;
  const top = y + thickness / 2;
  const bot = y - thickness / 2;
  // Caps.
  for (const [yy, ny] of /** @type {[number, number][]} */ ([[top, 1], [bot, -1]])) {
    const base = mesh.positions.length / 3;
    for (const [x, z] of outline) {
      mesh.positions.push(x, yy, z);
      mesh.normals.push(0, ny, 0);
      mesh.uvs.push(0.5, 0.5);
    }
    for (let i = 1; i + 1 < outline.length; i++) {
      if (ny > 0) mesh.indices.push(base, base + i, base + i + 1);
      else mesh.indices.push(base, base + i + 1, base + i);
    }
  }
  // Walls.
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i];
    const [x1, z1] = outline[(i + 1) % outline.length];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;
    const base = mesh.positions.length / 3;
    mesh.positions.push(x0, bot, z0, x1, bot, z1, x1, top, z1, x0, top, z0);
    for (let k = 0; k < 4; k++) mesh.normals.push(nx, 0, nz);
    mesh.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// STRAPS, BRACELETS, THE WRIST CYLINDER AND THE BUCKLE.
//
// Feedback #56, verbatim: "Straps are made of blocks — little to no difference
// between jubilee and oyster bracelets, and rubber and leather look weird when
// made up of blocks", "starting angles of bracelet/strap is off — when worn
// straps don't start out straight out like they do here … make the default be
// that it is placed on a leather cylinder holder to simulate a wrist", and
// "would be nice to have a buckle for straps".
//
// All three were true of the same 45 lines: every strap was an identical chain
// of box() links (10 for a bracelet, 15 for anything else) that left the lug
// horizontally and ended in mid-air. What replaces it:
//
//   * ONE CONSTRUCTION PER FAMILY, from the researched table STRAP_GEOMETRY.
//     An Oyster is a three-link row, a Jubilee is five links with three
//     ROUNDED centres offset half a pitch, beads-of-rice is seven, a rubber
//     strap is a continuous tapering band with real surface relief, leather is
//     a crowned band with stitching, and a NATO is what a NATO actually is —
//     one nylon pass running UNDER the case with a second layer folded back
//     over it, keepers and metal rings.
//   * A REAL DEPARTURE ANGLE. The band leaves the lug tip already dropping
//     (STRAP_DRAPE.drop) and curves onto the wrist cylinder along a Hermite
//     that meets the cylinder TANGENTIALLY, then wraps it to 6 o'clock. No
//     sample is ever allowed inside the cylinder.
//   * THE CYLINDER ITSELF, exported as its own mesh and shown by default.
//   * A pin/tang buckle for leather, rubber and NATO; a fold-over clasp for
//     bracelets — both sized from the taper, at the width the strap has where
//     the hardware actually sits.
//
// THE RENDERER CONTRACT (public/js/watch-render.js owns every material; this
// file owns only geometry and the HINT that says what the geometry is made
// of). buildMeshes() returns:
//
//   meshes.strap          the band: bracelet links, rubber, leather, nylon,
//                         woven mesh. One material for the whole thing.
//   meshes.strapHardware  buckle, fold-over clasp, NATO rings. ALWAYS steel,
//                         whatever the band is — a leather strap must not end
//                         in a leather buckle. Empty for a strap that takes no
//                         hardware.
//   meshes.wrist          the leather-covered display cylinder the watch sits
//                         on. Present BY DEFAULT; buildMeshes(build, { wrist:
//                         false }) returns it empty so the page can toggle it.
//                         Axis along X, centred on x = 0.
//   strapMaterials        { strap, strapHardware, wrist }, each
//                         { kind, color, rough, metal, brush, useCaseFinish }.
//                         `kind` is the honest material name — "steel",
//                         "rubber", "leather", "nylon" — which is what #56's
//                         "leather shouldn't be shiny like a mirror" needs:
//                         leather is rough 0.92 / metal 0, and only
//                         useCaseFinish:true (bracelets) should take the
//                         case's own finish and brushing.
//   wrist                 { show, r, cy, len } — the cylinder's own numbers, so
//                         the page can ground a shadow on it.
//
// Nothing here reads the DOM, fetches, or allocates a timer; every builder
// returns the same plain {positions, normals, uvs, indices} the rest of the
// file does.

/** How the strap is draped, independent of what it is made of. */
export const STRAP_DRAPE = {
  // A 60 mm cylinder — a 188 mm wrist, and also the size of an ordinary
  // leather display roll. Listing-derived, so approximate by construction.
  wristR: 30,
  // How far below horizontal the band already points AS IT LEAVES THE LUG.
  // The old code left at 0° and that is exactly what "straps don't start out
  // straight out like they do here" was about.
  drop: 0.52,
  src: "community",
  approx: true,
};

/**
 * Construction data, one row per strap/bracelet family, keyed by catalogue id
 * with a fallback row per `kind` so a family the catalogue adds later still
 * renders as something honest rather than as boxes.
 *
 * Every number is read off a retailer listing rather than a drawing, so every
 * row is `approx: true` and names its `src`. Widths are FRACTIONS of the lug
 * width (the one dimension the case catalogue really knows); pitches, gaps and
 * thicknesses are millimetres. `n` is a superellipse exponent: 2 is a fully
 * round link, 6 is a flat one with a machined edge break.
 */
export const STRAP_GEOMETRY = {
  // --- link bracelets -------------------------------------------------------
  oyster: {
    build: "links",
    close: "clasp",
    pitch: 9.5,
    gap: 0.7,
    thick: 3,
    taper: 0.18,
    cols: [
      { w: 0.245, n: 5.5, h: 0.82, offset: 0 },
      { w: 0.44, n: 6, h: 1, offset: 0 },
      { w: 0.245, n: 5.5, h: 0.82, offset: 0 },
    ],
    src: "dupewatch",
    approx: true,
    note: {
      en: "Three-link row: one wide flat centre link between two narrower outer links, tapering 22 → 18 mm at the clasp.",
      sv: "Trelänksrad: en bred platt mittlänk mellan två smalare ytterlänkar, avsmalnande 22 → 18 mm vid låset.",
    },
  },
  jubilee: {
    build: "links",
    close: "clasp",
    // The single most visible difference from an Oyster, and the reason the
    // pitch is nearly half: a Jubilee row is short, and its three centre links
    // are rounded and offset half a pitch from the flat outer ones.
    pitch: 5.6,
    gap: 0.45,
    thick: 2.9,
    taper: 0.18,
    cols: [
      { w: 0.215, n: 6, h: 0.95, offset: 0 },
      { w: 0.115, n: 2, h: 1, offset: 0.5 },
      { w: 0.115, n: 2, h: 1, offset: 0.5 },
      { w: 0.115, n: 2, h: 1, offset: 0.5 },
      { w: 0.215, n: 6, h: 0.95, offset: 0 },
    ],
    src: "dupewatch",
    approx: true,
    note: {
      en: "Five-link row: three small rounded polished centre links between two larger brushed outer links.",
      sv: "Femlänksrad: tre små rundade polerade mittlänkar mellan två större borstade ytterlänkar.",
    },
  },
  "beads-of-rice": {
    build: "links",
    close: "clasp",
    pitch: 4.6,
    gap: 0.4,
    thick: 2.7,
    taper: 0.16,
    cols: [
      { w: 0.2, n: 6, h: 0.78, offset: 0 },
      { w: 0.1, n: 2, h: 1, offset: 0.5 },
      { w: 0.1, n: 2, h: 1, offset: 0.5 },
      { w: 0.1, n: 2, h: 1, offset: 0.5 },
      { w: 0.1, n: 2, h: 1, offset: 0.5 },
      { w: 0.1, n: 2, h: 1, offset: 0.5 },
      { w: 0.2, n: 6, h: 0.78, offset: 0 },
    ],
    src: "watchwiki",
    approx: true,
    note: {
      en: "Five to seven small rounded centre links — the grains of rice — between larger flat outer links.",
      sv: "Fem till sju små rundade mittlänkar — risgrynen — mellan större platta ytterlänkar.",
    },
  },
  president: {
    build: "links",
    close: "clasp",
    pitch: 5.2,
    gap: 0.4,
    thick: 3.1,
    taper: 0.14,
    cols: [
      { w: 0.21, n: 2, h: 0.85, offset: 0 },
      { w: 0.42, n: 2, h: 1, offset: 0.5 },
      { w: 0.21, n: 2, h: 0.85, offset: 0 },
    ],
    src: "watchwiki",
    approx: true,
    note: {
      en: "Three semi-circular links, the centre one about twice the width of the outers and offset 50 % from them.",
      sv: "Tre halvrunda länkar, mittlänken ungefär dubbelt så bred som ytterlänkarna och förskjuten 50 %.",
    },
  },
  engineer: {
    build: "links",
    close: "clasp",
    pitch: 6.4,
    gap: 0.45,
    thick: 2.8,
    taper: 0.14,
    cols: [
      { w: 0.172, n: 5, h: 1, offset: 0 },
      { w: 0.172, n: 5, h: 1, offset: 0.5 },
      { w: 0.172, n: 5, h: 1, offset: 0 },
      { w: 0.172, n: 5, h: 1, offset: 0.5 },
      { w: 0.172, n: 5, h: 1, offset: 0 },
    ],
    src: "watchwiki",
    approx: true,
    note: {
      en: "Five links of equal width, flattened and offset 50 % from each other — the sporty five-link.",
      sv: "Fem länkar av samma bredd, tillplattade och förskjutna 50 % mot varandra — den sportiga femlänken.",
    },
  },
  // --- woven surfaces (NOT discrete links) ----------------------------------
  mesh: {
    build: "woven",
    close: "clasp",
    thick: 2.1,
    thickEnd: 2.1,
    taper: 0.12,
    weave: { u: 1.1, s: 1.3, depth: 0.16 },
    src: "dupewatch",
    approx: true,
    note: {
      en: "Milanese is a woven wire surface, not a chain of links — modelled as one continuous band with a fine weave relief.",
      sv: "Milanese är en vävd trådyta, inte en kedja av länkar — modellerad som ett kontinuerligt band med fin vävrelief.",
    },
  },
  "shark-mesh": {
    build: "woven",
    close: "clasp",
    thick: 3.4,
    thickEnd: 3.4,
    taper: 0.1,
    weave: { u: 2.6, s: 3, depth: 0.45 },
    src: "dupewatch",
    approx: true,
    note: {
      en: "The same weave as Milanese but coarse and heavy — bigger cells, thicker band.",
      sv: "Samma väv som Milanese men grov och tung — större celler, tjockare band.",
    },
  },
  // --- rubber ---------------------------------------------------------------
  waffle: {
    build: "band",
    close: "buckle",
    section: "rubber",
    thick: 3.4,
    thickEnd: 2.6,
    taper: 0.09,
    keepers: 1,
    relief: { kind: "waffle", pitch: 2.6, depth: 0.38 },
    src: "unclestraps",
    approx: true,
    note: {
      en: "A continuous band tapering 22 → 20 mm at the buckle, with the waffle's raised grid standing off the surface.",
      sv: "Ett kontinuerligt band som avsmalnar 22 → 20 mm vid spännet, med våffelmönstrets upphöjda rutnät.",
    },
  },
  tropic: {
    build: "band",
    close: "buckle",
    section: "rubber",
    thick: 3.2,
    thickEnd: 2.4,
    taper: 0.09,
    keepers: 1,
    relief: { kind: "grooves", pitch: 2.2, depth: 0.32 },
    src: "unclestraps",
    approx: true,
    note: {
      en: "Same taper as the waffle; the pattern is transverse grooves cut across the band rather than a raised grid.",
      sv: "Samma avsmalning som våfflan; mönstret är tvärgående spår i bandet i stället för ett upphöjt rutnät.",
    },
  },
  // --- leather --------------------------------------------------------------
  leather: {
    build: "band",
    close: "buckle",
    section: "leather",
    thick: 3.5,
    thickEnd: 2,
    taper: 0.18,
    keepers: 2,
    relief: { kind: "stitch", inset: 1.7, pitch: 3.4, depth: 0.22 },
    src: "dryden",
    approx: true,
    note: {
      en: "Padded and tapered: ≈3.5 mm thick at the lug falling to ≈2 mm at the buckle, 22 → 18 mm wide, stitched along both edges.",
      sv: "Stoppat och avsmalnande: ≈3,5 mm tjockt vid bandinfästningen ned till ≈2 mm vid spännet, 22 → 18 mm brett, sytt längs båda kanterna.",
    },
  },
  // --- nylon ----------------------------------------------------------------
  nato: {
    build: "nato",
    close: "buckle",
    section: "nylon",
    thick: 1.2,
    thickEnd: 1.2,
    taper: 0,
    keepers: 3,
    src: "crownbuckle",
    approx: true,
    note: {
      en: "One continuous ≈1.2 mm nylon pass running UNDER the case, with the short second layer folded back over it; buckle plus three keeper rings, and the case therefore sits two nylon layers proud of the wrist.",
      sv: "Ett kontinuerligt ≈1,2 mm nylonband som löper UNDER boetten, med det korta andra lagret vikt tillbaka över det; spänne plus tre hållarringar, och boetten vilar därför två nylonlager ovanför handleden.",
    },
  },
};

/** Fallback row per `kind`, so an unknown id still builds as its material. */
const STRAP_KIND_FALLBACK = {
  bracelet: "oyster",
  rubber: "waffle",
  leather: "leather",
  nato: "nato",
};

/** Tang-buckle stock, from Strapcode's #64/#65 parts listings. */
export const BUCKLE_STOCK = { plate: 1.4, bar: 1.7, tongue: 2, open: 7, src: "strapcodebuckle", approx: true };

/**
 * Resolve one strap entry into the numbers the geometry needs. Never throws:
 * an unknown strap becomes a leather band rather than nothing, because a watch
 * head floating with no strap does not read as a finished build.
 * @param {any} caseEntry
 * @param {any} strapEntry
 */
export function strapPlan(caseEntry, strapEntry) {
  const key = strapEntry && strapEntry.id;
  const fallback = STRAP_KIND_FALLBACK[/** @type {keyof typeof STRAP_KIND_FALLBACK} */ ((strapEntry || {}).kind)];
  const g =
    STRAP_GEOMETRY[/** @type {keyof typeof STRAP_GEOMETRY} */ (key)] ||
    STRAP_GEOMETRY[/** @type {keyof typeof STRAP_GEOMETRY} */ (fallback)] ||
    STRAP_GEOMETRY.leather;
  const row = /** @type {any} */ (g);
  const lugW = (caseEntry && caseEntry.dims && caseEntry.dims.lugW) || 20;
  return {
    id: key || "leather",
    build: row.build,
    close: row.close,
    section: row.section || "steel",
    cols: row.cols || null,
    weave: row.weave || null,
    relief: row.relief || null,
    keepers: row.keepers || 0,
    pitch: row.pitch || 0,
    gap: row.gap || 0,
    thick: row.thick,
    thickEnd: row.thickEnd == null ? row.thick : row.thickEnd,
    taper: row.taper,
    // Nylon runs UNDER the case, so on a NATO the watch sits two layers proud
    // of the wrist and the cylinder has to drop by exactly that much.
    underCase: row.build === "nato" ? row.thick * 2 + 0.4 : 0,
    // The nylon is cut a hair under the lug width; everything else fills it.
    lugW: row.build === "nato" ? lugW - 0.4 : lugW,
    wristR: STRAP_DRAPE.wristR,
    drop: STRAP_DRAPE.drop,
    src: row.src,
    approx: row.approx === true,
    note: row.note || null,
  };
}

/**
 * @typedef {{ z: number, y: number, tz: number, ty: number, nz: number, ny: number, s: number }} StrapFrame
 * @typedef {{ frames: StrapFrame[], total: number, at: (s: number) => StrapFrame }} StrapPath
 */

/**
 * Turn a dense polyline in the (z, y) plane into an arc-length-parameterised
 * path with a continuous frame. The frame's `n` is the out-of-plane axis the
 * band's thickness stacks along; it is chosen once (pointing away from the
 * wrist axis) and then carried forward by continuity, which is what stops a
 * band flipping inside out halfway round the wrist.
 * @param {{ z: number, y: number }[]} pts
 * @param {number} seedZ
 * @param {number} seedY
 * @returns {StrapPath}
 */
function makeStrapPath(pts, seedZ, seedY) {
  /** @type {StrapFrame[]} */
  const frames = [];
  let s = 0;
  let pnz = 0;
  let pny = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tz = b.z - a.z;
    let ty = b.y - a.y;
    const tl = Math.hypot(tz, ty) || 1;
    tz /= tl;
    ty /= tl;
    let nz = -ty;
    let ny = tz;
    const ref = i === 0 ? nz * seedZ + ny * seedY : nz * pnz + ny * pny;
    if (ref < 0) {
      nz = -nz;
      ny = -ny;
    }
    pnz = nz;
    pny = ny;
    if (i > 0) s += Math.hypot(p.z - pts[i - 1].z, p.y - pts[i - 1].y);
    frames.push({ z: p.z, y: p.y, tz, ty, nz, ny, s });
  }
  const total = frames.length ? frames[frames.length - 1].s : 0;
  /** @param {number} q */
  const at = (q) => {
    if (!frames.length) return { z: 0, y: 0, tz: 0, ty: -1, nz: 0, ny: 1, s: 0 };
    if (q <= 0) return frames[0];
    if (q >= total) return frames[frames.length - 1];
    let lo = 0;
    let hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].s <= q) lo = mid;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[hi];
    const span = b.s - a.s || 1;
    const u = (q - a.s) / span;
    const mix = (/** @type {number} */ x, /** @type {number} */ y) => x + (y - x) * u;
    const tz = mix(a.tz, b.tz);
    const ty = mix(a.ty, b.ty);
    const tl = Math.hypot(tz, ty) || 1;
    const nz = mix(a.nz, b.nz);
    const ny = mix(a.ny, b.ny);
    const nl = Math.hypot(nz, ny) || 1;
    return { z: mix(a.z, b.z), y: mix(a.y, b.y), tz: tz / tl, ty: ty / tl, nz: nz / nl, ny: ny / nl, s: q };
  };
  return { frames, total, at };
}

/**
 * Where the wrist cylinder sits for this build. Its top surface is just under
 * the case back — or under the nylon layers, on a NATO.
 * @param {any} plan
 */
function wristAxis(plan) {
  return { r: plan.wristR, cy: -(plan.wristR + plan.underCase + 0.15) };
}

/**
 * The radius the band's CENTRELINE runs at: the cylinder, plus half the band,
 * plus enough clearance that the deepest part of the surface relief still does
 * not cut into the cylinder. A waffle's recessed grid is 0.38 mm deep, and
 * without this the strap eats the wrist it is lying on.
 * @param {any} plan
 */
function bandRadius(plan) {
  const depth = plan.weave ? plan.weave.depth : plan.relief ? plan.relief.depth : 0;
  return wristAxis(plan).r + plan.thick / 2 + depth + 0.05;
}

/**
 * WHERE THE STRAP IS BOLTED ON — the spring-bar centre, at 6 and 12 o'clock.
 *
 * This is a SEAM with the lug geometry in buildMeshes: the lugs are four boxes
 * reaching out to `l2l / 2` at height `thick * 0.3`, and the band has to start
 * on exactly that point or it reads as a floating slab with daylight between
 * it and the case — which is what a browser render of the old builder showed.
 * Both sides derive it from the same two catalogue numbers; if the lug code
 * ever moves, it should move by calling this.
 *
 * One case needs more than the catalogue's lug-to-lug: the Tuna's SHROUD is
 * wider than its lug-to-lug (47 mm across, 44.5 mm lug-to-lug), so anchoring
 * at `l2l / 2` starts the strap 1.25 mm INSIDE the case wall and buries it.
 * The anchor is therefore pushed out to clear whatever the shell's outline
 * really is at the lug angle — for every other case that clamp does nothing.
 *
 * @param {any} caseEntry
 * @returns {{ z: number, y: number, tuck: number }} `tuck` is how far back
 * toward the case the band starts, so the joint always overlaps. Running a
 * millimetre and a half INTO the case is deliberate: that end is inside solid
 * geometry and invisible, whereas stopping a hair short is a visible seam.
 */
export function lugAnchor(caseEntry) {
  const dims = (caseEntry && caseEntry.dims) || { l2l: 44, thick: 12, dia: 40 };
  // The lug axis is 12/6 o'clock, which is θ = π/2 in the lathe's frame.
  const wall = (dims.dia / 2) * outlineFor(caseEntry && caseEntry.shell)(Math.PI / 2);
  return { z: Math.max(dims.l2l / 2, wall + 0.35), y: dims.thick * 0.3, tuck: 1.6 };
}

/**
 * One arm of the strap: from the lug tip, bending down over the lug at the
 * drape's departure angle, onto the wrist cylinder TANGENTIALLY, then wrapped
 * round it to 6 o'clock.
 *
 * The lead-in is a cubic Hermite rather than a straight line because a strap
 * is stiff at the lug and slack further out; a straight run from the lug tip
 * to the tangent point plunges at nearly 75° and reads as a broken hinge. Any
 * sample the Hermite still drops inside the cylinder is pushed back out to its
 * surface, so the drape can sag but can never sink into the wrist.
 *
 * @param {any} caseEntry
 * @param {any} plan
 * @param {1 | -1} dir +1 is the 6 o'clock arm, −1 the 12 o'clock (buckle) arm
 * @param {number} [extend] extra wrap past 6 o'clock, in radians
 * @returns {StrapPath}
 */
export function strapPath(caseEntry, plan, dir, extend) {
  const w = wristAxis(plan);
  const rp = bandRadius(plan);
  const anchor = lugAnchor(caseEntry);
  const p = { z: dir * anchor.z, y: anchor.y };
  const dz = p.z;
  const dy = p.y - w.cy;
  const d = Math.hypot(dz, dy) || 1;
  const alpha = Math.atan2(dy, dz);
  const beta = Math.acos(Math.max(-1, Math.min(0.999, rp / d)));
  const thetaT = alpha - dir * beta;
  const t = { z: rp * Math.cos(thetaT), y: w.cy + rp * Math.sin(thetaT) };
  const d0 = { z: dir * Math.cos(plan.drop), y: -Math.sin(plan.drop) };
  const dT = { z: dir * Math.sin(thetaT), y: -dir * Math.cos(thetaT) };
  const len = Math.hypot(t.z - p.z, t.y - p.y);
  /** @type {{ z: number, y: number }[]} */
  const pts = [];
  // Start a shade BEHIND the anchor so the band overlaps the lug instead of
  // butting against it — a hairline gap here is what read as "detached
  // floating blocks" in the render.
  pts.push({ z: p.z - d0.z * anchor.tuck, y: p.y - d0.y * anchor.tuck });
  const lead = 18;
  for (let i = 0; i <= lead; i++) {
    const u = i / lead;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    pts.push({
      z: h00 * p.z + h10 * len * d0.z + h01 * t.z + h11 * len * dT.z,
      y: h00 * p.y + h10 * len * d0.y + h01 * t.y + h11 * len * dT.y,
    });
  }
  // Both arms stop at the bottom of the wrist — which is where a clasp or a
  // buckle really sits — plus whatever tail the caller asked for.
  const bottom = dir > 0 ? -Math.PI / 2 : Math.PI * 1.5;
  const span = Math.abs(bottom - thetaT) + (extend || 0);
  const arcN = Math.max(10, Math.ceil(span / 0.045));
  for (let i = 1; i <= arcN; i++) {
    const th = thetaT - dir * span * (i / arcN);
    pts.push({ z: rp * Math.cos(th), y: w.cy + rp * Math.sin(th) });
  }
  for (const q of pts) {
    const rz = q.z;
    const ry = q.y - w.cy;
    const r = Math.hypot(rz, ry);
    if (r > 1e-6 && r < rp) {
      q.z = (rz * rp) / r;
      q.y = w.cy + (ry * rp) / r;
    }
  }
  return makeStrapPath(pts, p.z, p.y - w.cy);
}

/**
 * A plain arc around the wrist — the tail that runs past the buckle, the
 * fold-over clasp's plates, the NATO's keepers.
 * @param {any} plan
 * @param {number} r
 * @param {number} th0
 * @param {number} th1
 * @returns {StrapPath}
 */
function wristArcPath(plan, r, th0, th1) {
  const w = wristAxis(plan);
  const n = Math.max(6, Math.ceil(Math.abs(th1 - th0) / 0.045));
  /** @type {{ z: number, y: number }[]} */
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const th = th0 + (th1 - th0) * (i / n);
    pts.push({ z: r * Math.cos(th), y: w.cy + r * Math.sin(th) });
  }
  return makeStrapPath(pts, Math.cos(th0), Math.sin(th0));
}

/**
 * A straight run in the (z, y) plane — the nylon under a NATO's case back.
 * @param {{ z: number, y: number }[]} pts
 * @param {number} seedZ
 * @param {number} seedY
 */
function polyPath(pts, seedZ, seedY) {
  return makeStrapPath(pts, seedZ, seedY);
}

/**
 * A superelliptic cross-section point. `n` = 2 is an ellipse (a rounded
 * Jubilee centre link, a President half-round); `n` = 6 is a flat link with a
 * machined edge break.
 * @param {number} a angle around the section
 * @param {number} halfW
 * @param {number} halfT
 * @param {number} n
 */
function superSection(a, halfW, halfT, n) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const p = 2 / Math.max(2, n);
  return {
    u: halfW * Math.sign(c) * Math.pow(Math.abs(c), p),
    v: halfT * Math.sign(s) * Math.pow(Math.abs(s), p),
  };
}

/**
 * Sweep a closed cross-section along a path. This is the one workhorse every
 * strap family shares: a link is a 6 mm sweep with caps, a rubber strap is a
 * 90 mm sweep with relief, a clasp plate is a flat sweep. Normals come from
 * the grid itself (finite differences), which is what makes surface relief —
 * a waffle grid, a woven cell, a stitch line — actually catch the light
 * instead of shading as if it were flat.
 *
 * @param {StrapPath} path
 * @param {number} s0
 * @param {number} s1
 * @param {{ cols: number, rowLen: number, caps?: boolean,
 *          section: (a: number, t: number, s: number) => { u: number, v: number } }} o
 * @returns {Mesh}
 */
function sweepTube(path, s0, s1, o) {
  const mesh = emptyMesh();
  const run = s1 - s0;
  if (!(run > 0.001)) return mesh;
  const cols = Math.max(4, Math.round(o.cols));
  const rows = Math.max(1, Math.ceil(run / Math.max(0.08, o.rowLen)));
  // HANDEDNESS. The frame's out-of-plane axis is forced to point AWAY from the
  // wrist on both arms, which makes (x, n, tangent) right-handed on one arm and
  // left-handed on the other. Traversing the section the other way round on the
  // left-handed arm is what keeps the outward face outward — without this the
  // 12 o'clock half of every strap renders inside out and back-face culling
  // eats it.
  const seed = path.at(s0);
  const hand = seed.ny * seed.tz - seed.ty * seed.nz < 0 ? -1 : 1;
  /** @type {{ ring: number[][], f: StrapFrame }[]} */
  const grid = [];
  for (let i = 0; i <= rows; i++) {
    const s = s0 + (run * i) / rows;
    const f = path.at(s);
    /** @type {number[][]} */
    const ring = [];
    for (let j = 0; j < cols; j++) {
      // Reverse the ORDER, never the angle: negating the angle would mirror
      // the section and put a leather strap's crowned face against the wrist.
      const jj = hand > 0 ? j : (cols - j) % cols;
      const sec = o.section((jj / cols) * Math.PI * 2, i / rows, s);
      ring.push([sec.u, f.y + sec.v * f.ny, f.z + sec.v * f.nz]);
    }
    grid.push({ ring, f });
  }
  const base = mesh.positions.length / 3;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j < cols; j++) {
      const p = grid[i].ring[j];
      const a = grid[Math.max(0, i - 1)].ring[j];
      const b = grid[Math.min(rows, i + 1)].ring[j];
      const c = grid[i].ring[(j + cols - 1) % cols];
      const e = grid[i].ring[(j + 1) % cols];
      const di = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const dj = [e[0] - c[0], e[1] - c[1], e[2] - c[2]];
      let nx = dj[1] * di[2] - dj[2] * di[1];
      let ny = dj[2] * di[0] - dj[0] * di[2];
      let nz = dj[0] * di[1] - dj[1] * di[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      mesh.positions.push(p[0], p[1], p[2]);
      mesh.normals.push(nx, ny, nz);
      mesh.uvs.push(j / cols, i / rows);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % cols;
      const a = base + i * cols + j;
      const b = base + i * cols + j1;
      const c = base + (i + 1) * cols + j1;
      const d = base + (i + 1) * cols + j;
      mesh.indices.push(a, b, c, a, c, d);
    }
  }
  if (o.caps !== false) {
    for (const end of [0, rows]) {
      const g = grid[end];
      const sign = end === 0 ? -1 : 1;
      const cap = mesh.positions.length / 3;
      for (let j = 0; j < cols; j++) {
        const p = g.ring[j];
        mesh.positions.push(p[0], p[1], p[2]);
        mesh.normals.push(0, sign * g.f.ty, sign * g.f.tz);
        mesh.uvs.push(0.5 + Math.cos((j / cols) * Math.PI * 2) / 2, 0.5 + Math.sin((j / cols) * Math.PI * 2) / 2);
      }
      for (let k = 1; k + 1 < cols; k++) {
        if (sign > 0) mesh.indices.push(cap, cap + k, cap + k + 1);
        else mesh.indices.push(cap, cap + k + 1, cap + k);
      }
    }
  }
  return mesh;
}

/**
 * Rigidly place a mesh built in local (x across, y outward, z forward) into a
 * path frame. Used for every piece of hardware, which is easier to model
 * upright and then drop onto the wrist than to sweep.
 * @param {Mesh} mesh
 * @param {StrapFrame} f
 * @returns {Mesh}
 */
function placeOnPath(mesh, f) {
  // (x, n, tangent) is left-handed on the 12 o'clock arm — see sweepTube.
  // Mirroring the local x axis makes the map a proper rotation again, so the
  // buckle's faces keep pointing outward. Every hardware part is symmetric
  // across x, so the mirror itself is invisible.
  const hand = f.ny * f.tz - f.ty * f.nz < 0 ? -1 : 1;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    const z = mesh.positions[i + 2];
    mesh.positions[i] = hand * x;
    mesh.positions[i + 1] = f.y + y * f.ny + z * f.ty;
    mesh.positions[i + 2] = f.z + y * f.nz + z * f.tz;
    const nx = mesh.normals[i];
    const ny = mesh.normals[i + 1];
    const nz = mesh.normals[i + 2];
    mesh.normals[i] = hand * nx;
    mesh.normals[i + 1] = ny * f.ny + nz * f.ty;
    mesh.normals[i + 2] = ny * f.nz + nz * f.tz;
  }
  return mesh;
}

/**
 * A soft square pulse in [0,1] — the plateau of a waffle cell.
 * @param {number} x
 */
function pulse(x) {
  const f = x - Math.floor(x);
  const d = 0.5 - Math.abs(f - 0.5);
  return Math.max(0, Math.min(1, d * 5 - 0.35));
}

/**
 * The out-of-plane displacement the surface pattern adds, in millimetres,
 * signed so it always pushes away from the band's mid-plane.
 * @param {any} plan
 * @param {number} u across the band, mm from the centre
 * @param {number} halfW
 * @param {number} v out-of-plane, mm
 * @param {number} halfT
 * @param {number} s along the band, mm
 */
function bandRelief(plan, u, halfW, v, halfT, s) {
  const face = halfT > 0 ? Math.min(1, Math.abs(v) / halfT) : 0;
  if (face < 0.35) return 0;
  const dir = v >= 0 ? 1 : -1;
  const w = plan.weave;
  if (w) {
    return dir * face * w.depth * Math.cos((2 * Math.PI * u) / w.u) * Math.cos((2 * Math.PI * s) / w.s);
  }
  const r = plan.relief;
  if (!r) return 0;
  if (r.kind === "waffle") {
    // Raised squares standing off a recessed grid — the pattern IS the strap.
    return dir * face * r.depth * (pulse(u / r.pitch) * pulse(s / r.pitch) - 0.45);
  }
  if (r.kind === "grooves") {
    const f = s / r.pitch - Math.floor(s / r.pitch);
    return -dir * face * r.depth * Math.max(0, 1 - Math.abs(f - 0.5) * 5);
  }
  if (r.kind === "stitch") {
    // A groove parallel to each edge with the stitches themselves raised in it.
    const off = Math.abs(Math.abs(u) - (halfW - r.inset));
    const line = Math.max(0, 1 - off * 2.2);
    const bump = 0.5 + 0.5 * Math.cos((2 * Math.PI * s) / r.pitch);
    return dir * face * r.depth * line * (bump * 1.6 - 0.9);
  }
  return 0;
}

/**
 * The band's cross-section before relief. Leather is crowned — padded and
 * domed on top, near flat underneath — which is why it cannot be the same
 * superellipse as rubber or nylon.
 * @param {number} a
 * @param {number} halfW
 * @param {number} halfT
 * @param {string} kind
 */
function bandSection(a, halfW, halfT, kind) {
  if (kind === "leather") {
    // 1.2346 = 2 / (1 + 0.62): the flattened underside would otherwise make a
    // "3.5 mm" strap 2.8 mm thick.
    const p = superSection(a, halfW, halfT * 1.2346, 3.2);
    if (p.v < 0) p.v *= 0.62;
    return p;
  }
  return superSection(a, halfW, halfT, kind === "nylon" ? 8 : 5);
}

/** How far a section reaches BELOW its mid-line, as a fraction of halfT. */
const SECTION_UNDERSIDE = { leather: 0.765 };

/**
 * A pin/tang buckle, modelled in the band's own plane so the strap runs
 * through the opening the way it does on the wrist. Sized from `width`, which
 * the caller reads off the taper AT THE POINT THE BUCKLE SITS — feedback #56
 * asked for a buckle, and a buckle that is not the strap's width there is a
 * worse answer than none.
 * @param {number} width
 * @param {number} thick
 * @returns {Mesh}
 */
export function buckleMesh(width, thick) {
  const m = emptyMesh();
  const stock = Math.max(BUCKLE_STOCK.plate, thick * 0.55);
  const bar = BUCKLE_STOCK.bar;
  const innerW = width + 0.9;
  const innerL = BUCKLE_STOCK.open;
  for (const sx of [-1, 1]) {
    mergeMesh(m, box(bar, stock, innerL + 2 * bar, [sx * (innerW / 2 + bar / 2), 0, 0]));
  }
  for (const sz of [-1, 1]) {
    mergeMesh(m, box(innerW, stock, bar, [0, 0, sz * (innerL / 2 + bar / 2)]));
  }
  // The tongue, hinged on the rear bar and lying across the opening.
  mergeMesh(m, box(BUCKLE_STOCK.tongue * 0.6, stock * 0.7, innerL * 0.94, [0, stock * 0.28, 0.3]));
  return m;
}

/**
 * A fold-over clasp: the cover plate plus the leaf under it, both swept along
 * the wrist so they curve with it rather than sitting on it as a slab.
 * @param {any} plan
 * @param {number} width
 * @param {number} q detail factor
 * @returns {Mesh}
 */
function claspMesh(plan, width, q) {
  const rp = bandRadius(plan);
  const half = 13 / rp;
  const cols = Math.max(8, Math.round(16 * q));
  const cover = wristArcPath(plan, rp + plan.thick * 0.32, -Math.PI / 2 - half, -Math.PI / 2 + half);
  const leaf = wristArcPath(plan, rp - plan.thick * 0.34, -Math.PI / 2 - half * 0.78, -Math.PI / 2 + half * 0.78);
  const m = emptyMesh();
  mergeMesh(
    m,
    sweepTube(cover, 0, cover.total, {
      cols,
      rowLen: 1.6 / q,
      section: (a) => superSection(a, width / 2, plan.thick * 0.3, 6),
    }),
  );
  mergeMesh(
    m,
    sweepTube(leaf, 0, leaf.total, {
      cols,
      rowLen: 1.6 / q,
      section: (a) => superSection(a, width * 0.42, plan.thick * 0.22, 6),
    }),
  );
  return m;
}

/**
 * A keeper — the loop that holds the strap's tail down. Same material as the
 * band on leather and rubber; a steel ring on a NATO.
 * @param {number} width
 * @param {number} thick
 * @returns {Mesh}
 */
function keeperMesh(width, thick) {
  const m = emptyMesh();
  const t = 0.9;
  const d = 2.6;
  const halfW = width / 2 + 0.55;
  const halfT = thick / 2 + 0.5;
  mergeMesh(m, box(halfW * 2 + t * 2, t, d, [0, halfT + t / 2, 0]));
  mergeMesh(m, box(halfW * 2 + t * 2, t, d, [0, -halfT - t / 2, 0]));
  for (const sx of [-1, 1]) mergeMesh(m, box(t, halfT * 2, d, [sx * (halfW + t / 2), 0, 0]));
  return m;
}

/**
 * The leather display cylinder the watch is presented on — feedback #56's
 * "make the default be that it is placed on a leather cylinder holder to
 * simulate a wrist". Axis along X, capped, with a small chamfer at each end so
 * the rim is not a razor edge.
 * @param {any} caseEntry
 * @param {any} strapEntry
 * @param {{ segments?: number }} [opts]
 * @returns {Mesh}
 */
export function wristMesh(caseEntry, strapEntry, opts) {
  const plan = strapPlan(caseEntry, strapEntry || { kind: "leather", id: "leather" });
  const w = wristAxis(plan);
  const segs = Math.max(24, Math.round(((opts && opts.segments) || 96) * 0.6));
  const len = Math.max(52, caseEntry.dims.dia * 2.2);
  const half = len / 2;
  const cham = 1.6;
  /** @type {{ x: number, r: number }[]} */
  const profile = [
    { x: -half, r: 0 },
    { x: -half, r: w.r - cham },
    { x: -half + cham, r: w.r },
    { x: half - cham, r: w.r },
    { x: half, r: w.r - cham },
    { x: half, r: 0 },
  ];
  const mesh = emptyMesh();
  const cols = segs + 1;
  for (const p of profile) {
    for (let c = 0; c < cols; c++) {
      const th = (c / segs) * Math.PI * 2;
      const st = Math.sin(th);
      const ct = Math.cos(th);
      mesh.positions.push(p.x, w.cy + p.r * st, p.r * ct);
      mesh.normals.push(0, st, ct);
      mesh.uvs.push(c / segs, (p.x + half) / len);
    }
  }
  // Cap and chamfer rows want their own normals; recompute them per row from
  // the profile slope so the flat ends do not shade as part of the barrel.
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    const dx = b.x - a.x;
    const dr = b.r - a.r;
    const l = Math.hypot(dx, dr) || 1;
    const nx = -dr / l;
    const nr = dx / l;
    for (const row of [i, i + 1]) {
      for (let c = 0; c < cols; c++) {
        const idx = (row * cols + c) * 3;
        const th = (c / segs) * Math.PI * 2;
        // Only the flat/chamfer rows are overwritten; the barrel keeps its
        // purely radial normal, which the two middle rows already have.
        if (Math.abs(nx) < 0.01) continue;
        mesh.normals[idx] = nx;
        mesh.normals[idx + 1] = nr * Math.sin(th);
        mesh.normals[idx + 2] = nr * Math.cos(th);
      }
    }
  }
  for (let i = 0; i + 1 < profile.length; i++) {
    for (let c = 0; c < segs; c++) {
      const a = i * cols + c;
      const b = (i + 1) * cols + c;
      mesh.indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return mesh;
}

/**
 * The material HINT per strap mesh. Geometry lives here; shading lives in
 * watch-render.js — this is the seam between them, and the reason feedback
 * #56's "leather shouldn't be shiny like a mirror" can be answered without the
 * core knowing what a shader is.
 * @param {any} strapEntry
 */
export function strapMaterialHint(strapEntry) {
  const kind = !strapEntry
    ? "leather"
    : strapEntry.kind === "bracelet"
      ? "steel"
      : strapEntry.kind === "nato"
        ? "nylon"
        : strapEntry.kind;
  const band =
    kind === "steel"
      ? { kind, color: (strapEntry && strapEntry.color) || "#9aa2ab", rough: 0.4, metal: 1, brush: true, useCaseFinish: true }
      : kind === "leather"
        ? { kind, color: (strapEntry && strapEntry.color) || "#4a3226", rough: 0.92, metal: 0, brush: false, useCaseFinish: false }
        : kind === "rubber"
          ? { kind, color: (strapEntry && strapEntry.color) || "#15171b", rough: 0.78, metal: 0, brush: false, useCaseFinish: false }
          : { kind: "nylon", color: (strapEntry && strapEntry.color) || "#2b3038", rough: 0.88, metal: 0, brush: false, useCaseFinish: false };
  return {
    strap: band,
    strapHardware: { kind: "steel", color: "#b6bec7", rough: 0.28, metal: 1, brush: false, useCaseFinish: true },
    wrist: { kind: "leather", color: "#5b4231", rough: 0.94, metal: 0, brush: false, useCaseFinish: false },
  };
}

/**
 * Build every strap mesh for one build in one pass: the band, its hardware and
 * the wrist cylinder. `strapMesh` and `strapHardwareMesh` are thin readers of
 * this so a caller that wants only one still pays for one construction.
 * @param {any} caseEntry
 * @param {any} strapEntry
 * @param {{ segments?: number, wrist?: boolean }} [opts]
 */
export function strapAssembly(caseEntry, strapEntry, opts) {
  const showWrist = !(opts && opts.wrist === false);
  const materials = strapMaterialHint(strapEntry);
  const band = emptyMesh();
  const hardware = emptyMesh();
  if (!strapEntry || !caseEntry || !caseEntry.dims) {
    return { band, hardware, wrist: emptyMesh(), materials, wristInfo: { show: false, r: 0, cy: 0, len: 0 }, plan: null };
  }
  const plan = strapPlan(caseEntry, strapEntry);
  const q = Math.max(0.25, Math.min(1, ((opts && opts.segments) || 96) / 96));
  const w = wristAxis(plan);
  const lugW = plan.lugW;
  const bandCols = Math.max(10, Math.round(26 * q));
  const reliefPitch = plan.weave ? plan.weave.s : plan.relief ? plan.relief.pitch : 0;
  const rowLen = (reliefPitch ? Math.min(1, reliefPitch / 2.5) : 1.15) / q;

  /** Width at arc length `s` on a path of length `total`, from the taper. */
  const widthOn = (/** @type {number} */ s, /** @type {number} */ total) =>
    lugW * (1 - plan.taper * Math.max(0, Math.min(1, total > 0 ? s / total : 0)));
  const thickOn = (/** @type {number} */ s, /** @type {number} */ total) =>
    plan.thick + (plan.thickEnd - plan.thick) * Math.max(0, Math.min(1, total > 0 ? s / total : 0));

  /** @param {StrapPath} path @param {number} s0 @param {number} s1 */
  const contBand = (path, s0, s1) =>
    sweepTube(path, s0, s1, {
      cols: bandCols,
      rowLen,
      section: (a, _t, s) => {
        const halfW = widthOn(s, path.total) / 2;
        const halfT = thickOn(s, path.total) / 2;
        const p = bandSection(a, halfW, halfT, plan.section);
        p.v += bandRelief(plan, p.u, halfW, p.v, halfT, s);
        // A leather strap thins toward the buckle, and a crowned section does
        // not reach as far below its mid-line as above it. The path is one
        // fixed radius, so both come off the OUTSIDE — otherwise the strap
        // lifts off the wrist exactly where it should still be touching.
        const under = (SECTION_UNDERSIDE[/** @type {keyof typeof SECTION_UNDERSIDE} */ (plan.section)] || 1) * halfT;
        p.v -= plan.thick / 2 - under;
        return p;
      },
    });

  /** @param {StrapPath} path @param {number} usable */
  const linkBand = (path, usable) => {
    const cols = plan.cols || [];
    const filled = cols.reduce((/** @type {number} */ a, /** @type {any} */ c) => a + c.w, 0);
    const gapEach = cols.length > 1 ? Math.max(0, 1 - filled) / (cols.length - 1) : 0;
    /** @type {number[]} */
    const centres = [];
    let acc = -0.5;
    for (const c of cols) {
      centres.push(acc + c.w / 2);
      acc += c.w + gapEach;
    }
    const secCols = Math.max(6, Math.round(10 * q));
    const rows = Math.max(1, Math.floor(usable / plan.pitch));
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      for (let ri = 0; ri < rows; ri++) {
        const s0 = ri * plan.pitch + (c.offset || 0) * plan.pitch;
        const s1 = s0 + plan.pitch - plan.gap;
        if (s1 > usable) continue;
        mergeMesh(
          band,
          sweepTube(path, s0, s1, {
            cols: secCols,
            rowLen: Math.max(1, (s1 - s0) / 3),
            section: (a, _t, s) => {
              const total = widthOn(s, path.total);
              const p = superSection(a, (total * c.w) / 2, (plan.thick * (c.h == null ? 1 : c.h)) / 2, c.n);
              p.u += centres[ci] * total;
              return p;
            },
          }),
        );
      }
    }
  };

  if (plan.build === "nato") {
    // The construction that makes a NATO a NATO: ONE strip through both spring
    // bars and under the case, with a short second layer folded back OVER it,
    // so the watch rides two nylon layers proud of the wrist.
    const anchor = lugAnchor(caseEntry);
    const lugZ = anchor.z;
    const lugY = anchor.y;
    const under = -(plan.thick * 1.5 + 0.35);
    /** @type {{ z: number, y: number }[]} */
    const bridge = [];
    for (let i = 0; i <= 26; i++) {
      const u = i / 26;
      bridge.push({ z: lugZ * (1 - 2 * u), y: under + (lugY - under) * Math.pow(Math.abs(2 * u - 1), 2.2) });
    }
    const bp = polyPath(bridge, 0, 1);
    mergeMesh(band, contBand(bp, 0, bp.total));
    // The folded-back flap, lying between the main strip and the case back and
    // running out past the 12 o'clock lug where it ends free.
    const flapY = -(plan.thick * 0.5 + 0.15);
    const fp = polyPath(
      [
        { z: lugZ * 0.32, y: flapY },
        { z: -lugZ - 4, y: flapY },
      ],
      0,
      1,
    );
    mergeMesh(
      band,
      sweepTube(fp, 0, fp.total, {
        cols: bandCols,
        rowLen: 2 / q,
        section: (a) => bandSection(a, (lugW - 0.6) / 2, plan.thick / 2, plan.section),
      }),
    );
  }

  const armPlus = strapPath(caseEntry, plan, 1, 0);
  const armMinus = strapPath(caseEntry, plan, -1, 0);
  const claspArc = plan.close === "clasp" ? 13.5 : 0;

  if (plan.build === "links") {
    linkBand(armPlus, Math.max(plan.pitch, armPlus.total - claspArc));
    linkBand(armMinus, Math.max(plan.pitch, armMinus.total - claspArc));
  } else {
    const buckleGap = plan.close === "buckle" ? 8 : claspArc;
    mergeMesh(band, contBand(armPlus, 0, armPlus.total));
    mergeMesh(band, contBand(armMinus, 0, Math.max(1, armMinus.total - buckleGap)));
  }

  if (plan.close === "clasp") {
    mergeMesh(hardware, claspMesh(plan, widthOn(armMinus.total, armMinus.total) + 0.5, q));
  } else {
    // The buckle sits at the 12 o'clock arm's end, at the width the taper
    // leaves the strap there — feedback #56 asked for a buckle, and one that
    // is not the strap's width where it sits is worse than none.
    const at = Math.max(0, armMinus.total - 4);
    const endW = widthOn(at, armMinus.total);
    const endT = thickOn(at, armMinus.total);
    mergeMesh(hardware, placeOnPath(buckleMesh(endW, endT), armMinus.at(at)));
    // The free tail: through the buckle and back over the other arm, so it
    // runs one thickness further out, with the keepers wrapping it there.
    const tail = wristArcPath(plan, bandRadius(plan) + plan.thick * 0.95, -Math.PI / 2 + 0.04, -Math.PI / 2 - 0.62);
    mergeMesh(
      band,
      sweepTube(tail, 0, tail.total, {
        cols: bandCols,
        rowLen,
        section: (a, _t, s) => {
          const p = bandSection(a, endW / 2, endT / 2, plan.section);
          p.v += bandRelief(plan, p.u, endW / 2, p.v, endT / 2, s + armPlus.total);
          return p;
        },
      }),
    );
    for (let k = 0; k < plan.keepers; k++) {
      const s = tail.total - 3.5 - k * 5.5;
      if (s < 0.5) continue;
      const km = placeOnPath(keeperMesh(endW, endT), tail.at(s));
      // A NATO's keepers are steel rings; a leather or rubber keeper is a loop
      // of the strap's own material and belongs to the band.
      mergeMesh(plan.section === "nylon" ? hardware : band, km);
    }
  }

  const wristInfo = {
    show: showWrist,
    r: w.r,
    cy: w.cy,
    len: Math.max(52, caseEntry.dims.dia * 2.2),
  };
  return {
    band,
    hardware,
    wrist: showWrist ? wristMesh(caseEntry, strapEntry, opts) : emptyMesh(),
    materials,
    wristInfo,
    plan,
  };
}

/**
 * The strap or bracelet band — the part made of the strap's own material.
 * Kept as its own export because that is what the renderer draws with the
 * strap material; the buckle/clasp comes back from strapHardwareMesh.
 * @param {any} caseEntry
 * @param {any} strapEntry
 * @param {{ segments?: number }} [opts]
 * @returns {Mesh}
 */
export function strapMesh(caseEntry, strapEntry, opts) {
  if (!strapEntry) return emptyMesh();
  return strapAssembly(caseEntry, strapEntry, opts).band;
}

/**
 * The strap's METAL: a pin/tang buckle on leather, rubber and NATO, a
 * fold-over clasp on a bracelet, plus a NATO's keeper rings. Always steel.
 * @param {any} caseEntry
 * @param {any} strapEntry
 * @param {{ segments?: number }} [opts]
 * @returns {Mesh}
 */
export function strapHardwareMesh(caseEntry, strapEntry, opts) {
  if (!strapEntry) return emptyMesh();
  return strapAssembly(caseEntry, strapEntry, opts).hardware;
}

// ---------------------------------------------------------------------------
// The case silhouette. One parametric profile per shell archetype, driven
// entirely by the catalogue's millimetres — change a dimension and the render
// changes with it, which is the point: the picture IS the spec sheet.

/**
 * @param {any} caseEntry
 * @param {any} crystalEntry
 * @returns {{ profile: ProfilePoint[], bezelTopY: number, dialY: number, crystalR: number, bezelR: number, domeH: number, caseTopY: number }}
 */
export function caseProfile(caseEntry, crystalEntry) {
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (caseEntry.platform)] || PLATFORMS.native;
  const R = caseEntry.dims.dia / 2;
  const T = caseEntry.dims.thick;
  const crystalR = (caseEntry.crystal ? caseEntry.crystal.dia : plat.crystalDia || caseEntry.dims.dia - 11) / 2;
  const hasBezel = caseEntry.bezel === "dive120";
  const bezelR = hasBezel ? R : R * 0.985;
  const domeH = crystalEntry ? 0.9 + crystalEntry.dome * 1.9 : 1.6;

  // Heights, from the case back upward. These ratios are what makes an SKX
  // read as an SKX and a 62MAS as a slim vintage piece; they are tuned so the
  // rendered silhouette matches the catalogue thickness exactly.
  const backY = 0;
  const backEdgeY = T * 0.1;
  const waistY = T * 0.42;
  const shoulderY = T * (hasBezel ? 0.6 : 0.72);
  const bezelTopY = T * (hasBezel ? 0.86 : 0.8);
  const caseTopY = bezelTopY;
  const dialY = T * 0.34;

  /** @type {ProfilePoint[]} */
  const profile = [];
  const shell = caseEntry.shell;
  // Case back: a shallow dome into the flank.
  profile.push({ r: 0, y: backY + (caseEntry.shell === "dress" ? 0.2 : 0.35) });
  profile.push({ r: R * 0.42, y: backY + 0.12, s: true });
  profile.push({ r: R * 0.66, y: backY, s: true });
  profile.push({ r: R * (shell === "shroud" ? 0.86 : 0.8), y: backEdgeY });
  // Flank.
  if (shell === "shroud") {
    profile.push({ r: R * 0.99, y: T * 0.22 });
    profile.push({ r: R, y: T * 0.62 });
    profile.push({ r: R * 0.93, y: T * 0.74 });
    profile.push({ r: bezelR * 0.86, y: T * 0.78 });
  } else if (shell === "dress" || shell === "field") {
    profile.push({ r: R * 0.95, y: waistY * 0.8, s: true });
    profile.push({ r: R, y: shoulderY });
    profile.push({ r: R * 0.995, y: bezelTopY - 0.35 });
  } else {
    profile.push({ r: R * 0.94, y: waistY, s: true });
    profile.push({ r: R * 0.999, y: shoulderY });
    profile.push({ r: R * 0.985, y: shoulderY + T * 0.04 });
  }
  // Bezel.
  if (hasBezel) {
    profile.push({ r: bezelR, y: shoulderY + T * 0.05 });
    profile.push({ r: bezelR * 0.995, y: bezelTopY });
    profile.push({ r: crystalR + 0.9, y: bezelTopY });
  } else {
    profile.push({ r: bezelR, y: bezelTopY });
    profile.push({ r: crystalR + 0.7, y: bezelTopY });
  }
  return { profile, bezelTopY, dialY, crystalR, bezelR, domeH, caseTopY };
}

/**
 * The crystal: a domed cap sitting on the bezel seat.
 * @param {number} crystalR
 * @param {number} y
 * @param {number} domeH
 * @param {number} segments
 * @returns {Mesh}
 */
export function crystalMesh(crystalR, y, domeH, segments) {
  /** @type {ProfilePoint[]} */
  const profile = [];
  const rings = 14;
  // Traversed edge → centre (r shrinking, y rising), which keeps the
  // counter-clockwise convention the lathe's normals assume.
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = crystalR * Math.cos((t * Math.PI) / 2);
    // A shallow spherical cap, not a hemisphere: dome height sets the sag.
    const h = domeH * Math.sin((t * Math.PI) / 2);
    profile.push({ r, y: y + h, s: i > 0 && i < rings });
  }
  return lathe(profile, segments);
}

// ---------------------------------------------------------------------------
// Hand outlines. Each is a closed polygon in (x = along the hand, z = across),
// normalised to length 1 and half-width in z. The renderer scales them to the
// dial radius; the counterweight tail is part of the outline so the hand
// balances visually the way a real one does.

/** @type {Record<string, (w: number) => [number, number][]>} */
const HAND_OUTLINES = {
  sword: (w) => [
    [-0.16, -w * 0.55],
    [0.05, -w],
    [0.82, -w * 0.42],
    [1, 0],
    [0.82, w * 0.42],
    [0.05, w],
    [-0.16, w * 0.55],
  ],
  arrow: (w) => [
    [-0.15, -w * 0.5],
    [0.1, -w * 0.62],
    [0.62, -w * 0.62],
    [0.66, -w * 1.5],
    [1, 0],
    [0.66, w * 1.5],
    [0.62, w * 0.62],
    [0.1, w * 0.62],
    [-0.15, w * 0.5],
  ],
  // Every outline reaches exactly 1.0 along its length: the hand set's `len`
  // is what decides reach, so a shape must not quietly shorten itself.
  mercedes: (w) => [
    [-0.16, -w * 0.5],
    [0.08, -w * 0.8],
    [0.44, -w * 0.8],
    [0.58, -w * 1.55],
    [1, 0],
    [0.58, w * 1.55],
    [0.44, w * 0.8],
    [0.08, w * 0.8],
    [-0.16, w * 0.5],
  ],
  snowflake: (w) => [
    [-0.14, -w * 0.45],
    [0.12, -w * 0.75],
    [0.5, -w * 1.25],
    [0.92, -w * 0.35],
    [1, 0],
    [0.92, w * 0.35],
    [0.5, w * 1.25],
    [0.12, w * 0.75],
    [-0.14, w * 0.45],
  ],
  plongeur: (w) => [
    [-0.14, -w * 0.5],
    [0.06, -w * 0.7],
    [0.55, -w * 0.7],
    [0.58, -w * 1.7],
    [0.95, -w * 1.7],
    [1, 0],
    [0.95, w * 1.7],
    [0.58, w * 1.7],
    [0.55, w * 0.7],
    [0.06, w * 0.7],
    [-0.14, w * 0.5],
  ],
  cathedral: (w) => [
    [-0.15, -w * 0.5],
    [0.05, -w * 0.7],
    [0.28, -w * 1.5],
    [0.55, -w * 1.5],
    [0.72, -w * 0.5],
    [1, 0],
    [0.72, w * 0.5],
    [0.55, w * 1.5],
    [0.28, w * 1.5],
    [0.05, w * 0.7],
    [-0.15, w * 0.5],
  ],
  dauphine: (w) => [
    [-0.12, -w * 0.35],
    [0.04, -w * 1.15],
    [1, 0],
    [0.04, w * 1.15],
    [-0.12, w * 0.35],
  ],
  baton: (w) => [
    [-0.14, -w * 0.55],
    [1, -w * 0.55],
    [1, w * 0.55],
    [-0.14, w * 0.55],
  ],
  needle: (w) => [
    [-0.26, -w * 0.55],
    [0.02, -w * 0.32],
    [1, -w * 0.12],
    [1, w * 0.12],
    [0.02, w * 0.32],
    [-0.26, w * 0.55],
  ],
  lollipop: (w) => [
    [-0.3, -w * 0.6],
    [0.02, -w * 0.3],
    [0.62, -w * 0.22],
    [0.68, -w * 1.5],
    [0.86, -w * 1.5],
    [0.92, -w * 0.22],
    [1, -w * 0.12],
    [1, w * 0.12],
    [0.92, w * 0.22],
    [0.86, w * 1.5],
    [0.68, w * 1.5],
    [0.62, w * 0.22],
    [0.02, w * 0.3],
    [-0.3, w * 0.6],
  ],
  gmtarrow: (w) => [
    [-0.24, -w * 0.5],
    [0.02, -w * 0.35],
    [0.74, -w * 0.35],
    [0.74, -w * 1.4],
    [1, 0],
    [0.74, w * 1.4],
    [0.74, w * 0.35],
    [0.02, w * 0.35],
    [-0.24, w * 0.5],
  ],
};

/**
 * A hand outline by shape id, scaled to `length` mm with `width` mm half-width.
 * Unknown shapes fall back to a baton — a missing hand is worse than a plain
 * one (invariant 2's fail-soft posture, applied to geometry).
 * @param {string} shape
 * @param {number} length
 * @param {number} width
 * @returns {[number, number][]}
 */
export function handOutline(shape, length, width) {
  const fn = HAND_OUTLINES[shape] || HAND_OUTLINES.baton;
  const w = width / length;
  return fn(w).map(([x, z]) => /** @type {[number, number]} */ ([x * length, z * length]));
}

export const HAND_SHAPES = Object.keys(HAND_OUTLINES);

// ---------------------------------------------------------------------------
// Dial and bezel LAYOUT. What to paint, not how — the renderer turns these
// into canvas strokes, and the unit tests check the counts and angles without
// a canvas anywhere.

/**
 * @param {any} dial
 * @param {number} radius dial radius in mm
 */
export function dialLayout(dial, radius) {
  const style = dial.markers;
  /** @type {{ hour: number, angle: number, kind: string, len: number, wid: number }[]} */
  const markers = [];
  const skip = new Set();
  if (dial.date === "3") skip.add(3);
  if (dial.day) skip.add(3);
  for (let h = 1; h <= 12; h++) {
    if (skip.has(h) && style !== "gs") continue;
    const angle = (h / 12) * Math.PI * 2;
    let kind = "bar";
    let len = 0.13;
    let wid = 0.05;
    if (style === "skx" || style === "sub") {
      if (h === 12) {
        kind = "triangle";
        len = 0.15;
        wid = 0.1;
      } else if (h === 6 || h === 9) {
        kind = "bar";
        len = 0.15;
        wid = 0.055;
      } else {
        kind = "dot";
        len = 0.085;
        wid = 0.085;
      }
    } else if (style === "62mas") {
      kind = h % 3 === 0 ? "bar" : "dot";
      len = h % 3 === 0 ? 0.16 : 0.08;
      wid = h % 3 === 0 ? 0.055 : 0.08;
    } else if (style === "explorer") {
      kind = h === 3 || h === 6 || h === 9 ? "numeral" : h === 12 ? "triangle" : "bar";
      len = 0.14;
    } else if (style === "california") {
      kind = h <= 6 ? "roman" : "numeral";
      len = 0.14;
    } else if (style === "roman") {
      kind = "roman";
      len = 0.14;
    } else if (style === "gs") {
      kind = "facet";
      len = 0.15;
      wid = 0.045;
    } else if (style === "alpinist") {
      kind = h % 3 === 0 ? "numeral" : "bar";
      len = 0.13;
    }
    markers.push({ hour: h, angle, kind, len: len * radius * 2, wid: wid * radius * 2 });
  }
  const ticks = [];
  for (let m = 0; m < 60; m++) {
    if (m % 5 === 0) continue;
    ticks.push({ minute: m, angle: (m / 60) * Math.PI * 2 });
  }
  return {
    radius,
    markers,
    ticks,
    date: dial.date,
    day: dial.day,
    gmt: dial.gmt,
    openHeart: dial.openHeart,
    text: Array.isArray(dial.text) ? dial.text : [],
  };
}

/**
 * The bezel scale: a dive bezel is 60 minutes with a lumed pip at zero; a GMT
 * bezel is 24 hours.
 * @param {any} insert
 */
export function bezelLayout(insert) {
  if (!insert || insert.scale === "none") return { scale: "none", ticks: [], numerals: [], pip: false };
  if (insert.scale === "hours24") {
    const numerals = [];
    for (let h = 0; h < 24; h += 2) numerals.push({ value: h, angle: (h / 24) * Math.PI * 2 });
    const ticks = [];
    for (let h = 0; h < 24; h++) ticks.push({ angle: (h / 24) * Math.PI * 2, major: h % 2 === 0 });
    return { scale: "hours24", ticks, numerals, pip: true, split: true };
  }
  const numerals = [];
  for (let m = 10; m < 60; m += 10) numerals.push({ value: m, angle: (m / 60) * Math.PI * 2 });
  const ticks = [];
  for (let m = 0; m < 60; m++) {
    ticks.push({ angle: (m / 60) * Math.PI * 2, major: m % 5 === 0, fine: m < 15 });
  }
  return { scale: "dive60", ticks, numerals, pip: true, split: !!insert.base2 };
}

// ---------------------------------------------------------------------------
// Assembling one build into meshes. This is the function the renderer calls;
// everything above it exists to make this one deterministic and testable.

/**
 * @param {Record<string, string> | null | undefined} build
 * @param {{ segments?: number, wrist?: boolean }} [opts]
 */
export function buildMeshes(build, opts) {
  const segments = (opts && opts.segments) || 96;
  const { parts } = resolveBuild(build);
  const cs = parts.case;
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)] || PLATFORMS.native;
  const geo = caseProfile(cs, parts.crystal);
  const dialR = plat.dialDia / 2;
  const outline = outlineFor(cs.shell);

  const caseMesh = lathe(geo.profile, segments, outline);

  // Lugs: four blocks reaching out to the catalogue's lug-to-lug.
  const lugs = emptyMesh();
  const lugThk = 2.3;
  const half = cs.dims.lugW / 2 + lugThk / 2;
  const reach = cs.dims.l2l / 2;
  // Start the lug well inside the case wall so it reads as machined from the
  // same block rather than glued on, and end it exactly at the catalogue's
  // lug-to-lug — that number IS this geometry.
  const inner = (cs.dims.dia / 2) * 0.8;
  const lugLen = Math.max(2, reach - inner);
  const lugY = cs.dims.thick * 0.3;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mergeMesh(
        lugs,
        box(lugThk, cs.dims.thick * 0.32, lugLen, [sx * half, lugY, sz * (inner + lugLen / 2)]),
      );
    }
  }
  // Crown. Lathed around Y like everything else; the renderer lays it on its
  // side and pushes it out to the case flank using the transform below.
  const crownAngle = (cs.crown.hour / 12) * Math.PI * 2 - Math.PI / 2;
  const crownR = cs.shell === "dress" ? 1.5 : 1.9;
  const crownOut = (cs.dims.dia / 2) * outline(crownAngle) + crownR * 0.75;
  const crown = lathe(
    [
      { r: 0, y: -crownR },
      { r: crownR * 0.9, y: -crownR },
      { r: crownR, y: -crownR * 0.55 },
      { r: crownR, y: crownR * 0.55 },
      { r: crownR * 0.9, y: crownR },
      { r: 0, y: crownR },
    ],
    Math.max(24, segments / 2),
  );
  const crownTransform = {
    x: Math.cos(crownAngle) * crownOut,
    z: Math.sin(crownAngle) * crownOut,
    y: cs.dims.thick * 0.45,
    angle: crownAngle,
  };

  // Dial, chapter ring, insert face, crystal. The chapter-ring cone is
  // traversed outer-top → inner-bottom so its VISIBLE face (the one angled up
  // toward the crystal) is the one that gets the outward normal.
  const dial = annulus(0, dialR, geo.dialY, segments);
  // Always modelled, on every platform. Without it the gap between the dial
  // edge and the crystal seat renders as a black void — the rehaut is a real
  // part of a real case, whether or not it carries a printed minute track.
  const chapterRing = cone(dialR - 0.1, geo.dialY + 0.05, geo.crystalR, geo.dialY + 1.15, segments);
  // The insert sits INSIDE the bezel, leaving a steel rim at the outer edge —
  // which is what a real bezel looks like and what stops the render reading as
  // one flat painted disc.
  const insertInner = geo.crystalR + 0.6;
  const insertOuter = geo.bezelR * 0.9;
  const insert =
    cs.bezel === "dive120"
      ? annulus(insertInner, insertOuter, geo.bezelTopY + 0.02, segments)
      : emptyMesh();
  const crystal = crystalMesh(geo.crystalR, geo.bezelTopY + 0.05, geo.domeH, segments);

  // Hands.
  const hs = parts.hands;
  const handY = geo.dialY + 0.55;
  /** @type {{ id: string, mesh: Mesh, y: number, color: string }[]} */
  const hands = [];
  const order = /** @type {const} */ (["hour", "minute", "gmt", "second"]);
  let lift = 0;
  for (const key of order) {
    const shape = /** @type {any} */ (hs.shapes)[key];
    if (!shape) continue;
    const len = /** @type {any} */ (hs.len)[key] * dialR;
    const width = key === "second" ? 0.28 : key === "hour" ? 1.15 : 0.9;
    hands.push({
      id: key,
      mesh: extrude(handOutline(shape, len, width), key === "second" ? 0.16 : 0.28, handY + lift),
      y: handY + lift,
      color: key === "second" ? hs.secondColor : key === "gmt" ? hs.gmtColor || hs.color : hs.color,
    });
    lift += 0.38;
  }

  // Case back — a shallow disc with a rim, seen only from below (or through a
  // display back, which the renderer tints rather than modelling the movement).
  const caseback = lathe(
    [
      { r: 0, y: -0.05 },
      { r: (cs.dims.dia / 2) * 0.62, y: -0.05, s: true },
      { r: (cs.dims.dia / 2) * 0.66, y: 0.35 },
    ],
    segments,
  );

  // Strap, hardware and the wrist cylinder. The cylinder is the DEFAULT
  // presentation (feedback #56); buildMeshes(build, { wrist: false }) drops it.
  // See the renderer contract above strapMesh for what each key is for.
  const strapKit = strapAssembly(cs, parts.strap, {
    segments,
    wrist: !(opts && opts.wrist === false),
  });

  return {
    meshes: {
      case: caseMesh,
      lugs,
      crown,
      dial,
      chapterRing,
      insert,
      crystal,
      caseback,
      strap: strapKit.band,
      strapHardware: strapKit.hardware,
      wrist: strapKit.wrist,
    },
    strapMaterials: strapKit.materials,
    wrist: strapKit.wristInfo,
    crownTransform,
    hands,
    geo,
    dialR,
    insertInner,
    insertOuter,
    platform: plat,
  };
}

// ---------------------------------------------------------------------------
// A tiny formatting helper the page and the docs share, so "≈" appears in
// exactly the same places in both.

/**
 * @param {number} value millimetres
 * @param {boolean} [approx] true when the source was a listing, not a spec sheet
 * @returns {string}
 */
export function mm(value, approx) {
  const n = Math.round(value * 100) / 100;
  return `${approx ? "≈" : ""}${n} mm`;
}
