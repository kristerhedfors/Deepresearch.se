// The MCP control surface (src/mcp-api.js): key resolution — including every
// way a key stops working — the config/key endpoints, and the endpoint URL
// shown in the setup instructions.
//
// D1 is a small in-memory fake recognizing the two statements this module and
// src/accounts.js run against `users` (a SELECT by id, an UPDATE of
// settings_json), plus the batch/ALTER calls src/db.js's one-time migration
// makes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  handleMcpConfigGet,
  handleMcpConfigPut,
  handleMcpKeyMint,
  handleMcpKeyRevoke,
  mcpEndpointUrl,
  resolveMcpKeyIdentity,
} from "./mcp-api.js";
import { parseMcpConfig } from "./mcp-config.js";
import { mintMcpKey } from "./mcp-key.js";

const SECRET = "9f2a71c4be08d5361ea9c7b204fd8e63a15c07d94b8e2f6031ac5d78e9b40126";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const URL_APEX = new URL("https://deepresearch.se/api/mcp/config");

/** A users table with one row, and the two statements this module runs. */
function fakeEnv(user) {
  const rows = new Map([[user.id, { ...user }]]);
  const stmt = (sql) => ({
    _args: [],
    bind(...a) {
      this._args = a;
      return this;
    },
    async first() {
      if (sql.includes("FROM users WHERE id")) return rows.get(Number(this._args[0])) || null;
      return null;
    },
    async run() {
      if (sql.startsWith("UPDATE users SET settings_json")) {
        const [json, id] = this._args;
        const row = rows.get(Number(id));
        if (row) row.settings_json = json;
      }
      return { success: true };
    },
    async all() {
      return { results: [] };
    },
  });
  return {
    env: { SESSION_SECRET: SECRET, DB: { prepare: stmt, async batch() {} } },
    rows,
  };
}

const activeUser = (settings) => ({
  id: 42,
  email: "a@b.test",
  name: "Ada",
  role: "user",
  status: "active",
  settings_json: settings ? JSON.stringify(settings) : null,
});

/** An identity carrying a live user row, as the identity gate produces. */
const identityFor = (row) => ({
  id: String(row.id),
  role: "user",
  email: row.email,
  name: row.name,
  user: row,
});

const readJson = (res) => res.json();

// ---- resolveMcpKeyIdentity ---------------------------------------------------

test("no bearer at all: null, so the request falls through to the identity gate", async () => {
  const { env } = fakeEnv(activeUser());
  const req = new Request("https://mcp.deepresearch.se/mcp", { method: "POST" });
  assert.equal(await resolveMcpKeyIdentity(req, env), null);
});

test("some OTHER family's bearer is not an MCP key either — still null", async () => {
  const { env } = fakeEnv(activeUser());
  const req = new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers: { authorization: "Bearer prx1.abc.def" },
  });
  assert.equal(await resolveMcpKeyIdentity(req, env), null);
});

/** Mint a key for the fake account and record it, the way the endpoint does. */
async function keyedEnv(overrides = {}) {
  const user = activeUser();
  const { env, rows } = fakeEnv(user);
  const minted = await mintMcpKey(env, user.id);
  const config = {
    enabled: true,
    key: { jti: minted.jti, hint: minted.hint, label: "test", created_at: Date.now(), exp: minted.exp },
    ...overrides,
  };
  rows.get(42).settings_json = JSON.stringify({ mcp: config });
  return { env, rows, token: minted.token, minted };
}

