// Unit tests for the per-user CONCURRENCY reservation on POST /mcp
// (src/mcp.js, P-3 / docs/MCP-COST.md §4b).
//
// The defect these pin: /api/chat, /api/embed, /api/quiz/grade and
// /api/bash/step have taken a reserveInflight slot since 2026-07-12, and /mcp
// — the one endpoint an external bearer key drives, with no browser and no
// rate limiter in front of it — did not. So the check-then-act race quota.js's
// header describes was bounded everywhere except where it mattered most.
//
// What must hold, and why each is here rather than left to a live probe:
//
//   * a slot is HELD while a spending tool runs and RELEASED after it — a
//     leaked slot is a self-inflicted denial of service that only clears when
//     INFLIGHT_TTL_MS (300 s) ages the row out;
//   * released on the ERROR path too, which is the exit a leak hides behind;
//   * a refusal comes back as a JSON-RPC *result* with isError — an MCP client
//     reads the envelope, and a transport-level 429 reads to it as a broken
//     server rather than a condition its model can act on;
//   * a D1 failure fails OPEN for the RESERVATION (invariant 2) while the
//     quota gate beside it fails CLOSED — the two directions are deliberate
//     and the reasoning is written out above QUOTA_UNAVAILABLE_STATUS in
//     quota.js;
//   * the seven tools that contact no provider take NO slot — one held there
//     would only deny the caller its own next call.
//
// The suite drives the real handleMcp against an in-memory D1 stand-in (the
// harness style of src/quota.test.js, extended to record which statements ran)
// and a fake Vectorize index + stubbed Berget endpoints (the style of
// src/literature-run.test.js). Nothing here reaches the network.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_MCP_TOOLS,
  SPENDING_TOOL_NAMES,
  handleMcp,
  inflightLimitToolMessage,
  quotaUnavailableToolMessage,
} from "./mcp.js";
import { INFLIGHT_CAP } from "./quota.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = /** @type {any} */ ({ waitUntil() {} });

/** A 1024-dim vector, the width both hosted indexes are built at. */
const VEC = () => new Array(1024).fill(0.01);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * An in-memory D1 stand-in covering the reservation queries, and recording
 * every statement so a test can assert that NO reservation was attempted.
 * Unknown statements (the lazy schema migration, config reads, usage reads,
 * the chat-log insert) are accepted and answer empty, which is exactly the
 * "nothing recorded yet" state each caller degrades against.
 *
 * `failSql` makes a SUBSET of statements throw, which is what a real D1
 * incident usually looks like (one query erroring, not the binding vanishing)
 * and the only way to observe the reservation's fail-open in isolation now
 * that the quota gate beside it fails closed.
 * @param {{ failSql?: (sql: string) => boolean }} [opts]
 */
function mockD1({ failSql } = {}) {
  /** @type {{ req_id: string, user_id: string, ts: number }[]} */
  const rows = [];
  /** @type {string[]} */
  const seen = [];
  const make = (sql) => {
    if (failSql?.(sql)) throw new Error("d1 down");
    let args = [];
    return {
      sql,
      bind(...a) {
        args = a;
        return this;
      },
      async run() {
        seen.push(sql);
        if (sql.startsWith("DELETE FROM inflight WHERE ts <")) {
          const cutoff = args[0];
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < cutoff) rows.splice(i, 1);
        } else if (sql.startsWith("DELETE FROM inflight WHERE req_id")) {
          const id = String(args[0]);
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].req_id === id) rows.splice(i, 1);
        } else if (sql.startsWith("INSERT INTO inflight")) {
          rows.push({ req_id: String(args[0]), user_id: String(args[1]), ts: args[2] });
        }
        return { success: true };
      },
      async first() {
        seen.push(sql);
        if (sql.startsWith("SELECT COUNT(*) AS n FROM inflight WHERE user_id")) {
          const uid = String(args[0]);
          return { n: rows.filter((r) => r.user_id === uid).length };
        }
        return null;
      },
      async all() {
        seen.push(sql);
        return { results: [] };
      },
    };
  };
  return {
    _rows: rows,
    _seen: seen,
    /** Statements that touched the reservation table, in order. */
    inflightSql: () => seen.filter((s) => s.includes("inflight")),
    prepare: (sql) => make(sql),
    async batch() {
      return [];
    },
  };
}

