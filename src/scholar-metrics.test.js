// Unit tests for the Google Scholar enrichment (src/scholar-metrics.js).
//
// The profile fixture below reproduces the markup of a real
// `citations?user=` page VERBATIM in structure — the class names, the nesting,
// the `<span class="gs_oph">, 2012</span>` year suffix inside the venue div, the
// six `.gsc_rsb_std` statistics cells in citations/h/i10 × (all, since) order —
// with invented names and numbers. Structure is what the parser depends on and
// what upstream will eventually change; the person is not, and there is no
// reason to commit a real researcher's metrics into this repo to test a regex.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHOLAR_SEARCHES_PER_REQUEST,
  SCHOLAR_SOURCE_ID,
  fetchProfile,
  parseProfile,
  profileBlock,
  preprintSources,
  profileId,
  runScholarMetricsEnrichment,
  venueBlock,
  venueCategory,
  venueIntent,
} from "./scholar-metrics.js";
import { parseVenueTable, topVenues, venueKey, venueMetrics, venueNote } from "./scholar-venues.js";

// ---- the fixture -------------------------------------------------------------

const work = (title, authors, venue, year, cites) =>
  `<tr class="gsc_a_tr"><td class="gsc_a_t">` +
  `<a href="/citations?view_op=view_citation&amp;hl=en&amp;user=XXXX" class="gsc_a_at">${title}</a>` +
  `<div class="gs_gray">${authors}</div>` +
  `<div class="gs_gray">${venue}<span class="gs_oph">, ${year}</span></div></td>` +
  `<td class="gsc_a_c"><a href="#" class="gsc_a_ac gs_ibl">${cites}</a>` +
  `<span class="gsc_a_m"><a href="javascript:void(0)" class="gsc_a_am">*</a></span></td>` +
  `<td class="gsc_a_y"><span class="gsc_a_h gsc_a_hc gs_ibl">${year}</span></td></tr>`;

const PROFILE_HTML =
  `<div id="gsc_prf_inw"><div id="gsc_prf_in">Ada Nordin</div></div>` +
  `<div class="gsc_prf_il">Professor of Marine Ecology, <a href="#" class="gsc_prf_ila">Uppsala University</a></div>` +
  `<div class="gsc_prf_il" id="gsc_prf_ivh">Verified email at example.ac.uk - <a href="#" class="gsc_prf_ila">Homepage</a></div>` +
  `<div class="gsc_prf_il" id="gsc_prf_int">` +
  `<a href="#" class="gsc_prf_inta gs_ibl">marine ecology</a>` +
  `<a href="#" class="gsc_prf_inta gs_ibl">biogeochemistry</a></div>` +
  `<table id="gsc_rsb_st"><tbody>` +
  `<tr><td class="gsc_rsb_sc1">Citations</td><td class="gsc_rsb_std">12345</td><td class="gsc_rsb_std">4321</td></tr>` +
  `<tr><td class="gsc_rsb_sc1">h-index</td><td class="gsc_rsb_std">57</td><td class="gsc_rsb_std">41</td></tr>` +
  `<tr><td class="gsc_rsb_sc1">i10-index</td><td class="gsc_rsb_std">160</td><td class="gsc_rsb_std">120</td></tr>` +
  `</tbody></table>` +
  `<table id="gsc_a_t"><tbody id="gsc_a_b">` +
  work("Carbon burial in restored coastal wetlands", "A Nordin, B Sjöberg", "Nature Geoscience 12", 2019, 842) +
  work("Sediment cores and the Holocene record", "A Nordin", "Limnology and Oceanography 60", 2015, 311) +
  `</tbody></table>`;

const VENUE_ARTIFACT = {
  version: 1,
  harvested: "2026-07-31",
  fields: ["name", "h5", "h5median", "cats"],
  rows: [
    ["Nature", 490, 784, "bio"],
    ["The New England Journal of Medicine", 441, 854, "med"],
    ["IEEE Transactions on Information Forensics and Security", 91, 152, "eng"],
    ["Nature Geoscience", 140, 210, "bio"],
  ],
};

// ---- profile id detection ------------------------------------------------------

test("profileId reads an id out of a profile URL or an explicit mention", () => {
  assert.equal(
    profileId("look at https://scholar.google.com/citations?user=JicYPdAAAAAJ&hl=en please"),
    "JicYPdAAAAAJ",
  );
  assert.equal(profileId("https://scholar.google.se/citations?hl=sv&user=AbCdEf123456"), "AbCdEf123456");
  assert.equal(profileId("scholar id: JicYPdAAAAAJ"), "JicYPdAAAAAJ");
  assert.equal(profileId("scholar profile AbCdEf123456"), "AbCdEf123456");
});

