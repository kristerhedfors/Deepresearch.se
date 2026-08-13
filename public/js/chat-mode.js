// @ts-check
// The chat MODE dropdown's state + theming. The dropdown started as three
// entries (owner directive, 2026-07-18: introspection and SDK as explicit modes
// alongside Normal; the titanium-white composer pane marks introspection, GREEN
// marks the SDK "lovable experience" mode) and grew one entry at a time. A mode
// id and its UI label are allowed to differ — `sdk` is labeled "Agent Studio" —
// and mode-theme.js owns the labels.
//
// THERE IS NO GENERAL MODE (owner directive, 2026-08-13). The first entry used
// to be `normal`, labeled "Deep Research": plain web research, no theme class,
// and the value every fallback in this file named. It is retired along with the
// general agent, and DEEP SCIENCE is now both the first dropdown entry and the
// terminal fallback — so every fallback below lands on a themed mode with a
// declared policy rather than on an unthemed catch-all. Requests still arriving
// with `normal` (a stored setting, a share link, a tab that has not reloaded)
// resolve through chat-mode-core.js's RETIRED_CHAT_MODES rather than being
// clamped as junk.
//
// THE MODE IS THE UNIT (2026-07-26). Every request names its mode —
// `chat_mode: "<mode>"` — and the theme, the answer phase and whether the site's
// own source is in context are all derived from that one value. The table of
// modes and the wire resolution live in the shared pure core
// chat-mode-core.js, so this module is only the BROWSER half: which theme class
// the root carries and where the pick is cached.
//
//   science       → the peer-reviewed record only — no open-web search, no
//                   preprints. The default. Theme: `sci-mode` (the parchment
//                   reading room, a dark field).
//   cyber         → cybersecurity and OSINT: host intelligence, geospatial
//                   imagery read as open-source intelligence, entity research,
//                   the appsec reference. Theme: `cyber-mode` (the crimson
//                   operations room, the second dark field).
//   introspection → answers from this site's own deployed source. Theme: the
//                   `dev-mode` root class (dev-mode.js's titanium pane).
//   sdk           → the DistillSDK build flow — distill this site (above all the
//                   Se/cure tier) into a new flavour published at a live URL.
//                   Theme: the `sdk-mode` root class (the green pane).
//   orchestrator  → the sub-agent workflow flow (src/orchestrator.js): a planned
//                   team of sub-agents runs in the background and the workflow is
//                   shown live. Theme: `orch-mode` (the violet pane).
//   outrospection → the outward feed (src/outrospect.js) — introspection's mirror
//                   image, answering from what everyone ELSE shipped. Theme:
//                   `outro-mode` (the newsprint pane).
//   models        → the MODEL-LIFECYCLE agent (src/models-agent.js): Hub search
//                   forced every turn, and a message about models answered
//                   against the live cross-provider catalog, priced and annotated
//                   with what has been verified. Theme: `models-mode` (amber).
//
// There used to be a per-account `developer_mode` knob underneath all of this,
// and the dropdown wrote it on every change ("on" for any non-Normal mode). That
// made the same choice live in three places — the D1 knob, the `dr_dev_mode`
// cache and the mode key here — which had to be reconciled on every page load.
// Now the SERVER stores the mode (settings_json.chat_mode) and this key is
// simply its first-paint CACHE: the cached value paints immediately, the
// server's value replaces it when /api/settings resolves, and there is no
// downgrade rule to get wrong.
//
// Like dev-mode.js this module has an inline first-paint twin in index.html
// (<script data-devtheme>) — if the class logic here changes, update that
// script AND recompute its CSP hash (THEME_BOOT_HASH in
// src/security-headers.js).
//
// Import-safe in Node (unit-tested without a DOM): every document /
// localStorage access is guarded and fails soft.

import { CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode } from "./chat-mode-core.js";
import { MODE_ROOT_CLASSES, barTint, modeRootClass } from "./mode-theme.js";
import { nudgeTint } from "./bar-tint.js";
import { sessionAgent, setSessionAgent } from "./session.js";

export { CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode };

