// The Google Maps enrichment runners — the MAPS side of the enrichment
// registry (src/enrichment.js), split out 2026-07-09 when the maps
// subsystem was refactored for modularity: src/googlemaps-text.js decides
// WHAT the user is asking (the pure lookup-intent registry feeding
// pickLookup), src/googlemaps.js talks to Google (REST clients + the pure
// context-block builders), and THIS module orchestrates one resolved
// target into a reply: the lookups, the vision describe, the SSE events
// (frames/embeds), and the appended block. One runner per target shape,
// dispatched by runGoogleMapsEnrichment (exported); every runner keeps the standing
// enrichment contract — silent when there is nothing to look up, a visible
// step naming the service when there is, fail-soft in every branch.

import { consumeChatStream } from "./berget.js";
import { chatCompletion } from "./providers.js";
import { imagePartsOf, lastUserMessage, textOf, withAppendedText } from "./conversation.js";
import { getModelProfile } from "./model-profiles.js";
import {
  buildCrossBarrierBlock,
  buildJourneyBlock,
  buildJumpBlock,
  buildMapsBlock,
  buildMapViewBlock,
  buildNearbyPlacesBlock,
  buildPovBlock,
  compassDir,
  computeWalkingRoute,
  googleMapsEmbedKey,
  placesNearbySearch,
  routeMapImage,
  runBarrierCrossing,
  runGoogleMapsLookup,
  runMapViewCapture,
  runStreetViewJumpLookup,
  runStreetViewPovCapture,
  unresolvedMapsBlock,
} from "./googlemaps.js";
import { bearingDeg, distanceMeters, hereAskIntent, pickLookup, samplePolyline, streetViewIntent } from "./googlemaps-text.js";
import { reverseGeocode } from "./geocode.js";
import { addUsage } from "./quota.js";

// The most images to hand the vision-describe helper in one request — the
// client's own per-message image cap, which Berget vision models accept
// reliably (a report of 5 attached frames drew a Berget 400).
const MAX_MAPS_IMAGES = 4;

