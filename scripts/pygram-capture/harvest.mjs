// pygram-capture harvester: turn captured python invocations into the corpus
// that pygram (the minimal Python-subset runtime) is measured against.
//
//   node scripts/pygram-capture/harvest.mjs [options]
//
//     --log PATH          shim/hook log (default $PYGRAM_LOG or ~/.pygram/invocations.jsonl)
//     --transcripts DIR   Claude Code transcript root (default ~/.claude/projects)
//     --corpus PATH       corpus to merge into (default tests/pygram/corpus.jsonl)
//     --no-transcripts    skip the transcript scan
//     --dry-run           report what would change, write nothing
//     --quiet             summary line only
//     --json              print the summary as JSON
//
// Three inputs, one output:
//   (a) the JSONL log written by scripts/pygram-capture/python-shim (every run
//       that reached an interpreter) and by .claude/hooks/pygram-capture.sh
//       (every Bash command that mentioned python),
//   (b) Claude Code transcripts — Bash tool_use inputs whose command is
//       python-ish, which is how sessions from BEFORE the shim was installed
//       still contribute,
//   (c) the existing corpus, whose records are never lost.
//
// One record per DISTINCT program, keyed by a hash of the NORMALIZED program
// text, so `print(1)` logged a hundred times is one record with count=100.
//
// SAFE TO RE-RUN: every count is derived from stable sighting keys (log line
// number, transcript tool_use id) rather than incremented, so running the
// harvest twice over the same inputs produces a byte-identical corpus.
//
// PRIVACY: the log can contain repo content, and the corpus is COMMITTED.
// Every program, argv tail, and stdin sample is passed through the repo's
// canonical credential patterns (the same set as scripts/scan-secrets) and
// matches are replaced with a redaction marker before anything is written.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Provenance ranking. A shim record proves the program actually RAN, which is
 *  stronger evidence than a command string that merely mentions python. */
export const SOURCE_RANK = { shim: 3, hook: 2, transcript: 1, manual: 0 };

/** Canonical credential patterns — kept in sync with scripts/scan-secrets (the
 *  security-posture skill §1 owns the list). Written so this file does not
 *  self-match: every literal prefix is followed by a bracketed character class,
 *  which is not itself a member of that class. */
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{24,}/g,
  /sk_ber_[A-Za-z0-9_-]{8,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /xox[bpoas]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Largest program kept. A multi-megabyte heredoc is a data blob, not a
 *  one-liner pygram has to run. */
export const MAX_PROGRAM_BYTES = 64 * 1024;

// ---------------------------------------------------------------- redaction --

/** Replace credential-shaped tokens with a marker that carries only the
 *  provider prefix and the length. Idempotent: the marker cannot re-match. */
export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return { text: text ?? "", hits: 0 };
  let hits = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), (m) => {
      hits++;
      return `[REDACTED ${m.slice(0, 4)} ${m.length} chars]`;
    });
  }
  return { text: out, hits };
}

// ------------------------------------------------------------ normalization --

/** Dedup key text. Line endings unified, trailing whitespace per line dropped,
 *  outer blank lines dropped. Indentation is NOT touched — it is syntax in
 *  Python, and two programs that differ only in indentation are two programs. */
