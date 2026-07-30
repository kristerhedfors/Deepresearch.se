// @ts-check
// The watch builder's MATERIAL TABLE: what each real material does to light,
// and which parts of a real dial stand proud of it.
//
// Split out of public/js/watch-render.js for the same reason watch-math.js
// was — the renderer needs a GL context to load, so nothing inside it can be
// Node-tested, and "is leather still matte?" is exactly the question a unit
// test should be able to ask. Nothing here touches a canvas, a GL context or
// the DOM: it is a lookup table, four resolvers that map a catalogue entry
// onto one, and the relief plan the dial painter follows.
//
// WHY THE NUMBERS LOOK LIKE THIS. Feedback #56 said the metals read as
// "ugly reflections, not realistic" and that leather "shouldn't be shiny like
// a mirror surface". Both come from the same root cause: the old renderer had
// ONE response — a metal one — and every part borrowed it, so a leather strap
// picked up the same environment reflection a polished bezel did. The fix is
// a real split:
//
//   * A CONDUCTOR (steel, gold, bronze, titanium, PVD) has no diffuse
//     response at all. Everything you see is the environment, tinted by the
//     metal's own reflectance at normal incidence — which is why `reflect`
//     below is a measured-ish luminance rather than a look-good guess, and
//     why the tint comes from the catalogue's colour through `tintedF0`
//     instead of a hard-coded swatch (change the catalogue colour and the
//     render follows it, which is the whole point of this builder).
//   * A DIELECTRIC (leather, rubber, nylon, ceramic, lacquer) reflects a few
//     percent at normal incidence — 0.02–0.08, never more — and everything
//     else it does is diffuse or, for the fibrous ones, SHEEN: the pale
//     grazing-angle glow of a surface covered in fine fibres. Suede is almost
//     pure diffuse plus sheen. That is what stops leather looking like a
//     mirror without also making it look like dead plastic.
//
// Reflectance sources: conductor F0 values are the standard tabulated ones
// (iron/steel ≈0.56–0.58, gold ≈(1.00,0.77,0.34), copper-rich bronze ≈0.7,
// titanium ≈0.5, aluminium ≈0.91). Dielectric F0 = ((n−1)/(n+1))²: sapphire
// n=1.77 → 0.077, mineral glass n=1.52 → 0.043, ceramic n≈1.7 → 0.067,
// leather/most polymers n≈1.4–1.5 → 0.03–0.05. Roughness, sheen and grain are
// art-directed — there is no table for "how brushed is a Seiko case flank" —
// but they are art-directed WITHIN the physical split above, not across it.
//
// No user-facing strings live here and nothing here routes intent, so this
// module carries no EN/SV surface of its own (invariant 6): the names the UI
// shows come from the catalogue in watch-core.js, which is already bilingual.

import { linear } from "./watch-math.js";

// ---------------------------------------------------------------------------
// How a surface's micro-grooves run. The renderer builds a tangent frame from
// this in OBJECT space, so it survives the model transform without needing
// per-vertex tangents (there are none: the core emits positions, normals and
// UVs only).

/** Isotropic: no preferred direction. */
export const ANISO_NONE = 0;
/** Circumferential about the axis — a lathe-brushed case flank, a bracelet
 * whose links follow the wrist arc (axis = the arc's axis). */
export const ANISO_CIRCUMFERENTIAL = 1;
/** Straight along the axis — a strap's length, a brushed lug top. */
export const ANISO_AXIAL = 2;
/** Radial, out from the axis — a sunburst dial, a sunray-brushed caseback. */
export const ANISO_RADIAL = 3;
/** Knurled: grooves parallel to the axis, repeating around it. A crown's
 * coin edge. Unlike the others this repeats a COUNT, not a pitch — a coin
 * edge has the same number of teeth whatever its diameter. */
export const ANISO_KNURL = 4;
/** Isotropic grain — pebbled leather, blasted steel, a rubber moulding. */
export const ANISO_GRAIN = 5;

