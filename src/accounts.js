// User accounts, invitations, and access requests (all D1-backed).
//
// Passwords are PBKDF2-SHA-256 (150k iterations, per-user random salt) via
// WebCrypto — bcrypt/argon aren't available in Workers without WASM, and
// PBKDF2 at this cost is fine for an invite-only site. Google sign-in will
// later slot in beside this (accounts are keyed by email).

import { getDb } from "./db.js";

const PBKDF2_ITERATIONS = 150_000;

export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  // Pragmatic shape check — the invite flow is the real verification.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash: hex(bits), salt: hex(salt.buffer ?? salt) };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- users -----------------------------------------------------------------

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

// Returns the user on success, null on bad credentials / disabled account.
export async function verifyUserLogin(env, email, password) {
  const user = await getUserByEmail(env, email);
  if (!user || user.status !== "active" || !user.pass_hash || !user.pass_salt) return null;
  const { hash } = await hashPassword(password, user.pass_salt);
  return timingSafeEqualHex(hash, user.pass_hash) ? user : null;
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

export async function deleteUser(env, id) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  await db.prepare("DELETE FROM usage_events WHERE user_id = ?").bind(String(id)).run();
}

// ---- invites ---------------------------------------------------------------

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createInvite(env, { email, role, expiryDays, createdBy }) {
  const db = await getDb(env);
  const e = normalizeEmail(email);
  if (!db) throw new Error("Database not configured.");
  if (!e) throw new Error("Invalid email address.");
  const existing = await getUserByEmail(env, e);
  if (existing) throw new Error("A user with that email already exists.");
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare("INSERT INTO invites (token, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(token, e, role === "admin" ? "admin" : "user", createdBy || null, now, now + expiryDays * 86_400_000)
    .run();
  return { token, email: e };
}

export async function listInvites(env) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare("SELECT token, email, role, created_at, expires_at, used_at FROM invites ORDER BY created_at DESC LIMIT 100")
    .all();
  return results || [];
}

export async function getValidInvite(env, token) {
  const db = await getDb(env);
  if (!db || !token) return null;
  const inv = await db.prepare("SELECT * FROM invites WHERE token = ?").bind(String(token)).first();
  if (!inv || inv.used_at || inv.expires_at < Date.now()) return null;
  return inv;
}

export async function revokeInvite(env, token) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db.prepare("DELETE FROM invites WHERE token = ? AND used_at IS NULL").bind(String(token)).run();
}

// Consumes the invite and creates the account. Returns the new user.
export async function acceptInvite(env, token, { name, password }) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const inv = await getValidInvite(env, token);
  if (!inv) throw new Error("This invitation is invalid, expired, or already used.");
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const { hash, salt } = await hashPassword(password);
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (email, name, role, status, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
      )
      .bind(inv.email, String(name || "").slice(0, 120) || null, inv.role, hash, salt, Date.now()),
    db.prepare("UPDATE invites SET used_at = ? WHERE token = ?").bind(Date.now(), inv.token),
    db
      .prepare("UPDATE access_requests SET status='approved', handled_at=? WHERE email=? AND status='pending'")
      .bind(Date.now(), inv.email),
  ]);
  return getUserByEmail(env, inv.email);
}

// ---- access requests --------------------------------------------------------

export async function createAccessRequest(env, email, message) {
  const db = await getDb(env);
  const e = normalizeEmail(email);
  if (!db) throw new Error("Requests are not available yet — the site owner has not enabled accounts.");
  if (!e) throw new Error("Please enter a valid email address.");
  if (await getUserByEmail(env, e)) {
    // Don't leak which emails exist: same reply either way.
    return;
  }
  const pending = await db
    .prepare("SELECT id FROM access_requests WHERE email = ? AND status = 'pending'")
    .bind(e)
    .first();
  if (pending) return; // idempotent
  await db
    .prepare("INSERT INTO access_requests (email, message, created_at) VALUES (?, ?, ?)")
    .bind(e, String(message || "").slice(0, 500) || null, Date.now())
    .run();
}

export async function listAccessRequests(env, status = "pending") {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare("SELECT * FROM access_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200")
    .bind(status)
    .all();
  return results || [];
}

// approve -> creates an invite for the email; deny -> just marks handled.
export async function handleAccessRequest(env, id, action, expiryDays) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const req = await db.prepare("SELECT * FROM access_requests WHERE id = ?").bind(id).first();
  if (!req || req.status !== "pending") throw new Error("Request not found or already handled.");
  if (action === "deny") {
    await db.prepare("UPDATE access_requests SET status='denied', handled_at=? WHERE id=?").bind(Date.now(), id).run();
    return null;
  }
  const invite = await createInvite(env, {
    email: req.email,
    role: "user",
    expiryDays,
    createdBy: "admin",
  });
  await db.prepare("UPDATE access_requests SET status='approved', handled_at=? WHERE id=?").bind(Date.now(), id).run();
  return invite;
}
