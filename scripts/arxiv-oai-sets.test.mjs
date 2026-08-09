import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertHarvestableSets,
  assertLeafSets,
  buildUrl,
  harvestSet,
  isArchiveWideSet,
  leafSets,
  parseArgs,
  parseSetList,
  parseSetSpecs,
  shardName,
} from "./arxiv-oai-sets.mjs";
import { parseRecord } from "./arxiv-harvest.mjs";
import { vectorMetadata } from "./arxiv-vectorize.mjs";

// Everything here is offline. The fixtures are shaped like the live feed —
// the `<record>` layout, the whitespace-only final resumption token and the
// setSpec hierarchy are copied from responses measured on 2026-08-09 — because
// what this channel rests on is that a set-scoped page produces the same corpus
// row as a datestamp-scoped one, and a fixture that drifts from the wire stops
// testing that.

const ABSTRACT = "We study retrieval under differential privacy &amp; report an epsilon &lt; 1 result on a corpus of scientific abstracts. ".repeat(2);

/** @param {string} id @param {{ cats?: string, abstract?: string, deleted?: boolean }} [o] */
const record = (id, o = {}) =>
  o.deleted
    ? `<record><header status="deleted"><identifier>oai:arXiv.org:${id}</identifier><datestamp>2026-07-20</datestamp></header></record>`
    : `<record>
  <header><identifier>oai:arXiv.org:${id}</identifier><datestamp>2026-07-20</datestamp></header>
  <metadata><arXiv xmlns="http://arxiv.org/OAI/arXiv/">
    <id>${id}</id>
    <created>2026-07-17</created>
    <updated>2026-07-20</updated>
    <authors>
      <author><keyname>Lindqvist</keyname><forenames>Anna</forenames></author>
      <author><keyname>Chen</keyname><forenames>Bo</forenames></author>
    </authors>
    <title>Private Retrieval over Scientific
    Corpora</title>
    <categories>${o.cats ?? "cs.CR cs.IR"}</categories>
    <abstract>${o.abstract ?? ABSTRACT}</abstract>
  </arXiv></metadata>
</record>`;

/** @param {string[]} records @param {string|null} token @param {number} [complete] */
const page = (records, token, complete = 0) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>
${records.join("\n")}
${token === null ? "" : `<resumptionToken${complete ? ` completeListSize="${complete}" cursor="0"` : ""}>${token}</resumptionToken>`}
</ListRecords></OAI-PMH>`;

const LIST_SETS = `<OAI-PMH><ListSets>
  <set><setSpec>cs</setSpec><setName>Computer Science</setName></set>
  <set><setSpec>physics</setSpec><setName>Physics</setName></set>
  <set><setSpec>stat</setSpec><setName>Statistics</setName></set>
  <set><setSpec>cs:cs</setSpec><setName>Computer Science</setName></set>
  <set><setSpec>stat:stat</setSpec><setName>Statistics</setName></set>
  <set><setSpec>physics:cond-mat</setSpec><setName>Condensed Matter</setName></set>
  <set><setSpec>physics:gr-qc</setSpec><setName>General Relativity and Quantum Cosmology</setName></set>
  <set><setSpec>cs:cs:AI</setSpec><setName>Artificial Intelligence</setName></set>
  <set><setSpec>cs:cs:CR</setSpec><setName>Cryptography and Security</setName></set>
  <set><setSpec>cs:cs:LG</setSpec><setName>Machine Learning</setName></set>
  <set><setSpec>stat:stat:ML</setSpec><setName>Machine Learning</setName></set>
  <set><setSpec>physics:cond-mat:stat-mech</setSpec><setName>Statistical Mechanics</setName></set>
