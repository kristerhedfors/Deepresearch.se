#!/usr/bin/env node
// Wordmark slash-gap meter (see the **slash-spacing** skill).
//
// Measures the actual INK gap on each side of the slash in the Se/cure and
// Se/rver wordmarks — the visual whitespace between the last glyph before the
// slash, the slash stroke itself, and the first glyph after it — for a given
// font family / weight / style, and recommends the `.sl` margin that puts the
// wordmark in the codified target band (tight enough to read as one word,
// never touching).
//
// Why a meter instead of eyeballing: the right margin depends on the FONT
// (glyph side bearings, slash slope/width, weight), so the global
// `.sl { margin: 0 -.12em }` that is correct for regular-weight system-ui is
// wrong in bold or in another family. Bounding boxes are useless here — the
// slash is diagonal, so its box overlaps its neighbours' boxes long before
// any ink touches. This tool renders each run ("Se", "/", "cure") on a
// canvas in headless Chromium, extracts per-row ink edge profiles, and
// computes the true minimum horizontal ink distance between adjacent runs —
// exactly what the eye sees. Runs are rendered separately because that is
// how the DOM lays them out too: the `<span class="sl">` boundary breaks
// kerning between the slash and its neighbours, so
//   layout = advance(left) + margin + advance(/) + margin + advance(right).
// The gap therefore varies LINEARLY with the margin: gap(m) = gap(0) + m,
// which lets the tool solve for the recommended margin directly.
//
// No dependencies: the harness is a self-contained HTML page, run through the
// pre-installed Playwright Chromium with --dump-dom; results come back as
// JSON in the DOM. Node 18+, matching the repo's zero-dependency stance.
//
// Usage:
//   node scripts/slash-gap.mjs                       # default sweep
//   node scripts/slash-gap.mjs --weights 700         # the bold case
//   node scripts/slash-gap.mjs --fonts "DejaVu Sans" --margin -0.06
//   node scripts/slash-gap.mjs --style italic
//   node scripts/slash-gap.mjs --json                # machine-readable
//
// Flags (all optional):
//   --fonts    comma list of families to test (each measured alone, so a
//              missing family silently falls back to fontconfig's default —
//              rows whose metrics equal the generic sans-serif row are marked
//              "=sans-serif fallback?")
//   --weights  comma list of font-weights                 (default 400,700)
//   --style    normal | italic                            (default normal)
//   --words    comma list of slash words                  (default Se/cure,Se/rver)
//   --margin   the .sl margin under test, em              (default -0.12)
//   --target   desired per-side ink gap, em               (default 0.06)
//   --floor    absolute minimum acceptable gap, em        (default 0.03)
//   --chrome   chromium binary                            (default the PW install)
//
// The default --target/--floor come from calibrating against the accepted
// reference rendering (regular-weight sans at the global -.12em) — see the
// slash-spacing skill for the calibration table and the decision procedure.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULTS = {
  fonts: "system-ui, Liberation Sans, DejaVu Sans, FreeSans, sans-serif",
  weights: "400,700",
  style: "normal",
  words: "Se/cure,Se/rver",
  margin: "-0.12",
  target: "0.06",
  floor: "0.03",
  chrome: process.env.CHROME_BIN || "/opt/pw-browsers/chromium",
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { out.json = true; continue; }
    const m = /^--(fonts|weights|style|words|margin|target|floor|chrome)$/.exec(a);
    if (m && i + 1 < argv.length) { out[m[1]] = argv[++i]; continue; }
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
  return out;
}

// The measurement harness. Runs inside Chromium: renders each run of each
// word for each (font, weight) at S px on its own canvas, extracts per-row
// ink edge profiles (alpha threshold), and reports the minimum horizontal
// ink distance between adjacent runs at margin 0. Emits JSON into #out.
function harnessHtml(cfg) {
  return `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const CFG = ${JSON.stringify(cfg)};
const S = 200, PAD = Math.ceil(S * 0.6), ALPHA = 32;

function inkProfiles(text, font) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.font = font;
  const adv = ctx.measureText(text).width;
  c.width = Math.ceil(adv + 2 * PAD);
  c.height = Math.ceil(S * 2.2);
  const ctx2 = c.getContext("2d", { willReadFrequently: true });
  ctx2.font = font; // canvas resize resets state
  ctx2.fillStyle = "#000";
  ctx2.textBaseline = "alphabetic";
  const baseline = Math.round(S * 1.5);
  ctx2.fillText(text, PAD, baseline);
  const img = ctx2.getImageData(0, 0, c.width, c.height);
  const left = new Array(c.height).fill(null);
  const right = new Array(c.height).fill(null);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (img.data[(y * c.width + x) * 4 + 3] >= ALPHA) {
        if (left[y] === null) left[y] = x - PAD;
        right[y] = x - PAD;
      }
    }
  }
  return { adv, left, right };
}

// True minimum horizontal ink distance between run A (origin xA) and run B
// (origin xB), scanned per pixel row — negative means the ink overlaps.
function pairGap(a, xA, b, xB) {
  let min = Infinity;
  for (let y = 0; y < a.right.length; y++) {
    if (a.right[y] === null || b.left[y] === null) continue;
    const g = (xB + b.left[y]) - (xA + a.right[y]);
    if (g < min) min = g;
  }
  return min;
}

const rows = [];
for (const family of CFG.fonts) {
  for (const weight of CFG.weights) {
    const font = CFG.style + " " + weight + " " + S + "px " + (/^[a-z-]+$/.test(family) ? family : JSON.stringify(family));
    for (const word of CFG.words) {
      const [l, r] = word.split("/");
      const L = inkProfiles(l, font);
      const X = inkProfiles("/", font);
      const R = inkProfiles(r, font);
      // margin 0 layout: runs sit at their advance positions
      const gapLeft = pairGap(L, 0, X, L.adv) / S;
      const gapRight = pairGap(X, L.adv, R, L.adv + X.adv) / S;
      rows.push({ family, weight, word,
        gapLeft0: gapLeft, gapRight0: gapRight,
        advE: inkProfiles("e", font).adv / S });
    }
  }
}
document.getElementById("out").textContent = JSON.stringify(rows);
</script>`;
}

