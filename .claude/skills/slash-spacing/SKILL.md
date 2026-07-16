---
name: slash-spacing
description: >-
  Load whenever the space around the wordmark SLASH — the `.sl` span in
  DeepResearch.Se/cure and DeepResearch.Se/rver — must be decided, checked,
  or fixed: "the slash touches the letters", "the wordmark looks too
  tight/loose", adding the wordmark to a NEW surface (page, popover, email,
  PDF), changing a surface's font family/weight/style, or touching any
  `.sl { margin: … }` rule or `wmHtml` (public/js/drc-page-core.js). Owns
  the measurement tool `scripts/slash-gap.mjs` (true ink-gap metering in
  headless Chromium), the codified gap band, the per-context override
  convention, and the audit table of every surface that renders the slash.
---

# Slash spacing — deciding the `.sl` margin precisely

## What this is

The two product tiers are always written DeepResearch.**Se/cure** and
DeepResearch.**Se/rver** (branding rule, CLAUDE.md). In rendered UI the
slash is wrapped in `<span class="sl">/</span>` and pulled toward its
neighbours with a negative margin so the wordplay reads as ONE word
("Secure", "Server") rather than three tokens. The global rule everywhere
is:

```css
.sl { margin: 0 -.12em; }
```

`wmHtml` in `public/js/drc-page-core.js` produces this markup for
JS-built prose; static pages hand-write it. **Plain text (markdown, docs,
commit messages, prompts) never tightens — no span, no rule.**

## The problem this skill solves

**The right margin depends on the font — there is no one correct
constant.** The visual gap is set by the glyph *ink*: the side bearings of
the letter before the slash (always an `e`), the slash's own slope and
stroke width, and the first letter after it (`c` or `r`). Those vary by
family, by weight (bold ink is wider — the gap shrinks), and by style.
`-.12em` was tuned by eye for the app's regular-weight UI font; drop the
same constant into a **bold** run or another family and the glyphs can
touch (the 2026-07-16 report: the help page's bold
`DeepResearch.Se/cure` in the privacy-flag box rendered with the slash
touching the `e` and `c`).

Two hand-tuned overrides already existed before this skill — evidence the
constant was never universal:

- `public/welcome/index.html`: `#mbubble .sl { margin: 0 .02em; }` (a
  *positive* margin — that context needed MORE space, not less)
- `public/cure/drc.css`: `#ghostsay .sl, #drspop .sl { margin: 0 -.04em; }`

**Never decide by eyeballing a screenshot at one size on one machine.**
Measure.

## The measurement tool

```bash
node scripts/slash-gap.mjs                    # default sweep (400 + 700, sans set)
node scripts/slash-gap.mjs --weights 700      # a bold context
node scripts/slash-gap.mjs --fonts "DejaVu Sans" --margin -0.06
node scripts/slash-gap.mjs --style italic --json
```

`scripts/slash-gap.mjs` renders each run of the wordmark ("Se", "/",
"cure"/"rver") in headless Chromium (the pre-installed Playwright binary,
no npm deps) and measures the **true minimum ink distance** between
adjacent runs by scanning per-pixel-row edge profiles. Two facts make this
exact rather than approximate:

1. **Bounding boxes are useless here** — the slash is diagonal, so its box
   overlaps its neighbours' boxes long before any ink touches. Only a
   per-row ink scan measures what the eye sees.
2. **The span boundary breaks kerning**, so the DOM layout really is
   `advance(left) + margin + advance(/) + margin + advance(right)`. The
   gap therefore varies LINEARLY with the margin — `gap(m) = gap(0) + m`
   (in em) — and the tool solves for the recommended margin directly
   instead of iterating.

Output: per (family, weight, word) the left gap (`e→/`) and right gap
(`/→c` or `/→r`) at margin 0 and at the margin under test, a verdict
(`TOUCHES/OVERLAPS` / `too tight` / `ok` / `loose`), and a recommended
margin per configuration.

## The codified gap band

Per SIDE, in em of the rendered font size:

| | value | meaning |
|---|---|---|
| **floor** | `0.03em` | below this, anti-aliasing fuses the glyphs at body-text sizes (0.03em ≈ 0.5px at 16px) |
| **target** | `0.06em` | ≈ 1px at 16px — clearly separated, still much tighter than a normal `/` |
| **loose** | `> 0.12em` | tighter than nothing, but the wordplay stops reading as one word |