/** A D1 binding that is simply broken — every access throws. */
const brokenD1 = {
  prepare() {
    throw new Error("d1 down");
  },
  batch() {
    throw new Error("d1 down");
  },
};

/**
 * A fake Vectorize index. `onQuery` fires mid-retrieval, which is how a test
 * observes whether the slot is held WHILE the tool runs rather than only
 * before and after it.
 * @param {{ rows?: any[], onQuery?: () => void }} [opts]
 */
function fakeIndex({ rows = [], onQuery } = {}) {
  return {
    async query() {
      if (onQuery) onQuery();
      return { matches: rows };
    },
    async getByIds(ids) {
      return rows.filter((r) => ids.includes(r.id));
    },
    async describe() {
      return { vectorCount: 772658, dimensions: 1024 };
    },
  };
}

function arxivRow(id, title) {
  return {
    id,
    metadata: { t: title, a: `An abstract about ${title}.`, au: "Ada Lovelace", c: "cs.IR", d: "2026-05-02" },
  };
}

/** Stub Berget's embeddings + rerank endpoints. Nothing else is reachable. */
function stubBerget() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (obj) =>
      new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
    if (href.endsWith("/embeddings")) {
      return json({ data: body.input.map((_, index) => ({ index, embedding: VEC() })), usage: { prompt_tokens: 10 } });
    }
    if (href.endsWith("/rerank")) {
      return json({ results: body.documents.map((_, index) => ({ index, relevance_score: 1 - index * 0.1 })) });
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
  return { restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

const user = /** @type {any} */ ({ id: "u1", role: "user", email: "u@example.com", name: "U", user: null });
const admin = /** @type {any} */ ({ id: "adm", role: "admin", email: "a@example.com", name: "A", user: null });

/**
 * POST one JSON-RPC tools/call at the real handler and return the parsed
 * envelope plus the Response (so a test can assert the transport status).
 */
async function callTool(env, name, args, { identity = user, requestId = "req-1" } = {}) {
  const request = new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcp(request, env, /** @type {any} */ (silentLog), identity, ctx, requestId);
  return { res, body: await res.clone().json() };
}

// ---------------------------------------------------------------------------
// Which tools hold a slot
// ---------------------------------------------------------------------------

describe("SPENDING_TOOL_NAMES", () => {
  test("is exactly the tools that reach a provider", () => {
    assert.deepEqual(
      [...SPENDING_TOOL_NAMES].sort(),
      [
        "deep_research",
        "literature_search",
        "literature_similar",
        "search",
        // The extension families: each reaches a metered third-party API, and
        // the imagery one a vision model on top. They arrive from the tool
        // registry rather than being written into mcp.js (invariant 7), which
        // is why this list is the assertion that catches a family added there
        // without a decision about what it costs.
        "street_view_look",
        "place_nearby",
        "host_intel",
      ].sort(),
    );
  });

  test("every name in the set is a tool this server actually serves", () => {
    const served = new Set(ALL_MCP_TOOLS.map((t) => t.name));
    for (const name of SPENDING_TOOL_NAMES) {
      assert.ok(served.has(name), `${name} must be a served tool`);
    }
  });

  test("the free seven are exempt — a slot there is pure self-denial of service", () => {
    // docs/MCP-COST.md §5: these cost nothing at a provider, so they cannot
    // take part in the check-then-act race the cap exists to bound.
    for (const name of [
      "literature_fetch",
      "literature_corpora",
      "fetch",
      "sdk_list_modules",
      "sdk_show_module",
      "sdk_plan",
      "sdk_validate",
    ]) {
      assert.equal(SPENDING_TOOL_NAMES.has(name), false, `${name} must not hold a slot`);
    }
  });
});

describe("inflightLimitToolMessage", () => {
  test("names the limit in plain language and leaks no cost figures", () => {
    const msg = inflightLimitToolMessage({ limit: 5, active: 5 });
    assert.match(msg, /5/);
    assert.match(msg, /limit/i);
    // Same rule as quota.js's inflightLimitResponse: a rate limit is not the
    // place to leak what the site pays.
    assert.ok(!/eur|€|budget|cost|\$/i.test(msg), "no internal cost figures");
    // Written for an LLM caller: it must say retrying immediately is pointless,
    // or the client model loops on it.
    assert.match(msg, /wait|finish/i);
  });
});

// ---------------------------------------------------------------------------
// The reservation lifecycle
// ---------------------------------------------------------------------------

describe("a spending tool takes and releases a slot", () => {
  test("literature_search holds a slot DURING the call and releases it after", async () => {
    const berget = stubBerget();
    const db = mockD1();
    /** @type {number[]} */
    const heldDuringRetrieval = [];
    const env = /** @type {any} */ ({
      DB: db,
      BERGET_API_TOKEN: "t",
      ARXIV_INDEX: fakeIndex({
        rows: [arxivRow("2401.00001", "Dense retrieval"), arxivRow("2401.00002", "Sparse retrieval")],
        onQuery: () => heldDuringRetrieval.push(db._rows.length),
      }),
    });
    try {
      const { res, body } = await callTool(
        env,
        "literature_search",
        { queries: ["how does dense retrieval work"], corpus: "arxiv" },
        { requestId: "req-held" },
      );
      assert.equal(res.status, 200);
      assert.equal(body.result.isError, false, "the tool ran normally");
      assert.match(body.result.content[0].text, /2401\.00001/);
      // Held while the retrieval was in flight…
      assert.ok(heldDuringRetrieval.length > 0, "the fake index was queried");
      assert.ok(
        heldDuringRetrieval.every((n) => n === 1),
        `the slot must be held during the run (saw ${heldDuringRetrieval})`,
      );
      // …and gone once the call returned.
      assert.deepEqual(db._rows, [], "the slot is released on the success path");
      const sql = db.inflightSql();
      assert.ok(
        sql.some((s) => s.startsWith("INSERT INTO inflight")),
        "a reservation was inserted",
      );
      assert.ok(
        sql.some((s) => s.startsWith("DELETE FROM inflight WHERE req_id")),
        "the reservation was deleted by req_id, not left to the TTL sweep",
      );
    } finally {
      berget.restore();
    }
  });

  test("deep_research releases the slot when the tool THROWS", async () => {
    // No BERGET_API_TOKEN → runDeepResearch throws before it imports the
    // pipeline, which is the cheapest real error path this surface has.
    const db = mockD1();
    const env = /** @type {any} */ ({ DB: db });
    const { res, body } = await callTool(env, "deep_research", { question: "anything" }, { requestId: "req-boom" });
    assert.equal(res.status, 200);
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Research failed/);
    assert.deepEqual(db._rows, [], "the slot is released on the error path");
    assert.ok(db.inflightSql().some((s) => s.startsWith("INSERT INTO inflight")), "a reservation was taken first");
  });

  test("a tool-level soft failure still releases the slot", async () => {
    // No corpus binding: the literature runner degrades to a named miss rather
    // than throwing, and that is still an exit path the slot must survive.
    const db = mockD1();
    const env = /** @type {any} */ ({ DB: db, BERGET_API_TOKEN: "t" });
    const { body } = await callTool(env, "literature_search", { queries: ["anything"] }, { requestId: "req-soft" });
    assert.equal(body.result.isError, true);
    assert.deepEqual(db._rows, []);
  });

  test("ADMINS take a slot too — the cap is abuse mitigation, not a spend cap", async () => {
    // An admin is exempt from the QUOTA gate (a spend cap an operator is
    // trusted to exceed) and deliberately NOT from the concurrency cap: an
    // admin credential is the one whose leak matters most.
    const db = mockD1();
    const env = /** @type {any} */ ({ DB: db });
    await callTool(env, "deep_research", { question: "x" }, { identity: admin, requestId: "req-admin" });
    assert.ok(
      db.inflightSql().some((s) => s.startsWith("INSERT INTO inflight")),
      "an admin call reserves a slot like any other",
    );
    assert.deepEqual(db._rows, [], "and releases it");
  });
});

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

describe("the refusal is a JSON-RPC result, never a transport error", () => {
  test("an over-cap caller gets isError inside a 200 result envelope", async () => {
    const db = mockD1();
    const now = Date.now();
    for (let i = 0; i < INFLIGHT_CAP; i++) db._rows.push({ req_id: `held-${i}`, user_id: "u1", ts: now });
    const env = /** @type {any} */ ({ DB: db, BERGET_API_TOKEN: "t" });

    const { res, body } = await callTool(env, "deep_research", { question: "x" }, { requestId: "req-over" });
    assert.equal(res.status, 200, "an MCP client reads the envelope — a 429 reads as a broken server");
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 42);
    assert.equal(body.error, undefined, "not a JSON-RPC error");
    assert.equal(body.result.isError, true);
    assert.equal(body.result.content[0].text, inflightLimitToolMessage({ limit: INFLIGHT_CAP, active: INFLIGHT_CAP }));
    // Refused WITHOUT inserting, so the refusal cannot itself consume a slot.
    assert.equal(db._rows.length, INFLIGHT_CAP);
  });

  test("another user is unaffected by a saturated account", async () => {
    const db = mockD1();
    const now = Date.now();
    for (let i = 0; i < INFLIGHT_CAP; i++) db._rows.push({ req_id: `held-${i}`, user_id: "u1", ts: now });
    const env = /** @type {any} */ ({ DB: db });
    const other = /** @type {any} */ ({ id: "u2", role: "user", email: null, name: null, user: null });
    const { body } = await callTool(env, "deep_research", { question: "x" }, { identity: other, requestId: "req-u2" });
    // Not the rate-limit message — it got through to the tool and failed there.
    assert.match(body.result.content[0].text, /Research failed/);
  });
});

