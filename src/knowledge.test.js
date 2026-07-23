// The workspace-knowledge inbox (src/knowledge.js): the self-provisioning
// import-agent keypair, the pool-token-authorized sealed submit (ciphertext
// only, revocation-aware, backlog-capped), the owner's list/import/delete,
// and the upload-open route's addressing gate. D1 is a small in-memory fake
// recognizing the statements the module runs; the seal round-trips use the
// REAL WebCrypto ECIES from knowledge-core.js — the point is that what rests
// in the fake inbox is genuinely unreadable ciphertext until import.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureKnowledgeAgent, handleKnowledgeApi, handleKnowledgeKey, handleKnowledgeSubmit } from "./knowledge.js";
import { mintPoolToken } from "./pool-token.js";
import {
  buildConclusion,
  buildKnowledgeBundle,
  sealKnowledge,
  validateKnowledgeEnvelope,
} from "../public/js/knowledge-core.js";

const SECRET = "aab9d62f8a311109ded0a2d4e838e1c1c7c65fef7b784c9623ee113f8ab5da9a";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const nowS = () => Math.floor(Date.now() / 1000);

// ── in-memory D1 fake ────────────────────────────────────────────────────────
function fakeDb() {
  let agent = null; // the single knowledge_agent row
  const inbox = new Map(); // id → row
  const poolTokens = new Map(); // jti → row
  const poolConsumers = new Map(); // `${pool} ${key}` → row

  const stmt = (sql) => ({
    _a: [],
    bind(...a) { this._a = a; return this; },
    async run() {
      const a = this._a;
      let changes = 0;
      if (sql.startsWith("INSERT OR IGNORE INTO knowledge_agent")) {
        if (!agent) { agent = { public_key: a[0], private_jwk: a[1], created_at: a[2] }; changes = 1; }
      } else if (sql.startsWith("INSERT INTO knowledge_inbox")) {
        inbox.set(a[0], { id: a[0], owner_id: a[1], token_jti: a[2], envelope_json: a[3], state: "new", created_at: a[4], imported_at: null });
        changes = 1;
      } else if (sql.startsWith("UPDATE knowledge_inbox SET state = 'imported'")) {
        const r = inbox.get(a[0]);
        if (r) { r.state = "imported"; r.imported_at = a[1]; changes = 1; }
      } else if (sql.startsWith("DELETE FROM knowledge_inbox")) {
        const r = inbox.get(a[0]);
        if (r && r.owner_id === a[1]) { inbox.delete(a[0]); changes = 1; }
      }
      return { meta: { changes } };
    },
    async first() {
      const a = this._a;
      if (sql.startsWith("SELECT public_key, private_jwk FROM knowledge_agent")) return agent;
      if (sql.startsWith("SELECT jti FROM pool_tokens")) {
        const r = poolTokens.get(a[0]);
        return r && r.expires_at > a[1] ? { jti: r.jti } : null;
      }
      if (sql.startsWith("SELECT state FROM pool_consumers")) {
        return poolConsumers.get(`${a[0]} ${a[1]}`) || null;
      }
      if (sql.startsWith("SELECT COUNT(*) AS n FROM knowledge_inbox")) {
        let n = 0;
        for (const r of inbox.values()) if (r.owner_id === a[0] && r.state === "new") n++;
        return { n };
      }
      if (sql.startsWith("SELECT envelope_json FROM knowledge_inbox")) {
        const r = inbox.get(a[0]);
        return r && r.owner_id === a[1] ? { envelope_json: r.envelope_json } : null;
      }
      return null;
    },
    async all() {
      const a = this._a;
      if (sql.includes("FROM knowledge_inbox k LEFT JOIN pool_tokens p")) {
        const rows = [...inbox.values()]
          .filter((r) => r.owner_id === a[0])
          .sort((x, y) => y.created_at - x.created_at)
          .slice(0, a[1])
          .map((r) => ({
            id: r.id,
            token_jti: r.token_jti,
            state: r.state,
            created_at: r.created_at,
            imported_at: r.imported_at,
            size: String(r.envelope_json).length,
            label: poolTokens.get(r.token_jti)?.label ?? null,
          }));
        return { results: rows };
      }
      return { results: [] };
    },
  });

  return {
    prepare: stmt,
    async batch(stmts) { for (const s of stmts) await s.run?.(); return []; },
    _tables: { inbox, poolTokens, poolConsumers, get agent() { return agent; } },
  };
}