// Google Maps enrichment: resolve a location the message is about (a street
// address parsed from it, or an attached photo's GPS coordinates) into Google
// Maps data — Places (canonical place details + coordinates), Street View
// (coverage + capture date), and a road map — and append it as one labeled
// context block. Street View imagery is described by a vision helper model
// (never attached to the answer model — see below). Stays silent when the
// message names no address and carries no photo location; beyond one free
// Street View metadata check an ordinary question costs nothing.
export async function runGoogleMapsEnrichment(env, log, emit, step, stepDone, conversation, state) {
  const target = pickLookup(conversation, state.imageLocations, state.streetViewPov, state.mapView, state.userLocation);
  // How routing went, made visible (requested 2026-07-09 after a run of
  // silent intent misses): which matcher decided — or "none" — lands in
  // Workers Logs here and rides into the chat_logs meta via
  // state.mapsIntent, so scripts/chatlogs shows the routing per exchange.
  state.mapsIntent = target ? target.intent || "matched" : "none";
  log.info("maps.intent", { intent: state.mapsIntent, mode: target?.nearby?.mode });
  if (!target) {
    // An EXPLICIT street-view ask that resolved to nothing still needs an
    // honest note: with no block at all the model invents "enable Google
    // Maps in Settings" steps at a user whose knob is ON (reported verbatim:
    // "Street view of LEGO offices in Copenhagen", pre-named-place support).
    // A HERE-ask landing here — "street view here", a plain "where am I?",
    // or a short "my location" answer to an earlier street-view turn
    // (hereAskIntent, the conversation-level gate) — means the device
    // location never arrived: the note asks for location access instead of
    // "which address?".
    const lastText = textOf(lastUserMessage(conversation)?.content);
    const hereAsk = hereAskIntent(conversation);
    if (hereAsk || streetViewIntent(lastText)) {
      return withAppendedText(conversation, unresolvedMapsBlock(hereAsk));
    }
    return conversation;
  }
  // The user's actual question, for the vision helper to ANSWER about the
  // imagery (not just generically describe it). The client appends labeled
  // document/metadata blocks after the typed text, so keep only what precedes
  // the first block, bounded.
  const question = textOf(lastUserMessage(conversation)?.content).split("\n\n---")[0].trim().slice(0, 400);

  // The user panned/moved the inline panorama and asked about it: capture
  // exactly the frame on their screen (its own path — no Places lookup, one
  // Static fetch at their heading/pitch/fov) instead of the four generic
  // cardinal frames of a place lookup.
  if (target.pov) return runPovEnrichment(env, log, emit, step, stepDone, conversation, state, target.pov, question);

  // The map-view sibling: the user panned/zoomed the inline interactive MAP
  // (shown when a location resolved without Street View coverage) and asked
  // about it — capture a road-map image of exactly the area on their screen.
  if (target.mapView) {
    return runMapViewEnrichment(env, log, emit, step, stepDone, conversation, state, target.mapView, question);
  }

  // A Street View JUMP: "street view here" / "100 meters along this road" —
  // the destination was computed deterministically from the live view (or
  // the device's reported location) and the phrase; pop a panorama there.
  if (target.jump) {
    return runJumpEnrichment(env, log, emit, step, stepDone, conversation, state, target.jump, question);
  }

  // A NEARBY-place ask ("Gas station near e18 there"): search Google Places
  // around the current position and show the best hit.
  if (target.nearby) {
    return runNearbyPlaceEnrichment(env, log, emit, step, stepDone, conversation, state, target.nearby, question);
  }

  // A CROSS-BARRIER relocation ("Get to the other side of the railway"):
  // find renewed Street View coverage beyond the barrier and relocate the
  // panorama there, with a photo series of the virtual crossing.
  if (target.crossBarrier) {
    return runCrossBarrierEnrichment(env, log, emit, step, stepDone, conversation, state, target.crossBarrier, question);
  }

  // The JOURNEY view ("show how we traveled"): draw the conversation's
  // visited positions as a route, with distances and walking time.
  if (target.journey) {
    return runJourneyEnrichment(env, log, emit, step, stepDone, conversation, state, target.journey);
  }

  // Fetch imagery when we have a vision helper to DESCRIBE it (and the message
  // isn't already carrying user images). We deliberately do NOT attach the
  // Street View frames to the ANSWER model — a report showed attaching several
  // frames making the answer call fail with a Berget 400 (too many images on
  // one message). Instead a vision helper looks at the frames and only its
  // TEXT description reaches the answer model, so the answer call is always
  // image-free and can't fail from maps imagery. Works uniformly for vision
  // and non-vision answer models.
  const alreadyHasImages = imagePartsOf(lastUserMessage(conversation)).length > 0;
  const fetchImages = !!state.visionModel && !alreadyHasImages;

  step("maps", "Checking Google Maps…");
  let result = null;
  try {
    result = await runGoogleMapsLookup(env, log, { ...target, fetchImages });
  } catch (err) {
    log.warn("googlemaps.phase_failed", { error: err?.message || String(err) });
  }
  if (!result) {
    stepDone("maps", "No Google Maps data for that location");
    // We only reach here with the knob ON, but the lookup returned nothing.
    // Inject an honest note so the model doesn't wrongly tell the user to
    // enable an already-enabled feature (a reported bug: empty lookups — often
    // a Google Cloud API/billing gap — made the model claim Maps was off and
    // hand out enable instructions).
    const q = target.address || target.coords;
    return withAppendedText(
      conversation,
      "\n\n--- Google Maps ---\n" +
        `Google Maps & Street View is ENABLED and was checked for "${q}", but Google returned no usable data for this location ` +
        "(it may be unrecognized, have no Street View coverage, or the required Google Maps APIs may not be fully enabled on the server). " +
        "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
        "--- End of Google Maps ---",
    );
  }

  state.mapsCount = result.count;
  // Cap the images handed to the vision helper to what THIS vision model's
  // one request reliably accepts: the client's own per-message cap (4) as
  // the ceiling, tightened by the model's reproduced per-request image
  // limit when one is profiled (model-profiles.js — e.g. Mistral Medium
  // 400s on >2 images; that 400 blinded every describe until probed).
  // Street View frames first, road map last.
  const frames = Array.isArray(result.streetViewFrames) ? result.streetViewFrames : [];
  const imageCap = Math.min(MAX_MAPS_IMAGES, getModelProfile(state.visionModel).maxImages || MAX_MAPS_IMAGES);
  const images = [...frames.map((f) => f.url), result.staticMapImage].filter(Boolean).slice(0, imageCap);

  // Describe the imagery with the vision helper so the answer model (vision or
  // not) gets a factual look-around as TEXT — this is what makes "describe this
  // street view" work, and keeps the answer call free of the images that broke
  // it. The helper also gets the user's question so a follow-up ("what color
  // is the roof?") is answered from the CURRENT frames, not from memory of a
  // prior description. Fail-soft: no description → the block points at the
  // keyless link.
  let description = "";
  const hasMap = !!result.staticMapImage && images.includes(result.staticMapImage);
  // No Street View coverage (or every frame fetch failed) leaves only the
  // road map — the intro and the block must then say MAP, not "Street View
  // photos": mislabeling it here made the vision helper describe the map as
  // street imagery and the answer present fake Street View (reported
  // 2026-07-09, "Street view basaltvägen 1 enköping").
  const mapOnly = hasMap && !frames.length;
  if (images.length) {
    const intro = mapOnly
      ? `This is a Google Maps road-map image of the area around ${result.displayQuery}. There are NO Street View photos of this location.`
      : `These are Google Street View photos (looking in different directions)${hasMap ? " and a road map" : ""} of ${result.displayQuery}.`;
    description = await describeStreetView(env, log, state, intro, images, question, { mapOnly });
  }

  // Snap the frames into the reply: the client renders the very images the
  // vision helper reasoned about beside the answer, so the user sees the same
  // context the model saw (data URLs are already fetched — no extra billing).
  // With no Street View coverage the road map stands in — honestly labeled —
  // so an address lookup never comes back with nothing visual at all.
  // Frames carry their position (lat/lng, optional — clients that don't
  // know the fields ignore them) so the client's image deck can pin each
  // image on the map and anchor follow-ups at it (see the sse-protocol
  // skill's forward-compat rule).
  if (frames.length) {
    emit({
      status: {
        type: "streetview_frames",
        query: result.displayQuery,
        frames: frames.map((f) => ({ ...f, lat: result.lat, lng: result.lng })),
      },
    });
  } else if (result.staticMapImage) {
    emit({
      status: {
        type: "streetview_frames",
        query: result.displayQuery,
        title: `Map — ${result.displayQuery} (no Street View here)`,
        frames: [{ dir: "", label: "road map of the area", kind: "map", lat: result.lat, lng: result.lng, url: result.staticMapImage }],
      },
    });
  }

  // With no panorama to embed, an interactive MAP of the area stands in
  // beside the reply (requested 2026-07-09, right after the honest
  // no-coverage degrade landed: "include a google maps link with the maps
  // view, or better an interactive maps view"). Same key discipline as the
  // Street View embed: coordinates only, the client holds the browser key.
  const mapEmbedShown =
    !result.embed && Number.isFinite(result.lat) && Number.isFinite(result.lng) && !!googleMapsEmbedKey(env);

  const block = buildMapsBlock(result.displayQuery, {
    place: result.place,
    lat: result.lat,
    lng: result.lng,
    streetView: result.streetView,
    streetViewCount: 0,
    hasMap: false,
    description,
    describedMapOnly: mapOnly,
    followUp: !!target.followUp,
    framesShown: frames.length,
    mapShown: !frames.length && !!result.staticMapImage,
    mapEmbedShown,
  });

  stepDone(
    "maps",
    description ? "Google Maps data + Street View described" : "Google Maps data found",
    result.details,
  );

  // Hand the client the coordinates for an inline, navigable Street View embed
  // — but ONLY when the browser-exposed embed key is configured (otherwise the
  // client can't build the iframe and the keyless link in the block stands).
  // The key is NOT sent here: the client holds it from /api/settings, so it
  // never lands in the "Copy research JSON" debug export (which records events).
  if (result.embed && googleMapsEmbedKey(env)) {
    emit({ status: { type: "streetview_embed", lat: result.embed.lat, lng: result.embed.lng } });
  } else if (mapEmbedShown) {
    emit({ status: { type: "map_embed", lat: result.lat, lng: result.lng, q: result.displayQuery } });
  }

  return withAppendedText(conversation, block);
}

