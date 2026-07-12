// Build the "Project pulse" analytics dataset from this repo's git history.
//
//   node scripts/build-pulse.mjs          # update public/pulse/data.json
//   npm run pulse                          # same, via package.json
//
// It reads `git log --numstat` and aggregates, per calendar day, the three
// series the /pulse page charts: commits, lines changed, and NEW FEATURES.
// The first two are exact counts from git; the third is a keyword HEURISTIC
// over commit subjects (see classify()) — a starting point a human (or Claude,
// running the commit-analytics skill) refines by hand. Each day also carries a
// short `summary` derived from its commit subjects; the skill rewrites those
// into real prose.
//
// CURATION IS PRESERVED. On re-run, a day whose subject list is unchanged and
// that was marked `curated: true` keeps its hand-written `summary` and
// `features` — only the exact git counts refresh. New or changed days get fresh
// heuristic defaults and `curated: false`, which is the skill's review queue.
//
// The deterministic parts (commits/added/removed/subjects) are always exact;
// nothing here calls a model or the network — it's plain git + text.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "pulse", "data.json");
const REPO = "kristerhedfors/deepresearch.se";

// A record separator no commit subject contains, so we can split the stream.
const REC = "\x1e";

// Paths excluded from the LINE-churn metric only (commits still count). These
// are committed GENERATED or VENDORED artifacts — a single `npm run bundle`
// rewrites tens of thousands of lines in source-snapshot.json / source-rag.json
// and would otherwise swamp the lines-per-day chart with non-human change.
// Kept deliberately small and evidence-driven (the two big introspection
// artifacts, vendored libs, minified/lock files, and this dataset itself).
const GENERATED = [
  /^public\/introspect\/source-snapshot\.json$/,
  /^public\/introspect\/source-rag\.json$/,
  /^public\/pulse\/data\.json$/,
  /^public\/vendor\//,
  /\.min\.(js|css)$/,
  /(^|\/)package-lock\.json$/,
  /\.lock$/,
];

/** @param {string} path @returns {boolean} */
function isGenerated(path) {
  return GENERATED.some((re) => re.test(path));
}

/**
 * Read the whole history as: for each commit, a header line
 *   REC<hash>\t<authorDateISO>\t<subject>
 * followed by numstat rows "<added>\t<removed>\t<path>".
 */
