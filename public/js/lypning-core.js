// @ts-check
// The pure core behind the lypning dashboard (/lypning/) and its stats agent.
//
// Everything here is a function of its arguments: no DOM, no fetch, no VM. The
// page (public/lypning/index.html) owns the pixels and the browser Linux VM;
// src/lypning-stats.js re-exports this module so the Worker-side agent answers
// from exactly the numbers the page is showing. That is the point of the split
// — a stats agent that computed its own figures a second way would eventually
// disagree with the chart the reader is looking at.
//
// ONE RULE governs this file, and it is lypning's own (its invariant 3): never
// present a remembered number as a measurement. Two kinds of number live here
// and they are kept apart everywhere:
//
//   · MEASURED HERE — the battery ran in the reader's own browser Linux VM just
//     now, or build-lypning.mjs counted it out of the tree. Quotable.
//   · QUOTED — a figure some commit's README published, on a machine nobody
//     here has seen. Plottable as history, never as "your number".
//
// `measuredHere` rides on every series and every battery row so the page can
// render the two differently without a hard-coded list of which is which.

/** The three interpreters the mixture picks between, in fall-through order. */
export const ENGINES = [
  { id: "lypning", label: "lypning", note: "Rust subset, in-process" },
  { id: "lypning-mp", label: "lypning-mp", note: "MicroPython variant, forked" },
  { id: "python3", label: "CPython", note: "the reference, exec'd" },
];

/**
 * The one thing the sandbox punishes: a command that crosses the VM's exec
 * ceiling does not fail, it DESTROYS the VM (skills-disabled/sandbox-perf-eval).
 * So the battery is a list of SMALL steps run one at a time, each with its own
 * budget, rather than one script that measures everything. The reader watching
 * numbers appear one row at a time is a side effect of that constraint, and a
 * happy one.
 */
export const EXEC_CEILING_MS = 30_000;

/** A battery step's budget may never reach the ceiling; leave the VM room. */
export const STEP_BUDGET_MS = 20_000;

/**
 * `min` of N, not `mean`.
 *
 * Noise on a shared machine — and a browser tab is the most shared machine
 * there is — is one-sided: scheduling, page faults and a neighbouring tab can
 * only ever ADD time. So the minimum of a repeated run is the least biased
 * estimate of the true cost, which is the same reasoning lypning's own bench
 * ledger uses. The mean would report the reader's other tabs.
 *
 * Emits microseconds, because a subset interpreter's startup is under a
 * millisecond and integer milliseconds would round it to zero.
 *
 * @param {string} cmd the command to time
 * @param {number} repeat how many times
 * @returns {string} a shell program printing one integer: microseconds
 */
export function timingProgram(cmd, repeat) {
  return (
    `best=; n=0; while [ $n -lt ${repeat} ]; do ` +
    `s=$(date +%s%N); ${cmd} >/dev/null 2>&1; e=$(date +%s%N); ` +
    `d=$(( (e - s) / 1000 )); ` +
    `if [ -z "$best" ] || [ "$d" -lt "$best" ]; then best=$d; fi; ` +
    `n=$((n+1)); done; echo "$best"`
  );
}

/**
 * Which engines does this VM actually have?
 *
 * The honest answer is usually "CPython only": the stock image is a Debian i386
 * rootfs, and lypning's two engines are musl-i386 binaries that have to be put
 * there. A dashboard that quietly filled the missing rows from the README would
 * be showing the reader somebody else's machine — so an absent engine is
 * reported ABSENT, and the charts that need it stay empty and say why.
 */
export const PROBE_COMMAND =
  ENGINES.map((e) => `printf '%s ' ${e.id}; command -v ${e.id} >/dev/null 2>&1 && echo yes || echo no`).join("; ");

/**
 * @param {string} stdout output of PROBE_COMMAND
 * @returns {Record<string, boolean>} engine id → present
 */
export function parseProbe(stdout) {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const line of String(stdout || "").split("\n")) {
    const m = /^(\S+)\s+(yes|no)\s*$/.exec(line.trim());
    if (m) out[m[1]] = m[2] === "yes";
  }
  return out;
}

/**
 * The workloads. Deliberately tiny and deliberately the shape of the thing
 * lypning exists for — the one-liners a coding agent types, not a benchmark
 * suite. Each must finish far inside STEP_BUDGET_MS on CPython, which is the
 * slowest arm by an order of magnitude.
 */
