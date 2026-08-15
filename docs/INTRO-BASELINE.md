# The intro baseline

**The intro phase is the sequence a first-time visitor walks before they are
inside one of the two tiers with a composer in front of them.** This document
is its specification: what it consists of, in what order, and by what mechanism
each part is held in place.

---

## 0. The mark

> **Owner directive, 2026-07-26 — the landing page is APPROVED and is the
> baseline.**
>
> The landing page as it stands at `600c7300` (`public/welcome/index.html`, the
> shared data-path diagrams, and the first-visit overlay it carries) is the
> accepted front door. **We are not going back to an earlier landing.** Future
> work BUILDS ON this one.
>
> **The whole intro phase for new visitors is tightly controlled from here
> on.** It is not a surface anyone improvises on. Every change to any of the
> surfaces in §2 is a deliberate edit to this document and to the contract test
> that pins it (`src/intro-phase.test.js`), in the same commit as the change.

Baseline commit: **`600c7300`** — *Merge the seventh 2026-07-26 ledger queue
(PRs #310–#311)*. Everything in §2 describes that state.

What "tightly controlled" means in practice, in one line each:

- **Additive, not revisionary.** Blocks may be added, sharpened, or reordered
  within the rules in §4. The page is not re-conceived, re-themed, or replaced.
- **No surface joins the intro silently.** A new first-visit overlay, greeter,
  animation, or interstitial is a change to §2 plus §5's enforcement, not a
  drive-by addition.
- **The tests are the contract, not a smoke check.** A red
  `src/intro-phase.test.js` means the intro moved; the fix is either restoring
  the behaviour or amending the contract on purpose.

---

## 1. Scope — where the intro starts and stops

It starts at the **first request from a browser that has never been here**, and
ends at whichever of these comes first:

- the composer is focused in **Se/cure** (`/cure`), or
- the visitor is at **sign-in** (`/login`) in **Se/rver**, or
- the visitor has left for one of the deep pages (`/story/`,
  `/architecture/`, `/pulse/`, `/build/`, the help sites, GitHub).

Everything reachable in that window is intro surface. Returning visitors get
the same *pages* with every first-visit layer suppressed (§3) — that
suppression is part of the contract, not a side effect.

---

## 2. What the intro consists of

### 2.1 The front door — `/` serves the landing IN PLACE

An unauthenticated `GET /` serves `public/welcome/index.html` through
`serveAsset` **without a redirect** (`src/index.js`, the unauthenticated branch
of `routeRequest`), so the URL a visitor was given — `deepresearch.se` — is the
URL they read the introduction at. The page is also directly reachable at
`/welcome/`. A signed-in arrival is forwarded to Se/rver instead and never sees
it.

The root has flipped between the landing and a `302` to `/cure` before. It does
not flip again by accident: the routing shape is pinned, and so is the absence
of the redirect.

### 2.2 The first-visit overlay — `#wintro`

Drawn over the landing on a first visit, before anything is read. Fixed
structure, in this order:

1. **`.wlogo`** — the icon and `<h2 class="wname">DeepResearch.se</h2>`.
2. **`.wlede`** — the tagline, in the same words the page's own hero uses.
3. **`.dodont`** — two columns, **It does** / **It doesn't**, three bullets
   each.
4. **`#wintrook`** — the "Got it" dismiss. A tap on the backdrop dismisses too.

The name-then-tagline-then-contrast order is the fix for **feedback #32**: the
overlay opens over a page nobody has read, so a does/doesn't grid with no
subject lands on nothing. The overlay is a doorway, not the page — **six
bullets and ~140 words are the ceiling**.

Six bullets are all the room there is, so each one is read as a statement about
the *site*, not about a tier. The client-side tier is the one that goes wrong
here: "runs entirely in your browser, on your own key" was written as an
unqualified **does**, and an owner read it as the whole property being
client-side (2026-08-06). It is one capability of two tiers, and the larger
feature set — workspaces, projects and the vault, RAG, the MCP server, Agent
Studio, Orchestrator, the Models agent — runs **server-side, in the cloud**,
behind the approval-gated tier. The browser bullet therefore carries its own
qualifier, in the same bullet rather than a later one nobody joins up.

### 2.3 The ghost mascot and its bubble — `#mascot`, `#mbubble`

Dismissing the overlay starts the mascot: the ghost travels in and stops just
left of the header's **ghost button**, raises its arm to point at it, and the
bubble explains that the ghost is the door to Se/cure — anonymous research in
the visitor's own browser, the server not in the data path.

While the bubble is up the background is **inert**: exactly two targets act —
the ghost button and the bubble's own link, both leading to `/cure`. Any other
tap is swallowed (`preventDefault` + `stopPropagation`) and closes the bubble.
Under `prefers-reduced-motion` the mascot arrives without travel. A 4.2 s
watchdog fires `arrive()` if `transitionend` is swallowed.

### 2.4 The landing page itself — the blocks, in order

| # | Block | What it is for |
|---|-------|----------------|
| 1 | Header bar | The wordmark, the **ghost button** (→ `/cure`), the **account button** (→ `/login`). The front door wears the app's own chrome. |
| 2 | Hero | Logo, `DeepResearch.se`, the tagline — plans its own searches, checks coverage, cites, within a time budget. |
| 3 | Promo video | `/llm-assiterad-utveckling.mp4`, autoplay-muted-loop. |
| 4 | `#focuscard` — "What work has been done and when" | The compact feature-focus timeline: chips as the legend/picker, `Busiest 6` / `All` / `None`, a link through to the full page. Behind the curves, the **code-volume backdrop** — how many lines the tree holds, on its own right-hand scale in thousands (added 2026-08-05). Hidden until the dataset parses. |
| 5 | "What this project is for" | The mission: privacy capabilities of LLM applications, stated precisely as a **deep-research security architecture**; the two tiers as the proof; still experimental; the build story as a pointer, not a lead. |
| 6 | "The architecture, in short" | One question, two data paths — the five deterministic phases, then the paired **Se/cure** and **Se/rver** diagrams, then the link to `/architecture/`. |
| 7 | "Some of what it does" | `ul.feat` — the capability list. Additive by R1: entries join it as capabilities ship (the **open model catalog** entry arrived 2026-07-27 with Hugging Face). No cap on its length — the ≤6 rule is the overlay's (R4), not this list's. |
| 8 | "Open source, MIT" | GitHub, the licence, the 80 % framing, and the claim that makes the page checkable: the site deploys straight from the repo. |
| 9 | `#askdemo` — "Questions before you sign in?" | The prepackaged answers (§2.5). |
| 10 | `.links` | The doors onward (§2.6). |
| 11 | `.cta` | **Sign in**, plus the invite-only / operator-approval note. |
| 12 | Footer | Not a commercial product; never placed on the market; the use restrictions at `/build/`. |

Block 4 carries **two units in one plot** and must keep them apart: the feature
curves count commits and read against the LEFT axis, the volume backdrop counts
lines the tree holds and reads against the RIGHT. The backdrop is drawn first,
under every curve, in a flat wash that must never compete with one — a series
seventh in colour and first in area would be worse than no backdrop at all.

Blocks 4 and 6 draw through **shared** sources rather than local copies: the
timeline and its backdrop through the pure core `/js/pulse-timeline-core.js`
(the same one `/pulse/timeline.html` uses), the diagrams through the standalone files
`/architecture/path-secure.svg` and `path-server.svg` (the same two
`/architecture/` embeds). Neither may be re-inlined or re-implemented.

The two diagrams name **providers**, so they go stale when the provider set
does — and a wrong diagram on the front door is worse than a plain one. Four
things move together when either is edited: the `<desc>`, both `alt` attributes
(landing *and* `/architecture/`), and the `/architecture/` comparison table.
Then **measure** the result instead of eyeballing it — render the SVG and check
each `<text>` node's `getBBox()` against its host `<rect>`, the same discipline
slash-spacing applies to the wordmark. Both files share one four-box provider
geometry (`x` = 8/110/212/314, 96 wide) so the tiers line up when read side by
side.

The named boxes are a legible SELECTION, not the full registry: Groq ships and
works in Se/cure but sits off the diagrams deliberately (2026-07-27), because
four boxes is what fits and Hugging Face's open catalog is the more interesting
case. What keeps that selection from reading as a boundary — and R11 with it —
is the escape-hatch row, "…or ANY other OpenAI-compatible endpoint".

### 2.5 The prepackaged ask demo — `#askdemo`

Five chips (*What is this? / Is it private? / How is it built? / What does it
cost? / How do I sign in?*) and a free-text box, answered by
`public/js/canned-faq.js` with `tier: "drs"`. **No language model is in this
path** — there cannot be one, the visitor is signed out. Every reply carries
the `CANNED_LABEL` badge so it can never be mistaken for the research model,
and the answers follow the language of the question (EN/SV, invariant 6). The
five ids `#askdemo`, `#askchips`, `#askmsgs`, `#askform`, `#askinput` are
load-bearing: the inline module looks each up by id and throws on the first
missing one, taking the rest of the script with it.

### 2.6 The doors onward — `.links`

Eight, in this order: `/cure` (**Try it now, no account**), `/story/`,
`/architecture/`, `/pulse/`, `/build/`, `/cure/help/`, `/help/`, GitHub. Plus
the two in the header (ghost → `/cure`, account → `/login`) and the CTA's
**Sign in**. Every one of these is reachable **without authentication** — an
auth wall inside the intro is a broken intro (§4, R9).

### 2.7 Se/cure's own first run — `/cure`

A visitor who takes the ghost door gets the tier's own three-beat first run:

1. **The umbrella intro** (`public/cure/umbrella.js`, driven from
   `public/cure/drc.js`) — the logotype's flag vortex untwists into wireframe
   umbrellas, the camera swings a quarter circle, colour floods back. ~5.9 s at
   default speed. Tap to skip.
2. **The greeter** — `#ghostsay`, the little ghost naming the tier, stating
   what this session actually exposes, saying plainly that it is a research
   project and not a product, and pointing at the **account button**. Once per
   browser; dismisses on its ✕ or any outside tap (UX-1).
3. **The composer** — and nothing else. Since the **2026-07-12 onboarding
   directive** the promotional `#intro` glass pane **does not auto-open**; new
   users land in the input. The pane stays available on demand by tapping the
   wordmark, and its publication shelf is prefetched so it is populated
   whenever it is opened.

The strolling ghost (`ghostwalk.js`) is chained onto a **real** intro play and
held behind the greeter until it is dismissed.

There is deliberately **no** "hide the chrome until the intro plays" head
script: the chat UI always paints, because an earlier guard turned a stalled
animation into a blank khaki screen.

### 2.8 Se/rver's own first run — the signed-in app

The blue tier's counterpart (`public/js/balloon-intro.js`, gated in
`public/js/app.js`): the same opening beat, but the disc is a balloon crown,
the camera drops a full 180°, and it ends looking up at a five-balloon fleet.
Deliberately faster than the umbrella (~4.1 s). It is followed by the balloon
greeter — the one and only appearance of the tier's figure, per **UX-3**
(mascots are first-visit pointers, never persistent).

