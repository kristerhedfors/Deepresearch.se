// Dedicated Playwright config for the sandbox live-validation specs
// (e2e/sandbox.spec.js — does it boot and run; e2e/terminal-pane.spec.js — what
// the user SEES of it). The default config's projects (mocked/live) filter by
// filename and would exclude both, so they get their own single project that
// reuses the same live-site `use` block (agent proxy, re-signing CA, TLS 1.2
// cap, pre-installed Chromium, break-glass Basic Auth).
//
//   npx playwright test --config=sandbox.pw.config.js
//   npx playwright test --config=sandbox.pw.config.js e2e/terminal-pane.spec.js

import { defineConfig } from "@playwright/test";

const user = process.env.BASIC_AUTH_USER;
const pass = process.env.BASIC_AUTH_PASS;
if (!user || !pass) {
  throw new Error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(sandbox|terminal-pane)\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "https://deepresearch.se",
    // These ride on EVERY request the context makes, cross-origin ones
    // included — which silently broke this very spec: with an `authorization`
    // header attached, the CheerpX runtime's `import(CHEERPX_CDN)` fails with
    // net::ERR_FAILED, so the VM died at "loading CheerpX…" and only the
    // fail-soft fallback was ever exercised. The header is still REQUIRED here
    // (an unauthenticated `/` 302s to the anonymous `/cure` tier, which never
    // sets `window.__appReady`), so the fix is not to drop it but to strip it
    // per-origin: call `stripCrossOriginAuth(context)` from e2e/helpers.js in
    // any spec that boots the sandbox. See that helper for the full rationale.
    extraHTTPHeaders: {
      authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    },
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium",
      ...(process.env.HTTPS_PROXY ? { args: ["--ssl-version-max=tls1.2"] } : {}),
    },
    // `bypass` keeps a LOCAL target reachable: pointing BASE_URL at a
    // `wrangler dev` on 127.0.0.1 is how a branch gets verified before it is
    // merged and deployed, and the agent proxy cannot route to loopback. The
    // cross-origin CheerpX runtime + disk still go through the proxy, which is
    // the only reason it is configured at all.
    ...(process.env.HTTPS_PROXY
      ? {
          proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" },
          ignoreHTTPSErrors: true,
        }
      : {}),
    viewport: { width: 1280, height: 900 },
  },
});
