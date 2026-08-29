// @ts-check
// The /lypning/ dashboard's browser half: pixels, the Linux VM, and the chat.
//
// All arithmetic and every string that states a number lives in
// public/js/lypning-core.js, which is pure and unit-tested. This file may
// arrange, never compute — the split exists so the figure the reader sees and
// the figure the agent quotes come from one function.

import {
  ENGINES, PROBE_COMMAND, parseProbe, batterySteps, parseTiming, summarize,
  movement, seriesPoints, formatValue, answerLocally, statsContextBlock, chartScale,
} from "./lypning-core.js";
import { ensureSandboxBooted, execInSandbox, sandboxSupported } from "./sandbox.js";

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

/** @type {any} */ let history_ = { commits: [], series: [] };
/** @type {any} */ let live = { running: false, summary: null };
/** @type {string[]} */ let focused = [];
let stopping = false;

// ---- history

async function loadHistory() {
  try {
    const res = await fetch("/lypning/history.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`history.json ${res.status}`);
    history_ = await res.json();
  } catch (err) {
    $("cards").innerHTML =
      `<p class="warn">Could not load the commit history (${String(/** @type {any} */ (err).message || err)}). ` +
      `The live battery below still works — it does not need it.</p>`;
    return;
  }
  renderCards();
  if (history_.series && history_.series.length) focus([history_.series[0].key]);
}

function renderCards() {
  const cards = [];
  for (const s of history_.series || []) {
    const m = movement(history_, s.key);
    if (!m) continue;
    const dir = m.improved === null ? "" : m.improved ? "up" : "down";
    const arrow = m.improved === null ? "unchanged" : m.improved ? "better" : "worse";
    cards.push(
      `<div class="card${focused.includes(s.key) ? " focus" : ""}" data-key="${esc(s.key)}" role="button" tabindex="0">` +
        `<div class="lab"><span>${esc(m.label)}</span>` +
        `<span class="prov ${s.measuredHere ? "measured" : "quoted"}">${s.measuredHere ? "counted" : "quoted"}</span></div>` +
        `<div class="val">${esc(formatValue(m.last.y, m.unit))}</div>` +
        `<div class="mv ${dir}">${esc(formatValue(m.first.y, m.unit))} → ${esc(formatValue(m.last.y, m.unit))} · ${arrow}</div>` +
        sparkline(m) +
        `</div>`,
    );
  }
  $("cards").innerHTML = cards.join("");
  for (const el of $("cards").querySelectorAll(".card")) {
    el.addEventListener("click", () => focus([el.getAttribute("data-key")]));
    el.addEventListener("keydown", (/** @type {any} */ ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focus([el.getAttribute("data-key")]); }
    });
  }
}