// The current-view path: the user panned/moved the live panorama, so capture
// the exact frame they see (one Static fetch at their heading/pitch/fov),
// have the vision helper answer their question about THAT frame, and render
// a fresh interactive panorama at that view beside the reply so they can
// continue navigating from where they are (the static capture is only shown
// when no embed key exists). No Places call. Fail-soft like every branch: a
// failed capture degrades to an honest note, never a blocked chat.
async function runPovEnrichment(env, log, emit, step, stepDone, conversation, state, pov, question) {
  step("maps", "Capturing your current Street View view…");
  let capture = null;
  try {
    capture = await runStreetViewPovCapture(env, log, pov);
  } catch (err) {
    log.warn("googlemaps.pov_failed", { error: err?.message || String(err) });
  }
  const where = `${pov.lat}, ${pov.lng}, facing ${pov.heading}° (${compassDir(pov.heading)})`;
  if (!capture) {
    stepDone("maps", "Couldn't capture the current Street View view");
    return withAppendedText(
      conversation,
      "\n\n--- Google Maps ---\n" +
        `Google Maps & Street View is ENABLED and a capture of the user's current panorama view (at ${where}) was attempted, but no image could be fetched. ` +
        "Answer from the conversation so far and say plainly that the current view couldn't be captured this time. " +
        "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
        "--- End of Google Maps ---",
    );
  }

  state.mapsCount = 1;
  let description = "";
  if (state.visionModel) {
    description = await describeStreetView(
      env,
      log,
      state,
      `This is the exact Google Street View frame the user is currently looking at in an interactive panorama (at ${where}, pitch ${pov.pitch}°).`,
      [capture.image],
      question,
    );
  }

  // Continue-from-here: render a NEW interactive panorama positioned at the
  // user's current view beside THIS reply (they navigated away from the
  // original location, so the old panorama sits stale by an earlier turn and
  // a static capture would freeze them there — reported 2026-07-09). The
  // captured frame is only shown when no embed key is configured, i.e. when
  // the client can't build a panorama at all.
  const panoramaShown = !!googleMapsEmbedKey(env);
  if (panoramaShown) {
    emit({
      status: { type: "streetview_embed", lat: pov.lat, lng: pov.lng, heading: pov.heading, pitch: pov.pitch },
    });
  } else {
    emit({
      status: {
        type: "streetview_frames",
        query: `your current view (${compassDir(pov.heading)})`,
        frames: [{ dir: "", label: "your current view", lat: pov.lat, lng: pov.lng, url: capture.image }],
      },
    });
  }

  stepDone(
    "maps",
    description ? "Current Street View view captured + described" : "Current Street View view captured",
    [`${where}${capture.date ? ` — imagery ${capture.date}` : ""}`],
  );

  return withAppendedText(
    conversation,
    buildPovBlock(pov, { date: capture.date, description, framesShown: panoramaShown ? 0 : 1, panoramaShown }),
  );
}

