// Dedicated Playwright config for the sandbox PERFORMANCE battery
// (e2e/sandbox-perf.spec.js) and the agent-loop event trace
// (e2e/sandbox-agent-trace.spec.js). Same live-site `use` block as
// sandbox.pw.config.js (agent proxy, re-signing CA, TLS 1.2 cap, pre-installed
// Chromium, break-glass Basic Auth) but a much longer timeout — the battery
// boots a real Debian VM and then runs ~40 probes several times each.
//
//   npx playwright test --config=sandbox-perf.pw.config.js
//   npx playwright test --config=sandbox-perf.pw.config.js -g "performance"
//   PERF_REPEATS=5 npx playwright test --config=sandbox-perf.pw.config.js

import { defineConfig } from "@playwright/test";

const user = process.env.BASIC_AUTH_USER;
const pass = process.env.BASIC_AUTH_PASS;
if (!user || !pass) {
  throw new Error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /sandbox-(perf|agent-trace)\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "https://deepresearch.se",
    // Required so `/` resolves to the signed-in `/rver` app (unauthenticated it
    // 302s to `/cure`, which never sets `window.__appReady`). Playwright puts
    // these on cross-origin requests too, which breaks the CheerpX CDN import —
    // both specs here call `stripCrossOriginAuth(context)` (e2e/helpers.js) to
    // remove the header for any origin that is not the site under test.
    extraHTTPHeaders: {
      authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    },
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium",
      ...(process.env.HTTPS_PROXY ? { args: ["--ssl-version-max=tls1.2"] } : {}),
    },
    ...(process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true }
      : {}),
    viewport: { width: 1280, height: 900 },
  },
});
