# Video capture — recording the site, editing for sharing, reviewing by swipe

*Shipped 2026-08-10, run end to end the same day. Extended 2026-08-11 (owner
directive) into a SELF-REFILLING QUEUE OF TWENTY that replaced the try-it
queue's launcher in the chat header: twenty unanswered clips spanning all
seven agents, each numbered and named, each stamped with the commit it was
recorded at, and each able to grow a thread of successive versions when it
comes back with feedback. The pixels are verified (§8); what remains untested
is the gesture on a real touch screen.*

The working guide is the **video-capture** skill; this is the reference —
formats, endpoints, fields, and the reasoning behind the numbers.

## 1. Why this exists

Explaining what a deep-research pipeline does is hard in prose and easy on
video: the composer takes a real question, the activity bar fills with search
rounds, the answer streams with its citations. The problem is that a real run
is mostly **waiting** — ten to ninety seconds of a screen that does not move —
so an honest screen recording is unwatchable and a hand-edited one is not
reproducible.

So the recording carries its own edit decision list. The driver writes down
what was happening on screen, moment by moment; the editor turns that into
cuts and speed ramps; both halves are pure functions of that record, so the
same inputs give the same clip and a different `--speed` is a re-run rather
than a re-edit.

## 2. The four stages

```
tests/capture.mjs          scripts/capture-edit.mjs        scripts/captures      /captures/
──────────────────         ────────────────────────        ────────────────      ──────────
 browser, live      →   raw.webm + timeline.json   →   final.mp4 + edit.json  →  D1 row + R2
                        + meta.json                     + poster.jpg               ↓
                                                                              swipe right → like
                                                                              swipe left  → feedback
```

`scripts/capture-core.mjs` is the shared pure core. It holds the shape table,
the run matrix, the dead-air detector, the cut planner, the ffmpeg argv
builder and LinkedIn's limits — no filesystem, no browser, no clock, no
encoder. `scripts/capture-core.test.mjs` therefore covers the entire editing
model on a machine with no ffmpeg, which is every agent container this repo is
developed in.

`scripts/capture-guard.mjs` is the second pure core, on the recording side: the
decision about whether what was just recorded shows the product **working**
(§3.6). Same discipline, same reason — the interesting cases are a Swedish
error answer and an app that says the key is missing, and neither should need a
live re-recording to re-check.

## 3. Stage 1 — recording

`node tests/capture.mjs --agents <csv> --models <csv> [options]`
(`npm run capture -- …`).

### 3.1 The run matrix

`expandMatrix` produces one run per **agent × model × example prompt**, in
that nesting order. Agent-major means an interrupted or `--limit`ed batch
covers whole agents rather than leaving each one half-captured.

An *agent* is a chat mode. `AGENT_MODES` inverts `MODE_AGENTS` from
`public/js/starters-core.js`, so the harness routes through the same table
`/api/chat` does and the two cannot drift:

| agent | chat mode (`#modesel`) |
|---|---|
| `research` | `normal` (Deep Research) |
| `scholar` | `science` (Deep Science) |
| `introspection` | `introspection` |
| `agent-builder` | `sdk` (Agent Studio) |
| `orchestrator` | `orchestrator` |
| `outrospection` | `outrospection` |
| `models` | `models` |

The prompts come from the shipped starter queues (`public/js/starters-data.js`,
the **starter-prompts** skill), ranked entries first, wrapping rather than
running dry when more are asked for than the queue holds. `--lang sv` narrows
to the Swedish half, which exists because invariant 6 requires it to.

**Never capture a prompt taken from `chat_logs`.** The starters are synthetic
by construction for exactly this reason: a full-visibility interaction log is
not consent to put one user's question in front of an audience.

### 3.2 Shapes

| shape | recorded viewport | delivered frame | ratio |
|---|---|---|---|
| `portrait` (default) | 720 × 900 | 1080 × 1350 | 4:5 |
| `square` | 800 × 800 | 1080 × 1080 | 1:1 |
| `landscape` | 1280 × 720 | 1920 × 1080 | 16:9 |
| `raw` | 1280 × 800 | source, unscaled | — |

The recorded viewport is **smaller than the delivered frame on purpose**. A
feed video plays in a box a few centimetres wide; what decides whether a
transcript reads there is the size of the text relative to the frame, not the
pixel count. Recording 1080 CSS pixels and encoding 1:1 produces a crisp video
nobody can read, so each shape records the site in its narrow, large-type
layout and upscales with lanczos.

### 3.3 The sidecars

