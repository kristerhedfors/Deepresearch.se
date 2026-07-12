// @ts-check
// The file-mounting pure core for the in-browser Linux sandbox (see the
// SANDBOX-HOST-COMMANDS design doc, part B). The browser-only orchestration
// lives in public/js/sandbox.js; this module holds the deterministic,
// I/O-free logic so it can be Node-tested (sandbox-files.test.js) and stays
// out of the CheerpX/DOM glue.
//
// The layout it builds:
//   /workspace/                 ← this chat session's files + guest scratch (persistent)
//   /workspace/INDEX.txt        ← the manifest below
//   /workspace/<projname>  ->  /mnt/<projname>-<hash>   ← friendly symlink (no hash)
//   /mnt/<projname>-<hash>/     ← the active project's own persistent mount
//
// Host bytes can't be written into an IDBDevice directly (no host writeFile),
// so they ingest through DataDevices at /mnt/in-s (session) and /mnt/in-p
// (project) and a boot script cp's them into the persistent tree — buildSeedScript()
// is that script. Everything here is pure string/byte manipulation.

// ---- caps -----------------------------------------------------------------

// Per-file and total byte budgets for the Tier-1 (DataDevice) mount, which
// holds the whole payload in page memory. Files over the per-file cap, or that
// would push the running total over the budget, are dropped and recorded in
// the manifest (Tier-2 WebDevice streaming is not built yet).
export const MAX_MOUNT_FILE_BYTES = 32 * 1024 * 1024; // 32 MB per file
export const MAX_MOUNT_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MB across all mounted files

// ---- name sanitizing ------------------------------------------------------

/**
 * Sanitize an arbitrary file name into a safe basename for the guest FS:
 * basename only (drop any path), control chars and path separators removed,
 * whitespace collapsed. Never empty.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  let s = String(name == null ? "" : name);
  // basename: everything after the last / or \
  s = s.split(/[\\/]/).pop() || "";
  // drop control chars, NUL, and characters awkward in a shell path
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  // no leading dots-only names or "." / ".."
  if (!s || s === "." || s === "..") return "file";
  return s.slice(0, 200);
}

/**
 * Sanitize a project name into a directory-name component: keep it readable
 * but restrict to a safe alphabet so it's clean in a mount path. Never empty.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeProjName(name) {
  let s = String(name == null ? "" : name).trim().toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!s || s === "." || s === "..") return "project";
  return s.slice(0, 60);
}

/**
 * A short, stable, non-cryptographic hash of a project id, used to make the
 * project mount path unique and stable across sessions (FNV-1a, 8 hex chars).
 * @param {string} projId
 * @returns {string}
 */
