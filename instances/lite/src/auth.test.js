// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { identify, createSessionCookie, ADMIN_ID } from "./auth.js";

const env = { SESSION_SECRET: "test-secret-abc123", ADMIN_USER: "root", ADMIN_PASS: "hunter2" };

/** @param {string} cookie */
const reqWithCookie = (cookie) => new Request("https://x/", { headers: { Cookie: cookie } });
/** @param {string} user @param {string} pass */
const reqWithBasic = (user, pass) =>
  new Request("https://x/", { headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } });

test("session cookie round-trips through identify", async () => {
  const setCookie = await createSessionCookie(env, "42");
  const cookie = setCookie.split(";")[0]; // dr_session=u.42.<exp>.<sig>
  const id = await identify(reqWithCookie(cookie), env);
  assert.ok(id);
  assert.equal(id.uid, "42");
  assert.equal(id.isAdmin, false);
});

test("admin uid is admin", async () => {
  const cookie = (await createSessionCookie(env, ADMIN_ID)).split(";")[0];
  const id = await identify(reqWithCookie(cookie), env);
  assert.equal(id.isAdmin, true);
});

test("tampered signature is rejected", async () => {
  const cookie = (await createSessionCookie(env, "42")).split(";")[0];
  const tampered = cookie.slice(0, -4) + "0000";
  assert.equal(await identify(reqWithCookie(tampered), env), null);
});

test("forged uid (different uid, same sig) is rejected", async () => {
  const cookie = (await createSessionCookie(env, "42")).split(";")[0];
  const forged = cookie.replace("u.42.", "u.99.");
  assert.equal(await identify(reqWithCookie(forged), env), null);
});

test("expired cookie is rejected", async () => {
  // Hand-craft an expired cookie by signing a past exp.
  const past = Math.floor(Date.now() / 1000) - 10;
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", env.SESSION_SECRET).update(`7.${past}`).digest("hex");
  const cookie = `dr_session=u.7.${past}.${sig}`;
  assert.equal(await identify(reqWithCookie(cookie), env), null);
});

test("no SESSION_SECRET => cookie fails closed", async () => {
  const cookie = (await createSessionCookie(env, "42")).split(";")[0];
  assert.equal(await identify(reqWithCookie(cookie), {}), null);
});

test("break-glass Basic admin", async () => {
  const id = await identify(reqWithBasic("root", "hunter2"), env);
  assert.ok(id);
  assert.equal(id.uid, ADMIN_ID);
  assert.equal(id.isAdmin, true);
});

test("bad Basic returns null WITHOUT falling through to a cookie", async () => {
  const cookie = (await createSessionCookie(env, "42")).split(";")[0];
  const req = new Request("https://x/", {
    headers: {
      Authorization: "Basic " + Buffer.from("root:wrong").toString("base64"),
      Cookie: cookie,
    },
  });
  assert.equal(await identify(req, env), null);
});

test("anonymous is null", async () => {
  assert.equal(await identify(new Request("https://x/"), env), null);
});

test("refreshCookie flag set only past the half-life", async () => {
  const fresh = (await createSessionCookie(env, "42")).split(";")[0];
  const id = await identify(reqWithCookie(fresh), env);
  assert.equal(id.refreshCookie, false); // just minted, well before half-life
});
