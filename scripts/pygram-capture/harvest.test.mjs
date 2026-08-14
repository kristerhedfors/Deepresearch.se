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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeProgram,
  programId,
  redactSecrets,
  shellTokens,
  splitHeredocs,
  extractPythonPrograms,
  looksPythonish,
  sightingsFromLog,
  sightingsFromTranscript,
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