Each run writes `captures/<date>/<slug>/`:

**`raw.webm`** — the Playwright recording. Playwright flushes it only on
`context.close()`, so the driver closes in a `finally`; without that the file
is zero bytes.

**`timeline.json`** — the edit decision input.

```json
{
  "durationMs": 32000,
  "sampleMs": 250,
  "samples": [{ "t": 0, "sig": "3|7|5|1842|Writing report…|0" }],
  "markers": [{ "t": 1200, "id": "send", "label": "prompt sent" }]
}
```

`sig` is an opaque content signature: message count, step count, finished-step
count, the last assistant turn's text length, the last step label, and whether
`.stats` has landed. It changes when and only when something visible changed.
Markers (`open`, `send`, `first_token`, `done`, `timeout`) are for chapters
and trimming — never for cutting.

**`meta.json`** — what was run: `slug`, `agent`, `mode`, `model`, `prompt`,
`starter`, `xp`, `lang`, `name`, `shape`, `viewport`, `base`, `commit_sha`,
`deployed_digest`, `intro`, `budget_s`, `search`, `started_at`, `ended_at`,
`durationMs`, `ok`, `error`, and — for an Agent Studio run only — `app_e2e`
(§3.5). Plus what the run VERIFICATION GATE saw: `verdict`, `observed` and
`frames` (§3.6).

**`endframe.png`** and, for a run that walked to a published app,
**`chatframe.png`** — the last frame as a still. §3.6.

Three of those exist for the review queue rather than for the edit:

- **`commit_sha`** is the commit the SITE WAS SERVING, resolved once per batch.
  Without it a clip is un-reproducible — the deck outlives the code, and six
  merges later "why does this video not match the app" has no answer.

  It is deliberately **not** always the working tree's HEAD. Against a loopback
  base the local worker really is running this tree, so HEAD is exact; against
  a REMOTE base it is not, and stamping it names a commit the site has very
  likely never run. That is confident wrong provenance, which is worse than
  none because it invites someone to check out that commit to explain a clip.
  The first twenty captures were stamped that way and had to be corrected by
  hand. A remote base therefore records `origin/main` — this repo deploys main
  — and `null` rather than a guess when git is unavailable.

- **`deployed_digest`** is the fingerprint the site actually served: the
  `digest` at the head of the committed introspection snapshot, which every
  deploy rebuilds, read with a 300-byte Range request. `origin/main` is still
  only a best answer (a branch build also deploys here), so this is what makes
  a wrong `commit_sha` **detectable** rather than believed.
- **`name`** is the short human name the deck shows beside the capture's
  `#CAP-<id>` number, derived from the starter id (`res-sv-elpris` → "Elpris":
  the agent prefix and the language marker are noise, not name) so it needs no
  model call and never blocks an unattended top-up. It
  is a default: `scripts/captures --name <id> "…"` improves any one by hand.

A batch also writes `batch.json` at the root: the options used plus one row
per run.

### 3.4 No intro in a recording

A capture is about the research run, so the harness opens the site with
**`?anim=0`** — the documented inverse of the `?anim=1` that forces the intro
on (`docs/INTRO-BASELINE.md` §3) — and additionally sets the browser's
`prefers-reduced-motion`, which §3 already lists as a suppression gate for all
three intro tiers. Belt and braces on purpose: the two are independent
mechanisms, the media query works against deploys that predate the parameter,
and a recording is expensive to redo.

`--intro` opts back in, for the one combined cut that wants an intro beat.

### 3.5 Agent Studio: the capture must prove the app works

An `agent-builder` capture does not stop when the build finishes. It reads the
published `/app/<slug>/` off the build chip, **walks there and uses it while
still recording**, and grades what happens (`tests/app-e2e.mjs`). The clip
therefore shows the thing that was built actually working — and a capture whose
app FAILS is never published: it stays on disk with its verdict, because a
video of a build that does not work is a demo of a broken thing filed as if it
were a demo of a working one (owner directive, 2026-08-11).

Seven checks, each with a stable id:

| id | passes when |
|---|---|
| `app_loads` | the page loaded, has content, **and every file the build shipped arrived** |
| `no_page_errors` | nothing the app itself threw (provider/network noise filtered) |
| `key_field_masked` | every key field is masked **at every sample**. No key field at all is a pass |
| `key_not_revealed` | the sentinel is in no visible text and no attribute |
| `key_not_persisted` | the sentinel is in no storage, cookie or URL |
| `app_interactive` | there is something to type into and press, and pressing it did not throw |
| `app_answered` | pressing it produced a REPLY — new text on the page, and not an error message |