export function normalizeProgram(src) {
  if (typeof src !== "string") return "";
  const lines = src.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/** Stable id for a program: `py-` + 12 hex of the normalized text's sha256. */
export function programId(src) {
  return "py-" + createHash("sha256").update(normalizeProgram(src), "utf8").digest("hex").slice(0, 12);
}

// -------------------------------------------------- shell command extraction --

const PY_WORD = /^(?:python[0-9.]*|py)$/;
const SEPARATORS = new Set([";", "|", "||", "&&", "&", "(", ")", "\n", "{", "}"]);
const RUNNERS = new Set(["uv", "pipx", "poetry", "hatch", "pdm", "rye"]);

/** Does this command string look like it invokes python at all? */
export function looksPythonish(command) {
  if (typeof command !== "string" || !command) return false;
  return (
    /(?:^|[\s;&|(){}`$"'=])python[0-9.]*(?:\s|$)/.test(command) ||
    /(?:^|[\s;&|(){}`$])py\s+-c(?:\s|$)/.test(command) ||
    /(?:^|[\s;&|(){}`$])(?:uv|pipx|poetry|hatch|pdm|rye)\s+run(?:\s|$)/.test(command) ||
    /<<-?\s*['"]?(?:PY|PYTHON|PYEOF|EOFPY)\b/.test(command)
  );
}

/** A heredoc delimiter is a shell word. Anything else — a stray quote picked up
 *  from a `<<` that lives INSIDE a quoted string, which is how a command that
 *  merely TALKS about a heredoc gets mistaken for one — is not a heredoc. */
const HEREDOC_DELIM = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split heredoc bodies out of a command, so the body is never tokenized as
 *  shell words. Returns the command with the bodies removed plus one entry per
 *  heredoc: { delim, body, header } where header is the line that opened it. */
export function splitHeredocs(command) {
  const lines = String(command).split("\n");
  const heredocs = [];
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `(?:^|[^<])` keeps a herestring (`<<<word`) from reading as a heredoc.
    const m = /(?:^|[^<])<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    if (!m || !HEREDOC_DELIM.test(m[2] ?? m[3] ?? m[4] ?? "")) {
      kept.push(line);
      continue;
    }
    const dash = m[1] === "-";
    const delim = m[2] ?? m[3] ?? m[4];
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      // `<<-DELIM` strips leading TABS from the body and the terminator; the
      // trim() on the comparison is deliberate slack for hand-written commands.
      const probe = dash ? lines[j].replace(/^\t+/, "") : lines[j];
      if (probe.trim() === delim) break;
      body.push(probe);
    }
    heredocs.push({ delim, body: body.join("\n"), header: line });
    // m.index can point one char BEFORE `<<` because of the leading group.
    kept.push(line.slice(0, m.index + (m[0].startsWith("<<") ? 0 : 1)));
    i = j; // skip body + terminator
  }
  return { stripped: kept.join("\n"), heredocs };
}

/** Minimal shell word splitter: enough to find `-c <program>` without being
 *  fooled by quoting. Unquoted operators come back as their own tokens. */
export function shellTokens(str) {
  const tokens = [];
  let cur = "";
  let started = false;
  const push = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'") {
      started = true;
      const end = str.indexOf("'", i + 1);
      if (end === -1) {
        cur += str.slice(i + 1);
        i = str.length;
      } else {
        cur += str.slice(i + 1, end);
        i = end;
      }
      continue;
    }
    if (c === '"') {
      started = true;
      let j = i + 1;
      for (; j < str.length; j++) {
        if (str[j] === "\\" && j + 1 < str.length && '"\\$`\n'.includes(str[j + 1])) {
          if (str[j + 1] !== "\n") cur += str[j + 1];
          j++;
          continue;
        }
        if (str[j] === '"') break;
        cur += str[j];
      }
      i = j;
      continue;
    }
    if (c === "\\" && i + 1 < str.length) {
      if (str[i + 1] === "\n") {
        i++;
        continue;
      }
      started = true;
      cur += str[i + 1];
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      push();
      let op = c;
      if ((c === "&" || c === "|") && str[i + 1] === c) {
        op = c + c;
        i++;
      }
      tokens.push(op);
      continue;
    }
    started = true;
    cur += c;
  }
  push();
  return tokens;
}

/** Every python program embedded in a Bash command string: `-c` arguments and
 *  heredoc bodies fed to an interpreter. Order is stable (heredocs last). */
