// @ts-check
// Published research replays — the /cure/<slug> surface (R2 `pub/{slug}`).
//
// The URL is the product: deepresearch.se/cure/<slug> reads as
// "deep research secure <slug>", so publications are frozen deep-research
// sessions on security-flavored subjects whose slug completes the phrase
// ("/cure/your-cloud-storage" → "…secure your cloud storage"). The
// publishing workflow — how a live chat session becomes a frozen
// publication here — is the **publish-research** skill; this module is
// just the storage and the two API faces:
//
//   GET  /api/pub          — the public publication index (newest first)
//   GET  /api/pub/:slug    — one frozen session as JSON (public; the
//                            /cure viewer page and free mode's
//                            "continue" seeding both read this)
//   PUT  /api/pub/:slug    — publish/replace (ADMIN only — routed behind
//                            the identity gate in src/index.js)
//   DELETE /api/pub/:slug  — unpublish (admin only)
//
// A publication is deliberately just {title, description?, model?,
// createdAt, messages[]} — plain {role, content} text turns, the same
// shape free mode chats in — so "Continue with your own API keys" is a
// verbatim handoff: the /cure viewer links to /?continue=<slug> and the
// free page seeds a conversation from these very messages.

import { jsonResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

export const PUB_MAX_BYTES = 2 * 1024 * 1024; // a frozen session is text
const MAX_MESSAGES = 200;

// Slugs are URL words completing the "…se/cure/<slug>" phrase: lowercase,
// digits, hyphens. No dots — so a slug can never collide with the viewer
// page's own asset files under /cure/.
/** @param {unknown} s */
export const pubSlugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);

/** @param {string} slug */
const pubKey = (slug) => `pub/${slug}`;

/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

/**
 * Structural validation + normalization of a publication body.
 * @param {any} body
 * @returns {{ error: string } | { pub: object }}
 */
export function validatePublication(body) {
  if (!body || typeof body !== "object") return { error: "Expected a JSON body." };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return { error: "A publication needs a title." };
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) {
    return { error: `messages must be 1-${MAX_MESSAGES} turns.` };
  }
  const messages = [];
  for (const m of body.messages) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m?.content !== "string" || !m.content.trim()) {
      return { error: "Each message needs role user|assistant and non-empty string content." };
    }
    messages.push({ role: m.role, content: m.content });
  }
  return {
    pub: {
      title,
      description: typeof body.description === "string" ? body.description.trim().slice(0, 500) : "",
      model: typeof body.model === "string" ? body.model.slice(0, 100) : "",
      createdAt: Number(body.createdAt) || Date.now(),
      messages,
    },
  };
}

// ---- public reads (routed BEFORE the identity gate) ---------------------------

/**
 * GET /api/pub and GET /api/pub/:slug — the public face.
 * @param {Env} env
 * @param {?string} slug
 * @returns {Promise<Response>}
 */
export async function handlePubGet(env, slug) {
  if (!env.STORAGE) return jsonResponse({ error: "Publications are not configured on this server." }, 503);
  if (slug === null) {
    const out = [];
    let cursor;
    do {
      const page = await bucket(env).list({ prefix: "pub/", cursor, include: ["customMetadata"] });
      for (const o of page.objects) {
        out.push({
          slug: o.key.slice(4),
          title: o.customMetadata?.title || o.key.slice(4),
          description: o.customMetadata?.description || "",
          createdAt: Number(o.customMetadata?.createdAt) || 0,
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    out.sort((a, b) => b.createdAt - a.createdAt);
    return jsonResponse({ publications: out });
  }
  if (!pubSlugOk(slug)) return jsonResponse({ error: "Invalid slug." }, 400);
  const obj = await bucket(env).get(pubKey(slug));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

// ---- admin writes (routed behind the identity gate + admin check) ---------------

/**
 * PUT/DELETE /api/pub/:slug. The caller (src/index.js) has already
 * verified identity.role === "admin".
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {string} slug
 * @returns {Promise<Response>}
 */
export async function handlePubWrite(request, env, log, slug) {
  if (!env.STORAGE) return jsonResponse({ error: "Publications are not configured on this server." }, 503);
  if (!pubSlugOk(slug)) return jsonResponse({ error: "Invalid slug (lowercase letters, digits, hyphens)." }, 400);
  if (request.method === "DELETE") {
    await bucket(env).delete(pubKey(slug));
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PUT") return jsonResponse({ error: "Not found." }, 404);
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const checked = validatePublication(body);
  if ("error" in checked) return jsonResponse({ error: checked.error }, 400);
  const json = JSON.stringify(checked.pub);
  if (json.length > PUB_MAX_BYTES) return jsonResponse({ error: "Publication too large." }, 413);
  await bucket(env).put(pubKey(slug), json, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      title: /** @type {any} */ (checked.pub).title.slice(0, 200),
      description: /** @type {any} */ (checked.pub).description.slice(0, 200),
      createdAt: String(/** @type {any} */ (checked.pub).createdAt),
    },
  });
  log.info("pub.published", { slug, bytes: json.length });
  return jsonResponse({ ok: true, slug, url: "/cure/" + slug });
}
