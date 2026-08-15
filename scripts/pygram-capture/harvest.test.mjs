// Unit tests for the pygram capture harvester (scripts/pygram-capture/harvest.mjs).
//
// The corpus this thing writes is COMMITTED and is the spec pygram gets built
// against, so the three properties that matter are pinned hard:
//   1. DEDUP — the same program, however often and from wherever it was seen,
//      is one record; two different programs are never collapsed.
//   2. NORMALIZATION — cosmetic differences (line endings, trailing spaces,
//      surrounding blank lines) do not mint a second record, but indentation
//      does, because indentation is Python syntax.
//   3. IDEMPOTENCY — re-running over the same inputs changes nothing, which is
//      what makes the harvest safe to wire into a loop.
// Plus the privacy contract: nothing credential-shaped reaches the corpus.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeProgram,
  programId,
  redactSecrets,
  envSecretValues,
  shellTokens,
  splitHeredocs,
  extractPythonPrograms,
  looksPythonish,
  sightingsFromLog,
  sightingsFromTranscript,
  sightingsFromExport,
  serializeSightings,
  sightingsFileName,
  exportSightings,
  listSightingFiles,
  mergeSightings,
  seedIds,
  parseCorpus,
  serializeCorpus,
  harvest,
  parseArgs,
  SOURCE_RANK,
} from "./harvest.mjs";

const logLine = (o) => JSON.stringify({ kind: "python_invocation", ts: "2026-08-13T10:00:00.000Z", ...o });

// ------------------------------------------------------------ normalization --

test("normalizeProgram: line endings, trailing spaces and outer blank lines are cosmetic", () => {
  const a = "print(1)\nprint(2)";
  assert.equal(normalizeProgram("print(1)\r\nprint(2)"), a);
  assert.equal(normalizeProgram("print(1)   \nprint(2)\t"), a);
  assert.equal(normalizeProgram("\n\nprint(1)\nprint(2)\n\n"), a);
});

test("normalizeProgram: INDENTATION is syntax, not whitespace noise", () => {
  assert.notEqual(normalizeProgram("if x:\n    pass"), normalizeProgram("if x:\n  pass"));
});

test("programId: stable, prefixed, and equal exactly when the normalized text is", () => {
  assert.match(programId("print(1)"), /^py-[0-9a-f]{12}$/);
  assert.equal(programId("print(1)\n"), programId("\nprint(1)   "));
  assert.notEqual(programId("print(1)"), programId("print(2)"));
});

// ----------------------------------------------------------------- redaction --

test("redactSecrets: credential-shaped tokens are replaced, and the marker is stable", () => {
  const fake = "sk-" + "A".repeat(30);
  const once = redactSecrets(`import os; os.environ["K"]="${fake}"`);
  assert.equal(once.hits, 1);
  assert.ok(!once.text.includes(fake));
  assert.match(once.text, /\[REDACTED sk-A \d+ chars\]/);
  // Idempotent: the marker itself must never re-match on a second pass.
  const twice = redactSecrets(once.text);
  assert.equal(twice.hits, 0);
  assert.equal(twice.text, once.text);
});

test("redactSecrets: ordinary python is left byte-identical", () => {
  const src = "print('sk-short'); x = AKIA_lower";
  assert.deepEqual(redactSecrets(src), { text: src, hits: 0 });
});

test("mergeSightings: a program carrying a secret is redacted BEFORE it is hashed", () => {
  const fake = "ghp_" + "b".repeat(30);
  const { records } = mergeSightings([], [{ key: "shim:l#1", source: "shim", program: `t="${fake}"`, argv_tail: [], ts: "2026-01-01T00:00:00Z" }]);
  assert.equal(records.length, 1);
  assert.ok(!records[0].program.includes(fake));
  // The id must be derivable from what was WRITTEN, or a re-harvest would fork.
  assert.equal(records[0].id, programId(records[0].program));
});

// ------------------------------------------------------- command extraction --

test("shellTokens: quoting survives, operators come back as their own tokens", () => {
  assert.deepEqual(shellTokens(`python3 -c 'print("a b")' x`), ["python3", "-c", 'print("a b")', "x"]);
  assert.deepEqual(shellTokens(`a && b | c`), ["a", "&&", "b", "|", "c"]);
  assert.deepEqual(shellTokens(`python -c "print(\\"q\\")"`), ["python", "-c", 'print("q")']);
});

test("extractPythonPrograms: -c programs, with the argv tail, across runners", () => {
  assert.deepEqual(extractPythonPrograms(`python3 -c 'print(1)'`), [{ program: "print(1)", argv_tail: [] }]);
  assert.deepEqual(extractPythonPrograms(`python -c 'import sys;print(sys.argv)' a b`), [
    { program: "import sys;print(sys.argv)", argv_tail: ["a", "b"] },
  ]);
  assert.deepEqual(extractPythonPrograms(`uv run python -c 'print(2)'`), [{ program: "print(2)", argv_tail: [] }]);
  assert.deepEqual(extractPythonPrograms(`py -c "print(3)"`), [{ program: "print(3)", argv_tail: [] }]);
});