### 2.9 Sign-in and the approval gate

`/login` is where the Se/rver door leads. The landing states the gate before
the visitor spends a click on it: **invite-only, new accounts await the
operator's approval after signing in with Google.** The intro never implies
open signup.

---

## 3. The state that makes a visit "first"

Every layer is gated on one `localStorage` key, every read and write wrapped
so blocked storage degrades to "unseen" rather than throwing.

| Key | Gates | Set | Notes |
|---|---|---|---|
| `dr_welcome_seen` | The landing overlay `#wintro` (and therefore the mascot) | On dismiss | Replay: `?anim=1`; suppress: `?anim=0` |
| `dr_umbrella_seen_v2` | Se/cure's umbrella intro | **Only after the intro actually ran** | Versioned key: the v1 key was set *before* the play, so a browser that hit the stuck-canvas bug recorded an intro it never saw |
| `dr_secure_intro_seen` | Se/cure's `#ghostsay` greeter | On show | |
| `dr_intro_seen` | Se/cure's `#intro` glass pane | After the umbrella beat | The pane no longer auto-opens; the key keeps anything from re-popping it |
| `dr_rver_intro_seen` | Se/rver's balloon intro | **Only after `onDone`** | Same discipline as the umbrella |
| `dr_intro_plays` / `dr_rver_intro_plays` | The per-tier reverse-play easter egg (every 40th play) | Per play | Independent counters, one per tier |

