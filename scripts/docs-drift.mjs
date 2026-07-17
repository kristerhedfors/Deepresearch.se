// Timestamp-driven docs-drift report (see the docs-drift-validation skill;
// companion to update-docs, whose greps catch STRUCTURAL drift — missing
// rows/bullets. This catches TEMPORAL drift: source that moved AFTER the doc
// describing it was last touched).
//
//   node scripts/docs-drift.mjs            # full report, bottom-up by level
//   node scripts/docs-drift.mjs --quiet    # summary + escalations only
//
// For every documented surface in WATCH below, the script asks git two
// questions: when was the doc last committed, and which commits have touched
// its watched source paths SINCE. A doc whose watched code moved after its
// last update is DRIFT-SUSPECT — not proven wrong (the change may not alter
// any claim), so every hit still needs a human/agent read of the doc against
// the diff. Hits on POSTURE paths (the routing/auth/provider/grant/privacy
// surfaces) are escalated separately: if code moved there and the doc lags,
// the documented capability or privacy posture may no longer be the real one,
// and that is for the OWNER to validate — not for a session to silently
// rewrite (the doc may be the intent and the code the bug).
//
// The report is ordered BOTTOM-UP (level 1 technical → level 3 narrative):
// validate the technical mirrors first, then carry each confirmed technical
// delta upward and ask whether it changes what the higher-level doc CLAIMS.
//
// Exit code: 0 = no drift-suspect docs, 1 = drift found (so a loop/hook can
// gate on it). Read-only over git.
//
// Mirror discipline: WATCH is part of the documentation inventory. A new doc
// in docs/ (or a new root *.md) must get a row here in the same commit, or
// the script flags it as UNMAPPED. Registries, test-enforced mirrors, and
// append-only ledgers are deliberately excluded (see EXCLUDED) — they have
// their own freshness mechanisms.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");

// Paths whose changes can move the ARCHITECTURE / CAPABILITY / PRIVACY
// POSTURE the docs promise. A drift-suspect doc with hits here is an
// escalation, not a routine fix. Prefixes (dir or exact file).
const POSTURE = [
  "src/index.js", // routing + identity gate
  "src/auth.js",
  "src/google.js",
  "src/login.js",
  "src/pipeline.js", // invariant 1: no function calling
  "src/providers.js",
  "src/anthropic.js",
  "src/openai.js",
  "src/mcp.js",
  "src/llm-proxy.js",
  "src/chatlog.js", // incognito promise
  "src/storage.js",
  "src/vault.js",
  "src/rag.js",
  "src/pub.js",
  "src/token-crypto.js",
  "src/proxy.js",
  "src/proxy-grant.js",
  "src/grant-http.js",
  "src/websearch.js",
  "src/websearch-key.js",
  "src/websearch-backends.js",
  "src/server-token.js",
  "src/server-grants.js",
  "public/cure/", // the never-cloud tier
  "wrangler.toml",
];

// Build outputs regenerated on nearly every source commit — pure noise in a
// drift report (their freshness is test-enforced; see update-docs).
const IGNORE = ["public/introspect/", "public/pulse/"];

