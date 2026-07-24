// @ts-check
// WORKSPACE KNOWLEDGE's pure core — the curation model behind "tap 👍 to pass
// a response along to the secure workspace" (docs/COMPUTE-SHARING.md §9b).
//
// A CONCLUSION is the unit of shared knowledge: one thumbed-up exchange,
// packaged as { context summary, query, reply } with the reply split into
// TEXT BLOCKS the curator steers individually:
//   plus    — the block is knowledge AND is tagged along as context wherever
//             the conclusion is used;
//   neutral — the block ships with the conclusion but is not context-tagged;
//   minus   — the block is REMOVED entirely: not shown, not included, gone
//             from every rendering and export.
// Every curation step goes through a pure reducer with full UNDO/REDO, so a
// mis-tap never loses work.
//
// TRANSPORT: conclusions leave the browser only SEALED. The envelope is the
// SAME ECIES sealed box DRCR/1 established (research-seal-core.js — ECDH
// P-256 · HKDF-SHA-256 · AES-256-GCM, WebCrypto-only, minimal-deps), with its
// own frozen kind and HKDF info string so a knowledge blob never opens as a
// crowd-research result and vice versa:
//   { v: 1, kind: "drskn-bundle", kid, epk, iv, ct }   (all base64url)
// The DEFAULT recipient is the site's IMPORT-AGENT key (src/knowledge.js
// serves the public half; the sealed envelope rides POST /api/knowledge and
// rests as ciphertext until the workspace owner imports it in the Se/rver
// panel). The SAME envelope, saved as a .drskn JSON file, is the
// downloadable-blob migration path — delivered out-of-band, imported by
// upload. One format, two routes.
//
// Pure core under public/ (the workspace-core.js convention): WebCrypto only,
// dependency-free, Node-testable unchanged; src/knowledge.js reaches it via
// its server façade.

import { b64urlDecode, b64urlEncode, sha256hex } from "./proxy-bundle.js";

export const CONCLUSION_KIND = "drc-conclusion";
export const CONCLUSION_V = 1;
export const KNOWLEDGE_KIND = "drskn-bundle";
export const KNOWLEDGE_V = 1;
/** The downloadable-blob filename extension (the migration path). */
export const KNOWLEDGE_FILE_EXT = ".drskn";

export const BLOCK_TAGS = ["plus", "neutral", "minus"];
const MAX_BLOCKS = 200;
const MAX_BLOCK_CHARS = 8_000;
const MAX_QUERY_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 2_000;

// ---- frozen crypto constants (CIPHER SUITE 1, research-seal-core.js) ----
const CURVE = "P-256";
const RAW_PUBKEY_LEN = 65; // uncompressed point: 0x04 || X(32) || Y(32)
const GCM_IV_BYTES = 12;
// FROZEN — distinct from DRCR's, so the two seals can never cross-open.
const HKDF_INFO = "deepresearch.se/drskn knowledge seal v1";

const te = new TextEncoder();
const td = new TextDecoder();

// ── conclusions ─────────────────────────────────────────────────────────────

/**
 * Split a reply into tag-able text blocks: fenced code blocks stay whole;
 * prose splits on blank lines. Deterministic, so the same reply always yields
 * the same block ids (b0, b1, …).
 * @param {string} text
 * @returns {{ id: string, text: string, tag: "neutral" }[]}
 */
export function splitBlocks(text) {
  const s = String(text == null ? "" : text);
  /** @type {string[]} */
  const parts = [];
  // Peel fenced code blocks out first so a blank line inside a fence never splits it.
  const fence = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = fence.exec(s))) {
    if (m.index > last) parts.push(...s.slice(last, m.index).split(/\n\s*\n/));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(...s.slice(last).split(/\n\s*\n/));
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKS)
    .map((p, i) => ({ id: "b" + i, text: p.slice(0, MAX_BLOCK_CHARS), tag: /** @type {"neutral"} */ ("neutral") }));
}

/**
 * A DETERMINISTIC compression of the conversation BEFORE a thumbed-up
 * exchange — the "summary of context" that travels with the query and reply.
 * No model call (this must work offline and cost nothing): the last few
 * turns, one line each, truncated. The curator can edit it before sending.
 * @param {{ role: string, content: string }[]} messages the turns PRECEDING the exchange
 * @param {{ maxTurns?: number, perTurnChars?: number }} [opts]
 * @returns {string}
 */
