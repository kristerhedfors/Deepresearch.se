// @ts-check
// THE ANCIENT-SAMPLE QUERY CORE — pure logic over the committed sample
// artifact (public/aadr/samples.tsv.json, built by scripts/aadr-build.mjs).
//
// What this answers is the question a palaeogenomics researcher actually asks
// and no chat interface answers well:
//
//   "ancient individuals within 200 km of Uppsala dated 5000–4000 BP with a
//    Y-haplogroup, sorted by coverage"
//
// That is a STRUCTURED query — geography, a time window, a haplogroup prefix, a
// coverage floor — over 20,927 published individuals. A language model asked
// this from memory invents sample IDs, misplaces dates by millennia and cites
// papers that do not exist. Answered from the table instead, every row is a
// real published individual with a real accession, and the answer can say how
// many matched rather than how many it recalled.
//
// PURE, and in public/js/ for the usual reason: a browser can only import
// served modules, so shared cores live here and the Worker re-exports them
// (src/aadr.js is the façade). Nothing in this file fetches, logs, or reads a
// binding — it takes the parsed artifact and a string, and returns data.
//
// ---- the three deliberate refusals ------------------------------------------
//
// 1. **No geocoder.** "Near Uppsala" is resolved against the dataset's OWN
//    place and country dictionaries — the centroid of the samples already
//    recorded there — not by asking Nominatim or Google. That keeps a
//    structured sample query free of any outbound request at all, which is the
//    privacy property worth having here: the question never leaves the Worker.
//    The cost is honest and bounded — a place with no samples cannot anchor a
//    radius, and the block says so rather than silently returning nothing.
// 2. **No genotypes.** The artifact carries per-individual METADATA. Genotype
//    data stays upstream in the Poseidon/AADR packages, where it belongs: it is
//    gigabytes, it is licensed, and no research turn needs it in context.
// 3. **No inferred ancestry.** This core filters and counts. It does not run
//    f-statistics, qpAdm or PCA, and an answer built on it must not imply that
//    it did. Those belong in the execution sandbox with the real tools
//    (container/palaeo/Dockerfile), against the real genotype files.
//
// ---- the Ignore_ convention, which a naive reader gets wrong -----------------
//
// AADR (and Poseidon after it) marks individuals that must NOT enter an
// analysis by prefixing their group label with `Ignore_` — contaminated
// libraries, duplicates of another sample, first-degree relatives kept for
// reference, failed captures. There are thousands of them and they look exactly
// like ordinary rows. Counting them into an answer is not a rounding error; it
// is the specific mistake the convention exists to prevent. So they are
// EXCLUDED by default here and reported separately, and a caller has to ask for
// them explicitly (`includeIgnored`).

/** Where the built artifact is served from. */
export const SAMPLES_PATH = "/aadr/samples.tsv.json";

/** The column layout this core understands. scripts/aadr-build.mjs writes
 * `layout` into the artifact; a mismatch is refused rather than read shifted. */
export const SAMPLES_LAYOUT = 1;

/** Column order in the artifact's TSV rows (layout 1). */
export const COLUMNS = [
  "id", "grp", "ctry", "place", "lat", "lon",
  "dtype", "dstart", "dmed", "dstop", "c14bp",
  "mt", "y", "sex", "snps", "cov", "pkg", "pub",
];

/** Date_Type enum, mirrored from the build script. */
export const DATE_TYPES = { 0: "unknown", 1: "radiocarbon", 2: "contextual", 3: "present-day" };

/** The radiocarbon "present" — 1950 CE by convention, which is what BP means.
 * Using 2000 or "now" here would shift every converted date by half a century,
 * which matters for the Holocene questions this is most often asked. */
export const BP_ZERO = 1950;

/** Default radius when a message says "near X" without a distance. Wide enough
 * to cover a region's sites, narrow enough to mean something. */
export const DEFAULT_RADIUS_KM = 250;

/** Rows carried into the context block. Beyond this the block reports
 * aggregates instead — 400 rows of table is not an answer. */
export const BLOCK_ROWS = 30;

// ---- parsing the artifact --------------------------------------------------

/**
 * @typedef {Object} SampleDataset
 * @property {number} n
 * @property {string[]} id
 * @property {Int32Array} grp
 * @property {Int32Array} ctry
 * @property {Int32Array} place
 * @property {Float64Array} lat
 * @property {Float64Array} lon
 * @property {Int32Array} dtype
 * @property {Float64Array} dstart
 * @property {Float64Array} dmed
 * @property {Float64Array} dstop
 * @property {Float64Array} c14bp
 * @property {string[]} mt
 * @property {string[]} y
 * @property {Int32Array} sex
 * @property {Float64Array} snps
 * @property {Float64Array} cov
 * @property {Int32Array} pkg
 * @property {Int32Array} pub
 * @property {Uint8Array} ignored
 * @property {Record<string, string[]>} dict
 * @property {Record<string, string>} packageDesc
 * @property {Record<string, number>} counts
 * @property {any} source
 * @property {Map<string, number[]>} placeSeg
 * @property {string[]} countryLower
 * @property {Map<string, number>} countryIdx
 * @property {Set<string>} groupSeg
 */

/**
 * Parses the built artifact into columnar arrays. Null — never a throw — for a
 * missing, malformed or wrong-layout artifact, so every caller degrades to "no
 * sample data" (invariant 2).
 * @param {any} artifact
 * @returns {SampleDataset | null}
 */