/** A 40px sparkline. No axes — the card's two numbers are the scale. */
function sparkline(m) {
  const pts = m.points;
  if (pts.length < 2) return "";
  const w = 200, h = 40, pad = 3;
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = pts
    .map((p, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((p.y - lo) / span) * (h - 2 * pad);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const colour = m.measuredHere ? "var(--measured)" : "var(--quoted)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Open one or more series in the detail panel and highlight their cards. */
function focus(keys) {
  focused = (keys || []).filter(Boolean);
  renderCards();
  const panels = focused.map(detailChart).filter(Boolean);
  $("detail").innerHTML = panels.join("");
  if (panels.length) $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** The opened chart: full width, dated axis, one dot per commit that carried a value. */
function detailChart(key) {
  const m = movement(history_, key);
  if (!m) return "";
  const pts = m.points;
  const w = 900, h = 240, l = 56, r = 12, t = 16, b = 34;
  const xs = pts.map((p) => p.at);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const lo = Math.min(...ys), hi = Math.max(...ys);
  // A flat series still needs a band, or every point lands on one pixel row.
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.12 || 1;
  // The padding exists so a FLAT series still gets a band to draw in. It must
  // not push the axis below zero on a series that counts things: an axis
  // labelled −167 corpus entries is a chart making a claim about a quantity
  // that cannot exist, which is exactly the kind of small lie this page is
  // about not telling.
  const yLo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
  const yHi = hi + pad;
  const X = (v) => l + ((v - x0) / (x1 - x0 || 1)) * (w - l - r);
  const Y = (v) => t + (1 - (v - yLo) / (yHi - yLo || 1)) * (h - t - b);
  const colour = m.measuredHere ? "var(--measured)" : "var(--quoted)";
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const dots = pts
    .map(
      (p) =>
        `<circle cx="${X(p.at).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${colour}">` +
        `<title>${esc(p.sha)} · ${esc(dateOf(p.at))}\n${esc(formatValue(p.y, m.unit))}\n${esc(p.subject)}</title></circle>`,
    )
    .join("");
  const ticks = [yHi, (yHi + yLo) / 2, yLo]
    .map(
      (v) =>
        `<line x1="${l}" x2="${w - r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>` +
        `<text x="${l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(formatValue(v, m.unit))}</text>`,
    )
    .join("");
  const dateLabels =
    `<text x="${l}" y="${h - 10}" font-size="11" fill="var(--muted)">${esc(dateOf(x0))}</text>` +
    `<text x="${w - r}" y="${h - 10}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(dateOf(x1))}</text>`;
  return (
    `<h3>${esc(m.label)} <span class="prov ${m.measuredHere ? "measured" : "quoted"}">` +
    `${m.measuredHere ? "counted out of the tree" : "quoted from each commit's README"}</span></h3>` +
    `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="${esc(m.label)} across ${pts.length} commits">${ticks}` +
    `<path d="${line}" fill="none" stroke="${colour}" stroke-width="2"/>${dots}${dateLabels}</svg>`
  );
}

const dateOf = (/** @type {number} */ at) => new Date(at * 1000).toISOString().slice(0, 10);
const esc = (/** @type {any} */ s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

// ---- the live battery

async function runBattery() {
  if (live.running) return;
  if (!sandboxSupported()) {
    setStatus("This browser cannot run the VM — it needs cross-origin isolation and SharedArrayBuffer.", true);
    return;
  }
  live = { running: true, summary: null };
  stopping = false;
  $("run").disabled = true;
  $("stop").hidden = false;
  $("live-steps").innerHTML = "";
  setStatus("Booting the Linux VM…");

  const booted = await ensureSandboxBooted(null, (/** @type {string} */ msg) => setStatus(msg));
  if (!booted) {
    setStatus("The VM did not boot. Nothing was measured — no numbers are shown rather than borrowed ones.", true);
    return endRun();
  }

  setStatus("Looking for the interpreters…");
  const probe = await execInSandbox(PROBE_COMMAND, { timeoutMs: 15_000 });
  const present = parseProbe(probe.stdout);
  renderEngines(present);

  const steps = batterySteps(present);
  if (!steps.length) {
    setStatus("No interpreter to measure in this VM.", true);
    return endRun();
  }

  /** @type {Record<string, any>} */
  const results = {};
  renderTable(steps, results, present);
  for (const step of steps) {
    if (stopping) { setStatus("Stopped. The rows that did land are real; the rest were not measured."); break; }
    markStep(step, "running");
    setStatus(`${step.label}…`);
    const res = await execInSandbox(step.command, { timeoutMs: step.budgetMs });
    const parsed = parseTiming(res);
    results[step.id] = parsed;
    markStep(step, parsed.ok ? "done" : "failed", parsed.ok ? formatValue(parsed.us, "us") : parsed.error);
    live.summary = summarize(steps, results);
    renderTable(steps, results, present);
  }
  live.summary = summarize(steps, results);
  renderTable(steps, results, present);
  if (!stopping) setStatus(`Done — ${Object.values(results).filter((r) => r.ok).length} of ${steps.length} cases measured in this tab.`);
  endRun();
}

function endRun() {
  live.running = false;
  $("run").disabled = false;
  $("stop").hidden = true;
}

function setStatus(text, warn = false) {
  const el = $("live-status");
  el.textContent = text;
  el.className = warn ? "warn" : "muted";
  el.style.fontSize = ".82rem";
}

function renderEngines(present, probed = true) {
  // BEFORE the probe has run, "not in this VM" is a claim nobody checked. The
  // page is about the difference between a measurement and an assumption, so
  // an unprobed engine reads as unprobed.
  const bits = ENGINES.map((e) => {
    if (!probed) {
      return `<span style="margin-right:.9rem">· <span class="mono">${esc(e.id)}</span> — ` +
        `<span style="color:var(--absent)">not looked for yet</span></span>`;
    }
    const yes = present[e.id];
    return `<span style="margin-right:.9rem">${yes ? "●" : "○"} <span class="mono">${esc(e.id)}</span> — ${
      yes ? esc(e.note) : "<span style='color:var(--absent)'>not in this VM</span>"
    }</span>`;
  }).join("");
  const missing = ENGINES.filter((e) => !present[e.id]);
  const note = probed && missing.length
    ? `<p class="sub" style="margin:.4rem 0 0">The ${missing.length === ENGINES.length ? "" : "missing "}` +
      `engine${missing.length === 1 ? "" : "s"} ${missing.map((m) => `<span class="mono">${esc(m.id)}</span>`).join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} not installed in this VM, so ${missing.length === 1 ? "its row stays" : "their rows stay"} ` +
      `empty rather than being filled from the published table. Getting them in there is ` +
      `<span class="mono">scripts/build-sandbox-image.sh</span> — see <span class="mono">docs/LYPNING.md</span> §3.</p>`
    : "";
  $("engines").innerHTML = bits + note;
}

function markStep(step, state, detail = "") {
  let el = document.getElementById(`step-${cssId(step.id)}`);
  if (!el) {
    el = document.createElement("div");
    el.id = `step-${cssId(step.id)}`;
    el.className = "step";
    $("live-steps").appendChild(el);
  }
  el.className = `step ${state}`;
  el.innerHTML = `<span class="dot"></span><span>${esc(step.label)}</span>` +
    (detail ? `<span class="muted mono">${esc(detail)}</span>` : "");
  el.scrollIntoView({ block: "nearest" });
}

const cssId = (/** @type {string} */ s) => s.replace(/[^a-z0-9]+/gi, "-");

function renderTable(steps, results, present) {
  const sum = summarize(steps, results);
  if (!sum.engines.length) { $("live-table").innerHTML = ""; return; }
  const head =
    `<tr><th>case</th>${sum.engines.map((e) => `<th>${esc(e)}</th>`).join("")}` +
    `<th>vs CPython</th></tr>`;
  const rows = sum.rows
    .map((row) => {
      const cells = sum.engines
        .map((e) => {
          const c = row.cells[e];
          if (!c || c.us == null) return `<td class="${c && c.error && c.error !== "not run" ? "failed" : "pending"}">${esc(c && c.error === "not run" ? "…" : "—")}</td>`;
          return `<td class="mono">${esc(formatValue(c.us, "us"))}</td>`;
        })
        .join("");
      // The best non-CPython ratio, which is the sentence the table is making.
      const ratios = sum.engines
        .filter((e) => e !== "python3")
        .map((e) => row.cells[e] && row.cells[e].ratio)
        .filter((r) => r != null);
      const best = ratios.length ? Math.min(...ratios) : null;
      return `<tr><td>${esc(row.label)}</td>${cells}<td class="${best == null ? "pending" : "best"} mono">${
        best == null ? "—" : esc(`${best.toFixed(3)}x`)
      }</td></tr>`;
    })
    .join("");
  const coldRow = sum.engines.some((e) => sum.cold[e] != null)
    ? `<tr><td>cold start <span class="muted">(once, unrepeatable)</span></td>` +
      sum.engines.map((e) => `<td class="mono">${esc(sum.cold[e] == null ? "—" : formatValue(sum.cold[e], "us"))}</td>`).join("") +
      `<td class="pending">—</td></tr>`
    : "";
  $("live-table").innerHTML =
    `<table><thead>${head}</thead><tbody>${coldRow}${rows}</tbody></table>` +
    `<p class="sub" style="margin:.4rem 0 0">Floor-subtracted against each engine's own <span class="mono">-c 'pass'</span>, except the startup row itself. ` +
    `A dash is a case that was not measured — never a zero.</p>`;
}

// ---- chat

function say(role, text, source = "") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  // Only the local responder's own **bold** markers are honoured; nothing here
  // renders arbitrary HTML from a model.
  el.innerHTML = esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") +
    (source ? `<span class="src">${esc(source)}</span>` : "");
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

async function ask(question) {
  if (!question.trim()) return;
  say("you", question);
  const local = answerLocally(question, { history: history_, live });
  if (local.focus.length) focus(local.focus);
  if (local.run) runBattery();

  // The agent takes over when the reader is signed in AND the local responder
  // had nothing — that ordering is deliberate: a question this page can answer
  // from its own data is answered instantly, and the round trip is spent only
  // on the questions that need one.
  if (local.handled) {
    say("bot", local.text, "answered from this page's own data");
    return;
  }
  const pending = say("bot", "…", "asking the lypning agent");
  try {
    const answer = await askAgent(question);
    pending.remove();
    say("bot", answer, "lypning agent");
    $("chat-badge").textContent = "agent";
    $("chat-badge").className = "prov quoted";
  } catch (err) {
    pending.remove();
    say("bot", local.text, `no agent available (${String(/** @type {any} */ (err).message || err)}) — answered locally`);
  }
}

/**
 * One turn against /api/chat in the lypning mode. The dashboard's own data goes
 * up with the question so the agent answers from the rows on screen; it is a
 * plain SSE read with no client-side pipeline, because this mode has none.
 */
async function askAgent(question) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      chat_mode: "lypning",
      web_search: false,
      messages: [
        { role: "user", content: `${statsContextBlock(history_, live.summary)}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          // Forward-compatible by construction: an event this page does not
          // know is skipped, never an error (the SSE vocabulary's own rule).
          if (typeof ev.delta === "string") out += ev.delta;
          else if (ev.type === "chunk" && typeof ev.text === "string") out += ev.text;
        } catch { /* a frame we don't parse is a frame we don't need */ }
      }
    }
  }
  if (!out.trim()) throw new Error("empty answer");
  return out.trim();
}

// ---- wiring

$("run").addEventListener("click", runBattery);
$("stop").addEventListener("click", () => { stopping = true; });
$("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = $("q").value;
  $("q").value = "";
  ask(q);
});
for (const b of document.querySelectorAll(".chips button")) {
  b.addEventListener("click", () => ask(b.getAttribute("data-q") || ""));
}
renderEngines({}, false);
loadHistory();
say(
  "bot",
  "This page holds two kinds of number and keeps them apart: what your own VM measures, and what each " +
    "lypning commit published about itself. Ask about a metric and I'll open it; ask me to run and I'll measure.",
  "local",
);
