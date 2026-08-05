// Regression lock for the e2e job's dev-server supervisor.
//
// The failure being locked out is NOT "wrangler crashed" — that is wrangler's
// own transient loopback fatal and nothing here can prevent it. It is the
// second-order one: the supervisor brings the port back SLOWER than Playwright
// re-runs the test it just lost, so the single CI retry is spent inside the
// outage and the build goes red for a crash it was supposed to absorb.
// Measured on occurrence 11 (run 30988531735): the retry finished 0.48 s before
// `Ready on http://localhost:8787`.
//
// So the properties these tests pin are the ones that decide whether a retry
// lands on a live server:
//
//   1. the restart delay stays small,
//   2. the loop does not re-resolve the wrangler package on every restart,
//   3. the loop still restarts at all, and still prints the line
//      docs/TESTING.md tells you to grep for,
//   4. the config still supervises, still pins the version, and has NOT
//      answered this by piling on retries (occurrences 8-12 prove more retry is
//      not the fix).
//
// Everything here is offline: the loop is driven through the E2E_WRANGLER_BIN
// seam with a stub, so no package is resolved and no port is bound.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "dev-server.sh");
const script = readFileSync(SCRIPT, "utf8");
const config = readFileSync(join(here, "playwright.config.js"), "utf8");

test("the supervisor script is executable", () => {
  // Playwright runs it as a bare command; a non-executable file is a webServer
  // that never starts, i.e. the whole job red rather than one test.
  assert.equal(statSync(SCRIPT).mode & 0o111 ? true : false, true);
});

test("the restart delay is short enough that a retry lands after it", () => {
  const m = /RESTART_DELAY_S="\$\{E2E_RESTART_DELAY_S:-([\d.]+)\}"/.exec(script);
  assert.ok(m, "dev-server.sh must default RESTART_DELAY_S");
  const delay = Number(m[1]);
  assert.ok(delay > 0, "a zero delay spins the CPU when wrangler cannot boot");
  // Playwright re-ran the lost test 2.3 s after the exit. wrangler's own start
  // is ~1.8 s of that, so anything above ~0.5 s puts the restart back on the
  // wrong side of the retry.
  assert.ok(delay <= 0.5, `restart delay ${delay}s is too long — see the header`);
});

test("package resolution happens once, outside the restart loop", () => {
  // ~1.2 s per restart was `npx` re-resolving an already-cached package. The
  // loop body must exec a resolved entry point, not go back through npx.
  const loop = script.slice(script.indexOf("while true; do"));
  assert.ok(loop.length > 0, "the restart loop must still exist");
  assert.ok(!/\bnpx\b/.test(loop), "the restart loop must not call npx");
  assert.ok(/npx --yes "\$\{SPEC\}" --version/.test(script), "resolution must still warm the cache once");
  assert.ok(/RUN=\(npx --yes "\$\{SPEC\}"\)/.test(script), "an unresolvable cache must still fall back to npx");
});

test("the loop restarts a dying server, fast, and says so", async () => {
  // Drive the real loop with a stub that exits immediately. Three restarts
  // inside two seconds is only possible if the delay stayed small AND no
  // package resolution happens per iteration.
  const dir = mkdtempSync(join(tmpdir(), "dev-server-"));
  const stub = join(dir, "stub.js");
  writeFileSync(stub, "process.exit(7);\n");
  chmodSync(stub, 0o755);

  const child = spawn("bash", [SCRIPT], {
    env: { ...process.env, E2E_WRANGLER_BIN: stub, E2E_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (b) => (err += b));
  await new Promise((r) => setTimeout(r, 2000));
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));

  const restarts = [...err.matchAll(/wrangler dev exited \(7\) — restarting/g)].length;
  assert.ok(restarts >= 3, `expected >=3 restarts in 2s, saw ${restarts}\n${err}`);
  assert.ok(/resolved to/.test(err), "the resolved entry point must be announced");
  assert.ok(!/falling back to npx/.test(err), "the seam must skip resolution entirely");
});

test("the config supervises, pins wrangler, and has not answered this with more retries", () => {
  assert.match(config, /const WRANGLER_SUPERVISED = "\.\/tests\/dev-server\.sh"/);
  assert.match(config, /command: WRANGLER_SUPERVISED/);
  // Version and port are decided in the config and passed down, so the script
  // cannot drift to a different pin.
  assert.match(config, /env: \{ WRANGLER_VERSION, E2E_PORT: LOCAL_PORT \}/);
  assert.match(config, /WRANGLER_VERSION \|\| "4\.118\.0"/);
  // Occurrences 8-12 all had `retries: 1` and still went red. Raising it hides
  // a real failure twice over instead of shortening the outage.
  assert.match(config, /retries: process\.env\.CI \? 1 : 0/);
});
