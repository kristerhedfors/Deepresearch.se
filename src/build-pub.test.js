import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSlugOk,
  handleBuildDelete,
  handleBuildGet,
  handleBuildManualPublish,
  newBuildSlug,
  publishBuild,
  replyLinksTo,
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

test("keepOwner (admin in-place republish): slug reused, ORIGINAL owner preserved", async () => {
  const env = { STORAGE: mockBucket() };
  const first = await publishBuild(env, log, { slug: null, title: "App", files: appFiles(), userId: "u1" });

  // The admin path (handleBuildManualPublish sets keepOwner) republishes the
  // user's build IN PLACE — same URL — instead of minting a fresh slug.
  const fixed = await publishBuild(env, log, {
    slug: first.slug,
    title: "App (fixed)",
    files: [{ path: "index.html", content: "<h1>fixed</h1>" }],
    userId: "admin",
    keepOwner: true,
  });
  assert.equal(fixed.slug, first.slug);
  assert.match(await (await handleBuildGet(env, first.slug, "")).text(), /fixed/);

  // …and the build still belongs to u1: the user's own next republish keeps
  // the slug (an admin fix must never wrest an app from its owner's chat).
  const usersOwn = await publishBuild(env, log, {
    slug: first.slug,
    title: "App v3",
    files: [{ path: "index.html", content: "<h1>v3</h1>" }],
    userId: "u1",
  });
  assert.equal(usersOwn.slug, first.slug);
  assert.match(await (await handleBuildGet(env, first.slug, "")).text(), /v3/);

  // keepOwner on a FRESH slug just publishes normally, owned by the caller.
  const freshByAdmin = await publishBuild(env, log, {
    slug: null,
    title: "Admin tool",
    files: appFiles(),
    userId: "admin",
    keepOwner: true,
  });
  const next = await publishBuild(env, log, {
    slug: freshByAdmin.slug,
    title: "Admin tool v2",
    files: [{ path: "index.html", content: "<h1>admin v2</h1>" }],
    userId: "admin",
  });
  assert.equal(next.slug, freshByAdmin.slug);
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

test("replyLinksTo: only a real markdown link to the url counts as clickable", () => {
  const url = "/app/simplest-llm-chat-r3vb/";
  // Bare / bold / prose mentions are NOT clickable — marked never autolinks a
  // relative /app/ path, so these must still get the "Try it live" append.
  assert.equal(replyLinksTo(`Live: **${url}**`, url), false);
  assert.equal(replyLinksTo(`Your app is at ${url} — enjoy.`, url), false);
  assert.equal(replyLinksTo(`See \`${url}\` for the build.`, url), false);
  // A genuine markdown link (any label) is clickable — don't double-append.
  assert.equal(replyLinksTo(`[Try it live](${url})`, url), true);
  assert.equal(replyLinksTo(`Open [the app](${url}) now`, url), true);
  assert.equal(replyLinksTo(`[x](${url} "title")`, url), true);
  // A link to a DIFFERENT url doesn't satisfy it.
  assert.equal(replyLinksTo(`[x](/app/other-slug/)`, url), false);
  // Empty inputs are safe.
  assert.equal(replyLinksTo("", url), false);
  assert.equal(replyLinksTo("text", ""), false);
});

// ---- the app kit (feedback #66) ---------------------------------------------
//
// The kit is INJECTED at the publish boundary rather than written by the model,
// so these tests are about the boundary: it arrives when a build asks for it,
// it does not when a build has no key input, and an unreadable kit never costs
// the user their app.

const KIT_PATH = "js/dr-provider-kit.js";
const KIT_SOURCE = "/* stub */ window.DRKit = {};";

const kitEnv = (assets) => ({ STORAGE: mockBucket(), ASSETS: assets });
const servingKit = () => ({
  fetch: async (req) =>
    new URL(req.url).pathname === "/app-kit/dr-provider-kit.js"
      ? new Response(KIT_SOURCE, { status: 200 })
      : new Response("nope", { status: 404 }),
});

const keyedApp = () => [
  {
    path: "index.html",
    content: `<!doctype html><script src="${KIT_PATH}"></script><script src="js/app.js"></script>`,
  },
  { path: "js/app.js", content: "const p = DRKit.mountModelPicker({});" },
];

test("app kit: a build that references it gets the real file, served", async () => {
  const env = kitEnv(servingKit());
  const pub = await publishBuild(env, log, { slug: null, title: "Keyed", files: keyedApp(), userId: "u1" });
  assert.ok(!("error" in pub));
  assert.equal(pub.files, 3, "the kit is published alongside the two authored files");
  assert.ok(pub.paths.includes(KIT_PATH));

  const kit = await handleBuildGet(env, pub.slug, KIT_PATH);
  assert.equal(kit.status, 200);
  assert.equal(await kit.text(), KIT_SOURCE);
  assert.match(kit.headers.get("content-type"), /javascript/);
});

test("app kit: a build with no key input is left exactly as it was", async () => {
  const env = kitEnv(servingKit());
  const pub = await publishBuild(env, log, { slug: null, title: "Plain", files: appFiles(), userId: "u1" });
  assert.equal(pub.files, 2);
  assert.ok(!pub.paths.includes(KIT_PATH));
});

test("app kit: the model's own version of the path is replaced by the shipped one", async () => {
  // The reserved path exists so an app runs the real kit rather than a
  // hallucinated approximation of its API.
  const env = kitEnv(servingKit());
  const files = [...keyedApp(), { path: KIT_PATH, content: "window.DRKit = { chat: null };" }];
  const pub = await publishBuild(env, log, { slug: null, title: "Overwrite", files, userId: "u1" });
  assert.equal(pub.files, 3);
  assert.equal(await (await handleBuildGet(env, pub.slug, KIT_PATH)).text(), KIT_SOURCE);
});

test("app kit: an unreadable kit still publishes the app (fail-soft)", async () => {
  const env = kitEnv({ fetch: async () => new Response("gone", { status: 404 }) });
  const pub = await publishBuild(env, log, { slug: null, title: "Keyed", files: keyedApp(), userId: "u1" });
  assert.ok(!("error" in pub), "publishing is never blocked by the kit");
  assert.equal(pub.files, 2);
  assert.equal((await handleBuildGet(env, pub.slug, "index.html")).status, 200);
});

test("app kit: no ASSETS binding at all is not an error either", async () => {
  const pub = await publishBuild({ STORAGE: mockBucket() }, log, {
    slug: null,
    title: "Keyed",
    files: keyedApp(),
    userId: "u1",
  });
  assert.equal(pub.files, 2);
});

// ---- hosted model access (capture #CAP-22, 2026-08-12) -----------------------
//
// A published agent used to greet its first visitor with "Error: you didn't
// provide an api key". A build can now ask to run on the site's own model
// access instead, and the grant that makes that possible is minted HERE, at the
// publish boundary, so every publish surface behaves the same way. What these
// pin: the config file ships and is served, the grant is reused across the
// republishes that keep an app's URL stable, and a build never fails to publish
// because no grant could be minted.

const CONFIG_PATH = "js/dr-app-config.js";

const hostedApp = () => [
  {
    path: "index.html",
    content:
      `<!doctype html><script src="${CONFIG_PATH}"></script>` +
      `<script src="${KIT_PATH}"></script><script src="js/app.js"></script>`,
  },
  { path: "js/app.js", content: "const llm = DRKit.hosted({});" },
];

// The smallest D1 that minting runs against — schema batch, config row, INSERT.
function hostedDb() {
  const inserts = [];
  return {
    _inserts: inserts,
    async batch(stmts) {
      for (const s of stmts) await s.run();
      return [];
    },
    prepare(sql) {
      return {
        _args: [],
        bind(...a) {
          this._args = a;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT INTO server_tokens")) inserts.push(this._args);
          return { success: true };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

const hostedEnv = (db = hostedDb()) => ({
  STORAGE: mockBucket(),
  ASSETS: servingKit(),
  DB: db,
  SESSION_SECRET: "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de",
  BERGET_API_TOKEN: "berget-test",
});

const configOf = async (env, slug) =>
  JSON.parse((await (await handleBuildGet(env, slug, CONFIG_PATH)).text()).match(/\{[\s\S]*\}/)[0]);

test("hosted: a build that asks for it ships a served config with a live grant", async () => {
  const db = hostedDb();
  const env = hostedEnv(db);
  const pub = await publishBuild(env, log, { slug: null, title: "Tutor", files: hostedApp(), userId: "u1" });
  assert.ok(!("error" in pub));
  assert.ok(pub.paths.includes(CONFIG_PATH), "the config is part of what shipped");
  assert.ok(pub.paths.includes(KIT_PATH), "and so is the kit it feeds");

  const res = await handleBuildGet(env, pub.slug, CONFIG_PATH);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);

  const cfg = await configOf(env, pub.slug);
  assert.ok(cfg.token, "a visitor needs no API key of their own");
  assert.ok(cfg.model, "and the app is pinned to a model");
  assert.equal(cfg.base, "/api/server-token/llm");
  assert.equal(db._inserts.length, 1, "exactly one grant for the app");
});

test("hosted: iterating on an app reuses its grant instead of minting another", async () => {
  const db = hostedDb();
  const env = hostedEnv(db);
  const first = await publishBuild(env, log, { slug: null, title: "Tutor", files: hostedApp(), userId: "u1" });
  const before = await configOf(env, first.slug);

  const again = await publishBuild(env, log, {
    slug: first.slug,
    title: "Tutor",
    files: [...hostedApp(), { path: "css/app.css", content: "body{color:teal}" }],
    userId: "u1",
  });
  assert.equal(again.slug, first.slug, "the URL is stable across iterations");
  assert.equal((await configOf(env, again.slug)).token, before.token);
  assert.equal(db._inserts.length, 1, "one app, one allowance");
});

test("hosted: the model's own version of the config path is replaced", async () => {
  // Reserved like the kit's path: an app must run the grant it was published
  // with, not a token a model invented.
  const env = hostedEnv();
  const files = [...hostedApp(), { path: CONFIG_PATH, content: "window.DR_APP_CONFIG={token:'fake'};" }];
  const pub = await publishBuild(env, log, { slug: null, title: "Tutor", files, userId: "u1" });
  const cfg = await configOf(env, pub.slug);
  assert.notEqual(cfg.token, "fake");
  assert.ok(cfg.token);
});

test("hosted: no D1 still publishes — with a config that says so (fail-soft)", async () => {
  const env = { STORAGE: mockBucket(), ASSETS: servingKit(), BERGET_API_TOKEN: "berget-test" };
  const pub = await publishBuild(env, log, { slug: null, title: "Tutor", files: hostedApp(), userId: "u1" });
  assert.ok(!("error" in pub), "a missing grant never costs the user their app");
  const cfg = await configOf(env, pub.slug);
  assert.equal(cfg.token, null);
  assert.equal(cfg.reason, "unavailable", "the app can tell its visitor what happened");
});

test("hosted: a bring-your-own-key build gets no config and no grant", async () => {
  const db = hostedDb();
  const env = hostedEnv(db);
  const pub = await publishBuild(env, log, { slug: null, title: "Keyed", files: keyedApp(), userId: "u1" });
  assert.ok(!pub.paths.includes(CONFIG_PATH));
  assert.equal(db._inserts.length, 0, "nothing is minted for an app that never asked");
});
