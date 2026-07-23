// @ts-check
// Published SDK-mode builds — the /app/<slug>/ surface (R2 `build/{slug}`).
//
// SDK mode (the green mode in the mode dropdown) lets a conversation BUILD a
// small self-contained web app: the model stages files (write_file, or the
// deterministic FILE-block convention on models without tool use), and the
// pipeline publishes the collection here so the user gets a live URL to try
// immediately — the "describe it, get a link" loop. Storage is the same R2
// bucket the replay publications use (src/pub.js), under its own prefix:
//
//   build/<slug>/meta      — {title, createdAt, owner, files:[{p,s}]}
//   build/<slug>/f/<path>  — one object per published file
//
// Serving (GET /app/<slug>/<path>, routed PUBLIC in src/index.js — a build
// URL is meant to be shared) sends every response with
// `Content-Security-Policy: sandbox allow-scripts …`, which forces the
// document into an OPAQUE ORIGIN: published pages get no cookies, no
// localStorage, and no credentialed same-origin fetch — so a generated (or
// maliciously-crafted) page structurally cannot read the signed-in app's
// session or call its APIs as the visitor, even though it is served from the
// site's own hostname. Do not weaken that header without a design review.
//
// Writes normally happen INSIDE the pipeline (publishBuild — the caller has
// already resolved identity). The ONE other write surface is
// `handleBuildManualPublish` (PUT /api/build/:slug, admin-gated, alongside
// the DELETE below): a bypass of the chat/tool loop for output that was
// ALREADY built elsewhere — the execution sandbox's outbox convention, or a
// hand-assembled directory — and just needs a live `/app/<slug>/` URL. See
// `scripts/publish-app` and the publish-app skill. It calls the exact same
// `publishBuild` the pipeline uses, so a manually published app gets the
// same validation, caps, and CSP-sandboxed serving as one the model built.

import { jsonResponse } from "./http.js";
import {
  MAX_BUILD_FILES,
  MAX_BUILD_FILE_BYTES,
  MAX_BUILD_TOTAL_BYTES,
  sanitizeBuildPath,
  slugify,
} from "./sdk-tools.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

// Slugs: lowercase words + a random suffix (newBuildSlug). No dots, so a slug
// never collides with real asset files; same shape as pub.js slugs.
/** @param {unknown} s */
export const buildSlugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);

/** @param {string} slug */
const metaKey = (slug) => `build/${slug}/meta`;
/** @param {string} slug @param {string} path */
const fileKey = (slug, path) => `build/${slug}/f/${path}`;

/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

/**
 * Mint a fresh build slug from a title: the slugified fragment plus a short
 * random suffix (collision + guessing resistance without a registry).
 * @param {unknown} title
 * @returns {string}
 */
export function newBuildSlug(title) {
  const frag = slugify(title) || "app";
  const rnd = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...rnd].map((b) => (b % 36).toString(36)).join("");
  return `${frag.slice(0, 40)}-${suffix}`;
}

/**
 * True when `reply` already links to `url` with markdown link syntax — the URL
 * sits inside a `](…)` target, so `marked` renders it as a clickable anchor.
 *
 * A bare or bold path (`Live: /app/slug/`, or the same wrapped in asterisks)
 * does NOT count: `marked`'s GFM autolinker only makes full `http(s)://` URLs
 * clickable and never a relative `/app/…` path, so a build reply that mentions
 * the URL in prose still needs the explicit "Try it live" link appended or the
 * user is left with unclickable text. The build tool path hit exactly this —
 * the model called publish_app, got the URL, and wrote it bold instead of as a
 * link, while the old guard (a plain substring check) saw the path in prose and
 * suppressed the append ("no link to the generated app", 2026-07-18). The
 * appended link also rides the answer text, so it survives a dropped-stream
 * recovery, where only the text (never the `build` status event) is replayed.
 * @param {string} reply
 * @param {string} url
 * @returns {boolean}
 */
export function replyLinksTo(reply, url) {
  if (!reply || !url) return false;
  return reply.includes(`](${url})`) || reply.includes(`](${url} `);
}

/** Content types for the served build files (text formats only — the staging
 * rules in sdk-core.js allowlist the extensions). */
const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};

// The load-bearing header (see the module comment): every build response is
// sandboxed into an opaque origin. allow-scripts keeps generated apps
// interactive; allow-same-origin is DELIBERATELY absent.
const BUILD_CSP =
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock";

