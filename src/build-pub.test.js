import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSlugOk,
  handleBuildDelete,
  handleBuildGet,
  handleBuildManualPublish,
  newBuildSlug,
  publishBuild,
} from "./build-pub.js";

function mockBucket() {
  const store = new Map();
  return {
    _store: store,
    async get(key) {
      const v = store.get(key);
      return v
        ? {
            body: v.body,
            customMetadata: v.meta,
            json: async () => JSON.parse(v.body),
          }
        : null;
    },
    async put(key, body, opts) {
      store.set(key, { body, meta: opts?.customMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, customMetadata: v.meta }));
      return { objects, truncated: false };
    },
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

const appFiles = () => [
  { path: "index.html", content: "<!doctype html><h1>Hi</h1>" },
  { path: "css/app.css", content: "h1{color:teal}" },
];

test("buildSlugOk + newBuildSlug: minted slugs pass their own gate", () => {
  assert.equal(buildSlugOk("todo-app-a1b2"), true);
  assert.equal(buildSlugOk("Has.Dot"), false);
  assert.equal(buildSlugOk(""), false);
  const slug = newBuildSlug("My Todo App");
  assert.ok(buildSlugOk(slug));
  assert.match(slug, /^my-todo-app-[a-z0-9]{4}$/);
  assert.match(newBuildSlug(""), /^app-[a-z0-9]{4}$/);
});

test("publishBuild → serve round-trip, sandbox CSP on every response", async () => {
  const env = { STORAGE: mockBucket() };
  const pub = await publishBuild(env, log, { slug: null, title: "Todo App", files: appFiles(), userId: "u1" });
  assert.ok(!("error" in pub));
  assert.equal(pub.files, 2);
  assert.equal(pub.url, `/app/${pub.slug}/`);

  const root = await handleBuildGet(env, pub.slug, "");
  assert.equal(root.status, 200);
  assert.match(await root.text(), /<h1>Hi<\/h1>/);
  assert.match(root.headers.get("content-type"), /text\/html/);
  assert.match(root.headers.get("content-security-policy"), /^sandbox /);
  assert.doesNotMatch(root.headers.get("content-security-policy"), /allow-same-origin/);

  const css = await handleBuildGet(env, pub.slug, "css/app.css");
  assert.match(css.headers.get("content-type"), /text\/css/);

  // No trailing slash → 301 to the slash form so relative URLs resolve.
  const bare = await handleBuildGet(env, pub.slug, null);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("location"), `/app/${pub.slug}/`);

  assert.equal((await handleBuildGet(env, pub.slug, "../escape.html")).status, 404);
  assert.equal((await handleBuildGet(env, "no.slug", "")).status, 404);
  assert.equal((await handleBuildGet(env, "absent-slug", "")).status, 404);
  assert.equal((await handleBuildGet({}, pub.slug, "")).status, 503);
});

test("republish: same owner keeps the slug and prunes dropped files; foreign owner gets a fresh slug", async () => {
  const env = { STORAGE: mockBucket() };
  const first = await publishBuild(env, log, { slug: null, title: "App", files: appFiles(), userId: "u1" });
  const again = await publishBuild(env, log, {
    slug: first.slug,
    title: "App v2",
    files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    userId: "u1",
  });
  assert.equal(again.slug, first.slug);
  // The dropped css file no longer serves.
  assert.equal((await handleBuildGet(env, first.slug, "css/app.css")).status, 404);
  assert.match(await (await handleBuildGet(env, first.slug, "")).text(), /v2/);

  const foreign = await publishBuild(env, log, {
    slug: first.slug,
    title: "Hijack",
    files: appFiles(),
    userId: "u2",
  });
  assert.notEqual(foreign.slug, first.slug);
  // u1's build is untouched.
  assert.match(await (await handleBuildGet(env, first.slug, "")).text(), /v2/);
});