/**
 * @typedef {Object} MaterialSpec
 * @property {number} rough      perceptual roughness, 0 (mirror) .. 1
 * @property {number} metal      0 dielectric .. 1 conductor
 * @property {number} reflect    normal-incidence reflectance: a luminance for
 *                               conductors, a scalar F0 for dielectrics
 * @property {number} [aniso]    0 .. 0.95, how stretched the highlight is
 * @property {number} [anisoMode] one of the ANISO_* constants
 * @property {number} [axis]     0 = object Y (every lathe in the core), 1 = X
 *                               (the bracelet's wrist arc), 2 = Z
 * @property {number} [grain]    micro-normal amplitude
 * @property {number} [grainFreq] grain cycles per millimetre (per turn for knurl)
 * @property {number} [env]      how much of the environment it mirrors, 0..1
 * @property {number} [sheen]    fibrous grazing-angle glow, 0..1
 * @property {string} [sheenColor]
 * @property {number} [coat]     clear-coat lobe strength (lacquer, patent)
 * @property {number} [coatRough]
 * @property {boolean} [glass]   routed through the renderer's crystal path
 * @property {string} note       why these numbers; kept short, kept honest
 */

/** @type {Record<string, MaterialSpec>} */
export const MATERIALS = {
  // --- conductors ----------------------------------------------------------
  "steel-brushed": {
    rough: 0.3, metal: 1, reflect: 0.57,
    aniso: 0.78, anisoMode: ANISO_CIRCUMFERENTIAL, axis: 0,
    grain: 0.03, grainFreq: 6, env: 1,
    note: "Lathe-brushed flank: the highlight stretches around the case, not across it.",
  },
  "steel-polished": {
    rough: 0.055, metal: 1, reflect: 0.62, env: 1,
    note: "A mirror. Almost everything it shows is the environment, so the environment has to be worth showing.",
  },
  "steel-blasted": {
    rough: 0.58, metal: 1, reflect: 0.55,
    anisoMode: ANISO_GRAIN, grain: 0.05, grainFreq: 34, env: 0.9,
    note: "Bead-blasted: isotropic pitting, no direction at all — the one steel finish with no streak.",
  },
  "steel-radial": {
    rough: 0.22, metal: 1, reflect: 0.6,
    aniso: 0.8, anisoMode: ANISO_RADIAL, axis: 0,
    grain: 0.02, grainFreq: 10, env: 1,
    note: "Sunray brushing on a bezel top or caseback: grooves run out from the centre.",
  },
  "pvd-black": {
    rough: 0.34, metal: 1, reflect: 0.2,
    aniso: 0.5, anisoMode: ANISO_CIRCUMFERENTIAL, axis: 0,
    grain: 0.022, grainFreq: 6, env: 0.85,
    note: "A coating over brushed steel: it keeps the streak but reflects a fifth as much.",
  },
  gold: {
    rough: 0.13, metal: 1, reflect: 0.78, env: 1,
    note: "Gold's F0 is strongly coloured — the tint belongs in the specular, not in a diffuse albedo.",
  },
  bronze: {
    rough: 0.42, metal: 1, reflect: 0.7,
    anisoMode: ANISO_GRAIN, grain: 0.03, grainFreq: 12, env: 0.95,
    note: "Copper-rich and never quite even; the grain stands in for the patina a worn bronze case picks up.",
  },
  titanium: {
    rough: 0.48, metal: 1, reflect: 0.55,
    aniso: 0.35, anisoMode: ANISO_CIRCUMFERENTIAL, axis: 0,
    grain: 0.035, grainFreq: 8, env: 0.9,
    note: "Darker and much less glossy than steel — that flatness is how you recognise it.",
  },
  "bracelet-brushed": {
    rough: 0.3, metal: 1, reflect: 0.57,
    aniso: 0.72, anisoMode: ANISO_CIRCUMFERENTIAL, axis: 1,
    grain: 0.028, grainFreq: 6, env: 1,
    note: "A bracelet is brushed ALONG its length; the links follow the wrist arc, so that is circumferential about X.",
  },
  "bracelet-polished": {
    rough: 0.07, metal: 1, reflect: 0.62, env: 1,
    note: "Polished centre links and a milanese mesh both read as mirror steel.",
  },
  // The crown's FLUTES are modelled geometry (watch-core.js knurls the lathe:
  // 30 ribs for a coin edge, 14 fluted, 12 onion), so nothing here re-cuts
  // them — a procedural groove at the same pitch but a different phase would
  // beat against the real one and look like a moiré. What is left to the
  // material is the SURFACE: the axial direction the milling cutter left,
  // which stretches every highlight along the tooth, plus a fine machining
  // texture far above the flute pitch so the two cannot be confused.
  "crown-knurled": {
    rough: 0.26, metal: 1, reflect: 0.58,
    aniso: 0.7, anisoMode: ANISO_KNURL, axis: 0,
    grain: 0.02, grainFreq: 96, env: 1,
    note: "Coin edge: the modelled teeth give the shape, the axial anisotropy gives the streak along each one.",
  },
  "crown-fluted": {
    rough: 0.2, metal: 1, reflect: 0.6,
    aniso: 0.6, anisoMode: ANISO_KNURL, axis: 0,
    grain: 0.02, grainFreq: 96, env: 1,
    note: "Fluting is fewer, deeper cuts than a coin edge and polished between them, so it reads brighter.",
  },
  "hands-polished": {
    rough: 0.07, metal: 1, reflect: 0.62, env: 1,
    note: "Polished hands are mirrors: they go black, then flash, as they sweep. That flash is the point.",
  },

  // --- dielectrics: strap leathers ----------------------------------------
  leather: {
    rough: 0.6, metal: 0, reflect: 0.035, env: 0.06,
    sheen: 0.12, sheenColor: "#7a6350",
    anisoMode: ANISO_GRAIN, grain: 0.05, grainFreq: 26,
    note: "Smooth calf: a broad, weak, wide-angle sheen. It must never show the softbox as a shape.",
  },
  "leather-oiled": {
    rough: 0.45, metal: 0, reflect: 0.04, env: 0.12,
    sheen: 0.16, sheenColor: "#7d6248",
    anisoMode: ANISO_GRAIN, grain: 0.045, grainFreq: 22,
    note: "Oiled/waxed hides sit between calf and shell — a little wetter, still not a mirror.",
  },
  "leather-suede": {
    rough: 0.95, metal: 0, reflect: 0.018, env: 0.015,
    sheen: 0.34, sheenColor: "#9d8b76",
    anisoMode: ANISO_GRAIN, grain: 0.03, grainFreq: 60,
    note: "Nap, not surface: almost pure diffuse, and what gloss there is lives entirely at grazing angles.",
  },
  "leather-nubuck": {
    rough: 0.9, metal: 0, reflect: 0.02, env: 0.02,
    sheen: 0.3, sheenColor: "#9a8975",
    anisoMode: ANISO_GRAIN, grain: 0.035, grainFreq: 48,
    note: "Sanded grain side — slightly tighter nap than suede, otherwise the same story.",
  },
  "leather-shell": {
    rough: 0.3, metal: 0, reflect: 0.05, env: 0.4,
    sheen: 0.1, sheenColor: "#6f4d3a", coat: 0.25, coatRough: 0.25,
    note: "Shell cordovan is glassy for a leather: a real second lobe, but a soft one.",
  },
  "leather-patent": {
    rough: 0.1, metal: 0, reflect: 0.05, env: 0.95,
    coat: 0.6, coatRough: 0.08,
    note: "The one leather that IS a mirror — because it is a lacquer film over the hide.",
  },
  "leather-croc": {
    rough: 0.42, metal: 0, reflect: 0.045, env: 0.14,
    sheen: 0.14, sheenColor: "#7a6350",
    anisoMode: ANISO_GRAIN, grain: 0.09, grainFreq: 9,
    note: "Embossed scale pattern: coarse relief, and glossier on the raised scales than between them.",
  },

  // --- dielectrics: other straps ------------------------------------------
  rubber: {
    rough: 0.52, metal: 0, reflect: 0.05, env: 0.1,
    anisoMode: ANISO_GRAIN, grain: 0.04, grainFreq: 18,
    note: "A soft, wide highlight that never resolves into a shape — vulcanised rubber has no polish.",
  },
  nylon: {
    rough: 0.78, metal: 0, reflect: 0.04, env: 0.04,
    sheen: 0.3, sheenColor: "#93a0ad",
    aniso: 0.35, anisoMode: ANISO_AXIAL, axis: 1, grain: 0.05, grainFreq: 44,
    note: "Woven: the sheen runs along the weave, which on a NATO is along the strap.",
  },
  "nylon-seatbelt": {
    rough: 0.55, metal: 0, reflect: 0.045, env: 0.12,
    sheen: 0.34, sheenColor: "#9aa6b3",
    aniso: 0.55, anisoMode: ANISO_AXIAL, axis: 1, grain: 0.04, grainFreq: 36,
    note: "Seatbelt weave is tighter and shinier than webbing — the sheen is the whole look.",
  },

  // --- dielectrics: bezel inserts -----------------------------------------
  ceramic: {
    rough: 0.065, metal: 0, reflect: 0.067, env: 1,
    note: "Glossy and HARD: one small, sharp reflected softbox that travels as you turn it. Never a band across the ring.",
  },
  "aluminium-anodised": {
    rough: 0.46, metal: 0.35, reflect: 0.6,
    anisoMode: ANISO_RADIAL, axis: 0, grain: 0.03, grainFreq: 20, env: 0.75,
    note: "An oxide film over metal: half-metal is right here, but semi-MATTE — the old half-metal was glossy and caught the key light as one hard band.",
  },

  // --- dielectrics: dial finishes -----------------------------------------
  "dial-matte": {
    rough: 0.8, metal: 0, reflect: 0.04, env: 0.05,
    anisoMode: ANISO_GRAIN, grain: 0.015, grainFreq: 90,
    note: "Matte paint. Reads flat from every angle, which is what makes the applied indices pop off it.",
  },
  "dial-gloss": {
    rough: 0.11, metal: 0, reflect: 0.05, env: 1,
    coat: 0.35, coatRough: 0.08,
    note: "Lacquer: a dielectric film, so a bright small highlight over an unchanged dark body.",
  },
  "dial-sunburst": {
    rough: 0.26, metal: 0.85, reflect: 0.58,
    aniso: 0.88, anisoMode: ANISO_RADIAL, axis: 0, grain: 0.02, grainFreq: 90, env: 1,
    note: "A brushed metal disc. The bright bar that sweeps across it is radial anisotropy, not a painted gradient.",
  },
  "dial-fume": {
    rough: 0.17, metal: 0.45, reflect: 0.5,
    aniso: 0.7, anisoMode: ANISO_RADIAL, axis: 0, env: 1, coat: 0.4, coatRough: 0.09,
    note: "Sunburst under a sprayed, darkening lacquer: the anisotropy stays, a coat lobe goes on top.",
  },
  "dial-textured": {
    rough: 0.55, metal: 0.35, reflect: 0.5, env: 0.8,
    anisoMode: ANISO_GRAIN, grain: 0.05, grainFreq: 34,
    note: "Snowflake/stamped: genuinely three-dimensional, so it gets real relief as well as a rough response.",
  },
  "dial-guilloche": {
    rough: 0.3, metal: 0.55, reflect: 0.55, env: 0.9,
    aniso: 0.3, anisoMode: ANISO_RADIAL, axis: 0,
    note: "Engine-turned metal: cut, not printed, so the pattern is relief and the metal underneath still shines.",
  },
  "chapter-ring": {
    rough: 0.28, metal: 0.7, reflect: 0.58,
    aniso: 0.5, anisoMode: ANISO_RADIAL, axis: 0, env: 0.95,
    note: "A printed metal rehaut, angled up at the crystal — semi-bright, radially finished.",
  },
  "lume-plate": {
    rough: 0.85, metal: 0, reflect: 0.04, env: 0.04,
    note: "Lume compound is chalky. Its brightness comes from the glow term, never from a highlight.",
  },
  "wrist-leather": {
    rough: 0.72, metal: 0, reflect: 0.03, env: 0.04,
    sheen: 0.18, sheenColor: "#8a7360",
    anisoMode: ANISO_GRAIN, grain: 0.055, grainFreq: 14,
    note: "The leather display cylinder the watch sits on: a prop, so it must never out-shine the watch.",
  },

  // --- transparent ---------------------------------------------------------
  sapphire: {
    rough: 0.02, metal: 0, reflect: 0.077, env: 1, glass: true,
    note: "n=1.77. Anti-reflective coating drops the visible F0 by an order of magnitude — see crystalMaterial.",
  },
  mineral: {
    rough: 0.03, metal: 0, reflect: 0.043, env: 1, glass: true,
    note: "Hardlex/mineral, n=1.52: a touch less reflective than sapphire and much softer.",
  },
};

