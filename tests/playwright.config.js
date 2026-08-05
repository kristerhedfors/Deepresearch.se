// E2E suite. Two projects:
//
//   mocked — /api/chat is intercepted; verifies client-side parsing of every
//            attachment type by asserting on the request payload. Free, fast,
//            parallel.
//   live   — real /api/chat runs against Berget (and Exa in the tagged
//            test). Serial, generous timeouts, one retry (LLM answers are
//            not perfectly deterministic).
//
// TWO TARGETS (local added 2026-07-29).
//
//   LOCAL   `npm run test:local` — starts `wrangler dev` on this machine
//           (wrangler.dev.toml) and points the suite at it. No credentials, no
//           account, no network, nothing spent. This is what CI runs, and what
//           you get by default when no target is configured.
//   REMOTE  set BASE_URL (and BASIC_AUTH_USER / BASIC_AUTH_PASS) to run
//           against the deployed site or a branch preview URL.
//
// Until this existed the config THREW without break-glass credentials, so the
// 43 free mocked tests could not be run at all by anyone who did not have
// production secrets — and consequently nothing ran them. That was gap A4 in
// docs/TESTING-GAP-ANALYSIS.md.
//
// Run: cd tests && npm install && npm run fixtures && npm run test:local

import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

/** Where this repo's dev containers pre-install Chromium. Absent on CI. */
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

// Local-mode Basic Auth. These are not secrets: they are the [vars] in
// wrangler.dev.toml, accepted only by a Worker running on this machine
// against a scratch database. Keep the two files in step.
const LOCAL_USER = "e2e";
const LOCAL_PASS = "e2e-local-worker-no-secret";
const LOCAL_PORT = process.env.E2E_PORT || "8787";
const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}`;
// Must match BERGET_URL in wrangler.dev.toml.
const FAKE_PROVIDER_PORT = process.env.FAKE_PROVIDER_PORT || "8799";

/**
 * PINNED, deliberately. CI ran `npx wrangler` bare, so every run silently took
 * whatever wrangler had published that day — which means the e2e failure rate
 * moved under us and no two runs were the same experiment. That was written
 * down as a mitigation at the fifth crash (docs/MERGED-BRANCHES.md,
 * `claude/wrangler-crash-fifth-occurrence`) and never done; occurrences six
 * (PR #361) and seven (PR #364) followed.
 *
 * Bumping this is a deliberate act with a CI run behind it, not a side effect
 * of the date. Override with WRANGLER_VERSION to test a candidate.
 */
const WRANGLER_VERSION = process.env.WRANGLER_VERSION || "4.118.0";

/**
 * The dev server, wrapped in a restart loop — see `tests/dev-server.sh`, which
 * is that loop and carries the full reasoning.
 *
 * The crash it exists for is not ours and is not fixable from here: a transient
 * socket drop on miniflare's internal loopback
 * (`#handleLoopbackCustomFetchService` → `Network connection lost.`) gets
 * escalated to a process-ending fatal by wrangler's own `ProxyController`. It
 * has now killed `wrangler dev` mid-suite a dozen times.
 *
 * Playwright's `webServer` has no restart-on-exit, so that one dropped socket
 * used to cost the ENTIRE remaining suite: every later test dies on
 * ERR_CONNECTION_REFUSED. The blast radius is therefore random — the same
 * commit range once lost 27 of 63 and then 4 of 63 — which also makes the
 * failure count meaningless as a signal about the diff.
 *
 * The loop brings the port back, so a crash costs the test(s) actually in
 * flight rather than everything after it. Paired with `retries` on the mocked
 * project, that is meant to turn this class of failure into a retry instead of
 * a red build — and until 2026-08-05 it did not, because the RESTART WAS
 * SLOWER THAN THE RETRY. Occurrence 11 (run 30988531735) put the outage at
 * 5.0 s while Playwright re-navigated ~3.2 s in, so the retry finished 0.48 s
 * before the port came back and the build went red anyway. `dev-server.sh` cuts
 * our own share of that gap — a 2 s sleep and a redundant `npx` resolution —
 * measured end to end at 6.05 s → 3.39 s, a 44% cut; what is left is wrangler's
 * own start-up, which nothing here can shorten.
 *
 * It deliberately does NOT mask a Worker that cannot boot at all: a wrangler
 * that exits immediately just restarts in a loop and Playwright still times out
 * waiting for the URL.
 */
const WRANGLER_SUPERVISED = "./tests/dev-server.sh";

const envUser = process.env.BASIC_AUTH_USER;
const envPass = process.env.BASIC_AUTH_PASS;