export function parseSamples(artifact) {
  if (!artifact || typeof artifact !== "object") return null;
  if (artifact.layout !== SAMPLES_LAYOUT) return null;
  if (typeof artifact.rows !== "string" || !artifact.rows) return null;

  const lines = artifact.rows.split("\n");
  const n = lines.length;
  const num = () => new Float64Array(n).fill(NaN);
  const idx = () => new Int32Array(n).fill(-1);

  const d = /** @type {SampleDataset} */ ({
    n,
    id: new Array(n),
    grp: idx(), ctry: idx(), place: idx(), pkg: idx(), pub: idx(),
    lat: num(), lon: num(), dstart: num(), dmed: num(), dstop: num(),
    c14bp: num(), snps: num(), cov: num(),
    dtype: new Int32Array(n), sex: new Int32Array(n),
    mt: new Array(n), y: new Array(n),
    ignored: new Uint8Array(n),
    dict: artifact.dict || {},
    packageDesc: artifact.packageDesc || {},
    counts: artifact.counts || {},
    source: artifact.source || {},
    placeSeg: new Map(),
    countryLower: [],
    countryIdx: new Map(),
    groupSeg: new Set(),
  });

  const groups = d.dict.group || [];
  for (let i = 0; i < n; i++) {
    const f = lines[i].split("\t");
    d.id[i] = f[0] || "";
    d.grp[i] = f[1] === "" ? -1 : +f[1];
    d.ctry[i] = f[2] === "" ? -1 : +f[2];
    d.place[i] = f[3] === "" ? -1 : +f[3];
    d.lat[i] = f[4] === "" ? NaN : +f[4] / 1000;
    d.lon[i] = f[5] === "" ? NaN : +f[5] / 1000;
    d.dtype[i] = f[6] === "" ? 0 : +f[6];
    d.dstart[i] = f[7] === "" ? NaN : +f[7];
    d.dmed[i] = f[8] === "" ? NaN : +f[8];
    d.dstop[i] = f[9] === "" ? NaN : +f[9];
    d.c14bp[i] = f[10] === "" ? NaN : +f[10];
    d.mt[i] = f[11] || "";
    d.y[i] = f[12] || "";
    d.sex[i] = f[13] === "" ? 0 : +f[13];
    d.snps[i] = f[14] === "" ? NaN : +f[14];
    d.cov[i] = f[15] === "" ? NaN : +f[15] / 100;
    d.pkg[i] = f[16] === "" ? -1 : +f[16];
    d.pub[i] = f[17] === "" ? -1 : +f[17];
    // The Ignore_ convention (see the header) — resolved once, at parse time,
    // so no query path can forget to apply it.
    const g = d.grp[i] >= 0 ? groups[d.grp[i]] || "" : "";
    d.ignored[i] = /^ignore[_.]/i.test(g) ? 1 : 0;
  }

  // ---- entity indexes, built once per dataset --------------------------------
  //
  // Both are SEGMENT indexes, and both directions of the naive version are
  // wrong in a way that produces confident nonsense:
  //
  // * Place strings are compound ("Gotland, Västerbjers, Sweden", "Samara
  //   Oblast, Volga River Valley, Lopatino II, Russia"). Asking whether the
  //   whole string appears in the message never matches — nobody types the
  //   comma-joined form — so a place index keyed on whole strings finds
  //   nothing, always. Keyed on comma-separated SEGMENTS, "Gotland" resolves to
  //   every place that names Gotland, which is what "near Gotland" means.
  // * Group labels are underscore-compound ("Russia_EBA_Yamnaya_Samara"), so a
  //   population name is a segment of a label, never a label. But matching a
  //   message token as a bare SUBSTRING of a label matches far too much:
  //   probed on this corpus, "dated" matched because a label contains
  //   `possmisdated`, and "ancient DNA samples DATED 5000-4000 BP" silently
  //   acquired a population filter nobody asked for. Segment equality is the
  //   fix — `dated` is not a segment of `possmisdated`, `yamnaya` is a segment
  //   of `Russia_EBA_Yamnaya_Samara`.
  for (let i = 0; i < (d.dict.place || []).length; i++) {
    for (const seg of String(d.dict.place[i]).split(",")) {
      const k = seg.trim().toLowerCase();
      if (k.length < 4) continue;
      addPlaceKey(d, k, i);
      // …and the individual WORDS of a compound segment, because upstream
      // records administrative units ("Samara Oblast", "Sergiyevsky District")
      // while people name the place ("near Samara"). Words shorter than five
      // characters and the administrative vocabulary itself are skipped, or
      // "valley" would resolve to every valley on earth.
      if (!k.includes(" ")) continue;
      for (const w of k.split(/[^\p{L}\p{N}]+/u)) {
        if (w.length >= 5 && !PLACE_NOISE.has(w)) addPlaceKey(d, w, i);
      }
    }
  }
  d.countryLower = (d.dict.country || []).map((s) => s.toLowerCase());
  // Countries below four characters are dropped from the lookup, not from the
  // data: "Chad" and "Mali" are also ordinary words, and a country filter is a
  // hard AND that would silently empty an unrelated query.
  d.countryLower.forEach((v, i) => {
    if (v.length >= 4) d.countryIdx.set(v, i);
  });
  for (const g of d.dict.group || []) {
    for (const seg of String(g).split(/[_.\-()]+/)) {
      const k = seg.trim().toLowerCase();
      if (k.length >= 4) d.groupSeg.add(k);
    }
  }
  return d;
}

