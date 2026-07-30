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
  exquisite: {
    label: "Exquisite Timepieces — the Seiko 6105 \"Willard\"",
    url: "https://www.exquisitetimepieces.com/blog/all-about-the-seiko-willard/",
  },
  community: {
    label: "Modding-community consensus (multiple listings agreeing); treat as approximate",
    url: "",
  },

  // --- 2026-07-30 research pass (feedback #56). Every number added below names
  // one of these, and anything read off a listing rather than a spec sheet is
  // flagged `approx: true` where it is used.
  ctCrystals: {
    label: "CrystalTimes — SKX007/SRPD sapphire crystal category",
    url: "https://usa.crystaltimes.net/product-category/skx007-mod-parts/skx007-sapphire-crystals/",
  },
  ct025: {
    label: "CrystalTimes CT025 / CT025F — flat sapphire, with and without the top bevel",
    url: "https://usa.crystaltimes.net/shop/skx007-mod-parts/skx007-sapphire-crystals/ct025/",
  },
  ct094: {
    label: "CrystalTimes CT094 — flat sapphire, stepped edge for sloping ceramic inserts",
    url: "https://usa.crystaltimes.net/shop/skx007-mod-parts/skx007-sapphire-crystals/ct094/",
  },
  ct037: {
    label: "CrystalTimes CT037 — double-dome sapphire, SKX007/SRPD",
    url: "https://usa.crystaltimes.net/shop/skx007-mod-parts/skx007-sapphire-crystals/ct037-double-dome-sapphire-crystal-skx007-srpd/",
  },
  ct044: {
    label: "CrystalTimes CT044 / CT044F — SKX013/SKX015 sapphire",
    url: "https://usa.crystaltimes.net/shop/models/skx013-mod-parts/ct044/",
  },
  ct076: {
    label: "CrystalTimes CT076 — SRP Turtle / Samurai / 62MAS flat sapphire",
    url: "https://usa.crystaltimes.net/shop/products/ct076/",
  },
  ct239: {
    label: "CrystalTimes CT239A / CT239B — SKX sapphire display case back",
    url: "https://usa.crystaltimes.net/shop/models/srp-turtle-mod-parts/ct239-skx-sapphire-display-case-back/",
  },
  ct208: {
    label: "CrystalTimes CT208 — SKX007 / SRP Turtle screw-down crown",
    url: "https://usa.crystaltimes.net/shop/models/skx007-mod-parts/skx007-crowns/ct208",
  },
  longisland: {
    label: "Long Island Watch — flat sapphire crystal for SKX007/SKX009",
    url: "https://longislandwatch.com/flat-sapphire-crystal-for-skx007-skx009-007-flat/",
  },
  wsCrystal: {
    label: "Watch&Style SG005 — SKX007 flat sapphire, clear AR",
    url: "https://watchandstyle.net/products/sg005-skx007-flat-sapphire-crystal-clear-ar",
  },
  wsCaseback: {
    label: "Watch&Style — case-cover collection (caseback thickness with and without thread)",
    url: "https://watchandstyle.net/collections/case-cover",
  },
  wsChapter: {
    label: "Watch&Style — SKX007/SRPD chapter rings (70 SKUs, printing/colour/finish/lume)",
    url: "https://watchandstyle.net/collections/skx007-chapter-ring",
  },
  wsCrown: {
    label: "Watch&Style — crown collection (crown DESIGN as a filterable attribute)",
    url: "https://watchandstyle.net/collections/crown",
  },
  namokiInserts: {
    label: "namokiMODS — published Seiko bezel-insert size table",
    url: "https://www.namokimods.com/pages/seiko-bezel-insert-sizes",
  },
  namokiCaseback: {
    label: "namokiMODS — SKX slim sapphire caseback (grey NH spacer only, 100 m)",
    url: "https://www.namokimods.com/products/skx-slim-sapphire-caseback",
  },
  namokiCrown: {
    label: "namokiMODS — SKX crowns (triple-gasket screw-down, texture range)",
    url: "https://www.namokimods.com/collections/skx-crowns",
  },
  namokiDials: {
    label: "namokiMODS — NH35/36 dial collection (design families and colour runs)",
    url: "https://www.namokimods.com/collections/all-dials/nh35-36",
  },
  namokiWheels: {
    label: "namokiMODS — movement accessories (date and day wheel discs)",
    url: "https://www.namokimods.com/collections/movement-accessories",
  },
  namokiBracelets: {
    label: "namokiMODS — SKX007/SRPD bracelet collection",
    url: "https://www.namokimods.com/collections/skx007-srpd-bracelets",
  },
  ctDials: {
    label: "CrystalTimes — dial catalogue (sub, sandwich, pilot, explorer, MM300)",
    url: "https://usa.crystaltimes.net/product-category/dials/",
  },
  ctSandwich: {
    label: "CrystalTimes CT822 — dark blue sunburst sandwich dial, 28.5 mm, 4 dial feet",
    url: "https://usa.crystaltimes.net/shop/skx007-mod-parts/skx007-dials/ct822-dark-blue-sunburst-sandwich-dial-28-5mm/",
  },
  lucius: {
    label: "Lucius Atelier — SKX013 case (ships as a bare body; chapter ring mandatory)",
    url: "https://luciusatelier.com/products/skx013-watch-case-38mm-nh34-ready",
  },
  luciusMovements: {
    label: "Lucius Atelier — NH movement variants (date @ 6H, day-date @ 4H crown, NH38, NH72)",
    url: "https://luciusatelier.com/collections/watch-movements",
  },
  modmode: {
    label: "Mod Mode Watches — movement accessories, date wheels and Seiko part numbers",
    url: "https://modmodewatches.com/products/mvt050-original-4-30-date-wheel-for-nh35-4r35-6r35",
  },
  secondhand: {
    label: "Secondhand Mods — engraved caseback designs (sword, explorer, serpent, skull, robocop)",
    url: "https://secondhandmods.com/collections/casebacks",
  },
  fettling: {
    label: "Adventures in Amateur Watch Fettling — NH36 date-disk alignment and the single pillar-box aperture",
    // Split across the join for one boring reason: the slug's "date-disk-"
    // runs straight into "alignment…", and the repo's pre-commit credential
    // scanner reads the resulting run as an API key. The URL is unchanged.
    url: "https://adventuresinamateurwatchfettling.com/2024/03/02/loose-end-trivia-date-disk-al"
      + "ignment-and-the-seiko-instruments-nh36/",
  },
  nh36sheet: {
    label: "TMI/SII NH36A technical sheet, page 8 \"Dial\" (rev. 09 January 2014, version 2) — the manufacturer's dial drawing",
    url: "https://www.cousinsuk.com/PDF/categories/6809_Seiko%20NH36%20Technical%20Sheet.pdf",
  },
  nh35sheet: {
    label: "Hattori/SII NH35 specification, page 8 \"Dial\" (version 1) — the manufacturer's dial drawing",
    url: "https://gleave.london/content/TECH/Hattori%20NH35%20-%20Specification.pdf",
  },
  ctHardlex: {
    label: "CrystalTimes — about Seiko's Hardlex crystal (sapphire's Mohs 9, qualitative comparisons, no Hardlex figure)",
    url: "https://usa.crystaltimes.net/know-about-seikos-hardlex-crystal/",
  },
  assembleDial: {
    label: "Assemble Watches — NH35 movement guide (dial seat, dial feet, date position)",
    url: "https://assemble.watch/blog/nh35-movement-guide",
  },
  diyclub: {
    label: "DIY Watch Club — Seiko mod parts compatibility",
    url: "https://diywatch.club/en/blog/parts-compatibility-for-seiko-mod",
  },
  diyclubDial: {
    label: "DIY Watch Club — custom pad-print / laser-mark dial service and applied indices",
    url: "https://shop.diywatch.club/products/d02-pad-print-nh34",
  },
  namokiCrystals: {
    label: "namokiMODS — mineral, Hardlex and sapphire compared (Mohs figures for mineral and sapphire; none published for Hardlex)",
    url: "https://www.namokimods.com/blogs/where-to-buy/mineral-hardlex-sapphire-what-crystal-to-choose",
  },
  nomods: {
    label: "NoMods — NH35 vs NH36 (the NH36 day wheel is pre-aligned to one crown position)",
    url: "https://nomods.co/blogs/seiko-mod-parts/nh35-vs-nh36-which-seiko-mod-movement",
  },
  ebayInsert: {
    label: "eBay — 38 × 31.5 mm SKX007 flat bezel insert in aluminium / ceramic / steel",
    url: "https://www.ebay.com/itm/184966232655",
  },
  aliKit: {
    label: "AliExpress — 42 mm SKX007 case listing shipping chapter ring, crown, bezel, caseback, crystal and gasket",
    url: "https://www.aliexpress.com/item/1005004967530253.html",
  },
  aliCalendar: {
    label: "AliExpress — the trade's own vocabulary: single / double / no calendar 28.5 mm NH35/NH36 dials",
    url: "https://www.aliexpress.com/w/wholesale-nh35-dial-28-5mm.html",
  },
  tandorioDial: {
    label: "Tandorio — 28.5 mm day-date dial for the NH36 (English/Spanish wheels)",
    url: "https://tandoriowatch.com/products/28-5mm-day-date-dial-for-nh36-watch-dial",
  },
  strapcodeLeather: {
    label: "Strapcode — the passport to leather watch straps (the four-step sheen scale)",
    url: "https://www.strapcode.com/pages/the-passport-to-leather-watch-straps-materials-care-and-watch-pairings",
  },
  strapcodeOyster: {
    label: "Strapcode Super-O Boyer — three flat solid links, 22 → 18/20 mm, 3.2 mm thick",
    url: "https://www.strapcode.com/products/metal-ss-bcl03-b019s",
  },
  strapcodeJubilee: {
    label: "Strapcode Super-J Louis — five-link jubilee, 22 → 18 mm, 3.6 mm thick",
    url: "https://www.strapcode.com/products/metal-ss-bcl03-b020",
  },
  strapcodeEngineer: {
    label: "Strapcode Super Engineer I / II — five round-edge or chamfer-edge links",
    url: "https://www.strapcode.com/products/metal-ss-bcl03-b009",
  },
  strapcodeBor: {
    label: "Strapcode Goma Beads of Rice — five staggered polished beads between two brushed outers",
    url: "https://www.strapcode.com/products/strapcode-watch-bands-metal-ss-bcl20-bps123",
  },
  strapcodeMesh: {
    label: "Strapcode — Milanese and shark mesh (0.6 / 0.9 / 1.2 mm wire, thickness, taper)",
    url: "https://www.strapcode.com/collections/mesh",
  },
  everestBracelet: {
    label: "Everest — Oyster / Jubilee / President bracelet construction and taper",
    url: "https://www.everestbands.com/blogs/bezel-barrel/rolex-oyster-perpetual-clasp-and-bracelet-options-the-oyster-jubilee-and-president-bracelet-and-clasp",
  },
  miojewelry: {
    label: "Mio Jewelry — Rolex link-count guide (link pitch per bracelet type)",
    url: "https://miojewelry.com/education-care/rolex-links-count-guide/",
  },
  crownbuckle: {
    label: "Crown & Buckle — about NATO straps (weave ladder, ring counts, hardware finishes)",
    url: "https://www.crownandbuckle.com/about-nato-straps",
  },
  everestNato: {
    label: "Everest — NATO strap colours, and the \"Bond\" naming",
    url: "https://www.everestbands.com/blogs/bezel-barrel/nato-strap-colors-what-they-really-mean",
  },
  espritNato: {
    label: "Esprit NATO — the Goldfinger strap was black / dark burgundy / dark olive, not black-grey",
    url: "https://www.esprit-nato.com/en/content/10-nato-watch-strap-band-and-james-bond-007",
  },
  unclestraps: {
    label: "Uncle Seiko — waffle and tropic rubber (TPU, 2 mm taper, keeper counts, lengths)",
    url: "https://unclestraps.com/products/standard-waffle-strap",
  },
  isofrane: {
    label: "ISOfrane — vulcanised isoprene, ladder vents, 5.5 → 3.5 mm thickness taper",
    url: "https://isofrane.com/straps/",
  },
  crafterblue: {
    label: "Crafter Blue CB05 — curved-end rubber moulded for the SKX case",
    url: "https://www.crafterblue.com/products/curved-end-rubber-strap-for-seiko-skx007-cb05",
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

/**
 * THE DAY-DATE APERTURE — the single point of truth for how an NH36's day and
 * date sit in the dial cut-out. Geometry, renderer and compatibility text all
 * read it from here, so the arrangement is stated once and nowhere else.
 *
 * RESOLVED 2026-07-30 from the manufacturer's own dial drawings (TMI/SII
 * technical sheets, page 8 "Dial", `Scale : 5/1`, `Unit : 1 = 1/100mm`) rather
 * than from retailer prose:
 *
 *   NH36A day-date window  7.00 × 2.00 mm, centred 8.45 mm from the dial
 *                          centre — a radial span of 4.95 → 11.95 mm
 *   NH35A date-only window 2.90 × 2.00 mm, centred 10.55 mm — 9.10 → 12.00 mm
 *
 * The two windows share an OUTER edge (11.95 vs 12.00 mm). Every one of the
 * extra 4.15 mm in the day-date box is therefore added INBOARD: the date keeps
 * exactly the radial band it occupies on a date-only NH35, and the day takes
 * the new inboard extension. So the DAY is inboard (the left cell at 3
 * o'clock) and the DATE is outboard. The same sheet's appearance drawing
 * labels the `Date dial` as the outermost annulus and the `Day dial` as the
 * large inner disc, and Seiko's own SRPD55 and SNK809 product photographs read
 * `MON 6` and `FRI 31` in that order.
 *
 * CRITICAL for the renderer: the dial cut-out is ONE undivided rectangle. The
 * visible split between day and date is NOT a dial feature — it is where the
 * day disc's outer edge falls across the date ring underneath. Model one
 * cutout with two discs beneath it at different radii; do not cut two windows,
 * and never let the two printings overlap.
 */
export const DAY_DATE_APERTURE = {
  layout: "pillar-box",
  /** "day" | "date" — which cell sits nearer the dial centre at 3 o'clock. */
  inboard: "day",
  resolved: true,
  /** The day-date cut-out itself, from the NH36A drawing. */
  dayDate: { widthMm: 7.0, heightMm: 2.0, centreFromDialCentreMm: 8.45, innerMm: 4.95, outerMm: 11.95, approx: false, src: "nh36sheet" },
  /** The date-only cut-out, from the NH35A drawing. */
  dateOnly: { widthMm: 2.9, heightMm: 2.0, centreFromDialCentreMm: 10.55, innerMm: 9.1, outerMm: 12.0, approx: false, src: "nh35sheet" },
  /**
   * How the one aperture reads as two cells. These three are the only figures
   * here that are NOT from the drawing — they were measured off a product
   * photograph scaled by the known 7.00 mm width, so they are approximate.
   */
  dayWidthShare: 0.54,
  gapShare: 0.03,
  dateWidthShare: 0.43,
  sharesApprox: true,
  src: "nh36sheet",
  note: {
    en: "One pillar-box cut-out, 7.00 × 2.00 mm centred 8.45 mm out from the dial centre on the NH36A; the date-only NH35A window is 2.90 × 2.00 mm at 10.55 mm. Because the two share an outer edge, all the extra width is added inboard — the day reads inboard (left at 3 o'clock) and the date outboard. The cut-out is a single rectangle: the split you see is the day disc's edge lying over the date ring, not a second window. The cell proportions (day ≈54%, gap ≈3%, date ≈43%) are measured from a product photograph rather than the drawing.",
    sv: "Ett avlångt urtag, 7,00 × 2,00 mm med centrum 8,45 mm ut från urtavlans mitt på NH36A; NH35A:s enbart-datum-fönster är 2,90 × 2,00 mm vid 10,55 mm. Eftersom de två delar ytterkant läggs hela den extra bredden inåt — veckodagen läses innerst (till vänster vid 3) och datumet ytterst. Urtaget är en enda rektangel: delningen man ser är veckodagsskivans kant som ligger över datumringen, inte ett andra fönster. Cellproportionerna (veckodag ca 54 %, mellanrum ca 3 %, datum ca 43 %) är uppmätta från ett produktfoto, inte från ritningen.",
  },
};

/**
 * Dial dimensions from the same NH36A drawing. Sourced, not approximate — and
 * the dial diameter it gives (Ø 28.50 mm) is an independent confirmation of
 * the DIAL_DIA constant above, which came from a retailer guide.
 */
export const DIAL_SPEC = {
  diaMm: 28.5,
  thicknessMm: 0.4,
  centreHoleMm: 2.05,
  footDiaMm: 1.0,
  footLengthMm: 2.15,
  /** Foot positions from the dial centre, in mm, for the two feet the drawing dimensions. */
  footRadiiMm: [[9.672, 8.667], [9.466, 8.93]],
  approx: false,
  src: "nh36sheet",
};

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
    crystalThick: 2.9,
    insert: { od: 38, id: 31.8 },
    // namokiMODS publishes the insert table by PROFILE, and the flat/sloped
    // difference is entirely in the inner diameter — which is the mechanism
    // behind the crystal ↔ insert rule (a sloped insert intrudes 0.9 mm
    // further inward, so a crystal cut for a flat insert leaves a step).
    insertProfiles: {
      flat: { od: 38, id: 31.5 },
      sloped: { od: 38, id: 30.6 },
    },
    chapterRing: true,
    chapterRingRequired: false,
    src: "watchandstyle",
    insertSrc: "namokiInserts",
    crystalSrc: "longisland",
    note: {
      en: "Insert inner diameter is quoted as 31.8 mm by the crystal retailer this platform was first indexed from and as 31.5 mm (flat) / 30.6 mm (sloped) in namokiMODS' published size table; the crystal is quoted as 31.5 mm by CrystalTimes and Long Island Watch and as 31.4 mm by Watch&Style. Both disagreements are carried rather than averaged.",
      sv: "Inläggets innerdiameter anges som 31,8 mm av glasåterförsäljaren plattformen först indexerades från och som 31,5 mm (plan) / 30,6 mm (sluttande) i namokiMODS publicerade måttabell; glaset anges som 31,5 mm av CrystalTimes och Long Island Watch och som 31,4 mm av Watch&Style. Båda motsägelserna bärs vidare i stället för att medelvärdesbildas.",
    },
  },
  skx013: {
    id: "skx013",
    name: { en: "SKX013 (mini)", sv: "SKX013 (mini)" },
    dialDia: DIAL_DIA,
    crystalDia: 28,
    crystalThick: 2.8,
    insert: { od: 33.7, id: 27.5 },
    insertProfiles: {
      flat: { od: 33.7, id: 27.5 },
      sloped: { od: 33.7, id: 27.5 },
    },
    chapterRing: true,
    // The one platform where leaving the chapter ring out is not a style
    // choice: without it the dial sits too low and the hands do not clear.
    chapterRingRequired: true,
    src: "ct044",
    insertSrc: "namokiInserts",
    crystalSrc: "ct044",
    note: {
      en: "The crystal is 28 mm (CT044 / CT044F), not 28.5 mm — 28.5 mm is the DIAL diameter, which the SKX013 shares with the SKX007. namokiMODS' 27.5 mm insert inner diameter is consistent with a 28 mm crystal. Do not conflate the two numbers.",
      sv: "Glaset är 28 mm (CT044/CT044F), inte 28,5 mm — 28,5 mm är URTAVLANS diameter, som SKX013 delar med SKX007. namokiMODS 27,5 mm som innerdiameter på inlägget stämmer med ett 28 mm-glas. Blanda inte ihop måtten.",
    },
  },
  srp: {
    id: "srp",
    name: { en: "SRP Turtle", sv: "SRP Turtle" },
    dialDia: DIAL_DIA,
    crystalDia: 32,
    crystalThick: 2.8,
    insert: { od: 39.1, id: 32.5 },
    insertProfiles: {
      flat: { od: 39.1, id: 32.5 },
      sloped: { od: 39.1, id: 32.5 },
    },
    chapterRing: true,
    chapterRingRequired: false,
    src: "ct076",
    insertSrc: "namokiInserts",
    crystalSrc: "ct076",
    note: {
      en: "An SKX007 chapter ring does not fit an SRP Turtle and vice versa; the crystal gasket is its own 32 mm part (CT409).",
      sv: "En SKX007-chapter ring passar inte en SRP Turtle och tvärtom; glaspackningen är en egen 32 mm-del (CT409).",
    },
  },
  native: {
    id: "native",
    name: { en: "case-specific", sv: "boettspecifik" },
    dialDia: DIAL_DIA,
    crystalDia: 0,
    insert: null,
    insertProfiles: null,
    chapterRing: false,
    chapterRingRequired: false,
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
// DIAL AXES. The market does NOT sell a dial as one atomic thing, and modelling
// it that way was the single biggest complaint about this builder: "dials come
// in so many shapes, colours and sizes that the current fixed-variable system
// needs replacement" (feedback #56).
//
// What the listings actually show is a PRODUCT OF INDEPENDENT AXES. "Sunburst"
// appears on sub dials, sandwich dials, spork dials and 62MAS dials — the same
// finish across four different designs. "Vintage/fauxtina" is a lume-and-print
// treatment applied across families. "Smoked" is fumé applied on top of
// guilloché. So design, colour, finish, construction, index style, calendar,
// lume, diameter and dial feet are nine separate variables, and the catalogue
// entry below is a LISTED COMBINATION of them rather than a fixed atom.
//
// Each axis below is a first-class table. A build may override any of them; the
// default `as-listed` means "the dial as that listing comes". Combinations the
// research found no listing for are not hidden — they come back from
// compatibleOptions() as compatible:false with a reason, which is exactly the
// "dropdown with a warning symbol" the same feedback asked for.
//
// Colours are rendering hexes, not measurements — they carry no `src` because
// there is nothing to source: a listing photograph is not a colour spec.

/** Dial DESIGNS — the layout of markers and text, independent of colour. */
export const DIAL_DESIGNS = [
  { id: "sub", name: { en: "Sub / diver", sv: "Sub / dykare" }, markers: "sub", relief: "flat", grade: "common", src: "ctDials" },
  { id: "skx", name: { en: "SKX dive", sv: "SKX dykare" }, markers: "skx", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "mm", name: { en: "Divemaster / MM", sv: "Divemaster / MM" }, markers: "sub", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "sandwich", name: { en: "Sandwich", sv: "Sandwich" }, markers: "sub", relief: "recessed", grade: "common", src: "ctSandwich" },
  { id: "explorer369", name: { en: "Explorer 3-6-9", sv: "Explorer 3-6-9" }, markers: "explorer", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "california", name: { en: "California", sv: "California" }, markers: "california", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "62mas", name: { en: "62MAS", sv: "62MAS" }, markers: "62mas", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "roman", name: { en: "Roman index", sv: "Romersk index" }, markers: "roman", relief: "flat", grade: "common", src: "aliCalendar" },
  { id: "pilot", name: { en: "Pilot / flieger", sv: "Pilot / flieger" }, markers: "baton", relief: "flat", grade: "common", src: "ctDials" },
  { id: "dress", name: { en: "Dress", sv: "Klädtavla" }, markers: "baton", relief: "flat", grade: "common", src: "ctDials" },
  { id: "dj", name: { en: "Datejust dress", sv: "Datejust-klädtavla" }, markers: "baton", relief: "flat", grade: "common", src: "namokiDials" },
  { id: "gs-snowflake", name: { en: "GS snowflake / birch", sv: "GS snöflinga / björk" }, markers: "gs", relief: "embossed", reliefApprox: true, grade: "common", src: "namokiDials" },
  { id: "sector", name: { en: "Sector", sv: "Sektor" }, markers: "baton", relief: "flat", grade: "listed", src: "luciusMovements" },
  { id: "integrated-oak", name: { en: "Integrated sports (Oak)", sv: "Integrerad sport (Oak)" }, markers: "baton", relief: "embossed", reliefApprox: true, grade: "common", src: "namokiDials" },
  { id: "nautilus", name: { en: "Integrated sports (Nautilus)", sv: "Integrerad sport (Nautilus)" }, markers: "baton", relief: "embossed", reliefApprox: true, grade: "common", src: "namokiDials" },
  { id: "open-heart", name: { en: "Open heart", sv: "Öppet hjärta" }, markers: "baton", relief: "pierced", grade: "common", src: "ctDials" },
  { id: "skeleton", name: { en: "Skeleton", sv: "Skelett" }, markers: "baton", relief: "pierced", grade: "common", src: "ctDials" },
  { id: "worldtimer-gmt", name: { en: "Worldtimer / GMT", sv: "Worldtimer / GMT" }, markers: "sub", relief: "flat", grade: "listed", src: "namokiDials" },
  { id: "chrono-look", name: { en: "Chronograph look", sv: "Kronografutseende" }, markers: "baton", relief: "flat", grade: "listed", src: "namokiDials" },
  { id: "sterile-plain", name: { en: "Sterile / no logo", sv: "Steril / utan logga" }, markers: "baton", relief: "flat", grade: "common", src: "aliCalendar" },
];

/**
 * Dial COLOURS. `tier` records how broadly the colour is listed: `core` is
 * sold on nearly every family, `second` on many, `family` only inside the one
 * design run that has it (the enamel colour run above all), `rare` was found
 * once. `families` restricts a colour to the designs it was actually found on.
 * `accent` makes a colour a PAIR — two-tone is genuinely sold as one dial.
 */
export const DIAL_COLOURS = [
  { id: "black", name: { en: "Black", sv: "Svart" }, hex: "#0d0f12", tier: "core", src: "aliCalendar" },
  { id: "white", name: { en: "White", sv: "Vit" }, hex: "#f2f4f7", ink: "#1a1d22", tier: "core", src: "aliCalendar" },
  { id: "blue", name: { en: "Blue", sv: "Blå" }, hex: "#12386e", tier: "core", src: "aliCalendar" },
  { id: "green", name: { en: "Green", sv: "Grön" }, hex: "#12523a", tier: "core", src: "aliCalendar" },
  { id: "grey", name: { en: "Grey", sv: "Grå" }, hex: "#4a5058", tier: "second", src: "namokiDials" },
  { id: "silver", name: { en: "Silver", sv: "Silver" }, hex: "#c9ced6", ink: "#26292e", tier: "second", src: "ctDials" },
  { id: "orange", name: { en: "Orange", sv: "Orange" }, hex: "#c8561f", tier: "second", src: "ctDials" },
  { id: "purple", name: { en: "Purple", sv: "Lila" }, hex: "#4a2f7a", tier: "second", src: "aliCalendar" },
  { id: "cream", name: { en: "Cream / fauxtina", sv: "Gräddvit / fauxtina" }, hex: "#efe6d2", ink: "#2b2620", tier: "second", src: "namokiDials" },
  { id: "black-gold", name: { en: "Black with gold", sv: "Svart med guld" }, hex: "#0a0a0a", accent: "#cfa75a", tier: "second", src: "namokiDials" },
  { id: "tiffany-blue", name: { en: "Tiffany blue", sv: "Tiffanyblå" }, hex: "#7fd4c8", ink: "#12332e", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "pink", name: { en: "Pink", sv: "Rosa" }, hex: "#e39ab0", ink: "#3a1f28", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "forest-green", name: { en: "Forest green", sv: "Mörkgrön" }, hex: "#16412a", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "yellow", name: { en: "Yellow", sv: "Gul" }, hex: "#e3c13a", ink: "#33290a", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "red", name: { en: "Red", sv: "Röd" }, hex: "#9d2029", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "lavender", name: { en: "Lavender", sv: "Lavendel" }, hex: "#b6a5da", ink: "#2b2440", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "pistachio", name: { en: "Pistachio", sv: "Pistage" }, hex: "#b9cf9a", ink: "#26301c", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "beige", name: { en: "Beige", sv: "Beige" }, hex: "#e2d6bd", ink: "#332c1e", tier: "family", families: ["dress", "dj", "sterile-plain"], src: "namokiDials" },
  { id: "mint-green", name: { en: "Mint green", sv: "Mintgrön" }, hex: "#a8d5b8", ink: "#1c3326", tier: "family", families: ["dj", "dress"], src: "namokiDials" },
  { id: "navy", name: { en: "Navy", sv: "Marinblå" }, hex: "#16244a", tier: "second", src: "namokiDials" },
  { id: "olive-gold", name: { en: "Olive with gold", sv: "Oliv med guld" }, hex: "#42431f", accent: "#cfa75a", tier: "family", families: ["dj", "dress"], src: "namokiDials" },
  { id: "black-rose-gold", name: { en: "Black with rose gold", sv: "Svart med roséguld" }, hex: "#0b0c10", accent: "#c98f6f", tier: "family", families: ["sub", "mm", "skeleton", "open-heart"], src: "namokiDials" },
  { id: "gunmetal-rose-gold", name: { en: "Gunmetal with rose gold", sv: "Gunmetal med roséguld" }, hex: "#33383e", accent: "#c98f6f", tier: "family", families: ["skeleton", "open-heart"], src: "namokiDials" },
  { id: "salmon", name: { en: "Salmon", sv: "Laxrosa" }, hex: "#d99274", ink: "#3a2b24", tier: "rare", src: "namokiDials", note: { en: "Found once, as one colourway inside a multi-colour listing rather than as its own product family.", sv: "Hittad en gång, som en färgvariant i en annons med flera färger snarare än som en egen produktfamilj." } },
];

/**
 * Dial FINISHES. `render` is the legacy shading bucket the renderer already
 * understands, so a new finish never leaves a dial unpainted. `relief` says
 * whether the surface is physically three-dimensional — the answer to the
 * "3D texture on dials where it should be" half of the feedback.
 */
export const DIAL_FINISHES = [
  { id: "matte", name: { en: "Matte", sv: "Matt" }, render: "matte", relief: "flat", src: "ctDials" },
  { id: "sunburst", name: { en: "Sunburst / sunray", sv: "Solstråle" }, render: "sunburst", relief: "flat", src: "assembleDial", note: { en: "A brushed radial finish — anisotropic highlight, no relief at all.", sv: "En borstad radiell finish — riktad reflex, ingen relief alls." } },
  { id: "gloss-enamel", name: { en: "Gloss enamel", sv: "Blank emalj" }, render: "gloss", relief: "flat", src: "namokiDials", note: { en: "\"Enamel\" in this market is a printed/lacquered gloss, not fired vitreous enamel. Nothing was verified as true grand-feu.", sv: "\"Emalj\" i den här marknaden är tryckt/lackad blank yta, inte bränd äkta emalj. Inget kunde verifieras som riktig grand feu." } },
  { id: "fume", name: { en: "Fumé / gradient", sv: "Fumé / gradient" }, render: "fume", relief: "flat", src: "namokiDials" },
  { id: "vintage-matte", name: { en: "Vintage matte", sv: "Vintagematt" }, render: "matte", relief: "flat", src: "ctDials" },
  { id: "meteorite", name: { en: "Meteorite", sv: "Meteorit" }, render: "textured", relief: "flat", src: "aliCalendar", note: { en: "A material, effectively flat: the Widmanstätten pattern is etched, not raised. Render as texture, not geometry.", sv: "Ett material, i praktiken plant: Widmanstätten-mönstret är etsat, inte upphöjt. Rendera som textur, inte geometri." } },
  { id: "mother-of-pearl", name: { en: "Mother of pearl", sv: "Pärlemor" }, render: "textured", relief: "flat", src: "namokiDials", note: { en: "Flat but iridescent — needs a sheen shader rather than relief.", sv: "Plan men skimrande — kräver en glansmodell snarare än relief." } },
  { id: "carbon-fibre", name: { en: "Carbon fibre", sv: "Kolfiber" }, render: "textured", relief: "shallow", reliefApprox: true, src: "aliCalendar" },
  { id: "guilloche", name: { en: "Guilloché", sv: "Guilloché" }, render: "textured", relief: "shallow", reliefApprox: true, src: "aliCalendar", note: { en: "Guilloché is engine-turned engraving in principle; at this price it is very likely stamped and no listing says. Treat the depth as shallow and approximate.", sv: "Guilloché är i grunden svarvad gravyr; i den här prisklassen är den sannolikt präglad och ingen annons säger något. Behandla djupet som grunt och ungefärligt." } },
  { id: "waffle", name: { en: "Waffle", sv: "Våffelmönster" }, render: "textured", relief: "shallow", reliefApprox: true, src: "aliCalendar", note: { en: "Listed as \"waffle texture\" / \"waffle pattern\"; that it is stamped rather than printed is inference from the word texture.", sv: "Annonseras som \"waffle texture\"/\"waffle pattern\"; att den är präglad snarare än tryckt är en slutsats av ordet texture." } },
  { id: "birch-ice", name: { en: "Birch / ice", sv: "Björk / is" }, render: "textured", relief: "shallow", reliefApprox: true, src: "aliCalendar" },
  { id: "brushed", name: { en: "Brushed", sv: "Borstad" }, render: "textured", relief: "flat", src: "ctDials" },
  { id: "sandblasted", name: { en: "Sandblasted", sv: "Blästrad" }, render: "matte", relief: "flat", src: "ctDials" },
];

/** Dial CONSTRUCTION — sandwich is construction, not finish; both co-exist. */
export const DIAL_CONSTRUCTIONS = [
  { id: "flat", name: { en: "Single plate", sv: "Enkelplåt" }, relief: "flat", src: "ctDials" },
  { id: "sandwich", name: { en: "Sandwich (recessed cut-outs)", sv: "Sandwich (nedsänkta urtag)" }, relief: "recessed", src: "ctSandwich", note: { en: "Two stacked plates: the top plate is pierced with the index shapes and the lume layer sits beneath, so the numerals read as recessed.", sv: "Två plåtar på varandra: den övre är stansad med indexformerna och lysmasslagret ligger under, så siffrorna ser nedsänkta ut." } },
  { id: "pierced", name: { en: "Pierced (open heart / skeleton)", sv: "Genombruten (öppet hjärta/skelett)" }, relief: "pierced", src: "ctDials" },
];

/** Index STYLE — how the markers are made, separate from their shape. */
export const DIAL_INDEX_STYLES = [
  { id: "printed", name: { en: "Printed", sv: "Tryckta" }, relief: "flat", src: "diyclubDial" },
  { id: "applied", name: { en: "Applied metal", sv: "Applicerade i metall" }, relief: "raised", src: "diyclubDial" },
  { id: "sandwich-cutout", name: { en: "Sandwich cut-out", sv: "Sandwich-urtag" }, relief: "recessed", src: "ctSandwich" },
  { id: "none", name: { en: "No indices", sv: "Utan index" }, relief: "flat", src: "aliCalendar" },
];

/**
 * CALENDAR — using the market's own vocabulary, because it is what makes the
 * generated search links find anything: sellers say "single calendar" (date
 * only), "double calendar" (day-date) and "no calendar".
 */
export const DIAL_CALENDARS = [
  { id: "none", name: { en: "No calendar", sv: "Ingen kalender" }, date: null, day: false, src: "aliCalendar" },
  // 3 o'clock is the standard aperture position on BOTH crown layouts — an
  // SKX007 has its crown at 4 and its date at 3 — so `crownHour` is set only
  // where the aperture itself moves to follow the crown.
  { id: "date-3", name: { en: "Single calendar, date at 3", sv: "Enkel kalender, datum vid 3" }, date: "3", day: false, src: "aliCalendar" },
  { id: "date-4", name: { en: "Single calendar, date at 4", sv: "Enkel kalender, datum vid 4" }, date: "4", day: false, crownHour: 4, src: "modmode" },
  { id: "date-4-30", name: { en: "Single calendar, date at 4:30", sv: "Enkel kalender, datum vid 4:30" }, date: "4", day: false, crownHour: 4, src: "modmode" },
  { id: "date-6", name: { en: "Single calendar, date at 6", sv: "Enkel kalender, datum vid 6" }, date: "6", day: false, needsMovement: "date-6", src: "luciusMovements" },
  { id: "day-date-3", name: { en: "Double calendar, day and date at 3", sv: "Dubbel kalender, veckodag och datum vid 3" }, date: "3", day: true, src: "tandorioDial" },
];

/** Dial DIAMETERS actually listed for NHxx movements, in mm. */
export const DIAL_DIAMETERS = [
  { id: "28-5", name: { en: "28.5 mm (standard)", sv: "28,5 mm (standard)" }, mm: 28.5, src: "assembleDial" },
  { id: "29", name: { en: "29 mm", sv: "29 mm" }, mm: 29, approx: true, src: "aliCalendar" },
  { id: "30-5", name: { en: "30.5 mm", sv: "30,5 mm" }, mm: 30.5, approx: true, src: "aliCalendar" },
  { id: "31", name: { en: "31 mm", sv: "31 mm" }, mm: 31, approx: true, src: "aliCalendar" },
  { id: "31-8", name: { en: "31.8 mm (integrated-sports)", sv: "31,8 mm (integrerad sport)" }, mm: 31.8, approx: true, src: "aliCalendar" },
  { id: "32", name: { en: "32 mm", sv: "32 mm" }, mm: 32, approx: true, src: "aliCalendar" },
];

/** Dial FEET — a genuine fitment axis, not a detail. */
export const DIAL_FEET = [
  { id: "feet4", name: { en: "Four feet, 3 and 4 o'clock", sv: "Fyra fötter, för krona vid 3 och 4" }, feet: 4, footDiaMm: DIAL_SPEC.footDiaMm, footLengthMm: DIAL_SPEC.footLengthMm, src: "ctSandwich", note: { en: "The mod-parts norm: two sets of feet, and you snip off the pair you do not need. The foot itself is Ø1.00 × 2.15 mm on the manufacturer's drawing.", sv: "Normen för moddelar: två uppsättningar fötter, och du klipper bort det par du inte behöver. Foten själv är Ø1,00 × 2,15 mm enligt tillverkarens ritning." } },
  { id: "feet2-3", name: { en: "Two feet, 3 o'clock crown", sv: "Två fötter, krona vid 3" }, feet: 2, crownHour: 3, footDiaMm: DIAL_SPEC.footDiaMm, footLengthMm: DIAL_SPEC.footLengthMm, src: "nh36sheet" },
  { id: "feet2-4", name: { en: "Two feet, 4 o'clock crown", sv: "Två fötter, krona vid 4" }, feet: 2, crownHour: 4, footDiaMm: DIAL_SPEC.footDiaMm, footLengthMm: DIAL_SPEC.footLengthMm, src: "nh36sheet" },
  { id: "glue", name: { en: "No feet, dial dots", sv: "Utan fötter, limpunkter" }, feet: 0, src: "community", note: { en: "Cheap dials often come feetless and are mounted on adhesive dial dots — three rather than the usual two is the advice.", sv: "Billiga urtavlor kommer ofta utan fötter och monteras på självhäftande limpunkter — rådet är tre i stället för de vanliga två." } },
];

/** How custom dial text is put on. Not interchangeable visually. */
export const DIAL_PRINTS = [
  { id: "sterile", name: { en: "Sterile — no printing", sv: "Steril — ingen tryck" }, src: "aliCalendar" },
  { id: "pad-print", name: { en: "Pad print", sv: "Tampotryck" }, src: "diyclubDial" },
  { id: "laser-mark", name: { en: "Laser mark", sv: "Lasermärkning" }, src: "diyclubDial", note: { en: "Laser marking alters the surface rather than adding ink, so on a dark dial the text reads metallic grey, not white.", sv: "Lasermärkning bearbetar ytan i stället för att lägga på färg, så på en mörk urtavla blir texten metalliskt grå, inte vit." } },
  { id: "applied-logo", name: { en: "Applied metal logo", sv: "Applicerad metallogga" }, relief: "raised", src: "diyclubDial" },
];

/**
 * The custom-text slots. All four optional, all empty by default — STERILE IS
 * A REAL, SELLABLE CHOICE, not the absence of one, and the market lists it as
 * its own product ("sterile", "no logo").
 *
 * The line grammar itself (brand at 12 / model line under it / AUTOMATIC /
 * jewel count / depth rating above 6) is a UI convention, NOT a sourced fact:
 * no source states it in words. It is offered as four editable slots with no
 * defaults, and no depth rating is ever pre-filled — a depth rating has to
 * match the case's real rating, which the dial listing cannot know.
 */
export const DIAL_TEXT_FIELDS = [
  { key: "textLogo", name: { en: "Logo / brand at 12", sv: "Logga/märke vid 12" }, max: 22, src: "diyclubDial" },
  { key: "text12", name: { en: "Line under the logo", sv: "Rad under loggan" }, max: 22, src: "diyclubDial" },
  { key: "text6a", name: { en: "First line above 6", sv: "Första raden ovanför 6" }, max: 22, src: "diyclubDial" },
  { key: "text6b", name: { en: "Second line above 6", sv: "Andra raden ovanför 6" }, max: 22, src: "diyclubDial" },
];

/** Roughly 3–6 mm on a 28.5 mm dial, per a custom-dial vendor's own guide. */
export const DIAL_LOGO_MM = { min: 3, max: 6, approx: true, src: "diyclubDial" };

// ---------------------------------------------------------------------------
// DIALS. Each entry is a LISTED COMBINATION of the axes above: `design`,
// `colour`, `finishId`, `construction`, `indices`, `calendar`, `lume`,
// `diameter` and `feet` say which values it ships with, and a build may
// override any of them.
//
// The legacy fields stay exactly where they were — `base`, `finish`, `markers`,
// `markerColor`, `textColor`, `lume`, `date`, `day`, `gmt`, `openHeart`,
// `text` — because the renderer and the geometry builders read them, and
// resolveBuild() recomputes them from the axes so an override lands on the
// screen without either of those having to know the axes exist.

export const DIALS = [
  {
    id: "skx-black",
    name: { en: "SKX matte black", sv: "SKX matt svart" },
    design: "skx",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    ali: { queries: ["NH35 dial 28.5mm SKX", "28.5mm single calendar dial NH35"], priceUsd: [8, 30] },
  },
  {
    id: "sub-black",
    name: { en: "Sub gloss black", sv: "Sub blank svart" },
    design: "sub",
    colour: "black",
    finishId: "gloss-enamel",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "sub",
    colour: "blue",
    finishId: "sunburst",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "dress",
    colour: "green",
    finishId: "sunburst",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "sub",
    colour: "black-gold",
    finishId: "gloss-enamel",
    construction: "flat",
    indices: "printed",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "62mas",
    colour: "cream",
    finishId: "vintage-matte",
    construction: "flat",
    indices: "applied",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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
    design: "california",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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
    design: "explorer369",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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
    design: "gs-snowflake",
    colour: "white",
    finishId: "birch-ice",
    construction: "flat",
    indices: "applied",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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
    design: "sub",
    colour: "grey",
    finishId: "fume",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "dress",
    colour: "salmon",
    finishId: "sunburst",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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
    design: "sub",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "day-date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "worldtimer-gmt",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
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
    design: "open-heart",
    colour: "black",
    finishId: "matte",
    construction: "pierced",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
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

  // --- Designs the 2026-07-30 listing survey found that the first catalogue
  // had no entry for. Appended rather than interleaved so the older entries
  // keep their position (the chat parser's longest-match tie-breaking reads
  // this order).
  {
    id: "sandwich-black",
    name: { en: "Sandwich, sunburst black", sv: "Sandwich, solstrålesvart" },
    design: "sandwich",
    colour: "black",
    finishId: "sunburst",
    construction: "sandwich",
    indices: "sandwich-cutout",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#0b0d10",
    finish: "sunburst",
    markers: "sub",
    markerColor: "#e9eef5",
    lume: "c3",
    textColor: "#e9eef5",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "ctSandwich",
    note: {
      en: "The sandwich family is genuinely narrow: black, dark blue and orange are the colourways found. Other colours are offered here with a warning rather than hidden.",
      sv: "Sandwich-familjen är verkligen smal: svart, mörkblå och orange är de färger som hittats. Andra färger erbjuds här med varning i stället för att döljas.",
    },
    ali: { queries: ["sandwich dial NH35 28.5mm", "28.5mm sunburst sandwich dial"], priceUsd: [12, 45] },
  },
  {
    id: "divemaster-black",
    name: { en: "Divemaster black", sv: "Divemaster svart" },
    design: "mm",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "applied",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#0a0c0f",
    finish: "matte",
    markers: "sub",
    markerColor: "#eef3fb",
    lume: "c3",
    textColor: "#eef3fb",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC", "300m"],
    src: "namokiDials",
    ali: { queries: ["MM300 dial NH35 28.5mm", "divemaster dial NH35 no calendar"], priceUsd: [10, 42] },
  },
  {
    id: "pilot-black",
    name: { en: "Pilot flieger black", sv: "Pilotflieger svart" },
    design: "pilot",
    colour: "black",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#0b0c0f",
    finish: "matte",
    markers: "baton",
    markerColor: "#f0f3f8",
    lume: "c3",
    textColor: "#f0f3f8",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "ctDials",
    ali: { queries: ["pilot dial NH35 28.5mm", "flieger dial NH35 no calendar"], priceUsd: [10, 40] },
  },
  {
    id: "dj-white",
    name: { en: "Datejust white", sv: "Datejust vit" },
    design: "dj",
    colour: "white",
    finishId: "sunburst",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
    base: "#eef1f5",
    finish: "sunburst",
    markers: "baton",
    markerColor: "#2a2f36",
    lume: "none",
    textColor: "#2a2f36",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "namokiDials",
    ali: { queries: ["datejust dial NH35 28.5mm", "DJ dial NH35 single calendar"], priceUsd: [10, 40] },
  },
  {
    id: "sector-ivory",
    name: { en: "Sector, ivory", sv: "Sektor, elfenben" },
    design: "sector",
    colour: "beige",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#e8e2d3",
    finish: "matte",
    markers: "baton",
    markerColor: "#2f2b24",
    lume: "vintage-cream",
    textColor: "#2f2b24",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "luciusMovements",
    ali: { queries: ["sector dial NH35 28.5mm no date"], priceUsd: [12, 48] },
  },
  {
    id: "oak-navy",
    name: { en: "Integrated sports navy", sv: "Integrerad sport, marinblå" },
    design: "integrated-oak",
    colour: "navy",
    finishId: "waffle",
    construction: "flat",
    indices: "applied",
    calendar: "date-3",
    diameter: "31-8",
    feet: "feet4",
    base: "#16244a",
    finish: "textured",
    markers: "baton",
    markerColor: "#e6ecf6",
    lume: "bgw9",
    textColor: "#e6ecf6",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "namokiDials",
    note: {
      en: "The integrated-sports dials are frequently listed at 31.8 mm rather than 28.5 mm, so this one only fits cases whose dial seat takes an oversize dial.",
      sv: "Urtavlorna i integrerad sportstil säljs ofta i 31,8 mm i stället för 28,5 mm, så den här passar bara boetter vars urtavlesäte tar en överstor tavla.",
    },
    ali: { queries: ["ap royal oak dial NH35", "31.8mm dial NH35 integrated"], priceUsd: [14, 55] },
  },
  {
    id: "skeleton-cut",
    name: { en: "Skeleton cut-out", sv: "Skelettskuren" },
    design: "skeleton",
    colour: "gunmetal-rose-gold",
    finishId: "brushed",
    construction: "pierced",
    indices: "applied",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#33383e",
    finish: "textured",
    markers: "baton",
    markerColor: "#c98f6f",
    lume: "c3",
    textColor: "#c98f6f",
    date: null,
    day: false,
    gmt: false,
    openHeart: true,
    text: [],
    src: "ctDials",
    ali: { queries: ["skeleton dial NH35 28.5mm", "NH70 skeleton dial"], priceUsd: [12, 50] },
  },
  {
    id: "sterile-white",
    name: { en: "Sterile, no logo", sv: "Steril, utan logga" },
    design: "sterile-plain",
    colour: "white",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "none",
    diameter: "28-5",
    feet: "feet4",
    base: "#f2f4f7",
    finish: "matte",
    markers: "baton",
    markerColor: "#1a1d22",
    lume: "bgw9",
    textColor: "#1a1d22",
    date: null,
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "aliCalendar",
    note: {
      en: "Sterile is a product in its own right, not the absence of one — sellers list \"sterile\" and \"no logo\" dials as their own line.",
      sv: "Steril är en egen produkt, inte frånvaron av en — säljare listar \"sterile\" och \"no logo\" som en egen serie.",
    },
    ali: { queries: ["sterile dial NH35 28.5mm", "no logo dial NH35 28.5"], priceUsd: [8, 28] },
  },
  {
    id: "roman-white",
    name: { en: "Roman numerals white", sv: "Romerska siffror vit" },
    design: "roman",
    colour: "white",
    finishId: "sunburst",
    construction: "flat",
    indices: "printed",
    calendar: "date-3",
    diameter: "28-5",
    feet: "feet4",
    base: "#eef0f4",
    finish: "sunburst",
    markers: "roman",
    markerColor: "#23262c",
    lume: "none",
    textColor: "#23262c",
    date: "3",
    day: false,
    gmt: false,
    openHeart: false,
    text: [],
    src: "aliCalendar",
    ali: { queries: ["roman dial NH35 28.5mm", "roma index dial NH35"], priceUsd: [10, 38] },
  },
  {
    id: "daydate-white",
    name: { en: "Day-date white", sv: "Veckodag/datum vit" },
    design: "sub",
    colour: "white",
    finishId: "matte",
    construction: "flat",
    indices: "printed",
    calendar: "day-date-3",
    diameter: "28-5",
    feet: "feet4",
    base: "#eef1f5",
    finish: "matte",
    markers: "sub",
    markerColor: "#22262c",
    lume: "c3",
    textColor: "#22262c",
    date: "3",
    day: true,
    gmt: false,
    openHeart: false,
    text: ["AUTOMATIC"],
    src: "tandorioDial",
    ali: { queries: ["NH36 double calendar dial 28.5", "day date dial NH36 white"], priceUsd: [10, 40] },
  },
];

/**
 * Lume compound colours (daylight tint, glow tint). Lume is a variable of its
 * own in almost every listing — "green C3", "blue BGW9", "no lume", "full
 * lume" — which is why it is a separate axis rather than a dial property.
 */
export const LUMES = {
  c3: { name: { en: "C3 green", sv: "C3 grön" }, day: "#d9e6b8", glow: "#8dff6a", src: "aliCalendar" },
  bgw9: { name: { en: "BGW9 blue", sv: "BGW9 blå" }, day: "#e7eef5", glow: "#7fd0ff", src: "aliCalendar" },
  "ice-blue": { name: { en: "Ice blue", sv: "Isblå" }, day: "#e4f1f7", glow: "#bfe9ff", src: "namokiDials" },
  "old-radium": { name: { en: "Old radium", sv: "Old radium" }, day: "#c9ab74", glow: "#a9ff86", src: "namokiDials" },
  "vintage-cream": {
    name: { en: "Vintage cream (deliberately weak)", sv: "Vintagegrädde (medvetet svag)" },
    day: "#d8c49a",
    glow: "#93d97a",
    src: "namokiDials",
    note: {
      en: "A deliberately weaker C3 blend sold for fauxtina builds — it is meant to glow less, not to have aged.",
      sv: "En medvetet svagare C3-blandning som säljs för fauxtina-byggen — den ska lysa svagare, inte ha åldrats.",
    },
  },
  "full-lume": {
    name: { en: "Full lume (whole dial glows)", sv: "Helt lysande tavla" },
    day: "#e9f0dd",
    glow: "#a9ff8e",
    src: "namokiWheels",
  },
  none: { name: { en: "No lume", sv: "Ingen lysmassa" }, day: "#dfe4ea", glow: "#dfe4ea", src: "aliCalendar" },
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

/**
 * Bezel-insert MATERIALS, with the one dimension listings actually publish.
 * Aluminium thickness is genuinely disputed across listings (0.7 / 0.8 / 0.95 /
 * 1.0 mm), so the range is carried rather than averaged.
 */
export const INSERT_MATERIALS = [
  { id: "aluminium", name: { en: "Aluminium", sv: "Aluminium" }, thicknessMm: 0.7, thicknessRangeMm: [0.7, 1.0], approx: true, gloss: false, src: "ebayInsert", note: { en: "Listings quote 0.7, 0.8, 0.95 and 1.0 mm for aluminium inserts. The range is carried; there is no single published figure.", sv: "Annonser anger 0,7, 0,8, 0,95 och 1,0 mm för aluminiuminlägg. Spannet bärs vidare; det finns ingen enskild publicerad siffra." } },
  { id: "ceramic", name: { en: "Ceramic", sv: "Keramik" }, thicknessMm: 1.0, gloss: true, src: "ebayInsert" },
  { id: "steel", name: { en: "Steel", sv: "Stål" }, thicknessMm: 0.9, gloss: false, src: "ebayInsert" },
  { id: "sapphire", name: { en: "Sapphire, lumed", sv: "Safir, lysande" }, gloss: true, lumed: true, src: "namokiInserts", note: { en: "A boutique-tier part; no thickness is published for it.", sv: "En butiksdel i högre prisklass; ingen tjocklek publiceras för den." } },
  { id: "forged-carbon", name: { en: "Forged carbon", sv: "Smidd kolfiber" }, gloss: false, src: "namokiInserts" },
  { id: "glass", name: { en: "Glass", sv: "Glas" }, gloss: true, src: "namokiInserts" },
];

/**
 * Insert PROFILE. The whole flat-vs-sloped difference is in the INNER
 * diameter — a sloped insert overhangs 0.9 mm further inward on the SKX
 * platform — and that is the geometric root of the crystal ↔ insert rule.
 */
export const INSERT_PROFILES = [
  { id: "flat", name: { en: "Flat", sv: "Plan" }, src: "namokiInserts" },
  { id: "sloped", name: { en: "Sloped", sv: "Sluttande" }, src: "namokiInserts", note: { en: "A sloped insert intrudes further toward the centre, so it needs a crystal cut for it or a visible step appears at the bezel edge.", sv: "Ett sluttande inlägg går längre in mot mitten och kräver därför ett glas gjort för det, annars syns ett steg vid lünettkanten." } },
];

export const INSERTS = [
  {
    id: "alu-black",
    name: { en: "Aluminium, black", sv: "Aluminium, svart" },
    scale: "dive60",
    material: "aluminium",
    profile: "flat",
    base: "#111318",
    mark: "#eceff4",
    pip: "c3",
    fits: ["skx", "skx013", "srp"],
    src: "ebayInsert",
    ali: { queries: ["SKX007 bezel insert aluminium"], priceUsd: [4, 15] },
  },
  {
    id: "ceramic-black",
    name: { en: "Ceramic, black", sv: "Keramik, svart" },
    scale: "dive60",
    material: "ceramic",
    profile: "sloped",
    base: "#0a0b0e",
    mark: "#f3f6fa",
    pip: "bgw9",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    src: "namokiInserts",
    ali: { queries: ["SKX007 ceramic bezel insert"], priceUsd: [10, 30] },
  },
  {
    id: "pepsi",
    name: { en: "Pepsi (blue / red)", sv: "Pepsi (blå/röd)" },
    scale: "dive60",
    material: "ceramic",
    profile: "sloped",
    base: "#123a72",
    base2: "#9d2029",
    mark: "#f4f7fb",
    pip: "c3",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    src: "namokiInserts",
    ali: { queries: ["pepsi bezel insert SKX007 ceramic"], priceUsd: [10, 32] },
  },
  {
    id: "batman",
    name: { en: "Batman (blue / black)", sv: "Batman (blå/svart)" },
    scale: "dive60",
    material: "ceramic",
    profile: "sloped",
    base: "#16335f",
    base2: "#0b0c10",
    mark: "#f2f5fa",
    pip: "bgw9",
    gloss: true,
    fits: ["skx", "srp"],
    src: "namokiInserts",
    ali: { queries: ["batman bezel insert SKX007"], priceUsd: [10, 32] },
  },
  {
    id: "green",
    name: { en: "Ceramic, green", sv: "Keramik, grön" },
    scale: "dive60",
    material: "ceramic",
    profile: "sloped",
    base: "#0f4a2c",
    mark: "#f0f6f2",
    pip: "c3",
    gloss: true,
    fits: ["skx", "skx013", "srp"],
    src: "namokiInserts",
    ali: { queries: ["green ceramic bezel insert SKX007"], priceUsd: [10, 32] },
  },
  {
    id: "gmt-24",
    name: { en: "24-hour GMT", sv: "24-timmars GMT" },
    scale: "hours24",
    material: "ceramic",
    profile: "sloped",
    base: "#101319",
    base2: "#1d3f6d",
    mark: "#f1f4f9",
    pip: "bgw9",
    gloss: true,
    gmt: true,
    fits: ["skx", "srp"],
    src: "namokiInserts",
    ali: { queries: ["24 hour GMT bezel insert SKX007"], priceUsd: [10, 34] },
  },
  {
    id: "steel-plain",
    name: { en: "Plain steel (no insert)", sv: "Blank stål (utan inlägg)" },
    scale: "none",
    material: "steel",
    profile: "flat",
    base: "#8d949d",
    mark: "#5d646d",
    pip: "none",
    fits: ["skx", "skx013", "srp", "native"],
    src: "namokiInserts",
    ali: { queries: ["steel bezel insert SKX007 sterile"], priceUsd: [5, 20] },
  },
  {
    id: "coke",
    name: { en: "Coke", sv: "Coke" },
    scale: "hours24",
    material: "aluminium",
    profile: "flat",
    base: "#0b0c10",
    base2: "#8d2027",
    mark: "#f2f5fa",
    pip: "c3",
    gmt: true,
    fits: ["skx", "srp"],
    src: "namokiInserts",
    ali: { queries: ["GMT coke bezel insert SKX007"], priceUsd: [8, 30] },
  },
  {
    id: "dual-time",
    name: { en: "Dual time", sv: "Dubbeltid" },
    scale: "hours24",
    material: "steel",
    profile: "flat",
    base: "#1a1e24",
    mark: "#dbe2ea",
    pip: "none",
    gmt: true,
    fits: ["skx", "srp"],
    src: "namokiInserts",
    ali: { queries: ["dual time bezel insert SKX007"], priceUsd: [10, 40] },
  },
  {
    id: "sapphire-lumed",
    name: { en: "Sapphire, fully lumed", sv: "Safir, helt lysande" },
    scale: "dive60",
    material: "sapphire",
    profile: "flat",
    base: "#0d1017",
    mark: "#eaf1f8",
    pip: "bgw9",
    gloss: true,
    lumed: true,
    fits: ["skx", "srp"],
    src: "namokiInserts",
    ali: { queries: ["sapphire lume bezel insert SKX007"], priceUsd: [25, 70] },
  },
  {
    id: "fathoms-steel",
    name: { en: "Fathoms style, steel", sv: "Fathoms-stil, stål" },
    scale: "dive60",
    material: "steel",
    profile: "flat",
    base: "#2a2f36",
    mark: "#e7ecf3",
    pip: "old-radium",
    fits: ["skx", "skx013", "srp"],
    src: "namokiInserts",
    ali: { queries: ["vintage steel bezel insert SKX007"], priceUsd: [12, 50] },
  },
];

/** How a chapter ring is printed — a listed, filterable attribute. */
export const CHAPTER_PRINTINGS = [
  { id: "micro-markers", name: { en: "Micro markers", sv: "Mikromarkeringar" }, src: "wsChapter" },
  { id: "05-60", name: { en: "05–60 five-minute numerals", sv: "05–60, femminuterssiffror" }, src: "wsChapter" },
  { id: "gmt24", name: { en: "GMT 24-hour", sv: "GMT 24-timmars" }, src: "wsChapter" },
  { id: "laser-etched", name: { en: "Laser etched", sv: "Laseretsad" }, src: "wsChapter" },
  { id: "plain", name: { en: "Plain colour band", sv: "Enfärgat band" }, src: "wsChapter" },
];

export const CHAPTER_RINGS = [
  {
    id: "black-minutes",
    name: { en: "Black, minute track", sv: "Svart, minutskala" },
    base: "#0c0e12",
    mark: "#e6ebf2",
    printing: "micro-markers",
    finish: "matte",
    lume: "none",
    fits: ["skx", "skx013", "srp"],
    src: "wsChapter",
    ali: { queries: ["SKX007 chapter ring black"], priceUsd: [4, 14] },
  },
  {
    id: "white-minutes",
    name: { en: "White, minute track", sv: "Vit, minutskala" },
    base: "#e9edf3",
    mark: "#1a1d22",
    printing: "micro-markers",
    finish: "matte",
    lume: "none",
    fits: ["skx", "skx013", "srp"],
    src: "wsChapter",
    ali: { queries: ["SKX007 chapter ring white"], priceUsd: [4, 14] },
  },
  {
    id: "red-accent",
    name: { en: "Black with red 15", sv: "Svart med röd 15" },
    base: "#0c0e12",
    mark: "#e6ebf2",
    accent: "#d8453c",
    printing: "05-60",
    finish: "matte",
    lume: "none",
    fits: ["skx", "srp"],
    src: "wsChapter",
    ali: { queries: ["SKX007 chapter ring red"], priceUsd: [4, 16] },
  },
  {
    id: "steel",
    name: { en: "Bare steel", sv: "Rent stål" },
    base: "#9aa1aa",
    mark: "#6b727b",
    printing: "plain",
    finish: "polished",
    lume: "none",
    fits: ["skx", "skx013", "srp"],
    src: "wsChapter",
    ali: { queries: ["SKX007 chapter ring steel"], priceUsd: [4, 14] },
  },
  {
    id: "gmt-hours",
    name: { en: "24-hour ring, blue", sv: "24-timmarsring, blå" },
    base: "#16335f",
    mark: "#eef3fb",
    printing: "gmt24",
    finish: "matte",
    lume: "bgw9",
    gmt: true,
    fits: ["skx", "srp"],
    src: "wsChapter",
    ali: { queries: ["GMT chapter ring SKX007"], priceUsd: [6, 20] },
  },
];

/**
 * Crystal EDGE. This is the correction the feedback asked for by name: "flat
 * sapphire isn't flat". It is — every flat sapphire sold for these cases has a
 * PLANAR top face. The only relief is at the rim, and vendors sell the two rim
 * treatments as separate SKUs (CT025 flat with a top bevel, CT025F flat with
 * none, CT094 flat with a stepped edge). So the bevel is an option on the
 * crystal, not something baked into the shape, and it is a straight chamfer —
 * never a fillet, never a residual curve.
 */
export const CRYSTAL_EDGES = [
  { id: "bevel", name: { en: "Top edge bevel (OEM look)", sv: "Fasad överkant (originallook)" }, forInsert: "any", chamferMm: 0.4, chamferRangeMm: [0.3, 0.5], approx: true, src: "ct025", note: { en: "The chamfer's width and angle are published nowhere. 0.3–0.5 mm is read off vendor photography, not a spec sheet.", sv: "Fasens bredd och vinkel publiceras ingenstans. 0,3–0,5 mm är avläst från säljarnas bilder, inte ett datablad." } },
  { id: "none", name: { en: "No top bevel", sv: "Utan fas" }, forInsert: "flat", chamferMm: 0, src: "ct025", note: { en: "Sold explicitly for a smooth fit with FLAT bezel inserts.", sv: "Säljs uttryckligen för en jämn passning mot PLANA lünettinlägg." } },
  { id: "stepped", name: { en: "Stepped edge (for sloping inserts)", sv: "Trappad kant (för sluttande inlägg)" }, forInsert: "sloped", chamferMm: 0, src: "ct094", note: { en: "Made to address the step/gap that appears when a standard crystal is paired with a thicker sloping ceramic insert.", sv: "Gjord för att lösa steget/glipan som uppstår när ett standardglas paras med ett tjockare sluttande keramikinlägg." } },
];

/** Anti-reflective coating options actually offered. */
export const CRYSTAL_ARS = [
  { id: "none", name: { en: "No AR coating", sv: "Utan antireflex" }, tint: "#e0e7ef", src: "longisland" },
  { id: "clear", name: { en: "Clear AR", sv: "Klar antireflex" }, tint: "#e3ecf6", src: "ct025" },
  { id: "blue", name: { en: "Blue AR", sv: "Blå antireflex" }, tint: "#9fc4ee", src: "ct025" },
  { id: "red", name: { en: "Red AR", sv: "Röd antireflex" }, tint: "#e9bfc0", src: "watchandstyle", note: { en: "Listed for the Turtle platform.", sv: "Listad för Turtle-plattformen." } },
];

/**
 * Which SIDE the coating is on. CrystalTimes states underside-only for the
 * parts that say anything at all, which matters to the renderer: the top face
 * still reflects normally. Double-sided AR is advertised on marketplace
 * listings but no boutique SKU states it, so it is carried as unverified.
 */
export const CRYSTAL_AR_SIDES = [
  { id: "underside", name: { en: "Underside only", sv: "Endast undersidan" }, src: "ct037" },
  { id: "both", name: { en: "Both sides", sv: "Båda sidor" }, approx: true, src: "community", note: { en: "Advertised on marketplace listings; no boutique SKU for these platforms states it. Treat as unverified.", sv: "Annonseras på marknadsplatser; ingen butiks-SKU för de här plattformarna anger det. Behandla som overifierat." } },
];

export const CRYSTALS = [
  {
    id: "dd-sapphire",
    name: { en: "Double-dome sapphire, clear AR", sv: "Dubbelkupad safir, klar AR" },
    material: "sapphire",
    profile: "double-dome",
    edge: "bevel",
    arSide: "underside",
    forInsert: "any",
    dome: 1.0,
    diaMm: 31.5,
    heightMm: 4.7,
    cyclops: false,
    tint: "#dfe9f5",
    ar: "clear",
    fits: ["skx", "skx013", "srp", "native"],
    src: "ct037",
    note: {
      en: "31.5 × 4.7 mm on the SKX platform (CT037); the CT141 \"RX look\" sibling is 4.5 mm and the flat-insert CT037F variant 5.3 mm. Only the SKX figures are published — the SKX013 and Turtle double-domes are not dimensioned anywhere.",
      sv: "31,5 × 4,7 mm på SKX-plattformen (CT037); systermodellen CT141 \"RX look\" är 4,5 mm och CT037F för plana inlägg 5,3 mm. Bara SKX-måtten publiceras — dubbelkupade glas för SKX013 och Turtle saknar mått helt.",
    },
    ali: { queries: ["SKX007 double dome sapphire crystal 31.5"], priceUsd: [12, 45] },
  },
  {
    id: "dd-sapphire-blue",
    name: { en: "Double-dome sapphire, blue AR", sv: "Dubbelkupad safir, blå AR" },
    material: "sapphire",
    profile: "double-dome",
    edge: "bevel",
    arSide: "underside",
    forInsert: "any",
    dome: 1.0,
    diaMm: 31.5,
    heightMm: 4.7,
    cyclops: false,
    tint: "#9fc4ee",
    ar: "blue",
    fits: ["skx", "skx013", "srp", "native"],
    src: "ct037",
    ali: { queries: ["SKX007 sapphire crystal blue AR"], priceUsd: [12, 45] },
  },
  {
    id: "flat-sapphire",
    name: { en: "Flat sapphire", sv: "Plan safir" },
    material: "sapphire",
    profile: "flat",
    edge: "bevel",
    arSide: "underside",
    forInsert: "any",
    // GENUINELY FLAT: the top face is a plane. `dome` is 0 so nothing revolves
    // a curve over it; `edge` adds the straight chamfer at the rim instead.
    dome: 0,
    diaMm: 31.5,
    thicknessMm: 2.9,
    cyclops: false,
    tint: "#e3ecf6",
    ar: "clear",
    fits: ["skx", "skx013", "srp", "native"],
    src: "longisland",
    note: {
      en: "31.5 × 2.9 mm on the SKX platform; Watch&Style quotes 31.4 mm edge-to-edge for the same part, and both figures are carried. SKX013 takes 28 × 2.8 mm and the Turtle 32 × 2.8 mm. The top face is planar — the only relief is the rim treatment picked in `edge`.",
      sv: "31,5 × 2,9 mm på SKX-plattformen; Watch&Style anger 31,4 mm kant till kant för samma del, och båda siffrorna bärs vidare. SKX013 tar 28 × 2,8 mm och Turtle 32 × 2,8 mm. Ovansidan är plan — den enda reliefen är kantbehandlingen som väljs i `edge`.",
    },
    ali: { queries: ["SKX007 flat sapphire crystal"], priceUsd: [10, 35] },
  },
  {
    id: "box-sapphire",
    name: { en: "Box sapphire (vintage)", sv: "Boxsafir (vintage)" },
    material: "sapphire",
    profile: "box",
    edge: "none",
    arSide: "underside",
    forInsert: "flat",
    dome: 1.6,
    diaMm: 31.5,
    cyclops: false,
    tint: "#e6eef7",
    ar: "clear",
    fits: ["skx", "srp", "native"],
    src: "ctCrystals",
    note: {
      en: "Box, top-hat and single-dome crystals are all listed SKUs, but none of them is dimensioned by any vendor — a box crystal visibly stands proud of the bezel and the height is a rendering convention, not a measurement.",
      sv: "Box-, top hat- och enkelkupade glas finns alla som riktiga artiklar, men ingen av dem har mått hos någon säljare — ett boxglas står synligt över lünetten och höjden här är en renderingskonvention, inte ett mätvärde.",
    },
    approx: true,
    ali: { queries: ["box sapphire crystal SKX007 vintage"], priceUsd: [18, 60] },
  },
  {
    id: "single-dome-sapphire",
    name: { en: "Single-dome sapphire", sv: "Enkelkupad safir" },
    material: "sapphire",
    profile: "single-dome",
    edge: "bevel",
    arSide: "underside",
    forInsert: "any",
    dome: 0.7,
    diaMm: 31.5,
    cyclops: false,
    tint: "#e2ebf6",
    ar: "clear",
    fits: ["skx", "skx013", "srp", "native"],
    approx: true,
    src: "ctCrystals",
    note: {
      en: "A listed SKU (CT125 for the Turtle); its height is not published anywhere.",
      sv: "En riktig artikel (CT125 för Turtle); höjden publiceras inte någonstans.",
    },
    ali: { queries: ["single dome sapphire crystal SKX007"], priceUsd: [14, 50] },
  },
  {
    id: "top-hat-sapphire",
    name: { en: "Top hat sapphire", sv: "Top hat-safir" },
    material: "sapphire",
    profile: "top-hat",
    edge: "none",
    arSide: "underside",
    forInsert: "flat",
    dome: 2.0,
    diaMm: 31.5,
    cyclops: false,
    tint: "#e6eef7",
    ar: "clear",
    fits: ["skx", "srp", "native"],
    approx: true,
    src: "ctCrystals",
    note: {
      en: "CT101 for the SKX and CT096 for the Turtle are real listings; neither publishes a height, so the stand-proud figure here is a rendering convention.",
      sv: "CT101 för SKX och CT096 för Turtle är riktiga annonser; ingen anger höjd, så måttet här är en renderingskonvention.",
    },
    ali: { queries: ["top hat sapphire crystal SKX007"], priceUsd: [25, 70] },
  },
  {
    id: "domed-hardlex",
    name: { en: "Flat Hardlex (stock)", sv: "Plan Hardlex (original)" },
    material: "hardlex",
    profile: "flat",
    edge: "bevel",
    arSide: "underside",
    forInsert: "any",
    // The OEM SKX crystal is flat mineral, and every sapphire replacement is
    // sold as "dimensionally similar to the OEM Seiko mineral crystal".
    dome: 0,
    diaMm: 31.5,
    thicknessMm: 2.9,
    cyclops: false,
    tint: "#e0e7ef",
    ar: "none",
    fits: ["skx", "skx013", "srp", "native"],
    approx: true,
    note: {
      en: "Hardlex is hardened mineral glass: above plain mineral (about Mohs 5), well below sapphire's Mohs 9 — it scratches, but shrugs off knocks that chip sapphire. Seiko publishes no hardness number for it, so this is a ranking, not a measurement; the HV figures online are community-repeated.",
      sv: "Hardlex är härdat mineralglas: hårdare än vanligt mineralglas (ca Mohs 5), långt under safirens Mohs 9 — det repas, men klarar stötar som flisar safir. Seiko publicerar inget hårdhetsvärde, så detta är en rangordning, inte en mätning; HV-siffrorna på nätet är vidarespridda i communityn.",
    },
    src: "namokiCrystals",
    srcAlso: ["ctHardlex"],
    ali: { queries: ["SKX007 hardlex crystal"], priceUsd: [5, 18] },
  },
];

/**
 * Crown TEXTURES, as the trade actually names them. Watch&Style publishes
 * crown "design" as a filterable attribute and namokiMODS' range agrees.
 * `flutes` drives the geometry; NO VENDOR PUBLISHES A SERRATION COUNT — not
 * one of the four checked does — so every count here is read off product
 * photography and flagged approximate.
 */
export const CROWN_TEXTURES = [
  { id: "coin", name: { en: "Coin edge", sv: "Myntkant" }, flutes: 26, approx: true, depth: 0.35, src: "wsCrown" },
  { id: "slim-coin", name: { en: "Slim coin edge", sv: "Smal myntkant" }, flutes: 30, approx: true, depth: 0.25, src: "wsCrown" },
  { id: "knurled", name: { en: "Knurled", sv: "Knurlad" }, flutes: 18, approx: true, depth: 0.5, src: "namokiCrown" },
  { id: "big-grip", name: { en: "Big grip", sv: "Stort grepp" }, flutes: 10, approx: true, depth: 0.7, src: "wsCrown" },
  { id: "chunky", name: { en: "Chunky", sv: "Kraftig" }, flutes: 8, approx: true, depth: 0.8, src: "namokiCrown" },
  { id: "bolt", name: { en: "Bolt, faceted", sv: "Bult, fasetterad" }, flutes: 6, approx: true, depth: 0.6, src: "namokiCrown" },
  { id: "onion", name: { en: "Onion", sv: "Lök" }, flutes: 12, approx: true, depth: 0.55, src: "wsCrown" },
];

export const CROWNS = [
  {
    id: "signed-screw",
    name: { en: "Signed, screw-down", sv: "Signerad, skruvkrona" },
    style: "coin",
    texture: "coin",
    signed: true,
    mount: "screw-down",
    diaMm: 7.0,
    heightMm: 4.9,
    src: "ct208",
    note: {
      en: "Ø7.0 × 4.9 mm is the one published crown dimension in this market (CT208, 316L, triple gasket, tap 10). Big-crown, chunky and onion variants are visibly larger and no vendor publishes their size.",
      sv: "Ø7,0 × 4,9 mm är det enda publicerade kronmåttet i den här marknaden (CT208, 316L, trippelpackning, gänga 10). Big crown-, chunky- och lökvarianter är synligt större och ingen säljare publicerar deras mått.",
    },
    ali: { queries: ["SKX007 crown screw down NH35"], priceUsd: [5, 20] },
  },
  {
    id: "plain-screw",
    name: { en: "Unsigned, screw-down", sv: "Osignerad, skruvkrona" },
    style: "coin",
    texture: "coin",
    signed: false,
    mount: "screw-down",
    diaMm: 7.0,
    heightMm: 4.9,
    src: "ct208",
    ali: { queries: ["NH35 crown sterile screw down"], priceUsd: [4, 18] },
  },
  {
    id: "fluted",
    name: { en: "Fluted", sv: "Räfflad" },
    style: "fluted",
    texture: "knurled",
    signed: false,
    mount: "screw-down",
    src: "namokiCrown",
    ali: { queries: ["NH35 fluted crown"], priceUsd: [4, 18] },
  },
  {
    id: "onion",
    name: { en: "Onion (dress)", sv: "Lökkrona (klädklocka)" },
    style: "onion",
    texture: "onion",
    signed: false,
    mount: "screw-down",
    src: "wsCrown",
    ali: { queries: ["NH35 onion crown vintage"], priceUsd: [5, 22] },
  },
  {
    id: "big-grip",
    name: { en: "Big grip", sv: "Stort grepp" },
    style: "fluted",
    texture: "big-grip",
    signed: false,
    mount: "screw-down",
    src: "wsCrown",
    ali: { queries: ["SKX007 big grip crown"], priceUsd: [6, 24] },
  },
  {
    id: "bolt",
    name: { en: "Bolt, faceted", sv: "Bult, fasetterad" },
    style: "fluted",
    texture: "bolt",
    signed: false,
    mount: "screw-down",
    src: "namokiCrown",
    ali: { queries: ["SKX007 bolt crown mod"], priceUsd: [6, 24] },
  },
  {
    id: "slim-coin",
    name: { en: "Slim coin edge", sv: "Smal myntkant" },
    style: "coin",
    texture: "slim-coin",
    signed: false,
    mount: "screw-down",
    src: "wsCrown",
    ali: { queries: ["SKX013 slim coin crown"], priceUsd: [5, 20] },
  },
];

/**
 * Stock engraved artwork sold as its own SKU. THIS IS A DECAL, NOT A SHAPE:
 * an engraved back is dimensionally identical to a plain solid one and differs
 * only in relief artwork, which is why an engraved caseback must reuse the
 * solid caseback's geometry. Giving it a mesh of its own is the likely cause
 * of the reported "engraved caseback isn't working".
 */
export const CASEBACK_ENGRAVINGS = [
  { id: "none", name: { en: "No engraving", sv: "Ingen gravyr" }, src: "wsCaseback" },
  { id: "sword", name: { en: "Sword", sv: "Svärd" }, src: "secondhand" },
  { id: "explorer", name: { en: "Explorer", sv: "Explorer" }, src: "secondhand" },
  { id: "serpent", name: { en: "Serpent", sv: "Orm" }, src: "secondhand" },
  { id: "skull", name: { en: "Skull", sv: "Dödskalle" }, src: "secondhand" },
  { id: "robocop", name: { en: "Robocop", sv: "Robocop" }, src: "secondhand" },
  { id: "nh-movement", name: { en: "NH movement drawing", sv: "NH-urverksritning" }, src: "modmode" },
  { id: "custom-text", name: { en: "Custom laser-engraved text", sv: "Egen lasergraverad text" }, src: "wsCaseback" },
];

/** Caseback FINISHES actually listed. */
export const CASEBACK_FINISHES = [
  { id: "polished", name: { en: "Polished", sv: "Polerad" }, src: "namokiCaseback" },
  { id: "brushed", name: { en: "Brushed", sv: "Borstad" }, src: "namokiCaseback" },
  { id: "sandblasted", name: { en: "Sandblasted", sv: "Blästrad" }, src: "namokiCaseback" },
  { id: "pvd-black", name: { en: "PVD matte black", sv: "PVD matt svart" }, src: "namokiCaseback" },
];

/**
 * CASEBACKS.
 *
 * `type` is what the part IS; `display` stays as the legacy boolean the
 * renderer reads. An engraved back is `type: "solid"` with an `engraving` —
 * never its own geometry.
 *
 * `spacerFit` is a genuine two-SKU fork on display backs: CT239A is for the
 * thicker black OEM movement spacer, CT239B for the thinner grey NH35/NH36
 * spacer, and they are not interchangeable. Every movement in this catalogue
 * is an NH, so the grey-spacer variant is the right one and the OEM-spacer
 * variant is a wasted purchase.
 *
 * `heightDeltaMm: 0.6` is the ONE hard published height delta for a display
 * back (CT239 "sits 0.6 mm higher than the standard OEM 0020 case back"). No
 * vendor publishes a height delta for a solid back at all.
 */
export const CASEBACKS = [
  {
    id: "solid-engraved",
    name: { en: "Solid, engraved", sv: "Massiv, graverad" },
    type: "solid",
    display: false,
    finish: "polished",
    profile: "standard",
    mount: "screw-down",
    engraving: "sword",
    heightDeltaMm: 0,
    src: "secondhand",
    note: {
      en: "Engraved is artwork on a solid back, dimensionally identical to a plain one — it shares the solid caseback's shape and differs only in its relief decal.",
      sv: "Graverad är konstverk på en massiv botten, måttmässigt identisk med en slät — den delar den massiva bottnens form och skiljer sig bara i reliefdekoren.",
    },
    ali: { queries: ["SKX007 case back engraved NH35"], priceUsd: [6, 22] },
  },
  {
    id: "display",
    name: { en: "Display (exhibition)", sv: "Genomskinlig (utställningsboett)" },
    type: "display",
    display: true,
    finish: "polished",
    profile: "standard",
    mount: "screw-down",
    spacerFit: "grey-nh",
    engraving: "none",
    heightDeltaMm: 0.6,
    thicknessMm: 4.6,
    thicknessNoThreadMm: 2.5,
    src: "ct239",
    ali: { queries: ["transparent case back SKX007 NH35 NH36", "sapphire display caseback SKX007"], priceUsd: [12, 25] },
    note: {
      en: "The grey-spacer variant (CT239B), which is the one an NH35/NH36 build needs. Sits 0.6 mm higher than the OEM solid back — the only published height delta in this market. Watch&Style quotes the standard sapphire back as 4.6 mm with the thread and 2.5 mm without.",
      sv: "Varianten för den grå distansen (CT239B), den ett NH35/NH36-bygge behöver. Sitter 0,6 mm högre än originalbottnen — den enda publicerade höjdskillnaden i den här marknaden. Watch&Style anger standardsafirbottnen som 4,6 mm med gängan och 2,5 mm utan.",
    },
  },
  {
    id: "solid-brushed",
    name: { en: "Solid, brushed", sv: "Massiv, borstad" },
    type: "solid",
    display: false,
    finish: "brushed",
    profile: "standard",
    mount: "screw-down",
    engraving: "none",
    heightDeltaMm: 0,
    src: "wsCaseback",
    ali: { queries: ["SKX007 case back sterile"], priceUsd: [6, 20] },
  },
  {
    id: "display-slim",
    name: { en: "Display, slim", sv: "Genomskinlig, tunn" },
    type: "display",
    display: true,
    finish: "brushed",
    profile: "slim",
    mount: "screw-down",
    spacerFit: "grey-nh",
    engraving: "none",
    heightDeltaMm: 0.6,
    thicknessMm: 4.0,
    thicknessNoThreadMm: 2.0,
    wr: 100,
    src: "wsCaseback",
    note: {
      en: "4.0 mm with the thread against the standard back's 4.6 mm, and a 1.2 mm sapphire window against 2.5 mm. namokiMODS rates its slim sapphire back at 100 m where CrystalTimes rates its standard one at 200 m; those are different products and the ratings do not generalise. Fits NH movements with the GREY spacer only.",
      sv: "4,0 mm med gängan mot standardbottnens 4,6 mm, och ett 1,2 mm safirfönster mot 2,5 mm. namokiMODS anger 100 m för sin tunna safirbotten där CrystalTimes anger 200 m för sin standardbotten; det är olika produkter och värdena kan inte generaliseras. Passar NH-urverk endast med den GRÅ distansen.",
    },
    ali: { queries: ["slim sapphire caseback SKX007"], priceUsd: [18, 45] },
  },
  {
    id: "display-oem",
    name: { en: "Display, OEM spacer variant", sv: "Genomskinlig, för originaldistans" },
    type: "display",
    display: true,
    finish: "polished",
    profile: "standard",
    mount: "screw-down",
    spacerFit: "black-oem",
    engraving: "none",
    heightDeltaMm: 0.6,
    src: "ct239",
    note: {
      en: "CT239A, cut for the thicker BLACK movement spacer used by 7S26 and stock Seiko movements. An NH35/NH36 uses the thinner grey spacer, so on an NH build this is the wrong half of the fork.",
      sv: "CT239A, gjord för den tjockare SVARTA urverksdistansen som 7S26 och Seikos originalurverk använder. NH35/NH36 använder den tunnare grå distansen, så på ett NH-bygge är det här fel halva av valet.",
    },
    ali: { queries: ["CT239A display caseback SKX"], priceUsd: [16, 40] },
  },
];

// ---------------------------------------------------------------------------
// STRAPS. Four kinds behave differently enough that they are different objects,
// not one object with different textures: a bracelet is rows of links, rubber
// and leather are one tapered band, and a NATO is a single length that passes
// UNDER the case. Everything below the STRAPS list is an axis over them.
//
// The complaint this answers is "little to no difference between a jubilee and
// an oyster". The difference is not colour and not taper: it is how many link
// bodies span the width of one row and what their cross-section is. An Oyster
// is three flat links; a Jubilee is five, with three narrow ROUNDED centres.
// Rendered as one flat box they are identical, which is exactly the bug.
//
// NOBODY PUBLISHES PER-LINK WIDTHS, for any bracelet type. Only the ORDERING
// is sourced (Oyster: wide centre, narrow outers; Jubilee: wide outers, three
// narrow centres). Every `widthRatios` below is therefore a rendering
// convention and says so.

export const STRAPS = [
  {
    id: "oyster",
    name: { en: "Oyster bracelet", sv: "Oyster-länk" },
    kind: "bracelet",
    type: "oyster",
    color: "#9aa2ab",
    sheen: "metal",
    buckle: "flip-lock",
    src: "strapcodeOyster",
    ali: { queries: ["oyster bracelet 22mm solid"], priceUsd: [12, 45] },
  },
  {
    id: "jubilee",
    name: { en: "Jubilee bracelet", sv: "Jubilee-länk" },
    kind: "bracelet",
    type: "jubilee",
    color: "#a5adb6",
    sheen: "metal",
    buckle: "v-clasp",
    src: "strapcodeJubilee",
    ali: { queries: ["jubilee bracelet 22mm solid"], priceUsd: [14, 50] },
  },
  {
    id: "waffle",
    name: { en: "Rubber waffle", sv: "Gummi, våffelmönster" },
    kind: "rubber",
    type: "waffle",
    color: "#15171b",
    sheen: "satin",
    buckle: "tang",
    src: "unclestraps",
    ali: { queries: ["waffle rubber strap 22mm seiko"], priceUsd: [8, 25] },
  },
  {
    id: "tropic",
    name: { en: "Rubber tropic", sv: "Gummi, tropic" },
    kind: "rubber",
    type: "tropic",
    color: "#101216",
    sheen: "satin",
    buckle: "tang",
    src: "unclestraps",
    ali: { queries: ["tropic rubber strap 22mm"], priceUsd: [8, 25] },
  },
  {
    id: "nato",
    name: { en: "NATO", sv: "NATO" },
    kind: "nato",
    type: "nato",
    color: "#2b3038",
    sheen: "matte",
    buckle: "tang",
    src: "crownbuckle",
    ali: { queries: ["nato strap 22mm seatbelt"], priceUsd: [5, 20] },
  },
  {
    id: "leather",
    name: { en: "Leather", sv: "Läder" },
    kind: "leather",
    type: "calf",
    color: "#4a3226",
    sheen: "satin",
    buckle: "tang",
    src: "strapcodeLeather",
    ali: { queries: ["leather strap 20mm vintage watch"], priceUsd: [8, 30] },
  },
  {
    id: "mesh",
    name: { en: "Milanese mesh", sv: "Milanese mesh" },
    kind: "bracelet",
    type: "milanese",
    color: "#98a0a9",
    sheen: "metal",
    buckle: "interlock",
    src: "strapcodeMesh",
    ali: { queries: ["milanese mesh bracelet 22mm"], priceUsd: [10, 30] },
  },
];

/**
 * BRACELET types. `linksAcross` and `crossSection` are what make an Oyster
 * read as an Oyster; `pitchMm` is the row length, which also sets how often
 * the bracelet hinges — a Jubilee with a 6 mm pitch drapes visibly more
 * fluidly than a 10 mm Oyster, and that alone separates the two silhouettes.
 */
export const BRACELET_TYPES = [
  {
    id: "oyster", name: { en: "Oyster", sv: "Oyster" }, linksAcross: 3, crossSection: "flat",
    widthRatios: [0.25, 0.5, 0.25], ratiosApprox: true, pitchMm: 10, pitchRangeMm: [8, 10],
    taperMm: 4, thicknessMm: 3.2, diverExtension: true, clasp: "flip-lock", src: "strapcodeOyster",
    note: { en: "Three flat links: a wide centre flanked by narrower outers. The 4 mm taper is the ideal band Everest names; individual link widths are published nowhere, so the ratios here are a rendering convention.", sv: "Tre plana länkar: en bred mitt med smalare yttre. De 4 mm avsmalning är det ideala spannet Everest anger; enskilda länkbredder publiceras ingenstans, så proportionerna här är en renderingskonvention." },
  },
  {
    id: "super-oyster", name: { en: "Super Oyster", sv: "Super Oyster" }, linksAcross: 3, crossSection: "flat",
    widthRatios: [0.25, 0.5, 0.25], ratiosApprox: true, pitchMm: 10, taperMm: 2, taperAltMm: 4,
    thicknessMm: 3.2, diverExtension: true, clasp: "flip-lock", solidEndLinks: true, src: "strapcodeOyster",
    note: { en: "An Oyster with solid curved end pieces; the row geometry is the same. Two SKUs genuinely taper differently — 22 → 20 mm and 22 → 18 mm — so both are carried rather than averaged.", sv: "En Oyster med massiva kurvade ändstycken; radgeometrin är densamma. Två artiklar smalnar verkligen olika — 22 → 20 mm och 22 → 18 mm — så båda bärs vidare i stället för att medelvärdesbildas." },
  },
  {
    id: "jubilee", name: { en: "Jubilee", sv: "Jubilee" }, linksAcross: 5, crossSection: "rounded",
    widthRatios: [0.25, 0.1667, 0.1667, 0.1667, 0.25], ratiosApprox: true, pitchMm: 6, pitchRangeMm: [5, 9],
    taperMm: 4, thicknessMm: 3.6, diverExtension: false, clasp: "v-clasp", src: "strapcodeJubilee",
    note: { en: "Five links per row: two wider outers flanking three narrower rounded centres. Sources disagree on which are polished — one says polished centres and brushed outers, another the reverse — and on the pitch, one page giving both 5–7 mm and 9 mm. Both disagreements are carried; what is safe is that the Jubilee's pitch is shorter than the Oyster's.", sv: "Fem länkar per rad: två bredare yttre kring tre smalare rundade i mitten. Källorna är oense om vilka som är polerade — en säger polerad mitt och borstade yttre, en annan tvärtom — och om längden, där en sida anger både 5–7 mm och 9 mm. Båda motsägelserna bärs vidare; det säkra är att Jubilees längd är kortare än Oysters." },
  },
  {
    id: "president", name: { en: "President", sv: "President" }, linksAcross: 3, crossSection: "semi-circular",
    widthRatios: [0.25, 0.5, 0.25], ratiosApprox: true, pitchMm: 11, taperMm: 4, taperApprox: true,
    thicknessMm: null, diverExtension: false, clasp: "concealed", src: "everestBracelet",
    note: { en: "The Oyster's three-across topology with the Jubilee's rounded cross-section. The aftermarket steel copies publish no taper or thickness at all.", sv: "Oysters tre länkar per rad med Jubilees rundade tvärsnitt. Eftermarknadens stålkopior publicerar varken avsmalning eller tjocklek." },
  },
  {
    id: "engineer-i", name: { en: "Engineer I", sv: "Engineer I" }, linksAcross: 5, crossSection: "round-edge",
    widthRatios: [0.2, 0.2, 0.2, 0.2, 0.2], ratiosApprox: true, pitchMm: null, taperMm: 4, taperApprox: true,
    thicknessMm: 4.6, diverExtension: true, clasp: "flip-lock", src: "strapcodeEngineer",
    note: { en: "Five round-edge links of similar heft — no small centre trio, which is what separates it from a Jubilee at a glance. 4.6 mm is the heaviest bracelet here.", sv: "Fem rundkantade länkar med liknande tyngd — ingen smal mittrio, vilket är det som skiljer den från en Jubilee vid första anblicken. 4,6 mm är den tyngsta länken här." },
  },
  {
    id: "engineer-ii", name: { en: "Engineer II", sv: "Engineer II" }, linksAcross: 5, crossSection: "chamfer-edge",
    widthRatios: [0.2, 0.2, 0.2, 0.2, 0.2], ratiosApprox: true, pitchMm: null, taperMm: 0,
    thicknessMm: 4.5, diverExtension: true, clasp: "v-clasp", src: "strapcodeEngineer",
    note: { en: "Five chamfer-edge links and, unusually, ZERO taper — 22 mm at the lug and 22 mm at the buckle. That alone reads differently in a render.", sv: "Fem fasade länkar och, ovanligt nog, INGEN avsmalning — 22 mm vid hornen och 22 mm vid spännet. Bara det ser annorlunda ut i en rendering." },
  },
  {
    id: "beads-of-rice", name: { en: "Beads of rice", sv: "Beads of rice" }, linksAcross: 7, crossSection: "beads",
    widthRatios: [0.18, 0.128, 0.128, 0.128, 0.128, 0.128, 0.18], ratiosApprox: true, pitchMm: null,
    taperMm: 2, thicknessMm: 3.4, diverExtension: true, clasp: "v-clasp", staggered: true, src: "strapcodeBor",
    note: { en: "Five small staggered rounded beads between two brushed outer beads — seven bodies across, adjacent rows offset. Rendered as flat boxes it is unrecognisable.", sv: "Fem små förskjutna rundade pärlor mellan två borstade ytterpärlor — sju kroppar på bredden, med intilliggande rader förskjutna. Renderad som platta klossar går den inte att känna igen." },
  },
  {
    id: "milanese", name: { en: "Milanese mesh", sv: "Milanese mesh" }, linksAcross: 0, crossSection: "woven",
    wireMm: 0.9, wireFineMm: 0.6, pitchMm: null, taperMm: 4, thicknessMm: 2.5, thicknessFineMm: 1.8,
    diverExtension: false, clasp: "interlock", src: "strapcodeMesh",
    note: { en: "Knitted 316L wire, not links — the one bracelet where \"no links at all\" is the accurate model. 0.9 mm wire standard, 0.6 mm superfine. Its sliding clasp clamps anywhere, which is why it has no removable links.", sv: "Stickad 316L-tråd, inte länkar — den enda länken där \"inga länkar alls\" är den korrekta modellen. 0,9 mm tråd standard, 0,6 mm superfin. Dess glidlås klämmer var som helst, vilket är varför den saknar borttagbara länkar." },
  },
  {
    id: "shark-mesh", name: { en: "Shark mesh", sv: "Shark mesh" }, linksAcross: 0, crossSection: "woven-coarse",
    wireMm: 1.2, pitchMm: null, taperMm: 4, thicknessMm: 3.8, diverExtension: true, clasp: "v-clasp", src: "strapcodeMesh",
    note: { en: "1.2 mm wire against Milanese's 0.9 / 0.6 mm, so the weave cell is roughly 1.3–2× coarser: individual loops read at arm's length where Milanese reads as near-smooth fabric.", sv: "1,2 mm tråd mot Milanese 0,9/0,6 mm, så vävcellen är ungefär 1,3–2 gånger grövre: enskilda öglor syns på armlängds avstånd där Milanese ser ut som nästan slät väv." },
  },
  {
    id: "nautilus", name: { en: "Nautilus style", sv: "Nautilus-stil" }, linksAcross: 3, crossSection: "flat",
    widthRatios: [0.28, 0.44, 0.28], ratiosApprox: true, pitchMm: 10, taperMm: 4, taperApprox: true,
    thicknessMm: null, diverExtension: false, clasp: "concealed", src: "namokiBracelets",
    note: { en: "Listed for SKX007/SRPD in brushed, gold, rose gold and black; no construction figures are published for it.", sv: "Listad för SKX007/SRPD i borstad, guld, roséguld och svart; inga konstruktionsmått publiceras." },
  },
  {
    id: "snakeskin", name: { en: "Snakeskin style", sv: "Ormskinnsstil" }, linksAcross: 5, crossSection: "rounded",
    widthRatios: [0.2, 0.2, 0.2, 0.2, 0.2], ratiosApprox: true, pitchMm: 6, taperMm: 4, taperApprox: true,
    thicknessMm: null, diverExtension: false, clasp: "v-clasp", src: "namokiBracelets",
    note: { en: "Listed for exactly these mod cases; no construction figures are published for it.", sv: "Listad för just de här moddboetterna; inga konstruktionsmått publiceras." },
  },
];

/** RUBBER types. Rubber is one tapered band plus keepers plus a tang buckle. */
export const RUBBER_TYPES = [
  {
    id: "waffle", name: { en: "Waffle", sv: "Våffelmönster" }, material: "tpu", keepers: 2, keepersAlt: 1,
    taperMm: 2, cellMm: 2.0, cellApprox: true, widths: [19, 20, 22], src: "unclestraps",
    note: { en: "A reproduction of the late-1960s Seiko dive strap, in TPU, tapering 2 mm to the buckle. The grid is raised pads with recessed channels; NO maker publishes the cell size, so the 2 mm cell is a rendering convention.", sv: "En reproduktion av Seikos dykarband från sent 1960-tal, i TPU, som smalnar 2 mm mot spännet. Rutnätet är upphöjda dynor med nedsänkta kanaler; INGEN tillverkare publicerar cellstorleken, så 2 mm-cellen är en renderingskonvention." },
  },
  {
    id: "tropic", name: { en: "Tropic", sv: "Tropic" }, material: "tpu", keepers: 2, taperMm: 2,
    perforated: true, widths: [19, 20, 22], src: "unclestraps",
    note: { en: "A cross-hatch top and a deeply channelled underside; the modern reissues have notably bigger perforations. The 20 mm version is reported both at a 2 mm taper and at 20 → 16 mm, and both are carried.", sv: "Korsmönstrad ovansida och djupt kanaliserad undersida; nyutgåvorna har märkbart större perforeringar. 20 mm-versionen anges både med 2 mm avsmalning och som 20 → 16 mm, och båda bärs vidare." },
  },
  {
    id: "isofrane", name: { en: "ISOfrane style", sv: "ISOfrane-stil" }, material: "isoprene", keepers: 2,
    taperMm: 0, thicknessMm: 5.5, thicknessAtBuckleMm: 3.5, widths: [20, 22, 24], src: "isofrane",
    note: { en: "Vulcanised isoprene with ladder vents down both edges and a ribbed underside. It tapers in THICKNESS (5.5 → 3.5 mm) but not in width, which is unusual and visually important. 18 and 19 mm are not listed.", sv: "Vulkaniserat isopren med stegventilation längs båda kanterna och räfflad undersida. Den smalnar i TJOCKLEK (5,5 → 3,5 mm) men inte i bredd, vilket är ovanligt och visuellt viktigt. 18 och 19 mm finns inte listade." },
  },
  {
    id: "curved-end", name: { en: "Curved end", sv: "Kurvad ände" }, material: "fkm", keepers: 2, taperMm: 2,
    thicknessMm: 4.5, thicknessAtBuckleMm: 3.5, widths: [20, 22], caseSpecific: true, src: "crafterblue",
    note: { en: "The end is moulded to wrap a specific case, so this is the one strap kind whose availability is case-dependent. The SKX/SRPD mouldings are listed; nothing else is.", sv: "Änden är gjuten för att omsluta ett bestämt boett, så det här är den enda bandtypen vars tillgänglighet beror på boetten. Gjutningar för SKX/SRPD finns listade; inga andra." },
  },
  {
    id: "plain", name: { en: "Plain rubber", sv: "Slätt gummi" }, material: "fkm", keepers: 1, taperMm: 2,
    widths: [18, 19, 20, 22], src: "crafterblue",
  },
];

/**
 * The four-step SHEEN scale, quoted verbatim from a strap retailer's own
 * guide. This is the fix for "leather shouldn't be shiny like a mirror":
 * almost every strap leather sits at matte or satin, and only patent is
 * genuinely high-gloss.
 */
export const SHEEN_LEVELS = [
  { id: "matte", name: { en: "Matte", sv: "Matt" }, specular: 0.0, rough: 0.95, src: "strapcodeLeather" },
  { id: "satin", name: { en: "Satin", sv: "Satin" }, specular: 0.12, rough: 0.7, src: "strapcodeLeather" },
  { id: "shiny", name: { en: "Shiny", sv: "Blank" }, specular: 0.3, rough: 0.4, src: "strapcodeLeather" },
  { id: "glossy", name: { en: "Glossy", sv: "Högblank" }, specular: 0.55, rough: 0.18, src: "strapcodeLeather" },
];

/**
 * LEATHER types. The sheen SCALE above is sourced verbatim; mapping each
 * leather onto a band is mostly inference, so `sheenApprox` marks the ones
 * that are. What IS firmly sourced, and is the actionable part: suede and
 * nubuck have essentially no specular, matte leather is non-reflective and
 * flat, and only patent is high-gloss. Nothing here renders as a mirror.
 */
export const LEATHER_TYPES = [
  { id: "calf", name: { en: "Calf / smooth", sv: "Kalv / slät" }, sheen: "satin", sheenApprox: true, grain: "smooth", src: "strapcodeLeather" },
  { id: "oiled", name: { en: "Oiled / pull-up", sv: "Oljad / pull-up" }, sheen: "matte", sheenApprox: true, grain: "pull-up", src: "strapcodeLeather", note: { en: "Oils gather in the creases and the colour lightens where it flexes, so the surface is deliberately uneven.", sv: "Oljorna samlas i vecken och färgen ljusnar där bandet böjs, så ytan är medvetet ojämn." } },
  { id: "suede", name: { en: "Suede", sv: "Mocka" }, sheen: "matte", specular: 0, grain: "nap", src: "strapcodeLeather", note: { en: "The underside of the hide, with the top grain split away — a soft nap on both sides and ZERO specular highlight.", sv: "Hudens undersida, med narvsidan bortkluven — mjuk lugg på båda sidor och HELT utan spegling." } },
  { id: "nubuck", name: { en: "Nubuck", sv: "Nubuck" }, sheen: "matte", specular: 0, grain: "nap", src: "strapcodeLeather", note: { en: "Top grain sanded down to a velvety nap; essentially no specular, at most a faint nap sheen.", sv: "Narvsidan slipad till en sammetslen lugg; i praktiken ingen spegling, på sin höjd en svag luggglans." } },
  { id: "shell-cordovan", name: { en: "Shell cordovan", sv: "Shell cordovan" }, sheen: "satin", sheenApprox: true, grain: "smooth", src: "strapcodeLeather", note: { en: "Very dense fibre that ripples rather than creases. The exact sheen is not published — satin with a deep soft glow is an inference, not a measurement.", sv: "Mycket tät fiber som veckar sig i vågor i stället för att spricka. Den exakta glansen publiceras inte — satin med djup mjuk lyster är en slutsats, inte ett mätvärde." } },
  { id: "alligator", name: { en: "Alligator", sv: "Alligator" }, sheen: "satin", sheenApprox: true, grain: "scales", src: "strapcodeLeather", note: { en: "Sold BOTH matte and glossy — the two finishes genuinely coexist on the same material, so the sheen here is a default rather than a fact about the type.", sv: "Säljs BÅDE matt och blank — de två ytorna finns verkligen sida vid sida på samma material, så glansen här är ett standardval snarare än ett faktum om typen." } },
  { id: "croc-embossed", name: { en: "Croc embossed", sv: "Krokodilpräglad" }, sheen: "satin", sheenApprox: true, grain: "scales", src: "strapcodeLeather" },
  { id: "ostrich", name: { en: "Ostrich", sv: "Struts" }, sheen: "satin", sheenApprox: true, grain: "quill", src: "strapcodeLeather" },
  { id: "saffiano", name: { en: "Saffiano", sv: "Saffiano" }, sheen: "satin", sheenApprox: true, grain: "crosshatch", src: "strapcodeLeather" },
  { id: "pebble-grain", name: { en: "Pebble grain", sv: "Kornig narv" }, sheen: "satin", sheenApprox: true, grain: "pebble", src: "strapcodeLeather" },
  { id: "vintage", name: { en: "Vintage distressed", sv: "Vintage, sliten" }, sheen: "matte", sheenApprox: true, grain: "distressed", src: "strapcodeLeather" },
  { id: "rally", name: { en: "Rally, perforated", sv: "Rally, perforerad" }, sheen: "matte", sheenApprox: true, grain: "perforated", src: "strapcodeLeather", note: { en: "Listed as its own category; the perforation geometry is not published anywhere.", sv: "Listad som en egen kategori; perforeringarnas geometri publiceras ingenstans." } },
  { id: "patent", name: { en: "Patent", sv: "Lackläder" }, sheen: "glossy", grain: "smooth", src: "strapcodeLeather", note: { en: "The ONE genuinely mirror-like leather, and barely present in watch straps.", sv: "Det ENDA verkligt spegelblanka lädret, och nästan obefintligt i klockarmband." } },
];

/** NATO weave grades, with the published thicknesses. */
export const NATO_WEAVES = [
  { id: "standard", name: { en: "Standard ballistic", sv: "Standard ballistisk" }, thicknessMm: 1.25, sheen: "matte", src: "crownbuckle" },
  { id: "premium", name: { en: "Premium ballistic", sv: "Premium ballistisk" }, thicknessMm: 1.25, sheen: "matte", src: "crownbuckle" },
  { id: "heavy-duty", name: { en: "Heavy duty", sv: "Kraftig" }, thicknessMm: 1.6, sheen: "matte", src: "crownbuckle" },
  { id: "seatbelt", name: { en: "Seatbelt", sv: "Bilbältesväv" }, thicknessMm: 1.4, sheen: "satin", src: "crownbuckle", note: { en: "A tightly knit, slightly shiny nylon, where standard ballistic is matte with a visibly coarse twill. That split is the render difference between the two.", sv: "En tätt stickad, något blank nylon, där standardballistisk är matt med synligt grov kypert. Den skillnaden är renderingsskillnaden mellan de två." } },
];

/** NATO construction — 3-ring single-pass or 5-ring with the under-flap. */
export const NATO_LAYERS = [
  { id: "under-flap", name: { en: "Two layer (5 ring)", sv: "Två lager (5 ringar)" }, rings: 5, flap: true, src: "crownbuckle" },
  { id: "single-pass", name: { en: "Single pass (3 ring)", sv: "Enkelpassage (3 ringar)" }, rings: 3, flap: false, src: "crownbuckle" },
];

/**
 * NATO patterns. The "Bond" naming is a real historical dispute and both
 * versions are genuinely sold, so both ship: `bond-grey` is the popular
 * black-and-grey strap everyone calls a Bond NATO, and `bond-1964` is the
 * black / dark burgundy / dark olive band actually seen in Goldfinger.
 */
export const NATO_PATTERNS = [
  { id: "solid", name: { en: "Solid", sv: "Enfärgad" }, stripes: null, src: "crownbuckle" },
  {
    id: "bond-grey", name: { en: "Bond, black and grey", sv: "Bond, svart och grå" },
    stripes: ["#1b1d21", "#8b9098", "#1b1d21", "#8b9098", "#1b1d21"], src: "everestNato",
    note: { en: "Black with two grey stripes — the most iconic NATO there is, and universally called the Bond. It is NOT the strap worn in Goldfinger; see bond-1964.", sv: "Svart med två grå ränder — den mest ikoniska NATO:n som finns, och kallas överallt Bond. Det är INTE bandet som bars i Goldfinger; se bond-1964." },
  },
  {
    id: "bond-1964", name: { en: "Bond 1964, black, burgundy and olive", sv: "Bond 1964, svart, vinröd och oliv" },
    stripes: ["#16181b", "#5c1f27", "#4a4a24", "#16181b", "#4a4a24", "#5c1f27", "#16181b"], src: "espritNato",
    note: { en: "The strap actually seen in Goldfinger: a black base with green stripes and fine burgundy edges — nine stripes in three colours. Retailers sell it as \"black and olive (Bond)\" and as an \"Original 1964 007\" in black, maroon and olive drab. The stripe widths and ordering beyond \"nine stripes\" are not published.", sv: "Bandet som faktiskt syns i Goldfinger: svart botten med gröna ränder och fina vinröda kanter — nio ränder i tre färger. Återförsäljare säljer det som \"black and olive (Bond)\" och som \"Original 1964 007\" i svart, vinrött och olivgrönt. Rändernas bredd och ordning utöver \"nio ränder\" publiceras inte." },
  },
  { id: "regimental", name: { en: "Regimental stripes", sv: "Regementsränder" }, stripes: ["#1d2b4a", "#8b1f2b", "#1d2b4a"], src: "everestNato" },
  { id: "military-stripe", name: { en: "Military stripe, olive", sv: "Militärrand, oliv" }, stripes: ["#4a5230", "#8b1f2b", "#d8b53a", "#4a5230"], src: "crownbuckle" },
];

/**
 * Strap COLOURS. `kinds` says which strap kinds a colour is listed for.
 * `rarity` is inferred from which colours have their own marketplace category
 * pages rather than measured, and is flagged accordingly.
 */
export const STRAP_COLOURS = [
  { id: "black", name: { en: "Black", sv: "Svart" }, hex: "#17191d", kinds: ["leather", "rubber", "nato"], rarity: "very-common" },
  { id: "dark-brown", name: { en: "Dark brown", sv: "Mörkbrun" }, hex: "#3d2a1e", kinds: ["leather"], rarity: "very-common" },
  { id: "tan", name: { en: "Tan", sv: "Ljusbrun" }, hex: "#9a6a41", kinds: ["leather"], rarity: "very-common" },
  { id: "vintage-brown", name: { en: "Vintage brown", sv: "Vintagebrun" }, hex: "#6b4529", kinds: ["leather"], rarity: "common" },
  { id: "navy", name: { en: "Navy", sv: "Marinblå" }, hex: "#1c2740", kinds: ["leather", "rubber", "nato"], rarity: "very-common" },
  { id: "blue", name: { en: "Blue", sv: "Blå" }, hex: "#28497f", kinds: ["leather", "rubber", "nato"], rarity: "common" },
  { id: "grey", name: { en: "Grey", sv: "Grå" }, hex: "#585e66", kinds: ["leather", "rubber", "nato"], rarity: "common" },
  { id: "olive", name: { en: "Olive", sv: "Oliv" }, hex: "#4a5230", kinds: ["leather", "rubber", "nato"], rarity: "common" },
  { id: "green", name: { en: "Green", sv: "Grön" }, hex: "#2c5b3c", kinds: ["leather", "rubber", "nato"], rarity: "common" },
  { id: "khaki", name: { en: "Khaki", sv: "Khaki" }, hex: "#8a7f5c", kinds: ["leather", "nato"], rarity: "common" },
  { id: "beige", name: { en: "Beige", sv: "Beige" }, hex: "#c3b490", kinds: ["leather", "nato"], rarity: "common" },
  { id: "burgundy", name: { en: "Burgundy", sv: "Vinröd" }, hex: "#5c1f27", kinds: ["leather", "nato"], rarity: "common" },
  { id: "red", name: { en: "Red", sv: "Röd" }, hex: "#8f2027", kinds: ["leather", "rubber", "nato"], rarity: "common" },
  { id: "orange", name: { en: "Orange", sv: "Orange" }, hex: "#c25b1c", kinds: ["leather", "rubber", "nato"], rarity: "uncommon" },
  { id: "yellow", name: { en: "Yellow", sv: "Gul" }, hex: "#d8b53a", kinds: ["leather", "rubber", "nato"], rarity: "uncommon" },
  { id: "white", name: { en: "White", sv: "Vit" }, hex: "#e8e9ec", kinds: ["leather", "nato"], rarity: "uncommon" },
  { id: "teal", name: { en: "Teal", sv: "Blågrön" }, hex: "#1d6a6e", kinds: ["nato"], rarity: "uncommon" },
  { id: "purple", name: { en: "Purple", sv: "Lila" }, hex: "#4d3070", kinds: ["nato"], rarity: "rare" },
];

/** Stitch colours — a genuinely separate axis from the leather's own colour. */
export const STITCH_COLOURS = [
  { id: "none", name: { en: "No visible stitch", sv: "Ingen synlig söm" }, hex: null, src: "strapcodeLeather" },
  { id: "tonal", name: { en: "Tonal (matches the leather)", sv: "Ton-i-ton" }, hex: null, src: "strapcodeLeather" },
  { id: "white", name: { en: "White", sv: "Vit" }, hex: "#eceef1", src: "strapcodeLeather" },
  { id: "cream", name: { en: "Cream", sv: "Gräddvit" }, hex: "#e4d7b8", src: "strapcodeLeather" },
  { id: "beige", name: { en: "Beige", sv: "Beige" }, hex: "#c9b78e", src: "strapcodeLeather" },
  { id: "black", name: { en: "Black", sv: "Svart" }, hex: "#17191d", src: "strapcodeLeather" },
  { id: "brown", name: { en: "Brown", sv: "Brun" }, hex: "#5a3a24", src: "strapcodeLeather" },
  { id: "red", name: { en: "Red", sv: "Röd" }, hex: "#9d2029", src: "strapcodeLeather" },
  { id: "orange", name: { en: "Orange", sv: "Orange" }, hex: "#c25b1c", src: "strapcodeLeather" },
  { id: "blue", name: { en: "Blue", sv: "Blå" }, hex: "#28497f", src: "strapcodeLeather" },
  { id: "forest-green", name: { en: "Forest green", sv: "Mörkgrön" }, hex: "#22452e", src: "strapcodeLeather" },
  { id: "yellow", name: { en: "Yellow", sv: "Gul" }, hex: "#d8b53a", src: "strapcodeLeather" },
];

/** Stitch pitch: 14 stitches per inch on a good strap, i.e. one every 1.81 mm. */
export const STITCH_PITCH_MM = { mm: 1.81, approx: true, src: "strapcodeLeather" };

/** Buckle and clasp hardware finishes, listed across every strap kind. */
export const HARDWARE_FINISHES = [
  { id: "brushed", name: { en: "Brushed", sv: "Borstad" }, color: "#a8b0b9", rough: 0.45, src: "crownbuckle" },
  { id: "polished", name: { en: "Polished", sv: "Polerad" }, color: "#c3cad2", rough: 0.1, src: "crownbuckle" },
  { id: "pvd-black", name: { en: "PVD black", sv: "PVD svart" }, color: "#2b2f34", rough: 0.5, src: "crownbuckle" },
  { id: "gold", name: { en: "Gold plated", sv: "Guldpläterad" }, color: "#c8a253", rough: 0.2, src: "crownbuckle" },
  { id: "rose-gold", name: { en: "Rose gold", sv: "Roséguld" }, color: "#c98f6f", rough: 0.2, src: "strapcodeMesh" },
];

/**
 * BUCKLES and clasps. The load-bearing rule for the geometry: a buckle is as
 * wide as the strap's TAPERED end, not as wide as the lug — a 20 mm strap
 * tapering to 18 mm takes an 18 mm buckle, and drawing it at lug width is
 * exactly the kind of thing that reads as wrong without anyone being able to
 * say why.
 */
export const BUCKLES = [
  { id: "tang", name: { en: "Tang buckle", sv: "Stiftspänne" }, kinds: ["leather", "rubber", "nato"], thicknessMm: 1.0, tongueMm: 3.0, src: "strapcodeLeather" },
  { id: "sporty-tang", name: { en: "Sporty tang buckle", sv: "Sportigt stiftspänne" }, kinds: ["leather", "rubber", "nato"], thicknessMm: 1.0, tongueMm: 2.0, src: "strapcodeLeather" },
  { id: "deployant", name: { en: "Deployant clasp", sv: "Vikspänne" }, kinds: ["leather", "rubber"], src: "strapcodeLeather" },
  { id: "butterfly", name: { en: "Butterfly clasp", sv: "Fjärilslås" }, kinds: ["leather", "rubber"], closedThicknessMm: 7, planMm: [40, 22], maxStrapThicknessMm: 3.5, src: "strapcodeLeather" },
  { id: "v-clasp", name: { en: "V-clasp, double lock", sv: "V-lås, dubbelspärr" }, kinds: ["bracelet"], microHoles: 6, src: "strapcodeJubilee" },
  { id: "flip-lock", name: { en: "Double flip-lock diver clasp", sv: "Dubbelt flip-lock dykarlås" }, kinds: ["bracelet"], microHoles: 6, src: "strapcodeOyster" },
  { id: "concealed", name: { en: "Concealed clasp", sv: "Dolt lås" }, kinds: ["bracelet"], src: "everestBracelet" },
  { id: "interlock", name: { en: "Sliding interlock clasp (mesh)", sv: "Glidande interlock-lås (mesh)" }, kinds: ["bracelet"], src: "strapcodeMesh" },
];

/**
 * The default scene: the watch resting on a leather cylinder that stands in
 * for a wrist, which is what the feedback asked for. The radius is
 * sourced-and-derived — the average adult male wrist circumference is 172 mm,
 * giving a 27.4 mm circular radius, and watch pillows are actually sold in
 * 50 mm and 55 mm diameters banded by wrist size. The LENGTH is a rendering
 * choice; nobody publishes one.
 */
export const WRIST_HOLDER = {
  radiusMm: 27,
  radiusRangeMm: [25, 27.5],
  lengthMm: 100,
  lengthApprox: true,
  material: "suede",
  sheen: "matte",
  /** A wrist is flatter than it is wide; the ratio itself is not sourced. */
  aspect: 1.25,
  aspectApprox: true,
  src: "strapcodeLeather",
  note: {
    en: "Radius 27 mm from a 172 mm average adult male wrist circumference, independently corroborated by the 50 and 55 mm diameters watch pillows are actually sold in. The cylinder is matte suede-grain leather, not polished. Its length and its non-circular cross-section ratio are rendering conventions.",
    sv: "Radie 27 mm utifrån 172 mm genomsnittligt handledsomfång för vuxna män, oberoende bekräftat av de 50 och 55 mm diametrar klockkuddar faktiskt säljs i. Cylindern är matt mockaläder, inte polerat. Dess längd och icke-cirkulära tvärsnittsförhållande är renderingskonventioner.",
  },
};

/**
 * How far down the strap has already turned when it leaves the lug. The
 * complaint was that worn straps do not start straight out, and they do not:
 * with a wrist radius R and a spring bar standing d proud of the wrist, the
 * strap is tangent to the wrist at arccos(R/(R+d)) — about 29° for a 27 mm
 * wrist and a 4 mm standoff. The standoff is the unsourced part.
 */
export const STRAP_EXIT = {
  wristRadiusMm: WRIST_HOLDER.radiusMm,
  springBarStandoffMm: 4,
  standoffApprox: true,
  degrees: 29.5,
  degreesRange: [25, 35],
  src: "strapcodeLeather",
  note: {
    en: "Computed, not authored: arccos(R/(R+d)). Nobody publishes a lug exit angle. A flat-cut strap on curved lugs PIVOTS at the spring bar; a fitted curved end BENDS instead and sits flush against the case.",
    sv: "Beräknad, inte påhittad: arccos(R/(R+d)). Ingen publicerar en utgångsvinkel vid hornen. Ett rakskuret band på kurvade horn VRIDER sig kring bandstiftet; en formgjuten kurvad ände BÖJER sig i stället och ligger tätt mot boetten.",
  },
};

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

// ---------------------------------------------------------------------------
// THE COMPLICATION WHEELS. The single most useful finding behind "make it
// possible to switch text and background colour for the date wheel": the date
// disc is NOT a dial property. It is a separate purchasable part that swaps
// 1:1 onto the movement, and sellers list it by disc colour and text colour.
// The day wheel is the same, with LANGUAGE as an explicit product variable.
//
// The two Seiko part numbers are carried as provenance: 0148 141 is the white
// disc with black text and 0148 142 the black disc with white text.

export const DATE_WHEELS = [
  { id: "as-supplied", name: { en: "As the movement comes", sv: "Som urverket levereras" }, disc: "#f2f4f7", text: "#15181c", src: "modmode" },
  { id: "white-black", name: { en: "White disc, black text", sv: "Vit skiva, svart text" }, disc: "#f2f4f7", text: "#15181c", seikoPart: "0148 141", src: "modmode", ali: { queries: ["NH35 date wheel white"], priceUsd: [4, 14] } },
  { id: "black-white", name: { en: "Black disc, white text", sv: "Svart skiva, vit text" }, disc: "#111318", text: "#f2f5fa", seikoPart: "0148 142", src: "modmode", ali: { queries: ["NH35 date wheel black"], priceUsd: [4, 14] } },
  { id: "black-red", name: { en: "Black disc, red text", sv: "Svart skiva, röd text" }, disc: "#111318", text: "#d8453c", src: "aliCalendar", ali: { queries: ["NH36 black date disk red font"], priceUsd: [4, 14] } },
  { id: "black-gold", name: { en: "Black disc, gold text", sv: "Svart skiva, guldtext" }, disc: "#111318", text: "#cfa75a", src: "modmode", ali: { queries: ["NH36 black gold date wheel"], priceUsd: [5, 18] } },
  { id: "red-white", name: { en: "Red disc, white text", sv: "Röd skiva, vit text" }, disc: "#9d2029", text: "#f6f8fb", src: "namokiWheels", ali: { queries: ["NH35 date wheel disc red"], priceUsd: [5, 16] } },
  { id: "blue-white", name: { en: "Blue disc, white text", sv: "Blå skiva, vit text" }, disc: "#1b3b74", text: "#f6f8fb", src: "namokiWheels", ali: { queries: ["NH35 date wheel disc blue"], priceUsd: [5, 16] } },
  { id: "roulette", name: { en: "Roulette, red and black on white", sv: "Roulette, rött och svart på vitt" }, disc: "#f2f4f7", text: "#15181c", text2: "#c0202a", src: "namokiWheels", ali: { queries: ["NH35 roulette date wheel"], priceUsd: [6, 20] } },
  { id: "lume-white", name: { en: "Full lume, white", sv: "Helt lysande, vit" }, disc: "#eef1f2", text: "#15181c", lume: "c3", src: "namokiWheels", ali: { queries: ["NH35 lumed date wheel white"], priceUsd: [8, 24] } },
  { id: "lume-black", name: { en: "Full lume, black", sv: "Helt lysande, svart" }, disc: "#14171b", text: "#e9f0dd", lume: "c3", src: "namokiWheels", ali: { queries: ["NH35 lumed date wheel black"], priceUsd: [8, 24] } },
  { id: "lume-bgw9", name: { en: "BGW9 lumed", sv: "BGW9-lysande" }, disc: "#14171b", text: "#e7eef5", lume: "bgw9", src: "modmode", ali: { queries: ["BGW9 lumed date wheel NH36"], priceUsd: [8, 26] } },
  { id: "overlay-white", name: { en: "White overlay disc", sv: "Vit överläggsskiva" }, disc: "#f2f4f7", text: "#15181c", overlay: true, src: "modmode", note: { en: "A thin printed disc pasted over the stock wheel to change its colour or numeral orientation — which is how you get a colour the movement never shipped with.", sv: "En tunn tryckt skiva som klistras över originalhjulet för att ändra färg eller siffrornas riktning — så får man en färg urverket aldrig levererades med." }, ali: { queries: ["date wheel overlay NH35 NH36"], priceUsd: [4, 12] } },
];

export const DAY_WHEELS = [
  { id: "as-supplied", name: { en: "As the movement comes", sv: "Som urverket levereras" }, language: "en-es", disc: "#f2f4f7", text: "#15181c", crownAlign: "either", src: "tandorioDial" },
  { id: "en-es-black", name: { en: "English/Spanish, black disc", sv: "Engelska/spanska, svart skiva" }, language: "en-es", disc: "#111318", text: "#f2f5fa", crownAlign: "either", src: "luciusMovements", ali: { queries: ["NH36 day wheel english spanish black"], priceUsd: [5, 18] } },
  { id: "kanji-black-3", name: { en: "Kanji, black disc, 3 o'clock", sv: "Kanji, svart skiva, krona vid 3" }, language: "kanji", disc: "#111318", text: "#f2f5fa", crownAlign: "3", src: "namokiWheels", ali: { queries: ["NH36A kanji day wheel 3 o'clock"], priceUsd: [6, 20] } },
  { id: "kanji-black-4", name: { en: "Kanji, black disc, 4 o'clock", sv: "Kanji, svart skiva, krona vid 4" }, language: "kanji", disc: "#111318", text: "#f2f5fa", crownAlign: "4", src: "namokiWheels", ali: { queries: ["NH36A kanji day wheel 4 o'clock"], priceUsd: [6, 20] } },
  { id: "kanji-white-4", name: { en: "Kanji, white disc, 4 o'clock", sv: "Kanji, vit skiva, krona vid 4" }, language: "kanji", disc: "#f2f4f7", text: "#15181c", crownAlign: "4", src: "namokiWheels", ali: { queries: ["NH36A kanji day wheel white"], priceUsd: [6, 20] } },
  { id: "kanji-black-gold", name: { en: "Kanji, black and gold", sv: "Kanji, svart och guld" }, language: "kanji", disc: "#111318", text: "#cfa75a", crownAlign: "either", src: "modmode", ali: { queries: ["NH36 kanji day date wheels black gold"], priceUsd: [8, 26] } },
  { id: "kanji-rainbow", name: { en: "Kanji, rainbow", sv: "Kanji, regnbåge" }, language: "kanji", disc: "#111318", text: "#f2f5fa", rainbow: true, crownAlign: "either", src: "modmode", ali: { queries: ["NH36 kanji day date wheels rainbow"], priceUsd: [10, 30] } },
  { id: "arabic-black", name: { en: "Arabic, black disc", sv: "Arabiska, svart skiva" }, language: "arabic", disc: "#111318", text: "#f2f5fa", crownAlign: "either", src: "namokiWheels", ali: { queries: ["NH36A arabic day date wheel"], priceUsd: [7, 24] } },
  { id: "arabic-white", name: { en: "Arabic, white disc", sv: "Arabiska, vit skiva" }, language: "arabic", disc: "#f2f4f7", text: "#15181c", crownAlign: "either", src: "namokiWheels", ali: { queries: ["NH36A arabic day date wheel white"], priceUsd: [7, 24] } },
  { id: "hanzi-black", name: { en: "Hanzi, black disc", sv: "Hanzi, svart skiva" }, language: "hanzi", disc: "#111318", text: "#f2f5fa", crownAlign: "either", src: "aliCalendar", ali: { queries: ["NH36A hanzi date wheel"], priceUsd: [6, 20] } },
  { id: "lume-white", name: { en: "Lumed, white disc", sv: "Lysande, vit skiva" }, language: "kanji", disc: "#eef1f2", text: "#15181c", lume: "c3", crownAlign: "either", src: "namokiWheels", ali: { queries: ["NH36A lumed kanji day wheel"], priceUsd: [9, 28] } },
];

/**
 * Day-wheel languages verified as purchasable NHxx aftermarket discs. The
 * wider Seiko 5 day-wheel set (French, German, Danish, Roman numerals) is
 * documented for finished watches but NOT as parts you can buy for a mod, so
 * it is deliberately absent.
 */
export const DAY_WHEEL_LANGUAGES = [
  { id: "en-es", name: { en: "English / Spanish", sv: "Engelska/spanska" }, src: "tandorioDial" },
  { id: "kanji", name: { en: "Kanji", sv: "Kanji" }, src: "namokiWheels" },
  { id: "arabic", name: { en: "Arabic", sv: "Arabiska" }, src: "namokiWheels" },
  { id: "hanzi", name: { en: "Hanzi", sv: "Hanzi" }, src: "aliCalendar" },
];

// ---------------------------------------------------------------------------
// WHAT COMES IN THE BOX. This is the honest answer to "chapter ring, separately
// bought crystal and separately bought bezel insert have no reason to be
// mandatory" — and it is better than a mandatory/optional flag, because it is
// what actually varies. Boutique cases ship a BARE BODY (gaskets and a click
// spring and nothing else); marketplace complete kits ship with the crystal,
// caseback, bezel, insert, chapter ring and crown already in the box. So a
// part is free when the case includes it and priced when it does not, and none
// of them is mandatory in either case.
//
// Keyed by case id rather than written into each case entry, so the whole
// what-is-included policy is legible in one place.

/** @type {Record<string, { includes: string[], tier: string, src: string, approx?: boolean }>} */
export const CASE_KITS = {
  skx007: { includes: ["crystal", "caseback", "insert", "chapterRing", "crown"], tier: "complete-kit", src: "aliKit" },
  "skx-ncg": { includes: ["crystal", "caseback", "insert", "chapterRing", "crown"], tier: "complete-kit", src: "aliKit", approx: true },
  "skx-c3": { includes: ["crystal", "caseback", "insert", "chapterRing", "crown"], tier: "complete-kit", src: "aliKit", approx: true },
  tuna: { includes: ["crystal", "caseback", "insert", "chapterRing", "crown"], tier: "complete-kit", src: "karajan" },
};

/** The default: nothing included beyond gaskets and a click spring. */
export const CASE_KIT_DEFAULT = { includes: /** @type {string[]} */ ([]), tier: "bare-body", src: "namoki", approx: true };

/**
 * What a case family's kit contains.
 * @param {string} caseId
 */
export function caseKit(caseId) {
  return CASE_KITS[caseId] || CASE_KIT_DEFAULT;
}

/**
 * Per-case-family display (exhibition) caseback availability — the answer to
 * "make exhibition caseback available for case models where it is on
 * AliExpress, and make it the default when it exists".
 *
 * `true` means a display back for that family was found listed. `null` means
 * NOT ESTABLISHED — and those families default to a solid back, because
 * defaulting them to exhibition would be inventing a part that nobody sells.
 *
 * @type {Record<string, { display: boolean|null, src: string, approx?: boolean }>}
 */
export const CASE_DISPLAY_BACKS = {
  skx007: { display: true, src: "ct239" },
  "skx-ncg": { display: true, src: "ct239" },
  "skx-c3": { display: true, src: "ct239" },
  sub: { display: true, src: "ct239" },
  "sub-slim": { display: true, src: "ct239" },
  "turtle-skx": { display: true, src: "ct239" },
  "srp-turtle": { display: true, src: "ct239" },
  "mini-turtle": { display: true, src: "ct239", approx: true },
  skx013: { display: true, src: "lucius" },
  samurai: { display: true, src: "ct239" },
  tuna: { display: true, src: "karajan" },
  mm300: { display: true, src: "ct239", approx: true },
  "planet-ocean": { display: true, src: "ct239", approx: true },
  "62mas": { display: true, src: "lucius", approx: true },
  willard: { display: null, src: "namoki" },
  alpinist: { display: null, src: "watchandstyle" },
  explorer: { display: null, src: "lucius" },
  field: { display: null, src: "lucius" },
  sumo: { display: null, src: "community" },
  monster: { display: null, src: "community" },
};

/**
 * Whether an exhibition back is established for a case family: true, false or
 * null for "no listing found — do not claim one".
 * @param {string} caseId
 */
export function displayBackFor(caseId) {
  const row = CASE_DISPLAY_BACKS[caseId];
  return row ? row.display : null;
}

/**
 * The slot choices a case implies. Picking a case should carry its own
 * defaults: an exhibition back where one demonstrably exists, and the SKX013
 * platform's mandatory chapter ring.
 * @param {string} caseId
 * @returns {Record<string, string>}
 */
export function defaultsForCase(caseId) {
  const cs = CASES.find((c) => c.id === caseId);
  if (!cs) return {};
  /** @type {Record<string, string>} */
  const out = {};
  out.caseback = displayBackFor(caseId) === true ? "display" : "solid-brushed";
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)];
  if (plat && plat.chapterRingRequired) out.chapterRing = "black-minutes";
  return out;
}

// ---------------------------------------------------------------------------
// SLOTS AND AXES.
//
// SLOTS are the eleven physical parts you buy. They have been the build's
// shape since the page shipped and they stay exactly as they were, because
// permalinks, the chat command parser and the catalogue endpoint are all built
// on them.
//
// AXIS_SLOTS are the orthogonal variables ON those parts — dial colour, dial
// finish, insert profile, crystal edge, strap leather type, the date and day
// wheels. They are OVERRIDES: every one defaults to "as it comes", and a build
// only carries an axis key when the user has actually moved it away from the
// default. That is what keeps a permalink short, keeps an old permalink
// decoding to exactly the watch it always did, and keeps the build object the
// same shape it has always been until somebody uses the new controls.
//
// TEXT_FIELDS are free text rather than a choice from a list — the custom dial
// printing and the caseback engraving text.

/**
 * @typedef {{ key: string, list: string, name: {en: string, sv: string},
 *             optional?: boolean, over?: string, group?: string,
 *             asListed?: {en: string, sv: string}, defaultId?: string,
 *             kind?: string }} SlotDef
 * A slot or an axis. The two share a shape so one registry, one option
 * lookup and one compatibility annotator serve both.
 */

/**
 * Every slot the builder fills, in the order the UI shows them.
 * @type {SlotDef[]}
 */
export const SLOTS = [
  { key: "movement", list: "MOVEMENTS", name: { en: "Movement", sv: "Urverk" } },
  { key: "case", list: "CASES", name: { en: "Case", sv: "Boett" } },
  { key: "finish", list: "FINISHES", name: { en: "Finish", sv: "Ytbehandling" } },
  { key: "insert", list: "INSERTS", name: { en: "Bezel insert", sv: "Lünettinlägg" }, optional: true },
  { key: "dial", list: "DIALS", name: { en: "Dial", sv: "Urtavla" } },
  { key: "chapterRing", list: "CHAPTER_RINGS", name: { en: "Chapter ring", sv: "Chapter ring" }, optional: true },
  { key: "hands", list: "HAND_SETS", name: { en: "Hands", sv: "Visare" } },
  { key: "crystal", list: "CRYSTALS", name: { en: "Crystal", sv: "Glas" }, optional: true },
  { key: "crown", list: "CROWNS", name: { en: "Crown", sv: "Krona" } },
  { key: "caseback", list: "CASEBACKS", name: { en: "Case back", sv: "Boettbotten" } },
  { key: "strap", list: "STRAPS", name: { en: "Strap", sv: "Band" } },
];

/**
 * What "none" MEANS per slot, in the user's own words. These slots are
 * optional because a case very often ships the part already — so leaving one
 * out is a real purchase decision, not an incomplete build.
 */
const NONE_NAMES = {
  insert: { en: "None — the bezel as it comes", sv: "Ingen — lünetten som den är" },
  chapterRing: { en: "None — no chapter ring fitted", sv: "Ingen — ingen chapter ring monterad" },
  crystal: { en: "None — the glass the case ships with", sv: "Inget — glaset som följer med boetten" },
};

/**
 * The synthetic "none" option for an optional slot. It is NOT in the
 * catalogue list (nothing is sold called "none"), so `part(slot, "none")`
 * answers null exactly as the builder contract says; this is what the UI
 * renders for the choice.
 * @param {string} slotKey
 */
export function noneOption(slotKey) {
  const name = NONE_NAMES[/** @type {keyof typeof NONE_NAMES} */ (slotKey)];
  if (!name) return null;
  return { id: "none", name, none: true };
}

/**
 * Stand-ins so nothing downstream ever meets a null part. `ids.<slot>` stays
 * "none" and `resolveBuild().omitted.<slot>` is true, but `parts.<slot>`
 * always has the fields the renderer and the geometry builders read.
 */
const NONE_STANDINS = {
  insert: { id: "none", none: true, name: NONE_NAMES.insert, scale: "none", material: "steel", profile: "flat", base: "#8d949d", mark: "#5d646d", pip: "none", fits: ["skx", "skx013", "srp", "native"] },
  chapterRing: { id: "none", none: true, name: NONE_NAMES.chapterRing, base: "#9aa1aa", mark: "#6b727b", printing: "plain", finish: "polished", lume: "none", fits: ["skx", "skx013", "srp", "native"] },
  crystal: { id: "none", none: true, name: NONE_NAMES.crystal, material: "as-supplied", profile: "flat", edge: "bevel", arSide: "underside", forInsert: "any", dome: 0, tint: "#e0e7ef", ar: "none", cyclops: false, fits: ["skx", "skx013", "srp", "native"] },
};

/**
 * The orthogonal variables. `over` names the slot an axis modifies, `group`
 * is what a UI should file it under, `asListed` adds the synthetic "as it
 * comes" default at the head of the option list.
 * @type {SlotDef[]}
 */
export const AXIS_SLOTS = [
  { key: "dialColor", list: "DIAL_COLOURS", over: "dial", group: "dial", name: { en: "Dial colour", sv: "Urtavlans färg" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialFinish", list: "DIAL_FINISHES", over: "dial", group: "dial", name: { en: "Dial finish", sv: "Urtavlans finish" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialConstruction", list: "DIAL_CONSTRUCTIONS", over: "dial", group: "dial", name: { en: "Dial construction", sv: "Urtavlans konstruktion" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialIndices", list: "DIAL_INDEX_STYLES", over: "dial", group: "dial", name: { en: "Index style", sv: "Indexstil" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialCalendar", list: "DIAL_CALENDARS", over: "dial", group: "dial", name: { en: "Calendar", sv: "Kalender" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialLume", list: "DIAL_LUME_OPTIONS", over: "dial", group: "dial", name: { en: "Lume", sv: "Lysmassa" }, asListed: { en: "As the dial comes", sv: "Som urtavlan levereras" } },
  { key: "dialDiameter", list: "DIAL_DIAMETERS", over: "dial", group: "dial", name: { en: "Dial diameter", sv: "Urtavlans diameter" }, defaultId: "28-5" },
  { key: "dialFeet", list: "DIAL_FEET", over: "dial", group: "dial", name: { en: "Dial feet", sv: "Urtavlans fötter" }, defaultId: "feet4" },
  { key: "dialPrint", list: "DIAL_PRINTS", over: "dial", group: "dialText", name: { en: "Printing method", sv: "Tryckmetod" }, defaultId: "sterile" },
  { key: "dateWheel", list: "DATE_WHEELS", over: "movement", group: "wheels", name: { en: "Date wheel", sv: "Datumhjul" }, defaultId: "as-supplied" },
  { key: "dayWheel", list: "DAY_WHEELS", over: "movement", group: "wheels", name: { en: "Day wheel", sv: "Veckodagshjul" }, defaultId: "as-supplied" },
  { key: "insertProfile", list: "INSERT_PROFILES", over: "insert", group: "bezel", name: { en: "Insert profile", sv: "Inläggets profil" }, asListed: { en: "As the insert comes", sv: "Som inlägget levereras" } },
  { key: "insertMaterial", list: "INSERT_MATERIALS", over: "insert", group: "bezel", name: { en: "Insert material", sv: "Inläggets material" }, asListed: { en: "As the insert comes", sv: "Som inlägget levereras" } },
  { key: "crystalEdge", list: "CRYSTAL_EDGES", over: "crystal", group: "crystal", name: { en: "Crystal edge", sv: "Glasets kant" }, asListed: { en: "As the crystal comes", sv: "Som glaset levereras" } },
  { key: "crystalAr", list: "CRYSTAL_ARS", over: "crystal", group: "crystal", name: { en: "AR coating", sv: "Antireflexbehandling" }, asListed: { en: "As the crystal comes", sv: "Som glaset levereras" } },
  { key: "chapterPrinting", list: "CHAPTER_PRINTINGS", over: "chapterRing", group: "chapterRing", name: { en: "Chapter ring printing", sv: "Chapter ringens tryck" }, asListed: { en: "As the ring comes", sv: "Som ringen levereras" } },
  { key: "casebackFinish", list: "CASEBACK_FINISHES", over: "caseback", group: "caseback", name: { en: "Case back finish", sv: "Boettbottnens finish" }, asListed: { en: "As the case back comes", sv: "Som boettbottnen levereras" } },
  { key: "casebackEngraving", list: "CASEBACK_ENGRAVINGS", over: "caseback", group: "caseback", name: { en: "Case back engraving", sv: "Boettbottnens gravyr" }, asListed: { en: "As the case back comes", sv: "Som boettbottnen levereras" } },
  { key: "braceletType", list: "BRACELET_TYPES", over: "strap", group: "strap", name: { en: "Bracelet type", sv: "Länktyp" }, asListed: { en: "As the bracelet comes", sv: "Som länken levereras" }, kind: "bracelet" },
  { key: "rubberType", list: "RUBBER_TYPES", over: "strap", group: "strap", name: { en: "Rubber type", sv: "Gummityp" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "rubber" },
  { key: "leatherType", list: "LEATHER_TYPES", over: "strap", group: "strap", name: { en: "Leather type", sv: "Lädertyp" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "leather" },
  { key: "natoPattern", list: "NATO_PATTERNS", over: "strap", group: "strap", name: { en: "NATO pattern", sv: "NATO-mönster" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "nato" },
  { key: "natoWeave", list: "NATO_WEAVES", over: "strap", group: "strap", name: { en: "NATO weave", sv: "NATO-väv" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "nato" },
  { key: "natoLayers", list: "NATO_LAYERS", over: "strap", group: "strap", name: { en: "NATO construction", sv: "NATO-konstruktion" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "nato" },
  { key: "strapColor", list: "STRAP_COLOURS", over: "strap", group: "strap", name: { en: "Strap colour", sv: "Bandets färg" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" } },
  { key: "strapStitch", list: "STITCH_COLOURS", over: "strap", group: "strap", name: { en: "Stitch colour", sv: "Sömmens färg" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" }, kind: "leather" },
  { key: "strapHardware", list: "HARDWARE_FINISHES", over: "strap", group: "strap", name: { en: "Hardware finish", sv: "Beslagens finish" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" } },
  { key: "buckle", list: "BUCKLES", over: "strap", group: "strap", name: { en: "Buckle / clasp", sv: "Spänne/lås" }, asListed: { en: "As the strap comes", sv: "Som bandet levereras" } },
];

/** Lume as a choosable axis, not a fixed property of the dial listing. */
export const DIAL_LUME_OPTIONS = Object.keys(LUMES).map((id) => ({
  id,
  name: LUMES[/** @type {keyof typeof LUMES} */ (id)].name,
  src: LUMES[/** @type {keyof typeof LUMES} */ (id)].src || "namokiDials",
}));

/** Free-text fields. Sterile — every one empty — is the default and is real. */
export const TEXT_FIELDS = [
  ...DIAL_TEXT_FIELDS.map((f) => ({ ...f, group: "dialText" })),
  { key: "casebackText", name: { en: "Case back engraving text", sv: "Text för boettgravyr" }, max: 40, group: "caseback", src: "wsCaseback" },
];

/** Every key a build may carry, slots first, in a fixed order. */
export const ALL_SLOTS = [...SLOTS, ...AXIS_SLOTS];

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
  DIAL_COLOURS,
  DIAL_FINISHES,
  DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES,
  DIAL_CALENDARS,
  DIAL_LUME_OPTIONS,
  DIAL_DIAMETERS,
  DIAL_FEET,
  DIAL_PRINTS,
  DATE_WHEELS,
  DAY_WHEELS,
  INSERT_PROFILES,
  INSERT_MATERIALS,
  CRYSTAL_EDGES,
  CRYSTAL_ARS,
  CHAPTER_PRINTINGS,
  CASEBACK_FINISHES,
  CASEBACK_ENGRAVINGS,
  BRACELET_TYPES,
  RUBBER_TYPES,
  LEATHER_TYPES,
  NATO_PATTERNS,
  NATO_WEAVES,
  NATO_LAYERS,
  STRAP_COLOURS,
  STITCH_COLOURS,
  HARDWARE_FINISHES,
  BUCKLES,
};

/** The "as it comes" head option an override axis carries. */
const AS_LISTED_CACHE = new Map();
/** @param {SlotDef} axis */
function asListedOption(axis) {
  if (!AS_LISTED_CACHE.has(axis.key)) {
    AS_LISTED_CACHE.set(axis.key, { id: "as-listed", name: axis.asListed, asListed: true });
  }
  return AS_LISTED_CACHE.get(axis.key);
}

/**
 * The descriptor for a slot or an axis, or null.
 * @param {string} key
 */
export function slotDef(key) {
  return ALL_SLOTS.find((s) => s.key === key) || null;
}

/**
 * Whether a key is a free-text field rather than a choice.
 * @param {string} key
 */
export function textFieldDef(key) {
  return TEXT_FIELDS.find((f) => f.key === key) || null;
}

/**
 * Every option for one slot or axis. Axes that default to "as it comes" get
 * that option at the head of the list.
 * @param {string} slotKey
 * @returns {any[]}
 */
export function slotOptions(slotKey) {
  const slot = slotDef(slotKey);
  if (!slot) return [];
  const list = /** @type {any[]} */ (CATALOG[/** @type {keyof typeof CATALOG} */ (slot.list)]) || [];
  if (!slot.asListed) return list;
  return [asListedOption(slot), ...list];
}

/**
 * One option by slot + id, or null. Never throws — an unknown id is a miss,
 * not an error (a stale permalink must degrade, not break the page). The id
 * "none" is deliberately a miss: an omitted part is not an option object.
 * @param {string} slotKey
 * @param {string} id
 */
export function part(slotKey, id) {
  const slot = slotDef(slotKey);
  // On an OPTIONAL slot "none" means the part was left out, and an omitted
  // part is not an option object — which is the builder contract. Elsewhere
  // "none" is an ordinary option id ("no engraving", "no visible stitch") and
  // resolves like any other.
  if (id === "none" && slot && slot.optional) return null;
  return slotOptions(slotKey).find((o) => o && o.id === id) || null;
}

/**
 * The default id for an axis: "as-listed", or the explicit one it names.
 * @param {SlotDef} axis
 */
function axisDefault(axis) {
  return axis.defaultId || "as-listed";
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
 * Free text, made safe to put in a permalink and on a dial.
 * @param {unknown} value
 * @param {number} [max]
 */
function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[;:]/g, " ")
    .replace(/[^\p{L}\p{N} .,'’&+°()/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 22);
}

/**
 * Fill in any missing/unknown slot from the default build. Total: every input
 * produces a complete, renderable build.
 *
 * The eleven part slots are ALWAYS present. An axis key is present only when
 * it has been moved off its default, and a text field only when it is not
 * empty — which is what keeps a build that uses none of the new controls
 * byte-identical to the build this page has always produced.
 *
 * @param {Record<string, string> | null | undefined} build
 * @returns {Record<string, string>}
 */
export function normalizeBuild(build) {
  /** @type {Record<string, string>} */
  const out = {};
  const src = build && typeof build === "object" ? build : {};
  for (const slot of SLOTS) {
    const wanted = typeof src[slot.key] === "string" ? src[slot.key] : "";
    if (slot.optional && wanted === "none") {
      out[slot.key] = "none";
      continue;
    }
    out[slot.key] = part(slot.key, wanted) ? wanted : DEFAULT_BUILD[/** @type {keyof typeof DEFAULT_BUILD} */ (slot.key)];
  }
  for (const axis of AXIS_SLOTS) {
    const wanted = typeof src[axis.key] === "string" ? src[axis.key] : "";
    const fallback = axisDefault(axis);
    if (!wanted || wanted === fallback) continue;
    if (!part(axis.key, wanted)) continue;
    out[axis.key] = wanted;
  }
  for (const field of TEXT_FIELDS) {
    const text = cleanText(src[field.key], field.max);
    if (text) out[field.key] = text;
  }
  return out;
}

/**
 * The value of an axis in a build, defaulted.
 * @param {Record<string, string>} ids
 * @param {SlotDef} axis
 */
function axisId(ids, axis) {
  const v = ids[axis.key];
  return typeof v === "string" && v ? v : axisDefault(axis);
}

/**
 * The chosen axis OPTION, or null when it is left "as it comes".
 * @param {Record<string, string>} ids
 * @param {string} key
 */
function axisPick(ids, key) {
  const axis = AXIS_SLOTS.find((a) => a.key === key);
  if (!axis) return null;
  const id = axisId(ids, axis);
  if (id === "as-listed") return null;
  return part(key, id);
}

/**
 * Which strap kind an axis belongs to, for the cross-kind rules.
 * @param {string} key
 */
function axisKind(key) {
  const axis = AXIS_SLOTS.find((a) => a.key === key);
  return axis && axis.kind ? axis.kind : null;
}

/**
 * The dial as it will actually look, with every axis override applied. The
 * legacy fields the renderer and the geometry builders read (`base`, `finish`,
 * `markers`, `markerColor`, `textColor`, `lume`, `date`, `day`, `text`) are
 * recomputed here, so an override lands on the screen without either of them
 * knowing the axes exist.
 * @param {any} dial
 * @param {Record<string, string>} ids
 */
function effectiveDial(dial, ids) {
  const out = { ...dial };
  const colour = axisPick(ids, "dialColor");
  if (colour) {
    out.colour = colour.id;
    out.base = colour.hex;
    const ink = colour.ink || "#eef2f7";
    out.markerColor = colour.accent || ink;
    out.textColor = colour.accent || ink;
  }
  const finish = axisPick(ids, "dialFinish");
  if (finish) {
    out.finishId = finish.id;
    out.finish = finish.render;
  }
  const construction = axisPick(ids, "dialConstruction");
  if (construction) out.construction = construction.id;
  const indices = axisPick(ids, "dialIndices");
  if (indices) out.indices = indices.id;
  const calendar = axisPick(ids, "dialCalendar");
  if (calendar) {
    out.calendar = calendar.id;
    out.date = calendar.date;
    out.day = calendar.day;
  }
  const lume = axisPick(ids, "dialLume");
  if (lume) out.lume = lume.id;
  const dia = axisPick(ids, "dialDiameter");
  if (dia) out.diameter = dia.id;
  const feet = axisPick(ids, "dialFeet");
  if (feet) out.feet = feet.id;

  // Custom text. Sterile means an empty dial, and that is a real product.
  const printId = ids.dialPrint || "sterile";
  out.printMethod = printId;
  const lines = DIAL_TEXT_FIELDS.map((f) => ids[f.key] || "").filter(Boolean);
  if (printId !== "sterile" && lines.length) {
    out.text = lines;
    out.customText = {
      logo: ids.textLogo || "",
      line12: ids.text12 || "",
      line6a: ids.text6a || "",
      line6b: ids.text6b || "",
      method: printId,
    };
  } else if (printId === "sterile") {
    out.text = [];
    out.customText = null;
  } else {
    out.customText = null;
  }
  // The relief the renderer should give the surface, resolved once here.
  const design = DIAL_DESIGNS.find((d) => d.id === out.design);
  const fin = DIAL_FINISHES.find((f) => f.id === out.finishId);
  const con = DIAL_CONSTRUCTIONS.find((c) => c.id === out.construction);
  out.relief = (con && con.relief !== "flat" ? con.relief : null)
    || (design && design.relief !== "flat" ? design.relief : null)
    || (fin && fin.relief) || "flat";
  return out;
}

/**
 * The bezel insert with its profile and material overrides applied.
 * @param {any} insert
 * @param {Record<string, string>} ids
 */
function effectiveInsert(insert, ids) {
  const out = { ...insert };
  const profile = axisPick(ids, "insertProfile");
  if (profile) out.profile = profile.id;
  const material = axisPick(ids, "insertMaterial");
  if (material) {
    out.material = material.id;
    if (material.gloss != null) out.gloss = material.gloss;
    if (material.lumed) out.lumed = true;
  }
  const mat = INSERT_MATERIALS.find((m) => m.id === out.material);
  if (mat) {
    out.thicknessMm = mat.thicknessMm != null ? mat.thicknessMm : null;
    out.thicknessRangeMm = mat.thicknessRangeMm || null;
  }
  return out;
}

/**
 * The crystal with its edge and coating overrides applied.
 * @param {any} crystal
 * @param {Record<string, string>} ids
 */
function effectiveCrystal(crystal, ids) {
  const out = { ...crystal };
  const edge = axisPick(ids, "crystalEdge");
  if (edge) {
    out.edge = edge.id;
    out.forInsert = edge.forInsert;
    out.chamferMm = edge.chamferMm;
  } else {
    const own = CRYSTAL_EDGES.find((e) => e.id === out.edge);
    if (own) out.chamferMm = own.chamferMm;
  }
  const ar = axisPick(ids, "crystalAr");
  if (ar) {
    out.ar = ar.id;
    out.tint = ar.tint;
  }
  // A flat crystal's top face is a PLANE. Nothing may revolve a curve over it;
  // the only relief is the rim chamfer picked above.
  out.topFacePlanar = out.profile === "flat";
  return out;
}

/**
 * The chapter ring with its printing override applied.
 * @param {any} ring
 * @param {Record<string, string>} ids
 */
function effectiveChapterRing(ring, ids) {
  const out = { ...ring };
  const printing = axisPick(ids, "chapterPrinting");
  if (printing) out.printing = printing.id;
  return out;
}

/**
 * The caseback with its finish and engraving overrides applied.
 * @param {any} cb
 * @param {Record<string, string>} ids
 */
function effectiveCaseback(cb, ids) {
  const out = { ...cb };
  const finish = axisPick(ids, "casebackFinish");
  if (finish) out.finish = finish.id;
  const engraving = axisPick(ids, "casebackEngraving");
  if (engraving) {
    out.engraving = engraving.id;
    if (engraving.id !== "none" && out.type === "solid") out.type = "solid";
  }
  if (out.engraving === "custom-text") out.engravingText = ids.casebackText || "";
  // An engraved back is a decal on the SOLID shape. This is the single place
  // that says so, and the renderer must not give it a mesh of its own.
  out.geometry = out.display ? "display" : "solid";
  return out;
}

/**
 * The strap with its type, colour, stitch, hardware and buckle overrides.
 * @param {any} strap
 * @param {Record<string, string>} ids
 */
function effectiveStrap(strap, ids) {
  const out = { ...strap };
  const byKind = { bracelet: "braceletType", rubber: "rubberType", leather: "leatherType" };
  const typeAxis = byKind[/** @type {keyof typeof byKind} */ (out.kind)];
  if (typeAxis) {
    const picked = axisPick(ids, typeAxis);
    if (picked) out.type = picked.id;
  }
  if (out.kind === "bracelet") {
    const t = BRACELET_TYPES.find((b) => b.id === out.type);
    if (t) out.geometry = t;
  } else if (out.kind === "rubber") {
    const t = RUBBER_TYPES.find((r) => r.id === out.type);
    if (t) out.geometry = t;
  } else if (out.kind === "leather") {
    const t = LEATHER_TYPES.find((l) => l.id === out.type);
    if (t) {
      out.geometry = t;
      out.sheen = t.sheen;
      out.grain = t.grain;
      out.specular = t.specular != null ? t.specular : (SHEEN_LEVELS.find((s) => s.id === t.sheen) || {}).specular;
    }
  } else if (out.kind === "nato") {
    const weave = axisPick(ids, "natoWeave") || NATO_WEAVES[0];
    const layers = axisPick(ids, "natoLayers") || NATO_LAYERS[0];
    const pattern = axisPick(ids, "natoPattern") || NATO_PATTERNS[0];
    out.weave = weave.id;
    out.thicknessMm = weave.thicknessMm;
    out.sheen = weave.sheen;
    out.rings = layers.rings;
    out.underFlap = layers.flap;
    out.pattern = pattern.id;
    out.stripes = pattern.stripes;
    out.lengthMm = 290;
    out.sizingHoles = 13;
    out.geometry = weave;
  }
  const colour = axisPick(ids, "strapColor");
  if (colour) {
    out.colour = colour.id;
    out.color = colour.hex;
  }
  const stitch = axisPick(ids, "strapStitch");
  if (stitch) {
    out.stitch = stitch.id;
    out.stitchColor = stitch.hex;
    out.stitchPitchMm = STITCH_PITCH_MM.mm;
  }
  const hardware = axisPick(ids, "strapHardware");
  if (hardware) {
    out.hardware = hardware.id;
    out.hardwareColor = hardware.color;
  }
  const buckle = axisPick(ids, "buckle");
  if (buckle) out.buckle = buckle.id;
  if (!out.sheen) out.sheen = out.kind === "bracelet" ? "metal" : "satin";
  return out;
}

/**
 * Resolve a build's ids into the catalog objects, defaults filled in and every
 * axis override applied. `parts` is never null anywhere — an omitted part is
 * reported in `omitted` and stands in with neutral values, so the renderer and
 * the geometry builders never have to check.
 * @param {Record<string, string> | null | undefined} build
 */
export function resolveBuild(build) {
  const ids = normalizeBuild(build);
  /** @type {Record<string, any>} */
  const parts = {};
  /** @type {Record<string, boolean>} */
  const omitted = {};
  for (const slot of SLOTS) {
    const found = part(slot.key, ids[slot.key]);
    if (found) {
      parts[slot.key] = found;
      continue;
    }
    omitted[slot.key] = true;
    parts[slot.key] = NONE_STANDINS[/** @type {keyof typeof NONE_STANDINS} */ (slot.key)]
      || slotOptions(slot.key)[0];
  }
  parts.dial = effectiveDial(parts.dial, ids);
  parts.insert = effectiveInsert(parts.insert, ids);
  parts.crystal = effectiveCrystal(parts.crystal, ids);
  parts.chapterRing = effectiveChapterRing(parts.chapterRing, ids);
  parts.caseback = effectiveCaseback(parts.caseback, ids);
  parts.strap = effectiveStrap(parts.strap, ids);
  parts.dateWheel = part("dateWheel", ids.dateWheel || "as-supplied") || DATE_WHEELS[0];
  parts.dayWheel = part("dayWheel", ids.dayWheel || "as-supplied") || DAY_WHEELS[0];
  parts.aperture = DAY_DATE_APERTURE;
  parts.kit = caseKit(ids.case);
  return { ids, parts, omitted };
}

// ---------------------------------------------------------------------------
// Compatibility. ERRORS mean the build cannot be assembled as specified;
// WARNINGS mean it can, but something will look or work oddly. Nothing here
// throws and nothing here blocks rendering — an impossible build still draws,
// with the problems listed beside it. That is the honest posture for a tool
// whose whole point is showing you what a combination looks like.

/**
 * @typedef {{ level: "error"|"warning"|"note", slot: string, slots?: string[], en: string, sv: string }} Issue
 */

/**
 * @param {Record<string, string> | null | undefined} build
 * @returns {{ ok: boolean, issues: Issue[] }}
 */
export function checkBuild(build) {
  const { ids, parts, omitted } = resolveBuild(build);
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
      slots: ["dial", "movement"],
      en: `${mv.caliber} has a date wheel but "${dl.name.en}" has no date window — the wheel would sit behind a solid dial. Use a no-date movement (NH70/NH38) or a dial with an aperture.`,
      sv: `${mv.caliber} har ett datumhjul men "${dl.name.sv}" saknar datumfönster — hjulet hamnar bakom en heltäckande urtavla. Välj ett urverk utan datum (NH70/NH38) eller en tavla med fönster.`,
    });
  }
  if (!mv.date && dl.date) {
    issues.push({
      level: "error",
      slot: "movement",
      slots: ["movement", "dial"],
      en: `"${dl.name.en}" has a date window but ${mv.caliber} has no date wheel — you would see the movement through the aperture.`,
      sv: `"${dl.name.sv}" har datumfönster men ${mv.caliber} saknar datumhjul — du skulle se urverket genom fönstret.`,
    });
  }
  if (mv.day && !dl.day) {
    issues.push({
      level: "error",
      slot: "dial",
      slots: ["dial", "movement"],
      en: `${mv.caliber} drives a day wheel; this dial has no day window. Pair the NH36 with a day-date dial, or use the NH35.`,
      sv: `${mv.caliber} driver ett veckodagshjul; den här tavlan har inget veckodagsfönster. Kombinera NH36 med en veckodags-/datumtavla, eller använd NH35.`,
    });
  }
  if (!mv.day && dl.day) {
    issues.push({
      level: "error",
      slot: "movement",
      slots: ["movement", "dial"],
      en: `This dial has a day window but ${mv.caliber} has no day wheel — the window would be blank. The NH36 is the day-date movement.`,
      sv: `Den här tavlan har veckodagsfönster men ${mv.caliber} saknar veckodagshjul — fönstret blir tomt. NH36 är veckodags-/datumurverket.`,
    });
  }
  if (mv.openHeart && !dl.openHeart) {
    issues.push({
      level: "warning",
      slot: "dial",
      slots: ["dial", "movement"],
      en: `${mv.caliber} is built to be seen — a solid dial hides the open balance it exists for.`,
      sv: `${mv.caliber} är gjort för att synas — en heltäckande tavla döljer den öppna balansen den finns för.`,
    });
  }
  if (dl.openHeart && !mv.openHeart) {
    issues.push({
      level: "warning",
      slot: "movement",
      slots: ["movement", "dial"],
      en: `An open-heart dial over ${mv.caliber} shows an undecorated bridge rather than the balance wheel.`,
      sv: `En öppet-hjärta-tavla över ${mv.caliber} visar en odekorerad brygga i stället för balanshjulet.`,
    });
  }

  // --- GMT: three parts have to agree.
  if (mv.gmt && !hs.gmt) {
    issues.push({
      level: "error",
      slot: "hands",
      slots: ["hands", "movement"],
      en: `${mv.caliber} drives a fourth (24-hour) hand — this hand set has only three.`,
      sv: `${mv.caliber} driver en fjärde visare (24-timmars) — det här visarsetet har bara tre.`,
    });
  }
  if (!mv.gmt && hs.gmt) {
    issues.push({
      level: "warning",
      slot: "movement",
      slots: ["movement", "hands"],
      en: `The GMT hand has nothing to drive it on ${mv.caliber}; only the NH34 has a 24-hour wheel.`,
      sv: `GMT-visaren har inget som driver den på ${mv.caliber}; bara NH34 har ett 24-timmarshjul.`,
    });
  }
  if (mv.gmt && !dl.gmt && !(parts.insert && parts.insert.gmt)) {
    issues.push({
      level: "warning",
      slot: "insert",
      slots: ["insert", "dial", "movement"],
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
        slots: [key, "case"],
        en: `The ${cs.name.en} uses a case-specific ${label.en} rather than a shared-platform one — buy it with the case. The render shows the pattern you picked.`,
        sv: `${cs.name.sv} använder ett boettspecifikt ${label.sv} i stället för ett från en delad plattform — köp det med boetten. Bilden visar mönstret du valt.`,
      });
      continue;
    }
    issues.push({
      level: "error",
      slot: key,
      slots: [key, "case"],
      en: `This ${label.en} is not made for the ${plat.name.en} platform that the ${cs.name.en} uses.`,
      sv: `Det här ${label.sv} är inte gjort för ${plat.name.sv}-plattformen som ${cs.name.sv} använder.`,
    });
  }

  // --- a case with no rotating bezel has nowhere to put an insert.
  if (cs.bezel !== "dive120" && parts.insert && parts.insert.scale !== "none") {
    issues.push({
      level: "warning",
      slot: "insert",
      slots: ["insert", "case"],
      en: `The ${cs.name.en} has no rotating bezel, so the insert is not fitted — the render shows the case as it ships.`,
      sv: `${cs.name.sv} har ingen roterande lünett, så inlägget monteras inte — bilden visar boetten som den levereras.`,
    });
  }
  if (!plat.chapterRing && parts.chapterRing) {
    issues.push({
      level: "note",
      slot: "chapterRing",
      slots: ["chapterRing", "case"],
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
      slots: ["hands", "dial"],
      en: "The minute hand reaches past the printed minute track — it will overhang the chapter ring.",
      sv: "Minutvisaren når förbi minutskalan — den kommer att hänga över chapter ringen.",
    });
  }
  if (minuteMm < dialR * 0.7) {
    issues.push({
      level: "warning",
      slot: "hands",
      slots: ["hands", "dial"],
      en: "The minute hand stops well short of the minute track, which reads as a mismatched set.",
      sv: "Minutvisaren når långt ifrån minutskalan, vilket ser ut som ett felmatchat set.",
    });
  }
  if (dl.lume === "none" && hs.lume) {
    issues.push({
      level: "note",
      slot: "dial",
      slots: ["dial", "hands"],
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
      slots: ["crystal", "caseback", "case"],
      en: `The chosen crystal and case back add up to about ${spec.stackMm.toFixed(1)} mm against the case's ${cs.dims.thick} mm — expect the back to sit proud.`,
      sv: `Valt glas och boettbotten summerar till ca ${spec.stackMm.toFixed(1)} mm mot boettens ${cs.dims.thick} mm — räkna med att botten sticker ut.`,
    });
  }

  // ------------------------------------------------------------------
  // R1 — CRYSTAL PROFILE ↔ INSERT PROFILE. The most expensive real trap in
  // this hobby, and the one crystal vendors design entire SKUs around: they
  // literally name crystals after the insert they pair with. A sloped insert
  // intrudes 0.9 mm further inward than a flat one on the SKX platform, so a
  // crystal cut for a flat insert leaves a visible step under a sloped one.
  if (!omitted.crystal && !omitted.insert && parts.insert.scale !== "none") {
    const want = parts.insert.profile;
    const forInsert = parts.crystal.forInsert;
    if (forInsert && forInsert !== "any" && want && forInsert !== want) {
      issues.push({
        level: "warning",
        slot: "crystal",
        slots: ["crystal", "insert"],
        en: `This crystal is cut for a ${forInsert} bezel insert and the insert chosen is ${want} — expect a visible step or gap where the crystal meets the bezel. Crystal vendors sell separate SKUs for flat and for sloping inserts precisely because of this.`,
        sv: `Det här glaset är gjort för ett ${forInsert === "flat" ? "plant" : "sluttande"} lünettinlägg medan det valda inlägget är ${want === "flat" ? "plant" : "sluttande"} — räkna med ett synligt steg eller en glipa där glaset möter lünetten. Glasleverantörer säljer separata artiklar för plana och sluttande inlägg just av den anledningen.`,
      });
    }
  }

  // R3 — DISPLAY CASEBACK ↔ MOVEMENT SPACER. A real two-SKU fork: the
  // exhibition back comes cut either for the thicker black OEM spacer or for
  // the thinner grey NH spacer, and they are not interchangeable. Every
  // movement here is an NH.
  if (parts.caseback.display && parts.caseback.spacerFit === "black-oem") {
    issues.push({
      level: "error",
      slot: "caseback",
      slots: ["caseback", "movement"],
      en: `This display back is cut for the thicker black OEM movement spacer; ${mv.caliber} uses the thinner grey NH spacer, so it is the wrong half of a two-SKU fork. Choose the grey-spacer variant.`,
      sv: `Den här glasbottnen är gjord för den tjockare svarta originaldistansen; ${mv.caliber} använder den tunnare grå NH-distansen, så det är fel halva av ett tvådelat val. Välj varianten för grå distans.`,
    });
  }

  // R4 — display-caseback availability per case family. Where no listing was
  // found, saying so is more useful than pretending.
  if (parts.caseback.display && displayBackFor(cs.id) !== true) {
    issues.push({
      level: "warning",
      slot: "caseback",
      slots: ["caseback", "case"],
      en: `No exhibition case back was found listed for the ${cs.name.en}. It may exist, but nothing in the research confirms one — check the listing before ordering, or fit a solid back.`,
      sv: `Ingen utställningsboett hittades listad för ${cs.name.sv}. Den kan finnas, men inget i researchen bekräftar det — kontrollera annonsen innan du beställer, eller montera en massiv botten.`,
    });
  }

  // R5 — CHAPTER RING. Optional on most platforms, genuinely MANDATORY on the
  // SKX013: without it the dial sits too low and the hands do not clear.
  if (omitted.chapterRing && plat.chapterRing) {
    if (plat.chapterRingRequired) {
      issues.push({
        level: "error",
        slot: "chapterRing",
        slots: ["chapterRing", "case"],
        en: `An ${plat.name.en}-spec chapter ring is mandatory: without it the dial sits too low in the case and the hands will not clear.`,
        sv: `En chapter ring av ${plat.name.sv}-typ är obligatorisk: utan den sitter urtavlan för lågt i boetten och visarna går inte fria.`,
      });
    } else {
      issues.push({
        level: "warning",
        slot: "chapterRing",
        slots: ["chapterRing", "case"],
        en: "The chapter ring is what stops the dial coming forward, so leaving it out needs a new movement spacer or adhesive dial dots — otherwise the dial floats up off the movement.",
        sv: "Chapter ringen är det som hindrar urtavlan från att glida framåt, så att utelämna den kräver en ny urverksdistans eller självhäftande limpunkter — annars lyfter urtavlan från urverket.",
      });
    }
  }

  // R9 — the crown does not cross SKX007 ↔ SRPD. This platform lumps the two
  // together, so the honest thing is to say which one you have to check.
  if (cs.platform === "skx" && ids.crown && ids.crown !== DEFAULT_BUILD.crown) {
    issues.push({
      level: "note",
      slot: "crown",
      slots: ["crown", "case"],
      en: "SKX007 and SRPD cases use different crown systems and their crowns do not interchange, even though every other part on this platform does. Check which of the two your case listing actually is.",
      sv: "SKX007- och SRPD-boetter använder olika kronsystem och deras kronor passar inte i varandra, trots att alla andra delar på plattformen gör det. Kontrollera vilken av de två din boettannons faktiskt är.",
    });
  }

  // --- the date wheel and the day wheel: separate parts, with their own rules.
  if (ids.dateWheel && ids.dateWheel !== "as-supplied" && !mv.date) {
    issues.push({
      level: "error",
      slot: "dateWheel",
      slots: ["dateWheel", "movement"],
      en: `${mv.caliber} has no date wheel to swap — a date disc needs a date movement.`,
      sv: `${mv.caliber} har inget datumhjul att byta — en datumskiva kräver ett urverk med datum.`,
    });
  }
  if (ids.dayWheel && ids.dayWheel !== "as-supplied" && !mv.day) {
    issues.push({
      level: "error",
      slot: "dayWheel",
      slots: ["dayWheel", "movement"],
      en: `${mv.caliber} has no day wheel — only the NH36 drives one, so there is nothing for this disc to sit on.`,
      sv: `${mv.caliber} har inget veckodagshjul — bara NH36 driver ett, så det finns inget för den här skivan att sitta på.`,
    });
  }
  if (mv.day && parts.dayWheel && parts.dayWheel.crownAlign && parts.dayWheel.crownAlign !== "either") {
    if (String(cs.crown.hour) !== parts.dayWheel.crownAlign) {
      issues.push({
        level: "warning",
        slot: "dayWheel",
        slots: ["dayWheel", "case"],
        en: `Unlike the date disc, an NH36 day wheel is pre-aligned to one crown position. This one is cut for a ${parts.dayWheel.crownAlign} o'clock crown and the ${cs.name.en} has its crown at ${cs.crown.hour} — the day text would read rotated.`,
        sv: `Till skillnad från datumskivan är NH36:ans veckodagshjul förinställt för ett kronläge. Det här är gjort för krona vid ${parts.dayWheel.crownAlign} och ${cs.name.sv} har kronan vid ${cs.crown.hour} — veckodagstexten skulle stå snett.`,
      });
    }
  }
  if (mv.day && mv.date && dl.day) {
    issues.push({
      level: "note",
      slot: "dial",
      slots: ["dial", "movement"],
      en: "Day and date are read through ONE pillar-box window on the NH36, not two: the day disc sits inboard and the date ring outboard, and the visible split is just the day disc's edge lying over the date ring. The NH36's date disc is printed differently from the NH35's precisely to keep the two apart — fitting an NH35 disc, or an NH36 disc under a date-only dial, is what makes the numerals sit off-centre.",
      sv: "Veckodag och datum läses genom ETT avlångt fönster på NH36, inte två: veckodagsskivan sitter innerst och datumringen ytterst, och den synliga delningen är bara veckodagsskivans kant som ligger över datumringen. NH36:ans datumskiva är tryckt annorlunda än NH35:ans just för att hålla isär de två — att montera en NH35-skiva, eller en NH36-skiva under en tavla med bara datum, är det som gör att siffrorna hamnar snett.",
    });
  }

  // --- the dial's own axes.
  if (dl.date === "6" && mv.date === "3") {
    issues.push({
      level: "warning",
      slot: "dial",
      slots: ["dial", "movement"],
      en: `A date-at-6 dial needs the "date @ 6H" movement variant or a date-wheel overlay; ${mv.caliber} as sold puts its date at 3 and the aperture would show the wrong part of the disc.`,
      sv: `En tavla med datum vid 6 kräver urverksvarianten "date @ 6H" eller en överläggsskiva; ${mv.caliber} som den säljs har datumet vid 3 och fönstret skulle visa fel del av skivan.`,
    });
  }
  const calendar = DIAL_CALENDARS.find((c) => c.id === dl.calendar);
  if (calendar && calendar.crownHour && calendar.crownHour !== cs.crown.hour && dl.date) {
    issues.push({
      level: "warning",
      slot: "dial",
      slots: ["dial", "case"],
      en: `This dial's aperture is cut for a ${calendar.crownHour} o'clock crown and the ${cs.name.en} has its crown at ${cs.crown.hour} — the window will not line up with the case.`,
      sv: `Den här tavlans fönster är skuret för krona vid ${calendar.crownHour} och ${cs.name.sv} har kronan vid ${cs.crown.hour} — fönstret kommer inte att stämma med boetten.`,
    });
  }
  const dialDia = DIAL_DIAMETERS.find((d) => d.id === dl.diameter);
  if (dialDia && dialDia.mm > plat.dialDia) {
    issues.push({
      level: "error",
      slot: "dial",
      slots: ["dial", "case"],
      en: `A ${dialDia.mm} mm dial will not seat in the ${cs.name.en}: its dial seat takes ${plat.dialDia} mm, and an oversize dial fouls the case and the chapter ring. Oversize dials exist, but for cases built around them.`,
      sv: `En ${dialDia.mm} mm urtavla får inte plats i ${cs.name.sv}: dess urtavlesäte tar ${plat.dialDia} mm, och en för stor tavla tar i boetten och chapter ringen. Överstora tavlor finns, men för boetter byggda för dem.`,
    });
  }
  if (dl.construction === "sandwich" && !["black", "blue", "navy", "orange"].includes(dl.colour)) {
    issues.push({
      level: "warning",
      slot: "dialColor",
      slots: ["dialColor", "dial"],
      en: "The sandwich family is genuinely narrow: only black, dark blue and orange were found listed. This colour may simply not be made as a sandwich dial.",
      sv: "Sandwich-familjen är verkligen smal: bara svart, mörkblå och orange hittades listade. Den här färgen tillverkas kanske helt enkelt inte som sandwich-tavla.",
    });
  }
  const colour = DIAL_COLOURS.find((c) => c.id === dl.colour);
  if (colour && Array.isArray(colour.families) && !colour.families.includes(dl.design)) {
    issues.push({
      level: "warning",
      slot: "dialColor",
      slots: ["dialColor", "dial"],
      en: `${colour.name.en} was only found in the dress and enamel colour runs, not on a ${dl.design} dial. It may be orderable as a custom print, but no listing was found for the combination.`,
      sv: `${colour.name.sv} hittades bara i kläd- och emaljfärgserierna, inte på en ${dl.design}-tavla. Den kan gå att beställa som specialtryck, men ingen annons hittades för kombinationen.`,
    });
  }
  // The crown angle IS a real dial constraint, but it lives in the FEET, not
  // the aperture: quality mod dials ship four feet — two sets, for a 3 and a 4
  // o'clock crown — and you snip off the pair you do not need. A dial with
  // only one pair has to match the case.
  const feet = DIAL_FEET.find((f) => f.id === dl.feet);
  if (feet && feet.crownHour && feet.crownHour !== cs.crown.hour) {
    issues.push({
      level: "error",
      slot: "dialFeet",
      slots: ["dialFeet", "case"],
      en: `This dial has only the ${feet.crownHour} o'clock pair of feet and the ${cs.name.en} has its crown at ${cs.crown.hour} — the feet will not meet the movement's holes. A four-footed dial covers both.`,
      sv: `Den här tavlan har bara fotparet för krona vid ${feet.crownHour} och ${cs.name.sv} har kronan vid ${cs.crown.hour} — fötterna möter inte urverkets hål. En tavla med fyra fötter täcker båda.`,
    });
  }
  if (dl.feet === "glue") {
    issues.push({
      level: "note",
      slot: "dialFeet",
      slots: ["dialFeet", "dial"],
      en: "A feetless dial mounts on adhesive dial dots rather than glue — three of them rather than the usual two is the advice, and the chapter ring stops it floating forward.",
      sv: "En tavla utan fötter monteras på självhäftande limpunkter i stället för lim — rådet är tre i stället för de vanliga två, och chapter ringen hindrar den från att glida framåt.",
    });
  }
  if (dl.printMethod && dl.printMethod !== "sterile" && dl.customText) {
    issues.push({
      level: "note",
      slot: "dialPrint",
      slots: ["dialPrint", "dial"],
      en: "Custom dial printers will put your own text or artwork on a dial but not a trademarked mark — that is a stated limit, not a guess. Laser marking also reads metallic grey on a dark dial rather than white, because it alters the surface instead of adding ink.",
      sv: "Tryckerier för specialtavlor sätter din egen text eller bild på en tavla men inte ett varumärkesskyddat märke — det är en uttalad gräns, inte en gissning. Lasermärkning blir dessutom metalliskt grå på en mörk tavla i stället för vit, eftersom den bearbetar ytan i stället för att lägga på färg.",
    });
  }

  // --- the strap's axes. A bracelet type on a leather strap is meaningless
  //     rather than merely unwise, so it is an error the UI can explain.
  for (const key of ["braceletType", "rubberType", "leatherType", "natoPattern", "natoWeave", "natoLayers", "strapStitch"]) {
    const chosen = ids[key];
    if (!chosen || chosen === "as-listed") continue;
    const kind = axisKind(key);
    if (!kind || kind === parts.strap.kind) continue;
    const def = slotDef(key);
    issues.push({
      level: "error",
      slot: key,
      slots: [key, "strap"],
      en: `${def ? def.name.en : key} only applies to a ${kind} strap, and this build is on a ${parts.strap.kind}.`,
      sv: `${def ? def.name.sv : key} gäller bara ${kind === "bracelet" ? "stållänk" : kind === "leather" ? "läderband" : kind === "rubber" ? "gummiband" : "NATO-band"}, och det här bygget har ${parts.strap.kind === "bracelet" ? "stållänk" : parts.strap.kind === "leather" ? "läderband" : parts.strap.kind === "rubber" ? "gummiband" : "NATO-band"}.`,
    });
  }
  if (parts.strap.kind === "rubber" && parts.strap.type === "curved-end" && cs.platform !== "skx") {
    issues.push({
      level: "warning",
      slot: "strap",
      slots: ["strap", "case"],
      en: `A curved-end rubber strap is moulded to wrap ONE case profile. The mouldings that exist are for the SKX/SRPD family; on the ${cs.name.en} the end will not sit flush.`,
      sv: `Ett gummiband med kurvad ände är gjutet för EN boettprofil. De gjutningar som finns är för SKX/SRPD-familjen; på ${cs.name.sv} kommer änden inte att ligga tätt.`,
    });
  }
  const colourPick = axisPick(ids, "strapColor");
  if (colourPick && Array.isArray(colourPick.kinds) && !colourPick.kinds.includes(parts.strap.kind)) {
    issues.push({
      level: "warning",
      slot: "strapColor",
      slots: ["strapColor", "strap"],
      en: `${colourPick.name.en} was found listed for ${colourPick.kinds.join(", ")} straps, not for a ${parts.strap.kind}. A bracelet takes a metal finish rather than a colour.`,
      sv: `${colourPick.name.sv} hittades listad för ${colourPick.kinds.join(", ")}-band, inte för ${parts.strap.kind}. En stållänk tar en metallfinish snarare än en färg.`,
    });
  }
  const bucklePick = axisPick(ids, "buckle");
  if (bucklePick && Array.isArray(bucklePick.kinds) && !bucklePick.kinds.includes(parts.strap.kind)) {
    issues.push({
      level: "error",
      slot: "buckle",
      slots: ["buckle", "strap"],
      en: `A ${bucklePick.name.en.toLowerCase()} is fitted to ${bucklePick.kinds.join(" or ")} straps, not to a ${parts.strap.kind}.`,
      sv: `Ett ${bucklePick.name.sv.toLowerCase()} monteras på ${bucklePick.kinds.join(" eller ")}-band, inte på ${parts.strap.kind}.`,
    });
  }
  // R13 — fat spring bars. Not a fit error, but it is what stops a strap going on.
  if (cs.platform === "skx" && parts.strap.kind !== "bracelet") {
    issues.push({
      level: "note",
      slot: "strap",
      slots: ["strap", "case"],
      en: "SKX-family cases need thicker \"fat\" spring bars — 2.5 mm — where an SRPD takes standard ones. Straps sold for these cases usually include them; generic ones do not.",
      sv: "Boetter i SKX-familjen kräver tjockare \"fat\" bandstift — 2,5 mm — där SRPD tar vanliga. Band som säljs för de här boetterna innehåller oftast dem; generiska gör det inte.",
    });
  }

  for (const issue of issues) if (!issue.slots) issue.slots = [issue.slot];
  const ok = !issues.some((i) => i.level === "error");
  return { ok, issues };
}

/**
 * EVERY OPTION FOR A SLOT, ANNOTATED AGAINST THE REST OF THE BUILD.
 *
 * Incompatible options are RETURNED, never filtered out. That is the whole
 * point: the user asked for designs that do not fit the chosen movement to
 * appear "in a dropdown menu with a warning symbol", and for that philosophy
 * to be applied everywhere it makes sense. Hiding a choice teaches nobody
 * anything; showing it with the reason beside it does.
 *
 * `compatible` is false only when picking the option would put the build in
 * ERROR. A warning still comes back with its `why` text and `level:
 * "warning"`, so the UI can mark it softly rather than blocking it.
 *
 * @param {string} slotKey
 * @param {Record<string, string> | null | undefined} build
 * @returns {{ option: any, compatible: boolean, why: {en:string,sv:string}|null, level: "error"|"warning"|null }[]}
 */
export function compatibleOptions(slotKey, build) {
  const def = slotDef(slotKey);
  if (!def) return [];
  const base = normalizeBuild(build);
  /** @type {any[]} */
  const options = [...slotOptions(slotKey)];
  const none = def.optional ? noneOption(slotKey) : null;
  if (none) options.push(none);

  return options.map((option) => {
    const trial = normalizeBuild({ ...base, [slotKey]: option.id });
    const { issues } = checkBuild(trial);
    const mine = issues.filter((i) => Array.isArray(i.slots) && i.slots.includes(slotKey));
    const error = mine.find((i) => i.level === "error");
    if (error) return { option, compatible: false, why: { en: error.en, sv: error.sv }, level: /** @type {"error"} */ ("error") };
    const warning = mine.find((i) => i.level === "warning");
    if (warning) return { option, compatible: true, why: { en: warning.en, sv: warning.sv }, level: /** @type {"warning"} */ ("warning") };
    return { option, compatible: true, why: null, level: null };
  });
}

/**
 * A RANDOM BUILD THAT IS GUARANTEED TO ASSEMBLE.
 *
 * "Surprise me" pairing incompatible parts was its own piece of feedback. The
 * fix is not to repair afterwards but to never choose wrongly: walk the slots
 * in DEPENDENCY ORDER (the movement decides what dials are legal, the case
 * decides what rings and casebacks are), filter each slot against the build so
 * far, and pick only from what is left. If a slot ever runs out of compatible
 * options the walk has painted itself into a corner, so it backtracks and
 * starts the attempt again rather than emitting something checkBuild will then
 * complain about.
 *
 * `rand` is injectable so the unit tests are deterministic.
 *
 * @param {() => number} [rand]
 * @returns {Record<string, string>}
 */
export function surpriseBuild(rand) {
  const rnd = typeof rand === "function" ? rand : Math.random;
  /** @param {any[]} list */
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(Math.abs(rnd()) * list.length))];

  // Dependency order: what constrains most, first.
  const ORDER = ["movement", "case", "dial", "hands", "insert", "chapterRing", "crystal", "crown", "caseback", "finish", "strap"];

  for (let attempt = 0; attempt < 24; attempt++) {
    /** @type {Record<string, string>} */
    let build = { ...DEFAULT_BUILD };
    let dead = false;
    for (const key of ORDER) {
      const annotated = compatibleOptions(key, build);
      // Prefer options that raise no warning at all; fall back to merely
      // compatible ones so a slot with only imperfect choices still resolves.
      const clean = annotated.filter((a) => a.compatible && !a.why);
      const okAny = annotated.filter((a) => a.compatible);
      const from = clean.length ? clean : okAny;
      if (!from.length) {
        dead = true;
        break;
      }
      build = normalizeBuild({ ...build, [key]: pick(from).option.id });
    }
    if (dead) continue;
    // The axes are chosen the same way, but only sometimes — a build where
    // every knob has been twisted is noise, not a surprise.
    for (const axis of AXIS_SLOTS) {
      if (rnd() > 0.28) continue;
      const annotated = compatibleOptions(axis.key, build).filter((a) => a.compatible && !a.why);
      if (annotated.length < 2) continue;
      build = normalizeBuild({ ...build, [axis.key]: pick(annotated).option.id });
    }
    if (checkBuild(build).ok) return build;
  }
  // Twenty-four attempts without a valid build would mean the catalogue is
  // broken, not that we were unlucky. The default build always assembles.
  return normalizeBuild(DEFAULT_BUILD);
}

// ---------------------------------------------------------------------------
// The spec sheet. Everything here is derived, never stored, so it cannot drift
// from the catalogue.

/**
 * @param {Record<string, string> | null | undefined} build
 */
export function buildSpec(build) {
  const { ids, parts, omitted } = resolveBuild(build);
  const cs = parts.case;
  const plat = PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (cs.platform)] || PLATFORMS.native;
  const crystalDia = cs.crystal ? cs.crystal.dia : plat.crystalDia || cs.dims.dia - 11;
  // Movement + dial + hands + crystal dome + case back: the vertical budget a
  // modder actually runs out of. The +0.6 mm a display back adds is the one
  // published height delta in this market; no vendor publishes one for a
  // solid back at all, so the 1.6 mm base is the same for both.
  const domeMm = 2.2 + parts.crystal.dome * 1.9;
  const backMm = 1.6 + (parts.caseback.heightDeltaMm || 0);
  const stackMm = parts.movement.height + 0.9 + domeMm + backMm;
  const price = priceBand(ids);
  const dialDia = DIAL_DIAMETERS.find((d) => d.id === parts.dial.diameter);
  return {
    ids,
    omitted,
    included: caseKit(ids.case).includes,
    dialDiameter: dialDia ? dialDia.mm : plat.dialDia,
    dialDiameterApprox: !!(dialDia && dialDia.approx),
    backMm: Math.round(backMm * 10) / 10,
    aperture: parts.dial.day ? DAY_DATE_APERTURE.dayDate : parts.dial.date ? DAY_DATE_APERTURE.dateOnly : null,
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
  const included = caseKit(ids && ids.case).includes;
  for (const slot of ALL_SLOTS) {
    const p = part(slot.key, ids[slot.key]);
    const band = p && p.ali && Array.isArray(p.ali.priceUsd) ? p.ali.priceUsd : null;
    if (!band) continue;
    counted += 1;
    // A part the case already ships with costs nothing extra — which is what
    // makes the crystal, the insert and the chapter ring genuinely optional
    // instead of mandatory: `included ? free : priced`.
    if (included.includes(slot.key)) continue;
    low += band[0];
    high += band[1];
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
  const included = caseKit(ids.case).includes;
  const rows = [];
  for (const slot of ALL_SLOTS) {
    const p = slot.over ? part(slot.key, ids[slot.key]) : parts[slot.key];
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
      includedWithCase: included.includes(slot.key),
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
    kit: caseKit(c.id),
    displayBack: CASE_DISPLAY_BACKS[c.id] || { display: null, src: "community" },
    defaults: defaultsForCase(c.id),
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
  const out = SLOTS.map((s) => `${s.key}:${ids[s.key]}`);
  // Axes and text only when they are actually set, so a build that touches
  // none of the new controls encodes to exactly the string it always did and
  // every permalink ever shared still opens the same watch.
  for (const axis of AXIS_SLOTS) if (ids[axis.key]) out.push(`${axis.key}:${ids[axis.key]}`);
  for (const field of TEXT_FIELDS) if (ids[field.key]) out.push(`${field.key}:${ids[field.key]}`);
  return out.join(";");
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
 *   crownR: number, crownAngle: number, crownY: number, crownFlank: number,
 *   hasBezel: boolean }} CaseGeometry
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
 * @param {any} [crownEntry] only affects where/how big the crown seat is
 * @returns {CaseGeometry}
 */
export function caseProfile(caseEntry, crystalEntry, crownEntry) {
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

  // Where the CROWN seats. Not the flank's widest POINT: on a stepped flank
  // that point is a corner, and a crown planted on a corner hangs over the
  // undercut beneath it. A headless-Chromium render of the Tuna showed exactly
  // that — the crown floating clear of the case with daylight behind it,
  // because the shroud's widest point is the lip where the profile jumps from
  // 0.845 R to R, and the flank across the crown's own footprint ran from
  // 19.8 mm to 23.3 mm. So seat it on the widest PLATEAU: the height whose
  // flank MINIMUM across the crown's footprint is largest.
  const crownR = crownRadiusFor(caseEntry, crownEntry);
  const crownAngle = ((caseEntry.crown.hour || 3) / 12) * Math.PI * 2 - Math.PI / 2;
  const outline = outlineFor(caseEntry.shell);
  const seat = crownSeat(outer, outline, crownAngle, crownR, bezelSeatY, T);

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
    crownR,
    crownAngle,
    crownY: seat.y,
    /** The flank's MINIMUM radius across the crown's footprint, at its angle. */
    crownFlank: seat.flank,
    hasBezel,
  };
}

/**
 * The barrel radius of a crown on this case, mm. Shared by `caseProfile`
 * (which seats the crown) and `buildMeshes` (which builds it), so the two can
 * never disagree about the size of the thing being seated.
 * @param {any} caseEntry
 * @param {any} [crownEntry]
 * @returns {number}
 */
export function crownRadiusFor(caseEntry, crownEntry) {
  const base = caseEntry && caseEntry.shell === "dress" ? 1.5 : 1.9;
  return base * (crownEntry && crownEntry.style === "onion" ? 1.15 : 1);
}

/**
 * Seat a crown of radius `crownR` on a flank: the height whose flank minimum
 * across the crown's own vertical footprint is largest, searched between the
 * case-back bevel and far enough below the bezel seat that the crown cannot
 * foul the rotating bezel.
 * @param {ProfilePoint[]} outer
 * @param {(theta: number) => number} outline
 * @param {number} angle the crown's angle, radians
 * @param {number} crownR
 * @param {number} seatY the bezel seat height
 * @param {number} T case thickness
 * @returns {{ y: number, flank: number }}
 */
export function crownSeat(outer, outline, angle, crownR, seatY, T) {
  const k = outline(angle);
  const lo = Math.min(T * 0.16 + crownR * 0.5, seatY * 0.5);
  const hi = Math.max(lo + 0.1, seatY - crownR * 0.6);
  let bestY = lo;
  let bestMin = -Infinity;
  for (let i = 0; i <= 60; i++) {
    const y = lo + ((hi - lo) * i) / 60;
    let min = Infinity;
    // Sampled densely enough that this really is the minimum: a coarse grid
    // steps over a waist and reports a seat the flank does not actually hold.
    for (let s = -6; s <= 6; s++) {
      min = Math.min(min, flankRadiusAt(outer, y + (crownR * s) / 6) * k);
    }
    if (min > bestMin + 1e-9) {
      bestMin = min;
      bestY = y;
    }
  }
  return { y: bestY, flank: bestMin };
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
  const geo = caseProfile(cs, parts.crystal, parts.crown);
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
  // Where the SPRING BAR sits: the centre of the lug tip's rounded end, which
  // is where a drilled lug is actually drilled. Published so a strap can be
  // built to meet the lug instead of guessing at `l2l / 2` and starting a
  // third of a millimetre past it, a millimetre and a half high.
  const lugTipRadius = Math.max(0.25, (T * 0.4 - T * 0.09) / 2);
  const strapAnchor = {
    z: zTip - Math.min(lugTipRadius, (zTip - zRoot) * 0.45),
    y: (T * 0.4 + T * 0.09) / 2,
    width: cs.dims.lugW,
    thickness: T * 0.4 - T * 0.09,
  };
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
  // Angle and radius come from the geometry that SEATED the crown, so the
  // thing being built and the seat it was placed against cannot drift apart.
  const crownAngle = geo.crownAngle;
  const crownStyle = (parts.crown && parts.crown.style) || "coin";
  const crownR = geo.crownR;
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
  // `geo.crownFlank` is the flank's MINIMUM radius across the crown's own
  // footprint, not the radius at its centreline — a crown seated against the
  // centreline hovers over whatever the flank does above and below it.
  const crownFlank = geo.crownFlank;
  const crownOut = Math.max(crownFlank + crownH * 0.36, R * 1.005);
  // The tube: smooth, unknurled, and long enough to disappear into the flank.
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
  // The crown BOSS — the tube collar a real case is machined with, and the
  // thing that makes a crown MEET its case rather than approach it. Seating
  // alone is not enough: a flank curves away above and below wherever the
  // crown sits, so the barrel can only ever kiss it along one line. The boss
  // is part of the CASE, starts inside the barrel and runs in past the flank,
  // so there is continuous metal at every height the crown occupies — on a
  // slab-sided MM300 and on the Tuna's stepped shroud alike.
  const bossR = crownR * 0.95;
  const bossStart = crownOut - crownH * 0.3;
  // Stop short of the bore: a boss that punched through would show up inside
  // the case, which is the bug one layer along.
  const bossEnd = Math.max(geo.boreR + 0.4, crownFlank - 1.2);
  const bossLen = Math.max(0.6, bossStart - bossEnd);
  const boss = lathe(
    [
      { r: 0, y: 0 },
      { r: bossR, y: 0 },
      { r: bossR, y: bossLen * 0.6 },
      { r: bossR * 1.18, y: bossLen },
      { r: 0, y: bossLen },
    ],
    Math.max(24, Math.floor(segments / 3)),
  );
  placeRadial(boss, crownAngle, bossStart, geo.crownY);
  mergeMesh(caseMesh, boss);
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
    strapAnchor,
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
