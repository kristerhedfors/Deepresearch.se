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
    // ORIGIN-SCOPED credentials, deliberately NOT `extraHTTPHeaders`. A blanket
    // `authorization` header is attached to EVERY request the context makes,
    // including cross-origin ones — which (a) leaks the break-glass admin
    // password to third parties, and (b) turns the CheerpX runtime's module
    // fetch into a non-simple CORS request the CDN answers with no preflight,
    // so `import(CHEERPX_CDN)` dies with net::ERR_FAILED and the VM can never
    // boot. `httpCredentials` with an `origin` only answers a 401 challenge
    // from the site itself, so the CDN and disk host see clean requests.
    httpCredentials: { username: user, password: pass, origin: process.env.BASE_URL || "https://deepresearch.se" },
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