test("extractPythonPrograms: a script or module invocation carries no inline source", () => {
  assert.deepEqual(extractPythonPrograms("python3 build.py --fast"), []);
  assert.deepEqual(extractPythonPrograms("python3 -m json.tool file.json"), []);
  assert.deepEqual(extractPythonPrograms("ls -la | wc -l"), []);
});

test("extractPythonPrograms: heredoc bodies, quoted and tab-stripped", () => {
  const cmd = ["python3 <<'PY'", "import json", "print(json.dumps({'a': 1}))", "PY"].join("\n");
  assert.deepEqual(extractPythonPrograms(cmd), [{ program: "import json\nprint(json.dumps({'a': 1}))", argv_tail: [] }]);
  const dashed = ["python3 <<-PY", "\tprint(1)", "\tPY"].join("\n");
  assert.deepEqual(extractPythonPrograms(dashed), [{ program: "print(1)", argv_tail: [] }]);
  // A heredoc fed to something that is not python is not python.
  assert.deepEqual(extractPythonPrograms("cat <<'TXT'\nhello\nTXT"), []);
});

test("extractPythonPrograms: a command that only TALKS about a heredoc is not one", () => {
  // Found in the first live harvest: a shell command that echoes a JSON payload
  // containing `python3 <<'PY'` was read as opening a heredoc whose delimiter
  // was the quote character, and swallowed the rest of the script as "python".
  const cmd = [
    `p '{"tool_input":{"command":"python3 <<'"'"'PY'"'"'\\nimport json\\nPY"}}'`,
    `p 'not json at all'`,
    `echo done`,
  ].join("\n");
  assert.deepEqual(extractPythonPrograms(cmd), []);
  // A herestring is not a heredoc either.
  assert.deepEqual(extractPythonPrograms("python3 -m json.tool <<<'{}'"), []);
});

test("extractPythonPrograms: several programs in one command line", () => {
  const cmd = `python3 -c 'print(1)' && python3 -c 'print(2)'`;
  assert.deepEqual(
    extractPythonPrograms(cmd).map((p) => p.program),
    ["print(1)", "print(2)"],
  );
});

test("splitHeredocs / looksPythonish: the gate that decides what is even scanned", () => {
  const { heredocs } = splitHeredocs("python3 <<'PY'\nx\nPY");
  assert.equal(heredocs.length, 1);
  assert.equal(heredocs[0].delim, "PY");
  assert.ok(looksPythonish("python3 -c 'x'"));
  assert.ok(looksPythonish("uv run foo.py"));
  assert.ok(!looksPythonish("git status"));
});

// -------------------------------------------------------------------- input --

test("sightingsFromLog: shim records keyed by line, hook records mined for programs", () => {
  const text = [
    logLine({ program: "print(1)", argv_tail: ["x"] }),
    JSON.stringify({ kind: "exit", ts: "2026-08-13T10:00:01Z", exit_code: 0, wall_ms: 12 }),
    logLine({ program: null, argv_tail: [] }), // `python --version`: nothing to learn
    JSON.stringify({ kind: "bash_command", ts: "2026-08-13T10:00:02Z", command: `python3 -c 'print(9)'` }),
    "{ not json",
  ].join("\n");
  const s = sightingsFromLog(text, "t");
  assert.deepEqual(
    s.map((x) => [x.source, x.program, x.key]),
    [
      ["shim", "print(1)", "shim:t#1"],
      ["hook", "print(9)", "hook:t#4#0"],
    ],
  );
});

test("sightingsFromTranscript: Bash tool_use inputs only, keyed by tool_use id", () => {
  const text = [
    JSON.stringify({
      timestamp: "2026-08-13T09:00:00Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `python3 -c 'print(7)'` } }] },
    }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "git status" } }] } }),
  ].join("\n");
  const s = sightingsFromTranscript(text, "p/a.jsonl");
  assert.equal(s.length, 1);
  assert.equal(s[0].program, "print(7)");
  assert.equal(s[0].key, "transcript:p/a.jsonl#toolu_1#0");
  assert.equal(s[0].ts, "2026-08-13T09:00:00Z");
});

// -------------------------------------------------------------------- merge --

test("mergeSightings: dedup — one record per distinct program, count = sightings", () => {
  const sightings = [
    { key: "shim:l#1", source: "shim", program: "print(1)", argv_tail: [], ts: "2026-08-13T10:00:00Z" },
    { key: "shim:l#2", source: "shim", program: "print(1)\n", argv_tail: [], ts: "2026-08-13T09:00:00Z" },
    { key: "shim:l#3", source: "shim", program: "print(2)", argv_tail: [], ts: "2026-08-13T11:00:00Z" },
  ];
  const { records } = mergeSightings([], sightings);
  assert.equal(records.length, 2);
  const one = records.find((r) => r.program.startsWith("print(1)"));
  assert.equal(one.count, 2);
  assert.equal(one.first_seen, "2026-08-13T09:00:00Z", "first_seen is the EARLIEST sighting, not the first read");
  assert.equal(records.find((r) => r.program === "print(2)").count, 1);
});

test("mergeSightings: the same sighting key never counts twice", () => {
  const s = { key: "shim:l#1", source: "shim", program: "print(1)", argv_tail: [], ts: "2026-08-13T10:00:00Z" };
  const { records, skipped } = mergeSightings([], [s, { ...s }]);
  assert.equal(records[0].count, 1);
  assert.equal(skipped.duplicateKey, 1);
});

