// @ts-check
// The games subsystem's REGISTRY and dispatch seam — the games counterpart
// of src/providers.js (LLM providers) and src/search-sources.js (research
// sources): one declarative entry per game, and everything outside this
// file is game-agnostic.
//
// A game contributes:
//   id          — URL segment: /api/games/<id>/* and (by convention) the
//                 static page under public/games/<id>/
//   name/emoji/tagline/description — what the account panel's Games shelf
//                 renders (the shelf is fetched from GET /api/games, so a
//                 new game appears there by REGISTERING it — no client edit)
//   path        — the game page the shelf links to
//   available(env) — whether this server can run it (missing binding →
//                 the shelf shows the row disabled with `requires`, the
//                 same explain-don't-hide posture as the settings knobs)
//   requires    — human-readable text for the unavailable state
//   handle(request, env, url, log, identity, subpath) — the game's API
//                 handler; `subpath` is everything after /api/games/<id>/
//
// Adding a game = one module exporting a handler (game rules in their own
// pure Node-tested core, like src/tokemon.js) + one entry here. Games are
// authed like every /api/* route (the identity gate runs in index.js) and
// must degrade to a clear error, never a crash, when their backing is
// missing.

import { jsonResponse } from "./http.js";
import { handleTokemon } from "./tokemon-api.js";

/**
 * The authenticated caller, as resolved by the identity gate in index.js
 * (src/auth.js) — game handlers key persistence on `id`.
 * @typedef {import('./settings.js').Identity} GameIdentity
 */

/**
 * One registry entry — the full contract a game implements (each field is
 * described in the header above).
 * @typedef {Object} GameEntry
 * @property {string} id
 * @property {string} name
 * @property {string} emoji
 * @property {string} tagline
 * @property {string} description
 * @property {string} path
 * @property {(env: import('./types.js').Env) => boolean} available
 * @property {string} requires
 * @property {(request: Request, env: import('./types.js').Env, url: URL, log: import('./types.js').Logger, identity: GameIdentity, subpath: string) => Response | Promise<Response>} handle
 */

/** @type {GameEntry[]} */
export const GAMES = [
  {
    id: "tokemon",
    name: "Tokemon",
    emoji: "👾",
    tagline: "catch creatures on the real streets around you",
    description:
      "Open-world augmented-reality game: walk the actual street map (with GPS, " +
      "or tap-to-walk), find and catch wild Tokemon, collect items, and battle " +
      "the villains of Team Glitch.",
    path: "/games/tokemon/",
    available: (env) => !!env.DB,
    requires: "the accounts database (D1)",
    handle: handleTokemon,
  },
];

/**
 * The shelf payload for one game — everything the client needs to render a
 * row, never the handler.
 * @param {GameEntry} game
 * @param {import('./types.js').Env} env
 */
function gameInfo(game, env) {
  return {
    id: game.id,
    name: game.name,
    emoji: game.emoji,
    tagline: game.tagline,
    description: game.description,
    path: game.path,
    available: game.available(env),
    requires: game.requires,
  };
}

/**
 * GET /api/games            → {games:[...]} (the shelf)
 * *   /api/games/<id>/<sub> → the game's own API
 * @param {Request} request
 * @param {import('./types.js').Env} env
 * @param {URL} url
 * @param {import('./types.js').Logger} log
 * @param {GameIdentity} identity
 * @returns {Promise<Response>}
 */
export async function handleGames(request, env, url, log, identity) {
  const m = /^\/api\/games\/?([^/]*)\/?(.*)$/.exec(url.pathname);
  if (!m || !m[1]) {
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405);
    return jsonResponse({ games: GAMES.map((g) => gameInfo(g, env)) });
  }
  const game = GAMES.find((g) => g.id === m[1]);
  if (!game) return jsonResponse({ error: "No such game." }, 404);
  return game.handle(request, env, url, log, identity, m[2]);
}