// doc → { level, watch } — the source paths whose truth the doc mirrors.
// level 1 = technical mirror, 2 = subsystem/design, 3 = top-level narrative.
const WATCH = {
  // ---- level 1: technical mirrors -------------------------------------
  "docs/CODE-LAYOUT.md": { level: 1, watch: ["src/", "public/js/", "public/cure/"] },
  "docs/TESTING.md": {
    level: 1,
    watch: ["src/*.test.js", "public/js/*.test.js", "sdk/*.test.mjs", "tests/", "package.json"],
  },
  "docs/AGENT-PAIR-SDK.md": { level: 1, watch: ["sdk/"] },
  "docs/PIPELINE-LANGUAGE.md": { level: 1, watch: ["sdk/drpl.mjs", "sdk/drpl.test.mjs"] },
  "docs/WORKSPACE-PROTOCOL.md": { level: 1, watch: ["public/cure/", "sdk/"] },
  "docs/SERVER-TOKENS.md": {
    level: 1,
    watch: ["src/server-token.js", "src/server-grants.js", "src/token-crypto.js"],
  },
  "docs/ENCRYPTION.md": {
    level: 1,
    watch: ["src/history-key.js", "src/vault.js", "src/storage.js", "src/token-crypto.js", "src/rag.js", "public/cure/"],
  },
  "docs/GOOGLE-AUTH.md": {
    level: 1,
    watch: ["src/google.js", "src/auth.js", "src/login.js", "src/accounts.js"],
  },
  "docs/SECRET-SCANNING.md": { level: 1, watch: ["scripts/scan-secrets", ".githooks/"] },
  "docs/DECISION-BOARD-LOOPS.md": {
    level: 1,
    watch: ["src/board.js", "src/admin-boards.js", "src/features.js", "src/security-risks.js", "src/panels.js"],
  },
  "docs/SANDBOX-HOST-COMMANDS.md": {
    level: 1,
    watch: ["public/js/sandbox.js", "public/js/sandbox-files.js", "public/js/bash-core.js", "src/bash-agent.js", "src/bash-api.js"],
  },
  "docs/WORKSPACE-FS-DESIGN.md": {
    level: 1,
    watch: ["public/js/sandbox.js", "public/js/sandbox-files.js", "public/js/bash-core.js", "src/bash-agent.js", "src/bash-api.js"],
  },
  "docs/SANDBOX-LOCAL-IMAGE.md": {
    level: 1,
    watch: ["src/sandbox-image.js", "scripts/build-sandbox-image.sh", "public/js/sandbox.js"],
  },
  "docs/JS-VM-RESEARCH.md": { level: 1, watch: ["public/js/sandbox.js", "src/sandbox-image.js"] },
  "docs/BONSAI-27B-PHONE-INFERENCE.md": { level: 1, watch: ["public/cure/"] },
  "docs/SYMBOL-LANGUAGE.md": { level: 1, watch: ["public/cure/"] },
  "docs/WORKSPACE-SECURITY.md": {
    level: 1,
    watch: ["public/cure/", "src/proxy-grant.js", "src/grant-http.js", "src/websearch-key.js", "src/token-crypto.js"],
  },

  // ---- level 2: subsystem / design ------------------------------------
  "docs/ARCHITECTURE.md": { level: 2, watch: ["src/", "public/", "wrangler.toml"] },
  "docs/PRIVACY-MODEL.md": {
    level: 2,
    // the posture set IS this doc's subject
    watch: POSTURE.filter((p) => p !== "wrangler.toml"),
  },
  "docs/BRANDING.md": { level: 2, watch: ["public/**/*.html", "public/**/*.css"] },
  "docs/STACKLESS-RESEARCH.md": { level: 2, watch: ["sdk/"] },
  "docs/ARCHITECTURE-ROADMAP.md": { level: 2, watch: ["src/", "public/", "sdk/"] },
  "docs/FOREVERAGENT-GAP-ANALYSIS.md": { level: 2, watch: ["public/cure/"] },
  "docs/FOREVERAGENT-TRAJECTORY.md": { level: 2, watch: ["public/cure/"] },

  // ---- level 3: top-level narrative -----------------------------------
  "README.md": { level: 3, watch: ["src/", "public/", "sdk/", "wrangler.toml", "package.json"] },
  "AGENTS.md": { level: 3, watch: ["src/", "public/", "sdk/", "wrangler.toml"] },
  "CLAUDE.md": {
    level: 3,
    watch: ["src/", "public/", "sdk/", "scripts/", "wrangler.toml", "package.json", ".claude/skills/"],
  },
};

// Docs with their OWN freshness mechanism — never reported here.
const EXCLUDED = new Set([
  "docs/MERGED-BRANCHES.md", // ledger; scripts/check-merged-branches.mjs
  "docs/MAINTENANCE-OWNERS.md", // registry; feature-maintenance discipline
  "FEATURES.md", // test-enforced mirror (features.test.js)
  "SECURITY-RISKS.md", // test-enforced mirror (security-risks.test.js)
  "SECURITY-ASSESSMENT.md", // board-mirrored
]);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function docLastCommit(doc) {
  const out = git(["log", "-1", "--format=%ct\t%h\t%s", "--", doc]).trim();
  if (!out) return null;
  const [ct, h, ...s] = out.split("\t");
  return { ct: Number(ct), h, s: s.join("\t") };
}

