// AGENT-LOOP EVENT TRACE — one real chat turn with the execution sandbox
// enabled, with a timestamp on every observable event, so we can see where a
// sandbox-backed answer actually spends its time.
//
//   npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"
//
// What gets timestamped (all relative to the moment Send is clicked):
//
//   * every `POST /api/bash/step` — the round boundaries of the agentic shell
//     loop (bash-agent.js fetchShellStep). Request-sent and response-received
//     are recorded separately, so the LLM step latency is visible on its own.
//   * the GAP between one step's response and the next step's request — that
//     window IS the in-VM execution of that round's commands. `execInSandbox`
//     is imported as a module binding (stream.js line 992), not read off
//     `window`, so it cannot be monkey-patched from a test; the step gap is the
//     accurate, non-invasive measurement of it.
//   * every SSE frame on `POST /api/chat`, by `type`, via a tee'd response
//     body — the pipeline phases as the client sees them.
//   * every `sandbox.*` beacon on `POST /api/client-log` (boot stages etc.).
//
// The wrapper is installed as an init script so it is in place before any app
// module runs, and it is a strict pass-through: the tee'd branch is read by the
// collector while the original stream is handed to the app untouched.

import { expect, test } from "@playwright/test";
import { stripCrossOriginAuth } from "./helpers.js";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
const ANSWER_TIMEOUT = 240_000;
// Forces at least two shell rounds: write, then read back and report a number
// the model cannot possibly invent.
const PROMPT =
  process.env.TRACE_PROMPT ||
  "Using the sandbox, write the text 'hello sandbox' into /tmp/trace.txt, then read it back and tell me the exact byte size of that file.";