**The sentinel rule.** The key typed is `sk-FAKE-CAPTURE-SENTINEL`, never a real
one, for two reasons: it is typed WHILE RECORDING, so an unmasked field would
put it in the video — which is exactly the failure being tested for — and it is
sent to a real provider, which 401s. That 401 is expected and filtered. The
constant is deliberately 21 characters after `sk-`, because `scripts/scan-secrets`
blocks `sk-[A-Za-z0-9_-]{24,}` and a longer one stops the commit.

**Three traps, all paid for on the first live run:**

- **A module script never loads.** `<script type="module">` is fetched in CORS
  mode and `/app/<slug>/` is served into an opaque origin, so the browser
  blocks it SILENTLY: the page renders, throws nothing, and does nothing. One
  published app was inert for exactly this reason, and `app_interactive` still
  passed for it — typing and clicking "work", nothing happens — which is why
  the ASSET half of `app_loads` is the check with teeth. The build
  instructions now forbid module scripts, since a model cannot discover this
  from a failure that does not exist.
- **The checker's own probe looked like an app error.** Reading storage in an
  opaque origin throws a `SecurityError`, and `key_not_persisted`'s probe
  provokes it; Chromium reports it on the page-error channel as well, where it
  failed every app. Filtered narrowly — that one denial, not SecurityErrors in
  general.
- **The chat mode did not stick.** The `dr_chat_mode` pin makes the dropdown
  already read the wanted mode, so the harness returned satisfied and
  `/api/settings` then reverted it. That records the WRONG AGENT: an Agent
  Studio run that fell back to Deep Research prints code as prose and builds
  nothing, and the clip looks fine unless you read the composer. `selectMode`
  now holds the value and fails the run rather than recording the wrong thing.

**The fourth trap, and the one that reached the owner: pressing the button was
never the same as getting an answer.** `app_interactive` typed a question and
clicked Send and asked nothing further, so an app that answered "Error: could
not get a response." scored six green checks. Capture **#CAP-22** was published
on that verdict, and its own final frame shows the failure. `app_answered` is
the missing assertion: after send, the page must GAIN text (the prompt itself
subtracted — an app that echoes the question and answers nothing has "grown"),
and that text must not be error-shaped in either language.

One consequence is intended and worth stating plainly: **a build in
bring-your-own-key mode fails `app_answered`**, because the key it is handed is
the sentinel and the sentinel cannot buy an answer. That is not a false
positive. It is the reason hosted mode is the default the build prompts teach
(PR #426): an app that needs a key nobody has is an app whose capture shows an
error on camera, which is the clip the owner rejected. The fix is to build
hosted, not to soften the check.

**The narrowed noise filter.** `isProviderNoise` is deliberately generous,
because the sentinel is fake and its rejection fires on every run — but
"rejected" and "never arrived" are different facts. OpenAI says *"Incorrect API
key provided: sk-…"* when a key is present and wrong (the sentinel working as
designed) and *"You didn't provide an API key… in an Authorization header"*
when the header is absent or malformed. The second means the app collected a
key and failed to put it on the wire. Capture **#CAP-21** shows exactly that —
key field filled, model selected, that verbatim 401 — and passed
`no_page_errors` with the note "6 provider/network messages ignored". The
filter had swallowed the one message that was evidence. A missing-key /
malformed-authorization message is now checked FIRST and is never noise.

### 3.6 The run verification gate

Everything above is Agent Studio's. The gate in this section runs at the end of
**every** recorded run, for every agent (owner directive, 2026-08-12).

**What it replaced.** A run used to count as successful on one signal: the
`.stats` footer landing, which is how the sampler sets `done`. The server emits
that footer from a `finally` (`src/chat.js`), so it lands on **every** exit
path — after an `{error}` event included. A turn that ended in a red error
message was therefore indistinguishable from one that ended in an answer, and
nothing anywhere read the answer itself. Two clips of failing runs were handed
to the owner as good captures before anyone noticed.

