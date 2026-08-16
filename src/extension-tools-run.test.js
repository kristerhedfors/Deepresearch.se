// Unit tests for src/extension-tools-run.js — specifically that the MCP
// extension tools are METERED.
//
// Why this file exists. The three extension tools shipped passing the research
// quota gate and incrementing nothing, so a key that only called them was
// unmetered — the same defect the literature family carried until August 2026.
// It was caught in review and fixed, and the fix arrived with no test: deleting
// the `recordOutboundCalls` call from the runner's `finally` left the whole
// suite green except the artifact-drift check, which fires for any byte change.
// A fix nothing pins can regress exactly the way the bug arrived, which is what
// happened the first time. `literature-run.test.js` asserts `recordUsage` for
// the same reason; this is that assertion for this runner.
//
// No network: `host_intel` adds its targets to the spend BEFORE the lookup
// (extension-tools-run.js, `spend.calls += ips.length + hostnames.length`), so
// an env with no Shodan credential still exercises the whole metering path —
// the lookup degrades to "nothing came back" per invariant 2, and the `finally`
// records what was going to be spent either way.

import test from "node:test";
import assert from "node:assert/strict";

import { runExtensionTool } from "./extension-tools-run.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

/** The columns quota.js binds, in order (see the INSERT INTO usage_events). */
const COL = {
  user_id: 0,
  ts: 1,
  model: 2,
  prompt_tokens: 3,
  completion_tokens: 4,
  searches: 5,
  berget_cost: 6,
  exa_cost: 7,
  duration_ms: 8,
};

/**
 * A D1 fake that records only the usage_events inserts, matching the
 * captureRunDb idiom in quota.test.js — recordUsage writes a single row through
 * prepare/bind/run rather than batch().
 */
function captureRunDb() {
  /** @type {any[][]} */
  const inserts = [];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.includes("INSERT INTO usage_events")) inserts.push(args);
      return { success: true };
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return { _inserts: inserts, prepare: (sql) => stmt(sql), async batch() { return []; } };
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

test("host_intel bills the account one search per host looked up", async () => {
  const DB = captureRunDb();
  const answer = await runExtensionTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "host_intel",
    { hosts: "1.1.1.1, 8.8.8.8" },
    { identity: { id: "u-meter" } },
  );

  // The answer still arrives — no credential is configured, so it degrades to
  // the honest "cannot tell these three apart" message (invariant 2).
  assert.equal(answer.isError, false);

  assert.equal(DB._inserts.length, 1, "exactly one usage_events row");
  const row = DB._inserts[0];
  assert.equal(row[COL.user_id], "u-meter");
  assert.equal(row[COL.searches], 2, "two hosts asked about, two billed outbound calls");
  // Third-party spend is not Berget spend: the row exists to move the four-window
  // quota, not to claim token cost the tool never incurred.
  assert.equal(row[COL.model], null);
  assert.equal(row[COL.prompt_tokens], 0);
  assert.equal(row[COL.completion_tokens], 0);
  assert.equal(row[COL.berget_cost], 0);
});

test("a tool that spends nothing writes no row", async () => {
  // An empty row only inflates the request count, so the runner suppresses it.
  const DB = captureRunDb();
  await runExtensionTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "host_intel",
    { hosts: "" },
    { identity: { id: "u-meter" } },
  );
  assert.equal(DB._inserts.length, 0);
});

test("an anonymous caller is not billed, and does not throw", async () => {
  // recordUsage keys on a user id; without one there is nothing to charge. The
  // metering runs in a `finally` after the answer is formed, so failing to
  // record must never surface as an error (invariant 2).
  const DB = captureRunDb();
  const answer = await runExtensionTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "host_intel",
    { hosts: "1.1.1.1" },
    {},
  );
  assert.equal(answer.isError, false);
  assert.equal(DB._inserts.length, 0);
});

