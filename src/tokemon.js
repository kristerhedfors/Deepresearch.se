// @ts-check
// Tokemon — the open-world AR game's PURE game core (no I/O, Node-tested).
//
// Design rule (explicit product decision): DON'T invent game logic. Every
// mechanic here is lifted verbatim from Pokémon Generation 1 — the most
// battle-tested balance model there is — under an original AI/token-themed
// skin:
//   - stat formula: Gen 1 (DVs 0–15, no EVs — the fresh-catch case)
//   - damage formula: Gen 1, incl. the truncation order, STAB ×1.5, the
//     217–255/255 random factor, and Gen 1's physical/special split BY TYPE
//     (single Special stat)
//   - critical hits: Gen 1 — chance = baseSpeed/512 (×8 for high-crit
//     moves), damage recomputed with the doubled level term
//   - catching: the Gen 1 capture algorithm (ball ceiling/factor, the
//     HP-derived second roll)
//   - fleeing: the Gen 1 escape formula
//   - XP: medium-fast growth (level³) and Gen 1 wild-XP gain (base·L/7)
//   - type chart: the official matchups restricted to 8 types, renamed
//     1:1 (Normal→Neural, Fire→Compute, Water→Data, Grass→Code,
//     Electric→Spark, Psychic→Logic, Fighting→Adversarial, Ghost→Phantom),
//     with Gen 2's corrected Ghost-vs-Psychic (the Gen 1 bug is not balance)
//   - species: base stats, catch rates and base-XP yields copied from
//     documented Gen 1 species (mapping noted per entry); moves copied from
//     documented move stats (power/accuracy/PP; multi-turn/status side
//     effects dropped — noted per entry)
//
// Deliberate simplifications (scope, not balance inventions): no status
// conditions or stat stages, no move side effects, wild/villain AI is
// Gen 1's wild behavior (uniform random move). Spawning is the one part
// with no Gen 1 equivalent; it follows Pokémon GO's shape: deterministic
// per (geocell, time-bucket) so every client and the server agree without
// storing spawn state.
//
// The static data tables (species, moves, the renamed type chart, spawn
// tables) live in src/tokemon-data.js — imported here and re-exported below
// so this module's import surface (src/tokemon-api.js, tests) is unchanged.

import {
  BALLS,
  CHART,
  HEAL_ITEMS,
  ITEM_DROPS,
  MOVES,
  PHYSICAL_TYPES,
  SPAWN_TABLE,
  SPECIES,
  STARTERS,
  VILLAINS,
} from "./tokemon-data.js";

export { BALLS, HEAL_ITEMS, MOVES, SPECIES, STARTERS, TYPES, VILLAINS } from "./tokemon-data.js";

// ---------------------------------------------------------------------------
// Shared shapes. These typedefs are the game's data contract — the API layer
// (src/tokemon-api.js) imports them via JSDoc import types. The data-table
// shapes (StatBlock, Move, Species) live with the tables in
// src/tokemon-data.js and are re-aliased here.

/** @typedef {import("./tokemon-data.js").StatBlock} StatBlock */
/** @typedef {import("./tokemon-data.js").Move} Move */
/** @typedef {import("./tokemon-data.js").Species} Species */

/** A uniform random source, 0 ≤ rng() < 1 (always injected — see seededRng). @typedef {() => number} Rng */

/** Computed battle stats at a level (statsFor). @typedef {{maxHp: number, atk: number, def: number, spe: number, spc: number}} Stats */

/** A known move on a creature with its remaining PP. @typedef {{id: string, pp: number}} MoveSlot */

/**
 * One owned or wild creature instance.
 * @typedef {Object} Creature
 * @property {string} uid      Unique within a save (battle switching, party ops).
 * @property {string} species  SPECIES key.
 * @property {number} level
 * @property {number} xp       Lifetime XP (medium-fast: level³ at each level).
 * @property {StatBlock} ivs   Gen 1 DVs, rolled once at creation.
 * @property {number} hp       Current HP (max derives from statsFor).
 * @property {MoveSlot[]} moves  Up to 4.
 * @property {number} caughtAt   ms epoch; 0 for wild/foe creatures.
 */

/**
 * A deterministic map spawn. The id encodes its own derivation
 * (`<kind>:<cx>:<cy>:<bucket>:<i>`) so the server can re-derive and validate
 * it without stored state (spawnById).
 * @typedef {{id: string, kind: "creature", species: string, level: number, lat: number, lng: number, expiresAt: number, emoji: string, name: string}} CreatureSpawn
 * @typedef {{id: string, kind: "item", item: string, count: number, lat: number, lng: number, expiresAt: number, emoji: string}} ItemSpawn
 * @typedef {{id: string, kind: "villain", villain: string, tier: number, lat: number, lng: number, expiresAt: number, emoji: string}} VillainSpawn
 * @typedef {CreatureSpawn | ItemSpawn | VillainSpawn} Spawn
 */

/** Per-species dex tally. @typedef {{seen: number, caught: number}} DexEntry */

