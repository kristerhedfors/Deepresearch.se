// Tests for the Tokemon game core (src/tokemon.js). The mechanics are
// Pokémon Gen 1 by design, so several tests assert against independently
// known values of those formulas rather than against the implementation.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyBattleAction,
  awardXp,
  BALLS,
  catchCheck,
  cellSpawns,
  computeDamage,
  escapeCheck,
  hashSeed,
  haversineM,
  HEAL_ITEMS,
  levelCapFor,
  levelFromXp,
  makeCreature,
  MOVES,
  movesAtLevel,
  newSave,
  newVillainBattle,
  newWildBattle,
  normalizeSave,
  promoteForLevel,
  seededRng,
  SPECIES,
  spawnById,
  spawnsAround,
  STARTERS,
  statsFor,
  typeMultiplier,
  TYPES,
  xpForLevel,
  xpGain,
} from "./tokemon.js";

const NOW = 1_750_000_000_000;

// A creature with fixed IVs for deterministic assertions.
function fixedCreature(species, level, iv = 8) {
  const ivs = { hp: iv, atk: iv, def: iv, spe: iv, spc: iv };
  const { maxHp } = statsFor(species, level, ivs);
  return {
    uid: `t-${species}-${level}`,
    species,
    level,
    xp: xpForLevel(level),
    ivs,
    hp: maxHp,
    moves: movesAtLevel(species, level),
    caughtAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Catalog integrity

test("every species is well-formed and learnset moves exist", () => {
  for (const [id, s] of Object.entries(SPECIES)) {
    assert.ok(s.name, id);
    assert.ok(s.types.every((t) => TYPES.includes(t)), `${id} types`);
    for (const k of ["hp", "atk", "def", "spe", "spc"]) {
      assert.ok(Number.isInteger(s.base[k]) && s.base[k] > 0, `${id} base.${k}`);
    }
    assert.ok(s.catchRate >= 1 && s.catchRate <= 255, `${id} catchRate`);
    assert.ok(s.baseExp > 0, `${id} baseExp`);
    assert.ok(s.learnset.length >= 1, `${id} learnset`);
    for (const [lvl, move] of s.learnset) {
      assert.ok(lvl >= 1 && MOVES[move], `${id} learnset ${move}`);
    }
    if (s.evolvesTo) {
      assert.ok(SPECIES[s.evolvesTo], `${id} evolvesTo`);
      assert.ok(s.evolveLevel > 1, `${id} evolveLevel`);
    }
  }
  for (const starter of STARTERS) assert.ok(SPECIES[starter]);
});

test("every move has valid stats and a real type", () => {
  for (const [id, m] of Object.entries(MOVES)) {
    assert.ok(TYPES.includes(m.type), id);
    assert.ok(m.power > 0 && m.acc > 0 && m.acc <= 100 && m.pp > 0, id);
  }
});

// ---------------------------------------------------------------------------
// Type chart — spot-check against the official matchups (renamed 1:1:
// compute=Fire, data=Water, code=Grass, spark=Electric, logic=Psychic,
// adversarial=Fighting, phantom=Ghost, neural=Normal).

test("type chart matches the official matchups", () => {
  assert.equal(typeMultiplier("compute", ["code"]), 2); // Fire → Grass
  assert.equal(typeMultiplier("compute", ["data"]), 0.5); // Fire → Water
  assert.equal(typeMultiplier("data", ["compute"]), 2); // Water → Fire
  assert.equal(typeMultiplier("spark", ["data"]), 2); // Electric → Water
  assert.equal(typeMultiplier("spark", ["spark"]), 0.5); // Electric → Electric
  assert.equal(typeMultiplier("neural", ["phantom"]), 0); // Normal → Ghost
  assert.equal(typeMultiplier("adversarial", ["phantom"]), 0); // Fighting → Ghost
  assert.equal(typeMultiplier("phantom", ["neural"]), 0); // Ghost → Normal
  assert.equal(typeMultiplier("phantom", ["logic"]), 2); // Ghost → Psychic (Gen 2 fix)
  assert.equal(typeMultiplier("adversarial", ["neural"]), 2); // Fighting → Normal
  assert.equal(typeMultiplier("logic", ["adversarial"]), 2); // Psychic → Fighting
  assert.equal(typeMultiplier("logic", ["logic"]), 0.5);
  assert.equal(typeMultiplier("neural", ["neural"]), 1);
});

// ---------------------------------------------------------------------------
// Stats & XP — Gen 1 formulas with hand-computed expected values.

test("statsFor implements the Gen 1 formulas", () => {
  // Cindron (Charmander base stats 39/52/43/65/50), level 10, all IVs 8:
  // HP  = floor((39+8)*2*10/100) + 10 + 10 = 9 + 20 = 29
  // Atk = floor((52+8)*2*10/100) + 5 = 12 + 5 = 17
  const s = statsFor("cindron", 10, { hp: 8, atk: 8, def: 8, spe: 8, spc: 8 });
  assert.equal(s.maxHp, 29);
  assert.equal(s.atk, 17);
  assert.equal(s.def, Math.floor(((43 + 8) * 2 * 10) / 100) + 5);
  assert.equal(s.spe, Math.floor(((65 + 8) * 2 * 10) / 100) + 5);
  assert.equal(s.spc, Math.floor(((50 + 8) * 2 * 10) / 100) + 5);
});

test("medium-fast XP curve is cubic and levelFromXp inverts it", () => {
  assert.equal(xpForLevel(10), 1000);
  assert.equal(levelFromXp(999), 9);
  assert.equal(levelFromXp(1000), 10);
  assert.equal(levelFromXp(0), 1);
  assert.equal(levelFromXp(10 ** 9), 100); // capped
});

test("xpGain is Gen 1's base·level/7", () => {
  // Baudrat maps to Rattata (baseExp 57): level 14 → floor(57*14/7) = 114.
  assert.equal(xpGain("baudrat", 14), 114);
});

// ---------------------------------------------------------------------------
// Damage

test("computeDamage follows the Gen 1 pipeline (STAB, effectiveness, random range)", () => {
  const attacker = fixedCreature("cindron", 20);
  const defender = fixedCreature("promptle", 20); // code (Grass): weak to compute
  // Force no crit, max random factor: rng yields crit-roll then random byte.
  const rigged = (() => {
    const seq = [0.999, 0.999]; // no crit (0.999 > critChance), random byte = 255
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)];
  })();
  const { dmg, mult, crit, stab } = computeDamage(attacker, defender, "overclock", rigged);
  assert.equal(mult, 2);
  assert.equal(crit, false);
  assert.equal(stab, true);
  // Hand computation: L=20 → levelTerm = floor(40/5)+2 = 10. A=spc attacker
  // = floor((50+8)*2*20/100)+5 = 28. D=spc defender = floor((65+8)*2*20/100)+5 = 34.
  // base = floor(floor(10*40*28/34)/50) = floor(329/50) = 6; +2 = 8.
  // STAB → 12; ×2 → 24; random 255/255 → 24.
  assert.equal(dmg, 24);
});

