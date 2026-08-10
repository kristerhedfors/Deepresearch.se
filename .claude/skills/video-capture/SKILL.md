---
name: video-capture
description: >-
  Load when RECORDING the site in a browser and turning the recording into a
  shareable clip — "capture a video of a research run", "record the pipeline
  answering", "make a demo video", "screen-record the agent", "spela in en
  körning", "make a LinkedIn video", "cut the waiting out of that recording",
  "speed the video up", "why is the clip four minutes of nothing" — or when
  touching tests/capture.mjs, scripts/capture-core.mjs, scripts/capture-edit.mjs,
  src/captures.js, public/js/captures.js / captures-core.js, scripts/captures,
  or the Capture reviews page at /captures/. Covers the four stages (record →
  plan → encode → review), how selected AGENTS and selected MODELS become a run
  matrix over the shipped example prompts, the activity timeline that is what
  makes cutting dead air possible at all, the ffmpeg settings LinkedIn actually
  plays (and the three that make a clip render as a black rectangle or refuse
  to start), the speed/cut knobs, and the admin swipe deck where a capture is
  liked or sent back with feedback.
---

# Capturing the site on video

## What this is

Four stages, three commands, one shared core.

| Stage | Command | Reads | Writes |
|---|---|---|---|
| **Record** | `npm run capture -- --agents … --models …` | the site, live | `captures/<date>/<slug>/raw.webm` + `timeline.json` + `meta.json` |
| **Plan + encode** | `npm run capture:edit -- <dir>` | those three | `final.mp4`, `poster.jpg`, `edit.json` |
| **Publish** | `scripts/captures --add … --upload …` | `edit.json` | a D1 row + two R2 objects |
| **Review** | `/captures/` → Capture reviews | the API | a like, or feedback |

`scripts/capture-core.mjs` is the pure core all of it shares — the run matrix,
the dead-air detector, the cut plan, the ffmpeg argv, the LinkedIn limits. It
is a function of its arguments: no filesystem, no browser, no clock, no
encoder. That is why an edit can be argued about (`--dry-run`) before a frame
is spent, and why `scripts/capture-core.test.mjs` covers the whole editing
model without ffmpeg installed.

## Recording: selected agents × selected models × the example prompts

```bash
cd tests && npm install                      # once — the harness needs Playwright
export BASIC_AUTH_USER=… BASIC_AUTH_PASS=…   # break-glass, same as the e2e suite

npm run capture -- --agents research,introspection --models <id> --per-agent 2
npm run capture -- --agents research --models <a>,<b> --shape portrait --lang sv
npm run capture -- --agents research --models <id> --dry-run   # matrix only
```

**Agents are chat modes.** `--agents` takes agent ids from the starter registry
(`research`, `scholar`, `introspection`, `agent-builder`, `orchestrator`,
`outrospection`, `models`); the core's `modeForAgent` maps each to the
`#modesel` value through `MODE_AGENTS`, so the harness and the product cannot
drift on what an agent is. An unknown name is a hard error that lists the
valid ones — a capture batch that silently ran the wrong agent is worse than
one that did not run.

**The prompts are the shipped example prompts.** `pickPrompts` draws from the
same starter queues the empty composer shows (the **starter-prompts** skill),
ranked entries first. Three reasons this is not a detail:

1. They are what a visitor actually sees, so a video made from them shows the
   product rather than a private demo of it.
2. They are **synthetic by construction**. Lifting a question out of
   `chat_logs` for a public video publishes one user's chat to an audience,
   and a full-visibility log is not consent for that. `starters-data.js` says
   the same thing about putting a logged question on a stranger's screen; a
   LinkedIn post is a much larger stranger.
3. They are EN/SV balanced (invariant 6), so `--lang sv` produces a Swedish
   batch without anyone hand-writing Swedish prompts for it.

The matrix is **agent-major**: all of one agent's runs, then the next. An
interrupted batch therefore covers whole agents instead of leaving every agent
half-captured.

**Shapes.** `--shape portrait|square|landscape|raw` sets the CSS viewport AND
the delivery frame together. Portrait (720×900 recorded → 1080×1350 delivered)
is the default because 4:5 is the tallest ratio LinkedIn renders at full width
in the feed and a transcript is a vertical thing. The viewport is deliberately
SMALLER than the output: what decides whether a research run reads in a feed
box on a phone is how large the text is relative to the frame, not pixel
sharpness. Recording 1080 CSS pixels and encoding 1:1 gives a crisp video
nobody can read.