export function extractPythonPrograms(command) {
  if (typeof command !== "string" || !command) return [];
  const found = [];
  const { stripped, heredocs } = splitHeredocs(command);
  const tokens = shellTokens(stripped);

  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (RUNNERS.has(t) && tokens[i + 1] === "run") {
      i += 1;
      // `uv run python -c …` and `uv run -c …` (the latter is not a thing, but
      // the scan is cheap) both continue from here.
      if (PY_WORD.test(tokens[i + 1] || "")) i += 1;
      t = "python";
    } else if (!PY_WORD.test(t)) {
      continue;
    }
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[j];
      if (SEPARATORS.has(a)) break;
      if (a === "-c") {
        const prog = tokens[j + 1];
        if (typeof prog === "string" && prog.trim()) {
          const tail = [];
          for (let k = j + 2; k < tokens.length && !SEPARATORS.has(tokens[k]); k++) tail.push(tokens[k]);
          found.push({ program: prog, argv_tail: tail });
        }
        break;
      }
      if (a === "-m" || !a.startsWith("-")) break; // module or script path: no inline source
    }
  }

  for (const hd of heredocs) {
    if (!hd.body.trim()) continue;
    if (!looksPythonish(hd.header) && !/^(?:PY|PYTHON|PYEOF|EOFPY)$/i.test(hd.delim)) continue;
    found.push({ program: hd.body, argv_tail: [] });
  }
  return found;
}

// ------------------------------------------------------------------ inputs ---

/** Sightings from one shim/hook log file. The key is the line number, which is
 *  stable because the log is append-only. */
export function sightingsFromLog(text, tag = "log") {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.kind === "python_invocation") {
      if (typeof rec.program !== "string" || !rec.program.trim()) continue;
      out.push({
        key: `shim:${tag}#${i + 1}`,
        source: "shim",
        program: rec.program,
        argv_tail: Array.isArray(rec.argv_tail) ? rec.argv_tail.map(String) : [],
        ts: typeof rec.ts === "string" ? rec.ts : null,
        stdin_sample: null,
      });
    } else if (rec.kind === "bash_command" && typeof rec.command === "string") {
      const progs = extractPythonPrograms(rec.command);
      progs.forEach((p, n) => {
        out.push({
          key: `hook:${tag}#${i + 1}#${n}`,
          source: "hook",
          program: p.program,
          argv_tail: p.argv_tail,
          ts: typeof rec.ts === "string" ? rec.ts : null,
          stdin_sample: null,
        });
      });
    }
    // {"kind":"exit"} records carry no program — they exist for timing analysis.
  }
  return out;
}

/** Sightings from one Claude Code transcript (.jsonl). Only Bash tool_use
 *  inputs are read; the key is the tool_use id, which never changes. */
export function sightingsFromTranscript(text, tag = "transcript") {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_use" || block.name !== "Bash") continue;
      const command = block?.input?.command;
      if (typeof command !== "string" || !looksPythonish(command)) continue;
      const id = block.id || "noid";
      extractPythonPrograms(command).forEach((p, n) => {
        out.push({
          key: `transcript:${tag}#${id}#${n}`,
          source: "transcript",
          program: p.program,
          argv_tail: p.argv_tail,
          ts: typeof ev.timestamp === "string" ? ev.timestamp : null,
          stdin_sample: null,
        });
      });
    }
  }
  return out;
}

/** All *.jsonl under a directory tree, sorted for deterministic ordering. */
export function listTranscripts(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

// ------------------------------------------------------------------- merge ---

export function parseCorpus(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.program === "string") out.push(rec);
    } catch {
      // a corrupt line is dropped rather than allowed to fail the harvest
    }
  }
  return out;
}

export function serializeCorpus(records) {
  return records
    .map((r) =>
      JSON.stringify({
        id: r.id,
        program: r.program,
        argv_tail: r.argv_tail ?? [],
        source: r.source,
        first_seen: r.first_seen ?? null,
        count: r.count ?? 1,
        stdin_sample: r.stdin_sample ?? null,
      }),
    )
    .join("\n") + (records.length ? "\n" : "");
}

const earlier = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
};

/**
 * Merge sightings into existing corpus records.
 *
 * - Programs are redacted BEFORE hashing, so an id is a function of what gets
 *   written — recomputing it from a stored record gives the same answer.
 * - `count` is max(stored, distinct sighting keys): it grows with new evidence
 *   and never shrinks when a log is rotated away, and re-running changes nothing.
 * - `source` is the strongest provenance ever seen for the program.
 * - existing text/argv_tail/stdin_sample win, so a hand-curated record survives.
 *
 * `seedIds` is the set of programIds in seed-corpus.jsonl, and a sighting whose
 * program is byte-identical to a seed program is DROPPED — see SEED COLLISION
 * below. Defaults to empty so a caller that does not care keeps the old
 * behaviour.
 */