test("type immunity yields zero damage", () => {
  const attacker = fixedCreature("baudrat", 20); // neural
  const defender = fixedCreature("nullshade", 20); // phantom
  const rng = seededRng(1);
  const { dmg, mult } = computeDamage(attacker, defender, "bit_bump", rng);
  assert.equal(mult, 0);
  assert.equal(dmg, 0);
});

test("damage is never below 1 for a connecting effective move", () => {
  const attacker = fixedCreature("floppish", 2);
  const defender = fixedCreature("datalisk", 60);
  const rng = seededRng(42);
  for (let i = 0; i < 50; i++) {
    const { dmg } = computeDamage(attacker, defender, "bit_bump", rng);
    assert.ok(dmg >= 1);
  }
});

// ---------------------------------------------------------------------------
// Catching & fleeing

test("catchCheck: rate-255 species at 1 HP is caught overwhelmingly often", () => {
  const rng = seededRng(7);
  const { maxHp } = statsFor("baudrat", 10, { hp: 8, atk: 8, def: 8, spe: 8, spc: 8 });
  let caught = 0;
  for (let i = 0; i < 500; i++) if (catchCheck("baudrat", 1, maxHp, "tokeball", rng)) caught++;
  assert.ok(caught > 450, `caught ${caught}/500`);
});

