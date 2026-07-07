// Session-cookie HMAC: keyed by SESSION_SECRET, not the admin password.
// These exercise only the admin/HMAC path (no D1) — the security property
// is that a cookie's validity no longer depends on ADMIN_USER/ADMIN_PASS
// once SESSION_SECRET is set, so cracking a cookie can't recover the
// break-glass credentials and rotating the password can't forge sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { createSessionCookie, identify } from "./auth.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const admin = { ADMIN_USER: "root", ADMIN_PASS: "weakpass" };
const withSecret = { ...admin, SESSION_SECRET: SECRET };

const cookieOf = (setCookie) => setCookie.split(";")[0];
const reqWith = (cookie) => new Request("https://x/", { headers: { Cookie: cookie } });

test("SESSION_SECRET-signed admin cookie verifies", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const id = await identify(reqWith(cookie), withSecret);
  assert.equal(id?.role, "admin");
});

test("legacy admin-cred cookie still verifies after SESSION_SECRET added (no forced logout)", async () => {
  const legacy = cookieOf(await createSessionCookie(admin, "admin"));
  const id = await identify(reqWith(legacy), withSecret);
  assert.equal(id?.role, "admin");
});

test("SESSION_SECRET cookie is decoupled from the admin password (survives ADMIN_PASS rotation)", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const rotated = { ...withSecret, ADMIN_PASS: "a-completely-different-password" };
  const id = await identify(reqWith(cookie), rotated);
  assert.equal(id?.role, "admin");
});

test("legacy cookie (no SESSION_SECRET) is still tied to ADMIN_PASS — rotation invalidates it", async () => {
  const legacy = cookieOf(await createSessionCookie(admin, "admin"));
  const rotated = { ...admin, ADMIN_PASS: "a-completely-different-password" };
  assert.equal(await identify(reqWith(legacy), rotated), null);
});

test("tampered signature is rejected", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const tampered = cookie.slice(0, -4) + "0000";
  assert.equal(await identify(reqWith(tampered), withSecret), null);
});

test("fails closed when admin secrets are unset, even with SESSION_SECRET", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  assert.equal(await identify(reqWith(cookie), { SESSION_SECRET: SECRET }), null);
});