test("mergeSightings: provenance is the STRONGEST source ever seen", () => {
  const { records } = mergeSightings(
    [],
    [
      { key: "transcript:a#1#0", source: "transcript", program: "print(1)", argv_tail: [], ts: "2026-08-13T08:00:00Z" },
      { key: "shim:l#1", source: "shim", program: "print(1)", argv_tail: [], ts: "2026-08-13T10:00:00Z" },
    ],
  );
  assert.equal(records[0].source, "shim");
  assert.ok(SOURCE_RANK.shim > SOURCE_RANK.transcript);
});

test("mergeSightings: existing records survive, counts never shrink, curation wins", () => {
  const existing = [
    { id: programId("print(1)"), program: "print(1)", argv_tail: ["kept"], source: "manual", first_seen: "2026-01-01T00:00:00Z", count: 99, stdin_sample: "1 2 3" },
    { id: programId("gone()"), program: "gone()", argv_tail: [], source: "manual", first_seen: "2026-01-01T00:00:00Z", count: 1, stdin_sample: null },
  ];
  const { records } = mergeSightings(existing, [
    { key: "shim:l#1", source: "shim", program: "print(1)", argv_tail: ["fresh"], ts: "2026-08-13T10:00:00Z" },
  ]);
  assert.equal(records.length, 2, "a record no source produced this run is carried over, not dropped");
  const one = records.find((r) => r.program === "print(1)");
  assert.equal(one.count, 99, "count is max(stored, sightings) — a rotated log cannot erase history");
  assert.equal(one.first_seen, "2026-01-01T00:00:00Z");
  assert.deepEqual(one.argv_tail, ["kept"], "a curated argv_tail is not overwritten");
  assert.equal(one.stdin_sample, "1 2 3");
  assert.equal(one.source, "shim", "provenance still upgrades");
});

test("mergeSightings: empty programs are skipped and records sort by id", () => {
  const { records, skipped } = mergeSightings([], [
    { key: "shim:l#1", source: "shim", program: "   \n  ", argv_tail: [], ts: null },
    { key: "shim:l#2", source: "shim", program: "b()", argv_tail: [], ts: null },
    { key: "shim:l#3", source: "shim", program: "a()", argv_tail: [], ts: null },
  ]);
  assert.equal(skipped.empty, 1);
  assert.deepEqual([...records].map((r) => r.id).sort(), records.map((r) => r.id));
});

test("serializeCorpus / parseCorpus: one JSON object per line, fixed field order, round-trips", () => {
  const { records } = mergeSightings([], [{ key: "shim:l#1", source: "shim", program: "print(1)", argv_tail: ["a"], ts: "2026-08-13T10:00:00Z" }]);
  const text = serializeCorpus(records);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.trim().split("\n").length, 1);
  assert.deepEqual(Object.keys(JSON.parse(text)), ["id", "program", "argv_tail", "source", "first_seen", "count", "stdin_sample"]);
  assert.deepEqual(parseCorpus(text), records);
  assert.deepEqual(serializeCorpus([]), "");
});

// -------------------------------------------------------------- idempotency --

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pygram-harvest-"));
  const log = join(dir, "invocations.jsonl");
  const corpus = join(dir, "corpus.jsonl");
  const transcripts = join(dir, "projects", "proj");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    log,
    [
      logLine({ program: "print(1)", argv_tail: [] }),
      logLine({ program: "print(1)", argv_tail: [] }),
      logLine({ program: "import sys; print(sys.version)", argv_tail: [] }),
      JSON.stringify({ kind: "bash_command", ts: "2026-08-13T10:05:00Z", command: "python3 <<'PY'\nprint(2)\nPY" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(transcripts, "a.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-12T10:00:00Z",
      message: { content: [{ type: "tool_use", id: "toolu_A", name: "Bash", input: { command: `python3 -c 'print(1)'` } }] },
    }) + "\n",
  );
  return { dir, log, corpus, transcripts: join(dir, "projects") };
}

test("harvest: end to end over log + transcripts, then RE-RUN changes nothing", () => {
  const f = fixture();
  const opts = { log: f.log, transcripts: f.transcripts, corpus: f.corpus, transcriptsEnabled: true, dryRun: false };

  const first = harvest(opts);
  assert.equal(first.wrote, true);
  assert.equal(first.total, 3, "print(1), the sys.version one-liner, and the heredoc");
  const afterFirst = readFileSync(f.corpus, "utf8");
  const recs = parseCorpus(afterFirst);
  const one = recs.find((r) => r.program === "print(1)");
  assert.equal(one.count, 3, "twice from the shim log + once from the transcript");
  assert.equal(one.source, "shim");
  assert.equal(one.first_seen, "2026-08-12T10:00:00Z", "the transcript sighting predates the log");
  assert.ok(recs.some((r) => r.program === "print(2)" && r.source === "hook"));

  const second = harvest(opts);
  assert.equal(second.wrote, false, "a re-run must not rewrite the file");
  assert.equal(second.added, 0);
  assert.equal(second.total, first.total);
  assert.equal(readFileSync(f.corpus, "utf8"), afterFirst, "byte-identical on re-run");

  const third = harvest(opts);
  assert.equal(readFileSync(f.corpus, "utf8"), afterFirst, "and still identical on a third run");
});