Decision rule: **pick the LEAST tightening that the worst-case font in the
surface's real stack needs** — i.e. take the recommended margin per
configuration and use the one closest to zero (it can be positive — see
`#mbubble`). Round to a hundredth of an em. A tie between "slightly loose"
and "risks the floor" resolves toward loose: the 2026-07-16 complaint was
touching, nobody has ever complained the slash was too airy.

## Measured facts (2026-07-16, container fonts)

Linux proxies measured: DejaVu Sans (Chromium's `system-ui` here),
Liberation Sans (= Chromium's `sans-serif` here; Arial-metric), FreeSans
(Helvetica-metric). Key numbers, worst word (`Se/rver` right side is
always tighter than `Se/cure`'s):

- **The LEFT side (`e→/`) is always the tight side**: gap@0 is only
  0.083–0.118em across all measured configs — so the global `-.12em`
  consumes it entirely (verdict `TOUCHES/OVERLAPS` in every measured
  config, worst in bold Liberation at −0.037em of overlap).
- **`-.04em` passes everywhere measured**: worst side +0.043em, all
  verdicts `ok`. This is also exactly the value the `#ghostsay`/`#drspop`
  override had already converged on by hand.
- Bold is tighter than regular in Arial-metric fonts (0.083 vs 0.093) but
  slightly wider in DejaVu (0.118 vs 0.110) — weight alone doesn't predict
  the direction; measure.

Caveat: the fonts real users resolve (`system-ui` → SF Pro on Apple,
Segoe UI on Windows, Roboto on Android) are NOT installable here. The
container numbers are the measurable worst-case proxies; `-.12em`
evidently renders acceptably at REGULAR weight on the owner's devices (it
is the standing default they chose), while bold at `-.12em` touches on
device too (the report that created this skill). So: use the tool for the
relative decision, keep the on-device check for anything user-visible
(the **testable-interaction-points** flow, or ask the owner — the
**on-device-trace** skill if it only reproduces there).

## How to apply a decision

1. Identify the surface's REAL font context: family stack, weight
   (wordmarks are usually inside `<b>` — that's `700`), style, and any
   `letter-spacing` (letter-spacing adds to both gaps; subtract it).
2. Run the tool for that context; read the recommended margin; round
   toward less tightening.
3. Scope the override NEXT TO the surface's existing `.sl` rule — never
   change the global `-.12em` (it is the owner-approved default for the
   regular-weight app chrome). Convention:

   ```css
   .sl { margin: 0 -.12em; }
   /* Bold ink is wider — the global tightening makes the slash touch
      (measured: scripts/slash-gap.mjs --weights 700). */
   b .sl { margin: 0 -.04em; }
   ```

4. If the page is served pre-auth, remember the snapshot freshness gate:
   `npm run bundle` after editing any bundled source file, or `npm test`
   fails.
5. User-visible spacing change → queue a try-it point
   (**testable-interaction-points**) so the owner confirms on device.

## Audit table — every surface that renders `.sl`

The global rule appears in 8 stylesheets; instances are mostly BOLD.
Fixed vs still running on the global constant (as of 2026-07-16):

| surface | rule | bold wordmarks? | status |
|---|---|---|---|
| `public/help/index.html` (Se/rver docs) | `-.12em` + `b .sl -.04em` | yes | FIXED 2026-07-16 (the reported instance) |
| `public/cure/help/index.html` (Se/cure docs, split 2026-07-16) | `-.12em` + `b .sl -.04em` | yes | FIXED 2026-07-16 (same fix at merge time) |
| `public/css/app.css` (app + header brand) | `-.12em` | yes (header `<b>`) | on the global constant — owner-tuned, leave unless reported |
| `public/cure/drc.css` | `-.12em` + `#ghostsay/#drspop -.04em` + `#proxybanner/#notices -.04em` | many | partial (`#proxybanner`/`#notices` MEASURED + fixed 2026-07-16 — owner report: proxy banner + footer notices too tight) |
| `public/welcome/index.html` | `-.12em` + `#mbubble +.02em` | yes | partial |
| `public/build/index.html` | `-.12em` | yes | unmeasured on device |
| `public/architecture/index.html` | `-.12em` | yes | unmeasured on device |
| `src/login.js` (login/terms pages) | `-.12em` | yes | unmeasured on device |
| `docs/symbol-language/proposals.html` | `-.12em` | yes | internal doc, low stakes |

When a new report names one of the unfixed surfaces, apply steps 1–5; when
adding the wordmark to a NEW surface, decide the margin with the tool
BEFORE shipping instead of inheriting `-.12em` blind.