/**
 * An in-progress battle, stored inside the save so a reload resumes it.
 * @typedef {{kind: "wild", spawnId: string, foes: Creature[], foeIdx: number, activeUid: string | null, runAttempts: number, startedAt: number}} WildBattle
 * @typedef {{kind: "villain", spawnId: string, villain: string, tier: number, foes: Creature[], foeIdx: number, activeUid: string | null, runAttempts: number, startedAt: number}} VillainBattle
 * @typedef {WildBattle | VillainBattle} Battle
 */

/**
 * The whole per-user save (one D1 JSON row — see src/tokemon-api.js).
 * @typedef {Object} Save
 * @property {number} v  Save-format version.
 * @property {string | null} starter  Chosen starter species id, null until picked.
 * @property {Record<string, number>} items  Ball/heal counts by item id.
 * @property {Creature[]} party  Up to PARTY_MAX.
 * @property {Creature[]} box    Overflow storage.
 * @property {Record<string, DexEntry>} dex
 * @property {Record<string, number>} usedSpawns  Spawn id → expiry ms (pruned on load).
 * @property {Battle | null} battle
 * @property {{caught: number, battlesWon: number, battlesLost: number, villainsBeaten: number, itemsCollected: number}} stats
 * @property {number} lastHealAt
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** Which side acted. @typedef {"player" | "foe"} Actor */

/** The client-visible foe view (publicFoe — no IVs/moves leaked). @typedef {{species: string, name: string, emoji: string, types: string[], level: number, hp: number, maxHp: number, idx: number, count: number}} PublicFoe */

/**
 * One entry of the ordered event list a battle turn returns — the wire
 * vocabulary the client (public/games/tokemon/js/battle.js) plays back.
 * @typedef {(
 *   {t: "miss", who: Actor, move: string} |
 *   {t: "immune", who: Actor, move: string} |
 *   {t: "hit", who: Actor, move: string, dmg: number, mult: number, crit: boolean, defenderHp: number} |
 *   {t: "faint", who: Actor} |
 *   {t: "xp", uid: string, gained: number} |
 *   {t: "levelup", uid: string, level: number} |
 *   {t: "forgot", uid: string, move: string} |
 *   {t: "learned", uid: string, move: string} |
 *   {t: "evolved", uid: string, from: string, to: string} |
 *   {t: "switched", uid: string, forced: boolean} |
 *   {t: "foe_next", foe: PublicFoe | null} |
 *   {t: "reward", reward: Record<string, number>} |
 *   {t: "caught", species: string, level: number, where: "party" | "box", uid: string} |
 *   {t: "broke_free", ball: string} |
 *   {t: "escaped"} |
 *   {t: "escape_failed"} |
 *   {t: "item_used", item: string, uid: string, hp: number} |
 *   {t: "end", result: BattleResult}
 * )} BattleEvent
 */

/** How a battle ended. @typedef {"won" | "lost" | "caught" | "fled"} BattleResult */

/**
 * One player intent per turn (applyBattleAction).
 * @typedef {(
 *   {type: "move", move: string} |
 *   {type: "switch", uid: string} |
 *   {type: "item", item: string, uid?: string} |
 *   {type: "catch", ball: string} |
 *   {type: "run"}
 * )} BattleAction
 */

// ---------------------------------------------------------------------------
// Seeded RNG — everything randomized takes an rng() (0 ≤ r < 1) so battles
// are replayable in tests and spawns are deterministic per cell/bucket.

/**
 * FNV-1a 32-bit string hash → seed.
 * @param {string} str
 * @returns {number}
 */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — tiny, good-enough PRNG.
 * @param {number} seed
 * @returns {Rng}
 */
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer 0..maxInclusive. @type {(rng: Rng, maxInclusive: number) => number} */
const randInt = (rng, maxInclusive) => Math.floor(rng() * (maxInclusive + 1));

// ---------------------------------------------------------------------------
// Type effectiveness — over the renamed 8-type chart (CHART) in
// src/tokemon-data.js.

/**
 * Combined type effectiveness of a move against a defender's type(s).
 * @param {string} moveType
 * @param {string[]} defenderTypes
 * @returns {number} 0 (immune) … 4 (double weakness).
 */
