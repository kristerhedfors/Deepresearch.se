// @ts-check
// THE EXTENSION REGISTRY — the clean cut between the platform core and the
// third-party services woven into research (owner directive, 2026-07-25).
//
// Google Maps / Street View and Shodan are EXAMPLE integrations: they
// demonstrate that the pipeline can fold outside data into a research turn,
// but nothing about the agent architecture depends on them, and the core
// must keep working — and keep reading — as if they did not exist. So this
// file is the ONE module in `src/` that the core is allowed to know about,
// and the ONE module that is allowed to name an individual third-party
// service at the architectural seam. Everything upstream of it (pipeline.js,
// enrichment.js, chat.js, settings.js, prompts.js, mcp.js, types.d.ts) talks
// to the registry generically; everything downstream of it (shodan.js,
// shodan-enrichment.js, googlemaps*.js, maps-enrichment.js) is free to be as
// service-specific as it likes.
//
// Adding an integration is therefore ONE descriptor here plus its own
// modules — no core file is edited, and `extensions.test.js` fails the build
// if a core file starts naming a service again.
//
// The five seams a descriptor owns (each consumed generically by core):
//   1. settings     — the per-account knob: wire key, availability, backing
//                     secret, the 503 when it isn't configured.
//   2. resolveState — request body → this extension's slice of `state.ext`.
//   3. enrichment   — the pre-pipeline runner (see src/enrichment.js).
//   4. logMeta      — what the slice contributes to chat.complete / chat_logs.
//   5. capability   — the line in the grounded capabilities note
//                     (src/prompts.js), so "what can you do?" stays factual.
//
// NOT everything external is an extension. The site's own source
// (introspection) is a core capability, and OpenStreetMap Nominatim
// reverse-geocoding runs unconditionally as part of reading an attached
// photo's metadata — neither has a knob or a service-specific request state,
// so neither is registered here.

import { googleMapsAvailable, googleMapsEmbedKey } from "./googlemaps.js";
import { runGoogleMapsEnrichment, validateMapView, validateStreetViewPov } from "./maps-enrichment.js";
import { shodanAvailable } from "./shodan.js";
import { runShodanEnrichment } from "./shodan-enrichment.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */
/** @typedef {import('./enrichment.js').Enrichment} Enrichment */

/**
 * The per-account knob an extension contributes. `key` and `availability`
 * are WIRE names (settings_json, PUT /api/settings, the `available` map the
 * client reads) and must not change once shipped.
 * @typedef {{
 *   key: string,
 *   availability: string,
 *   secret: string,
 *   available: (env: Env) => boolean,
 *   unavailableError: string,
 *   doc: string,
 * }} ExtensionSetting
 */

/**
 * One registered extension. `id` is the state-bag namespace, the enrichment
 * step/log slug, and the handle core code passes around.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   setting: ExtensionSetting,
 *   resolveState: (body: any, on: boolean) => Record<string, any>,
 *   enabled: (slice: any) => boolean,
 *   run: (ctx: EnrichmentCtx, slice: any) => Promise<Conversation>,
 *   logMeta: (slice: any) => Record<string, any>,
 *   payloadExtras?: (env: Env, on: boolean) => Record<string, any>,
 *   capability: { order: number, text: string },
 * }} Extension
 */

/**
 * The registry. Order is the ENRICHMENT order — each runner sees the
 * conversation as the previous one left it — and core enrichments run after
 * these (src/enrichment.js).
 * @type {Extension[]}
 */
