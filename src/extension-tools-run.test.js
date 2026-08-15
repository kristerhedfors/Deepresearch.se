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
