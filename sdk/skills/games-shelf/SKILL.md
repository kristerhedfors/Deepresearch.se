---
name: games-shelf
description: >-
  Load when giving a generated agent pair a GAMES SHELF — the smallest,
  clearest demonstration of the pair's registry-seam pattern: one declarative
  entry per game (id/name/emoji/tagline/path/available(env)/handle), a shelf
  endpoint the account panel renders dynamically, and subpath dispatch, so
  adding an entire game touches NO shelf code — or when adding a new game to
  an existing pair. Covers the pure-core/API/client split with ALL rules
  server-side and anti-cheat view projections, the no-invented-game-logic
  rule (adopt documented mechanics verbatim so correctness is checkable
  against published values), deterministic seeded spawning per (geocell, time
  bucket), and the degrade-cleanly posture when the game's backing store is
  absent. This module exists in the SDK as the worked example of "add a whole
  product surface through one registry entry".
---

# Games shelf — the registry seam, demonstrated end to end

Give the server tier a games subsystem whose entire integration surface is
ONE declarative registry entry per game. The module earns its place in an SDK
not because a research assistant needs games, but because it is the cleanest
worked example of the pair's recurring architectural move: a declarative
registry + one dispatch function, with everything outside the registry
game-agnostic — the same seam shape the pair uses for LLM providers,
research sources, and enrichments. Build this once and every future "add a
whole product surface" decision has a template: registry entry in, zero
changes to the shell that hosts it.

## Capability class & tier story

**Class S — server-backed, honestly server-only.** Games need accounts
(saves keyed to an identity), a database, and — critically —
server-authoritative rules: the server re-derives world state and resolves
every action, and the client only presents. That combination has no
client-tier form (a client-side game could be trivially cheated and has no
cross-device save), so the tier story is one-sided by design: the shelf
lives in the server tier's account panel, game pages are authed like the
rest of the app, and the client tier does not carry the module at all.

## Contracts

- **PA-5, sharpened into the no-invented-game-logic rule** — never invent
  mechanics or hand-tune balance. Adopt a DOCUMENTED, proven ruleset
  verbatim (the reference lifts Pokémon Generation 1 formulas 1:1 under a
  renamed skin: stat/damage/catch/escape formulas, XP curves, the official
  type chart renamed one-to-one, species stats copied from documented
  species with each entry's comment naming its source). The payoff is
  checkability: every constant traces to a published value, so unit tests
  assert against hand-computed known answers instead of taste. The same
  contract's minimal-deps half: no runtime dependencies (the reference's
  map is a ~150-line dependency-free slippy-tile renderer).
- **PA-2** — a game whose backing is absent degrades cleanly: the shelf
  shows the row DISABLED with human-readable `requires` text
  (explain-don't-hide), and the game's own endpoints return clear 503s,
  never crashes — dispatch does not block on availability.
- **PA-4** — location-flavored games send the minimum outbound (a
  coordinate for a lookup, never identity or conversation), ride the same
  per-user opt-in knobs as the pair's other integrations, and the
  anti-cheat projections double as privacy projections: hidden server
  state never reaches the client.
- **PA-6** — any text-command grammar the game accepts carries all
  supported languages with the same breadth and a parity suite, and reply
  language follows the command's language, derived from the SAME token sets
  the grammar matches (so it cannot drift).
- **PA-7 (the convention, not the class)** — game RULES live in a pure,
  I/O-free, Node-tested core; every random draw takes an injected RNG so
  outcomes are testable and spawns re-derivable.
- **PA-10** — pure cores are unit-tested against published values; anything
  touching the database or live map/imagery providers is verified live.

## Build plan

1. **The registry module.** One declarative array of game entries plus one
   dispatch handler; everything else in the file is game-agnostic. The
   entry contract:
   - `id` — the URL segment (`/api/games/<id>/*`, and by convention the
     static page at `games/<id>/`)
   - `name` / `emoji` / `tagline` / `description` — what the shelf renders
   - `path` — the game page the shelf links to
   - `available(env)` — can THIS server run it (missing binding → disabled
     row), plus `requires` — the human-readable reason
   - `handle(request, env, url, log, identity, subpath)` — the game's API
     handler, `subpath` pre-stripped, identity already resolved by the
     pair's gate.
2. **The two dispatch faces.** `GET /api/games` returns the shelf payload —
   a projection of every entry (id, name, emoji, tagline, description,
   path, availability, requires) that NEVER includes the handler.
   `/api/games/<id>/<sub>` finds the entry and calls its `handle` with the
   stripped subpath; unknown id → 404. Auth happened upstream in the
   entrypoint's identity gate — the dispatcher never re-checks.
3. **The shelf client.** The account panel's Games view fetches the shelf
   endpoint and renders rows dynamically — enabled rows link to `path`,
   unavailable rows render disabled with the `requires` text. This is the
   whole point: registering a game is ALL it takes to appear here.
4. **The game's pure rules core.** One module, no I/O, fully Node-tested:
   the adopted formulas, a seeded RNG (`hashSeed`/`seededRng` — everything
   random takes an injected rng), spawn generation, the turn engine
   (actions return an ordered EVENT LIST the client plays back), and save
   shape (new/normalize). Split static DATA tables (species, moves, items,
   type chart, spawn tables) into a sibling module re-exported through the
   core so consumers see one surface — the provenance rule applies to every
   value in it.
5. **Deterministic seeded spawning.** Spawns derive from (geocell, time
   bucket) through the seeded RNG, so the world is consistent for all
   observers without storing it: a spawn id encodes its derivation
   (`cell:x:y:bucket:index`) and the server RE-DERIVES the spawn from the
   id on every interaction rather than trusting the client. Consuming a
   spawn is one `usedSpawns[id] = expiry` entry, pruned on load. Scale
   difficulty per player (a level cap from the player's own save) —
   re-derivation must then use the SAME save's cap.
6. **The API handler.** Persistence in the game's own table added to the
   pair's lazy schema (one JSON save row per user); position claims pass a
   proximity check only; battles/turns resolve ENTIRELY server-side (one
   POST per turn; the in-progress battle lives in the save row so a reload
   resumes it); no database → every endpoint 503s and the page explains
   itself.
7. **Anti-cheat view projections.** Every response passes through explicit
   projection functions (`publicSave` / `publicBattle` / `publicCreature`)
   that strip hidden state — opponent stats/IVs/moves, the foe roster,
   spawn tables — so the client can render but never peek. Unit-test that
   the hidden fields never appear in projected output; this boundary is
   the module's second reason to exist in the SDK (the pattern generalizes
   to any server-authoritative feature).
8. **The static page.** A standalone authed page under the games path:
   presentation only — map/scene rendering, input, and playing back the
   server's event lists. Any per-page platform permission (the reference
   grants `geolocation=(self)` in the site-wide Permissions-Policy for the
   game page) is declared site-wide, deliberately, with a comment saying
   which feature owns it.