// THE AGENT IS PER SESSION (owner directive, 2026-07-27). A session is an
// agent, a workspace and a history (session-core.js), so the mode belongs to
// the session and two tabs run two agents — which is the point of opening a
// second tab. Before this the mode was one value for the whole account and the
// dropdown wrote it globally, so opening a tab could land you in whatever agent
// another tab had last picked, and a resumed conversation was answered by
// whichever agent happened to be current.
//
// The key below therefore changed ROLE but not name: it is no longer "the
// mode", it is the SEED — the account's last pick, cached for (a) first paint
// before any session exists, and (b) the agent a brand-new session starts in.
// Keeping the name matters: index.html's inline first-paint script reads it
// directly, and that script's bytes are pinned by a CSP hash
// (THEME_BOOT_HASH in src/security-headers.js), so leaving it alone avoids a
// hash recompute for a rename that buys nothing.
/**
 * The localStorage key caching the account's picked chat mode — the first-paint
 * theme and the seed for a new session. The mode a session is actually running
 * is on the session record; read it with cachedChatMode().
 */
export const CHAT_MODE_KEY = "dr_chat_mode";
/** The root class carrying the green SDK-mode pane tint. */
export const SDK_MODE_CLASS = "sdk-mode";
/** The root class carrying the violet Orchestrator-mode pane tint. */
export const ORCH_MODE_CLASS = "orch-mode";
/** The root class carrying the newsprint Outrospection-mode pane tint. */
export const OUTRO_MODE_CLASS = "outro-mode";
/** The root class carrying the amber Models-mode pane tint. */
export const MODELS_MODE_CLASS = "models-mode";
/** The root class carrying the parchment Deep-Science reading-room theme. */
export const SCI_MODE_CLASS = "sci-mode";
/** The root class carrying the crimson Cyber operations-room theme. */
export const CYBER_MODE_CLASS = "cyber-mode";
/**
 * The account's last picked mode — the first-paint theme and the seed a NEW
 * session starts in. DEFAULT_CHAT_MODE (Deep Science) when nothing is cached or
 * storage is unavailable — the safe default is now a themed mode with a stated
 * policy rather than the general one, because the general one is gone.
 *
 * Callers wanting "which agent is answering here" want cachedChatMode(); this
 * is only the seed. app.js passes it to initSession.
 * @returns {string}
 */
