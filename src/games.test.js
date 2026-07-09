// Tests for the games registry / dispatch seam (src/games.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { GAMES, handleGames } from "./games.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const identity = { id: "u1", user: { id: 1 } };

async function req(method, path, env = {}) {
  const url = new URL(`https://x.se${path}`);
  const res = await handleGames(new Request(url, { method }), env, url, log, identity);
  return { status: res.status, body: await res.json() };
}

test("every registered game is well-formed", () => {
  assert.ok(GAMES.length >= 1);
  const ids = new Set();
  for (const g of GAMES) {
    assert.match(g.id, /^[a-z0-9-]+$/, `${g.id} is URL-safe`);
    assert.ok(!ids.has(g.id), `${g.id} unique`);
    ids.add(g.id);
    for (const k of ["name", "emoji", "tagline", "description", "path", "requires"]) {
      assert.equal(typeof g[k], "string", `${g.id}.${k}`);
      assert.ok(g[k].length, `${g.id}.${k} non-empty`);
    }
    assert.equal(g.path, `/games/${g.id}/`, `${g.id} page path follows the convention`);
    assert.equal(typeof g.available, "function", `${g.id}.available`);
    assert.equal(typeof g.handle, "function", `${g.id}.handle`);
  }
});

test("GET /api/games lists the shelf with availability, never handlers", async () => {
  const r = await req("GET", "/api/games", { DB: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.games.length, GAMES.length);
  const tokemon = r.body.games.find((g) => g.id === "tokemon");
  assert.ok(tokemon);
  assert.equal(tokemon.available, true);
  assert.equal(tokemon.handle, undefined, "handler not serialized");
  // Without D1 the game reports unavailable (shelf shows it disabled).
  const r2 = await req("GET", "/api/games", {});
  assert.equal(r2.body.games.find((g) => g.id === "tokemon").available, false);
});

test("non-GET on the list and unknown game ids are rejected", async () => {
  assert.equal((await req("POST", "/api/games")).status, 405);
  assert.equal((await req("GET", "/api/games/")).status, 200); // trailing slash = the list
  assert.equal((await req("GET", "/api/games/nope")).status, 404);
  assert.equal((await req("POST", "/api/games/nope/state")).status, 404);
});

test("dispatch strips the prefix and passes the game's subpath", async () => {
  const seen = [];
  const stub = {
    id: "stub",
    name: "Stub",
    emoji: "🧪",
    tagline: "t",
    description: "d",
    path: "/games/stub/",
    requires: "nothing",
    available: () => true,
    handle: (request, env, url, lg, id, subpath) => {
      seen.push(subpath);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
  GAMES.push(stub);
  try {
    const r = await req("GET", "/api/games/stub/deep/sub/path?x=1");
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ["deep/sub/path"]);
  } finally {
    GAMES.pop();
  }
});

test("an unavailable game still answers through its own handler (503, not a crash)", async () => {
  // Tokemon without D1: the registry dispatches, the game degrades itself.
  const r = await req("GET", "/api/games/tokemon/state", {});
  assert.equal(r.status, 503);
  assert.match(r.body.error, /database/i);
});