/** The response used for anything the resolvers cannot place. */
export const FALLBACK_MATERIAL = "steel-brushed";

/**
 * Fallback swatches, for the parts whose colour the catalogue does not supply
 * — a mesh a geometry module adds (the leather wrist cylinder, a buckle)
 * arrives with a material id and nothing else. Never consulted when the
 * caller passes a colour, which is the normal path.
 * @type {Record<string, string>}
 */
export const DEFAULT_COLORS = {
  "wrist-leather": "#4a3a2e",
  leather: "#4a3226",
  "leather-oiled": "#4b3220",
  "leather-suede": "#5a4a3c",
  "leather-nubuck": "#584839",
  "leather-shell": "#4a2620",
  "leather-patent": "#17181c",
  "leather-croc": "#3d2a20",
  rubber: "#15171b",
  nylon: "#2b3038",
  "nylon-seatbelt": "#2f353e",
  ceramic: "#0a0b0e",
  "aluminium-anodised": "#111318",
  "lume-plate": "#dfe4ea",
  sapphire: "#dfe9f5",
  mineral: "#e0e7ef",
};

/**
 * Tint a conductor's F0 with the catalogue's colour while putting it at the
 * right LEVEL. The catalogue picks colours to look right in a swatch, which
 * is not the same thing as a reflectance: `#c8a253` for gold is far too dark
 * to be gold's F0. Keeping the hue and rescaling the luminance means the
 * builder's colour choice still drives the render — change the swatch and the
 * metal changes with it — without the render inheriting a swatch's brightness.
 *
 * Dielectrics get a neutral F0: their specular colour is white regardless of
 * what colour the body is, which is precisely the difference between a metal
 * and a painted surface.
 *
 * @param {number[]} rgb linear albedo
 * @param {number} reflect target normal-incidence reflectance
 * @param {number} metal
 * @returns {number[]} linear F0
 */
