// Unit tests for the introspection enrichment (src/introspect.js) against a
// mocked ASSETS binding, plus the source-snapshot freshness check: the
// committed artifact (public/introspect/source-snapshot.json) must match the
// working tree, so a source change without `npm run bundle` fails the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceSnapshot, runIntrospectionEnrichment } from "./introspect.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

const SNAPSHOT = {
  v: 1,
  digest: "deadbeefcafe0123",
  count: 2,
  bytes: 0,
  files: [
    { p: "CLAUDE.md", s: 20, t: "# CLAUDE.md\norientation" },
    { p: "src/pipeline.js", s: 10, t: "// phases" },
  ],
};

/** @param {any} payload @param {number} [status] */
function envWith(payload, status = 200) {
  return /** @type {any} */ ({
    ASSETS: {
      fetch: async () =>
        new Response(payload === null ? "not found" : JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
    },
  });
}

function steps() {
  /** @type {string[]} */
  const started = [];
  /** @type {string[]} */
  const done = [];
  return {
    started,
    done,
    step: (/** @type {string} */ id, /** @type {string} */ label) => started.push(label),
    stepDone: (/** @type {string} */ id, /** @type {string} */ label) => done.push(label),
  };
}

const convo = (/** @type {string[]} */ ...texts) => texts.map((t) => ({ role: "user", content: t }));

test("loadSourceSnapshot: fetches + validates via the ASSETS binding", async () => {
  const snap = await loadSourceSnapshot(envWith(SNAPSHOT), noopLog);
  assert.ok(snap);
  assert.equal(snap.count, 2);
  // missing binding / 404 / junk all degrade to null, never a throw
  assert.equal(await loadSourceSnapshot(/** @type {any} */ ({}), noopLog), null);
  assert.equal(await loadSourceSnapshot(envWith(null, 404), noopLog), null);
  assert.equal(await loadSourceSnapshot(envWith({ nope: 1 }), noopLog), null);
});

test("runIntrospectionEnrichment: silent (no step, unchanged) when not engaged", async () => {
  const s = steps();
  const conversation = convo("what's the weather in Lund?");
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const out = await runIntrospectionEnrichment(envWith(SNAPSHOT), noopLog, s.step, s.stepDone, /** @type {any} */ (conversation), state);
  assert.equal(out, conversation);
  assert.equal(s.started.length, 0);
  assert.equal(state.introspectionCount, 0);
});

test("runIntrospectionEnrichment: appends the labeled block when engaged (EN and SV)", async () => {
  for (const ask of ["how are you implemented?", "visa mig din källkod"]) {
    const s = steps();
    const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0, shellTranscript: [] });
    const out = await runIntrospectionEnrichment(envWith(SNAPSHOT), noopLog, s.step, s.stepDone, /** @type {any} */ (convo(ask)), state);
    const text = /** @type {any} */ (out[out.length - 1]).content;
    assert.match(text, /--- Introspection: deepresearch\.se source snapshot/, ask);
    assert.match(text, /src\/pipeline\.js\t10/);
    assert.equal(state.introspectionCount, 1);
    assert.equal(s.done.length, 1);
    assert.match(s.done[0], /source snapshot in context \(2 files\)/);
  }
});

test("runIntrospectionEnrichment: the mode is sticky across follow-ups", async () => {
  const s = steps();
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const conversation = convo("explain your architecture", "and what does the gap check do?");
  const out = await runIntrospectionEnrichment(envWith(SNAPSHOT), noopLog, s.step, s.stepDone, /** @type {any} */ (conversation), state);
  assert.notEqual(out, conversation);
  assert.equal(state.introspectionCount, 1);
});

test("runIntrospectionEnrichment: a named repo path engages it; junk paths don't", async () => {
  const engaged = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const s1 = steps();
  await runIntrospectionEnrichment(envWith(SNAPSHOT), noopLog, s1.step, s1.stepDone, /** @type {any} */ (convo("read src/pipeline.js")), engaged);
  assert.equal(engaged.introspectionCount, 1);
  // path-shaped but not in the snapshot: loads it, then reports not engaged
  const not = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const s2 = steps();
  const conversation = convo("my repo has a src/other-app.py file");
  const out = await runIntrospectionEnrichment(envWith(SNAPSHOT), noopLog, s2.step, s2.stepDone, /** @type {any} */ (conversation), not);
  assert.equal(out, conversation);
  assert.equal(not.introspectionCount, 0);
});

test("runIntrospectionEnrichment: fail-soft when the snapshot is unavailable", async () => {
  const s = steps();
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const conversation = convo("how are you built?");
  const out = await runIntrospectionEnrichment(envWith(null, 404), noopLog, s.step, s.stepDone, /** @type {any} */ (conversation), state);
  assert.equal(out, conversation); // unchanged, no throw
  assert.match(s.done[0], /unavailable/);
  assert.equal(state.introspectionCount, 0);
});

// ---- the committed artifact stays fresh -----------------------------------------

test("source snapshot artifact matches the working tree (npm run bundle)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Exits non-zero (throws here) when public/introspect/source-snapshot.json
  // is stale — regenerate with `npm run bundle` and commit it.
  execFileSync(process.execPath, [join(root, "scripts/bundle-source.mjs"), "--check"], {
    cwd: root,
    stdio: "pipe",
  });
});