test("catchCheck: rate-3 legendary at full HP almost never falls to a Tokeball", () => {
  const rng = seededRng(7);
  const { maxHp } = statsFor("singularion", 40, { hp: 8, atk: 8, def: 8, spe: 8, spc: 8 });
  let caught = 0;
  for (let i = 0; i < 500; i++) if (catchCheck("singularion", maxHp, maxHp, "tokeball", rng)) caught++;
  assert.ok(caught < 15, `caught ${caught}/500`);
});

test("better balls catch strictly more over many trials", () => {
  const { maxHp } = statsFor("bitmouse", 15, { hp: 8, atk: 8, def: 8, spe: 8, spc: 8 });
  const trials = (ball) => {
    const rng = seededRng(99);
    let n = 0;
    for (let i = 0; i < 2000; i++) if (catchCheck("bitmouse", Math.floor(maxHp / 2), maxHp, ball, rng)) n++;
    return n;
  };
  assert.ok(trials("hyperball") > trials("tokeball"), "hyperball > tokeball");
});

test("escapeCheck is certain when fast enough or after enough attempts", () => {
  const rng = seededRng(1);
  assert.equal(escapeCheck(200, 3, 1, rng), true); // foe spe/4 = 0 → auto escape
  assert.equal(escapeCheck(200, 50, 1, rng), true); // F = 200*32/12+30 > 255
  // A slow creature against a fast foe sometimes fails.
  let failed = 0;
  for (let i = 0; i < 200; i++) if (!escapeCheck(10, 200, 1, rng)) failed++;
  assert.ok(failed > 0);
});

// ---------------------------------------------------------------------------
// Spawning

test("cellSpawns is deterministic and bucket-scoped", () => {
  // Cell 101:200 is known-nonempty at NOW (creature + item).
  const a = cellSpawns(101, 200, NOW, 20);
  const b = cellSpawns(101, 200, NOW, 20);
  assert.deepEqual(a, b);
  assert.ok(a.some((s) => s.kind === "creature"));
  // Spawn ids embed the bucket, so the next bucket's set never overlaps.
  const c = cellSpawns(101, 200, NOW + 15 * 60 * 1000, 20);
  const aIds = new Set(a.map((s) => s.id));
  assert.ok(c.every((s) => s.kind === "villain" || !aIds.has(s.id)));
});

test("spawnsAround covers a 5×5 cell grid and spawnById re-derives entries", () => {
  const spawns = spawnsAround(59.3293, 18.0686, NOW, 20); // Stockholm
  assert.ok(spawns.length > 0, "some spawns in 25 cells");
  for (const s of spawns) {
    const again = spawnById(s.id, NOW, 20);
    assert.ok(again, s.id);
    assert.deepEqual(again, s);
  }
});

test("spawnById rejects garbage and foreign buckets", () => {
  assert.equal(spawnById("nonsense", NOW, 20), null);
  assert.equal(spawnById("c:1:2:99999:0", NOW, 20), null);
  assert.equal(spawnById(null, NOW, 20), null);
});

test("wild spawn levels respect the player-scaled cap", () => {
  for (let cx = 0; cx < 40; cx++) {
    for (const s of cellSpawns(cx, 5, NOW, 12)) {
      if (s.kind === "creature") assert.ok(s.level >= 2 && s.level <= 12, `${s.level}`);
    }
  }
});

test("promoteForLevel walks the evolution chain by level", () => {
  assert.equal(promoteForLevel("baudrat", 5), "baudrat");
  assert.equal(promoteForLevel("baudrat", 20), "gigarat");
  assert.equal(promoteForLevel("pixling", 40), "pixeot");
  assert.equal(promoteForLevel("floppish", 19), "floppish");
});

