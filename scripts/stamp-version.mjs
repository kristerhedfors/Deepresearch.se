#!/usr/bin/env node
// Deploy-time version stamp: writes public/version.json with the git commit
// being deployed, so the live site can answer "which commit is serving?"
// (/version.json is on the public no-auth surface — see src/index.js — and
// scripts/verify-site.mjs and /build/ both read it).
//
// Runs as wrangler's [build] command (wrangler.toml) on BOTH deploy paths:
// the git-connected Workers Build (which sets WORKERS_CI_COMMIT_SHA /
// WORKERS_CI_BRANCH) and a direct `npx wrangler deploy` (where git itself
// answers). The stamp is SELF-REPORTED by the deploy — it is a convenience
// pointer, not a proof; the proof is scripts/verify-site.mjs comparing
// actual served bytes.
//
// MUST NEVER FAIL: a broken stamp must not break a deploy. Every path is
// wrapped; the worst case is a stamp with commit: null (or a stale/absent
// version.json), never a non-zero exit.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function git(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

try {
  const commit = process.env.WORKERS_CI_COMMIT_SHA || git("git rev-parse HEAD");
  const branch = process.env.WORKERS_CI_BRANCH || git("git rev-parse --abbrev-ref HEAD");
  const stamp = {
    commit,
    branch: branch === "HEAD" ? null : branch,
    stampedAt: new Date().toISOString(),
    repo: "https://github.com/kristerhedfors/Deepresearch.se",
    note: "Self-reported by the deploy. Verify independently: clone the repo and run `node scripts/verify-site.mjs`.",
  };
  writeFileSync(
    new URL("../public/version.json", import.meta.url),
    JSON.stringify(stamp, null, 2) + "\n",
  );
  console.log(`stamp-version: ${commit || "unknown commit"}${stamp.branch ? ` (${stamp.branch})` : ""}`);
} catch (err) {
  // Deliberately swallowed — see the header note.
  console.error(`stamp-version: skipped (${err?.message || err})`);
}