export function summarizeContext(messages, opts = {}) {
  const maxTurns = opts.maxTurns || 6;
  const perTurn = opts.perTurnChars || 160;
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim() && (m.role === "user" || m.role === "assistant"))
    .slice(-maxTurns);
  return turns
    .map((m) => {
      const text = m.content.replace(/\s+/g, " ").trim();
      return (m.role === "user" ? "Q: " : "A: ") + (text.length > perTurn ? text.slice(0, perTurn - 1) + "…" : text);
    })
    .join("\n")
    .slice(0, MAX_SUMMARY_CHARS);
}

/**
 * Build a conclusion from a thumbed-up exchange. The context summary is the
 * caller's compression of the conversation so far (the client builds it from
 * the preceding turns); it travels WITH the query and reply so the receiving
 * side sees what the answer was an answer to.
 * @param {{ query: string, reply: string, contextSummary?: string, model?: string, workspace?: string }} opts
 * @returns {any} a conclusion object (validateConclusion passes)
 */
export function buildConclusion(opts) {
  const o = opts || /** @type {any} */ ({});
  return {
    v: CONCLUSION_V,
    kind: CONCLUSION_KIND,
    id: crypto.randomUUID(),
    at: Date.now(),
    query: String(o.query == null ? "" : o.query).slice(0, MAX_QUERY_CHARS),
    summary: String(o.contextSummary == null ? "" : o.contextSummary).slice(0, MAX_SUMMARY_CHARS),
    model: o.model ? String(o.model).slice(0, 120) : undefined,
    workspace: o.workspace ? String(o.workspace).slice(0, 80) : undefined,
    blocks: splitBlocks(o.reply),
  };
}

/** @param {any} c @returns {boolean} */
export function validateConclusion(c) {
  if (!c || typeof c !== "object" || c.v !== CONCLUSION_V || c.kind !== CONCLUSION_KIND) return false;
  if (typeof c.id !== "string" || typeof c.query !== "string" || typeof c.summary !== "string") return false;
  if (!Array.isArray(c.blocks) || c.blocks.length > MAX_BLOCKS) return false;
  return c.blocks.every(
    (/** @type {any} */ b) =>
      b && typeof b === "object" && typeof b.id === "string" && typeof b.text === "string" && BLOCK_TAGS.includes(b.tag),
  );
}

// ── the curation reducer (plus / minus / undo / redo) ───────────────────────
//
// State shape: { conclusion, past: [], future: [] } — past/future hold
// block-tag snapshots (the only thing curation changes), so undo/redo is a
// tiny array of {id → tag} maps rather than deep conclusion copies.

/** @param {any} conclusion @returns {{ conclusion: any, past: Record<string,string>[], future: Record<string,string>[] }} */
export function curationState(conclusion) {
  return { conclusion, past: [], future: [] };
}

/** @param {any} conclusion @returns {Record<string, string>} */
function tagSnapshot(conclusion) {
  /** @type {Record<string, string>} */
  const snap = {};
  for (const b of conclusion.blocks) snap[b.id] = b.tag;
  return snap;
}

/** @param {any} conclusion @param {Record<string, string>} snap */
function applySnapshot(conclusion, snap) {
  for (const b of conclusion.blocks) if (snap[b.id]) b.tag = snap[b.id];
}

/**
 * The pure curation reducer. Actions:
 *   { type: "tag",  blockId, tag: "plus"|"neutral"|"minus" } — set a block's tag
 *   { type: "plus", blockId } / { type: "minus", blockId }   — shorthands that
 *       TOGGLE: tapping plus on an already-plus block returns it to neutral,
 *       same for minus (a second tap undoes the first, matching the UI).
 *   { type: "undo" } / { type: "redo" }
 * Mutates and returns the state (the conclusion object is shared with the UI).
 * Unknown actions / unknown block ids are no-ops — never throws.
 * @param {{ conclusion: any, past: Record<string,string>[], future: Record<string,string>[] }} state
 * @param {{ type: string, blockId?: string, tag?: string }} action
 */
