// @ts-check
// Self-hosted Linux sandbox images (the admin-selectable, small-image feature —
// see docs/SANDBOX-LOCAL-IMAGE.md). Two PUBLIC endpoints, both routed BEFORE the
// identity gate in index.js because they must serve BOTH tiers, including the
// server-in-no-data-path DRC (/cure) client:
//
//   GET /sandbox/img/<id>.ext2  — streams a self-hosted ext2 image from R2 with
//       HTTP Range support, so CheerpX's HttpBytesDevice can lazily fetch disk
//       blocks (public/js/sandbox.js). Same-origin, so it carries no cross-origin
//       concern under COEP require-corp. Content-addressed by <id> + immutable —
//       publish a NEW id to change an image, never mutate one in place.
//   GET /api/sandbox-image      — the effective sandbox-image config (the admin's
//       selected image URL + id + prefetch flag) both tiers read to decide which
//       disk to boot. Presentation/config only, no user data — the same public
//       posture as /api/anim.
//
// FAIL-SOFT by construction: no STORAGE binding, an unknown/unselected image, or
// any R2 miss degrades to an empty/404/503 answer, and the client falls back to
// the built-in streamed default (invariant 2). Nothing here can break a chat.

import { jsonResponse } from "./http.js";
import { getConfig } from "./config.js";

/** @typedef {import('./types.js').Env} Env */

// The R2 key prefix under the shared STORAGE bucket. Images are build artifacts
// uploaded out of band (wrangler/dashboard), never committed to git.
const IMG_PREFIX = "sandbox-images/";

/**
 * The public URL path an image id is served at.
 * @param {string} id
 * @returns {string}
 */
export function imagePath(id) {
  return `/sandbox/img/${id}.ext2`;
}

/**
 * Resolve the effective sandbox-image selection from site config: the selected
 * id must match a REGISTERED image row (an admin can't point the fleet at a
 * non-existent image), else it degrades to "" = the built-in default.
 * @param {import('./config.js').SiteConfig} cfg
 * @returns {{ id: string, url: string, prefetch: boolean }}
 */
export function resolveSelectedImage(cfg) {
  const sb = cfg && cfg.sandbox;
  const id = sb && typeof sb.image === "string" ? sb.image : "";
  const images = sb && Array.isArray(sb.images) ? sb.images : [];
  const known = !!id && images.some((im) => im && im.id === id);
  return {
    id: known ? id : "",
    url: known ? imagePath(id) : "",
    prefetch: known && !!(sb && sb.prefetch),
  };
}

/**
 * GET /api/sandbox-image — the effective image selection both tiers read before
 * booting the sandbox. Empty `url` ⇒ the client uses its built-in streamed
 * default (today's webvm.io CloudDevice), so this is inert until an operator
 * uploads AND selects an image. Browser-cacheable for a minute like /api/anim.
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handleSandboxImageConfig(env) {
  let sel = { id: "", url: "", prefetch: false };
  try {
    const cfg = await getConfig(env);
    sel = resolveSelectedImage(cfg);
  } catch {
    // Fail-soft: any config error → the built-in default (empty selection).
  }
  return jsonResponse(sel, 200, { "cache-control": "public, max-age=60" });
}

/**
 * Parse a single HTTP Range header into an R2 range option. Handles the two
 * forms CheerpX issues — `bytes=start-end` and the open-ended `bytes=start-` —
 * plus the suffix form `bytes=-N`. Returns null for absent/unsupported/
 * multi-range headers (the caller then serves the whole object). Never throws.
 * @param {string | null} header
 * @returns {{ offset?: number, length?: number, suffix?: number } | null}
 */
export function parseRange(header) {
  if (!header || typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // absent, malformed, or multi-range → whole object
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    // bytes=-N — the last N bytes.
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { suffix: n };
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return null;
  if (endStr === "") return { offset: start }; // bytes=start- (to end)
  const end = Number(endStr);
  if (!Number.isFinite(end) || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/**
 * GET /sandbox/img/<id>.ext2 — stream a self-hosted sandbox image from R2 with
 * Range support. Public + same-origin (no CORP needed under require-corp, though
 * we set it harmlessly). Immutable, content-addressed by id.
 * @param {Request} request
 * @param {Env} env
 * @param {string} id the image id (already extracted from the path, no .ext2)
 * @returns {Promise<Response>}
 */
export async function handleSandboxImage(request, env, id) {
  const bucket = /** @type {any} */ (env).STORAGE;
  if (!bucket) return new Response("storage not configured", { status: 503 });
  if (!/^[a-z0-9-]+$/.test(String(id || ""))) {
    return new Response("bad image id", { status: 400 });
  }
  const key = IMG_PREFIX + id + ".ext2";
  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader);
  /** @type {any} */
  let obj;
  try {
    // No `onlyIf` — a conditional match returns a body-less R2 object, and
    // CheerpX issues plain Range gets, not conditional ones. Keep it simple.
    obj = await bucket.get(key, range ? { range } : undefined);
  } catch {
    return new Response("read failed", { status: 502 });
  }
  if (!obj) return new Response("image not found", { status: 404 });

  const headers = new Headers();
  if (typeof obj.writeHttpMetadata === "function") obj.writeHttpMetadata(headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  // Content-addressed by id + never mutated in place ⇒ safe to cache hard.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  // Same-origin under require-corp needs nothing, but this is harmless + explicit.
  headers.set("cross-origin-resource-policy", "same-origin");

  // A HEAD request (CheerpX may probe size) gets headers only.
  const size = Number(obj.size) || 0;
  if (request.method === "HEAD") {
    headers.set("content-length", String(size));
    return new Response(null, { status: 200, headers });
  }

  // Partial content when a range was requested AND R2 resolved one.
  if (range && obj.range) {
    const offset = Number(obj.range.offset) || 0;
    const length = Number(obj.range.length) || 0;
    if (length > 0 && size > 0) {
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${size}`);
      headers.set("content-length", String(length));
      return new Response(obj.body, { status: 206, headers });
    }
  }
  headers.set("content-length", String(size));
  return new Response(obj.body, { status: 200, headers });
}
