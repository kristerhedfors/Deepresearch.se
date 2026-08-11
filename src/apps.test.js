// The /api/apps management surface. The RULES it applies are the pure core's
// (public/js/apps-core.test.js covers those); what is tested here is the part
// that only exists once R2 and an identity are in play — which apps a caller
// can see, which ones they may write, and that an edit keeps the app's
// identity (slug, owner, createdAt) instead of forking or resetting it.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { handleApps } from "./apps.js";
import { publishBuild } from "./build-pub.js";
import worker from "./index.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { fakeAssets, fakeCtx, fakeEnv, fakeR2 } from "./test-helpers/env.js";

// In-memory R2, same shape as src/build-pub.test.js's (deliberately a copy —
// a test fixture imported across suites couples them). `size` and `text()`
// are the two additions this module needs: it reads files back to edit them.
function mockBucket() {
  const store = new Map();
  return {
    _store: store,
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: v.body,
        size: new TextEncoder().encode(v.body).length,
        customMetadata: v.meta,
        text: async () => v.body,
        json: async () => JSON.parse(v.body),
      };
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
        .map(([key, v]) => ({
          key,
          size: new TextEncoder().encode(v.body).length,
          customMetadata: v.meta,
        }));
      return { objects, truncated: false };
    },
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

const owner = { id: "u1", role: "user", email: null, name: "Owner" };
const stranger = { id: "u2", role: "user", email: null, name: "Stranger" };
const admin = { id: "adm", role: "admin", email: null, name: "Admin" };

const appFiles = () => [
  { path: "index.html", content: "<!doctype html><h1>Hi</h1>" },
  { path: "css/app.css", content: "h1{color:teal}" },
];

/** Drive the handler the way index.js does. */
async function call(env, identity, path, init = {}) {
  const url = new URL(`https://x${path}`);
  const request = new Request(url, init);
  return handleApps(request, env, url, log, identity);
}

const readMeta = async (env, slug) => JSON.parse(env.STORAGE._store.get(`build/${slug}/meta`).body);

/** A bucket holding one app per named owner. */
async function seed(pairs) {
  const env = { STORAGE: mockBucket() };
  /** @type {Record<string, string>} */
  const slugs = {};
  for (const [title, userId] of pairs) {
    const pub = await publishBuild(env, log, { slug: null, title, files: appFiles(), userId });
    slugs[title] = pub.slug;
  }
  return { env, slugs };
}

test("GET /api/apps lists only the caller's own apps", async () => {
  const { env, slugs } = await seed([
    ["Mine", "u1"],
    ["Theirs", "u2"],
  ]);
  const res = await call(env, owner, "/api/apps");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.apps.map((a) => a.slug),
    [slugs.Mine],
  );
  assert.deepEqual(body.me, { id: "u1", role: "user" });
  assert.equal(body.apps[0].title, "Mine");
  assert.equal(body.apps[0].owner, "u1");
  assert.equal(body.apps[0].files, 2);
  assert.equal(body.apps[0].url, `/app/${slugs.Mine}/`);
  // updatedAt falls back to createdAt for an app nobody has edited.
  assert.equal(body.apps[0].updatedAt, body.apps[0].createdAt);
});

test("?all=1: admin sees every account's apps; a non-admin still gets only their own", async () => {
  const { env, slugs } = await seed([
    ["Mine", "u1"],
    ["Theirs", "u2"],
  ]);
  const asAdmin = await (await call(env, admin, "/api/apps?all=1")).json();
  assert.deepEqual(new Set(asAdmin.apps.map((a) => a.slug)), new Set([slugs.Mine, slugs.Theirs]));

  // The parameter is a SCOPE, not a permission: a user sending it is not an
  // error, they just get their own list.
  const asUser = await (await call(env, owner, "/api/apps?all=1")).json();
  assert.deepEqual(
    asUser.apps.map((a) => a.slug),
    [slugs.Mine],
  );
  // An admin without ?all=1 sees only what they built themselves.
  assert.deepEqual((await (await call(env, admin, "/api/apps")).json()).apps, []);
});

test("?q= and ?sort= are the core's selection; ?format=text renders the board", async () => {
  const { env, slugs } = await seed([
    ["Alpha tool", "u1"],
    ["Beta tool", "u1"],
  ]);
  const filtered = await (await call(env, owner, "/api/apps?q=alpha")).json();
  assert.deepEqual(
    filtered.apps.map((a) => a.title),
    ["Alpha tool"],
  );
  const byName = await (await call(env, owner, "/api/apps?sort=name")).json();
  assert.deepEqual(
    byName.apps.map((a) => a.title),
    ["Alpha tool", "Beta tool"],
  );

  const text = await call(env, owner, "/api/apps?format=text");
  assert.match(text.headers.get("content-type"), /text\/plain/);
  const body = await text.text();
  assert.match(body, /2 published apps/);
  assert.ok(body.includes(slugs["Alpha tool"]));
  assert.ok(body.includes(`/app/${slugs["Beta tool"]}/`));
  assert.match(body, /2 files/);
});

