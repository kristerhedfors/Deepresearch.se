// @ts-check
// Published apps — the management surface over /app/<slug>/ (R2 `build/…`).
//
// Agent Studio publishes a build and hands back a URL (src/build-pub.js), and
// until this module that URL was the ONLY handle on it: nothing listed what an
// account had published, renamed one, fixed a typo in one, or took one down.
// The two HTTP surfaces that existed — PUT/DELETE /api/build/:slug — are
// ADMIN-gated and `scripts/publish-app` depends on the PUT, so they are left
// exactly as they are; this is a second, USER-owned face over the same objects:
//
//   build/<slug>/meta      — {title, createdAt, updatedAt?, owner, files:[{p,s}]}
//   build/<slug>/f/<path>  — one object per published file
//
// Endpoints (signed-in; the per-app gate is ownership, not role — see below):
//   GET    /api/apps                    the caller's apps; admin ?all=1 for
//                                       every account's. ?q= ?sort= ?format=text
//   GET    /api/apps/:slug              one app + its file list
//   GET    /api/apps/:slug/file?path=   one file's text (manage only)
//   PATCH  /api/apps/:slug              {title} — rename (manage only)
//   PUT    /api/apps/:slug/file         {path, content} (manage only)
//   DELETE /api/apps/:slug/file?path=   (manage only)
//   DELETE /api/apps/:slug              unpublish (manage only)
//
// WHO MAY WRITE. `canManageApp` (the shared core) is the whole rule: the app's
// owner, or an admin. It is checked per app rather than per route, because the
// route is reachable by every signed-in user — an app belongs to the account
// that built it, not to the operator.
//
// The RULES live in public/js/apps-core.js and this module re-exports them
// (façade discipline — src/facade-contract.test.js pins that the exported
// function objects ARE the core's): the title cap, the sort orders, the search
// fold, the ownership predicate, the two file-edit planners and the
// `?format=text` rendering are the same code the page runs, so the API and the
// UI cannot disagree about what is allowed.
//
// WHY AN EDIT REPUBLISHES THE WHOLE COLLECTION. `publishBuild` is
// whole-collection by design — files it is not sent are pruned — so changing
// one file means reading them all back, planning the new set (planFileEdit /
// planFileRemove), and republishing. That keeps ONE publish path with one set
// of caps and one CSP posture, at the cost of an R2 read per file. A RENAME
// deliberately does NOT go through it: rewriting every file object to change a
// title would be pure waste, so the rename touches the meta object alone.

import { jsonResponse, readJsonBody, textResponse } from "./http.js";
import { buildSlugOk, handleBuildDelete, publishBuild } from "./build-pub.js";
import { MAX_BUILD_FILE_BYTES, sanitizeBuildPath } from "./sdk-tools.js";
import {
  appSummary,
  canManageApp,
  normalizeAppTitle,
  planFileEdit,
  planFileRemove,
  renderAppsText,
  selectApps,
} from "../public/js/apps-core.js";

// Re-exported, not mirrored: the listing rules the page renders with are the
// same objects the API selects with (src/facade-contract.test.js enforces the
// identity, so a re-implementation here fails the build).
export * from "../public/js/apps-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/** @param {string} slug */
const metaKey = (slug) => `build/${slug}/meta`;
/** @param {string} slug */
const filePrefix = (slug) => `build/${slug}/f/`;
/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

// How many metas one listing walks. An account has tens of apps, not hundreds,
// and the admin's ?all=1 view is a management screen rather than a report — so
// the walk is BOUNDED and says so (`truncated` in the response, a warning in
// the log) instead of paging forever behind a spinner. Raise it if the number
// of published apps ever makes it bite.
export const MAX_LISTED_APPS = 500;

// How many meta objects are read at once. 500 sequential round-trips would
// dominate the response; 500 at once is a needless burst against one bucket.
const META_BATCH = 20;

const NO_STORAGE = "Builds are not configured on this server.";

/**
 * Read an app's meta object.
 *
 * `valid` is false when the JSON did not parse: publishBuild also stamps
 * `{title, owner}` into the object's customMetadata, so a corrupted meta is
 * RECOVERED from that rather than making the app vanish — this is the only
 * surface that can rename or delete it, and an app that cannot be listed is an
 * app nobody can clean up. Write paths repair it before touching anything else
 * (see `ensureValidMeta`).
 * @param {Env} env
 * @param {string} slug
 * @returns {Promise<{ meta: any, valid: boolean } | null>} null when there is no such app
 */