**How it works.** At the end of the run the driver reads the page's end state —
the last assistant bubble's text, whether that bubble carries `.content
.error-text` (the class `setError` puts on it, `public/js/turns.js`), whether
the stats footer landed, the console, and the timeline's last content
signature — and passes it to `gradeRun` in **`scripts/capture-guard.mjs`**. That
module is pure: no filesystem, no browser, no clock, no network, no imports. It
returns `{ ok, reasons[], summary }`, naming each failure with a stable id.

| reason id | raised when |
|---|---|
| `driver_error` | the recorder already knew something failed |
| `timed_out` | the turn never finished inside `--timeout` |
| `error_state` | the answer bubble is an ERROR bubble, whatever it says |
| `error_text:*` / `answer_text:*` / `app_text:*` | an error-shaped phrase in the error bubble, the answer, or the built app's own screen |
| `empty_answer` | no answer, or under `MIN_ANSWER_CHARS` of it |
| `turn_unfinished` | the completion stats never arrived |
| `no_final_content` | the timeline's last sample is missing, unreadable, or has no assistant text in it |
| `app_e2e` | the Agent Studio app gate failed (§3.5) |
| `page_errors` | the page threw on its own account (network weather filtered) |

**Two rules the phrase list is built around.**

*Precision over reach.* A gate that fires on a good answer costs a good
recording, fires on every run, and gets switched off. So the phrases are
ERROR-SHAPED — `Error:` at the head of a line, "could not get a response",
"kunde inte få ett svar", "you didn't provide an API key" — never merely
negative. "Kunde inte" on its own is ordinary Swedish prose in a research
answer, and the hosted mode's *success* line ("no API key needed" / "ingen
API-nyckel behövs") says the opposite of a failure with nearly the same words;
both are pinned as non-matches. The one structural signal — the `error-text`
class — fails the run regardless of wording, because the product itself already
decided.

*Equal Swedish and English* (CLAUDE.md invariant 6). Every sign carries an `en`
and an `sv` pattern; `scripts/capture-guard.test.mjs` fails the build if one is
added without the other, and separately asserts that no Swedish pattern uses
`\b`, which treats å/ä/ö as non-word characters. Half the capture matrix is
`--lang sv`; an English-only gate would pass every Swedish failure.

**Full visibility.** The point is that a failure is legible without watching the
video, so every run also writes:

- **`endframe.png`** — the last frame as a still, taken before the context
  closes and therefore present on the error path too, which is the path whose
  last frame is worth the most.
- **`chatframe.png`** — for a run that then walks away from the transcript
  (Agent Studio goes to the published app), the transcript's own last frame.
- **`meta.json` → `verdict`** — `{ ok, reasons[], summary }` verbatim.
- **`meta.json` → `observed`** — the answer's head AND tail (`setError`
  *appends* its message to whatever streamed, so a head-only excerpt is exactly
  the excerpt that cannot show the error), the error text, the stats line, the
  step counts, the final URL, the first console errors, and the built app's own
  screen text.

### 3.7 Failure posture

One failing run never aborts a batch (invariant 2's posture, applied to a
harness). A run that times out keeps its video and timeline — a stalled run is
the recording most worth watching — is marked `ok: false` with a reason, and
the batch exits non-zero only if every run failed.

A run that fails the verification gate is treated the same way: **collected,
never aborted**, its footage kept on disk beside its verdict. What changes is
that it is impossible to miss. The failure is printed twice — once under the
run as it finishes, once in a block at the foot of the batch summary that names
every failed clip, every reason, and where its `endframe.png` is — because a
one-line row in a table of twenty is how a bad run gets scrolled past.

## 4. Stage 2 — the cut plan

`stillSpans(samples, {minStillMs})` returns the maximal spans over which the
signature never changed. Two decisions in it are load-bearing:

- A span **ends at the last sample known to be idle**, not at the sample where
  the change was observed. A change seen at sample *m* happened somewhere in
  `(t[m-1], t[m]]`; ending one sample early guarantees the frame where new
  content appears is never inside a cut.
- The sampler runs in **Node**, driving `page.evaluate`, not as an in-page
  timer — a frozen page cannot stop it.

`planEdit` turns those spans into an ordered segment list:

| Input | Default | Meaning |
|---|---|---|
| `minStillMs` | 1500 | Below this, a pause is reading rhythm, not dead air. |
| `holdMs` | 600 | Head of each dead span kept, so the reached state is legible. |
| `speed` | 1 | Playback multiplier where something is happening. |
| `waitMode` | `cut` | `cut` drops dead air, `speed` accelerates it, `keep` leaves it. |
| `waitSpeed` | 8 | Multiplier for `waitMode: "speed"`. |
| `minSegmentMs` | 200 | Below this a kept fragment reads as a glitch. |
| `trimStartMs` | measured | Head of the recording. Left unset it is derived — see 4.1. |
| `trimEndMs` | 0 | Extra tail to drop, on top of ending at the last content frame. |
| `endHoldMs` | 1200 | The final content frame is frozen this long — see 4.2. |
| `endAtContent` | true | End on the last frame proven to carry content, not at EOF. |

The output carries `segments`, `keptMs`, `cutMs`, `outMs`, `segmentsMs`,
`waitMs`, `headTrimMs`, `endHoldMs`, `contentEndMs`, `contentStatus` and
`tailMs`, which is what `--dry-run` renders and what `edit.json` records.
`outMs` is the finished duration INCLUDING the end hold — the bitrate cap, the
duration check and the poster offset all read it — and `segmentsMs` is the
segments alone. Contiguous segments at the same speed are fused, so the
encoder gets one trim instead of two.

Degenerate inputs are handled rather than thrown on: no timeline at all yields
one full-length segment; a recording that is entirely dead air still yields
the hold, because an empty segment list would break the filter graph.

### 4.1 The head flash — why the clip does not start at frame zero

Recording starts at `page.goto`, so the first frames are a white viewport
waiting for the site to paint. Measured 2026-08-12 with ffmpeg `signalstats`
YAVG per frame across the three published clips (CAP-20/21/22): every
near-white frame in all three sits between t=0 and ~0.65 s at YAVG 235–236,
and every tail is a static content-rich frame. **The blank frame is at the
head, not the tail.** What a reviewer reports as "the video ends blank" is the
deck's player looping — it wraps to t=0, and t=0 is the flash.

So `headTrim(timeline)` derives the head trim instead of hardcoding it. The
sampler only starts once the app is up (composer visible, model dropdown
filled), so the timeline's first entry is evidence of when there was something
to look at:

- first entry at `t > 0` → trim that offset, floored at `HEAD_FLASH.fallbackMs`
  (750 ms, so a fast first sample cannot leave a residual flash) and capped at
  `HEAD_FLASH.maxMs` (1500 ms, so a slow one cannot eat the opening beat —
  whatever empty-app time is left is dead air the cut already handles);
- first entry at `t = 0` → the head is measured, not guessed; trim nothing;
- no timeline → assume the flash and drop `fallbackMs`.

`--trim-start <ms>` overrides it, and `--trim-start 0` keeps the flash.

### 4.2 Where the clip ends, and the end hold

The recording outlives the run: the sampler stops, then Playwright closes the
context and flushes the file, and nobody chose those frames. The plan
therefore ends at the last frame that can be PROVEN to carry content
(`contentEnd`), not at `sourceMs`. `--trim-end` still applies on top; it can
only shorten. `--end-at eof` restores the raw tail.

"Content" is read out of the same signature the cuts are read out of
(`parseSignature`): a torn-down or navigated-away page reads `0|0|0|0||0`, and
a signature that does not parse as that grammar counts as content, because
footage is never dropped on the strength of a format guess. **Markers raise
the floor**: an Agent Studio capture walks to the published app, which has
none of the chat DOM the signature reads, so its samples look blank while
being the most important footage in the clip — `app_done` (and
`done`/`error`/`timeout`) keep the end from landing before it.

The **end hold** (`--end-hold`, default 1200 ms) then freezes that final frame.
Two reasons, both the owner's: a finished answer needs a beat to be read in a
feed, and the extracted last frame is how a run is judged to have succeeded or
failed, so it has to be unambiguous rather than a single frame flicking past.
`contentStatus` records which of `found` / `blank` / `unknown` the ending
rests on.

## 5. Stage 3 — the encode

One ffmpeg pass:

```
[0:v]trim=start=…:end=…,setpts=(PTS-STARTPTS)/<speed>[cN]   (one per segment)
[c0][c1]…concat=n=N:v=1:a=0[cv]
[cv]scale=W:H:force_original_aspect_ratio=decrease:flags=lanczos,
    pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,
    tpad=stop_mode=clone:stop_duration=1.200,format=yuv420p[v]