const envWith = (db) => ({ SESSION_SECRET: SECRET, DB: db });

/** Mint a live pool token + meter row for pool "owner-1", sub "bob". */
async function liveToken(db, env, { pool = "owner-1", sub = "bob", jti = "j-1" } = {}) {
  const t = nowS();
  db._tables.poolTokens.set(jti, { jti, pool_id: pool, user_id: pool, quota: 0, used: 0, expires_at: t + 3600, label: "team ws" });
  return mintPoolToken(env, { jti, pool, sub, iat: t, exp: t + 3600 });
}

async function sealedEnvelope(db, { owner = "owner-1" } = {}) {
  const agent = await ensureKnowledgeAgent(db);
  const bundle = buildKnowledgeBundle({
    owner,
    workspace: "ws-alpha",
    from: "bob",
    conclusions: [buildConclusion({ query: "Q?", reply: "A.", contextSummary: "ctx" })],
  });
  return sealKnowledge(bundle, agent.publicKey);
}

const submitReq = (token, envelope) =>
  new Request("https://x/api/knowledge/submit", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ envelope }),
  });

const ownerReq = (path, opts = {}) => new Request("https://x" + path, opts);
const identity = (id) => ({ id, email: id + "@x", name: id });

// ── the agent keypair ────────────────────────────────────────────────────────

test("ensureKnowledgeAgent generates once, then always returns the same key", async () => {
  const db = fakeDb();
  const a = await ensureKnowledgeAgent(db);
  const b = await ensureKnowledgeAgent(db);
  assert.ok(a.publicKey && a.privateJwk);
  assert.equal(a.publicKey, b.publicKey);
});

test("handleKnowledgeKey serves the public half + kid, never the private key", async () => {
  const db = fakeDb();
  const res = await handleKnowledgeKey(envWith(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.publicKey);
  assert.equal(typeof body.kid, "string");
  assert.equal(body.kid.length, 8);
  assert.equal("privateJwk" in body, false);
  assert.equal("private_jwk" in body, false);
});

// ── submit ───────────────────────────────────────────────────────────────────

test("submit: no/bad token → 403; valid token stores CIPHERTEXT routed to the pool owner", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const envlp = await sealedEnvelope(db);
  const noTok = await handleKnowledgeSubmit(submitReq("", envlp), env, log);
  assert.equal(noTok.status, 403);

  const token = await liveToken(db, env);
  const res = await handleKnowledgeSubmit(submitReq(token, envlp), env, log);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const row = db._tables.inbox.get(id);
  assert.equal(row.owner_id, "owner-1");
  // What rests in the inbox is the sealed envelope — no conclusion text.
  assert.ok(!String(row.envelope_json).includes("Q?"));
  assert.ok(validateKnowledgeEnvelope(JSON.parse(row.envelope_json)));
});

test("submit: a revoked token (meter row gone) and a blocked consumer are refused", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const envlp = await sealedEnvelope(db);
  const token = await liveToken(db, env, { jti: "j-rev" });
  db._tables.poolTokens.delete("j-rev");
  assert.equal((await handleKnowledgeSubmit(submitReq(token, envlp), env, log)).status, 403);

  const token2 = await liveToken(db, env, { jti: "j-blk", sub: "mallory" });
  db._tables.poolConsumers.set("owner-1 mallory", { state: "blocked" });
  assert.equal((await handleKnowledgeSubmit(submitReq(token2, envlp), env, log)).status, 403);
});