test("the metering survives a D1 outage without touching the answer", async () => {
  // Invariant 2 again, at the seam that matters most: a database that throws
  // degrades the ACCOUNTING, never the answer the caller asked for.
  const DB = {
    prepare() {
      throw new Error("D1 is down");
    },
    async batch() {
      throw new Error("D1 is down");
    },
  };
  const answer = await runExtensionTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "host_intel",
    { hosts: "1.1.1.1" },
    { identity: { id: "u-meter" } },
  );
  assert.equal(answer.isError, false);
  assert.ok(answer.text.length > 0);
});

// ============================================================================
// THE BROADER HOST-INTELLIGENCE TOOLS (2026-08-16)
// ============================================================================
//
// These drive the real runners against a stubbed fetch, which the tests above
// deliberately do not need — host_intel adds its spend before the lookup, so it
// meters with no network at all. The three tools added here decide how much to
// spend from what came BACK (a domain retried one level up costs two requests,
// a count-only search costs one), so the stub is what makes the meter testable.

const KEYED = { SHODAN_API_KEY: "k-for-the-runner-tests" };

/** Runs one extension tool against stubbed routes; returns { answer, rows, stub }. */
async function runTool(name, args, routes, env = KEYED) {
  const DB = captureRunDb();
  return withFakeFetch(routes, async (stub) => ({
    answer: await runExtensionTool(
      /** @type {any} */ ({ ...env, DB }),
      /** @type {any} */ (quietLog),
      name,
      args,
      { identity: { id: "u-meter" } },
    ),
    rows: DB._inserts,
    stub,
  }));
}

const COUNT = /\/shodan\/host\/count/;
const SEARCH = /\/shodan\/host\/search/;
const DOMAIN = /\/dns\/domain\//;
const CVE_ONE = /cvedb\.shodan\.io\/cve\//;

test("host_search bills the free count leg as well as the search", async () => {
  // The count costs Shodan nothing, and is metered anyway: a tool that reaches
  // a third party while moving no meter is one the quota gate cannot bound.
  const { answer, rows, stub } = await runTool(
    "host_search",
    { query: "product:nginx", facets: ["country"] },
    [
      [COUNT, { total: 4000, facets: { country: [{ value: "SE", count: 500 }] } }],
      [SEARCH, { total: 4000, matches: [{ ip_str: "203.0.113.1", port: 443, org: "Glesys AB" }] }],
    ],
  );
  assert.equal(answer.isError, false);
  assert.equal(answer.found, true);
  assert.match(answer.text, /Shodan matches 4000 hosts/);
  assert.match(answer.text, /By country, the largest are SE with 500/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][COL.searches], 2, "the count and the search are one billed unit each");
  // Both legs are independent, so they overlap rather than queue.
  assert.equal(stub.matching(COUNT).length, 1);
  assert.equal(stub.matching(SEARCH).length, 1);
});

test("count_only asks Shodan for no hosts at all, and bills one unit", async () => {
  const { answer, rows, stub } = await runTool(
    "host_search",
    { query: "port:22 country:SE", count_only: true },
    [[COUNT, { total: 812 }]],
  );
  assert.match(answer.text, /Shodan matches 812 hosts/);
  assert.equal(stub.matching(SEARCH).length, 0, "no search request is made");
  assert.equal(rows[0][COL.searches], 1);
});

test("a search with no facets asks for no count — the search reports its own total", async () => {
  // The count leg earns its place only when it is asked to break the total
  // DOWN; otherwise it is a second request for a number already in hand.
  const { answer, rows, stub } = await runTool("host_search", { query: "port:22" }, [
    [SEARCH, { total: 77, matches: [{ ip_str: "203.0.113.5", port: 22 }] }],
  ]);
  assert.equal(stub.matching(COUNT).length, 0);
  assert.match(answer.text, /Shodan matches 77 hosts/);
  assert.equal(rows[0][COL.searches], 1);
});