**Suppression gates, all three tiers of intro:** `prefers-reduced-motion`,
already-seen, and a deep link (`?try=`, a project, a published replay) each
suppress the animation. `?anim=1` — and `?anim=rev` for the reverse play —
force through **all** of them, and are the supported verification path.

**`?anim=0` is the mirror image: it forces the intro OFF through all of
them**, the never-been-here case included, on whichever surface it is used on.
On the landing that is the `#wintro` overlay and the mascot beat behind it; on
`/cure` the umbrella intro, the `#ghostsay` greeter, the `#intro` pane's
first-visit bookkeeping, and the strolling ghost chained onto a real play; on
Se/rver the balloon intro and the balloon greeter that follows it. It exists
because a screen recording of the product should not spend its first seconds
on an animation — the capture harness appends it to every recording URL. Two
properties make it safe to hand to a recorder:

- **Exactly the value `0` counts.** No other value is read as "off", so a
  stray or truncated parameter cannot silently disable the front door.
- **It writes no `seen` key.** Suppressing an intro is not the same as
  consuming a visitor's one first visit: after a recording, a real person on
  that browser still gets the intro. This is the same rule as the next
  paragraph, seen from the other side.

**Marking "seen" only after a real play is a rule, not an implementation
detail.** A browser gets its one first visit; a failed module load must not
burn it.