// Local unless the caller explicitly points somewhere else. `E2E_TARGET=local`
// forces it; a BASE_URL on a loopback host implies it.
const explicitLocal = process.env.E2E_TARGET === "local";
const baseUrlIsLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(process.env.BASE_URL || "");
// No BASE_URL and no credentials is someone running the suite for the first
// time. Serve them a working local run rather than an exception.
const nothingConfigured = !process.env.BASE_URL && (!envUser || !envPass);
const LOCAL = explicitLocal || baseUrlIsLocal || nothingConfigured;

if (!LOCAL && (!envUser || !envPass)) {
  throw new Error(
    "Remote target selected (BASE_URL is set) but BASIC_AUTH_USER / BASIC_AUTH_PASS are not. " +
      "Set them, or run against a local Worker with E2E_TARGET=local.",
  );
}

const user = LOCAL ? LOCAL_USER : envUser;
const pass = LOCAL ? LOCAL_PASS : envPass;
const baseURL = LOCAL ? process.env.BASE_URL || LOCAL_URL : process.env.BASE_URL;

// Publish the resolved target back into the environment. Ten spec files and
// helpers.js each read `process.env.BASE_URL || "https://deepresearch.se"`
// directly, because until now the suite only ever ran against a deployment.
// Two of those uses are load-bearing rather than cosmetic:
//
//   - `stripCrossOriginAuth(context, base)` strips the break-glass header from
//     any request whose origin is not `base`. Left at the production default,
//     a local run has its Authorization stripped from EVERY request — so the
//     Worker serves the signed-out landing and no spec ever finds `#form`.
//   - `addCookies({ url: base })` puts the privacy acknowledgement on the
//     wrong origin, so the notice never clears.
//
// Setting it here fixes all of them at once, and Playwright re-evaluates this
// config in each worker process, so the value reaches the tests.
if (LOCAL && !process.env.BASE_URL) process.env.BASE_URL = baseURL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  // LOCAL mode starts the Worker itself. `wrangler dev` is run from the repo
  // root with the dev-only config; see wrangler.dev.toml for why it cannot be
  // an [env.*] of wrangler.toml (routes rewrite the Host, containers need
  // Docker). reuseExistingServer keeps an already-running `wrangler dev`
  // usable during iteration; CI always starts its own.
  ...(LOCAL
    ? {
        webServer: [
          // The provider stand-in, started FIRST so the Worker's first catalog
          // fetch finds it. See tests/fake-provider.mjs for why a browser-level
          // mock is not enough (/api/models is never intercepted, and
          // api.spec.js calls the Worker directly).
          {
            command: `node fake-provider.mjs`,
            url: `http://127.0.0.1:${FAKE_PROVIDER_PORT}/v1/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
            stdout: "pipe",
            stderr: "pipe",
          },
          {
            // Pinned and supervised — see WRANGLER_SUPERVISED above for why
            // both, and what the dozen crashes actually were. The pin and the
            // port are passed in rather than re-defaulted in the script, so
            // this file stays the single place either is decided.
            command: WRANGLER_SUPERVISED,
            cwd: "..",
            env: { WRANGLER_VERSION, E2E_PORT: LOCAL_PORT },
            url: LOCAL_URL,
            reuseExistingServer: !process.env.CI,
            // Cold start pulls workerd and builds the asset manifest.
            timeout: 180_000,
            stdout: "pipe",
            stderr: "pipe",
          },
        ],
      }
    : {}),
  use: {
    baseURL,
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
    //
    // None of that applies to a Worker on loopback, and routing 127.0.0.1
    // through an external proxy would fail outright — so in LOCAL mode the
    // proxy is skipped entirely (and, where a proxy is configured for other
    // traffic, loopback is added to Chromium's bypass list).
    launchOptions: {
      // Only when it is actually there. The agent containers this repo is
      // developed in pre-install Chromium at this path and set
      // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so Playwright's own resolution finds
      // nothing; a CI runner installs browsers normally and must be left to
      // resolve them itself. Hard-coding the path unconditionally makes the
      // suite unrunnable anywhere but here.
      ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
      args: [...(!LOCAL && process.env.HTTPS_PROXY ? ["--ssl-version-max=tls1.2"] : [])],
    },
    ...(!LOCAL && process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true }
      : {}),
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: "mocked",
      testMatch: /(parsing|limits|report|api|ui|metadata|projects|proxy-space|pulse-timeline|landing)\.spec\.js/,
      timeout: 90_000,
      // The other half of the wrangler-crash mitigation. The supervisor above
      // brings the port back, but the test that was in flight when the socket
      // dropped is already lost; without a retry the build is still red for a
      // reason that has nothing to do with the diff. One retry is enough —
      // these tests are deterministic, so a genuine failure fails twice.
      retries: process.env.CI ? 1 : 0,
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
