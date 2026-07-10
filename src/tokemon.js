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

// ---------------------------------------------------------------------------
// Shared shapes. These typedefs are the game's data contract — the API layer
// (src/tokemon-api.js) imports them via JSDoc import types.

/** A uniform random source, 0 ≤ rng() < 1 (always injected — see seededRng). @typedef {() => number} Rng */

/**
 * The five Gen 1 stat axes (single Special stat). Doubles as the base-stat
 * block on a species and the DV/IV block on a creature (DVs are 0–15).
 * @typedef {{hp: number, atk: number, def: number, spe: number, spc: number}} StatBlock
 */

/** Computed battle stats at a level (statsFor). @typedef {{maxHp: number, atk: number, def: number, spe: number, spc: number}} Stats */

/**
 * One move catalog entry — power/accuracy/PP copied from the named Gen 1
 * original (see MOVES).
 * @typedef {Object} Move
 * @property {string} name
 * @property {string} type    One of TYPES.
 * @property {number} power
 * @property {number} acc     Accuracy in percent (Gen 1's /100 form).
 * @property {number} pp
 * @property {boolean} [highCrit] Gen 1 high-critical-ratio flag (×8 chance).
 * @property {number} [priority]  Strikes first regardless of speed (Quick Attack).
 */

/**
 * One species catalog entry — stats/rates copied from the documented Gen 1
 * species named in the entry's comment (see SPECIES).
 * @typedef {Object} Species
 * @property {string} name
 * @property {string[]} types  1–2 of TYPES.
 * @property {StatBlock} base
 * @property {number} catchRate  Gen 1 capture-rate byte (3 = legendary, 255 = trivial).
 * @property {number} baseExp    Gen 1 base-XP yield.
 * @property {string} [evolvesTo]   Next species id, absent for final forms.
 * @property {number} [evolveLevel] Level threshold for evolvesTo.
 * @property {Array<[number, string]>} learnset  [level, moveId] in learn order.
 * @property {number} spawnWeight  Wild-spawn table weight; 0 = evolution-only.
 * @property {string} emoji  The map/scene marker.
 */

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
// Types — the official chart's matchups among 8 types, renamed 1:1.
// Gen 1 splits physical/special BY TYPE (one Special stat): Normal and
// Fighting (Neural/Adversarial) are physical; so was Ghost, but Phantom's
// signature move here is Gen 2's Shadow Ball era, so Phantom stays special
// alongside Fire/Water/Grass/Electric/Psychic — a 1-type deviation noted
// rather than hidden.
export const TYPES = ["neural", "compute", "data", "code", "spark", "logic", "adversarial", "phantom"];
const PHYSICAL_TYPES = new Set(["neural", "adversarial"]);