```

`tpad` is the end hold, and it comes **after** `fps`: it clones the last frame
at the stream's frame rate, and a Playwright webm is variable-rate, so holding
before normalisation can produce one very long frame instead of a second of
video. It is omitted entirely at `--end-hold 0`.

`setpts=(PTS-STARTPTS)/1` is not a no-op: `STARTPTS` must be rebased or
`concat` cannot butt the segments together. Padding rather than cropping is
deliberate — a transcript loses its meaning at the edges.

Arguments are built as an **array** and spawned without a shell, so a filter
graph full of `:`, `,`, `[` and `]` is never quoted or escaped. That is the
whole class of bug that makes an edit pipeline unreliable.

### 5.1 Encoder settings, and what each one prevents

| Setting | What breaks without it |
|---|---|
| `-c:v libx264 -profile:v high -pix_fmt yuv420p` | A 10-bit or 4:4:4 stream uploads fine and plays as a black rectangle. |
| `-movflags +faststart` | Playback waits for the full download; in a feed that reads as broken. |
| `-an` | Nothing, but a silent AAC track costs a stream on a platform that autoplays muted. |
| `-crf 21` | Default quality target. `--max-mb` adds `-maxrate`/`-bufsize` from `bitrateCapKbps`, which keeps 6% headroom for container overhead. |

### 5.2 The delivery check

`checkDelivery` holds LinkedIn's published fences — 5 GB, 10 minutes, ≥3 s,
aspect between 1:2.4 and 2.4:1, and a 1920-per-side note — plus this project's
own targets (40 MB, 90 s). It is **advisory**: `capture-edit` prints problems
and warnings and writes the file anyway, because "95 seconds against a 90
second target" is a judgement, not an error.

Passed a `content` block (`planContent(plan)`), it also judges the **ending**,
which is the half a reviewer cannot see from the deck's card:

| Verdict | Why |
|---|---|
| `blank` → problem | No sample ever showed content: the recording is broken, and its last frame proves nothing. |
| `unknown` → warning | No timeline, so the last content frame could not be located. It may be fine; nobody checked. |
| `tailMs` > 400 ms → warning | Source kept past the last content frame — the clip ends on teardown, not on the answer. |
| `endHoldMs` = 0 → warning | The finished state is one frame long. |
| `headTrimMs` = 0 → warning | The clip opens on the page-load flash, which is what a looping player shows the instant it ends. |

These need no encoder, so `capture-edit` prints them **before** the ffmpeg
pass and on `--dry-run` — the only view available on a machine with no ffmpeg,
and the point is to catch a clip that ends on nothing before spending the
encode.

### 5.3 Outputs

`final.mp4`, `poster.jpg` and `edit.json`: the plan, the probe, the delivery
verdict and the original `meta.json`, which is what the publish step reads.

The poster is taken from the *edited* file, so its offset is output time — a
frame from the raw recording usually lands inside a cut. `posterAtMs` puts it
in the **middle of the end hold** by default: the deck's card shows the poster,
so the poster is the one image that says whether the run succeeded without
pressing play. It used to be 60% in, which showed an answer mid-stream and
looked identical whether the run finished, errored or hung (`--poster mid`
restores that; `--poster-at <ms>` overrides both).

## 6. Stage 4 — the review surface

### 6.1 Storage

Three D1 tables: `captures` (one row per clip — identity, the run it came
from, the current cut's numbers, `name`, `commit_sha`, `version`,
`answered_at`, `status`, `likes`), `capture_versions` (one row per CUT, so an
older version is retained rather than overwritten) and `capture_reviews` (one
row per verdict — the thread). Media lives in R2 at
`captures/<id>/v<version>/{video.mp4,poster.jpg}`. Metadata and media are
split because R2 has no meaningful object-size constraint and D1 has a 2 MB
row ceiling — the same judgement `src/storage.js` documents for conversations.

`status` moves `new → liked | needs_work → archived`, and a new version puts a
`needs_work` capture back to `new` so the re-cut gets judged.

**The four captures published before versioning existed** are not orphaned and
needed no migration job. Their bytes are at the old unversioned keys, and
three things keep them working: `listVersions` returns a SYNTHETIC v1 built
from the capture row when it has no version rows; `versionKeyFor` falls back
for v1 to the capture's own key and then to the legacy path; and the first new
version MATERIALISES that synthetic row before the parent columns are
overwritten. The fallback to the capture's own pointer applies only while the
capture is still at v1 — past that the pointer names the newest cut, and
serving it as v1 would answer "show me the original" with the re-cut.

### 6.2 The API

Admin-gated, under `/api/admin/captures` (`src/captures.js`, dispatched from
`src/admin-api.js`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/captures` | List. `?queue=1` is the unreviewed deck; also `status`, `agent`, `model`, `q`, `limit`, `format=text`. |
| `POST` | `/api/admin/captures` | Create the metadata row; returns the upload URLs. |
| `GET` | `/api/admin/captures/:id` | One capture with its reviews. |
| `PATCH` | `/api/admin/captures/:id` | `{label?, name?, status?, ref?, commit_sha?}`. |
| `DELETE` | `/api/admin/captures/:id` | Row, reviews, version rows, every R2 key. |
| `GET` | `/api/admin/captures/queue-status` | What the top-up reads: `{target, unanswered, deficit, by_agent, used}`. |
| `PUT` | `/api/admin/captures/:id/video` | Raw MP4 bytes → the CURRENT version's key. |
| `PUT` | `/api/admin/captures/:id/poster` | Raw JPEG bytes → the current version's poster. |
| `GET` | `/api/admin/captures/:id/video` | The current version, with real HTTP Range support. |
| `GET` | `/api/admin/captures/:id/poster` | The thumbnail. |
| `GET` | `/api/admin/captures/:id/versions` | Every cut of this capture, newest first. |
| `POST` | `/api/admin/captures/:id/versions` | A NEW cut: `version = max+1`, status back to `new`. |
| `PUT`/`GET` | `/api/admin/captures/:id/versions/:v/{video,poster}` | One specific cut; Range preserved. |
| `POST` | `/api/admin/captures/:id/review` | The verdict: `{verdict:"like"\|"feedback", note?}`. |