export const WORKLOADS = [
  { id: "pass", label: "startup", program: "pass", repeat: 15, note: "the floor every other row is measured against" },
  { id: "sum", label: "sum a range", program: "print(sum(range(10000)))", repeat: 7 },
  { id: "json", label: "json round-trip", program: "import json; print(len(json.dumps({'a':list(range(200))})))", repeat: 7 },
  { id: "split", label: "split and count", program: "s='a b c '*500; print(len(s.split()))", repeat: 7 },
  { id: "re", label: "regex substitute", program: "import re; print(len(re.sub('a','b','abc'*400)))", repeat: 5 },
];

/**
 * The battery, as data. `cold` runs first and exactly once per engine — the
 * first invocation after boot is the number lypning was built to attack (the
 * sandbox streams its disk block by block, so a cold spawn costs orders of
 * magnitude more than a warm one) and it can only be measured once, because
 * measuring it warms it.
 *
 * @param {Record<string, boolean>} present engine id → present, from parseProbe
 * @returns {Array<{id: string, engine: string, workload: string, label: string, kind: string, command: string, budgetMs: number}>}
 */
export function batterySteps(present) {
  const live = ENGINES.filter((e) => present[e.id]);
  /** @type {any[]} */
  const steps = [];
  for (const e of live) {
    steps.push({
      id: `cold:${e.id}`,
      engine: e.id,
      workload: "pass",
      label: `${e.label} — cold start`,
      kind: "cold",
      // Once, and first. `date` twice around a single spawn; no loop, because a
      // loop would measure the warm case and call it cold.
      command: `s=$(date +%s%N); ${e.id} -c 'pass' >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e - s) / 1000 ))`,
      budgetMs: STEP_BUDGET_MS,
    });
  }
  for (const w of WORKLOADS) {
    for (const e of live) {
      steps.push({
        id: `warm:${e.id}:${w.id}`,
        engine: e.id,
        workload: w.id,
        label: `${e.label} — ${w.label}`,
        kind: "warm",
        command: timingProgram(`${e.id} -c ${shellQuote(w.program)}`, w.repeat),
        budgetMs: STEP_BUDGET_MS,
      });
    }
  }
  return steps;
}

/**
 * Single-quote for `sh`. The programs above contain quotes of their own, so
 * this cannot be skipped, and the closing/reopening dance is the only way to
 * get a literal single quote through a single-quoted shell word.
 * @param {string} s
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * One step's result. A step that failed is recorded as failed rather than
 * dropped: a battery that silently shrank when a case timed out would report a
 * faster machine than the reader has.
 *
 * @param {{exitCode: number, stdout: string, stderr: string}} res
 * @returns {{ok: boolean, us: number|null, error: string}}
 */
export function parseTiming(res) {
  if (!res || res.exitCode !== 0) {
    return { ok: false, us: null, error: (res && String(res.stderr || "").trim().slice(0, 200)) || `exit ${res ? res.exitCode : "?"}` };
  }
  const m = /(-?\d+)\s*$/.exec(String(res.stdout || "").trim());
  if (!m) return { ok: false, us: null, error: "no timing on stdout" };
  const us = Number(m[1]);
  if (!Number.isFinite(us) || us < 0) return { ok: false, us: null, error: `implausible timing ${m[1]}` };
  return { ok: true, us, error: "" };
}

/**
 * The live table: one row per workload, one column per engine, plus the ratio
 * that is the actual deliverable.
 *
 * Floor-subtracted, like lypning's own bench: `-c 'pass'` is measured per
 * engine and taken off every other row, so a 3 ms workload is not reported as a
 * 90 ms one because process spawn dominated it. A row whose floor is missing is
 * reported RAW and says so — subtracting a floor you did not measure is how a
 * benchmark starts lying.
 *
 * @param {Array<{id: string, engine: string, workload: string, kind: string}>} steps
 * @param {Record<string, {ok: boolean, us: number|null, error: string}>} results step id → parsed
 */