// ---------------------------------------------------------------------------
// Fail-soft (invariant 2)
// ---------------------------------------------------------------------------

describe("the RESERVATION fails open", () => {
  // Driven with an ordinary user, which is the caller the cap actually applies
  // to: only the inflight statements throw, so the quota gate beside it reads
  // its windows normally and the reservation's own fail-open is what decides.
  const inflightOnly = { failSql: (/** @type {string} */ sql) => sql.includes("inflight") };

  test("an errored reservation lets an ordinary user through and does not 500", async () => {
    const db = mockD1(inflightOnly);
    const env = /** @type {any} */ ({ DB: db, BERGET_API_TOKEN: "t" });
    const { res, body } = await callTool(env, "literature_search", { queries: ["x"] }, { requestId: "req-nores" });
    assert.equal(res.status, 200);
    // It reached the tool (which then reports no corpus binding) rather than
    // being refused by the cap or by an escaped throw.
    assert.match(body.result.content[0].text, /No hosted corpus/i);
  });

  test("a wholly broken database does not 500 either", async () => {
    // An admin here, and deliberately so: with a dead D1 the quota gate refuses
    // every non-exempt caller (the test below pins that), so the admin
    // exemption is what leaves the reservation as the only decision left to
    // observe. This is the LAST D1 touch on an admin's path.
    const env = /** @type {any} */ ({ DB: brokenD1, BERGET_API_TOKEN: "t" });
    const { res, body } = await callTool(env, "literature_search", { queries: ["x"] }, {
      identity: admin,
      requestId: "req-nodb",
    });
    assert.equal(res.status, 200);
    assert.match(body.result.content[0].text, /No hosted corpus/i);
  });

  test("no DB binding at all is likewise allowed", async () => {
    // A site with no database is a SUPPORTED configuration, not an outage:
    // nothing throws, so nothing is refused — for an ordinary user either.
    const env = /** @type {any} */ ({ BERGET_API_TOKEN: "t" });
    const { body } = await callTool(env, "literature_search", { queries: ["x" ] }, { requestId: "req-nobind" });
    assert.match(body.result.content[0].text, /No hosted corpus/i);
  });
});