export function projHash(projId) {
  const s = String(projId == null ? "" : projId);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit range
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * De-duplicate a list of already-sanitized names, appending -2, -3, … before
 * the extension on collision. Returns a new array in the same order.
 * @param {string[]} names
 * @returns {string[]}
 */
export function dedupeNames(names) {
  const seen = new Map();
  const out = [];
  for (const raw of names) {
    const name = raw || "file";
    if (!seen.has(name)) {
      seen.set(name, 1);
      out.push(name);
      continue;
    }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = seen.get(name) + 1;
    let candidate = `${base}-${n}${ext}`;
    while (seen.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}${ext}`;
    }
    seen.set(name, n);
    seen.set(candidate, 1);
    out.push(candidate);
  }
  return out;
}

// ---- size cap -------------------------------------------------------------

/**
 * @typedef {{ name: string, type?: string, bytes: Uint8Array }} MountInput
 * @typedef {{ name: string, type: string, size: number, bytes: Uint8Array }} MountKept
 * @typedef {{ name: string, reason: string }} MountDropped
 */

/**
 * Apply the per-file and running-total byte caps, sanitizing + de-duplicating
 * kept names. Order preserved. Anything over a cap is dropped (recorded).
 * `startTotal` lets a second call (project files) continue the same budget.
 * @param {MountInput[]} files
 * @param {{ perFileMax?: number, totalMax?: number, startTotal?: number }} [opts]
 * @returns {{ kept: MountKept[], dropped: MountDropped[], total: number }}
 */
export function applySizeCap(files, opts = {}) {
  const perFileMax = opts.perFileMax ?? MAX_MOUNT_FILE_BYTES;
  const totalMax = opts.totalMax ?? MAX_MOUNT_TOTAL_BYTES;
  let total = opts.startTotal ?? 0;
  const kept = [];
  const dropped = [];
  const list = Array.isArray(files) ? files : [];
  const rawKeptNames = [];
  const staged = [];
  for (const f of list) {
    const bytes = f && f.bytes instanceof Uint8Array ? f.bytes : null;
    const name = sanitizeName(f && f.name);
    if (!bytes || bytes.length === 0) {
      dropped.push({ name, reason: "empty or unreadable" });
      continue;
    }
    if (bytes.length > perFileMax) {
      dropped.push({ name, reason: `over ${Math.round(perFileMax / (1024 * 1024))}MB per-file cap` });
      continue;
    }
    if (total + bytes.length > totalMax) {
      dropped.push({ name, reason: "over total size budget, no streaming backend" });
      continue;
    }
    total += bytes.length;
    rawKeptNames.push(name);
    staged.push({ type: String(f.type || "file"), size: bytes.length, bytes });
  }
  const deduped = dedupeNames(rawKeptNames);
  for (let i = 0; i < staged.length; i++) {
    kept.push({ name: deduped[i], type: staged[i].type, size: staged[i].size, bytes: staged[i].bytes });
  }
  return { kept, dropped, total };
}

// ---- the manifest ---------------------------------------------------------

/**
 * Build the /workspace/INDEX.txt text the model reads to discover what's
 * mounted. Tab-separated, one row per file, plus dropped-file markers.
 * @param {{
 *   session: MountKept[],
 *   project: { name: string, files: MountKept[] } | null,
 *   dropped?: Array<{ scope: string, name: string, reason: string }>,
 *   source?: { count: number, bytes: number } | null,
 * }} plan
 * @returns {string}
 */
export function buildManifest(plan) {
  const lines = [];
  lines.push("# Files mounted into this Linux sandbox.");
  lines.push("# Session files are in /workspace/. The active project's files are in");
  lines.push("# /workspace/" + (plan.project ? plan.project.name : "<projname>") + "/ (a symlink to its /mnt mount).");
  if (plan.source) {
    lines.push(
      `# INTROSPECTION: the deepresearch.se source snapshot (${plan.source.count} files, ${plan.source.bytes} bytes)`,
    );
    lines.push("# is mounted at /src (also reachable as /workspace/source) — ls/cat/grep it freely.");
  }
  lines.push("# columns: scope\\tname\\ttype\\tsize_bytes\\ttier");
  lines.push("");
  for (const f of plan.session || []) {
    lines.push(`session\t${f.name}\t${f.type}\t${f.size}\tdata`);
  }
  if (plan.project) {
    for (const f of plan.project.files || []) {
      lines.push(`project\t${f.name}\t${f.type}\t${f.size}\tdata`);
    }
  }
  for (const d of plan.dropped || []) {
    lines.push(`${d.scope}\t${d.name}\t-\t-\t[not mounted — ${d.reason}]`);
  }
  return lines.join("\n") + "\n";
}

// ---- shell helpers --------------------------------------------------------

/**
 * POSIX single-quote escape for interpolating a string into a /bin/sh command.
 * @param {string} s
 * @returns {string}
 */
