// SANDBOX COMMAND PERFORMANCE PROBE — a real browser, a real CheerpX VM, and a
// battery of one-liners timed individually so we can say WHICH kinds of shell
// commands are cheap in the in-browser Linux sandbox and which to avoid.
//
//   npx playwright test --config=sandbox-perf.pw.config.js
//
// Why this exists: the sandbox's cost model is NOT a normal Linux box's. The
// root filesystem is a Debian ext2 image streamed block-by-block over a
// WebSocket (CloudDevice → wss://disks.webvm.io) behind an IndexedDB block
// cache, running on a single-threaded WASM CPU. That makes two costs dominate
// which barely register on real hardware:
//
//   1. COLD BLOCK FETCH. The first execution of any binary pulls its ELF (and
//      every shared library it links) over the network. The second execution
//      reads the same blocks from the IDB cache. Cold-vs-warm for the SAME
//      command is therefore the single largest effect in the whole system, and
//      it is why every probe below is run repeatedly and reported as
//      cold (run 1) vs warm (median of the rest).
//   2. PROCESS CREATION. Every `execInSandbox` is `/bin/sh -c <wrapped>` on a
//      WASM CPU, so even `true` has a floor cost. Anything that forks per line
//      (a shell loop calling an external binary) multiplies that floor.
//
// The battery is deliberately grouped by the QUESTION it answers (see GROUPS
// below) rather than by command, so the report reads as guidance.
//
// Environment note: the CheerpX runtime imports from a cross-origin CDN and the
// disk streams over wss://. Both must be reachable or the VM cannot boot — that
// is an ENVIRONMENT limit, not a code bug. The test skips (not fails) when the
// VM does not come up, so this file is safe to run anywhere.

import { expect, test } from "@playwright/test";

const BASE = process.env.BASE_URL || "https://deepresearch.se";
// A cold Debian boot legitimately takes ~30 s here; sandbox.js caps it at 90 s.
const BOOT_TIMEOUT = 150_000;
// Repeats per probe: run 1 is the cold sample, the rest give the warm median.
const REPEATS = Number(process.env.PERF_REPEATS || 3);

// ---------------------------------------------------------------------------
// The battery. Each probe: { id, group, cmd, note }
// `setup` probes run once, untimed-but-recorded, to build fixtures in the VM.
// ---------------------------------------------------------------------------

const GROUPS = {
  floor: "Round-trip floor — what one exec costs before doing any work",
  builtin: "Shell builtin vs external binary (fork + ELF load)",
  dir: "Directory listing by location (which mount backs it)",
  read: "Reading a file — by size, then by location",
  scan: "Scanning/searching a tree",
  interp: "Interpreter and toolchain startup",
  shape: "Same result, different command shape (the avoidable costs)",
};

/** Fixture sizes in KB — used to derive a ms-per-KB slope for file reads. */
const SIZES_KB = [1, 64, 512, 2048];

const SETUP = [
  // /tmp on this image is ordinary disk (the ext2 overlay), not tmpfs — the
  // fixtures therefore measure the same backing store the model's own files hit.
  { id: "mkdir", cmd: "mkdir -p /tmp/perf && echo ok" },
  // Build fixtures from an in-guest byte source. `head -c` on /dev/zero writes
  // a sparse-ish but real file; tr to printable so `cat` output is realistic
  // text (base64 envelope cost scales with BYTES, not entropy, so this is fair).
  ...SIZES_KB.map((kb) => ({
    id: `fixture-${kb}k`,
    cmd: `head -c ${kb * 1024} /dev/urandom | base64 | head -c ${kb * 1024} > /tmp/perf/f${kb}k.txt; wc -c < /tmp/perf/f${kb}k.txt`,
  })),
  // A small tree to scan: 200 files across 10 dirs.
  {
    id: "fixture-tree",
    cmd: "for d in $(seq 1 10); do mkdir -p /tmp/perf/tree/d$d; for f in $(seq 1 20); do echo \"line one needle$f\" > /tmp/perf/tree/d$d/f$f.txt; done; done; find /tmp/perf/tree -type f | wc -l",
  },
];