## The activity timeline — why cutting dead air works here at all

A deep-research run is mostly waiting. The composer sends, the activity bar
sits still for ten to ninety seconds while the pipeline searches, then tokens
stream. ffmpeg's own scene detection cannot tell "the pipeline is thinking"
from "the answer paused mid-sentence" — both are a static frame — so any
fixed threshold either keeps the dead air or eats the pauses that make an
answer readable.

So the **driver decides what activity means and writes it down**. Every
`--sample` ms (250 by default) it reads a content signature out of the page —
message count, step count, how many steps are finished, the last step's label,
the length of the assistant's text, whether `.stats` has landed — and appends
`{t, sig}`. Consecutive identical signatures are *provably* dead time: nothing
on screen changed.

Two properties of `stillSpans` worth keeping:

- A span **ends at the last sample known to be idle**, not at the sample where
  the change was observed. A change seen at sample *m* happened somewhere in
  `(t[m-1], t[m]]`, so ending one sample early guarantees the frame where new
  content appears is never inside a cut. That one-sample conservatism is the
  difference between an edit that feels tight and one that clips the first
  word of every answer.
- The sampler is driven from **Node**, not from an in-page timer, so a frozen
  page cannot stop it. A stalled run is exactly the recording worth watching.

## Editing: cutting the waits, choosing the speed

```bash
npm run capture:edit -- captures/2026-08-10/research__…            # defaults
npm run capture:edit -- --all captures/2026-08-10                  # whole batch
npm run capture:edit -- <dir> --dry-run                            # plan + argv
npm run capture:edit -- <dir> --speed 1.5 --wait speed --wait-speed 8
npm run capture:edit -- <dir> --shape square --max-mb 30
```

| Knob | Default | What it decides |
|---|---|---|
| `--wait cut` | ✔ | Dead air is **removed**. Shortest clip; the pipeline looks instant. |
| `--wait speed` + `--wait-speed 8` | | Dead air is **kept but accelerated**. Honest: the viewer sees the search rounds go by. |
| `--wait keep` | | Nothing is cut. The unedited run at `--speed`. |
| `--speed <n>` | 1 | Playback multiplier for the parts where something *is* happening. 1.25–1.5 reads as brisk; past 2 the streaming answer is unreadable. |
| `--min-still <ms>` | 1500 | Below this a pause is part of the rhythm of reading, not dead air. |
| `--hold <ms>` | 600 | Head of every dead span kept, so the state that was reached is legible before the cut. |
| `--trim-start` / `--trim-end` | 0 | Drop the page load and the trailing settle. |

`--dry-run` prints the whole plan — every segment with its source range, kind
and speed, how much was removed, and how many times shorter the clip is than
the real run — plus the exact `ffmpeg` argv. **Read that before encoding.** A
32-second run with two dead spans typically comes out around 8 seconds at
`--wait speed --speed 1.5`, and the segment table is where a bad
`--min-still` shows up as one enormous cut swallowing the answer.

Mechanically: one `trim` + `setpts=(PTS-STARTPTS)/N` chain per segment, all
`concat`ed, then `scale`(lanczos) → `pad` → `fps` → `format=yuv420p`. Dividing
by 1 looks like a no-op and is not: `STARTPTS` must be rebased or `concat`
cannot butt the segments together. Padding rather than cropping is deliberate
— a research transcript loses its meaning at the edges.

## What "optimized for LinkedIn" actually means

The settings in `ffmpegArgs` are not taste. Each one is a failure mode:

- **`-c:v libx264 -profile:v high -pix_fmt yuv420p`** — the only combination
  every LinkedIn client decodes. A 10-bit or 4:4:4 stream uploads fine and
  plays as a **black rectangle**.
- **`-movflags +faststart`** — moves the `moov` atom to the front so playback
  starts before the file has finished downloading. Without it a feed video
  looks broken, because the feed is where nobody waits.
- **`-an`** — no audio track at all. LinkedIn autoplays muted; a silent AAC
  track buys nothing and costs a stream. (Adding music is a second `-i` — see
  `references/ffmpeg-recipes.md`.)