`commit_sha` on `PATCH` is for BACKFILL — the recorder stamps it at capture
time and nothing in the normal path edits it — and is validated as a hex sha
rather than free text, because a provenance field holding "unknown" is worse
than an empty one: it looks like an answer.

Range support is not a nicety: the surface exists so a clip can be scrubbed in
a deck, and a `<video>` element seeks by range.

Uploads are capped at **100 MB** for the video and 4 MB for the poster. 100 MB
is not a policy choice — it is Cloudflare's edge body limit on this plan, which
rejects a larger request before the Worker ever sees it, so a higher number
here would be a limit that can never be reached and a 150 MB upload would fail
with an opaque edge error instead of a legible 413. The pipeline aims at 40 MB
(`LINKEDIN.target_bytes`), so this is headroom rather than a constraint.

Without the R2 binding the media endpoints answer 503 and the rest of the
board keeps working — the metadata list is useful on its own.

### 6.3 The swipe deck

**Capture reviews** is its own admin-gated page at **`/captures/`**, reached
from the account panel's admin row beside "Admin interface".

It was a panel section inside `/admin` until 2026-08-10, when the owner moved
it up a level. The reasoning is worth keeping: `/admin` is where the site is
OPERATED — approvals, quotas, alerts, grants, the fix boards — and every one
of those is a decision about the service. Watching a recorded run and judging
whether the answer was any good is a different job, done at a different time,
usually on a phone. It is also deliberately NOT registered in `src/panels.js`
any more: the attention board orders *admin panels*, and a review surface that
is not one of them would only distort that ordering.