test("a meta whose JSON is corrupt still LISTS — this is the only surface that can delete it", async () => {
  const { env, slugs } = await seed([["Broken", "u1"]]);
  const slug = slugs.Broken;
  // Keep the customMetadata publishBuild stamps (title + owner) and destroy the
  // body — the failure mode a partial write leaves behind.
  env.STORAGE._store.set(`build/${slug}/meta`, {
    body: "{not json",
    meta: { title: "Broken", owner: "u1" },
  });

  const list = await (await call(env, owner, "/api/apps")).json();
  assert.deepEqual(
    list.apps.map((a) => a.slug),
    [slug],
  );
  assert.equal(list.apps[0].title, "Broken");
  assert.equal(list.apps[0].createdAt, 0);

  // …and the owner can still act on it: the detail view falls back to the file
  // objects for the list the corrupt meta no longer carries.
  const detail = await (await call(env, owner, `/api/apps/${slug}`)).json();
  assert.equal(detail.can_manage, true);
  assert.deepEqual(new Set(detail.files.map((f) => f.path)), new Set(["index.html", "css/app.css"]));
  assert.ok(detail.files.every((f) => f.size > 0));

  // A rename repairs it rather than leaving it unreadable forever.
  const renamed = await call(env, owner, `/api/apps/${slug}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Repaired" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await readMeta(env, slug)).title, "Repaired");
});

test("GET /api/apps/:slug is readable by any signed-in user, but can_manage is ownership", async () => {
  const { env, slugs } = await seed([["Mine", "u1"]]);
  const slug = slugs.Mine;
  const mine = await (await call(env, owner, `/api/apps/${slug}`)).json();
  assert.equal(mine.can_manage, true);
  assert.equal(mine.app.slug, slug);
  assert.deepEqual(
    mine.files.map((f) => f.path).sort(),
    ["css/app.css", "index.html"],
  );
  assert.equal(mine.files.find((f) => f.path === "index.html").size, appFiles()[0].content.length);

  const theirs = await call(env, stranger, `/api/apps/${slug}`);
  assert.equal(theirs.status, 200);
  assert.equal((await theirs.json()).can_manage, false);
  // An admin manages anything.
  assert.equal((await (await call(env, admin, `/api/apps/${slug}`)).json()).can_manage, true);
});

test("PATCH rename: title changes, createdAt / owner / files do not", async () => {
  const { env, slugs } = await seed([["Old name", "u1"]]);
  const slug = slugs["Old name"];
  const before = await readMeta(env, slug);

  const res = await call(env, owner, `/api/apps/${slug}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "  New   name  " }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.app.title, "New name"); // normalized by the core
  assert.equal(body.app.slug, slug);

  const after = await readMeta(env, slug);
  assert.equal(after.title, "New name");
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.owner, "u1");
  assert.deepEqual(after.files, before.files);
  assert.ok(after.updatedAt >= after.createdAt);
  // The customMetadata pair is kept in publishBuild's shape (it is what makes a
  // corrupt meta recoverable).
  assert.deepEqual(env.STORAGE._store.get(`build/${slug}/meta`).meta, { title: "New name", owner: "u1" });
  // The files themselves were not rewritten — a rename touches the meta only.
  assert.equal(env.STORAGE._store.get(`build/${slug}/f/index.html`).body, appFiles()[0].content);

  // An empty / whitespace title is refused.
  for (const title of ["", "   ", null, 42]) {
    const bad = await call(env, owner, `/api/apps/${slug}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    assert.equal(bad.status, 400, `title ${JSON.stringify(title)} should be refused`);
  }
});

test("PUT a file: republished in place, createdAt preserved, updatedAt bumped", async () => {
  const { env, slugs } = await seed([["Editable", "u1"]]);
  const slug = slugs.Editable;
  // Age the app so a reset createdAt would be unmistakable.
  const aged = { ...(await readMeta(env, slug)), createdAt: 1_600_000_000_000 };
  env.STORAGE._store.set(`build/${slug}/meta`, {
    body: JSON.stringify(aged),
    meta: { title: aged.title, owner: "u1" },
  });

  const res = await call(env, owner, `/api/apps/${slug}/file`, {
    method: "PUT",
    body: JSON.stringify({ path: "index.html", content: "<!doctype html><h1>Edited</h1>" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.app.slug, slug, "an edit must never fork the app to a new URL");
  assert.equal(body.app.createdAt, 1_600_000_000_000);
  assert.ok(body.app.updatedAt > body.app.createdAt);
  assert.equal(body.app.files, 2);

  const after = await readMeta(env, slug);
  assert.equal(after.createdAt, 1_600_000_000_000);
  assert.equal(after.owner, "u1");
  assert.equal(after.title, "Editable");
  assert.equal(env.STORAGE._store.get(`build/${slug}/f/index.html`).body, "<!doctype html><h1>Edited</h1>");
  // The untouched file survived the whole-collection republish.
  assert.equal(env.STORAGE._store.get(`build/${slug}/f/css/app.css`).body, appFiles()[1].content);

  // A NEW path is created the same way.
  const added = await call(env, owner, `/api/apps/${slug}/file`, {
    method: "PUT",
    body: JSON.stringify({ path: "js/extra.js", content: "console.log(1)" }),
  });
  assert.equal((await added.json()).app.files, 3);
  assert.equal(env.STORAGE._store.get(`build/${slug}/f/js/extra.js`).body, "console.log(1)");

  // The core's rules still gate the write.
  const badPath = await call(env, owner, `/api/apps/${slug}/file`, {
    method: "PUT",
    body: JSON.stringify({ path: "../escape.html", content: "x" }),
  });
  assert.equal(badPath.status, 400);
  const badBody = await call(env, owner, `/api/apps/${slug}/file`, { method: "PUT", body: "not json" });
  assert.equal(badBody.status, 400);
});

test("GET/DELETE a file: read the source to edit it, and remove one (never index.html)", async () => {
  const { env, slugs } = await seed([["Editable", "u1"]]);
  const slug = slugs.Editable;

  const file = await call(env, owner, `/api/apps/${slug}/file?path=css/app.css`);
  assert.equal(file.status, 200);
  assert.deepEqual(await file.json(), { path: "css/app.css", content: appFiles()[1].content });
  assert.equal((await call(env, owner, `/api/apps/${slug}/file?path=nope.js`)).status, 404);
  assert.equal((await call(env, owner, `/api/apps/${slug}/file?path=../etc.html`)).status, 400);

  const removed = await call(env, owner, `/api/apps/${slug}/file?path=css/app.css`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).app.files, 1);
  assert.equal(env.STORAGE._store.has(`build/${slug}/f/css/app.css`), false);
  assert.equal(env.STORAGE._store.has(`build/${slug}/f/index.html`), true);

  // The entry point cannot be removed — the app would 404 at its own URL.
  const entry = await call(env, owner, `/api/apps/${slug}/file?path=index.html`, { method: "DELETE" });
  assert.equal(entry.status, 400);
  assert.match((await entry.json()).error, /index\.html/);
});

test("a non-owner is refused EVERY write, and the app is untouched", async () => {
  const { env, slugs } = await seed([["Mine", "u1"]]);
  const slug = slugs.Mine;
  const writes = [
    [`/api/apps/${slug}`, { method: "PATCH", body: JSON.stringify({ title: "Hijacked" }) }],
    [`/api/apps/${slug}`, { method: "DELETE" }],
    [`/api/apps/${slug}/file`, { method: "PUT", body: JSON.stringify({ path: "index.html", content: "<h1>x</h1>" }) }],
    [`/api/apps/${slug}/file?path=css/app.css`, { method: "DELETE" }],
    // The edit READ is a write surface too: it is the source of an app the
    // stranger has no business editing.
    [`/api/apps/${slug}/file?path=index.html`, {}],
  ];
  for (const [path, init] of writes) {
    const res = await call(env, stranger, path, init);
    assert.equal(res.status, 403, `${init.method || "GET"} ${path} should be 403`);
    assert.match((await res.json()).error, /another account/);
  }
  const meta = await readMeta(env, slug);
  assert.equal(meta.title, "Mine");
  assert.equal(env.STORAGE._store.get(`build/${slug}/f/index.html`).body, appFiles()[0].content);

  // The admin, by contrast, may fix someone else's app — and it stays theirs.
  const fixed = await call(env, admin, `/api/apps/${slug}/file`, {
    method: "PUT",
    body: JSON.stringify({ path: "index.html", content: "<h1>fixed</h1>" }),
  });
  assert.equal(fixed.status, 200);
  assert.equal((await readMeta(env, slug)).owner, "u1");
});

test("DELETE /api/apps/:slug removes every object under the slug", async () => {
  const { env, slugs } = await seed([
    ["Mine", "u1"],
    ["Theirs", "u2"],
  ]);
  const res = await call(env, owner, `/api/apps/${slugs.Mine}`, { method: "DELETE" });
  assert.equal(res.status, 204);
  assert.deepEqual(
    [...env.STORAGE._store.keys()].filter((k) => k.startsWith(`build/${slugs.Mine}/`)),
    [],
  );
  // The other account's app is untouched.
  assert.ok(env.STORAGE._store.has(`build/${slugs.Theirs}/meta`));
  assert.deepEqual((await (await call(env, owner, "/api/apps")).json()).apps, []);
});

test("unknown slugs, bad slugs, bad methods and a missing bucket", async () => {
  const { env, slugs } = await seed([["Mine", "u1"]]);
  assert.equal((await call(env, owner, "/api/apps/absent-slug")).status, 404);
  assert.equal((await call(env, owner, "/api/apps/absent-slug/file?path=index.html")).status, 404);
  assert.equal(
    (await call(env, owner, "/api/apps/absent-slug", { method: "DELETE" })).status,
    404,
    "a missing app is 404 before any ownership question",
  );
  assert.equal((await call(env, owner, "/api/apps/No.Slug")).status, 400);
  assert.equal((await call(env, owner, `/api/apps/${slugs.Mine}/nope`)).status, 404);
  assert.equal((await call(env, owner, "/api/apps", { method: "POST", body: "{}" })).status, 404);
  // No R2 at all: 503 with a sentence, matching build-pub.js.
  const none = await call({}, owner, "/api/apps");
  assert.equal(none.status, 503);
  assert.match((await none.json()).error, /not configured/);
});

test("the trailing-slash spellings reach the same handlers", async () => {
  const { env, slugs } = await seed([["Mine", "u1"]]);
  assert.equal((await call(env, owner, "/api/apps/")).status, 200);
  assert.equal((await call(env, owner, `/api/apps/${slugs.Mine}/`)).status, 200);
});

// ---------------------------------------------------------------------------
// The routes (src/index.js)
// ---------------------------------------------------------------------------
//
// What these pin is the ONE thing the handler tests above cannot see: that
// /apps and /api/apps are gated as SIGNED-IN rather than admin. The surface
// next to this one (/captures) 302s a non-admin away, and copying that gate
// here would have looked right and silently locked every user out of their own
// published apps.

describe("the /apps routes are signed-in, not admin", () => {
  const ORIGIN = "https://deepresearch.test";
  const PAGE = "<html>published apps</html>";
  const ADMIN = { ADMIN_USER: "root", ADMIN_PASS: "hunter2" };
  const adminHeader = { authorization: `Basic ${Buffer.from("root:hunter2").toString("base64")}` };
  // Break-glass acting as an ordinary user (src/run-as.js) — the cheapest
  // faithful way to be a signed-in NON-admin, as in src/captures-page.test.js.
  const asUser = { ...adminHeader, "x-run-as": "user" };

  const routeEnv = () =>
    fakeEnv({
      ...ADMIN,
      DB: fakeD1(),
      STORAGE: fakeR2(),
      // The fake assets binding resolves paths exactly — no index.html
      // resolution, no trailing-slash redirect — so both spellings are mapped.
      // What this can prove is that the route reaches the binding at all.
      ASSETS: fakeAssets({
        "/apps": PAGE,
        "/apps/": PAGE,
        "/apps/index.html": PAGE,
        "/index.html": "<html>app</html>",
        "/welcome/index.html": "<html>landing</html>",
        "/login.html": "<html>login</html>",
      }),
    });

  /** @param {string} path @param {Record<string,string>} [headers] @param {string} [method] */
  async function call(path, headers, method = "GET") {
    const ctx = fakeCtx();
    const response = await worker.fetch(new Request(ORIGIN + path, { headers, method }), routeEnv(), ctx);
    await ctx.settle();
    return response;
  }

  test("a signed-in non-admin is served the page on both spellings", async () => {
    for (const path of ["/apps", "/apps/"]) {
      const res = await call(path, asUser);
      assert.equal(res.status, 200, `${path} should serve the page to any signed-in user`);
      assert.equal(await res.text(), PAGE);
    }
  });

  test("a signed-out visitor never reaches it — the identity gate answers first", async () => {
    const res = await call("/apps");
    assert.equal(res.status, 401);
    assert.notEqual(await res.text(), PAGE);
  });

  test("GET /api/apps reaches the handler as an ordinary user", async () => {
    const res = await call("/api/apps", asUser);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.apps, []);
    assert.equal(body.me.role, "user");
  });

  test("/api/build/:slug stays ADMIN-only — this surface did not loosen it", async () => {
    // scripts/publish-app depends on that PUT, and the DELETE is the operator's.
    assert.equal((await call("/api/build/some-app", asUser, "DELETE")).status, 403);
    assert.equal((await call("/api/build/some-app", adminHeader, "DELETE")).status, 204);
  });
});
