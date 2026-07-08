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
import { buildMapsBlock, googleMapsEmbedKey, pickLookup, runGoogleMapsLookup } from "./googlemaps.js";
import { addUsage } from "./quota.js";
import { extractTargets, runShodanLookup } from "./shodan.js";

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
  const target = pickLookup(conversation, state.imageLocations);
  if (!target) return conversation;
  // The user's actual question, for the vision helper to ANSWER about the
  // imagery (not just generically describe it). The client appends labeled
  // document/metadata blocks after the typed text, so keep only what precedes
  // the first block, bounded.
  const question = textOf(lastUserMessage(conversation)?.content).split("\n\n---")[0].trim().slice(0, 400);

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
  // Cap the images handed to the vision helper to what a single vision request
  // reliably accepts (the client's own per-message cap is 4). Street View
  // frames first, road map last.
  const frames = Array.isArray(result.streetViewFrames) ? result.streetViewFrames : [];
  const images = [...frames.map((f) => f.url), result.staticMapImage].filter(Boolean).slice(0, MAX_MAPS_IMAGES);

  // Describe the imagery with the vision helper so the answer model (vision or
  // not) gets a factual look-around as TEXT — this is what makes "describe this
  // street view" work, and keeps the answer call free of the images that broke
  // it. The helper also gets the user's question so a follow-up ("what color
  // is the roof?") is answered from the CURRENT frames, not from memory of a
  // prior description. Fail-soft: no description → the block points at the
  // keyless link.
  let description = "";
  if (images.length) {
    description = await describeStreetView(env, log, state, result.displayQuery, images, question);
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

// Runs the Street View / map images through a vision-capable helper model to
// produce a short factual description, so a NON-vision answer model (e.g. the
// default Mistral Small) can still tell the user what the location looks like.
// When the user's question is passed, the helper answers IT from the imagery
// first — that's what lets a follow-up reason about the particular image
// instead of replaying a generic description. Its tokens go to
// state.visionTotals so chat.js bills them at that model's rate. Fully
// fail-soft: any error yields "" and the block falls back to the keyless
// Street View link.
async function describeStreetView(env, log, state, label, images, question = "") {
  try {
    const ask = question
      ? `The user's current question about this place is: "${question}". First answer that question strictly from what is actually visible in these photos — if the photos cannot answer it, say so plainly. Then briefly describe`
      : "Describe";
    const content = [
      {
        type: "text",
        text:
          `These are Google Street View photos (looking in different directions) and a road map of ${label}. ` +
          `${ask} the building and its immediate surroundings factually in 2-4 sentences: architecture/materials, ` +
          "apparent use (residential, commercial, industrial), approximate number of floors, notable features, and the " +
          "street setting. Only state what is visible; do not guess an address, names, or anything not shown.",
      },
      ...images.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
    const upstream = await chatCompletion(env, [{ role: "user", content }], { model: state.visionModel });
    if (!upstream.ok || !upstream.body) {
      log.warn("googlemaps.describe_failed", { status: upstream.status });
      return "";
    }
    const { text, usage } = await consumeChatStream(upstream.body, () => {});
    addUsage(state.visionTotals, usage);
    return (text || "").trim();
  } catch (err) {
    log.warn("googlemaps.describe_failed", { error: err?.message || String(err) });
    return "";
  }
}