// CHART[attacking][defending] — only non-1 entries listed. Values are the
// official ones (Gen 2+ chart, which fixes Ghost-vs-Psychic).
/** @type {Record<string, Record<string, number>>} */
const CHART = {
  neural: { phantom: 0 },
  compute: { compute: 0.5, data: 0.5, code: 2 },
  data: { compute: 2, data: 0.5, code: 0.5 },
  code: { compute: 0.5, data: 2, code: 0.5 },
  spark: { data: 2, code: 0.5, spark: 0.5 },
  logic: { adversarial: 2, logic: 0.5 },
  adversarial: { neural: 2, logic: 0.5, phantom: 0 },
  phantom: { logic: 2, phantom: 2, neural: 0 },
};

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
// Moves — stats copied from the named original move (power/accuracy/PP).
// `highCrit` = Gen 1's high-critical-ratio flag; `priority` = strikes first
// regardless of speed (Quick Attack). Side effects of the originals
// (paralysis chance, recoil, recharge/charge turns) are dropped.
/** @type {Record<string, Move>} */
export const MOVES = {
  bit_bump: { name: "Bit Bump", type: "neural", power: 35, acc: 95, pp: 35 }, // Tackle
  cache_hit: { name: "Cache Hit", type: "neural", power: 40, acc: 100, pp: 30, priority: 1 }, // Quick Attack
  slice: { name: "Slice", type: "neural", power: 70, acc: 100, pp: 20, highCrit: true }, // Slash
  payload_slam: { name: "Payload Slam", type: "neural", power: 85, acc: 100, pp: 15 }, // Body Slam
  beam_burst: { name: "Beam Burst", type: "neural", power: 150, acc: 90, pp: 5 }, // Hyper Beam (no recharge)
  overclock: { name: "Overclock", type: "compute", power: 40, acc: 100, pp: 25 }, // Ember
  thermal_throttle: { name: "Thermal Throttle", type: "compute", power: 95, acc: 100, pp: 15 }, // Flamethrower
  core_meltdown: { name: "Core Meltdown", type: "compute", power: 120, acc: 85, pp: 5 }, // Fire Blast
  data_drip: { name: "Data Drip", type: "data", power: 40, acc: 100, pp: 25 }, // Water Gun
  stream_burst: { name: "Stream Burst", type: "data", power: 65, acc: 100, pp: 20 }, // Bubble Beam
  data_flood: { name: "Data Flood", type: "data", power: 95, acc: 100, pp: 15 }, // Surf
  firehose: { name: "Firehose", type: "data", power: 120, acc: 80, pp: 5 }, // Hydro Pump
  regex_whip: { name: "Regex Whip", type: "code", power: 35, acc: 100, pp: 25 }, // Vine Whip
  razor_branch: { name: "Razor Branch", type: "code", power: 55, acc: 95, pp: 25, highCrit: true }, // Razor Leaf
  compile_beam: { name: "Compile Beam", type: "code", power: 120, acc: 100, pp: 10 }, // Solar Beam (no charge turn)
  static_jolt: { name: "Static Jolt", type: "spark", power: 40, acc: 100, pp: 30 }, // Thundershock
  voltage_spike: { name: "Voltage Spike", type: "spark", power: 95, acc: 100, pp: 15 }, // Thunderbolt
  grid_surge: { name: "Grid Surge", type: "spark", power: 120, acc: 70, pp: 10 }, // Thunder
  inference: { name: "Inference", type: "logic", power: 50, acc: 100, pp: 25 }, // Confusion
  mind_probe: { name: "Mind Probe", type: "logic", power: 65, acc: 100, pp: 20 }, // Psybeam
  deep_thought: { name: "Deep Thought", type: "logic", power: 90, acc: 100, pp: 10 }, // Psychic
  jailbreak_chop: { name: "Jailbreak Chop", type: "adversarial", power: 50, acc: 100, pp: 25, highCrit: true }, // Karate Chop
  exploit_slam: { name: "Exploit Slam", type: "adversarial", power: 80, acc: 80, pp: 20 }, // Submission (no recoil)
  ghost_ping: { name: "Ghost Ping", type: "phantom", power: 20, acc: 100, pp: 30 }, // Lick
  phantom_packet: { name: "Phantom Packet", type: "phantom", power: 80, acc: 100, pp: 15 }, // Shadow Ball
};

