// @ts-check
// The chat-mode registry's SERVER FAÇADE. The table and the resolution rules
// live in ONE shared module, public/js/chat-mode-core.js, so the Worker
// (src/chat.js's mode routing, src/settings.js's stored mode) and the browser
// (public/js/chat-mode.js's dropdown + theming) can never disagree about which
// modes exist, which request field selects each one, or which of them carry the
// site's own source. The core lives under public/ because the browser can only
// import served modules, while the Worker bundler can import from anywhere — so
// the server reaches it through this re-export, the same arrangement as
// src/introspect-tools.js over public/js/introspect-core.js.
//
// Adding a mode is a row in the core's MODE_REQUEST_FLAGS plus a `defaults` row
// in sdk/AGENTS.json (the routing authority) — not a new boolean threaded
// through chat.js.

export {
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  FLAG_FOR_MODE,
  MODE_REQUEST_FLAGS,
  modeCarriesSource,
  normalizeChatMode,
  resolveBodyChatMode,
  routingNeedsRegistry,
} from "../public/js/chat-mode-core.js";
