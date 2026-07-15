// The secure-workspace GRANT-TOKEN invariants, end to end — the cross-
// subsystem suite over the quota-limited, account-bound, TEMPORARY tokens a
// workspace link can carry (wsk1 web-search grants, prg1/prx1 proxy grants):
// the properties that must hold when a token circulates INSIDE a sealed
// workspace link while its allowance is administered live on the server.
//
// The per-subsystem suites (websearch.test.js, proxy.test.js, and the token
// halves websearch-key.test.js / proxy-grant.test.js) each cover their own
// module in isolation. THIS suite pins what none of them can see alone:
//   - the token-fixed / row-metered split: an adjusted allowance is felt by
//     the ORIGINAL token in circulation (the whole point of the
//     secure-workspaces minter control) — the token's embedded quota claim is
//     mint-time provenance, never the meter;
//   - concurrency-overrun proofs on the atomic reserve, refund floors, and
//     the exhaust → refund → top-up recovery ledger;
//   - temporariness: expiry boundaries on all three token families, the row
//     expiry beating a still-valid token, expiry freeing the global budget,
//     and adjust NOT resurrecting an expired grant;
//   - account binding: the uid claim, per-user ghost isolation, and the
//     owner-scoped adjust reading foreign rows as byte-identical not_found;
//   - the cross-family forgery matrix (prefix swaps between wsk1/prg1/prx1
//     never verify — the namespace separation, tested at the wire);
//   - the whole workspace flow: mint → build payload (URL-safe tiers only,
//     never a prx1) → seal → open → apply → hydrate → spend both meters →
//     minter pause/top-up felt immediately → revoke kills it — offline open
//     still fine.
//
// D1 is one combined in-memory fake serving BOTH tables (websearch_grants +
// proxy_grants), so cross-subsystem budget independence is real here; Exa and
// Berget are a mocked global fetch. Config selects return null → the real
// DEFAULT_CONFIG applies (websearch quota 25; proxy web 25 / api 40).
import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustGrantQuota,
  grantStatus,
  grantWebSearch,
  handleWebSearch,
  handleWebSearchAdjust,
  mintWebSearchGrant,
  revokeGrant,
} from "./websearch.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";
import {
  adjustProxyGrantQuota,
  exchangeGrant,
  grantBundle,
  handleAdminProxy,
  handleProxyAdjust,
  handleProxyLlm,
  handleProxyWeb,
  mintBundle,
} from "./proxy.js";
import { mintGrantToken, mintProxyToken, verifyGrantToken, verifyProxyToken } from "./proxy-grant.js";
import { openBundle } from "../public/js/proxy-bundle.js";
import {
  applyWorkspacePayload,
  buildWorkspacePayload,
  generateWorkspacePassword,
  openWorkspace,
  parseWorkspaceHash,
  sealWorkspace,
  validateWorkspacePayload,
  workspaceLink,
} from "../public/js/workspace-core.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const minter = { id: "42", role: "user", email: "u@x", name: "U" };
const admin = { id: "admin", role: "admin" };

