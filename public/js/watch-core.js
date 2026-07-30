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
  longisland: {
    label: "Long Island Watch — #007-Flat flat sapphire for SKX007/SKX009 (31.5 mm × 2.9 mm, Seiko bevel on top)",
    url: "https://longislandwatch.com/products/flat-sapphire-crystal-for-skx007-skx009-007-flat",
  },
  watchmodz: {
    label: "Watch-Modz — SKX007 flat sapphire, NO bevel (31.5 mm × 3.5 mm)",
    url: "https://watch-modz.com/product/skx007-sapphire-clear-ar-flat-no-bevel/",
  },
  luciusatelier: {
    label: "Lucius Atelier — SKX007 double-domed sapphire, micro-bevel (~5.1 mm through the middle)",
    url: "https://luciusatelier.com/products/skx007-double-domed-sapphire-crystal-micro-bevel",
  },
  crystaltimesct094: {
    label: "CrystalTimes CT094 — SKX007/SRPD flat sapphire cut for sloping ceramic inserts (31.5 mm × 4.1 mm)",
    url: "https://usa.crystaltimes.net/shop/skx007-mod-parts/skx007-sapphire-crystals/ct094/",
  },
  nh36sheet: {
    label:
      "Seiko Instruments (TMI) NH36A technical sheet, page 8 \"Dial\" — revised 09 January 2014, Version 2; scale 5/1, unit 1 = 1/100 mm",
    url: "https://www.cousinsuk.com/PDF/categories/6809_Seiko%20NH36%20Technical%20Sheet.pdf",
  },
  nh35sheet: {
    label: "Hattori/Seiko Instruments NH35A specification, page 8 \"Dial\" — Version 1; scale 5/1, unit 1 = 1/100 mm",
    url: "https://gleave.london/content/TECH/Hattori%20NH35%20-%20Specification.pdf",
  },
  srpd55: {
    label: "Seiko USA — Seiko 5 Sports SRPD55 official product image (a 4R36/NH36 day-date aperture at 3)",
    url: "https://seikousa.com/products/srpd55",
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
      return base * (1 - 0.028 * Math.cos(4 * t));
    };
  }
  if (shell === "shroud") {
    // Tuna: round, with the shroud's four bolt lobes.
    return (t) => 1 + 0.018 * Math.cos(4 * t);
  }
  // Divers, dress cases and field cases are ROUND in plan — their character is
  // in the vertical profile (`caseProfile`), not in the plan silhouette, which
  // is why they share one outline and still render as different watches.
  return () => 1;
}

/**
 * The angular DERIVATIVE dk/dθ of `outlineFor(shell)`, by central difference.
 * `lathe` needs it to tilt the shading normal where the silhouette is not a
 * circle; without it a cushion case shades exactly like a round one and the
 * corners only show up in the outline. Numeric rather than analytic so a new
 * outline can never ship with a stale hand-derived slope.
 * @param {string} shell
 * @returns {(theta: number) => number}
 */
export function outlineSlopeFor(shell) {
  return slopeOf(outlineFor(shell));
}

/**
 * Central-difference derivative of any radius-modulation function.
 * @param {(theta: number) => number} fn
 * @param {number} [h]
 * @returns {(theta: number) => number}
 */
export function slopeOf(fn, h = 1e-4) {
  return (t) => (fn(t + h) - fn(t - h)) / (2 * h);
}

/**
 * A knurl / fluting modulation: `count` rounded ribs cut `depth` deep, as the
 * radius factor and its exact derivative. Used for the crown's grip and a dive
 * bezel's coin edge — real modelled serrations, not a texture.
 * @param {number} count
 * @param {number} depth fraction of the radius
 * @returns {{ k: (theta: number) => number, dk: (theta: number) => number }}
 */
export function knurl(count, depth) {
  return {
    k: (t) => 1 - depth * 0.5 * (1 - Math.cos(count * t)),
    dk: (t) => -depth * 0.5 * count * Math.sin(count * t),
  };
}

/**
 * Revolve a silhouette. Creased points (no `s`) emit two rings so the two
 * adjacent faces keep their own normals; smooth points emit one shared ring.
 * @param {ProfilePoint[]} profile
 * @param {number} segments radial subdivisions
 * @param {(theta: number) => number} [radiusAt] outline modulation, default round
 * @param {(theta: number) => number} [slopeAt] dk/dθ of `radiusAt`; when given
 *   the shading normal is tilted exactly rather than approximated, which is what
 *   makes modelled knurling and a cushion's corners actually catch the light
 * @returns {Mesh}
 */
