// Unit tests for the outrospection Worker façade (src/outrospect.js): the
// refresh-body validation, the cooldown arithmetic, storage round-tripping,
// and the two read endpoints. The lens registry / delta / merge logic itself
// is tested once, in the shared core (public/js/outrospect-core.test.js) —
// this file covers the parts that only exist on the server.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LENS_COOLDOWN_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  USER_RUNS_PER_HOUR,
  handleAdminOutrospect,
  handleOutrospectFeed,
  handleOutrospectRefresh,
  lensesOnCooldown,
  loadItems,
  projectItem,
  storeItems,
  validateRefreshBody,
} from "./outrospect.js";
import { OUTROSPECT_LENSES as CORE_LENSES, mergeFeed } from "../public/js/outrospect-core.js";

// ---------------------------------------------------------------------------
// The façade contract: ONE implementation, two faces. If these ever diverge,
// a scan and a live refresh could disagree about what a lens is.
// ---------------------------------------------------------------------------

test("the façade re-exports the core registry by identity, not by copy", () => {
  assert.equal(OUTROSPECT_LENSES, CORE_LENSES);
});

// ---------------------------------------------------------------------------
// Refresh-body validation
// ---------------------------------------------------------------------------

test("validateRefreshBody: an empty body means 'you pick the lens'", () => {
  assert.deepEqual(validateRefreshBody({}), { lens: null, known: [] });
  assert.deepEqual(validateRefreshBody(null), { lens: null, known: [] });
  assert.equal(validateRefreshBody({ lens: "auto" }).lens, null);
});

test("validateRefreshBody: a real lens is honoured, an invented one is rejected", () => {
  assert.equal(validateRefreshBody({ lens: LENS_IDS[1] }).lens, LENS_IDS[1]);
  assert.match(validateRefreshBody({ lens: "made-up" }).error, /Unknown lens/);
});

test("validateRefreshBody normalizes known keys and drops unusable ones", () => {
  const v = validateRefreshBody({
    known: ["http://www.example.com/a/", "javascript:alert(1)", "", null, "https://b.example/x?utm_source=q"],
  });
  assert.deepEqual(v.known, ["https://example.com/a", "https://b.example/x"]);
});

test("validateRefreshBody caps the known list rather than accepting any size", () => {
  const known = Array.from({ length: OUTROSPECT_CAPS.known + 1 }, (_, i) => `https://a.example/${i}`);
  assert.match(validateRefreshBody({ known }).error, /Too many known keys/);
});

// ---------------------------------------------------------------------------
// Cooldown arithmetic
// ---------------------------------------------------------------------------

test("lensesOnCooldown covers only runs inside the window", () => {
  const now = 1_800_000_000_000;
  const runs = [
    { lens: "edge-rag", ts: now - 1000 },
    { lens: "privacy-llm", ts: now - LENS_COOLDOWN_MS - 1 },
  ];
  const cooling = lensesOnCooldown(runs, now);
  assert.deepEqual(cooling, ["edge-rag"]);
});

test("lensesOnCooldown dedupes repeated runs of one lens", () => {
  const now = 1_800_000_000_000;
  const cooling = lensesOnCooldown(
    [{ lens: "edge-rag", ts: now - 1 }, { lens: "edge-rag", ts: now - 2 }],
    now,
  );
  assert.deepEqual(cooling, ["edge-rag"]);
});

