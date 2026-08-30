#!/usr/bin/env node
// Measure the lypning engines against CPython INSIDE a real CheerpX VM.
//
//   node scripts/lypning-vm-measure.mjs <image.ext2> [--repeats 5] [--port 8099]
//
// WHY THIS IS STILL HERE AFTER THE INTERPRETER LEFT. lypning owns its engines,
// its conformance run and its own bench — but its bench measures a normal
// filesystem, and the whole premise of using it in the sandbox is that the
// sandbox is NOT one: the disk arrives block by block over a WebSocket, so cost
// there tracks bytes and file opens rather than CPU. The upstream project
// explicitly does not own the headless-VM harness. This repository does,
// because this repository is where the claim "a subset one-liner is worth it in
// the browser VM" gets made (`docs/LYPNING.md` §2). Nothing else can check it.
//
// It produces that number without needing a deployed image, an R2 upload or the
// live site: it serves a local ext2 over HTTP Range, boots CheerpX in headless
// Chromium, and times probes.
//
// WHAT IT REPORTS, and why there are two columns rather than one:
//
//   ms      Wall clock. The image is served over LOOPBACK here, while
//           production streams it over a WebSocket from R2, so these are
//           OPTIMISTIC — python3 --version measures ~340 ms here against 8573 ms
//           in production, about 26x. Use them for RATIOS between engines,
//           never as the production figure.
//
//   bytes   Blocks the guest actually pulled off the image for that command.
//           TRANSPORT-INDEPENDENT: the same command pulls the same blocks
//           whether they arrive over loopback or a WebSocket. Cold cost tracks
//           bytes and file opens, so this is the column that transfers, and the
//           one to quote.
//
// COLD is the first run in a fresh IndexedDB block cache; WARM is the median of
// the repeats after it — the same split as tests/e2e/sandbox-perf.spec.js.
//
// An engine the image does not carry reports ABSENT and is left out of the
// ratios. It is never reported as a zero, and never filled in from lypning's
// published table: that table was measured on another machine, on a filesystem
// this one is not.
//
// REQUIREMENTS: Playwright's Chromium (this repo has it at
// PLAYWRIGHT_BROWSERS_PATH) and, on first run, network access to fetch the
// pinned CheerpX engine into .cache/cheerpx/. The BROWSER never needs network:
// the engine and the image are both served from 127.0.0.1, which is also what
// makes the byte accounting exact.
import { createServer } from 'node:http';
import { open, stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pinned to the same build public/js/sandbox.js imports. A different engine is
// a different measurement.
const CHEERPX_VERSION = '1.2.6';
const CHEERPX_BASE = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}`;
const CACHE_DIR = join(ROOT, '.cache', 'cheerpx', CHEERPX_VERSION);

const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REPEATS = Number(flag('repeats', 5));
const PORT = Number(flag('port', 8099));
const CAP_MS = Number(flag('cap-ms', 60000));

if (!IMG || !existsSync(IMG)) {
  console.error('usage: node scripts/lypning-vm-measure.mjs <image.ext2> [--repeats N] [--port N]');
  console.error('build an image first: sudo bash scripts/build-sandbox-image.sh alpine <id> 512');
  process.exit(2);
}

// --------------------------------------------------------------------------
// The page. Mirrors public/js/sandbox.js's boot: same device stack, same
// mounts, same run() env/cwd/uid. Divergence here is divergence in the number.
// --------------------------------------------------------------------------
const HARNESS = `<!doctype html><meta charset="utf-8"><title>lypning vm measure</title>
<pre id="log">booting…</pre><script type="module">
const logEl = document.getElementById('log');
const say = (m) => { logEl.textContent += "\\n" + m; };
window.__ready = false; window.__err = null;
try {
  const CheerpX = await import('/cx/cx.esm.js');
  const base = await CheerpX.HttpBytesDevice.create(new URL('/img.ext2', location.href).href);
  const cacheId = new URLSearchParams(location.search).get('cache') || 'lypning-measure';
  const blockCache = await CheerpX.IDBDevice.create(cacheId);
  const overlay = await CheerpX.OverlayDevice.create(base, blockCache);
  const cx = await CheerpX.Linux.create({ mounts: [
    { type: 'ext2', dev: overlay, path: '/' },
    { type: 'devs', path: '/dev' }, { type: 'devpts', path: '/dev/pts' },
    { type: 'proc', path: '/proc' }, { type: 'sys', path: '/sys' },
  ]});
  let chunks = [];
  cx.setCustomConsole((buf) => { chunks.push(new Uint8Array(buf)); }, 1024, 24);
  window.__probe = async (cmd) => {
    chunks = [];
    const t0 = performance.now();
    let status = -1;
    try {
      const r = await cx.run('/bin/sh', ['-c', cmd], {
        env: ['HOME=/root', 'TERM=dumb', 'USER=root',
              'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
        cwd: '/root', uid: 0, gid: 0 });
      status = r && Number.isFinite(r.status) ? r.status : 0;
    } catch { status = -2; }
    const ms = performance.now() - t0;
    let out = ''; for (const c of chunks) out += new TextDecoder().decode(c);
    return { ms: +ms.toFixed(1), status, out: out.slice(0, 400) };
  };
  window.__ready = true; say('READY');
} catch (err) { window.__err = String(err && err.stack || err); say('ERROR ' + window.__err); }
</script>`;

// --------------------------------------------------------------------------
// Server. Three things it must get right or the measurement is wrong.
// --------------------------------------------------------------------------
const ISO = {
  // CheerpX needs SharedArrayBuffer, which needs cross-origin isolation.
  // require-corp rather than credentialless: sandbox.js records that iOS Safari
  // ignores credentialless, so require-corp is what production ships.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
let rangeCount = 0, bytesServed = 0;

await mkdir(CACHE_DIR, { recursive: true });
async function cheerpxAsset(rel) {
  const path = join(CACHE_DIR, rel);
  if (existsSync(path)) return readFile(path);
  // Lazy mirror. CheerpX pulls a wider asset graph than its loader names
  // (tun/direct.js, tun/ipstack.js, tun/wasm_exec.js all load at boot even with
  // networking unused), so enumerating by hand does not converge. Fetching on
  // miss does, and it is cached under .cache/ for every later run.
  await mkdir(dirname(path), { recursive: true });
  await execFileP('curl', ['-sSf', '--create-dirs', '-o', path, `${CHEERPX_BASE}/${rel}`], { timeout: 180000 });
  process.stderr.write(`  mirrored ${rel}\n`);
  return readFile(path);
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/') {
      res.writeHead(200, { ...ISO, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HARNESS);
    }
    if (url === '/stats/reset') { rangeCount = 0; bytesServed = 0; res.writeHead(200, ISO); return res.end('{}'); }
    if (url === '/stats') { res.writeHead(200, { ...ISO, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ rangeCount, bytesServed })); }
    if (url.startsWith('/cx/')) {
      const rel = url.slice(4);
      try {
        const body = await cheerpxAsset(rel);
        const type = rel.endsWith('.wasm') ? 'application/wasm' : rel.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { ...ISO, 'Content-Type': type, 'Content-Length': body.length });
        return res.end(body);
      } catch { res.writeHead(404, ISO); return res.end('missing'); }
    }
    if (url === '/img.ext2') {
      const st = await stat(IMG);
      // HttpBytesDevice REFUSES to initialise without a validator:
      // "Server didn't include header `Last-Modified` nor header `Etag`". It
      // uses one to notice the image changing under a warm block cache. R2
      // sends an ETag so production gets this free; a hand-rolled origin does
      // not, which is worth knowing before serving an image from anything else.
      const validator = {
        ETag: `"${st.size}-${Math.floor(st.mtimeMs)}"`,
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      };
      const fh = await open(IMG, 'r');
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!m) {
        res.writeHead(200, { ...ISO, ...validator, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
        const s = fh.createReadStream(); s.on('close', () => fh.close()); return s.pipe(res);
      }
      const start = Number(m[1]), end = m[2] ? Number(m[2]) : st.size - 1, len = end - start + 1;
      rangeCount++; bytesServed += len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start); await fh.close();
      res.writeHead(206, { ...ISO, ...validator, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': len });
      return res.end(buf);
    }
    res.writeHead(404, ISO); res.end('no');
  } catch (err) { res.writeHead(500, ISO); res.end(String(err)); }
});
await new Promise((r) => server.listen(PORT, r));

// --------------------------------------------------------------------------
// Probes. `warm-shell` runs first deliberately: it absorbs the first touch of
// /bin/sh so that every later probe measures its OWN binary. Without it the
// first probe reads ~350 ms and the second ~20 ms for the same work.
// --------------------------------------------------------------------------
// THE BYTE COLUMNS ARE ORDER-DEPENDENT WITHIN A RUN, and reading them without
// knowing that gives the wrong answer twice over. The IDB cache is fresh per
// RUN, not per probe, so the FIRST probe to touch a binary pays for all of its
// device blocks and every later probe using the same binary reads as free.
// `lypning-mp-hello` showing 128K and `lypning-mp-import-json` showing 0K does not mean
// lypning-mp is smaller than lypning — it means `lypning-mp-version` ran first and already
// pulled lypning-mp's blocks in.
//
// So the honest cross-runtime comparison is between each runtime's FIRST probe,
// which is `lypning-version` against `lypning-mp-version`. Keep those first in their
// groups, and do not quote a later probe's byte count as a size.
const PROBES = [
  { id: 'warm-shell',         cmd: 'true' },
  { id: 'lypning-version',     cmd: 'lypning --version 2>&1' },
  { id: 'lypning-hello',       cmd: "lypning -c 'print(1+1)'" },
  { id: 'lypning-import-json', cmd: 'lypning -c \'import json;print(json.dumps({"a":1}))\'' },
  // A character class, not \d: the pattern crosses JS -> shell -> Python
  // quoting and an escaped backslash silently became a literal one, so the
  // probe printed [] at exit 0. Measuring the wrong thing successfully is the
  // exact failure this project cares most about, so the escaping is avoided.
  { id: 'lypning-re',          cmd: 'lypning -c \'import re;print(re.findall(r"[0-9]+","a1 b22"))\'' },
  // lypning-mp, the same four tasks. It has never been measured in a
  // VM: every published figure for it is from a normal Linux filesystem, with the
  // x86_64 binary, which CheerpX cannot even load. `import re` is deliberately
  // absent from its set — it refuses regex by design (that is a routing
  // decision, the dispatcher owns it), so a probe would time the refusal, not the work.
  // No `| head`: a pipe spawns busybox, whose own blocks land in this probe's
  // byte count and made lypning-mp look 5.9x lypning on a probe that measures neither.
  { id: 'lypning-mp-version',       cmd: 'lypning-mp --version 2>&1' },
  { id: 'lypning-mp-hello',         cmd: "lypning-mp -c 'print(1+1)'" },
  { id: 'lypning-mp-import-json',   cmd: 'lypning-mp -c \'import json;print(json.dumps({"a":1}))\'' },
  // A probe with actual WORK in it. Everything above is startup-dominated —
  // `print(1+1)` measures the exec round-trip and the block fetches and almost
  // nothing else — so a runtime that is genuinely faster at running code cannot
  // show it. This one loops enough to be visible above the floor.
  { id: 'lypning-work',        cmd: 'lypning -c \'t=0\nfor i in range(200000): t+=i*i\nprint(t)\'' },
  { id: 'lypning-mp-work',          cmd: 'lypning-mp -c \'t=0\nfor i in range(200000): t+=i*i\nprint(t)\'' },
  { id: 'python-version',     cmd: 'python3 --version 2>&1' },
  { id: 'python-hello',       cmd: "python3 -c 'print(1+1)'" },
  { id: 'python-import-json', cmd: 'python3 -c \'import json;print(json.dumps({"a":1}))\'' },
  { id: 'python-re',          cmd: 'python3 -c \'import re;print(re.findall(r"[0-9]+","a1 b22"))\'' },
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json());

// Playwright is a devDependency of tests/, not of the root, and ESM resolves
// from THIS file's directory rather than the cwd — so it has to be resolved
// against tests/package.json explicitly or the tool only runs from tests/.
// Playwright is a devDependency of tests/, not of the root, and ESM resolves
// from THIS file's directory rather than the cwd — so it has to be resolved
// against tests/package.json explicitly or the tool only runs from tests/.
// require() rather than import(): the package is CJS, and a dynamic import of
// it yields a namespace whose `chromium` is undefined.
const { createRequire } = await import('node:module');
let chromium;
try {
  const req = createRequire(join(ROOT, 'tests', 'package.json'));
  ({ chromium } = req('@playwright/test'));
} catch {
  console.error('Playwright not found. Run: cd tests && npm install');
  process.exit(2);
}
if (!chromium) { console.error('Playwright resolved but exposed no chromium.'); process.exit(2); }
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?cache=m-${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready===true || window.__err', null, { timeout: 180000 });
const bootErr = await page.evaluate('window.__err');
if (bootErr) { console.error('BOOT ERROR\n' + bootErr); await browser.close(); server.close(); process.exit(1); }
const bootStats = await get('/stats');
console.log(`\nimage ${IMG}  (${(await stat(IMG)).size} B)`);
console.log(`boot ${Date.now() - t0} ms, ${(bootStats.bytesServed / 1048576).toFixed(2)} MiB in ${bootStats.rangeCount} range requests\n`);

const rows = [];
for (const p of PROBES) {
  const ms = [], by = [];
  let out = '', status = 0, hung = false, hungAfter = 0;
  for (let i = 0; i < REPEATS; i++) {
    await get('/stats/reset');
    const started = Date.now();
    try {
      const r = await Promise.race([
        page.evaluate((c) => window.__probe(c), p.cmd),
        new Promise((_, rj) => setTimeout(() => rj(new Error('cap')), CAP_MS)),
      ]);
      const s = await get('/stats');
      ms.push(r.ms); by.push(s.bytesServed);
      if (i === 0) { out = r.out.trim().replace(/\s+/g, ' ').slice(0, 40); status = r.status; }
    } catch {
      hung = true; hungAfter = Date.now() - started;
      const s = await get('/stats');
      if (!ms.length) rows.push({ ...p, hung: true, hungAfter, hungBytes: s.bytesServed });
      break;
    }
  }
  if (hung && !ms.length) break; // a wedged VM makes every later probe meaningless
  rows.push({ ...p, coldMs: ms[0], warmMs: ms.length > 1 ? median(ms.slice(1)) : ms[0],
              coldB: by[0], warmB: by.length > 1 ? median(by.slice(1)) : by[0], status, out });
}

const k = (b) => (b / 1024).toFixed(0) + 'K';
console.log(`  ${'probe'.padEnd(20)} ${'cold'.padStart(8)} ${'warm'.padStart(7)} ${'coldB'.padStart(7)} ${'warmB'.padStart(6)}  rc  out`);
for (const r of rows) {
  if (r.hung) { console.log(`  ${r.id.padEnd(20)}  HUNG after ${(r.hungAfter / 1000).toFixed(0)}s, ${k(r.hungBytes)} streamed then FROZEN — VM wedged`); continue; }
  console.log(`  ${r.id.padEnd(20)} ${(r.coldMs.toFixed(0) + 'ms').padStart(8)} ${(r.warmMs.toFixed(0) + 'ms').padStart(7)} ${k(r.coldB).padStart(7)} ${k(r.warmB).padStart(6)}  ${String(r.status).padStart(2)}  ${r.out}`);
}

const pick = (id) => rows.find((r) => r.id === id && !r.hung);
const pairs = [['lypning-version', 'python-version'], ['lypning-hello', 'python-hello'],
               ['lypning-import-json', 'python-import-json'], ['lypning-re', 'python-re']];
const mpPairs = [['lypning-mp-hello', 'lypning-hello'], ['lypning-mp-import-json', 'lypning-import-json'],
                   ['lypning-mp-version', 'lypning-version'], ['lypning-mp-work', 'lypning-work']];
// lypning-mp against lypning, which is the comparison that decides anything: CPython
// cannot run a one-liner in this image at all, so "faster than CPython" is not
// the question. The question is whether lypning-mp's 1.7x warm advantage on a normal
// filesystem survives streaming 8 device blocks against lypning's 3.
if (pick('lypning-mp-hello')) {
  console.log('\n  lypning-mp vs lypning, same task (bytes is the column that transfers):');
  for (const [a, b] of mpPairs) {
    const x = pick(a), y = pick(b);
    if (!x || !y) continue;
    console.log(`    ${a.replace('lypning-mp-', '').padEnd(12)} ms ${(x.coldMs / Math.max(y.coldMs, 0.1)).toFixed(2)}x   bytes ${(x.coldB / Math.max(y.coldB, 1)).toFixed(2)}x   (lypning-mp ${k(x.coldB)} vs lypning ${k(y.coldB)})`);
  }
}

console.log('\n  lypning vs CPython, same task (bytes is the column that transfers):');
for (const [a, b] of pairs) {
  const x = pick(a), y = pick(b);
  if (!x) continue;
  if (!y) { console.log(`    ${a.replace('lypning-', '').padEnd(12)} lypning ${x.coldMs.toFixed(0)}ms / ${k(x.coldB)} — CPython DID NOT COMPLETE`); continue; }
  console.log(`    ${a.replace('lypning-', '').padEnd(12)} ms ${(y.coldMs / Math.max(x.coldMs, 0.1)).toFixed(1)}x   bytes ${(y.coldB / Math.max(x.coldB, 1)).toFixed(1)}x   (${k(x.coldB)} vs ${k(y.coldB)})`);
}
console.log('\nJSON ' + JSON.stringify({ image: IMG, rows }));
await browser.close();
server.close();