test("profileId does not fire on a bare token that merely looks like an id", () => {
  // A 12-character URL-safe token is half the hashes on the internet; matching
  // one loose would send a fetch to Google for every commit sha someone pastes.
  for (const s of [
    "",
    "the commit is 4f3a9c2b1e77",
    "my api key is AbCdEf123456",
    "https://example.com/citations?user=AbCdEf123456",
  ]) {
    assert.equal(profileId(s), "", `should not match: ${s}`);
  }
});

// ---- the one outbound URL, checked against Scholar's actual robots.txt ----------

// scholar.google.com/robots.txt, the rules governing /citations, verbatim as
// fetched 2026-07-31. Kept here rather than fetched so the assertion is
// deterministic and offline; re-fetch it when this test starts arguing with
// reality.
const SCHOLAR_ROBOTS = [
  ["disallow", "/citations?"],
  ["allow", "/citations?user="],
  ["disallow", "/citations?*cstart="],
  ["disallow", "/citations?user=*%40"],
  ["disallow", "/citations?user=*@"],
];

/**
 * RFC 9309 matching, the part that decides this case: a rule matches when its
 * pattern is a PREFIX of the request's path+query (`*` matching any run of
 * characters), and the LONGEST matching pattern wins, Allow taking ties.
 * @param {string} pathAndQuery
 */
function robotsVerdict(pathAndQuery) {
  let best = { type: "allow", len: -1 };
  for (const [type, pattern] of SCHOLAR_ROBOTS) {
    const rx = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
    if (!rx.test(pathAndQuery)) continue;
    const len = pattern.length;
    if (len > best.len || (len === best.len && type === "allow")) best = { type, len };
  }
  return best.type;
}

test("the profile fetch is ALLOWED by Scholar's robots.txt — and parameter order is why", async () => {
  const realFetch = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(PROFILE_HTML, { status: 200 });
  };
  try {
    await fetchProfile("JicYPdAAAAAJ", null);
  } finally {
    globalThis.fetch = realFetch;
  }
  const u = new URL(urls[0]);
  assert.equal(robotsVerdict(u.pathname + u.search), "allow");

  // The failure this pins is not hypothetical: `Disallow: /citations?` is a
  // prefix of EVERY /citations URL, and `Allow: /citations?user=` only outranks
  // it when the query STARTS with `user=`. Put any other parameter first and
  // the Allow stops matching, leaving the Disallow to win on its own.
  assert.equal(robotsVerdict("/citations?hl=en&user=JicYPdAAAAAJ"), "disallow");
  // The two rules satisfied by construction, asserted so a loosened id regex
  // cannot quietly start reaching them.
  assert.equal(robotsVerdict("/citations?user=JicYPdAAAAAJ&cstart=20"), "disallow");
  assert.equal(robotsVerdict("/citations?user=someone%40example.com"), "disallow");
  assert.equal(profileId("scholar id: someone@example.com"), "");
});

// ---- the profile parser ---------------------------------------------------------

test("parseProfile reads the header, the statistics and the works table", () => {
  const p = /** @type {any} */ (parseProfile(PROFILE_HTML, "XXXX"));
  assert.ok(p);
  assert.equal(p.name, "Ada Nordin");
  assert.equal(p.affiliation, "Professor of Marine Ecology, Uppsala University");
  assert.match(p.verified, /Verified email at example\.ac\.uk/);
  // Interests come from the per-anchor class, not from the containing div: a
  // text() of the whole div runs them together ("marine ecologybiogeochemistry"),
  // which is what the first version of this parser produced.
  assert.deepEqual(p.interests, ["marine ecology", "biogeochemistry"]);
  assert.deepEqual(p.all, { citations: 12345, hIndex: 57, i10: 160 });
  assert.deepEqual(p.since, { citations: 4321, hIndex: 41, i10: 120 });

  assert.equal(p.works.length, 2);
  assert.deepEqual(p.works[0], {
    title: "Carbon burial in restored coastal wetlands",
    authors: "A Nordin, B Sjöberg",
    // The `, 2019` suffix lives INSIDE the venue div; leaving it there prints
    // the year twice in the block.
    venue: "Nature Geoscience 12",
    year: 2019,
    citedBy: 842,
  });
  assert.equal(p.works[1].citedBy, 311);
});

