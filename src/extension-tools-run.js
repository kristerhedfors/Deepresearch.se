// @ts-check
// THE EXTENSION TOOL RUNNERS — everything the MCP tool families do that touches
// a network, a model or a binding.
//
// The split mirrors src/literature-tools.js ⇄ src/literature-run.js exactly, and
// for the same two reasons: src/mcp.js loads this behind a dynamic import so its
// static half stays free of the provider graph (its file-layout rule), and the
// pure halves (src/maps-tools.js, src/shodan-tools.js) stay unit-testable with
// plain strings.
//
// WHAT MAKES THESE TOOLS DIFFERENT from the literature family: they run on
// behalf of a caller who is not in a conversation and cannot see anything. So
// this module does three things the chat enrichments never have to:
//
//   1. It resolves a STANDPOINT from arguments alone — an address, a coordinate,
//      or a handle from a previous call — where the chat path reads the live
//      panorama and the device's location off the request.
//   2. It hands the imagery to a vision helper and returns only that helper's
//      WORDS. No frame ever reaches the caller: they are base64 data URLs, and a
//      voice client has no use for one.
//   3. It bills the vision tokens itself. Inside a chat turn the pipeline's own
//      accounting sweeps them up at the end; here there is no pipeline, so the
//      spend is recorded in a `finally` exactly as the literature runner does.

import { bergetCost, recordModelUsage, recordUsage } from "./quota.js";
import { reverseGeocode } from "./geocode.js";
import { listChatModels } from "./providers.js";
import { describeStreetView } from "./maps-enrichment.js";
import {
  placesNearbySearch,
  placesTextSearch,
  runStreetViewJumpLookup,
  runStreetViewPovCapture,
} from "./googlemaps.js";
import { bearingDeg, distanceMeters, movePoint } from "./googlemaps-text.js";
import { runShodanLookup, runShodanSearch } from "./shodan.js";
import {
  MAX_NEARBY,
  clampMoveMeters,
  compassPoint,
  formatViewHandle,
  parseViewHandle,
  renderNearbyAnswer,
  renderStreetViewAnswer,
  resolveDirection,
  resolvePitch,
  usableCoords,
} from "./maps-tools.js";
import { clampHostLimit, parseHosts, renderHostAnswer, renderSearchAnswer } from "./shodan-tools.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * What every runner hands back to src/mcp.js: the spoken text, whether it is a
 * failure the caller should read as one, and whether anything was actually
 * found (for the log line — "ran and found nothing" and "could not run" are
 * different states and the chatlogs must be able to tell them apart).
 * @typedef {{ text: string, isError: boolean, found: boolean }} ToolAnswer
 */

/** The field of view a single described frame uses. 90° is what the chat path's
 * cardinal frames use — wide enough to show a building and its neighbours,
 * narrow enough that the description is about something. */
const FOV = 90;

/**
 * Dispatch one extension tool. Every branch fails SOFT (invariant 2): a missing
 * key, a dead upstream, an unparseable argument all come back as an isError tool
 * result the calling model can read, never as a thrown transport error.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {string} name
 * @param {any} args
 * @param {{ identity?: any, requestId?: string }} billing
 * @returns {Promise<ToolAnswer>}
 */
export async function runExtensionTool(env, log, name, args, billing) {
  switch (name) {
    case "street_view_look":
      return runStreetViewLook(env, log, args || {}, billing);
    case "place_nearby":
      return runPlaceNearby(env, log, args || {});
    case "host_intel":
      return runHostIntel(env, log, args || {});
    default:
      return { text: `Unknown tool: ${name}`, isError: true, found: false };
  }
}

// ---------------------------------------------------------------------------
// street_view_look
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @param {{ identity?: any, requestId?: string }} billing
 * @returns {Promise<ToolAnswer>}
 */