export function tintedF0(rgb, reflect, metal) {
  if (!(metal > 0.2)) return [reflect, reflect, reflect];
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  // Scale to the target luminance, but never past the point where a channel
  // would exceed 1 — no surface reflects more than all of the light. A very
  // saturated swatch therefore lands a little under its target rather than
  // clipping, which would bend the hue the catalogue chose.
  const k = Math.min(lum > 1e-4 ? reflect / lum : 1, peak > 1e-4 ? 1 / peak : 1);
  return rgb.map((c) => Math.max(0.02, c * k));
}

/**
 * One catalogue entry + one colour → everything the shader needs. The colour
 * is separate because the same material serves several catalogue entries: one
 * `leather`, six strap colours.
 *
 * @param {string} id a key of MATERIALS
 * @param {string|number[]} [color] a hex swatch, or an already-linear triple
 */
export function materialFor(id, color) {
  const key = MATERIALS[id] ? id : FALLBACK_MATERIAL;
  const spec = MATERIALS[key];
  const rgb = Array.isArray(color)
    ? color.slice()
    : linear(color || DEFAULT_COLORS[key] || "#8d949d");
  const metal = spec.metal;
  return {
    id: key,
    color: rgb,
    f0: tintedF0(rgb, spec.reflect, metal),
    rough: spec.rough,
    metal,
    aniso: spec.aniso || 0,
    anisoMode: spec.anisoMode || ANISO_NONE,
    axis: spec.axis || 0,
    grain: spec.grain || 0,
    grainFreq: spec.grainFreq || 0,
    env: spec.env === undefined ? 0.25 : spec.env,
    sheen: spec.sheen || 0,
    sheenColor: spec.sheen ? linear(spec.sheenColor || "#8b8b8b") : [0, 0, 0],
    coat: spec.coat || 0,
    coatRough: spec.coatRough || 0.1,
    glass: !!spec.glass,
  };
}