function runChromium(chrome, htmlPath) {
  const out = execFileSync(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--hide-scrollbars", "--dump-dom", "file://" + htmlPath,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(out);
  if (!m || !m[1]) throw new Error("harness produced no output — is the chromium binary right? (--chrome)");
  const json = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(json);
}

function fmt(em) {
  if (em === null || !isFinite(em)) return "   n/a";
  return (em >= 0 ? "+" : "") + em.toFixed(3);
}

function main() {
  const args = parseArgs(process.argv);
  const cfg = {
    fonts: args.fonts.split(",").map((s) => s.trim()).filter(Boolean),
    weights: args.weights.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean),
    style: args.style === "italic" ? "italic" : "normal",
    words: args.words.split(",").map((s) => s.trim()).filter((w) => w.includes("/")),
  };
  const margin = parseFloat(args.margin);
  const target = parseFloat(args.target);
  const floor = parseFloat(args.floor);
  if (!existsSync(args.chrome)) {
    console.error(`Chromium not found at ${args.chrome} — pass --chrome <path>.`);
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "slash-gap-"));
  const htmlPath = join(dir, "harness.html");
  writeFileSync(htmlPath, harnessHtml(cfg));
  let rows;
  try {
    rows = runChromium(args.chrome, htmlPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Fallback detection: a family Chromium can't find resolves to the generic
  // sans default, so its 'e' advance matches the sans-serif row exactly.
  const sansAdv = new Map();
  for (const r of rows) if (r.family === "sans-serif") sansAdv.set(r.weight + "/" + r.word, r.advE);
  for (const r of rows) {
    r.fallback = r.family !== "sans-serif" && !/^(system-ui)$/.test(r.family) &&
      sansAdv.get(r.weight + "/" + r.word) === r.advE;
  }

  // Per (family, weight): the recommendation must satisfy the WORST side of
  // the worst word. gap(m) = gap(0) + m, so m_target = target - minGap0.
  const byConfig = new Map();
  for (const r of rows) {
    const key = `${r.family} @ ${r.weight}`;
    const minGap0 = Math.min(r.gapLeft0, r.gapRight0);
    const prev = byConfig.get(key);
    if (!prev || minGap0 < prev.minGap0) byConfig.set(key, { ...r, minGap0 });
  }

  if (args.json) {
    const report = rows.map((r) => ({
      family: r.family, weight: r.weight, word: r.word, fallback: r.fallback,
      gapLeft0_em: +r.gapLeft0.toFixed(4), gapRight0_em: +r.gapRight0.toFixed(4),
      gapLeftAtMargin_em: +(r.gapLeft0 + margin).toFixed(4),
      gapRightAtMargin_em: +(r.gapRight0 + margin).toFixed(4),
      recommendedMargin_em: +(target - Math.min(r.gapLeft0, r.gapRight0)).toFixed(3),
    }));
    console.log(JSON.stringify({ margin, target, floor, rows: report }, null, 2));
    return;
  }

  console.log(`slash-gap: ink gap around the wordmark slash (em; + is space, - is OVERLAP)`);
  console.log(`margin under test: ${margin}em   target gap: ${target}em   floor: ${floor}em\n`);
  const header = "family".padEnd(18) + "wt".padEnd(5) + "word".padEnd(10) +
    "gap@0 L/R".padEnd(17) + `gap@${margin} L/R`.padEnd(20) + "verdict";
  console.log(header);
  console.log("-".repeat(header.length + 6));
  for (const r of rows) {
    const gl = r.gapLeft0 + margin, gr = r.gapRight0 + margin;
    const worst = Math.min(gl, gr);
    const verdict = worst <= 0 ? "TOUCHES/OVERLAPS" : worst < floor ? "too tight" :
      worst > target * 2 ? "loose" : "ok";
    console.log(
      (r.family + (r.fallback ? "*" : "")).padEnd(18) + String(r.weight).padEnd(5) +
      r.word.padEnd(10) + (fmt(r.gapLeft0) + "/" + fmt(r.gapRight0)).padEnd(17) +
      (fmt(gl) + "/" + fmt(gr)).padEnd(20) + verdict,
    );
  }
  console.log("\nrecommended .sl margin per configuration (worst side at target " + target + "em):");
  for (const [key, r] of byConfig) {
    const rec = target - r.minGap0;
    console.log(`  ${key.padEnd(24)} margin: 0 ${rec.toFixed(3).replace(/^(-?)0\./, "$1.")}em` +
      (r.fallback ? "   (* metrics identical to sans-serif — family likely missing here)" : ""));
  }
  console.log("\nPick the LEAST tightening (closest to 0 / most positive) across the fonts" +
    "\nreal users will resolve, so the worst-case font still clears the floor." +
    "\nSee .claude/skills/slash-spacing/SKILL.md for the decision procedure.");
}

main();