// ---- the intent gate -------------------------------------------------------

/** Subject matter that puts a message in this dataset's territory, EN + SV.
 * Deliberately about SAMPLES and populations rather than about ancient DNA in
 * general: "how does ancient DNA degrade" is a literature question, not a
 * sample-table question, and answering it from a table of individuals would be
 * a worse answer than the literature leg gives. */
const SAMPLE_SUBJECT =
  /\b(ancient (?:individual|individuals|sample|samples|genome|genomes|dna sample\w*)|aadr|poseidon|\.janno\b|eigenstrat|haplogroups?|haplotypes?|y[-\s]?chromosom\w*|mtdna|mitochondrial haplogroup|burials?|skeletons?|remains|excavat\w*|archaeological sites?|radiocarbon dat\w*|population genetics|admixture|ancestry|ancient population\w*|steppe ancestry|hunter[-\s]?gatherers?|neolithic|mesolithic|palaeolithic|paleolithic|bronze age|iron age|viking age|corded ware|beaker|yamnaya)\b|\b(forntida (?:individ\w*|prov\w*|genom\w*)|fornlämning\w*|gravfält|skelett\w*|kvarlev\w*|utgrävning\w*|haplogrupp\w*|y-?kromosom\w*|mtdna|mitokondrie\w*|kol-?14|radiokoldat\w*|befolkningsgenetik|härkomst|härstamning|inblandning|jägar-?samlar\w*|neolit\w*|mesolit\w*|paleolit\w*|bronsålder\w*|järnålder\w*|vikingatid\w*|stridsyxekultur\w*|gropkeramisk\w*)\b/i;

/** The query SHAPE — asking for a set of things rather than for an explanation.
 * Requires a counting/listing/locating verb or an explicit filter clause. */
const SAMPLE_QUERY_SHAPE =
  /\b(how many|list|show|find|which|what|where|search|count|sorted?|filter\w*|between|within|near|older than|younger than|dated?|coverage|from the database|in the dataset)\b|\b(hur många|lista|visa|hitta|sök|vilka|vilken|var\b|räkna|sorter\w*|filtrer\w*|mellan|inom|nära|äldre än|yngre än|daterad?e?|täckning|i databasen|i datasetet)\b/i;

/** Naming the dataset itself. */
const SAMPLE_NAMED = /\b(aadr|allen ancient dna resource|poseidon|reich lab|\.janno\b|sample (?:database|table)|provdatabas\w*)\b/i;

/**
 * Does this message want the structured sample table? Two ways in: it names the
 * dataset, or it combines this dataset's subject matter with a query shape.
 * Conservative on purpose — a miss costs a less specific answer, a false fire
 * spends context on 30 irrelevant rows.
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function ancientSampleIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  if (SAMPLE_NAMED.test(s)) return true;
  return SAMPLE_SUBJECT.test(s) && SAMPLE_QUERY_SHAPE.test(s);
}

/** Names the dataset explicitly — the tier that justifies spending the whole
 * block on rows even when the question is vague.
 * @param {string} text
 * @returns {boolean} */
export function ancientSampleLeadIntent(text) {
  return SAMPLE_NAMED.test(String(text || ""));
}

// ---- query parsing ---------------------------------------------------------

/**
 * @typedef {Object} SampleQuery
 * @property {{ lat: number, lon: number, km: number, label: string } | null} near
 * @property {{ from: number, to: number, label: string } | null} when
 * @property {{ mt: string | null, y: string | null, either: string | null }} haplo
 * @property {string | null} group
 * @property {number | null} country dictionary index
 * @property {number[] | null} places dictionary indexes of every matching place
 * @property {1 | 2 | null} sex
 * @property {number | null} minCoverage
 * @property {boolean} ancientOnly
 * @property {boolean} includeIgnored
 * @property {string[]} notes human-readable account of what was understood
 */

// ---- Unicode-safe word boundaries ------------------------------------------
//
// JavaScript's `\b` is defined over [A-Za-z0-9_] only, so `å ä ö` are NOT word
// characters to it: `/\häldre än/` can never match " äldre än", and `\w*` as a
// Swedish suffix wildcard stops dead at the first accented letter. Both fail
// SILENTLY — the English alternatives in the same group keep working, so the
// gate looks alive while the Swedish half of invariant 6 is inert. Measured
// here during development: "äldre än 3000 år" parsed to no date window at all
// because of exactly this. Every bilingual pattern below therefore uses
// lookaround boundaries and the `u` flag.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
const L = "[\\p{L}]*";
/** @param {string} body @param {string} [flags] */
const re = (body, flags = "iu") => new RegExp(B + "(?:" + body + ")" + E, flags);

/** Era markers → how to convert a number to a BC/AD year. */
const ERAS = [
  { re: re("bp|before present|years? ago|år sedan|år gamla|år gammal|år|f\\.?\\s?v\\.?\\s?t\\.?"), conv: (/** @type {number} */ n) => BP_ZERO - n, name: "BP" },
  { re: re("bce|bc|f\\.?\\s?kr\\.?"), conv: (/** @type {number} */ n) => -n, name: "BCE" },
  { re: re("ce|ad|e\\.?\\s?kr\\.?|e\\.?\\s?v\\.?\\s?t\\.?"), conv: (/** @type {number} */ n) => n, name: "CE" },
];