test("harvest: a new invocation appended to the log adds exactly one record", () => {
  const f = fixture();
  const opts = { log: f.log, transcripts: f.transcripts, corpus: f.corpus, transcriptsEnabled: true, dryRun: false };
  harvest(opts);
  const before = parseCorpus(readFileSync(f.corpus, "utf8")).length;
  writeFileSync(f.log, readFileSync(f.log, "utf8") + logLine({ program: "print(42)", argv_tail: [] }) + "\n");
  const r = harvest(opts);
  assert.equal(r.added, 1);
  assert.equal(r.total, before + 1);
});

test("harvest: --dry-run writes nothing", () => {
  const f = fixture();
  const r = harvest({ log: f.log, transcripts: f.transcripts, corpus: f.corpus, transcriptsEnabled: true, dryRun: true });
  assert.equal(r.wrote, false);
  assert.equal(r.changed, true);
  assert.equal(existsSync(f.corpus), false);
});

test("harvest: missing inputs are not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pygram-empty-"));
  const r = harvest({ log: join(dir, "nope.jsonl"), transcripts: join(dir, "nope"), corpus: join(dir, "corpus.jsonl"), transcriptsEnabled: true, dryRun: false });
  assert.equal(r.total, 0);
  assert.equal(r.sightings, 0);
});