test("haversineM measures real-world distances", () => {
  // One CELL_DEG of latitude ≈ 167 m.
  const d = haversineM(59, 18, 59.0015, 18);
  assert.ok(d > 160 && d < 175, `${d}`);
});

// ---------------------------------------------------------------------------
// Save state

test("newSave/normalizeSave round-trip and tolerate garbage", () => {
  const fresh = newSave(NOW);
  assert.equal(fresh.items.tokeball, 15);
  const round = normalizeSave(JSON.stringify(fresh), NOW + 1);
  assert.equal(round.items.tokeball, 15);
  assert.deepEqual(normalizeSave("not json", NOW).party, []);
  assert.deepEqual(normalizeSave(null, NOW).items, fresh.items);
  // Expired used-spawn markers are pruned; live ones kept.
  const s = newSave(NOW);
  s.usedSpawns = { old: NOW - 1000, live: NOW + 1000, junk: "x" };
  const n = normalizeSave(JSON.stringify(s), NOW);
  assert.deepEqual(Object.keys(n.usedSpawns), ["live"]);
});

test("levelCapFor floors at 6 and tracks the strongest party member", () => {
  const save = newSave(NOW);
  assert.equal(levelCapFor(save), 6);
  save.party.push(fixedCreature("cindron", 30));
  assert.equal(levelCapFor(save), 33);
  save.party.push(fixedCreature("baudrat", 90));
  assert.equal(levelCapFor(save), 55); // capped
});

// ---------------------------------------------------------------------------
// Battle engine

function saveWithParty(...creatures) {
  const save = newSave(NOW);
  save.starter = "cindron";
  save.party.push(...creatures);
  return save;
}

function wildSpawn(species, level) {
  return { id: `c:1:2:${Math.floor(NOW / (15 * 60 * 1000))}:0`, kind: "creature", species, level, lat: 0, lng: 0, expiresAt: NOW + 1 };
}

test("a wild battle can be fought to a win, awarding XP", () => {
  const save = saveWithParty(fixedCreature("cindron", 25));
  const rng = seededRng(5);
  save.battle = newWildBattle(save, wildSpawn("floppish", 3), rng, NOW);
  assert.equal(save.dex.floppish.seen, 1);
  const xpBefore = save.party[0].xp;
  let guard = 0;
  let ended = null;
  while (save.battle && guard++ < 30) {
    const { events, error } = applyBattleAction(save, { type: "move", move: "overclock" }, rng, NOW);
    assert.equal(error, undefined);
    ended = events.find((e) => e.t === "end") || ended;
  }
  assert.ok(ended, "battle ended");
  assert.equal(ended.result, "won");
  assert.ok(save.party[0].xp > xpBefore, "xp gained");
  assert.equal(save.stats.battlesWon, 1);
  assert.ok(save.usedSpawns[Object.keys(save.usedSpawns)[0]] > NOW, "spawn consumed");
});

test("catching a wild creature adds it to the party and the dex", () => {
  const save = saveWithParty(fixedCreature("cindron", 20));
  const rng = seededRng(3);
  save.battle = newWildBattle(save, wildSpawn("baudrat", 3), rng, NOW);
  const balls = save.items.tokeball;
  let caught = null;
  let guard = 0;
  while (save.battle && guard++ < 50) {
    const { events, error } = applyBattleAction(save, { type: "catch", ball: "tokeball" }, rng, NOW);
    assert.equal(error, undefined);
    caught = events.find((e) => e.t === "caught") || caught;
    if (events.some((e) => e.t === "end" && e.result === "lost")) break;
  }
  assert.ok(caught, "eventually caught (rate 255)");
  assert.equal(save.party.length, 2);
  assert.equal(save.dex.baudrat.caught, 1);
  assert.ok(save.items.tokeball < balls, "balls consumed");
  assert.equal(save.stats.caught, 1);
});