// ---------------------------------------------------------------------------
// Species — every line maps to a documented Gen 1 species whose base stats
// (hp/atk/def/spe + the single Gen 1 Special), catch rate and base-XP yield
// are copied unchanged (the mapping is the comment). `learnset` is
// [level, moveId] in learn order; `spawnWeight` drives the wild-spawn table
// (0 = never spawns wild — reached by evolution); `emoji` is the map marker.
/** @type {Record<string, Species>} */
export const SPECIES = {
  // Starters (Bulbasaur / Charmander / Squirtle lines)
  promptle: { name: "Promptle", types: ["code"], base: { hp: 45, atk: 49, def: 49, spe: 45, spc: 65 }, catchRate: 45, baseExp: 64, evolvesTo: "promptoid", evolveLevel: 16, learnset: [[1, "bit_bump"], [7, "regex_whip"], [13, "razor_branch"], [30, "compile_beam"]], spawnWeight: 4, emoji: "🌱" },
  promptoid: { name: "Promptoid", types: ["code"], base: { hp: 60, atk: 62, def: 63, spe: 60, spc: 80 }, catchRate: 45, baseExp: 141, evolvesTo: "promptron", evolveLevel: 32, learnset: [[1, "bit_bump"], [7, "regex_whip"], [13, "razor_branch"], [30, "compile_beam"]], spawnWeight: 0, emoji: "🌿" },
  promptron: { name: "Promptron", types: ["code"], base: { hp: 80, atk: 82, def: 83, spe: 80, spc: 100 }, catchRate: 45, baseExp: 208, learnset: [[1, "bit_bump"], [7, "regex_whip"], [13, "razor_branch"], [30, "compile_beam"]], spawnWeight: 0, emoji: "🌳" },
  cindron: { name: "Cindron", types: ["compute"], base: { hp: 39, atk: 52, def: 43, spe: 65, spc: 50 }, catchRate: 45, baseExp: 62, evolvesTo: "cindroid", evolveLevel: 16, learnset: [[1, "bit_bump"], [9, "overclock"], [24, "slice"], [38, "thermal_throttle"]], spawnWeight: 4, emoji: "🔥" },
  cindroid: { name: "Cindroid", types: ["compute"], base: { hp: 58, atk: 64, def: 58, spe: 80, spc: 65 }, catchRate: 45, baseExp: 142, evolvesTo: "pyrocessor", evolveLevel: 36, learnset: [[1, "bit_bump"], [9, "overclock"], [24, "slice"], [38, "thermal_throttle"]], spawnWeight: 0, emoji: "🔥" },
  pyrocessor: { name: "Pyrocessor", types: ["compute"], base: { hp: 78, atk: 84, def: 78, spe: 100, spc: 85 }, catchRate: 45, baseExp: 209, learnset: [[1, "bit_bump"], [9, "overclock"], [24, "slice"], [38, "thermal_throttle"], [46, "core_meltdown"]], spawnWeight: 0, emoji: "🐉" },
  streamlet: { name: "Streamlet", types: ["data"], base: { hp: 44, atk: 48, def: 65, spe: 43, spc: 50 }, catchRate: 45, baseExp: 63, evolvesTo: "torrentide", evolveLevel: 16, learnset: [[1, "bit_bump"], [8, "data_drip"], [24, "stream_burst"], [42, "firehose"]], spawnWeight: 4, emoji: "💧" },
  torrentide: { name: "Torrentide", types: ["data"], base: { hp: 59, atk: 63, def: 80, spe: 58, spc: 65 }, catchRate: 45, baseExp: 142, evolvesTo: "datalisk", evolveLevel: 36, learnset: [[1, "bit_bump"], [8, "data_drip"], [24, "stream_burst"], [42, "firehose"]], spawnWeight: 0, emoji: "🌊" },
  datalisk: { name: "Datalisk", types: ["data"], base: { hp: 79, atk: 83, def: 100, spe: 78, spc: 85 }, catchRate: 45, baseExp: 210, learnset: [[1, "bit_bump"], [8, "data_drip"], [24, "stream_burst"], [42, "firehose"]], spawnWeight: 0, emoji: "🐢" },
  // Commons / uncommons
  baudrat: { name: "Baudrat", types: ["neural"], base: { hp: 30, atk: 56, def: 35, spe: 72, spc: 25 }, catchRate: 255, baseExp: 57, evolvesTo: "gigarat", evolveLevel: 20, learnset: [[1, "bit_bump"], [7, "cache_hit"], [23, "payload_slam"]], spawnWeight: 30, emoji: "🐀" }, // Rattata
  gigarat: { name: "Gigarat", types: ["neural"], base: { hp: 55, atk: 81, def: 60, spe: 97, spc: 50 }, catchRate: 127, baseExp: 116, learnset: [[1, "bit_bump"], [7, "cache_hit"], [23, "payload_slam"], [34, "beam_burst"]], spawnWeight: 0, emoji: "🐀" }, // Raticate
  pixling: { name: "Pixling", types: ["neural"], base: { hp: 40, atk: 45, def: 40, spe: 56, spc: 35 }, catchRate: 255, baseExp: 55, evolvesTo: "pixeon", evolveLevel: 18, learnset: [[1, "bit_bump"], [5, "cache_hit"], [28, "slice"]], spawnWeight: 30, emoji: "🐦" }, // Pidgey
  pixeon: { name: "Pixeon", types: ["neural"], base: { hp: 63, atk: 60, def: 55, spe: 71, spc: 50 }, catchRate: 120, baseExp: 113, evolvesTo: "pixeot", evolveLevel: 36, learnset: [[1, "bit_bump"], [5, "cache_hit"], [28, "slice"]], spawnWeight: 0, emoji: "🐦" }, // Pidgeotto
  pixeot: { name: "Pixeot", types: ["neural"], base: { hp: 83, atk: 80, def: 75, spe: 91, spc: 70 }, catchRate: 45, baseExp: 172, learnset: [[1, "bit_bump"], [5, "cache_hit"], [28, "slice"], [44, "beam_burst"]], spawnWeight: 0, emoji: "🦅" }, // Pidgeot
  bitmouse: { name: "Bitmouse", types: ["spark"], base: { hp: 35, atk: 55, def: 30, spe: 90, spc: 50 }, catchRate: 190, baseExp: 82, evolvesTo: "voltvermin", evolveLevel: 28, learnset: [[1, "static_jolt"], [1, "cache_hit"], [26, "voltage_spike"], [43, "grid_surge"]], spawnWeight: 12, emoji: "⚡" }, // Pikachu
  voltvermin: { name: "Voltvermin", types: ["spark"], base: { hp: 60, atk: 90, def: 55, spe: 100, spc: 90 }, catchRate: 75, baseExp: 122, learnset: [[1, "static_jolt"], [1, "cache_hit"], [26, "voltage_spike"], [43, "grid_surge"]], spawnWeight: 0, emoji: "⚡" }, // Raichu
  sparkorb: { name: "Sparkorb", types: ["spark"], base: { hp: 40, atk: 30, def: 50, spe: 100, spc: 55 }, catchRate: 190, baseExp: 103, evolvesTo: "overvolt", evolveLevel: 30, learnset: [[1, "bit_bump"], [9, "static_jolt"], [29, "voltage_spike"]], spawnWeight: 12, emoji: "🔋" }, // Voltorb
  overvolt: { name: "Overvolt", types: ["spark"], base: { hp: 60, atk: 50, def: 70, spe: 140, spc: 80 }, catchRate: 60, baseExp: 150, learnset: [[1, "bit_bump"], [9, "static_jolt"], [29, "voltage_spike"], [40, "grid_surge"]], spawnWeight: 0, emoji: "🔋" }, // Electrode
  psybit: { name: "Psybit", types: ["logic"], base: { hp: 25, atk: 20, def: 15, spe: 90, spc: 105 }, catchRate: 200, baseExp: 73, evolvesTo: "psybyte", evolveLevel: 16, learnset: [[1, "inference"], [27, "mind_probe"], [38, "deep_thought"]], spawnWeight: 12, emoji: "🔮" }, // Abra
  psybyte: { name: "Psybyte", types: ["logic"], base: { hp: 40, atk: 35, def: 30, spe: 105, spc: 120 }, catchRate: 100, baseExp: 145, evolvesTo: "psychip", evolveLevel: 36, learnset: [[1, "inference"], [27, "mind_probe"], [38, "deep_thought"]], spawnWeight: 0, emoji: "🔮" }, // Kadabra
  psychip: { name: "Psychip", types: ["logic"], base: { hp: 55, atk: 50, def: 45, spe: 120, spc: 135 }, catchRate: 50, baseExp: 186, learnset: [[1, "inference"], [27, "mind_probe"], [38, "deep_thought"]], spawnWeight: 0, emoji: "🧠" }, // Alakazam
  bruteling: { name: "Bruteling", types: ["adversarial"], base: { hp: 70, atk: 80, def: 50, spe: 35, spc: 35 }, catchRate: 180, baseExp: 88, evolvesTo: "brutebot", evolveLevel: 28, learnset: [[1, "jailbreak_chop"], [25, "payload_slam"], [39, "exploit_slam"]], spawnWeight: 12, emoji: "🥊" }, // Machop
  brutebot: { name: "Brutebot", types: ["adversarial"], base: { hp: 80, atk: 100, def: 70, spe: 45, spc: 50 }, catchRate: 90, baseExp: 146, evolvesTo: "brutemax", evolveLevel: 44, learnset: [[1, "jailbreak_chop"], [25, "payload_slam"], [39, "exploit_slam"]], spawnWeight: 0, emoji: "🤖" }, // Machoke
  brutemax: { name: "Brutemax", types: ["adversarial"], base: { hp: 90, atk: 130, def: 80, spe: 55, spc: 65 }, catchRate: 45, baseExp: 193, learnset: [[1, "jailbreak_chop"], [25, "payload_slam"], [39, "exploit_slam"]], spawnWeight: 0, emoji: "💪" }, // Machamp
  nullshade: { name: "Nullshade", types: ["phantom"], base: { hp: 30, atk: 35, def: 30, spe: 80, spc: 100 }, catchRate: 90, baseExp: 95, evolvesTo: "voidwraith", evolveLevel: 25, learnset: [[1, "ghost_ping"], [29, "phantom_packet"]], spawnWeight: 6, emoji: "👻" }, // Gastly
  voidwraith: { name: "Voidwraith", types: ["phantom"], base: { hp: 45, atk: 50, def: 45, spe: 95, spc: 115 }, catchRate: 90, baseExp: 126, evolvesTo: "segfright", evolveLevel: 45, learnset: [[1, "ghost_ping"], [29, "phantom_packet"], [38, "mind_probe"]], spawnWeight: 0, emoji: "👻" }, // Haunter
  segfright: { name: "Segfright", types: ["phantom"], base: { hp: 60, atk: 65, def: 60, spe: 110, spc: 130 }, catchRate: 45, baseExp: 190, learnset: [[1, "ghost_ping"], [29, "phantom_packet"], [38, "mind_probe"], [48, "deep_thought"]], spawnWeight: 0, emoji: "🎃" }, // Gengar
  kernelhound: { name: "Kernelhound", types: ["compute"], base: { hp: 55, atk: 70, def: 45, spe: 60, spc: 50 }, catchRate: 190, baseExp: 91, evolvesTo: "daemonhound", evolveLevel: 33, learnset: [[1, "bit_bump"], [18, "overclock"], [50, "thermal_throttle"]], spawnWeight: 12, emoji: "🐕" }, // Growlithe
  daemonhound: { name: "Daemonhound", types: ["compute"], base: { hp: 90, atk: 110, def: 80, spe: 95, spc: 80 }, catchRate: 75, baseExp: 213, learnset: [[1, "bit_bump"], [18, "overclock"], [45, "thermal_throttle"]], spawnWeight: 0, emoji: "🐺" }, // Arcanine
  floppish: { name: "Floppish", types: ["data"], base: { hp: 20, atk: 10, def: 55, spe: 80, spc: 20 }, catchRate: 255, baseExp: 20, evolvesTo: "terabyss", evolveLevel: 20, learnset: [[1, "bit_bump"]], spawnWeight: 30, emoji: "🐟" }, // Magikarp (given Tackle at 1 so it can act)
  terabyss: { name: "Terabyss", types: ["data"], base: { hp: 95, atk: 125, def: 79, spe: 81, spc: 100 }, catchRate: 45, baseExp: 214, learnset: [[1, "bit_bump"], [20, "stream_burst"], [32, "data_flood"], [52, "firehose"]], spawnWeight: 0, emoji: "🐉" }, // Gyarados
  singularion: { name: "Singularion", types: ["logic"], base: { hp: 106, atk: 110, def: 90, spe: 130, spc: 154 }, catchRate: 3, baseExp: 220, learnset: [[1, "inference"], [30, "mind_probe"], [45, "deep_thought"], [60, "beam_burst"]], spawnWeight: 1, emoji: "🌌" }, // Mewtwo
};