export function summarize(steps, results) {
  /** @type {Record<string, number>} */
  const floor = {};
  for (const s of steps) {
    if (s.kind !== "warm" || s.workload !== "pass") continue;
    const r = results[s.id];
    if (r && r.ok && r.us != null) floor[s.engine] = r.us;
  }
  const engines = [...new Set(steps.map((s) => s.engine))];
  /** @type {any[]} */
  const rows = [];
  for (const w of WORKLOADS) {
    /** @type {Record<string, any>} */
    const cells = {};
    for (const e of engines) {
      const r = results[`warm:${e}:${w.id}`];
      if (!r || !r.ok || r.us == null) {
        cells[e] = { us: null, floored: false, error: r ? r.error : "not run" };
        continue;
      }
      const hasFloor = w.id !== "pass" && floor[e] != null;
      cells[e] = {
        us: hasFloor ? Math.max(0, r.us - floor[e]) : r.us,
        floored: hasFloor,
        error: "",
      };
    }
    // The ratio every reader is here for: the cheapest subset arm against
    // CPython on the same case. Absent either side, there is no ratio — not a 1.
    const ref = cells["python3"];
    for (const e of engines) {
      const c = cells[e];
      c.ratio = ref && ref.us != null && ref.us > 0 && c.us != null ? c.us / ref.us : null;
    }
    rows.push({ workload: w.id, label: w.label, note: w.note || "", cells });
  }
  /** @type {Record<string, any>} */
  const cold = {};
  for (const e of engines) {
    const r = results[`cold:${e}`];
    cold[e] = r && r.ok ? r.us : null;
  }
  return { engines, rows, cold, floor, measuredHere: true };
}

// ---- the backward-looking half: series over lypning's commit history