test("running from a wild battle leaves the spawn re-engageable", () => {
  const save = saveWithParty(fixedCreature("cindron", 40)); // fast → escape certain
  const rng = seededRng(3);
  save.battle = newWildBattle(save, wildSpawn("floppish", 3), rng, NOW);
  const { events, error } = applyBattleAction(save, { type: "run" }, rng, NOW);
  assert.equal(error, undefined);
  assert.ok(events.some((e) => e.t === "escaped"));
  assert.equal(save.battle, null);
  assert.deepEqual(save.usedSpawns, {});
});

test("catch is refused in villain battles; run is refused too", () => {
  const save = saveWithParty(fixedCreature("cindron", 20));
  const rng = seededRng(9);
  const vspawn = { id: "v:1:2:3:0", kind: "villain", villain: "Bit Rot", tier: 2, lat: 0, lng: 0, expiresAt: NOW + 1 };
  save.battle = newVillainBattle(save, vspawn, rng, NOW);
  assert.equal(save.battle.foes.length, 2);
  assert.match(applyBattleAction(save, { type: "catch", ball: "tokeball" }, rng, NOW).error, /villain/i);
  assert.match(applyBattleAction(save, { type: "run" }, rng, NOW).error, /villain/i);
});

test("defeating a villain team pays out a reward", () => {
  const save = saveWithParty(fixedCreature("pyrocessor", 55));
  const rng = seededRng(11);
  const vspawn = { id: "v:5:6:7:0", kind: "villain", villain: "Glitchlord", tier: 1, lat: 0, lng: 0, expiresAt: NOW + 1 };
  save.battle = newVillainBattle(save, vspawn, rng, NOW);
  // Deterministic outcome: pin the generated team to a harmless foe so the
  // reward path (not battle variance) is what's under test.
  save.battle.foes = [fixedCreature("floppish", 3)];
  save.battle.foeIdx = 0;
  let reward = null;
  let guard = 0;
  while (save.battle && guard++ < 60) {
    const { events, error } = applyBattleAction(save, { type: "move", move: save.party[0].moves.find((m) => m.pp > 0).id }, rng, NOW);
    assert.equal(error, undefined);
    reward = events.find((e) => e.t === "reward") || reward;
    if (events.some((e) => e.t === "end" && e.result === "lost")) break;
  }
  assert.ok(reward, "reward paid");
  assert.ok(reward.reward.tokeball >= 3);
  assert.equal(save.stats.villainsBeaten, 1);
});

test("losing every creature ends the battle as lost", () => {
  const weak = fixedCreature("floppish", 2);
  const save = saveWithParty(weak);
  const rng = seededRng(13);
  save.battle = newWildBattle(save, wildSpawn("bruteling", 30), rng, NOW);
  let guard = 0;
  let end = null;
  while (save.battle && guard++ < 60) {
    const { events } = applyBattleAction(save, { type: "move", move: "bit_bump" }, rng, NOW);
    end = events.find((e) => e.t === "end") || end;
  }
  assert.ok(end);
  assert.equal(end.result, "lost");
  assert.equal(save.stats.battlesLost, 1);
});

test("items heal mid-battle and PP-less moves are refused", () => {
  const c = fixedCreature("cindron", 20);
  c.hp = 5;
  const save = saveWithParty(c);
  save.items.potion = 1;
  const rng = seededRng(17);
  save.battle = newWildBattle(save, wildSpawn("floppish", 3), rng, NOW);
  const { events, error } = applyBattleAction(save, { type: "item", item: "potion", uid: c.uid }, rng, NOW);
  assert.equal(error, undefined);
  const used = events.find((e) => e.t === "item_used");
  assert.ok(used && used.hp > 5);
  assert.equal(save.items.potion, 0);
  // PP exhaustion: zero out and try.
  for (const m of c.moves) m.pp = 0;
  if (save.battle) {
    const r = applyBattleAction(save, { type: "move", move: c.moves[0].id }, rng, NOW);
    assert.match(r.error, /PP/);
  }
});

