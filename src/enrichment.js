// Pre-pipeline context enrichments: the opt-in Shodan and Google Maps
// phases that resolve things the latest message NAMES (a host/IP, a street
// address, an attached photo's GPS) into labeled context blocks appended to
// the conversation before any model call — so triage, search, and synthesis
// all see the data. Extracted from pipeline.js so the phase orchestrator
// stays about the research flow itself; both enrichments follow the same
// contract: silent (no step, no conversation change) when the message names
// nothing to look up, a visible activity step naming the external service
// when it does, and fail-soft in every branch — the conversation comes back
// unchanged rather than ever blocking a chat.

import { chatCompletion, consumeChatStream } from "./berget.js";
import { imagePartsOf, lastUserMessage, textOf, withAppendedText } from "./conversation.js";
import { getModelProfile } from "./model-profiles.js";
import {
  buildMapsBlock,
  buildPovBlock,
  compassDir,
  googleMapsEmbedKey,
  runGoogleMapsLookup,
  runStreetViewPovCapture,
  unresolvedMapsBlock,
} from "./googlemaps.js";
import { pickLookup, streetViewIntent } from "./googlemaps-text.js";
import { addUsage } from "./quota.js";
import { extractTargets, runShodanLookup } from "./shodan.js";

// The enrichment registry — the pre-pipeline counterpart of the
// search-source registry (src/search-sources.js), and for the same
// parallel-work reason: a new enrichment is ONE runner in this file plus
// ONE entry here; pipeline.js calls runEnrichments() once and never names
// an individual enrichment. Entry contract: `id` (log/step slug),
// `enabled(state)` (the per-user knob gate resolved in chat.js), and
// `run(ctx)` receiving {env, log, emit, step, stepDone, conversation,
// state} and returning the (possibly augmented) conversation. Order
// matters and is deliberate: each runner sees the conversation as left by
// the previous one. Every runner must keep the standing contract: silent
// when the message names nothing to look up, a visible step naming the
// external service when it does, fail-soft in every branch.
const ENRICHMENTS = [
  {
    id: "shodan",
    enabled: (state) => !!state.shodan,
    run: (c) => runShodanEnrichment(c.env, c.log, c.step, c.stepDone, c.conversation, c.state),
  },
  {
    id: "maps",
    enabled: (state) => !!state.googleMaps,
    run: (c) => runGoogleMapsEnrichment(c.env, c.log, c.emit, c.step, c.stepDone, c.conversation, c.state),
  },
];

// Runs every knob-enabled enrichment in registry order. A throwing runner
// is contained here (the conversation passes through unchanged) so a buggy
// enrichment can never take down the chat — same fail-soft rule its
// internals already follow.
export async function runEnrichments(env, log, emit, step, stepDone, conversation, state) {
  let convo = conversation;
  for (const e of ENRICHMENTS) {
    if (!e.enabled(state)) continue;
    try {
      convo = await e.run({ env, log, emit, step, stepDone, conversation: convo, state });
    } catch (err) {
      log.warn(`${e.id}.enrichment_failed`, { error: err?.message || String(err) });
    }
  }
  return convo;
}

// Shodan enrichment: resolve any host/IP the latest message names into
// live infrastructure data and append it as a labeled context block —
// an ordinary question with the knob left on costs nothing and shows no
// spurious step. Otherwise it emits a visible activity step whose
// expandable details list each host, and returns the augmented
// conversation.
export async function runShodanEnrichment(env, log, step, stepDone, conversation, state) {
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const { ips, hostnames } = extractTargets(lastUser);
  if (!ips.length && !hostnames.length) return conversation;

  step("shodan", "Querying Shodan…");
  let result = null;
  try {
    result = await runShodanLookup(env, log, conversation);
  } catch (err) {
    log.warn("shodan.phase_failed", { error: err?.message || String(err) });
  }
  if (!result) {
    stepDone("shodan", "Shodan lookup unavailable — continuing without it");
    return conversation;
  }
  state.shodanCount = result.count;
  const label = result.count
    ? `Shodan: ${result.count} host${result.count === 1 ? "" : "s"} found`
    : "Shodan: no records for the host(s) named";
  stepDone("shodan", label, result.details);
  return withAppendedText(conversation, result.block);
}

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
  const target = pickLookup(conversation, state.imageLocations, state.streetViewPov);
  if (!target) {
    // An EXPLICIT street-view ask that resolved to nothing still needs an
    // honest note: with no block at all the model invents "enable Google
    // Maps in Settings" steps at a user whose knob is ON (reported verbatim:
    // "Street view of LEGO offices in Copenhagen", pre-named-place support).
    if (streetViewIntent(textOf(lastUserMessage(conversation)?.content))) {
      return withAppendedText(conversation, unresolvedMapsBlock());
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
  if (images.length) {
    const hasMap = !!result.staticMapImage && images.includes(result.staticMapImage);
    description = await describeStreetView(
      env,
      log,
      state,
      `These are Google Street View photos (looking in different directions)${hasMap ? " and a road map" : ""} of ${result.displayQuery}.`,
      images,
      question,
    );
  }

  // Snap the frames into the reply: the client renders the very images the
  // vision helper reasoned about beside the answer, so the user sees the same
  // context the model saw (data URLs are already fetched — no extra billing).
  if (frames.length) {
    emit({ status: { type: "streetview_frames", query: result.displayQuery, frames } });
  }

  const block = buildMapsBlock(result.displayQuery, {
    place: result.place,
    lat: result.lat,
    lng: result.lng,
    streetView: result.streetView,
    streetViewCount: 0,
    hasMap: false,
    description,
    followUp: !!target.followUp,
    framesShown: frames.length,
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
        frames: [{ dir: "", label: "your current view", url: capture.image }],
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
async function describeStreetView(env, log, state, intro, images, question = "") {
  const ask = question
    ? `The user's current question about this place is: "${question}". First answer that question strictly from what is actually visible in these photos — if the photos cannot answer it, say so plainly. Then briefly describe`
    : "Describe";
  const content = [
    {
      type: "text",
      text:
        `${intro} ` +
        `${ask} the building and its immediate surroundings factually in 2-4 sentences: architecture/materials, ` +
        "apparent use (residential, commercial, industrial), approximate number of floors, notable features, and the " +
        "street setting. Only state what is visible; do not guess an address, names, or anything not shown.",
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
