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
  or the Capture reviews page at /captures/. ALSO the AGENT STUDIO GATE: a
  capture of a build walks to the published /app/<slug>/ and uses it on camera,
  and is only kept if the app passes — masked key field included — so load this
  before changing tests/app-e2e.mjs, the app kit's key input, or what a
  generated app is allowed to do. Covers the four stages (record →
  plan → encode → review), how selected AGENTS and selected MODELS become a run
  matrix over the shipped example prompts, the activity timeline that is what
  makes cutting dead air possible at all, the ffmpeg settings LinkedIn actually
  plays (and the three that make a clip render as a black rectangle or refuse
  to start), the speed/cut knobs, and the admin review FEED where every capture
  is scrolled through and any one liked, sent back with feedback, or undone.
---

# Capturing the site on video

## What this is

Four stages, three commands, one shared core.

| Stage | Command | Reads | Writes |
|---|---|---|---|
| **Record** | `npm run capture -- --agents … --models …` | the site, live | `captures/<date>/<slug>/raw.webm` + `timeline.json` + `meta.json` (with the run's `chat`) |
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

npm run capture -- --agents cyber,introspection --models <id> --per-agent 2
npm run capture -- --agents cyber --models <a>,<b> --shape portrait --lang sv
npm run capture -- --agents cyber --models <id> --dry-run   # matrix only
```

**Agents are chat modes.** `--agents` takes agent ids from the starter registry
(`scholar`, `cyber`, `introspection`, `agent-builder`, `orchestrator`,
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

**A capture's commit is the DEPLOYED one, not your working tree's.** Against a
remote base, local HEAD names a commit the site has very likely never run;
stamping it is confident wrong provenance, which is worse than none because it
invites someone to check out that commit to explain a clip. The first twenty
captures were stamped that way and had to be corrected by hand. A remote base
records `origin/main`, a loopback base records local HEAD, and
`deployed_digest` (the served snapshot's fingerprint, via a 300-byte Range
request) is what makes a wrong stamp detectable.

**No intro.** Every recording opens the site with `?anim=0` (the documented
inverse of `?anim=1`, which forces the intro on) AND with
`prefers-reduced-motion` set — two independent gates, because a recording is
expensive to redo and the media query works against deploys that predate the
parameter. `--intro` opts back in for the one combined cut that wants an intro
beat.

**A name to refer to it by.** Each capture carries a short derived name
(`res-sv-elpris` → "Elpris" — the agent prefix and the language marker are
noise, not name), shown beside its `#CAP-<id>` number so a clip can be asked
for out loud. The derivation lives once, in `public/js/captures-core.js`'s
`starterName`; the harness, the top-up, the server and the feed all call it.
`scripts/captures --name <id> "…"` improves any one by hand.

**Shapes.** `--shape portrait|square|landscape|raw` sets the CSS viewport AND
the delivery frame together. Portrait (720×900 recorded → 1080×1350 delivered)
is the default because 4:5 is the tallest ratio LinkedIn renders at full width
in the feed and a transcript is a vertical thing. The viewport is deliberately
SMALLER than the output: what decides whether a research run reads in a feed
box on a phone is how large the text is relative to the frame, not pixel
sharpness. Recording 1080 CSS pixels and encoding 1:1 gives a crisp video
nobody can read.

## Agent Studio: a capture must prove the app it built works

An `agent-builder` capture does not stop when the build finishes. It reads the
published `/app/<slug>/` off the build chip, **walks there and uses it while
still recording**, and grades it (`tests/app-e2e.mjs`). A capture whose app
fails is **not published** — it stays on disk with its verdict. A video of a
build that does not work is a demo of a broken thing filed as if it were a demo
of a working one.

Six checks: the app and its own files load · it throws nothing of its own ·
every key field is masked at every sample · the key reaches no text or
attribute · none of storage, cookie or URL · the thing is usable.

**Never type a real key into a recording.** The sentinel is
`sk-FAKE-CAPTURE-SENTINEL` — fake because it is typed ON CAMERA (an unmasked
field would put it in the video, which is the failure being tested for) and
because it is sent to a real provider, which 401s. That 401 is expected and
filtered. It is 21 characters after `sk-` on purpose: `scripts/scan-secrets`
blocks `sk-[A-Za-z0-9_-]{24,}` and a longer sentinel stops the commit.

Three traps, all paid for on the first live run:

- **A module script never loads in a published app.** `<script type="module">`
  is fetched in CORS mode and `/app/<slug>/` is served into an opaque origin,
  so it is blocked SILENTLY: the page renders, throws nothing, does nothing.
  `app_interactive` still passes for such an app — typing and clicking "work"
  — which is why the ASSET half of `app_loads` is the check with teeth. The
  build instructions forbid module scripts for this reason; do not "simplify"
  that back.
- **The checker's own storage probe looks like an app error.** Reading storage
  in an opaque origin throws a `SecurityError`, and Chromium reports it on the
  page-error channel too. Unfiltered, it fails every app. If you add a probe
  that the sandbox denies, filter its noise the same way.
- **The chat mode does not stick by itself.** The `dr_chat_mode` pin makes the
  dropdown already read the wanted mode, so a set-and-return leaves
  `/api/settings` free to revert it — silently recording THE WRONG AGENT. An
  Agent Studio run that fell back to the default mode prints code as prose and
  builds nothing, and the clip looks fine unless you read the composer. The
  fallback is Deep Science since 2026-08-13, which makes a slipped pin louder
  rather than quieter.
  `selectMode` holds the value and fails the run instead.

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

Three properties of `waitSpans` worth keeping:

- **It compares what a viewer can READ, not the whole signature.**
  `readableSignature` keeps `msgs`, `answerLen` and `stats` and drops `steps`,
  `finished` and the step label. A ticking activity bar is the wait, not an
  escape from it — see the #CAP-10 trap below, which is what this rule was
  bought with.
- A span **ends at the last sample known to be idle**, not at the sample where
  the change was observed. A change seen at sample *m* happened somewhere in
  `(t[m-1], t[m]]`, so ending one sample early guarantees the frame where new
  content appears is never inside a cut. That one-sample conservatism is the
  difference between an edit that feels tight and one that clips the first
  word of every answer.
- The sampler is driven from **Node**, not from an in-page timer, so a frozen
  page cannot stop it. A stalled run is exactly the recording worth watching.

Each span is labelled by whether the *full* signature moved inside it — `dead`
(a frozen frame) or `thinking` (the bar moved, nothing readable did). `--wait
cut` drops the frozen ones and **accelerates** the thinking rather than
deleting it: a deep research clip whose search rounds have been edited out is a
demo of a different product.

## A clip links back to the chat it recorded

> *"Link from captured agent videos to the actual chat so one can continue and
> explore from there. Let those recorded chats appear in admin's chat history
> panel under its own expandable."* — owner, 2026-08-14

A clip used to be a dead end: the run died with the browser that recorded it,
so the answer on screen could not be opened, followed up, or checked. Four
pieces close that loop, and each one has a reason worth keeping.

**The driver reads the RAW messages, not the screen.**
`window.__DR_TRANSCRIPT` (`public/js/stream.js` `conversationTranscript`)
returns a copy of the message array the conversation was built from, and it
goes into `meta.json` as `chat`. The DOM read is only a fallback: an answer is
markdown, and by the time it is on screen the links are elements — a scraped
transcript keeps the words and loses every citation URL, which is exactly the
half a reader following the link came for. The read happens BEFORE the Agent
Studio walk navigates the page to the published app; after that there is no
chat left to read.

**The transcript is taken out of the edit report before storage.**
`CAPTURE_CAPS.meta` is 20 kB and one research answer is larger, so a report
that still carried the chat would serialize past the cap and `serializeMeta`
would drop THE WHOLE REPORT — segments, ffprobe, verdict — in exchange for
something that has its own column. The server strips it (`withoutChat`) and
reads it from any of `chat`, `meta.chat` or `meta.meta.chat`, which is where
the documented `meta: .` publish recipe actually puts it. **This is why the
publish recipe below did not have to change.**

**Every capture links, transcript or not.** A clip recorded before this shows
"💬 Ask this again" and opens the composer with the same question, agent and
model; one with a transcript shows "💬 Continue this chat". `resumable` /
`has_chat` is what decides the wording — "continue" over an empty history is a
promise the app cannot keep.

**The reader's copy wins.** The conversation is written into local encrypted
history under the stable id `capture-<id>`. Reopening a capture you have
already continued brings back YOUR chat, follow-ups and all, not the
recording; the stable id is also why following the same link twice does not
leave two entries in the drawer.

```bash
scripts/captures --chat 12 captures/2026-08-14/…/meta.json   # backfill one
scripts/captures --chat 12 -                                  # clear it again
curl -su "$U:$P" "$BASE/api/admin/captures/12/chat"           # the seed
```

The **Recorded runs** group in the left chat-history drawer
(`public/js/capture-chat.js`, `#capturechats`) lists them: collapsed, admin
only, hidden entirely when the API answers with nothing. Its list endpoint
selects the naming columns only — never `meta_json`, never `chat_json` — because
it is opened on every drawer refresh by a pane that is mostly about the
reader's own conversations.

**One rule that is not negotiable:** nothing in this path reads `chat_logs`.
Capture prompts are the shipped starters (synthetic by construction) and the
answers are this pipeline's own, recorded by the operator. A full-visibility
log is not consent to replay somebody's conversation into a video or a drawer.

## Editing: cutting the waits, choosing the speed

```bash
npm run capture:edit -- captures/2026-08-14/cyber__…               # defaults
npm run capture:edit -- --all captures/2026-08-14                  # whole batch
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
CAP=captures/2026-08-14/cyber__…

# edit.json already holds everything the row needs — reshape it and post:
scripts/captures --add "$(jq '{label:("Capture " + (.meta.slug // "")), agent:.meta.agent,
  model:.meta.model, prompt:.meta.prompt, starter:.meta.starter, lang:.meta.lang,
  shape:.shape, duration_ms:.output_ms, source_ms:.source_ms, cut_ms:.cut_ms,
  speed:.speed, wait_mode:.wait_mode, width:.probe.width, height:.probe.height,
  size_bytes:.probe.bytes, meta:.}' "$CAP/edit.json")"        # → prints the id
scripts/captures --upload <id> "$CAP/final.mp4"
scripts/captures --poster <id> "$CAP/poster.jpg"

scripts/captures                      # the unreviewed queue, as text
scripts/captures --status needs_work  # the RE-SHOOT list: what came back with feedback
scripts/captures --review 12 feedback "the sources scroll past too fast"
scripts/captures --undo 12            # take the last verdict back — the mis-swipe
```

The row is created before the bytes are uploaded (`video_key` stays null until
they land), so a failed upload leaves a visible incomplete clip rather than an
orphaned R2 object nobody can find.

Metadata lives in D1 (`captures`, `capture_reviews`); the MP4 and the poster
live in R2 under `captures/<id>/`. The video endpoint implements real HTTP
Range, because the whole point is a `<video>` element being scrubbed on a
card.

**The review feed** is its own admin-gated page at **`/captures/`** — reached
from the account panel's admin row, beside "Admin interface". (It lived inside
`/admin` until 2026-08-10; the owner moved it up a level because reviewing a
run is not an ops task. It is no longer in `src/panels.js`, on purpose.) Every
capture in the open list is on the page, one under the next: the clip, the
agent, the model, the prompt it answered, and the facts that describe the edit
(size, length, speed, how much was cut).

