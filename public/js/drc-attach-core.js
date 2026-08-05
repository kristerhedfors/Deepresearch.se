// @ts-check
// The PURE CORE of file attachments for the Se/cure tier (public/cure/).
//
// Se/cure is the never-cloud tier: the server is in no data path, so an
// attached file's bytes exist only in this tab. public/cure/drc.js owns the
// DOM — the paperclip, the hidden <input type=file>, the pending-card row,
// the downscale/parse calls — and imports everything below for the logic.
// This is the same split as public/js/bash-core.js (browser glue in
// sandbox.js) and public/js/sandbox-files.js (the mount plan): the
// deterministic, I/O-free half lives here so `node --test` can exercise it
// without a DOM, a network, or a browser.
//
// WHY public/js/ rather than public/cure/: the browser can only import what
// the Worker actually serves, and src/assets.js allowlists the served module
// graph path by path. public/js/ is where the shared pure cores already live
// and where the Se/cure graph's allowlist entries point, so a core placed
// here is importable from both tiers; one placed beside drc.js would need a
// second allowlist family for no benefit.
//
// THE IMPORT RULE, which is load-bearing: nothing here may reach the authed
// Se/rver stack. attachments.js, models.js, opfs.js and history-store.js all
// pull in session/account code, and a single such edge 401s the whole
// Se/cure tier — this tier's recurring failure class. The one import is
// message-content.js, which is import-free and pure, so both tiers frame an
// attached document with the identical labeled block.
//
// THE SEALED-STATE CONSTRAINT: Se/cure's sealed state rests in localStorage
// (drc-store.js), whose own comment records the assumption it was sized
// against — "no attached-file bytes". base64 inflates by ~4/3 and the quota
// is ~5 MB, so ONE 4 MB PDF would blow the whole store. Nothing here writes
// to persistence and nothing here belongs in a sealed state: a pending
// attachment lives in tab memory for exactly one send. What may be persisted
// is what drcUserContent() returns — text, plus already-downscaled image
// data URLs whose char budget is capped below precisely so a conversation
// stays storable.

import { imageMetadataBlock, inlineDocBlock } from "./message-content.js";

// ---- types -----------------------------------------------------------------

/**
 * One pending attachment. `bytes` is the ORIGINAL file's bytes (what the
 * sandbox VM mounts); `dataUrl` (images) is the downscaled copy that goes on
 * the wire; `text` (documents) is the extracted text that goes on the wire.
 * The two are deliberately different payloads — see sessionFilesFor.
 * @typedef {object} DrcAttachment
 * @property {"image" | "doc"} kind
 * @property {string} name sanitized basename
 * @property {string} [type] MIME type, for the VM manifest
 * @property {Uint8Array} [bytes] the original file's bytes
 * @property {string} [dataUrl] images: the downscaled data: URL sent to the model
 * @property {string} [text] documents: the extracted text inlined into the message
 * @property {boolean} [truncated] documents: the extraction hit the char cap
 * @property {string | null} [metadata] formatted EXIF / docProps summary, or null
 * @property {boolean} [metadataSensitive] the metadata carries GPS / tracked deletions
 */

/**
 * @typedef {object} DrcAttachCaps
 * @property {number} [maxImages]
 * @property {number} [maxDocs]
 * @property {number} [maxFileBytes]
 * @property {number} [maxTotalBytes]
 * @property {number} [maxImageChars]
 * @property {number} [maxTotalImageChars]
 * @property {number} [maxDocChars]
 */

/**
 * One part of a multimodal user message (OpenAI wire shape — what
 * drc-providers.js consumes).
 * @typedef {{type: string, text?: string, image_url?: {url: string}}} DrcContentPart
 */