/** Read a dotted path off a commit record. @param {any} obj @param {string} path */
export function pluck(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/**
 * One series' points, dropping commits that carry no value for it. Dropping is
 * right here and wrong in the battery: a commit that published no benchmark
 * table did not measure zero, it did not measure. A gap in the line is the
 * honest rendering.
 *
 * @param {{commits: any[]}} history
 * @param {string} key dotted, e.g. "published.mixtureRatio"
 * @returns {Array<{at: number, sha: string, subject: string, y: number}>}
 */
export function seriesPoints(history, key) {
  const commits = (history && Array.isArray(history.commits) ? history.commits : []);
  /** @type {any[]} */
  const out = [];
  for (const c of commits) {
    const y = pluck(c, key);
    if (y == null) continue;
    out.push({ at: c.at, sha: c.sha, subject: c.subject, y });
  }
  return out;
}

/**
 * How a series moved, first published value to last. `better` says which
 * direction counts as progress, so the page never has to know that a falling
 * cost ratio is good news and a falling corpus count is not.
 *
 * @param {{commits: any[], series: any[]}} history
 * @param {string} key
 */
export function movement(history, key) {
  const series = (history.series || []).find((/** @type {any} */ s) => s.key === key) || null;
  const pts = seriesPoints(history, key);
  if (!pts.length) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const delta = last.y - first.y;
  const better = series && series.better === "down" ? -1 : 1;
  return {
    key,
    label: series ? series.label : key,
    unit: series ? series.unit : "",
    measuredHere: series ? !!series.measuredHere : false,
    first,
    last,
    delta,
    pct: first.y !== 0 ? (delta / Math.abs(first.y)) * 100 : null,
    improved: delta === 0 ? null : Math.sign(delta) === better,
    points: pts,
  };
}

/**
 * The one deterministic intent gate on this page: which series is the reader
 * asking about? EN and SV get the same breadth — definite forms, the plural,
 * the obvious synonyms — because CLAUDE.md invariant 6 applies to every gate
 * that routes behaviour, and this one moves the chart.
 *
 * Word-boundary note: JS `\b` is ASCII-only, so `\bmått\b` does NOT match at
 * the end of "måttet" the way an English `\bsize\b` fails to match "sizes" —
 * it matches, wrongly, between "å" and "t". Every pattern here is therefore
 * substring-matched against a lowercased haystack instead of anchored on `\b`.
 *
 * @type {Array<{key: string, en: string[], sv: string[]}>}
 */
export const SERIES_INTENT = [
  {
    key: "tree.corpusEntries",
    en: ["corpus", "corpora", "programs captured", "captured programs", "sightings", "how many programs"],
    sv: ["korpus", "korpusen", "korpusar", "infångade program", "fångade program", "hur många program"],
  },
  {
    key: "tree.rustLoc",
    en: ["rust", "subset size", "how much rust", "lines of rust", "the subset"],
    sv: ["rust", "delmängd", "delmängden", "subsetet", "rader rust", "hur mycket rust"],
  },
  {
    key: "tree.frozenStdlibModules",
    en: ["stdlib", "standard library", "frozen modules", "frozen stdlib", "modules"],
    sv: ["standardbibliotek", "standardbiblioteket", "frysta moduler", "moduler", "stdlib"],
  },
  {
    key: "published.mixtureRatio",
    en: ["ratio", "cost", "how much cheaper", "speedup", "faster than cpython", "mixture cost", "vs cpython"],
    sv: ["kvot", "kvoten", "kostnad", "kostnaden", "hur mycket billigare", "snabbare än cpython", "jämfört med cpython"],
  },
  {
    key: "published.startupMixtureMs",
    en: ["startup", "start-up", "start up", "cold start", "boot time", "spawn"],
    sv: ["uppstart", "uppstarten", "starttid", "starttiden", "kallstart", "kallstarten", "starta"],
  },
  {
    key: "published.lypningMpMismatch",
    en: ["mismatch", "wrong answer", "wrong answers", "correctness", "disagree"],
    sv: ["felsvar", "fel svar", "avvikelse", "avvikelser", "korrekthet", "stämmer inte"],
  },
  {
    key: "published.routeIdealPct",
    en: ["route", "routing", "classifier", "which engine", "picks the engine", "ideal"],
    sv: ["ruttning", "routing", "dirigering", "klassificerare", "vilken motor", "väljer motor", "idealisk"],
  },
  {
    key: "published.binaryLypningBytes",
    en: ["binary", "binary size", "how big", "bytes", "size of the binary"],
    sv: ["binär", "binären", "binärstorlek", "hur stor", "storlek", "byte"],
  },
];

/**
 * Which series a message is about, best match first. Returns [] for a message
 * that names none — the caller then answers generally rather than guessing at a
 * chart to move.
 *
 * @param {string} text
 * @returns {string[]} series keys
 */
export function matchSeries(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return [];
  /** @type {Array<{key: string, score: number}>} */
  const hits = [];
  for (const row of SERIES_INTENT) {
    let score = 0;
    for (const phrase of [...row.en, ...row.sv]) {
      if (hay.includes(phrase)) score = Math.max(score, phrase.length);
    }
    if (score) hits.push({ key: row.key, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.map((h) => h.key);
}

/**
 * Does this message ask for the battery to be RUN, rather than asked about?
 * EN + SV, same breadth, same reason as above.
 * @param {string} text
 */
export function wantsRun(text) {
  const hay = String(text || "").toLowerCase();
  const phrases = [
    "run the battery", "run it", "run the benchmark", "benchmark it", "measure it",
    "measure now", "run now", "re-run", "rerun", "run again", "start the run",
    "kör batteriet", "kör den", "kör om", "kör igen", "kör nu", "mät nu",
    "mät det", "mät om", "starta mätningen", "mät igen", "gör en mätning",
  ];
  return phrases.some((p) => hay.includes(p));
}

/**
 * Format a value in its unit. Bytes get thousands separators because the
 * binary-size series is the one people compare by eye.
 * @param {number|null} v @param {string} unit
 */
export function formatValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "B") return `${Math.round(v).toLocaleString("en-US")} B`;
  if (unit === "x") return `${v.toFixed(3)}x`;
  if (unit === "%") return `${v.toFixed(1)}%`;
  if (unit === "ms") return `${v.toFixed(2)} ms`;
  if (unit === "us") return v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${Math.round(v)} µs`;
  return Math.round(v).toLocaleString("en-US");
}

// ---- the local responder
//
// The dashboard answers stat questions itself, deterministically, from the data
// it already holds. That is not a downgrade of the lypning agent — it is what
// makes the page work signed out, and what makes it answer instantly enough
// that the chart moving feels like part of the sentence rather than a second
// step. The agent (src/lypning-stats.js) takes over for anything this cannot
// answer, and is handed this same data so the two can never disagree about a
// figure.
//
// It is deliberately incapable of inventing a number: every branch either reads
// a value out of `history`/`live` or says it does not have one.

/**
 * @param {string} question
 * @param {{history: any, live: any}} data
 * @returns {{text: string, focus: string[], run: boolean, handled: boolean}}
 */
export function answerLocally(question, { history, live }) {
  const keys = matchSeries(question);
  const run = wantsRun(question);
  /** @type {string[]} */
  const parts = [];

  if (run) {
    parts.push(
      live && live.running
        ? "The battery is already running — the rows fill in as each case returns."
        : "Starting the battery in this tab's Linux VM. Each case is its own command, so the numbers arrive one at a time.",
    );
  }

  for (const key of keys.slice(0, 2)) {
    const m = movement(history, key);
    if (!m) {
      parts.push(`No commit in the history carries ${key}.`);
      continue;
    }
    const dir = m.improved === null ? "did not move" : m.improved ? "improved" : "went the wrong way";
    const span = `${m.points.length} commit${m.points.length === 1 ? "" : "s"}`;
    parts.push(
      `**${m.label}** ${dir}: ${formatValue(m.first.y, m.unit)} → ${formatValue(m.last.y, m.unit)}` +
        (m.pct == null ? "" : ` (${m.pct > 0 ? "+" : ""}${m.pct.toFixed(1)}%)`) +
        ` over ${span}, last at ${m.last.sha} — “${m.last.subject}”.` +
        (m.measuredHere
          ? " Counted out of the tree by this site."
          : " Quoted from the README that commit published, measured on the author's machine — not a measurement of yours."),
    );
  }

  // A live figure beats a quoted one whenever the reader has one, and saying so
  // is the whole editorial line of the page.
  if (keys.some((k) => k.startsWith("published.startup")) && live && live.summary && live.summary.cold) {
    const cold = Object.entries(live.summary.cold).filter(([, v]) => v != null);
    if (cold.length) {
      parts.push(
        "Your own VM, this session: " +
          cold.map(([e, v]) => `${e} cold ${formatValue(/** @type {number} */ (v), "us")}`).join(", ") +
          ". That is the number that applies to you.",
      );
    }
  }

  if (!parts.length) {
    const named = (history.series || []).map((/** @type {any} */ s) => s.label).join(", ");
    return {
      text:
        "I answer from two things and no others: what this tab's VM measured, and what each lypning " +
        `commit published. The series I hold are — ${named}. Ask about one, or ask me to run the battery.`,
      focus: [],
      run: false,
      handled: false,
    };
  }
  return { text: parts.join("\n\n"), focus: keys.slice(0, 2), run, handled: true };
}

/**
 * The context block handed to the lypning AGENT when it answers instead. Kept
 * here rather than in the Worker so the agent reads the same rows the reader is
 * looking at — the failure mode this avoids is an agent confidently quoting a
 * figure that is not on the screen.
 *
 * @param {any} history
 * @param {any} live live summary, or null
 * @returns {string}
 */
export function statsContextBlock(history, live) {
  const lines = ["LYPNING STATS (the dashboard's own data — answer from this, do not recall figures):"];
  lines.push(`Repository: ${history.source || "https://github.com/kristerhedfors/lypning"}`);
  lines.push(`History: ${(history.commits || []).length} commits, head ${history.head}.`);
  lines.push("");
  lines.push("Series (QUOTED = published by that commit on the author's machine; COUNTED = counted out of the tree here):");
  for (const s of history.series || []) {
    const m = movement(history, s.key);
    if (!m) continue;
    lines.push(
      `- ${m.label} [${s.measuredHere ? "COUNTED" : "QUOTED"}] ${formatValue(m.first.y, m.unit)} → ` +
        `${formatValue(m.last.y, m.unit)} over ${m.points.length} commits` +
        (m.improved === null ? "" : m.improved ? " (improved)" : " (worse)"),
    );
  }
  if (live && live.rows) {
    lines.push("");
    lines.push("LIVE, measured in this reader's own browser Linux VM this session (floor-subtracted, min of N):");
    for (const e of live.engines || []) {
      const cold = live.cold ? live.cold[e] : null;
      lines.push(`- ${e}: cold start ${cold == null ? "not measured" : formatValue(cold, "us")}`);
    }
    for (const row of live.rows) {
      const cells = (live.engines || [])
        .map((/** @type {string} */ e) => `${e}=${row.cells[e] && row.cells[e].us != null ? formatValue(row.cells[e].us, "us") : "—"}`)
        .join(" ");
      lines.push(`- ${row.label}: ${cells}`);
    }
  } else {
    lines.push("");
    lines.push("LIVE: the reader has not run the battery this session — there are no numbers of their own to quote.");
  }
  return lines.join("\n");
}