9. **Optional integration hooks.** If the game touches the pair's paid
   integrations (street imagery, place search), ride the EXISTING per-user
   knobs and edge caches, return structured `{available:false, reason}`
   objects the page explains — never an error — and bill-shield with
   caching keyed on deliberate view changes, never on sensor jitter.
10. **Prove the seam.** The registry's acceptance is a SECOND registered
    game (even a stub) appearing on the shelf with zero client changes —
    keep that test as the seam's guard.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Registry + dispatch (the whole seam) | `src/games.js` (`GAMES`, `handleGames`) |
| Shelf client (dynamic rows from `GET /api/games`) | `public/js/account.js` (Games view, `loadGamesView`) |
| Pure rules core (Gen-1 formulas, seeded RNG, battle engine, projections) | `src/tokemon.js` (+ `src/tokemon.test.js`) |
| Static data tables (provenance-commented) | `src/tokemon-data.js` |
| API handler (D1 saves, re-derived spawns, proximity, server battles, 503s) | `src/tokemon-api.js` |
| Bilingual command grammar + geodesy + AR projection (pure) | `src/tokemon-nav.js` (+ `.test.js`, parity suite) |
| Game page (dependency-free map, movement, battle playback) | `public/games/tokemon/` (`js/map.js`, `js/game.js`, `js/street.js`, `js/battle.js`, `js/api.js`) |
| Lazy schema home | `src/db.js` (`tokemon_saves`) |
| Registry unit suite (entry shape, dispatch, no-DB degrade) | `src/games.test.js` |
| Street-imagery integration + edge cache | `src/googlemaps.js` (knob-gated POV capture) |
| Adding-a-game checklist | `.claude/skills/tokemon-game/SKILL.md` |

## Acceptance checklist

- [ ] Registry suite green: entry shape, shelf payload projection (no
      handler leaks), subpath dispatch, unknown-game 404, no-DB degrade.
- [ ] A second registered game (stub is fine) appears on the shelf with
      ZERO changes outside its own modules + one registry entry.
- [ ] Rules core green against PUBLISHED values: formulas checked with
      hand-computed answers, type-chart parity vs the documented matchups,
      spawn determinism + bucket scoping.
- [ ] Projection tests prove hidden state (foe internals, roster, IVs)
      never appears in any client-facing payload.
- [ ] Command grammar (if any) passes its language-parity suite; replies
      follow the command's language.
- [ ] Backing store absent ⇒ shelf row disabled with `requires` text AND
      the game's endpoints 503 with a clear message (verified, not
      assumed).
- [ ] Live: a save round-trips, a spawn re-derives identically on
      interaction, a battle resolves server-side and replays client-side.

## Pitfalls

- **`hidden` loses to any explicit `display`.** The reference's battle
  overlay set `display:flex`, which beats the UA's `[hidden]{display:none}`
  — the EMPTY overlay permanently covered the whole game on first ship.
  Every hidden-toggled element that sets its own display needs an explicit
  `#el[hidden]{display:none}` companion (and iOS Safari needs
  `-webkit-backdrop-filter` for glass blur).
- **WebKit drops content positioned past ~2^24 px.** World-pixel
  coordinates at city zoom exceed 16.7M px; iOS Safari silently dropped
  every tile image positioned there while composited markers survived
  ("blank map, floating markers"). Use a FLOATING ORIGIN — position
  relative to a nearby integer tile origin, re-anchor on drift — never
  absolute world pixels.
- **Trust nothing positional from the client.** Spawns are re-derived from
  the id server-side; positions only pass a proximity check; battles
  resolve server-side. The moment a payload carries authoritative state
  from the client, the game is a cheat surface.
- **Don't hand-tune numbers.** New species/moves copy a documented
  original's stats and note the mapping in a comment — the reference's
  every entry names its source. Invented balance is untestable and
  unmaintainable.
- **Permissions-Policy edits look like cleanup.** The reference's
  `geolocation=(self)` exists FOR the game page; a security-minded pass
  once nearly "fixed" it back to `()`. Comment which feature owns each
  grant.
- **Billed imagery needs deliberate-change caching.** Scene frames are
  billed per view; cache at the edge and refetch only on deliberate
  changes (mode open, turns, commands, arrival) — never on GPS jitter.
- **Level-scaled worlds must re-derive with the same scale.** The same
  cell shows different spawn levels per player (capped by their save);
  re-derivation with a different save's cap silently mismatches the
  encounter the client saw.
