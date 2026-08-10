// The /captures/ page — the video-capture swipe deck, promoted out of /admin
// to its own door on 2026-08-10 (owner directive).
//
// Why this file exists: the deck used to be protected by nothing of its own.
// It was a <section> inside public/admin/index.html, so /admin's gate covered
// it for free. Moving it to its own path means the gate is now a route this
// repo has to keep — and the failure mode of getting it wrong is silent, since
// the page renders identically to an admin and to anyone else who can reach
// it (the API would 403 the fetches, but the surface, the prompts of recorded
// runs and the review UI would all be there).
//
// So the properties pinned here are the two the move introduced: the route is
// admin-gated exactly as /admin is, and neither the page nor its module graph
// is on the public (no-auth) allowlist.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "./index.js";
import { isPublicAsset } from "./assets.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { fakeEnv, fakeCtx, fakeAssets } from "./test-helpers/env.js";

const ORIGIN = "https://deepresearch.test";
const PAGE_BODY = "<html>capture reviews</html>";
const ADMIN = { ADMIN_USER: "root", ADMIN_PASS: "hunter2" };
const adminHeader = { authorization: `Basic ${Buffer.from("root:hunter2").toString("base64")}` };
// Break-glass acting as an ordinary user (src/run-as.js): role "user", no D1
// row needed. The cheapest faithful way to be a signed-in NON-admin.
const asUser = { ...adminHeader, "x-run-as": "user" };

const PUB = fileURLToPath(new URL("../public", import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(PUB, p), "utf8");
/**
 * Source with comments stripped. Every "this is gone" assertion below runs
 * against this: the files deliberately still SAY `captures-sec` and
 * `captures.js` in the comments that record where the panel went, and a
 * negative match over raw text would fail on the explanation rather than on
 * the code.
 * @param {string} src
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

function env() {
  return fakeEnv({
    ...ADMIN,
    DB: fakeD1(),
    ASSETS: fakeAssets({
      // The fake resolves paths EXACTLY — it has no index.html resolution and
      // no trailing-slash redirect, both of which the real Workers assets
      // binding performs (that is why the route matches the bare `/captures`
      // at all). So both spellings are mapped here: what these tests can
      // prove is that the route reaches the assets binding, not what the
      // binding then does with the path.
      "/captures": PAGE_BODY,
      "/captures/": PAGE_BODY,
      "/captures/index.html": PAGE_BODY,
      "/admin": "<html>admin</html>",
      "/admin/index.html": "<html>admin</html>",
      "/index.html": "<html>app</html>",
      "/welcome/index.html": "<html>landing</html>",
      "/login.html": "<html>login</html>",
    }),
  });
}

/**
 * @param {string} path
 * @param {Record<string,string>} [headers]
 */
async function call(path, headers) {
  const ctx = fakeCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { headers }), env(), ctx);
  await ctx.settle();
  return response;
}

describe("the /captures/ route is admin-gated", () => {
  test("an admin is served the page, on both spellings of the path", async () => {
    for (const path of ["/captures", "/captures/"]) {
      const resp = await call(path, adminHeader);
      assert.equal(resp.status, 200, `${path} should serve the page to an admin`);
      assert.equal(await resp.text(), PAGE_BODY);
    }
  });

  test("a signed-in non-admin gets EXACTLY what /admin gives them", async () => {
    // Not "some denial" — the same one. A different shape here (a 403 body, a
    // 404, a different destination) would tell a non-admin that a surface
    // called /captures exists, which /admin deliberately does not do.
    const admin = await call("/admin", asUser);
    for (const path of ["/captures", "/captures/"]) {
      const resp = await call(path, asUser);
      assert.equal(resp.status, admin.status, `${path} status must match /admin's`);
      assert.equal(resp.headers.get("location"), admin.headers.get("location"));
      assert.equal(resp.status, 302);
      assert.equal(resp.headers.get("location"), "/rver");
    }
  });

  test("a signed-out visitor never reaches it — the identity gate answers first", async () => {
    for (const path of ["/captures", "/captures/"]) {
      const resp = await call(path);
      assert.equal(resp.status, 401, `${path} must not be readable without an identity`);
      assert.notEqual(await resp.text(), PAGE_BODY);
    }
  });
});

describe("the page's module graph stays off the public allowlist", () => {
  // The recurring class this repo has paid for repeatedly is the opposite one
  // (a module MISSING from the allowlist takes /cure dark). This is the mirror:
  // an admin-only page whose assets get allowlisted "so they load" would serve
  // the whole review surface to anyone. Derived from the real files on disk so
  // a future import cannot quietly slip past a hand-written list.
  test("the page, its stylesheet and every module it reaches are non-public", async () => {
    const html = read("captures/index.html");
    const queue = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    queue.push(...[...html.matchAll(/<link[^>]+href="(\/css\/[^"]+)"/g)].map((m) => m[1]));
    assert.ok(queue.length >= 2, "expected the page to reference a module and a stylesheet");

    const checked = new Set(["/captures", "/captures/"]);
    while (queue.length) {
      const p = /** @type {string} */ (queue.shift());
      if (checked.has(p) || p.startsWith("http")) continue;
      checked.add(p);
      let src = "";
      if (p.endsWith(".js")) {
        src = readFileSync(join(PUB, p), "utf8");
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
          queue.push(posix.normalize(posix.join(posix.dirname(p), m[1])));
        }
      }
    }
    for (const p of checked) {
      assert.equal(
        isPublicAsset(new URL(ORIGIN + p), "GET"),
        false,
        `${p} is part of the admin-only /captures/ surface and must NOT be public`,
      );
    }
    // The move is only real if the deck's own modules are in that set.
    assert.ok(checked.has("/js/captures.js") && checked.has("/js/captures-core.js"));
    assert.ok(checked.has("/css/captures.css"));
  });
});

describe("the panel it used to be is fully gone", () => {
  // Three orphans are possible after a move like this: markup left behind, a
  // dead import, and a catalog entry for a panel that no longer exists. The
  // last one is the quiet one — src/panels.js's items ARE the admin sections,
  // so a stale id renders a vote widget for nothing and tells the attention
  // loop to go work a surface that isn't there.
  test("no admin markup or wiring still references the captures panel", async () => {
    assert.doesNotMatch(code(read("admin/index.html")), /captures-sec|data-panel="captures"/);
    assert.doesNotMatch(code(read("js/admin.js")), /loadCaptures|captures\.js/);
    const { PANEL_ITEMS } = await import("./panels.js");
    assert.equal(PANEL_ITEMS.find((i) => i.id === "captures"), undefined);
  });

  test("the deck drives a page now, not a panel", () => {
    const js = read("js/captures.js");
    assert.match(js, /export async function startCaptures\(/);
    assert.doesNotMatch(code(js), /captures-sec/);
    // The fold guard had to go with the fold; the two guards that stop a
    // stray arrow key from filing a capture must not have gone with it.
    assert.doesNotMatch(code(js), /classList\.contains\("open"\)/);
    assert.match(js, /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/);
    assert.match(js, /INPUT\|TEXTAREA\|SELECT/);
  });

  test("admins can find it: the account panel links it under the admin-only gate", async () => {
    const views = read("js/account-views.js");
    assert.match(views, /me\.role === "admin" \? '<a href="\/captures\/"/);
  });
});
