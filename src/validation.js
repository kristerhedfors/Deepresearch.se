// @ts-check
// Request validation for POST /api/chat: message/content shape, image caps,
// and model resolution (catalog membership, availability, vision).

import { defaultModel } from "./berget.js";
import { countImages, imagePartsOf, lastUserMessage } from "./conversation.js";
import { getModelProfile } from "./model-profiles.js";
import { MAX_SHELL_ROUNDS } from "./bash-agent.js";

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGES_PER_REQUEST = 8; // history is resent every turn — keep bounded
// Berget rejects request bodies over ~1 MB ("Request payload too large";
// measured 2026-07: 1.0M chars OK, 1.2M rejected). The client downscales
// images to fit; these server caps leave headroom for text/history.
const MAX_IMAGE_CHARS = 300_000; // per image, as a data URL
const MAX_TOTAL_IMAGE_CHARS = 750_000; // per request
const MAX_IMAGE_LOCATIONS = 4; // matches MAX_IMAGES_PER_REQUEST's practical ceiling per message
const MAX_LOCATION_NAME_CHARS = 200;

// Returns an error string for invalid input, or null when acceptable.
/**
 * @param {any} messages untrusted request body field
 * @returns {string | null} an error message, or null when acceptable
 */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Expected a non-empty `messages` array.";
  }
  if (messages.length > MAX_MESSAGES) {
    return `Conversation too long (max ${MAX_MESSAGES} messages). Start a new chat.`;
  }
  let totalImages = 0;
  let totalImageChars = 0;
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") {
      return "Each message must have role `user` or `assistant`.";
    }
    if (typeof m.content === "string") {
      if (m.content.length > MAX_MESSAGE_CHARS) {
        return `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`;
      }
      continue;
    }
    if (!Array.isArray(m.content) || m.content.length === 0) {
      return "Each message `content` must be a string or a non-empty array of parts.";
    }
    let textChars = 0;
    let images = 0;
    for (const part of m.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        textChars += part.text.length;
      } else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
        const url = part.image_url.url;
        if (!url.startsWith("data:image/")) {
          return "Images must be attached as data:image/… URLs.";
        }
        if (url.length > MAX_IMAGE_CHARS) {
          return "An attached image is too large after encoding (~220 KB max per image). Reload the page — it now compresses images automatically.";
        }
        images++;
        totalImages++;
        totalImageChars += url.length;
      } else {
        return "Unsupported message content part.";
      }
    }
    if (textChars > MAX_MESSAGE_CHARS) {
      return `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`;
    }
    if (images > MAX_IMAGES_PER_MESSAGE) {
      return `Too many images in one message (max ${MAX_IMAGES_PER_MESSAGE}).`;
    }
  }
  if (totalImages > MAX_IMAGES_PER_REQUEST) {
    return `Too many images in the conversation (max ${MAX_IMAGES_PER_REQUEST}). Start a new chat.`;
  }
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) {
    return "The attached images together exceed the provider's request size limit. Remove an image or start a new chat.";
  }
  return null;
}

// Sanitizes the client-reported GPS coordinates of attached photos (from
// public/js/exif.js, forwarded as body.imageLocations) before they're used
// for anything — untrusted input, arbitrary shape. Silently drops/caps
// rather than erroring the whole request: a malformed or oversized
// location list just means less (or no) geocoding context, never a
// blocked chat. Returns [] for anything not a non-empty array.
/**
 * @param {any} raw untrusted client-reported GPS coordinates
 * @returns {import('./types.js').ImageLocation[]}
 */
export function validateImageLocations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGE_LOCATIONS) break;
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    const name = typeof item?.name === "string" && item.name ? item.name.slice(0, MAX_LOCATION_NAME_CHARS) : "photo";
    out.push({ name, lat, lon });
  }
  return out;
}

// NOTE (the extension cut, 2026-07-25): the Street View point-of-view and
// interactive-map viewport sanitizers used to live here. They are Google
// Maps vocabulary — an EXTENSION, not core — so they moved next to the
// runners that consume them (src/maps-enrichment.js validateStreetViewPov /
// validateMapView, reached only through src/extensions.js). This module
// validates what EVERY request has: messages, model, attachments, shell
// transcript, client diagnostics. It must not grow a field per integration.

// Resolves the model for a request against the (possibly null) catalog:
// validates the override, checks availability, and enforces vision when the
// conversation carries images. Returns { model } on success or
// { error, status } to reject. Catalog unreachable → fall back to the
// default and let Berget be the judge downstream.
/**
 * @param {any} body the parsed request body ({ model?, messages })
 * @param {import('./types.js').ModelCatalogEntry[] | null | undefined} catalog
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @returns {{ model: string } | { error: string, status: number }}
 */
