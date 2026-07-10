// @ts-check
// Free mode (/free, /free/project-<hash>): a no-account chat surface where
// the user brings EVERYTHING — their own provider API keys, their own
// storage encryption, one master secret behind it all — and the operator
// contributes only the transport. Built on the project-vault primitives
// (src/vault.js / public/js/vault.js).
//
// The trust model, which every handler below must preserve:
//
//   - ONE user-held master secret (the vault's DR1-… format; saved in the
//     user's password manager — the /free page is a real form so 1Password
//     and Apple Passwords capture it). The client derives EVERYTHING from
//     it via HKDF with independent info strings (public/js/free-core.js):
//     the public project reference (the <hash> in /free/project-<hash> —
//     a bookmark label, NOT a capability), the storage blob id + its
//     AES-256-GCM key, the key-bundle id, and the "unlock" key.
//   - The PROJECT BLOB (conversations, settings) rests in R2 as pure
//     client-side ciphertext — the server never holds its key in any form.
//   - The PROVIDER KEY BUNDLE (the user's own Berget/Anthropic/OpenAI API
//     keys) rests in R2 encrypted CLIENT-side under the derived unlock
//     key. Each chat/models request carries that unlock key; the server
//     decrypts the bundle IN MEMORY, uses the keys for the one upstream
//     call, and drops them — nothing key-derived is ever written or
//     logged. Operator provider credentials are NEVER used here:
//     buildFreeEnv constructs the provider env from the user bundle alone.
//   - ABSOLUTELY NO MESSAGE-CONTENT LOGGING: free chats never touch the
//     interaction log (src/chatlog.js is not imported), and the structured
//     request logs carry counts and a model id only — never message text,
//     never key material. There is no quota/usage recording either — the
//     spend is on the user's own provider account.
//
// Storage is capability-addressed, not user-namespaced (there is no user):
// every id is an unguessable 160-bit HKDF output, and knowing an id is the
// read/write capability for that object — exactly the vault's model, minus
// the account fence. Objects live under R2 `free/blob/{id}` and
// `free/keys/{id}` and are excluded from every account wipe by
// construction (different prefix, no uid).
//
// Free chat is a DIRECT streamed completion on the user's chosen model —
// deliberately not the research pipeline: the pipeline's JSON phases and
// web search run on operator keys (Berget/Exa), which free mode must never
// touch.

import { consumeChatStream } from "./berget.js";
import { anthropicModels, isAnthropicModel } from "./anthropic.js";
import { isOpenAiModel, openaiModels } from "./openai.js";
import { listModels as bergetListModels } from "./berget.js";
import { chatCompletion } from "./providers.js";
import { jsonResponse, sseResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

export const FREE_BLOB_MAX_BYTES = 25 * 1024 * 1024; // the encrypted project state
export const FREE_KEYS_MAX_BYTES = 8 * 1024; // the encrypted key bundle (a few short strings)
export const FREE_BLOB_MIN_BYTES = 12 + 16 + 1; // IV + GCM tag + at least one byte
const MAX_MESSAGES = 80;
const MAX_TOTAL_CHARS = 300_000;
// A stalled provider stream must become a catchable error, not a hung
// isolate (the same lesson as the pipeline's round-2 finding).
const STREAM_IDLE_MS = 120_000;

// Same shape as vault ids: long HKDF-derived Crockford/base64url strings.
/** @param {unknown} s */
export const freeIdOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(s);

/** @param {string} kind @param {string} id */
const freeKey = (kind, id) => `free/${kind}/${id}`;

/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

// The provider env for one free request: the USER's keys and nothing else.
// Deliberately not a spread of the real env — operator credentials must be
// unreachable from free mode even by accident. The *_URL overrides ride
// along solely so unit tests can point providers at mocks (they are unset
// in production).
/**
 * @param {Env} env
 * @param {{berget?: string, anthropic?: string, openai?: string}} keys
 * @returns {Env}
 */
export function buildFreeEnv(env, keys) {
  return /** @type {Env} */ ({
    BERGET_API_TOKEN: keys.berget || "",
    ANTHROPIC_API_KEY: keys.anthropic || "",
    OPENAI_API_KEY: keys.openai || "",
    BERGET_URL: env.BERGET_URL,
    ANTHROPIC_URL: env.ANTHROPIC_URL,
    OPENAI_URL: env.OPENAI_URL,
    LOG_LEVEL: env.LOG_LEVEL,
  });
}

// Which of the user's keys the requested model needs (the providers.js
// namespace rule): claude-* → Anthropic, bare gpt-* → OpenAI, everything
// else → Berget.
/**
 * @param {string} model
 * @param {{berget?: string, anthropic?: string, openai?: string}} keys
 * @returns {?string} an error message, or null when the key is present
 */
export function missingKeyFor(model, keys) {
  if (isAnthropicModel(model)) return keys.anthropic ? null : "No Anthropic API key is stored for this project.";
  if (isOpenAiModel(model)) return keys.openai ? null : "No OpenAI API key is stored for this project.";
  return keys.berget ? null : "No Berget API key is stored for this project.";
}

// Minimal message validation: plain text turns only (free mode is a direct
// chat — attachments/vision belong to the signed-in app).
/**
 * @param {unknown} messages
 * @returns {?{role: "user" | "assistant" | "system", content: string}[]} null when unusable
 */
export function validateFreeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return null;
  let total = 0;
  /** @type {{role: "user" | "assistant" | "system", content: string}[]} */
  const out = [];
  for (const m of messages) {
    const role = /** @type {any} */ (m)?.role;
    const content = /** @type {any} */ (m)?.content;
    if (role !== "user" && role !== "assistant" && role !== "system") return null;
    if (typeof content !== "string" || !content) return null;
    total += content.length;
    out.push({ role, content });
  }
  if (total > MAX_TOTAL_CHARS) return null;
  return out;
}