test("@live sandbox agent trace: timestamps for every event in one sandbox-backed turn", async ({ page }) => {
  test.setTimeout(15 * 60_000);

  const consoleMsgs = [];
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  // ---- the in-page collector (installed before any app code) --------------
  await page.addInitScript(() => {
    const T = { t0: null, events: [] };
    window.__TRACE = T;
    const now = () => Math.round(performance.now());
    const push = (kind, fields) => T.events.push({ kind, ms: now(), ...fields });
    window.__TRACE_MARK = (label) => {
      T.t0 = now();
      push("mark", { label });
    };

    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      let url = "";
      try {
        url = typeof input === "string" ? input : input.url || String(input);
      } catch {
        /* ignore */
      }
      const path = (() => {
        try {
          return new URL(url, location.href).pathname;
        } catch {
          return url;
        }
      })();
      const traced = path === "/api/bash/step" || path === "/api/chat" || path === "/api/client-log";
      if (!traced) return origFetch(input, init);

      push("req", { path });
      const res = await origFetch(input, init);
      push("res", { path, status: res.status });

      // Tee an SSE body so frames are timestamped without disturbing the app.
      const ct = res.headers.get("content-type") || "";
      if (!res.body || !ct.includes("text/event-stream")) return res;
      const [appBranch, traceBranch] = res.body.tee();
      (async () => {
        const reader = traceBranch.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
              if (!dataLine) continue;
              const raw = dataLine.slice(5).trim();
              if (raw === "[DONE]") {
                push("sse", { type: "[DONE]" });
                continue;
              }
              // The wire format is OpenAI-style text deltas plus custom
              // `status` events (see the sse-protocol skill):
              //   {"choices":[{"delta":{"content":"…"}}]}
              //   {"status":{"type":"step_start","id":"plan","label":"…"}}
              let type = "(unparsed)";
              const extra = {};
              try {
                const j = JSON.parse(raw);
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === "string") {
                  type = "delta";
                  extra.chars = delta.length;
                } else if (j.status && typeof j.status === "object") {
                  type = j.status.type || "status";
                  if (j.status.id) extra.id = String(j.status.id).slice(0, 40);
                  if (j.status.label) extra.label = String(j.status.label).slice(0, 70);
                  if (j.status.query) extra.label = String(j.status.query).slice(0, 70);
                  if (typeof j.status.duration_ms === "number") extra.dur = j.status.duration_ms;
                } else {
                  type = Object.keys(j).join("+").slice(0, 40) || "(empty)";
                }
              } catch {
                type = raw.slice(0, 40);
              }
              push("sse", { type, ...extra });
            }
          }
        } catch (e) {
          push("sse-error", { err: String(e).slice(0, 120) });
        }
        push("sse-end", {});
      })();
      return new Response(appBranch, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };

    try {
      localStorage.setItem("web_search", "off");
      localStorage.setItem("dr_bash_lite", "1");
      localStorage.setItem("dr_sandbox_debug", "1");
    } catch {
      /* storage may be blocked pre-navigation */
    }
  });

  // The break-glass header must not reach the CheerpX CDN or the VM cannot boot.
  await stripCrossOriginAuth(page.context(), BASE);
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);
  page.on("dialog", (d) => d.accept().catch(() => {}));

  // Best-effort: turn the server-side knob on for this identity.
  let putStatus = null;
  try {
    const put = await page.request.put(`${BASE}/api/settings`, {
      headers: { "content-type": "application/json" },
      data: { bash_lite_mcp: true },
    });
    putStatus = put.status();
  } catch (e) {
    putStatus = `error:${e.message}`;
  }
  console.log("PUT /api/settings bash_lite_mcp:true ->", putStatus);

  await page.goto(`${BASE}/`);
  await expect(page.locator("#form")).toBeVisible({ timeout: 30_000 });
  try {
    await page.waitForFunction(() => window.__appReady === true, { timeout: 45_000 });
  } catch {
    const where = await page.evaluate(() => ({ url: location.href, ready: window.__appReady }));
    throw new Error(
      `app never became ready — landed on ${where.url} (__appReady=${where.ready}); ` +
        `an unauthenticated "/" 302s to /cure. Check BASIC_AUTH_USER/PASS.`,
    );
  }

  const iso = await page.evaluate(() => ({ coi: window.crossOriginIsolated === true }));
  console.log("crossOriginIsolated:", iso.coi);

  // ---- run the turn -------------------------------------------------------
  await page.fill("#input", PROMPT);
  await page.evaluate(() => window.__TRACE_MARK("send-click"));
  await page.click("#send");

  const turn = page.locator(".msg.assistant").nth(0);
  await expect(turn.locator(".stats")).not.toHaveText("", { timeout: ANSWER_TIMEOUT });
  await page.evaluate(() => window.__TRACE.events.push({ kind: "mark", ms: Math.round(performance.now()), label: "turn-complete" }));

  const trace = await page.evaluate(() => window.__TRACE);
  // The sandbox boots LAZILY — only once the loop actually proposes a command —
  // so the first round's "exec window" is boot + command, not command alone.
  // sandboxFsSummary().ms is the boot's own measurement, which splits the two.
  const fsSummary = await page.evaluate(async () => {
    try {
      const mod = await import("/js/sandbox.js");
      return mod.sandboxFsSummary?.() ?? null;
    } catch {
      return null;
    }
  });
  const answer = (await turn.locator(".content").innerText()).trim();

  // ---- render the timeline ------------------------------------------------
  const t0 = trace.events.find((e) => e.label === "send-click")?.ms ?? 0;
  const rel = (e) => e.ms - t0;

  console.log("\n================ SANDBOX AGENT TURN TIMELINE ================");
  console.log(`prompt: ${PROMPT}`);
  console.log(`crossOriginIsolated=${iso.coi}  settings PUT=${putStatus}\n`);
  // A streamed answer is hundreds of `delta` frames; printing one line each
  // buries every meaningful event. Collapse consecutive deltas into one row
  // carrying the run's frame count, total characters, and elapsed span.
  const collapsed = [];
  for (const e of trace.events) {
    const last = collapsed[collapsed.length - 1];
    if (e.kind === "sse" && e.type === "delta" && last && last.run) {
      last.n += 1;
      last.chars += e.chars || 0;
      last.endMs = e.ms;
      continue;
    }
    if (e.kind === "sse" && e.type === "delta") {
      collapsed.push({ ...e, run: true, n: 1, chars: e.chars || 0, endMs: e.ms });
      continue;
    }
    collapsed.push(e);
  }

  console.log("     t(ms)   Δ(ms)  event");
  let prev = t0;
  for (const e of collapsed) {
    const t = rel(e);
    const d = e.ms - prev;
    prev = e.run ? e.endMs : e.ms;
    const desc = e.run
      ? `sse: ${e.n} answer deltas over ${e.endMs - e.ms} ms (${e.chars} chars)`
      : e.kind === "mark"
        ? `── ${e.label} ──`
        : e.kind === "sse"
          ? `sse: ${e.type}${e.id ? ` [${e.id}]` : ""}${e.label ? ` ${e.label}` : ""}${e.dur ? ` (${e.dur}ms)` : ""}`
          : `${e.kind}: ${e.path || ""}${e.status ? ` ${e.status}` : ""}${e.err ? ` ${e.err}` : ""}`;
    console.log(`  ${String(t).padStart(7)} ${String(d).padStart(7)}  ${desc}`);
  }

  // ---- derive the shell-loop phase breakdown ------------------------------
  const steps = trace.events.filter((e) => e.path === "/api/bash/step");
  const rounds = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== "req") continue;
    const res = steps.slice(i + 1).find((e) => e.kind === "res");
    const nextReq = steps.slice(i + 1).find((e) => e.kind === "req");
    if (!res) continue;
    rounds.push({
      round: rounds.length + 1,
      stepMs: res.ms - steps[i].ms,
      execWindowMs: nextReq ? nextReq.ms - res.ms : null,
    });
  }
  const bootMs = fsSummary && typeof fsSummary.ms === "number" ? fsSummary.ms : null;
  console.log("\n## Shell-loop rounds (step = server LLM decision, exec window = in-VM run)");
  for (const r of rounds) {
    let line =
      `  round ${r.round}: step ${String(r.stepMs).padStart(6)} ms` +
      (r.execWindowMs !== null ? `   exec window ${String(r.execWindowMs).padStart(6)} ms` : "   (last round)");
    // Round 1 pays the lazy cold boot; attribute it so the command cost is honest.
    if (r.round === 1 && r.execWindowMs !== null && bootMs !== null) {
      line += `  = VM boot ${bootMs} ms + commands ~${r.execWindowMs - bootMs} ms`;
    }
    console.log(line);
  }
  const totalStep = rounds.reduce((a, r) => a + r.stepMs, 0);
  const totalExec = rounds.reduce((a, r) => a + (r.execWindowMs || 0), 0);
  const chatReq = trace.events.find((e) => e.kind === "req" && e.path === "/api/chat");
  const end = trace.events.find((e) => e.label === "turn-complete");
  console.log(`\n  shell loop total : ${totalStep + totalExec} ms  (LLM steps ${totalStep} ms + in-VM ${totalExec} ms)`);
  if (chatReq) console.log(`  /api/chat starts : ${rel(chatReq)} ms after send`);
  if (end) console.log(`  turn complete    : ${rel(end)} ms after send`);
  console.log("\n--- ANSWER ---");
  console.log(answer.slice(0, 1000));
  console.log("=============================================================\n");

  await test.info().attach("sandbox-agent-trace.json", {
    body: JSON.stringify({ prompt: PROMPT, iso, putStatus, t0, events: trace.events, rounds, bootMs, fsSummary, answer }, null, 2),
    contentType: "application/json",
  });

  expect(answer.length, "the turn must produce an answer").toBeGreaterThan(0);
  expect(/sandbox not ready/i.test(answer), "answer must not say 'sandbox not ready'").toBe(false);
});