export const STARTERS = ["promptle", "cindron", "streamlet"];

// Balls: Gen 1's capture parameters — [random ceiling, HP-factor divisor].
/** @type {Record<string, {name: string, ceiling: number, factor: number}>} */
export const BALLS = {
  tokeball: { name: "Tokeball", ceiling: 255, factor: 12 }, // Poké Ball
  megaball: { name: "Megaball", ceiling: 200, factor: 8 }, // Great Ball
  hyperball: { name: "Hyperball", ceiling: 150, factor: 12 }, // Ultra Ball
};

/** @type {Record<string, {name: string, heal?: number, revive?: boolean}>} */
export const HEAL_ITEMS = {
  potion: { name: "Patch", heal: 20 }, // Potion
  superpotion: { name: "Hotfix", heal: 50 }, // Super Potion
  revive: { name: "Reboot", revive: true }, // Revive (half max HP)
};

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

// Item-cache table: [item id, count, weight].
/** @type {Array<[string, number, number]>} */
const ITEM_DROPS = [
  ["tokeball", 3, 40],
  ["tokeball", 5, 15],
  ["megaball", 2, 15],
  ["hyperball", 1, 6],
  ["potion", 2, 14],
  ["superpotion", 1, 6],
  ["revive", 1, 4],
];

export const VILLAINS = ["Bit Rot", "Sir Overfit", "Null Pointer", "The Hallucinator", "Captain Dropout", "Prompt Injector", "Baron von Bug", "Glitchlord"];

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

/** @type {Array<[string, number]>} */
const SPAWN_TABLE = Object.entries(SPECIES)
  .filter(([, s]) => s.spawnWeight > 0)
  .map(([id, s]) => [id, s.spawnWeight]);

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
