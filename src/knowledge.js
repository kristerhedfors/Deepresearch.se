// @ts-check
// WORKSPACE KNOWLEDGE's server half — the sealed-conclusions INBOX behind
// "tap 👍 to pass a response along to the secure workspace"
// (docs/COMPUTE-SHARING.md §9b; the pure curation/seal core is
// public/js/knowledge-core.js).
//
// The flow this module serves: a workspace participant curates a conclusion
// in their Se/cure session, SEALS it to the site's IMPORT-AGENT public key
// (the drskn envelope — ECIES, knowledge-core.js), and hands the ciphertext
// over by ONE of two routes:
//   default   — POST /api/knowledge/submit (authorized by the workspace's
//               pool token; the envelope rests in knowledge_inbox as
//               ciphertext until the owner imports it);
//   migration — a downloaded .drskn file delivered out-of-band, which the
//               owner uploads in the Se/rver panel (POST /api/knowledge/open).
// The WORKSPACE OWNER (== the pool owner the token names) lists, imports
// (decrypts), and deletes entries in their Se/rver panel.
//
// PRIVACY POSTURE, stated plainly: the import agent's private key lives in D1
// (knowledge_agent), so THE SERVER CAN DECRYPT these envelopes — that is the
// deliberate design (owner ask: "encrypted with the server agent's public
// key") and it is disclosed in the data-flow notice every participant sees.
// What the seal buys: the conclusion rests as ciphertext (a leaked inbox dump
// is unreadable without the agent row), plaintext exists server-side only in
// the moment the OWNER asks for an import and is returned only to them, and
// nothing about a conclusion is ever logged (ids and sizes only). For
// knowledge the server must never be able to read, the DRCR/1 campaign path
// (client-held keys, docs/CROWD-RESEARCH.md) is the tool — pointed to in the
// docs, not duplicated here.
//
// Addressing: a sealed bundle carries `owner` — the pool id the sender's
// token names (== the workspace owner's account id). submit routes by the
// TOKEN's pool claim (authoritative); open (the upload route) decrypts and
// then REFUSES to return plaintext unless the bundle's owner IS the caller,
// so a stray .drskn file can't be read by any signed-in bystander.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { verifyPoolToken } from "./pool-token.js";
import { consumerBlocked } from "./pool.js";
import { generateKnowledgeKeypair, knowledgeKid, openKnowledge, validateKnowledgeEnvelope } from "../public/js/knowledge-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

// A sealed envelope is bounded like the pool request body: the inbox must not
// become an amplifier, and a conclusion bundle is prose, not an archive.
const ENVELOPE_MAX_CHARS = 400_000;
// Un-imported backlog cap per owner — a flooding token fills a bounded shelf.
const INBOX_NEW_MAX = 200;
const INBOX_LIST_MAX = 100;

const nowS = () => Math.floor(Date.now() / 1000);

// ── the import-agent keypair ─────────────────────────────────────────────────

/**
 * Read (or, on first use, generate) the site's import-agent keypair. The
 * INSERT is guarded so two isolates racing on first use converge on one row —
 * the loser's keypair is discarded and the stored one re-read.
 * @param {D1Database} db
 * @returns {Promise<{ publicKey: string, privateJwk: JsonWebKey } | null>}
 */
export async function ensureKnowledgeAgent(db) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await db
      .prepare("SELECT public_key, private_jwk FROM knowledge_agent WHERE id = 1")
      .first()
      .catch(() => null);
    if (row) {
      try {
        return { publicKey: String(row.public_key), privateJwk: JSON.parse(String(row.private_jwk)) };
      } catch {
        return null;
      }
    }
    const kp = await generateKnowledgeKeypair();
    await db
      .prepare("INSERT OR IGNORE INTO knowledge_agent (id, public_key, private_jwk, created_at) VALUES (1, ?1, ?2, ?3)")
      .bind(kp.publicKeyB64, JSON.stringify(kp.privateJwk), nowS())
      .run()
      .catch(() => {});
  }
  return null;
}

