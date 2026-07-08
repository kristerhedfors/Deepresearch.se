// Google Maps enrichment descriptor for the enrichment registry
// (src/enrichments/index.js). A THIN wrapper around the existing Google Maps
// client (src/googlemaps.js) — it does NOT re-implement address extraction,
// the Places/Street View/Static Map calls, or the block builder, only adapts
// them to the registry's detect → run → {block, details, count, doneLabel,
// embed} contract. The vision-describe helper and the honest "already
// enabled, no data" note (both pipeline glue, not client logic) live here so
// the behavior is identical to the hand-wired runGoogleMapsEnrichment.

import { chatCompletion, consumeChatStream } from "../berget.js";
import { imagePartsOf, lastUserMessage } from "../conversation.js";
import {
  buildMapsBlock,
  googleMapsEmbedKey,
  pickLookup,
  runGoogleMapsLookup,
} from "../googlemaps.js";
import { googleMapsEnabled } from "../settings.js";

// The most images to hand the vision-describe helper in one request — the
// client's own per-message image cap, which Berget vision models accept
// reliably (a report of 5 attached frames drew a Berget 400).
const MAX_MAPS_IMAGES = 4;

function addUsage(totals, usage) {
  if (!usage || !totals) return;
  totals.prompt_tokens += usage.prompt_tokens || 0;
  totals.completion_tokens += usage.completion_tokens || 0;
}

// Runs the Street View / map images through a vision-capable helper model to
// produce a short factual description, so a NON-vision answer model (e.g. the
// default Mistral Small) can still tell the user what the location looks like.
// Its tokens go to state.visionTotals so chat.js bills them at that model's
// rate. Fully fail-soft: any error yields "" and the block falls back to the
// keyless Street View link.
async function describeStreetView(env, log, state, label, images) {
  try {
    const content = [
      {
        type: "text",
        text:
          `These are Google Street View photos (looking in different directions) and a road map of ${label}. ` +
          "Describe the building and its immediate surroundings factually in 2-4 sentences: architecture/materials, " +
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

export const googleMapsEnrichment = {
  id: "maps",
  settingsKey: "google_maps",
  stateFlag: "googleMaps", // chat.js pre-resolves the knob into this state flag
  countKey: "mapsCount",
  startLabel: "Checking Google Maps…",
  unavailableLabel: "No Google Maps data for that location",
  failEvent: "googlemaps.phase_failed",

  enabled(env, identity) {
    return googleMapsEnabled(env, identity);
  },

  // Silent when the message names no address and carries no photo location.
  detect(conversation, state) {
    return pickLookup(conversation, state?.imageLocations);
  },

  async run(ctx, target) {
    const { env, log, state, conversation } = ctx;
    // Fetch imagery when we have a vision helper to DESCRIBE it (and the
    // message isn't already carrying user images). The frames are never
    // attached to the ANSWER model — only the helper's TEXT description
    // reaches it — so the answer call can't fail from maps imagery.
    const alreadyHasImages = imagePartsOf(lastUserMessage(conversation)).length > 0;
    const fetchImages = !!state.visionModel && !alreadyHasImages;

    let result = null;
    try {
      result = await runGoogleMapsLookup(env, log, { ...target, fetchImages });
    } catch (err) {
      log.warn("googlemaps.phase_failed", { error: err?.message || String(err) });
    }
    if (!result) {
      // Knob is ON but the lookup returned nothing. Inject an honest note so
      // the model doesn't wrongly tell the user to enable an already-enabled
      // feature (a reported bug: empty lookups made the model claim Maps was
      // off and hand out enable instructions). Still counts as a real step
      // with a block, so it goes through the registry's normal path.
      const q = target.address || target.coords;
      return {
        block:
          "\n\n--- Google Maps ---\n" +
          `Google Maps & Street View is ENABLED and was checked for "${q}", but Google returned no usable data for this location ` +
          "(it may be unrecognized, have no Street View coverage, or the required Google Maps APIs may not be fully enabled on the server). " +
          "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
          "--- End of Google Maps ---",
        details: [],
        count: 0,
        doneLabel: "No Google Maps data for that location",
        embed: null,
      };
    }

    // Cap the images handed to the vision helper to what a single vision
    // request reliably accepts. Street View frames first, road map last.
    const images = [...result.streetViewImages, result.staticMapImage].filter(Boolean).slice(0, MAX_MAPS_IMAGES);

    let description = "";
    if (images.length) {
      description = await describeStreetView(env, log, state, result.displayQuery, images);
    }

    const block = buildMapsBlock(result.displayQuery, {
      place: result.place,
      lat: result.lat,
      lng: result.lng,
      streetView: result.streetView,
      streetViewCount: 0,
      hasMap: false,
      description,
    });

    // Hand the client the coordinates for an inline navigable Street View
    // embed — but ONLY when the browser-exposed embed key is configured. The
    // registry emits the streetview_embed event (after step_done, matching the
    // original ordering); the key itself is never sent (the client holds it).
    const embed = result.embed && googleMapsEmbedKey(env) ? result.embed : null;

    return {
      block,
      details: result.details,
      count: result.count,
      doneLabel: description ? "Google Maps data + Street View described" : "Google Maps data found",
      embed,
    };
  },
};
