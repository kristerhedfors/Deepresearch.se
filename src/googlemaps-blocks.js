// @ts-check
// The Google Maps integration's pure context-block builders — extracted from
// googlemaps.js so the labeled plain-text blocks (and the keyless link
// helpers they cite) live apart from the REST clients and lookup
// orchestration that feed them. Everything here is pure and Node-testable
// (googlemaps.test.js), the same pure-core split as googlemaps-text.js.
//
// Privacy: the blocks hand the model and the user only Google's KEYLESS Maps
// URLs — the API key never appears here (the keyed image URLs live on the
// REST side, src/googlemaps.js, and are used only for the internal fetches).

import { CROSS_MAX_M, STREETVIEW_HEADINGS } from "./googlemaps.js";
import { distanceMeters } from "./googlemaps-text.js";

/** @typedef {import('./types.js').StreetViewPov} StreetViewPov */
/** @typedef {import('./googlemaps-text.js').LatLng} LatLng */
/** @typedef {import('./googlemaps-text.js').MapView} MapView */
/** @typedef {import('./googlemaps-text.js').JumpTarget} JumpTarget */
/** @typedef {import('./googlemaps.js').Place} Place */
/** @typedef {import('./googlemaps.js').PlaceWithCoords} PlaceWithCoords */
/** @typedef {import('./googlemaps.js').WalkingRoute} WalkingRoute */

// The honest note for an explicit street-view ask that resolved to NOTHING:
// the knob is on (this code only runs then), so the model must ask which
// place is meant — never hand out "enable it in Settings" steps. A
// here-ask ("street view at my location") that reaches this point means
// the DEVICE LOCATION never arrived (permission not yet granted, denied,
// or geolocation timed out) — say that, not a useless "which address?"
// (live report 2026-07-09, ref 7a75daf2: the reply was "Where should I
// look up Street View?" at a user pointing at their own position).
/**
 * @param {boolean} [hereAsk]
 * @returns {string}
 */
export function unresolvedMapsBlock(hereAsk = false) {
  const middle = hereAsk
    ? "The user asked for something anchored at their CURRENT LOCATION (a street-view-here ask, \"where am I?\", a go-to/teleport/nearby ask that starts from their position, or an answer to such a clarify), but no device location was shared with this request — the browser has not (yet) granted this site location access, the location request timed out, or the app is running an older cached version (a full reload/relaunch fixes that). " +
      "Tell the user that, to use their current position, they need to allow location access for this site when the browser asks (or in the browser's site settings) — and if no permission prompt ever appeared, to fully reload the app — then ask again. Or they can simply name an address or place instead. "
    : "The user asked for Street View, and Google Maps & Street View is ENABLED, but no address or place name could be identified in the message. " +
      "Ask the user which address or place they mean (one short question). ";
  return (
    "\n\n--- Google Maps ---\n" +
    middle +
    "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
    "--- End of Google Maps ---"
  );
}

// ---- pure link/block builders (exported for unit tests) --------------------

// Appended to every Maps context block. Without it a model that wanted to
// "show" imagery invented a Street View Static API markdown image with
// key=YOUR_API_KEY — a broken image in the reply (reported 2026-07-09,
// "Street view basaltvägen 1 enköping"). Any real imagery is rendered
// beside the reply by the client, never by the model.
const NO_FABRICATED_IMAGE_URLS =
  "NEVER construct or output Google Maps API image URLs or markdown images (e.g. maps.googleapis.com/maps/api/streetview?...) — you have no API key, so such URLs render as broken images. Any available imagery is already shown to the user beside this reply; when linking, use only the keyless links given above.";

// Keyless Google Maps Street View link (built from the pano's own
// coordinates) the model can cite and the user can open. NEVER embeds the API
// key — the keyed image URL is used only for the internal fetch.
/**
 * @param {number} lat
 * @param {number} lng
 * @returns {string}
 */
export function panoLink(lat, lng) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
}