// ---- caps ------------------------------------------------------------------
//
// Two real constraints bound every number here.
//
//   (1) Se/cure's persistence is localStorage (~5 MB, base64-inflated), and
//       drc-store.js assumes NO file bytes go in. So raw bytes never reach
//       persistence at all, and the only attachment-derived thing that CAN
//       (an image's data URL, inside the conversation) is char-capped.
//   (2) The in-browser Linux VM mounts these files, and sandbox-files.js
//       caps a mount at 32 MB per file / 64 MB total — anything over is
//       silently DROPPED at mount time. Rejecting at attach time instead
//       means the user is told, once, by a person-readable sentence.
//
// Where a Se/rver ingest cap already encodes a provider limit rather than a
// storage one, it is mirrored verbatim so the two tiers behave the same.

/**
 * Max images per message. Mirrors attachments.js (Se/rver) exactly: the
 * provider body limit, not storage, is what sets this.
 */
export const MAX_IMAGES = 4;

/**
 * Max documents per message. Mirrors attachments.js. Se/cure has no RAG
 * fallback for an over-long document in the composer path, so this stays
 * small on purpose — three inlined documents is already most of a message.
 */
export const MAX_DOCS = 3;

/**
 * Per-file raw-byte cap. Mirrors attachments.js's 25 MB sanity cap, which is
 * also comfortably UNDER sandbox-files.js's 32 MB per-file mount cap — so a
 * file this core accepts can never be dropped by the mount for being too big.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Total raw bytes across everything pending. Set to sandbox-files.js's
 * MAX_MOUNT_TOTAL_BYTES (64 MB) for the same reason: the mount budget is the
 * binding constraint, and matching it means the mount never silently drops a
 * file the composer said it accepted. Note 4 × 25 MB + 3 × 25 MB would be
 * 175 MB — the per-file cap alone does not bound this.
 */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Per-image data-URL char cap. Mirrors attachments.js's downscale budget: the
 * provider rejects request bodies over ~1 MB, and a data URL is ~4/3 of the
 * bytes it encodes.
 */
export const MAX_IMAGE_CHARS = 280_000;

/**
 * Total image data-URL chars in one message. Mirrors attachments.js. This is
 * the ONE cap that also protects constraint (1): image data URLs ride inside
 * the conversation, so they are the only attachment-derived bytes that can
 * reach the sealed localStorage state, and 700 KB of them keeps a
 * conversation inside a ~5 MB quota that a base64 seal inflates further.
 */
export const MAX_TOTAL_IMAGE_CHARS = 700_000;

/**
 * Chars of a document's extracted text inlined into the message. Mirrors
 * attachments.js's PER_DOC_CHARS: the server caps a message at 32K chars and
 * each document gets a slice of that. Se/cure does not post to that server,
 * but the same budget keeps three documents plus the question inside every
 * model's context — and the VM still holds the real file, so nothing is lost.
 */
export const MAX_DOC_CHARS = 9000;

/**
 * Name length cap. Deliberately the same 200 as sandbox-files.js's
 * sanitizeName, so the name on the pending card, the name in the message
 * block, and the name in the guest filesystem are one string rather than
 * three truncations of it.
 */
export const MAX_NAME_CHARS = 200;

// ---- name sanitizing -------------------------------------------------------

/**
 * Sanitize an arbitrary file name to a safe basename: path dropped, control
 * characters removed, whitespace collapsed, length-capped. Never empty.
 *
 * This is for DISPLAY (the pending card) and for the message block; the guest
 * filesystem is protected separately — sandbox-files.js sanitizes again at
 * mount time and de-duplicates collisions there. Doing it here too means the
 * user sees the same name the VM will show, and a hostile filename never
 * reaches innerHTML-adjacent code carrying control characters.
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeAttachName(name) {
  let s = typeof name === "string" ? name : name == null ? "" : String(name);
  // basename: everything after the last / or \
  s = s.split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  if (!s || s === "." || s === "..") return "file";
  return s.slice(0, MAX_NAME_CHARS);
}

// ---- adding a pending attachment -------------------------------------------

/**
 * Human-readable byte size for an error sentence.
 * @param {number} n
 * @returns {string}
 */
function mb(n) {
  const v = n / (1024 * 1024);
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + " MB";
}

/**
 * @param {DrcAttachment[]} list
 * @param {"image" | "doc"} kind
 * @returns {number}
 */