const PROBES = [
  // --- 1. the floor -------------------------------------------------------
  { id: "true", group: "floor", cmd: "true", note: "shell builtin, no output — the pure round-trip floor" },
  { id: "echo-builtin", group: "floor", cmd: "echo hi", note: "builtin echo, 3 bytes out" },
  { id: "exit-code", group: "floor", cmd: "exit 3", note: "non-zero rc path" },

  // --- 2. builtin vs external --------------------------------------------
  { id: "echo-builtin-2", group: "builtin", cmd: "echo hello world", note: "builtin — no fork" },
  { id: "echo-external", group: "builtin", cmd: "/bin/echo hello world", note: "same output, forks + loads an ELF" },
  { id: "pwd-builtin", group: "builtin", cmd: "pwd", note: "builtin" },
  { id: "pwd-external", group: "builtin", cmd: "/bin/pwd", note: "external" },
  { id: "test-builtin", group: "builtin", cmd: "[ -f /etc/hostname ] && echo yes", note: "builtin test" },
  { id: "test-external", group: "builtin", cmd: "/usr/bin/test -f /etc/hostname && echo yes", note: "external test" },

  // --- 3. directories by location ----------------------------------------
  { id: "ls-root", group: "dir", cmd: "ls /", note: "root of the streamed ext2 image" },
  { id: "ls-etc", group: "dir", cmd: "ls /etc | wc -l", note: "~200 entries, disk image" },
  { id: "ls-usrbin", group: "dir", cmd: "ls /usr/bin | wc -l", note: "large dir (~1500), disk image" },
  { id: "ls-usrbin-long", group: "dir", cmd: "ls -l /usr/bin | wc -l", note: "same dir but stat()s every entry" },
  { id: "ls-tmp", group: "dir", cmd: "ls /tmp/perf", note: "our fixture dir" },
  { id: "ls-workspace", group: "dir", cmd: "ls -a /workspace 2>&1 | head -20", note: "the persistent IndexedDB volume" },
  { id: "ls-root-home", group: "dir", cmd: "ls -a /root", note: "cwd of every exec" },
  { id: "ls-proc", group: "dir", cmd: "ls /proc | head -20", note: "synthetic fs, no disk blocks" },

  // --- 4. reading files ---------------------------------------------------
  ...SIZES_KB.map((kb) => ({
    id: `cat-${kb}k`,
    group: "read",
    cmd: `cat /tmp/perf/f${kb}k.txt`,
    note: `read ${kb} KB back through the base64 envelope`,
  })),
  { id: "head-of-2048k", group: "read", cmd: "head -c 1024 /tmp/perf/f2048k.txt", note: "1 KB slice of the 2 MB file — cost follows OUTPUT, not file size" },
  { id: "wc-2048k", group: "read", cmd: "wc -c < /tmp/perf/f2048k.txt", note: "reads 2 MB, returns ~8 bytes" },
  { id: "cat-etc-passwd", group: "read", cmd: "cat /etc/passwd", note: "small file on the disk image" },
  { id: "cat-proc", group: "read", cmd: "cat /proc/cpuinfo", note: "synthetic file, no disk" },

  // --- 5. scanning trees --------------------------------------------------
  { id: "find-tree", group: "scan", cmd: "find /tmp/perf/tree -type f | wc -l", note: "200 files, one process" },
  { id: "grep-tree", group: "scan", cmd: "grep -rl needle7 /tmp/perf/tree | wc -l", note: "recursive grep, one process" },
  { id: "find-exec-grep", group: "scan", cmd: "find /tmp/perf/tree -type f -exec grep -l needle7 {} \\; | wc -l", note: "SAME result, but forks grep 200 times" },
  { id: "grep-usr-share", group: "scan", cmd: "grep -rl nonexistentneedle /usr/share/doc 2>/dev/null | wc -l", note: "scan a COLD region of the disk image", timeoutMs: 30_000 },
  { id: "du-etc", group: "scan", cmd: "du -sh /etc 2>/dev/null", note: "stat()s a whole tree" },

  // --- 6. interpreters ----------------------------------------------------
  { id: "python-version", group: "interp", cmd: "python3 --version 2>&1", note: "CPython startup — large ELF + many .so", timeoutMs: 30_000 },
  { id: "python-hello", group: "interp", cmd: "python3 -c 'print(1+1)'", note: "startup dominates; the work is free", timeoutMs: 30_000 },
  { id: "python-import-json", group: "interp", cmd: "python3 -c 'import json;print(json.dumps({\"a\":1}))'", note: "stdlib import adds file reads", timeoutMs: 30_000 },
  { id: "perl-version", group: "interp", cmd: "perl -e 'print 42' 2>&1", note: "perl startup", timeoutMs: 30_000 },
  { id: "awk-hello", group: "interp", cmd: "awk 'BEGIN{print 1+1}'", note: "small interpreter" },
  { id: "sed-hello", group: "interp", cmd: "echo abc | sed s/b/X/", note: "small binary" },
  { id: "node-version", group: "interp", cmd: "command -v node >/dev/null && node --version || echo '(node absent)'", note: "node may not be on the image", timeoutMs: 30_000 },

  // --- 7. command shape (the avoidable costs) -----------------------------
  { id: "shape-cat-once", group: "shape", cmd: "cat /tmp/perf/f64k.txt | wc -l", note: "one pipe" },
  { id: "shape-loop-fork", group: "shape", cmd: "for i in $(seq 1 50); do /bin/echo $i; done | tail -1", note: "50 forks of an external binary" },
  { id: "shape-loop-builtin", group: "shape", cmd: "for i in $(seq 1 50); do echo $i; done | tail -1", note: "SAME loop, builtin echo — no forks" },
  { id: "shape-seq-once", group: "shape", cmd: "seq 1 50 | tail -1", note: "SAME result, one process" },
  { id: "shape-batched", group: "shape", cmd: "echo A; echo B; echo C; ls /etc/hostname; cat /etc/hostname", note: "5 logical steps batched into ONE exec round-trip" },
  { id: "shape-stat-many", group: "shape", cmd: "for f in /usr/bin/*; do [ -f \"$f\" ] || true; done; echo done", note: "1500 builtin stats, no forks" },
];

