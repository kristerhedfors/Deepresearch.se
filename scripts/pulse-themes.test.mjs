// Unit coverage for the /pulse/timeline subject taxonomy (scripts/pulse-themes.mjs).
// Pure text → tags; no git, no network. Runs in `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBJECTS, tagCommit, subject, subjectRegistry } from "./pulse-themes.mjs";

test("every subject has a unique key, label, hex colour, blurb and RegExp", () => {
  const keys = new Set();
  for (const s of SUBJECTS) {
    assert.ok(s.key && !keys.has(s.key), `duplicate/empty key: ${s.key}`);
    keys.add(s.key);
    assert.match(s.color, /^#[0-9a-fA-F]{6}$/, `${s.key} colour must be #rrggbb`);
    assert.ok(s.label && s.blurb, `${s.key} needs a label + blurb`);
    assert.ok(s.test instanceof RegExp, `${s.key} needs a RegExp test`);
  }
});

test("subject colours are distinct (entity-stable, never a repeated hue)", () => {
  const colors = SUBJECTS.map((s) => s.color.toLowerCase());
  assert.equal(new Set(colors).size, colors.length, "two subjects share a hue");
});

test("subjectRegistry() drops the regex but keeps the client fields", () => {
  const reg = subjectRegistry();
  assert.equal(reg.length, SUBJECTS.length);
  for (const r of reg) {
    assert.deepEqual(Object.keys(r).sort(), ["blurb", "color", "key", "label"]);
  }
});

test("tagCommit returns zero-to-many keys, in SUBJECTS order", () => {
  assert.deepEqual(tagCommit(""), []);
  assert.deepEqual(tagCommit("Merge barrier: re-point main_sha"), []);
  const multi = tagCommit("Regenerate the source-rag index for the on-device download fix");
  assert.ok(multi.includes("ondevice"));
  assert.ok(multi.includes("artifacts") || multi.includes("introspection"),
    "regen-of-artifacts commit should also read as artifacts/introspection");
  // order preserved
  const order = SUBJECTS.map((s) => s.key);
  const idx = multi.map((k) => order.indexOf(k));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

// Representative real subject lines → the feature set they must land on.
const CASES = [
  ["On-device inference: 1-bit Bonsai models in the browser (Se/cure)", ["ondevice", "secure"]],
  ["Sandbox boot: tar-based /src seeding + a fail-soft seed timeout", ["sandbox"]],
  ["Widen hfIntent: hub-implied model vocabulary fires the HF Hub source", ["hf"]],
  ["Se/rver tokens: one ticket, one JWT — consolidated upstream-API grants", ["grants"]],
  ["Nearby-place asks run a location-biased Google Places search", ["maps"]],
  ["Help mode: the documentation-first layer of introspection", ["help", "introspection"]],
  ["refactor(client): split embeds registry and recovery transport from stream.js", ["refactor"]],
  ["security: mechanical secret-leak prevention — scanner + pre-push hook (P-2)", ["security"]],
  ["auth: canonicalize www -> apex so Google OAuth redirect_uri matches", ["access"]],
  ["Agent-Pair SDK: core design docs (DESIGN, MANIFEST, ROADMAP, README)", ["sdk"]],
];

for (const [line, mustHave] of CASES) {
  test(`tags: ${line.slice(0, 48)}…`, () => {
    const got = tagCommit(line);
    for (const key of mustHave) {
      assert.ok(got.includes(key), `expected "${key}" in [${got.join(", ")}] for: ${line}`);
      assert.ok(subject(key), `unknown key ${key}`);
    }
  });
}