function countKind(list, kind) {
  return list.filter((a) => a && a.kind === kind).length;
}

/**
 * @param {DrcAttachment[]} list
 * @returns {number}
 */
function totalBytes(list) {
  return list.reduce((s, a) => s + (a && a.bytes ? a.bytes.length : 0), 0);
}

/**
 * @param {DrcAttachment[]} list
 * @returns {number}
 */
function totalImageChars(list) {
  return list.reduce((s, a) => s + (a && a.kind === "image" && a.dataUrl ? a.dataUrl.length : 0), 0);
}

/**
 * Add one attachment to the pending list, applying the count and size caps.
 *
 * PURE: `list` is never mutated — on success a NEW array is returned, on
 * rejection the SAME array is returned unchanged alongside an error. The
 * error is one short human sentence the composer shows as-is; there is no
 * error code, because every one of these is a thing the user can act on by
 * removing something or attaching a smaller file.
 *
 * @param {DrcAttachment[] | null | undefined} list the current pending list
 * @param {Partial<DrcAttachment> | null | undefined} item the candidate
 * @param {DrcAttachCaps} [caps] overrides, for tests and for a tier that
 *   knows its VM is smaller
 * @returns {{list: DrcAttachment[], error: string | null}}
 */
export function addPending(list, item, caps = {}) {
  const current = Array.isArray(list) ? list.filter(Boolean) : [];
  const maxImages = caps.maxImages ?? MAX_IMAGES;
  const maxDocs = caps.maxDocs ?? MAX_DOCS;
  const maxFileBytes = caps.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = caps.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxImageChars = caps.maxImageChars ?? MAX_IMAGE_CHARS;
  const maxTotalImageChars = caps.maxTotalImageChars ?? MAX_TOTAL_IMAGE_CHARS;

  if (!item || typeof item !== "object") {
    return { list: current, error: "Nothing to attach." };
  }
  const kind = item.kind === "image" ? "image" : "doc";
  const name = sanitizeAttachName(item.name);
  const bytes = item.bytes instanceof Uint8Array ? item.bytes : undefined;

  if (kind === "image" && countKind(current, "image") >= maxImages) {
    return { list: current, error: `Max ${maxImages} images per message.` };
  }
  if (kind === "doc" && countKind(current, "doc") >= maxDocs) {
    return { list: current, error: `Max ${maxDocs} documents per message.` };
  }
  if (bytes && bytes.length > maxFileBytes) {
    return {
      list: current,
      error: `${name} is ${mb(bytes.length)} — the limit is ${mb(maxFileBytes)} per file.`,
    };
  }
  if (bytes && totalBytes(current) + bytes.length > maxTotalBytes) {
    return {
      list: current,
      error: `${name} would push this message past the ${mb(maxTotalBytes)} attachment budget — send the current files first.`,
    };
  }
  if (kind === "image" && item.dataUrl) {
    if (item.dataUrl.length > maxImageChars) {
      return { list: current, error: `${name} is too large to send even compressed — try a smaller image.` };
    }
    if (totalImageChars(current) + item.dataUrl.length > maxTotalImageChars) {
      return { list: current, error: "The image budget for this message is full — send these first." };
    }
  }

  /** @type {DrcAttachment} */
  const added = { ...item, kind, name };
  if (bytes) added.bytes = bytes;
  else delete added.bytes;
  const maxDocChars = caps.maxDocChars ?? MAX_DOC_CHARS;
  if (kind === "doc" && typeof added.text === "string" && added.text.length > maxDocChars) {
    added.text = added.text.slice(0, maxDocChars);
    added.truncated = true;
  }
  return { list: [...current, added], error: null };
}

// ---- the sandbox payload ---------------------------------------------------