/** A distance, in km or in Swedish "mil" (which is 10 km). */
const NEAR_DISTANCE = re("(\\d{1,4})\\s*(km|kilomet(?:er|re)s?|mil)", "iu");
const NEAR_WORD = re(
  "near|nearby|close to|around|within|surrounding|nära|i närheten av|omkring|runt|kring|inom",
);

// The haplogroup patterns are case-insensitive on the LABEL too: a user types
// "r1b" as readily as "R1b". The capture is upper-cased by the caller.
// The haplogroup patterns are case-insensitive on the LABEL too: a user types
// "r1b" as readily as "R1b". The connective words are matched EXPLICITLY rather
// than skipped with a lazy wildcard — a `\\D{0,14}?` gap happily lets the capture
// land on the word "haplogroup" itself, which is how "mtDNA haplogroup U5"
// parsed to the haplogroup "HAPLOGROUP" during development.
const CONNECT = "\\s*(?:haplogroups?|haplogrupp(?:en|er)?|hg|group|grupp)?\\s*[:\\-]?\\s*";
const LABEL = "([a-z][0-9a-z]{0,9})";
const Y_HAPLO = new RegExp(
  B + "(?:y[-\\s]?(?:chromosom(?:e|al)|dna|haplogroup|haplogrupp)|y-hg|paternal|f\u00e4dernelinje" + L + ")" +
    CONNECT + B + LABEL + E,
  "iu",
);
const MT_HAPLO = new RegExp(
  B + "(?:mt[-\\s]?(?:dna|haplogroup|haplogrupp)|mtdna|mitochondrial|mitokondrie" + L +
    "|maternal|m\u00f6dernelinje" + L + ")" + CONNECT + B + LABEL + E,
  "iu",
);
const ANY_HAPLO = new RegExp(
  B + "(?:haplogroups?|haplogrupp(?:en|er)?)" + CONNECT + B + LABEL + E,
  "iu",
);

const FEMALE = re("female|females|women|woman|kvinna|kvinnor|kvinnliga|kvinnlig");
const MALE = re("male|males|men|man|män|manliga|manlig");
const COVERAGE = new RegExp(
  B + "(?:coverage|täckning|depth)\\D{0,20}?(\\d+(?:\\.\\d+)?)\\s*[x×]?" + E +
    "|" + B + "(\\d+(?:\\.\\d+)?)\\s*[x×]\\s*(?:coverage|täckning)" + E,
  "iu",
);
const MODERN = re(
  "present[-\\s]?day|modern|contemporary|living|reference panel|nutida|nulevande|moderna|referenspanel",
);
const IGNORED = re("ignore[_d]?|flagged|contaminated|excluded|kontaminerad" + L + "|flaggad" + L);

const RANGE = new RegExp(
  "(?:between\\s+|mellan\\s+)?(\\d{2,6})\\s*(?:–|—|-|to|and|till|och)\\s*(\\d{2,6})\\s*([^,;!?]{0,20})",
  "iu",
);
const OLDER = new RegExp(
  B + "(?:older than|more than|över|äldre än|mer än)\\s+(\\d{2,6})\\s*([^,;!?]{0,20})",
  "iu",
);
const YOUNGER = new RegExp(
  B + "(?:younger than|less than|newer than|yngre än|mindre än)\\s+(\\d{2,6})\\s*([^,;!?]{0,20})",
  "iu",
);
const AROUND = new RegExp(
  B + "(?:around|about|circa|c\\.|ca\\.?|omkring|cirka|runt)\\s+(\\d{2,6})\\s*([^,;!?]{0,20})",
  "iu",
);
const BARE_DATE = new RegExp(
  "(\\d{2,6})\\s*" + B + "(bp|bce|bc|ce|ad|f\\.?\\s?kr\\.?|e\\.?\\s?kr\\.?|years? ago|år sedan)" + E,
  "iu",
);

/** Reads the era marker nearest after a match, defaulting to BP — which is how
 * palaeogenomics states a date when it does not say.
 * @param {string} tail */
function eraFor(tail) {
  for (const e of ERAS) if (e.re.test(tail)) return e;
  return ERAS[0];
}

/**
 * The time window a message asks for, as BC/AD years (negative = BCE).
 * Returns null when the message states no date at all.
 * @param {string} text
 * @returns {{ from: number, to: number, label: string } | null}
 */
export function parseDateWindow(text) {
  const s = String(text || "");

  // A RANGE: "5000–4000 BP", "between 3000 and 1000 BC", "mellan 5000 och 4000 f.Kr."
  const range = s.match(RANGE);
  if (range) {
    const era = eraFor(range[3] || s.slice(range.index || 0));
    const a = era.conv(+range[1]);
    const b = era.conv(+range[2]);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return { from, to, label: `${range[1]}–${range[2]} ${era.name}` };
  }

  // OLDER THAN / ÄLDRE ÄN — an open-ended window into the past.
  const older = s.match(OLDER);
  if (older) {
    const era = eraFor(older[2] || "");
    return { from: -Infinity, to: era.conv(+older[1]), label: `older than ${older[1]} ${era.name}` };
  }

  // YOUNGER THAN / YNGRE ÄN.
  const younger = s.match(YOUNGER);
  if (younger) {
    const era = eraFor(younger[2] || "");
    return { from: era.conv(+younger[1]), to: Infinity, label: `younger than ${younger[1]} ${era.name}` };
  }

  // AROUND / OMKRING — a point date, widened to a window a date estimate can
  // actually be compared against. ±500 years is roughly the spread of an
  // uncalibrated radiocarbon estimate on a Pleistocene sample.
  const around = s.match(AROUND);
  if (around) {
    const era = eraFor(around[2] || "");
    const y = era.conv(+around[1]);
    return { from: y - 500, to: y + 500, label: `around ${around[1]} ${era.name} (±500 y)` };
  }

  // A bare dated number with an explicit era: "samples from 4000 BP".
  const bare = s.match(BARE_DATE);
  if (bare) {
    const era = eraFor(bare[2]);
    const y = era.conv(+bare[1]);
    return { from: y - 500, to: y + 500, label: `${bare[1]} ${era.name} (±500 y)` };
  }
  return null;
}

