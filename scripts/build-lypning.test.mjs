// @ts-check
// The lypning history generator. Two things are pinned: the README parser
// (which is a QUOTE reader, so it must not silently invent a field), and the
// staleness of the committed dataset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPublished } from "./build-lypning.mjs";

const HISTORY = JSON.parse(readFileSync(new URL("../public/lypning/history.json", import.meta.url), "utf8"));

test("the published-number parser reads the whole table", () => {
  const readme = [
    "corpus capture that had grown to **1551 programs, 1305 of them measurable**:",
    "",
    "| | `cpython` | `lypning` | `lypning-mp` | **mixture** |",
    "|---|---:|---:|---:|---:|",
    "| startup, `-c 'pass'`, min of 15 | 11.57 ms | 0.66 ms | 0.61 ms | **0.60 ms** |",
    "| binary | 6,639,992 B | 987,336 B | 296,100 B | — |",
    "",
    "**The mixture answers all 1305 programs for 0.302x of CPython's cost**",
    "",
    "Correctness on the same tree, from `lypning conformance`: `lypning` 906 MATCH ·",
    "399 UNSUPPORTED · **0 MISMATCH**; `lypning-mp` 1229 · 65 · **11**; the mixture",
    "**1305 / 1305** with **1**.",
    "",
    "**91.0% IDEAL, 97.5% right on the first try** over the 1305 programs above.",
  ].join("\n");
  const got = readPublished(readme);
  assert.equal(got.corpusPrograms, 1551);
  assert.equal(got.corpusMeasurable, 1305);
  assert.equal(got.mixtureRatio, 0.302);
  assert.equal(got.startupCpythonMs, 11.57);
  assert.equal(got.startupMixtureMs, 0.6);
  assert.equal(got.binaryLypningBytes, 987336);
  assert.equal(got.lypningMismatch, 0);
  assert.equal(got.lypningMpMismatch, 11);
  assert.equal(got.routeIdealPct, 91.0);
});

test("a README with no table yields NO fields — not zeroed ones", () => {
  // The difference between "did not measure" and "measured zero" is the whole
  // editorial position of the dashboard. An absent field must stay absent.
  const got = readPublished("# lypning\n\nA mixture of Pythons. No numbers here yet.\n");
  assert.deepEqual(got, {});
});

test("the conformance sentence is read across its line breaks", () => {
  // It has been re-wrapped twice upstream. Anchoring on the prose rather than
  // on line geometry is what survives that.
  const wrapped = "from `lypning conformance`: `lypning` 500\nMATCH · 263 UNSUPPORTED · **0 MISMATCH**; `lypning-mp` 714 ·\n47 · **2**; the mixture";
  assert.equal(readPublished(wrapped).lypningMpMismatch, 2);
});

test("the committed history is coherent", () => {
  assert.ok(HISTORY.commits.length > 0, "history.json is empty — run `npm run lypning`");
  assert.equal(HISTORY.head, HISTORY.commits[HISTORY.commits.length - 1].sha);
  // Oldest first, so a chart can plot it without sorting.
  for (let i = 1; i < HISTORY.commits.length; i++) {
    assert.ok(HISTORY.commits[i].at >= HISTORY.commits[i - 1].at, `commit ${i} is out of order`);
  }
  // No wall-clock stamp: it would make every regeneration a diff and --check
  // could never tell a stale file from a re-run one.
  assert.equal(HISTORY.generatedAt, undefined);
  for (const s of HISTORY.series) {
    assert.equal(typeof s.measuredHere, "boolean", `${s.key} does not declare its provenance`);
    assert.ok(["up", "down"].includes(s.better), `${s.key} does not say which direction is progress`);
  }
});