export function curate(state, action) {
  const a = action || /** @type {any} */ ({});
  const c = state.conclusion;
  if (a.type === "undo") {
    const snap = state.past.pop();
    if (snap) {
      state.future.push(tagSnapshot(c));
      applySnapshot(c, snap);
    }
    return state;
  }
  if (a.type === "redo") {
    const snap = state.future.pop();
    if (snap) {
      state.past.push(tagSnapshot(c));
      applySnapshot(c, snap);
    }
    return state;
  }
  /** @type {string|null} */
  let tag = null;
  if (a.type === "tag" && BLOCK_TAGS.includes(String(a.tag))) tag = String(a.tag);
  if (a.type === "plus") tag = "plus";
  if (a.type === "minus") tag = "minus";
  if (!tag) return state;
  const block = c.blocks.find((/** @type {any} */ b) => b.id === a.blockId);
  if (!block) return state;
  const next = (a.type === "plus" || a.type === "minus") && block.tag === tag ? "neutral" : tag;
  if (next === block.tag) return state;
  state.past.push(tagSnapshot(c));
  state.future.length = 0; // a new edit invalidates the redo line
  block.tag = next;
  return state;
}

/**
 * The conclusion as it SHIPS: minus blocks removed entirely (not shown here,
 * not included anywhere downstream). Returns a NEW object; the curation copy
 * keeps its minus blocks so undo can restore them.
 * @param {any} conclusion
 */
export function finalizeConclusion(conclusion) {
  return {
    ...conclusion,
    blocks: conclusion.blocks
      .filter((/** @type {any} */ b) => b.tag !== "minus")
      .map((/** @type {any} */ b) => ({ id: b.id, text: b.text, tag: b.tag })),
  };
}

/**
 * Render a (finalized) conclusion as the CONTEXT text tagged along when the
 * knowledge is used downstream: the summary + query header, then plus-tagged
 * blocks as key points; neutral blocks are the body knowledge and follow.
 * @param {any} conclusion
 * @returns {string}
 */
export function conclusionToContext(conclusion) {
  const c = conclusion || /** @type {any} */ ({});
  const blocks = Array.isArray(c.blocks) ? c.blocks.filter((/** @type {any} */ b) => b.tag !== "minus") : [];
  const plus = blocks.filter((/** @type {any} */ b) => b.tag === "plus");
  const rest = blocks.filter((/** @type {any} */ b) => b.tag !== "plus");
  const lines = [];
  if (c.summary) lines.push("Context: " + c.summary);
  if (c.query) lines.push("Question: " + c.query);
  if (plus.length) lines.push("Key points:\n" + plus.map((/** @type {any} */ b) => b.text).join("\n\n"));
  if (rest.length) lines.push(rest.map((/** @type {any} */ b) => b.text).join("\n\n"));
  return lines.join("\n\n");
}

// ── the sealed envelope (ECIES — DRCR/1's suite with its own frozen binding) ─
// (sha256hex is imported from proxy-bundle.js — the shared WebCrypto leaf both
// seal cores already sit on; each core keeps its OWN HKDF info / kind binding.)

/**
 * Generate a recipient keypair. The public half travels as base64url of the
 * raw uncompressed point (the DRCR convention); the private half exports as a
 * JWK so the Worker can persist it (the import agent) or the owner can hold it.
 * @returns {Promise<{ publicKeyB64: string, privateJwk: JsonWebKey }>}
 */
export async function generateKnowledgeKeypair() {
  const kp = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
  );
  return {
    publicKeyB64: b64urlEncode(new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", kp.publicKey)))),
    privateJwk: /** @type {JsonWebKey} */ (await crypto.subtle.exportKey("jwk", kp.privateKey)),
  };
}

/** The key id: first 8 hex of SHA-256(raw public key) — a routing hint only.
 * @param {string} pubkeyB64 @returns {Promise<string>} */
export async function knowledgeKid(pubkeyB64) {
  return (await sha256hex(b64urlDecode(pubkeyB64))).slice(0, 8);
}

/** @param {string} pubkeyB64 @returns {Promise<CryptoKey>} */
function importPublicKey(pubkeyB64) {
  const raw = b64urlDecode(pubkeyB64);
  if (raw.length !== RAW_PUBKEY_LEN || raw[0] !== 0x04) throw new Error("bad knowledge public key");
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "ECDH", namedCurve: CURVE }, false, []);
}

/**
 * Derive the AES-256-GCM key from the ECDH shared secret, salted by the
 * ephemeral public key and bound to THIS use by the frozen HKDF info (so a
 * drskn key derivation never equals a drcr one, even for the same pair).
 * @param {CryptoKey} privateKey @param {CryptoKey} peerPublicKey @param {Uint8Array} ephPublicRaw
 * @returns {Promise<CryptoKey>}
 */
