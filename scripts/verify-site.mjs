#!/usr/bin/env node
// Verify that the live site serves EXACTLY the open-source repo — the
// "what you see is what you get" check. Because this project has no build
// step, the comparison is byte-for-byte: every file under public/ at a git
// commit is fetched from the site and hash-compared against the repo blob.
//
// Anyone can run this from a clone, from anywhere, at any time:
//
//   node scripts/verify-site.mjs                       # public surface only
//   node scripts/verify-site.mjs --cookie "session=…"  # + the signed-in app
//   BASIC_AUTH_USER=… BASIC_AUTH_PASS=… \
//     node scripts/verify-site.mjs                     # operator: everything incl. /admin
//
// Options:
//   --base URL      target site (default https://deepresearch.se)
//   --ref REF       repo commit/ref to compare against (default: the commit
//                   the site self-reports in /version.json, else HEAD)
//   --cookie STR    Cookie header value of a signed-in session (from your
//                   browser's devtools; use an account that accepted the terms)
//   --concurrency N parallel fetches (default 8)
//
// Reading the output: without credentials most of the app is expectedly
// "gated" (this Worker authenticates static assets too); the run only fails
// on mismatch / missing / error. The commit in /version.json is self-reported
// — this script is what turns it into a checked claim. Limits: this proves
// the served CLIENT matches the repo at the moment of the check, from this
// network vantage point. The server-side Worker (src/) is not externally
// verifiable, and extra never-referenced files on the server are not
// enumerable from outside — but they are inert unless referenced by the
// verified HTML/JS. See .claude/skills/site-integrity/SKILL.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { assetUrlPath, classifyResult, summarize } from "./verify-lib.mjs";

const MAX_BUFFER = 256 * 1024 * 1024;

function git(...argv) {
  return execFileSync("git", argv, { maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

// ---- arguments --------------------------------------------------------------
const args = { base: "https://deepresearch.se", ref: null, cookie: null, concurrency: 8 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--base") args.base = argv[++i];
  else if (a === "--ref") args.ref = argv[++i];
  else if (a === "--cookie") args.cookie = argv[++i];
  else if (a === "--concurrency") args.concurrency = Math.max(1, Number(argv[++i]) || 8);
  else if (a === "--help" || a === "-h") {
    console.log("Usage: node scripts/verify-site.mjs [--base URL] [--ref REF] [--cookie STR] [--concurrency N]");
    process.exit(0);
  } else {
    console.error(`Unknown option: ${a} (try --help)`);
    process.exit(2);
  }
}
const base = args.base.replace(/\/+$/, "");

/** @type {Record<string, string>} */
const headers = {};
if (args.cookie) headers.cookie = args.cookie;
else if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) {
  headers.authorization =
    "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64");
}
const authed = Object.keys(headers).length > 0;

// ---- resolve the commit to compare against ----------------------------------
let ref = args.ref;
let refSource = "--ref";
if (!ref) {
  try {
    const res = await fetch(`${base}/version.json`, { headers });
    if (res.ok) {
      const stamp = await res.json();
      if (stamp && typeof stamp.commit === "string" && /^[0-9a-f]{40}$/.test(stamp.commit)) {
        ref = stamp.commit;
        refSource = `${base}/version.json (self-reported${stamp.branch ? `, branch ${stamp.branch}` : ""})`;
      }
    }
  } catch (err) {
    console.error(`note: could not read ${base}/version.json (${err?.cause?.message || err.message})`);
    if (process.env.HTTPS_PROXY || process.env.https_proxy) {
      console.error("note: Node's fetch ignores HTTPS_PROXY; on a proxied network preload a dispatcher, e.g.");
      console.error("      node --import ./proxy-setup.mjs scripts/verify-site.mjs   (see the site-integrity skill)");
    }
  }
}
if (!ref) {
  ref = "HEAD";
  refSource = "local HEAD (site did not report a commit)";
}

// Make sure the commit exists locally (a fresh clone has main; a stamped
// commit from a branch deploy may need fetching).
let commit;
try {
  commit = git("rev-parse", `${ref}^{commit}`).toString().trim();
} catch {
  try {
    console.error(`note: ${ref} not present locally, trying: git fetch origin ${ref}`);
    git("fetch", "origin", ref);
    commit = git("rev-parse", "FETCH_HEAD^{commit}").toString().trim();
  } catch {
    console.error(`error: cannot resolve ${ref} in this clone (run from the repo root; try git fetch --all)`);
    process.exit(2);
  }
}

const paths = git("ls-tree", "-r", "--name-only", commit, "--", "public")
  .toString()
  .split("\n")
  .filter(Boolean);

console.log(`Comparing ${base} against ${commit.slice(0, 12)} (${refSource})`);
console.log(`${paths.length} files under public/ at that commit; credentials: ${authed ? "yes" : "no (public surface only)"}\n`);

// ---- fetch + compare ---------------------------------------------------------
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function checkOne(path) {
  const urlPath = assetUrlPath(path);
  const expected = sha256(git("show", `${commit}:${path}`));
  try {
    const res = await fetch(base + urlPath, { headers, redirect: "manual" });
    let matched = false;
    let actual = null;
    if (res.status === 200) {
      actual = sha256(Buffer.from(await res.arrayBuffer()));
      matched = actual === expected;
    } else {
      await res.body?.cancel();
    }
    const { verdict, note } = classifyResult({ urlPath, status: res.status, matched, authed });
    return { path, urlPath, verdict, note, expected, actual, status: res.status };
  } catch (err) {
    return { path, urlPath, verdict: "error", note: err?.cause?.message || err.message, expected, actual: null, status: 0 };
  }
}

const results = [];
const queue = [...paths];
await Promise.all(
  Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const r = await checkOne(path);
      results.push(r);
      const tag = { ok: "  OK    ", gated: "  gated ", mismatch: "  MISMATCH", missing: "  MISSING ", error: "  ERROR  " }[r.verdict];
      let line = `${tag} ${r.urlPath}`;
      if (r.verdict === "mismatch") line += `\n           expected sha256 ${r.expected.slice(0, 16)}…, served ${r.actual?.slice(0, 16)}…`;
      else if (r.verdict !== "ok" && r.note) line += `  (${r.note})`;
      console.log(line);
    }
  }),
);

// ---- summary ------------------------------------------------------------------
const { counts, ok } = summarize(results);
console.log(
  `\n${counts.ok} verified byte-for-byte, ${counts.gated} gated, ${counts.mismatch} mismatched, ${counts.missing} missing, ${counts.error} errors`,
);
if (counts.gated > 0 && !authed) {
  console.log("Gated files need credentials: --cookie from a signed-in browser session verifies the app.");
}
if (ok) {
  console.log(`\nPASS: everything reachable matches ${commit.slice(0, 12)} — the site serves the public repo.`);
} else {
  console.log(`\nFAIL: the site does NOT match ${commit.slice(0, 12)} (a deploy in progress can cause this — re-run before concluding).`);
}
process.exit(ok ? 0 : 1);