test("parseArgs: flags and defaults", () => {
  const o = parseArgs(["--log", "/l", "--corpus", "/c", "--no-transcripts", "--dry-run"]);
  assert.equal(o.log, "/l");
  assert.equal(o.corpus, "/c");
  assert.equal(o.transcriptsEnabled, false);
  assert.equal(o.dryRun, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

// --- the seed-collision guard -------------------------------------------------
// docs/PYGRAM.md §7 keeps the two corpus files separate so expectation cannot
// inflate the frequency table that decides build order. Separate FILES did not
// achieve that: the conformance runner executes every seed program, and while
// the capture shim was on PATH for those runs each execution was logged as a
// real invocation and merged back. The first harvest ended up with 138 of 197
// "observed" programs byte-identical to seed programs, 139 at count=8.

test("mergeSightings: a sighting identical to a seed program is dropped", () => {
  const seedProg = 'print("seeded")';
  const seen = new Set([programId(seedProg)]);
  const sightings = [
    { key: "shim:l#1", source: "shim", program: seedProg, argv_tail: [], ts: "2026-01-01T00:00:00Z" },
    { key: "shim:l#2", source: "shim", program: 'print("organic")', argv_tail: [], ts: "2026-01-01T00:00:01Z" },
  ];
  const { records, skipped } = mergeSightings([], sightings, seen);
  assert.equal(skipped.seedCollision, 1);
  assert.deepEqual(records.map((r) => r.program), ['print("organic")']);
});

test("mergeSightings: the guard is whitespace-insensitive, like every other id", () => {
  // Normalization is what makes the id stable, so a re-logged seed program that
  // picked up a trailing space or CRLF must not slip past the guard.
  const seen = new Set([programId('print("x")')]);
  const { records, skipped } = mergeSightings([], [
    { key: "shim:l#1", source: "shim", program: 'print("x")  \r\n', argv_tail: [], ts: "2026-01-01T00:00:00Z" },
  ], seen);
  assert.equal(skipped.seedCollision, 1);
  assert.equal(records.length, 0);
});

test("mergeSightings: the guard stops an ALREADY-laundered record's count growing", () => {
  // The 138 contaminated records stay in the committed corpus — this is a guard
  // against new contamination, not a rewrite of evidence — but re-running the
  // conformance suite must no longer inflate them.
  const prog = 'print("seeded")';
  const existing = [{ id: programId(prog), program: prog, argv_tail: [], source: "shim", first_seen: "2026-01-01T00:00:00Z", count: 8, stdin_sample: null }];
  const sightings = Array.from({ length: 5 }, (_, i) => ({ key: `shim:l#${i}`, source: "shim", program: prog, argv_tail: [], ts: "2026-02-01T00:00:00Z" }));
  const { records, skipped } = mergeSightings(existing, sightings, new Set([programId(prog)]));
  assert.equal(skipped.seedCollision, 5);
  assert.equal(records.length, 1);
  assert.equal(records[0].count, 8, "count must not grow from seed-identical sightings");
});

test("mergeSightings: with no seed set the old behaviour is unchanged", () => {
  const { records, skipped } = mergeSightings([], [
    { key: "shim:l#1", source: "shim", program: 'print("x")', argv_tail: [], ts: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(skipped.seedCollision, 0);
  assert.equal(records.length, 1);
});

test("seedIds: reads the seed corpus, tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pygram-seed-"));
  const f = join(dir, "seed.jsonl");
  writeFileSync(f, JSON.stringify({ id: "x", program: 'print("a")' }) + "\n" + JSON.stringify({ id: "y", program: 'print("b")' }) + "\n");
  const ids = seedIds(f);
  assert.equal(ids.size, 2);
  assert.ok(ids.has(programId('print("a")')));
  assert.equal(seedIds(join(dir, "missing.jsonl")).size, 0);
  assert.equal(seedIds("").size, 0);
});

// A hand-applied `tags` array is the ONLY field on a corpus record that cannot
// be re-derived from a sighting, and the conformance runner reads it to exempt
// an entry it must not compare (tests/pygram/conformance.mjs — nondeterministic,
// seeded, interpreter-specific, implementation-defined). The merge rebuilds
// every record from an explicit field list, so `tags` has to be carried through
// deliberately: before it was, tagging an entry "worked" until the next harvest
// silently erased it and CI went red with no diff to explain why. Found on the
// json-error-message divergence (pygram/lib/README.md #19).
test("mergeSightings: a hand-applied tag survives the rebuild", () => {
  // The id must be the program's own hash, as it is in the real corpus —
  // otherwise a later sighting of the same program lands on a different id and
  // the two never meet, which is a property of the test rather than the code.
  const tagged = {
    id: programId("print(1)"), program: "print(1)", argv_tail: [], source: "shim",
    first_seen: "2026-01-01T00:00:00Z", count: 2, stdin_sample: null,
    tags: ["implementation-defined"],
  };
  const { records } = mergeSightings([tagged], []);
  assert.deepEqual(records[0].tags, ["implementation-defined"]);
  // …and survives a sighting landing on the same program, which is the case
  // that actually happens: the entry keeps being invoked.
  const again = mergeSightings([tagged], [
    { key: "shim:l#9", source: "shim", program: "print(1)", argv_tail: [], ts: "2026-02-01T00:00:00Z" },
  ]);
  assert.equal(again.records.length, 1, "the sighting merged onto the tagged record");
  assert.deepEqual(again.records[0].tags, ["implementation-defined"]);
  // A sighting carries no tags of its own, and an untagged record carries no
  // `tags` key at all — see the projection's note on churn and round-tripping.
  const fresh = mergeSightings([], [
    { key: "shim:l#1", source: "shim", program: "print(2)", argv_tail: [], ts: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal("tags" in fresh.records[0], false);
  // Junk in the field is dropped rather than trusted.
  const junk = mergeSightings([{ ...tagged, tags: ["ok", 7, null, { a: 1 }] }], []);
  assert.deepEqual(junk.records[0].tags, ["ok"]);
});

test("serializeCorpus: tags round-trip, and an untagged line is byte-identical", () => {
  const untagged = { id: "u", program: "print(1)", argv_tail: [], source: "shim", first_seen: "t", count: 1, stdin_sample: null };
  // The 200-odd untagged records must not all churn when one entry is tagged,
  // so the key is emitted only when there is something to emit.
  assert.equal(
    serializeCorpus([untagged]).trim(),
    JSON.stringify({ id: "u", program: "print(1)", argv_tail: [], source: "shim", first_seen: "t", count: 1, stdin_sample: null }),
  );
  assert.equal(serializeCorpus([{ ...untagged, tags: [] }]).trim().includes("tags"), false);
  assert.deepEqual(parseCorpus(serializeCorpus(mergeSightings([untagged], []).records)), mergeSightings([untagged], []).records);
  const round = parseCorpus(serializeCorpus([{ ...untagged, tags: ["seeded"] }]));
  assert.deepEqual(round[0].tags, ["seeded"]);
});

test("parseArgs: the seed guard has a path and an escape hatch", () => {
  assert.equal(parseArgs(["--seed", "/s"]).seed, "/s");
  assert.equal(parseArgs(["--no-seed-guard"]).seed, "");
});

// --- durability: the per-session sightings files -------------------------------
// The log lives outside the repo and these containers are ephemeral, so evidence
// only survives if it reaches the tree. Folding it into the single shared
// corpus.jsonl did not achieve that: every session rewrites that one file, so
// branches conflict and the merge never happens. Measured 2026-08-14 — of the 19
// branches cut since the corpus landed, 2 carried growth and neither reached
// main. The durable unit is one file per session, which nothing else writes.

test("sightingsFromLog: the key is namespaced by the session that wrote the record", () => {
  // A line number is unique only inside one container's log. Without the
  // session, session B's line 1 and session A's line 1 are the same key, and
  // one of them is silently dropped as a duplicate when both are folded in.
  const text =
    JSON.stringify({ kind: "python_invocation", ts: "2026-08-13T10:00:00Z", session: "sess-A", program: "print(1)" }) +
    "\n" +
    JSON.stringify({ kind: "bash_command", ts: "2026-08-13T10:00:01Z", session: "sess-A", command: `python3 -c 'print(2)'` }) +
    "\n";
  const s = sightingsFromLog(text, "invocations");
  assert.deepEqual(s.map((x) => x.key), ["shim:sess-A#1", "hook:sess-A#2#0"]);
  assert.deepEqual(s.map((x) => x.session), ["sess-A", "sess-A"]);
});

test("sightingsFromLog: a record with no session falls back to the tag", () => {
  const s = sightingsFromLog(logLine({ program: "print(1)" }) + "\n", "t");
  assert.equal(s[0].key, "shim:t#1");
  assert.equal(s[0].session, null);
});

test("sightingsFromTranscript: the session comes from the transcript filename", () => {
  const text =
    JSON.stringify({
      timestamp: "2026-08-12T10:00:00Z",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `python3 -c 'print(1)'` } }] },
    }) + "\n";
  assert.equal(sightingsFromTranscript(text, "proj/sess-B.jsonl")[0].session, "sess-B");
});

test("sightingsFileName: a session id becomes a safe filename", () => {
  assert.equal(sightingsFileName("42d12fc7-74e1-5f47"), "42d12fc7-74e1-5f47.jsonl");
  assert.equal(sightingsFileName("../../etc/passwd"), ".._.._etc_passwd.jsonl");
  assert.equal(sightingsFileName(""), "unknown.jsonl");
});

test("sightingsFromExport / serializeSightings: a published file round-trips", () => {
  const s = [{ key: "shim:sess-A#1", source: "shim", session: "sess-A", program: "print(1)", argv_tail: ["x"], ts: "2026-08-13T10:00:00Z" }];
  assert.deepEqual(sightingsFromExport(serializeSightings(s)), [{ ...s[0], stdin_sample: null }]);
  assert.deepEqual(sightingsFromExport("not json\n{}\n"), [], "corrupt or programless lines are dropped, not thrown");
});

function exportFixture(records) {
  const dir = mkdtempSync(join(tmpdir(), "pygram-export-"));
  const log = join(dir, "invocations.jsonl");
  writeFileSync(log, records.map((r) => JSON.stringify({ kind: "python_invocation", ts: "2026-08-13T10:00:00.000Z", session: "sess-A", ...r })).join("\n") + "\n");
  return { dir, log, sightings: join(dir, "sightings"), opts: { log, transcriptsEnabled: false, sightings: join(dir, "sightings"), seed: "", dryRun: false } };
}

test("exportSightings: one file per session, named for it", () => {
  const f = exportFixture([{ program: "print(1)" }, { program: "print(2)" }]);
  const r = exportSightings(f.opts);
  assert.equal(r.added, 2);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, join(f.sightings, "sess-A.jsonl"));
  assert.deepEqual(listSightingFiles(f.sightings), [join(f.sightings, "sess-A.jsonl")]);
});

test("exportSightings: re-running is a union by key, byte-identical when nothing is new", () => {
  const f = exportFixture([{ program: "print(1)" }]);
  exportSightings(f.opts);
  const first = readFileSync(join(f.sightings, "sess-A.jsonl"), "utf8");
  const second = exportSightings(f.opts);
  assert.equal(second.added, 0);
  assert.equal(second.files[0].changed, false);
  assert.equal(readFileSync(join(f.sightings, "sess-A.jsonl"), "utf8"), first);

  // A later turn in the same session appends to the log; only the new line lands.
  writeFileSync(f.log, readFileSync(f.log, "utf8") + JSON.stringify({ kind: "python_invocation", ts: "2026-08-13T11:00:00Z", session: "sess-A", program: "print(9)" }) + "\n");
  const third = exportSightings(f.opts);
  assert.equal(third.added, 1);
  assert.equal(sightingsFromExport(readFileSync(join(f.sightings, "sess-A.jsonl"), "utf8")).length, 2);
});

test("exportSightings: published files are redacted and seed-guarded BEFORE they are committed", () => {
  // These files are committed, so the filter runs here — the pre-commit secret
  // scan is the backstop, not the filter. And a seed-identical sighting must
  // not be published at all, or it re-enters the corpus at the next fold and
  // inflates the very frequency table that decides build order.
  const fake = "sk-" + "A".repeat(32);
  const seedProg = 'print("seeded")';
  const f = exportFixture([{ program: `t="${fake}"` }, { program: seedProg }, { program: 'print("organic")' }]);
  const seedFile = join(f.dir, "seed.jsonl");
  writeFileSync(seedFile, JSON.stringify({ id: "s", program: seedProg }) + "\n");
  const r = exportSightings({ ...f.opts, seed: seedFile });
  assert.equal(r.skipped.seedCollision, 1);
  assert.equal(r.redactions, 1);
  const body = readFileSync(join(f.sightings, "sess-A.jsonl"), "utf8");
  assert.equal(body.includes(fake), false, "the raw token must never reach a committed file");
  assert.ok(body.includes("[REDACTED sk-A 35 chars]"));
  assert.equal(body.includes("seeded"), false);
});

test("exportSightings: --dry-run writes nothing", () => {
  const f = exportFixture([{ program: "print(1)" }]);
  const r = exportSightings({ ...f.opts, dryRun: true });
  assert.equal(r.added, 1);
  assert.equal(existsSync(join(f.sightings, "sess-A.jsonl")), false);
});

test("harvest: a published sightings file carries evidence whose log is gone", () => {
  const f = exportFixture([{ program: "print(1)" }, { program: "print(2)" }]);
  exportSightings(f.opts);
  // The container is reclaimed: the log goes with it, the committed file stays.
  const corpus = join(f.dir, "corpus.jsonl");
  const r = harvest({ log: join(f.dir, "gone.jsonl"), transcriptsEnabled: false, sightingsEnabled: true, sightings: f.sightings, corpus, dryRun: false });
  assert.equal(r.sightingFiles, 1);
  assert.deepEqual(parseCorpus(readFileSync(corpus, "utf8")).map((x) => x.program).sort(), ["print(1)", "print(2)"]);
});

test("harvest: the live log and this session's own published file do not double-count", () => {
  // The fold reads both, and both describe the same invocations. Sighting keys
  // are what stop it counting twice — which is exactly why the key had to stop
  // being a bare line number.
  const f = exportFixture([{ program: "print(1)" }, { program: "print(1)" }, { program: "print(1)" }]);
  exportSightings(f.opts);
  const corpus = join(f.dir, "corpus.jsonl");
  const r = harvest({ log: f.log, transcriptsEnabled: false, sightingsEnabled: true, sightings: f.sightings, corpus, dryRun: false });
  assert.equal(r.sightings, 6, "three from the log, three read back from the published file");
  const recs = parseCorpus(readFileSync(corpus, "utf8"));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 3, "three invocations happened, so the count is three");
});