async function deriveAesKey(privateKey, peerPublicKey, ephPublicRaw) {
  // The algorithm object is cast: lib.dom types this param `public`, the
  // workers-types codegen `$public` — and this core is compiled under BOTH
  // (the browser imports it directly; src/knowledge.js pulls it into the
  // Worker program). The runtime accepts `public` everywhere.
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(/** @type {any} */ ({ name: "ECDH", public: peerPublicKey }), privateKey, 256),
  );
  const hkdfKey = await crypto.subtle.importKey("raw", new Uint8Array(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(ephPublicRaw), info: new Uint8Array(te.encode(HKDF_INFO)) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal a knowledge bundle (one or more finalized conclusions + metadata) to a
 * recipient public key. Fresh ephemeral keypair per seal — no long-lived
 * sender key exists at all, and sealing twice yields unlinkable envelopes.
 * @param {any} bundle JSON-serializable (see buildKnowledgeBundle)
 * @param {string} recipientPubkeyB64 base64url raw public key
 * @returns {Promise<{ v: number, kind: string, kid: string, epk: string, iv: string, ct: string }>}
 */
export async function sealKnowledge(bundle, recipientPubkeyB64) {
  const recipient = await importPublicKey(recipientPubkeyB64);
  const eph = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
  );
  const ephPublicRaw = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", eph.publicKey)));
  const key = await deriveAesKey(eph.privateKey, recipient, ephPublicRaw);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(te.encode(JSON.stringify(bundle)))),
  );
  return {
    v: KNOWLEDGE_V,
    kind: KNOWLEDGE_KIND,
    kid: await knowledgeKid(recipientPubkeyB64),
    epk: b64urlEncode(ephPublicRaw),
    iv: b64urlEncode(iv),
    ct: b64urlEncode(ct),
  };
}

/**
 * Open a sealed knowledge envelope with the recipient's private JWK.
 * FAIL-CLOSED: returns null on any problem (malformed envelope, wrong key,
 * tampered ciphertext, malformed JSON) — never throws.
 * @param {any} envelope the object from sealKnowledge (or JSON.parse of it)
 * @param {JsonWebKey} privateJwk
 * @returns {Promise<any | null>}
 */
export async function openKnowledge(envelope, privateJwk) {
  try {
    if (!validateKnowledgeEnvelope(envelope)) return null;
    const ephRaw = b64urlDecode(envelope.epk);
    if (ephRaw.length !== RAW_PUBKEY_LEN || ephRaw[0] !== 0x04) return null;
    const ephPublic = await crypto.subtle.importKey("raw", new Uint8Array(ephRaw), { name: "ECDH", namedCurve: CURVE }, false, []);
    const priv = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
    const key = await deriveAesKey(priv, ephPublic, ephRaw);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(b64urlDecode(envelope.iv)) },
        key,
        new Uint8Array(b64urlDecode(envelope.ct)),
      ),
    );
    const bundle = JSON.parse(td.decode(pt));
    return bundle == null ? null : bundle;
  } catch {
    return null;
  }
}

/** Structural check of a knowledge envelope (before attempting decrypt).
 * @param {any} envelope @returns {boolean} */
export function validateKnowledgeEnvelope(envelope) {
  return !!(
    envelope &&
    envelope.kind === KNOWLEDGE_KIND &&
    envelope.v === KNOWLEDGE_V &&
    typeof envelope.kid === "string" &&
    typeof envelope.epk === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ct === "string"
  );
}

/**
 * The plaintext BUNDLE a seal wraps: finalized conclusions plus enough
 * metadata for the owner's import view to make sense of them. `owner` is the
 * ADDRESSING field — the workspace owner's pool id (read off the workspace's
 * pool token) — which the upload-import route enforces: a stray .drskn file
 * opens only for the account it names.
 * @param {{ conclusions: any[], owner?: string|null, workspace?: string|null, from?: string|null }} opts
 */
export function buildKnowledgeBundle(opts) {
  const o = opts || /** @type {any} */ ({});
  return {
    v: KNOWLEDGE_V,
    kind: "drskn-plain",
    at: Date.now(),
    owner: o.owner ? String(o.owner).slice(0, 80) : undefined,
    workspace: o.workspace ? String(o.workspace).slice(0, 80) : undefined,
    from: o.from ? String(o.from).slice(0, 80) : undefined,
    conclusions: (Array.isArray(o.conclusions) ? o.conclusions : []).filter(validateConclusion).map(finalizeConclusion),
  };
}