export function accountChatMode() {
  try {
    const stored = globalThis.localStorage?.getItem(CHAT_MODE_KEY);
    if (stored) return normalizeChatMode(stored);
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_CHAT_MODE;
}

/**
 * THE mode to paint/send with right now, synchronously — THIS SESSION's agent.
 * Every send path and every theme read goes through here, which is what makes
 * two tabs two agents.
 *
 * Falls back to the account seed when the session has no agent yet: before
 * initSession runs (the synchronous first-paint block at the top of app.js) and
 * whenever storage is unavailable, so private mode still paints and sends
 * correctly — it just can't remember the pick.
 * @returns {string}
 */
export function cachedChatMode() {
  try {
    const mine = sessionAgent();
    if (mine) return normalizeChatMode(mine);
  } catch {
    /* no session yet (first paint) or storage blocked — fall through to the seed */
  }
  return accountChatMode();
}

/**
 * Record the picked mode on THIS SESSION, and — unless told not to — update the
 * account seed so the next new tab opens in the same agent. The DEFAULT mode is
 * stored like any other: an explicit pick of Deep Science must survive a reload
 * rather than reading as "nothing chosen". Fail-soft on both.
 * @param {string} mode
 * @param {{ account?: boolean }} [opts] account:false writes only the session —
 *   used when adopting a value that came FROM the account, so a per-tab switch
 *   elsewhere is not overwritten by another tab's boot.
 * @returns {string} the stored (normalized) mode
 */
export function storeChatMode(mode, opts) {
  const m = normalizeChatMode(mode);
  try {
    setSessionAgent(m);
  } catch {
    /* no session/storage — the theme still applies for this page */
  }
  if (!opts || opts.account !== false) {
    try {
      globalThis.localStorage?.setItem(CHAT_MODE_KEY, m);
    } catch {
      /* storage unavailable */
    }
  }
  return m;
}

/**
 * Apply a mode's theme: exactly ONE of the registry's root classes on <html>.
 * Every surviving mode declares one — the single descriptor with `rootClass:
 * null` was `normal`, and it went with the general agent (2026-08-13), so the
 * "or none" branch is now only what an unthemed page would look like, never a
 * state a picked mode produces. Persists unless {persist:false} (the boot-time
 * cached apply is READING the cache, not deciding).
 *
 * The class list comes from mode-theme.js (MODE_ROOT_CLASSES), not from a
 * hand-written toggle per mode. Deep Science's `sci-mode` was missing from the
 * hand-written version for its whole life (2026-08-02): picking Deep Science
 * left the class off, and — because the parse-time script in index.html DID
 * apply it — a browser that had booted in Science kept it through every later
 * switch. The header then showed two mode tags at once and the palette, the
 * composer pane and the dropdown text each came from a different theme (the
 * near-white Science `--text` landing on the rose-white Introspection pane).
 * Deriving the set means the next mode cannot be forgotten the same way.
 * @param {string} mode
 * @param {{ persist?: boolean, account?: boolean }} [opts] account:false records
 *   the mode on this session only, leaving the account seed alone
 * @returns {string} the applied (normalized) mode
 */
export function applyChatModeTheme(mode, opts) {
  const m = normalizeChatMode(mode);
  if (!opts || opts.persist !== false) storeChatMode(m, { account: opts?.account !== false });
  try {
    const root = globalThis.document?.documentElement;
    const want = modeRootClass(m);
    for (const cls of MODE_ROOT_CLASSES) root?.classList?.toggle(cls, cls === want);
  } catch {
    /* no DOM (tests) — persistence above is the durable part */
  }
  // Repaint the iOS status-bar tint to the new mode's field color, so switching
  // modes moves the chrome above the app too (each mode is a full theme). A
  // single direct set is NOT enough here: iPhone left the strip behind the
  // status icons on the previous mode's blue across a switch (feedback #20,
  // 2026-07-24) — the same swallowing the 2026-07-10/17 navigation fixes hit —
  // so the switch gets bar-tint.js's layered changed-then-target nudge too.
  // The getter re-reads the stored mode so a rapid second switch's lagged
  // timers repaint the CURRENT pick, never a stale one (a non-persisted apply
  // paints its own mode — boot passes the cached value, so they agree).
  // Guarded separately so a DOM-less test never loses the class toggles above.
  try {
    const persisted = !opts || opts.persist !== false;
    nudgeTint(() => barTint(persisted ? cachedChatMode() : m));
  } catch {
    /* no DOM / no meta — bar-tint.js's boot wiring still re-asserts */
  }
  return m;
}

/**
 * Adopt the server's mode once /api/settings resolves. The account's stored
 * `chat_mode` is the authority for the ACCOUNT DEFAULT — it follows the account
 * across devices, and the server has already forced it to the default mode if
 * the modes are unavailable — so there is no downgrade rule on this side.
 *
 * What it is NOT, since the agent went per-session (2026-07-27): authority over
 * a session already in progress. `seed` says which case this is, and app.js
 * knows because initSession told it:
 *
 *   seed: true  — a NEW session (a new tab, or one whose session was taken over).
 *                 The account's mode is the right agent to open in, so adopt it.
 *   seed: false — a RESUMED session (this tab reloaded). Its own agent wins;
 *                 the server value only refreshes the seed for the next new tab.
 *                 Without this a reload would silently drag the tab back to
 *                 whatever agent another tab last pushed to the account.
 *
 * A server payload that does not carry `chat_mode` at all — an older or partial
 * response — leaves the pick alone rather than resetting it to the default.
 * @param {{ chat_mode?: string } | null | undefined} serverSettings
 * @param {{ seed?: boolean }} [opts]
 * @returns {string} the effective mode for this session
 */
export function adoptServerChatMode(serverSettings, opts) {
  const named = normalizeChatMode(serverSettings?.chat_mode, "");
  if (opts?.seed === false) {
    // Refresh the account seed only; this session keeps the agent it is running.
    if (named) {
      try {
        globalThis.localStorage?.setItem(CHAT_MODE_KEY, named);
      } catch {
        /* storage unavailable */
      }
    }
    return applyChatModeTheme(cachedChatMode(), { account: false });
  }
  return applyChatModeTheme(named || cachedChatMode());
}
