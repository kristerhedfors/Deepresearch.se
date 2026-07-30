// @ts-check
// The NHxx WATCH-BUILDER domain's server FAÇADE: a pure re-export of the ONE
// shared core public/js/watch-core.js (the parts catalogue, the pre-indexed
// AliExpress sourcing table, the compatibility engine, the spec-sheet maths,
// the permalink codec and the geometry builders), plus the single endpoint the
// domain owns:
//
//   GET /api/watch/catalog   PUBLIC — the pre-indexed case/parts catalogue as
//                            JSON. Public because the /watch/ builder itself is
//                            an unauthenticated showcase page, exactly like
//                            /space/ and /pulse/: there is no identity on that
//                            page and none is invented. The payload is derived
//                            entirely from committed data — no user input, no
//                            outbound call, nothing per-account — so serving it
//                            signed out exposes nothing.
//
// WHY AN ENDPOINT AT ALL when the page imports the core directly: the index is
// the useful half of this feature for a NON-browser consumer. An agent, an MCP
// client or a shell in the sandbox can ask "which NH35 cases are there, what do
// they measure, and what do I search for on AliExpress" in one request, without
// running WebGL. `?slot=` narrows it to one parts family and `?case=` to one
// case family, so a caller does not have to pull the whole catalogue to answer
// a single question.
//
// NO NETWORK, EVER. The AliExpress index is a curated SEARCH index — query
// strings, brand names and price bands — not a scrape. This endpoint builds
// aliexpress.com URLs as strings and never fetches one, which is why it cannot
// leak a visitor's build to a third party and cannot break when a listing
// disappears (docs/WATCH-BUILDER.md §4).
//
// The core lives under public/ for the same reason bash-core.js and
// space-core.js do: the browser can only import served modules, the Worker
// bundler imports from anywhere — one implementation, two faces.

import { jsonResponse } from "./http.js";
import {
  MOVEMENTS,
  CASES,
  DIALS,
  HAND_SETS,
  INSERTS,
  CHAPTER_RINGS,
  CRYSTALS,
  CROWNS,
  CASEBACKS,
  STRAPS,
  FINISHES,
  PLATFORMS,
  SLOTS,
  AXIS_SLOTS,
  ALL_SLOTS,
  TEXT_FIELDS,
  SOURCES,
  ALI_BRANDS,
  HAND_TUBES,
  DIAL_DIA,
  DIAL_SPEC,
  DAY_DATE_APERTURE,
  DIAL_DESIGNS,
  DIAL_COLOURS,
  DIAL_FINISHES,
  DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES,
  DIAL_CALENDARS,
  DIAL_DIAMETERS,
  DIAL_FEET,
  DIAL_PRINTS,
  DIAL_LUME_OPTIONS,
  DATE_WHEELS,
  DAY_WHEELS,
  DAY_WHEEL_LANGUAGES,
  INSERT_MATERIALS,
  INSERT_PROFILES,
  CRYSTAL_EDGES,
  CRYSTAL_ARS,
  CHAPTER_PRINTINGS,
  CASEBACK_ENGRAVINGS,
  CASEBACK_FINISHES,
  CROWN_TEXTURES,
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
  SHEEN_LEVELS,
  WRIST_HOLDER,
  STRAP_EXIT,
  CASE_KITS,
  CASE_DISPLAY_BACKS,
  LUMES,
  DEFAULT_BUILD,
  slotOptions,
  slotDef,
  noneOption,
  part,
  caseKit,
  displayBackFor,
  defaultsForCase,
  normalizeBuild,
  resolveBuild,
  checkBuild,
  compatibleOptions,
  surpriseBuild,
  buildSpec,
  priceBand,
  sourcingFor,
  caseIndex,
  aliSearchUrl,
  encodeBuild,
  decodeBuild,
  buildMeshes,
  lathe,
  cone,
  annulus,
  box,
  extrude,
  outlineFor,
  caseProfile,
  crystalMesh,
  strapMesh,
  handOutline,
  dialLayout,
  bezelLayout,
  mm,
  outlineSlopeFor,
  slopeOf,
  knurl,
  placeRadial,
  flankRadiusAt,
  silhouetteZ,
  lugMesh,
  SHELL_ARCHETYPES,
  CRYSTAL_FAMILIES,
  crystalFamily,
  DIAL_METRICS,
  layoutBoxes,
  layoutCollisions,
} from "../public/js/watch-core.js";

