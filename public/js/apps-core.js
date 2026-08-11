// @ts-check
// Published apps (`/app/<slug>/`) — the shared pure core behind the /apps/
// management surface.
//
// Agent Studio publishes a build to R2 and hands back a URL (src/build-pub.js),
// and until now that URL was the ONLY handle on it: nothing listed what you had
// published, renamed one, or removed one without an admin `curl`. This core
// holds the parts both ends need — the server listing (src/apps.js, its façade)
// and the browser page (public/js/apps.js) — so a title cap or an ownership
// rule cannot mean one thing in the API and another in the UI.
//
// Pure by construction: no fetch, no DOM, no R2. Everything here takes plain
// values and returns plain values, which is what makes public/js/apps-core.test.js
// able to cover the whole ruleset without a browser or a Worker.

import { MAX_BUILD_FILES, MAX_BUILD_FILE_BYTES, MAX_BUILD_TOTAL_BYTES, sanitizeBuildPath } from "./sdk-core.js";

/** The title cap publishBuild already applies — restated here so the UI can
 * stop a rename at the same boundary instead of silently having it truncated
 * server-side. */
export const APP_TITLE_MAX = 120;

/** Sort orders the listing offers. `new` is the default: the app you just
 * built is the one you are looking for. */
export const APP_SORTS = /** @type {const} */ (["new", "old", "name", "size"]);

/**
 * The meta object publishBuild writes is `{title, createdAt, owner, files:[{p,s}]}`.
 * A summary row is that, flattened, plus the two numbers the UI shows (file
 * count and total bytes) and the URL. Tolerant of a malformed/absent meta: a
 * build whose meta failed to parse still LISTS (the objects exist and can be
 * deleted) rather than vanishing from the only surface that could clean it up.
 * @param {string} slug
 * @param {any} meta
 * @returns {{slug: string, title: string, createdAt: number, updatedAt: number, owner: string, files: number, bytes: number, url: string}}
 */
export function appSummary(slug, meta) {
  const list = Array.isArray(meta?.files) ? meta.files : [];
  let bytes = 0;
  for (const f of list) bytes += Number(f?.s) > 0 ? Number(f.s) : 0;
  const createdAt = Number(meta?.createdAt) > 0 ? Number(meta.createdAt) : 0;
  return {
    slug,
    title: normalizeAppTitle(meta?.title) || slug,
    createdAt,
    // `updatedAt` is written by the /apps management surface only — a build
    // published by the pipeline has never been edited, so it falls back to
    // createdAt and the two sorts agree for apps nobody has touched.
    updatedAt: Number(meta?.updatedAt) > 0 ? Number(meta.updatedAt) : createdAt,
    owner: typeof meta?.owner === "string" ? meta.owner : "",
    files: list.length,
    bytes,
    url: appUrl(slug),
  };
}

/** @param {string} slug */
export const appUrl = (slug) => `/app/${slug}/`;

/**
 * A title as it will be STORED: trimmed and capped. Returns "" for anything
 * that isn't usable text, so a caller can tell "leave it alone" from "set it".
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeAppTitle(raw) {
  if (typeof raw !== "string") return "";
  // Trimmed AFTER the slice as well as before it: the cut lands wherever 120
  // characters end, which can be mid-gap, and a stored title ending in a space
  // renders as a title with a stray gap before whatever follows it.
  return raw.replace(/\s+/g, " ").trim().slice(0, APP_TITLE_MAX).trim();
}

/**
 * Who may rename/delete/edit an app: its owner, or an admin. Both ends check
 * this — the server because it is the actual gate, the client because showing
 * a button that 403s is worse than not showing it.
 * @param {{owner?: string}} app
 * @param {{id?: string, role?: string}} me
 * @returns {boolean}
 */
export function canManageApp(app, me) {
  if (!app || !me) return false;
  if (me.role === "admin") return true;
  return Boolean(app.owner) && String(app.owner) === String(me.id ?? "");
}

