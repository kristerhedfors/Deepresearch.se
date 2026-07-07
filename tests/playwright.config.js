// E2E suite against the LIVE site (default https://deepresearch.se) using
// the break-glass Basic Auth credentials from the environment. Two projects:
//
//   mocked — /api/chat is intercepted; verifies client-side parsing of every
//            attachment type by asserting on the request payload. Free, fast,
//            parallel.
//   live   — real /api/chat runs against Berget (and Exa in the tagged
//            test). Serial, generous timeouts, one retry (LLM answers are
//            not perfectly deterministic).
//
// Run: cd tests && npm install && npm run fixtures && npm test
// (BASIC_AUTH_USER / BASIC_AUTH_PASS must be set.)

import { defineConfig } from "@playwright/test";

const user = process.env.BASIC_AUTH_USER;
const pass = process.env.BASIC_AUTH_PASS;
if (!user || !pass) {
  throw new Error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "https://deepresearch.se",
    extraHTTPHeaders: {
      authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    },
    // The environment pre-installs Chromium here; the pinned Playwright
    // version may expect a different revision, so point at it explicitly.
    // Outbound HTTPS in this environment goes through an agent proxy that
    // re-signs TLS with its own CA; Chromium neither reads HTTPS_PROXY nor
    // trusts that CA on its own. The MITM also resets Chromium's TLS 1.3
    // ClientHello (verified: CONNECT succeeds, hello → RST; openssl works),
    // so cap the browser↔proxy leg at TLS 1.2.
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium",
      ...(process.env.HTTPS_PROXY ? { args: ["--ssl-version-max=tls1.2"] } : {}),
    },
    ...(process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true }
      : {}),
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: "mocked",
      testMatch: /(parsing|limits|report|api|ui|metadata|projects|maps)\.spec\.js/,
      timeout: 90_000,
    },
    {
      name: "live",
      testMatch: /live\.spec\.js/,
      timeout: 360_000,
      retries: 1,
      workers: 1,
    },
  ],
});
