// @ts-check
// THE GOOGLE SCHOLAR ENRICHMENT — the half of the Deep Science agent that talks
// to Google Scholar itself, and the switch that makes the agent's "peer-reviewed
// sources only" promise operational.
//
// It does three things:
//
//  1. **Restricts the turn to the scholar source.** Every turn, whatever the
//     message says: `state.forceAux` turns the peer-reviewed search leg on and
//     `state.auxOnly` turns every other auxiliary source off. Together with the
//     agent spec's `search.web: false` — which cannot be re-enabled by a
//     request, because capSearch composes by narrowing in both directions —
//     that is the whole "nothing but peer-reviewed literature" guarantee, and
//     it is three declarations rather than a promise in a prompt.
//  2. **Reads a Google Scholar AUTHOR PROFILE** when the message carries one,
//     from the robots-ALLOWED `/citations?user=` page: name, affiliation,
//     verified email domain, h-index, i10-index, total citations, and the
//     twenty most-cited works with their own citation counts.
//  3. **Folds in Google Scholar's VENUE METRICS** when the message asks where a
//     field publishes, from the committed artifact (src/scholar-venues.js) —
//     no outbound request at all.
//
// ---- what is deliberately NOT done -------------------------------------------
//
// Scholar's robots.txt allows `/citations?user=` and `view_op=top_venues`, and
// disallows everything else under `/citations?` — including
// `view_op=search_authors`. So there is no way to LOOK UP an author by name
// within the rules, and this module does not try: the profile leg fires only
// when the message already carries a profile link or id, which is how someone
// actually asks ("what has this researcher published — <url>"). Guessing ids,
// crawling the author search, or parsing `/scholar` results are all off the
// table; src/scholar.js's header records why at length.
//
// ---- fail-soft, and visibly so ----------------------------------------------
//
// Google may rate-limit a datacenter address at any time, allowed page or not.
// Every branch here degrades to "the profile could not be read" with the step
// still shown, never to silence and never to an error (invariant 2). The agent
// keeps working from its literature leg, which needs nothing from Google.

import { appendToLast, lastUserText } from "./conversation.js";
import { loadVenues, topVenues } from "./scholar-venues.js";

/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

/** The source id this agent is built around (src/search-sources.js). */
export const SCHOLAR_SOURCE_ID = "scholar";

/** Per-request ceiling on peer-reviewed searches. Higher than the registry
 * default for the same reason the Models agent raises the Hub's: with the web
 * leg structurally down, the gap rounds' follow-up angles have nowhere else to
 * go, and cross-wave dedup means a higher ceiling buys DISTINCT searches. */
export const SCHOLAR_SEARCHES_PER_REQUEST = 6;

const PROFILE_TIMEOUT_MS = 9000;
/** Scholar answers a default client UA with 403 on every path, allowed or not
 * (probed 2026-07-31). A browser UA is what makes an ALLOWED page readable; it
 * is not a way past a disallowed one, and no disallowed path is fetched here. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---- the profile leg --------------------------------------------------------

/** Scholar author ids are 12 characters of URL-safe base64. Matched either
 * inside a profile URL or standing alone next to the word "scholar", never as a
 * bare 12-character token — that would fire on half the hashes on the internet. */