async function runStreetViewLook(env, log, args, billing) {
  const anchor = await resolveAnchor(env, log, args);
  if (!anchor.ok) return { text: anchor.message, isError: true, found: false };

  let { lat, lng, label } = anchor;
  let heading = anchor.heading;
  let panoId = anchor.panoId;

  // 1. WALK. The move's bearing is resolved against the direction currently
  //    faced, which is what makes "forward" and "left" mean anything; a compass
  //    word ignores it. An unparseable direction does NOT move us — silently
  //    walking somewhere the caller did not ask for is worse than not walking.
  /** @type {{ bearing: number, meters: number, actual: number } | null} */
  let moved = null;
  /** @type {string} */
  let unparsed = "";
  const moveAsked = typeof args.move === "string" && args.move.trim();
  if (moveAsked) {
    const dir = resolveDirection(args.move, heading);
    if (!dir) unparsed = String(args.move).slice(0, 40);
    else {
      const meters = clampMoveMeters(args.move_meters);
      const dest = movePoint(lat, lng, dir.bearing, meters);
      // The heading to CAPTURE at is decided before the jump, so the snap's own
      // frame is already the one we want and no second billed image is needed
      // for the common "walk then look" call.
      const facing = resolveDirection(args.look, dir.bearing);
      const capturedHeading = facing ? facing.bearing : dir.bearing;
      const jump = await runStreetViewJumpLookup(env, log, {
        lat: dest.lat,
        lng: dest.lng,
        heading: capturedHeading,
        meters,
      });
      if (!jump) {
        return {
          text:
            `There is no street-level imagery about ${meters} metres ${compassPoint(dir.bearing)} of ` +
            `${label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`} — Google's coverage stops before that. ` +
            `Try a shorter distance, or a different direction.`,
          isError: false,
          found: false,
        };
      }
      moved = {
        bearing: dir.bearing,
        meters,
        actual: Math.round(distanceMeters(lat, lng, jump.lat, jump.lng)),
      };
      // The snap can land on a different street than the ray pointed down, so
      // the standpoint's own label is now stale; it is re-derived below.
      lat = jump.lat;
      lng = jump.lng;
      panoId = jump.panoId;
      heading = capturedHeading;
      label = "";
      anchor.date = jump.date || "";
      anchor.image = jump.image || null;
    }
  }

  // 2. TURN. Relative to the direction of travel when we just walked, relative
  //    to the handle's own heading otherwise. `look` may also tilt: "look up" is
  //    how anyone asks about the top of a building.
  const pitch = resolvePitch(args.look);
  if (!moved && typeof args.look === "string" && args.look.trim()) {
    const facing = resolveDirection(args.look, heading);
    if (facing) heading = facing.bearing;
    else if (!pitch) unparsed = String(args.look).slice(0, 40);
  }

  // 3. STAND. With a panorama id in hand (a handle, or the jump we just made)
  //    the capture is direct and edge-cached; without one, one metadata probe
  //    snaps to the nearest coverage.
  let image = anchor.image;
  let date = anchor.date;
  if (!panoId) {
    const snap = await runStreetViewJumpLookup(env, log, { lat, lng, heading, meters: 0 });
    if (!snap) {
      return {
        text:
          `There is no street-level imagery at ${label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`}. ` +
          `Google covers roads, so a spot set back from one often has none — try a nearby address.`,
        isError: false,
        found: false,
      };
    }
    lat = snap.lat;
    lng = snap.lng;
    panoId = snap.panoId;
    image = snap.image;
    date = snap.date || "";
  }
  // A tilt, or a turn taken from a handle, needs its own frame: the cached one
  // faces where we used to face.
  if (!image || pitch !== 0 || (!moved && typeof args.look === "string" && args.look.trim())) {
    const capture = await runStreetViewPovCapture(env, log, { panoId, lat, lng, heading, pitch, fov: FOV });
    if (capture?.image) {
      image = capture.image;
      date = capture.date || date;
    }
  }

  // 4. DESCRIBE. The frame goes to a vision helper and only its text comes back.
  //    Fail-soft in both directions: no vision model in the catalog, or a helper
  //    that will not answer, still leaves a truthful answer about where we are
  //    standing and what the imagery is.
  const vision = await newVisionState(env, log, billing?.identity);
  let description = "";
  if (image && vision.visionModels.length) {
    const question = typeof args.question === "string" ? args.question.slice(0, 400) : "";
    const intro =
      `This is a Google Street View photo taken at ${lat.toFixed(5)}, ${lng.toFixed(5)}, ` +
      `looking ${compassPoint(heading)}${pitch > 0 ? " and upward" : pitch < 0 ? " and downward" : ""}. ` +
      `It is being described to someone who cannot see it.`;
    try {
      description = await describeStreetView(env, log, /** @type {any} */ (vision), intro, [image], question);
    } catch (err) {
      log.warn("maps_tool.describe_failed", { error: errText(err) });
    } finally {
      await recordVisionSpend(env, log, billing, vision);
    }
  }

  if (!label) label = (await reverseGeocode(env, log, lat, lng)) || "";

  const text = renderStreetViewAnswer({
    at: { label, lat, lng },
    heading,
    moved,
    description,
    date,
    handle: formatViewHandle({ lat, lng, heading, panoId }),
    imagery: !!image,
  });
  log.info("maps_tool.look", { moved: !!moved, described: !!description, user_id: billing?.identity?.id });
  return {
    // An unparsed direction is reported WITH the answer rather than instead of
    // it: the look still happened, just not the one that was asked for, and a
    // caller told only "unknown direction" would not know that.
    text: unparsed ? `${text} (The direction "${unparsed}" was not understood, so nothing turned that way.)` : text,
    isError: false,
    found: !!description || !!image,
  };
}

/**
 * Where this call is standing before any move — a handle, a coordinate pair, or
 * a place name resolved through the place search.
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @returns {Promise<{ ok: true, lat: number, lng: number, heading: number, panoId: string, label: string, image: string | null, date: string } | { ok: false, message: string }>}
 */
async function resolveAnchor(env, log, args) {
  const handle = parseViewHandle(args.view);
  if (handle) {
    return { ok: true, ...handle, label: "", image: null, date: "" };
  }
  if (usableCoords(args.lat, args.lng)) {
    return {
      ok: true,
      lat: Number(args.lat),
      lng: Number(args.lng),
      heading: 0,
      panoId: "",
      label: "",
      image: null,
      date: "",
    };
  }
  const place = typeof args.place === "string" ? args.place.trim() : "";
  if (place) {
    const hit = await placesTextSearch(env, log, place);
    if (!hit || !usableCoords(hit.lat, hit.lng)) {
      return { ok: false, message: `No place matching "${place}" could be found, so there is nowhere to look from.` };
    }
    return {
      ok: true,
      lat: /** @type {number} */ (hit.lat),
      lng: /** @type {number} */ (hit.lng),
      heading: 0,
      panoId: "",
      label: [hit.name, hit.address].filter(Boolean).join(", "),
      image: null,
      date: "",
    };
  }
  return {
    ok: false,
    message:
      "Nothing to look from: pass `place` (an address or place name), `lat` and `lng`, or a `view` handle " +
      "returned by an earlier street_view_look call.",
  };
}

// ---------------------------------------------------------------------------
// place_nearby
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @returns {Promise<ToolAnswer>}
 */
async function runPlaceNearby(env, log, args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { text: "The `query` argument is required — say what to look for.", isError: true, found: false };

  const handle = parseViewHandle(args.view);
  let lat = handle?.lat;
  let lng = handle?.lng;
  let label = "";
  if (lat === undefined && usableCoords(args.lat, args.lng)) {
    lat = Number(args.lat);
    lng = Number(args.lng);
  }
  if (lat === undefined) {
    const near = typeof args.near === "string" ? args.near.trim() : "";
    if (!near) {
      return {
        text: "Nothing to search around: pass a `view` handle, `lat` and `lng`, or `near` (a place name).",
        isError: true,
        found: false,
      };
    }
    const hit = await placesTextSearch(env, log, near);
    if (!hit || !usableCoords(hit.lat, hit.lng)) {
      return { text: `No place matching "${near}" could be found.`, isError: true, found: false };
    }
    lat = /** @type {number} */ (hit.lat);
    lng = /** @type {number} */ (hit.lng);
    label = [hit.name, hit.address].filter(Boolean).join(", ");
  }

  const found = await placesNearbySearch(env, log, query, /** @type {number} */ (lat), /** @type {number} */ (lng));
  if (found === null) {
    // null is the failure, [] is a real empty answer — the difference matters to
    // a caller deciding whether to ask again differently.
    return { text: "The place search could not be reached just now. Nothing was looked up.", isError: true, found: false };
  }
  const limit = Math.min(MAX_NEARBY, Math.max(1, Math.round(Number(args.limit) || MAX_NEARBY)));
  const places = found.slice(0, limit).map((p) => ({
    name: p.name,
    type: p.type,
    address: p.address,
    meters: Math.round(distanceMeters(/** @type {number} */ (lat), /** @type {number} */ (lng), p.lat, p.lng)),
    bearing: bearingDeg(/** @type {number} */ (lat), /** @type {number} */ (lng), p.lat, p.lng),
  }));
  if (!label) label = (await reverseGeocode(env, log, /** @type {number} */ (lat), /** @type {number} */ (lng))) || "";
  log.info("maps_tool.nearby", { results: places.length });
  return {
    text: renderNearbyAnswer({ query, at: { label, lat: /** @type {number} */ (lat), lng: /** @type {number} */ (lng) }, places }),
    isError: false,
    found: places.length > 0,
  };
}

// ---------------------------------------------------------------------------
// host_intel
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @returns {Promise<ToolAnswer>}
 */
async function runHostIntel(env, log, args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const { ips, hostnames } = parseHosts(args.hosts);

  if (ips.length || hostnames.length) {
    // The lookup normally reads its targets off the latest message; given them
    // explicitly it never touches the conversation, so an empty one is correct
    // rather than a stub standing in for something.
    const found = await runShodanLookup(env, log, [], { ips, hostnames });
    if (!found) {
      return {
        text:
          "Nothing came back for those hosts. Either Shodan holds no record of them, the hostnames did not " +
          "resolve, or host intelligence is not configured on this server — the three are indistinguishable " +
          "from here, and none of them means the hosts are closed.",
        isError: false,
        found: false,
      };
    }
    const asked = [...ips, ...hostnames];
    const notFound = asked.filter((t) => !found.block.includes(t));
    log.info("host_tool.lookup", { targets: asked.length, hosts: found.count });
    return {
      text: renderHostAnswer({ targets: asked.length, details: found.details, notFound }),
      isError: false,
      found: found.count > 0,
    };
  }

  if (query) {
    const found = await runShodanSearch(env, log, query);
    if (!found) {
      return {
        text: "That search returned nothing — either no host matches it, or host intelligence is not configured on this server.",
        isError: false,
        found: false,
      };
    }
    const limit = clampHostLimit(args.limit);
    log.info("host_tool.search", { hosts: found.count });
    return {
      text: renderSearchAnswer({
        query,
        details: found.details.slice(0, limit),
        count: Math.min(found.count, limit),
        total: found.count,
      }),
      isError: false,
      found: found.count > 0,
    };
  }

  return {
    text: "Pass `hosts` (addresses or hostnames to look up) or `query` (a Shodan search).",
    isError: true,
    found: false,
  };
}

// ---------------------------------------------------------------------------
// The vision helper's state, and paying for it
// ---------------------------------------------------------------------------

/**
 * The minimal state describeStreetView needs: the ranked describe-helper
 * candidates, the one that answered, and the token tally. The same three fields
 * chat.js builds for a research turn, resolved here from the catalog through the
 * shared helper so the two cannot drift.
 *
 * Fail-soft: an unreachable catalog leaves no candidates, and the caller then
 * skips the describe rather than failing the look.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {any} identity
 * @returns {Promise<{ visionModel: string | null, visionModels: string[], visionTotals: { prompt_tokens: number, completion_tokens: number }, catalog: any }>}
 */
async function newVisionState(env, log, identity) {
  /** @type {any} */
  let catalog = null;
  try {
    catalog = await listChatModels(env, identity);
  } catch (err) {
    log.warn("maps_tool.catalog_unavailable", { error: errText(err) });
  }
  const { resolveVisionModels } = await import("./model-routing.js");
  const visionModels = resolveVisionModels(catalog, "");
  return {
    visionModel: visionModels[0] || null,
    visionModels,
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    catalog,
  };
}

/**
 * Record what the describe cost, against the same four-window quota /api/chat
 * and deep_research feed.
 *
 * NEVER throws: this runs in a `finally`, and invariant 2 is absolute — a
 * missing catalog entry or a D1 outage degrades the ACCOUNTING, never the answer
 * the caller asked for. Nothing is written when nothing was spent (no vision
 * model answered), because an empty row only inflates the request count.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {{ identity?: any, requestId?: string }} billing
 * @param {{ visionModel: string | null, visionTotals: { prompt_tokens: number, completion_tokens: number }, catalog: any }} vision
 */
async function recordVisionSpend(env, log, billing, vision) {
  try {
    const userId = billing?.identity?.id;
    if (userId === undefined || userId === null || userId === "") return;
    const { prompt_tokens, completion_tokens } = vision.visionTotals;
    if (!prompt_tokens && !completion_tokens) return;
    const model = vision.visionModel || "";
    const entry = vision.catalog?.find((/** @type {any} */ m) => m.id === model);
    const berget_cost = bergetCost(entry, prompt_tokens, completion_tokens);
    await recordUsage(env, log, {
      user_id: userId,
      model,
      prompt_tokens,
      completion_tokens,
      // The imagery itself is billed by Google, not by search count: folding it
      // into `searches` would price it as an Exa search, which it is not.
      searches: 0,
      berget_cost,
      exa_cost: 0,
      duration_ms: 0,
    });
    await recordModelUsage(env, log, {
      user_id: userId,
      request_id: billing?.requestId || null,
      by_model: [{ role: "vision", model, prompt_tokens, completion_tokens, berget_cost }],
    });
  } catch (err) {
    log.warn("maps_tool.spend_record_failed", { error: errText(err) });
  }
}

/** @param {unknown} err @returns {string} */
function errText(err) {
  return (/** @type {any} */ (err))?.message || String(err);
}