export function typeMultiplier(moveType, defenderTypes) {
  let m = 1;
  for (const t of defenderTypes) {
    const v = CHART[moveType]?.[t];
    if (v !== undefined) m *= v;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Stats & XP — Gen 1 formulas, DVs 0–15, no EVs.

/**
 * Gen 1 stat formula at a level for a given DV set.
 * @param {string} speciesId
 * @param {number} level
 * @param {StatBlock} ivs
 * @returns {Stats}
 */
export function statsFor(speciesId, level, ivs) {
  const s = SPECIES[speciesId];
  /** @type {(base: number, iv: number) => number} */
  const stat = (base, iv) => Math.floor(((base + iv) * 2 * level) / 100) + 5;
  return {
    maxHp: Math.floor(((s.base.hp + ivs.hp) * 2 * level) / 100) + level + 10,
    atk: stat(s.base.atk, ivs.atk),
    def: stat(s.base.def, ivs.def),
    spe: stat(s.base.spe, ivs.spe),
    spc: stat(s.base.spc, ivs.spc),
  };
}

// Medium-fast growth: total XP to BE level L is L³.
/** @type {(level: number) => number} */
export const xpForLevel = (level) => level ** 3;
/**
 * @param {number} xp
 * @returns {number} The level this XP total puts a creature at (1–100).
 */
export function levelFromXp(xp) {
  let l = 1;
  while (xpForLevel(l + 1) <= xp && l < 100) l++;
  return l;
}

// Gen 1 wild-battle XP yield (no trade/traded factor).
/** @type {(speciesId: string, foeLevel: number) => number} */
export const xpGain = (speciesId, foeLevel) => Math.max(1, Math.floor((SPECIES[speciesId].baseExp * foeLevel) / 7));

// ---------------------------------------------------------------------------
// Creatures

/**
 * Roll a fresh Gen 1 DV set (each stat uniform 0–15).
 * @param {Rng} rng
 * @returns {StatBlock}
 */
export function rollIvs(rng) {
  return {
    hp: randInt(rng, 15),
    atk: randInt(rng, 15),
    def: randInt(rng, 15),
    spe: randInt(rng, 15),
    spc: randInt(rng, 15),
  };
}

/**
 * The up-to-4 newest learnset moves at this level, oldest first.
 * @param {string} speciesId
 * @param {number} level
 * @returns {MoveSlot[]}
 */
export function movesAtLevel(speciesId, level) {
  const learned = SPECIES[speciesId].learnset.filter(([l]) => l <= level).map(([, id]) => id);
  return learned.slice(-4).map((id) => ({ id, pp: MOVES[id].pp }));
}

/**
 * Build a fresh creature at a level: rolled DVs, full HP, level-appropriate
 * moves.
 * @param {string} speciesId
 * @param {number} level
 * @param {Rng} rng
 * @param {string} [uid] Explicit uid; derived from the rng when omitted.
 * @returns {Creature}
 */
export function makeCreature(speciesId, level, rng, uid) {
  const ivs = rollIvs(rng);
  const { maxHp } = statsFor(speciesId, level, ivs);
  return {
    uid: uid || `c${Math.floor(rng() * 1e9).toString(36)}${level}`,
    species: speciesId,
    level,
    xp: xpForLevel(level),
    ivs,
    hp: maxHp,
    moves: movesAtLevel(speciesId, level),
    caughtAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Damage — the Gen 1 formula with its truncation order.

/**
 * Gen 1 critical-hit chance: baseSpeed/512 (×8 for high-crit moves), as a
 * 0–1 probability.
 * @param {string} speciesId
 * @param {boolean} highCrit
 * @returns {number}
 */
export function critChance(speciesId, highCrit) {
  const base = SPECIES[speciesId].base.spe;
  return Math.min(255, Math.floor((base * (highCrit ? 8 : 1)) / 2)) / 256;
}

/**
 * The full Gen 1 damage pipeline for one move use. dmg 0 means the move
 * can't affect the target (type immunity).
 * @param {Creature} attacker
 * @param {Creature} defender
 * @param {string} moveId
 * @param {Rng} rng
 * @returns {{dmg: number, mult: number, crit: boolean, stab: boolean}}
 */
export function computeDamage(attacker, defender, moveId, rng) {
  const move = MOVES[moveId];
  const aSpec = SPECIES[attacker.species];
  const dSpec = SPECIES[defender.species];
  const aStats = statsFor(attacker.species, attacker.level, attacker.ivs);
  const dStats = statsFor(defender.species, defender.level, defender.ivs);
  const physical = PHYSICAL_TYPES.has(move.type);
  const A = physical ? aStats.atk : aStats.spc;
  const D = physical ? dStats.def : dStats.spc;
  const mult = typeMultiplier(move.type, dSpec.types);
  if (mult === 0) return { dmg: 0, mult, crit: false, stab: false };
  const crit = rng() < critChance(attacker.species, !!move.highCrit);
  // Gen 1: a critical hit doubles the level term (and would ignore stat
  // stages — none exist here).
  const levelTerm = Math.floor((2 * attacker.level * (crit ? 2 : 1)) / 5) + 2;
  let dmg = Math.floor(Math.floor((levelTerm * move.power * A) / D) / 50);
  dmg = Math.min(997, dmg) + 2;
  const stab = aSpec.types.includes(move.type);
  if (stab) dmg = Math.floor(dmg * 1.5);
  dmg = Math.floor(dmg * mult);
  if (dmg === 0) return { dmg: 0, mult, crit, stab };
  // Gen 1 random factor: uniform 217..255 over 255 (skipped when dmg is 1).
  if (dmg > 1) dmg = Math.max(1, Math.floor((dmg * (217 + randInt(rng, 38))) / 255));
  return { dmg, mult, crit, stab };
}

// ---------------------------------------------------------------------------
// Catching — the Gen 1 capture algorithm (no status conditions here, so the
// status term is 0).

/**
 * One Gen 1 capture attempt.
 * @param {string} speciesId
 * @param {number} curHp
 * @param {number} maxHp
 * @param {string} ballId  BALLS key.
 * @param {Rng} rng
 * @returns {boolean} True when the creature is caught.
 */
export function catchCheck(speciesId, curHp, maxHp, ballId, rng) {
  const ball = BALLS[ballId];
  const r1 = randInt(rng, ball.ceiling);
  if (r1 > SPECIES[speciesId].catchRate) return false;
  const f = Math.max(1, Math.min(255, Math.floor(Math.floor((maxHp * 255) / ball.factor) / Math.max(1, Math.floor(curHp / 4)))));
  return randInt(rng, 255) <= f;
}

/**
 * Gen 1 escape formula. attempts starts at 1.
 * @param {number} mySpe
 * @param {number} foeSpe
 * @param {number} attempts
 * @param {Rng} rng
 * @returns {boolean} True when the flee succeeds.
 */
export function escapeCheck(mySpe, foeSpe, attempts, rng) {
  const b = Math.floor(foeSpe / 4) % 256;
  if (b === 0) return true;
  const f = Math.floor((mySpe * 32) / b) + 30 * attempts;
  if (f > 255) return true;
  return randInt(rng, 255) < f;
}

// ---------------------------------------------------------------------------
// Spawning — deterministic per (geocell, time bucket), Pokémon GO-shaped.
// Cell ≈ 167 m of latitude; creature bucket 15 min; villain bucket 2 h.

export const CELL_DEG = 0.0015;
export const SPAWN_BUCKET_MS = 15 * 60 * 1000;
export const VILLAIN_BUCKET_MS = 2 * 60 * 60 * 1000;
export const ENCOUNTER_RADIUS_M = 80;

/**
 * @template T
 * @param {Rng} rng
 * @param {Array<[T, number]>} entries  [value, weight] pairs.
 * @returns {T}
 */
function weightedPick(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r < 0) return v;
  }
  return entries[entries.length - 1][0];
}

/**
 * The geocell a coordinate falls in (integer cell indices).
 * @param {number} lat
 * @param {number} lng
 * @returns {{cx: number, cy: number}}
 */
export function cellOf(lat, lng) {
  return { cx: Math.floor(lat / CELL_DEG), cy: Math.floor(lng / CELL_DEG) };
}

// Wild levels scale with the player's strongest creature (Pokémon GO's
// trainer-level scaling, the existing precedent) via `levelCap`.
/** @type {(roll: number, levelCap: number) => number} */
function wildLevel(roll, levelCap) {
  return Math.max(2, 2 + Math.floor(roll * (levelCap - 2)));
}

/**
 * Promote a species along its evolution chain to match its level, so a
 * level-40 spawn is the evolved form, exactly as leveling would have made it.
 * @param {string} speciesId
 * @param {number} level
 * @returns {string}
 */
export function promoteForLevel(speciesId, level) {
  let id = speciesId;
  let s = SPECIES[id];
  while (s.evolvesTo && s.evolveLevel !== undefined && level >= s.evolveLevel) {
    id = s.evolvesTo;
    s = SPECIES[id];
  }
  return id;
}

/**
 * All spawns for one cell in one bucket — deterministic (same inputs, same
 * spawns, on every client and the server). Positions are uniform within the
 * cell.
 * @param {number} cx
 * @param {number} cy
 * @param {number} now  ms epoch (selects the time bucket).
 * @param {number} levelCap  levelCapFor(save) — wild levels are per-player.
 * @returns {Spawn[]}
 */
export function cellSpawns(cx, cy, now, levelCap) {
  /** @type {Spawn[]} */
  const out = [];
  const bucket = Math.floor(now / SPAWN_BUCKET_MS);
  const rng = seededRng(hashSeed(`tokemon:${cx}:${cy}:${bucket}`));
  const expiresAt = (bucket + 1) * SPAWN_BUCKET_MS;
  /** @type {(r1: number, r2: number) => {lat: number, lng: number}} */
  const pos = (r1, r2) => ({ lat: (cx + r1) * CELL_DEG, lng: (cy + r2) * CELL_DEG });
  // 0–2 creatures per cell per bucket (55% none, 35% one, 10% two).
  const roll = rng();
  const nCreatures = roll < 0.55 ? 0 : roll < 0.9 ? 1 : 2;
  for (let i = 0; i < nCreatures; i++) {
    const species = weightedPick(rng, SPAWN_TABLE);
    const levelRoll = rng();
    const p = pos(rng(), rng());
    const level = wildLevel(levelRoll, levelCap);
    const id = promoteForLevel(species, level);
    out.push({ id: `c:${cx}:${cy}:${bucket}:${i}`, kind: "creature", species: id, level, ...p, expiresAt, emoji: SPECIES[id].emoji, name: SPECIES[id].name });
  }
  // ~35% of cells carry an item cache.
  if (rng() < 0.35) {
    const [item, count] = weightedPick(rng, ITEM_DROPS.map(([it, n, w]) => [[it, n], w]));
    const p = pos(rng(), rng());
    out.push({ id: `i:${cx}:${cy}:${bucket}:0`, kind: "item", item, count, ...p, expiresAt, emoji: "🎒" });
  }
  // Villains use the slower bucket: ~8% of cells host one for 2 h.
  const vBucket = Math.floor(now / VILLAIN_BUCKET_MS);
  const vRng = seededRng(hashSeed(`villain:${cx}:${cy}:${vBucket}`));
  if (vRng() < 0.08) {
    const name = VILLAINS[Math.floor(vRng() * VILLAINS.length)];
    const tier = 1 + Math.floor(vRng() * 3); // team size 1–3
    const p = pos(vRng(), vRng());
    out.push({ id: `v:${cx}:${cy}:${vBucket}:0`, kind: "villain", villain: name, tier, ...p, expiresAt: (vBucket + 1) * VILLAIN_BUCKET_MS, emoji: "🦹" });
  }
  return out;
}

/**
 * All spawns within `cells` cells of (lat,lng) — the client's visible set.
 * @param {number} lat
 * @param {number} lng
 * @param {number} now
 * @param {number} levelCap
 * @param {number} [cells]
 * @returns {Spawn[]}
 */
export function spawnsAround(lat, lng, now, levelCap, cells = 2) {
  const { cx, cy } = cellOf(lat, lng);
  /** @type {Spawn[]} */
  const out = [];
  for (let dx = -cells; dx <= cells; dx++) {
    for (let dy = -cells; dy <= cells; dy++) {
      out.push(...cellSpawns(cx + dx, cy + dy, now, levelCap));
    }
  }
  return out;
}

/**
 * Re-derive one spawn from its id (server-side validation: the client can
 * only encounter what the deterministic generator actually placed there).
 * @param {string | undefined} id
 * @param {number} now
 * @param {number} levelCap  Must be the SAME save's cap the spawn was listed with.
 * @returns {Spawn | null}
 */
export function spawnById(id, now, levelCap) {
  const m = /^([civ]):(-?\d+):(-?\d+):(\d+):(\d+)$/.exec(id || "");
  if (!m) return null;
  const [, , cxs, cys] = m;
  return cellSpawns(Number(cxs), Number(cys), now, levelCap).find((s) => s.id === id) || null;
}

/**
 * Great-circle distance in meters.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  /** @type {(d: number) => number} */
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Read a client-supplied position, rejecting anything outside Web Mercator's
 * usable latitudes.
 * @param {{lat?: unknown, lng?: unknown} | null | undefined} source
 * @returns {{lat: number, lng: number} | null}
 */
export function parseLatLng(source) {
  const lat = Number(source?.lat);
  const lng = Number(source?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// ---------------------------------------------------------------------------
// Save state

export const PARTY_MAX = 6;
export const HEAL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * A brand-new save with the starting item kit.
 * @param {number} now
 * @returns {Save}
 */
export function newSave(now) {
  return {
    v: 1,
    starter: null,
    items: { tokeball: 15, megaball: 0, hyperball: 0, potion: 3, superpotion: 0, revive: 1 },
    party: [],
    box: [],
    dex: {},
    usedSpawns: {},
    battle: null,
    stats: { caught: 0, battlesWon: 0, battlesLost: 0, villainsBeaten: 0, itemsCollected: 0 },
    lastHealAt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Tolerant re-hydration of a stored save; anything unreadable → fresh save.
 * @param {unknown} json  The stored JSON string (or already-parsed object).
 * @param {number} now
 * @returns {Save}
 */
export function normalizeSave(json, now) {
  /** @type {any} */
  let raw = null;
  try {
    raw = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return newSave(now);
  const fresh = newSave(now);
  /** @type {Save} */
  const save = {
    ...fresh,
    ...raw,
    items: { ...fresh.items, ...(raw.items || {}) },
    stats: { ...fresh.stats, ...(raw.stats || {}) },
    party: Array.isArray(raw.party) ? raw.party : [],
    box: Array.isArray(raw.box) ? raw.box : [],
    dex: raw.dex && typeof raw.dex === "object" ? raw.dex : {},
    usedSpawns: raw.usedSpawns && typeof raw.usedSpawns === "object" ? raw.usedSpawns : {},
    updatedAt: now,
  };
  // Prune expired used-spawn markers so the map never grows unbounded.
  for (const [id, exp] of Object.entries(save.usedSpawns)) {
    if (typeof exp !== "number" || exp < now) delete save.usedSpawns[id];
  }
  return save;
}

/**
 * @param {Save} save
 * @returns {number} The strongest party member's level (0 with no party).
 */
export function maxPartyLevel(save) {
  return save.party.reduce((m, c) => Math.max(m, c.level), 0);
}

/**
 * The wild-level cap for this save: a bit above the strongest party member,
 * floored for new players, capped at 55 (legendaries excepted server-side).
 * @param {Save} save
 * @returns {number}
 */
export function levelCapFor(save) {
  return Math.max(6, Math.min(55, maxPartyLevel(save) + 3));
}

/**
 * @param {Save} save
 * @param {string} speciesId
 */
export function markDexSeen(save, speciesId) {
  const d = save.dex[speciesId] || { seen: 0, caught: 0 };
  d.seen++;
  save.dex[speciesId] = d;
}

/**
 * @param {Save} save
 * @param {string} speciesId
 */
export function markDexCaught(save, speciesId) {
  const d = save.dex[speciesId] || { seen: 0, caught: 0 };
  d.caught++;
  save.dex[speciesId] = d;
}

/**
 * Add to party if there's room, else box.
 * @param {Save} save
 * @param {Creature} creature
 * @returns {"party" | "box"} Where it went.
 */
export function addCreature(save, creature) {
  if (save.party.length < PARTY_MAX) {
    save.party.push(creature);
    return "party";
  }
  save.box.push(creature);
  return "box";
}

// ---------------------------------------------------------------------------
// Battles — engine over the formulas above. A battle lives in save.battle;
// each player action resolves one full turn and returns an ordered event
// list the client renders.

/**
 * Start a wild battle from a creature spawn. Marks the species seen.
 * @param {Save} save
 * @param {CreatureSpawn} spawn
 * @param {Rng} rng
 * @param {number} now
 * @returns {WildBattle}
 */
export function newWildBattle(save, spawn, rng, now) {
  const foe = makeCreature(spawn.species, spawn.level, rng);
  foe.hp = statsFor(foe.species, foe.level, foe.ivs).maxHp;
  markDexSeen(save, foe.species);
  return {
    kind: "wild",
    spawnId: spawn.id,
    foes: [foe],
    foeIdx: 0,
    activeUid: firstAbleUid(save),
    runAttempts: 0,
    startedAt: now,
  };
}

/**
 * Start a villain battle. The villain's team is generated at encounter time,
 * scaled to the player's strongest creature (trainer battles scale — the
 * Pokémon GO precedent).
 * @param {Save} save
 * @param {VillainSpawn} spawn
 * @param {Rng} rng
 * @param {number} now
 * @returns {VillainBattle}
 */
export function newVillainBattle(save, spawn, rng, now) {
  const base = Math.max(5, maxPartyLevel(save));
  /** @type {Creature[]} */
  const foes = [];
  for (let i = 0; i < spawn.tier; i++) {
    const level = Math.max(3, base - 2 + randInt(rng, 4));
    const species = promoteForLevel(weightedPick(rng, SPAWN_TABLE), level);
    foes.push(makeCreature(species, level, rng));
  }
  for (const f of foes) markDexSeen(save, f.species);
  return {
    kind: "villain",
    spawnId: spawn.id,
    villain: spawn.villain,
    tier: spawn.tier,
    foes,
    foeIdx: 0,
    activeUid: firstAbleUid(save),
    runAttempts: 0,
    startedAt: now,
  };
}

/**
 * @param {Save} save
 * @returns {string | null} The first party member able to battle.
 */
function firstAbleUid(save) {
  const c = save.party.find((p) => p.hp > 0);
  return c ? c.uid : null;
}

/**
 * @param {Save} save
 * @param {string | null | undefined} uid
 * @returns {Creature | null}
 */
export function partyMember(save, uid) {
  return save.party.find((c) => c.uid === uid) || null;
}

/** @type {(battle: Battle) => Creature} */
function currentFoe(battle) {
  return battle.foes[battle.foeIdx];
}

/**
 * Villain reward table by tier — balls and heals, richer per tier.
 * @param {number} tier
 * @param {Rng} rng
 * @returns {Record<string, number>} Item id → count.
 */
export function villainReward(tier, rng) {
  /** @type {Record<string, number>} */
  const reward = { tokeball: 2 + tier, potion: tier };
  if (tier >= 2) reward.megaball = tier - 1;
  if (tier >= 3) {
    reward.hyperball = 1;
    if (rng() < 0.5) reward.revive = 1;
  }
  return reward;
}

/**
 * One attack: attacker uses moveId against defender. Emits events; mutates
 * hp/pp.
 * @param {Creature} attacker
 * @param {Creature} defender
 * @param {string} moveId
 * @param {Actor} who
 * @param {BattleEvent[]} events
 * @param {Rng} rng
 */
function performMove(attacker, defender, moveId, who, events, rng) {
  const move = MOVES[moveId];
  const slot = attacker.moves.find((m) => m.id === moveId);
  if (slot) slot.pp = Math.max(0, slot.pp - 1);
  if (randInt(rng, 99) >= move.acc) {
    events.push({ t: "miss", who, move: moveId });
    return;
  }
  const { dmg, mult, crit } = computeDamage(attacker, defender, moveId, rng);
  if (mult === 0) {
    events.push({ t: "immune", who, move: moveId });
    return;
  }
  defender.hp = Math.max(0, defender.hp - dmg);
  events.push({ t: "hit", who, move: moveId, dmg, mult, crit, defenderHp: defender.hp });
  if (defender.hp === 0) events.push({ t: "faint", who: who === "player" ? "foe" : "player" });
}

/**
 * Gen 1 wild AI: uniform random move with PP left.
 * @param {Creature} foe
 * @param {Rng} rng
 * @returns {string}
 */
function foeMoveId(foe, rng) {
  const usable = foe.moves.filter((m) => m.pp > 0);
  const pool = usable.length ? usable : foe.moves; // Struggle stand-in: never truly stuck
  return pool[Math.floor(rng() * pool.length)].id;
}

/** @type {(creature: Creature) => number} */
function effectiveSpe(creature) {
  return statsFor(creature.species, creature.level, creature.ivs).spe;
}

/**
 * Award XP to the player's active creature; handle level-ups, move learning,
 * evolution. Emits events.
 * @param {Save} save
 * @param {Creature} creature
 * @param {Creature} foe
 * @param {BattleEvent[]} events
 */
export function awardXp(save, creature, foe, events) {
  const gained = xpGain(foe.species, foe.level);
  creature.xp += gained;
  events.push({ t: "xp", uid: creature.uid, gained });
  let newLevel = levelFromXp(creature.xp);
  while (creature.level < newLevel) {
    creature.level++;
    const { maxHp } = statsFor(creature.species, creature.level, creature.ivs);
    // Gen 1 keeps current HP damage constant across level-up; simplest
    // faithful equivalent: grow current hp by the max-hp delta.
    const prevMax = statsFor(creature.species, creature.level - 1, creature.ivs).maxHp;
    creature.hp = Math.min(maxHp, creature.hp + (maxHp - prevMax));
    events.push({ t: "levelup", uid: creature.uid, level: creature.level });
    // Learn any move at exactly this level; with 4 known, the oldest slot
    // is replaced (v1 rule — no prompt).
    for (const [lvl, moveId] of SPECIES[creature.species].learnset) {
      if (lvl === creature.level && !creature.moves.some((m) => m.id === moveId)) {
        if (creature.moves.length >= 4) {
          const dropped = /** @type {MoveSlot} */ (creature.moves.shift());
          events.push({ t: "forgot", uid: creature.uid, move: dropped.id });
        }
        creature.moves.push({ id: moveId, pp: MOVES[moveId].pp });
        events.push({ t: "learned", uid: creature.uid, move: moveId });
      }
    }
    // Evolution at threshold.
    const spec = SPECIES[creature.species];
    if (spec.evolvesTo && spec.evolveLevel !== undefined && creature.level >= spec.evolveLevel) {
      const from = creature.species;
      const hpFrac = creature.hp / statsFor(creature.species, creature.level, creature.ivs).maxHp;
      creature.species = spec.evolvesTo;
      creature.hp = Math.max(1, Math.floor(statsFor(creature.species, creature.level, creature.ivs).maxHp * hpFrac));
      markDexSeen(save, creature.species);
      markDexCaught(save, creature.species);
      events.push({ t: "evolved", uid: creature.uid, from, to: creature.species });
    }
  }
}

/**
 * Close the battle: consume the spawn (24 h), clear save.battle, emit "end".
 * @param {Save} save
 * @param {BattleEvent[]} events
 * @param {BattleResult} result
 */
function endBattle(save, events, result) {
  if (save.battle?.spawnId) save.usedSpawns[save.battle.spawnId] = (save.battle.startedAt || 0) + 24 * 60 * 60 * 1000;
  save.battle = null;
  events.push({ t: "end", result });
}

/**
 * Foe (and only the foe) acts — used after non-move player actions.
 * @param {Save} save
 * @param {Battle} battle
 * @param {BattleEvent[]} events
 * @param {Rng} rng
 */
function foeTurn(save, battle, events, rng) {
  const player = partyMember(save, battle.activeUid);
  const foe = currentFoe(battle);
  if (!player || player.hp <= 0 || foe.hp <= 0) return;
  performMove(foe, player, foeMoveId(foe, rng), "foe", events, rng);
  if (player.hp === 0) handlePlayerFaint(save, battle, events);
}

/**
 * Force-switch to the next able creature, or lose the battle.
 * @param {Save} save
 * @param {Battle} battle
 * @param {BattleEvent[]} events
 */
function handlePlayerFaint(save, battle, events) {
  const next = save.party.find((c) => c.hp > 0);
  if (next) {
    battle.activeUid = next.uid;
    events.push({ t: "switched", uid: next.uid, forced: true });
  } else {
    save.stats.battlesLost++;
    endBattle(save, events, "lost");
  }
}

/**
 * XP for the KO, then the villain's next foe or victory (+ villain reward).
 * @param {Save} save
 * @param {Battle} battle
 * @param {BattleEvent[]} events
 * @param {Rng} rng
 */
function handleFoeFaint(save, battle, events, rng) {
  const player = partyMember(save, battle.activeUid);
  const foe = currentFoe(battle);
  if (player && player.hp > 0) awardXp(save, player, foe, events);
  if (battle.kind === "villain" && battle.foeIdx < battle.foes.length - 1) {
    battle.foeIdx++;
    events.push({ t: "foe_next", foe: publicFoe(battle) });
    return;
  }
  save.stats.battlesWon++;
  if (battle.kind === "villain") {
    save.stats.villainsBeaten++;
    const reward = villainReward(battle.tier, rng);
    for (const [item, n] of Object.entries(reward)) save.items[item] = (save.items[item] || 0) + n;
    events.push({ t: "reward", reward });
  }
  endBattle(save, events, "won");
}

/**
 * The client-visible view of the current foe (no IVs/moves leaked).
 * @param {Battle} battle
 * @returns {PublicFoe | null}
 */
export function publicFoe(battle) {
  const foe = currentFoe(battle);
  if (!foe) return null;
  const { maxHp } = statsFor(foe.species, foe.level, foe.ivs);
  return {
    species: foe.species,
    name: SPECIES[foe.species].name,
    emoji: SPECIES[foe.species].emoji,
    types: SPECIES[foe.species].types,
    level: foe.level,
    hp: foe.hp,
    maxHp,
    idx: battle.foeIdx,
    count: battle.foes.length,
  };
}

// ---------------------------------------------------------------------------
// Client views — the save goes to the client minus what would enable
// cheating in a battle (the foe's exact IVs/moves stay server-side).

/** @param {Creature} c */
export function publicCreature(c) {
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
export function publicBattle(battle) {
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
export function publicSave(save) {
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

/**
 * Resolve ONE player action (a full turn — the foe replies where the rules
 * say so). Mutates save; the caller persists it.
 * @param {Save} save
 * @param {BattleAction | null | undefined} action  Client intent, not yet trusted.
 * @param {Rng} rng
 * @param {number} now
 * @returns {{events: BattleEvent[], error?: string}} An ordered event list
 *   for the client to play back; `error` means nothing happened.
 */
export function applyBattleAction(save, action, rng, now) {
  const battle = save.battle;
  /** @type {BattleEvent[]} */
  const events = [];
  if (!battle) return { events, error: "No active battle." };
  const player = partyMember(save, battle.activeUid);
  const foe = currentFoe(battle);
  if (!player) return { events, error: "No able creature." };

  switch (action?.type) {
    case "move": {
      const slot = player.moves.find((m) => m.id === action.move);
      if (!slot) return { events, error: "Unknown move." };
      if (slot.pp <= 0) return { events, error: "No PP left for that move." };
      const move = MOVES[action.move];
      const foeMove = foeMoveId(foe, rng);
      // Order: priority first, then speed, ties random (Gen 1).
      const pPri = move.priority || 0;
      const fPri = MOVES[foeMove].priority || 0;
      const playerFirst =
        pPri !== fPri
          ? pPri > fPri
          : effectiveSpe(player) !== effectiveSpe(foe)
            ? effectiveSpe(player) > effectiveSpe(foe)
            : rng() < 0.5;
      /** @type {Array<[Creature, Creature, string, Actor]>} */
      const order = playerFirst
        ? [[player, foe, action.move, "player"], [foe, player, foeMove, "foe"]]
        : [[foe, player, foeMove, "foe"], [player, foe, action.move, "player"]];
      for (const [att, def, mv, who] of order) {
        if (att.hp <= 0 || def.hp <= 0) continue;
        performMove(att, def, mv, who, events, rng);
      }
      if (foe.hp === 0) handleFoeFaint(save, battle, events, rng);
      else if (player.hp === 0) handlePlayerFaint(save, battle, events);
      return { events };
    }
    case "switch": {
      const next = partyMember(save, action.uid);
      if (!next || next.hp <= 0) return { events, error: "That creature can't battle." };
      if (next.uid === battle.activeUid) return { events, error: "Already in battle." };
      battle.activeUid = next.uid;
      events.push({ t: "switched", uid: next.uid, forced: false });
      foeTurn(save, battle, events, rng);
      return { events };
    }
    case "item": {
      // Mirrored by useHealItemOutOfBattle in src/tokemon-api.js — the
      // checks and messages must stay in sync.
      const item = HEAL_ITEMS[action.item];
      if (!item) return { events, error: "Unknown item." };
      if (!save.items[action.item]) return { events, error: "None left." };
      const target = action.uid ? partyMember(save, action.uid) : player;
      if (!target) return { events, error: "No such creature." };
      const { maxHp } = statsFor(target.species, target.level, target.ivs);
      if (item.revive) {
        if (target.hp > 0) return { events, error: "It hasn't fainted." };
        target.hp = Math.floor(maxHp / 2);
      } else {
        if (target.hp <= 0) return { events, error: "It has fainted — use a Reboot." };
        if (target.hp >= maxHp) return { events, error: "Already at full health." };
        target.hp = Math.min(maxHp, target.hp + (item.heal || 0));
      }
      save.items[action.item]--;
      events.push({ t: "item_used", item: action.item, uid: target.uid, hp: target.hp });
      foeTurn(save, battle, events, rng);
      return { events };
    }
    case "catch": {
      if (battle.kind !== "wild") return { events, error: "You can't catch a villain's creature!" };
      if (!BALLS[action.ball]) return { events, error: "Unknown ball." };
      if (!save.items[action.ball]) return { events, error: "None left." };
      save.items[action.ball]--;
      const { maxHp } = statsFor(foe.species, foe.level, foe.ivs);
      const caught = catchCheck(foe.species, foe.hp, maxHp, action.ball, rng);
      if (caught) {
        foe.caughtAt = now;
        foe.uid = `c${now.toString(36)}${Math.floor(rng() * 1e6).toString(36)}`;
        const where = addCreature(save, foe);
        markDexCaught(save, foe.species);
        save.stats.caught++;
        events.push({ t: "caught", species: foe.species, level: foe.level, where, uid: foe.uid });
        endBattle(save, events, "caught");
      } else {
        events.push({ t: "broke_free", ball: action.ball });
        foeTurn(save, battle, events, rng);
      }
      return { events };
    }
    case "run": {
      if (battle.kind !== "wild") return { events, error: "You can't run from a villain!" };
      battle.runAttempts++;
      if (escapeCheck(effectiveSpe(player), effectiveSpe(foe), battle.runAttempts, rng)) {
        // Fleeing does NOT consume the spawn — you can re-engage.
        save.battle = null;
        events.push({ t: "escaped" });
        events.push({ t: "end", result: "fled" });
      } else {
        events.push({ t: "escape_failed" });
        foeTurn(save, battle, events, rng);
      }
      return { events };
    }
    default:
      return { events, error: "Unknown action." };
  }
}
