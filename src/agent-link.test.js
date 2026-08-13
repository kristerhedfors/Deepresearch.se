// Agent share-link minting (src/agent-link.js): the thin adapter that mints a
// standard Se/rver token for an AgentSpec. Verifies it composes the EXISTING
// subsystem correctly — the JWT verifies, the D1 meter rows are created with the
// spec's quota, the closed permission vocabulary holds, and the failure paths
// (missing/unknown agent, no registry, no D1) return the right status. The JWT
// crypto itself is covered by server-token.test.js; the meter by
// server-grants.test.js — this suite is the wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleAgentLink, loadAgentRegistry } from "./agent-link.js";
import { verifyServerToken } from "./server-token.js";
import { AGENTS_REGISTRY_PATH, SNAPSHOT_PATH } from "../public/js/introspect-core.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const admin = { id: "admin-1", role: "admin" };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_TEXT = readFileSync(join(repoRoot, "sdk/AGENTS.json"), "utf8");

// A minimal in-memory D1 recognizing the statements mintServerTokenGrant +
// config.js run on the MINT path: the budget SUM, the INSERT, and config's
// null-row default. (The reserve/adjust paths aren't exercised here.)
function fakeDb() {
  const rows = new Map();
  const live = (t) => [...rows.values()].filter((r) => r.expires_at > t);
  const stmt = (sql) => ({
    _args: [],
    bind(...a) { this._args = a; return this; },
    async first() {
      if (sql.includes("SUM(quota - used)")) {
        const [t] = this._args;
        return { rem: live(t).reduce((a, r) => a + (r.quota - r.used), 0) };
      }
      return null; // config 'app' row absent → DEFAULT_CONFIG applies
    },
    async all() { return { results: [...rows.values()] }; },
    async run() {
      if (sql.startsWith("INSERT")) {
        const [jti, service, user_id, quota, created_at, expires_at, label, source] = this._args;
        rows.set(`${jti}|${service}`, { jti, service, user_id, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _rows: rows, prepare: stmt, async batch() { return []; } };
}

// A fake ASSETS binding serving the real AGENTS.json. `serve` says by which of
// the two routes: the standalone registry artifact (what a current deploy
// carries), the source snapshot (the fallback, and what a deploy whose bundle
// predates the artifact carries), or both.
function fakeAssets(agentsText = AGENTS_TEXT, serve = "both") {
  const snapshot = () =>
    JSON.stringify({ v: 1, files: [{ p: "sdk/AGENTS.json", s: agentsText.length, t: agentsText }] });
  return {
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === AGENTS_REGISTRY_PATH && serve !== "snapshot") {
        return new Response(agentsText, { status: 200 });
      }
      if (u.pathname === SNAPSHOT_PATH && serve !== "artifact") {
        return new Response(snapshot(), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

const envWith = (over = {}) => ({ DB: fakeDb(), ASSETS: fakeAssets(), SESSION_SECRET: SECRET, ...over });
const post = (body) => new Request("https://x/api/admin/agent-link", { method: "POST", body: JSON.stringify(body) });
const url = new URL("https://x/api/admin/agent-link");

test("loadAgentRegistry prefers the standalone artifact, falls back to the snapshot", async () => {
  // Both routes must produce the same registry. The artifact is what every
  // current deploy carries and what keeps the multi-megabyte snapshot off a
  // path that every request now takes (2026-08-13); the snapshot leg is the
  // fallback that keeps a deploy whose bundle predates the artifact routing by
  // capability instead of silently resolving a null one.
  for (const serve of ["both", "artifact", "snapshot"]) {
    const reg = await loadAgentRegistry({ ASSETS: fakeAssets(AGENTS_TEXT, serve) });
    assert.ok(reg && reg.agents.some((a) => a.id === "cyber"), `serve=${serve}`);
    assert.equal(reg.agents.some((a) => a.id === "research"), false, "the general agent is retired");
  }
  assert.equal(await loadAgentRegistry({}), null); // no ASSETS binding
  // Neither route available: null, never a throw (invariant 2).
  assert.equal(await loadAgentRegistry({ ASSETS: { async fetch() { return new Response("", { status: 404 }); } } }), null);
});

test("mints a Se/rver token for an agent: JWT verifies, meter rows carry the quota", async () => {
  const env = envWith();
  const res = await handleAgentLink(post({ agent: "cyber" }), env, url, log, admin);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.agent, "cyber");
  assert.ok(body.token, "returns the JWT");
  assert.ok(body.link.startsWith("https://x/cure?st="), "returns a shareable /cure link");

  // The token verifies through the REAL server-token verifier.
  const claims = await verifyServerToken(env, body.token);
  assert.ok(claims, "minted token verifies");
  // Research has a model + web-search toggle → both upstream perms.
  assert.deepEqual(claims.perms.sort(), ["api", "web"]);

  // The D1 rows exist, keyed by (jti, service), carrying Research's 50-req quota.
  const apiRow = env.DB._rows.get(`${claims.jti}|api`);
  assert.ok(apiRow && apiRow.quota === 50 && apiRow.used === 0);
  assert.equal(apiRow.source, "agent");
});

test("admin can override the quota at mint time", async () => {
  const env = envWith();
  const res = await handleAgentLink(post({ agent: "cyber", quotas: { api: 7 }, ttlHours: 1 }), env, url, log, admin);
  const body = await res.json();
  const claims = await verifyServerToken(env, body.token);
  assert.equal(env.DB._rows.get(`${claims.jti}|api`).quota, 7);
});

test("a client-only agent still mints (upstream access is via the bridge)", async () => {
  const env = envWith();
  const res = await handleAgentLink(post({ agent: "under-construction" }), env, url, log, admin);
  assert.equal(res.status, 200);
  const claims = await verifyServerToken(env, (await res.json()).token);
  assert.deepEqual(claims.perms, ["api"]); // prompt-input only → api
});

test("failure paths return the right status", async () => {
  assert.equal((await handleAgentLink(post({}), envWith(), url, log, admin)).status, 400); // no agent
  assert.equal((await handleAgentLink(post({ agent: "nope" }), envWith(), url, log, admin)).status, 404); // unknown
  const noAssets = { DB: fakeDb(), SESSION_SECRET: SECRET }; // no ASSETS → no registry
  assert.equal((await handleAgentLink(post({ agent: "cyber" }), noAssets, url, log, admin)).status, 503);
  const noDb = { ASSETS: fakeAssets(), SESSION_SECRET: SECRET }; // no D1 → mint unavailable
  assert.equal((await handleAgentLink(post({ agent: "cyber" }), noDb, url, log, admin)).status, 503);
});