/**
 * GET /api/knowledge/key — PUBLIC. The import-agent public key a Se/cure
 * client seals conclusions to (plus its kid for display).
 * @param {Env} env
 */
export async function handleKnowledgeKey(env) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
  const agent = await ensureKnowledgeAgent(db);
  if (!agent) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
  return jsonResponse({ publicKey: agent.publicKey, kid: await knowledgeKid(agent.publicKey) });
}

// ── submit (public; the pool token is the authority) ─────────────────────────

/**
 * POST /api/knowledge/submit — PUBLIC. Body: { envelope } (a drskn sealed
 * envelope). Authorization: Bearer <pool token> — the same capability that
 * lets a workspace participant use shared compute routes their conclusions
 * to that pool's owner. The server stores CIPHERTEXT and learns nothing else.
 * @param {Request} request @param {Env} env @param {Logger} log
 */
export async function handleKnowledgeSubmit(request, env, log) {
  const auth = request.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  const claims = await verifyPoolToken(env, token);
  if (!claims) return jsonResponse({ error: "A valid pool token is required to pass conclusions along." }, 403);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
  // The token must still be live (its meter row is its revocation handle) and
  // the consumer not blocked — revoking access cuts this path too.
  const live = await db
    .prepare("SELECT jti FROM pool_tokens WHERE jti = ?1 AND expires_at > ?2")
    .bind(claims.jti, nowS())
    .first()
    .catch(() => null);
  if (!live) return jsonResponse({ error: "This pool token was revoked or expired." }, 403);
  const consumerKey = claims.sub && claims.sub !== claims.pool ? claims.sub : claims.jti;
  if (await consumerBlocked(db, claims.pool, consumerKey)) {
    return jsonResponse({ error: "Access to this pool was revoked." }, 403);
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > ENVELOPE_MAX_CHARS) return jsonResponse({ error: "Envelope too large." }, 413);
  let envelope = null;
  try { envelope = JSON.parse(raw)?.envelope; } catch { envelope = null; }
  if (!validateKnowledgeEnvelope(envelope)) {
    return jsonResponse({ error: "A sealed drskn envelope is required." }, 400);
  }

  const backlog = await db
    .prepare("SELECT COUNT(*) AS n FROM knowledge_inbox WHERE owner_id = ?1 AND state = 'new'")
    .bind(claims.pool)
    .first()
    .catch(() => null);
  if (backlog && Number(backlog.n) >= INBOX_NEW_MAX) {
    return jsonResponse({ error: "The owner's knowledge inbox is full — ask them to import or clear it.", code: "inbox_full" }, 429);
  }

  const id = crypto.randomUUID();
  const ok = await db
    .prepare(
      "INSERT INTO knowledge_inbox (id, owner_id, token_jti, envelope_json, state, created_at) VALUES (?1, ?2, ?3, ?4, 'new', ?5)",
    )
    .bind(id, claims.pool, claims.jti, JSON.stringify(envelope), nowS())
    .run()
    .then(() => true)
    .catch(() => false);
  if (!ok) return jsonResponse({ error: "Could not store the envelope." }, 503);
  log.info("knowledge.submitted", { owner: claims.pool, id, bytes: raw.length });
  return jsonResponse({ ok: true, id });
}

// ── the owner surface (authed) ───────────────────────────────────────────────

/**
 * The workspace owner's Se/rver-panel surface, dispatched under /api/knowledge:
 *   GET    /api/knowledge          → the caller's inbox (ciphertext metadata only)
 *   POST   /api/knowledge/import   → decrypt ONE entry (server-side, agent key),
 *                                    mark imported, return the plaintext bundle
 *   POST   /api/knowledge/open     → decrypt an UPLOADED .drskn envelope (the
 *                                    migration route); refused unless the
 *                                    bundle is addressed to the caller
 *   DELETE /api/knowledge/:id      → drop an entry (owner-scoped)
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log @param {Identity} identity
 */