function readCommits() {
  const raw = execFileSync(
    "git",
    ["log", "--no-merges", "--numstat", `--format=${REC}%H\t%aI\t%s`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const commits = [];
  for (const block of raw.split(REC)) {
    const text = block.trim();
    if (!text) continue;
    const lines = text.split("\n");
    const [hash, dateIso, ...subjectParts] = lines[0].split("\t");
    const subject = subjectParts.join("\t");
    let added = 0;
    let removed = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [a, r, ...pathParts] = line.split("\t");
      // Binary files show "-\t-": count as 0 line changes. Generated/vendored
      // artifacts are excluded from churn (see GENERATED) but the commit
      // itself still counts.
      if (isGenerated(pathParts.join("\t"))) continue;
      added += a === "-" ? 0 : Number(a) || 0;
      removed += r === "-" ? 0 : Number(r) || 0;
    }
    commits.push({ hash, date: (dateIso || "").slice(0, 10), subject, added, removed });
  }
  return commits;
}

/**
 * Bucket commits into a "feature / fix / refactor / docs / test / chore /
 * other" category by subject keywords. Order is load-bearing: the non-feature
 * categories are matched FIRST so "refactor: add a helper" reads as refactor,
 * not a feature. English + Swedish forms (the repo commits in both).
 * @param {string} subject
 * @returns {"feature"|"fix"|"refactor"|"docs"|"test"|"chore"|"other"}
 */
export function classify(subject) {
  const s = String(subject).toLowerCase().trim();
  if (/^(revert|merge)\b/.test(s)) return "other";
  if (/^(fix|hotfix|bug|bugfix|patch|åtgärda|fixa|rätta)\b/.test(s) || /\bfix(es|ed)?\b/.test(s)) return "fix";
  if (/^(refactor|refaktor|cleanup|clean up|tidy|rename|move|extract|split|inline|dedupe|de-?duplicate|simplify|reorganize|reorganise|omstrukturera|städa|förenkla)\b/.test(s)) return "refactor";
  if (/^(docs?|document|comment|readme|skill|guide|dokument)\b/.test(s) || /\bdocs?\b/.test(s)) return "docs";
  if (/^(test|tests|spec|coverage|testa?)\b/.test(s)) return "test";
  if (/^(chore|bump|deps?|dependency|build|ci|deploy|config|tweak|tighten|polish|style|nit|lint|format|typo|wip|justera|puts)\b/.test(s)) return "chore";
  if (/^(feat|feature|add|adds|added|new|introduce|introduces|implement|implements|support|supports|create|creates|enable|enables|ship|ships|lägg\s*till|lägger\s*till|ny|nytt|inför|stöd)\b/.test(s)) return "feature";
  if (/\b(add|adds|added|new|introduce|implement|support for|feature|lägg\s*till|inför)\b/.test(s)) return "feature";
  return "other";
}

/** Build a default one-line summary for a day from its commit subjects. */
function heuristicSummary(day) {
  const sign = day.added >= day.removed ? "+" : "";
  const churn = `${sign}${day.added}/−${day.removed} lines`;
  const feats = day.subjects.filter((s) => classify(s) === "feature").slice(0, 3);
  const plural = day.commits === 1 ? "" : "s";
  if (feats.length) {
    return `${day.commits} commit${plural}, ${churn}. New: ${feats.join("; ")}.`;
  }
  // No clear feature — name the dominant kind of work instead.
  const counts = {};
  for (const s of day.subjects) counts[classify(s)] = (counts[classify(s)] || 0) + 1;
  const kind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "other";
  const label = { fix: "fixes", refactor: "refactoring", docs: "docs", test: "tests", chore: "chores", other: "changes" }[kind] || "changes";
  return `${day.commits} commit${plural}, ${churn}. Mostly ${label}.`;
}

function aggregate(commits) {
  /** @type {Record<string, any>} */
  const byDate = {};
  for (const c of commits) {
    if (!c.date) continue;
    const d = (byDate[c.date] ||= { date: c.date, commits: 0, added: 0, removed: 0, subjects: [] });
    d.commits += 1;
    d.added += c.added;
    d.removed += c.removed;
    d.subjects.push(c.subject);
  }
  const days = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) {
    d.features = d.subjects.filter((s) => classify(s) === "feature").length;
    d.summary = heuristicSummary(d);
    d.curated = false;
  }
  return days;
}

/** Merge fresh git aggregates with any previously curated summaries/features. */
function mergeCuration(freshDays, prevPath) {
  if (!existsSync(prevPath)) return freshDays;
  let prev;
  try {
    prev = JSON.parse(readFileSync(prevPath, "utf8"));
  } catch {
    return freshDays;
  }
  const prevByDate = new Map((prev.days || []).map((d) => [d.date, d]));
  return freshDays.map((d) => {
    const p = prevByDate.get(d.date);
    const sameSubjects = p && JSON.stringify(p.subjects) === JSON.stringify(d.subjects);
    if (p && p.curated && sameSubjects) {
      // Keep the human's summary + feature call; refresh only the exact counts.
      return { ...d, features: p.features, summary: p.summary, curated: true };
    }
    return d;
  });
}

function main() {
  const commits = readCommits();
  const days = mergeCuration(aggregate(commits), OUT);
  const totals = days.reduce(
    (t, d) => ({
      commits: t.commits + d.commits,
      added: t.added + d.added,
      removed: t.removed + d.removed,
      features: t.features + d.features,
    }),
    { commits: 0, added: 0, removed: 0, features: 0 },
  );
  const data = {
    generated: new Date().toISOString(),
    repo: REPO,
    range: days.length ? { from: days[0].date, to: days[days.length - 1].date } : null,
    totals,
    days,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  const pending = days.filter((d) => !d.curated).length;
  console.log(
    `pulse: ${days.length} day(s), ${totals.commits} commits, ` +
      `${totals.features} heuristic features → ${OUT}` +
      (pending ? `\n  ${pending} day(s) need summary review (curated:false)` : ""),
  );
}

// Only run when invoked directly, so classify() can be imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