test("publishBuild rejects junk: no files, no index.html, missing storage", async () => {
  const env = { STORAGE: mockBucket() };
  assert.match((await publishBuild(env, log, { title: "x", files: [], userId: "u" })).error, /Nothing publishable/);
  assert.match(
    (await publishBuild(env, log, { title: "x", files: [{ path: "a.js", content: "1" }], userId: "u" })).error,
    /index\.html/,
  );
  assert.match(
    (await publishBuild(env, log, { title: "x", files: [{ path: "../x.html", content: "1" }], userId: "u" })).error,
    /Nothing publishable/,
  );
  assert.match((await publishBuild({}, log, { title: "x", files: appFiles(), userId: "u" })).error, /not configured/);
});

test("admin delete removes every object under the slug", async () => {
  const env = { STORAGE: mockBucket() };
  const pub = await publishBuild(env, log, { slug: null, title: "App", files: appFiles(), userId: "u1" });
  const del = await handleBuildDelete(new Request("https://x", { method: "DELETE" }), env, log, pub.slug);
  assert.equal(del.status, 204);
  assert.equal(env.STORAGE._store.size, 0);
  assert.equal((await handleBuildGet(env, pub.slug, "")).status, 404);
  assert.equal(
    (await handleBuildDelete(new Request("https://x", { method: "DELETE" }), env, log, "No.Slug")).status,
    400,
  );
});

const adminIdentity = { id: "admin", role: "admin", email: null, name: "Admin", isSecretAdmin: true };

test("handleBuildManualPublish: admin bypass of the chat/tool loop, same caps + CSP as a pipeline build", async () => {
  const env = { STORAGE: mockBucket() };
  const put = new Request("https://x/api/build/sandbox-app", {
    method: "PUT",
    body: JSON.stringify({ title: "Sandbox App", files: appFiles() }),
  });
  const res = await handleBuildManualPublish(put, env, log, adminIdentity, "sandbox-app");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.slug, "sandbox-app");
  assert.equal(body.url, "/app/sandbox-app/");

  const root = await handleBuildGet(env, "sandbox-app", "");
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-security-policy"), /^sandbox /);
  assert.doesNotMatch(root.headers.get("content-security-policy"), /allow-same-origin/);

  // Re-PUT to the SAME slug (same admin identity) republishes in place.
  const put2 = new Request("https://x/api/build/sandbox-app", {
    method: "PUT",
    body: JSON.stringify({ title: "Sandbox App v2", files: [{ path: "index.html", content: "<h1>v2</h1>" }] }),
  });
  const res2 = await handleBuildManualPublish(put2, env, log, adminIdentity, "sandbox-app");
  assert.equal((await res2.json()).slug, "sandbox-app");
  assert.match(await (await handleBuildGet(env, "sandbox-app", "")).text(), /v2/);
});

test("handleBuildManualPublish: validation errors", async () => {
  const env = { STORAGE: mockBucket() };
  assert.equal(
    (
      await handleBuildManualPublish(
        new Request("https://x", { method: "PUT", body: "{}" }),
        env,
        log,
        adminIdentity,
        "Bad.Slug",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleBuildManualPublish(
        new Request("https://x", { method: "PUT", body: "not json" }),
        env,
        log,
        adminIdentity,
        "sandbox-app",
      )
    ).status,
    400,
  );
  const noFiles = await handleBuildManualPublish(
    new Request("https://x", { method: "PUT", body: JSON.stringify({ title: "x", files: [] }) }),
    env,
    log,
    adminIdentity,
    "sandbox-app",
  );
  assert.equal(noFiles.status, 400);
  assert.match((await noFiles.json()).error, /files must be/);
  // publishBuild's own rules still apply (defense in depth) — no index.html.
  const noIndex = await handleBuildManualPublish(
    new Request("https://x", { method: "PUT", body: JSON.stringify({ title: "x", files: [{ path: "a.js", content: "1" }] }) }),
    env,
    log,
    adminIdentity,
    "sandbox-app",
  );
  assert.equal(noIndex.status, 400);
  assert.match((await noIndex.json()).error, /index\.html/);
  assert.equal(
    (
      await handleBuildManualPublish(
        new Request("https://x", { method: "PUT", body: JSON.stringify({ title: "x", files: appFiles() }) }),
        {},
        log,
        adminIdentity,
        "sandbox-app",
      )
    ).status,
    503,
  );
});