const keyRequest = (token) =>
  new Request("https://mcp.deepresearch.se/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

test("a live key resolves to its account's identity and config", async () => {
  const { env, token } = await keyedEnv();
  const resolved = await resolveMcpKeyIdentity(keyRequest(token), env);
  assert.ok(resolved && "identity" in resolved);
  assert.equal(resolved.identity.id, "42");
  assert.equal(resolved.identity.email, "a@b.test");
  assert.equal(resolved.identity.role, "user");
  assert.ok(resolved.identity.user, "the D1 row rides along so the pipeline can read settings");
  assert.equal(resolved.config.enabled, true);
});

test("a REVOKED key stops working immediately — the account's jti no longer matches", async () => {
  const { env, rows, token } = await keyedEnv();
  rows.get(42).settings_json = JSON.stringify({ mcp: { enabled: true, key: null } });
  const resolved = await resolveMcpKeyIdentity(keyRequest(token), env);
  assert.ok(resolved && "error" in resolved);
  assert.match(resolved.error, /revoked/i);
});

test("a ROTATED key kills the previous issue", async () => {
  const { env, rows, token: first } = await keyedEnv();
  const second = await mintMcpKey(env, 42);
  rows.get(42).settings_json = JSON.stringify({
    mcp: { enabled: true, key: { jti: second.jti, hint: second.hint } },
  });
  assert.ok("error" in (await resolveMcpKeyIdentity(keyRequest(first), env)));
  assert.ok("identity" in (await resolveMcpKeyIdentity(keyRequest(second.token), env)));
});

test("the master switch off turns every key away", async () => {
  const { env, token } = await keyedEnv({ enabled: false });
  const resolved = await resolveMcpKeyIdentity(keyRequest(token), env);
  assert.ok(resolved && "error" in resolved);
  assert.match(resolved.error, /switched off/i);
});

test("a non-active account's key stops working", async () => {
  for (const status of ["pending", "disabled"]) {
    const { env, rows, token } = await keyedEnv();
    rows.get(42).status = status;
    const resolved = await resolveMcpKeyIdentity(keyRequest(token), env);
    assert.ok(resolved && "error" in resolved, `${status} should be refused`);
    assert.match(resolved.error, /not active/i);
  }
});

test("a deleted account's key stops working", async () => {
  const { env, rows, token } = await keyedEnv();
  rows.delete(42);
  const resolved = await resolveMcpKeyIdentity(keyRequest(token), env);
  assert.ok(resolved && "error" in resolved);
  assert.match(resolved.error, /no longer exists/i);
});

test("a garbage or expired mck1 token is refused, not ignored", async () => {
  const { env } = await keyedEnv();
  const resolved = await resolveMcpKeyIdentity(keyRequest("mck1.nonsense.deadbeef"), env);
  assert.ok(resolved && "error" in resolved, "a presented-but-bad key must not fall through to the login page");
  assert.match(resolved.error, /invalid or has expired/i);
});

// ---- the config endpoints ----------------------------------------------------

test("GET /api/mcp/config reports the defaults, the catalog and the endpoint", async () => {
  const user = activeUser();
  const payload = await readJson(await handleMcpConfigGet(URL_APEX, identityFor(user)));
  assert.equal(payload.endpoint, "https://mcp.deepresearch.se");
  assert.ok(payload.catalog.length >= 5);
  assert.equal(payload.config.enabled, true);
  assert.equal(payload.config.key, null);
  assert.match(payload.connect_command, /^claude mcp add --transport http deepresearch /);
  assert.match(payload.connect_command, /<your-key>/, "the placeholder, never a real token");
});

test("break-glass has no row to hang an MCP config on", async () => {
  const res = await handleMcpConfigGet(URL_APEX, { id: "admin", role: "admin", isSecretAdmin: true });
  assert.equal(res.status, 403);
});

test("PUT /api/mcp/config persists a partial update", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  const req = new Request("https://deepresearch.se/api/mcp/config", {
    method: "PUT",
    body: JSON.stringify({ tools: { sdk_plan: false }, defaults: { time_budget_s: 45 } }),
  });
  const payload = await readJson(await handleMcpConfigPut(req, env, URL_APEX, log, identity));
  assert.equal(payload.config.tools.sdk_plan, false);
  assert.equal(payload.config.tools.deep_research, true);
  assert.equal(payload.config.defaults.time_budget_s, 45);
  // And it round-trips through the column.
  assert.equal(parseMcpConfig(identity.user.settings_json).tools.sdk_plan, false);
});

test("PUT preserves the OTHER halves of settings_json", async () => {
  const user = activeUser({ bash_lite_mcp: true, accepted_models: ["a"] });
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  const req = new Request("https://deepresearch.se/api/mcp/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  await handleMcpConfigPut(req, env, URL_APEX, log, identity);
  const stored = JSON.parse(identity.user.settings_json);
  assert.equal(stored.bash_lite_mcp, true);
  assert.deepEqual(stored.accepted_models, ["a"]);
  assert.equal(stored.mcp.enabled, false);
});

test("PUT rejects a malformed body with the reason", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const req = new Request("https://deepresearch.se/api/mcp/config", {
    method: "PUT",
    body: JSON.stringify({ tools: { imaginary: true } }),
  });
  const res = await handleMcpConfigPut(req, env, URL_APEX, log, identityFor(user));
  assert.equal(res.status, 400);
  assert.match((await readJson(res)).error, /Unknown tool/);
});

