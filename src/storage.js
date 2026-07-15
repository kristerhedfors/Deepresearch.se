// @ts-check
// Opt-in server-side storage (R2 binding `STORAGE`) for the per-user
// `server_history` knob (src/settings.js). Three key families, all
// namespaced per user id:
//
//   projects/{uid}/{projectId} — one PROJECT record as JSON, same encrypted
//       {iv, ciphertext} shape as a conversation: the project's name, file
//       inventory (incl. extracted image metadata), notes, and per-project
//       cloud knob all live inside the ciphertext. Which files/convos
//       belong to a project is therefore invisible server-side — the
//       per-project drain is client-driven (it knows the ids and deletes
//       them individually through the endpoints below).
//   convos/{uid}/{convId} — one conversation record as JSON. Two stored
//       forms, chosen by the client the same way it chooses a file's
//       x-file-enc: {iv, ciphertext, updatedAt, createdAt} — the SAME
//       encrypted blob the client stores in its own IndexedDB
//       (public/js/history-store.js): AES-256-GCM ciphertext under the
//       per-user key from /api/history-key. The server stores it, lists
//       it, serves it back — it never holds the key material to read it
//       (only the secret a live server could re-derive it from; see
//       src/history-key.js's threat model). Titles included: they live
//       inside the ciphertext here exactly as they do client-side. OR
//       {data, updatedAt, createdAt} — a READABLE record: project chats,
//       which are RAG-indexed for cross-chat retrieval and therefore rest
//       readable like every other indexed material (the index would hold
//       their text in the clear anyway — public/js/chat-rag.js).
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
import { idOk, wipeRagForUser } from "./rag.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

const CONVO_MAX_BYTES = 8 * 1024 * 1024; // encrypted record incl. inline images
const FILE_MAX_BYTES = 30 * 1024 * 1024; // client caps raw files at 25 MB
const MAX_OBJECTS_PER_USER = 1000; // per key family — sanity backstop, not a product limit

// Conversation/file ids are client-generated UUIDs; anything else is
// rejected before it can become a key path segment (`idOk`, shared with
// src/rag.js — imported above).

// Two families share the encrypted-record shape and handlers below:
// "convos" (one conversation each) and "projects" (one project's metadata
// record each — name, file inventory, notes, per-project knob — all inside
// the ciphertext; the server can't tell them apart and doesn't need to).
/** @type {Record<string, string>} family -> the list response's key */
const ENC_FAMILIES = { convos: "conversations", projects: "projects" };
/** @param {string} family @param {number | string} uid @param {string} id */
const encKey = (family, uid, id) => `${family}/${uid}/${id}`;
/** @param {number | string} uid @param {string} id */
const fileKey = (uid, id) => `files/${uid}/${id}`;

// The storageAvailability gate at the top of handleStorage guarantees both
// the binding and the user row exist on every path below it.
/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

