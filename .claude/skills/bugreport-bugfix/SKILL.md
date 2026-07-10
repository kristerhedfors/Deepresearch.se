---
name: bugreport-bugfix
description: >-
  Load when the user reports a bug as little more than a chat keyword —
  "some recent chat about X failed to do Y, fix it" — with no request id,
  no log, no repro steps. The workflow that turns a keyword into a verified
  fix: chatlogs keyword search → read the meta counters → replay the exact
  logged message through the deterministic gates → fix at the right layer
  with the verbatim message as a unit test (Swedish parity included) →
  verify. Canonical example: the Rosa Pantern street-view miss (chat_logs
  #47, 2026-07-09).
---

# Bug report by chat keyword — the keyword-to-fix workflow

## When this applies

The user says something like *"some recent chat about ‹keyword› failed to
‹do X›, see if you can fix it"*. Nothing else. Because the server keeps the
full-visibility interaction log (see the **chat-logs** skill), a keyword is
genuinely enough — this skill is the discipline that gets from keyword to
deployed fix without asking the user anything.

## The workflow

### 1. Find the interaction — search BOTH the keyword and its variants

```bash
scripts/chatlogs --q "rosa pantern"     # exact phrase, matches question OR answer
scripts/chatlogs --q "rosapantern"      # user-reported spelling variants too
scripts/chatlogs --errors               # if the report is about a failure/error
scripts/chatlogs --id 47                # the hit: full conversation + meta (JSON)
```

Search every spelling the report offers (and case/diacritic variants —
`--q` is a literal substring match). If nothing matches, the chat may have
been incognito (never logged — tell the user that honestly) or phrased
differently: try distinctive fragments of what the ANSWER would contain.
Also pull neighbors (`--params "user=N&limit=30"`) — follow-up turns from
the same user often show what they tried next, and whether a retry worked.

### 2. Read the row like a flight recorder

The list row + `--id` view answer most diagnostic questions before any code
is read:

- **`META` counters name the phase that didn't run.** `google_maps: 0`,
  `shodan_hosts: 0`, `queries: []` — a zero/empty where the user expected
  activity localizes the bug to that enrichment/phase gate. In #47 the
  question was visual ("what's the color of the building across the road
  from ”Rosa Pantern”") and `google_maps: 0` said the Maps enrichment never
  fired.
- **The answer text is evidence too** — but of the MODEL's view, not the
  truth. "Enable the feature in Settings" in an answer does NOT mean the
  knob was off: the known failure mode (LEGO offices 2026-07-08, Rosa
  Pantern 2026-07-09) is a gate miss producing NO context block, whereupon
  the model invents enable-instructions from the system prompt's feature
  list. Never close a report as "feature was off" on the answer's say-so.
- **`request_id`** correlates with Workers Logs (`(ref …)`, `wrangler
  tail`) when server-side errors need the other half of the story — see
  the **live-verify** skill.
- **`status`** distinguishes error/disconnect bugs from wrong-behavior bugs.

### 3. Replay the EXACT logged message through the deterministic gates

Most "it didn't trigger" bugs here live in the deterministic intent gates
(`src/googlemaps-text.js`, `src/quiz.js`, `src/shodan.js` target
extraction), because the LLM phases are language-tolerant and the regexes
are not. Trace the verbatim question — copied character-for-character from
the log, typographic quotes (`”…”`), typos and all — through the gate
chain by hand or with a quick `node -e` probe:

```bash
node -e "import('./src/googlemaps-text.js').then(m =>
  console.log(m.pickLookup([{role:'user',content:'<paste the logged Q verbatim>'}], [])))"
```

The verbatim detail matters: #47 failed precisely because the message
named a *place* in Unicode quotes with no street address and no literal
"street view" keyword — every paraphrase you invent risks not reproducing
that. Then confirm the knob/config state the code would have seen
(`src/settings.js` defaults; the admin API does not expose per-user
settings_json, so when the knob state is unknowable, fix the gate so the
knob-ON case works AND the knob-OFF answer stays honest — the gate fix is
required under either assumption if the trace shows a miss).

### 4. Fix at the layer the trace names, not where the symptom appeared

- Gate misses → extend the deterministic extraction/gate (this is where
  #47 was fixed: `extractNamedPlaceQuery` + a `pickLookup` branch).
- Wrong data / API errors → the client module (`googlemaps.js`, `exa.js`…),
  usually needs a live probe (**integrations** skill).
- Model-specific misbehavior → evidence first, then `model-profiles.js`
  (**model-eval** skill).

House rules that bind every such fix: helper phases stay fail-soft; NO
function calling in the pipeline; **Swedish parity in every gate you touch,
with a parity test in the same change** (CLAUDE.md invariant 6).

### 5. The verbatim message becomes a unit test

Paste the logged question — unedited — into the relevant `*.test.js` with a
comment citing the chat_logs id and date, plus the negative cases that keep
the new gate from overfiring (the near-miss phrasings that must NOT
trigger) and the Swedish sibling. This is the regression contract: the next
keyword report should never be about the same message shape. `npm test`
must be fully green.

### 6. Verify and close the loop

Deploy per the **deploy** skill, then verify live: re-ask the logged
question against production and check the new behavior end-to-end (for
gated features the break-glass account needs the knob on), or at minimum
confirm via a fresh `scripts/chatlogs` row that the expected phase now
fires (`google_maps: 1`, …). Report back what the bug was, citing the
chat_logs id, so the user can confirm it matches the chat they meant.

## Case ledger

- **#47 (2026-07-09, "rosa pantern")** — visual question about a named
  restaurant in Unicode quotes, no address, no "street view" keyword →
  no extraction path fired → no Maps block → model invented
  enable-instructions. Fixed with `extractNamedPlaceQuery`
  (quoted/cued/place-type-word names + locality, gated on visual flavor)
  in `googlemaps-text.js`; tests cite the verbatim message.
- **#192–#193 (2026-07-10, Enköping→Stockholm journey)** — mid-journey
  "Go on to stockholm central station" matched no gate (`maps_intent:
  "none"`; the continuation particle "on" broke `TRAVEL_TO_RE`) and got a
  train-timetable research answer; the follow-up "Street view go there"
  missed the `^`-anchored `GO_THERE_RE` (leading street-view phrase), fell
  through to `extractPlaceQuery`, and Places resolved the LITERAL text
  "go there" to "Girls Go There Salon" in Anderson, SC. Fixed in
  `googlemaps-text.js`: the on/onwards/vidare particle in `TRAVEL_TO_RE`/
  `TELEPORT_LEAD_RE` (+ "fortsätt till", "continue/carry on to" — particle
  REQUIRED for continue/carry, bare "continue to <verb>" is the English
  infinitive), an optional street-view prefix in `GO_THERE_RE`, and a
  deictic-only-remainder guard in `extractPlaceQuery` so relocation filler
  never becomes a Places query. Lesson: a deictic that survives intent-word
  stripping is a RESUME signal, not a place name.