test("host_search reports WHY it could not run, rather than an empty result", async () => {
  const credits = JSON.stringify({ error: "Insufficient query credits" });
  const { answer } = await runTool("host_search", { query: "port:22" }, [
    [COUNT, new Response(credits, { status: 401 })],
    [SEARCH, new Response(credits, { status: 401 })],
  ]);
  assert.equal(answer.isError, true);
  // "No host matches that" and "the plan is out of credits" send a caller in
  // opposite directions, and only one of them is worth retrying.
  assert.match(answer.text, /Insufficient query credits/);
});

test("host_search survives one leg failing, using whichever answered", async () => {
  // Invariant 2 at the leg level: a dead count still leaves a usable search,
  // and the search's own total stands in for the one the count would have given.
  const { answer } = await runTool("host_search", { query: "port:22", facets: ["country"] }, [
    [COUNT, new Response("boom", { status: 500 })],
    [SEARCH, { total: 77, matches: [{ ip_str: "203.0.113.5", port: 22 }] }],
  ]);
  assert.equal(answer.isError, false);
  assert.match(answer.text, /Shodan matches 77 hosts/);
  assert.match(answer.text, /203\.0\.113\.5/);
});

test("host_search refuses an empty query without spending anything", async () => {
  const { answer, rows, stub } = await runTool("host_search", {}, []);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /`query` argument is required/);
  assert.deepEqual(stub.requests, []);
  assert.equal(rows.length, 0);
});

test("domain_intel retries one level up when handed a hostname, and bills both", async () => {
  const { answer, rows, stub } = await runTool("domain_intel", { domain: "www.example.com" }, [
    [
      DOMAIN,
      (rec) =>
        new URL(rec.url).pathname.endsWith("/www.example.com")
          ? new Response("No information available", { status: 404 })
          : { domain: "example.com", subdomains: ["www"], data: [{ subdomain: "www", type: "A", value: "203.0.113.9" }] },
    ],
  ]);
  assert.equal(answer.isError, false);
  assert.equal(stub.matching(DOMAIN).length, 2);
  // Answering about a different name than the one asked about is stated, never
  // silent.
  assert.match(answer.text, /www\.example\.com is not a domain Shodan tracks on its own/);
  assert.equal(rows[0][COL.searches], 2, "the retry is a second billed request");
});

test("domain_intel refuses an address, which is host_intel's question", async () => {
  const { answer, stub } = await runTool("domain_intel", { domain: "8.8.8.8" }, []);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /host_intel/);
  assert.deepEqual(stub.requests, []);
});

test("cve_intel answers with no Shodan credential — that database is keyless", async () => {
  const { answer, rows, stub } = await runTool(
    "cve_intel",
    { cve: "2021-44228" },
    [[CVE_ONE, { cve_id: "CVE-2021-44228", summary: "Log4Shell.", cvss: 10, epss: 0.97, kev: true }]],
    {}, // no SHODAN_API_KEY at all
  );
  assert.equal(answer.isError, false);
  assert.match(answer.text, /CVE-2021-44228/);
  assert.match(answer.text, /CVSS severity of 10 out of 10/);
  assert.equal(new URL(stub.requests[0].url).origin, "https://cvedb.shodan.io");
  // Free upstream, metered anyway — the flag is what puts it behind the quota
  // gate and the concurrency cap.
  assert.equal(rows[0][COL.searches], 1);
});

test("cve_intel refuses a non-identifier before spending, and says what one looks like", async () => {
  const { answer, rows, stub } = await runTool("cve_intel", { cve: "log4shell" }, []);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /CVE-2021-44228/);
  assert.deepEqual(stub.requests, []);
  assert.equal(rows.length, 0);
});

test("an unknown tool name is refused rather than dispatched", async () => {
  const { answer } = await runTool("host_scan", { hosts: "1.1.1.1" }, []);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Unknown tool/);
});
