// Location enrichment for photos carrying GPS EXIF (extracted client-side
// by public/js/exif.js). Raw decimal coordinates alone are of little use to
// either the model (which can only guess loosely from training data) or Exa
// (which can't search on a lat/lon pair) — so each photo's coordinates are
// enriched three ways, all appended to the conversation as one labeled block:
//   1. Reverse geocoding via OpenStreetMap's Nominatim → a human-readable
//      place name to reason and search with.
//   2. A Google Maps Street View deep link (the Maps URLs API — a plain URL,
//      no API key, no request to Google from this Worker) the model can hand
//      to the user so they can look at the spot at street level themselves.
//   3. Nearby establishments via OpenStreetMap's Overpass API — named
//      amenities/shops within walking distance, so questions about a photo's
//      surroundings ("what's the café across the street?") have concrete
//      names to answer and search with.
//
// Runs server-side, not client-side: same as every other third-party call
// in this app (Berget, Exa), it's Worker-mediated so it's logged and rate-
// limited consistently, and it keeps the outbound requests minimal — only
// the coordinates cross the wire to Nominatim/Overpass, never the filename,
// the user's question, or any account/session identifier. The User-Agent
// below identifies this as an automated client (both services' usage
// policies require *some* non-default value or they filter the traffic as
// an unidentified bot) but is deliberately generic — no site name, no URL.

import { validateImageLocations } from "./validation.js";
import { withAppendedText } from "./conversation.js";

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const TIMEOUT_MS = 4000;
const GENERIC_USER_AGENT = "geocode-client/1.0";

const NEARBY_RADIUS_M = 250;
const NEARBY_MAX = 20;
// The OSM tag families that mean "an establishment someone might ask about"
// — checked in this order when labeling a result's kind.
const NEARBY_TAGS = ["amenity", "shop", "tourism", "leisure"];

// Google Maps URLs API Street View deep link — a universal URL (opens the
// interactive panorama nearest the coordinates in the Maps app or browser)
// that requires no API key and sends nothing from this Worker; it only
// resolves when the user chooses to open it.
export function streetViewUrl(lat, lon) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat}%2C${lon}`;
}

// Overpass QL: named establishments within the radius, across the tag
// families above. `out center` gives ways/relations a representative point
// (unused today, but keeps the response shape uniform).
export function overpassQuery(lat, lon) {
  const around = `around:${NEARBY_RADIUS_M},${lat},${lon}`;
  const clauses = NEARBY_TAGS.map((t) => `nwr(${around})[name][${t}];`).join("");
  return `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000)}];(${clauses});out center ${NEARBY_MAX * 3};`;
}

// Pure: Overpass elements → deduped "Name (kind)" strings, capped at
// NEARBY_MAX. Elements without a usable name are skipped; duplicate names
// (the same place mapped as both node and way, or matching two tag
// families) collapse to one entry.
export function formatNearby(elements) {
  if (!Array.isArray(elements)) return [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    if (out.length >= NEARBY_MAX) break;
    const name = typeof el?.tags?.name === "string" ? el.tags.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = NEARBY_TAGS.map((t) => el.tags[t]).find((v) => typeof v === "string" && v);
    out.push(kind ? `${name} (${kind.replace(/_/g, " ")})` : name);
  }
  return out;
}

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

// Named establishments near the coordinates, as display strings — [] on any
// failure/timeout (fails soft, same rationale as reverseGeocode above).
export async function nearbyEstablishments(env, log, lat, lon) {
  try {
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "User-Agent": GENERIC_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "data=" + encodeURIComponent(overpassQuery(lat, lon)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("geocode.nearby_error", { status: resp.status });
      return [];
    }
    const data = await resp.json();
    return formatNearby(data?.elements);
  } catch (err) {
    log.warn("geocode.nearby_error", { error: err?.message || String(err) });
    return [];
  }
}

// Enriches every valid location in `rawLocations` (place name + Street View
// link + nearby establishments, resolved in parallel) and appends them to
// the conversation as one labeled context block, same convention as the
// client's own image/document metadata blocks — never silently dropped,
// never silently blended into the main text. Returns the conversation
// UNCHANGED when there's nothing valid to enrich — this must never block or
// delay the chat beyond a few resolved-in-parallel lookups. Unlike the
// original Nominatim-only version, a lookup failure no longer drops the
// whole entry: valid coordinates always yield at least the Street View link.
export async function augmentWithLocations(env, log, conversation, rawLocations) {
  const locations = validateImageLocations(rawLocations);
  if (!locations.length) return conversation;

  const entries = await Promise.all(
    locations.map(async ({ name, lat, lon }) => {
      const [place, nearby] = await Promise.all([
        reverseGeocode(env, log, lat, lon),
        nearbyEstablishments(env, log, lat, lon),
      ]);
      const lines = [
        place ? `${name}: near ${place}` : `${name}: at coordinates ${lat}, ${lon}`,
        `  Street View (open to look around at street level): ${streetViewUrl(lat, lon)}`,
      ];
      if (nearby.length) {
        lines.push(`  Establishments within ${NEARBY_RADIUS_M} m: ${nearby.join("; ")}`);
      }
      return lines.join("\n");
    }),
  );

  const block =
    "\n\n--- Resolved location(s) (via OpenStreetMap) ---\n" +
    entries.join("\n") +
    "\n--- End of resolved location(s) ---";
  return withAppendedText(conversation, block);
}