// ---------------------------------------------------------------------------
// ENERGY CONSERVATION WHEN A SOURCE IS BLURRED.
//
// Both formulas below are mirrored inline in watch-render.js's fragment
// shader, which cannot import anything. They live here because they are the
// two lines that decide whether a metal reads as metal or as white plastic,
// and because a one-line formula is exactly the kind of thing that gets
// "simplified" back out by someone who reads it as an arbitrary fudge.
//
// The bug they fix, found in a real-browser check of the first version of
// this renderer (feedback #56 follow-up): a brushed steel bracelet rendered
// as flat white while the case body beside it stayed correctly grey. Two
// independent causes, both energy being invented rather than moved:
//
//   1. The procedural softbox WIDENED with roughness and stayed just as
//      bright, so a rough surface received several times the source's power.
//   2. Each analytic light was a delta source with a normalised GGX lobe,
//      whose peak goes to infinity as the surface smooths. A curved case
//      flank puts only a thin band at that peak; the flat, near-parallel
//      faces of a bracelet link put the WHOLE face there at once.
//
// Neither shows up on a dielectric — leather's lobe is already wider than any
// real source — which is why the leather half of the same frame looked right.

/**
 * How much a blurred area source dims as it spreads. Power is conserved, so
 * radiance falls with the solid angle it is spread over, and solid angle goes
 * as the square of the half-width.
 * @param {number} hw0 the source's own half-width
 * @param {number} hw the half-width after roughness blurs it (>= hw0)
 * @returns {number} 0..1
 */
