// LIVE regression cover for the TERMINAL PANE when the commands run somewhere
// the pane cannot see for itself — feedback #43.
//
// terminal-pane.spec.js covers the in-browser VM: it narrates its own boot and
// mirrors every command from inside public/js/sandbox.js, so the pane fills by
// construction. A REMOTE execution environment — the user's own DREE/1 runner,
// or Se/rver's cloud container — narrates nothing: exec-backends-core.js's
// Runner is a health probe and a fetch. On 2026-07-27 the container became
// Se/rver's DEFAULT environment, so that silence became the common case, and
// the next send reported it:
//
//   "feedback terminal commands did not show up in background this time
//    neither: [ sandbox terminal idle — no output yet ]"
//
// chat_logs #690 is the proof it was not the user's imagination:
// `client_diag.xb: "cloudflare"`, `ran: 1`, `meta.shell` holding a real `ls /`
// whose output wrote the answer — while the pane behind that answer said it had
// never seen anything.
//
// This spec is DETERMINISTIC AND FREE. Every external leg is intercepted: the
// step model (/api/bash/step returns a canned command), the runner itself (a
// stub DREE/1 service at the configured localhost URL), and the answer
// (/api/chat's SSE). So it asserts the wiring — does a remote run reach the
// pane — without a model call, a container, or a real runner.
//
// It uses the LOCAL backend rather than the cloud container because a local
// runner's base URL is client-configured and therefore interceptable, while
// /api/exec is same-origin and needs a real deploy binding. Both flow through
// the identical seam (selectRunner → the shell pass's mirror), so the local
// runner is the honest stand-in and the cheap one.
//
// Not matched by the default mocked/live projects; run it via:
//   npx playwright test --config=sandbox.pw.config.js e2e/terminal-remote.spec.js

import { expect, test } from "@playwright/test";
import { stripCrossOriginAuth } from "./helpers.js";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
const IDLE = "sandbox terminal idle";
const RUNNER = "http://127.0.0.1:8100";
const COMMAND = "ls /";
const STDOUT = "bin\nboot\netc\nsrc\nworkspace\n";
// A sentinel in the runner's output: it can only reach the pane by travelling
// the whole path this fix adds, so finding it is not something a placeholder or
// a coincidence can fake.
const MARKER = "DR43-REMOTE-MARKER";

/**
 * Wait until /api/settings has landed with the sandbox knob on.
 *
 * NOT optional and not a flake guard. `bashLiteOn()` reads the SERVER settings
 * object, not the `dr_bash_lite` localStorage cache (that one only drives first
 * paint and the header icon), so a send fired before the fetch resolves skips
 * the shell pass entirely — the runner is never called and the spec would pass
 * or fail for reasons that have nothing to do with the terminal. Polling the
 * real module is the honest check: it asks the exact predicate the send path
 * asks.
 */
const settingsResolved = (page) =>
  expect
    .poll(
      async () =>
        await page.evaluate(() =>
          import("/js/settings.js").then((m) => m.bashLiteOn()).catch(() => false),
        ),
      { timeout: 60_000, message: "the sandbox knob never resolved — the shell pass would be skipped" },
    )
    .toBe(true);

/** What the terminal pane holds right now, plus the switch's state. */
const paneState = () => {
  const btn = document.getElementById("termbtn");
  const pre = document.querySelector(".dr-agent-backdrop-pre");
  return {
    iconShown: !!btn && !btn.hasAttribute("hidden"),
    pressed: btn ? btn.getAttribute("aria-pressed") : null,
    text: pre ? pre.textContent || "" : null,
  };
};