// Router for /api/convos*, /api/projects*, /api/files*, DELETE /api/storage
// — called from src/index.js once the identity is resolved.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleStorage(request, env, url, log, identity) {
  const available = storageAvailability(env, identity);
  if (!available.storage || !identity.user) {
    return jsonResponse({ error: "Cloud storage is not configured on this server." }, 503);
  }
  const uid = identity.user.id;
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", family, id?]
  const family = parts[1] || "";
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;

  if (family === "storage" && method === "DELETE" && !id) {
    return wipeAll(env, log, identity, uid);
  }
  if (id !== null && !idOk(id)) return jsonResponse({ error: "Invalid id." }, 400);

  if (ENC_FAMILIES[family]) {
    if (!id && method === "GET") return listEncRecords(env, uid, family);
    if (id && method === "GET") return getEncRecord(env, uid, family, id);
    if (id && method === "PUT") return putEncRecord(request, env, log, identity, uid, family, id);
    if (id && method === "DELETE") return deleteObject(env, encKey(family, uid, id));
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
/**
 * @param {Env} env
 * @param {string} prefix
 * @param {R2ListOptions["include"]} [include]
 * @returns {Promise<R2Object[]>}
 */
async function listAll(env, prefix, include) {
  const out = [];
  let cursor;
  do {
    const page = await bucket(env).list({ prefix, cursor, include });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** @param {Env} env @param {string} prefix */
async function countUnder(env, prefix) {
  return (await listAll(env, prefix)).length;
}

// ---- encrypted records (conversations + project records) -------------------

/** @param {Env} env @param {number | string} uid @param {string} family */
async function listEncRecords(env, uid, family) {
  const objects = await listAll(env, `${family}/${uid}/`, ["customMetadata"]);
  const items = objects.map((o) => ({
    id: o.key.split("/").pop(),
    updatedAt: Number(o.customMetadata?.updatedAt) || o.uploaded?.getTime?.() || 0,
    size: o.size,
  }));
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return jsonResponse({ [ENC_FAMILIES[family]]: items });
}

/** @param {Env} env @param {number | string} uid @param {string} family @param {string} id */
async function getEncRecord(env, uid, family, id) {
  const obj = await bucket(env).get(encKey(family, uid, id));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {string} family
 * @param {string} id
 */
async function putEncRecord(request, env, log, identity, uid, family, id) {
  if (!serverHistoryEnabled(env, identity)) {
    return jsonResponse({ error: "Cloud history is switched off for this account." }, 403);
  }
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  // Either stored form (see the header): the encrypted {iv, ciphertext}
  // blob, or a readable {data} record (project chats — RAG-indexed, so
  // they rest readable). The client decides per record; the server just
  // stores what it's given, same as x-file-enc on files.
  const isPlain = body?.data && typeof body.data === "object" && !Array.isArray(body.data);
  if (!isPlain && (typeof body?.iv !== "string" || typeof body?.ciphertext !== "string")) {
    return jsonResponse({ error: "Expected {iv, ciphertext, updatedAt} or {data, updatedAt}." }, 400);
  }
  const record = isPlain
    ? {
        data: body.data,
        updatedAt: Number(body.updatedAt) || Date.now(),
        createdAt: Number(body.createdAt) || undefined,
      }
    : {
        iv: body.iv.slice(0, 64),
        ciphertext: body.ciphertext,
        updatedAt: Number(body.updatedAt) || Date.now(),
        createdAt: Number(body.createdAt) || undefined,
      };
  const json = JSON.stringify(record);
  if (json.length > CONVO_MAX_BYTES) {
    return jsonResponse({ error: "Record too large." }, 413);
  }
  const key = encKey(family, uid, id);
  if (!(await bucket(env).head(key)) && (await countUnder(env, `${family}/${uid}/`)) >= MAX_OBJECTS_PER_USER) {
    return jsonResponse({ error: "Cloud record limit reached." }, 409);
  }
  await bucket(env).put(key, json, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { updatedAt: String(record.updatedAt) },
  });
  log.debug("storage.record_put", { user_id: identity.id, family, size: json.length });
  return jsonResponse({ ok: true, id, updatedAt: record.updatedAt });
}

// ---- files ------------------------------------------------------------------

/** @param {Env} env @param {number | string} uid */
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

/** @param {Env} env @param {number | string} uid @param {string} id */
async function getFile(env, uid, id) {
  const obj = await bucket(env).get(fileKey(uid, id));
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
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {string} id
 */
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
  if (!(await bucket(env).head(key)) && (await countUnder(env, `files/${uid}/`)) >= MAX_OBJECTS_PER_USER) {
    return jsonResponse({ error: "Cloud file limit reached." }, 409);
  }
  await bucket(env).put(key, bytes, { customMetadata: { name, type, enc } });
  log.debug("storage.file_put", { user_id: identity.id, size: bytes.byteLength, enc: enc === "1" });
  return jsonResponse({ ok: true, id, size: bytes.byteLength });
}

// ---- shared -----------------------------------------------------------------

/** @param {Env} env @param {string} key */
async function deleteObject(env, key) {
  await bucket(env).delete(key);
  return new Response(null, { status: 204 });
}

// DELETE /api/storage — the drain path's final step: after sync-to-client
// completes, everything this user ever stored server-side (conversations,
// files, RAG exports AND their Vectorize vectors) is removed in one call.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 */
async function wipeAll(env, log, identity, uid) {
  // vault/{uid}/ (src/vault.js) is deliberately NOT in this list: vault
  // objects are secret-encrypted archives stored by explicit user action —
  // often made precisely BECAUSE the knob is going off — so the knob-driven
  // drain must never destroy them.
  const prefixes = [`convos/${uid}/`, `projects/${uid}/`, `files/${uid}/`];
  let deleted = 0;
  for (const prefix of prefixes) {
    const objects = await listAll(env, prefix);
    for (let i = 0; i < objects.length; i += 900) {
      const keys = objects.slice(i, i + 900).map((o) => o.key);
      if (keys.length) await bucket(env).delete(keys);
      deleted += keys.length;
    }
  }
  deleted += await wipeRagForUser(env, uid);
  log.info("storage.wiped", { user_id: identity.id, objects: deleted });
  return jsonResponse({ ok: true, deleted });
}