/**
 * Substring match over the two fields a person actually remembers: the slug
 * and the title. Case- and diacritic-insensitive so "sokratisk" finds
 * "Sokratisk" (invariant 6 — a Swedish title must be as findable as an
 * English one, and `toLowerCase` alone does not fold the accents a paste from
 * elsewhere carries).
 * @param {{slug?: string, title?: string}} app
 * @param {string} q
 * @returns {boolean}
 */
export function appMatches(app, q) {
  const needle = fold(q);
  if (!needle) return true;
  return fold(app?.slug ?? "").includes(needle) || fold(app?.title ?? "").includes(needle);
}

/** @param {string} s */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Filter + sort in one step — the listing is small enough (an account's builds)
 * that doing it in memory beats a query language, and doing it HERE means the
 * `?q=`/`?sort=` API and the page's search box cannot disagree.
 * @template {{slug?: string, title?: string, createdAt?: number, bytes?: number}} T
 * @param {T[]} apps
 * @param {{q?: string, sort?: string}} [opts]
 * @returns {T[]}
 */
export function selectApps(apps, opts = {}) {
  const q = opts.q ?? "";
  const sort = APP_SORTS.includes(/** @type {any} */ (opts.sort)) ? opts.sort : "new";
  const rows = (Array.isArray(apps) ? apps : []).filter((a) => appMatches(a, q));
  /** @param {any} a @param {any} b */
  const byNew = (a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0);
  rows.sort((a, b) => {
    if (sort === "old") return -byNew(a, b);
    if (sort === "size") return (Number(b?.bytes) || 0) - (Number(a?.bytes) || 0) || byNew(a, b);
    if (sort === "name") {
      // Locale compare so å/ä/ö sort where a Swedish reader expects them,
      // rather than after z as a codepoint sort would put them.
      return String(a?.title ?? "").localeCompare(String(b?.title ?? ""), "sv") || byNew(a, b);
    }
    return byNew(a, b);
  });
  return rows;
}

/**
 * Validate an edit to ONE file of an existing app, returning the full file
 * list to republish (publishBuild is whole-collection: what you don't send is
 * pruned, so an edit has to resend everything).
 *
 * `current` is the app's files as `[{path, content}]`; `path` must already
 * exist OR be a valid new path. Returns `{files}` or `{error}` — the same
 * shape publishBuild answers with, so the caller has one thing to check.
 * @param {Array<{path: string, content: string}>} current
 * @param {unknown} rawPath
 * @param {unknown} rawContent
 * @returns {{files: Array<{path: string, content: string}>} | {error: string}}
 */
export function planFileEdit(current, rawPath, rawContent) {
  const files = (Array.isArray(current) ? current : []).map((f) => ({ path: f.path, content: f.content }));
  const sizes = files.map((f) => ({ path: f.path, size: new TextEncoder().encode(String(f.content ?? "")).length }));
  const check = checkFileEdit(sizes, rawPath, rawContent);
  if ("error" in check) return { error: check.error };

  const at = files.findIndex((f) => f.path === check.path);
  if (at >= 0) files[at] = { path: check.path, content: /** @type {string} */ (rawContent) };
  else files.push({ path: check.path, content: /** @type {string} */ (rawContent) });
  return { files };
}

/**
 * The SAME ruleset as `planFileEdit`, decided from a `[{path, size}]` listing
 * instead of the files' contents.
 *
 * This exists because the two callers hold different things. The server has
 * read every file (it has to — publishBuild republishes the collection), so it
 * plans. The BROWSER has only what `GET /api/apps/:slug` returns, which is
 * sizes: pulling all 40 files just to weigh the collection would make opening
 * an app cost as much as downloading it. Sizes are all the caps actually need
 * — the edited file's own content is the only one whose bytes change — so the
 * page can refuse an over-cap save with a sentence under the button instead of
 * a round trip that ends in a 400.
 *
 * `planFileEdit` delegates here, which is what keeps the two answers identical.
 * @param {Array<{path: string, size: number}>} sizes
 * @param {unknown} rawPath
 * @param {unknown} rawContent
 * @returns {{path: string, size: number} | {error: string}}
 */
export function checkFileEdit(sizes, rawPath, rawContent) {
  const path = sanitizeBuildPath(rawPath);
  if (!path) return { error: "Invalid file path for a published app." };
  if (typeof rawContent !== "string") return { error: "File content must be text." };
  const size = new TextEncoder().encode(rawContent).length;
  if (size > MAX_BUILD_FILE_BYTES) return { error: "That file is over the per-file size cap." };

  const rows = (Array.isArray(sizes) ? sizes : []).map((f) => ({
    path: String(f?.path ?? ""),
    size: Number(f?.size) > 0 ? Number(f.size) : 0,
  }));
  const at = rows.findIndex((f) => f.path === path);
  if (at >= 0) rows[at] = { path, size };
  else rows.push({ path, size });

  if (rows.length > MAX_BUILD_FILES) return { error: "That would take the app over the file-count cap." };
  let total = 0;
  for (const f of rows) total += f.size;
  if (total > MAX_BUILD_TOTAL_BYTES) return { error: "That would take the app over the total size cap." };
  if (!rows.some((f) => f.path === "index.html")) return { error: "An app needs an index.html entry point." };
  return { path, size };
}

/**
 * Same, for removing a file. Refuses to remove the entry point, because the
 * result would be a published app that 404s at its own URL.
 *
 * Generic over the row shape because a removal reads nothing but the path: the
 * server passes `{path, content}` (it republishes what comes back) and the page
 * passes the `{path, size}` listing it already has, and both get their own
 * shape back.
 * @template {{path: string}} T
 * @param {T[]} current
 * @param {unknown} rawPath
 * @returns {{files: T[]} | {error: string}}
 */
export function planFileRemove(current, rawPath) {
  const path = sanitizeBuildPath(rawPath);
  if (!path) return { error: "Invalid file path for a published app." };
  if (path === "index.html") return { error: "index.html is the entry point and cannot be removed." };
  const files = (Array.isArray(current) ? current : []).filter((f) => f.path !== path);
  if (files.length === (Array.isArray(current) ? current.length : 0)) return { error: "No such file in this app." };
  if (!files.length) return { error: "An app needs at least one file." };
  return { files };
}

/** Human byte sizes, matching the units the build summary already uses.
 * @param {unknown} n */
export function formatBytes(n) {
  // `null` is checked before Number(), which turns it into 0 — a missing byte
  // count would otherwise render as a confident "0 B", i.e. as the claim that
  // the app is empty rather than that nobody counted.
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} kB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Relative age, in the same voice as the rest of the app ("3 days ago").
 * `now` is a parameter so the test doesn't have to freeze the clock.
 * @param {number} ts epoch ms
 * @param {number} [now]
 */
export function formatWhen(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} days ago`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `${mo} months ago`;
  return `${Math.round(mo / 12)} years ago`;
}

/**
 * The `?format=text` rendering of a listing — the decision-board convention
 * (docs: decision-boards): every admin surface that lists things can be read
 * by an agent without parsing HTML or guessing at JSON shape.
 * @param {Array<ReturnType<typeof appSummary>>} apps
 * @param {number} [now]
 * @returns {string}
 */
export function renderAppsText(apps, now = Date.now()) {
  const rows = Array.isArray(apps) ? apps : [];
  if (!rows.length) return "No published apps.\n";
  const lines = [`${rows.length} published app${rows.length === 1 ? "" : "s"}`, ""];
  for (const a of rows) {
    // Both timestamps, but only when they differ: an agent asked to act on
    // "the app I just changed" cannot find it from a made-on date alone, and
    // printing "edited" on every row (where it equals the build date) would
    // be noise on the majority that were never touched.
    const edited = Number(a.updatedAt) > Number(a.createdAt) ? `  ·  edited ${formatWhen(a.updatedAt, now)}` : "";
    lines.push(
      `${a.slug}  ${a.title}`,
      `    ${a.url}  ·  ${a.files} file${a.files === 1 ? "" : "s"}  ·  ${formatBytes(a.bytes)}  ·  ${formatWhen(a.createdAt, now)}${edited}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