export function lathe(profile, segments, radiusAt, slopeAt) {
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
      if (slopeAt) {
        // Exact normal for the surface (r(u)·k(θ)·cosθ, y(u), r(u)·k(θ)·sinθ):
        //   N = ( (k'·sinθ + k·cosθ)·y' , −r'·k² , (k·sinθ − k'·cosθ)·y' )
        // and the ring already carries y' as `nr` and −r' as `ny`. With k ≡ 1
        // it collapses to the unmodulated normal below, so passing a slope is
        // never a change of behaviour for a round case — only a correction for
        // a modulated one (a cushion's corners, a knurled crown's flutes).
        const dk = slopeAt(t);
        const nx = (dk * st + k * ct) * ring.nr;
        const ny = ring.ny * k * k;
        const nz = (k * st - dk * ct) * ring.nr;
        const len = Math.hypot(nx, ny, nz) || 1;
        mesh.normals.push(nx / len, ny / len, nz / len);
      } else {
        // The modulation tilts the surface; approximating the normal with the
        // unmodulated one is within a couple of degrees for k within ±20 %,
        // which is all a cushion case uses.
        mesh.normals.push(ring.nr * ct, ring.ny, ring.nr * st);
      }
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

/**
 * The strap or bracelet, as two arcs curving away from the lugs around an
 * imaginary wrist. A bracelet is a chain of separate links with visible gaps;
 * a rubber, NATO or leather strap is one continuous taper. Modelled rather
 * than faked because a watch head floating with no strap does not read as a
 * finished build — and because the lug width the catalogue carries is exactly
 * what sets its width.
 * @param {any} caseEntry
 * @param {any} strapEntry
 * @returns {Mesh}
 */
export function strapMesh(caseEntry, strapEntry) {
  const mesh = emptyMesh();
  if (!strapEntry) return mesh;
  const bracelet = strapEntry.kind === "bracelet";
  const width = caseEntry.dims.lugW;
  const startZ = caseEntry.dims.l2l / 2;
  const y0 = caseEntry.dims.thick * 0.3;
  // A 62 mm wrist radius is about a 195 mm circumference — an ordinary wrist.
  const wristR = 31;
  const links = bracelet ? 10 : 15;
  const thick = bracelet ? 1.6 : 2.2;
  const step = 0.155;
  for (const dir of [1, -1]) {
    for (let i = 0; i < links; i++) {
      const t = i / links;
      // Taper toward the clasp: bracelets keep more width than a strap does.
      const w = width * (1 - (bracelet ? 0.16 : 0.26) * t);
      const phi = (i + 0.5) * step;
      // The centre of this link on the wrist arc, measured from the lug tip.
      const cz = dir * (startZ + wristR * Math.sin(phi));
      const cy = y0 - wristR * (1 - Math.cos(phi));
      const segLen = wristR * step * (bracelet ? 0.84 : 1);
      const link = box(w, thick, segLen, [0, 0, 0]);
      // Rotate about X so the link's long (+z) axis follows the tangent
      // (0, −sin φ, dir·cos φ). Solving gives α = φ on one side and π − φ on
      // the other, which is what makes both arms curve DOWN and away rather
      // than one of them sweeping up through the case.
      const alpha = dir > 0 ? phi : Math.PI - phi;
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      for (let p = 0; p < link.positions.length; p += 3) {
        const py = link.positions[p + 1];
        const pz = link.positions[p + 2];
        link.positions[p + 1] = py * ca - pz * sa + cy;
        link.positions[p + 2] = py * sa + pz * ca + cz;
        const ny = link.normals[p + 1];
        const nz = link.normals[p + 2];
        link.normals[p + 1] = ny * ca - nz * sa;
        link.normals[p + 2] = ny * sa + nz * ca;
      }
      mergeMesh(mesh, link);
    }
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Placement and sweep helpers. Everything here is pure arithmetic over meshes
// the builders above produced — no new primitives, just moving them into place
// so a part can be MERGED into the solid it belongs to rather than drawn as a
// floating extra. (The renderer draws a fixed set of mesh keys; a part that
// wants to be seen has to arrive inside one of them.)

/**
 * Move a Y-axis lathe onto a RADIAL axis at `angle`, `out` mm from the centre,
 * `y` mm up — the same transform the renderer applies to the crown, so a part
 * placed here and a part placed there land in exactly the same spot.
 *
 * Local +Y ends up pointing INWARD (toward the case axis), which is why every
 * radial part below is modelled with its outer face at negative local y.
 * @param {Mesh} mesh mutated in place
 * @param {number} angle radians, 0 = +x
 * @param {number} out distance from the axis, mm
 * @param {number} y height, mm
 * @returns {Mesh}
 */
export function placeRadial(mesh, angle, out, y) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const py = mesh.positions[i + 1];
    const pz = mesh.positions[i + 2];
    mesh.positions[i] = -py * ca - pz * sa + out * ca;
    mesh.positions[i + 1] = x + y;
    mesh.positions[i + 2] = -py * sa + pz * ca + out * sa;
    const nx = mesh.normals[i];
    const ny = mesh.normals[i + 1];
    const nz = mesh.normals[i + 2];
    mesh.normals[i] = -ny * ca - nz * sa;
    mesh.normals[i + 1] = nx;
    mesh.normals[i + 2] = -ny * sa + nz * ca;
  }
  return mesh;
}

/**
 * The outer radius of a case profile at height `y`, by linear interpolation.
 * Used to plant the lugs and the crown ON the flank instead of near it.
 * @param {ProfilePoint[]} outer bottom-to-top outer flank points
 * @param {number} y
 * @returns {number}
 */
export function flankRadiusAt(outer, y) {
  if (!outer.length) return 0;
  if (y <= outer[0].y) return outer[0].r;
  for (let i = 0; i + 1 < outer.length; i++) {
    const a = outer[i];
    const b = outer[i + 1];
    if (y <= b.y) {
      const span = b.y - a.y;
      const f = span <= 1e-9 ? 1 : (y - a.y) / span;
      return a.r + (b.r - a.r) * f;
    }
  }
  return outer[outer.length - 1].r;
}

/**
 * Where the silhouette crosses the line x = `x`, i.e. how far along +z a lug at
 * that x has to start for its root to be BURIED in the flank rather than
 * hovering beside it. Fixed-point iteration on z = √((R·k(atan2(z,x)))² − x²);
 * `outline` is the plan modulation, so this is exact for a round case and
 * converges in a handful of steps for a cushion or a tonneau.
 * @param {number} x
 * @param {number} radius the unmodulated flank radius at the lug's height
 * @param {(theta: number) => number} outline
 * @returns {number} z ≥ 0 (0 when x is already outside the silhouette)
 */
export function silhouetteZ(x, radius, outline) {
  let z = radius;
  for (let i = 0; i < 32; i++) {
    const rr = radius * outline(Math.atan2(z, x));
    const next = Math.sqrt(Math.max(0, rr * rr - x * x));
    if (Math.abs(next - z) < 1e-9) return next;
    z = next;
  }
  return z;
}

/**
 * One LUG, swept as a solid: a rectangular section that tapers and droops from
 * a root buried inside the case flank out to a drilled-lug-style ROUNDED tip at
 * exactly the catalogue's lug-to-lug. This replaces the four axis-aligned boxes
 * that used to start at a fixed 0.8·R and therefore floated free of any case
 * whose silhouette was not a circle.
 * @param {{ x: number, z0: number, z1: number, halfW: number, rootTop: number,
 *           rootBot: number, tipTop: number, tipBot: number, stations?: number }} o
 * @returns {Mesh}
 */
export function lugMesh(o) {
  const mesh = emptyMesh();
  const len = o.z1 - o.z0;
  if (!(len > 0)) return mesh;
  const tipHalf = Math.max(0.25, (o.tipTop - o.tipBot) / 2);
  const rTip = Math.min(tipHalf, len * 0.45);
  const straight = Math.max(0, len - rTip);
  const body = o.stations || 8;
  const round = 6;

  /** @type {{ z: number, cy: number, halfH: number, halfW: number }[]} */
  const sections = [];
  /** @param {number} f 0 at the root, 1 at the tip */
  const at = (f) => {
    // Cubic-ish ease so the lug leaves the flank tangentially and only then
    // falls away — a real lug curves, it does not slope in a straight line.
    const e = f * f * (3 - 2 * f);
    const top = o.rootTop + (o.tipTop - o.rootTop) * e;
    const bot = o.rootBot + (o.tipBot - o.rootBot) * e;
    return { cy: (top + bot) / 2, halfH: (top - bot) / 2 };
  };
  for (let i = 0; i <= body; i++) {
    const f = (i / body) * (straight / len);
    const { cy, halfH } = at(f);
    sections.push({ z: o.z0 + f * len, cy, halfH, halfW: o.halfW * (1 - 0.12 * f) });
  }
  for (let i = 1; i <= round; i++) {
    const phi = (i / round) * (Math.PI / 2);
    const f = (straight + rTip * Math.sin(phi)) / len;
    const { cy, halfH } = at(Math.min(1, f));
    const shrink = Math.cos(phi);
    sections.push({
      z: o.z0 + Math.min(1, f) * len,
      cy,
      halfH: Math.max(1e-3, halfH * shrink),
      halfW: o.halfW * 0.88 * (0.55 + 0.45 * shrink),
    });
  }

  /** Corner order runs counter-clockwise seen from +z, so the caps wind right. */
  /** @param {{ z: number, cy: number, halfH: number, halfW: number }} s @param {number} k */
  const corner = (s, k) => {
    const sx = k === 0 || k === 3 ? -1 : 1;
    const sy = k < 2 ? -1 : 1;
    return [o.x + sx * s.halfW, s.cy + sy * s.halfH, s.z];
  };
  /** @param {number[]} p @param {number[]} n */
  const push = (p, n) => {
    mesh.positions.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    mesh.normals.push(n[0] / l, n[1] / l, n[2] / l);
    mesh.uvs.push(0.5, 0.5);
  };
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    for (let k = 0; k < 4; k++) {
      const a0 = corner(a, k);
      const a1 = corner(a, (k + 1) % 4);
      const b0 = corner(b, k);
      const b1 = corner(b, (k + 1) % 4);
      // Face normal from the quad's own edges: the swept faces are not
      // axis-aligned once the lug tapers and droops.
      const e1 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
      const e2 = [b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const base = mesh.positions.length / 3;
      push(a0, n);
      push(a1, n);
      push(b1, n);
      push(b0, n);
      mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  // Caps. The root cap is buried inside the case and never seen; it is emitted
  // anyway so the lug is a closed solid on its own — a hole is a hole even when
  // something else happens to be in front of it.
  for (const [s, dir] of /** @type {[any, number][]} */ ([[sections[0], -1], [sections[sections.length - 1], 1]])) {
    const base = mesh.positions.length / 3;
    const order = dir > 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
    for (const k of order) push(corner(s, k), [0, 0, dir]);
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// The case silhouette. One parametric profile per shell archetype, driven
// entirely by the catalogue's millimetres — change a dimension and the render
// changes with it, which is the point: the picture IS the spec sheet.

/**
 * One entry per shell archetype: the vertical character of the flank, as
 * fractions of the case radius and thickness. These are what stop an SKX, a
 * Turtle, a 62MAS and a dress case from reading alike — the plan silhouette
 * (`outlineFor`) only separates the cushion/tonneau/shroud families, and three
 * of the six archetypes are round in plan.
 *
 * NOT millimetres and not sourced: they are shape ratios of a procedural model,
 * the same kind of number the profile has always carried. Every actual
 * DIMENSION in the rendered case still comes from `caseEntry.dims`.
 * @type {Record<string, { rim: number, seatF: number, topF: number,
 *   flank: (R: number, T: number, k: { slim: number, beefy: number, reach: number }) => ProfilePoint[] }>}
 */
export const SHELL_ARCHETYPES = {
  // A diver's flank is a barrel with a waist: it tucks in above the case-back
  // bevel and swells back out to a shoulder just under the bezel. How MUCH it
  // tucks is what separates a slab-sided 300 m case from a slim vintage one,
  // so the waist is driven by the catalogue's water resistance and thickness.
  diver: {
    rim: 0.87,
    seatF: 0.62,
    topF: 0.855,
    flank: (R, T, k) => {
      const waist = 0.055 * (1.3 - 0.7 * k.beefy) * (1.25 - 0.45 * k.slim);
      return [
        { r: R * (0.955 + 0.025 * k.beefy), y: T * (0.10 + 0.03 * k.slim), s: true },
        { r: R * (1 - waist), y: T * 0.40, s: true },
        { r: R * 0.998, y: T * (0.50 + 0.06 * k.beefy) },
        { r: R * 0.99, y: T * 0.62 },
      ];
    },
  },
  // A cushion is fattest LOW and tucks under as it rises — that undercut is
  // the whole read of a 6309/Turtle, and it is why the bezel of a Turtle looks
  // small for the case.
  cushion: {
    rim: 0.90,
    seatF: 0.64,
    topF: 0.865,
    flank: (R, T, k) => [
      { r: R * 0.995, y: T * 0.16, s: true },
      { r: R * 1.0, y: T * 0.34, s: true },
      { r: R * (0.95 - 0.02 * (1 - k.slim)), y: T * 0.54, s: true },
      { r: R * 0.925, y: T * 0.64 },
    ],
  },
  // The Samurai: every surface is a flat meeting another flat. No smoothing
  // anywhere, and a machined groove partway up the flank.
  tonneau: {
    rim: 0.88,
    seatF: 0.66,
    topF: 0.855,
    flank: (R, T) => [
      { r: R * 0.985, y: T * 0.14 },
      { r: R * 0.955, y: T * 0.30 },
      { r: R * 1.0, y: T * 0.50 },
      { r: R * 0.93, y: T * 0.66 },
    ],
  },
  // The Tuna: a shroud bolted OVER the case, so the profile steps hard outward
  // at the shroud's bottom lip and the bezel ends up deeply recessed.
  shroud: {
    rim: 0.80,
    seatF: 0.80,
    topF: 0.90,
    flank: (R, T) => [
      { r: R * 0.86, y: T * 0.10 },
      { r: R * 0.845, y: T * 0.20 },
      { r: R * 1.0, y: T * 0.30 },
      { r: R * 1.0, y: T * 0.70 },
      { r: R * 0.93, y: T * 0.78 },
      { r: R * 0.86, y: T * 0.80 },
    ],
  },
  // A dress case swells low and tapers to a wide polished bevel at the top —
  // the opposite order to a diver, which is why the two never read alike even
  // when both are round in plan.
  dress: {
    rim: 0.86,
    seatF: 0.74,
    topF: 0.80,
    flank: (R, T, k) => [
      { r: R * 0.945, y: T * 0.10, s: true },
      { r: R * 1.0, y: T * (0.28 + 0.04 * k.reach), s: true },
      { r: R * 0.955, y: T * 0.60 },
      { r: R * 0.90, y: T * 0.74 },
    ],
  },
  // A field case has no bezel at all: a straight taper with one bevel, and the
  // crystal running almost to the case edge.
  field: {
    rim: 0.87,
    seatF: 0.78,
    topF: 0.84,
    flank: (R, T) => [
      { r: R * 0.99, y: T * 0.12, s: true },
      { r: R * 1.0, y: T * 0.44 },
      { r: R * 0.985, y: T * 0.70 },
      { r: R * 0.955, y: T * 0.78 },
    ],
  },
};

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * @typedef {{ profile: ProfilePoint[], outer: ProfilePoint[], bezelProfile: ProfilePoint[]|null,
 *   bezelTopY: number, bezelSeatY: number, dialY: number, crystalR: number, bezelR: number,
 *   towerR: number, boreR: number, boreBotR: number, apertureR: number, dialR: number,
 *   insertInner: number, insertOuter: number,
 *   seatFloorY: number, floorY: number, domeH: number, caseTopY: number, crystalTop: number,
 *   crownY: number, hasBezel: boolean }} CaseGeometry
 */

/**
 * The case as a SHELL, not a silhouette. `profile` is a CLOSED cross-section —
 * outer flank up, over the top, down the case BORE, back along the bottom — so
 * revolving it produces a solid with an inside. Before this, the case was a
 * single lathed surface with no inner wall and a hole in the bottom, and from
 * any angle past the dial edge you looked straight through the watch; the
 * fragment shader's backface normal flip was the only thing hiding it.
 *
 * `outer` is the same flank on its own, bottom rim to bezel seat — the lugs and
 * the crown plant themselves on it via `flankRadiusAt`.
 * @param {any} caseEntry
 * @param {any} crystalEntry
 * @returns {CaseGeometry}
 */
export function caseProfile(caseEntry, crystalEntry) {
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (caseEntry.platform)] || PLATFORMS.native;
  const D = caseEntry.dims.dia;
  const R = D / 2;
  const T = caseEntry.dims.thick;
  const L = caseEntry.dims.l2l || D;
  const crystalR = (caseEntry.crystal ? caseEntry.crystal.dia : plat.crystalDia || D - 11) / 2;
  const dialR = plat.dialDia / 2;
  const hasBezel = caseEntry.bezel === "dive120";
  const arch = SHELL_ARCHETYPES[caseEntry.shell] || SHELL_ARCHETYPES.diver;

  // The three catalogue-derived character scalars every archetype reads. All of
  // them come from `dims` and `wr`, so two cases that differ in the catalogue
  // cannot come out of here identical.
  const k = {
    slim: clamp((T / D - 0.27) / 0.075, 0, 1),
    beefy: clamp(((caseEntry.wr || 100) - 100) / 200, 0, 1),
    reach: clamp((L / D - 0.94) / 0.28, 0, 1),
  };

  const bezelSeatY = T * arch.seatF;
  const bezelTopY = T * arch.topF;
  const caseTopY = bezelTopY;
  // The dial plane. 40 % of the case height leaves the NH movement's 5.32 mm
  // underneath it, which is what actually decides this number.
  const dialY = T * 0.4;
  const seatFloorY = dialY + 1.15;
  const floorY = Math.max(0.8, dialY - 3.2);

  // The BORE: the case's inner diameter. It has to clear the dial, and on a
  // platform whose crystal is smaller than its dial (SKX013) it stays wider
  // than the crystal seat, which is what puts a real overhanging lip over the
  // dial edge instead of an impossible inverted rehaut.
  const boreR = Math.max(dialR + 0.35, crystalR);
  const boreBotR = boreR + 0.45;
  const apertureR = Math.min(crystalR, boreR);
  const towerR = crystalR + 0.5;

  const flank = arch.flank(R, T, k);
  const rimR = Math.max(R * arch.rim, boreBotR + 0.6);
  /** @type {ProfilePoint[]} */
  const outer = [{ r: rimR, y: 0 }];
  for (const p of flank) if (p.y < bezelSeatY) outer.push(p);
  outer.push({ r: flank.length ? flank[flank.length - 1].r : R * 0.99, y: bezelSeatY });

  /** @type {ProfilePoint[]} */
  const profile = [{ r: boreBotR, y: 0 }];
  for (const p of outer) profile.push(p);
  if (hasBezel) {
    // The case carries a raised crystal TOWER that the bezel ring rides around;
    // the ledge between them is the bezel seat.
    profile.push({ r: towerR, y: bezelSeatY });
    profile.push({ r: towerR, y: bezelTopY });
  } else {
    profile.push({ r: R * (caseEntry.bezel === "fixed" ? 0.985 : 0.96), y: bezelTopY });
  }
  profile.push({ r: crystalR, y: bezelTopY });
  // Inner wall, top-down: crystal seat well → dial/rehaut seat → bore →
  // case-back recess → the bottom face, closing the loop on the first point.
  profile.push({ r: crystalR, y: seatFloorY });
  if (Math.abs(boreR - crystalR) > 1e-6) profile.push({ r: boreR, y: seatFloorY });
  profile.push({ r: boreR, y: floorY + 0.5 });
  profile.push({ r: boreBotR, y: floorY });
  profile.push({ r: boreBotR, y: 0 });

  /** @type {ProfilePoint[] | null} */
  let bezelProfile = null;
  const bezelR = hasBezel ? flankRadiusAt(outer, bezelSeatY) : R * (caseEntry.bezel === "fixed" ? 0.985 : 0.96);
  // The insert sits INSIDE the bezel, leaving a steel rim at the outer edge.
  // Both radii live here so the bezel's recess and the insert disc cannot drift
  // apart into a floating ring.
  const insertOuter = bezelR * 0.955;
  const insertInner = Math.min(towerR + 0.25, Math.max(crystalR + 0.15, insertOuter - 0.3));
  if (hasBezel) {
    const rimTop = bezelTopY + 0.25;
    const recessR = Math.min(bezelR - 0.2, insertOuter + 0.2);
    const inner = towerR + 0.1;
    const ch = Math.min(0.35, (rimTop - bezelSeatY) * 0.2);
    bezelProfile = [
      { r: inner, y: bezelSeatY },
      { r: bezelR, y: bezelSeatY },
      { r: bezelR, y: rimTop - ch },
      { r: bezelR - ch, y: rimTop },
      { r: recessR, y: rimTop },
      { r: recessR, y: bezelTopY },
      { r: inner, y: bezelTopY },
      { r: inner, y: bezelSeatY },
    ];
  }

  // The crystal's PROUD height: the family's sourced thickness times the share
  // of it that stands above the seat, capped so a box crystal on a slim case
  // cannot tower over the catalogue's total thickness.
  const fam = CRYSTAL_FAMILIES[crystalFamily(crystalEntry)];
  const domeH = clamp(fam.thick * fam.proudF, 0.5, Math.max(0.6, T * 1.12 - bezelTopY));

  // The crown belongs at the flank's CREST, which is where a real one is
  // machined in. Found rather than guessed, so it lands right on every
  // archetype — and never at y = 0, where the bottom rim can be the widest
  // point (the Tuna's shroud is).
  let crownY = T * 0.45;
  let crest = -1;
  for (const p of outer) {
    if (p.y > T * 0.12 && p.y < bezelSeatY && p.r > crest) {
      crest = p.r;
      crownY = p.y;
    }
  }

  return {
    profile,
    outer,
    bezelProfile,
    bezelTopY,
    bezelSeatY,
    dialY,
    crystalR,
    bezelR,
    towerR,
    boreR,
    boreBotR,
    apertureR,
    dialR,
    insertInner,
    insertOuter,
    seatFloorY,
    floorY,
    domeH,
    caseTopY,
    crystalTop: bezelTopY + domeH,
    crownY,
    hasBezel,
  };
}

// ---------------------------------------------------------------------------
// CRYSTALS as real profiles. A flat sapphire is FLAT — a flat top face, a
// vertical wall and the bevel Seiko puts on the top edge — not a low dome, and
// a box crystal has near-vertical walls under a flat top rather than a taller
// version of the same cap. The four families are genuinely different solids.
//
// `thick` is the crystal's total thickness in millimetres and carries a source;
// `proudF` is the share of it standing above the bezel seat, which is a
// modelling ratio and is flagged as such rather than dressed up as a
// measurement (no invented millimetres).

/**
 * @type {Record<string, { id: string, name: {en:string,sv:string}, thick: number,
 *   proudF: number, approx: boolean, src: string, note?: {en:string,sv:string} }>}
 */
export const CRYSTAL_FAMILIES = {
  flat: {
    id: "flat",
    name: { en: "Flat", sv: "Plan" },
    thick: 2.9,
    proudF: 0.38,
    approx: false,
    src: "longisland",
    note: {
      en: "Sources disagree on how thick a flat SKX sapphire is: Long Island Watch's #007-Flat is 31.5 × 2.9 mm with the classic Seiko bevel on top, Watch-Modz's no-bevel cut is 3.5 mm, and CrystalTimes' CT094 for sloping ceramic inserts is 4.1 mm. The bevelled 2.9 mm one is modelled here.",
      sv: "Källorna är oense om hur tjockt ett plant SKX-safirglas är: Long Island Watch #007-Flat är 31,5 × 2,9 mm med Seikos klassiska fas upptill, Watch-Modz ofasade variant är 3,5 mm och CrystalTimes CT094 för lutande keraminlägg är 4,1 mm. Här modelleras det fasade 2,9 mm-glaset.",
    },
  },
  dome: {
    id: "dome",
    name: { en: "Single dome", sv: "Enkelkupad" },
    thick: 3.7,
    proudF: 0.5,
    approx: true,
    src: "community",
    note: {
      en: "Single-dome and stock Hardlex thicknesses are quoted loosely by retailers; treat as approximate.",
      sv: "Tjockleken på enkelkupade glas och original-Hardlex anges löst av återförsäljarna; behandla som ungefärlig.",
    },
  },
  double: {
    id: "double",
    name: { en: "Double dome", sv: "Dubbelkupad" },
    thick: 5.1,
    proudF: 0.56,
    approx: true,
    src: "luciusatelier",
    note: {
      en: "Both faces are curved — a concave underside under a convex top. Lucius Atelier quotes ~5.1 mm through the middle for the SKX007 cut.",
      sv: "Båda ytorna är kupade — konkav undersida under en konvex ovansida. Lucius Atelier anger ca 5,1 mm genom mitten för SKX007-glaset.",
    },
  },
  box: {
    id: "box",
    name: { en: "Box (vintage)", sv: "Box (vintage)" },
    thick: 4.8,
    proudF: 0.75,
    approx: true,
    src: "community",
    note: {
      en: "A box crystal is a slab with near-vertical walls and a flat top, not a dome. No retailer publishes the wall height, so the wall/top split is a modelling ratio.",
      sv: "Ett boxglas är en kloss med nästan lodräta sidor och plan ovansida, inte en kupol. Ingen återförsäljare publicerar väggens höjd, så förhållandet vägg/ovansida är en modellparameter.",
    },
  },
};

/**
 * Which crystal family a catalogue entry belongs to. An explicit `shape` wins;
 * otherwise the catalogue's `dome` scalar names the family, which is exactly
 * how it has always been used.
 * @param {any} entry
 * @returns {string}
 */
export function crystalFamily(entry) {
  if (!entry) return "dome";
  if (typeof entry.shape === "string" && CRYSTAL_FAMILIES[entry.shape]) return entry.shape;
  const d = typeof entry.dome === "number" ? entry.dome : 0.6;
  if (d <= 0.25) return "flat";
  if (d <= 0.8) return "dome";
  if (d <= 1.3) return "double";
  return "box";
}

/**
 * The crystal as a closed solid of the given family, spanning exactly
 * [`y`, `y` + `height`].
 * @param {number} crystalR
 * @param {number} y seat height
 * @param {number} height total proud height (the old `domeH`)
 * @param {number} segments
 * @param {string} [family] one of CRYSTAL_FAMILIES; defaults to a single dome
 * @returns {Mesh}
 */
export function crystalMesh(crystalR, y, height, segments, family) {
  const fam = CRYSTAL_FAMILIES[family || ""] ? family : "dome";
  const h = height;
  const top = y + h;
  /** @type {ProfilePoint[]} */
  const profile = [];
  /**
   * @param {number} rings @param {number} r0 @param {number} y0
   * @param {number} r1 @param {number} y1 @param {boolean} convex
   */
  const arc = (rings, r0, y0, r1, y1, convex) => {
    // A quarter ellipse from (r0, y0) to (r1, y1); `convex` bulges upward.
    for (let i = 1; i <= rings; i++) {
      const t = (i / rings) * (Math.PI / 2);
      const f = convex ? Math.sin(t) : 1 - Math.cos(t);
      const g = convex ? 1 - Math.cos(t) : Math.sin(t);
      profile.push({ r: r0 + (r1 - r0) * g, y: y0 + (y1 - y0) * f, s: i < rings });
    }
  };

  if (fam === "flat") {
    // Flat means flat: a disc with a vertical wall and the bevel Seiko cuts on
    // the top edge. Nothing about it is a cap.
    const bevel = Math.min(0.45, h * 0.4, crystalR * 0.06);
    profile.push({ r: 0, y });
    profile.push({ r: crystalR, y });
    profile.push({ r: crystalR, y: top - bevel });
    profile.push({ r: crystalR - bevel, y: top });
    profile.push({ r: 0, y: top });
  } else if (fam === "box") {
    // Near-vertical walls, then a flat top with a small edge break.
    profile.push({ r: 0, y });
    profile.push({ r: crystalR, y });
    profile.push({ r: crystalR, y: y + h * 0.78 });
    profile.push({ r: crystalR * 0.985, y: y + h * 0.92 });
    profile.push({ r: crystalR * 0.95, y: top });
    profile.push({ r: 0, y: top });
  } else if (fam === "double") {
    // Both faces curved: a concave underside, a rim, then a convex top.
    const sag = h * 0.2;
    const rim = h * 0.16;
    profile.push({ r: 0, y: y + sag });
    arc(6, 0, y + sag, crystalR, y, false);
    profile.push({ r: crystalR, y: y + rim });
    arc(10, crystalR, y + rim, 0, top, true);
  } else {
    // Single dome: a flat underside, a short rim, a spherical cap on top.
    const rim = h * 0.22;
    profile.push({ r: 0, y });
    profile.push({ r: crystalR, y });
    profile.push({ r: crystalR, y: y + rim });
    arc(11, crystalR, y + rim, 0, top, true);
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
 * Where every dial feature sits. Collected in one table because the bug this
 * replaces was exactly the opposite: a dozen hardcoded fractions spread across
 * the painter, none of which knew about each other, so the day wheel clipped
 * the date, the GMT numeral at 3 sat under the date window, and a wide window
 * ran out past the minute track.
 *
 * The APERTURE millimetres come off the manufacturer's dial drawings (TMI/SII
 * NH36A and NH35A technical sheets, page 8, scale 5/1, unit 1 = 1/100 mm) and
 * are therefore NOT approximate. Everything else here is a layout ratio of a
 * procedural model, flagged as such.
 */
export const DIAL_METRICS = {
  /** The dial the millimetres below are quoted on — the drawings' Ø2850. */
  dialDia: DIAL_DIA,

  /**
   * THE CUTOUT. One rectangle, whichever movement is under it. The NH36's
   * day-date box and the NH35's date box share an outer edge (11.95 vs
   * 12.00 mm); every one of the day-date box's extra 4.15 mm is added INBOARD,
   * which is the drawing's own proof that the day reads inboard of the date.
   */
  aperture: {
    /** Tangential height of both cutouts, mm. */
    height: 2.0,
    /** NH35A "Date window position:3H": 2.90 × 2.00 mm at 10.55 mm. */
    date: { width: 2.9, centre: 10.55, src: "nh35sheet" },
    /** NH36A "Day-Date window position:3H": 7.00 × 2.00 mm at 8.45 mm. */
    dayDate: { width: 7.0, centre: 8.45, src: "nh36sheet" },
    approx: false,
    src: "nh36sheet",
    note: {
      en: "The dial is cut ONCE. The line a wearer reads as a divider between the day and the date is not on the dial at all — it is where the day disc's outer edge falls over the date ring, so the two never share a millimetre of aperture.",
      sv: "Urtavlan har EN öppning. Strecket som ser ut som en avdelare mellan veckodag och datum finns inte på urtavlan — det är kanten på veckodagsskivan där den ligger över datumringen, så de två delar aldrig en millimeter av fönstret.",
    },
  },

  /**
   * How the two DISCS divide that one cut, as fractions of its width from the
   * inboard edge outward. Measured by pixel threshold on an official SRPD55
   * product image scaled by the drawing's 7.00 mm, so approximate — the drawing
   * fixes the cut, not where one disc ends and the next begins.
   */
  cells: { day: 0.54, gap: 0.03, date: 0.43, approx: true, src: "srpd55" },

  /** Layout ratios of the dial radius. Modelling numbers, not measurements. */
  markerOuter: 0.87,
  trackInner: 0.885,
  trackOuter: 0.945,
  gmtTrack: 0.66,
  gmtHandTip: 0.72,
  heartCentre: 0.44,
  heartRadius: 0.24,
  subCentre: 0.46,
  subRadius: 0.24,
  logoR: 0.4,
  textStart: 0.3,
  textStep: 0.085,
  textLimit: 0.66,
  approx: true,
  src: "community",
};

/** @type {Record<number, string>} */
const ROMAN_LABEL = {
  1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI",
  7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI", 12: "XII",
};

/**
 * A feature reduced to a polar box, so two of them can be asked whether they
 * touch. `halfAng` is the half-width in radians AT that radius, which is what
 * makes a wide window near the centre and a narrow marker near the rim
 * comparable at all.
 * @typedef {{ id: string, angle: number, halfAng: number, rIn: number, rOut: number }} LayoutBox
 */

/**
 * @param {string} id
 * @param {number} angle
 * @param {number} rIn
 * @param {number} rOut
 * @param {number} halfWidth tangential half-width, as a fraction of the radius
 * @returns {LayoutBox}
 */
function polarBox(id, angle, rIn, rOut, halfWidth) {
  const r = Math.max(1e-3, (rIn + rOut) / 2);
  return { id, angle, halfAng: Math.min(Math.PI, Math.atan2(halfWidth, r)), rIn, rOut };
}

/** @param {number} a @param {number} b shortest angular distance */
function angleGap(a, b) {
  const two = Math.PI * 2;
  let d = Math.abs(((a - b) % two) + two) % two;
  if (d > Math.PI) d = two - d;
  return d;
}

/**
 * @param {LayoutBox} a
 * @param {LayoutBox} b
 */
function boxesOverlap(a, b) {
  if (a.rOut <= b.rIn + 1e-9 || b.rOut <= a.rIn + 1e-9) return false;
  return angleGap(a.angle, b.angle) < a.halfAng + b.halfAng - 1e-9;
}

/**
 * The dial's APERTURE, laid out the way the manufacturer's drawing cuts it:
 * ONE rectangle at 3 o'clock, 7.00 × 2.00 mm centred 8.45 mm out on a day-date
 * dial and 2.90 × 2.00 mm centred 10.55 mm out on a date-only one.
 *
 * The two CELLS inside it are not two windows — they are where the day disc and
 * the date ring show through the single cut, the day INBOARD and the date
 * outboard, with the visible "divider" being the day disc's own outer edge.
 * Cutting two overlapping windows is what produced the reported clipping;
 * a painter given this should draw one aperture and place two glyphs in it.
 * @param {any} dial
 * @param {number} radius mm
 */
function apertureLayout(dial, radius) {
  /** @type {{ kind: string, angle: number, r: number, w: number, h: number, mmW: number, mmH: number,
   *   cells: { kind: string, r: number, w: number, mmW: number, sample: string }[] }[]} */
  const out = [];
  if (!dial || !dial.date) return out;
  const A = DIAL_METRICS.aperture;
  const scale = radius / (DIAL_METRICS.dialDia / 2);
  const angle = ((Number(dial.date) || 3) / 12) * Math.PI * 2;
  const cut = dial.day ? A.dayDate : A.date;
  const w = (cut.width * scale) / radius;
  const h = (A.height * scale) / radius;
  const r = (cut.centre * scale) / radius;
  const inner = r - w / 2;

  /** @type {{ kind: string, r: number, w: number, mmW: number, sample: string }[]} */
  const cells = [];
  if (dial.day) {
    // Fractions of the ONE cut, from its inboard edge outward: day, the gap
    // where the day disc's edge crosses the date ring, then the date. They sum
    // to the cut, so no two cells can share a millimetre by construction.
    let at = inner;
    for (const [kind, frac, sample] of /** @type {[string, number, string][]} */ ([
      ["day", DIAL_METRICS.cells.day, "MON"],
      ["gap", DIAL_METRICS.cells.gap, ""],
      ["date", DIAL_METRICS.cells.date, "31"],
    ])) {
      const cw = w * frac;
      if (kind !== "gap") cells.push({ kind, r: at + cw / 2, w: cw, mmW: cut.width * scale * frac, sample });
      at += cw;
    }
  } else {
    cells.push({ kind: "date", r, w, mmW: cut.width * scale, sample: "31" });
  }

  out.push({
    kind: dial.day ? "daydate" : "date",
    angle,
    r,
    w,
    h,
    mmW: cut.width * scale,
    mmH: A.height * scale,
    cells,
  });
  return out;
}

/**
 * @param {any} dial
 * @param {number} radius dial radius in mm
 * @param {{ apertureR?: number }} [opts] the case's VISIBLE opening in mm, when
 *   it is smaller than the dial (an SKX013's 27.5 mm crystal over a 28.5 mm
 *   dial); everything is pulled inside it so no feature is printed under the
 *   case lip
 */
export function dialLayout(dial, radius, opts) {
  const style = dial.markers;
  const apertureR = opts && opts.apertureR ? Math.min(radius, opts.apertureR) : radius;
  const visible = apertureR / radius;
  // Every radial fraction below is measured against the VISIBLE disc, so a
  // smaller aperture shrinks the whole layout instead of hiding its outside.
  const markerOuter = DIAL_METRICS.markerOuter * visible;
  const trackInner = DIAL_METRICS.trackInner * visible;
  const trackOuter = DIAL_METRICS.trackOuter * visible;

  const apertures = apertureLayout(dial, radius);
  /** @type {LayoutBox[]} */
  const apertureBoxes = apertures.map((a) =>
    polarBox(`${a.kind} window`, a.angle, a.r - a.w / 2, a.r + a.w / 2, a.h / 2),
  );

  /** @type {{ hour: number, angle: number, kind: string, len: number, wid: number, rOuter: number, rInner: number, fit: number }[]} */
  const markers = [];
  for (let h = 1; h <= 12; h++) {
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
    len *= visible;
    wid *= visible;
    // A printed numeral is as wide as its glyphs, not as wide as a bar. "VIII"
    // at bar width was reported as a hairline and drawn four characters wide,
    // which is how roman dials ended up with numerals running into each other.
    let fit = 1;
    if (kind === "numeral" || kind === "roman") {
      const label = kind === "roman" ? ROMAN_LABEL[h] : String(h);
      wid = len * 0.46 * label.length;
    }
    const rOuter = markerOuter;
    const rInner = markerOuter - len;
    // `wid` is a fraction of the dial DIAMETER, so half of it in radius units is
    // the same number — which is exactly the half-width `polarBox` wants.
    // Nothing may take more than 12.5° of the 30° an hour position owns; a
    // numeral that would takes a `fit` scale down instead, which is how "VIII"
    // stops running into "VII" on a roman dial.
    const rMid = (rOuter + rInner) / 2;
    const widest = rMid * Math.tan((12.5 * Math.PI) / 180);
    if (wid > widest) {
      fit = widest / wid;
      wid = widest;
    }
    const box = polarBox(`marker ${h}`, angle, rInner, rOuter, wid);
    // A marker under an aperture gives way to it — for EVERY marker style. The
    // old rule skipped hour 3 by hand and then exempted the Grand-Seiko style
    // from its own skip, which printed a facet marker under the date window.
    if (apertureBoxes.some((a) => boxesOverlap(a, box))) continue;
    markers.push({
      hour: h,
      angle,
      kind,
      len: len * radius * 2,
      wid: wid * radius * 2,
      rOuter,
      rInner,
      fit,
    });
  }

  const ticks = [];
  for (let m = 0; m < 60; m++) {
    if (m % 5 === 0) continue;
    ticks.push({ minute: m, angle: (m / 60) * Math.PI * 2, rOuter: trackOuter, rInner: trackInner });
  }

  // The GMT 24-hour track sits inside the hour markers, and any numeral that
  // would land on an aperture is dropped rather than printed under it.
  let gmtTrack = null;
  if (dial.gmt) {
    const r = DIAL_METRICS.gmtTrack * visible;
    const half = 0.05 * visible;
    const numerals = [];
    for (let h = 0; h < 24; h += 2) {
      const angle = (h / 24) * Math.PI * 2;
      const box = polarBox(`gmt ${h}`, angle, r - half, r + half, half);
      numerals.push({ value: h, angle, skipped: apertureBoxes.some((a) => boxesOverlap(a, box)) });
    }
    gmtTrack = { r, half, numerals, handTip: DIAL_METRICS.gmtHandTip * visible };
  }

  const heart = dial.openHeart
    ? { angle: (9 / 12) * Math.PI * 2, r: DIAL_METRICS.heartCentre * visible, radius: DIAL_METRICS.heartRadius * visible }
    : null;
  const sub = dial.subSeconds
    ? {
        angle: ((Number(dial.subSeconds) || 6) / 12) * Math.PI * 2,
        r: DIAL_METRICS.subCentre * visible,
        radius: DIAL_METRICS.subRadius * visible,
      }
    : null;

  // Printed text goes at 6 o'clock unless something already lives there, in
  // which case it stacks under the logo at 12 instead of being drawn over a
  // sub-dial.
  const lines = Array.isArray(dial.text) ? dial.text.slice(0, 4) : [];
  const sixTaken = !!(sub && angleGap(sub.angle, Math.PI) < 0.4);
  const textAngle = sixTaken ? 0 : Math.PI;
  const room = DIAL_METRICS.textLimit * visible - DIAL_METRICS.textStart * visible;
  const step = lines.length > 1 ? Math.min(DIAL_METRICS.textStep * visible, room / (lines.length - 1)) : 0;
  const textLines = lines.map((/** @type {any} */ t, /** @type {number} */ i) => ({
    text: String(t),
    angle: textAngle,
    r: (sixTaken ? 0.5 : DIAL_METRICS.textStart) * visible + step * i,
    size: 0.033 * visible,
  }));

  return {
    radius,
    apertureR,
    visible,
    markers,
    ticks,
    markerOuter,
    trackInner,
    trackOuter,
    apertures,
    gmtTrack,
    heart,
    sub,
    logo: { angle: 0, r: DIAL_METRICS.logoR * visible, size: 0.05 * visible },
    textLines,
    date: dial.date,
    day: dial.day,
    gmt: dial.gmt,
    openHeart: dial.openHeart,
    text: lines,
  };
}

/**
 * Every feature of a laid-out dial as a polar box. Exported so the audit is
 * something a test can run rather than something a reviewer has to eyeball.
 * @param {ReturnType<typeof dialLayout>} layout
 * @returns {LayoutBox[]}
 */
export function layoutBoxes(layout) {
  /** @type {LayoutBox[]} */
  const boxes = [];
  for (const m of layout.markers) {
    boxes.push(polarBox(`marker ${m.hour}`, m.angle, m.rInner, m.rOuter, m.wid / (layout.radius * 2)));
  }
  for (const a of layout.apertures) {
    boxes.push(polarBox(`${a.kind} window`, a.angle, a.r - a.w / 2, a.r + a.w / 2, a.h / 2));
  }
  if (layout.gmtTrack) {
    for (const n of layout.gmtTrack.numerals) {
      if (n.skipped) continue;
      boxes.push(
        polarBox(`gmt ${n.value}`, n.angle, layout.gmtTrack.r - layout.gmtTrack.half, layout.gmtTrack.r + layout.gmtTrack.half, layout.gmtTrack.half),
      );
    }
  }
  if (layout.heart) {
    boxes.push(polarBox("open heart", layout.heart.angle, layout.heart.r - layout.heart.radius, layout.heart.r + layout.heart.radius, layout.heart.radius));
  }
  if (layout.sub) {
    boxes.push(polarBox("sub-seconds", layout.sub.angle, layout.sub.r - layout.sub.radius, layout.sub.r + layout.sub.radius, layout.sub.radius));
  }
  boxes.push(
    polarBox("logo", layout.logo.angle, layout.logo.r - layout.logo.size, layout.logo.r + layout.logo.size, layout.logo.size * 6),
  );
  for (const t of layout.textLines) {
    boxes.push(polarBox(`text "${t.text}"`, t.angle, t.r - t.size, t.r + t.size, t.size * Math.max(1, t.text.length) * 0.45));
  }
  return boxes;
}

/**
 * Everything on this dial that collides with something else, or that runs
 * outside the dial or outside the case's visible opening. An empty array is the
 * whole point: it is the audit the "day clips into date" report asked for,
 * expressed as an assertion instead of a look.
 * @param {ReturnType<typeof dialLayout>} layout
 * @returns {{ a: string, b: string }[]}
 */
export function layoutCollisions(layout) {
  const boxes = layoutBoxes(layout);
  /** @type {{ a: string, b: string }[]} */
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) hits.push({ a: boxes[i].id, b: boxes[j].id });
    }
  }
  for (const b of boxes) {
    if (b.rOut > layout.trackInner + 1e-9) hits.push({ a: b.id, b: "minute track" });
    if (b.rOut > layout.visible + 1e-9) hits.push({ a: b.id, b: "case aperture" });
  }
  return hits;
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
 * @param {{ segments?: number }} [opts]
 */
export function buildMeshes(build, opts) {
  const segments = (opts && opts.segments) || 96;
  const { parts } = resolveBuild(build);
  const cs = parts.case;
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)] || PLATFORMS.native;
  const geo = caseProfile(cs, parts.crystal);
  const dialR = plat.dialDia / 2;
  const outline = outlineFor(cs.shell);
  const slope = outlineSlopeFor(cs.shell);
  const R = cs.dims.dia / 2;
  const T = cs.dims.thick;

  // The case BODY: a closed shell with an inner wall, so there is no longer a
  // line of sight from outside the watch through the bottom of the case and out
  // past the dial edge.
  const caseMesh = lathe(geo.profile, segments, outline, slope);
  // A dive bezel is its own ring around the case's crystal tower, ROUND even on
  // a cushion case (which is how a Turtle is actually built) and carrying real
  // modelled coin-edge serrations rather than a smooth band.
  if (geo.bezelProfile) {
    const coin = knurl(60, 0.011);
    mergeMesh(caseMesh, lathe(geo.bezelProfile, Math.max(segments, 300), coin.k, coin.dk));
  }

  // LUGS. Each one starts inside the flank at the silhouette radius for its own
  // x — computed, not assumed — tapers and droops on its way out, and finishes
  // in a rounded drilled-lug tip exactly at the catalogue's lug-to-lug.
  const lugs = emptyMesh();
  const lugThk = 1.9 + 0.5 * clamp(((cs.wr || 100) - 100) / 200, 0, 1);
  const halfX = cs.dims.lugW / 2 + lugThk / 2;
  const lugTop = T * 0.58;
  const lugBot = T * 0.16;
  const flankAtLug = flankRadiusAt(geo.outer, (lugTop + lugBot) / 2);
  const zSurface = silhouetteZ(halfX + lugThk / 2, flankAtLug, outline);
  const zTip = cs.dims.l2l / 2;
  // Bury the root 1.6 mm inside the flank so the lug and the case READ as one
  // machined block; never let it start outside the silhouette.
  const zRoot = Math.max(0.5, Math.min(zSurface - 1.6, zTip - 2));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lug = lugMesh({
        x: sx * halfX,
        z0: zRoot,
        z1: zTip,
        halfW: lugThk / 2,
        rootTop: lugTop,
        rootBot: lugBot,
        tipTop: T * 0.4,
        tipBot: T * 0.09,
      });
      if (sz < 0) {
        for (let i = 2; i < lug.positions.length; i += 3) lug.positions[i] = -lug.positions[i];
        for (let i = 2; i < lug.normals.length; i += 3) lug.normals[i] = -lug.normals[i];
        // Mirroring flips handedness, so the winding has to flip with it or
        // every −z lug renders inside out.
        for (let i = 0; i < lug.indices.length; i += 3) {
          const t = lug.indices[i + 1];
          lug.indices[i + 1] = lug.indices[i + 2];
          lug.indices[i + 2] = t;
        }
      }
      mergeMesh(lugs, lug);
    }
  }

  // CROWN. A real crown is knurled, and the flutes are modelled — a barrel with
  // `flutes` rounded ribs cut into it, a domed outer face and a tube that
  // reaches INTO the flank instead of hovering beside it.
  const crownAngle = (cs.crown.hour / 12) * Math.PI * 2 - Math.PI / 2;
  const crownStyle = (parts.crown && parts.crown.style) || "coin";
  const crownR = (cs.shell === "dress" ? 1.5 : 1.9) * (crownStyle === "onion" ? 1.15 : 1);
  const crownH = crownR * (crownStyle === "onion" ? 2.1 : crownStyle === "fluted" ? 1.7 : 1.85);
  const flutes = crownStyle === "fluted" ? 14 : crownStyle === "onion" ? 12 : 30;
  const cut = knurl(flutes, crownStyle === "coin" ? 0.06 : 0.13);
  const crownSeg = Math.max(48, flutes * 5);
  const yOut = -crownH / 2;
  const yIn = crownH / 2;
  const grip =
    crownStyle === "onion"
      ? [
          { r: 0, y: yOut },
          { r: crownR * 0.62, y: yOut },
          { r: crownR, y: yOut + crownH * 0.42, s: true },
          { r: crownR * 0.9, y: yIn - crownH * 0.12, s: true },
          { r: crownR * 0.55, y: yIn },
          { r: 0, y: yIn },
        ]
      : [
          { r: 0, y: yOut },
          { r: crownR * 0.74, y: yOut },
          { r: crownR, y: yOut + crownH * 0.16 },
          { r: crownR, y: yIn - crownH * 0.12 },
          { r: crownR * 0.82, y: yIn },
          { r: 0, y: yIn },
        ];
  const crown = lathe(grip, crownSeg, cut.k, cut.dk);
  // The tube: smooth, unknurled, and long enough to disappear into the flank.
  const crownFlank = flankRadiusAt(geo.outer, geo.crownY) * outline(crownAngle);
  const crownOut = Math.max(crownFlank + crownH * 0.36, R * 1.02);
  const embed = crownOut - crownFlank + 0.8;
  mergeMesh(
    crown,
    lathe(
      [
        { r: 0, y: yIn },
        { r: crownR * 0.44, y: yIn },
        { r: crownR * 0.44, y: yIn + embed },
        { r: 0, y: yIn + embed },
      ],
      Math.max(24, segments / 3),
    ),
  );
  const crownTransform = {
    x: Math.cos(crownAngle) * crownOut,
    z: Math.sin(crownAngle) * crownOut,
    y: geo.crownY,
    angle: crownAngle,
  };
  // Crown GUARDS are part of the case on the cases that have them, so they are
  // merged into the case body — and their absence is half of why a no-guard
  // conversion case looks different from an SKX.
  if (cs.crown.guards) {
    const guardR = crownR * 1.35;
    for (const side of [-1, 1]) {
      const guard = lathe(
        [
          { r: 0, y: -guardR * 0.9 },
          { r: guardR * 0.75, y: -guardR * 0.9, s: true },
          { r: guardR, y: -guardR * 0.2, s: true },
          { r: guardR * 0.92, y: guardR * 1.5 },
          { r: 0, y: guardR * 1.5 },
        ],
        Math.max(20, segments / 4),
      );
      const spread = Math.atan2(crownR * 1.5, Math.max(1, crownFlank));
      placeRadial(guard, crownAngle + side * spread, crownFlank - guardR * 0.55, geo.crownY);
      mergeMesh(caseMesh, guard);
    }
  }

  // Dial, rehaut, insert face, crystal. The rehaut spans the dial edge to the
  // case's VISIBLE opening, which on a platform whose crystal is smaller than
  // its dial is the bore lip rather than the crystal — the old unconditional
  // dialR → crystalR cone inverted itself on exactly those platforms.
  const dial = annulus(0, dialR, geo.dialY, segments);
  const rehautOuter = geo.apertureR;
  const rehautInner = Math.min(dialR - 0.1, rehautOuter - 0.9);
  const chapterRing = cone(rehautInner, geo.dialY + 0.05, rehautOuter, geo.seatFloorY, segments);
  const insertInner = geo.insertInner;
  const insertOuter = geo.insertOuter;
  const insert =
    cs.bezel === "dive120"
      ? annulus(insertInner, insertOuter, geo.bezelTopY + 0.06, segments)
      : emptyMesh();
  const crystal = crystalMesh(
    geo.crystalR,
    geo.bezelTopY,
    geo.domeH,
    segments,
    crystalFamily(parts.crystal),
  );

  // Hands. A GMT hand is clamped to the 24-hour track the dial actually prints
  // rather than running past it into the hour markers.
  const hs = parts.hands;
  const handY = geo.dialY + 0.55;
  const layout = dialLayout(parts.dial, dialR, { apertureR: geo.apertureR });
  /** @type {{ id: string, mesh: Mesh, y: number, color: string }[]} */
  const hands = [];
  const order = /** @type {const} */ (["hour", "minute", "gmt", "second"]);
  let lift = 0;
  for (const key of order) {
    const shape = /** @type {any} */ (hs.shapes)[key];
    if (!shape) continue;
    let reach = /** @type {any} */ (hs.len)[key];
    if (key === "gmt" && layout.gmtTrack) reach = Math.min(reach, layout.gmtTrack.handTip);
    const len = reach * dialR;
    const width = key === "second" ? 0.28 : key === "hour" ? 1.15 : 0.9;
    hands.push({
      id: key,
      mesh: extrude(handOutline(shape, len, width), key === "second" ? 0.16 : 0.28, handY + lift),
      y: handY + lift,
      color: key === "second" ? hs.secondColor : key === "gmt" ? hs.gmtColor || hs.color : hs.color,
    });
    lift += 0.38;
  }

  // CASE BACK, and the interior it closes onto. The caseback is a solid puck
  // that plugs the bore; above it sit a movement drum and the dial spacer ring,
  // so looking into the watch shows a case interior rather than the outside
  // world through the far wall.
  const caseback = lathe(
    [
      { r: 0, y: -0.35 },
      { r: geo.boreBotR * 0.72, y: -0.42, s: true },
      { r: geo.boreBotR - 0.35, y: -0.05, s: true },
      { r: geo.boreBotR, y: 0.3 },
      { r: geo.boreBotR, y: geo.floorY - 0.2 },
      { r: geo.boreR, y: geo.floorY },
      { r: 0, y: geo.floorY },
    ],
    segments,
  );
  const movR = Math.min(geo.boreR - 0.3, (parts.movement && parts.movement.dia ? parts.movement.dia : 27.4) / 2);
  mergeMesh(
    caseback,
    lathe(
      [
        { r: 0, y: geo.floorY },
        { r: movR, y: geo.floorY },
        { r: movR, y: geo.dialY - 0.45 },
        { r: 0, y: geo.dialY - 0.45 },
      ],
      segments,
    ),
  );
  // The spacer ring: fills the last millimetre between the movement drum and
  // the bore wall, right under the dial, so a steep viewing angle cannot see
  // down the side of the movement.
  mergeMesh(
    caseback,
    lathe(
      [
        { r: movR - 0.2, y: geo.dialY - 0.9 },
        { r: geo.boreR, y: geo.dialY - 0.9 },
        { r: geo.boreR, y: geo.dialY - 0.15 },
        { r: movR - 0.2, y: geo.dialY - 0.15 },
        { r: movR - 0.2, y: geo.dialY - 0.9 },
      ],
      segments,
    ),
  );

  const strap = strapMesh(cs, parts.strap);

  return {
    meshes: { case: caseMesh, lugs, crown, dial, chapterRing, insert, crystal, caseback, strap },
    crownTransform,
    hands,
    geo,
    dialR,
    apertureR: geo.apertureR,
    layout,
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