// The Street View JUMP path: pop open a panorama at the user's current
// position ("street view here", from the live view or the device's reported
// location) or at a computed destination ("100 meters along this road" —
// current position + compass bearing → point). Finds the nearest panorama
// (150m search), captures one frame facing the travel direction for the
// vision helper, and renders a fresh interactive panorama there (locking
// superseded embeds client-side). No panorama near the destination degrades
// to an interactive MAP of it plus an honest block — never an invented view.
async function runJumpEnrichment(env, log, emit, step, stepDone, conversation, state, jump, question) {
  step("maps", "Opening Street View at the requested position…");
  // The panorama search and the reverse geocode (Nominatim — free,
  // 4s-bounded, fail-soft to null) are independent, so they run together.
  // The place NAME is what turns a bare-coordinates block into one that
  // actually answers the here-ask family's "where am I?" — and it improves
  // every jump reply ("100 m north" now lands somewhere nameable).
  const [found, place] = await Promise.all([
    runStreetViewJumpLookup(env, log, jump).catch((err) => {
      log.warn("googlemaps.jump_failed", { error: err?.message || String(err) });
      return null;
    }),
    reverseGeocode(env, log, jump.lat, jump.lng),
  ]);
  const embedKeyOk = !!googleMapsEmbedKey(env);

  if (!found) {
    stepDone("maps", "No Street View at that position — showing a map");
    if (embedKeyOk) {
      emit({ status: { type: "map_embed", lat: jump.lat, lng: jump.lng, zoom: 17 } });
    }
    return withAppendedText(conversation, buildJumpBlock(jump, { found: false, mapShown: embedKeyOk, place }));
  }

  state.mapsCount = 1;
  const at = { ...jump, lat: found.lat, lng: found.lng };
  let description = "";
  if (state.visionModel && found.image) {
    description = await describeStreetView(
      env,
      log,
      state,
      `This is the Google Street View frame at the position the user asked to jump to (${found.lat}, ${found.lng}, facing ${jump.heading}° ${compassDir(jump.heading)}).`,
      [found.image],
      question,
    );
  }

  // The destination frame ALWAYS joins the reply (not just as the no-embed
  // fallback): every jump stop contributes a clickable image to the
  // conversation's image deck (imagedeck.js), which is how the journey's
  // waypoints get their miniatures.
  if (found.image) {
    emit({
      status: {
        type: "streetview_frames",
        query: `${found.lat}, ${found.lng}`,
        frames: [{ dir: "", label: "destination view", lat: found.lat, lng: found.lng, url: found.image }],
      },
    });
  }
  if (embedKeyOk) {
    emit({ status: { type: "streetview_embed", lat: found.lat, lng: found.lng, heading: jump.heading } });
  }

  stepDone(
    "maps",
    description ? "Street View opened at the destination + described" : "Street View opened at the destination",
    [`${found.lat}, ${found.lng} facing ${compassDir(jump.heading)}${found.date ? ` — imagery ${found.date}` : ""}`],
  );

  return withAppendedText(
    conversation,
    buildJumpBlock(at, {
      found: true,
      date: found.date,
      panoramaShown: embedKeyOk,
      framesShown: !embedKeyOk && found.image ? 1 : 0,
      description,
      place,
    }),
  );
}