export function mergeSightings(existingRecords, sightings, seedIds = new Set()) {
  const byId = new Map();
  let redactions = 0;

  for (const rec of existingRecords) {
    const { text: program, hits } = redactSecrets(rec.program);
    redactions += hits;
    const id = rec.id || programId(program);
    byId.set(id, {
      id,
      program,
      argv_tail: Array.isArray(rec.argv_tail) ? rec.argv_tail : [],
      source: rec.source && rec.source in SOURCE_RANK ? rec.source : "manual",
      first_seen: rec.first_seen ?? null,
      count: Number.isFinite(rec.count) && rec.count > 0 ? Math.floor(rec.count) : 1,
      stdin_sample: rec.stdin_sample ?? null,
      keys: new Set(),
      fresh: false,
    });
  }

  const skipped = { empty: 0, oversized: 0, duplicateKey: 0, seedCollision: 0 };
  const seenKeys = new Set();
  const ordered = [...sightings].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const s of ordered) {
    if (seenKeys.has(s.key)) {
      skipped.duplicateKey++;
      continue;
    }
    seenKeys.add(s.key);
    const { text: program, hits } = redactSecrets(s.program);
    redactions += hits;
    if (!normalizeProgram(program)) {
      skipped.empty++;
      continue;
    }
    if (Buffer.byteLength(program, "utf8") > MAX_PROGRAM_BYTES) {
      skipped.oversized++;
      continue;
    }
    const tail = (s.argv_tail ?? []).map((t) => redactSecrets(String(t)).text);
    const id = programId(program);
    // SEED COLLISION. docs/PYGRAM.md §7 requires the two corpus files stay
    // separate, because blending them lets expectation inflate the frequency
    // table that decides build order. Keeping them as separate FILES does not
    // achieve that on its own: the conformance runner EXECUTES every seed
    // program, and until the capture shim was excluded from those runs each
    // execution was logged as a real invocation and merged back in here. That
    // is how the first harvest ended up with 138 of its 197 "observed"
    // programs byte-identical to seed programs, 139 of them at count=8.
    //
    // So the rule is enforced where it was being broken. A sighting matching a
    // seed program is dropped rather than merged — which also stops an
    // already-laundered record's count from growing further, since the count is
    // the max over sighting keys. Existing records are NOT deleted: this is a
    // guard against new contamination, not a rewrite of committed evidence.
    //
    // The cost is that a genuine agent invocation which happens to be
    // byte-identical to one of the 153 hand-written seeds is lost. That trade
    // is deliberate: such a collision tells us nothing the seed did not already
    // say, while a false observation corrupts the one table that ranks work.
    if (seedIds.has(id)) {
      skipped.seedCollision++;
      continue;
    }
    let rec = byId.get(id);
    if (!rec) {
      rec = {
        id,
        program,
        argv_tail: tail,
        source: s.source,
        first_seen: s.ts ?? null,
        count: 0,
        stdin_sample: s.stdin_sample ?? null,
        keys: new Set(),
        fresh: true,
      };
      byId.set(id, rec);
    }
    rec.keys.add(s.key);
    rec.first_seen = earlier(rec.first_seen, s.ts ?? null);
    if (SOURCE_RANK[s.source] > SOURCE_RANK[rec.source]) rec.source = s.source;
    if (!rec.argv_tail.length && tail.length) rec.argv_tail = tail;
    if (rec.stdin_sample == null && s.stdin_sample != null) rec.stdin_sample = s.stdin_sample;
  }

  const records = [...byId.values()].map((r) => ({
    id: r.id,
    program: r.program,
    argv_tail: r.argv_tail,
    source: r.source,
    first_seen: r.first_seen,
    count: Math.max(r.count, r.keys.size) || 1,
    stdin_sample: r.stdin_sample,
  }));
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const added = [...byId.values()].filter((r) => r.fresh).length;
  return { records, added, redactions, skipped };
}

// -------------------------------------------------------------------- main ---