// One in-memory D1 serving BOTH grant tables, keyed to the statements
// websearch.js, proxy.js, and config.js actually run — so a single env can
// exercise the two subsystems side by side (budget independence, the full
// workspace flow). Mirrors the two per-suite fakes; the reserve guards keep
// their check-and-increment synchronous, modeling D1's row-level atomicity.
function fakeDb() {
  const ws = new Map(); // websearch_grants by jti
  const px = new Map(); // proxy_grants by jti
  const stmt = (sql) => ({
    _args: [],
    bind(...a) {
      this._args = a;
      return this;
    },
    async first() {
      if (sql.includes("websearch_grants")) {
        if (sql.includes("SUM(quota - used)")) {
          const [t] = this._args;
          return { rem: [...ws.values()].filter((r) => r.expires_at > t).reduce((a, r) => a + (r.quota - r.used), 0) };
        }
        if (sql.includes("source = 'ghost'")) {
          const [uid, t] = this._args;
          return (
            [...ws.values()]
              .filter((r) => r.user_id === uid && r.source === "ghost" && r.expires_at > t)
              .sort((a, b) => b.expires_at - a.expires_at)[0] || null
          );
        }
        return ws.get(this._args[0]) || null;
      }
      if (sql.includes("proxy_grants")) {
        if (sql.includes("SUM(quota - used)")) {
          const [t] = this._args;
          return { rem: [...px.values()].filter((r) => r.expires_at > t).reduce((a, r) => a + (r.quota - r.used), 0) };
        }
        if (sql.includes("SELECT bundle_id FROM proxy_grants")) {
          const [uid, t] = this._args;
          const r = [...px.values()]
            .filter((x) => x.user_id === uid && x.source === "ghost" && x.expires_at > t)
            .sort((a, b) => b.created_at - a.created_at)[0];
          return r ? { bundle_id: r.bundle_id } : null;
        }
        if (sql.includes("WHERE jti = ?1 AND expires_at > ?2")) {
          const [jti, t] = this._args;
          const r = px.get(jti);
          return r && r.expires_at > t ? { ...r } : null;
        }
        if (sql.includes("SELECT jti FROM proxy_grants")) {
          const r = px.get(this._args[0]);
          return r ? { jti: r.jti } : null;
        }
        const r = px.get(this._args[0]);
        return r ? { ...r } : null;
      }
      return null; // config select → DEFAULT_CONFIG applies
    },
    async all() {
      if (sql.includes("WHERE bundle_id = ?1")) {
        const [bundleId, t] = this._args;
        return { results: [...px.values()].filter((r) => r.bundle_id === bundleId && r.expires_at > t) };
      }
      const table = sql.includes("websearch_grants") ? ws : px;
      const [t] = this._args;
      return { results: [...table.values()].filter((r) => r.expires_at > t).sort((a, b) => b.created_at - a.created_at) };
    },
    async run() {
      if (sql.startsWith("INSERT INTO websearch_grants")) {
        const [jti, user_id, quota, created_at, expires_at, label, source] = this._args;
        ws.set(jti, { jti, user_id, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("INSERT INTO proxy_grants")) {
        const [jti, bundle_id, user_id, service, quota, created_at, expires_at, label, source] = this._args;
        px.set(jti, { jti, bundle_id, user_id, service, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      const table = sql.includes("websearch_grants") ? ws : px;
      if (sql.includes("SET quota =")) {
        const [jti, quota] = this._args;
        const r = table.get(jti);
        if (!r) return { meta: { changes: 0 } };
        r.quota = quota;
        return { meta: { changes: 1 } };
      }
      if (sql.includes("used = used + 1")) {
        if (sql.includes("proxy_grants")) {
          const [jti, service, t] = this._args;
          const r = px.get(jti);
          if (r && r.service === service && r.used < r.quota && r.expires_at > t) {
            r.used++;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        const [jti, t] = this._args;
        const r = ws.get(jti);
        if (r && r.used < r.quota && r.expires_at > t) {
          r.used++;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.includes("used = used - 1")) {
        const r = table.get(this._args[0]);
        if (r && r.used > 0) {
          r.used--;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.startsWith("DELETE FROM proxy_grants")) {
        const [bundleId] = this._args;
        let n = 0;
        for (const [k, r] of px) if (r.bundle_id === bundleId) (px.delete(k), n++);
        return { meta: { changes: n } };
      }
      if (sql.startsWith("DELETE FROM websearch_grants")) {
        const had = ws.delete(this._args[0]);
        return { meta: { changes: had ? 1 : 0 } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _ws: ws, _px: px, prepare: stmt, async batch() { return []; } };
}

const envWith = (db) => ({ DB: db, SESSION_SECRET: SECRET, EXA_API_KEY: "exa-test", BERGET_API_TOKEN: "berget-test" });
const post = (body) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body) });

// Swap global fetch for the duration of a callback. The dispatcher routes by
// upstream: Berget (the LLM proxy) vs Exa (everything else).
async function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
const exaHit = () =>
  new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.x/a", highlights: ["h"] }] }), { status: 200 });
const exaEmpty = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
const bothUpstreams = async (input) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.includes("berget")) {
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }
  return exaHit();
};

const searchReq = (token, query) => post({ token, query });
const nowS = () => Math.floor(Date.now() / 1000);

// ---- the token-fixed / row-metered split -------------------------------------------

test("an adjusted quota is felt by the ORIGINAL token: the row meters, the claim is provenance", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 2, ttlHours: 24, userId: "42", source: "link" });

  await withFetch(exaHit, async () => {
    // Spend to exhaustion on the original token.
    assert.equal((await handleWebSearch(searchReq(g.token, "q1"), env, log)).status, 200);
    assert.equal((await handleWebSearch(searchReq(g.token, "q2"), env, log)).status, 200);
    assert.equal((await handleWebSearch(searchReq(g.token, "q3"), env, log)).status, 429);

    // The minter raises the allowance — NO new token is issued.
    const up = await adjustGrantQuota(env, log, g.jti, { quota: 5 });
    assert.equal(up.quota, 5);
    // The very same token now spends again, up to the ROW's new quota…
    assert.equal((await handleWebSearch(searchReq(g.token, "q4"), env, log)).status, 200);
    // …while the token's embedded claim still reads the MINT-time quota: the
    // claim is provenance, never the meter.
    const claims = await verifyWebSearchToken(env, g.token);
    assert.equal(claims.quota, 2);
    assert.equal(db._ws.get(g.jti).used, 3);
  });
});

test("proxy tokens survive an adjust unchanged too, and adjust never moves expiry", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42", source: "link" });
  const webRow = b.connected.find((s) => s.svc === "web");
  const opened = await openBundle(b.blob, b.key);
  const webGrantToken = opened.grants.find((g) => g.svc === "web").token;
  const ex = await exchangeGrant(env, webGrantToken);

  const expBefore = db._px.get(webRow.jti).expires_at;
  await adjustProxyGrantQuota(env, log, webRow.jti, { quota: 1 });
  assert.equal(db._px.get(webRow.jti).expires_at, expBefore); // allowance moved, lifetime didn't

  await withFetch(exaHit, async () => {
    const send = () => handleProxyWeb(searchReq(ex.proxyToken, "q"), env, log);
    assert.equal((await send()).status, 200); // the pre-adjust proxy token still works
    assert.equal((await send()).status, 429); // …and the NEW quota (1) governs it
  });
  // The grant token also stays exchangeable after the adjust.
  const re = await exchangeGrant(env, webGrantToken);
  assert.equal(re.quota, 1);
  assert.equal(re.remaining, 0);
});

// ---- meter arithmetic under load ----------------------------------------------------

test("a concurrent burst can never overrun the web-search grant: exactly quota succeed", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 5, ttlHours: 24, userId: "42" });

  const results = await withFetch(exaHit, () =>
    Promise.all(Array.from({ length: 9 }, (_, i) => handleWebSearch(searchReq(g.token, "q" + i), env, log))),
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 5);
  assert.equal(codes.filter((c) => c === 429).length, 4);
  assert.equal(db._ws.get(g.jti).used, 5); // never above quota
});

test("a concurrent burst can never overrun a proxy grant either", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const opened = await openBundle(b.blob, b.key);
  const ex = await exchangeGrant(env, opened.grants.find((g) => g.svc === "web").token);
  await adjustProxyGrantQuota(env, log, ex.jti, { quota: 4 });

  const results = await withFetch(exaHit, () =>
    Promise.all(Array.from({ length: 7 }, (_, i) => handleProxyWeb(searchReq(ex.proxyToken, "q" + i), env, log))),
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 4);
  assert.equal(codes.filter((c) => c === 429).length, 3);
  assert.equal(db._px.get(ex.jti).used, 4);
});

