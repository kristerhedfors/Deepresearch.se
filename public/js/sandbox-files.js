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
    // The counts are stated when this side knows them (the browser VM tars the
    // snapshot itself). A REMOTE environment that seeds /src server-side does
    // not have them at manifest time, so the announcement stands without them
    // rather than claiming zero.
    const detail = plan.source.count ? ` (${plan.source.count} files, ${plan.source.bytes} bytes)` : "";
    lines.push(`# INTROSPECTION: the deepresearch.se source snapshot${detail}`);
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

// ---- the whole-send mount plan ---------------------------------------------

/**
 * Turn a file provider's raw `{session, project, source}` payload into the plan
 * BOTH execution environments mount from: size-capped, sanitized, de-duped
 * lists, the project's mount identity, the manifest, and (optionally) the
 * introspection source plan.
 *
 * This is the pure half of what public/js/sandbox.js's preparePlan used to do
 * inline; it moved here when the SERVER-SIDE container gained the same mounts
 * (src/exec-container.js), because "what a sandbox holds" must not be able to
 * differ between environments. sandbox.js keeps the logging and the CheerpX
 * device writes; exec-backends-core.js's remote runner turns this same plan
 * into a tar (planRemoteMount).
 *
 * `source` is a SEPARATE opt-out because the two environments obtain it
 * differently: the browser VM tars the snapshot it already fetched, while the
 * server-side container is seeded from this deploy's ASSETS — the ~11 MB never
 * needs to leave (or re-enter) the browser, so the remote caller passes
 * `{source:false}` and asks the server to mount it instead.
 *
 * Never throws for a malformed payload: a bad provider yields an empty plan,
 * which mounts nothing rather than failing the send.
 *
 * @param {any} raw the provider's payload
 * @param {{ source?: boolean }} [opts]
 * @returns {{ session: MountKept[], project: { name: string, id: string, hash: string, files: MountKept[] } | null, source: any, manifest: string, dropped: Array<{scope: string, name: string, reason: string}>, bytes: number }}
 */
export function planMounts(raw, opts = {}) {
  raw = raw || {};
  const withSource = opts.source !== false;
  const sessionCap = applySizeCap(Array.isArray(raw.session) ? raw.session : []);
  let total = sessionCap.total;
  const dropped = sessionCap.dropped.map((d) => ({ scope: "session", ...d }));
  let project = null;
  if (raw.project && Array.isArray(raw.project.files) && raw.project.files.length) {
    const projCap = applySizeCap(raw.project.files, { startTotal: total });
    total = projCap.total;
    for (const d of projCap.dropped) dropped.push({ scope: "project", ...d });
    project = {
      name: sanitizeProjName(raw.project.name),
      id: String(raw.project.id || ""),
      hash: projHash(raw.project.id),
      files: projCap.kept,
    };
  }
  let source = null;
  if (withSource && raw.source && Array.isArray(raw.source.files) && raw.source.files.length) {
    source = planSourceMount(raw.source.files);
    if (source) total += source.bytes;
  }
  // The manifest still ANNOUNCES the source mount when the caller is having it
  // seeded elsewhere — `source:{server:true}`, which is what a remote runner
  // that can fetch the snapshot itself asks for — so the model reads the same
  // INDEX.txt in both environments and finds /src where it is told it is.
  const sourceNote = source
    ? { count: source.count, bytes: source.bytes }
    : raw.source && (raw.source.server === true || raw.source.files?.length)
      ? { count: 0, bytes: 0 }
      : null;
  const manifest = buildManifest({
    session: sessionCap.kept,
    project: project ? { name: project.name, files: project.files } : null,
    dropped,
    source: sourceNote,
  });
  return { session: sessionCap.kept, project, source, manifest, dropped, bytes: total };
}

/**
 * Turn a plan (planMounts above) into what a REMOTE DREE/1 runner needs: ONE
 * ustar archive whose members are the guest's absolute layout minus the leading
 * slash (`workspace/…`, `mnt/<project>-<hash>/…`) plus the small script that
 * installs the friendly symlink after extraction.
 *
 * Paths are relative on purpose: `tar -xf - -C /` then lands them exactly where
 * the browser VM's seed script puts them, and GNU tar's default refusal of `..`
 * members means a hand-crafted archive can't walk out of the tree.
 *
 * The SOURCE tree is deliberately not included — a remote runner gets /src from
 * the server (src/exec-container.js `/api/exec/source`), and pushing 11 MB up
 * from the browser to reach a machine that can read it locally would be pure
 * waste.
 *
 * @param {{ session: MountKept[], project: { name: string, hash: string, files: MountKept[] } | null, manifest: string }} plan
 * @returns {{ tar: Uint8Array, script: string, count: number, bytes: number }}
 */