It was a one-card-at-a-time DECK until 2026-08-13, when the owner said what
was wrong with it: *"I can see only the next in queue — I want to scroll
through all of them north to south and swipe or review any one of my choice"*,
plus *"revert the one I just swiped right"*. The gesture math did not change;
what changed is that the reviewer picks the clip, and a verdict is reversible.

- **Swipe right → like.** Posts `{verdict:"like"}`, the capture becomes
  `liked`, and the card **stays where it is** wearing the verdict.
- **Swipe left → feedback.** A **note field opens inside the card**, under the
  clip it is about. Nothing is posted until Send. The server *requires* a note
  on a `feedback` verdict — a left swipe with no words is not a review, it is
  a shrug — so the field is the mechanism, not decoration.
- **Undo.** A filed card carries "↩︎ Undo the 👍": `DELETE
  …/captures/:id/review` deletes the review row, un-counts the like and
  reverts the status (to the verdict before it, or to the queue). This is why
  a filed card is not removed — there would be nothing left to undo against.
- Arrow keys and two explicit buttons do the same two things, and matter more
  on a feed than they did on a deck: nobody drags fifty cards with a mouse.
  The keys act on the focused card, else the first unfiled one in view.
- All four lists are the same reviewable feed. Changing your mind about a clip
  you already filed IS reviewing it.
