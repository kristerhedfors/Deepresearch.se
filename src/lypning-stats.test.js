// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// The Worker's lypning seam. Two properties, both about honesty rather than
// arithmetic: the figures come from the SAME module the dashboard renders from,
// and a deployment that cannot load the dataset says so instead of recalling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLypningHistory, lypningContextBlock, HISTORY_PATH, movement } from "./lypning-stats.js";
import { statsContextBlock } from "../public/js/lypning-core.js";

const HISTORY = JSON.parse(readFileSync(new URL("../public/lypning/history.json", import.meta.url), "utf8"));
const quiet = { warn() {}, info() {}, error() {} };

/** An ASSETS binding that serves one path. */
const assetsServing = (path, body, status = 200) => ({
  ASSETS: {
    fetch: async (/** @type {Request} */ req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: status < 400, status, json: async () => body };
    },
  },
});

test("the history loads through the ASSETS binding at the path the page reads", async () => {
  const env = assetsServing(HISTORY_PATH, HISTORY);
  const got = await loadLypningHistory(env, quiet);
  assert.equal(got.head, HISTORY.head);
  assert.equal(got.commits.length, HISTORY.commits.length);
});

test("a missing, broken or unbound dataset is null, never a throw", async () => {
  assert.equal(await loadLypningHistory({}, quiet), null, "no binding");
  assert.equal(await loadLypningHistory(assetsServing(HISTORY_PATH, {}, 404), quiet), null, "404");
  assert.equal(await loadLypningHistory(assetsServing(HISTORY_PATH, { nope: 1 }), quiet), null, "wrong shape");
  const throwing = { ASSETS: { fetch: async () => { throw new Error("binding down"); } } };
  assert.equal(await loadLypningHistory(throwing, quiet), null, "a throwing binding");
});

test("a deployment with no dataset says so rather than recalling figures", async () => {
  const block = await lypningContextBlock({}, quiet);
  assert.match(block, /could not be loaded/);
  assert.match(block, /never quoted as a measurement/);
  // It must not contain a number that looks like a result.
  assert.doesNotMatch(block, /0\.\d\d\dx/);
});

test("the agent reads exactly what the page renders", async () => {
  // Same function, same data, so the two cannot drift into disagreeing about a
  // figure the reader is looking at.
  const env = assetsServing(HISTORY_PATH, HISTORY);
  assert.equal(await lypningContextBlock(env, quiet), statsContextBlock(HISTORY, null));
});

test("a live summary from the reader's own VM is marked as theirs", async () => {
  const env = assetsServing(HISTORY_PATH, HISTORY);
  const live = { engines: ["python3"], cold: { python3: 8_573_000 }, rows: [] };
  const block = await lypningContextBlock(env, quiet, live);
  assert.match(block, /measured in this reader's own browser Linux VM/);
  assert.match(block, /8573\.00 ms/);
});

test("the module re-exports the core rather than reimplementing it", () => {
  // If this ever becomes a second implementation, the two answers diverge.
  const m = movement(HISTORY, "published.mixtureRatio");
  assert.equal(m.measuredHere, false, "a quoted series must stay marked quoted on the server side too");
});