</ListSets></OAI-PMH>`;

const scratch = () => mkdtemp(join(tmpdir(), "arxiv-sets-"));

/** The harvester writes into <outDir>/raw and <outDir>/state; both must exist. */
async function outDir() {
  const dir = await scratch();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "raw"), { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  return dir;
}

// ---- the guard, which is the point ------------------------------------------

test("a whole-archive set is refused by name, with the measurement", () => {
  // Measured 2026-08-09: `set=cs` returned NOTHING in 120 s, twice, while
  // `set=cs:cs:CR` served 1,300 records in 650 ms. A comment would not have
  // stopped anyone typing --sets cs and waiting two minutes for a guess.
  for (const wide of ["cs", "physics", "cs:cs", "math:math", "stat:stat"]) {
    assert.ok(isArchiveWideSet(wide), wide);
    assert.throws(() => assertHarvestableSets([wide]), /whole archive|does not answer/, wide);
  }
  for (const leaf of ["cs:cs:CR", "stat:stat:ML", "physics:cond-mat:stat-mech", "physics:gr-qc"]) {
    assert.ok(!isArchiveWideSet(leaf), leaf);
  }
  assert.doesNotThrow(() => assertHarvestableSets(["cs:cs:CR", "cs:cs:AI"]));
});

test("a bare --from with no set is refused, naming the 100 s hang", () => {
  // The other measured non-answer: `from=2026-07-25` with no set, no response
  // in 100 s. The error has to say WHICH shape hangs, or the next session
  // re-derives it.
  assert.throws(() => assertHarvestableSets([], "2026-07-25"), /with no --sets[\s\S]*100 s/);
  assert.throws(() => assertHarvestableSets([]), /--sets is required/);
  assert.throws(() => parseArgs(["--from", "2026-07-25"]), /100 s/);
  assert.throws(() => parseArgs(["--sets", "cs"]), /120 s/);
  assert.throws(() => parseArgs([]), /--sets is required/);
});

test("assertLeafSets refuses a set the hierarchy extends, and names its children", () => {
  const specs = parseSetSpecs(LIST_SETS);
  assert.equal(specs.length, 12);
  assert.deepEqual(
    leafSets(specs).sort(),
    ["cs:cs:AI", "cs:cs:CR", "cs:cs:LG", "physics:cond-mat:stat-mech", "physics:gr-qc", "stat:stat:ML"].sort(),
    "a leaf is what nothing else extends — which is a two-part set for gr-qc and a three-part one for cs.CR",
  );
  assert.throws(() => assertLeafSets(["physics:cond-mat"], specs), /not a leaf set[\s\S]*stat-mech/);
  assert.throws(() => assertLeafSets(["cs:cs"], specs), /not a leaf set/);
  assert.throws(() => assertLeafSets(["cs:cs:XX"], specs), /not one of the 12 sets/);
  // A category named without its archive path is the likely typo, so the error
  // points at the real spec rather than just refusing.
  assert.throws(() => assertLeafSets(["cs:CR"], specs), /did you mean cs:cs:CR/);
  // Terminal but not the three-part shape the throughput was measured on: it
  // is allowed, and RETURNED as unmeasured so the run can say so.
  assert.deepEqual(assertLeafSets(["cs:cs:CR", "physics:gr-qc"], specs), ["physics:gr-qc"]);
  assert.deepEqual(assertLeafSets(["cs:cs:CR", "stat:stat:ML"], specs), []);
});

// ---- CLI ---------------------------------------------------------------------

test("parseSetList takes a list and refuses a token that is not a setSpec", () => {
  assert.deepEqual(parseSetList("cs:cs:CR,cs:cs:AI"), ["cs:cs:CR", "cs:cs:AI"]);
  assert.deepEqual(parseSetList(" cs:cs:CR , cs:cs:CR "), ["cs:cs:CR"], "deduped, order preserved");
  assert.deepEqual(parseSetList("physics:cond-mat:stat-mech"), ["physics:cond-mat:stat-mech"]);
  for (const bad of ["cs.CR", "cs/CR", "2401.12345", "cs:cs:CR!", "Cs:cs:CR"]) {
    assert.throws(() => parseSetList(bad), /not an arXiv setSpec/, bad);
  }
});

test("parseArgs validates rather than silently accepting nonsense", () => {
  const a = parseArgs(["--sets", "cs:cs:CR,cs:cs:AI", "--from", "2026-07-25"]);
  assert.deepEqual(a.setList, ["cs:cs:CR", "cs:cs:AI"]);
  assert.equal(a.from, "2026-07-25");
  assert.equal(a.pauseMs, 3000, "the default is arXiv's published rate, not the 0 the probe measured at");
  assert.equal(parseArgs(["--sets=cs:cs:CR", "--max-pages=2"]).maxPages, 2);
  assert.throws(() => parseArgs(["--sets", "cs:cs:CR", "--from", "2026-07"]), /ISO day/);
  assert.throws(() => parseArgs(["--sets", "cs:cs:CR", "--pause", "-1"]), /--pause/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
  // --list-sets needs no --sets: it is how you find out what to pass.
  assert.doesNotThrow(() => parseArgs(["--list-sets"]));
  assert.doesNotThrow(() => parseArgs(["--help"]));
});

// ---- the resumption-token protocol ------------------------------------------

test("a continuation request carries the token and NOTHING else", () => {
  // resumptionToken is an exclusive argument in OAI-PMH: repeating
  // metadataPrefix/set/from beside it is a badArgument. arXiv's token is the
  // literal query anyway — every page of the cs.CR run came back with
  // `verb=ListRecords&metadataPrefix=arXiv&from=…&set=cs%3Acs%3ACR` inside it.
  const first = buildUrl({ set: "cs:cs:CR", from: "2026-07-25" });
  assert.equal(first.searchParams.get("verb"), "ListRecords");
  assert.equal(first.searchParams.get("metadataPrefix"), "arXiv");
  assert.equal(first.searchParams.get("set"), "cs:cs:CR");
  assert.equal(first.searchParams.get("from"), "2026-07-25");

  const next = buildUrl({ set: "cs:cs:CR", from: "2026-07-25", token: "verb=ListRecords&from=2026-01-08&set=cs%3Acs%3ACR" });
  assert.deepEqual([...next.searchParams.keys()].sort(), ["resumptionToken", "verb"]);
  assert.equal(next.searchParams.get("resumptionToken"), "verb=ListRecords&from=2026-01-08&set=cs%3Acs%3ACR", "the token goes back verbatim, encoded once");

  const all = buildUrl({ set: "cs:cs:CR" });
  assert.equal(all.searchParams.get("from"), null, "no --from means no from parameter, not an empty one");
});

test("shardName keeps a set's shard out of the datestamp path's namespace", () => {
  assert.equal(shardName("cs:cs:CR"), "cs-cs-CR");
  assert.equal(shardName("physics:cond-mat:stat-mech"), "physics-cond-mat-stat-mech");
  assert.ok(!/^\d{4}-\d{2}$/.test(shardName("cs:cs:CR")), "must not collide with a YYYY-MM month shard");
});

// ---- harvesting one set ------------------------------------------------------

test("harvestSet pages to exhaustion and stops on the WHITESPACE final token", async () => {
  const dir = await outDir();
  try {
    /** @type {Array<{ set: string, from?: string, token?: string }>} */
    const calls = [];
    const r = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async (req) => {
        calls.push({ ...req });
        if (!req.token) return page([record("2607.00001"), record("2607.00002")], "tok&amp;1", 3);
        // THE LAST PAGE'S TOKEN IS NOT EMPTY, IT IS WHITESPACE — measured on
        // the final page of the full cs.CR run. A truthiness check spends one
        // more request to be told 0 records; parsePage trims, so this stops.
        return page([record("2607.00003")], "\n\n    ");
      },
    });
    assert.equal(calls.length, 2, "the whitespace token ends the run — no third request");
    assert.equal(calls[1].token, "tok&1", "the token is entity-decoded before it goes back on the wire");
    assert.equal(r.kept, 3);
    assert.equal(r.seen, 3);
    assert.equal(r.pages, 2);
    assert.equal(r.complete, 3, "completeListSize is carried through for the progress line");
    assert.ok(r.done);

    const rows = (await readFile(join(dir, "raw", "cs-cs-CR.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.id), ["2607.00001", "2607.00002", "2607.00003"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the rows are the SAME shape scripts/arxiv-harvest.mjs emits", async () => {
  // The load-bearing claim of the channel: arxiv-corpus.mjs, arxiv-index.mjs
  // and arxiv-vectorize.mjs consume this JSONL unchanged. It holds by
  // construction — parseRecord is imported, not reimplemented — and this pins
  // it so a future "small tweak" here shows up as a failing test.
  const dir = await outDir();
  try {
    await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async () => page([record("2607.00042")], null),
    });
    const row = JSON.parse((await readFile(join(dir, "raw", "cs-cs-CR.jsonl"), "utf8")).trim());
    const direct = parseRecord(record("2607.00042"));
    assert.deepEqual(Object.keys(row), Object.keys(direct), "same keys, same order");
    assert.deepEqual(row, direct);
    assert.equal(row.title, "Private Retrieval over Scientific Corpora", "wrapped titles collapse to one line");
    assert.deepEqual(row.categories, ["cs.CR", "cs.IR"]);
    assert.equal(row.primary, "cs.CR");
    assert.ok(row.abstract.includes("privacy & report"), "entities decoded");
    // And it survives the leg that consumes it.
    assert.equal(vectorMetadata(row).c, "cs.CR");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleted and abstract-less records are seen but not kept", async () => {
  const dir = await outDir();
  try {
    const r = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async () => page([record("2607.00001"), record("2607.00002", { deleted: true }), record("2607.00003", { abstract: "" })], null),
    });
    assert.equal(r.seen, 3);
    assert.equal(r.kept, 1, "seen is records off the wire; kept is rows the index can use");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted set resumes from its checkpoint instead of restarting", async () => {
  // The corpus is gitignored and the container is ephemeral, so a harvest that
  // cannot resume is a harvest that gets re-paid for.
  const dir = await outDir();
  try {
    const first = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      maxPages: 1,
      log: () => {},
      fetchXml: async () => page([record("2607.00001")], "tok-page-2"),
    });
    assert.equal(first.kept, 1);
    assert.ok(!first.done, "stopped at --max-pages, not finished");
    const state = JSON.parse(await readFile(join(dir, "state", "cs-cs-CR.json"), "utf8"));
    assert.equal(state.token, "tok-page-2");
    assert.equal(state.done, false);

    /** @type {Array<string|undefined>} */
    const tokens = [];
    const second = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async (req) => {
        tokens.push(req.token);
        return page([record("2607.00002")], null);
      },
    });
    assert.deepEqual(tokens, ["tok-page-2"], "the resume continues the token, it does not re-ask the first page");
    assert.equal(second.kept, 2, "the counters continue too");
    assert.equal(second.pages, 2);
    const rows = (await readFile(join(dir, "raw", "cs-cs-CR.jsonl"), "utf8")).trim().split("\n");
    assert.equal(rows.length, 2, "a resume APPENDS — page one is not written twice");

    // A finished set is not re-fetched.
    let called = false;
    const third = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async () => {
        called = true;
        return page([], null);
      },
    });
    assert.ok(!called);
    assert.equal(third.kept, 2);
    assert.ok(third.done);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a checkpoint from a different --from window is discarded, not continued", async () => {
  // arXiv puts the window INSIDE the resumption token, so continuing a token
  // taken under `from=2026-07-25` while the run claims `from=2026-01-01` would
  // harvest the old window and append it to the shard — leaving a file whose
  // coverage nobody can state afterwards.
  const dir = await outDir();
  try {
    await writeFile(
      join(dir, "state", "cs-cs-CR.json"),
      JSON.stringify({ set: "cs:cs:CR", from: "2026-07-25", token: "old-window-token", kept: 5, seen: 5, pages: 1, done: false }),
    );
    await writeFile(join(dir, "raw", "cs-cs-CR.jsonl"), "stale\n");
    /** @type {Array<string|undefined>} */
    const tokens = [];
    const r = await harvestSet("cs:cs:CR", {
      outDir: dir,
      from: "2026-01-01",
      pauseMs: 0,
      log: () => {},
      fetchXml: async (req) => {
        tokens.push(req.token);
        return page([record("2607.00009")], null);
      },
    });
    assert.deepEqual(tokens, [""], "the stale token is not sent");
    assert.equal(r.kept, 1, "counters start over");
    assert.equal((await readFile(join(dir, "raw", "cs-cs-CR.jsonl"), "utf8")).trim(), JSON.stringify(parseRecord(record("2607.00009"))), "and the shard is truncated, not appended to");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale resumption token restarts the set once, then fails loudly", async () => {
  const dir = await outDir();
  try {
    await writeFile(join(dir, "state", "cs-cs-CR.json"), JSON.stringify({ set: "cs:cs:CR", from: "", token: "expired", kept: 3, seen: 3, pages: 2, done: false }));
    let calls = 0;
    const r = await harvestSet("cs:cs:CR", {
      outDir: dir,
      pauseMs: 0,
      log: () => {},
      fetchXml: async (req) => {
        calls++;
        if (req.token) return `<OAI-PMH><error code="badResumptionToken">expired</error></OAI-PMH>`;
        return page([record("2607.00001")], null);
      },
    });
    assert.equal(calls, 2, "one rejected continuation, then a clean sweep from the top");
    assert.equal(r.kept, 1, "the counters restart with the sweep rather than carrying the abandoned page");

    // A feed that rejects every CONTINUATION must fail rather than loop: the
    // restart would hit the same wall on its own second page for ever.
    await writeFile(join(dir, "state", "cs-cs-CR.json"), JSON.stringify({ set: "cs:cs:CR", from: "", token: "expired", kept: 0, seen: 0, pages: 1, done: false }));
    await assert.rejects(
      () =>
        harvestSet("cs:cs:CR", {
          outDir: dir,
          pauseMs: 0,
          log: () => {},
          fetchXml: async (req) =>
            req.token ? `<OAI-PMH><error code="badResumptionToken">expired</error></OAI-PMH>` : page([record("2607.00001")], "expired-again"),
        }),
      /rejected the resumption token twice/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("noRecordsMatch is an empty delta, any other OAI error is a failure", async () => {
  const dir = await outDir();
  try {
    const r = await harvestSet("cs:cs:CR", {
      outDir: dir,
      from: "2026-08-09",
      pauseMs: 0,
      log: () => {},
      fetchXml: async () => `<OAI-PMH><error code="noRecordsMatch">nothing</error></OAI-PMH>`,
    });
    assert.equal(r.kept, 0);
    assert.ok(r.done, "an empty delta is complete, not interrupted — the next run must not re-sweep it");
    await assert.rejects(
      () => harvestSet("cs:cs:CR", { outDir: dir, pauseMs: 0, log: () => {}, fetchXml: async () => `<OAI-PMH><error code="badArgument">no such set</error></OAI-PMH>` }),
      /OAI error badArgument on set cs:cs:CR/,
    );
    assert.ok((await readdir(join(dir, "raw"))).includes("cs-cs-CR.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