// Commits strictly AFTER `sinceCt` touching any of `watch`, with the touched
// files (filtered back through the watch prefixes, doc itself excluded).
function changesSince(sinceCt, watch, doc) {
  const out = git([
    "log",
    `--since=${new Date((sinceCt + 1) * 1000).toISOString()}`,
    "--pretty=format:@@\t%ct\t%h\t%s",
    "--name-only",
    "--",
    ...watch,
  ]);
  const commits = [];
  const fileHits = new Map(); // file → commit-touch count
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@\t")) {
      const [, ct, h, ...s] = line.split("\t");
      cur = { ct: Number(ct), h, s: s.join("\t") };
      // --since is date-fuzzy; enforce strictly-after ourselves
      if (cur.ct <= sinceCt) cur = null;
      else commits.push(cur);
    } else if (cur && line.trim() && line !== doc && !IGNORE.some((p) => line.startsWith(p))) {
      fileHits.set(line, (fileHits.get(line) || 0) + 1);
      cur.hit = true;
    }
  }
  // Commits whose only watched files were ignored artifacts aren't drift.
  return { commits: commits.filter((c) => c.hit), fileHits };
}

// A pure-CSS change never moves the posture, however sensitive its directory.
function postureHits(fileHits) {
  return [...fileHits.keys()].filter(
    (f) => !f.endsWith(".css") && POSTURE.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p))
  );
}

const days = (sec) => Math.floor(sec / 86400);

function main() {
  // Unmapped-doc check: every tracked root/docs markdown must be mapped or excluded.
  const tracked = git(["ls-files", "*.md", "docs/*.md"])
    .split("\n")
    .filter((f) => f && (!f.includes("/") || /^docs\/[^/]+\.md$/.test(f)));
  const unmapped = tracked.filter((f) => !WATCH[f] && !EXCLUDED.has(f));

  const rows = [];
  for (const [doc, { level, watch }] of Object.entries(WATCH)) {
    const last = docLastCommit(doc);
    if (!last) continue; // doc not in git (yet) — nothing to compare against
    const { commits, fileHits } = changesSince(last.ct, watch, doc);
    if (!commits.length) continue;
    rows.push({
      doc,
      level,
      last,
      commits,
      fileHits,
      posture: postureHits(fileHits),
      newest: Math.max(...commits.map((c) => c.ct)),
    });
  }
  rows.sort((a, b) => a.level - b.level || b.commits.length - a.commits.length);

  const clean = Object.keys(WATCH).length - rows.length;
  console.log(
    `docs-drift: ${rows.length} drift-suspect doc(s), ${clean} in sync, ${unmapped.length} unmapped.\n`
  );

  let lastLevel = 0;
  for (const r of rows) {
    if (!QUIET && r.level !== lastLevel) {
      lastLevel = r.level;
      const name = { 1: "technical mirrors", 2: "subsystem / design", 3: "top-level narrative" }[r.level];
      console.log(`── Level ${r.level} — ${name} ${"─".repeat(Math.max(1, 50 - name.length))}`);
    }
    const stale = days(r.newest - r.last.ct);
    const flag = r.posture.length ? "  ⚠ POSTURE" : "";
    console.log(
      `${r.doc}${flag}\n    doc last touched ${r.last.h} ${new Date(r.last.ct * 1000).toISOString().slice(0, 10)}; ` +
        `${r.commits.length} watched commit(s) since, newest ${stale}d after the doc.`
    );
    if (!QUIET) {
      const top = [...r.fileHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [f, n] of top) console.log(`      ${String(n).padStart(3)}×  ${f}${r.posture.includes(f) ? "  ⚠" : ""}`);
      const more = r.fileHits.size - top.length;
      if (more > 0) console.log(`           … and ${more} more file(s)`);
    }
  }

  for (const f of unmapped) {
    console.log(`UNMAPPED doc (add a WATCH row or an EXCLUDED entry): ${f}`);
  }

  const escalations = rows.filter((r) => r.posture.length);
  if (escalations.length) {
    console.log("\n=================== NOTIFY OWNER (krister.hedfors@gmail.com) ===================");
    console.log("Code on ARCHITECTURE/POSTURE surfaces moved after the doc describing them was");
    console.log("last updated. If the doc's claims no longer match the code, that is a drift in");
    console.log("the documented capability or privacy posture — the OWNER validates which side");
    console.log("is right (the doc may be the intent and the code the bug). Do NOT silently");
    console.log("rewrite these docs to match the code:\n");
    for (const r of escalations) {
      console.log(`  • ${r.doc} — posture files touched since: ${r.posture.slice(0, 6).join(", ")}${r.posture.length > 6 ? ", …" : ""}`);
    }
    console.log("================================================================================");
  }

  process.exit(rows.length || unmapped.length ? 1 : 0);
}

main();