test("@live terminal pane: a run on a REMOTE execution environment reaches the pane", async ({ page }) => {
  await stripCrossOriginAuth(page.context(), BASE);
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);

  await page.addInitScript(
    ([runner]) => {
      localStorage.setItem("dr_bash_lite", "1");
      localStorage.setItem("web_search", "off");
      localStorage.setItem("dr_chat_mode", "normal");
      localStorage.setItem("budget_s", "15");
      // THE POINT OF THE SPEC: this device runs its commands somewhere else.
      // With this set, stream.js takes the remote branch — no VM boot, no
      // sandbox.js, and (before the fix) nothing at all in the pane.
      localStorage.setItem("dr_exec_env", JSON.stringify({ backend: "local", baseUrl: runner, key: "" }));
    },
    [RUNNER],
  );

  // The sandbox knob must be on for the shell pass to engage at all.
  await page.route("**/api/settings", async (route) => {
    try {
      if (route.request().method() !== "GET") return await route.continue();
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      await route.fulfill({ response: res, json: { ...body, bash_lite_mcp: true, chat_mode: "science" } });
    } catch { /* page closed mid-flight */ }
  });

  // ---- the stub DREE/1 runner ------------------------------------------------
  const execCalls = [];
  await page.route(`${RUNNER}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) =>
      route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/healthz") {
      // Deliberately WITHOUT mount/source: a runner that offers neither still
      // runs commands, and this spec is about the terminal, not about mounts.
      return json({ ok: true, protocol: "dree/1", backend: "local", image: "debian", network: "none", version: "1" });
    }
    if (path === "/exec") {
      execCalls.push(route.request().postDataJSON()?.command || "");
      return json({ exitCode: 0, stdout: STDOUT + MARKER + "\n", stderr: "" });
    }
    return json({ ok: true });
  });

  // ---- the step model: one command, then done --------------------------------
  let step = 0;
  await page.route("**/api/bash/step", async (route) => {
    step++;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        step === 1
          ? { commands: [COMMAND], done: false, reasoning: "list the root" }
          : { commands: [], done: true, reasoning: "" },
      ),
    });
  });

  // ---- the answer ------------------------------------------------------------
  const chatPayloads = [];
  await page.route("**/api/chat", async (route) => {
    chatPayloads.push(route.request().postDataJSON());
    const events = [
      { choices: [{ delta: { content: "Listed the root directory." } }] },
      { status: { type: "done", model: "mock-model", rounds: 1, searches: 0, duration_ms: 42, prompt_tokens: 10, completion_tokens: 20 } },
    ];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
    });
  });

  await page.goto("/");
  await expect(page.locator("#form")).toBeVisible({ timeout: 60_000 });
  await settingsResolved(page);

  await page.fill("#input", "list the files in /");
  await page.click("#send");

  // The shell pass has to have actually happened on the remote runner —
  // otherwise the pane assertions below would be testing nothing.
  await expect
    .poll(() => execCalls.length, { timeout: 90_000, message: "the stub runner never received a command" })
    .toBeGreaterThan(0);
  expect(execCalls[0]).toContain("ls");

  await expect(page.locator(".msg.assistant").first().locator(".stats")).not.toHaveText("", { timeout: 60_000 });

  // The header icon is the way in — it must be there, and it must respond.
  await page.waitForSelector("#termbtn:not([hidden])", { timeout: 30_000 });
  await page.click("#termbtn");
  const tapped = await page.evaluate(paneState);
  expect(tapped.pressed, "the switch must respond").toBe("true");

  const pane = await page.evaluate(paneState);
  test.info().annotations.push({ type: "pane", description: JSON.stringify(pane).slice(0, 900) });
  const text = pane.text || "";

  // THE REGRESSION (#43): commands ran, so the pane is not idle.
  expect(text, `commands ran on the runner — the pane cannot be idle; held: ${JSON.stringify(text)}`)
    .not.toContain(IDLE);

  // What the user asked to see, in order: which environment was reached, the
  // command in full, and its real output.
  expect(text, "the pane names the environment it connected to").toMatch(/connecting to the local runner|commands run in the local runner/);
  expect(text, "the pane shows the command").toContain("$ " + COMMAND);
  expect(text, "the pane shows the command's real output").toContain(MARKER);
  // The stamped connect log, same shape the browser VM's boot writes.
  expect(text, "the connect is stamped like a boot").toMatch(/\[\s*\d+\.\d+s\]/);

  // ---- and the chat log can now answer the question the user raised ----------
  const diag = chatPayloads.at(-1)?.client_diag;
  expect(diag?.xb, "the log records WHERE the commands ran").toBe("local");
  expect(diag?.xd, "the log carries an execution diagnostic").toBeTruthy();
  expect(diag.xd.boot, "the environment came up").toBe(1);
  expect(diag.xd.cmds, "one command ran").toBeGreaterThan(0);
  // The counter that makes "the terminal was empty" checkable from a chat log
  // instead of reproducible only by asking the user to try again.
  expect(diag.xd.term, "the pane was written to").toBeGreaterThan(0);
});

test("@live terminal pane: a REMOTE environment that cannot be reached says so", async ({ page }) => {
  // The other half of feedback #42's lesson, applied to the environment that
  // has no boot ticker: a failure must leave words in the pane, not a blank
  // field under a lit-up icon.
  await stripCrossOriginAuth(page.context(), BASE);
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);

  await page.addInitScript(
    ([runner]) => {
      localStorage.setItem("dr_bash_lite", "1");
      localStorage.setItem("web_search", "off");
      localStorage.setItem("dr_chat_mode", "normal");
      localStorage.setItem("budget_s", "15");
      localStorage.setItem("dr_exec_env", JSON.stringify({ backend: "local", baseUrl: runner, key: "" }));
    },
    [RUNNER],
  );
  await page.route("**/api/settings", async (route) => {
    try {
      if (route.request().method() !== "GET") return await route.continue();
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      await route.fulfill({ response: res, json: { ...body, bash_lite_mcp: true, chat_mode: "science" } });
    } catch { /* page closed mid-flight */ }
  });

  // The runner is not there.
  await page.route(`${RUNNER}/**`, (route) => route.abort("connectionrefused"));

  let step = 0;
  await page.route("**/api/bash/step", async (route) => {
    step++;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(step === 1 ? { commands: [COMMAND], done: false, reasoning: "" } : { commands: [], done: true, reasoning: "" }),
    });
  });

  const chatPayloads = [];
  await page.route("**/api/chat", async (route) => {
    chatPayloads.push(route.request().postDataJSON());
    const events = [
      { choices: [{ delta: { content: "Answered without a shell." } }] },
      { status: { type: "done", model: "mock-model", rounds: 1, searches: 0, duration_ms: 42, prompt_tokens: 10, completion_tokens: 20 } },
    ];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
    });
  });

  await page.goto("/");
  await expect(page.locator("#form")).toBeVisible({ timeout: 60_000 });
  await settingsResolved(page);
  await page.fill("#input", "list the files in /");
  await page.click("#send");
  await expect(page.locator(".msg.assistant").first().locator(".stats")).not.toHaveText("", { timeout: 60_000 });

  await page.waitForSelector("#termbtn:not([hidden])", { timeout: 30_000 });
  await page.click("#termbtn");
  const pane = await page.evaluate(paneState);
  const text = pane.text || "";
  test.info().annotations.push({ type: "pane", description: JSON.stringify(pane).slice(0, 900) });

  expect(text, "a failed connect is not an idle terminal").not.toContain(IDLE);
  expect(text, "the pane says the environment could not be reached").toMatch(/could not reach the local runner/);
  expect(text, "…and that the answer has no shell behind it").toMatch(/answering without a shell/);

  // The chat log says the same thing, in counters.
  const diag = chatPayloads.at(-1)?.client_diag;
  expect(diag?.xd?.boot, "the environment did not come up").toBe(0);
  expect(diag?.xd?.err, "…and the log names why").toBe("boot-failed");
});