export function resolveModel(body, catalog, env, log) {
  let model = typeof body.model === "string" && body.model ? body.model : null;

  if (model && catalog) {
    const entry = catalog.find((m) => m.id === model);
    if (!entry) {
      log.warn("chat.invalid_model", { model: model.slice(0, 120) });
      return { error: "Unknown model.", status: 400 };
    }
    if (!entry.up) {
      log.warn("chat.model_down", { model: model.slice(0, 120) });
      return {
        error: `${entry.name} is temporarily unavailable (down for maintenance at Berget). Pick another model.`,
        status: 400,
      };
    }
  } else if (model && !catalog) {
    model = null;
  }
  const activeModel = model || defaultModel(env);

  if (countImages(body.messages) > 0 && catalog) {
    const entry = catalog.find((m) => m.id === activeModel);
    if (entry && !entry.vision) {
      const alternatives = catalog
        .filter((m) => m.vision && m.up)
        .map((m) => m.name)
        .join(", ");
      log.warn("chat.model_no_vision", { model: activeModel.slice(0, 120) });
      return {
        error:
          `${entry.name} does not support image input.` +
          (alternatives ? ` Vision-capable models: ${alternatives}.` : ""),
        status: 400,
      };
    }
    // Some vision models cap how many images one request may carry (a
    // reproduced per-model Berget limit — model-profiles.js). Only the
    // LATEST user message's images are forwarded to the answer call
    // (conversation.js/pipeline.js), so that's the count that matters.
    // Reject with a clear message instead of letting the answer call die
    // on Berget's opaque 400 ("invalid_request").
    const maxImages = getModelProfile(activeModel).maxImages;
    const latestImages = imagePartsOf(lastUserMessage(body.messages)).length;
    if (maxImages && latestImages > maxImages) {
      log.warn("chat.model_image_cap", { model: activeModel.slice(0, 120), images: latestImages, max: maxImages });
      return {
        error:
          `${entry?.name || activeModel} accepts at most ${maxImages} image${maxImages === 1 ? "" : "s"} per message. ` +
          `Remove ${latestImages - maxImages} image${latestImages - maxImages === 1 ? "" : "s"} or pick another vision-capable model.`,
        status: 400,
      };
    }
  }

  return { model: activeModel };
}

/**
 * Coerces the client's bash-lite `shell_transcript` into a clean, bounded
 * array of runs — untrusted input, so every field is typed/clamped and the
 * whole thing is capped (the loop runs at most MAX_SHELL_ROUNDS rounds × a few
 * commands). Non-array or junk entries degrade to an empty transcript, so the
 * answer path is byte-identical to a run without the sandbox.
 * @param {any} raw
 * @returns {Array<{ command: string, exitCode: number, stdout: string, stderr: string }>}
 */
export function resolveShellTranscript(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || typeof r.command !== "string" || !r.command.trim()) continue;
    out.push({
      command: r.command,
      exitCode: Number.isFinite(Number(r.exitCode)) ? Math.trunc(Number(r.exitCode)) : 1,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    });
    if (out.length >= MAX_SHELL_ROUNDS * 8) break;
  }
  return out;
}

/**
 * Coerces the client's `swarm_results` — the briefs the browser's on-device
 * SWARM produced for the workflow's swarm nodes (public/js/swarm-runtime.js)
 * before the request was sent. Untrusted like every other client block: keys
 * must look like agent ids, the brief is clamped to one node's result budget,
 * and the reported member/agreement figures are coerced to numbers used for
 * nothing but the activity line and the chat-log meta. Junk degrades to `{}`,
 * which makes the request identical to one where no swarm ran.
 * @param {any} raw
 * @returns {Record<string, { text: string, agreement: number, members: number, rounds: number, failed: number }>}
 */
export function resolveSwarmResults(raw) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) continue;
    const rec = /** @type {any} */ (v);
    const text = rec && typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) continue;
    const num = (/** @type {any} */ n, /** @type {number} */ hi) =>
      Math.max(0, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : 0));
    out[id] = {
      text: text.slice(0, MAX_SWARM_RESULT_CHARS),
      agreement: num(rec.agreement, 1),
      members: Math.round(num(rec.members, 64)),
      rounds: Math.round(num(rec.rounds, 8)),
      failed: Math.round(num(rec.failed, 64)),
    };
    if (Object.keys(out).length >= 4) break; // a plan may carry at most a couple
  }
  return out;
}

/** One swarm brief's ceiling — the orchestrator clamps again at MAX_RESULT_CHARS. */
const MAX_SWARM_RESULT_CHARS = 8000;

