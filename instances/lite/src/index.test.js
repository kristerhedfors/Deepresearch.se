// @ts-nocheck
// Integration smoke over the entrypoint routing + auth gate. Uses a mock ASSETS
// binding and real cookies; the pipeline itself is unit-tested separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { createSessionCookie } from "./auth.js";

const baseEnv = {
  SESSION_SECRET: "test-secret-abc123",
  SEARCH_ENABLED: "false",
  ASSETS: { fetch: async () => new Response("APP SHELL", { headers: { "content-type": "text/html" } }) },
};

const get = (path, headers = {}) => new Request(`https://lite.example${path}`, { headers });

test("no SESSION_SECRET => config-error page (fail closed)", async () => {
  const resp = await worker.fetch(get("/"), { ...baseEnv, SESSION_SECRET: "" }, {});
  assert.equal(resp.status, 503);
  assert.match(await resp.text(), /not configured/i);
});

test("anonymous visitor gets the login page, not the app", async () => {
  const resp = await worker.fetch(get("/"), baseEnv, {});
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /sign in|not configured/i);
  assert.ok(!html.includes("APP SHELL"), "app shell must be behind the gate");
});

test("anonymous API call is 401", async () => {
  const resp = await worker.fetch(new Request("https://lite.example/api/me"), baseEnv, {});
  assert.equal(resp.status, 401);
});

test("a valid session cookie reaches the app shell", async () => {
  const cookie = (await createSessionCookie(baseEnv, "42")).split(";")[0];
  const resp = await worker.fetch(get("/", { Cookie: cookie }), baseEnv, {});
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), "APP SHELL");
});

test("/api/me reports identity for a signed-in user", async () => {
  const cookie = (await createSessionCookie(baseEnv, "42")).split(";")[0];
  const resp = await worker.fetch(get("/api/me", { Cookie: cookie }), baseEnv, {});
  assert.equal(resp.status, 200);
  const me = await resp.json();
  assert.equal(me.uid, "42");
  assert.equal(me.search, false);
});

test("/logout clears the cookie", async () => {
  const resp = await worker.fetch(get("/logout"), baseEnv, {});
  assert.equal(resp.status, 303);
  assert.match(resp.headers.get("Set-Cookie") || "", /dr_session=;/);
});

test("/api/chat requires a non-empty messages array", async () => {
  const cookie = (await createSessionCookie(baseEnv, "42")).split(";")[0];
  const resp = await worker.fetch(
    new Request("https://lite.example/api/chat", {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }),
    baseEnv,
    {},
  );
  assert.equal(resp.status, 400);
});

test("/api/chat streams (SSE) for a signed-in user; fail-soft with no provider", async () => {
  const cookie = (await createSessionCookie(baseEnv, "42")).split(";")[0];
  const resp = await worker.fetch(
    new Request("https://lite.example/api/chat", {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello there" }] }),
    }),
    baseEnv,
    {},
  );
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") || "", /text\/event-stream/);
  const text = await resp.text();
  // Search is off and there's no real Berget token, so synthesis yields nothing
  // and the pipeline degrades to an honest message — but it ALWAYS terminates.
  assert.match(text, /data: \[DONE\]/);
  assert.match(text, /"type":"done"/);
});
