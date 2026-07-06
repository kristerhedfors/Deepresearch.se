// User accounts (D1-backed), provisioned exclusively by Google sign-in
// (src/google.js). No passwords are stored: Google proves the email, our
// signed session cookie carries the identity afterwards. Roles are
// user | admin — ADMIN_EMAIL is the ONLY path to admin (sole-admin
// policy; the admin API cannot change roles). Disabling a user takes
// effect on their next request.

import { getDb } from "./db.js";

export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  // Pragmatic shape check — Google's email_verified is the real gate.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export async function getUserById(env, id) {
  const db = await getDb(env);
  if (!db) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function getUserByEmail(env, email) {
  const db = await getDb(env);
  const e = normalizeEmail(email);
  if (!db || !e) return null;
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(e).first();
}

export async function listUsers(env) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare("SELECT id, email, name, role, status, quota_json, created_at FROM users ORDER BY created_at DESC")
    .all();
  return results || [];
}

// Count only — feeds the admin notification badge without pulling every
// user row (that's what /api/admin/overview's full list is for).
export async function countPendingUsers(env) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first();
  return row?.n || 0;
}

// First Google sign-in for an email creates the account. `sub` is Google's
// stable subject id — stored so the account stays pinned to that Google
// identity even if email ownership ever changes hands. `status` is
// "pending" when the approval gate is on (src/google.js decides).
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
  return getUserByEmail(env, email);
}

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
  if (typeof patch.name === "string") {
    sets.push("name = ?");
    binds.push(patch.name.slice(0, 120));
  }
  if (!sets.length) return getUserById(env, id);
  binds.push(id);
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return getUserById(env, id);
}

// One-time acceptance of the terms of use (the /terms page shown on first
// sign-in). Recorded as a timestamp so it doubles as an audit trail.
export async function acceptTerms(env, id) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare("UPDATE users SET terms_accepted_at = ? WHERE id = ? AND terms_accepted_at IS NULL")
    .bind(Date.now(), id)
    .run();
}

export async function deleteUser(env, id) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  await db.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(String(id)).run();
}