// ---------------------------------------------------------------------------
// The QUOTA GATE fails the other way — deliberately (quota.js,
// QUOTA_UNAVAILABLE_STATUS). Before this was chosen, the gate's D1 reads threw
// and the throw escaped as `Literature tool failed: d1 down`: a refusal nobody
// picked, worded so no caller could act on it.
// ---------------------------------------------------------------------------

describe("the QUOTA GATE fails closed", () => {
  for (const tool of ["literature_search", "literature_similar", "search"]) {
    test(`${tool} refuses an ordinary user with a readable message, not a throw`, async () => {
      const env = /** @type {any} */ ({ DB: brokenD1, BERGET_API_TOKEN: "t" });
      const { res, body } = await callTool(env, /** @type {any} */ (tool), { queries: ["x"], query: "x" }, {
        requestId: `req-gate-${tool}`,
      });
      assert.equal(res.status, 200, "never a transport error — an MCP client reads the envelope");
      assert.equal(body.error, undefined, "not a JSON-RPC error either");
      assert.equal(body.result.isError, true);
      assert.equal(body.result.content[0].text, quotaUnavailableToolMessage());
      // The old escaped-throw wording must not come back.
      assert.ok(!/d1 down/i.test(body.result.content[0].text), "no raw database error reaches the caller");
    });
  }

  test("deep_research refuses too, and does not reach the pipeline", async () => {
    const env = /** @type {any} */ ({ DB: brokenD1, BERGET_API_TOKEN: "t" });
    const { res, body } = await callTool(env, "deep_research", { question: "x" }, { requestId: "req-gate-deep" });
    assert.equal(res.status, 200);
    assert.equal(body.result.isError, true);
    // Carried out through dispatchToolCall's catch, so it wears the same
    // "Research failed:" prefix the quota-EXCEEDED refusal has always worn.
    assert.match(body.result.content[0].text, /quota can't be checked/i);
    assert.ok(!/d1 down/i.test(body.result.content[0].text));
  });

  test("an ADMIN is exempt from the gate, so a dead D1 never blocks an operator", async () => {
    const env = /** @type {any} */ ({ DB: brokenD1, BERGET_API_TOKEN: "t" });
    const { body } = await callTool(env, "literature_search", { queries: ["x"] }, {
      identity: admin,
      requestId: "req-gate-admin",
    });
    assert.ok(!/quota/i.test(body.result.content[0].text), "an admin call is not refused by the quota gate");
  });

  test("the free tools stay reachable — they are outside the gate", async () => {
    // An agent whose usage cannot be read should still be able to learn what
    // exists and resolve an id it was handed; neither costs anything.
    const env = /** @type {any} */ ({ DB: brokenD1, BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() });
    const { body } = await callTool(env, "literature_corpora", {}, { requestId: "req-gate-free" });
    assert.equal(body.result.isError, false);
    assert.ok(!/quota/i.test(body.result.content[0].text));
  });

  test("the message tells an LLM caller it is temporary and not its own limit", () => {
    const msg = quotaUnavailableToolMessage();
    assert.match(msg, /not a limit on the account/i, "or the model stops instead of retrying");
    assert.match(msg, /try (the call )?again/i);
    assert.ok(!/eur|€|\$/i.test(msg), "no cost figures, same rule as every other refusal here");
  });
});

// ---------------------------------------------------------------------------
// The exempt tools
// ---------------------------------------------------------------------------

describe("the free tools take no reservation", () => {
  for (const [name, args] of [
    ["literature_corpora", {}],
    ["literature_fetch", { ids: ["2401.00001"] }],
    ["fetch", { id: "2401.00001" }],
  ]) {
    test(`${name} touches the inflight table not at all`, async () => {
      const db = mockD1();
      const env = /** @type {any} */ ({ DB: db, BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() });
      const { res } = await callTool(env, /** @type {any} */ (name), args, { requestId: `req-${name}` });
      assert.equal(res.status, 200);
      assert.deepEqual(db.inflightSql(), [], `${name} must not reserve`);
    });
  }

  test("a tool the account has switched off is refused without reserving", async () => {
    const db = mockD1();
    const env = /** @type {any} */ ({ DB: db });
    const off = /** @type {any} */ ({
      id: "u1",
      role: "user",
      email: null,
      name: null,
      user: { settings_json: JSON.stringify({ mcp: { tools: { deep_research: false } } }) },
    });
    const { body } = await callTool(env, "deep_research", { question: "x" }, { identity: off, requestId: "req-off" });
    assert.ok(body.error, "reported as a JSON-RPC error (unknown tool)");
    assert.deepEqual(db.inflightSql(), [], "no slot is held for a tool that does not exist here");
  });
});