export function softboxEnergy(hw0, hw) {
  if (!(hw > 0)) return 1;
  return Math.min(1, (hw0 * hw0) / (hw * hw));
}

/**
 * How much a specular lobe dims when it is widened to the angular size of the
 * source that lights it. `at`/`ab` are the surface's own GGX widths along the
 * two tangent axes; `amin` is the source's. The result multiplies a lobe
 * evaluated at the WIDENED widths, so the peak is capped without the total
 * changing.
 * @param {number} at
 * @param {number} ab
 * @param {number} amin
 * @returns {number} 0..1
 */
export function lobeEnergy(at, ab, amin) {
  const at2 = Math.max(at, amin);
  const ab2 = Math.max(ab, amin);
  if (!(at2 > 0 && ab2 > 0)) return 1;
  return Math.min(1, (at * ab) / (at2 * ab2));
}

// ---------------------------------------------------------------------------
// Resolvers: catalogue entry → material id. Every one of them reads an
// OPTIONAL `material` field first, so the catalogue can name a material
// outright when it grows one (a new strap leather, a new insert substrate)
// without this module having to guess from a colour.

/**
 * The case finish. Anything unknown falls back to brushed steel rather than
 * to nothing, so a finish added to the catalogue still renders as metal.
 * @param {any} finish
 */
export function finishMaterialId(finish) {
  const id = String((finish && (finish.material || finish.id)) || "");
  if (MATERIALS[id]) return id;
  if (id === "brushed") return "steel-brushed";
  if (id === "polished") return "steel-polished";
  if (id === "blasted") return "steel-blasted";
  return FALLBACK_MATERIAL;
}

/**
 * A strap or bracelet. `kind` is the catalogue's coarse family; `material`
 * and `leather` are the finer grades the strap work adds ("suede", "nubuck",
 * "shell", "croc", "seatbelt").
 * @param {any} strap
 */
export function strapMaterialId(strap) {
  if (!strap) return "leather";
  const explicit = String(strap.material || "");
  if (MATERIALS[explicit]) return explicit;
  const kind = String(strap.kind || "");
  const grade = String(strap.leather || strap.grade || strap.weave || explicit || "").toLowerCase();
  if (kind === "bracelet") {
    const f = String(strap.finish || "").toLowerCase();
    if (f === "polished" || strap.id === "mesh") return "bracelet-polished";
    return "bracelet-brushed";
  }
  if (kind === "rubber" || kind === "silicone" || kind === "fkm") return "rubber";
  if (kind === "nato" || kind === "nylon" || kind === "fabric" || kind === "canvas") {
    return grade.includes("seatbelt") ? "nylon-seatbelt" : "nylon";
  }
  if (kind === "leather" || kind === "suede" || kind === "nubuck" || grade) {
    const g = grade || kind;
    if (g.includes("suede")) return "leather-suede";
    if (g.includes("nubuck")) return "leather-nubuck";
    if (g.includes("shell") || g.includes("cordovan")) return "leather-shell";
    if (g.includes("patent")) return "leather-patent";
    if (g.includes("croc") || g.includes("alligator") || g.includes("gator")) return "leather-croc";
    if (g.includes("oil") || g.includes("wax") || g.includes("horween")) return "leather-oiled";
    return "leather";
  }
  return "leather";
}

