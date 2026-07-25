// Build the "Feature focus timeline" dataset from this repo's git history.
//
//   node scripts/build-pulse-timeline.mjs           # update public/pulse/timeline.json
//   node scripts/build-pulse-timeline.mjs --audit   # print tag coverage, write nothing
//   npm run pulse:timeline                           # same as the first form
//
// Sibling of build-pulse.mjs. Where /pulse charts the RAW rhythm (commits,
// lines, features), /pulse/timeline charts WHICH FEATURE SETS the work was
// about, over time — so you can watch subjects (Linux sandbox, Hugging Face,
// on-device inference, …) rise, compete for focus, and fade. Each commit is
// tagged with zero-to-many subjects by scripts/pulse-themes.mjs; this script
// emits one lightweight record per commit ({ t, a, r, s }) and the subject
// registry, and the page buckets those records over an adjustable time window
// entirely client-side.
//
// Line counts are exact from git with the same generated/vendored exclusions as
// build-pulse.mjs (a `npm run bundle` rewrite of the snapshot/RAG artifacts must
// not masquerade as focus). Nothing here calls a model or the network.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUBJECTS, tagCommit, subjectRegistry } from "./pulse-themes.mjs";
import { toCetIso } from "./pulse-time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "pulse", "timeline.json");
const REPO = "kristerhedfors/deepresearch.se";
const REC = "\x1e";

// Committed generated/vendored artifacts excluded from the churn metric only
// (the commit itself still counts) — kept in sync with build-pulse.mjs GENERATED.
const GENERATED = [
  /^public\/introspect\/source-snapshot\.json$/,
  /^public\/introspect\/source-rag\.json$/,
  /^public\/pulse\/data\.json$/,
  /^public\/pulse\/timeline\.json$/,
  /^public\/vendor\//,
  /\.min\.(js|css)$/,
  /(^|\/)package-lock\.json$/,
  /\.lock$/,
];
const isGenerated = (path) => GENERATED.some((re) => re.test(path));

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
    const [, dateIso, ...subjectParts] = lines[0].split("\t");
    const subject = subjectParts.join("\t");
    let added = 0, removed = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [a, r, ...pathParts] = line.split("\t");
      if (isGenerated(pathParts.join("\t"))) continue;
      added += a === "-" ? 0 : Number(a) || 0;
      removed += r === "-" ? 0 : Number(r) || 0;
    }
    const iso = toCetIso(dateIso || "");
    if (!iso) continue;
    commits.push({ iso, subject, added, removed, s: tagCommit(subject) });
  }
  // Oldest → newest, the order the timeline reads left → right.
  commits.sort((x, y) => x.iso.localeCompare(y.iso));
  return commits;
}

/** Print how well the taxonomy covers the history — tuning aid, writes nothing. */
function audit(commits) {
  const counts = Object.fromEntries(SUBJECTS.map((s) => [s.key, 0]));
  let untagged = 0, totalTags = 0;
  for (const c of commits) {
    totalTags += c.s.length;
    if (!c.s.length) untagged += 1;
    for (const k of c.s) counts[k] += 1;
  }
  const n = commits.length || 1;
  console.log(`commits: ${commits.length} · subjects: ${SUBJECTS.length} · ` +
    `avg tags/commit: ${(totalTags / n).toFixed(2)} · untagged: ${untagged} (${Math.round((100 * untagged) / n)}%)`);
  for (const s of SUBJECTS) console.log(`${String(counts[s.key]).padStart(4)}  ${s.key}`);
}

function main() {
  const commits = readCommits();
  if (process.argv.includes("--audit")) { audit(commits); return; }

  const records = commits.map((c) => ({ t: c.iso, a: c.added, r: c.removed, s: c.s }));
  const byKey = Object.fromEntries(SUBJECTS.map((s) => [s.key, { commits: 0, added: 0, removed: 0 }]));
  let tagged = 0;
  for (const c of commits) {
    if (c.s.length) tagged += 1;
    for (const k of c.s) {
      const b = byKey[k];
      b.commits += 1; b.added += c.added; b.removed += c.removed;
    }
  }
  const days = [...new Set(records.map((r) => r.t.slice(0, 10)))].sort();
  const data = {
    generated: new Date().toISOString(),
    repo: REPO,
    range: days.length ? { from: days[0], to: days[days.length - 1] } : null,
    subjects: subjectRegistry(),
    totals: { commits: records.length, tagged, byKey },
    commits: records,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  const active = Object.values(byKey).filter((b) => b.commits > 0).length;
  console.log(`pulse-timeline: ${records.length} commits, ${tagged} tagged, ` +
    `${active}/${SUBJECTS.length} subjects active over ${days.length} day(s) → ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
