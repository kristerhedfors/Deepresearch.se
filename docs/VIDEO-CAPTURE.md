# Video capture — recording the site, editing for sharing, reviewing by swipe

*Shipped 2026-08-10. Status: the recorder, the editor and the review surface
are IMPLEMENTED and unit-tested. The encode leg has not been run against
ffmpeg inside an agent container — none of them has ffmpeg installed — so the
plan is verified and the pixels are not (§8).*

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
tests/capture.mjs          scripts/capture-edit.mjs        scripts/captures        /admin
──────────────────         ────────────────────────        ────────────────        ──────
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
`starter`, `xp`, `lang`, `shape`, `viewport`, `base`, `budget_s`, `search`,
`started_at`, `ended_at`, `durationMs`, `ok`, `error`.

A batch also writes `batch.json` at the root: the options used plus one row
per run.

### 3.4 Failure posture

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

D1 `captures` (one row per clip: identity, the run it came from, the edit's
numbers, `status`, `likes`) and `capture_reviews` (one row per verdict). The
MP4 and poster live in R2 under `captures/<id>/`. Metadata and media are split
because R2 has no meaningful object-size constraint and D1 has a 2 MB row
ceiling — the same judgement `src/storage.js` documents for conversations.

`status` moves `new → liked | needs_work → archived`.

### 6.2 The API

Admin-gated, under `/api/admin/captures` (`src/captures.js`, dispatched from
`src/admin-api.js`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/captures` | List. `?queue=1` is the unreviewed deck; also `status`, `agent`, `model`, `q`, `limit`, `format=text`. |
| `POST` | `/api/admin/captures` | Create the metadata row; returns the upload URLs. |
| `GET` | `/api/admin/captures/:id` | One capture with its reviews. |
| `PATCH` | `/api/admin/captures/:id` | `{label?, status?, ref?}`. |
| `DELETE` | `/api/admin/captures/:id` | Row, reviews and R2 objects. |
| `PUT` | `/api/admin/captures/:id/video` | Raw MP4 bytes → `captures/<id>/video.mp4`. |
| `PUT` | `/api/admin/captures/:id/poster` | Raw JPEG bytes → `captures/<id>/poster.jpg`. |
| `GET` | `/api/admin/captures/:id/video` | Streams with real HTTP Range support. |
| `GET` | `/api/admin/captures/:id/poster` | The thumbnail. |
| `POST` | `/api/admin/captures/:id/review` | The verdict: `{verdict:"like"\|"feedback", note?}`. |

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

The **Capture reviews** panel on `/admin` (registered in `src/panels.js` as
`captures`, so the attention board can promote or bury it like any other).

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

### 6.4 The loop it feeds

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

## 8. What is not verified

- **The encode has not run.** No agent container here has ffmpeg, and the
  package mirror in this one could not supply it. The filter graph, the argv
  and the plan are unit-tested; the pixels are not. First run on a machine
  with ffmpeg should check `ffprobe` reports `h264` / `yuv420p` and that
  `moov` precedes `mdat`.
- **The recorder has not been run against the live site from here.** It is
  built on the same helpers the e2e suite uses against production, but a first
  batch should be a single run with `--limit 1` before a matrix.
- **The panel has not been exercised on a touch device.** The thresholds in
  `captures-core.js` are reasoned, not measured; a thumb on a phone is the
  test that matters.