---

## 4. The rules the intro obeys

| | Rule |
|---|---|
| **R1** | **Additive only.** The baseline in §0 is not reverted to an earlier design. Changes build on it. |
| **R2** | **The root serves the landing in place.** No redirect from `/`; `deepresearch.se` is itself the introduction. |
| **R3** | **Introduce before contrasting.** Name → tagline → does/doesn't. A contrast with no subject is feedback #32. |
| **R4** | **The overlay is a doorway.** ≤ 6 bullets, ≤ ~140 words, one dismiss. |
| **R5** | **Secure-first and full-URL branding.** Wherever the tiers are named together — prose, lists, paired diagrams — **Se/cure** comes first, and both are written as `DeepResearch.` + the bold slashed tail (`docs/BRANDING.md`). |
| **R6** | **Decoration never blocks.** Every animation is skippable, watchdogged, wrapped, and fail-soft; nothing downstream awaits it; the chat UI paints regardless. |
| **R7** | **No language model in the intro.** The signed-out helper is prepackaged and badged as such. |
| **R8** | **Mascots are first-visit pointers, never persistent** (UX-3), and ambient motion stays low. |
| **R9** | **Every intro door is public.** Each surface the intro links to is served without auth. |
| **R10** | **Shared, not copied.** Diagrams, the timeline core, and the canned FAQ have exactly one implementation each; the intro references them. |
| **R11** | **Honest framing.** Experimental, not production-ready, not a commercial product, invite-only. The intro says so where it would be easiest not to. |
| **R12** | **A broken part removes itself.** A dataset that will not parse leaves `#focuscard` hidden — a broken chart on the front door is worse than no chart. |

---

## 5. How each rule is ensured

Three mechanisms carry the whole contract: **routing code**, **the public-asset
allowlist**, and **two test files that read the tree**.

