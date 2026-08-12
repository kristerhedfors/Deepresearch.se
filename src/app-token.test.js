// The hosted-model grant a published Agent Studio app ships with
// (src/app-token.js) — capture #CAP-22's fix. What has to hold:
//
//   1. A build that asks for hosted access gets a REAL Se/rver token, scoped to
//      the `api` permission only, minted for the app's owner.
//   2. Republishing REUSES it, so one app never accumulates allowances.
//   3. When no grant can be minted the app still gets a config file — with no
//      token — because a visitor must be told, not thrown at (invariant 2).
//   4. The generated file is a classic script defining one global, and cannot
//      break out of the <script> tag that loads it.
//
// D1 is the smallest fake that answers what minting runs: the config row (null
// → DEFAULT_CONFIG) and the INSERT per permission. The budget ceiling defaults
// to 0 (uncapped), so the SUM query is not reached here — server-grants.test.js
// owns that path.
import test from "node:test";
import assert from "node:assert/strict";
import { HOSTED_LLM_BASE, ensureAppGrant, hostedMetaRecord, renderAppConfig } from "./app-token.js";
import { verifyServerToken } from "./server-token.js";
import { DEFAULT_MODEL } from "./berget.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };

function fakeDb() {
  const inserts = [];
  return {
    _inserts: inserts,
    async batch(stmts) {
      // getDb() runs the schema in one batch before anything else touches D1.
      for (const s of stmts) await s.run();
      return [];
    },
    prepare(sql) {
      return {
        _args: [],
        bind(...a) {
          this._args = a;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO server_tokens")) {
            const [jti, service, user_id, quota, , expires_at, label, source] = this._args;
            inserts.push({ jti, service, user_id, quota, expires_at, label, source });
          }
          return { success: true };
        },
        async first() {
          return null; // the config row: DEFAULT_CONFIG applies
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

const envWith = (db) => ({ DB: db, SESSION_SECRET: SECRET, BERGET_API_TOKEN: "berget-test" });

test("a hosted build gets its own api-only grant, pinned to a model", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const grant = await ensureAppGrant(env, log, { slug: "tutor-a1b2", owner: "42" });

  assert.ok(grant.token, "a JWT is minted");
  assert.equal(grant.model, DEFAULT_MODEL, "pinned to the default Berget model");
  assert.equal(grant.base, HOSTED_LLM_BASE);
  assert.equal(grant.country, "Sweden", "Berget is the only upstream the proxy forwards to");

  // ONE row, for `api` alone: a published app has no business searching the web
  // on the site's Exa key, and the permission set is what bounds that.
  assert.equal(db._inserts.length, 1);
  assert.equal(db._inserts[0].service, "api");
  assert.equal(db._inserts[0].user_id, "42", "metered against the account that published it");
  assert.equal(db._inserts[0].quota, 200, "DEFAULT_CONFIG.server_token.app_quota");
  assert.equal(db._inserts[0].source, "app");
  assert.equal(db._inserts[0].label, "app:tutor-a1b2", "the admin surface can see which app it belongs to");

  // The token is a real Se/rver token and carries nothing beyond `api`.
  const claims = await verifyServerToken(env, grant.token);
  assert.deepEqual(claims.perms, ["api"]);
  assert.equal(claims.sub, "42");
});

test("republishing reuses the app's grant instead of stacking allowances", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const first = await ensureAppGrant(env, log, { slug: "tutor-a1b2", owner: "42" });
  const prev = hostedMetaRecord(first);
  assert.ok(prev?.token);

  const again = await ensureAppGrant(env, log, { slug: "tutor-a1b2", owner: "42", prev });
  assert.equal(again.token, first.token, "the same grant rides the next publish");
  assert.equal(db._inserts.length, 1, "nothing new was minted");
});

test("a grant close to expiry is renewed rather than handed on", async () => {
  // An app someone is actively iterating on must not hand its next visitor a
  // token that dies in a day.
  const db = fakeDb();
  const env = envWith(db);
  const prev = { token: "old.jwt", model: DEFAULT_MODEL, jti: "old", expiresAt: Date.now() + 2 * 24 * 3600 * 1000 };
  const grant = await ensureAppGrant(env, log, { slug: "tutor-a1b2", owner: "42", prev });
  assert.notEqual(grant.token, "old.jwt");
  assert.equal(db._inserts.length, 1);
});

test("no D1, no secret, or tokens disabled: a token-less config, never a failed publish", async () => {
  const noDb = await ensureAppGrant({ SESSION_SECRET: SECRET, BERGET_API_TOKEN: "x" }, log, {
    slug: "s", owner: "42",
  });
  assert.equal(noDb.token, null);
  assert.equal(noDb.reason, "unavailable");
  assert.equal(noDb.model, DEFAULT_MODEL, "the app is still told what it would have run on");

  const noBerget = await ensureAppGrant({ DB: fakeDb(), SESSION_SECRET: SECRET }, log, { slug: "s", owner: "42" });
  assert.equal(noBerget.token, null);
  assert.equal(noBerget.reason, "unconfigured");

  assert.equal(hostedMetaRecord(noDb), null, "nothing to remember when nothing was minted");
});

test("renderAppConfig is a classic script defining one global, tag-safe", () => {
  const js = renderAppConfig({
    token: "a.b.c",
    model: "m",
    base: HOSTED_LLM_BASE,
    country: "Sweden",
    flag: "🇸🇪",
    quota: 200,
    expiresAt: 1_800_000_000_000,
  });
  assert.match(js, /^\/\//, "opens with a comment saying where it came from");
  assert.match(js, /window\.DR_APP_CONFIG = \{/);
  assert.ok(!/\bimport\b|\bexport\b/.test(js), "a module script never loads in an opaque origin");

  const parsed = JSON.parse(js.slice(js.indexOf("{"), js.lastIndexOf("}") + 1));
  assert.equal(parsed.token, "a.b.c");
  assert.equal(parsed.model, "m");
  assert.equal(parsed.quota, 200);
  assert.equal(parsed.jti, undefined, "the admin handle stays in the build's meta");
});

test("renderAppConfig cannot close the script tag that loads it", () => {
  // Belt and braces: a model id is a catalog string today, but this file is
  // generated into a <script> and one "</script>" in a value would end it.
  const js = renderAppConfig({ token: "x", model: "</script><script>alert(1)</script>" });
  assert.ok(!js.includes("</script>"), "the closing tag is escaped away");
  assert.match(js, /\\u003c/);
});

test("a token-less config still tells the app what happened", () => {
  const js = renderAppConfig({ token: null, model: DEFAULT_MODEL, reason: "budget_exceeded" });
  const parsed = JSON.parse(js.slice(js.indexOf("{"), js.lastIndexOf("}") + 1));
  assert.equal(parsed.token, null);
  assert.equal(parsed.reason, "budget_exceeded");
});