test("lensesOnCooldown handles an empty/absent run log", () => {
  assert.deepEqual(lensesOnCooldown([], Date.now()), []);
  assert.deepEqual(lensesOnCooldown(null, Date.now()), []);
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test("projectItem turns a D1 row into a validated feed item", () => {
  const item = projectItem({
    id: 1,
    key: "https://a.example/x",
    lens: "edge-rag",
    title: "Headline",
    url: "https://a.example/x",
    teaser: null,
    source: null,
    first_seen: 1_800_000_000_000,
    query: null,
  });
  assert.equal(item.title, "Headline");
  assert.equal(item.source, "a.example", "a null source column is derived from the URL");
  assert.equal(item.teaser, "");
});

test("projectItem rejects a corrupt row instead of rendering it", () => {
  assert.equal(projectItem({ key: "nonsense", lens: "edge-rag", title: "T", url: "nonsense", first_seen: 1 }), null);
});

// ---------------------------------------------------------------------------
// A D1 fake, just rich enough for the two tables this module owns.
// ---------------------------------------------------------------------------

function fakeDb() {
  /** @type {any[]} */
  const items = [];
  /** @type {any[]} */
  const runs = [];
  let itemId = 0;
  let runId = 0;

  const stmt = (sql) => {
    /** @type {any[]} */
    let args = [];
    const api = {
      bind(...a) {
        args = a;
        return api;
      },
      async run() {
        if (/INSERT OR IGNORE INTO outrospect_items/i.test(sql)) {
          const [key, lens, title, url, teaser, source, first_seen, query] = args;
          // The UNIQUE(key) constraint is the point of the OR IGNORE.
          if (items.some((i) => i.key === key)) return { meta: { changes: 0 } };
          items.push({ id: ++itemId, key, lens, title, url, teaser, source, first_seen, query });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO outrospect_runs/i.test(sql)) {
          const [ts, user_id, lens, queries, found] = args;
          runs.push({ id: ++runId, ts, user_id, lens, queries, found });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async all() {
        if (/FROM outrospect_items/i.test(sql)) {
          let out = [...items];
          const since = args[0];
          out = out.filter((i) => i.first_seen > since);
          if (/lens = \?/i.test(sql)) out = out.filter((i) => i.lens === args[1]);
          out.sort((a, b) => b.first_seen - a.first_seen || b.id - a.id);
          return { results: out.slice(0, args[args.length - 1]) };
        }
        if (/FROM outrospect_runs/i.test(sql)) {
          let out = [...runs];
          if (/ts > \?/i.test(sql)) out = out.filter((r) => r.ts > args[0]);
          out.sort((a, b) => b.ts - a.ts || b.id - a.id);
          return { results: out };
        }
        return { results: [] };
      },
    };
    return api;
  };
  return { _items: items, _runs: runs, prepare: stmt, batch: async () => [] };
}

const envWith = (db, extra = {}) => /** @type {any} */ ({ DB: db, ...extra });
const log = /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {} });
const identity = /** @type {any} */ ({ id: "u-1", email: "u@example.com", role: "user" });

const item = (over = {}) => ({
  key: "https://a.example/x",
  lens: "edge-rag",
  title: "Headline",
  url: "https://a.example/x",
  teaser: "teaser",
  source: "a.example",
  first_seen: 1_800_000_000_000,
  query: "q",
  ...over,
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("storeItems writes each item once — a re-found article is ignored", async () => {
  const db = fakeDb();
  assert.equal(await storeItems(/** @type {any} */ (db), [item()]), 1);
  assert.equal(await storeItems(/** @type {any} */ (db), [item({ title: "Same article, later" })]), 0);
  assert.equal(db._items.length, 1);
  assert.equal(db._items[0].title, "Headline", "the first sighting's record stands");
});

test("loadItems round-trips, newest first, and filters by lens", async () => {
  const db = fakeDb();
  const base = 1_800_000_000_000;
  await storeItems(/** @type {any} */ (db), [
    item({ key: "https://a.example/1", url: "https://a.example/1", first_seen: base }),
    item({ key: "https://a.example/2", url: "https://a.example/2", first_seen: base + 1000 }),
    item({ key: "https://a.example/3", url: "https://a.example/3", lens: "privacy-llm", first_seen: base + 2000 }),
  ]);
  const all = await loadItems(/** @type {any} */ (db), {});
  assert.deepEqual(all.map((i) => i.url), [
    "https://a.example/3",
    "https://a.example/2",
    "https://a.example/1",
  ]);
  const one = await loadItems(/** @type {any} */ (db), { lens: "privacy-llm" });
  assert.equal(one.length, 1);
  const since = await loadItems(/** @type {any} */ (db), { since: base + 1000 });
  assert.equal(since.length, 1);
});

// ---------------------------------------------------------------------------
// GET /api/outrospect/feed
// ---------------------------------------------------------------------------

test("feed: no database → an empty live half, NOT an error (the page still renders)", async () => {
  const res = await handleOutrospectFeed(/** @type {any} */ ({}), new URL("https://x.test/api/outrospect/feed"));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.live, false);
  assert.deepEqual(json.items, []);
  assert.equal(json.lenses.length, LENS_IDS.length);
});

test("feed: returns stored items with a per-lens tally, and ?format=text renders", async () => {
  const db = fakeDb();
  await storeItems(/** @type {any} */ (db), [item()]);
  const env = envWith(db);
  const json = await (await handleOutrospectFeed(env, new URL("https://x.test/api/outrospect/feed"))).json();
  assert.equal(json.live, true);
  assert.equal(json.items.length, 1);
  assert.equal(json.tally["edge-rag"].total, 1);

  const text = await (
    await handleOutrospectFeed(env, new URL("https://x.test/api/outrospect/feed?format=text"))
  ).text();
  assert.match(text, /OUTROSPECTION FEED/);
  assert.match(text, /Headline/);
});

// ---------------------------------------------------------------------------
// POST /api/outrospect/refresh
// ---------------------------------------------------------------------------

const refreshReq = (body) =>
  new Request("https://x.test/api/outrospect/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("refresh: no database → 503, so the client can fall back to the committed feed", async () => {
  const res = await handleOutrospectRefresh(refreshReq({}), /** @type {any} */ ({}), log, identity);
  assert.equal(res.status, 503);
});

test("refresh: invalid JSON and unknown lenses are 400s", async () => {
  const env = envWith(fakeDb());
  const bad = new Request("https://x.test/api/outrospect/refresh", { method: "POST", body: "{not json" });
  assert.equal((await handleOutrospectRefresh(bad, env, log, identity)).status, 400);
  assert.equal((await handleOutrospectRefresh(refreshReq({ lens: "nope" }), env, log, identity)).status, 400);
});

// Invariant 2: helper phases fail soft. With no search backend configured at
// all, webSearch returns a failure string rather than throwing — a refresh
// must come back 200 with nothing new, never 500 the visitor's page load.
test("refresh: an unconfigured search backend degrades, it does not error", async () => {
  const db = fakeDb();
  const res = await handleOutrospectRefresh(refreshReq({}), envWith(db), log, identity);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.fresh, []);
  assert.equal(json.degraded, true);
  assert.ok(LENS_IDS.includes(json.lens), "it still reports which lens it tried");
  assert.equal(db._runs.length, 1, "the attempt is logged, so the cooldown holds");
});

test("refresh: the run log carries the lens and counts — never the reader's content", async () => {
  const db = fakeDb();
  await handleOutrospectRefresh(refreshReq({}), envWith(db), log, identity);
  const run = db._runs[0];
  assert.deepEqual(Object.keys(run).sort(), ["found", "id", "lens", "queries", "user_id", "ts"].sort());
  assert.equal(typeof run.queries, "number", "queries is a COUNT, not query text");
});

test("refresh: a lens searched moments ago is served from cooldown, not re-paid for", async () => {
  const db = fakeDb();
  const env = envWith(db);
  // First run picks and logs some lens.
  const first = await (await handleOutrospectRefresh(refreshReq({}), env, log, identity)).json();
  // Asking for that same lens explicitly now comes back cooled.
  const second = await (await handleOutrospectRefresh(refreshReq({ lens: first.lens }), env, log, identity)).json();
  assert.equal(second.cooled, true);
  assert.deepEqual(second.fresh, []);
  assert.equal(db._runs.length, 1, "a cooled request costs no run");
});

test("refresh: auto-pick walks to a DIFFERENT lens on the next visit", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const a = await (await handleOutrospectRefresh(refreshReq({}), env, log, identity)).json();
  const b = await (await handleOutrospectRefresh(refreshReq({}), env, log, identity)).json();
  assert.notEqual(a.lens, b.lens, "the stalest-lens pick must not sit on one lens");
});