/**
 * A bezel insert. This is the one feedback #56 singled out ("lighting looks
 * odd, especially for bezel inserts"): the renderer used to give EVERY insert
 * one half-metal response, so a matte anodised aluminium insert and a glossy
 * ceramic one caught the key light identically, as a hard band across the
 * whole ring. They are different materials and now behave like it.
 * @param {any} insert
 */
export function insertMaterialId(insert) {
  if (!insert) return "aluminium-anodised";
  const explicit = String(insert.material || insert.substrate || "");
  if (MATERIALS[explicit]) return explicit;
  const e = explicit.toLowerCase();
  if (e.includes("ceramic")) return "ceramic";
  if (e.includes("sapphire")) return "sapphire";
  if (e.includes("steel")) return "steel-radial";
  if (e.includes("alu")) return "aluminium-anodised";
  // No declared substrate: a plain steel bezel has no insert at all, and the
  // catalogue's `gloss` flag is exactly the ceramic/aluminium distinction.
  if (insert.scale === "none") return "steel-radial";
  return insert.gloss ? "ceramic" : "aluminium-anodised";
}

/**
 * A dial, by its finish.
 * @param {any} dial
 */
export function dialMaterialId(dial) {
  const explicit = String((dial && dial.material) || "");
  if (MATERIALS[explicit]) return explicit;
  const finish = String((dial && dial.finish) || "matte").toLowerCase();
  const byFinish = `dial-${finish}`;
  if (MATERIALS[byFinish]) return byFinish;
  if (finish.includes("guilloch") || finish.includes("clous") || finish.includes("waffle")) {
    return "dial-guilloche";
  }
  if (finish.includes("sun")) return "dial-sunburst";
  if (finish.includes("gloss") || finish.includes("lacquer")) return "dial-gloss";
  return "dial-matte";
}

/**
 * A crystal. AR coating is the whole difference between a crystal you can see
 * through and one you mostly see the sky in, so it moves the reflectance
 * rather than only the alpha.
 * @param {any} crystal
 */
export function crystalMaterial(crystal) {
  const id = String((crystal && crystal.material) || "sapphire");
  const base = MATERIALS[id] && MATERIALS[id].glass ? id : "sapphire";
  const m = materialFor(base, (crystal && crystal.tint) || "#dfe9f5");
  const ar = String((crystal && crystal.ar) || "none");
  // Single-layer AR takes ~4% down to well under 1%; the blue coatings sold
  // for these crystals are the ones that leave a visible cast at an angle.
  const k = ar === "none" ? 1 : ar === "blue" ? 0.28 : 0.2;
  m.f0 = m.f0.map((c) => c * k);
  return m;
}

/**
 * Anything the geometry core hands the renderer that the renderer does not
 * know by name. The geometry modules can publish a `materials` hint map
 * (mesh key → material id) and that wins; without one, a name heuristic keeps
 * a newly added mesh visible and plausible instead of silently metal.
 *
 * @param {string} key the mesh key from buildMeshes().meshes
 * @param {Record<string, string>} [hints] the geometry core's declared map
 */
export function meshMaterialId(key, hints) {
  const hinted = hints && hints[key];
  if (hinted && MATERIALS[hinted]) return hinted;
  const k = String(key || "").toLowerCase();
  if (/wrist|holder|cushion|pillow|roll|stand|display/.test(k)) return "wrist-leather";
  if (/strap|band/.test(k)) return "leather";
  if (/buckle|clasp|keeper|spring|screw|pin/.test(k)) return "steel-brushed";
  if (/lume|pip/.test(k)) return "lume-plate";
  if (/crystal|glass/.test(k)) return "sapphire";
  return FALLBACK_MATERIAL;
}

