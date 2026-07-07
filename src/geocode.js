// Reverse geocoding via OpenStreetMap's Nominatim — resolves a photo's GPS
// EXIF coordinates (extracted client-side by public/js/exif.js) into a
// human-readable place name. Raw decimal coordinates alone are of little
// use to either the model (which can only guess loosely from training
// data) or Exa (which can't search on a lat/lon pair) — a resolved place
// name gives both something concrete to reason and search with.
//
// Runs server-side, not client-side: same as every other third-party call
// in this app (Berget, Exa), it's Worker-mediated so it's logged and rate-
// limited consistently, and it keeps the outbound request minimal — only
// the coordinates cross the wire to Nominatim, never the filename, the
// user's question, or any account/session identifier. The User-Agent
// below identifies this as an automated client (Nominatim's usage policy
// requires *some* non-default value or they filter the traffic as an
// unidentified bot) but is deliberately generic — no site name, no URL.

import { validateImageLocations } from "./validation.js";
import { withAppendedText } from "./conversation.js";

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const TIMEOUT_MS = 4000;
const GENERIC_USER_AGENT = "geocode-client/1.0";

// Returns a human-readable place name or null on any failure/timeout —
// fails soft, same as every other helper phase in this pipeline: a photo's
// location is enrichment, never a hard requirement for the chat to work.
export async function reverseGeocode(env, log, lat, lon) {
  try {
    const url = `${REVERSE_URL}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=0`;
    const resp = await fetch(url, {
      headers: { "User-Agent": GENERIC_USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("geocode.error", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    return typeof data?.display_name === "string" && data.display_name ? data.display_name : null;
  } catch (err) {
    log.warn("geocode.error", { error: err?.message || String(err) });
    return null;
  }
}

// Resolves every valid location in `rawLocations` and appends them to the
// conversation as one labeled context block, same convention as the
// client's own image/document metadata blocks — never silently dropped,
// never silently blended into the main text. Returns the conversation
// UNCHANGED when there's nothing valid to resolve or nothing resolves
// (Nominatim down, bad coordinates, etc.) — this must never block or
// delay the chat beyond a few resolved-in-parallel lookups.
//
// Emits a visible activity step (step_start/step_done, same SSE contract as
// the pipeline's own steps and the Shodan enrichment) that NAMES the service
// being contacted — OpenStreetMap Nominatim — so the user has the same
// "which external source is being checked" visibility for the maps lookup
// that they already have for web search and Shodan. Stays SILENT (no step)
// when there's no photo location to resolve, so an ordinary question shows
// no spurious step. `emit` is optional — a plain no-op keeps the function
// usable/testable outside the SSE path.
export async function augmentWithLocations(env, log, emit, conversation, rawLocations) {
  const locations = validateImageLocations(rawLocations);
  if (!locations.length) return conversation;

  const step = typeof emit === "function" ? emit : () => {};
  step({ status: { type: "step_start", id: "geocode", label: "Resolving photo location (OpenStreetMap)…" } });

  const resolved = await Promise.all(
    locations.map(async ({ name, lat, lon }) => ({ name, place: await reverseGeocode(env, log, lat, lon) })),
  );
  const usable = resolved.filter((r) => r.place);
  const details = usable.map((r) => `${r.name}: near ${r.place}`);

  step({
    status: {
      type: "step_done",
      id: "geocode",
      label: usable.length
        ? `Resolved ${usable.length} photo location${usable.length === 1 ? "" : "s"} via OpenStreetMap Nominatim`
        : "No place name resolved for the photo location(s)",
      details,
    },
  });

  if (!usable.length) return conversation;
  const block =
    "\n\n--- Resolved location(s) (via OpenStreetMap Nominatim) ---\n" +
    details.join("\n") +
    "\n--- End of resolved location(s) ---";
  return withAppendedText(conversation, block);
}
