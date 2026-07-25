import test from "node:test";
import assert from "node:assert/strict";
// The outrospection VIEW's pure half — the parts that decide what the reader
// is told and where a strategic note gets filed. The DOM half (renderItem,
// renderLensStrip, mount) is verified live; everything worth asserting without
// a browser lives here.
import {
  ARTIFACT_URL,
  FEED_URL,
  FEEDBACK_URL,
  REFRESH_URL,
  knownKeys,
  loadFeed,
  noteLens,
  refreshStatusLine,
  requestRefresh,
  submitStrategyNote,
  whenLabel,
} from "./outrospect-view.js";
import { lensById } from "./outrospect-core.js";
import { STRATEGY_PAGE_SUFFIX } from "./feedback-core.js";

test("the module imports cleanly with no DOM (it must not auto-mount in Node)", () => {
  assert.equal(typeof loadFeed, "function");
});

// ---------------------------------------------------------------------------
// whenLabel
// ---------------------------------------------------------------------------

test("whenLabel: today reads as a time, this week as a weekday, older as a date", () => {
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  assert.match(whenLabel(now - 3600_000, now), /^\d\d:\d\d UTC$/);
  assert.match(whenLabel(now - 3 * 24 * 3600_000, now), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
  assert.match(whenLabel(now - 30 * 24 * 3600_000, now), /^\d{4}-\d\d-\d\d$/);
});

test("whenLabel: a missing timestamp renders as nothing, not 'Invalid Date'", () => {
  assert.equal(whenLabel(0), "");
  assert.equal(whenLabel(NaN), "");
});

// ---------------------------------------------------------------------------
// refreshStatusLine — the visitor must always be told what the search did
// ---------------------------------------------------------------------------

test("refreshStatusLine distinguishes 'nothing new' from 'we did not look'", () => {
  const nothingNew = refreshStatusLine({ lens: "edge-rag", fresh: [] });
  const cooled = refreshStatusLine({ lens: "edge-rag", cooled: true });
  assert.notEqual(nothingNew, cooled, "a silent no-op reads as a broken button");
  assert.match(nothingNew, /did not already have/);
  assert.match(cooled, /moments ago/);
});

test("refreshStatusLine counts fresh items and singularizes", () => {
  assert.match(refreshStatusLine({ lens: "edge-rag", fresh: [{}] }), /1 new item,/);
  assert.match(refreshStatusLine({ lens: "edge-rag", fresh: [{}, {}] }), /2 new items,/);
});

test("refreshStatusLine names the lens by its title, not its slug", () => {
  const line = refreshStatusLine({ lens: "browser-models", fresh: [] });
  assert.match(line, new RegExp(lensById("browser-models").title));
});

test("refreshStatusLine surfaces limits, backend failures, and errors plainly", () => {
  assert.match(refreshStatusLine({ limited: true }), /Enough refreshes/);
  assert.match(refreshStatusLine({ lens: "edge-rag", degraded: true }), /did not answer/);
  assert.match(refreshStatusLine({ error: "boom" }), /boom/);
  assert.match(refreshStatusLine(null), /could not run/);
});

// ---------------------------------------------------------------------------
// knownKeys — what the delta is computed against
// ---------------------------------------------------------------------------

test("knownKeys extracts keys, caps the list, and survives junk", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ key: `https://a.example/${i}` }));
  assert.equal(knownKeys(items).length, 10);
  assert.equal(knownKeys(items, 3).length, 3);
  assert.deepEqual(knownKeys(null), []);
  assert.deepEqual(knownKeys([{ key: "" }, {}]), []);
});

// ---------------------------------------------------------------------------
// noteLens — where a strategic note gets filed
// ---------------------------------------------------------------------------

test("noteLens prefers the lens the reader is filtered to", () => {
  assert.equal(noteLens("privacy-llm", "something about a library dependency"), "privacy-llm");
});

test("noteLens falls back to what the note is about, in EN and SV alike", () => {
  assert.equal(noteLens(null, "this library could be our one dependency"), "one-dependency");
  assert.equal(noteLens(null, "det här biblioteket kan bli vårt enda beroende"), "one-dependency");
});

test("noteLens leaves an unfilable note unfiled rather than misfiling it", () => {
  assert.equal(noteLens(null, "just a thought"), null);
  assert.equal(noteLens("not-a-lens", "just a thought"), null);
});

