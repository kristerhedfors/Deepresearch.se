// Reverse geocoding via OpenStreetMap's Nominatim — resolves decimal
// coordinates into a human-readable place name. This is now the FALLBACK
// reverse geocoder: src/maps.js prefers Google's Places API (New) and calls
// this only when the GOOGLE_MAPS_API_KEY secret is absent or the Google call
// fails, so a photo's/coordinate's location still resolves to a name without a
// Google key. Raw decimal coordinates alone are of little use to either the
// model (which can only guess loosely from training data) or Exa (which can't
// search on a lat/lon pair) — a resolved place name gives both something
// concrete to reason and search with.
//
// Runs server-side, not client-side: same as every other third-party call
// in this app (Berget, Exa), it's Worker-mediated so it's logged and rate-
// limited consistently, and it keeps the outbound request minimal — only
// the coordinates cross the wire to Nominatim, never the filename, the
// user's question, or any account/session identifier. The User-Agent
// below identifies this as an automated client (Nominatim's usage policy
// requires *some* non-default value or they filter the traffic as an
// unidentified bot) but is deliberately generic — no site name, no URL.

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