/** Distance in km between two lat/lon points (haversine, mean Earth radius).
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Administrative and landform vocabulary — real words inside place strings
 * that name no place on their own. */
const PLACE_NOISE = new Set([
  "oblast", "district", "region", "province", "county", "village", "valley", "river", "island",
  "islands", "mountain", "mountains", "north", "south", "east", "west", "central", "upper",
  "lower", "cave", "caves", "site", "necropolis", "cemetery", "burial", "grave", "tomb",
  "krai", "raion", "governorate", "prefecture", "municipality", "commune", "canton",
]);

/** @param {SampleDataset} d @param {string} key @param {number} i */
function addPlaceKey(d, key, i) {
  const at = d.placeSeg.get(key);
  if (at) {
    if (at[at.length - 1] !== i) at.push(i);
  } else {
    d.placeSeg.set(key, [i]);
  }
}

/** Domain vocabulary that appears inside group labels and would otherwise
 * "match" a population every time it is mentioned. */
const GROUP_NOISE = new Set([
  "ancient", "modern", "north", "south", "east", "west", "central", "late", "early", "middle",
  "published", "sample", "samples", "ignore", "outlier", "family", "brother", "sister",
  "forntida", "norra", "södra", "östra", "västra", "prov", "prover",
]);

/**
 * Resolves the geographic and population entities a message names, against the
 * dataset's OWN indexes — no geocoder (see the header).
 * @param {SampleDataset} d
 * @param {string} text
 * @returns {{ places: number[] | null, placeLabel: string, country: number | null, group: string | null }}
 */
export function matchEntities(d, text) {
  const raw = String(text || "");
  const s = raw.toLowerCase();
  const rawWords = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = rawWords.map((w) => w.toLowerCase());

  // A SINGLE-word place key must be capitalized in the message to count.
  // Place strings contain ordinary words ("Above", "River Mouth"), so without
  // this "ancient genomes from Greenland with coverage above 1x" resolves
  // "above" as a location, and — because a place filter suppresses the country
  // filter — quietly answers a Greenland question about nowhere. Place names
  // are proper nouns in English and Swedish alike, so requiring the capital is
  // the rule the languages already follow. Multi-word keys ("volga river
  // valley") are distinctive on their own and are exempt.
  const capitalized = (/** @type {number} */ i) => /^\p{Lu}/u.test(rawWords[i]);

  // Looked up as WORD N-GRAMS of the message rather than by testing each
  // dictionary entry as a substring. Substring matching is both slower (6,620
  // place keys per turn) and wrong: "group" is a word inside several place
  // strings, and `"…y-haplogroup r1b".includes("group")` is true, so
  // "Y-haplogroup R1b" acquired a geographic filter for a place nobody named.
  // Longest n-gram first, so "volga river valley" wins over "volga".
  let placeLabel = "";
  let places = null;
  let country = null;
  outer: for (let n = Math.min(4, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (n === 1 && !capitalized(i)) continue;
      const key = words.slice(i, i + n).join(" ");
      const list = d.placeSeg.get(key);
      if (list) {
        placeLabel = key;
        places = list;
        break outer;
      }
    }
  }
  for (let n = Math.min(3, words.length); n >= 1 && country === null; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const at = d.countryIdx.get(words.slice(i, i + n).join(" "));
      if (at !== undefined) {
        country = at;
        break;
      }
    }
  }

  // A population name is a SEGMENT of a group label — see the index comment in
  // parseSamples for why substring matching here is actively wrong.
  let group = null;
  for (const raw of s.split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.toLowerCase();
    if (t.length < 5 || GROUP_NOISE.has(t)) continue;
    if (d.groupSeg.has(t)) {
      group = t;
      break;
    }
  }

  // DISAMBIGUATION: a token can name a place AND appear in a population label —
  // "Samara" is both an oblast and the tail of `Russia_EBA_Yamnaya_Samara`,
  // "Sweden" is both a country and the head of every Swedish label. Keeping
  // both readings ANDs them, and the result is a query far narrower than what
  // was asked: "ancient samples near Samara" measured 3 hits with both filters
  // and 124 with the geographic one alone. The geographic reading wins, because
  // it is the one the message stated in words.
  if (group && (group === placeLabel || placeLabel.split(/[^\p{L}\p{N}]+/u).includes(group) ||
      (country !== null && group === d.countryLower[country]))) {
    group = null;
  }

  return { places, placeLabel, country, group };
}