export const EXTENSIONS = [
  {
    id: "shodan",
    label: "Shodan host intelligence",
    setting: {
      key: "shodan_mcp",
      availability: "shodan",
      secret: "SHODAN_API_KEY",
      available: (env) => shodanAvailable(env),
      unavailableError: "Shodan is not configured on this server (SHODAN_API_KEY missing).",
      doc:
        "default OFF (opt-in — enriching a query with Shodan sends the host/IP to a " +
        "third party, so it stays off until asked for).",
    },
    // Nothing to read off the body: the lookup targets are extracted from the
    // message itself (shodan.js extractTargets).
    resolveState: (_body, on) => ({ on, count: 0 }),
    enabled: (slice) => !!slice.on,
    run: (c, slice) => runShodanEnrichment(c.env, c.log, c.step, c.stepDone, c.conversation, slice),
    logMeta: (slice) => ({ shodan_hosts: slice.count || 0 }),
    capability: {
      order: 8,
      text:
        "Shodan host intelligence. When your message names an IP address or hostname, the site can look it up on Shodan and fold in its open ports, running services, hosting organization/ASN, location, and known CVEs, cited in the answer. Example: \"what services and known vulnerabilities does <hostname> expose?\". TURN ON/OFF: Account panel → Settings → \"Shodan host intelligence\", OFF by default (only the host/IP is sent to Shodan, never your question).",
    },
  },
  {
    id: "maps",
    label: "Google Maps & Street View",
    setting: {
      key: "google_maps",
      availability: "google_maps",
      secret: "GOOGLE_MAPS_API_KEY",
      available: (env) => googleMapsAvailable(env),
      unavailableError:
        "Google Maps is not configured on this server (GOOGLE_MAPS_API_KEY missing).",
      doc:
        "default OFF (opt-in — a named address / photo location is sent to Google Maps " +
        "Platform (Places + Street View + Static Maps) and the imagery fetches are billed, " +
        "so it stays off until asked for).",
    },
    // The client forwards what is on screen so a follow-up captures exactly
    // that view: street_view_pov = the panorama the user panned/moved,
    // map_view = the same idea for the interactive map, user_location =
    // browser geolocation (same shape as a map view — zoom ignored — so the
    // same validator applies), sent only for explicit "street view here"
    // asks with no live view on screen. All three are untrusted client input
    // and are sanitized here; they are read at all only when the knob is on.
    resolveState: (body, on) => ({
      on,
      count: 0,
      intent: undefined,
      pov: on ? validateStreetViewPov(body?.street_view_pov) : null,
      view: on ? validateMapView(body?.map_view) : null,
      userLocation: on ? validateMapView(body?.user_location) : null,
    }),
    enabled: (slice) => !!slice.on,
    // Unlike Shodan, the Maps runner also reads CORE state (the vision
    // describe-helper model and its token totals, the attached photos' GPS),
    // so it takes the whole state and reaches into its own slice itself.
    // Casts: `state.ext` is an open bag to core (types.d.ts ExtensionState),
    // so only this descriptor knows its own slice is present; and the runner
    // hands back conversation.js's looser Msg shape (appending blocks/images
    // can't loosen the roles the Conversation arrived with).
    run: (c) =>
      /** @type {Promise<Conversation>} */ (
        runGoogleMapsEnrichment(
          c.env, c.log, c.emit, c.step, c.stepDone, c.conversation,
          /** @type {import('./maps-enrichment.js').MapsState} */ (c.state),
        )
      ),
    logMeta: (slice) => ({
      google_maps: slice.count || 0,
      // Which intent matcher decided (or "none"/"anchor-missing") — the
      // routing trace scripts/chatlogs surfaces. Undefined (key dropped by
      // JSON.stringify) when the knob was off and the enrichment never ran.
      maps_intent: slice.intent,
    }),
    // Browser key for the interactive Street View embed — public by design,
    // safe because the key is HTTP-referrer-locked to the site. Sent only
    // when the caller can use Maps; empty string otherwise (the client then
    // shows the keyless link only).
    payloadExtras: (env, on) => ({ maps_embed_key: on ? googleMapsEmbedKey(env) : "" }),
    capability: {
      order: 9,
      text:
        "Google Maps & Street View. When your message names a street address (or you attach a photo carrying GPS location), the site looks it up on Google Maps Platform — resolving it with the Places API (canonical name, formatted address, place type, rating, business status and precise coordinates), confirming Google Street View coverage and its imagery capture date, and pulling a road map of the spot — then folds those details plus clickable Maps and Street View links into the research, hands several Street View angles around the location plus the map to a vision-capable model to describe, and (where coverage exists) shows an inline drag-to-navigate Street View in the answer. Example: \"what does the building at <street address> look like, and what's there?\". TURN ON/OFF: Account panel → Settings → \"Google Maps & Street View\", OFF by default (only the address or the photo's coordinates is sent to Google, never your whole question).",
    },
  },
];

/** @param {string} id */
export function getExtension(id) {
  return EXTENSIONS.find((e) => e.id === id) || null;
}