test("harvest: --no-sightings and a missing sightings dir are both fine", () => {
  const f = exportFixture([{ program: "print(1)" }]);
  const corpus = join(f.dir, "corpus.jsonl");
  const off = harvest({ log: f.log, transcriptsEnabled: false, sightingsEnabled: false, sightings: f.sightings, corpus, dryRun: true });
  assert.equal(off.sightingFiles, 0);
  const missing = harvest({ log: f.log, transcriptsEnabled: false, sightingsEnabled: true, sightings: join(f.dir, "nope"), corpus, dryRun: true });
  assert.equal(missing.sightingFiles, 0);
  assert.deepEqual(listSightingFiles(join(f.dir, "nope")), []);
  assert.deepEqual(listSightingFiles(""), []);
});

test("parseArgs: the export path has its own flags", () => {
  const o = parseArgs(["--export", "--sightings", "/s"]);
  assert.equal(o.exportOnly, true);
  assert.equal(o.sightings, "/s");
  assert.equal(parseArgs([]).exportOnly, false);
  assert.equal(parseArgs(["--no-sightings"]).sightingsEnabled, false);
  assert.ok(parseArgs([]).sightings.endsWith(join("tests", "pygram", "sightings")));
});

// --- the shapeless-credential defence -----------------------------------------
// A pattern only catches a secret with a recognisable SHAPE. The most dangerous
// credentials in these containers have none — a Cloudflare API token is 53
// characters of unprefixed base62 — and no regex separates that from a hash or a
// base64 fixture. The harvester runs inside the container that holds them, so it
// matches the literal value instead of guessing. This is the check that stands
// between a captured one-liner and a PUBLIC, auto-deploying repo.