// The NEARBY-place path: the user asked for a kind of place around where
// they are ("Gas station near e18 there", "närmaste apotek") — reported
// verbatim 2026-07-09, when the deictic "there" routed this into the POV
// capture and the model could only say the gas station wasn't visible in
// the current frame. Google Places (New) Text Search runs with a location
// bias circle at the anchor (the live view's position, or the device
// location), the hits join the conversation as a labeled block with
// distances and keyless links, and the BEST hit is shown like a jump
// destination: nearest panorama + one described frame + a fresh embed
// (interactive map when no Street View covers it). Fail-soft in every
// branch — a Places error or zero hits degrades to an honest block, never
// a blocked chat.
async function runNearbyPlaceEnrichment(env, log, emit, step, stepDone, conversation, state, nearby, question) {
  step("maps", "Searching Google Places near the current position…");
  const anchor = { lat: nearby.lat, lng: nearby.lng };
  const places = await placesNearbySearch(env, log, nearby.query, nearby.lat, nearby.lng);
  if (!places || !places.length) {
    stepDone("maps", `Google Places: nothing found for "${nearby.query}" nearby`);
    return withAppendedText(conversation, buildNearbyPlacesBlock(nearby.query, anchor, []));
  }
  state.mapsCount = places.length;
  const top = places[0];
  // The user's refined semantics (2026-07-09): "instant" (teleport) just
  // DROPS at the destination — no route map, no start narrative, no
  // series; "travel" ("go to nearest …") does the actual travel — start
  // narrative, photo waypoints along the way, route map; "search" (no
  // relocation verb) is informational — results + destination + route map.
  const mode = nearby.mode === "instant" || nearby.mode === "travel" ? nearby.mode : "search";
  const dest = { lat: top.lat, lng: top.lng };
  const straightM = distanceMeters(anchor.lat, anchor.lng, dest.lat, dest.lng);
  // Travel mode goes STEP BY STEP over Street View (reported 2026-07-09:
  // travel answers looked "just like teleport" — a start frame, then the
  // destination, nothing in between). The Routes API's walking polyline is
  // the actual ROAD PATH: the photo waypoints are sampled ALONG it (one
  // every ~fifth of the trip, up to 4), each snapped to the nearest
  // panorama facing the next waypoint — so the series really walks the
  // route. No route (API off/unreachable) degrades to straight-line
  // samples; the block then reports straight-line figures only.
  const route = mode === "travel" ? await computeWalkingRoute(env, log, [anchor, dest]) : null;
  let travelPoints = [];
  if (mode === "travel") {
    const spacing = Math.max(300, Math.round((route?.distanceMeters || straightM) / 5));
    const samples =
      route?.polyline?.length >= 2
        ? samplePolyline(route.polyline, spacing, 4)
        : straightM > 400
          ? [{ lat: (anchor.lat + dest.lat) / 2, lng: (anchor.lng + dest.lng) / 2 }]
          : [];
    const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    travelPoints = [
      { label: "start", lat: anchor.lat, lng: anchor.lng },
      ...samples.map((p) => ({ label: `on the way — ≈${fmt(distanceMeters(anchor.lat, anchor.lng, p.lat, p.lng))} in`, ...p })),
    ];
  }
  const headingAt = (i) => {
    const next = travelPoints[i + 1] || dest;
    return bearingDeg(travelPoints[i].lat, travelPoints[i].lng, next.lat, next.lng);
  };
  const [found, routeImg, anchorPlace, travelCaptures] = await Promise.all([
    runStreetViewJumpLookup(env, log, { lat: dest.lat, lng: dest.lng, heading: 0, meters: 0 }).catch((err) => {
      log.warn("googlemaps.nearby_pano_failed", { error: err?.message || String(err) });
      return null;
    }),
    mode === "instant"
      ? null
      : routeMapImage(env, log, [anchor, ...travelPoints.slice(1), dest], route?.polyline || null).catch(() => null),
    mode === "instant" ? null : reverseGeocode(env, log, anchor.lat, anchor.lng),
    Promise.all(
      travelPoints.map((w, i) =>
        runStreetViewJumpLookup(env, log, { lat: w.lat, lng: w.lng, heading: headingAt(i), meters: 0 }).catch(() => null),
      ),
    ),
  ]);
  const embedKeyOk = !!googleMapsEmbedKey(env);
  let description = "";
  if (found && state.visionModel && found.image) {
    description = await describeStreetView(
      env,
      log,
      state,
      `This is the Google Street View frame at "${top.name}" (${top.address}) — the best Google Places match for the user's nearby-place search.`,
      [found.image],
      question,
    );
  }
  // The deck frames, in travel order: the along-the-way waypoints (travel
  // mode; consecutive samples that snapped to the SAME panorama collapse),
  // the destination, then the waypoint route map (search/travel).
  const frames = [];
  let lastPano = "";
  travelPoints.forEach((w, i) => {
    const c = travelCaptures[i];
    if (!c?.image || (c.panoId && c.panoId === lastPano)) return;
    lastPano = c.panoId || "";
    frames.push({ dir: "", label: w.label, lat: c.lat, lng: c.lng, url: c.image });
  });
  if (found?.image) {
    frames.push({ dir: "", label: top.name || "best match", lat: found.lat, lng: found.lng, url: found.image });
  }
  if (routeImg) {
    frames.push({ dir: "", label: `you → ${top.name || "destination"}`, kind: "map", lat: dest.lat, lng: dest.lng, url: routeImg });
  }
  if (frames.length) {
    emit({ status: { type: "streetview_frames", query: top.name || nearby.query, frames } });
  }
  if (embedKeyOk && found) {
    emit({ status: { type: "streetview_embed", lat: found.lat, lng: found.lng, heading: 0 } });
  } else if (embedKeyOk) {
    emit({ status: { type: "map_embed", lat: top.lat, lng: top.lng, zoom: 16 } });
  }
  stepDone(
    "maps",
    `Google Places: ${places.length} result${places.length === 1 ? "" : "s"} near the current position`,
    places.map((p) => `${p.name} — ${p.address}`),
  );
  return withAppendedText(
    conversation,
    buildNearbyPlacesBlock(nearby.query, anchor, places, {
      panoramaShown: !!(embedKeyOk && found),
      mapShown: !!(embedKeyOk && !found),
      description,
      anchorPlace,
      routeMapShown: !!routeImg,
      mode,
      route,
      seriesShown: frames.filter((f) => f.kind !== "map").length,
    }),
  );
}