/**
 * The full structured query a message asks for. Everything is optional; an
 * all-null query is a valid "show me the dataset" ask and is answered with
 * aggregates rather than refused.
 * @param {SampleDataset} d
 * @param {string} text
 * @returns {SampleQuery}
 */
export function parseSampleQuery(d, text) {
  const s = String(text || "");
  const notes = [];
  const ent = matchEntities(d, s);

  // ---- geography. A radius needs an anchor, and the anchor is a place or
  // country already in the dataset (its sample centroid).
  let near = null;
  const kmMatch = s.match(NEAR_DISTANCE);
  const nearWord = NEAR_WORD.test(s);
  if (kmMatch || nearWord) {
    // Swedish "mil" is 10 km, and a Swedish speaker writing "20 mil" means
    // 200 km. Reading it as 20 would silently return an empty result set.
    const raw = kmMatch ? +kmMatch[1] : DEFAULT_RADIUS_KM;
    const km = kmMatch && /^mil$/i.test(kmMatch[2]) ? raw * 10 : raw;
    const anchorLabel = ent.placeLabel || (ent.country !== null ? d.countryLower[ent.country] : "");
    const c = ent.places || ent.country !== null
      ? centroid(d, { places: ent.places, country: ent.country })
      : null;
    if (c) {
      near = { lat: c.lat, lon: c.lon, km, label: anchorLabel };
      notes.push(`within ${km} km of ${anchorLabel} (anchored on the ${c.n} samples recorded there — no geocoder)`);
    } else {
      // Say it. A radius silently dropped is the difference between "no
      // samples near there" and "the place was never resolved", and only one
      // of those is a finding.
      notes.push(
        "a proximity radius was asked for but could not be anchored: no place or country in this " +
          "corpus matched the location named, and the corpus is the only gazetteer here (no geocoder)",
      );
    }
  }

  const when = parseDateWindow(s);
  if (when) notes.push(`dated ${when.label}`);

  // ---- haplogroups. "Y-haplogroup R1b" and "mtDNA U5" are unambiguous;
  // a bare "haplogroup R1b" is not — R is a valid label on BOTH trees — so an
  // unqualified prefix is matched against either column rather than guessed.
  /** @type {{ mt: string|null, y: string|null, either: string|null }} */
  const haplo = { mt: null, y: null, either: null };
  const yMatch = s.match(Y_HAPLO);
  const mtMatch = s.match(MT_HAPLO);
  const anyMatch = s.match(ANY_HAPLO);
  // Kept exactly as typed — a haplogroup is written "R1b", and echoing it back
  // as "R1B" in the block reads as a different notation. haploMatches folds
  // case on both sides, so matching does not depend on how it was typed.
  if (yMatch) haplo.y = yMatch[1];
  if (mtMatch) haplo.mt = mtMatch[1];
  if (!haplo.y && !haplo.mt && anyMatch) haplo.either = anyMatch[1] || anyMatch[2];
  if (haplo.y) notes.push(`Y-haplogroup ${haplo.y}*`);
  if (haplo.mt) notes.push(`mtDNA haplogroup ${haplo.mt}*`);
  if (haplo.either) notes.push(`haplogroup ${haplo.either}* on either tree (the message did not say which)`);

  /** @type {1 | 2 | null} */
  let sex = null;
  if (FEMALE.test(s)) sex = 2;
  else if (MALE.test(s)) sex = 1;
  if (sex) notes.push(sex === 1 ? "genetically male" : "genetically female");

  let minCoverage = null;
  const cov = s.match(COVERAGE);
  if (cov) {
    const v = Number(cov[1] ?? cov[2]);
    if (Number.isFinite(v)) {
      minCoverage = v;
      notes.push(`coverage ≥ ${v}×`);
    }
  }

  // Present-day reference individuals are excluded unless asked for. They are a
  // third of the corpus and would otherwise dominate any query that did not
  // state a date.
  const wantsModern = MODERN.test(s);
  const ancientOnly = !wantsModern;
  if (wantsModern) notes.push("present-day reference individuals included");

  const includeIgnored = IGNORED.test(s);
  if (includeIgnored) notes.push("Ignore_-flagged individuals included (normally excluded)");

  if (ent.group) notes.push(`population label with the segment "${ent.group}"`);
  if (ent.places && !near) notes.push(`location matching "${ent.placeLabel}"`);
  if (ent.country !== null && !near && !ent.places) notes.push(`country ${(d.dict.country || [])[ent.country]}`);

  return {
    near,
    when,
    haplo,
    group: ent.group,
    country: near || ent.places ? null : ent.country,
    places: near ? null : ent.places,
    sex,
    minCoverage,
    ancientOnly,
    includeIgnored,
    notes,
  };
}

/**
 * The mean coordinate of every sample recorded at the given places (or in the
 * given country) — the anchor a radius query uses instead of a geocoder.
 * Null when nothing there carries coordinates, which the caller must report
 * rather than quietly dropping the radius.
 * @param {SampleDataset} d
 * @param {{ places?: number[] | null, country?: number | null }} of
 * @returns {{ lat: number, lon: number, n: number } | null}
 */
export function centroid(d, of) {
  const places = of.places ? new Set(of.places) : null;
  let sLat = 0;
  let sLon = 0;
  let n = 0;
  for (let i = 0; i < d.n; i++) {
    const hit = places ? places.has(d.place[i]) : d.ctry[i] === of.country;
    if (!hit) continue;
    if (Number.isNaN(d.lat[i]) || Number.isNaN(d.lon[i])) continue;
    sLat += d.lat[i];
    sLon += d.lon[i];
    n++;
  }
  return n ? { lat: sLat / n, lon: sLon / n, n } : null;
}