// ---- 1. settings seam (src/settings.js) ------------------------------------

/**
 * The knob defaults every extension contributes — all OFF: an extension
 * reaches a third party, so it is opt-in by construction and only an
 * explicit stored `true` enables it.
 * @returns {Record<string, boolean>}
 */
export function extensionSettingDefaults() {
  return Object.fromEntries(EXTENSIONS.map((e) => [e.setting.key, false]));
}

/**
 * The knob → availability wiring, for the generic settings handlers.
 * @returns {Array<{ id: string, key: string, availability: string, unavailableError: string }>}
 */
export function extensionSettingSpecs() {
  return EXTENSIONS.map((e) => ({
    id: e.id,
    key: e.setting.key,
    availability: e.setting.availability,
    unavailableError: e.setting.unavailableError,
  }));
}

/**
 * What the server can actually offer right now, per extension: its backing
 * secret must be present AND — like every per-user setting — there must be a
 * D1 user row to persist the knob against (break-glass has none).
 * @param {Env} env
 * @param {boolean} hasUserRow
 * @returns {Record<string, boolean>}
 */
export function extensionAvailability(env, hasUserRow) {
  return Object.fromEntries(
    EXTENSIONS.map((e) => [e.setting.availability, !!(e.setting.available(env) && hasUserRow)]),
  );
}

/**
 * Extra fields extensions add to the GET/PUT /api/settings payload (today:
 * the Maps embed key).
 * @param {Env} env
 * @param {Record<string, boolean>} available the featureAvailability map
 * @returns {Record<string, any>}
 */
export function extensionPayloadExtras(env, available) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const e of EXTENSIONS) {
    if (!e.payloadExtras) continue;
    Object.assign(out, e.payloadExtras(env, !!available[e.setting.availability]));
  }
  return out;
}

// ---- 2. per-request state seam (src/chat.js, src/mcp.js) -------------------

/**
 * Builds the whole `state.ext` bag: one namespaced slice per extension,
 * resolved from the request body and whether the extension is enabled for
 * this caller. Core never reads inside a slice.
 * @param {any} body the parsed request body ({} for channels with none)
 * @param {Record<string, boolean>} [enabledById] extension id → on
 * @returns {Record<string, any>}
 */
export function resolveExtensionState(body, enabledById = {}) {
  return Object.fromEntries(
    EXTENSIONS.map((e) => [e.id, e.resolveState(body || {}, !!enabledById[e.id])]),
  );
}

/**
 * Every extension off with nothing read off a body — the shape a channel
 * that applies no per-user knobs wants (src/mcp.js).
 * @returns {Record<string, any>}
 */
export function emptyExtensionState() {
  return resolveExtensionState({}, {});
}

// ---- 3. enrichment seam (src/enrichment.js) --------------------------------

/**
 * The extensions as core `Enrichment` entries: each reads only its own slice
 * of `state.ext`, so a state bag built without extensions simply yields no
 * enabled enrichment.
 * @returns {Enrichment[]}
 */
export function extensionEnrichments() {
  return EXTENSIONS.map((e) => ({
    id: e.id,
    enabled: (state) => e.enabled(sliceOf(state, e.id)),
    run: (c) => e.run(c, sliceOf(c.state, e.id)),
  }));
}

/**
 * @param {any} state
 * @param {string} id
 */
function sliceOf(state, id) {
  return state?.ext?.[id] || {};
}

// ---- 4. logging seam (src/chat.js) -----------------------------------------

/**
 * What the extensions contribute to `chat.complete` and the chat_logs meta.
 * Undefined values are kept as-is so JSON.stringify drops the key (that is
 * how `maps_intent` stays absent when the enrichment never ran).
 * @param {any} state the full request state
 * @returns {Record<string, any>}
 */
export function extensionLogMeta(state) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const e of EXTENSIONS) Object.assign(out, e.logMeta(sliceOf(state, e.id)));
  return out;
}

// ---- 5. capabilities seam (src/prompts.js) ---------------------------------

/**
 * The extensions' entries for the grounded capabilities note, each with the
 * position it claims in the numbered list.
 * @returns {Array<{ order: number, text: string }>}
 */
export function extensionCapabilities() {
  return EXTENSIONS.map((e) => ({ ...e.capability }));
}