test("refunds floor at zero, and the exhaust → refund → top-up ledger balances", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 1, ttlHours: 24, userId: "42" });

  // Repeated empty searches: each reserves then refunds — used never goes
  // negative, quota never burns for unusable results.
  await withFetch(exaEmpty, async () => {
    for (let i = 0; i < 3; i++) {
      const res = await handleWebSearch(searchReq(g.token, "nothing " + i), env, log);
      assert.equal((await res.json()).resultCount, 0);
    }
  });
  assert.equal(db._ws.get(g.jti).used, 0);

  await withFetch(exaHit, async () => {
    assert.equal((await handleWebSearch(searchReq(g.token, "hit"), env, log)).status, 200); // used 1/1
    assert.equal((await handleWebSearch(searchReq(g.token, "over"), env, log)).status, 429);
  });
  // Top up by one; an EMPTY search reserves and refunds (used stays 1)…
  await adjustGrantQuota(env, log, g.jti, { delta: 1 });
  await withFetch(exaEmpty, async () => {
    await handleWebSearch(searchReq(g.token, "empty again"), env, log);
  });
  assert.equal(db._ws.get(g.jti).used, 1);
  // …so the topped-up unit is still there for a real hit, then exhausted again.
  await withFetch(exaHit, async () => {
    assert.equal((await handleWebSearch(searchReq(g.token, "hit 2"), env, log)).status, 200);
    assert.equal((await handleWebSearch(searchReq(g.token, "over 2"), env, log)).status, 429);
  });
  assert.equal(db._ws.get(g.jti).used, 2);
});