// ---- the query engine ------------------------------------------------------

/** Does a sample's date estimate overlap the asked window? A sample with a
 * start/stop interval is compared as an INTERVAL — a 5200–4800 BP sample
 * answers a "5000 BP" question — and one with only a median is compared as a
 * point. A sample with no date at all cannot match a dated query; it is counted
 * separately rather than silently dropped. */
function dateMatches(/** @type {SampleDataset} */ d, /** @type {number} */ i, /** @type {any} */ when) {
  const start = d.dstart[i];
  const stop = d.dstop[i];
  const med = d.dmed[i];
  if (!Number.isNaN(start) && !Number.isNaN(stop)) return stop >= when.from && start <= when.to;
  if (!Number.isNaN(med)) return med >= when.from && med <= when.to;
  return false;
}

/** Haplogroup prefix match. Ancient calls are reported at varying resolution
 * (R, R1, R1b, R1b1a1b), so asking for R1b must match R1b1a1b — a prefix, not
 * an equality. The reverse (asking for R1b1a1b, sample called R1b) is NOT a
 * match: the sample was not resolved that far and claiming it was would be a
 * fabricated result. */
export function haploMatches(/** @type {string} */ value, /** @type {string|null|undefined} */ prefix) {
  if (!prefix) return true;
  if (!value) return false;
  return value.toUpperCase().startsWith(prefix.toUpperCase());
}

/**
 * Runs a parsed query over the dataset.
 * @param {SampleDataset} d
 * @param {SampleQuery} q
 * @param {{ limit?: number }} [opts]
 * @returns {{ rows: number[], total: number, ignoredSkipped: number, undatedSkipped: number, aggregates: any }}
 */
export function querySamples(d, q, { limit = BLOCK_ROWS } = {}) {
  /** @type {number[]} */
  const hits = [];
  const placeSet = q.places ? new Set(q.places) : null;
  let ignoredSkipped = 0;
  let undatedSkipped = 0;

  for (let i = 0; i < d.n; i++) {
    if (!q.includeIgnored && d.ignored[i]) {
      ignoredSkipped++;
      continue;
    }
    if (q.ancientOnly && d.dtype[i] === 3) continue;
    if (q.sex && d.sex[i] !== q.sex) continue;
    if (q.minCoverage !== null && !(d.cov[i] >= q.minCoverage)) continue;
    if (q.country !== null && d.ctry[i] !== q.country) continue;
    if (placeSet && !placeSet.has(d.place[i])) continue;

    if (q.when) {
      if (Number.isNaN(d.dstart[i]) && Number.isNaN(d.dmed[i])) {
        undatedSkipped++;
        continue;
      }
      if (!dateMatches(d, i, q.when)) continue;
    }
    if (q.near) {
      if (Number.isNaN(d.lat[i])) continue;
      if (haversineKm(q.near.lat, q.near.lon, d.lat[i], d.lon[i]) > q.near.km) continue;
    }
    if (q.haplo.y && !haploMatches(d.y[i], q.haplo.y)) continue;
    if (q.haplo.mt && !haploMatches(d.mt[i], q.haplo.mt)) continue;
    if (q.haplo.either && !haploMatches(d.y[i], q.haplo.either) && !haploMatches(d.mt[i], q.haplo.either)) continue;
    if (q.group) {
      const g = (d.dict.group || [])[d.grp[i]] || "";
      if (!g.toLowerCase().includes(q.group)) continue;
    }
    hits.push(i);
  }

  // Ranked by how much a reader can DO with the row: coverage first (a 14×
  // genome answers questions a 0.01× one cannot), then having a date, then
  // having coordinates. Ties resolve by sample id so the block is stable
  // across identical turns.
  hits.sort((a, b) => {
    const ca = Number.isNaN(d.cov[a]) ? -1 : d.cov[a];
    const cb = Number.isNaN(d.cov[b]) ? -1 : d.cov[b];
    if (cb !== ca) return cb - ca;
    const da = Number.isNaN(d.dmed[a]) ? 1 : 0;
    const db = Number.isNaN(d.dmed[b]) ? 1 : 0;
    if (da !== db) return da - db;
    return d.id[a] < d.id[b] ? -1 : 1;
  });

  return {
    rows: hits.slice(0, limit),
    total: hits.length,
    ignoredSkipped,
    undatedSkipped,
    aggregates: aggregate(d, hits),
  };
}

/** Top counts by country, population label, publication and period — what a
 * result set of 400 rows can honestly say in six lines. */
function aggregate(/** @type {SampleDataset} */ d, /** @type {number[]} */ hits) {
  const by = (/** @type {(i:number)=>string} */ keyOf) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const i of hits) {
      const k = keyOf(i);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  };
  const dates = hits.map((i) => d.dmed[i]).filter((v) => !Number.isNaN(v));
  return {
    countries: by((i) => (d.dict.country || [])[d.ctry[i]] || ""),
    groups: by((i) => (d.dict.group || [])[d.grp[i]] || ""),
    publications: by((i) => (d.dict.pub || [])[d.pub[i]] || ""),
    dateRange: dates.length ? { min: Math.min(...dates), max: Math.max(...dates) } : null,
    withY: hits.filter((i) => d.y[i]).length,
    withMt: hits.filter((i) => d.mt[i]).length,
  };
}