export {
  MOVEMENTS,
  CASES,
  DIALS,
  HAND_SETS,
  INSERTS,
  CHAPTER_RINGS,
  CRYSTALS,
  CROWNS,
  CASEBACKS,
  STRAPS,
  FINISHES,
  PLATFORMS,
  SLOTS,
  AXIS_SLOTS,
  ALL_SLOTS,
  TEXT_FIELDS,
  SOURCES,
  ALI_BRANDS,
  HAND_TUBES,
  DIAL_DIA,
  DIAL_SPEC,
  DAY_DATE_APERTURE,
  DIAL_DESIGNS,
  DIAL_COLOURS,
  DIAL_FINISHES,
  DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES,
  DIAL_CALENDARS,
  DIAL_DIAMETERS,
  DIAL_FEET,
  DIAL_PRINTS,
  DIAL_LUME_OPTIONS,
  DATE_WHEELS,
  DAY_WHEELS,
  DAY_WHEEL_LANGUAGES,
  INSERT_MATERIALS,
  INSERT_PROFILES,
  CRYSTAL_EDGES,
  CRYSTAL_ARS,
  CHAPTER_PRINTINGS,
  CASEBACK_ENGRAVINGS,
  CASEBACK_FINISHES,
  CROWN_TEXTURES,
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
  SHEEN_LEVELS,
  WRIST_HOLDER,
  STRAP_EXIT,
  CASE_KITS,
  CASE_DISPLAY_BACKS,
  LUMES,
  DEFAULT_BUILD,
  slotOptions,
  slotDef,
  noneOption,
  part,
  caseKit,
  displayBackFor,
  defaultsForCase,
  normalizeBuild,
  resolveBuild,
  checkBuild,
  compatibleOptions,
  surpriseBuild,
  buildSpec,
  priceBand,
  sourcingFor,
  caseIndex,
  aliSearchUrl,
  encodeBuild,
  decodeBuild,
  buildMeshes,
  lathe,
  cone,
  annulus,
  box,
  extrude,
  outlineFor,
  caseProfile,
  crystalMesh,
  strapMesh,
  handOutline,
  dialLayout,
  bezelLayout,
  mm,
  outlineSlopeFor,
  slopeOf,
  knurl,
  placeRadial,
  flankRadiusAt,
  silhouetteZ,
  lugMesh,
  SHELL_ARCHETYPES,
  CRYSTAL_FAMILIES,
  crystalFamily,
  DIAL_METRICS,
  layoutBoxes,
  layoutCollisions,
};

/**
 * GET /api/watch/catalog — the pre-indexed catalogue.
 *
 *   (no params)      the case index + every parts family + the brand table
 *   ?case=<id>       one case family, expanded
 *   ?slot=<key>      one parts family (dial, hands, insert, …)
 *   ?build=<code>    resolve a permalink code into its spec sheet, fit check
 *                    and sourcing rows — the whole page's answer, without the
 *                    page
 *
 * Committed data only, so it is cacheable for an hour. Unknown ids answer 404
 * with the valid set rather than an empty object: a caller that guessed wrong
 * should be told what exists.
 *
 * @param {URL} url
 * @returns {Response}
 */
export function handleWatchCatalog(url) {
  const headers = { "cache-control": "public, max-age=3600" };
  const caseId = url.searchParams.get("case");
  const slotKey = url.searchParams.get("slot");
  // `has`, not `get`: an empty ?build= is still a request for a build, and it
  // must answer with the default rather than silently falling through to the
  // whole catalogue — the same degrade-don't-error posture the codec has.
  if (url.searchParams.has("build")) {
    const build = decodeBuild(url.searchParams.get("build") || "");
    return jsonResponse(
      {
        build,
        code: encodeBuild(build),
        spec: buildSpec(build),
        fit: checkBuild(build),
        sourcing: sourcingFor(build),
      },
      200,
      headers,
    );
  }

  if (caseId) {
    const row = caseIndex().find((c) => c.id === caseId);
    if (!row) {
      return jsonResponse(
        { error: "No such case.", cases: CASES.map((c) => c.id) },
        404,
      );
    }
    const full = CASES.find((c) => c.id === caseId);
    return jsonResponse(
      { case: { ...row, blurb: full ? full.blurb : null, note: full ? full.note : null }, platform: PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (row.platform)] },
      200,
      headers,
    );
  }

  if (slotKey) {
    const options = slotOptions(slotKey);
    if (!options.length) {
      return jsonResponse(
        { error: "No such slot.", slots: SLOTS.map((s) => s.key) },
        404,
      );
    }
    return jsonResponse({ slot: slotKey, options }, 200, headers);
  }

  return jsonResponse(
    {
      // The headline facts a builder needs before anything else.
      movement: { family: "Seiko/TMI NHxx", dialDia: DIAL_DIA, handTubes: HAND_TUBES },
      movements: MOVEMENTS,
      platforms: PLATFORMS,
      cases: caseIndex(),
      slots: SLOTS,
      parts: {
        finish: FINISHES,
        insert: INSERTS,
        dial: DIALS,
        chapterRing: CHAPTER_RINGS,
        hands: HAND_SETS,
        crystal: CRYSTALS,
        crown: CROWNS,
        caseback: CASEBACKS,
        strap: STRAPS,
      },
      // The orthogonal variables ON those parts — dial colour, dial finish,
      // insert profile, the date and day wheels, the strap's leather type and
      // so on. Additive: `parts` above keeps the exact shape it has always
      // answered in, and a caller that does not know about axes sees no change.
      axes: AXIS_SLOTS.map((a) => ({
        key: a.key,
        name: a.name,
        over: a.over,
        group: a.group,
        options: slotOptions(a.key),
      })),
      textFields: TEXT_FIELDS,
      dialSpec: DIAL_SPEC,
      aperture: DAY_DATE_APERTURE,
      brands: ALI_BRANDS,
      sources: SOURCES,
      defaultBuild: DEFAULT_BUILD,
      note:
        "Dimensions are read off the published sources named in `sources` and from mod-parts listings; anything with dims.approx or a *.approx flag is a listing figure, not a spec sheet. AliExpress links are search URLs built locally — this endpoint never contacts aliexpress.com.",
    },
    200,
    headers,
  );
}
