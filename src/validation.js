// @ts-check
// Request validation for POST /api/chat: message/content shape, image caps,
// and model resolution (catalog membership, availability, vision).

import { defaultModel } from "./berget.js";
import { countImages, imagePartsOf, lastUserMessage } from "./conversation.js";
import { getModelProfile } from "./model-profiles.js";

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

// Sanitizes the client-reported Street View point-of-view (from the inline
// StreetViewPanorama the user can pan/move — public/js/activity.js, forwarded
// as body.street_view_pov) before the server captures that exact frame.
// Untrusted input, arbitrary shape: anything unusable returns null (the
// enrichment then falls back to the address walk-back), never a blocked chat.
// Heading wraps into [0,360), pitch clamps to [-90,90], fov to Street View
// Static's [10,120]; the pano id is kept only when it looks like one.
/**
 * @param {any} raw untrusted client-reported Street View POV
 * @returns {import('./types.js').StreetViewPov | null}
 */
export function validateStreetViewPov(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const heading = Number(raw.heading);
  const pitch = Number(raw.pitch);
  const fov = Number(raw.fov);
  const panoId = typeof raw.panoId === "string" && /^[\w-]{1,64}$/.test(raw.panoId) ? raw.panoId : "";
  return {
    panoId,
    lat,
    lng,
    heading: Number.isFinite(heading) ? ((Math.round(heading) % 360) + 360) % 360 : 0,
    pitch: Number.isFinite(pitch) ? Math.max(-90, Math.min(90, Math.round(pitch))) : 0,
    fov: Number.isFinite(fov) ? Math.max(10, Math.min(120, Math.round(fov))) : 90,
  };
}

// Sanitizes the client-reported interactive-map view (from the inline
// google.maps.Map the user can pan/zoom — public/js/activity.js, forwarded
// as body.map_view) before the server captures a road-map image of that
// exact area. Untrusted input, arbitrary shape: anything unusable returns
// null (the enrichment then falls back to the address walk-back), never a
// blocked chat. Zoom clamps to the Static Maps API's [0,21].
/** @param {any} raw */
export function validateMapView(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const zoom = Number(raw.zoom);
  return {
    lat,
    lng,
    zoom: Number.isFinite(zoom) ? Math.max(0, Math.min(21, Math.round(zoom))) : 17,
  };
}

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