- **Clips mount lazily**, 600px ahead of the fold. Fifty `preload="metadata"`
  videos on page open is fifty range requests, and on a phone that is a feed
  that will not scroll.

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
npm run capture -- --agents cyber,introspection --models <a>,<b> \
    --per-agent 2 --shape portrait --budget 90

# 2. look at ONE plan before encoding forty of them
npm run capture:edit -- captures/<date>/<first-slug> --dry-run

# 3. encode the batch once the knobs are right. --min-still 3500 because a
#    research run's activity bar ticks every ~2 s and the 1500 default
#    strobes; --wait speed keeps the search rounds visible.
npm run capture:edit -- --all captures/<date> --speed 1.25 --wait speed --min-still 3500

# 4. publish and review
scripts/captures --upload …          # per clip
open https://deepresearch.se/captures/   # the review feed
```

## Reading a clip without watching it

Three reviews in a row (#CAP-20/21/22, 2026-08-12) said some version of "look
at the last frame — it would have told you it went wrong". They were right, and
the last frame is worth treating as an instrument rather than an impression.
ffmpeg is not installed in the agent containers (`apt-get install -y
--no-install-recommends ffmpeg`), and once it is, a published clip answers
three questions in about a minute:

```bash
curl -su "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  https://deepresearch.se/api/admin/captures/22/video -o cap22.mp4
ffmpeg -v error -sseof -0.15 -i cap22.mp4 -frames:v 1 -update 1 -y last.jpg   # the verdict frame
ffmpeg -v error -i cap22.mp4 -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
  -f null - 2>/dev/null | paste - -                                          # per-frame luma
