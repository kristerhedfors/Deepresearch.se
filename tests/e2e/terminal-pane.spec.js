// LIVE regression cover for the TERMINAL PANE — what a user actually SEES of
// the sandbox, as opposed to whether it boots (that is sandbox.spec.js).
//
// Feedback #38 said the switch did nothing during a cold boot. That was fixed,
// and feedback #42 came back with the next layer of the same complaint: "still
// the terminal is invisible now, button looks pressed but no terminal in
// background". Reproduced here before the fix — the pane showed the boot
// progress while the VM came up, then `stopBootQuips()` cleared that one
// replaceable line and the pane snapped straight back to the "no output yet"
// placeholder, leaving the header icon claiming Linux was running with nothing
// behind the chat to show for it.
//
// So the assertions are about CONTENT, not about the switch: once a boot has
// happened the pane must hold a real transcript of it, and must never fall back
// to the idle placeholder.
//
// This file is NOT matched by the default mocked/live projects; run it via:
//   npx playwright test --config=sandbox.pw.config.js e2e/terminal-pane.spec.js
//
// Environment note (same as sandbox.spec.js): the CheerpX runtime and its
// Debian disk are cross-origin, and an agent proxy may not tunnel either. If
// the VM cannot boot at all the test says so rather than asserting on a boot
// that never ran — but the "boot failed" line is itself part of what this
// change guarantees, so a failed boot still has to leave a visible trace.

import { expect, test } from "@playwright/test";
import { stripCrossOriginAuth } from "./helpers.js";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
const IDLE = "sandbox terminal idle";
const BOOT_CEILING_MS = 150_000;

/** What the terminal pane holds right now, plus the switch's state. */
const paneState = () => {
  const btn = document.getElementById("termbtn");
  const pre = document.querySelector(".dr-agent-backdrop-pre");
  return {
    iconShown: !!btn && !btn.hasAttribute("hidden"),
    pressed: btn ? btn.getAttribute("aria-pressed") : null,
    body: document.body.className,
    text: pre ? pre.textContent || "" : null,
  };
};

test("@live terminal pane: a boot leaves a transcript, and never falls back to the idle placeholder", async ({
  page,
}) => {
  await stripCrossOriginAuth(page.context(), BASE);
  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);
  await page.addInitScript(() => {
    // The CACHED sandbox knob is what reveals the header icon at first paint —
    // this is the returning-sandbox-user path both feedback reports came from.
    localStorage.setItem("dr_bash_lite", "1");
    localStorage.setItem("web_search", "off");
    localStorage.setItem("dr_chat_mode", "normal");
  });

  await page.goto("/");
  await expect(page.locator("#form")).toBeVisible({ timeout: 60_000 });

  // The icon is on screen before the VM has printed anything — deliberate, its
  // presence is the "Linux is starting" signal.
  await page.waitForSelector("#termbtn:not([hidden])", { timeout: 30_000 });

  // Tap it straight away, as the reply to #38 told the user to. The switch must
  // move (that is #38's fix, kept honest here) and bring the terminal forward.
  await page.click("#termbtn");
  const tapped = await page.evaluate(paneState);
  expect(tapped.pressed, "the switch must respond during the cold boot").toBe("true");
  expect(tapped.body, "the terminal must come forward").toContain("term-fg");

  // Wait for the boot to reach a conclusion — success or failure, both of which
  // now write a closing line into the pane.
  const settled = await page
    .waitForFunction(
      () => {
        const pre = document.querySelector(".dr-agent-backdrop-pre");
        const t = pre ? pre.textContent || "" : "";
        return /Linux is running|boot failed|boot timed out|sandbox stopped/.test(t);
      },
      null,
      { timeout: BOOT_CEILING_MS },
    )
    .then(() => true, () => false);

  const after = await page.evaluate(paneState);
  test.info().annotations.push({ type: "pane", description: JSON.stringify(after).slice(0, 900) });

  expect(
    settled,
    `the boot must announce how it ended in the terminal pane; pane held: ${JSON.stringify(after.text)}`,
  ).toBe(true);

  // THE REGRESSION (#42): with a boot behind it, the pane must never read as an
  // empty terminal. Give the log a moment to settle past the closing line.
  await page.waitForTimeout(8_000);
  const rested = await page.evaluate(paneState);
  expect(rested.text, "a pane with a boot behind it is not idle").not.toContain(IDLE);
  expect(
    (rested.text || "").split("\n").filter(Boolean).length,
    `the boot transcript must be more than one line; pane held: ${JSON.stringify(rested.text)}`,
  ).toBeGreaterThan(1);

  // And the stage transcript itself: the timestamped lines the boot commits.
  expect(rested.text, "the pane keeps the stamped boot log").toMatch(/\[\s*\d+\.\d+s\]/);
});