const ENV_FIXTURE = [
  { name: "CLOUDFLARE_API_TOKEN", value: "Zx7QpLmN4vRt2wYk8sHbJc3FdGe6Ua9TnPq5MrVy" },
  { name: "BASIC_AUTH_PASS", value: "correct-horse-battery" },
];

test("envSecretValues: takes credential-named vars, rejects what cannot be one", () => {
  const got = envSecretValues({
    CLOUDFLARE_API_TOKEN: "Zx7QpLmN4vRt2wYk8sHbJc3FdGe6Ua9TnPq5MrVy",
    HUGGINGFACE_API_TOKEN: "h" + "f_" + "a".repeat(34),
    NODE_ENV: "production",                       // not credential-named
    BASIC_AUTH_USER: "admin",                     // credential-named but too short
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", // a file descriptor
    CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/run/secrets/ingress-token", // a path
    HOME: "/root",
  });
  assert.deepEqual(got.map((s) => s.name).sort(), ["CLOUDFLARE_API_TOKEN", "HUGGINGFACE_API_TOKEN"]);
});

test("envSecretValues: longest first, so a nested secret is never left in fragments", () => {
  const got = envSecretValues({ A_TOKEN: "abcdefghijkl", B_TOKEN: "abcdefghijklmnopqrst" });
  assert.deepEqual(got.map((s) => s.name), ["B_TOKEN", "A_TOKEN"]);
});

test("redactSecrets: a LIVE env credential is redacted though no pattern describes it", () => {
  const raw = `import os\ntok="${ENV_FIXTURE[0].value}"\nprint(tok)`;
  // Precondition: the shape defence genuinely cannot see this one.
  assert.equal(redactSecrets(raw, []).hits, 0, "no SECRET_PATTERN matches it — that is the point");
  const { text, hits } = redactSecrets(raw, ENV_FIXTURE);
  assert.equal(hits, 1);
  assert.equal(text.includes(ENV_FIXTURE[0].value), false, "the live token must not survive");
  assert.match(text, /\[REDACTED env CLOUDFLARE_API_TOKEN 40 chars\]/);
});

test("redactSecrets: the marker names the VARIABLE and never the value", () => {
  const { text } = redactSecrets(`p="${ENV_FIXTURE[1].value}"`, ENV_FIXTURE);
  assert.equal(text.includes("correct-horse"), false);
  assert.ok(text.includes("BASIC_AUTH_PASS"));
});