// ---- mint / revoke -----------------------------------------------------------

const mintRequest = (label) =>
  new Request("https://deepresearch.se/api/mcp/key", {
    method: "POST",
    body: JSON.stringify(label ? { label } : {}),
  });

test("POST /api/mcp/key returns the token ONCE and stores only the jti + hint", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  const payload = await readJson(await handleMcpKeyMint(mintRequest("Laptop"), env, URL_APEX, log, identity));

  assert.match(payload.token, /^mck1\./);
  assert.equal(payload.rotated, false);
  assert.equal(payload.config.key.label, "Laptop");
  assert.equal(payload.config.key.hint, payload.token.slice(-6));
  assert.ok(payload.connect_command.includes(payload.token), "the paste-ready command carries the real key");

  // The row keeps no copy of the secret.
  assert.ok(!identity.user.settings_json.includes(payload.token));
  const stored = parseMcpConfig(identity.user.settings_json);
  assert.ok(stored.key.jti);
  assert.equal(stored.key.hint, payload.token.slice(-6));

  // And a later read never hands it back.
  const reread = await readJson(await handleMcpConfigGet(URL_APEX, identity));
  assert.equal(reread.token, undefined);
  assert.match(reread.connect_command, /<your-key>/);
});

test("minting again rotates: the new key works, the old one is dead", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  const first = await readJson(await handleMcpKeyMint(mintRequest(), env, URL_APEX, log, identity));
  const second = await readJson(await handleMcpKeyMint(mintRequest(), env, URL_APEX, log, identity));
  assert.equal(second.rotated, true);
  assert.notEqual(first.token, second.token);
  assert.ok("error" in (await resolveMcpKeyIdentity(keyRequest(first.token), env)));
  assert.ok("identity" in (await resolveMcpKeyIdentity(keyRequest(second.token), env)));
});

test("DELETE /api/mcp/key revokes, and is idempotent", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  const minted = await readJson(await handleMcpKeyMint(mintRequest(), env, URL_APEX, log, identity));
  const after = await readJson(await handleMcpKeyRevoke(env, URL_APEX, log, identity));
  assert.equal(after.config.key, null);
  assert.ok("error" in (await resolveMcpKeyIdentity(keyRequest(minted.token), env)));
  const again = await readJson(await handleMcpKeyRevoke(env, URL_APEX, log, identity));
  assert.equal(again.config.key, null);
});

test("revoking leaves the exposure config alone — it is a credential, not a setting", async () => {
  const user = activeUser();
  const { env } = fakeEnv(user);
  const identity = identityFor(user);
  await handleMcpConfigPut(
    new Request("https://x/y", { method: "PUT", body: JSON.stringify({ tools: { sdk_plan: false } }) }),
    env,
    URL_APEX,
    log,
    identity,
  );
  await handleMcpKeyMint(mintRequest(), env, URL_APEX, log, identity);
  const after = await readJson(await handleMcpKeyRevoke(env, URL_APEX, log, identity));
  assert.equal(after.config.tools.sdk_plan, false);
  assert.equal(after.config.enabled, true);
});

// ---- the endpoint shown in the instructions ----------------------------------

test("mcpEndpointUrl prefers the dedicated mcp. host, and falls back where none exists", () => {
  const at = (u) => mcpEndpointUrl(new URL(u));
  // The dedicated host advertises the BARE ORIGIN — the `/mcp` tail still
  // answers there, it is just not what we tell people to paste.
  assert.equal(at("https://deepresearch.se/rver"), "https://mcp.deepresearch.se");
  assert.equal(at("https://www.deepresearch.se/rver"), "https://mcp.deepresearch.se");
  assert.equal(at("https://mcp.deepresearch.se/mcp"), "https://mcp.deepresearch.se");
  // A preview or local deploy has no such host: point at where the reader is.
  assert.equal(
    at("https://abc-deepresearch-se.someone.workers.dev/rver"),
    "https://abc-deepresearch-se.someone.workers.dev/mcp",
  );
  assert.equal(at("http://localhost:8787/rver"), "http://localhost:8787/mcp");
});
