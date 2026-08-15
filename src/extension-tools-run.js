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
import { spokenText } from "./voice-answer.js";
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
  // Every billed outbound request this call makes lands here, and is metered in
  // the `finally` — the same shape runLiteratureTool uses, for the same reason:
  // a gate whose meter can be skipped by an early return is a gate that does not
  // bite. `calls` is passed down and incremented at each billed leg.
  const spend = { calls: 0 };
  try {
    switch (name) {
      case "street_view_look":
        return await runStreetViewLook(env, log, args || {}, billing, spend);
      case "place_nearby":
        return await runPlaceNearby(env, log, args || {}, spend);
      case "host_intel":
        return await runHostIntel(env, log, args || {}, spend);
      default:
        return { text: `Unknown tool: ${name}`, isError: true, found: false };
    }
  } finally {
    await recordOutboundCalls(env, log, billing, name, spend.calls);
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
async function runStreetViewLook(env, log, args, billing, spend) {
  const anchor = await resolveAnchor(env, log, args, spend);
  if (!anchor.ok) return { text: anchor.message, isError: true, found: false };

  let { lat, lng, label } = anchor;
  let heading = anchor.heading;
  let panoId = anchor.panoId;
  // The catalog read the describe needs depends on NOTHING here, so it is
  // started now and awaited at step 4. On a call that fetches imagery and then
  // describes it, that turns a strictly sequential chain into one overlapped
  // leg — the difference between a spoken answer arriving in four seconds and
  // in five, every time.
  const visionPromise = newVisionState(env, log, billing?.identity);
  /** @type {string[]} */
  const unparsed = [];

  // 1. WALK. The move's bearing is resolved against the direction currently
  //    faced, which is what makes "forward" and "left" mean anything; a compass
  //    word ignores it. An unparseable direction does NOT move us — silently
  //    walking somewhere the caller did not ask for is worse than not walking.
  /** @type {{ bearing: number, meters: number, actual: number } | null} */
  let moved = null;
  if (given(args.move)) {
    const dir = resolveDirection(args.move, heading);
    if (!dir) unparsed.push(`move="${String(args.move).slice(0, 40)}"`);
    else {
      const meters = clampMoveMeters(args.move_meters);
      const dest = movePoint(lat, lng, dir.bearing, meters);
      // The heading to CAPTURE at is decided before the jump, so the snap's own
      // frame is already the one we want and no second billed image is needed
      // for the common "walk then look" call.
      const facing = given(args.look) ? resolveDirection(args.look, dir.bearing) : null;
      const capturedHeading = facing ? facing.bearing : dir.bearing;
      spend.calls += 1;
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
            `${label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`} — the coverage stops before that. ` +
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
  const turned = !moved && given(args.look);
  if (turned) {
    const facing = resolveDirection(args.look, heading);
    if (facing) heading = facing.bearing;
    else if (!pitch) unparsed.push(`look="${String(args.look).slice(0, 40)}"`);
  }

  // 3. STAND. With a panorama id in hand (a handle, or the jump we just made)
  //    the capture is direct and edge-cached; without one, one metadata probe
  //    snaps to the nearest coverage.
  let image = anchor.image;
  let date = anchor.date;
  if (!panoId) {
    spend.calls += 1;
    const snap = await runStreetViewJumpLookup(env, log, { lat, lng, heading, meters: 0 });
    if (!snap) {
      // Three different things produce a null here and only one of them is
      // "no coverage": the service may be unconfigured on this server, and the
      // fetch may simply have failed. Saying "there is no imagery at this
      // address" for those two sends the caller to look somewhere else for a
      // problem that is not there.
      return {
        text: unavailableMessage(env, label || `${lat.toFixed(5)}, ${lng.toFixed(5)}`),
        isError: false,
        found: false,
      };
    }
    lat = snap.lat;
    lng = snap.lng;
    panoId = snap.panoId;
    image = snap.image;
    date = snap.date || "";
    // WHICH WAY TO FACE on a first look. The anchor's heading is north only
    // because nothing has said otherwise; if the caller named a PLACE, the thing
    // they want described is the place itself, and the panorama snapped to the
    // road near it. So face from the panorama back toward the place — which is
    // what a person standing there would do — unless the caller asked for a
    // direction, in which case that wins.
    if (!turned && anchor.target && distanceMeters(lat, lng, anchor.target.lat, anchor.target.lng) > 5) {
      heading = bearingDeg(lat, lng, anchor.target.lat, anchor.target.lng);
      image = null; // the snap's frame faces the wrong way now
    }
  }
  // A tilt, a turn taken from a handle, or a re-aim toward the target needs its
  // own frame: the cached one faces where we used to face.
  if (!image || pitch !== 0 || turned) {
    spend.calls += 1;
    const capture = await runStreetViewPovCapture(env, log, { panoId, lat, lng, heading, pitch, fov: FOV });
    if (capture?.image) {
      image = capture.image;
      date = capture.date || date;
    }
  }

  // 4. DESCRIBE, and name where we are — two independent legs, so they run
  //    together. The frame goes to a vision helper and only its text comes back,
  //    shaped for the ear: the helper is TOLD its words will be spoken, and its
  //    answer is run through the same speakable-text pass a voice research
  //    answer gets, because a model asked for prose still occasionally produces
  //    a bulleted list.
  const vision = await visionPromise;
  const question = typeof args.question === "string" ? args.question.slice(0, 400) : "";
  const intro =
    `This is a street-level photo taken at ${lat.toFixed(5)}, ${lng.toFixed(5)}, ` +
    `looking ${compassPoint(heading)}${pitch > 0 ? " and upward" : pitch < 0 ? " and downward" : ""}. ` +
    `It is being described to someone who CANNOT SEE IT and will HEAR your answer read aloud: ` +
    `write plain connected prose, no markdown, no lists, no headings.`;
  const [described, place] = await Promise.all([
    image && vision.visionModels.length
      ? describeStreetView(env, log, /** @type {any} */ (vision), intro, [image], question)
          .catch((err) => {
            log.warn("maps_tool.describe_failed", { error: errText(err) });
            return "";
          })
          .finally(() => recordVisionSpend(env, log, billing, vision))
      : Promise.resolve(""),
    label ? Promise.resolve(label) : reverseGeocode(env, log, lat, lng).then((name) => name || ""),
  ]);
  const description = spokenText(described || "");
  if (!label) label = place;

  const text = renderStreetViewAnswer({
    at: { label, lat, lng },
    heading,
    moved,
    description,
    date,
    handle: formatViewHandle({ lat, lng, heading, panoId }),
    imagery: !!image,
    // An unparsed argument is reported WITH the answer rather than instead of
    // it: the look still happened, just not the one that was asked for, and a
    // caller told only "unknown direction" would not know that. Both arguments
    // are named, because reporting one when the other failed sends the caller
    // to fix the wrong thing.
    unparsed,
  });
  log.info("maps_tool.look", { moved: !!moved, described: !!description, user_id: billing?.identity?.id });
  return { text, isError: false, found: !!description || !!image };
}

/** Was this argument actually supplied? Accepts a NUMBER as well as a string —
 * a bearing is a number, the schema says `string`, and a model handed "a
 * direction or a bearing in degrees" produces both. Refusing the number would
 * silently drop the move. */
function given(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && !!value.trim();
}

/**
 * What to say when a standpoint yields no panorama. The three causes are
 * genuinely different and only the caller can act on the difference.
 * @param {Env} env
 * @param {string} where
 * @returns {string}
 */
function unavailableMessage(env, where) {
  if (!env?.GOOGLE_MAPS_API_KEY) {
    return "Street-level imagery is not configured on this server, so nothing could be looked up. This is not about the place asked for.";
  }
  return (
    `No street-level imagery came back for ${where}. Coverage follows roads, so a spot set back from one often ` +
    `has none — try a nearby address, or a shorter move in a different direction.`
  );
}

/**
 * Where this call is standing before any move — a handle, a coordinate pair, or
 * a place name resolved through the place search.
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @returns {Promise<{ ok: true, lat: number, lng: number, heading: number, panoId: string, label: string, image: string | null, date: string } | { ok: false, message: string }>}
 */
async function resolveAnchor(env, log, args, spend) {
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
    spend.calls += 1;
    const hit = await placesTextSearch(env, log, place);
    if (!hit || !usableCoords(hit.lat, hit.lng)) {
      return { ok: false, message: `No place matching "${place}" could be found, so there is nowhere to look from.` };
    }
    const at = { lat: /** @type {number} */ (hit.lat), lng: /** @type {number} */ (hit.lng) };
    return {
      ok: true,
      ...at,
      heading: 0,
      panoId: "",
      label: placeLabel(hit),
      image: null,
      date: "",
      // The thing the caller actually asked about, kept so the first look can
      // FACE it: the panorama will snap to the road nearby, and a frame pointing
      // north from there describes whatever happens to be north.
      target: at,
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
async function runPlaceNearby(env, log, args, spend) {
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
    spend.calls += 1;
    const hit = await placesTextSearch(env, log, near);
    if (!hit || !usableCoords(hit.lat, hit.lng)) {
      return { text: `No place matching "${near}" could be found.`, isError: true, found: false };
    }
    lat = /** @type {number} */ (hit.lat);
    lng = /** @type {number} */ (hit.lng);
    label = [hit.name, hit.address].filter(Boolean).join(", ");
  }

  spend.calls += 1;
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
async function runHostIntel(env, log, args, spend) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const { ips, hostnames } = parseHosts(args.hosts);

  if (ips.length || hostnames.length) {
    // The lookup normally reads its targets off the latest message; given them
    // explicitly it never touches the conversation, so an empty one is correct
    // rather than a stub standing in for something.
    spend.calls += ips.length + hostnames.length;
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
    // `details` carries a line for every host looked up, INCLUDING the misses
    // ("<ip> — no Shodan record"), while `count` and `ips` describe only the
    // hosts actually found. Splitting them here rather than in the renderer is
    // what stops an all-missing lookup opening with "Shodan has a record for
    // this host" and then saying the opposite in the next clause.
    const hits = found.details.filter((line) => !/no shodan record/i.test(line));
    const misses = found.details
      .filter((line) => /no shodan record/i.test(line))
      .map((line) => line.split("—")[0].trim())
      .filter(Boolean);
    log.info("host_tool.lookup", { targets: asked.length, hosts: found.count });
    return {
      text: renderHostAnswer({ targets: asked.length, details: hits, notFound: misses }),
      isError: false,
      found: found.count > 0,
    };
  }

  if (query) {
    spend.calls += 1;
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
        // Shodan's own match count, not the size of the sample we kept —
        // reporting the sample as the population turns five hosts into a claim
        // about the internet.
        total: found.total,
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
 * A place's spoken label: its name plus the address, unless the address already
 * begins with the name (Google returns "Preem" + "Preem, Storgatan 1, …" often
 * enough that the naive join reads as a stutter out loud).
 * @param {{ name?: string, address?: string }} hit
 * @returns {string}
 */
function placeLabel(hit) {
  const name = (hit.name || "").trim();
  const address = (hit.address || "").trim();
  if (!name) return address;
  if (!address) return name;
  return address.toLowerCase().startsWith(name.toLowerCase()) ? address : `${name}, ${address}`;
}

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
 * Record the THIRD-PARTY requests a tool made, against the same four-window
 * quota /api/chat and deep_research feed.
 *
 * WHY THIS EXISTS, AND WHY IT COUNTS THEM AS `searches`. These three tools sit
 * behind `researchQuotaBlock` like every other spending tool — but the quota has
 * exactly two dimensions, Berget EUR and a search COUNT, and imagery, place
 * lookups and host records are neither: they are billed by Google and Shodan, in
 * their own currencies, and nothing in the ledger models that. A gate with no
 * meter behind it cannot bite, which is precisely the defect that made the
 * literature family unbounded until 2026-08-05 (docs/MCP-COST.md §4b); leaving
 * these three the same way would repeat it knowingly.
 *
 * So each billed outbound request counts as one unit of the only count dimension
 * there is. That deviates from the literature runner's rule that `searches`
 * belongs to Exa — deliberately, and it is the lesser wrong: the count is
 * calibrated at €0.005 a unit, which is the right order of magnitude for a
 * Street View frame, a Places search or a Shodan lookup, and `exa_cost` stays
 * zero so the EUR ledger keeps meaning what it meant. A tool-typed dimension is
 * the proper fix and is worth doing before this surface is widened.
 *
 * NEVER throws — invariant 2, and it runs after the answer is already formed.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {{ identity?: any, requestId?: string }} billing
 * @param {string} tool
 * @param {number} calls billed outbound requests this tool actually made
 */
async function recordOutboundCalls(env, log, billing, tool, calls) {
  try {
    const userId = billing?.identity?.id;
    if (userId === undefined || userId === null || userId === "" || calls <= 0) return;
    await recordUsage(env, log, {
      user_id: userId,
      model: "",
      prompt_tokens: 0,
      completion_tokens: 0,
      searches: calls,
      berget_cost: 0,
      exa_cost: 0,
      duration_ms: 0,
    });
    log.info("extension_tool.spend", { tool, calls });
  } catch (err) {
    log.warn("extension_tool.spend_record_failed", { error: errText(err) });
  }
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
