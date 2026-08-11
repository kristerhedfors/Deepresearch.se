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
  return raw.replace(/\s+/g, " ").trim().slice(0, APP_TITLE_MAX);
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
  const path = sanitizeBuildPath(rawPath);
  if (!path) return { error: "Invalid file path for a published app." };
  if (typeof rawContent !== "string") return { error: "File content must be text." };
  const size = new TextEncoder().encode(rawContent).length;
  if (size > MAX_BUILD_FILE_BYTES) return { error: "That file is over the per-file size cap." };

  const files = (Array.isArray(current) ? current : []).map((f) => ({ path: f.path, content: f.content }));
  const at = files.findIndex((f) => f.path === path);
  if (at >= 0) files[at] = { path, content: rawContent };
  else files.push({ path, content: rawContent });

  if (files.length > MAX_BUILD_FILES) return { error: "That would take the app over the file-count cap." };
  let total = 0;
  for (const f of files) total += new TextEncoder().encode(f.content).length;
  if (total > MAX_BUILD_TOTAL_BYTES) return { error: "That would take the app over the total size cap." };
  if (!files.some((f) => f.path === "index.html")) return { error: "An app needs an index.html entry point." };
  return { files };
}

/**
 * Same, for removing a file. Refuses to remove the entry point, because the
 * result would be a published app that 404s at its own URL.
 * @param {Array<{path: string, content: string}>} current
 * @param {unknown} rawPath
 * @returns {{files: Array<{path: string, content: string}>} | {error: string}}
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
    lines.push(
      `${a.slug}  ${a.title}`,
      `    ${a.url}  ·  ${a.files} file${a.files === 1 ? "" : "s"}  ·  ${formatBytes(a.bytes)}  ·  ${formatWhen(a.createdAt, now)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
