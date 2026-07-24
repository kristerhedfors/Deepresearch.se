// Dedicated Playwright config for the sandbox live-validation spec
// (e2e/sandbox.spec.js). The default config's projects (mocked/live) filter by
// filename and would exclude this spec, so it gets its own single project that
// reuses the same live-site `use` block (agent proxy, re-signing CA, TLS 1.2
// cap, pre-installed Chromium, break-glass Basic Auth).
//
//   npx playwright test --config=sandbox.pw.config.js

import { defineConfig } from "@playwright/test";

const user = process.env.BASIC_AUTH_USER;
const pass = process.env.BASIC_AUTH_PASS;
if (!user || !pass) {
  throw new Error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /sandbox\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "https://deepresearch.se",
    // ORIGIN-SCOPED credentials, deliberately NOT `extraHTTPHeaders` (2026-07-24).
    // A blanket `authorization` header rides on EVERY request the context makes,
    // cross-origin ones included. That (a) hands the break-glass admin password
    // to third parties, and (b) makes the CheerpX runtime's module fetch a
    // non-simple CORS request, which the CDN answers without a preflight — so
    // `import(CHEERPX_CDN)` fails with net::ERR_FAILED and the VM CANNOT boot.
    // Measured: with extraHTTPHeaders the boot died at 3.2 s in "loading
    // CheerpX…" every time, so this spec only ever exercised the fail-soft
    // fallback and never the sandbox itself. `httpCredentials` with an `origin`
    // only answers a 401 challenge from the site, leaving the CDN and the
    // wss:// disk host to see clean, credential-free requests.
    httpCredentials: {
      username: user,
      password: pass,
      origin: process.env.BASE_URL || "https://deepresearch.se",
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