export function defaultPaths(env = process.env) {
  const home = env.HOME || homedir() || "";
  return {
    log: env.PYGRAM_LOG || (home ? join(home, ".pygram", "invocations.jsonl") : ""),
    transcripts: env.PYGRAM_TRANSCRIPTS || (home ? join(home, ".claude", "projects") : ""),
    corpus: env.PYGRAM_CORPUS || join(ROOT, "tests", "pygram", "corpus.jsonl"),
    seed: env.PYGRAM_SEED || join(ROOT, "tests", "pygram", "seed-corpus.jsonl"),
  };
}

export function parseArgs(argv) {
  const opts = { ...defaultPaths(), transcriptsEnabled: true, dryRun: false, quiet: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") opts.log = argv[++i];
    else if (a === "--transcripts") opts.transcripts = argv[++i];
    else if (a === "--corpus") opts.corpus = argv[++i];
    else if (a === "--seed") opts.seed = argv[++i];
    else if (a === "--no-seed-guard") opts.seed = "";
    else if (a === "--no-transcripts") opts.transcriptsEnabled = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const readIfExists = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
};

/** programIds of every seed program, for the seed-collision guard in
 *  mergeSightings. A missing or unreadable seed file yields an empty set: the
 *  harvest still runs, it just loses the guard. */
export function seedIds(path) {
  const out = new Set();
  if (!path) return out;
  for (const rec of parseCorpus(readIfExists(path))) {
    if (typeof rec.program === "string" && rec.program) out.add(programId(redactSecrets(rec.program).text));
  }
  return out;
}

export function harvest(opts) {
  const sightings = [];
  const stats = { logLines: 0, transcriptFiles: 0 };

  if (opts.log) {
    const text = readIfExists(opts.log);
    stats.logLines = text ? text.split("\n").filter((l) => l.trim()).length : 0;
    sightings.push(...sightingsFromLog(text, "invocations"));
  }
  if (opts.transcriptsEnabled && opts.transcripts) {
    for (const file of listTranscripts(opts.transcripts)) {
      stats.transcriptFiles++;
      const tag = relative(opts.transcripts, file) || file;
      sightings.push(...sightingsFromTranscript(readIfExists(file), tag));
    }
  }

  const existing = parseCorpus(readIfExists(opts.corpus));
  const merged = mergeSightings(existing, sightings, seedIds(opts.seed));
  const body = serializeCorpus(merged.records);
  const before = readIfExists(opts.corpus);

  if (!opts.dryRun && body !== before) {
    mkdirSync(dirname(resolve(opts.corpus)), { recursive: true });
    writeFileSync(opts.corpus, body);
  }

  return {
    ...merged,
    ...stats,
    sightings: sightings.length,
    total: merged.records.length,
    existing: existing.length,
    changed: body !== before,
    wrote: !opts.dryRun && body !== before,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 15).join("\n").replace(/^\/\/ ?/gm, ""));
    return;
  }
  const r = harvest(opts);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!opts.quiet) {
    console.log(`log         : ${opts.log || "(none)"} — ${r.logLines} line(s)`);
    console.log(`transcripts : ${opts.transcriptsEnabled ? opts.transcripts : "(skipped)"} — ${r.transcriptFiles} file(s)`);
    console.log(`corpus      : ${opts.corpus}`);
    console.log(`sightings   : ${r.sightings}`);
    if (r.redactions) console.log(`redacted    : ${r.redactions} credential-shaped token(s)`);
    const sk = r.skipped;
    if (sk.empty || sk.oversized) console.log(`skipped     : ${sk.empty} empty, ${sk.oversized} oversized`);
    // Never silent: a seed collision means something executed the seed corpus
    // into the log, and a run that drops hundreds of them is reporting a
    // reopened feedback loop, not routine hygiene.
    if (sk.seedCollision) console.log(`seed guard  : ${sk.seedCollision} sighting(s) dropped as seed-identical`);
  }
  const verb = r.wrote ? "wrote" : opts.dryRun && r.changed ? "would write" : "unchanged";
  console.log(`${verb} ${opts.corpus}: ${r.total} program(s), ${r.added} new (was ${r.existing})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