// ---- temporariness -------------------------------------------------------------------

test("expiry boundary: all three token families die at exactly exp, not before", async () => {
  const env = envWith(fakeDb());
  const t = nowS();
  const exp = t + 100;
  const wsTok = await mintWebSearchToken(env, { jti: "j1", uid: "42", quota: 5, iat: t, exp });
  const prg = await mintGrantToken(env, { jti: "j2", uid: "42", svc: "web", quota: 5, iat: t, exp });
  const prx = await mintProxyToken(env, { jti: "j3", uid: "42", svc: "api", quota: 5, iat: t, exp });

  assert.ok(await verifyWebSearchToken(env, wsTok, exp * 1000 - 1));
  assert.equal(await verifyWebSearchToken(env, wsTok, exp * 1000), null);
  assert.ok(await verifyGrantToken(env, prg, exp * 1000 - 1));
  assert.equal(await verifyGrantToken(env, prg, exp * 1000), null);
  assert.ok(await verifyProxyToken(env, prx, exp * 1000 - 1));
  assert.equal(await verifyProxyToken(env, prx, exp * 1000), null);
});

test("a row that expired beats a still-valid token: reserve blocked, exchange refused", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 5, ttlHours: 24, userId: "42" });
  db._ws.get(g.jti).expires_at = nowS() - 5; // the ROW lapses; the token has hours left

  const res = await withFetch(exaHit, () => handleWebSearch(searchReq(g.token, "q"), env, log));
  assert.equal(res.status, 429); // reserve's expires_at guard, not the token check
  assert.equal(db._ws.get(g.jti).used, 0);

  const b = await mintBundle(env, log, { userId: "42" });
  const opened = await openBundle(b.blob, b.key);
  const webGrant = opened.grants.find((x) => x.svc === "web");
  const webRow = b.connected.find((s) => s.svc === "web");
  db._px.get(webRow.jti).expires_at = nowS() - 5;
  assert.equal(await exchangeGrant(env, webGrant.token), null); // no proxy token off a lapsed row
});

test("adjust cannot resurrect an expired grant, and an expired ghost grant is not reused", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g1 = await grantWebSearch(env, log, minter);
  db._ws.get(g1.jti).expires_at = nowS() - 5;

  // Raising the lapsed grant's quota succeeds as a row edit but buys nothing:
  // the reserve guard is time-checked independently of the allowance.
  const up = await adjustGrantQuota(env, log, g1.jti, { quota: 100 });
  assert.equal(up.quota, 100);
  const res = await withFetch(exaHit, () => handleWebSearch(searchReq(g1.token, "q"), env, log));
  assert.equal(res.status, 429);

  // The ghost path mints FRESH instead of reusing the lapsed grant.
  const g2 = await grantWebSearch(env, log, minter);
  assert.notEqual(g2.jti, g1.jti);
  assert.equal(db._ws.size, 2);
});

// ---- the global budget ceiling -------------------------------------------------------