// The hourly cap is the BACKSTOP behind the cooldown, not the everyday
// limiter: pressing the button repeatedly hits the per-lens cooldown first and
// costs nothing (the test above), so reaching the cap takes an hour of runs
// whose cooldowns have already expired. Seeding the run log is the only honest
// way to express that — a tight loop can never get there, which is the point.
/** @param {ReturnType<typeof fakeDb>} db @param {string} userId @param {number} n */
function seedRuns(db, userId, n, now = Date.now()) {
  for (let i = 0; i < n; i++) {
    db._runs.push({
      id: db._runs.length + 1,
      // Older than the lens cooldown, inside the hour — the state a user
      // reaches by refreshing steadily across an hour.
      ts: now - LENS_COOLDOWN_MS - 1000 * (i + 1),
      user_id: userId,
      lens: LENS_IDS[i % LENS_IDS.length],
      queries: 3,
      found: 0,
    });
  }
}

test("refresh: the per-user hourly limit returns 429 and says so", async () => {
  const db = fakeDb();
  seedRuns(db, "u-1", USER_RUNS_PER_HOUR);
  const res = await handleOutrospectRefresh(refreshReq({}), envWith(db), log, identity);
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.limited, true);
  assert.deepEqual(json.fresh, []);
});

test("refresh: one run short of the cap still goes through", async () => {
  const db = fakeDb();
  seedRuns(db, "u-1", USER_RUNS_PER_HOUR - 1);
  const res = await handleOutrospectRefresh(refreshReq({}), envWith(db), log, identity);
  assert.equal(res.status, 200);
});