export async function handleKnowledgeApi(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
  const sub = url.pathname.replace(/^\/api\/knowledge/, "");
  const method = request.method;
  const ownerId = String(identity.id);

  if (sub === "" && method === "GET") {
    const res = await db
      .prepare(
        "SELECT k.id, k.token_jti, k.state, k.created_at, k.imported_at, LENGTH(k.envelope_json) AS size, p.label " +
          "FROM knowledge_inbox k LEFT JOIN pool_tokens p ON p.jti = k.token_jti " +
          "WHERE k.owner_id = ?1 ORDER BY k.created_at DESC LIMIT ?2",
      )
      .bind(ownerId, INBOX_LIST_MAX)
      .all()
      .catch(() => ({ results: [] }));
    return jsonResponse({
      entries: (res.results || []).map((r) => ({
        id: String(r.id),
        tokenLabel: r.label ? String(r.label) : null,
        state: String(r.state),
        size: Number(r.size),
        createdAt: Number(r.created_at) * 1000,
        importedAt: r.imported_at ? Number(r.imported_at) * 1000 : null,
      })),
    });
  }

  if (sub === "/import" && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return jsonResponse({ error: "id is required." }, 400);
    const row = await db
      .prepare("SELECT envelope_json FROM knowledge_inbox WHERE id = ?1 AND owner_id = ?2")
      .bind(id, ownerId)
      .first()
      .catch(() => null);
    if (!row) return jsonResponse({ error: "No such entry." }, 404);
    const agent = await ensureKnowledgeAgent(db);
    if (!agent) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
    let envelope = null;
    try { envelope = JSON.parse(String(row.envelope_json)); } catch { envelope = null; }
    const bundle = await openKnowledge(envelope, agent.privateJwk);
    if (!bundle) return jsonResponse({ error: "This envelope cannot be opened (wrong key generation or corrupted)." }, 422);
    await db
      .prepare("UPDATE knowledge_inbox SET state = 'imported', imported_at = ?2 WHERE id = ?1")
      .bind(id, nowS())
      .run()
      .catch(() => {});
    log.info("knowledge.imported", { owner: ownerId, id });
    return jsonResponse({ id, bundle });
  }

  if (sub === "/open" && method === "POST") {
    const raw = await request.text().catch(() => "");
    if (raw.length > ENVELOPE_MAX_CHARS) return jsonResponse({ error: "Envelope too large." }, 413);
    let envelope = null;
    try { envelope = JSON.parse(raw)?.envelope; } catch { envelope = null; }
    if (!validateKnowledgeEnvelope(envelope)) return jsonResponse({ error: "A sealed drskn envelope is required." }, 400);
    const agent = await ensureKnowledgeAgent(db);
    if (!agent) return jsonResponse({ error: "Knowledge inbox is unavailable." }, 503);
    const bundle = await openKnowledge(envelope, agent.privateJwk);
    if (!bundle) return jsonResponse({ error: "This envelope cannot be opened (wrong key generation or corrupted)." }, 422);
    // Addressing gate: an uploaded blob opens ONLY for the owner it names.
    if (String(bundle.owner || "") !== ownerId) {
      log.warn("knowledge.open_refused", { caller: ownerId });
      return jsonResponse({ error: "This blob is not addressed to your account." }, 403);
    }
    log.info("knowledge.opened", { owner: ownerId, bytes: raw.length });
    return jsonResponse({ bundle });
  }

  const del = sub.match(/^\/([A-Za-z0-9-]+)$/);
  if (del && method === "DELETE") {
    const r = await db
      .prepare("DELETE FROM knowledge_inbox WHERE id = ?1 AND owner_id = ?2")
      .bind(del[1], ownerId)
      .run()
      .catch(() => null);
    return jsonResponse({ ok: !!r && Number(r?.meta?.changes || 0) >= 1 });
  }

  return jsonResponse({ error: "Not found." }, 404);
}