test("level-ups learn moves and trigger evolution with dex bookkeeping", () => {
  const c = fixedCreature("cindron", 15);
  const save = saveWithParty(c);
  save.dex.cindron = { seen: 1, caught: 1 };
  const rng = seededRng(19);
  // A level-15 cindron beating a high-XP foe crosses 16 → evolves to cindroid.
  save.battle = newWildBattle(save, wildSpawn("floppish", 3), rng, NOW);
  save.battle.foes[0] = fixedCreature("daemonhound", 60); // baseExp 213 → big XP
  let evolved = null;
  let guard = 0;
  while (save.battle && guard++ < 200) {
    const { events } = applyBattleAction(save, { type: "move", move: c.moves.find((m) => m.pp > 0)?.id || c.moves[0].id }, rng, NOW);
    evolved = events.find((e) => e.t === "evolved") || evolved;
    if (events.some((e) => e.t === "end" && e.result === "lost")) break;
  }
  if (evolved) {
    assert.equal(evolved.from, "cindron");
    assert.equal(evolved.to, "cindroid");
    assert.equal(save.party[0].species, "cindroid");
    assert.ok(save.dex.cindroid.caught >= 1, "evolution recorded in dex");
  } else {
    // The level-60 foe may win instead — that's a legitimate outcome; the
    // deterministic evolution path is covered below.
    assert.equal(save.stats.battlesLost, 1);
  }
});

test("awardXp levels up, learns moves, and evolves deterministically", () => {
  // Direct, non-probabilistic check: a level-19 baudrat beating a level-60
  // daemonhound gains floor(213·60/7) = 1825 XP — from 6859 to 8684, which
  // crosses level 20 (8000) and evolves it to gigarat.
  const c = fixedCreature("baudrat", 19);
  const save = saveWithParty(c);
  const foe = fixedCreature("daemonhound", 60);
  const events = [];
  awardXp(save, c, foe, events);
  assert.ok(events.some((e) => e.t === "xp" && e.gained === 1825));
  assert.ok(events.some((e) => e.t === "levelup" && e.level === 20));
  assert.ok(events.some((e) => e.t === "evolved" && e.to === "gigarat"));
  assert.equal(c.species, "gigarat");
  assert.equal(c.level, 20);
  assert.ok(save.dex.gigarat.caught >= 1, "evolution recorded in dex");
  // The level-23 learnset entry (payload_slam) is NOT learned yet at 20.
  assert.ok(!c.moves.some((m) => m.id === "payload_slam"));
});

test("switching creatures consumes the turn (foe acts)", () => {
  const a = fixedCreature("cindron", 30);
  const b = fixedCreature("streamlet", 30);
  const save = saveWithParty(a, b);
  const rng = seededRng(29);
  save.battle = newWildBattle(save, wildSpawn("baudrat", 5), rng, NOW);
  assert.equal(save.battle.activeUid, a.uid);
  const { events, error } = applyBattleAction(save, { type: "switch", uid: b.uid }, rng, NOW);
  assert.equal(error, undefined);
  assert.ok(events.some((e) => e.t === "switched" && e.uid === b.uid));
  assert.equal(save.battle.activeUid, b.uid);
  assert.ok(events.some((e) => e.who === "foe"), "foe took its turn");
});

test("HEAL_ITEMS and BALLS carry the Gen 1 parameters", () => {
  assert.equal(BALLS.tokeball.ceiling, 255);
  assert.equal(BALLS.megaball.ceiling, 200);
  assert.equal(BALLS.megaball.factor, 8);
  assert.equal(BALLS.hyperball.ceiling, 150);
  assert.equal(HEAL_ITEMS.potion.heal, 20);
  assert.equal(HEAL_ITEMS.superpotion.heal, 50);
  assert.ok(HEAL_ITEMS.revive.revive);
});

test("hashSeed/seededRng are stable across calls", () => {
  assert.equal(hashSeed("tokemon:1:2:3"), hashSeed("tokemon:1:2:3"));
  const a = seededRng(hashSeed("x"));
  const b = seededRng(hashSeed("x"));
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  const c = makeCreature("cindron", 5, seededRng(1));
  const d = makeCreature("cindron", 5, seededRng(1));
  assert.deepEqual({ ...c, uid: 0 }, { ...d, uid: 0 });
});
