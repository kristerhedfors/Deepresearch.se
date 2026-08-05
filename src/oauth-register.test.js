// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Dynamic client registration (src/oauth-register.js).
//
// The endpoint exists because advertising CIMD alone left every client that
// does not implement it with nowhere to register — the ChatGPT connector
// failure. So the assertions here are about the two things that makes it safe
// rather than merely present: a registration cannot widen where a code may be
// sent, and an identifier it did not issue cannot be made to verify.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OAUTH_CLIENT_PREFIX,
  handleOAuthRegister,
  looksRegistered,
  mintClientId,
  resolveRegisteredClient,
} from "./oauth-register.js";

const env = { SESSION_SECRET: "test-secret-for-registration" };
const otherEnv = { SESSION_SECRET: "a-completely-different-secret" };

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT = "https://chatgpt.com/connector/oauth/01ABC";

/** A logger that records rather than prints, so a test can assert on it. */
function recorder() {
  const lines = [];
  const push = (level) => (event, data) => lines.push({ level, event, data });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function post(body, init = {}) {
  return new Request("https://deepresearch.se/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

// ---- the identifier ---------------------------------------------------------

test("a minted client_id round-trips its own registration", async () => {
  // The whole reason there is no client table: the registration travels IN the
  // identifier, so nothing accumulates per connection.
  const { clientId } = await mintClientId(env, { redirectUris: [CLAUDE], name: "Claude" });
  assert.ok(clientId.startsWith(`${OAUTH_CLIENT_PREFIX}.`));
  assert.equal(looksRegistered(clientId), true);

  const resolved = await resolveRegisteredClient(env, clientId);
  assert.deepEqual(resolved.redirectUris, [CLAUDE]);
  assert.equal(resolved.name, "Claude");
});

test("an identifier this server did not sign does not resolve", async () => {
  const { clientId } = await mintClientId(env, { redirectUris: [CLAUDE], name: "Claude" });
  // A different signing key is the same situation as a rotated one: the
  // identifier is refused rather than half-trusted.
  assert.equal(await resolveRegisteredClient(otherEnv, clientId), null);
  // A tampered payload invalidates the tag, so a client cannot edit its own
  // registered redirect URIs after the fact.
  const [, payload, sig] = clientId.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ ru: ["https://evil.test/cb"], nm: "Claude", iat: 1 }),
  ).toString("base64url");
  assert.equal(await resolveRegisteredClient(env, `${OAUTH_CLIENT_PREFIX}.${forgedPayload}.${sig}`), null);
  assert.equal(await resolveRegisteredClient(env, `${OAUTH_CLIENT_PREFIX}.${payload}.${"0".repeat(64)}`), null);
});

test("a CIMD client_id is not mistaken for a registration", () => {
  // The prefix is what tells the authorization endpoint which of the two
  // shapes it holds, before anything is fetched or verified.
  assert.equal(looksRegistered("https://claude.ai/.well-known/oauth-client"), false);
  assert.equal(looksRegistered(""), false);
  assert.equal(looksRegistered(undefined), false);
});

// ---- the endpoint -----------------------------------------------------------

test("a registration returns a public client with no secret", async () => {
  const res = await handleOAuthRegister(post({ redirect_uris: [CHATGPT], client_name: "ChatGPT" }), env, recorder());
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.token_endpoint_auth_method, "none");
  // A public client has no secret, and returning an empty one invites a client
  // to start sending it.
  assert.equal("client_secret" in body, false);
  assert.deepEqual(body.redirect_uris, [CHATGPT]);
  assert.equal(body.client_name, "ChatGPT");
  assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
  assert.ok(typeof body.client_id_issued_at === "number");

  // The identifier it handed back is one the authorization endpoint will accept.
  const resolved = await resolveRegisteredClient(env, body.client_id);
  assert.deepEqual(resolved.redirectUris, [CHATGPT]);
});

test("registering CANNOT widen where a code may be sent", async () => {
  // The load-bearing assertion. An unauthenticated registration endpoint that
  // accepted arbitrary redirects would be an open redirector with a signature
  // on it — the allowlist is what makes it safe to leave open.
  const log = recorder();
  const res = await handleOAuthRegister(
    post({ redirect_uris: ["https://evil.test/steal"], client_name: "Nice App" }),
    env,
    log,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_redirect_uri");

  // The refused string is LOGGED: an exact-match failure is invisible from the
  // outside, and a vendor that changed its callback shows up here as a line
  // naming the new URL.
  const refused = log.lines.find((l) => l.event === "oauth.register_redirect_refused");
  assert.equal(refused.data.redirect_uri, "https://evil.test/steal");
});

test("one bad redirect_uri refuses the whole registration", async () => {
  // Not "register the good ones and drop the rest": a client that believed it
  // registered a callback and silently did not fails later, at the redirect,
  // where the error is far less legible.
  const res = await handleOAuthRegister(
    post({ redirect_uris: [CLAUDE, "https://evil.test/cb"] }),
    env,
    recorder(),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_redirect_uri");
});

test("a missing or empty redirect_uris is a registration error, not a silent success", async () => {
  for (const body of [{}, { redirect_uris: [] }, { redirect_uris: "not-an-array" }]) {
    const res = await handleOAuthRegister(post(body), env, recorder());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_redirect_uri");
  }
});

test("a form-encoded body is refused with a reason that names the trap", async () => {
  // RFC 7591 is JSON where the token endpoint is form-encoded; the two do not
  // share a body parser, and an integrator who mixes them up gets a parse
  // failure with no clue unless the message says so.
  const res = await handleOAuthRegister(
    post("redirect_uris=" + encodeURIComponent(CLAUDE), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    env,
    recorder(),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_client_metadata");
  assert.match(body.error_description, /JSON/);
});

test("duplicate redirect_uris are collapsed and the count is bounded", async () => {
  const res = await handleOAuthRegister(post({ redirect_uris: [CLAUDE, CLAUDE] }), env, recorder());
  assert.deepEqual((await res.json()).redirect_uris, [CLAUDE]);

  const many = await handleOAuthRegister(
    post({ redirect_uris: Array.from({ length: 11 }, () => CLAUDE) }),
    env,
    recorder(),
  );
  assert.equal(many.status, 400);
});

test("OPTIONS answers the preflight and GET says how to call it", async () => {
  const pre = await handleOAuthRegister(
    new Request("https://deepresearch.se/oauth/register", { method: "OPTIONS" }),
    env,
    recorder(),
  );
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");

  const get = await handleOAuthRegister(
    new Request("https://deepresearch.se/oauth/register", { method: "GET" }),
    env,
    recorder(),
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
});