/**
 * Coerces the client's diagnostic block (public/js/stream.js client_diag) to a
 * small, whitelisted shape for the chat log — untrusted, so every field is
 * typed and bounded. Undefined (dropped by JSON.stringify) when absent.
 * @param {any} d
 * @returns {{ coi: boolean|null, bl: boolean, sb: boolean, ran: number, css: string, sab: boolean, ua: string, xb: string, fs: ({ n: number, b: number, proj: boolean, drop: number, ms: number, err: string } | undefined), sw: ({ died: 0|1, kind: string, phase: string, round: number, members: number, conc: number, mb: number, cls: string, ago: number } | undefined) } | undefined}
 */
export function sanitizeClientDiag(d) {
  if (!d || typeof d !== "object") return undefined;
  return {
    coi: d.coi === true ? true : d.coi === false ? false : null,
    bl: d.bl === true,
    sb: d.sb === true,
    ran: Number.isFinite(d.ran) ? Math.max(0, Math.min(50, Math.trunc(d.ran))) : 0,
    css: typeof d.css === "string" ? d.css.slice(0, 16) : "",
    sab: d.sab === true,
    ua: typeof d.ua === "string" ? d.ua.slice(0, 140) : "",
    // WHICH execution environment this send resolved to — a closed vocabulary
    // (browser | local | cloudflare), never a URL, so a user's own runner
    // address never reaches a log. Added 2026-07-27: the diagnostic recorded
    // whether a sandbox COULD run and how many commands it ran, but never
    // WHERE, so a transcript could not be attributed to an environment at all
    // — the gap that let "the browser VM is the sandbox" survive after the
    // cloud container became the main one.
    xb: EXEC_DIAG_BACKENDS.includes(d.xb) ? String(d.xb) : "",
    // The last sandbox filesystem-mount summary (public/js/sandbox.js
    // sandboxFsSummary): whether files mounted, how many, total bytes, a
    // project mount, dropped count, boot ms, and any error — so a mount
    // problem is visible in the chat log without the debug beacon.
    fs: sanitizeFsSummary(d.fs),
    // An orchestrator swarm run that never finished — reported by the NEXT
    // request, because the tab that died could not report itself
    // (public/js/swarm-runtime.js swarmCrashDiag). Without this line the block
    // is dropped here and the crash stays invisible, which is exactly the hole
    // feedback #26 reported.
    sw: sanitizeSwarmDiag(d.sw),
  };
}

/** The execution environments `xb` may name — mirrors EXEC_BACKENDS in public/js/exec-backends-core.js. */
const EXEC_DIAG_BACKENDS = ["browser", "local", "cloudflare"];

/** The run phases a breadcrumb may name — mirrors RUN_PHASES in public/js/ondevice-core.js. */
const SWARM_DIAG_PHASES = ["start", "spawn", "diverge", "critique", "converge", "synthesis", "done"];
/** The failure classes a breadcrumb may carry — mirrors crashClass in public/js/ondevice-core.js. */
const SWARM_DIAG_CLASSES = ["", "oom", "crash", "timeout"];

/**
 * Whitelist the on-device swarm crash breadcrumb (untrusted, bounded).
 * Counters and closed-vocabulary tokens only — no conversation content ever
 * reaches this block, and nothing here is allowed to widen it (invariant 4).
 * `died: 1` means the run never reached "done" (the tab died mid-run);
 * `died: 0` means it finished but recorded a failure class along the way.
 * @param {any} s
 * @returns {{ died: 0|1, kind: string, phase: string, round: number, members: number, conc: number, mb: number, cls: string, ago: number } | undefined}
 */
export function sanitizeSwarmDiag(s) {
  if (!s || typeof s !== "object") return undefined;
  /** @param {any} v @param {number} max */
  const int = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : 0);
  /** @param {any} v @param {string[]} allowed */
  const pick = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : allowed[0]);
  return {
    died: s.died === 1 || s.died === true ? /** @type {1} */ (1) : /** @type {0} */ (0),
    kind: s.kind === "chat" ? "chat" : "swarm",
    phase: pick(s.phase, SWARM_DIAG_PHASES),
    round: int(s.round, 8),
    members: int(s.members, 32),
    conc: int(s.conc, 16),
    mb: int(s.mb, 100_000),
    cls: pick(s.cls, SWARM_DIAG_CLASSES),
    ago: int(s.ago, 86_400),
  };
}

/**
 * Whitelist the sandbox filesystem-mount summary (untrusted, bounded).
 * @param {any} f
 * @returns {{ n: number, b: number, proj: boolean, drop: number, ms: number, err: string } | undefined}
 */
export function sanitizeFsSummary(f) {
  if (!f || typeof f !== "object") return undefined;
  /** @param {any} v @param {number} max */
  const int = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : 0);
  return {
    n: int(f.n, 1000),
    b: int(f.b, 1e12),
    proj: f.proj === true,
    drop: int(f.drop, 1000),
    ms: int(f.ms, 600000),
    err: typeof f.err === "string" ? f.err.slice(0, 200) : "",
  };
}
