#!/usr/bin/env node
// Build public/lypning/history.json — the BACKWARD-LOOKING half of the lypning
// dashboard.
//
// The dashboard has two halves and they are measured by different instruments,
// which is the one thing about this page that must not blur:
//
//   · LIVE  — the visitor's own browser Linux VM runs the battery and the
//             numbers appear as they arrive. Nothing here produces those.
//   · PAST  — this script, walking the lypning repository's own history and
//             reading what each commit PUBLISHED about itself.
//
// So every series below is either a fact about the tree at a commit (how many
// programs the corpus held, how much Rust there was) or a number that commit
// wrote down in its own README. The second kind is a QUOTE, and it is labelled
// as one: lypning's invariant 3 says never to quote a remembered corpus size,
// and a chart that plotted a published figure as if this script had measured it
// would be doing exactly that. `measuredHere: false` rides on every quoted row.
//
// Usage:
//   node scripts/build-lypning.mjs [--repo <path>] [--out <path>] [--check]
//
// --repo   a clone of github.com/kristerhedfors/lypning. Defaults to
//          $LYPNING_REPO, then ../lypning, then ../kristerhedfors/lypning.
// --check  do not write; exit 3 if the committed file is stale. This is what
//          the test suite runs, so a lypning bump that nobody regenerated is
//          loud rather than silently old.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_OUT = join(ROOT, "public", "lypning", "history.json");

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { repo: "", out: DEFAULT_OUT, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") out.repo = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--check") out.check = true;
  }
  return out;
}

/** Where the lypning clone is. Explicit flag wins, then the env, then two guesses. */
function findRepo(explicit) {
  const candidates = [
    explicit,
    process.env.LYPNING_REPO,
    resolve(ROOT, "..", "lypning"),
    resolve(ROOT, "..", "kristerhedfors", "lypning"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, ".git")) && existsSync(join(c, "pyproject.toml"))) return resolve(c);
  }
  return "";
}