- **`-crf 21` by default, `-maxrate`/`-bufsize` only with `--max-mb`** —
  quality-targeted unless the caller names a budget. `bitrateCapKbps` keeps
  6% headroom for container overhead, so a `--max-mb 30` file actually lands
  under 30 MB.

`checkDelivery` holds LinkedIn's published fences (5 GB, 10 minutes, aspect
between 1:2.4 and 2.4:1, ≥3 s) and our own targets. It is **advisory**: the
edit CLI prints problems and warnings and still writes the file, because
"this is 95 seconds and we aim for 90" is a judgement, not an error. The one
warning worth obeying is the duration one — past about 90 seconds a feed
audience is gone, and the fix is `--speed` or a lower `--min-still`, not a
different encoder setting.

## Publishing and the review loop

```bash
CAP=captures/2026-08-10/research__…

# edit.json already holds everything the row needs — reshape it and post:
scripts/captures --add "$(jq '{label:("Capture " + (.meta.slug // "")), agent:.meta.agent,
  model:.meta.model, prompt:.meta.prompt, starter:.meta.starter, lang:.meta.lang,
  shape:.shape, duration_ms:.output_ms, source_ms:.source_ms, cut_ms:.cut_ms,
  speed:.speed, wait_mode:.wait_mode, width:.probe.width, height:.probe.height,
  size_bytes:.probe.bytes, meta:.}' "$CAP/edit.json")"        # → prints the id
scripts/captures --upload <id> "$CAP/final.mp4"
scripts/captures --poster <id> "$CAP/poster.jpg"

scripts/captures                      # the unreviewed deck, as text
scripts/captures --status needs_work  # the RE-SHOOT list: what came back with feedback
scripts/captures --review 12 feedback "the sources scroll past too fast"
```

The row is created before the bytes are uploaded (`video_key` stays null until
they land), so a failed upload leaves a visible incomplete clip rather than an
orphaned R2 object nobody can find.

Metadata lives in D1 (`captures`, `capture_reviews`); the MP4 and the poster
live in R2 under `captures/<id>/`. The video endpoint implements real HTTP
Range, because the whole point is a `<video>` element being scrubbed in a
deck.

**The swipe deck** is its own admin-gated page at **`/captures/`** — reached
from the account panel's admin row, beside "Admin interface". (It lived inside
`/admin` until 2026-08-10; the owner moved it up a level because reviewing a
run is not an ops task. It is no longer in `src/panels.js`, on purpose.) One
card at a time: the clip, the agent, the model, the prompt it answered, and
the facts that describe the edit (size, length, speed, how much was cut).

- **Swipe right → like.** Posts `{verdict:"like"}`, the capture becomes
  `liked`, the deck advances.
- **Swipe left → feedback.** The card flies out and a **feedback input field
  takes its place**, with the capture's title above it so the reviewer knows
  what they are writing about. Nothing is posted until Send. The server
  *requires* a note on a `feedback` verdict — a left swipe with no words is
  not a review, it is a shrug — so the field is the mechanism, not decoration.
- Arrow keys and two explicit buttons do the same two things. A gesture must
  never be the only way to act: this page is used with a mouse as often as a
  thumb.

Feedback lands as a `capture_reviews` row and shows in
`scripts/captures --status needs_work?format=text`, which is what a Claude
Code loop reads to know which capture to re-record and with what changed —
the same producer/consumer shape as the try-it queue
(**testable-interaction-points**) and the feature board.

## Runbook: a batch for a post

```bash
cd tests && npm install && cd ..
export BASIC_AUTH_USER=… BASIC_AUTH_PASS=…

# 1. record two prompts per agent across two models, portrait
npm run capture -- --agents research,introspection --models <a>,<b> \
    --per-agent 2 --shape portrait --budget 90

# 2. look at ONE plan before encoding forty of them
npm run capture:edit -- captures/<date>/<first-slug> --dry-run

# 3. encode the batch once the knobs are right. --min-still 3500 because a
#    research run's activity bar ticks every ~2 s and the 1500 default
#    strobes; --wait speed keeps the search rounds visible.
npm run capture:edit -- --all captures/<date> --speed 1.25 --wait speed --min-still 3500

# 4. publish and review
scripts/captures --upload …          # per clip
open https://deepresearch.se/captures/   # the swipe deck
```

## Traps

