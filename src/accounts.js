// @ts-check
// User accounts (D1-backed). Two ways a row appears: Google sign-in
// provisions one on first arrival (src/google.js), or an admin creates it
// ahead of time from /admin ("Add user" → createInvitedUser), keyed by
// email alone until its owner's first sign-in claims it
// (linkGoogleIdentity). No passwords are stored either way: Google proves
// the email, our signed session cookie carries the identity afterwards.
// Roles are user | admin — ADMIN_EMAIL is the ONLY path to admin
// (sole-admin policy; neither the admin API nor an invite can change or
// mint one). Disabling a user takes effect on their next request.

import { getDb } from "./db.js";

/** @typedef {import('./types.js').Env} Env */

/**
 * One `users` row (see src/db.js SCHEMA — settings_json/google_sub/
 * terms_accepted_at arrive via additive ALTERs, so they may be absent on
 * rows read before a migration ran).
 * @typedef {Object} User
 * @property {number} id
 * @property {string} email normalized (trimmed, lowercased)
 * @property {string | null} name
 * @property {string} role "user" | "admin"
 * @property {string} status "active" | "pending" | "disabled"
 * @property {string | null} [google_sub] Google's stable subject id
 * @property {string | null} [quota_json] per-user quota overrides (JSON)
 * @property {number | null} [terms_accepted_at] ms epoch of terms acceptance
 * @property {number | null} [quota_reset_at] usage-counting floor: only events
 *   at/after this ms epoch count toward quotas (admin "Reset quota" button;
 *   a future value = an uncapped grace window). Additive ALTER, may be absent.
 * @property {string | null} [settings_json] per-user settings (src/settings.js)
 * @property {number} created_at ms epoch
 */

/**
 * Trims, lowercases, and shape-checks an email. Pragmatic check only —
 * Google's email_verified is the real gate.
 * @param {any} email
 * @returns {string | null} the normalized email, or null when malformed
 */
export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

/**
 * @param {Env} env
 * @param {number} id
 * @returns {Promise<User | null>} null when unknown or no database
 */
export async function getUserById(env, id) {
  const db = await getDb(env);
  if (!db) return null;
  return /** @type {Promise<User | null>} */ (
    db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first()
  );
}

/**
 * @param {Env} env
 * @param {any} email normalized before lookup
 * @returns {Promise<User | null>} null when unknown, malformed, or no database
 */
export async function getUserByEmail(env, email) {
  const db = await getDb(env);
  const e = normalizeEmail(email);
  if (!db || !e) return null;
  return /** @type {Promise<User | null>} */ (
    db.prepare("SELECT * FROM users WHERE email = ?").bind(e).first()
  );
}

/**
 * Every user row (minus settings_json), newest first — the /admin user list.
 * @param {Env} env
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listUsers(env) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    // google_sub is reduced to a boolean rather than selected: the admin
    // list only needs to tell an admin-created invite (nobody has signed in
    // against it yet) from a live account — not the opaque Google subject id.
    .prepare(
      "SELECT id, email, name, role, status, quota_json, quota_reset_at, created_at," +
        " (google_sub IS NOT NULL) AS has_signed_in" +
        " FROM users ORDER BY created_at DESC",
    )
    .all();
  return results || [];
}

/**
 * Count only — feeds the admin notification badge without pulling every
 * user row (that's what /api/admin/overview's full list is for).
 * @param {Env} env
 * @returns {Promise<number>}
 */
export async function countPendingUsers(env) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = /** @type {{ n: number } | null} */ (
    await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first()
  );
  return row?.n || 0;
}

/**
 * First Google sign-in for an email creates the account. `sub` is Google's
 * stable subject id — stored so the account stays pinned to that Google
 * identity even if email ownership ever changes hands. `status` is
 * "pending" when the approval gate is on (src/google.js decides).
 * @param {Env} env
 * @param {{ email: string, name?: string, sub?: string, role?: string, status?: string }} fields
 * @returns {Promise<User>} the freshly inserted row
 */
export async function createUserFromGoogle(env, { email, name, sub, role, status }) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare(
      "INSERT INTO users (email, name, role, status, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      email,
      name?.slice(0, 120) || null,
      role === "admin" ? "admin" : "user",
      status === "pending" ? "pending" : "active",
      sub || null,
      Date.now(),
    )
    .run();
  // The INSERT above succeeded (or threw), so the row exists.
  return /** @type {Promise<User>} */ (getUserByEmail(env, email));
}

