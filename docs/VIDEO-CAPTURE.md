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

### 3.3 The three sidecars

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
`intro`, `budget_s`, `search`, `started_at`, `ended_at`, `durationMs`, `ok`,
`error`.

Two of those exist for the review queue rather than for the edit:

- **`commit_sha`** is the git HEAD the recording was made at, resolved once per
  batch. Without it a clip is un-reproducible — the deck outlives the code, and
  six merges later "why does this video not match the app" has no answer. It is
  `null` rather than a guess when git is unavailable.
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

### 3.5 Failure posture

One failing run never aborts a batch (invariant 2's posture, applied to a
harness). A run that times out keeps its video and timeline — a stalled run is
the recording most worth watching — is marked `ok: false` with a reason, and
the batch exits non-zero only if every run failed.

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
| `trimStartMs` / `trimEndMs` | 0 | Head and tail of the recording. |

The output carries `segments`, `keptMs`, `cutMs`, `outMs` and `waitMs`, which
is what `--dry-run` renders and what `edit.json` records. Contiguous segments
at the same speed are fused, so the encoder gets one trim instead of two.

Degenerate inputs are handled rather than thrown on: no timeline at all yields
one full-length segment; a recording that is entirely dead air still yields
the hold, because an empty segment list would break the filter graph.

## 5. Stage 3 — the encode

One ffmpeg pass:

```
[0:v]trim=start=…:end=…,setpts=(PTS-STARTPTS)/<speed>[cN]   (one per segment)
[c0][c1]…concat=n=N:v=1:a=0[cv]
[cv]scale=W:H:force_original_aspect_ratio=decrease:flags=lanczos,
    pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v]
```

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

### 5.3 Outputs

`final.mp4`, `poster.jpg` (taken from the *edited* file, so its offset is
output time — a frame from the raw recording usually lands inside a cut), and
`edit.json`: the plan, the probe, the delivery verdict and the original
`meta.json`, which is what the publish step reads.

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