// ---------------------------------------------------------------------------
// RELIEF: which parts of a dial actually stand off it.
//
// Feedback #56 asked for "3d texture on dials where it should be". The last
// two words are the constraint. A dial is a mix of things that are physically
// proud of the surface, things cut into it, and things that are simply ink —
// and getting that wrong in the other direction (embossing printed text)
// looks worse than painting everything flat, because it reads as a fake.
//
// The rule this module encodes, for the dials this builder actually sources
// (NH35-compatible 28.5 mm dials from the AliExpress supply chain — NOT a
// claim about the Swiss originals they copy):
//
//   APPLIED (raised, with a polished metal edge): bar, dot and triangle
//   indices, and the faceted GS-style ones. On these dials they are metal
//   frames pressed into the plate with lume filled inside them — which is
//   also why the lume sits slightly BELOW the frame's top edge.
//
//   PRINTED (dead flat): the minute track, all dial text, and printed
//   numerals and Roman numerals. Painted numerals are the norm at this price;
//   applied numerals exist but are a different, dearer part, so the catalogue
//   would have to say so.
//
//   CUT (recessed): the date/day aperture, and a sandwich dial's cut-outs,
//   where the lume plate is a separate layer under the dial and you can see
//   the thickness of the plate at the edge of every hole.
//
//   STAMPED (relief across the whole plate): snowflake/textured dials,
//   guilloché, clous de Paris, waffle and linen. These are formed in the
//   metal. A SUNBURST is not: it is fine radial brushing, no height at all —
//   which is why it is handled as anisotropy in MATERIALS and produces no
//   relief here.

/** Marker kinds that are applied metal on these dials rather than ink. */
export const APPLIED_MARKER_KINDS = ["bar", "dot", "triangle", "facet"];

/**
 * @param {string} kind a `dialLayout()` marker kind
 * @returns {boolean}
 */
export function markerIsApplied(kind) {
  return APPLIED_MARKER_KINDS.indexOf(String(kind)) >= 0;
}

/**
 * The relief plan for one dial: what the painter should raise, cut and leave
 * alone. Pure, so the truthfulness rule above is a unit test rather than a
 * comment.
 *
 * @param {any} dial
 * @returns {{ markers: "applied"|"printed", ticks: "printed", text: "printed",
 *             date: "cut"|"none", pattern: string, patternDepth: number,
 *             sandwich: boolean, anisotropy: "radial"|"none" }}
 */
export function dialRelief(dial) {
  const finish = String((dial && dial.finish) || "matte").toLowerCase();
  const texture = String((dial && dial.texture) || "").toLowerCase();
  let pattern = "none";
  let patternDepth = 0;
  const named = texture || finish;
  if (named === "textured" || named.includes("snow")) {
    pattern = "snowflake";
    patternDepth = 0.5;
  } else if (named.includes("clous") || named.includes("hobnail")) {
    pattern = "clous";
    patternDepth = 0.8;
  } else if (named.includes("waffle") || named.includes("grid")) {
    pattern = "waffle";
    patternDepth = 0.7;
  } else if (named.includes("guilloch") || named.includes("barleycorn")) {
    pattern = "guilloche";
    patternDepth = 0.6;
  } else if (named.includes("linen") || named.includes("tapisserie")) {
    pattern = "linen";
    patternDepth = 0.45;
  }
  return {
    // Every dial in the catalogue paints its indices from the same
    // `dialLayout` kinds, so the applied/printed split is per MARKER, not per
    // dial; this field is the dial-level default the painter overrides
    // kind by kind.
    markers: "applied",
    ticks: "printed",
    text: "printed",
    date: dial && dial.date ? "cut" : "none",
    pattern,
    patternDepth,
    // A sandwich dial is a second plate: the catalogue has to declare it,
    // because you cannot tell one from a printed dial by its colours.
    sandwich: !!(dial && (dial.sandwich || dial.construction === "sandwich")),
    // Sunburst and fumé are brushed, not embossed: no height, all direction.
    anisotropy: finish === "sunburst" || finish === "fume" ? "radial" : "none",
  };
}