/**
 * Creates an account BEFORE its owner has ever signed in — the /admin
 * "Add user" form (POST /api/admin/users). The row is keyed by email with
 * no `google_sub`; the first Google sign-in for that address finds it and
 * claims it (linkGoogleIdentity), so the person keeps the id, quota, and
 * history the admin set up for them.
 *
 * Pre-approving is the whole point: an invited user defaults to "active"
 * and so never meets the approval gate. "pending" stays available for
 * staging an account without granting access yet.
 *
 * The role is ALWAYS "user". ADMIN_EMAIL is the only path to admin
 * (sole-admin policy) — this must no more be able to mint an admin than
 * `updateUser` is able to promote one.
 *
 * Nothing is emailed: the site has no outbound mail path, so the admin
 * shares the sign-in link themselves. The row IS the invitation.
 * @param {Env} env
 * @param {{ email: string, name?: string, status?: string }} fields email is
 *   expected normalized (the caller validates it via normalizeEmail)
 * @returns {Promise<User>} the freshly inserted row
 */
export async function createInvitedUser(env, { email, name, status }) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare(
      "INSERT INTO users (email, name, role, status, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      email,
      name?.slice(0, 120) || null,
      "user",
      status === "pending" ? "pending" : "active",
      null,
      Date.now(),
    )
    .run();
  return /** @type {Promise<User>} */ (getUserByEmail(env, email));
}

/**
 * Pins an account to a Google identity — used when a sign-in lands on a row
 * that has no `google_sub` yet (an admin-created invite, or a legacy
 * pre-Google row).
 *
 * `WHERE google_sub IS NULL` makes it fill blanks only: a row already
 * pinned to one Google subject can never be repointed at another, so this
 * cannot become an account-takeover path. The name is filled in from the
 * Google profile only when the admin didn't already supply one.
 * @param {Env} env
 * @param {number} id
 * @param {{ sub?: string, name?: string }} identity from the verified claims
 * @returns {Promise<User | null>} the fresh row (unchanged when sub is empty)
 */
export async function linkGoogleIdentity(env, id, { sub, name }) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  if (!sub) return getUserById(env, id);
  await db
    .prepare(
      "UPDATE users SET google_sub = ?, name = COALESCE(NULLIF(name, ''), ?) WHERE id = ? AND google_sub IS NULL",
    )
    .bind(sub, name?.slice(0, 120) || null, id)
    .run();
  return getUserById(env, id);
}

/**
 * Applies an allowlisted patch (role/status/quota_json/name — unknown keys
 * and invalid values are ignored, never written) and returns the fresh row.
 * @param {Env} env
 * @param {number} id
 * @param {any} patch untrusted admin request body
 * @returns {Promise<User | null>} null when the id doesn't exist
 */
export async function updateUser(env, id, patch) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const sets = [];
  const binds = [];
  if (patch.role === "user" || patch.role === "admin") {
    sets.push("role = ?");
    binds.push(patch.role);
  }
  if (patch.status === "active" || patch.status === "disabled") {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if ("quota_json" in patch) {
    sets.push("quota_json = ?");
    binds.push(patch.quota_json ? JSON.stringify(patch.quota_json) : null);
  }
  // Quota reset floor (admin "Reset quota"): a positive ms timestamp sets the
  // grace/reset; null clears it (usage counts normally again). Anything else
  // is ignored — never write a bogus value.
  if ("quota_reset_at" in patch) {
    const v = patch.quota_reset_at;
    if (v === null || (Number.isFinite(Number(v)) && Number(v) > 0)) {
      sets.push("quota_reset_at = ?");
      binds.push(v === null ? null : Math.round(Number(v)));
    }
  }
  if (typeof patch.name === "string") {
    sets.push("name = ?");
    binds.push(patch.name.slice(0, 120));
  }
  if (!sets.length) return getUserById(env, id);
  binds.push(id);
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return getUserById(env, id);
}

/**
 * One-time acceptance of the terms of use (the /terms page shown on first
 * sign-in). Recorded as a timestamp so it doubles as an audit trail; the
 * IS NULL guard keeps the first timestamp authoritative.
 * @param {Env} env
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function acceptTerms(env, id) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare("UPDATE users SET terms_accepted_at = ? WHERE id = ? AND terms_accepted_at IS NULL")
    .bind(Date.now(), id)
    .run();
}

/**
 * Deletes the account and its usage history (usage_events keys user_id as
 * TEXT, hence the String()).
 * @param {Env} env
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteUser(env, id) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  await db.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(String(id)).run();
}