test("expired and paused grants free the budget; the ceiling is exact at the boundary", async () => {
  const db = fakeDb();
  const env = envWith(db);

  // 40 outstanding under a 50 budget → a 20-mint is blocked…
  const a = await mintWebSearchGrant(env, log, { quota: 40, ttlHours: 24, userId: "42", budget: 50 });
  assert.equal((await mintWebSearchGrant(env, log, { quota: 20, ttlHours: 24, userId: "42", budget: 50 })).error, "budget_exceeded");
  // …an adjust up to EXACTLY the ceiling passes, one past it doesn't.
  const exact = await adjustGrantQuota(env, log, a.jti, { delta: 10 }, { budget: 50 });
  assert.equal(exact.quota, 50);
  assert.equal((await adjustGrantQuota(env, log, a.jti, { delta: 1 }, { budget: 50 })).error, "budget_exceeded");

  // Pausing frees the whole remaining allowance for new mints…
  await adjustGrantQuota(env, log, a.jti, { quota: 0 });
  const afterPause = await mintWebSearchGrant(env, log, { quota: 20, ttlHours: 24, userId: "42", budget: 50 });
  assert.equal(afterPause.error, undefined);
  // …and natural expiry does the same.
  db._ws.get(afterPause.jti).expires_at = nowS() - 5;
  const afterExpiry = await mintWebSearchGrant(env, log, { quota: 50, ttlHours: 24, userId: "42", budget: 50 });
  assert.equal(afterExpiry.error, undefined);
});

test("a proxy adjust counts the whole table's outstanding; the two subsystems' budgets are independent", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" }); // web 25 + api 40 = 65 outstanding
  const webRow = b.connected.find((s) => s.svc === "web");

  // +10 on the web row is judged against BOTH services' outstanding (65).
  assert.equal((await adjustProxyGrantQuota(env, log, webRow.jti, { delta: 10 }, { budget: 70 })).error, "budget_exceeded");
  assert.equal((await adjustProxyGrantQuota(env, log, webRow.jti, { delta: 10 }, { budget: 80 })).quota, 35);

  // The websearch table doesn't see any of it: its own outstanding is 0, so a
  // 40-mint under a 50 budget passes despite 75 outstanding next door.
  const wsMint = await mintWebSearchGrant(env, log, { quota: 40, ttlHours: 24, userId: "42", budget: 50 });
  assert.equal(wsMint.error, undefined);
});

// ---- account binding -----------------------------------------------------------------

test("tokens carry the minting account; ghost grants are per-user and per-source", async () => {
  const db = fakeDb();
  const env = envWith(db);

  // A pre-existing LINK grant of the same user is never reused by the ghost path.
  await mintWebSearchGrant(env, log, { quota: 10, ttlHours: 24, userId: "42", source: "link" });
  const mine = await grantWebSearch(env, log, minter);
  assert.equal(db._ws.size, 2);
  assert.equal((await verifyWebSearchToken(env, mine.token)).uid, "42"); // accountability claim

  // Different users never share a ghost grant or bundle.
  const other = { id: "7", role: "user", email: "o@x", name: "O" };
  const theirs = await grantWebSearch(env, log, other);
  assert.notEqual(theirs.jti, mine.jti);
  const b1 = await grantBundle(env, log, minter);
  const b2 = await grantBundle(env, log, other);
  assert.notEqual(b1.bundleId, b2.bundleId);
  for (const g of (await openBundle(b2.blob, b2.key)).grants) {
    assert.equal((await verifyGrantToken(env, g.token)).uid, "7");
  }
});

test("a foreign owner's adjust is byte-identical to a missing jti — no confirmation leak", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 10, ttlHours: 24, userId: "42", source: "ghost" });
  const stranger = { id: "7", role: "user", email: "o@x", name: "O" };

  const foreign = await handleWebSearchAdjust(post({ jti: g.jti, quota: 1 }), env, log, stranger);
  const missing = await handleWebSearchAdjust(post({ jti: "no-such-jti", quota: 1 }), env, log, stranger);
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await foreign.json(), await missing.json());
  assert.equal(db._ws.get(g.jti).quota, 10); // untouched

  const b = await mintBundle(env, log, { userId: "42", source: "ghost" });
  const jti = b.connected[0].jti;
  const pForeign = await handleProxyAdjust(post({ jti, quota: 1 }), env, log, stranger);
  const pMissing = await handleProxyAdjust(post({ jti: "no-such-jti", quota: 1 }), env, log, stranger);
  assert.equal(pForeign.status, 404);
  assert.equal(pMissing.status, 404);
  assert.deepEqual(await pForeign.json(), await pMissing.json());
});