export function planRemoteMount(plan) {
  const enc = new TextEncoder();
  /** @type {Array<{ path: string, bytes: Uint8Array }>} */
  const files = [];
  let bytes = 0;
  const add = (/** @type {string} */ path, /** @type {Uint8Array} */ b) => {
    files.push({ path, bytes: b });
    bytes += b.length;
  };
  add("workspace/INDEX.txt", enc.encode(plan?.manifest || ""));
  for (const f of plan?.session || []) add("workspace/" + f.name, f.bytes);
  const lines = ["mkdir -p /workspace /workspace/outbox 2>/dev/null || true"];
  const p = plan?.project;
  if (p && p.files?.length) {
    const mount = "mnt/" + p.name + "-" + p.hash;
    for (const f of p.files) add(mount + "/" + f.name, f.bytes);
    lines.push(`mkdir -p ${shellEscape("/" + mount)} 2>/dev/null || true`);
    lines.push(`ln -sfn ${shellEscape("/" + mount)} ${shellEscape("/workspace/" + p.name)} 2>/dev/null || true`);
  }
  return { tar: buildTar(files), script: lines.join("\n") + "\n", count: files.length, bytes };
}

// ---- the introspection source mount (developer mode) ------------------------

// Byte budget for the source snapshot's DataDevice mount (in page memory,
// like every Tier-1 mount). Today's whole snapshot is ~3 MB, so this is pure
// headroom, not a working limit.
export const MAX_SOURCE_TOTAL_BYTES = 24 * 1024 * 1024;

// A snapshot repo path safe to recreate inside the guest: relative, no
// traversal, a conservative alphabet (matches what the bundler emits).
const SAFE_REPO_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

// ---- tar (ustar) builder for the source seed --------------------------------
// The source tree lands in the guest as ONE ustar archive extracted with a
// single `tar -xf` — one process spawn instead of one `cp` spawn per file.
// The per-file cp seed (hundreds of spawns) was measured blowing the 90s boot
// ceiling on a phone ("boot timed out at mounting files…", chat_logs #515):
// process spawns are the expensive unit in the WASM x86 emulator, file bytes
// are not. The cp script is kept as the fallback for a guest without tar.

/**
 * Write a POSIX-octal numeric field (value + NUL terminator) into a header.
 * @param {Uint8Array} header @param {number} off @param {number} len @param {number} value
 */
function tarOctal(header, off, len, value) {
  const s = value.toString(8).padStart(len - 1, "0");
  for (let i = 0; i < len - 1; i++) header[off + i] = s.charCodeAt(i);
  header[off + len - 1] = 0;
}

/**
 * Split a path into ustar name (≤100 bytes) + prefix (≤155 bytes) fields.
 * Snapshot paths are ASCII (SAFE_REPO_PATH_RE), so chars == bytes here.
 * @param {string} path
 * @returns {{ name: string, prefix: string } | null} null if unrepresentable
 */
function tarSplitPath(path) {
  if (path.length <= 100) return { name: path, prefix: "" };
  // Prefer the shortest prefix that makes the name fit.
  for (let i = 1; i < path.length; i++) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return null;
}

/**
 * Build a ustar archive of regular files (mode 0644, root, mtime 0 — the
 * content is a committed snapshot, so a stable timestamp is a feature).
 * Pure and deterministic; unit-tested against a real header parse.
 * @param {Array<{ path: string, bytes: Uint8Array }>} files
 * @returns {Uint8Array}
 */
export function buildTar(files) {
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const blocks = [];
  let total = 0;
  const push = (/** @type {Uint8Array} */ b) => { blocks.push(b); total += b.length; };
  for (const f of Array.isArray(files) ? files : []) {
    const split = tarSplitPath(f.path);
    if (!split) continue; // unrepresentable path — the cp fallback still carries it
    const h = new Uint8Array(512);
    h.set(enc.encode(split.name), 0); // name[100]
    tarOctal(h, 100, 8, 0o644); // mode
    tarOctal(h, 108, 8, 0); // uid
    tarOctal(h, 116, 8, 0); // gid
    tarOctal(h, 124, 12, f.bytes.length); // size
    tarOctal(h, 136, 12, 0); // mtime
    for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum = spaces while summing
    h[156] = 0x30; // typeflag '0' (regular file)
    h.set(enc.encode("ustar"), 257); // magic "ustar\0"
    h.set(enc.encode("00"), 263); // version
    if (split.prefix) h.set(enc.encode(split.prefix), 345); // prefix[155]
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    const cs = sum.toString(8).padStart(6, "0");
    h.set(enc.encode(cs), 148);
    h[154] = 0;
    h[155] = 0x20;
    push(h);
    push(f.bytes);
    const rem = f.bytes.length % 512;
    if (rem) push(new Uint8Array(512 - rem));
  }
  push(new Uint8Array(1024)); // end-of-archive: two zero blocks
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) { out.set(b, off); off += b.length; }
  return out;
}