// The CROSS-BARRIER path ("Get to the other side of the railway" — reported
// verbatim 2026-07-09, when it drew a real-world safety lecture instead of a
// relocation, twice): runBarrierCrossing probes free Street View metadata
// along the travel bearing for the barrier's coverage gap followed by
// renewed coverage, relocates the panorama to the far side, and documents
// the virtual crossing with a PHOTO SERIES (start → just before the barrier
// → the other side; each a cached POV capture facing the travel bearing)
// emitted as one streetview_frames strip. The destination also gets the
// usual treatment: reverse-geocoded place name, vision describe, fresh
// interactive embed. Fail-soft in every branch — no crossing found degrades
// to an honest block plus a map of the current area, never an invented view.
async function runCrossBarrierEnrichment(env, log, emit, step, stepDone, conversation, state, ask, question) {
  step("maps", `Looking for Street View on the other side of the ${ask.barrier}…`);
  const crossing = await runBarrierCrossing(env, log, ask);
  const embedKeyOk = !!googleMapsEmbedKey(env);
  if (!crossing) {
    stepDone("maps", `No Street View found beyond the ${ask.barrier} nearby`);
    if (embedKeyOk) emit({ status: { type: "map_embed", lat: ask.lat, lng: ask.lng, zoom: 16 } });
    return withAppendedText(conversation, buildCrossBarrierBlock(ask.barrier, ask, { found: false, mapShown: embedKeyOk }));
  }
  state.mapsCount = 1;
  const { bearing, before, after } = crossing;

  // The photo series: start, the last covered spot before the barrier, and
  // the landing on the other side — dropping consecutive duplicates (the
  // gap can start right at the user's feet). Captures and the reverse
  // geocode are independent, so they all run together.
  const waypoints = [
    { label: "start", lat: ask.lat, lng: ask.lng, panoId: "" },
    { label: `just before the ${ask.barrier}`, ...before },
    { label: `the other side of the ${ask.barrier}`, ...after },
  ].filter((w, i, arr) => i === 0 || w.panoId !== arr[i - 1].panoId || w.lat !== arr[i - 1].lat);
  const [captures, place, routeImg] = await Promise.all([
    Promise.all(
      waypoints.map((w) =>
        runStreetViewPovCapture(env, log, { panoId: w.panoId || "", lat: w.lat, lng: w.lng, heading: bearing, pitch: 0, fov: 90 }).catch(
          () => null,
        ),
      ),
    ),
    reverseGeocode(env, log, after.lat, after.lng),
    // A route map with the crossing's waypoints joins the photo series
    // (requested 2026-07-09: the initial reply should show a map view among
    // the images, with all waypoints), so the strip reads photo → photo →
    // photo → where-it-all-is.
    routeMapImage(env, log, waypoints).catch(() => null),
  ]);
  const frames = waypoints
    .map((w, i) => ({ dir: "", label: w.label, lat: w.lat, lng: w.lng, url: captures[i]?.image || null }))
    .filter((f) => f.url);
  if (routeImg) {
    frames.push({ dir: "", label: "the crossing on the map", kind: "map", lat: after.lat, lng: after.lng, url: routeImg });
  }

  let description = "";
  const destFrame = captures[captures.length - 1]?.image;
  if (state.visionModel && destFrame) {
    description = await describeStreetView(
      env,
      log,
      state,
      `This is the Google Street View frame on the other side of the ${ask.barrier}, where the user's panorama was just relocated (${after.lat}, ${after.lng}, facing ${bearing}° ${compassDir(bearing)}).`,
      [destFrame],
      question,
    );
  }

  if (frames.length) {
    emit({ status: { type: "streetview_frames", query: `other side of the ${ask.barrier}`, frames } });
  }
  if (embedKeyOk) {
    emit({ status: { type: "streetview_embed", lat: after.lat, lng: after.lng, heading: bearing } });
  }
  stepDone(
    "maps",
    `Street View relocated across the ${ask.barrier}${frames.length ? ` — ${frames.length}-photo crossing series` : ""}`,
    [`≈${after.distance} m ${compassDir(bearing)} — landed at ${after.lat}, ${after.lng}`],
  );
  return withAppendedText(
    conversation,
    buildCrossBarrierBlock(ask.barrier, ask, {
      found: true,
      bearing,
      distance: after.distance,
      lat: after.lat,
      lng: after.lng,
      place,
      framesShown: frames.length,
      panoramaShown: embedKeyOk,
      description,
    }),
  );
}