/**
 * Map the pending attachments to the sandbox fileProvider's `session` shape —
 * `[{name, type, bytes}]` — which is what ensureSandboxBooted's provider must
 * resolve to and what sandbox-files.js's planMounts consumes.
 *
 * Documents contribute their ORIGINAL bytes, not their extracted text: the VM
 * should get the real PDF so `pdftotext`, `file`, a hash, or a page count all
 * work on it. The extracted text is a separate payload for the model
 * (drcUserContent below) — the same file reaches the two consumers in the two
 * forms each can actually use.
 *
 * Attachments with no readable bytes (an image that only ever existed as a
 * downscaled data URL, say) are skipped rather than mounted empty —
 * applySizeCap would drop them as "empty or unreadable" anyway.
 * @param {DrcAttachment[] | null | undefined} pending
 * @returns {Array<{name: string, type: string, bytes: Uint8Array}>}
 */
export function sessionFilesFor(pending) {
  const list = Array.isArray(pending) ? pending : [];
  /** @type {Array<{name: string, type: string, bytes: Uint8Array}>} */
  const out = [];
  for (const a of list) {
    if (!a || !(a.bytes instanceof Uint8Array) || a.bytes.length === 0) continue;
    out.push({
      name: sanitizeAttachName(a.name),
      type: a.type || (a.kind === "image" ? "image" : "file"),
      bytes: a.bytes,
    });
  }
  return out;
}

// ---- the wire content ------------------------------------------------------

/**
 * Compose the user turn's `content` from the typed text and the pending
 * attachments.
 *
 * THE CONTRACT the rest of the tier keys off:
 *   - NO images pending  → returns a STRING (text, plus any document blocks).
 *   - ANY image pending  → returns an ARRAY of content parts, whose FIRST
 *     part is `{type:"text", text}` carrying the user's text (and the
 *     document blocks, and each image's metadata block), followed by one
 *     `{type:"image_url", image_url:{url}}` part per image with a data URL.
 *
 * The string case is not an optimisation, it is the load-bearing half. A
 * plain string keeps the sealed state, the history, every planning prompt and
 * every non-vision provider on the path they already have; an array is the
 * multimodal exception drc-providers.js knows how to translate (to Anthropic
 * base64 image blocks, or passed through unchanged on OpenAI-wire providers).
 * So an attachment that does not NEED the array shape must not produce one.
 *
 * Documents append via message-content.js's inlineDocBlock and images via
 * imageMetadataBlock, so a Se/cure message frames its material with exactly
 * the same labeled blocks a Se/rver message does.
 * @param {string | null | undefined} text the user's typed text
 * @param {DrcAttachment[] | null | undefined} pending
 * @returns {string | DrcContentPart[]}
 */
export function drcUserContent(text, pending) {
  const list = Array.isArray(pending) ? pending.filter(Boolean) : [];
  let body = typeof text === "string" ? text : "";

  for (const a of list) {
    if (a.kind !== "doc" || typeof a.text !== "string" || !a.text) continue;
    body += inlineDocBlock({
      name: sanitizeAttachName(a.name),
      text: a.text,
      truncated: !!a.truncated,
      metadata: a.metadata ?? null,
    });
  }

  const images = list.filter((a) => a.kind === "image" && typeof a.dataUrl === "string" && a.dataUrl);
  if (!images.length) return body;

  for (const a of images) {
    body += imageMetadataBlock({ name: sanitizeAttachName(a.name), metadata: a.metadata ?? null });
  }

  /** @type {DrcContentPart[]} */
  const parts = [{ type: "text", text: body }];
  for (const a of images) {
    parts.push({ type: "image_url", image_url: { url: /** @type {string} */ (a.dataUrl) } });
  }
  return parts;
}

// ---- the UI line -----------------------------------------------------------

/**
 * A short line for the composer: `2 files attached (report.pdf, chart.png)`.
 * Empty string for nothing pending, so the caller can render it blindly.
 * Long lists name the first three and count the rest rather than growing.
 * @param {DrcAttachment[] | null | undefined} pending
 * @returns {string}
 */
export function attachSummary(pending) {
  const list = Array.isArray(pending) ? pending.filter(Boolean) : [];
  if (!list.length) return "";
  const names = list.map((a) => sanitizeAttachName(a.name));
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const inner = shown.join(", ") + (rest ? `, +${rest} more` : "");
  return `${list.length} file${list.length === 1 ? "" : "s"} attached (${inner})`;
}