// ---- the cross-family forgery matrix --------------------------------------------------

test("prefix-swapped tokens never verify: each family's signature is bound to its namespace", async () => {
  const env = envWith(fakeDb());
  const t = nowS();
  const claims = { jti: "j", uid: "42", svc: "web", quota: 5, iat: t, exp: t + 3600 };
  const tokens = {
    wsk1: await mintWebSearchToken(env, claims),
    prg1: await mintGrantToken(env, claims),
    prx1: await mintProxyToken(env, claims),
  };
  const verifiers = {
    wsk1: (tok) => verifyWebSearchToken(env, tok),
    prg1: (tok) => verifyGrantToken(env, tok),
    prx1: (tok) => verifyProxyToken(env, tok),
  };
  for (const [mintedAs, token] of Object.entries(tokens)) {
    const [, payload, sig] = token.split(".");
    for (const [family, verify] of Object.entries(verifiers)) {
      // Relabel the token as the target family so the prefix gate passes and
      // the HMAC namespace is what's actually on trial.
      const relabeled = `${family}.${payload}.${sig}`;
      const verdict = await verify(relabeled);
      if (family === mintedAs) assert.ok(verdict, `${mintedAs} must verify as itself`);
      else assert.equal(verdict, null, `${mintedAs} relabeled as ${family} must not verify`);
    }
  }
});

test("endpoints reject the wrong family outright: grant tokens never spend, spend tokens never exchange", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const opened = await openBundle(b.blob, b.key);
  const webGrant = opened.grants.find((g) => g.svc === "web").token;
  const g = await mintWebSearchGrant(env, log, { quota: 5, ttlHours: 24, userId: "42" });

  await withFetch(exaHit, async () => {
    // A proxy GRANT token on the public search endpoints: 403, nothing metered.
    assert.equal((await handleWebSearch(searchReq(webGrant, "q"), env, log)).status, 403);
    assert.equal((await handleProxyWeb(searchReq(webGrant, "q"), env, log)).status, 403);
    // A websearch token cannot enter the proxy world.
    assert.equal((await handleProxyWeb(searchReq(g.token, "q"), env, log)).status, 403);
  });
  assert.ok([...db._px.values()].every((r) => r.used === 0));
  assert.equal(db._ws.get(g.jti).used, 0);
});

// ---- the whole workspace flow ---------------------------------------------------------

