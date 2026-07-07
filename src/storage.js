// Opt-in server-side storage (R2 binding `STORAGE`) for the per-user
// `server_history` knob (src/settings.js). Three key families, all
// namespaced per user id:
//
//   convos/{uid}/{convId} — one conversation record as JSON
//       {iv, ciphertext, updatedAt, createdAt}. The record is the SAME
//       encrypted blob the client stores in its own IndexedDB
//       (public/js/history-store.js): AES-256-GCM ciphertext under the
//       per-user key from /api/history-key. The server stores it, lists
//       it, serves it back — it never holds the key material to read it
//       (only the secret a live server could re-derive it from; see
//       src/history-key.js's threat model). Titles included: they live
//       inside the ciphertext here exactly as they do client-side.
//   files/{uid}/{fileId} — an attached file's ORIGINAL bytes, as-is
//       (name/type in customMetadata). Not encrypted — disclosed in the
//       settings UI; the server needs readable bytes to serve them back
//       and (for documents) to hold the text the RAG index points into.
//   rag/{uid}/{docId} — the exportable RAG index copy (src/rag.js writes
//       these; listed here only so the full-wipe below covers them).
//
// R2 over D1 for the blobs (the "which Cloudflare storage" judgement
// call): conversation records with inline images run to several MB —
// past D1's 2 MB row ceiling — and original files up to the client's
// 25 MB cap; R2 has no meaningful object-size constraint here, is cheap,
// and list-by-prefix covers the only query pattern this needs (D1 gains
// no schema — just the settings_json column). Vectors go to Vectorize,
// not R2 (src/rag.js), because similarity search inside the Worker would
// burn CPU-time budget the pipeline already competes for.
//
// Write access (PUT) requires the knob to be ON. Read + delete stay
// allowed while it's OFF — that is exactly the drain path: flipping the
// knob off makes the client pull everything down and then delete the
// server-side copies (public/js/sync.js).

import { jsonResponse } from "./http.js";
import { serverHistoryEnabled, storageAvailability } from "./settings.js";
import { wipeRagForUser } from "./rag.js";

const CONVO_MAX_BYTES = 8 * 1024 * 1024; // encrypted record incl. inline images
const FILE_MAX_BYTES = 30 * 1024 * 1024; // client caps raw files at 25 MB
const MAX_OBJECTS_PER_USER = 1000; // per key family — sanity backstop, not a product limit

// Conversation/file ids are client-generated UUIDs; anything else is
// rejected before it can become a key path segment.
const idOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);

const convoKey = (uid, id) => `convos/${uid}/${id}`;
const fileKey = (uid, id) => `files/${uid}/${id}`;

// Router for /api/convos*, /api/files*, DELETE /api/storage — called from
// src/index.js once the identity is resolved.
export async function handleStorage(request, env, url, log, identity) {
  const available = storageAvailability(env, identity);
  if (!available.storage) {
    return jsonResponse({ error: "Cloud storage is not configured on this server." }, 503);
  }
  const uid = identity.user.id;
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", family, id?]
  const family = parts[1];
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;

  if (family === "storage" && method === "DELETE" && !id) {
    return wipeAll(env, log, identity, uid);
  }
  if (id !== null && !idOk(id)) return jsonResponse({ error: "Invalid id." }, 400);

  if (family === "convos") {
    if (!id && method === "GET") return listConvos(env, uid);
    if (id && method === "GET") return getConvo(env, uid, id);
    if (id && method === "PUT") return putConvo(request, env, log, identity, uid, id);
    if (id && method === "DELETE") return deleteObject(env, convoKey(uid, id));
  }
  if (family === "files") {
    if (!id && method === "GET") return listFiles(env, uid);
    if (id && method === "GET") return getFile(env, uid, id);
    if (id && method === "PUT") return putFile(request, env, log, identity, uid, id);
    if (id && method === "DELETE") return deleteObject(env, fileKey(uid, id));
  }
  return jsonResponse({ error: "Not found." }, 404);
}