```

Then LOOK at `last.jpg`. #CAP-22's showed the built app replying "Error: could
not get a response." while the capture's stored `app_e2e` said all six checks
passed — the frame and the metadata disagreed, and the frame was right.

The per-frame luma is what settles a "blank frame" report, and it settled this
one against the obvious reading: **every near-white frame in all three clips
was at the HEAD (t=0.00–0.65 s, YAVG ≈ 235), none at the tail.** The blank was
the page-load white flash, reached because the card's `<video>` had `loop` set
and wrapped to t=0 the instant the clip ended. Fixed by ending on the last
frame with an explicit replay button (`public/js/captures.js`), but the general
lesson is the one worth keeping: *a report about where something appears in a
video is a measurement, not a description* — the reviewer describes what they
saw, which is not always where the file puts it.

**A version carries its own report.** `--add-version` used to overwrite every
describing column on the parent row except `meta_json`, `projectCaptureVersion`
never returned a version's `meta`, and materialising v1 dropped the report it
was materialised from. The visible symptom is the nastiest kind: a re-shoot
that plays v2 while quoting v1's grading, so the metadata vouches for a cut it
never saw. If you add a column that describes a cut, add it to all three places
or the row will lie about the next re-shoot.

## Traps

- **A PLACEHOLDER STARTER cannot be captured unattended.** Some starters open
  by promising input the harness never supplies — `cyb-attack-surface` is *"I
  will name a domain —"*, `cyb-street-view-site` and `cyb-sv-gata` name an
  address. The agent correctly answers `What is the domain?` and stops, which
  is a 19-character turn and a useless clip. The run gate fails it on
  `empty_answer` rather than publishing it (2026-08-14, the Cyber batch), so
  nothing bad ships — but it costs a run out of the batch. **Read the dry-run
  matrix's prompt column before recording** and reach past those with
  `--offset`; they are usually at the head of a queue, because they are the
  most on-topic thing the agent does.
- **`--add` prints prose, not JSON, unless you ask.** `id=$(scripts/captures
  --add "$payload" | jq -r .capture.id)` yields an EMPTY id — the default
  output starts with the word `capture`. An empty id then makes `--upload` and
  `--poster` no-ops that still exit 0, so a batch loop reports success and
  leaves five rows with no video. Pass `--json` in any pipeline — **before**
  `--add` or after the payload, never between them: `--add` takes the next
  word as its body, so `--add --json '{…}'` posts the flag itself and the row
  is never created.
- **A THRESHOLD CANNOT FIX A COMPARISON.** #CAP-10 (owner, 2026-08-14: *"video
  waits and waits for answer and then just the last frame shows the bottom of
  the reply"*) was 54 555 ms recorded, 43 644 ms delivered at 1.25× — that is
  `54555 / 1.25` **exactly**, so nothing at all was accelerated in a run that
  was mostly the pipeline searching. The activity bar ticked faster than any
  usable `--min-still`, so no two samples were byte-identical and the detector
  found zero dead air. Both obvious knob answers are wrong: `--min-still 1500`
  strobed (thirteen segments on a 54 s run, which is what the old
  `--min-still 3500` advice was for) and 3500 accelerated nothing at all. The
  fix was to compare only what a viewer can read (`readableSignature`), which
  makes 1500 correct again — **the old `--min-still 3500` advice is retired;
  leave the default alone.** Still read the segment table in `--dry-run` before
  encoding a batch; that is what it is for.
- **A wait that is not accelerated eats the answer.** The visible symptom is
  the one the owner reported: the clip spends its whole budget waiting and the
  last frame shows only the bottom of the reply, because the streaming answer
  never got room. When a plan's `thinking` line reads 0 s on a run that
  obviously searched, that is this bug, not a fast pipeline.
- **ffmpeg is not installed in the agent containers.** `--dry-run` works
  anyway, on purpose: the plan is reviewable without an encoder. To encode:
  `apt-get update && apt-get install -y --no-install-recommends ffmpeg`. The
  `--no-install-recommends` is load-bearing — a recommended VA-API driver 404s
  against the mirror and takes the whole install down with it, which is a
  confusing failure for something that has nothing to do with ffmpeg.
- **You cannot verify MP4 PLAYBACK in Playwright's Chromium.** It ships
  without proprietary codecs, so `canPlayType('video/mp4; codecs="avc1.42E01E"')`
  returns `''` and the card's `<video>` fails with
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
  is the one codec the feed and LinkedIn both need.
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
| `tests/capture.mjs` | The Playwright driver. Records, samples, writes the three sidecars; runs the Agent Studio gate. |
| `tests/app-e2e.mjs` | The generated app's end-to-end test: `exerciseApp` (on camera) + the pure `gradeApp`. |
| `scripts/capture-edit.mjs` | Plan → ffmpeg → `final.mp4` + `poster.jpg` + `edit.json`. |
| `src/captures.js` | D1 + R2 + `/api/admin/captures*`, including the like/feedback verdict and its undo. |
| `public/js/captures-core.js` | Pure swipe/feed logic (thresholds, tilt, hints, per-card state, formatting). |
| `public/captures/index.html` | The `/captures/` page shell (admin-gated in `src/index.js`). |
| `public/css/captures.css` | Its styles, incl. the feed (moved out of `admin.css` when the page split off). |
| `public/js/captures.js` | The feed UI that drives that page. |
| `scripts/captures` | The CLI over the admin API — publish, list, review. |
| `docs/VIDEO-CAPTURE.md` | The reference: file formats, API surface, field-by-field. |
| `references/ffmpeg-recipes.md` | Recipes beyond the default pipeline (captions, music, GIF, side-by-side). |