test("redactSecrets: every occurrence goes, not just the first", () => {
  const v = ENV_FIXTURE[0].value;
  const { text } = redactSecrets(`a="${v}"\nb="${v}"\nc="${v}"`, ENV_FIXTURE);
  assert.equal(text.includes(v), false);
  assert.equal(text.split("REDACTED env").length - 1, 3);
});

test("redactSecrets: env redaction is idempotent, like the pattern pass", () => {
  const once = redactSecrets(`t="${ENV_FIXTURE[0].value}"`, ENV_FIXTURE);
  const twice = redactSecrets(once.text, ENV_FIXTURE);
  assert.equal(twice.hits, 0);
  assert.equal(twice.text, once.text);
});

test("redactSecrets: a program with no secret is left byte-identical", () => {
  const src = "import json;print(json.dumps({'token':'x'}))";
  assert.deepEqual(redactSecrets(src, ENV_FIXTURE), { text: src, hits: 0 });
});

test("SECRET_PATTERNS: the shapes that were missing are covered", () => {
  const cases = [
    ["GitHub server token", "gh" + "s_" + "A".repeat(36)],
    ["GitHub oauth token", "gh" + "o_" + "B".repeat(36)],
    ["Hugging Face token", "hf" + "_" + "c".repeat(34)],
    ["Google OAuth client secret", "GOCSPX" + "-" + "d".repeat(28)],
    ["JWT", "ey" + "Jhbgciojissi.eyJzdWIiOiIxMjM0.SflKxwRJSM"],
  ];
  for (const [label, token] of cases) {
    const { text, hits } = redactSecrets(`k="${token}"`, []);
    assert.ok(hits >= 1, `${label} must match a SECRET_PATTERN`);
    assert.equal(text.includes(token), false, `${label} must not survive`);
  }
});

test("mergeSightings: the argv tail is a leak path too, and is redacted", () => {
  // A secret reaches the corpus through `python -c prog SECRET` as readily as
  // through the program text, and the tail is written to the same file.
  const fake = "sk_" + "ber_" + "z".repeat(24);
  const { records } = mergeSightings(
    [],
    [{ key: "shim:s#1", source: "shim", program: `t="${fake}"`, argv_tail: [fake, "--flag"], ts: "2026-01-01T00:00:00Z" }],
    new Set(),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].program.includes(fake), false);
  assert.equal(records[0].argv_tail.join(" ").includes(fake), false);
  // The id must be a function of what was WRITTEN, or a re-harvest forks it.
  assert.equal(records[0].id, programId(records[0].program));
});

test("mergeSightings: a LIVE env credential does not survive the production path", () => {
  // mergeSightings redacts against the module's own view of the environment —
  // there is no seam to inject a fixture, which is correct in production and is
  // exactly why this test uses a real value rather than a made-up one. It is
  // matched and asserted, never written or printed. Skips where nothing is set.
  const live = envSecretValues();
  if (!live.length) return;
  const { value } = live[0];
  const { records } = mergeSightings(
    [],
    [{ key: "shim:s#1", source: "shim", program: `t="${value}"`, argv_tail: [value], ts: "2026-01-01T00:00:00Z" }],
    new Set(),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].program.includes(value), false, "a live credential reached a corpus record");
  assert.equal(records[0].argv_tail.join(" ").includes(value), false);
  assert.match(records[0].program, /\[REDACTED env /);
});

test("the committed corpus and sightings carry no live env credential", () => {
  // The standing guard: this suite runs in the container that holds the real
  // secrets, so it can assert the real thing rather than a fixture.
  const live = envSecretValues();
  const root = join(import.meta.dirname, "..", "..", "tests", "pygram");
  const files = [join(root, "corpus.jsonl"), join(root, "seed-corpus.jsonl")];
  const sightingsDir = join(root, "sightings");
  if (existsSync(sightingsDir)) {
    for (const f of readdirSync(sightingsDir)) if (f.endsWith(".jsonl")) files.push(join(sightingsDir, f));
  }
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const { name, value } of live) {
      assert.equal(text.includes(value), false, `${name} appears verbatim in ${f} — rotate it, then purge history`);
    }
  }
});

test("envSecretValues: the three non-credential shapes live in THIS container", () => {
  // Every one of these was found set, under a name matching the credential
  // regex, in the container that runs the harvest. Treating any of them as a
  // secret would corrupt captured programs and block unrelated commits — a
  // false positive here is not cosmetic, it rewrites committed evidence.
  const got = envSecretValues({
    GIT_CONFIG_KEY_0: "credential.interactive",             // dotted config key
    GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",  // a URL
    GH_TOKEN: "proxy-injected",                             // the proxy sentinel
    SOME_TOKEN: "a value with spaces in it",                // prose, not a token
    REAL_API_TOKEN: "Zx7QpLmN4vRt2wYk8sHbJc3FdGe6Ua9T",     // a credential
    BASIC_AUTH_PASS: "correct-horse-battery",               // also a credential
  });
  assert.deepEqual(got.map((s) => s.name).sort(), ["BASIC_AUTH_PASS", "REAL_API_TOKEN"]);
});

test("envSecretValues: the placeholder check is case-insensitive", () => {
  assert.deepEqual(envSecretValues({ A_TOKEN: "PROXY-INJECTED", B_TOKEN: "ChangeMe" }), []);
});
