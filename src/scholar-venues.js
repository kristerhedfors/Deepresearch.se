// @ts-check
// GOOGLE SCHOLAR METRICS as a lookup table — the h5-index and h5-median of the
// venues Scholar ranks, read from the committed artifact
// public/scholar/venues.json (built by scripts/scholar-venues.mjs).
//
// This is the smallest and least glamorous half of the Google Scholar
// integration, and the half that does the most work in an answer. A peer-
// reviewed hit tells a reader that SOMEONE reviewed it; it does not tell them
// whether the venue is Nature or a journal that will print anything for a fee.
// Scholar's h5-index is a published, independent, per-venue number that
// separates the two, and folding it onto a citation line turns
//
//     [3] Nature Biotechnology, 2016
// into
//     [3] Nature Biotechnology (Scholar h5-index 218), 2016
//
// which is a claim the reader can check and the answer did not invent.
//
// Two properties matter:
//
//  1. **No outbound request.** The table is bytes in this deployment. Looking a
//     venue up tells Google nothing, which is the only version of this feature
//     compatible with invariant 4 — a live lookup would leak, per turn, which
//     journals someone's research question is about.
//  2. **Fail-soft to silence** (invariant 2). A missing, unreadable or
//     future-versioned artifact returns null and every caller simply omits the
//     annotation. Nothing about a research turn depends on it.

/** @typedef {import('./types.js').Env} Env */

/** The committed artifact, served from public/. */
export const VENUES_PATH = "/scholar/venues.json";

/** The artifact layout this module knows how to read. A different `version`
 * parses to null rather than being guessed at. */
export const VENUES_VERSION = 1;

/**
 * @typedef {Object} VenueTable
 * @property {number} n
 * @property {string} harvested ISO date the artifact was built
 * @property {Map<string, { name: string, h5: number, h5median: number, cats: string[] }>} byName
 *   keyed by `venueKey(name)`
 */

// Keyed on the ASSETS BINDING for the reason src/agent-registry.js and
// src/aadr.js both document: one binding per isolate, so this is still "parse
// once", but a caller holding a different binding can never be served another
// environment's artifact.
/** @type {WeakMap<object, VenueTable>} */
const cache = new WeakMap();

/**
 * Normalized venue key. Journal names arrive from four backends with four
 * house styles — "The New England Journal of Medicine" / "New Engl J Med" /
 * "N. Engl. J. Med." — so the key drops the leading article, punctuation and
 * case. It deliberately does NOT try to expand abbreviations: a wrong expansion
 * would attach the wrong h5-index to a citation, which is worse than attaching
 * none. Abbreviated names simply miss.
 * @param {string} name
 * @returns {string}
 */
export function venueKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim();
}

/**
 * Parse the artifact. Null — never a throw — for anything unexpected.
 * @param {any} raw
 * @returns {VenueTable | null}
 */
export function parseVenueTable(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== VENUES_VERSION) return null;
  if (!Array.isArray(raw.rows)) return null;
  /** @type {VenueTable['byName']} */
  const byName = new Map();
  for (const row of raw.rows) {
    if (!Array.isArray(row)) continue;
    const [name, h5, h5median, cats] = row;
    if (typeof name !== "string" || typeof h5 !== "number") continue;
    const key = venueKey(name);
    if (!key || byName.has(key)) continue;
    byName.set(key, {
      name,
      h5,
      h5median: typeof h5median === "number" ? h5median : 0,
      cats: typeof cats === "string" && cats ? cats.split(",") : [],
    });
  }
  if (!byName.size) return null;
  return { n: byName.size, harvested: String(raw.harvested || ""), byName };
}

/**
 * The venue table for this deployment, or null when it is unavailable.
 * A successful parse is cached for the isolate; a failure is not, so a
 * transient asset error retries next request instead of poisoning the isolate.
 * @param {Env} env
 * @returns {Promise<VenueTable | null>}
 */
export async function loadVenues(env) {
  const assets = /** @type {any} */ (env)?.ASSETS;
  if (!assets?.fetch) return null;
  if (cache.has(assets)) return cache.get(assets) || null;
  try {
    const res = await assets.fetch(new Request("https://assets.internal" + VENUES_PATH));
    if (!res.ok) return null;
    const parsed = parseVenueTable(await res.json());
    if (parsed) cache.set(assets, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The Scholar metrics for one venue name, or null when the table doesn't rank
 * it. Not ranking a venue is NOT a quality verdict — Scholar publishes the top
 * hundred per field, so most legitimate journals are absent — and callers must
 * word the annotation so it never reads as one.
 * @param {VenueTable | null | undefined} table
 * @param {string} name
 * @returns {{ name: string, h5: number, h5median: number, cats: string[] } | null}
 */
export function venueMetrics(table, name) {
  if (!table) return null;
  const key = venueKey(name);
  if (!key) return null;
  return table.byName.get(key) || null;
}

/**
 * The annotation appended to a citation's provenance line, or "" when the venue
 * is unranked. Phrased as the measurement it is ("Scholar h5-index 218") rather
 * than as a grade, and always attributed, because the number is Google's and
 * the reader should be able to go and check it.
 * @param {VenueTable | null | undefined} table
 * @param {string} name
 * @returns {string}
 */
export function venueNote(table, name) {
  const m = venueMetrics(table, name);
  return m ? `Scholar h5-index ${m.h5}` : "";
}

/**
 * The top-ranked venues of a subject category, most-cited first — the block the
 * enrichment folds in when someone asks WHERE to publish or read in a field.
 * @param {VenueTable | null | undefined} table
 * @param {string} cat one of the harvest's category codes (bus/chm/eng/med/hum/bio/phy/soc)
 * @param {number} [limit]
 * @returns {Array<{ name: string, h5: number, h5median: number }>}
 */
export function topVenues(table, cat, limit = 12) {
  if (!table) return [];
  const rows = [...table.byName.values()].filter((v) => !cat || v.cats.includes(cat));
  return rows.sort((a, b) => b.h5 - a.h5).slice(0, Math.max(0, limit));
}