export function shellEscape(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the boot seed+symlink script: cp the two flat ingest DataDevices
 * (/mnt/in-s = session, /mnt/in-p = project) into the persistent volumes, stamp
 * the project id, and make the friendly no-hash symlink. Session is refreshed
 * each boot (cp -a); project is add/update-only (cp -an) so guest edits aren't
 * clobbered. The ingest devices are flat (files at their root) so we never
 * depend on DataDevice auto-creating nested directories.
 * @param {{ hasProject: boolean, projName?: string, projId?: string, hash?: string }} p
 * @returns {string}
 */
export function buildSeedScript(p) {
  const lines = [];
  if (p.hasProject) {
    const proj = `/mnt/${p.projName}-${p.hash}`;
    lines.push(`mkdir -p /workspace ${shellEscape(proj)}`);
    lines.push(`cp -a /mnt/in-s/. /workspace/ 2>/dev/null || true`);
    lines.push(`cp -an /mnt/in-p/. ${shellEscape(proj + "/")} 2>/dev/null || true`);
    lines.push(`printf '%s' ${shellEscape(String(p.projId || ""))} > ${shellEscape(proj + "/.projectid")} 2>/dev/null || true`);
    lines.push(`ln -sfn ${shellEscape(proj)} ${shellEscape("/workspace/" + p.projName)} 2>/dev/null || true`);
  } else {
    lines.push(`mkdir -p /workspace`);
    lines.push(`cp -a /mnt/in-s/. /workspace/ 2>/dev/null || true`);
  }
  return lines.join("\n");
}

// ---- the introspection source mount (developer mode) ------------------------

// Byte budget for the source snapshot's DataDevice mount (in page memory,
// like every Tier-1 mount). Today's whole snapshot is ~3 MB, so this is pure
// headroom, not a working limit.
export const MAX_SOURCE_TOTAL_BYTES = 24 * 1024 * 1024;

// A snapshot repo path safe to recreate inside the guest: relative, no
// traversal, a conservative alphabet (matches what the bundler emits).
const SAFE_REPO_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Plan the introspection source mount: the snapshot's files (repo-relative
 * paths + full text, introspect-core.js's Snapshot shape) become FLAT entries
 * for one ingest DataDevice at /mnt/in-src (f0, f1, … — files at the device
 * root, the same no-nested-dirs discipline as the other ingest devices) plus
 * a seed script that recreates the real tree at /src. The script is written
 * INTO the device (as .seed) and run with `sh /mnt/in-src/.seed`, so a
 * hundreds-of-lines script never rides in argv. /src is refreshed on every
 * boot (it lives in the persistent overlay, so a stale copy would otherwise
 * survive reloads); a friendly /workspace/source symlink points at it.
 * @param {Array<{ p: string, s?: number, t: string }>} files
 * @param {{ totalMax?: number }} [opts]
 * @returns {{ entries: Array<{ flat: string, path: string, bytes: Uint8Array }>, seed: string, count: number, bytes: number, dropped: number } | null}
 */
export function planSourceMount(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const totalMax = opts.totalMax ?? MAX_SOURCE_TOTAL_BYTES;
  const enc = new TextEncoder();
  /** @type {Array<{ flat: string, path: string, bytes: Uint8Array }>} */
  const entries = [];
  const dirs = new Set();
  let bytes = 0;
  let dropped = 0;
  for (const f of list) {
    const path = typeof f?.p === "string" ? f.p : "";
    if (!SAFE_REPO_PATH_RE.test(path) || path.includes("..")) {
      dropped += 1;
      continue;
    }
    const b = enc.encode(typeof f.t === "string" ? f.t : "");
    if (!b.length || bytes + b.length > totalMax) {
      dropped += 1;
      continue;
    }
    bytes += b.length;
    const slash = path.lastIndexOf("/");
    if (slash > 0) dirs.add("/src/" + path.slice(0, slash));
    entries.push({ flat: "f" + entries.length, path, bytes: b });
  }
  if (!entries.length) return null;
  const lines = [];
  lines.push("rm -rf /src");
  lines.push("mkdir -p /src " + [...dirs].sort().map(shellEscape).join(" "));
  for (const e of entries) {
    lines.push(`cp /mnt/in-src/${e.flat} ${shellEscape("/src/" + e.path)}`);
  }
  lines.push("mkdir -p /workspace 2>/dev/null || true");
  lines.push("ln -sfn /src /workspace/source 2>/dev/null || true");
  return { entries, seed: lines.join("\n") + "\n", count: entries.length, bytes, dropped };
}