/**
 * Publish (or republish) a build: validate + cap the files, enforce slug
 * ownership, write the objects, and prune files dropped since the last
 * publish. Returns {slug, url, files, bytes} or {error}.
 *
 * `keepOwner` is the ADMIN-gated in-place republish (the manual PUT):
 * an existing slug is reused even when the caller isn't its owner, and the
 * build KEEPS its original owner — so a maintenance fix pushed over a
 * user's app leaves the user able to keep iterating on it from their own
 * chat. Only the admin-authenticated manual path may set it.
 * @param {Env} env
 * @param {Logger} log
 * @param {{ slug?: string | null, title: string, files: Array<{ path: string, content: string }>, userId: string, keepOwner?: boolean }} opts
 * @returns {Promise<{ slug: string, url: string, files: number, bytes: number } | { error: string }>}
 */
export async function publishBuild(env, log, { slug, title, files, userId, keepOwner = false }) {
  if (!env.STORAGE) return { error: "Publishing is not configured on this server (no R2 bucket)." };
  const cleanTitle = String(title || "").trim().slice(0, 120) || "Untitled build";

  // Re-validate every file at the publish boundary (defense in depth — the
  // staging layer already enforced this for the tool path, but the FILE-block
  // fallback and any future caller land here too).
  /** @type {Map<string, string>} */
  const clean = new Map();
  let bytes = 0;
  for (const f of Array.isArray(files) ? files : []) {
    const p = sanitizeBuildPath(f?.path);
    if (!p || typeof f?.content !== "string") continue;
    const size = new TextEncoder().encode(f.content).length;
    if (size > MAX_BUILD_FILE_BYTES) continue;
    if (!clean.has(p) && clean.size >= MAX_BUILD_FILES) continue;
    clean.set(p, f.content);
  }
  for (const [, c] of clean) bytes += new TextEncoder().encode(c).length;
  if (!clean.size) return { error: "Nothing publishable: no valid files were produced." };
  if (bytes > MAX_BUILD_TOTAL_BYTES) return { error: "Build exceeds the total size cap." };
  if (!clean.has("index.html")) return { error: "A build needs an index.html entry point." };

  // Slug: reuse the conversation's existing one (iteration keeps the URL
  // stable) when it's valid AND owned by this user — or when the admin
  // in-place republish (keepOwner) is taking it over; otherwise mint
  // fresh. On a keepOwner takeover the ORIGINAL owner is preserved.
  let owner = String(userId);
  let finalSlug = buildSlugOk(slug) ? /** @type {string} */ (slug) : null;
  if (finalSlug) {
    try {
      const existing = await bucket(env).get(metaKey(finalSlug));
      if (existing) {
        const meta = /** @type {any} */ (await existing.json().catch(() => null));
        if (!meta) finalSlug = null;
        else if (String(meta.owner ?? "") !== String(userId)) {
          if (keepOwner) owner = String(meta.owner ?? "");
          else finalSlug = null;
        }
      }
    } catch {
      finalSlug = null;
    }
  }
  if (!finalSlug) finalSlug = newBuildSlug(cleanTitle);

  // Prune files from the previous publish that this one no longer carries —
  // otherwise a renamed file's old copy would keep serving forever.
  try {
    const prefix = `build/${finalSlug}/f/`;
    let cursor;
    do {
      const page = await bucket(env).list({ prefix, cursor });
      for (const o of page.objects) {
        const p = o.key.slice(prefix.length);
        if (!clean.has(p)) await bucket(env).delete(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (/** @type {any} */ err) {
    log.warn("build.prune_failed", { slug: finalSlug, error: err?.message || String(err) });
  }

  const meta = {
    title: cleanTitle,
    createdAt: Date.now(),
    owner,
    files: [...clean].map(([p, c]) => ({ p, s: new TextEncoder().encode(c).length })),
  };
  await bucket(env).put(metaKey(finalSlug), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { title: cleanTitle.slice(0, 200), owner: owner.slice(0, 100) },
  });
  for (const [p, c] of clean) {
    await bucket(env).put(fileKey(finalSlug, p), c);
  }
  log.info("build.published", { slug: finalSlug, files: clean.size, bytes, user_id: userId });
  return { slug: finalSlug, url: `/app/${finalSlug}/`, files: clean.size, bytes };
}

/**
 * GET /app/<slug> and /app/<slug>/<path> — the public serving face.
 * Routed BEFORE the identity gate (a build link is meant to be shared); every
 * response carries the sandboxing CSP (see the module comment).
 * @param {Env} env
 * @param {string} slug
 * @param {string | null} subpath path after the slug: "" for the root, null
 *   when the URL had no trailing slash at all (→ 301 to the slash form)
 * @returns {Promise<Response>}
 */
export async function handleBuildGet(env, slug, subpath) {
  if (!env.STORAGE) return jsonResponse({ error: "Builds are not configured on this server." }, 503);
  if (!buildSlugOk(slug)) return notFound();
  // /build/<slug> (no trailing slash) → the slash form, so the page's relative
  // asset URLs (css/app.css …) resolve under the build.
  if (subpath === null) {
    return new Response(null, { status: 301, headers: { location: `/app/${slug}/` } });
  }
  const path = subpath === "" ? "index.html" : sanitizeBuildPath(subpath);
  if (!path) return notFound();
  const obj = await bucket(env).get(fileKey(slug, path));
  if (!obj) return notFound();
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return new Response(obj.body, {
    headers: {
      "content-type": CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (ext)] || "text/plain; charset=utf-8",
      "cache-control": "public, max-age=60",
      "content-security-policy": BUILD_CSP,
      "x-robots-tag": "noindex",
    },
  });
}

/**
 * DELETE /api/build/:slug — unpublish (ADMIN only; the caller has verified
 * identity.role === "admin" — the pub.js arrangement).
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {string} slug
 * @returns {Promise<Response>}
 */
export async function handleBuildDelete(request, env, log, slug) {
  if (!env.STORAGE) return jsonResponse({ error: "Builds are not configured on this server." }, 503);
  if (request.method !== "DELETE") return jsonResponse({ error: "Not found." }, 404);
  if (!buildSlugOk(slug)) return jsonResponse({ error: "Invalid slug." }, 400);
  const prefix = `build/${slug}/`;
  let cursor;
  let removed = 0;
  do {
    const page = await bucket(env).list({ prefix, cursor });
    for (const o of page.objects) {
      await bucket(env).delete(o.key);
      removed++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  log.info("build.deleted", { slug, objects: removed });
  return new Response(null, { status: 204 });
}

/**
 * PUT /api/build/:slug — ADMIN-ONLY manual publish (the caller has verified
 * identity.role === "admin"). The bypass of the chat/tool loop for a bundle
 * that's already built (the execution sandbox's outbox, a hand-assembled
 * directory — see the publish-app skill / `scripts/publish-app`): thin
 * validation of the request body, then the SAME `publishBuild` the pipeline
 * calls, so a manual publish gets identical caps + CSP-sandboxed serving.
 * Ownership is the ADMIN identity (`identity.id`) — re-PUTting the same URL
 * slug republishes in place (files not resent are pruned, like the pipeline
 * path). The URL slug must itself be well-formed; `publishBuild` still mints
 * a fresh one if this admin doesn't already own it (e.g. it collides with
 * someone else's build).
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {import('./auth.js').Identity} identity
 * @param {string} slug
 * @returns {Promise<Response>}
 */
export async function handleBuildManualPublish(request, env, log, identity, slug) {
  if (!env.STORAGE) return jsonResponse({ error: "Builds are not configured on this server." }, 503);
  if (!buildSlugOk(slug)) return jsonResponse({ error: "Invalid slug (lowercase letters, digits, hyphens)." }, 400);
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const title = typeof body?.title === "string" ? body.title : "";
  const files = Array.isArray(body?.files) ? body.files : null;
  if (!files || !files.length) {
    return jsonResponse({ error: "files must be a non-empty array of {path, content}." }, 400);
  }
  // keepOwner: this endpoint is admin-gated (the caller verified that), so
  // it may republish an existing build IN PLACE — same /app/<slug>/ URL —
  // while the build keeps its original owner (see publishBuild).
  const result = await publishBuild(env, log, { slug, title, files, userId: identity.id, keepOwner: true });
  if ("error" in result) return jsonResponse({ error: result.error }, 400);
  log.info("build.manual_publish", { slug: result.slug, admin: identity.id });
  return jsonResponse({ ok: true, ...result });
}

const notFound = () =>
  new Response("Not found.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": BUILD_CSP },
  });