// Full list under a prefix (R2 pages at 1000 — loop the cursor so a long
// history doesn't silently truncate).
async function listAll(env, prefix, include) {
  const out = [];
  let cursor;
  do {
    const page = await env.STORAGE.list({ prefix, cursor, include });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function countUnder(env, prefix) {
  return (await listAll(env, prefix)).length;
}

// ---- conversations ---------------------------------------------------------

async function listConvos(env, uid) {
  const objects = await listAll(env, `convos/${uid}/`, ["customMetadata"]);
  const items = objects.map((o) => ({
    id: o.key.split("/").pop(),
    updatedAt: Number(o.customMetadata?.updatedAt) || o.uploaded?.getTime?.() || 0,
    size: o.size,
  }));
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return jsonResponse({ conversations: items });
}

async function getConvo(env, uid, id) {
  const obj = await env.STORAGE.get(convoKey(uid, id));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function putConvo(request, env, log, identity, uid, id) {
  if (!serverHistoryEnabled(env, identity)) {
    return jsonResponse({ error: "Cloud history is switched off for this account." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  if (typeof body?.iv !== "string" || typeof body?.ciphertext !== "string") {
    return jsonResponse({ error: "Expected {iv, ciphertext, updatedAt}." }, 400);
  }
  const record = {
    iv: body.iv.slice(0, 64),
    ciphertext: body.ciphertext,
    updatedAt: Number(body.updatedAt) || Date.now(),
    createdAt: Number(body.createdAt) || undefined,
  };
  const json = JSON.stringify(record);
  if (json.length > CONVO_MAX_BYTES) {
    return jsonResponse({ error: "Conversation record too large." }, 413);
  }
  const key = convoKey(uid, id);
  if (!(await env.STORAGE.head(key)) && (await countUnder(env, `convos/${uid}/`)) >= MAX_OBJECTS_PER_USER) {
    return jsonResponse({ error: "Cloud conversation limit reached." }, 409);
  }
  await env.STORAGE.put(key, json, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { updatedAt: String(record.updatedAt) },
  });
  log.debug("storage.convo_put", { user_id: identity.id, size: json.length });
  return jsonResponse({ ok: true, id, updatedAt: record.updatedAt });
}

// ---- files ------------------------------------------------------------------

async function listFiles(env, uid) {
  const objects = await listAll(env, `files/${uid}/`, ["customMetadata"]);
  const items = objects.map((o) => ({
    id: o.key.split("/").pop(),
    name: o.customMetadata?.name || "",
    type: o.customMetadata?.type || "application/octet-stream",
    enc: o.customMetadata?.enc === "1",
    size: o.size,
  }));
  return jsonResponse({ files: items });
}

async function getFile(env, uid, id) {
  const obj = await env.STORAGE.get(fileKey(uid, id));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  const enc = obj.customMetadata?.enc === "1";
  return new Response(obj.body, {
    headers: {
      // Encrypted blobs are opaque bytes — advertising the original MIME
      // type on them would just confuse anything that tries to render one.
      "content-type": enc ? "application/octet-stream" : obj.customMetadata?.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(obj.customMetadata?.name || id),
      "x-file-type": obj.customMetadata?.type || "application/octet-stream",
      "x-file-enc": enc ? "1" : "0",
    },
  });
}

// PUT /api/files/:id — the file's STORAGE-FORM bytes in the body: AES-GCM
// ciphertext under the client-held history key for everything except
// RAG-indexed documents (x-file-enc says which — the server just stores
// the flag; it can't tell the difference and never needs to). The original
// filename and MIME type ride in headers so the body stays a clean byte
// stream.
async function putFile(request, env, log, identity, uid, id) {
  if (!serverHistoryEnabled(env, identity)) {
    return jsonResponse({ error: "Cloud history is switched off for this account." }, 403);
  }
  const declared = Number(request.headers.get("content-length")) || 0;
  if (declared > FILE_MAX_BYTES) return jsonResponse({ error: "File too large." }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > FILE_MAX_BYTES) return jsonResponse({ error: "File too large." }, 413);
  const name = decodeURIComponent(request.headers.get("x-file-name") || "").slice(0, 200) || id;
  const type = (request.headers.get("x-file-type") || "application/octet-stream").slice(0, 100);
  const enc = request.headers.get("x-file-enc") === "1" ? "1" : "0";
  const key = fileKey(uid, id);
  if (!(await env.STORAGE.head(key)) && (await countUnder(env, `files/${uid}/`)) >= MAX_OBJECTS_PER_USER) {
    return jsonResponse({ error: "Cloud file limit reached." }, 409);
  }
  await env.STORAGE.put(key, bytes, { customMetadata: { name, type, enc } });
  log.debug("storage.file_put", { user_id: identity.id, size: bytes.byteLength, enc: enc === "1" });
  return jsonResponse({ ok: true, id, size: bytes.byteLength });
}

// ---- shared -----------------------------------------------------------------

async function deleteObject(env, key) {
  await env.STORAGE.delete(key);
  return new Response(null, { status: 204 });
}

// DELETE /api/storage — the drain path's final step: after sync-to-client
// completes, everything this user ever stored server-side (conversations,
// files, RAG exports AND their Vectorize vectors) is removed in one call.
async function wipeAll(env, log, identity, uid) {
  const prefixes = [`convos/${uid}/`, `files/${uid}/`];
  let deleted = 0;
  for (const prefix of prefixes) {
    const objects = await listAll(env, prefix);
    for (let i = 0; i < objects.length; i += 900) {
      const keys = objects.slice(i, i + 900).map((o) => o.key);
      if (keys.length) await env.STORAGE.delete(keys);
      deleted += keys.length;
    }
  }
  deleted += await wipeRagForUser(env, uid);
  log.info("storage.wiped", { user_id: identity.id, objects: deleted });
  return jsonResponse({ ok: true, deleted });
}