// Keyless Google Maps link that drops a pin at the coordinates.
/**
 * @param {number} lat
 * @param {number} lng
 * @returns {string}
 */
export function mapLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// A heading in degrees as a compass point ("143°" → "southeast"), so the
// context block reads naturally for the model and the user.
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
/**
 * @param {number} heading
 * @returns {string}
 */
export function compassDir(heading) {
  const h = ((Number(heading) % 360) + 360) % 360;
  return COMPASS[Math.round(h / 45) % 8];
}

// The labeled context block for a captured CURRENT-view frame (the POV path):
// the user panned/moved the inline panorama and asked a follow-up, and the
// exact frame on their screen was captured and (when possible) described.
// Same plain-text convention as buildMapsBlock. Pure — exported for tests.
/**
 * @param {StreetViewPov} pov
 * @param {{ date?: string, description?: string, framesShown?: number, panoramaShown?: boolean }} parts
 * @returns {string}
 */
export function buildPovBlock(pov, parts) {
  const lines = [
    "The user is viewing an interactive Street View panorama beside this chat and may have panned or moved it.",
    `Their CURRENTLY VISIBLE view was captured for this question: at coordinates ${pov.lat}, ${pov.lng}, facing ${pov.heading}° (${compassDir(pov.heading)}), pitch ${pov.pitch}°.`,
  ];
  if (parts.date) lines.push(`Street View imagery captured: ${parts.date}`);
  lines.push(`Map link: ${mapLink(pov.lat, pov.lng)}`);
  lines.push(`Street View link: ${panoLink(pov.lat, pov.lng)}`);
  if (parts.panoramaShown) {
    lines.push(
      "An interactive Street View panorama positioned at exactly this view is displayed to the user directly beside this reply — they can keep looking around from there, so refer to the view as shared context.",
    );
  } else if (parts.framesShown) {
    lines.push("The captured frame is displayed to the user directly beside this reply, so you can refer to it as shared context.");
  }
  // The user navigated here from wherever the conversation started — the
  // coordinates above are where they are NOW, so the answer must hand them
  // a link to this position, not rely on links given for the original place.
  lines.push(
    `The user has moved within Street View, so ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(pov.lat, pov.lng)})) so they can open their current position.`,
  );
  if (parts.description) {
    lines.push(`Visual description of the user's current view (auto-generated): ${parts.description}`);
  } else {
    lines.push("The frame could not be examined by a vision model this time — answer from the location data above and say plainly that the view itself couldn't be inspected.");
  }
  // Conditional on purpose: the capture fires generously for panorama
  // conversations, so the question may or may not be about the view —
  // steer without misdirecting the unrelated case.
  lines.push(
    "If the question refers to something visible (a person, vehicle, sign, building — anything in the scene), answer it directly from the visual description above and never ask them to clarify who or what they mean: they mean what is in their view. If the question is unrelated to the view, answer it normally and ignore this block.",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// Human phrasing of a jump ask, from the deterministic parse (pure).
/** @param {JumpTarget} jump */
function jumpAskText(jump) {
  if (jump.dir === "here") return "at their current position";
  const dir =
    jump.dir === "forward"
      ? "along the road/direction they are viewing"
      : jump.dir === "back"
        ? "back the way they came"
        : `to the ${jump.dir}`;
  return `about ${jump.meters} meters ${dir} of their current position`;
}

// The labeled context block for a Street View JUMP: the user asked to pop
// open Street View at their current position ("street view here") or at a
// computed one ("100 meters along this road") — the destination was derived
// deterministically from their live view/location and phrasing. Pure —
// exported for tests. `jump` carries the (possibly pano-snapped) destination.
/**
 * @param {JumpTarget} jump
 * @param {{ found?: boolean, date?: string, place?: string | null, panoramaShown?: boolean,
 *   framesShown?: number, description?: string, mapShown?: boolean }} parts
 * @returns {string}
 */
export function buildJumpBlock(jump, parts) {
  const lines = [
    `The user asked to open Street View ${jumpAskText(jump)} — computed destination: ${jump.lat}, ${jump.lng}, facing ${jump.heading}° (${compassDir(jump.heading)}).`,
  ];
  // The destination NAMED, not just its coordinates — a here-jump is often
  // a literal "where am I?", and this line is the actual answer to it.
  if (parts.place) {
    lines.push(`The destination reverse-geocodes to (OpenStreetMap Nominatim): ${parts.place}`);
  }
  if (parts.found) {
    if (parts.date) lines.push(`Street View imagery captured: ${parts.date}`);
    lines.push(`Map link: ${mapLink(jump.lat, jump.lng)}`);
    lines.push(`Street View link: ${panoLink(jump.lat, jump.lng)}`);
    if (parts.panoramaShown) {
      lines.push(
        "An interactive Street View panorama positioned at this destination is displayed to the user directly beside this reply — they can keep looking around from there, so refer to it as shared context.",
      );
    } else if (parts.framesShown) {
      lines.push("The captured Street View frame of the destination is displayed to the user directly beside this reply.");
    }
    if (parts.description) {
      lines.push(`Visual description of the destination's Street View (auto-generated): ${parts.description}`);
    } else {
      lines.push(
        "The destination's imagery could not be examined by a vision model this time — answer from the location data above and say plainly that the view itself couldn't be inspected.",
      );
    }
  } else {
    lines.push(
      "Google has NO Street View panorama near that destination. Say so plainly — never invent what it looks like or present anything else as Street View.",
    );
    lines.push(`Map link: ${mapLink(jump.lat, jump.lng)}`);
    if (parts.mapShown) {
      lines.push("An interactive Google Map of the destination is displayed to the user directly beside this reply instead.");
    }
  }
  lines.push(
    `ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(jump.lat, jump.lng)})) so the user can open the destination.`,
  );
  lines.push(
    "The destination was computed from the user's own view and phrasing — do NOT ask them to confirm coordinates or clarify where they mean; answer about it directly.",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// The labeled context block for a CROSS-BARRIER relocation ("get to the
// other side of the railway"). The load-bearing line is the VIRTUAL note:
// the reported failure was the model answering a panorama relocation with
// real-world safety guidance ("never cross the tracks directly") — twice.
// Pure — exported for unit tests.
/**
 * @param {string} barrier
 * @param {LatLng} anchor
 * @param {{ found: true, bearing: number, distance: number, lat: number, lng: number,
 *     place?: string | null, framesShown?: number, panoramaShown?: boolean, description?: string }
 *   | { found?: false, mapShown?: boolean }} [parts]
 * @returns {string}
 */
export function buildCrossBarrierBlock(barrier, anchor, parts = {}) {
  const lines = [
    `The user asked to get to the other side of the ${barrier}. This is VIRTUAL Street View panorama navigation — the user is NOT physically moving. ` +
      "Do NOT give real-world safety or route guidance (no warnings about crossing tracks, traffic, or authorized paths); just describe where the view has been relocated to.",
  ];
  if (parts.found) {
    lines.push(
      `The panorama was relocated across the ${barrier}: heading ${parts.bearing}° (${compassDir(parts.bearing)}), ` +
        `landing ≈${parts.distance} m from the previous position at ${parts.lat}, ${parts.lng} (detected as renewed Street View coverage after the ${barrier}'s coverage gap).`,
    );
    if (parts.place) lines.push(`The destination reverse-geocodes to (OpenStreetMap Nominatim): ${parts.place}`);
    lines.push(`Map link: ${mapLink(parts.lat, parts.lng)}`);
    lines.push(`Street View link: ${panoLink(parts.lat, parts.lng)}`);
    if (parts.framesShown) {
      lines.push(
        `A photo series of the virtual crossing (start → just before the ${barrier} → the other side) is displayed to the user directly beside this reply — walk them through it in order.`,
      );
    }
    if (parts.panoramaShown) {
      lines.push(
        "An interactive Street View panorama at the destination is displayed to the user directly beside this reply — they can keep looking around from there.",
      );
    }
    if (parts.description) {
      lines.push(`Visual description of the destination's Street View (auto-generated): ${parts.description}`);
    }
    lines.push(
      `ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(parts.lat, parts.lng)})).`,
    );
  } else {
    lines.push(
      `No renewed Street View coverage was found beyond the ${barrier} within ~${CROSS_MAX_M} m of the current position in the probed directions. ` +
        "Say so plainly — never invent a view or a destination.",
    );
    lines.push(`Map link for the current position: ${mapLink(anchor.lat, anchor.lng)}`);
    if (parts.mapShown) {
      lines.push("An interactive Google Map of the current area is displayed to the user directly beside this reply.");
    }
  }
  lines.push("The relocation was computed from the user's own view and phrasing — do NOT ask them to confirm coordinates.");
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// The labeled context block for a NEARBY-place search ("Gas station near
// e18 there"): Google Places searched around the user's current position
// and these are the hits, nearest-relevance first, each with its distance
// from the anchor and a keyless Map link. `parts` carries the imagery facts
// (panorama/frame shown, vision description) for the TOP hit when Street
// View covered it. Pure — exported for unit tests.
/**
 * @param {string} query
 * @param {LatLng} anchor
 * @param {PlaceWithCoords[]} places
 * @param {{ mode?: string, anchorPlace?: string | null, panoramaShown?: boolean, mapShown?: boolean,
 *   routeMapShown?: boolean, route?: WalkingRoute | null, description?: string }} [parts]
 * @returns {string}
 */
export function buildNearbyPlacesBlock(query, anchor, places, parts = {}) {
  const lines = [
    `The user asked for a nearby place ("${query}") and Google Places was searched around their CURRENT position (${anchor.lat}, ${anchor.lng}). ` +
      "The position is where they have navigated the live view (or their device location) — do NOT ask them to confirm it.",
  ];
  // Mode framing (the user's refined semantics, 2026-07-09): teleport =
  // DROP, "go to" = the actual travel, verb-less = informational search.
  if (parts.mode === "instant") {
    lines.push(
      "The user asked to TELEPORT — they have been dropped straight at the first result; the panorama beside this reply is there. " +
        "Answer briefly with where they landed and what's around it — no travel narrative, no route description.",
    );
  } else if (parts.mode === "travel") {
    lines.push(
      "The user asked to GO there — present it as the actual travel: where they started, the way there (the photo waypoints and route map beside this reply, in order), and the arrival.",
    );
  }
  // The say-where-you-are opener (search/travel modes): the answer opens
  // with the user's own position, then presents the found place.
  if (parts.anchorPlace) {
    lines.push(
      `The user's current position reverse-geocodes to (OpenStreetMap Nominatim): ${parts.anchorPlace}. ` +
        "Open the answer by saying where the user currently is, then present the found place / relocation.",
    );
  }
  if (places.length) {
    lines.push(`${places.length} result${places.length === 1 ? "" : "s"}, best match first:`);
    for (const p of places) {
      const meters = distanceMeters(anchor.lat, anchor.lng, p.lat, p.lng);
      const dist = meters >= 1000 ? `≈${(meters / 1000).toFixed(1)} km away` : `≈${meters} m away`;
      const facts = [p.type, dist, p.rating ? `rated ${p.rating} (${p.ratingCount})` : "", p.status && p.status !== "OPERATIONAL" ? p.status : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(`- ${p.name} — ${p.address}${facts ? ` (${facts})` : ""} — Map link: ${mapLink(p.lat, p.lng)}`);
    }
    const top = places[0];
    if (parts.panoramaShown) {
      lines.push(
        `An interactive Street View panorama at the first result (${top.name}) is displayed to the user directly beside this reply — refer to it as shared context. ` +
          "If the user asked to \"jump\" or \"teleport\", that relocation HAS happened: the panorama IS at the destination.",
      );
    } else if (parts.mapShown) {
      lines.push(`An interactive Google Map at the first result (${top.name}) is displayed to the user directly beside this reply.`);
    }
    if (parts.routeMapShown) {
      lines.push(
        `A route map with numbered waypoints (1 = the user's position, last = ${top.name}) is displayed to the user beside this reply.`,
      );
    }
    if (parts.route) {
      const mins = parts.route.durationS ? Math.max(1, Math.round(parts.route.durationS / 60)) : null;
      lines.push(
        `Along roads/paths (Google Routes, walking): ≈${fmtMeters(parts.route.distanceMeters)}${mins ? `, about ${mins} min on foot` : ""}.`,
      );
    }
    if (parts.description) {
      lines.push(`Visual description of the first result's Street View (auto-generated): ${parts.description}`);
    }
    lines.push(
      `ALWAYS include the first result's Map link in your answer as a markdown link (e.g. [${top.name} on Google Maps](${mapLink(top.lat, top.lng)})) so the user can open it.`,
    );
  } else {
    lines.push(
      "Google Places returned NO results for this search near the current position. Say so plainly — never invent a place — and suggest widening the search or naming a place/address.",
    );
    lines.push(`Map link for the current position: ${mapLink(anchor.lat, anchor.lng)}`);
  }
  lines.push(
    "This is VIRTUAL Street View/map navigation — NEVER say you cannot teleport, move the user, or control navigation; the views beside this reply are the relocation.",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// The labeled context block for a captured CURRENT map view (the map-view
// path, the road-map sibling of buildPovBlock): the user panned/zoomed the
// inline interactive map and asked a follow-up, and a road-map image of
// exactly the area on their screen was captured and (when possible)
// described. Pure — exported for tests.
/**
 * @param {MapView} view
 * @param {{ description?: string, mapShown?: boolean }} parts
 * @returns {string}
 */
export function buildMapViewBlock(view, parts) {
  const lines = [
    "The user is viewing an interactive Google Map beside this chat and may have panned or zoomed it.",
    `Their CURRENTLY VISIBLE map area was captured for this question: centered at coordinates ${view.lat}, ${view.lng}, zoom level ${view.zoom}.`,
    `Map link: ${mapLink(view.lat, view.lng)}`,
  ];
  if (parts.mapShown) {
    lines.push(
      "A fresh interactive Google Map positioned at exactly this view is displayed to the user directly beside this reply — they can keep exploring from there, so refer to the view as shared context.",
    );
  }
  // The user panned/zoomed away from wherever the conversation started — the
  // center above is where they are NOW, so the answer must link there.
  lines.push(
    `The user has moved within the map, so ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(view.lat, view.lng)})) so they can open their current position.`,
  );
  if (parts.description) {
    lines.push(
      `Visual description of the user's current map view (auto-generated — this is a MAP image, NOT Street View): ${parts.description}`,
    );
  } else {
    lines.push(
      "The map view could not be examined by a vision model this time — answer from the coordinates above and say plainly that the view itself couldn't be inspected.",
    );
  }
  // Conditional on purpose, same as the POV block: the capture fires
  // generously for map conversations, so the question may be unrelated.
  lines.push(
    "If the question refers to something on the map (a road, a labeled place, an area — anything in their view), answer it directly from the visual description above and never ask them to clarify where they mean: they mean what is on their map. If the question is unrelated to the map, answer it normally and ignore this block.",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// The labeled context block appended to the conversation, same plain-text
// convention as geocode.js's resolved-location block and shodan.js's host
// block. `parts` is the assembled lookup result (place / streetView / map).
/**
 * @param {string} query
 * @param {{ place: Place | null, lat: number | null, lng: number | null,
 *   streetView: { date: string, lat: number | null, lng: number | null } | null,
 *   streetViewCount?: number, hasMap?: boolean, description?: string, describedMapOnly?: boolean,
 *   followUp?: boolean, framesShown?: number, mapShown?: boolean, mapEmbedShown?: boolean }} parts
 * @returns {string}
 */
export function buildMapsBlock(query, parts) {
  const lines = [`Location looked up: ${query}`];
  const p = parts.place;
  if (p) {
    if (p.name) lines.push(`Place: ${p.name}`);
    if (p.address) lines.push(`Address: ${p.address}`);
    if (p.type) lines.push(`Type: ${p.type}`);
    if (Number.isFinite(p.rating)) {
      lines.push(`Rating: ${p.rating}${p.ratingCount ? ` (${p.ratingCount} reviews)` : ""}`);
    }
    if (p.status) lines.push(`Business status: ${p.status}`);
  }
  const lat = parts.lat;
  const lng = parts.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    lines.push(`Coordinates: ${lat}, ${lng}`);
    lines.push(`Map link: ${mapLink(/** @type {number} */ (lat), /** @type {number} */ (lng))}`);
  }
  if (parts.streetView) {
    // Link the panorama's own position when the lookup reported one (it can
    // sit up to the search radius from the resolved address), else the
    // resolved coordinates.
    const svLat = Number.isFinite(parts.streetView.lat) ? parts.streetView.lat : lat;
    const svLng = Number.isFinite(parts.streetView.lng) ? parts.streetView.lng : lng;
    if (Number.isFinite(svLat) && Number.isFinite(svLng)) {
      lines.push(`Street View link: ${panoLink(/** @type {number} */ (svLat), /** @type {number} */ (svLng))}`);
    }
    if (parts.streetView.date) lines.push(`Street View imagery captured: ${parts.streetView.date}`);
  } else {
    // The location resolved but Google has no panorama near it. Said
    // explicitly, because omitting it made the model present a road-map
    // description as "Street View imagery" (reported 2026-07-09).
    lines.push(
      "No Street View imagery is available for this location (Google has no panorama near these coordinates). If the user asked for Street View, say that plainly — never present anything else (a map, a guess) as Street View imagery.",
    );
    // With no panorama, the map link is the user's way in — the first
    // no-coverage answers shipped without any link at all (requested
    // 2026-07-09: "include a google maps link with the maps view").
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      lines.push(
        `ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(/** @type {number} */ (lat), /** @type {number} */ (lng))})) so the user can open the location on Google Maps.`,
      );
    }
  }
  const svCount = parts.streetViewCount || 0;
  if (parts.followUp) {
    // pickLookup walked back to an address an EARLIER turn named: tell the
    // model this is fresh imagery of the location already under discussion,
    // so it reasons about THE image instead of denying knowledge of it.
    lines.push(
      "This is a follow-up question about the location already being discussed — the CURRENT Street View imagery of it was re-fetched and re-examined for this question.",
    );
  }
  if (parts.framesShown) {
    lines.push(
      `${parts.framesShown} Street View photo(s) of this location are displayed to the user directly beside this reply, so you can refer to them ("in the photos", "the north-facing frame") as shared context.`,
    );
  }
  if (parts.mapShown) {
    lines.push(
      "A road-map image of the area is displayed to the user directly beside this reply, so you can refer to it as shared context.",
    );
  }
  if (parts.mapEmbedShown) {
    lines.push(
      "An interactive Google Map of the area (draggable, zoomable, with a marker at the resolved location) is displayed to the user directly beside this reply, so you can refer to it as shared context.",
    );
  }
  if (parts.description) {
    // A vision model already looked at the imagery for a non-vision answer
    // model — hand over its description so the answer can relay it. Label
    // WHAT was described honestly: when only the road map could be examined
    // (no Street View coverage, or every frame fetch failed), saying
    // "Street View imagery" here made the model claim Street View it never
    // had (reported 2026-07-09).
    const describedWhat = parts.describedMapOnly
      ? "Visual description of the road map of the area (auto-generated — this is a MAP image, NOT Street View)"
      : "Visual description of the Street View imagery (auto-generated)";
    lines.push(`${describedWhat}: ${parts.description}`);
  } else {
    const imgs = [];
    if (svCount) {
      imgs.push(
        svCount === 1
          ? "one Street View photo"
          : `${svCount} Street View photos looking ${STREETVIEW_HEADINGS.slice(0, svCount).map((h) => h.dir).join(", ")} from the spot`,
      );
    }
    if (parts.hasMap) imgs.push("a road map");
    if (imgs.length) {
      lines.push(`Attached to this message for you to describe: ${imgs.join(" and ")}.`);
    } else if (parts.streetView) {
      lines.push("Street View imagery exists here; to see it the user can open the Street View link above (the answering model can't view images).");
    }
  }
  // A resolved location must never be re-asked (reported: the user wrote
  // "lidbecksgatan 10 hallstahammar" and still got "did you mean Lidköping
  // or Hallstahammar?" — a wasted turn beside already-fetched imagery).
  lines.push(
    "The location was already resolved as shown above — do NOT ask the user to confirm or disambiguate the location or city. Answer about the resolved location directly; if the user's message names a locality that differs from the resolved address, say so plainly instead of asking.",
  );
  // The knob is on (this block only exists when it is). Stop the model from
  // wrongly telling the user to enable an already-enabled feature.
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

/** @param {number} m */
const fmtMeters = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

// The labeled context block for the JOURNEY view ("show how we traveled"):
// the visited positions ARE the conversation's own relocations, so the
// block presents them as the journey confidently — the reported failure
// was the model disclaiming that "no verified route" exists and refusing
// to draw one. Pure — exported for unit tests.
/**
 * @param {LatLng[]} points
 * @param {{ route?: WalkingRoute | null, startPlace?: string | null, endPlace?: string | null,
 *   mapShown?: boolean, embedShown?: boolean }} [parts]
 * @returns {string}
 */
export function buildJourneyBlock(points, parts = {}) {
  const total = points.length;
  let straight = 0;
  const lines = [
    `The user asked to see how they traveled. This is the VIRTUAL journey of this conversation — the ${total} Street View/map positions visited, in order. ` +
      "Present it AS the journey (these are the actual visited positions); do not disclaim it as unverified or refuse to draw it.",
  ];
  points.forEach((p, i) => {
    const leg = i === 0 ? "" : ` — ${fmtMeters(distanceMeters(points[i - 1].lat, points[i - 1].lng, p.lat, p.lng))} from the previous stop (straight line)`;
    if (i > 0) straight += distanceMeters(points[i - 1].lat, points[i - 1].lng, p.lat, p.lng);
    const name = i === 0 && parts.startPlace ? ` (${parts.startPlace})` : i === total - 1 && parts.endPlace ? ` (${parts.endPlace})` : "";
    const role = i === 0 ? "start" : i === total - 1 ? "current position" : `stop ${i + 1}`;
    lines.push(`${i + 1}. ${role}: ${p.lat}, ${p.lng}${name}${leg}`);
  });
  lines.push(`Total straight-line distance along the stops: ≈${fmtMeters(straight)}.`);
  if (parts.route) {
    const mins = parts.route.durationS ? Math.max(1, Math.round(parts.route.durationS / 60)) : null;
    lines.push(
      `Along roads/paths (Google Routes, walking): ≈${fmtMeters(parts.route.distanceMeters)}${mins ? `, about ${mins} min on foot` : ""}.`,
    );
  } else {
    lines.push(
      "The along-road walking distance could not be computed this time (Routes API unavailable) — give the straight-line figures and say road distance would be somewhat longer; do NOT invent a walking time.",
    );
  }
  const dirLink = `https://www.google.com/maps/dir/${points.map((p) => `${p.lat},${p.lng}`).join("/")}`;
  lines.push(`Directions link through all stops: ${dirLink}`);
  if (parts.mapShown) {
    lines.push("A route map with the numbered stops and the path between them is displayed to the user directly beside this reply.");
  }
  if (parts.embedShown) {
    lines.push("An interactive map of the journey is also displayed beside this reply.");
  }
  lines.push(
    `ALWAYS include the directions link in your answer as a markdown link (e.g. [The route on Google Maps](${dirLink})).`,
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}