test("mint → seal into a workspace link → open → hydrate → spend → minter control → revoke", async () => {
  const db = fakeDb();
  const env = envWith(db);

  // 1. MINT — the Se/rver user's ghost crossover produces both grant kinds.
  const ws = await grantWebSearch(env, log, minter);
  const bundle = await grantBundle(env, log, minter);
  const openedBundle = await openBundle(bundle.blob, bundle.key);
  const proxyGrants = openedBundle.grants.map((g) => ({ svc: g.svc, token: g.token }));

  // 2. BUILD the payload. Only the URL-safe tiers may travel: the wsk1 grant
  // and the prg1 grant tokens — never a working prx1 credential.
  const state = {
    keys: { openai: "sk-test-abc" },
    providerId: "openai",
    model: "gpt-5.6-luna",
    research: true,
    conversations: [{ title: "Seed", messages: [{ role: "user", content: "hello" }] }],
  };
  const payload = buildWorkspacePayload(state, {
    keys: true,
    settings: true,
    conversations: true,
    grants: { ws: ws.token, proxy: proxyGrants },
    name: "Team space",
  });
  assert.ok(validateWorkspacePayload(payload));
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes("prx1."), "a working proxy token must never enter a link");
  assert.ok(wire.includes("wsk1."));
  assert.ok(wire.includes("prg1."));
  for (const tok of [ws.token, ...proxyGrants.map((p) => p.token)]) {
    assert.match(tok, /^[A-Za-z0-9._-]+$/, "grant tokens must be URL-safe");
  }

  // 3. SEAL → LINK → OPEN (the holder's side, out-of-band password).
  const password = generateWorkspacePassword();
  const blob = await sealWorkspace(payload, password);
  const link = workspaceLink("https://deepresearch.se", blob);
  assert.equal(parseWorkspaceHash(link), blob);
  const openedWs = await openWorkspace(blob, password);
  assert.ok(openedWs);

  // 4. APPLY + HYDRATE — the grants come back out for the fail-soft grant paths.
  const holderState = { keys: {}, conversations: [] };
  const applied = applyWorkspacePayload(holderState, openedWs.payload);
  assert.equal(applied.grants.ws, ws.token);
  assert.equal(applied.grants.proxy.length, 2);
  const status = await grantStatus(env, applied.grants.ws);
  assert.equal(status.remaining, 25); // hydration is non-consuming
  const web = await exchangeGrant(env, applied.grants.proxy.find((p) => p.svc === "web").token);
  const api = await exchangeGrant(env, applied.grants.proxy.find((p) => p.svc === "api").token);
  assert.ok(web.proxyToken.startsWith("prx1.") && api.proxyToken.startsWith("prx1."));

  // 5. SPEND on all three meters from the opened workspace.
  await withFetch(bothUpstreams, async () => {
    const s1 = await handleWebSearch(searchReq(applied.grants.ws, "q"), env, log);
    assert.equal((await s1.json()).remaining, 24);
    const s2 = await handleProxyWeb(searchReq(web.proxyToken, "q"), env, log);
    assert.equal((await s2.json()).remaining, 24);
    const llmReq = () =>
      new Request("https://x/api/proxy/llm/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + api.proxyToken, "content-type": "application/json" },
        body: JSON.stringify({ model: "mistralai/x", messages: [{ role: "user", content: "q" }] }),
      });
    const s3 = await handleProxyLlm(llmReq(), env, log, new URL("https://x/api/proxy/llm/chat/completions"));
    assert.equal((await s3.json()).remaining, 39);

    // 6. MINTER CONTROL, live, through the authed self-service endpoints — the
    // holder feels every move immediately on the very same tokens.
    const pause = await handleWebSearchAdjust(post({ jti: ws.jti, quota: 0 }), env, log, minter);
    assert.equal(pause.status, 200);
    assert.equal((await handleWebSearch(searchReq(applied.grants.ws, "q"), env, log)).status, 429);
    const topUp = await handleWebSearchAdjust(post({ jti: ws.jti, delta: 10 }), env, log, minter);
    assert.equal((await topUp.json()).quota, 10);
    assert.equal((await handleWebSearch(searchReq(applied.grants.ws, "q"), env, log)).status, 200);

    const clampApi = await handleProxyAdjust(post({ jti: api.jti, quota: 1 }), env, log, minter);
    assert.equal((await clampApi.json()).remaining, 0); // used 1 > quota 1 - clamped, never negative
    assert.equal((await handleProxyLlm(llmReq(), env, log, new URL("https://x/api/proxy/llm/chat/completions"))).status, 429);
    await handleProxyAdjust(post({ jti: api.jti, delta: 4 }), env, log, minter);
    assert.equal((await handleProxyLlm(llmReq(), env, log, new URL("https://x/api/proxy/llm/chat/completions"))).status, 200);

    // 7. REVOKE kills the borrowed space for every holder of the link.
    const delUrl = new URL("https://x/api/admin/proxy/" + bundle.bundleId);
    await handleAdminProxy(new Request(delUrl, { method: "DELETE" }), env, delUrl, log, admin);
    assert.equal(await exchangeGrant(env, applied.grants.proxy[0].token), null); // fail-soft null, no throw
    assert.equal((await handleProxyWeb(searchReq(web.proxyToken, "q"), env, log)).status, 403);
    await revokeGrant(env, ws.jti);
    assert.equal(await grantStatus(env, applied.grants.ws), null);
    assert.equal((await handleWebSearch(searchReq(applied.grants.ws, "q"), env, log)).status, 403);
  });

  // 8. The workspace itself stays an OFFLINE object: the payload in the link
  // is intact after every server-side revocation — only the borrowed
  // capabilities die, never the opened workspace.
  assert.ok(validateWorkspacePayload(openedWs.payload));
  assert.equal(holderState.conversations.length, 1);
  assert.equal(holderState.keys.openai, "sk-test-abc");
});