// Decrypts the stored key bundle with the caller-supplied unlock key —
// AES-256-GCM, the bundle's 12-byte IV and ciphertext base64 in JSON. The
// plaintext exists only in this function's scope and the caller's local
// variable; it is never logged, stored, or echoed.
/**
 * @param {Env} env
 * @param {string} keysId
 * @param {string} unlockB64
 * @returns {Promise<{berget?: string, anthropic?: string, openai?: string} | null>}
 */
async function openKeyBundle(env, keysId, unlockB64) {
  const obj = await bucket(env).get(freeKey("keys", keysId));
  if (!obj) return null;
  /** @type {any} */
  let stored;
  try {
    stored = JSON.parse(await obj.text());
  } catch {
    return null;
  }
  if (typeof stored?.iv !== "string" || typeof stored?.ciphertext !== "string") return null;
  try {
    const keyBytes = b64ToBytes(unlockB64);
    if (keyBytes.length !== 32) return null;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(stored.iv) },
      key,
      b64ToBytes(stored.ciphertext),
    );
    const keys = JSON.parse(new TextDecoder().decode(plain));
    if (!keys || typeof keys !== "object") return null;
    return {
      berget: typeof keys.berget === "string" ? keys.berget : undefined,
      anthropic: typeof keys.anthropic === "string" ? keys.anthropic : undefined,
      openai: typeof keys.openai === "string" ? keys.openai : undefined,
    };
  } catch {
    return null; // wrong unlock key or tampered bundle — GCM authenticates
  }
}

/** @param {string} b64 @returns {Uint8Array} */
function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Router for /api/free/* — called from src/index.js BEFORE the identity
// gate (free mode has no accounts).
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleFreeApi(request, env, url, log) {
  if (!env.STORAGE) {
    return jsonResponse({ error: "Free mode is not configured on this server (storage missing)." }, 503);
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "free", kind, id?]
  const kind = parts[2] || "";
  const id = parts[3] ? decodeURIComponent(parts[3]) : null;

  if (kind === "blob" && id) return handleBlob(request, env, id);
  if (kind === "keys" && id) return handleKeys(request, env, id);
  if (kind === "models" && request.method === "POST" && !id) return handleModels(request, env);
  if (kind === "chat" && request.method === "POST" && !id) return handleChat(request, env, log);
  return jsonResponse({ error: "Not found." }, 404);
}

// ---- the encrypted project blob (client-side ciphertext, opaque here) --------

/** @param {Request} request @param {Env} env @param {string} id */
async function handleBlob(request, env, id) {
  if (!freeIdOk(id)) return jsonResponse({ error: "Invalid id." }, 400);
  const key = freeKey("blob", id);
  if (request.method === "GET") {
    const obj = await bucket(env).get(key);
    if (!obj) return jsonResponse({ error: "Not found." }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "x-free-updated": obj.customMetadata?.updatedAt || "",
      },
    });
  }
  if (request.method === "PUT") {
    const declared = Number(request.headers.get("content-length")) || 0;
    if (declared > FREE_BLOB_MAX_BYTES) return jsonResponse({ error: "Project too large." }, 413);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > FREE_BLOB_MAX_BYTES) return jsonResponse({ error: "Project too large." }, 413);
    if (bytes.byteLength < FREE_BLOB_MIN_BYTES) {
      return jsonResponse({ error: "Not a valid encrypted blob." }, 400);
    }
    const updatedAt = Date.now();
    await bucket(env).put(key, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { updatedAt: String(updatedAt) },
    });
    return jsonResponse({ ok: true, updatedAt });
  }
  if (request.method === "DELETE") {
    await bucket(env).delete(key);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: "Not found." }, 404);
}

// ---- the encrypted provider-key bundle ----------------------------------------

