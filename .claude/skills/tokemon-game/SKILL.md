---
name: tokemon-game
description: >-
  Load when working on the Tokemon game — the open-world AR
  catch-and-battle game under Games in the account panel (src/tokemon.js,
  src/tokemon-api.js, public/games/tokemon/) — adding species/moves/items,
  changing spawning or battle behavior, debugging encounters, or adding a
  NEW game to the games shelf.
---

# The Tokemon game subsystem

An open-world augmented-reality game: the player walks the real street map
(GPS or tap-to-walk), finds deterministically spawned creatures/items/villains,
catches creatures and fights turn-based battles. Reached via **account panel →
Games → Tokemon** (`/games/tokemon/`, authed like the rest of the app).

## The one design rule: no invented game logic

Every mechanic is lifted verbatim from **Pokémon Generation 1** (the explicit
product decision when the game was built — proven balance, zero tuning debt):
stat formula (DVs, no EVs), the damage pipeline with its truncation order and
217–255/255 random factor, Gen 1's physical/special split BY TYPE, critical
hits (baseSpeed/512), the Gen 1 capture algorithm, the Gen 1 escape formula,
medium-fast XP (level³) and base·L/7 wild XP. The type chart is the official
matchups restricted to 8 types renamed 1:1 (Normal→Neural, Fire→Compute,
Water→Data, Grass→Code, Electric→Spark, Psychic→Logic, Fighting→Adversarial,
Ghost→Phantom; Gen 2's corrected Ghost-vs-Psychic). Species base stats, catch
rates and base-XP yields are copied from documented Gen 1 species — every
`SPECIES` entry's comment names its source (Cindron=Charmander, …); every
move names its original (Bit Bump=Tackle, …). Spawning has no Gen 1
equivalent and follows Pokémon GO's shape instead (deterministic per geocell +
time bucket, wild levels scaled to the player's strongest creature).

**When extending: keep this rule.** New species → copy a documented species'
stats and note the mapping. New moves → copy a documented move's
power/acc/PP. Don't hand-tune numbers.

## Code layout

- `src/tokemon.js` — the PURE core (no I/O, fully Node-tested in
  `src/tokemon.test.js`): catalogs (`SPECIES`, `MOVES`, `BALLS`,
  `HEAL_ITEMS`), formulas, seeded RNG (`hashSeed`/`seededRng` — everything
  random takes an injected rng), spawn generation
  (`cellSpawns`/`spawnsAround`/`spawnById`), the battle engine
  (`applyBattleAction` returns an ordered event list), save shape
  (`newSave`/`normalizeSave`).
- `src/tokemon-api.js` — `/api/tokemon/*`: persistence (D1 `tokemon_saves`,
  one JSON row per user, table in `src/db.js`) + validation. Server-
  authoritative: spawns are RE-DERIVED from the spawn id on every
  encounter/collect (`spawnById`), positions only pass a proximity check
  (80 m), battles resolve entirely server-side, and `publicSave`/`publicFoe`
  never leak foe IVs/moves. No D1 → every endpoint 503s and the page
  explains itself.
- `public/games/tokemon/` — standalone page: `js/map.js` (a ~150-line
  dependency-free slippy map over OSM raster tiles — attribution rendered,
  light usage), `js/game.js` (movement, spawn polling every 30 s or 90 m,
  panels), `js/battle.js` (renders the server's event list), `js/api.js`.
- Entry point: the Games view in `public/js/account.js`.

## Facts that cost time to establish

- `Permissions-Policy` in `src/index.js` had `geolocation=()` — it now
  carries `geolocation=(self)` FOR the game. Don't "clean it up" back.
- Spawn ids encode their derivation (`c:cx:cy:bucket:i`) — consuming a spawn
  is just `save.usedSpawns[id] = expiry` (pruned on load); fleeing a wild
  battle deliberately does NOT consume the spawn.
- Wild spawn levels are capped by `levelCapFor(save)` (strongest party
  member + 3, floor 6, cap 55), so the same cell shows different levels to
  different players — `spawnById` must be called with the SAME save's cap.
- Battle turns are one POST each; the battle lives in the save row, so a
  reload resumes it (`state` returns it and the client reopens the overlay).
- The mock-D1 smoke pattern for the API lives in the session scratchpad
  history; the committed tests cover the pure core only, matching the
  project's unit-test stance (D1/network = live-verify).