// ---------------------------------------------------------------------------
// The three network calls — asserted through an injected fetch
// ---------------------------------------------------------------------------

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test("loadFeed merges the committed artifact with the live rows", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url === ARTIFACT_URL) {
      return okJson({ items: [{ lens: "edge-rag", title: "From the scan", url: "https://a.example/1" }] });
    }
    return okJson({ live: true, items: [{ lens: "edge-rag", title: "From D1", url: "https://a.example/2" }] });
  };
  const res = await loadFeed(fake);
  assert.deepEqual(calls.sort(), [FEED_URL, ARTIFACT_URL].sort());
  assert.equal(res.items.length, 2);
  assert.equal(res.live, true);
});

test("loadFeed: either half failing leaves the other, and both failing is an empty feed", async () => {
  const artifactOnly = await loadFeed(async (url) =>
    url === ARTIFACT_URL
      ? okJson({ items: [{ lens: "edge-rag", title: "Scan", url: "https://a.example/1" }] })
      : { ok: false, status: 401 },
  );
  assert.equal(artifactOnly.items.length, 1);
  assert.equal(artifactOnly.live, false, "a signed-out visitor is told the live half is missing");

  const nothing = await loadFeed(async () => {
    throw new Error("offline");
  });
  assert.deepEqual(nothing.items, []);
});

test("loadFeed dedupes an item present in BOTH halves", async () => {
  const res = await loadFeed(async (url) =>
    okJson(
      url === ARTIFACT_URL
        ? { items: [{ lens: "edge-rag", title: "Same", url: "https://a.example/x" }] }
        : { live: true, items: [{ lens: "edge-rag", title: "Same", url: "http://www.a.example/x/" }] },
    ),
  );
  assert.equal(res.items.length, 1);
});

test("requestRefresh posts the lens and the known keys, and never throws", async () => {
  let sent = null;
  const res = await requestRefresh({ lens: "edge-rag", known: ["https://a.example/x"] }, async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return okJson({ lens: "edge-rag", fresh: [] });
  });
  assert.equal(sent.url, REFRESH_URL);
  assert.equal(sent.body.lens, "edge-rag");
  assert.deepEqual(sent.body.known, ["https://a.example/x"]);
  assert.equal(res.lens, "edge-rag");

  assert.match((await requestRefresh({}, async () => ({ ok: false, status: 500, json: async () => ({}) }))).error, /500/);
  assert.match(
    (
      await requestRefresh({}, async () => {
        throw new Error("offline");
      })
    ).error,
    /could not be reached/,
  );
});

test("requestRefresh with no lens asks the server to choose", async () => {
  let body = null;
  await requestRefresh({}, async (_url, init) => {
    body = JSON.parse(init.body);
    return okJson({});
  });
  assert.equal(body.lens, "auto");
});

// THE SHORTCUT. A note written on this page must reach the ordinary feedback
// queue tagged as a strategic idea against its lens — that tag is the entire
// difference between the loop reading it as direction and triaging it as a bug.
test("submitStrategyNote files the note as a strategy-scoped entry under its lens", async () => {
  let sent = null;
  const res = await submitStrategyNote({ comment: "Build on this library.", lens: "one-dependency" }, async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(res.ok, true);
  assert.equal(sent.url, FEEDBACK_URL);
  assert.equal(sent.body.comment, "Build on this library.");
  assert.ok(sent.body.page.endsWith(STRATEGY_PAGE_SUFFIX), "the strategy marker must survive to the server");
  assert.match(sent.body.page, /one-dependency/, "the lens must survive to the server");
  assert.equal(sent.body.question, lensById("one-dependency").question);
});

test("submitStrategyNote still files an unfiled note, just without a lens", async () => {
  let body = null;
  await submitStrategyNote({ comment: "A thought.", lens: null }, async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.ok(body.page.endsWith(STRATEGY_PAGE_SUFFIX));
  assert.equal(body.question, null);
});

test("submitStrategyNote refuses an empty note and reports failures", async () => {
  assert.equal((await submitStrategyNote({ comment: "   ", lens: null })).ok, false);
  const failed = await submitStrategyNote({ comment: "x", lens: null }, async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "Sign in first." }),
  }));
  assert.deepEqual(failed, { ok: false, error: "Sign in first." });
});
