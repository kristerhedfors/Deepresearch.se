// @ts-check
// /api/games/tokemon/* — the Tokemon game's server API, dispatched by the
// games registry (src/games.js). All game logic lives in src/tokemon.js
// (pure, Node-tested); this file is persistence + validation.
//
// Server-authoritative: the save (party, items, dex, active battle) lives in
// D1 (`tokemon_saves`, one row per user), spawns are re-derived
// deterministically from (cell, time-bucket) on every request, and every
// battle turn resolves server-side — the client only ever sends intents.
// Positions come from the client (GPS or tap-to-walk) and are trusted only
// for proximity checks; this is a casual game, not an anti-cheat exercise.
//
// Requires the D1 binding; without it every endpoint answers 503 and the
// game page explains itself (same degrade-don't-break posture as accounts).
//
// Routes (all authed via the normal identity gate in index.js; the
// /api/games/tokemon/ prefix is stripped by the registry, which passes the
// remainder as `subpath`):
//   GET  …/state              → {save: publicSave}
//   POST …/starter  {starter} → pick one of STARTERS (once)
//   GET  …/spawns?lat=&lng=   → {spawns:[...]} near the player
//   POST …/encounter {spawnId, lat, lng} → start a battle
//   POST …/collect  {spawnId, lat, lng}  → pick up an item cache
//   POST …/battle   {action}  → resolve one battle turn
//   POST …/heal               → full-team recharge (cooldown)
//   POST …/party    {op, ...} → lead | box | party | item (out of battle)
//   GET  …/scene?lat&lng&heading → a Street View frame at the player's
//        position with spawns PROJECTED INTO the imagery (src/tokemon-nav.js)
//        — gated on the per-user Google Maps knob, fail-soft without it
//   POST …/go {command, lat, lng, heading} → text-command navigation
//        ("go north 200 m", "gå till Kungsgatan 1", "look right"); moves and
//        turns are pure math, "go to <place>" resolves via Places (knob-gated)

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import {
  applyBattleAction,
  ENCOUNTER_RADIUS_M,
  HEAL_COOLDOWN_MS,
  HEAL_ITEMS,
  hashSeed,
  haversineM,
  levelCapFor,
  makeCreature,
  MOVES,
  newVillainBattle,
  newWildBattle,
  normalizeSave,
  PARTY_MAX,
  publicFoe,
  seededRng,
  SPECIES,
  spawnById,
  spawnsAround,
  STARTERS,
  statsFor,
} from "./tokemon.js";
import {
  destinationPoint,
  normalizeHeading,
  parseGoCommand,
  projectSpawns,
  SCENE_FOV,
  SCENE_VIEW_DIST_M,
} from "./tokemon-nav.js";
import { googleMapsEnabled } from "./settings.js";
import { placesTextSearch, runStreetViewPovCapture, streetViewMetadata } from "./googlemaps.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./games.js').GameIdentity} Identity */
/** @typedef {import('./tokemon.js').Save} Save */
/** @typedef {import('./tokemon.js').Creature} Creature */
/** @typedef {import('./tokemon.js').Spawn} Spawn */
/** @typedef {import('./tokemon.js').Battle} Battle */

/**
 * The games-registry entry point (see GAMES in src/games.js).
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @param {string} subpath  The route after /api/games/tokemon/.
 * @returns {Promise<Response>}
 */