The route gate in `src/index.js` duplicates `/admin`'s three lines rather than
generalising them, so a non-admin gets exactly the same 302 to `/rver` — no
403 body naming a surface they cannot see. Neither the page nor its CSS/JS is
on the public allowlist in `src/assets.js`.

- **Right = like.** Posts immediately, the deck advances.
- **Left = feedback.** The card leaves and a **feedback input field takes its
  place**, titled with the capture so the reviewer knows what they are writing
  about. Nothing posts until Send. The server *requires* a note on a
  `feedback` verdict — a left swipe with no words is a shrug, not a review —
  so the field is the mechanism rather than a courtesy.
- Arrow keys and two explicit buttons do the same two things. A gesture is
  never the only way to act on this page.

The pure half (`public/js/captures-core.js`) owns the thresholds, the
direction test, the tilt, the hint overlay and the formatting, and is
node-tested. The DOM half (`public/js/captures.js`) owns pointer capture,
the video element and the fetches, and fails soft: a failed review POST leaves
the card in place with an inline error rather than silently dropping a
verdict.

### 6.4 The queue of twenty

The deck is not a pile that drains — it is a **queue held at twenty**
(`QUEUE_TARGET`), because its purpose is to let the owner judge how the
product answers without running a prompt and waiting for it. Twenty unanswered
clips spanning all seven agents is enough to sample the whole surface in one
sitting.

**Every capture has a number and a name.** The number is its row id, rendered
`#CAP-12` — an increasing series, never reused, so "produce a review of #12"
is unambiguous. The name is short and human ("Elpris", "Vitamin D"), derived
from the starter id and improvable by hand.

**Every capture records its commit.** `commit_sha` is the git HEAD the
recording was made at. The deck outlives the code; without it, "why does this
video not match the app" has no answer.

**What happens when one is answered:**

| Verdict | The capture | The queue |
|---|---|---|
| **Like** (swipe right) | → `liked`, filed in **Appreciated**, still viewable | one short; the top-up records a new one |
| **Feedback** (swipe left, note required) | → `needs_work`, and the note joins its **thread** | one short; the top-up records a new one |

