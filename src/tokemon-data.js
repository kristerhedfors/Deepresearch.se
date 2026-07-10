// @ts-check
// Tokemon — the game core's static DATA tables (no logic, Node-tested via
// src/tokemon.test.js through src/tokemon.js's re-exports).
//
// Design rule (explicit product decision, same as src/tokemon.js): DON'T
// invent game logic — every value here is lifted verbatim from Pokémon
// Generation 1 under an original AI/token-themed skin. Species base stats,
// catch rates and base-XP yields are copied from the documented Gen 1
// species named in each entry's comment; move power/accuracy/PP from the
// named original move; the type chart is the official matchups restricted
// to 8 types, renamed 1:1. The mechanics that CONSUME these tables (stat/
// damage/catch/escape/XP formulas, spawning, the battle engine) live in
// src/tokemon.js, which imports this module and re-exports its tables.

/**
 * The five Gen 1 stat axes (single Special stat). Doubles as the base-stat
 * block on a species and the DV/IV block on a creature (DVs are 0–15).
 * @typedef {{hp: number, atk: number, def: number, spe: number, spc: number}} StatBlock
 */

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

// ---------------------------------------------------------------------------
// Types — the official chart's matchups among 8 types, renamed 1:1.
// Gen 1 splits physical/special BY TYPE (one Special stat): Normal and
// Fighting (Neural/Adversarial) are physical; so was Ghost, but Phantom's
// signature move here is Gen 2's Shadow Ball era, so Phantom stays special
// alongside Fire/Water/Grass/Electric/Psychic — a 1-type deviation noted
// rather than hidden.
export const TYPES = ["neural", "compute", "data", "code", "spark", "logic", "adversarial", "phantom"];
export const PHYSICAL_TYPES = new Set(["neural", "adversarial"]);

// CHART[attacking][defending] — only non-1 entries listed. Values are the
// official ones (Gen 2+ chart, which fixes Ghost-vs-Psychic).
/** @type {Record<string, Record<string, number>>} */
export const CHART = {
  neural: { phantom: 0 },
  compute: { compute: 0.5, data: 0.5, code: 2 },
  data: { compute: 2, data: 0.5, code: 0.5 },
  code: { compute: 0.5, data: 2, code: 0.5 },
  spark: { data: 2, code: 0.5, spark: 0.5 },
  logic: { adversarial: 2, logic: 0.5 },
  adversarial: { neural: 2, logic: 0.5, phantom: 0 },
  phantom: { logic: 2, phantom: 2, neural: 0 },
};

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
// Spawn tables — consumed by the deterministic spawner in src/tokemon.js.

// Item-cache table: [item id, count, weight].
/** @type {Array<[string, number, number]>} */
export const ITEM_DROPS = [
  ["tokeball", 3, 40],
  ["tokeball", 5, 15],
  ["megaball", 2, 15],
  ["hyperball", 1, 6],
  ["potion", 2, 14],
  ["superpotion", 1, 6],
  ["revive", 1, 4],
];

export const VILLAINS = ["Bit Rot", "Sir Overfit", "Null Pointer", "The Hallucinator", "Captain Dropout", "Prompt Injector", "Baron von Bug", "Glitchlord"];

/** @type {Array<[string, number]>} */
export const SPAWN_TABLE = Object.entries(SPECIES)
  .filter(([, s]) => s.spawnWeight > 0)
  .map(([id, s]) => [id, s.spawnWeight]);
