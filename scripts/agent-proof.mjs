#!/usr/bin/env node
// Visual proof-driven test for the agent platform: render every shipped agent's
// chat-input pane (composer) FROM ITS SPEC and prove that every declared control
// appears in the rendered markup. Two outputs:
//
//   1. a pass/fail table on stdout (one row per agent) — exits non-zero if any
//      declared control is missing from what actually renders. This is the
//      machine gate: run it in CI or before a commit that touches agents.
//   2. a self-contained HTML gallery of all four composers, written to the path
//      given as the first argument (default: a temp file printed at the end) —
//      open it in a browser to EYEBALL the proof: the controls, theme, intro/
//      loading markers and example strips each spec declares.
//
// It reads the real registry (sdk/AGENTS.json) through the same pure core the
// app and the CLI use (public/js/agent-spec-core.js), so the proof is of the
// deployed definition, not a copy. Dependency-free; no browser required.
//
//   node scripts/agent-proof.mjs [out.html]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  proveComposer,
  resolveControls,
  renderAgentShow,
} from "../public/js/agent-spec-core.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON.parse(readFileSync(join(repoRoot, "sdk/AGENTS.json"), "utf8"));

const GALLERY_CSS = `
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #05070b; color: #e8edf4;
  font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
h1 { font-size: 20px; } .sub { color: #93a1b5; margin-bottom: 24px; }
.grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
.agent-composer { background: var(--agent-bg); color: var(--agent-fg);
  border: 1px solid color-mix(in srgb, var(--agent-accent) 40%, transparent);
  border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ac-head { display: flex; flex-direction: column; gap: 2px; }
.ac-name { color: var(--agent-accent); font-size: 16px; }
.ac-tag { color: color-mix(in srgb, var(--agent-fg) 65%, transparent); font-size: 12px; }
.ac-examples { display: flex; flex-wrap: wrap; gap: 6px; }
.ac-example { background: var(--agent-accent-soft); color: var(--agent-fg);
  border: 0; border-radius: 999px; padding: 5px 10px; font-size: 12px; text-align: left; cursor: pointer; }
.ac-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.ac-ctl { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  color: color-mix(in srgb, var(--agent-fg) 80%, transparent); }
.ac-ctl span { white-space: nowrap; }
.ac-ticks { display: inline-flex; gap: 4px; opacity: .6; font-size: 10px; }
select, input[type=range] { accent-color: var(--agent-accent); }
select { background: rgba(255,255,255,.06); color: var(--agent-fg); border: 1px solid rgba(255,255,255,.14);
  border-radius: 8px; padding: 3px 6px; }
.ac-promptrow { display: flex; gap: 8px; align-items: flex-end; }
.ac-prompt { flex: 1; resize: vertical; background: rgba(255,255,255,.05); color: var(--agent-fg);
  border: 1px solid color-mix(in srgb, var(--agent-accent) 30%, transparent); border-radius: 10px; padding: 8px 10px; font: inherit; }
.ac-send { background: var(--agent-accent); color: #05070b; border: 0; border-radius: 10px;
  padding: 9px 16px; font-weight: 600; cursor: pointer; }
.ac-attach { background: transparent; color: inherit; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; padding: 5px 8px; cursor: pointer; }
.meta { margin-top: 8px; font-size: 11px; color: #7d8aa0; }
`;

const results = [];
const cards = [];
for (const a of reg.agents) {
  const p = proveComposer(a);
  results.push(p);
  cards.push(
    `<div class="card">\n${p.html}\n  <div class="meta">${resolveControls(a).length} controls · intro:${a.intro?.kind || "none"} · loading:${a.loading?.kind || "none"} · quota per share link resolved</div>\n</div>`
  );
}

// ---- the machine gate --------------------------------------------------------
let failed = false;
const w = (s) => process.stdout.write(s + "\n");
w("");
w("  AGENT COMPOSER — VISUAL PROOF");
w("  " + "─".repeat(54));
for (const p of results) {
  const controls = reg.agents.find((a) => a.id === p.id);
  const n = resolveControls(controls).length;
  if (p.ok) {
    w(`  ✔  ${p.id.padEnd(20)} ${n} controls render from spec`);
  } else {
    failed = true;
    w(`  x  ${p.id.padEnd(20)} MISSING: ${p.missing.join(", ")}`);
  }
}
w("  " + "─".repeat(54));

// ---- the eyeball artifact ----------------------------------------------------
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent composers — visual proof</title><style>${GALLERY_CSS}</style></head>
<body>
<h1>Agent composers — rendered from their specs</h1>
<div class="sub">Each pane below is built by <code>composerMarkup()</code> straight from <code>sdk/AGENTS.json</code>. The spec defines the composer.</div>
<div class="grid">
${cards.join("\n")}
</div>
</body></html>`;

const outPath = resolve(process.argv[2] || join(tmpdir(), "agent-proof.html"));
writeFileSync(outPath, html, "utf8");
w(`  gallery → ${outPath}`);
w("");

if (failed) {
  w("  RESULT: FAIL — a declared control did not render. See renderAgentShow:");
  for (const p of results) if (!p.ok) w(renderAgentShow(reg, p.id));
  process.exitCode = 1;
} else {
  w(`  RESULT: PASS — all ${results.length} agents' declared controls render.`);
}
