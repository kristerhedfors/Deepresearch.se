// LIVE validation of the iOS-PWA sandbox "sandbox not ready" fix
// (public/js/sandbox.js, commit 2279051). Drives a REAL Chromium against
// production, cross-origin isolated with the bash-lite knob on, sends the
// exact repro message ("List files in /"), and asserts the answer never says
// "sandbox not ready" — the sandbox either boots+runs OR falls back cleanly,
// never a hang.
//
// This file is NOT matched by the default mocked/live projects; run it via its
// own config:  npx playwright test --config=sandbox.pw.config.js
//
// Environment note: the CheerpX Debian disk streams over wss://disks.webvm.io
// and the CheerpX runtime imports from a cross-origin CDN. The agent proxy may
// not tunnel either, so the VM boot can fail — that is an ENVIRONMENT limit,
// not a code bug. The assertion that matters regardless is the fail-soft one:
// the turn completes, the answer does NOT say "sandbox not ready", no hang.

import { expect, test } from "@playwright/test";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
const ANSWER_TIMEOUT = 180_000;
const REPRO = "List files in /";

test("@live sandbox: 'List files in /' never answers 'sandbox not ready' (boots+runs or clean fallback)", async ({
  page,
}) => {
  // ---- collectors ---------------------------------------------------------
  const consoleMsgs = [];
  page.on("console", (m) => {
    consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  // Sandbox boot-stage beacons ride POST /api/client-log (navigator.sendBeacon
  // and fetch both surface as requests). Record their bodies.
  const bootEvents = [];
  page.on("request", (req) => {
    try {
      if (req.method() !== "POST") return;
      const p = new URL(req.url()).pathname;
      if (p === "/api/client-log") {
        const body = req.postData();
        if (body) bootEvents.push(body);
      }
    } catch {
      /* ignore */
    }
  });

  // Record the real /api/chat request payloads (client_diag lives here).
  const chatPayloads = [];
  page.on("request", (req) => {
    try {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") {
        chatPayloads.push(req.postDataJSON());
      }
    } catch {
      /* ignore */
    }
  });

  // ---- server-side: enable the bash_lite_mcp knob -------------------------
  // (The break-glass admin gets sandbox availability + COEP automatically via
  // bashLiteEnabled(); this PUT is best-effort belt-and-suspenders and must not
  // fail the test if the secret-admin identity has no settings row.)
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

  // ---- pre-navigation client state ----------------------------------------
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("web_search", "off");
      localStorage.setItem("budget_s", "15");
      localStorage.setItem("dr_bash_lite", "1"); // sandbox knob mirror → isolation self-heal
      localStorage.setItem("dr_sandbox_debug", "1"); // flush boot-stage beacons
    } catch {
      /* storage may be blocked pre-navigation on the very first hit */
    }
  });
  page.on("dialog", (d) => d.accept().catch(() => {}));

  // ---- probe the document COEP header up front ----------------------------
  let coepHeader = null;
  try {
    const docRes = await page.request.get(`${BASE}/rver`);
    coepHeader = docRes.headers()["cross-origin-embedder-policy"] || "(absent)";
    console.log("/rver COEP header:", coepHeader, "status:", docRes.status());
  } catch (e) {
    console.log("/rver header probe error:", e.message);
  }

  // ---- open the app (/, which 302s a signed-in admin to /rver) ------------
  await page.goto(`${BASE}/`);
  // The isolation self-heal may location.replace() to ?_coep=<ts>. Wait for the
  // composer + app-ready on whatever page we settle on.
  await expect(page.locator("#form")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => window.__appReady === true, { timeout: 30_000 });
  await expect(page.locator("#privacy")).toBeHidden();

  // ---- (a) isolation achieved? --------------------------------------------
  const iso = await page.evaluate(() => ({
    coi: window.crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer,
    url: location.href,
  }));
  console.log("ISOLATION:", JSON.stringify(iso), "COEP:", coepHeader);

  expect(
    iso.coi,
    `page must be cross-origin isolated (COEP header was "${coepHeader}", url ${iso.url})`,
  ).toBe(true);
  expect(iso.sab, "SharedArrayBuffer must be defined when isolated").toBe("function");

  // ---- (b) module graph linked --------------------------------------------
  const appReady = await page.evaluate(() => window.__appReady === true);
  expect(appReady, "window.__appReady must be true").toBe(true);

  // ---- (d) send the exact repro message -----------------------------------
  await page.fill("#input", REPRO);
  await page.click("#send");

  // Wait for the turn to complete (stats footer fills). Generous: a cold VM
  // boot + the whole shell loop is wall-capped at 120s.
  const turn = page.locator(".msg.assistant").nth(0);
  await expect(turn.locator(".stats")).not.toHaveText("", { timeout: ANSWER_TIMEOUT });

  // ---- (e) capture the answer + client_diag -------------------------------
  const answer = (await turn.locator(".content").innerText()).trim();
  const diag = chatPayloads.length ? chatPayloads.at(-1).client_diag : null;

  // Parse the boot-stage timeline from the beacon bodies.
  const stages = [];
  const events = [];
  for (const body of bootEvents) {
    try {
      const j = JSON.parse(body);
      const rows = Array.isArray(j) ? j : j.logs || j.events || [j];
      for (const r of rows) {
        const name = r.event || r.name || r.msg || "";
        if (typeof name === "string" && name.startsWith("sandbox.")) {
          events.push({ event: name, ...(r.data || r.fields || {}) });
          if (name === "sandbox.boot_stage" && r.data && r.data.stage) stages.push(r.data.stage);
        }
      }
    } catch {
      /* non-JSON beacon body — ignore */
    }
  }

  console.log("\n================ SANDBOX VALIDATION REPORT ================");
  console.log("PUT /api/settings status :", putStatus);
  console.log("/rver COEP header        :", coepHeader);
  console.log("crossOriginIsolated      :", iso.coi, "| SharedArrayBuffer:", iso.sab);
  console.log("settled URL              :", iso.url);
  console.log("client_diag              :", JSON.stringify(diag));
  console.log("boot-stage timeline      :", stages.join(" -> ") || "(none captured)");
  console.log("sandbox events           :");
  for (const e of events) console.log("   ", JSON.stringify(e));
  console.log("--- ANSWER (first 1200 chars) ---");
  console.log(answer.slice(0, 1200));
  console.log("=========================================================\n");

  // Persist a machine-readable copy for the report.
  await test.info().attach("sandbox-report.json", {
    body: JSON.stringify(
      { putStatus, coepHeader, iso, diag, stages, events, answer, consoleTail: consoleMsgs.slice(-40) },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // ---- (f) the core assertions --------------------------------------------
  expect(answer.length, "the turn must produce a non-empty answer (no hang)").toBeGreaterThan(0);
  expect(
    /sandbox not ready/i.test(answer),
    `answer must NOT contain "sandbox not ready" — got: ${answer.slice(0, 300)}`,
  ).toBe(false);
  await expect(turn.locator(".content")).not.toHaveClass(/error-text/);

  const ran = diag && typeof diag.ran === "number" ? diag.ran : 0;
  if (ran >= 1) {
    console.log(`RESULT: sandbox BOOTED and RAN ${ran} command round(s).`);
    // If it truly ran, a root listing should mention real dirs. Soft-checked
    // (the model's wording varies); logged, not hard-asserted, so a booted-but-
    // terse answer doesn't flake.
    const hasRootDirs = /\b(bin|etc|usr|workspace|root|home|var|lib)\b/.test(answer);
    console.log("answer mentions real root dirs:", hasRootDirs);
  } else {
    console.log("RESULT: sandbox did NOT run (ran=0) — verifying CLEAN FALLBACK.");
    console.log("   (fail-soft: turn completed, no 'sandbox not ready', no hang.)");
  }
});
