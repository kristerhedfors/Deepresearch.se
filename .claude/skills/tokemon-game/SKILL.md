---
name: tokemon-game
description: >-
  Load when working on the games subsystem — the src/games.js
  registry/dispatch seam, the account panel's Games shelf, or adding a NEW
  game — or on the Tokemon game itself, the open-world AR catch-and-battle
  game (src/tokemon.js, src/tokemon-api.js, public/games/tokemon/): adding
  species/moves/items, changing spawning or battle behavior, debugging
  encounters.
---

# The games subsystem & the Tokemon game

## The games registry (src/games.js) — how a game plugs in

`src/games.js` is the games counterpart of `providers.js` (LLM providers)
and `search-sources.js` (research sources): a declarative `GAMES` registry
plus one dispatch handler. Everything outside it is game-agnostic:

- `GET /api/games` → the shelf payload; the account panel's Games view
  (`public/js/account.js` `loadGamesView`) renders it dynamically —
  registering a game is ALL it takes to appear on the shelf.
- `/api/games/<id>/*` → dispatched to the entry's
  `handle(request, env, url, log, identity, subpath)` with the prefix
  stripped; auth already happened in index.js.
- `available(env)` gates on server backing (Tokemon: `!!env.DB`); an
  unavailable game is shown DISABLED on the shelf with its `requires`
  text (explain-don't-hide, like the settings rows), and its handler must
  still degrade cleanly (Tokemon 503s) since dispatch doesn't block.

**Adding a game**: (1) pure rules core in `src/<game>.js` with unit tests —
adopt an existing, documented ruleset rather than inventing balance (the
Tokemon precedent below); (2) API handler in `src/<game>-api.js` taking the
registry's `subpath`, persistence via its own D1 table added to `db.js`'s
lazy schema; (3) static page under `public/games/<id>/` (authed
automatically — not in `isPublicAsset`); (4) one `GAMES` entry; (5) registry
tests live in `src/games.test.js`, game-rule tests in the game's own test
file.

# The Tokemon game

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
  `src/tokemon.test.js`): formulas, seeded RNG (`hashSeed`/`seededRng` —
  everything random takes an injected rng), spawn generation
  (`cellSpawns`/`spawnsAround`/`spawnById`), the battle engine
  (`applyBattleAction` returns an ordered event list), save shape
  (`newSave`/`normalizeSave`).
- `src/tokemon-data.js` — the static DATA catalogs (`SPECIES`, `MOVES`,
  `BALLS`, `HEAL_ITEMS`, the renamed type chart, spawn/item-drop tables),
  re-exported through `tokemon.js` so consumers see one surface; the
  Gen-1 provenance rule above applies to every value here.
- `src/tokemon-api.js` — `/api/games/tokemon/*` (dispatched by the registry,
  which passes the stripped `subpath`): persistence (D1 `tokemon_saves`,
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
- `src/tokemon-nav.js` — the street-view mode's PURE side: the bilingual
  text-command grammar (`parseGoCommand` — EN+SV with the invariant-6
  parity suite in its test file; the `sv` reply-language flag derives from
  the SAME token sets the grammar matches on, so it can't drift), geodesy,
  and `projectSpawns` (bearing→x, distance→y/scale placement of spawns
  inside a Street View frame).
- Street-view AR mode: `GET …/scene` (free `streetViewMetadata` coverage
  probe → snap the camera to the pano's true position → billed-but-
  edge-cached `runStreetViewPovCapture` frame → overlays projected from the
  PANO position, `near` measured from the PLAYER position — the same 80 m
  the encounter check enforces) and `POST …/go` (text navigation; move/look
  are pure math and work with Maps off, "go to <place>" resolves via
  `placesTextSearch` and rides the per-user `google_maps` knob, replies
  follow the command's language). Client: `js/street.js` renders, the
  command bar in `js/game.js` drives.
- Entry point: the Games view in `public/js/account.js` (shelf from
  `GET /api/games`).

## Facts that cost time to establish

- **The `hidden` attribute loses to any explicit `display`.** `#tk-battle`
  sets `display:flex`, which beats the UA's `[hidden]{display:none}` — on
  first ship the EMPTY battle overlay (dark glass + backdrop blur)
  permanently covered the whole game (reported from an iPhone screenshot,
  2026-07-09). Every hidden-toggled element that also sets its own
  `display` needs an explicit `#el[hidden]{display:none}` companion rule.
  iOS Safari also needs `-webkit-backdrop-filter` for the glass blur.
- **WebKit drops content positioned past ~2^24 px (16.7M).** World-pixel
  coordinates at zoom 17 reach 18.4M px at Stockholm's longitude — iOS
  Safari silently dropped every tile <img> positioned there while emoji
  markers survived on composited layers ("blank map, floating markers",
  reported 2026-07-09; OSM itself served 200s). map.js therefore uses a
  FLOATING ORIGIN — everything is positioned relative to an integer tile
  origin near the viewport, re-anchored when the center drifts 30 tiles —
  so no offset ever exceeds a few thousand px. Don't reintroduce absolute
  world-pixel positioning. Verified headless via the scratchpad
  map-check harness (real Chromium: 28/28 tiles, marker mid-screen).
- Scene frames are billed per (pano, heading) but edge-cached in
  googlemaps.js; the client only refetches on deliberate changes (mode
  open, turns, commands, walk arrival — never GPS jitter). Street mode is
  knob-gated (`googleMapsEnabled`) and returns a structured
  `{available:false, reason}` the pane explains — never an error.
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
