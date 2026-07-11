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
// so they ingest through a DataDevice at /mnt/in (/session/* and /project/*)
// and a boot script cp's them into the persistent tree — buildSeedScript()
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
 * }} plan
 * @returns {string}
 */
export function buildManifest(plan) {
  const lines = [];
  lines.push("# Files mounted into this Linux sandbox.");
  lines.push("# Session files are in /workspace/. The active project's files are in");
  lines.push("# /workspace/" + (plan.project ? plan.project.name : "<projname>") + "/ (a symlink to its /mnt mount).");
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