/** @param {Request} request @param {Env} env @param {string} id */
async function handleKeys(request, env, id) {
  if (!freeIdOk(id)) return jsonResponse({ error: "Invalid id." }, 400);
  const key = freeKey("keys", id);
  if (request.method === "GET") {
    const obj = await bucket(env).get(key);
    if (!obj) return jsonResponse({ error: "Not found." }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  if (request.method === "PUT") {
    /** @type {any} */
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }
    if (typeof body?.iv !== "string" || typeof body?.ciphertext !== "string") {
      return jsonResponse({ error: "Expected {iv, ciphertext} (client-encrypted)." }, 400);
    }
    const json = JSON.stringify({ iv: body.iv.slice(0, 64), ciphertext: body.ciphertext });
    if (json.length > FREE_KEYS_MAX_BYTES) return jsonResponse({ error: "Key bundle too large." }, 413);
    await bucket(env).put(key, json, { httpMetadata: { contentType: "application/json" } });
    return jsonResponse({ ok: true });
  }
  if (request.method === "DELETE") {
    await bucket(env).delete(key);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: "Not found." }, 404);
}

// ---- the model catalog, from the user's own keys -------------------------------

/** @param {Request} request @param {Env} env */
async function handleModels(request, env) {
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  if (!freeIdOk(body?.keysId) || typeof body?.unlock !== "string") {
    return jsonResponse({ error: "Expected {keysId, unlock}." }, 400);
  }
  const keys = await openKeyBundle(env, body.keysId, body.unlock);
  if (!keys) return jsonResponse({ error: "No key bundle found for that secret." }, 404);
  const freeEnv = buildFreeEnv(env, keys);
  // Assembled per key present — Berget's live catalog only when the user
  // supplied a Berget key (never a fetch on the operator's account), the
  // static key-gated catalogs for the rest.
  /** @type {import('./types.js').ModelCatalogEntry[]} */
  let models = [];
  if (keys.berget) {
    try {
      models = models.concat((await bergetListModels(freeEnv)) || []);
    } catch {
      // the user's Berget key may be wrong/expired — the others still list
    }
  }
  models = models.concat(anthropicModels(freeEnv), openaiModels(freeEnv));
  return jsonResponse({ models });
}

// ---- free chat: user keys only, streamed, never logged --------------------------

/** @param {Request} request @param {Env} env @param {Logger} log */
async function handleChat(request, env, log) {
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  if (!freeIdOk(body?.keysId) || typeof body?.unlock !== "string") {
    return jsonResponse({ error: "Expected {keysId, unlock, model, messages}." }, 400);
  }
  const model = typeof body.model === "string" && body.model ? body.model : null;
  if (!model) return jsonResponse({ error: "Pick a model first." }, 400);
  const messages = validateFreeMessages(body.messages);
  if (!messages) return jsonResponse({ error: "Messages must be non-empty plain-text turns." }, 400);

  const keys = await openKeyBundle(env, body.keysId, body.unlock);
  if (!keys) return jsonResponse({ error: "No key bundle found for that secret." }, 404);
  const missing = missingKeyFor(model, keys);
  if (missing) return jsonResponse({ error: missing }, 400);

  // Metadata only — never message text, never key material.
  log.info("free.chat", { model, message_count: messages.length });

  const freeEnv = buildFreeEnv(env, keys);
  /** @type {Response} */
  let upstream;
  try {
    upstream = await chatCompletion(freeEnv, messages, { model });
  } catch (err) {
    log.warn("free.chat_connect_failed", { model, error: /** @type {any} */ (err)?.message });
    return jsonResponse({ error: "Could not reach the model provider." }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    // The provider's error body may quote the request — don't echo it.
    log.warn("free.chat_rejected", { model, status: upstream.status });
    await upstream.body?.cancel?.().catch(() => {});
    const hint = upstream.status === 401 || upstream.status === 403 ? " Check the API key you stored." : "";
    return jsonResponse({ error: `The provider rejected the request (${upstream.status}).${hint}` }, 502);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      /** @param {object} obj */
      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // client gone — keep consuming quietly; there is no recovery cache here
        }
      };
      let chars = 0;
      try {
        const result = await consumeChatStream(
          /** @type {ReadableStream<Uint8Array>} */ (upstream.body),
          (chunk) => {
            chars += chunk.length;
            send({ delta: chunk });
          },
          { idleMs: STREAM_IDLE_MS },
        );
        send({ status: { type: "done", finish_reason: result.finishReason || null, usage: result.usage || null } });
        log.info("free.chat_complete", { model, chars });
      } catch (err) {
        log.warn("free.chat_stream_failed", { model, chars, error: /** @type {any} */ (err)?.message });
        send({ error: "The model stream failed: " + (/** @type {any} */ (err)?.message || "unknown error") });
      }
      try {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // already torn down
      }
    },
  });
  return sseResponse(stream);
}