/** @param {string} repo @param {string[]} args */
const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** `git show <sha>:<path>`, or "" when the path did not exist at that commit. */
function showFile(repo, sha, path) {
  try {
    // stdio: git writes "exists on disk, but not in <sha>" to stderr for a path
    // added later in the history, which is the normal case for every early
    // commit. Swallowing it keeps a clean run quiet; the empty string is the
    // answer either way.
    return execFileSync("git", ["-C", repo, "show", `${sha}:${path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** The tree's file list at a commit. */
function treeFiles(repo, sha) {
  try {
    return git(repo, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The numbers a commit's README PUBLISHED about itself.
 *
 * Every one is a quote. The regexes are deliberately anchored on the prose
 * around each figure rather than on table geometry, because the table has been
 * reshaped twice and the sentences have not. A field that does not match is
 * absent, never zero — a missing measurement and a measured zero are different
 * facts and the chart must be able to tell them apart.
 *
 * @param {string} readme
 * @returns {Record<string, number>}
 */
export function readPublished(readme) {
  /** @type {Record<string, number>} */
  const out = {};
  const num = (s) => Number(String(s).replace(/,/g, ""));

  // "…had grown to **1551 programs, 1305 of them measurable**"
  let m = /\*\*([\d,]+) programs?, ([\d,]+) of them measurable\*\*/.exec(readme);
  if (m) {
    out.corpusPrograms = num(m[1]);
    out.corpusMeasurable = num(m[2]);
  }

  // "The mixture answers all 1305 programs for 0.302x of CPython's cost"
  m = /mixture answers all ([\d,]+) programs? for \*?\*?([\d.]+)x/.exec(readme);
  if (m) {
    out.mixtureAnswered = num(m[1]);
    out.mixtureRatio = Number(m[2]);
  }

  // The startup row: "| startup, `-c 'pass'`, min of 15 | 11.57 ms | 0.66 ms | 0.61 ms | **0.60 ms** |"
  m = /\|\s*startup[^|]*\|\s*([\d.]+) ms\s*\|\s*([\d.]+) ms\s*\|\s*([\d.]+) ms\s*\|\s*\*?\*?([\d.]+) ms/.exec(readme);
  if (m) {
    out.startupCpythonMs = Number(m[1]);
    out.startupLypningMs = Number(m[2]);
    out.startupLypningMpMs = Number(m[3]);
    out.startupMixtureMs = Number(m[4]);
  }

  // The binary row: "| binary | 6,639,992 B | 987,336 B | 296,100 B | — |"
  m = /\|\s*binary\s*\|\s*([\d,]+) B\s*\|\s*([\d,]+) B\s*\|\s*([\d,]+) B/.exec(readme);
  if (m) {
    out.binaryCpythonBytes = num(m[1]);
    out.binaryLypningBytes = num(m[2]);
    out.binaryLypningMpBytes = num(m[3]);
  }

  // The conformance sentence, whose line breaks move: read it unwrapped.
  const flat = readme.replace(/\s+/g, " ");
  m = /`lypning` ([\d,]+) MATCH · ([\d,]+) UNSUPPORTED · \*\*([\d,]+) MISMATCH\*\*; `lypning-mp` ([\d,]+) · ([\d,]+) · \*\*([\d,]+)\*\*/.exec(flat);
  if (m) {
    out.lypningMatch = num(m[1]);
    out.lypningUnsupported = num(m[2]);
    out.lypningMismatch = num(m[3]);
    out.lypningMpMatch = num(m[4]);
    out.lypningMpUnsupported = num(m[5]);
    out.lypningMpMismatch = num(m[6]);
  }

  // "**91.0% IDEAL, 97.5% right on the first try**"
  m = /\*\*([\d.]+)% IDEAL, ([\d.]+)% right on the first try\*\*/.exec(flat);
  if (m) {
    out.routeIdealPct = Number(m[1]);
    out.routeFirstTryPct = Number(m[2]);
  }
  return out;
}

/**
 * Facts about the tree itself at a commit — counted here, not quoted. These are
 * the series that are honest to plot without a caveat, because this script is
 * the instrument that produced them.
 */
function measureTree(repo, sha) {
  const files = treeFiles(repo, sha);
  const rust = files.filter((f) => f.endsWith(".rs"));
  let rustLoc = 0;
  for (const f of rust) rustLoc += countLines(showFile(repo, sha, f));
  return {
    corpusEntries: countLines(showFile(repo, sha, "src/lypning/assets/corpus/corpus.jsonl")),
    seedEntries: countLines(showFile(repo, sha, "src/lypning/assets/corpus/seed-corpus.jsonl")),
    rustFiles: rust.length,
    rustLoc,
    frozenStdlibModules: files.filter((f) => /assets\/micropython\/lib\/.*\.py$/.test(f)).length,
    pythonFiles: files.filter((f) => f.startsWith("src/lypning/") && f.endsWith(".py")).length,
    docs: files.filter((f) => f.startsWith("docs/") && f.endsWith(".md")).length,
    tests: files.filter((f) => f.startsWith("tests/") && f.endsWith(".py")).length,
    files: files.length,
  };
}

/** Lines in a blob, not counting a trailing newline as a line of its own. */
function countLines(text) {
  if (!text) return 0;
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t.length ? t.split("\n").length : 0;
}

/** @param {string} repo */
export function collect(repo) {
  const log = git(repo, ["log", "--reverse", "--pretty=%H%x1f%at%x1f%an%x1f%s"]).split("\n").filter(Boolean);
  /** @type {any[]} */
  const commits = [];
  for (const line of log) {
    const [sha, at, author, subject] = line.split("\x1f");
    const tree = measureTree(repo, sha);
    const published = readPublished(showFile(repo, sha, "README.md"));
    commits.push({
      sha: sha.slice(0, 8),
      // Seconds since the epoch, as git recorded it. The page formats it; this
      // file stays timezone-free so two machines regenerate it byte-identically.
      at: Number(at),
      author,
      subject,
      tree,
      published: Object.keys(published).length ? published : null,
    });
  }
  return commits;
}

/**
 * The series the dashboard plots. Each one names its instrument, so the page can
 * render a quoted series differently from a counted one without hard-coding
 * which is which.
 */
const SERIES = [
  { key: "tree.corpusEntries", label: "corpus entries", unit: "programs", measuredHere: true, better: "up" },
  { key: "tree.rustLoc", label: "Rust subset", unit: "lines", measuredHere: true, better: "up" },
  { key: "tree.frozenStdlibModules", label: "frozen stdlib", unit: "modules", measuredHere: true, better: "up" },
  { key: "tree.docs", label: "documentation", unit: "files", measuredHere: true, better: "up" },
  { key: "published.mixtureRatio", label: "mixture cost vs CPython", unit: "x", measuredHere: false, better: "down" },
  { key: "published.startupMixtureMs", label: "mixture startup", unit: "ms", measuredHere: false, better: "down" },
  { key: "published.startupCpythonMs", label: "CPython startup", unit: "ms", measuredHere: false, better: "down" },
  { key: "published.lypningMismatch", label: "lypning MISMATCH", unit: "cases", measuredHere: false, better: "down" },
  { key: "published.lypningMpMismatch", label: "lypning-mp MISMATCH", unit: "cases", measuredHere: false, better: "down" },
  { key: "published.routeIdealPct", label: "routes IDEAL", unit: "%", measuredHere: false, better: "up" },
  { key: "published.binaryLypningBytes", label: "lypning binary", unit: "B", measuredHere: false, better: "down" },
  { key: "published.binaryLypningMpBytes", label: "lypning-mp binary", unit: "B", measuredHere: false, better: "down" },
];

export function build(repo) {
  const commits = collect(repo);
  const head = commits[commits.length - 1] || null;
  return {
    // No generatedAt: a timestamp would make every regeneration a diff, and
    // --check could never tell a stale file from a re-run one.
    source: "https://github.com/kristerhedfors/lypning",
    head: head ? head.sha : null,
    commits,
    series: SERIES,
    note:
      "Series marked measuredHere:false are QUOTED from the README each commit " +
      "published — lypning's own invariant says never to present a remembered " +
      "number as a fresh measurement. Run the battery in the VM for that.",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = findRepo(args.repo);
  if (!repo) {
    console.error(
      "build-lypning: no lypning clone found.\n" +
        "  git clone https://github.com/kristerhedfors/lypning ../lypning\n" +
        "  (or pass --repo <path>, or set LYPNING_REPO)",
    );
    process.exit(2);
  }
  const data = build(repo);
  const text = JSON.stringify(data, null, 2) + "\n";
  if (args.check) {
    const have = existsSync(args.out) ? readFileSync(args.out, "utf8") : "";
    if (have === text) {
      console.log(`build-lypning: up to date (${data.commits.length} commits, head ${data.head})`);
      return;
    }
    console.error(
      `build-lypning: ${args.out} is STALE — regenerate with \`npm run lypning\`.\n` +
        `  committed: ${have ? `${countLines(have)} lines` : "missing"}\n` +
        `  computed : ${data.commits.length} commits, head ${data.head}`,
    );
    process.exit(3);
  }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, text);
  console.log(
    `build-lypning: wrote ${args.out} — ${data.commits.length} commits, head ${data.head}, ` +
      `${data.commits.filter((c) => c.published).length} carrying published numbers`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("build-lypning.mjs")) main();