test("submit: malformed envelopes are rejected, backlog cap returns 429", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const token = await liveToken(db, env);
  const bad = await handleKnowledgeSubmit(submitReq(token, { kind: "nope" }), env, log);
  assert.equal(bad.status, 400);
  // Fill the backlog artificially.
  for (let i = 0; i < 200; i++) {
    db._tables.inbox.set("f" + i, { id: "f" + i, owner_id: "owner-1", token_jti: "j-1", envelope_json: "{}", state: "new", created_at: i, imported_at: null });
  }
  const full = await handleKnowledgeSubmit(submitReq(token, await sealedEnvelope(db)), env, log);
  assert.equal(full.status, 429);
  assert.equal((await full.json()).code, "inbox_full");
});

// ── the owner surface ────────────────────────────────────────────────────────

test("owner: list shows metadata only; import decrypts, marks imported, returns the bundle", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const token = await liveToken(db, env);
  const sub = await handleKnowledgeSubmit(submitReq(token, await sealedEnvelope(db)), env, log);
  const { id } = await sub.json();

  const list = await handleKnowledgeApi(ownerReq("/api/knowledge"), env, new URL("https://x/api/knowledge"), log, identity("owner-1"));
  const { entries } = await list.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "new");
  assert.equal(entries[0].tokenLabel, "team ws");
  assert.equal("envelope" in entries[0], false);

  const imp = await handleKnowledgeApi(
    ownerReq("/api/knowledge/import", { method: "POST", body: JSON.stringify({ id }) }),
    env,
    new URL("https://x/api/knowledge/import"),
    log,
    identity("owner-1"),
  );
  assert.equal(imp.status, 200);
  const { bundle } = await imp.json();
  assert.equal(bundle.workspace, "ws-alpha");
  assert.equal(bundle.conclusions[0].query, "Q?");
  assert.equal(db._tables.inbox.get(id).state, "imported");
});

test("owner scoping: a foreign owner sees an empty list and cannot import or delete", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const token = await liveToken(db, env);
  const sub = await handleKnowledgeSubmit(submitReq(token, await sealedEnvelope(db)), env, log);
  const { id } = await sub.json();

  const list = await handleKnowledgeApi(ownerReq("/api/knowledge"), env, new URL("https://x/api/knowledge"), log, identity("intruder"));
  assert.equal((await list.json()).entries.length, 0);
  const imp = await handleKnowledgeApi(
    ownerReq("/api/knowledge/import", { method: "POST", body: JSON.stringify({ id }) }),
    env,
    new URL("https://x/api/knowledge/import"),
    log,
    identity("intruder"),
  );
  assert.equal(imp.status, 404);
  const del = await handleKnowledgeApi(
    ownerReq("/api/knowledge/" + id, { method: "DELETE" }),
    env,
    new URL("https://x/api/knowledge/" + id),
    log,
    identity("intruder"),
  );
  assert.equal((await del.json()).ok, false);
  assert.ok(db._tables.inbox.has(id));
});

test("open (upload route): decrypts only for the addressed owner", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const envlp = await sealedEnvelope(db, { owner: "owner-1" });
  const openFor = (who) =>
    handleKnowledgeApi(
      ownerReq("/api/knowledge/open", { method: "POST", body: JSON.stringify({ envelope: envlp }) }),
      env,
      new URL("https://x/api/knowledge/open"),
      log,
      identity(who),
    );
  const wrong = await openFor("bystander");
  assert.equal(wrong.status, 403);
  const right = await openFor("owner-1");
  assert.equal(right.status, 200);
  assert.equal((await right.json()).bundle.conclusions.length, 1);
});

// ── posture pin ──────────────────────────────────────────────────────────────
// knowledge.js stores/relays CIPHERTEXT and touches only its own tables plus
// the pool authority — it must never import a data-bearing module.
test("knowledge.js imports stay inside the inbox-only allowlist", () => {
  const src = readFileSync(new URL("./knowledge.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import[^"']+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  const allowed = new Set(["./db.js", "./http.js", "./pool-token.js", "./pool.js", "../public/js/knowledge-core.js"]);
  for (const spec of imports) {
    assert.ok(allowed.has(spec), `unexpected import in knowledge.js: ${spec}`);
  }
});