A capture with feedback is not discarded and not overwritten. It grows
**versions**: a later recording of the same prompt is added as version *n+1*,
the earlier cuts are retained and still playable from the card, and the
capture returns to the queue as `new` so the re-cut gets judged. `answered_at`
is stamped on the FIRST verdict and never cleared, which is how the top-up
tells a genuinely fresh capture from a re-cut of an old one.

`npm run capture:topup` reads `queue-status`, records whatever is missing —
always giving the next slot to the agent with the fewest captures in the deck,
and never re-recording an (agent, starter) pair already there — then edits,
publishes, and reports. `deficit <= 0` exits without recording, so it is safe
on a timer.

### 6.5 The loop it feeds

`scripts/captures --status needs_work` (or `?format=text` on the endpoint) is
what a Claude Code session reads to learn which capture to re-record and what
was wrong with it — the same producer→verdict→producer shape as the try-it
queue (`docs/DECISION-BOARD-LOOPS.md`, the **testable-interaction-points**
skill) and the feature board. `src/admin-boards.js` carries the entry so the
board is discoverable in one call.

## 7. Honesty about the footage

`--wait cut` makes the pipeline look instant. For a product clip that is fine;
attached to a claim about speed it is not. Two things keep this straight:

1. `--wait speed` keeps the wait on screen, accelerated, so the search rounds
   are visible.
2. `edit.json` records `source_ms`, `output_ms`, `cut_ms`, `dead_air_ms`,
   `wait_mode` and `speed`. Whatever the post says, the record of what was
   done to the footage exists alongside it.

## 8. The first batch — what it verified, and what it changed

Four sessions were recorded against the live site on 2026-08-10 with
`openai/gpt-oss-120b` (the site's own first up model, so the clips show what a
visitor gets), one starter prompt each, `--budget 60`:

| # | Agent | Starter | Recorded | Final |
|---|---|---|---|---|
| 1 | introspection | `int-pipeline` | 1m 18s | 39 s, 12.3 MB |
| 2 | research | `res-news-tech` (en) | 54 s | 27 s, 10.1 MB |
| 3 | research | `res-sv-elpris` (sv) | 54 s | 34 s, 12.5 MB |
| 4 | scholar | `sch-vitamin-d` | 56 s | 25 s, 9.8 MB |

What that settled, each of which was an open caveat when this document was
first written:

- **The encode runs and produces what LinkedIn plays.** `ffprobe` reports
  `h264` / profile `High` / `yuv420p` at 1080×1350, and `moov` precedes `mdat`
  (so `+faststart` is doing its job). ffmpeg is NOT preinstalled in these
  containers — `apt-get install -y --no-install-recommends ffmpeg` supplies it;
  `--no-install-recommends` matters, because a recommended VA-API driver 404s
  against the mirror and takes the whole install down with it. Playwright's
  own bundled `ffmpeg-linux` is not a substitute: it ships libvpx only, so it
  can cut a webm but cannot produce H.264.
- **The recorder drives the real site.** All four runs completed with real
  searches and real sources — capture #3's footer reads
  `gpt-oss-120b · 41.0 s · 27,116 tokens · 4 searches`. The markers land where
  they should: `send` at 8.8 s, `first_token` at 32.7 s, so the 24 s the
  pipeline spent researching is exactly the span the editor acts on.
- **Range works on the served video.** A `bytes=1000000-1000999` request
  answers `206` with the right `content-range` and exactly 1000 bytes, which is
  what lets the deck scrub a clip rather than only play it.

And one thing it CHANGED. The default `--min-still 1500` is wrong for a
research run: the activity bar posts a new search step every couple of
seconds, so almost every gap qualifies as dead air and the plan comes out as
thirteen segments strobing between 1.25× and 8×. `--min-still 3500` cuts the
same clip into five segments — only the genuinely long waits accelerate — and
that is the setting to use for anything with a visible activity log. The
default is left alone because it is right for a direct answer with no search
phase; this is a per-run knob, not a bug.

### Still not verified

- **The deck has not met a thumb.** The thresholds in `captures-core.js` are
  reasoned and unit-tested, and the page has been rendered at phone width in a
  headless browser — but no real touch screen has dragged a card. The four test
  points in `docs/test-requests/` exist for this.
- **Nothing has been swiped yet.** The four captures above sit at status
  `new`; no like or feedback verdict has round-tripped through the live API.
