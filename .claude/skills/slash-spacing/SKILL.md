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
same constant into a **bold** run, a smaller body-text size, or another
family and the glyphs can touch (the 2026-07-16 report: the help page's
bold `DeepResearch.Se/cure` in the privacy-flag box rendered with the
slash touching the `e` and `c`; a second 2026-07-16 report found the SAME
page's plain-weight body prose — e.g. "Se/cure is a deep-research
assistant…" under "What this tier is" — touching too, at the smaller
`.92rem` paragraph size, disproving the earlier assumption that regular
weight was safe at `-.12em` on device).

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
container numbers are the measurable worst-case proxies. `-.12em`
evidently renders acceptably at REGULAR weight in the app's own UI chrome
(the standing global default) — but that does NOT generalize to every
regular-weight context: the docs pages' `.92rem` body prose touched at
`-.12em` too (2026-07-16, second report), so size matters as much as
weight. **Don't assume "not bold" means safe — measure the surface's
actual font-size, not just its weight.** Where `-.04em` measures `ok` at
BOTH 400 and 700 for a page's font stack (true for both docs pages, see
the audit table), prefer ONE page-wide `.sl` rule over a `b .sl`-only
override — it's simpler and covers regular-weight prose the bold-only
rule would silently miss. So: use the tool for the relative decision,
keep the on-device check for anything user-visible (the
**testable-interaction-points** flow, or ask the owner — the
**on-device-trace** skill if it only reproduces there).

## How to apply a decision

1. Identify the surface's REAL font context: family stack, EVERY weight
   the slash actually renders at on that page (check for un-bolded
   `Se<span class="sl">/</span>cure` in body prose, not just the `<b>`
   wordmark — a page mixing both needs both weights tested), the body
   font-SIZE (a smaller `.92rem` paragraph is tighter than 16px UI text),
   style, and any `letter-spacing` (adds to both gaps; subtract it).
2. Run the tool for each weight present; read the recommended margin;
   round toward less tightening.
3. Scope the override NEXT TO the surface's existing `.sl` rule — never
   change the global `-.12em` (it is the owner-approved default for the
   app's own regular-weight UI chrome, not for every page that inherits
   the rule). Two shapes, pick by what step 2 found:

   ```css
   /* Only bold touches; regular measures ok at -.12em on this surface. */
   .sl { margin: 0 -.12em; }
   b .sl { margin: 0 -.04em; }

   /* Both weights touch at this page's font-size (docs pages, 2026-07-16:
      .92rem body prose plus <b> wordmarks both needed tightening) — one
      rule, no bold-only carve-out to forget. */
   .sl { margin: 0 -.04em; }
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
| `public/help/index.html` (Se/rver docs) | `-.04em` (page-wide) | yes + regular body prose | FIXED 2026-07-16, RE-FIXED 2026-07-16 (regular-weight `.92rem` prose touched too — collapsed to one page-wide rule, see Measured facts) |
| `public/cure/help/index.html` (Se/cure docs, split 2026-07-16) | `-.04em` (page-wide) | yes + regular body prose | FIXED 2026-07-16, RE-FIXED 2026-07-16 (the reported instance: "Se/cure is a deep-research assistant…" under "What this tier is" — regular weight, not bold) |
| `public/css/app.css` (app + header brand) | `-.12em` | yes (header `<b>`) | on the global constant — owner-tuned, leave unless reported |
| `public/cure/drc.css` | `-.12em` + `#ghostsay/#drspop -.04em` + `#proxybanner/#notices -.04em` + `#settingsview .setting-pop -.04em` + `#accountview -.04em` | many | partial (`#proxybanner`/`#notices` MEASURED + fixed 2026-07-16; the settings-drawer ⓘ pops MEASURED + fixed 2026-07-17 — owner report: the secure-research-space pop (`#proxypop`) too tight; scoped to the whole `.setting-pop` class since `#wspop`/`#localpop` share the same `.8rem` mixed-weight prose context; the account drawer MEASURED + fixed 2026-07-18 — owner report: ~5-6 wordmarks in the account panel's `.82rem`/`.9rem`/`.74rem` prose touching, one page-scoped `#accountview .sl` rule covers the whole drawer) |
| `public/welcome/index.html` | `-.12em` + `#mbubble +.02em` | yes | partial |
| `public/build/index.html` | `-.12em` | yes | unmeasured on device |
| `public/architecture/index.html` | `-.12em` | yes | unmeasured on device |
| `src/login.js` (login/terms pages) | `-.12em` | yes | unmeasured on device |
| `docs/symbol-language/proposals.html` | `-.12em` | yes | internal doc, low stakes |

When a new report names one of the unfixed surfaces, apply steps 1–5; when
adding the wordmark to a NEW surface, decide the margin with the tool
BEFORE shipping instead of inheriting `-.12em` blind.
