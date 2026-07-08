// Session-cookie HMAC: keyed ONLY by SESSION_SECRET — there is no
// admin-credential fallback. The security properties exercised here:
//   - a cookie's validity depends solely on SESSION_SECRET, never on
//     ADMIN_USER/ADMIN_PASS (so a captured cookie can't be brute-forced back
//     to the break-glass password, and rotating that password can't forge one);
//   - with no SESSION_SECRET there is no signing key at all, so nothing
//     verifies (the entrypoint serves a config-error page in that state);
//   - rotating SESSION_SECRET invalidates every existing cookie.
// These touch only the admin/HMAC path (no D1).
import test from "node:test";
import assert from "node:assert/strict";
import { createSessionCookie, identify } from "./auth.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const OTHER_SECRET = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const admin = { ADMIN_USER: "root", ADMIN_PASS: "weakpass" };
const withSecret = { ...admin, SESSION_SECRET: SECRET };

const cookieOf = (setCookie) => setCookie.split(";")[0];
const reqWith = (cookie) => new Request("https://x/", { headers: { Cookie: cookie } });

test("SESSION_SECRET-signed admin cookie verifies", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const id = await identify(reqWith(cookie), withSecret);
  assert.equal(id?.role, "admin");
});

test("cookie validity is decoupled from the admin password (survives ADMIN_PASS rotation)", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const rotated = { ...withSecret, ADMIN_PASS: "a-completely-different-password" };
  const id = await identify(reqWith(cookie), rotated);
  assert.equal(id?.role, "admin");
});

test("no admin-credential fallback: a cookie does NOT verify when SESSION_SECRET is unset", async () => {
  // Minted under SESSION_SECRET, then presented to a deployment that has the
  // admin creds but no SESSION_SECRET. With the fallback removed there is no
  // key to verify under, so it is rejected (rather than validating against an
  // admin-password-derived key, the old offline-brute-force exposure).
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  assert.equal(await identify(reqWith(cookie), admin), null);
});

test("rotating SESSION_SECRET invalidates existing cookies", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const rotated = { ...admin, SESSION_SECRET: OTHER_SECRET };
  assert.equal(await identify(reqWith(cookie), rotated), null);
});

test("tampered signature is rejected", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  const tampered = cookie.slice(0, -4) + "0000";
  assert.equal(await identify(reqWith(tampered), withSecret), null);
});

test("fails closed for the admin uid when the admin secrets are unset, even with SESSION_SECRET", async () => {
  const cookie = cookieOf(await createSessionCookie(withSecret, "admin"));
  assert.equal(await identify(reqWith(cookie), { SESSION_SECRET: SECRET }), null);
});
