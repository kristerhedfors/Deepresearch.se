// Direct coverage of the shared side-endpoint admission preamble
// (src/endpoint-gate.js). The three endpoints that use it —
// /api/orchestrator/plan, /api/quiz/grade, /api/bash/step — each exercise it
// through their own handler; this suite pins the gate's own contract, which as
// three inlined copies had no test of its own: who is blocked, who bypasses,
// what the caller gets back, and how it behaves when the database is absent.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { enforceQuotaAndReserve } from "./endpoint-gate.js";
import { INFLIGHT_CAP } from "./quota.js";

/** A user identity with no stored overrides (global quota defaults apply). */
const user = /** @type {any} */ ({ id: "42", role: "user", email: null, name: null, user: null });
const admin = /** @type {any} */ ({ ...user, role: "admin" });
const secretAdmin = /** @type {any} */ ({ ...user, isSecretAdmin: true });

/**
 * A D1 fake covering the three statements the gate's path issues: the config
 * read (null → DEFAULT_CONFIG), the usage aggregate, and reserveInflight's
 * sweep/count/insert.
 * @param {{ h5Cost?: number, inflight?: number }} [opts]
 */
function fakeDb({ h5Cost = 0, inflight = 0 } = {}) {
  const inserted = /** @type {any[][]} */ ([]);
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.includes("INSERT INTO inflight")) inserted.push(args);
      return { success: true };
    },
    async first() {
      if (sql.includes("FROM config")) return null; // defaults
      if (sql.includes("FROM inflight")) return { n: inflight };
      if (sql.includes("FROM usage_events")) {
        // Only the h5 budget bucket matters here; the rest read as zero.
        return { h5_berget_cost: h5Cost, h5_oldest: null };
      }
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return { _inserted: inserted, prepare: (sql) => stmt(sql), async batch() { return []; } };
}

describe("enforceQuotaAndReserve", () => {
  test("admits a user within quota and hands back the reqId to release", async () => {
    const db = fakeDb();
    const gate = await enforceQuotaAndReserve(/** @type {any} */ ({ DB: db }), user);
    assert.equal(gate.response, null);
    assert.equal(typeof gate.reqId, "string");
    assert.ok(gate.reqId);
    // The slot really was reserved, under that same id.
    assert.equal(db._inserted.length, 1);
    assert.equal(db._inserted[0][0], gate.reqId);
  });

  test("blocks a user over the budget cap with a 429 and no reservation", async () => {
    // DEFAULT_CONFIG's h5 budget is well under 1000 EUR.
    const db = fakeDb({ h5Cost: 1000 });
    const gate = await enforceQuotaAndReserve(/** @type {any} */ ({ DB: db }), user);
    assert.equal(gate.reqId, null);
    const res = gate.response;
    assert.ok(res);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.quota.kind, "budget");
    assert.equal(body.quota.period, "h5");
    // The EUR amount never leaves the admin surface.
    assert.deepEqual(Object.keys(body.quota).sort(), ["kind", "period", "reset_at"]);
    // Nothing was reserved on the blocked path.
    assert.equal(db._inserted.length, 0);
  });

  test("admins are never blocked, however far over the cap they are", async () => {
    for (const ident of [admin, secretAdmin]) {
      const gate = await enforceQuotaAndReserve(
        /** @type {any} */ ({ DB: fakeDb({ h5Cost: 1000 }) }),
        ident,
      );
      assert.equal(gate.response, null, `${ident.role} / secret=${!!ident.isSecretAdmin} must pass`);
      assert.ok(gate.reqId);
    }
  });

  test("a user at the concurrency cap gets a 429 instead of a slot", async () => {
    const db = fakeDb({ inflight: INFLIGHT_CAP });
    const gate = await enforceQuotaAndReserve(/** @type {any} */ ({ DB: db }), user);
    assert.equal(gate.reqId, null);
    const res = gate.response;
    assert.ok(res);
    assert.equal(res.status, 429);
    assert.equal(db._inserted.length, 0);
  });

  test("fail-soft: no database configured admits rather than 500s", async () => {
    const gate = await enforceQuotaAndReserve(/** @type {any} */ ({}), user);
    assert.equal(gate.response, null);
    assert.ok(gate.reqId);
  });

  // The fail-soft story is ASYMMETRIC, and this pins it rather than asserting
  // the tidier behaviour: an ABSENT database admits (getConfig/getUsage return
  // defaults, reserveInflight reports degraded-ok), but a database that THROWS
  // propagates out of the usage read — getUsage has no catch, unlike
  // reserveInflight's explicit fail-open. That was equally true of the three
  // inlined copies this replaced, so it is preserved behaviour, not a
  // regression. Whether the quota read should fail open like the reservation
  // does is a live question for the owner, not something to change under a
  // refactor.
  test("a database that throws propagates from the usage read (no catch there)", async () => {
    const broken = /** @type {any} */ ({
      DB: {
        prepare() {
          throw new Error("d1 down");
        },
      },
    });
    await assert.rejects(() => enforceQuotaAndReserve(broken, user), /d1 down/);
  });
});