// ---------------------------------------------------------------------------

test("@live sandbox command performance battery", async ({ page }) => {
  test.setTimeout(20 * 60_000);

  const consoleMsgs = [];
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  await page.context().addCookies([{ name: "dr_privacy_ack", value: "1", url: BASE }]);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("web_search", "off");
      localStorage.setItem("dr_bash_lite", "1"); // sandbox knob mirror → COEP self-heal
    } catch {
      /* storage may be blocked on the very first hit */
    }
  });
  page.on("dialog", (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/`);
  await expect(page.locator("#form")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => window.__appReady === true, { timeout: 30_000 });

  const iso = await page.evaluate(() => ({
    coi: window.crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer,
    url: location.href,
  }));
  console.log("ISOLATION:", JSON.stringify(iso));
  expect(iso.coi, "page must be cross-origin isolated for CheerpX").toBe(true);

  // ---- boot the VM (bare — no file mounts, so we time the shell, not a seed)
  const boot = await page.evaluate(async (timeout) => {
    const t0 = performance.now();
    const stages = [];
    try {
      const mod = await import("/js/sandbox.js");
      const ok = await Promise.race([
        mod.ensureSandboxBooted(null, (m) => stages.push({ ms: Math.round(performance.now() - t0), msg: String(m) })),
        new Promise((r) => setTimeout(() => r("timeout"), timeout)),
      ]);
      return { ok, ms: Math.round(performance.now() - t0), stages, fs: mod.sandboxFsSummary?.() ?? null };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0), stages, err: String(e).slice(0, 300) };
    }
  }, BOOT_TIMEOUT);

  console.log("BOOT:", JSON.stringify(boot, null, 2));

  const live = await page.evaluate(async () => {
    if (!window.__DR_SANDBOX?.exec) return { live: false };
    const r = await window.__DR_SANDBOX.exec("echo __alive__");
    return { live: r.exitCode === 0 && /__alive__/.test(r.stdout), r };
  });
  console.log("VM LIVE:", JSON.stringify(live));

  test.skip(
    !live.live,
    `CheerpX VM did not come up in this environment (boot=${JSON.stringify(boot.ok)}) — ` +
      `the disk streams over wss://disks.webvm.io and the runtime imports a cross-origin CDN; ` +
      `both must be reachable. This is an environment limit, not a code failure.`,
  );

  // ---- fixtures ----------------------------------------------------------
  const setupResults = await page.evaluate(async (setup) => {
    const out = [];
    for (const s of setup) {
      const t0 = performance.now();
      const r = await window.__DR_SANDBOX.exec(s.cmd, { timeoutMs: 30000 });
      out.push({
        id: s.id,
        ms: Math.round(performance.now() - t0),
        rc: r.exitCode,
        out: (r.stdout || r.stderr || "").trim().slice(0, 120),
      });
    }
    return out;
  }, SETUP);
  console.log("\n--- fixture setup (one-time, also a data point) ---");
  for (const s of setupResults) {
    console.log(`  ${String(s.ms).padStart(7)} ms  rc=${s.rc}  ${s.id.padEnd(16)} ${s.out}`);
  }

  // ---- the battery -------------------------------------------------------
  const results = await page.evaluate(
    async ({ probes, repeats }) => {
      const out = [];
      for (const p of probes) {
        const samples = [];
        let rc = null;
        let bytes = 0;
        let sample = "";
        for (let i = 0; i < repeats; i++) {
          const t0 = performance.now();
          let r;
          try {
            r = await window.__DR_SANDBOX.exec(p.cmd, p.timeoutMs ? { timeoutMs: p.timeoutMs } : {});
          } catch (e) {
            r = { exitCode: -1, stdout: "", stderr: String(e).slice(0, 200) };
          }
          samples.push(Math.round(performance.now() - t0));
          rc = r.exitCode;
          bytes = (r.stdout || "").length;
          if (i === 0) sample = ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 160);
        }
        out.push({ ...p, samples, rc, bytes, sample });
      }
      return out;
    },
    { probes: PROBES, repeats: REPEATS },
  );

  // ---- report ------------------------------------------------------------
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const rows = results.map((r) => {
    const cold = r.samples[0];
    const warm = median(r.samples.slice(1).length ? r.samples.slice(1) : r.samples);
    return { ...r, cold, warm, ratio: warm > 0 ? +(cold / warm).toFixed(1) : 0 };
  });

  console.log("\n================ SANDBOX COMMAND PERFORMANCE ================");
  console.log(`base=${BASE}  repeats=${REPEATS}  boot=${boot.ms}ms`);
  for (const [key, title] of Object.entries(GROUPS)) {
    const g = rows.filter((r) => r.group === key);
    if (!g.length) continue;
    console.log(`\n## ${title}`);
    console.log("   cold     warm   c/w  rc   out    probe");
    for (const r of g.sort((a, b) => a.warm - b.warm)) {
      console.log(
        `  ${String(r.cold).padStart(6)}ms ${String(r.warm).padStart(6)}ms ` +
          `${String(r.ratio).padStart(5)}x ${String(r.rc).padStart(3)} ${String(r.bytes).padStart(6)}b  ` +
          `${r.id.padEnd(20)} ${r.cmd.slice(0, 62)}`,
      );
      if (r.note) console.log(`${" ".repeat(43)}↳ ${r.note}`);
    }
  }

  // Read throughput slope: ms per KB across the size fixtures.
  const reads = rows.filter((r) => /^cat-\d+k$/.test(r.id));
  if (reads.length >= 2) {
    console.log("\n## Read cost vs file size (warm)");
    for (const r of reads) {
      const kb = Number(r.id.match(/(\d+)k/)[1]);
      console.log(`  ${String(kb).padStart(5)} KB → ${String(r.warm).padStart(6)} ms  (${(r.warm / kb).toFixed(2)} ms/KB, ${r.bytes}b returned)`);
    }
  }
  console.log("\n=============================================================\n");

  await test.info().attach("sandbox-perf.json", {
    body: JSON.stringify({ base: BASE, repeats: REPEATS, iso, boot, setup: setupResults, rows }, null, 2),
    contentType: "application/json",
  });

  // The battery is an exploration tool, so the only hard assertions are that it
  // actually produced data — the numbers themselves are the deliverable.
  expect(rows.length).toBe(PROBES.length);
  expect(rows.filter((r) => r.rc === -1).length, "no probe may throw").toBe(0);
});