// ---- rendering the context block -------------------------------------------

/** A BC/AD year as a reader states it. */
export function year(/** @type {number} */ y) {
  if (!Number.isFinite(y)) return "";
  return y < 0 ? `${Math.abs(Math.round(y))} BCE` : `${Math.round(y)} CE`;
}

/** One row as a table line. */
function rowLine(/** @type {SampleDataset} */ d, /** @type {number} */ i) {
  const g = (d.dict.group || [])[d.grp[i]] || "";
  const c = (d.dict.country || [])[d.ctry[i]] || "";
  const p = (d.dict.place || [])[d.place[i]] || "";
  const where = [p, c].filter(Boolean).join(", ");
  const dated = !Number.isNaN(d.dmed[i])
    ? year(d.dmed[i]) + (d.dtype[i] === 1 ? " (¹⁴C)" : d.dtype[i] === 2 ? " (context)" : "")
    : "undated";
  const cov = Number.isNaN(d.cov[i]) ? "—" : `${d.cov[i].toFixed(2)}×`;
  const snps = Number.isNaN(d.snps[i]) ? "—" : `${Math.round(d.snps[i] / 1000)}k`;
  const sex = d.sex[i] === 1 ? "M" : d.sex[i] === 2 ? "F" : "?";
  return [
    d.id[i], g, where, dated, sex,
    d.mt[i] || "—", d.y[i] || "—", cov, snps,
    (d.dict.pub || [])[d.pub[i]] || "",
  ].join(" | ");
}

/**
 * The labeled context block appended to the conversation. Written to be read by
 * a model AND checkable by a human: it states what was searched, what the
 * filters were, how many matched, what was deliberately excluded, and where the
 * numbers came from — so an answer built on it can be specific without
 * overclaiming, and a wrong answer is traceable to a row.
 *
 * @param {SampleDataset} d
 * @param {SampleQuery} q
 * @param {ReturnType<typeof querySamples>} res
 * @returns {string}
 */
export function sampleBlock(d, q, res) {
  const out = [];
  out.push("ANCIENT-SAMPLE DATABASE (structured query result)");
  out.push(
    `Corpus: ${d.counts.total} published individuals from ${(d.dict.pkg || []).length} studies — ` +
      `${d.counts.ancient} ancient, ${d.counts.modern} present-day reference. ` +
      `Source: ${d.source?.name || "Poseidon public archives"}. Per-individual metadata only; no genotype data.`,
  );
  out.push(`Filters applied: ${q.notes.length ? q.notes.join("; ") : "none — this is the whole corpus"}.`);
  out.push(`Matched: ${res.total} individual${res.total === 1 ? "" : "s"}.`);
  if (!q.includeIgnored && res.ignoredSkipped) {
    out.push(
      `Excluded ${res.ignoredSkipped} individuals whose population label is prefixed Ignore_ ` +
        "(the AADR/Poseidon convention for contaminated, duplicated or otherwise unusable samples — " +
        "they must not enter an analysis).",
    );
  }
  if (q.when && res.undatedSkipped) {
    out.push(`${res.undatedSkipped} individuals could not be tested against the date window: no date recorded upstream.`);
  }

  if (res.total === 0) {
    out.push("");
    out.push(
      "NO ROWS MATCHED. Say so plainly rather than substituting remembered samples. " +
        "The likely causes, in order: the filters are jointly too narrow; the region has no published " +
        "individuals in this corpus; or the date window falls outside what has been sequenced there.",
    );
    return out.join("\n");
  }

  out.push("");
  out.push(`Top ${res.rows.length} by coverage (id | population | location | date | sex | mtDNA | Y | coverage | SNPs | publication):`);
  for (const i of res.rows) out.push(rowLine(d, i));

  const a = res.aggregates;
  if (res.total > res.rows.length) {
    out.push("");
    out.push(`Across all ${res.total} matches:`);
    if (a.dateRange) out.push(`  date span: ${year(a.dateRange.min)} … ${year(a.dateRange.max)} (medians)`);
    if (a.countries.length) out.push(`  countries: ${a.countries.map((/** @type {[string,number]} */ [k, v]) => `${k} (${v})`).join(", ")}`);
    if (a.groups.length) out.push(`  population labels: ${a.groups.map((/** @type {[string,number]} */ [k, v]) => `${k} (${v})`).join(", ")}`);
    if (a.publications.length) out.push(`  publications: ${a.publications.map((/** @type {[string,number]} */ [k, v]) => `${k} (${v})`).join(", ")}`);
    out.push(`  with a Y-haplogroup: ${a.withY}; with an mtDNA haplogroup: ${a.withMt}`);
  }

  out.push("");
  out.push(
    "USING THIS BLOCK: cite individuals by their sample id and name the publication key; " +
      "the counts above are exact for this corpus, so state them as such and do not round them into " +
      "vaguer language. This corpus is what has been PUBLISHED and repackaged, not what exists — " +
      "absence of samples from a region is absence of published data, never evidence of absence of people. " +
      "Coverage, date type (¹⁴C vs contextual) and the Ignore_ exclusion are the caveats that decide " +
      "whether a claim holds; carry them into the answer. Nothing here is an ancestry inference: " +
      "these are filters and counts, not f-statistics, qpAdm or PCA.",
  );
  return out.join("\n");
}