test("refresh: one user's limit does not spend another user's", async () => {
  const db = fakeDb();
  seedRuns(db, "u-1", USER_RUNS_PER_HOUR);
  const other = /** @type {any} */ ({ id: "u-2", email: "b@example.com" });
  const res = await handleOutrospectRefresh(refreshReq({}), envWith(db), log, other);
  assert.notEqual(res.status, 429);
});

test("refresh: runs older than an hour no longer count against the cap", async () => {
  const db = fakeDb();
  const now = Date.now();
  for (let i = 0; i < USER_RUNS_PER_HOUR; i++) {
    db._runs.push({ id: i + 1, ts: now - 3600_000 - 1000, user_id: "u-1", lens: LENS_IDS[0], queries: 3, found: 0 });
  }
  const res = await handleOutrospectRefresh(refreshReq({}), envWith(db), log, identity);
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// GET /api/admin/outrospect
// ---------------------------------------------------------------------------

test("admin view: items + run log, and ?format=text renders both sections", async () => {
  const db = fakeDb();
  await storeItems(/** @type {any} */ (db), [item()]);
  const env = envWith(db);
  await handleOutrospectRefresh(refreshReq({}), env, log, identity);

  const json = await (await handleAdminOutrospect(env, new URL("https://x.test/api/admin/outrospect"))).json();
  assert.equal(json.items.length, 1);
  assert.equal(json.runs.length, 1);

  const text = await (
    await handleAdminOutrospect(env, new URL("https://x.test/api/admin/outrospect?format=text"))
  ).text();
  assert.match(text, /OUTROSPECTION — live feed/);
  assert.match(text, /RECENT REFRESH RUNS/);
});

test("admin view: no database → 503", async () => {
  const res = await handleAdminOutrospect(/** @type {any} */ ({}), new URL("https://x.test/api/admin/outrospect"));
  assert.equal(res.status, 503);
});

// A sanity check that the merge the client will run over BOTH halves behaves
// the same on the server's rows — the artifact and the live rows are the same
// shape by construction, and this is what proves it.
test("stored rows merge with artifact-shaped items without duplicating", async () => {
  const db = fakeDb();
  await storeItems(/** @type {any} */ (db), [item()]);
  const live = await loadItems(/** @type {any} */ (db), {});
  const artifact = [{ lens: "edge-rag", title: "Headline", url: "http://www.a.example/x/", first_seen: 1 }];
  assert.equal(mergeFeed([artifact, live]).length, 1);
});