async function readMeta(env, slug) {
  const obj = await bucket(env).get(metaKey(slug));
  if (!obj) return null;
  const parsed = await obj.json().catch(() => null);
  if (parsed && typeof parsed === "object") return { meta: parsed, valid: true };
  const cm = obj.customMetadata || {};
  return { meta: { title: cm.title || "", owner: cm.owner || "", files: [] }, valid: false };
}

/**
 * Write the meta object in the shape publishBuild writes it — including the
 * customMetadata pair, which is what makes a listing survive a meta whose JSON
 * body is unreadable.
 * @param {Env} env
 * @param {string} slug
 * @param {any} meta
 * @returns {Promise<void>}
 */
async function writeMeta(env, slug, meta) {
  const title = String(meta?.title || "");
  const owner = String(meta?.owner || "");
  await bucket(env).put(metaKey(slug), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { title: title.slice(0, 200), owner: owner.slice(0, 100) },
  });
}

/**
 * Repair an unparseable meta before a write path proceeds. Without this, an
 * edit would call publishBuild, which re-reads the meta itself, fail to parse
 * it, conclude the slug is unowned and mint a FRESH one — forking the app to a
 * new URL instead of editing it.
 * @param {Env} env
 * @param {Logger} log
 * @param {string} slug
 * @param {{ meta: any, valid: boolean }} read
 * @returns {Promise<void>}
 */
async function ensureValidMeta(env, log, slug, read) {
  if (read.valid) return;
  log.warn("apps.meta_repaired", { slug });
  await writeMeta(env, slug, read.meta);
}

/**
 * Every app in the bucket, newest-agnostic (the sort is applied later by
 * `selectApps`). `owner` scopes the walk to one account; null lists everything.
 * @param {Env} env
 * @param {Logger} log
 * @param {{ owner: string | null }} opts
 * @returns {Promise<{ apps: Array<ReturnType<typeof appSummary>>, truncated: boolean }>}
 */
