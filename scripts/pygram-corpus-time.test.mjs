// Unit tests for the corpus timer (scripts/pygram-corpus-time.mjs) — the parts
// that decide whether a number means anything, never the numbers themselves.
//
// NOTHING HERE ASSERTS A DURATION. Same rule as scripts/pygram-bench.test.mjs:
// a test that says "351 programs take under 600 ms" is a flake generator on a
// shared runner. What is worth pinning is the machinery that makes an A/B
// comparison honest — that entries are deduped so one program cannot be counted
// twice, that stdin arrives from either of the two field names the two corpus
// files use, and above all that each entry runs in its OWN directory, because
// harvested corpus programs write files and one entry's output must never
// become the next entry's input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCorpus, runEntry, timeCorpus } from "./pygram-corpus-time.mjs";

function tmpFile(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "corpustime-test-"));
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

// A stand-in for the interpreter: echoes its -c program, reads stdin, and can
// be told to exit 90 so the unsupported accounting has something to count.
function fakeBin(body) {
  const p = tmpFile("fake.sh", `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("loadCorpus reads both files and takes each id once", () => {
  const a = tmpFile(
    "corpus.jsonl",
    JSON.stringify({ id: "one", program: "print(1)" }) +
      "\n" +
      JSON.stringify({ id: "two", program: "print(2)" }) +
      "\n",
  );
  const b = tmpFile(
    "seed.jsonl",
    // Same id as the harvested file: a duplicate would double-count that
    // program in the total and quietly weight it twice in an A/B.
    JSON.stringify({ id: "one", program: "print(1)" }) +
      "\n" +
      JSON.stringify({ id: "three", program: "print(3)" }) +
      "\n",
  );
  const got = loadCorpus([a, b]);
  assert.deepEqual(
    got.map((e) => e.id),
    ["one", "two", "three"],
  );
});

test("loadCorpus takes stdin from either field name, and defaults to empty", () => {
  const f = tmpFile(
    "c.jsonl",
    [
      JSON.stringify({ id: "seed", program: "x", stdin: "from-seed" }),
      // The harvested file names it stdin_sample; reading only `stdin` would
      // run every harvested pipeline entry against no input at all.
      JSON.stringify({ id: "harvested", program: "x", stdin_sample: "from-harvest" }),
      JSON.stringify({ id: "none", program: "x" }),
    ].join("\n"),
  );
  const got = loadCorpus([f]);
  assert.equal(got[0].stdin, "from-seed");
  assert.equal(got[1].stdin, "from-harvest");
  assert.equal(got[2].stdin, "");
});

test("loadCorpus skips entries with no program rather than timing an empty run", () => {
  const f = tmpFile(
    "c.jsonl",
    [
      JSON.stringify({ id: "real", program: "print(1)" }),
      JSON.stringify({ id: "empty", program: "" }),
      JSON.stringify({ id: "missing" }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    loadCorpus([f]).map((e) => e.id),
    ["real"],
  );
});

test("loadCorpus ignores a corpus file that is not there", () => {
  assert.deepEqual(loadCorpus([join(tmpdir(), "no-such-corpus.jsonl")]), []);
});

test("runEntry reports the child's exit status, so exit 90 stays distinguishable", () => {
  const bin = fakeBin("exit 90");
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const got = runEntry(bin, { program: "pass", argv_tail: [], stdin: "" }, dir);
  assert.equal(got.status, 90);
  assert.ok(got.ms >= 0);
});

test("runEntry returns null when the binary does not exist", () => {
  const got = runEntry(
    join(tmpdir(), "definitely-not-a-binary"),
    { program: "pass", argv_tail: [], stdin: "" },
    tmpdir(),
  );
  assert.equal(got, null);
});

test("each entry runs in its own directory, and it is cleaned up after", () => {
  // The failure this pins: a corpus program writes a file, the next program
  // reads it, and the second program is timed doing work the first one paid
  // for. Harvested entries really do rewrite files wholesale.
  const bin = fakeBin('pwd > cwd.txt; ls | wc -l >> "$PWD/seen.txt"');
  const corpus = [
    { id: "a", program: "x", argv_tail: [], stdin: "" },
    { id: "b", program: "x", argv_tail: [], stdin: "" },
  ];
  const seen = [];
  const { best } = timeCorpus([bin], corpus, 1, (_r, entry) => seen.push(entry.id));
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(best[0].size, 2);
  // Nothing the fake wrote survives: the directories are removed, so a run
  // cannot leave the repository — or the next run — dirty.
  assert.ok(!existsSync(join(process.cwd(), "cwd.txt")));
});

test("timeCorpus keeps the MINIMUM across repeats, per binary", () => {
  // Noise on a shared box is one-sided, so the min is the estimate. A mean
  // would let one descheduled run decide the verdict.
  const bin = fakeBin("exit 0");
  const corpus = [{ id: "a", program: "x", argv_tail: [], stdin: "" }];
  const { best } = timeCorpus([bin], corpus, 3, null);
  const single = timeCorpus([bin], corpus, 1, null).best[0].get("a");
  assert.ok(best[0].get("a") <= single + 50);
});

test("the child cannot feed the capture harness", () => {
  // docs/PYGRAM.md §7a: the conformance runner logging its own 212 invocations
  // back into the corpus is a solved bug. A timing run makes 351 x repeats x
  // binaries of them, so it must stay switched off here too.
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const out = join(dir, "capture.txt");
  const bin = fakeBin(`printf "%s" "\${PYGRAM_CAPTURE-unset}" > ${out}`);
  runEntry(bin, { program: "x", argv_tail: [], stdin: "" }, dir);
  assert.equal(readFileSync(out, "utf8"), "0");
});

test("stdin reaches the child", () => {
  const dir = mkdtempSync(join(tmpdir(), "in-"));
  const out = join(dir, "got.txt");
  const bin = fakeBin(`cat > ${out}`);
  runEntry(bin, { program: "x", argv_tail: [], stdin: "piped\n" }, dir);
  assert.equal(readFileSync(out, "utf8"), "piped\n");
});