// The JOURNEY path ("Show how we traveled on maps" — requested 2026-07-09,
// when the model listed coordinates and disclaimed that no travel trail
// exists): the waypoints ARE the conversation's own relocations (parsed by
// extractJourneyPoints from the mandated links in assistant turns), drawn
// as a Static Maps route image (numbered markers + path, shown as a frames
// strip), plus an interactive map embed carrying the path (the client
// draws markers + polyline; older clients ignore the extra field — the
// sse-protocol forward-compat rule), plus Google Routes walking distance/
// time (fail-soft null → the block reports straight-line only, honestly).
async function runJourneyEnrichment(env, log, emit, step, stepDone, conversation, state, journey) {
  step("maps", "Mapping the journey so far…");
  const points = journey.points;
  const [image, route, startPlace, endPlace] = await Promise.all([
    routeMapImage(env, log, points).catch(() => null),
    computeWalkingRoute(env, log, points),
    reverseGeocode(env, log, points[0].lat, points[0].lng),
    reverseGeocode(env, log, points[points.length - 1].lat, points[points.length - 1].lng),
  ]);
  state.mapsCount = 1;
  if (image) {
    const mid = points[Math.floor(points.length / 2)];
    emit({
      status: {
        type: "streetview_frames",
        title: `Route — ${points.length} stops`,
        query: "the journey so far",
        frames: [{ dir: "", label: `the journey — ${points.length} stops`, kind: "map", lat: mid.lat, lng: mid.lng, url: image }],
      },
    });
  }
  const embedKeyOk = !!googleMapsEmbedKey(env);
  if (embedKeyOk) {
    const mid = {
      lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
      lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
    };
    emit({ status: { type: "map_embed", lat: mid.lat, lng: mid.lng, zoom: 15, path: points } });
  }
  let straight = 0;
  for (let i = 1; i < points.length; i++) {
    straight += distanceMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  stepDone(
    "maps",
    `Journey mapped — ${points.length} stops`,
    [
      `≈${fmt(straight)} straight-line${route ? `, ≈${fmt(route.distanceMeters)} on foot` : ""}`,
    ],
  );
  return withAppendedText(
    conversation,
    buildJourneyBlock(points, { route, startPlace, endPlace, mapShown: !!image, embedShown: embedKeyOk }),
  );
}

// The current-map-view path (the road-map sibling of runPovEnrichment): the
// user panned/zoomed the live interactive map, so capture a road-map image
// of exactly the area they see (one Static Maps fetch at their center/zoom),
// have the vision helper answer their question about THAT map, and render a
// fresh interactive map at that view beside the reply so they can continue
// exploring from where they are (the client locks the superseded map, same
// as panoramas). Fail-soft like every branch: a failed capture degrades to
// an honest note, never a blocked chat.
async function runMapViewEnrichment(env, log, emit, step, stepDone, conversation, state, view, question) {
  step("maps", "Capturing your current map view…");
  let capture = null;
  try {
    capture = await runMapViewCapture(env, log, view);
  } catch (err) {
    log.warn("googlemaps.mapview_failed", { error: err?.message || String(err) });
  }
  const where = `${view.lat}, ${view.lng} (zoom ${view.zoom})`;
  if (!capture) {
    stepDone("maps", "Couldn't capture the current map view");
    return withAppendedText(
      conversation,
      "\n\n--- Google Maps ---\n" +
        `Google Maps & Street View is ENABLED and a capture of the user's current map view (centered at ${where}) was attempted, but no image could be fetched. ` +
        "Answer from the conversation so far and say plainly that the current map view couldn't be captured this time. " +
        "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
        "--- End of Google Maps ---",
    );
  }

  state.mapsCount = 1;
  let description = "";
  if (state.visionModel) {
    description = await describeStreetView(
      env,
      log,
      state,
      `This is a road-map image of exactly the area the user is currently viewing in an interactive Google Map beside this chat (centered at ${where}). There are NO Street View photos in this view.`,
      [capture.image],
      question,
      { mapOnly: true },
    );
  }

  // Continue-from-here: a fresh interactive map at the user's current view
  // beside THIS reply; rendering it locks the superseded map client-side.
  const mapShown = !!googleMapsEmbedKey(env);
  if (mapShown) {
    emit({ status: { type: "map_embed", lat: view.lat, lng: view.lng, zoom: view.zoom } });
  }

  stepDone(
    "maps",
    description ? "Current map view captured + described" : "Current map view captured",
    [where],
  );

  return withAppendedText(conversation, buildMapViewBlock(view, { description, mapShown }));
}

// Runs Street View / map images through a vision-capable helper model to
// produce a short factual description, so a NON-vision answer model (e.g. the
// default Mistral Small) can still tell the user what the location looks like.
// `intro` is the caller's first sentence saying what the imagery IS (the
// four-cardinal-frames look-around vs the user's exact current panorama
// view). When the user's question is passed, the helper answers IT from the
// imagery first — that's what lets a follow-up reason about the particular
// image instead of replaying a generic description. Its tokens go to
// state.visionTotals so chat.js bills them at that model's rate. Fully
// fail-soft: any error yields "" and the block falls back to the keyless
// Street View link.
async function describeStreetView(env, log, state, intro, images, question = "", { mapOnly = false } = {}) {
  const ask = question
    ? `The user's current question about this place is: "${question}". First answer that question strictly from what is actually visible in ${mapOnly ? "this map image" : "these photos"} — if ${mapOnly ? "the map" : "the photos"} cannot answer it, say so plainly. Then briefly describe`
    : "Describe";
  // A road map can't show architecture — asking for façades/floors made the
  // helper invent street-level detail from map labels; ask for what a MAP
  // actually shows instead.
  const detail = mapOnly
    ? "what the map shows factually in 2-3 sentences: the street layout, labeled roads, and any labeled businesses or places near the marker. Only state what is visible on the map; do not describe buildings or scenery the map cannot show, and do not guess anything not shown."
    : "the building and its immediate surroundings factually in 2-4 sentences: architecture/materials, " +
      "apparent use (residential, commercial, industrial), approximate number of floors, notable features, and the " +
      "street setting. Only state what is visible; do not guess an address, names, or anything not shown.";
  const content = [
    {
      type: "text",
      text: `${intro} ${ask} ${detail}`,
    },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  // Failover, not a single shot: production trace 2026-07-08 (describe_failed
  // "The operation was aborted") showed a loaded Mistral Medium missing the
  // 30s connect timeout while other vision models answered instantly — one
  // flaky model must not blind every answer about the imagery.
  const candidates = state.visionModels?.length ? state.visionModels : [state.visionModel].filter(Boolean);
  for (const model of candidates) {
    try {
      const upstream = await chatCompletion(env, [{ role: "user", content }], { model });
      if (!upstream.ok || !upstream.body) {
        // Capture Berget's error body: the bare status was not enough to
        // diagnose the Mistral-Medium image-count 400 (the detail had to be
        // re-derived with live probes — see model-profiles.js).
        const detail = await upstream.text().catch(() => "");
        log.warn("googlemaps.describe_failed", {
          status: upstream.status,
          model,
          images: images.length,
          detail: detail.slice(0, 200),
        });
        continue;
      }
      // Bounded read: the describe runs BEFORE triage, so an accepted-but-
      // stalled vision stream would otherwise hang the entire request on
      // "Checking Google Maps…" with no way out. A tripped guard throws into
      // the catch below — the next candidate gets its turn.
      const { text, usage } = await consumeChatStream(upstream.body, () => {}, {
        idleMs: 20_000,
        maxMs: 45_000,
      });
      addUsage(state.visionTotals, usage);
      const out = (text || "").trim();
      if (out) {
        // Bill the vision tokens at the rate of the model that actually
        // produced them (failed attempts contribute no usage).
        state.visionModel = model;
        return out;
      }
      log.warn("googlemaps.describe_failed", { model, images: images.length, error: "empty completion" });
    } catch (err) {
      log.warn("googlemaps.describe_failed", { model, error: err?.message || String(err) });
    }
  }
  return "";
}