const PROFILE_URL = /scholar\.google\.[a-z.]+\/citations\?[^\s"'<>]*user=([A-Za-z0-9_-]{10,16})/i;
const PROFILE_ID = /(?<![\p{L}\p{N}_])(?:scholar\s*(?:id|profile|user)|scholar-id)\s*[:=]?\s*([A-Za-z0-9_-]{10,16})(?![\p{L}\p{N}_])/iu;

/**
 * The Google Scholar author id the message names, or "".
 * @param {string} text
 * @returns {string}
 */
export function profileId(text) {
  const s = String(text || "");
  return (s.match(PROFILE_URL)?.[1] || s.match(PROFILE_ID)?.[1] || "").trim();
}

/**
 * @typedef {Object} ScholarProfile
 * @property {string} id
 * @property {string} name
 * @property {string} affiliation
 * @property {string} verified verified-email line, "" when the profile has none
 * @property {string[]} interests
 * @property {{ citations: number, hIndex: number, i10: number }} all
 * @property {{ citations: number, hIndex: number, i10: number }} since
 * @property {Array<{ title: string, authors: string, venue: string, year: number|null, citedBy: number }>} works
 */

/** Strip tags and decode the entities Scholar emits.
 * @param {unknown} s
 * @returns {string}
 */
function text(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a `/citations?user=` page. Pure and exported so the whole parser is
 * unit-tested against a saved page rather than against the live site.
 *
 * The markup, verified 2026-07-31 against a real profile: the header is
 * `#gsc_prf_in` (name) followed by `.gsc_prf_il` divs (affiliation, then the
 * verified-email line, then interests); the statistics table is six
 * `.gsc_rsb_std` cells in the order citations/h-index/i10 × (all, since); each
 * work is a `tr.gsc_a_tr` with `.gsc_a_at` (title), two `.gs_gray` divs
 * (authors, then venue+year) and `.gsc_a_ac` (citations).
 *
 * Null when the page is not a profile — a CAPTCHA interstitial and a consent
 * page both return HTTP 200, so "we got bytes" is not "we got a profile".
 * @param {string} html
 * @param {string} id
 * @returns {ScholarProfile | null}
 */
export function parseProfile(html, id) {
  const h = String(html || "");
  const name = text(h.match(/id="gsc_prf_in"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
  if (!name) return null;

  const il = [...h.matchAll(/class="gsc_prf_il"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
  const verified = il.find((s) => /verified email|bekräftad e-post/i.test(s)) || "";
  const affiliation = il.find((s) => s && s !== verified) || "";
  // Interests are one anchor each; the concatenated div would run them together
  // ("machine learningpsychology"), which is what a naive text() of the third
  // .gsc_prf_il produces.
  const interests = [...h.matchAll(/class="gsc_prf_inta[^"]*"[^>]*>([^<]*)</g)].map((m) => text(m[1])).filter(Boolean);

  const std = [...h.matchAll(/class="gsc_rsb_std">([^<]*)</g)].map((m) => Number(String(m[1]).replace(/\D/g, "")) || 0);
  /** @param {number} a @param {number} b @param {number} c */
  const stats = (a, b, c) => ({ citations: std[a] || 0, hIndex: std[b] || 0, i10: std[c] || 0 });

  /** @type {ScholarProfile['works']} */
  const works = [];
  for (const m of h.matchAll(/<tr class="gsc_a_tr">([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    const title = text(row.match(/class="gsc_a_at"[^>]*>([\s\S]*?)<\/a>/)?.[1] || "");
    if (!title) continue;
    const grays = [...row.matchAll(/class="gs_gray"[^>]*>([\s\S]*?)<\/div>/g)].map((g) => text(g[1]));
    const venueLine = grays[1] || "";
    const year = Number(row.match(/class="gsc_a_h[^"]*"[^>]*>(\d{4})</)?.[1]) || null;
    const citedBy = Number(text(row.match(/class="gsc_a_ac[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] || "").replace(/\D/g, "")) || 0;
    works.push({
      title,
      authors: grays[0] || "",
      // The year is repeated inside the venue line as ", 2012"; drop it so the
      // block doesn't print it twice.
      venue: venueLine.replace(/,\s*(1[6-9]\d{2}|20\d{2})\s*$/, "").trim(),
      year,
      citedBy,
    });
  }

  return {
    id,
    name,
    affiliation,
    verified,
    interests,
    all: stats(0, 2, 4),
    since: stats(1, 3, 5),
    works,
  };
}

/**
 * Fetch and parse one profile. Null on anything at all — a non-200, a timeout,
 * a CAPTCHA page that parses to nothing.
 * @param {string} id
 * @param {import('./types.js').Logger} log
 * @returns {Promise<ScholarProfile | null>}
 */
export async function fetchProfile(id, log) {
  // ONLY the robots-allowed path, with only the id in it. Nothing about the
  // conversation, the question or the account crosses the wire (invariant 4) —
  // Google learns that someone looked at a public profile, which is what the
  // page is for.
  const url = `https://scholar.google.com/citations?hl=en&user=${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "en" },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log?.warn?.("scholar.profile_http", { status: res.status });
      return null;
    }
    const profile = parseProfile(await res.text(), id);
    if (!profile) log?.warn?.("scholar.profile_unparsed", { id });
    return profile;
  } catch (/** @type {any} */ err) {
    log?.warn?.("scholar.profile_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * The labeled context block for a profile.
 *
 * Every number is attributed to Google Scholar and dated by what it is, because
 * these are Scholar's counts and not this platform's: Scholar's citation counts
 * are famously more generous than Web of Science's or Scopus's — they include
 * preprints, theses and self-citations. An answer that quotes an h-index
 * without saying whose h-index it is has made a claim it cannot support.
 * @param {ScholarProfile} p
 * @returns {string}
 */
export function profileBlock(p) {
  const lines = [
    "Google Scholar author profile (fetched live from scholar.google.com/citations, the robots-allowed profile page).",
    "These are GOOGLE SCHOLAR's own metrics. Scholar counts citations from preprints, theses and self-citations, so its h-index and totals run higher than Web of Science or Scopus — say whose numbers these are when quoting them, and do not present them as a neutral measure of impact.",
    "",
    `Name: ${p.name}`,
  ];
  if (p.affiliation) lines.push(`Affiliation: ${p.affiliation}`);
  if (p.verified) lines.push(`${p.verified}`);
  if (p.interests.length) lines.push(`Interests: ${p.interests.join(", ")}`);
  lines.push(
    `Citations: ${p.all.citations} all time, ${p.since.citations} recent · h-index ${p.all.hIndex} (recent ${p.since.hIndex}) · i10-index ${p.all.i10} (recent ${p.since.i10})`,
  );
  if (p.works.length) {
    lines.push("", `Most-cited works on the profile (${p.works.length} shown, Scholar's own ordering):`);
    for (const w of p.works) {
      const bits = [w.authors, w.venue, w.year ? String(w.year) : "", w.citedBy ? `cited ${w.citedBy}×` : ""].filter(Boolean);
      lines.push(`- ${w.title}${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
    }
    lines.push(
      "",
      "A profile listing is NOT a peer-review verdict: Scholar profiles list preprints, book chapters, theses and slide decks beside journal articles. To cite any of these as peer-reviewed research, it must also come back from the peer-reviewed literature search.",
    );
  }
  return lines.join("\n");
}

// ---- the venue-metrics leg --------------------------------------------------

/** Asking where a field publishes / which journals rank highest. EN + SV, with
 * the Unicode-aware boundaries the `\b` trap requires (src/europepmc.js). */
const VENUE_ASK = new RegExp(
  "(?:top (?:journals|venues|publications)|best journals?|leading journals?|highest[-\\s]?impact" +
    "|which journals?|what journals?|where (?:should|do|to) (?:i |we |one )?publish|where is .{0,40} published" +
    "|journal rank(?:ing|ings)?|venue rank(?:ing|ings)?|h5[-\\s]?index|impact factor" +
    "|främsta tidskrifter|bästa tidskrifter(?:na)?|ledande tidskrifter|vilka tidskrifter" +
    "|var (?:ska|bör|skall) man publicera|var publicerar man|tidskriftsrankning" +
    "|högst(?:a)? (?:impact|genomslag)|h5[-\\s]?index)",
  "iu",
);

/** Field words → Scholar's own category codes. EN + SV in one table, the same
 * breadth on both sides (invariant 6). */
/** @type {Array<[string, RegExp]>} */
const CATEGORY_WORDS = [
  ["bio", /(?:biolog|genetic|genomic|ecolog|evolution|zoolog|botan|geolog|earth science|climate|neuroscience|biokemi|biolog|genetik|genomik|ekolog|evolution|geolog|klimat|neurovetenskap)/iu],
  ["med", /(?:medicin|medical|clinical|health|disease|oncolog|cardiolog|psychiatr|epidemiolog|nursing|vaccin|klinisk|hälsa|sjukdom|onkolog|kardiolog|psykiatri|epidemiolog|omvårdnad)/iu],
  ["eng", /(?:engineering|computer|software|machine learning|artificial intelligence|robotic|network|security|cryptograph|electronic|teknik|ingenjör|datavetenskap|programvara|maskininlärning|artificiell intelligens|robotik|nätverk|säkerhet|kryptograf|elektronik)/iu],
  ["phy", /(?:physic|mathematic|astronom|astrophysic|quantum|particle|cosmolog|statistic|fysik|matematik|astronomi|astrofysik|kvant|partikel|kosmolog|statistik)/iu],
  ["chm", /(?:chemistr|chemical|material science|polymer|nanotech|catalys|kemi|kemisk|materialvetenskap|polymer|nanoteknik|katalys)/iu],
  ["soc", /(?:sociolog|psycholog|political|anthropolog|education|law|criminolog|social science|sociolog|psykolog|statsvetenskap|antropolog|utbildning|juridik|kriminolog|samhällsvetenskap)/iu],
  ["bus", /(?:business|economic|finance|management|marketing|accounting|ekonomi|företagsekonomi|finans|ledarskap|marknadsföring|redovisning)/iu],
  ["hum", /(?:humanities|history|philosoph|literature study|linguistic|art history|religio|humaniora|historia|filosofi|lingvistik|konsthistoria|religion)/iu],
];

/**
 * Which Scholar subject category the message is about, or "" for all fields.
 * @param {string} text
 * @returns {string}
 */
export function venueCategory(text) {
  const s = String(text || "");
  for (const [code, re] of CATEGORY_WORDS) if (re.test(s)) return code;
  return "";
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function venueIntent(text) {
  return VENUE_ASK.test(String(text || ""));
}

/**
 * The labeled block of Scholar's venue metrics.
 * @param {import('./scholar-venues.js').VenueTable} table
 * @param {string} cat
 * @param {Array<{ name: string, h5: number, h5median: number }>} rows
 * @returns {string}
 */
export function venueBlock(table, cat, rows) {
  const label = cat ? `subject category "${cat}"` : "all fields";
  return [
    `Google Scholar Metrics — top venues by h5-index, ${label} (from the committed metrics table harvested ${table.harvested}; ${table.n} venues ranked).`,
    "h5-index is the h-index computed over the last five complete years; h5-median is the median citation count of the articles in that h-core. They rank VOLUME OF CITATION, not quality of review: a high h5 says a venue is widely cited, not that any particular paper in it is right.",
    "",
    ...rows.map((v, i) => `${i + 1}. ${v.name} — h5-index ${v.h5}, h5-median ${v.h5median}`),
  ].join("\n");
}

// ---- the runner -------------------------------------------------------------

/**
 * The enrichment (registered in src/enrichment.js, gated on the resolved
 * agent's declared `scholar-metrics` context block — no chat mode, no settings
 * knob, no request flag, exactly like the ancient-sample corpus).
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runScholarMetricsEnrichment(c) {
  const { env, log, state, conversation } = c;

  // (1) The agent's identity, applied every turn whatever the message says.
  // Core reads all three generically (pipeline.js) and learns nothing about
  // which source this is.
  /** @type {any} */ (state).forceAux = [SCHOLAR_SOURCE_ID];
  /** @type {any} */ (state).auxOnly = [SCHOLAR_SOURCE_ID];
  /** @type {any} */ (state).auxMaxPerRequest = { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST };

  const asked = lastUserText(conversation);
  /** @type {string[]} */
  const blocks = [];

  // (2) A profile, when the message carries one.
  const id = profileId(asked);
  if (id) {
    c.step("scholar_profile", "Reading the Google Scholar profile…");
    const profile = await fetchProfile(id, log);
    if (profile) {
      blocks.push(profileBlock(profile));
      c.stepDone("scholar_profile", `${profile.name} — h-index ${profile.all.hIndex}, ${profile.works.length} works listed`);
      /** @type {any} */ (state).scholarProfile = {
        id,
        works: profile.works.length,
        h_index: profile.all.hIndex,
      };
    } else {
      // Fail soft and VISIBLY: the step already told the user a lookup had
      // started, so silence here would read as a result rather than an outage.
      c.stepDone("scholar_profile", "The Google Scholar profile could not be read");
      /** @type {any} */ (state).scholarProfile = { id, works: 0, h_index: 0 };
    }
  }

  // (3) Venue metrics, when the message asks where a field publishes. No
  // outbound request — the table is a build artifact.
  if (venueIntent(asked)) {
    const table = await loadVenues(env);
    const cat = venueCategory(asked);
    const rows = topVenues(table, cat, 15);
    if (table && rows.length) {
      blocks.push(venueBlock(table, cat, rows));
      c.stepDone("scholar_venues", `Google Scholar venue metrics — ${rows.length} venues${cat ? ` in ${cat}` : ""}`);
      /** @type {any} */ (state).scholarVenues = { cat: cat || "all", shown: rows.length };
    }
  }

  if (!blocks.length) return conversation;
  return [...conversation.slice(0, -1), appendToLast(conversation[conversation.length - 1], blocks.join("\n\n"))];
}