/**
 * Plan the introspection source mount: the snapshot's files (repo-relative
 * paths + full text, introspect-core.js's Snapshot shape) become ONE ustar
 * archive (`tar`, extracted in a single spawn — the fast path) PLUS the same
 * files as FLAT entries for the ingest DataDevice at /mnt/in-src (f0, f1, …
 * — files at the device root, the same no-nested-dirs discipline as the other
 * ingest devices) with a per-file cp script (`seedCp`) as the fallback for a
 * guest without tar. The main `seed` script tries the tar extraction and
 * falls back to `sh /mnt/in-src/.seedcp`; both are written INTO the device,
 * so a hundreds-of-lines script never rides in argv.
 *
 * /src lives in the persistent overlay, and extraction is the single most
 * expensive thing this sandbox does on a phone (the fs phase measured 62 s on
 * iOS, chat_logs #522) — so the seed is STAMP-GUARDED, not refreshed blindly:
 * a content stamp (FNV over every path+size) is written to /src/.dr-stamp
 * ONLY after a successful extraction, and the next boot's seed compares it
 * first — a matching stamp means /src is already this exact snapshot and the
 * whole rm -rf + extraction is skipped (only the /workspace/source symlink is
 * refreshed). A stale or missing stamp (older deploy, interrupted seed —
 * the stamp is written LAST, so a partial extraction never stamps) still
 * re-extracts from scratch. A friendly /workspace/source symlink points at
 * /src either way.
 * @param {Array<{ p: string, s?: number, t: string }>} files
 * @param {{ totalMax?: number }} [opts]
 * @returns {{ entries: Array<{ flat: string, path: string, bytes: Uint8Array }>, seed: string, seedCp: string, tar: Uint8Array, stamp: string, count: number, bytes: number, dropped: number } | null}
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
  // Fallback (no tar in the guest): recreate the tree with one cp per file.
  const cpLines = [];
  cpLines.push("mkdir -p /src " + [...dirs].sort().map(shellEscape).join(" "));
  for (const e of entries) {
    cpLines.push(`cp /mnt/in-src/${e.flat} ${shellEscape("/src/" + e.path)}`);
  }
  const stamp = sourceStamp(entries);
  // Main seed: skip everything when the persisted /src already carries this
  // exact snapshot (the stamp guard — see the function comment), else one tar
  // extraction (archive entry names are repo-relative, so -C /src lands them
  // at /src/<path>), cp script only if tar fails/missing. The stamp is written
  // ONLY when an extraction path exited 0, and it is written LAST — an
  // interrupted or failed seed leaves no stamp and re-extracts next boot.
  const lines = [];
  lines.push(`if [ "$(cat /src/.dr-stamp 2>/dev/null)" != ${shellEscape(stamp)} ]; then`);
  lines.push("rm -rf /src");
  lines.push("mkdir -p /src");
  lines.push(`( tar -xf /mnt/in-src/src.tar -C /src 2>/dev/null || sh /mnt/in-src/.seedcp 2>/dev/null ) && printf '%s' ${shellEscape(stamp)} > /src/.dr-stamp 2>/dev/null || true`);
  lines.push("fi");
  lines.push("mkdir -p /workspace 2>/dev/null || true");
  lines.push("ln -sfn /src /workspace/source 2>/dev/null || true");
  const tar = buildTar(entries.map((e) => ({ path: e.path, bytes: e.bytes })));
  return {
    entries,
    seed: lines.join("\n") + "\n",
    seedCp: cpLines.join("\n") + "\n",
    tar,
    stamp,
    count: entries.length,
    bytes,
    dropped,
  };
}

/**
 * A short, stable content stamp for the source snapshot: FNV-1a over every
 * kept entry's path and byte length, plus the entry count. Deterministic for
 * the same deploy's snapshot, different the moment any file's path or size
 * changes — exactly the granularity the seed's skip-if-current guard needs
 * (the snapshot is a committed artifact, so size+path is an honest proxy for
 * content without hashing megabytes on every boot).
 * @param {Array<{ path: string, bytes: Uint8Array }>} entries
 * @returns {string}
 */
export function sourceStamp(entries) {
  let h = 0x811c9dc5;
  const mix = (/** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of entries) mix(e.path + ":" + e.bytes.length + ";");
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + entries.length;
}