| Rule | Mechanism | Pinned by |
|---|---|---|
| R1 | This document + the baseline marker comment in `public/welcome/index.html` | `intro-phase.test.js` — "the landing carries the baseline marker" |
| R2 | `src/index.js` unauthenticated branch → `serveAsset(… "/welcome/")` | `landing.test.js` — "the root serves the landing asset in place, not a redirect" |
| R3 | Markup order inside `#wintro` | `landing.test.js` — "the introduction comes BEFORE the does/doesn't contrast" |
| R4 | — | `landing.test.js` — "stays short — it is a doorway, not the page" |
| R5 | Markup and copy | `landing.test.js` — "names Se/cure before Se/rver…"; `intro-phase.test.js` — the wordmark-shape check |
| R6 | `try`/`catch` wrappers, `.catch(() => {})`, the transition watchdog, the deliberate absence of a chrome-hiding head script | `intro-phase.test.js` — the reduced-motion, watchdog, and no-head-guard checks |
| §3's `?anim=0` | One `anim=0` test per surface, placed at the same seam that reads `?anim=1`, returning before any `seen` key is written | `intro-phase.test.js` — "the intro OFF switch" suite |
| R7 | `canned-faq.js` with `CANNED_LABEL`; no `/api/chat` on the landing | `intro-phase.test.js` — "the signed-out helper is prepackaged, never the model" |
| R8 | First-visit gating in `drc.js` / `app.js` | UX-3 in the `ux-conventions` skill; `intro-phase.test.js` — the seen-key table |
| R9 | `isPublicAsset` in `src/assets.js` | `intro-phase.test.js` — "every door the intro offers is reachable without auth" |
| R10 | Shared files and pure cores | `landing.test.js` — the diagram and timeline-core suites, including "the curves are drawn over the code-volume backdrop, on its own right-hand scale" |
| R11 | Copy in the landing, the overlay, and Se/cure's greeter | `intro-phase.test.js` — the honest-framing checks; `landing.test.js` — "frames the browser-only tier as ONE option, not the whole property" |
| R12 | `#focuscard` starts `hidden`, revealed only after the fetch parses; a dataset with no `volume` block simply draws no backdrop | `landing.test.js` — "the card removes itself when the dataset can't be read"; `pulse-timeline-core.test.js` — "a dataset built before the series existed draws no backdrop" |

Plus the repo-wide guard that already covers these pages:
`src/static-pages.test.js` asserts every id an inline script reaches for exists
in the same file — the failure mode that once left `/story/` stuck on
"Loading…" forever with every unit test green.

The animations' own maths is unit-tested separately from this contract:
`public/js/umbrella-intro.test.js` and `public/js/balloon-intro.test.js` pin
the phase timelines and geometry, including the faster-than-the-umbrella
directive for the balloon.

---

## 6. Changing the intro

1. **Read §2 first** and decide which surface you are touching. If the change
   adds a surface, it is a §2 subsection, not an appendix.
2. **Check it against §4.** A change that breaks a rule needs the owner, not a
   workaround.
3. **Change the code and this document in the same commit.**
4. **Extend the contract** — `src/intro-phase.test.js` for cross-surface rules,
   `src/landing.test.js` for the landing's own structure. A new rule with no
   test is a rule that lasts until the next session.
5. **Verify the replay paths by hand**: `/?anim=1`, `/cure?anim=1`,
   `/cure?anim=rev`, `/rver?anim=1`, and a genuinely fresh profile. The OFF
   switch is verified the same way, on a fresh profile that has seen nothing:
   `/?anim=0`, `/cure?anim=0`, `/rver?anim=0` must show no intro layer at all
   — and the next visit WITHOUT the parameter must still play it, which is how
   you see that nothing was marked seen.
6. **Run `npm test`.** Editing tracked text can stale the committed docs
   corpus; regenerate with `npm run bundle:docs` / `bundle:docs-rag`, never by
   hand.

---

## 7. File map

| Path | Role in the intro |
|---|---|
| `public/welcome/index.html` | The landing: the page, the `#wintro` overlay, the mascot, the ask demo, the timeline card. Carries the baseline marker. |
| `src/index.js` | Serves the landing in place at `/` for unauthenticated visitors |
| `src/assets.js` | `isPublicAsset` — what the intro may link to without auth |
| `public/architecture/path-secure.svg`, `path-server.svg` | The two shared data-path diagrams |
| `public/js/pulse-timeline-core.js` | The shared timeline maths behind `#focuscard` |
| `public/js/canned-faq.js` | The prepackaged signed-out helper, both tiers |
| `public/cure/index.html`, `drc.js` | Se/cure's first run: `#intro`, `#ghostsay`, the gating |
| `public/cure/umbrella.js`, `ghostwalk.js` | Se/cure's intro animation and the strolling ghost |
| `public/js/app.js`, `balloon-intro.js`, `balloon.js` | Se/rver's intro animation, its gate, and the greeter |
| `src/intro-phase.test.js` | The cross-surface intro contract |
| `src/landing.test.js` | The landing page's own structure |
| `src/static-pages.test.js` | The repo-wide inline-script id guard |

Related: `docs/BRANDING.md` (R5), `docs/PRIVACY-MODEL.md` (what the intro's
privacy claims must stay true to), the `ux-conventions` skill (UX-1, UX-3,
UX-19), and the `ui-notes` skill.