- **`--min-still 1500` is wrong for a run with an activity log.** The default
  suits a direct answer with no search phase. A research run posts a new
  search step every couple of seconds, so nearly every gap qualifies as dead
  air and the plan comes out strobing between the action speed and 8× —
  measured at thirteen segments on a 54 s run. **Use `--min-still 3500`** for
  anything with a visible activity bar; the same clip becomes five segments
  and only the genuine waits accelerate. Always read the segment table in
  `--dry-run` before encoding a batch; that is what it is for.
- **ffmpeg is not installed in the agent containers.** `--dry-run` works
  anyway, on purpose: the plan is reviewable without an encoder. To encode:
  `apt-get update && apt-get install -y --no-install-recommends ffmpeg`. The
  `--no-install-recommends` is load-bearing — a recommended VA-API driver 404s
  against the mirror and takes the whole install down with it, which is a
  confusing failure for something that has nothing to do with ffmpeg.
- **You cannot verify MP4 PLAYBACK in Playwright's Chromium.** It ships
  without proprietary codecs, so `canPlayType('video/mp4; codecs="avc1.42E01E"')`
  returns `''` and the deck's `<video>` fails with
  `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`. This looks exactly like a corrupt
  upload and is not one — verified 2026-08-10 by fetching the served bytes and
  finding them sha256-identical to the local encode, which `ffprobe` read as
  clean H.264. **Verify a clip with `ffprobe` plus a real browser**; use the
  headless one for layout, the poster, the fetches and the gesture, never for
  decoding. (VP8/VP9 webm *does* play there, which is a tempting wrong turn:
  do not switch the delivery codec to satisfy a test browser.)
- **Playwright's bundled ffmpeg is not a substitute.**
  `/opt/pw-browsers/ffmpeg-*/ffmpeg-linux` exists and runs, so it is tempting.
  It ships **libvpx only** — it can cut a webm but cannot produce H.264, which
  is the one codec the deck and LinkedIn both need.
- **Playwright only flushes the video file on `context.close()`.** A run that
  returns without closing its context leaves a zero-byte `raw.webm`. The
  harness closes in a `finally` for that reason — keep it there.
- **The break-glass `Authorization` header must be stripped cross-origin.**
  `tests/e2e/helpers.js` documents this for the e2e suite and it applies
  identically here: the app pulls cross-origin resources on load, and sending
  break-glass credentials to a third party is the actual risk.
- **A failing run never aborts a batch.** Collect and report; exit non-zero
  only if every run failed. Same posture as invariant 2 — one bad run should
  cost one clip.
- **Do not point a capture at a real user's question.** The example prompts
  exist so nobody has to.
- **Cutting is not free of meaning.** `--wait cut` makes the pipeline look
  instant. That is fine for a product clip and dishonest in a benchmark
  claim; if the post says anything about speed, use `--wait speed` so the
  wait is visible, and let `edit.json` (`source_ms` vs `output_ms`) be the
  record of what was done to the footage.

## Where the pieces live

| File | Role |
|---|---|
| `scripts/capture-core.mjs` | The pure core: shapes, run matrix, `stillSpans`, `planEdit`, `buildFilterGraph`, `ffmpegArgs`, `checkDelivery`. |
| `scripts/capture-core.test.mjs` | Its unit tests — the whole editing model, no ffmpeg required. |
| `tests/capture.mjs` | The Playwright driver. Records, samples, writes the three sidecars. |
| `scripts/capture-edit.mjs` | Plan → ffmpeg → `final.mp4` + `poster.jpg` + `edit.json`. |
| `src/captures.js` | D1 + R2 + `/api/admin/captures*`, including the like/feedback verdict. |
| `public/js/captures-core.js` | Pure swipe/deck logic (thresholds, tilt, hints, formatting). |
| `public/captures/index.html` | The `/captures/` page shell (admin-gated in `src/index.js`). |
| `public/css/captures.css` | Its styles, incl. the deck (moved out of `admin.css` when the page split off). |
| `public/js/captures.js` | The deck UI that drives that page. |
| `scripts/captures` | The CLI over the admin API — publish, list, review. |
| `docs/VIDEO-CAPTURE.md` | The reference: file formats, API surface, field-by-field. |
| `references/ffmpeg-recipes.md` | Recipes beyond the default pipeline (captions, music, GIF, side-by-side). |