test("parseProfile returns null for a page that is not a profile", () => {
  // A CAPTCHA interstitial and a consent page both come back HTTP 200, so
  // "we got bytes" is not "we got a profile" (invariant 2 depends on this).
  assert.equal(parseProfile("<html><body>Please verify you are human</body></html>", "X"), null);
  assert.equal(parseProfile("", "X"), null);
});

test("profileBlock attributes every number to Google Scholar and refuses to imply peer review", () => {
  const block = profileBlock(/** @type {any} */ (parseProfile(PROFILE_HTML, "XXXX")));
  assert.match(block, /Ada Nordin/);
  assert.match(block, /h-index 57/);
  assert.match(block, /cited 842×/);
  // The two disclaimers that keep the block honest: Scholar's counts are not a
  // neutral impact measure, and a profile listing is not a peer-review verdict.
  assert.match(block, /GOOGLE SCHOLAR's own metrics/);
  assert.match(block, /Web of Science or Scopus/);
  assert.match(block, /NOT a peer-review verdict/);
});

// ---- the venue table ------------------------------------------------------------

test("venueKey normalizes the house styles four backends use", () => {
  assert.equal(venueKey("The New England Journal of Medicine"), venueKey("new england journal of medicine"));
  assert.equal(venueKey("Science & Justice"), venueKey("Science and Justice"));
  assert.equal(venueKey(""), "");
});

test("parseVenueTable refuses a layout it does not know", () => {
  assert.ok(parseVenueTable(VENUE_ARTIFACT));
  assert.equal(parseVenueTable({ ...VENUE_ARTIFACT, version: 99 }), null);
  assert.equal(parseVenueTable({ version: 1, rows: [] }), null);
  assert.equal(parseVenueTable(null), null);
  assert.equal(parseVenueTable("nope"), null);
});

test("venueMetrics and venueNote annotate a ranked venue and stay silent on the rest", () => {
  const t = parseVenueTable(VENUE_ARTIFACT);
  assert.equal(venueMetrics(t, "nature")?.h5, 490);
  assert.equal(venueNote(t, "The New England Journal of Medicine"), "Scholar h5-index 441");
  // Scholar publishes only the top hundred per field, so absence is NOT a
  // quality verdict and the annotation is simply omitted.
  assert.equal(venueNote(t, "Journal of Obscure Studies"), "");
  assert.equal(venueNote(null, "Nature"), "");
});

test("topVenues filters by Scholar's own subject category", () => {
  const t = parseVenueTable(VENUE_ARTIFACT);
  assert.deepEqual(topVenues(t, "bio", 5).map((v) => v.name), ["Nature", "Nature Geoscience"]);
  assert.deepEqual(topVenues(t, "eng", 5).map((v) => v.name), [
    "IEEE Transactions on Information Forensics and Security",
  ]);
  assert.equal(topVenues(t, "", 2).length, 2, "no category = every venue, most-cited first");
  assert.deepEqual(topVenues(null, "bio"), []);
});

// ---- the venue gate ---------------------------------------------------------------

test("venueIntent fires on 'where does this field publish', in both languages", () => {
  for (const s of [
    "Which journals publish the highest-cited work in computer security?",
    "what are the top venues in machine learning",
    "where should I publish this?",
    "show me the h5-index for medical journals",
    "Vilka tidskrifter inom medicin har högst h5-index?",
    "Vilka är de främsta tidskrifterna inom fysik?",
    "Var ska man publicera en artikel om kemi?",
    "Hur fungerar tidskriftsrankning?",
  ]) {
    assert.equal(venueIntent(s), true, `should fire: ${s}`);
  }
  for (const s of ["", "what does the research say about sleep", "vad säger forskningen om sömn"]) {
    assert.equal(venueIntent(s), false, `should not fire: ${s}`);
  }
});

test("venueCategory maps a field to Scholar's own code, EN and SV alike", () => {
  assert.equal(venueCategory("top journals in computer security"), "eng");
  assert.equal(venueCategory("tidskrifter inom datavetenskap"), "eng");
  assert.equal(venueCategory("best journals in clinical medicine"), "med");
  assert.equal(venueCategory("tidskrifter inom klinisk psykiatri"), "med");
  assert.equal(venueCategory("where to publish in quantum physics"), "phy");
  assert.equal(venueCategory("var publicerar man inom kvantfysik"), "phy");
  assert.equal(venueCategory("top journals in economics"), "bus");
  assert.equal(venueCategory("tidskrifter inom företagsekonomi"), "bus");
  assert.equal(venueCategory("which journals rank highest"), "", "no field named = all fields");
});

test("venueBlock says what h5-index measures and what it does not", () => {
  const t = /** @type {any} */ (parseVenueTable(VENUE_ARTIFACT));
  const block = venueBlock(t, "bio", topVenues(t, "bio", 5));
  assert.match(block, /Nature — h5-index 490, h5-median 784/);
  assert.match(block, /harvested 2026-07-31/);
  // The line that stops an answer reading a ranking as a quality judgement.
  assert.match(block, /rank VOLUME OF CITATION, not quality of review/);
});

// ---- the runner -----------------------------------------------------------------

/** A minimal EnrichmentCtx over a one-message conversation. */
/** @param {string} text @param {Record<string, any>} [over] */
function ctx(text, over = {}) {
  /** @type {string[][]} */
  const steps = [];
  const state = /** @type {any} */ ({});
  return {
    steps,
    state,
    c: /** @type {any} */ ({
      env: {},
      log: { info() {}, warn() {} },
      emit() {},
      step: (/** @type {string} */ id, /** @type {string} */ label) => steps.push(["start", id, label]),
      stepDone: (/** @type {string} */ id, /** @type {string} */ label) => steps.push(["done", id, label]),
      conversation: [{ role: "user", content: text }],
      state,
      ...over,
    }),
  };
}

test("the enrichment restricts EVERY turn to the peer-reviewed source", async () => {
  // This is the agent's promise, and it is three state fields rather than a
  // sentence in a prompt: force the scholar source on, forbid every other
  // auxiliary source, and raise its per-request ceiling because with the web
  // leg structurally down the gap rounds have nowhere else to go.
  const { c, state } = ctx("what is the boiling point of water");
  const out = await runScholarMetricsEnrichment(c);
  assert.deepEqual(state.forceAux, [SCHOLAR_SOURCE_ID]);
  assert.deepEqual(state.auxOnly, [SCHOLAR_SOURCE_ID]);
  assert.deepEqual(state.auxMaxPerRequest, { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST });
  // …and it appends nothing and shows no step on a turn that names neither a
  // profile nor a venue question.
  assert.deepEqual(out, c.conversation);
});

test("the enrichment folds in venue metrics without any outbound request", async () => {
  const { c, state } = ctx("Which journals publish the top-cited work in computer security?", {
    env: {
      ASSETS: {
        fetch: async () => new Response(JSON.stringify(VENUE_ARTIFACT), { headers: { "content-type": "application/json" } }),
      },
    },
  });
  const out = await runScholarMetricsEnrichment(c);
  const appended = String(out[0].content);
  assert.match(appended, /Google Scholar Metrics/);
  assert.match(appended, /IEEE Transactions on Information Forensics and Security/);
  assert.deepEqual(state.scholarVenues, { cat: "eng", shown: 1 });
});

test("a profile that cannot be read fails soft and VISIBLY", async () => {
  // The step already told the user a lookup had started, so silence here would
  // read as a result rather than an outage.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 429 });
  try {
    const { c, state, steps } = ctx("summarise https://scholar.google.com/citations?user=JicYPdAAAAAJ");
    const out = await runScholarMetricsEnrichment(c);
    assert.deepEqual(out, c.conversation, "the conversation comes back unchanged");
    assert.deepEqual(steps, [
      ["start", "scholar_profile", "Reading the Google Scholar profile…"],
      ["done", "scholar_profile", "The Google Scholar profile could not be read"],
    ]);
    assert.deepEqual(state.scholarProfile, { id: "JicYPdAAAAAJ", works: 0, h_index: 0 });
    // The restriction still applied — a dead Google does not hand the turn
    // back to the open web.
    assert.deepEqual(state.auxOnly, [SCHOLAR_SOURCE_ID]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a readable profile becomes an attributed context block", async () => {
  const realFetch = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(PROFILE_HTML, { status: 200 });
  };
  try {
    const { c, state } = ctx("what has https://scholar.google.com/citations?user=JicYPdAAAAAJ published?");
    const out = await runScholarMetricsEnrichment(c);
    // ONLY the robots-allowed path, carrying ONLY the id — never the question,
    // the conversation or any account identity (invariant 4).
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://scholar.google.com/citations?user=JicYPdAAAAAJ&hl=en");
    assert.ok(!urls[0].includes("published"), "the question does not cross the wire");
    assert.match(String(out[0].content), /Ada Nordin/);
    assert.equal(state.scholarProfile.h_index, 57);
    assert.equal(state.scholarProfile.works, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the preprint widening (owner directive, 2026-08-13) -------------------
//
// Deep Science became the exclusive OWNER of the site's arXiv and PubMed
// capability when the roster was made specific (src/search-sources.js
// `requiresContext`, src/literature-exclusivity.test.js). Owning a corpus it
// could never consult would be ownership in name only — `state.auxOnly` blocked
// both — so the reader may now ask for the preprint record by name and get it.
// What must NOT change is the shipped promise: an ordinary turn is the
// peer-reviewed leg alone, exactly as before.

test("the default turn is peer-reviewed only — the promise, unchanged", async () => {
  // Every one of these engages the WIDE arxiv/europepmc intent gates (research
  // phrasing over a scientific topic, a life-science subject), which is most of
  // what this agent is ever asked. Widening on those gates instead of the
  // narrow "named" ones would have turned "peer-reviewed only" into
  // "peer-reviewed plus whatever else matched", which is the whole trap.
  for (const text of [
    "what does the latest research say about llm swarm reasoning",
    "senaste forskningen om språkmodeller",
    "is intermittent fasting proven to lower blood pressure",
    "vad säger studierna om statiner och muskelvärk",
    "which journals publish the top-cited work in computer security",
  ]) {
    const { c, state } = ctx(text);
    await runScholarMetricsEnrichment(c);
    assert.deepEqual(state.auxOnly, [SCHOLAR_SOURCE_ID], `widened on "${text}"`);
    // The force and the raised ceiling stay keyed to the peer-reviewed leg.
    assert.deepEqual(state.forceAux, [SCHOLAR_SOURCE_ID]);
    assert.deepEqual(state.auxMaxPerRequest, { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST });
  }
});

test("naming the preprint record widens auxOnly to that corpus, and only that one", async () => {
  const arxiv = await (async () => {
    const { c, state } = ctx("any arxiv preprints on diffusion transformers?");
    await runScholarMetricsEnrichment(c);
    return state;
  })();
  assert.deepEqual(arxiv.auxOnly, [SCHOLAR_SOURCE_ID, "arxiv"]);
  // Forced and capped stay unchanged: the widened source is PERMITTED, not
  // forced (its own intent gate still has to fire, which the ask that named it
  // satisfies by construction), and it keeps its own registry ceiling.
  assert.deepEqual(arxiv.forceAux, [SCHOLAR_SOURCE_ID]);
  assert.deepEqual(arxiv.auxMaxPerRequest, { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST });

  const { c, state } = ctx("search pubmed for statin adherence trials");
  await runScholarMetricsEnrichment(c);
  assert.deepEqual(state.auxOnly, [SCHOLAR_SOURCE_ID, "europepmc"]);
});

test("preprintSources: EN and SV name the archives with the same breadth (invariant 6)", () => {
  // The gates are the sources' own NAMED tiers (arxivNamedIntent /
  // europepmcNamedIntent), so parity is inherited rather than re-implemented —
  // but inherited parity is exactly the kind that rots unnoticed, so it is
  // asserted here as matched pairs. The archive names are proper nouns and
  // identical in both languages; what differs is the Swedish word for the
  // record itself.
  const pairs = [
    ["any arxiv preprints on diffusion transformers", "finns det förhandstryck på arxiv om diffusionsmodeller", ["arxiv"]],
    ["is there a preprint on this method", "finns det ett preprint om den här metoden", ["arxiv"]],
    ["search pubmed for statin adherence trials", "sök i pubmed efter studier om statiner", ["europepmc"]],
    ["what does biorxiv have on ancient DNA", "vad finns på biorxiv om forntida dna", ["europepmc"]],
  ];
  for (const [en, sv, want] of pairs) {
    assert.deepEqual(preprintSources(en), want, `EN: ${en}`);
    assert.deepEqual(preprintSources(sv), want, `SV: ${sv}`);
  }
  // Both archives at once is both, in registry order.
  assert.deepEqual(preprintSources("compare the arxiv preprints with what pubmed indexes"), ["arxiv", "europepmc"]);
});

test("preprintSources: research phrasing is not naming, in either language", () => {
  for (const text of [
    "what does the latest research say about statins",
    "vad säger den senaste forskningen om statiner",
    "which peer-reviewed studies support this",
    "vilka vetenskapliga artiklar stöder detta",
    // The trap this gate must never fall into: `förtryck` is Swedish for
    // OPPRESSION, not "preprint" (src/arxiv.js records why it was removed from
    // the explicit tier — feedback #61's failure shape reached through a
    // dictionary word). A question about human rights must not open the
    // preprint archive.
    "politiskt förtryck i Belarus",
    "förtryck av kvinnor i Iran",
    "",
    null,
  ]) {
    assert.deepEqual(preprintSources(text), [], `widened on "${text}"`);
  }
});