async function listApps(env, log, { owner }) {
  /** @type {string[]} */
  const slugs = [];
  let cursor;
  let truncated = false;
  // Only meta keys matter: `build/` also holds every file object, and the
  // delimiter-less walk is the same cursor loop handleBuildDelete uses.
  do {
    const page = await bucket(env).list({ prefix: "build/", cursor });
    for (const o of page.objects) {
      const m = o.key.match(/^build\/([^/]+)\/meta$/);
      if (!m) continue;
      if (slugs.length >= MAX_LISTED_APPS) {
        truncated = true;
        break;
      }
      slugs.push(m[1]);
    }
    cursor = !truncated && page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (truncated) log.warn("apps.list_truncated", { cap: MAX_LISTED_APPS, owner: owner || "*" });

  /** @type {Array<ReturnType<typeof appSummary>>} */
  const apps = [];
  for (let i = 0; i < slugs.length; i += META_BATCH) {
    const batch = slugs.slice(i, i + META_BATCH);
    const reads = await Promise.all(batch.map((slug) => readMeta(env, slug).catch(() => null)));
    reads.forEach((read, n) => {
      if (!read) return; // deleted between the list and the read
      const app = appSummary(batch[n], read.meta);
      if (owner !== null && app.owner !== owner) return;
      apps.push(app);
    });
  }
  return { apps, truncated };
}

/**
 * An app's files, read back whole — what an edit has to resend, because
 * publishBuild prunes anything it is not given.
 * @param {Env} env
 * @param {string} slug
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
async function readFiles(env, slug) {
  const prefix = filePrefix(slug);
  /** @type {string[]} */
  const paths = [];
  let cursor;
  do {
    const page = await bucket(env).list({ prefix, cursor });
    for (const o of page.objects) paths.push(o.key.slice(prefix.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  /** @type {Array<{ path: string, content: string }>} */
  const files = [];
  for (const path of paths) {
    const obj = await bucket(env).get(prefix + path);
    if (!obj) continue;
    files.push({ path, content: await obj.text() });
  }
  return files;
}

/**
 * The file list the detail view shows. Taken from the meta's `files:[{p,s}]`
 * (what publishBuild recorded) and falling back to the objects themselves when
 * that is missing or empty — a recovered meta has no file list, and the edit
 * surface is exactly where those files still need to be reachable.
 * @param {Env} env
 * @param {string} slug
 * @param {any} meta
 * @returns {Promise<Array<{ path: string, size: number }>>}
 */
async function fileList(env, slug, meta) {
  const recorded = /** @type {any[]} */ (Array.isArray(meta?.files) ? meta.files : []);
  if (recorded.length) {
    return recorded
      .filter((f) => typeof f?.p === "string")
      .map((f) => ({ path: String(f.p), size: Number(f.s) > 0 ? Number(f.s) : 0 }));
  }
  const prefix = filePrefix(slug);
  /** @type {Array<{ path: string, size: number }>} */
  const out = [];
  let cursor;
  do {
    const page = await bucket(env).list({ prefix, cursor });
    for (const o of page.objects) out.push({ path: o.key.slice(prefix.length), size: Number(o.size) || 0 });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Republish an app around a new file set, keeping its identity.
 *
 * publishBuild stamps a FRESH `createdAt` on every publish, which is right for
 * a new build and wrong for an edit: without the fixup below, saving a typo fix
 * would jump the app to the top of a "newest" sort and lose the day it was
 * actually made. So the meta is rewritten afterwards with the ORIGINAL
 * createdAt and `updatedAt` = now — the one field this surface owns.
 * @param {Env} env
 * @param {Logger} log
 * @param {string} slug
 * @param {any} meta the app's current meta (already repaired if needed)
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Promise<{ app: ReturnType<typeof appSummary> } | { error: string }>}
 */
async function republish(env, log, slug, meta, files) {
  const result = await publishBuild(env, log, {
    slug,
    title: String(meta?.title || "") || slug,
    files,
    // The caller is the owner or an admin (canManageApp, checked by the
    // handler). keepOwner is what keeps an ADMIN fix from taking the app away
    // from the user whose chat built it — and what keeps the URL stable.
    userId: String(meta?.owner || ""),
    keepOwner: true,
  });
  if ("error" in result) return { error: result.error };
  if (result.slug !== slug) {
    // Not reachable with a repaired meta (see ensureValidMeta) — but a fork
    // would silently strand the user on a new URL, so it is loud if it happens.
    log.warn("apps.edit_forked", { slug, forked_to: result.slug });
  }
  const after = await readMeta(env, result.slug);
  const next = {
    ...(after?.meta || {}),
    createdAt: Number(meta?.createdAt) > 0 ? Number(meta.createdAt) : Date.now(),
    updatedAt: Date.now(),
  };
  await writeMeta(env, result.slug, next);
  return { app: appSummary(result.slug, next) };
}

/**
 * The /api/apps surface. Routed behind the identity gate in src/index.js:
 * every signed-in account reaches it, and ownership is enforced here, per app.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleApps(request, env, url, log, identity) {
  if (!env.STORAGE) return jsonResponse({ error: NO_STORAGE }, 503);
  const rest = url.pathname.replace(/^\/api\/apps/, "").replace(/\/$/, "");
  const method = request.method;

  // GET /api/apps — the board.
  if (rest === "") {
    if (method !== "GET") return jsonResponse({ error: "Not found." }, 404);
    const p = url.searchParams;
    // ?all=1 is an ADMIN view. A non-admin who sends it gets their own list
    // rather than a 403: the parameter is a scope, not a permission, and
    // erroring on it would only teach the client to hide the button.
    const all = p.get("all") === "1" && identity.role === "admin";
    const { apps, truncated } = await listApps(env, log, { owner: all ? null : String(identity.id) });
    const rows = selectApps(apps, { q: p.get("q") || "", sort: p.get("sort") || "" });
    // ?format=text — the decision-board convention: an agent reads the board
    // without parsing JSON.
    if (p.get("format") === "text") return textResponse(renderAppsText(rows));
    return jsonResponse({ apps: rows, me: { id: identity.id, role: identity.role }, truncated });
  }

  const match = rest.match(/^\/([^/]+)(\/file)?$/);
  if (!match) return jsonResponse({ error: "Not found." }, 404);
  const slug = decodeURIComponent(match[1]);
  const isFile = match[2] === "/file";
  if (!buildSlugOk(slug)) return jsonResponse({ error: "Invalid slug." }, 400);

  const read = await readMeta(env, slug);
  if (!read) return jsonResponse({ error: "No such app." }, 404);
  const app = appSummary(slug, read.meta);
  const canManage = canManageApp(app, { id: String(identity.id), role: identity.role });
  const denied = () => jsonResponse({ error: "That app belongs to another account." }, 403);

  // GET /api/apps/:slug — readable by anyone signed in: the app itself is
  // public at /app/<slug>/, so its title and file list are not a secret. Only
  // `can_manage` decides what the page offers to do about it.
  if (!isFile && method === "GET") {
    return jsonResponse({ app, files: await fileList(env, slug, read.meta), can_manage: canManage });
  }

  // PATCH /api/apps/:slug {title} — rename. Meta only (see the module comment).
  if (!isFile && method === "PATCH") {
    if (!canManage) return denied();
    const { body, response } = await readJsonBody(request);
    if (response) return response;
    const title = normalizeAppTitle(body?.title);
    if (!title) return jsonResponse({ error: "An app needs a non-empty title." }, 400);
    const next = { ...read.meta, title, updatedAt: Date.now() };
    await writeMeta(env, slug, next);
    log.info("apps.renamed", { slug, user_id: identity.id });
    return jsonResponse({ ok: true, app: appSummary(slug, next) });
  }

  // DELETE /api/apps/:slug — unpublish. The object loop is handleBuildDelete's
  // (same prefix, same cursor walk, same 204): reused rather than copied, with
  // the ownership check standing in front of it — that admin endpoint's own
  // gate is the route's, and this route is open to every signed-in account.
  if (!isFile && method === "DELETE") {
    if (!canManage) return denied();
    log.info("apps.deleted", { slug, user_id: identity.id, owner: app.owner });
    return handleBuildDelete(request, env, log, slug);
  }

  // GET /api/apps/:slug/file?path= — the EDIT read, not the public one (that is
  // /app/<slug>/<path>), so it is behind the manage gate.
  if (isFile && method === "GET") {
    if (!canManage) return denied();
    const path = sanitizeBuildPath(url.searchParams.get("path"));
    if (!path) return jsonResponse({ error: "Invalid file path." }, 400);
    const obj = await bucket(env).get(filePrefix(slug) + path);
    if (!obj) return jsonResponse({ error: "No such file in this app." }, 404);
    if (Number(obj.size) > MAX_BUILD_FILE_BYTES) {
      return jsonResponse({ error: "That file is over the per-file size cap and cannot be edited here." }, 400);
    }
    const content = await obj.text();
    if (new TextEncoder().encode(content).length > MAX_BUILD_FILE_BYTES) {
      return jsonResponse({ error: "That file is over the per-file size cap and cannot be edited here." }, 400);
    }
    return jsonResponse({ path, content });
  }

  // PUT /api/apps/:slug/file {path, content} — create or replace one file.
  if (isFile && method === "PUT") {
    if (!canManage) return denied();
    const { body, response } = await readJsonBody(request);
    if (response) return response;
    await ensureValidMeta(env, log, slug, read);
    const plan = planFileEdit(await readFiles(env, slug), body?.path, body?.content);
    if ("error" in plan) return jsonResponse({ error: plan.error }, 400);
    const done = await republish(env, log, slug, read.meta, plan.files);
    if ("error" in done) return jsonResponse({ error: done.error }, 400);
    log.info("apps.file_saved", { slug, user_id: identity.id, files: plan.files.length });
    return jsonResponse({ ok: true, app: done.app });
  }

  // DELETE /api/apps/:slug/file?path= — remove one file (never index.html;
  // planFileRemove refuses, because the result would 404 at its own URL).
  if (isFile && method === "DELETE") {
    if (!canManage) return denied();
    await ensureValidMeta(env, log, slug, read);
    const plan = planFileRemove(await readFiles(env, slug), url.searchParams.get("path"));
    if ("error" in plan) return jsonResponse({ error: plan.error }, 400);
    const done = await republish(env, log, slug, read.meta, plan.files);
    if ("error" in done) return jsonResponse({ error: done.error }, 400);
    log.info("apps.file_removed", { slug, user_id: identity.id, files: plan.files.length });
    return jsonResponse({ ok: true, app: done.app });
  }

  return jsonResponse({ error: "Not found." }, 404);
}