export async function handleTokemon(request, env, url, log, identity, subpath) {
  const db = await getDb(env);
  if (!db) {
    return jsonResponse({ error: "The game needs the accounts database, which isn't configured on this server." }, 503);
  }
  const path = (subpath || "").replace(/\/+$/, "");
  const method = request.method;

  if (path === "state" && method === "GET") return getState(db, identity);
  if (path === "starter" && method === "POST") return postStarter(request, db, log, identity);
  if (path === "spawns" && method === "GET") return getSpawns(db, url, identity);
  if (path === "encounter" && method === "POST") return postEncounter(request, db, log, identity);
  if (path === "collect" && method === "POST") return postCollect(request, db, log, identity);
  if (path === "battle" && method === "POST") return postBattle(request, db, log, identity);
  if (path === "heal" && method === "POST") return postHeal(db, log, identity);
  if (path === "party" && method === "POST") return postParty(request, db, identity);
  if (path === "scene" && method === "GET") return getScene(db, env, url, log, identity);
  if (path === "go" && method === "POST") return postGo(request, env, log, identity);
  return jsonResponse({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------------------
// Persistence

/**
 * @param {D1Database} db
 * @param {string} userId
 * @returns {Promise<Save>} The stored save, or a fresh one (normalizeSave
 *   tolerates a missing/corrupt row).
 */
async function loadSave(db, userId) {
  const now = Date.now();
  const row = await db.prepare("SELECT save_json FROM tokemon_saves WHERE user_id = ?").bind(userId).first();
  return normalizeSave(row?.save_json ?? null, now);
}

/**
 * @param {D1Database} db
 * @param {string} userId
 * @param {Save} save
 */
async function storeSave(db, userId, save) {
  save.updatedAt = Date.now();
  await db
    .prepare(
      "INSERT INTO tokemon_saves (user_id, save_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET save_json = excluded.save_json, updated_at = excluded.updated_at",
    )
    .bind(userId, JSON.stringify(save), save.updatedAt)
    .run();
}

/**
 * @param {Request} request
 * @returns {Promise<any>} The parsed body, or null on malformed/absent JSON.
 */
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client views — the save goes to the client minus what would enable
// cheating in a battle (the foe's exact IVs/moves stay server-side).

/** @param {Creature} c */
function publicCreature(c) {
  const stats = statsFor(c.species, c.level, c.ivs);
  const spec = SPECIES[c.species];
  return {
    uid: c.uid,
    species: c.species,
    name: spec.name,
    emoji: spec.emoji,
    types: spec.types,
    level: c.level,
    xp: c.xp,
    hp: c.hp,
    maxHp: stats.maxHp,
    moves: c.moves.map((m) => ({ id: m.id, name: MOVES[m.id].name, type: MOVES[m.id].type, power: MOVES[m.id].power, pp: m.pp, maxPp: MOVES[m.id].pp })),
    caughtAt: c.caughtAt,
  };
}

/** @param {Battle | null} battle */
function publicBattle(battle) {
  if (!battle) return null;
  return {
    kind: battle.kind,
    villain: battle.kind === "villain" ? battle.villain : null,
    activeUid: battle.activeUid,
    foe: publicFoe(battle),
    runAttempts: battle.runAttempts,
  };
}

/** @param {Save} save */
function publicSave(save) {
  return {
    starter: save.starter,
    items: save.items,
    party: save.party.map(publicCreature),
    box: save.box.map(publicCreature),
    dex: save.dex,
    stats: save.stats,
    battle: publicBattle(save.battle),
    healReadyAt: save.lastHealAt + HEAL_COOLDOWN_MS,
    starters: STARTERS.map((id) => ({ id, name: SPECIES[id].name, emoji: SPECIES[id].emoji, types: SPECIES[id].types })),
  };
}

// ---------------------------------------------------------------------------
// Handlers

/** @param {D1Database} db @param {Identity} identity */
async function getState(db, identity) {
  const save = await loadSave(db, identity.id);
  return jsonResponse({ save: publicSave(save) });
}

/** @param {Request} request @param {D1Database} db @param {Logger} log @param {Identity} identity */
async function postStarter(request, db, log, identity) {
  const body = await readJson(request);
  const choice = body?.starter;
  if (!STARTERS.includes(choice)) {
    return jsonResponse({ error: "starter must be one of: " + STARTERS.join(", ") }, 400);
  }
  const save = await loadSave(db, identity.id);
  if (save.starter) return jsonResponse({ error: "A starter was already chosen." }, 409);
  const rng = seededRng(hashSeed(`starter:${identity.id}:${Date.now()}`));
  const starter = makeCreature(choice, 5, rng);
  starter.caughtAt = Date.now();
  save.starter = choice;
  save.party.push(starter);
  save.dex[choice] = { seen: 1, caught: 1 };
  await storeSave(db, identity.id, save);
  log.info("tokemon.starter", { user_id: identity.id, starter: choice });
  return jsonResponse({ save: publicSave(save) });
}

/**
 * Read a client-supplied position, rejecting anything outside Web Mercator's
 * usable latitudes.
 * @param {{lat?: unknown, lng?: unknown} | null | undefined} source
 * @returns {{lat: number, lng: number} | null}
 */
function parseLatLng(source) {
  const lat = Number(source?.lat);
  const lng = Number(source?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** @param {D1Database} db @param {URL} url @param {Identity} identity */
async function getSpawns(db, url, identity) {
  const pos = parseLatLng({ lat: url.searchParams.get("lat"), lng: url.searchParams.get("lng") });
  if (!pos) return jsonResponse({ error: "lat and lng query params are required." }, 400);
  const save = await loadSave(db, identity.id);
  const now = Date.now();
  const spawns = spawnsAround(pos.lat, pos.lng, now, levelCapFor(save)).filter((s) => !save.usedSpawns[s.id]);
  return jsonResponse({ spawns, now, encounterRadiusM: ENCOUNTER_RADIUS_M });
}

/**
 * Shared validation for encounter/collect: the spawn must re-derive from its
 * id (i.e. the generator really placed it, this bucket), be unused, and be
 * within reach of the reported position.
 * @param {Save} save
 * @param {any} body  {spawnId, lat, lng} from the client.
 * @param {Spawn["kind"]} expectedKind
 * @returns {{error: string, spawn?: undefined, now?: undefined} | {error?: undefined, spawn: Spawn, now: number}}
 */
function validateSpawn(save, body, expectedKind) {
  const pos = parseLatLng(body);
  if (!pos) return { error: "lat and lng are required." };
  const now = Date.now();
  const spawn = spawnById(body?.spawnId, now, levelCapFor(save));
  if (!spawn || spawn.kind !== expectedKind) return { error: "That isn't here any more." };
  if (save.usedSpawns[spawn.id]) return { error: "Already used." };
  if (haversineM(pos.lat, pos.lng, spawn.lat, spawn.lng) > ENCOUNTER_RADIUS_M) {
    return { error: "Too far away — move closer." };
  }
  return { spawn, now };
}

/** @param {Request} request @param {D1Database} db @param {Logger} log @param {Identity} identity */
async function postEncounter(request, db, log, identity) {
  const body = await readJson(request);
  const save = await loadSave(db, identity.id);
  if (save.battle) return jsonResponse({ error: "A battle is already under way.", battle: publicBattle(save.battle) }, 409);
  if (!save.party.some((c) => c.hp > 0)) {
    return jsonResponse({ error: "All your Tokemon have fainted — recharge or use a Reboot first." }, 409);
  }
  const kind = body?.spawnId?.startsWith("v:") ? "villain" : "creature";
  const v = validateSpawn(save, body, kind);
  if (v.error !== undefined) return jsonResponse({ error: v.error }, 400);
  const rng = seededRng(hashSeed(`enc:${v.spawn.id}:${identity.id}`));
  // validateSpawn matched `kind`, so the union member is known here.
  save.battle =
    kind === "villain"
      ? newVillainBattle(save, /** @type {import('./tokemon.js').VillainSpawn} */ (v.spawn), rng, v.now)
      : newWildBattle(save, /** @type {import('./tokemon.js').CreatureSpawn} */ (v.spawn), rng, v.now);
  await storeSave(db, identity.id, save);
  log.info("tokemon.encounter", { user_id: identity.id, spawn: v.spawn.id, kind });
  return jsonResponse({ battle: publicBattle(save.battle), save: publicSave(save) });
}

/** @param {Request} request @param {D1Database} db @param {Logger} log @param {Identity} identity */
async function postCollect(request, db, log, identity) {
  const body = await readJson(request);
  const save = await loadSave(db, identity.id);
  const v = validateSpawn(save, body, "item");
  if (v.error !== undefined) return jsonResponse({ error: v.error }, 400);
  const spawn = /** @type {import('./tokemon.js').ItemSpawn} */ (v.spawn); // validateSpawn matched "item"
  save.items[spawn.item] = (save.items[spawn.item] || 0) + spawn.count;
  save.usedSpawns[spawn.id] = spawn.expiresAt;
  save.stats.itemsCollected++;
  await storeSave(db, identity.id, save);
  log.info("tokemon.collect", { user_id: identity.id, spawn: spawn.id, item: spawn.item, count: spawn.count });
  return jsonResponse({ collected: { item: spawn.item, count: spawn.count }, save: publicSave(save) });
}

/** @param {Request} request @param {D1Database} db @param {Logger} log @param {Identity} identity */
async function postBattle(request, db, log, identity) {
  const body = await readJson(request);
  const save = await loadSave(db, identity.id);
  if (!save.battle) return jsonResponse({ error: "No active battle." }, 409);
  const now = Date.now();
  // Turn RNG is seeded per turn from unguessable-enough parts; determinism
  // matters for tests (which call the core directly), not for the API.
  const rng = seededRng(hashSeed(`turn:${identity.id}:${now}:${Math.random()}`));
  const { events, error } = applyBattleAction(save, body?.action, rng, now);
  if (error) return jsonResponse({ error }, 400);
  await storeSave(db, identity.id, save);
  const ended = events.find((e) => e.t === "end");
  if (ended) log.info("tokemon.battle_end", { user_id: identity.id, result: ended.result });
  return jsonResponse({ events, battle: publicBattle(save.battle), save: publicSave(save) });
}

// Out-of-battle party management. Ops:
//   {op:"lead", uid}          — move a creature to the front of the party
//   {op:"box", uid}           — party → box (never the last able member)
//   {op:"party", uid}         — box → party (if there's room)
//   {op:"item", item, uid}    — use a Patch/Hotfix/Reboot outside battle
/** @param {Request} request @param {D1Database} db @param {Identity} identity */
async function postParty(request, db, identity) {
  const body = await readJson(request);
  const save = await loadSave(db, identity.id);
  if (save.battle) return jsonResponse({ error: "Not during a battle — use the battle menu." }, 409);
  const error = applyPartyOp(save, body);
  if (error) return jsonResponse({ error }, 400);
  await storeSave(db, identity.id, save);
  return jsonResponse({ save: publicSave(save) });
}

/**
 * Apply one party op to the save. Mutates save.
 * @param {Save} save
 * @param {any} body  {op, uid, item?} from the client.
 * @returns {string | null} An error message, or null on success.
 */
function applyPartyOp(save, body) {
  const op = body?.op;
  const uid = body?.uid;
  if (op === "lead") {
    const i = save.party.findIndex((c) => c.uid === uid);
    if (i < 0) return "No such creature in the party.";
    save.party.unshift(save.party.splice(i, 1)[0]);
    return null;
  }
  if (op === "box") {
    const i = save.party.findIndex((c) => c.uid === uid);
    if (i < 0) return "No such creature in the party.";
    if (save.party.length <= 1) return "The party can't be left empty.";
    save.box.push(save.party.splice(i, 1)[0]);
    return null;
  }
  if (op === "party") {
    const i = save.box.findIndex((c) => c.uid === uid);
    if (i < 0) return "No such creature in the box.";
    if (save.party.length >= PARTY_MAX) return `The party is full (${PARTY_MAX}).`;
    save.party.push(save.box.splice(i, 1)[0]);
    return null;
  }
  if (op === "item") return useHealItemOutOfBattle(save, body?.item, uid);
  return "op must be lead | box | party | item.";
}

/**
 * Use a heal item on a party OR boxed creature. Mutates save. Mirrors the
 * in-battle "item" action in src/tokemon.js applyBattleAction — the checks
 * and messages must stay in sync (in battle, only the party is reachable
 * and the foe takes a turn afterwards; the item semantics are identical).
 * @param {Save} save
 * @param {unknown} itemId
 * @param {unknown} uid
 * @returns {string | null} An error message, or null on success.
 */
function useHealItemOutOfBattle(save, itemId, uid) {
  const item = HEAL_ITEMS[/** @type {string} */ (itemId)];
  if (!item) return "Unknown item.";
  const key = /** @type {string} */ (itemId);
  if (!save.items[key]) return "None left.";
  const target = save.party.find((c) => c.uid === uid) || save.box.find((c) => c.uid === uid);
  if (!target) return "No such creature.";
  const { maxHp } = statsFor(target.species, target.level, target.ivs);
  if (item.revive) {
    if (target.hp > 0) return "It hasn't fainted.";
    target.hp = Math.floor(maxHp / 2);
  } else {
    if (target.hp <= 0) return "It has fainted — use a Reboot.";
    if (target.hp >= maxHp) return "Already at full health.";
    target.hp = Math.min(maxHp, target.hp + (item.heal || 0));
  }
  save.items[key]--;
  return null;
}

/** @param {D1Database} db @param {Logger} log @param {Identity} identity */
async function postHeal(db, log, identity) {
  const save = await loadSave(db, identity.id);
  if (save.battle) return jsonResponse({ error: "Not during a battle!" }, 409);
  const now = Date.now();
  if (now - save.lastHealAt < HEAL_COOLDOWN_MS) {
    return jsonResponse({ error: "Recharge is cooling down.", readyAt: save.lastHealAt + HEAL_COOLDOWN_MS }, 429);
  }
  for (const c of save.party) {
    c.hp = statsFor(c.species, c.level, c.ivs).maxHp;
    c.moves = c.moves.map((m) => ({ id: m.id, pp: MOVES[m.id].pp }));
  }
  save.lastHealAt = now;
  await storeSave(db, identity.id, save);
  log.info("tokemon.heal", { user_id: identity.id });
  return jsonResponse({ save: publicSave(save) });
}

// ---------------------------------------------------------------------------
// Street-view mode: the real-world AR view. GET …/scene captures a Street
// View frame at the player's position+heading (edge-cached in
// googlemaps.js, so re-looking at the same view is free) and projects the
// live spawns INTO the image; POST …/go executes a text navigation command.
// Both fail soft: no knob/coverage → a structured "unavailable" answer the
// client explains, never an error page.

/**
 * The fail-soft "street mode can't show anything" answer (200 with a reason
 * the client's pane explains — never an error page).
 * @param {string} reason
 * @param {string} message
 */
function sceneUnavailable(reason, message) {
  return jsonResponse({ available: false, reason, message });
}

/**
 * Project the live spawns into a captured frame and decorate each overlay
 * with what the client renders. Camera = the PANO's true position; `near`
 * (tappable) is measured from the PLAYER's position — the same 80 m check
 * …/encounter enforces.
 * @param {Save} save
 * @param {{lat: number, lng: number}} cam  The panorama position.
 * @param {number} heading
 * @param {{lat: number, lng: number}} playerPos
 */
function sceneOverlays(save, cam, heading, playerPos) {
  const spawns = spawnsAround(cam.lat, cam.lng, Date.now(), levelCapFor(save)).filter((s) => !save.usedSpawns[s.id]);
  return projectSpawns(cam.lat, cam.lng, heading, spawns).map((o) => {
    const s = /** @type {Spawn} */ (spawns.find((x) => x.id === o.id)); // o came from projecting spawns
    return {
      ...o,
      emoji: s.emoji,
      name: s.kind === "creature" ? s.name : s.kind === "villain" ? s.villain : s.item,
      level: s.kind === "creature" ? s.level : undefined,
      near: haversineM(playerPos.lat, playerPos.lng, s.lat, s.lng) <= ENCOUNTER_RADIUS_M,
      lat: s.lat,
      lng: s.lng,
    };
  });
}

/** @param {D1Database} db @param {Env} env @param {URL} url @param {Logger} log @param {Identity} identity */
async function getScene(db, env, url, log, identity) {
  const pos = parseLatLng({ lat: url.searchParams.get("lat"), lng: url.searchParams.get("lng") });
  if (!pos) return jsonResponse({ error: "lat and lng query params are required." }, 400);
  const heading = normalizeHeading(Number(url.searchParams.get("heading")) || 0);
  if (!googleMapsEnabled(env, identity)) {
    return sceneUnavailable(
      "disabled",
      "Street view mode needs the Google Maps & Street View setting — turn it on under Account → Settings. The map keeps working without it.",
    );
  }
  // Free metadata probe: is there imagery here, and where exactly does the
  // panorama stand? The pano position becomes the camera for projection.
  const meta = await streetViewMetadata(env, log, `${pos.lat},${pos.lng}`, "", 100);
  if (meta?.status !== "OK") {
    return sceneUnavailable("no_coverage", "No Street View imagery here — walk toward a road and try again.");
  }
  const cam = { lat: Number(meta.location?.lat ?? pos.lat), lng: Number(meta.location?.lng ?? pos.lng) };
  const frame = await runStreetViewPovCapture(env, log, {
    panoId: meta.pano_id || "",
    lat: cam.lat,
    lng: cam.lng,
    heading: Math.round(heading),
    pitch: 0,
    fov: SCENE_FOV,
  });
  if (!frame?.image) {
    return sceneUnavailable("capture_failed", "Couldn't fetch the imagery right now — try again in a moment.");
  }
  const save = await loadSave(db, identity.id);
  const overlays = sceneOverlays(save, cam, heading, pos);
  log.info("tokemon.scene", { user_id: identity.id, overlays: overlays.length, heading: Math.round(heading) });
  return jsonResponse({
    available: true,
    image: frame.image,
    date: frame.date || "",
    pano: { lat: cam.lat, lng: cam.lng },
    heading: Math.round(heading),
    fov: SCENE_FOV,
    viewDistM: SCENE_VIEW_DIST_M,
    overlays,
  });
}

// Bilingual reply strings for …/go — the command grammar itself is
// EN+SV-equal in src/tokemon-nav.js; replies follow the command's language
// (the parsed command's `sv` flag).
const GO_SAY = {
  /** @type {(sv: boolean, dist: number, dir: string) => string} */
  moved: (sv, dist, dir) => (sv ? `Gick ${dist} m ${dir}.` : `Walked ${dist} m ${dir}.`),
  /** @type {(sv: boolean, dir: number) => string} */
  turned: (sv, dir) => (sv ? `Tittar ${dir}°.` : `Facing ${dir}°.`),
  /** @type {(sv: boolean, name: string) => string} */
  went: (sv, name) => (sv ? `Reste till ${name}.` : `Traveled to ${name}.`),
  /** @type {(sv: boolean, q: string) => string} */
  notFound: (sv, q) => (sv ? `Hittade inte "${q}".` : `Couldn't find "${q}".`),
  /** @type {(sv: boolean) => string} */
  needMaps: (sv) =>
    sv
      ? "Att resa till en plats kräver Google Maps-inställningen (Konto → Inställningar)."
      : "Traveling to a place needs the Google Maps setting (Account → Settings).",
  help: () =>
    'Try: "go north 200 m" · "gå till Kungsgatan 1" · "look right" · "titta västerut"',
};

/** Cardinal bearings → [English, Swedish] words. @type {Record<number, [string, string]>} */
const DIR_WORD = { 0: ["north", "norrut"], 45: ["northeast", "nordost"], 90: ["east", "österut"], 135: ["southeast", "sydost"], 180: ["south", "söderut"], 225: ["southwest", "sydväst"], 270: ["west", "västerut"], 315: ["northwest", "nordväst"] };
/** @type {(bearing: number, sv: boolean) => string} */
const dirWord = (bearing, sv) => (DIR_WORD[bearing] || [`${bearing}°`, `${bearing}°`])[sv ? 1 : 0];

/** @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity */
async function postGo(request, env, log, identity) {
  const body = await readJson(request);
  const pos = parseLatLng(body);
  if (!pos) return jsonResponse({ error: "lat and lng are required." }, 400);
  const heading = normalizeHeading(Number(body?.heading) || 0);
  const cmd = parseGoCommand(body?.command);
  if (!cmd) return jsonResponse({ error: GO_SAY.help() }, 400);

  if (cmd.kind === "move") {
    const to = destinationPoint(pos.lat, pos.lng, cmd.bearing, cmd.distanceM);
    log.info("tokemon.go", { user_id: identity.id, kind: "move", dist: cmd.distanceM });
    return jsonResponse({
      pos: to,
      heading: cmd.bearing,
      moved: true,
      say: GO_SAY.moved(cmd.sv, cmd.distanceM, dirWord(cmd.bearing, cmd.sv)),
    });
  }
  if (cmd.kind === "look") {
    const next = cmd.bearing !== undefined ? cmd.bearing : normalizeHeading(heading + cmd.turn);
    log.info("tokemon.go", { user_id: identity.id, kind: "look" });
    return jsonResponse({ pos, heading: next, moved: false, say: GO_SAY.turned(cmd.sv, next) });
  }
  // goto — resolving a free-text place sends the query to Google Places,
  // so it rides the same per-user knob as every Maps feature.
  if (!googleMapsEnabled(env, identity)) {
    return jsonResponse({ error: GO_SAY.needMaps(cmd.sv) }, 403);
  }
  const place = await placesTextSearch(env, log, cmd.query);
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
    return jsonResponse({ error: GO_SAY.notFound(cmd.sv, cmd.query) }, 404);
  }
  log.info("tokemon.go", { user_id: identity.id, kind: "goto" });
  return jsonResponse({
    pos: { lat: place.lat, lng: place.lng },
    heading,
    moved: true,
    say: GO_SAY.went(cmd.sv, place.name || place.address || cmd.query),
  });
}
