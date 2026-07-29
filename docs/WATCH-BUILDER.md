# The NHxx watch builder

*Shipped 2026-07-29. The public surface is `/watch/`; the code is
`public/js/watch-core.js` (pure core, Node-tested), `public/js/watch-render.js`
(WebGL), `public/watch/` (the page) and `src/watch.js` (the façade plus
`GET /api/watch/catalog`).*

Pick a case, a dial, a set of hands and the rest of the stack, and the finished
watch assembles itself in 3D: rotate it, zoom it, turn the lights out to see the
lume, save the frame as a PNG. Beside it the page answers the two questions a
mod build actually turns on — **does this combination fit**, and **where do I
buy the parts**.

The subject is the Seiko/TMI **NHxx** movement family, because that family is
what created the modding market: one footprint (27.40 mm across, 5.32 mm tall),
one dial size (28.5 mm), one set of hand tubes (1.50 / 0.90 / 0.20 mm), and
hundreds of interchangeable cases, dials and hands built around it. That is the
whole reason a mix-and-match tool is possible at all.

---

## 1. What was researched, and what came back

Two research questions, both asked before a line was written.

### 1.1 Which of the pre-populated sandbox tools are useful here

The execution sandbox this platform ships (`container/Dockerfile`, the
per-session Cloudflare Container in `src/exec-container.js`) is pre-populated
with a fixed toolchain, installed at image build time. It carries:

| Present | Useful here? |
|---|---|
| `bash`, `coreutils`, `findutils`, `grep`, `sed`, `gawk` | yes — driving everything below |
| `nodejs` | **yes, decisively** — see §2 |
| `python3` + `python3-venv` | stdlib only; see the caveat below |
| `sqlite3` | yes, if the parts index outgrows a JS module |
| `jq` | yes — querying `/api/watch/catalog` from a shell |
| `git`, `ripgrep`, `tree`, `file`, `less`, `bc` | incidental |
| `tar`, `gzip`, `bzip2`, `xz`, `zip`, `unzip` | incidental |

And, decisively, what it does **not** carry:

- **No 3D renderer.** No Blender, no OpenSCAD, no FreeCAD, no POV-Ray.
- **No raster imaging.** No ImageMagick, no GraphicsMagick, no `libvips`.
- **No graphics stack at all.** No Mesa, no OSMesa, no EGL, no X, no GPU.
- **No Python packages.** `python3` is there; `pip` has nothing to install
  from, because —
- **No network.** The container runs with `enableInternet: false`, matching the
  browser VM. `apt-get install blender` cannot run, on purpose. The Dockerfile
  says it in as many words: *"a missing tool is a failed research pass, not a
  slow one."*

So **nothing in the sandbox can render a watch**, and nothing can be added to it
at run time. Rather than a gap to route around, that settles the second
question.

### 1.2 What actually produces the required outcome

The requirement was not "an image". It was *a picture of a complete watch that
you can rotate and zoom in and out*. Those verbs are the specification, and they
rule out most of the plausible pipelines:

| Approach | Verdict |
|---|---|
| Render server-side (Blender/POV-Ray) and serve a PNG | **No.** Not installed, not installable, and it gives one fixed angle. Rotation would mean a render round-trip per frame. |
| Pre-render a turntable — N frames per configuration, scrub between them | **No.** The catalogue has 20 cases × 15 dials × 8 hand sets × 7 finishes × 7 inserts before the other four slots, so the product runs to millions of configurations. |
| Server-side headless GL (`gl` npm package, SwiftShader) | **No.** A native dependency and a build step, both of which invariant 5 forbids, and still a frame per interaction. |
| Ship a 3D asset per part (glTF) and a viewer | **No.** Hundreds of authored assets to make and host, and every dimension in them would be divorced from the catalogue's millimetres — change a spec, and the model silently disagrees. |
| **Generate the geometry in JavaScript from the catalogue and draw it with WebGL in the reader's browser** | **Yes.** |

The last one wins on every axis that matters here. Rotation and zoom are free
(they are camera state, not a request). There is no build step, no vendored
engine and no new dependency — the geometry is a few hundred lines of maths and
the shading is one vertex/fragment pair. Nothing is authored twice, because the
render is *generated from the spec sheet*: a case's diameter, lug-to-lug,
thickness and lug width are the numbers the mesh is built out of, so the picture
cannot drift from the data. And it is a natural fit for the repo's existing
shape — `/space/` already renders interactive 3D from a Node-tested pure core.

The sandbox toolchain still earns its keep, on the half that needs no browser.
Node — which the image does carry — runs `npm test`, and the test suite is where
the geometry is actually verified: 81 checks over the catalogue's integrity, the
compatibility rules and the mesh builders. `jq` against
`GET /api/watch/catalog` is how an agent or a shell asks what a case measures
without rendering anything. The sandbox verifies and queries; the browser
renders.

### 1.3 Sources

Every dimension in the catalogue carries a `src` key naming where it came from,
and the page shows it under the spec sheet. The `SOURCES` table in
`watch-core.js` is the full list; the ones that carry the most numbers are:

- [Assemble Watches — NH35 compatible parts](https://assemble.watch/blog/nh35-compatible-parts)
  and [the NH35 movement guide](https://assemble.watch/blog/nh35-movement-guide)
  — movement dimensions, the 28.5 mm dial, the 1.50/0.90/0.20 mm hand tubes.
- [DLW Watches — case size comparison](https://www.dlwwatches.com/pages/case-size-comparison)
  — SKX-platform mod cases, diameter / lug-to-lug / lug width.
- [Strapcode — Seiko diver dimensions](https://www.strapcode.com/pages/seiko-divers-watch-dimension)
  — the Seiko references the mod cases homage.
- [CrystalTimes case catalogue](https://usa.crystaltimes.net/product-category/cases/)
  — which conversions exist on which platform, and crown positions.
- [Watch&Style](https://watchandstyle.net/products/skx007-double-dome-sapphire-crystal-for-flat-insert)
  — the SKX crystal (31.5 mm) and insert (38 / 31.8 mm) figures.
- Vendor listings for the case-specific families:
  [Thorn](https://www.thornwatches.com/products/62mas-diving-40mm-silver-sterile-watch-case-domed-sapphire-glass-fit-nh35-nh36-movement)
  and [WR Watches](https://wrwatches.com/products/62mas-case-set-for-seiko-mod) (62MAS),
  [KARAJAN](https://diywatchmod.com/products/silver-tuna-case-for-nh35-nh36-movement) (Tuna),
  [Tandorio](https://tandoriowatch.com/products/tandorio-titanium-turtle-diver) (Turtle),
  [seikomods CT714](https://www.seikomods.com/shop/ct714-skx013-to-mini-turtle-conversion-case-crown-at-3/) (mini Turtle),
  [Exquisite Timepieces](https://www.exquisitetimepieces.com/blog/all-about-the-seiko-willard/) (6105 Willard),
  and [AliExpress's own NH35-case reference article](https://www.aliexpress.com/s/wiki-ssr/article/seiko-nh35-size)
  (crystal materials, crown thread, 316L, clearance).

---

## 2. No invented millimetres

Watch modding is a domain where a tenth of a millimetre decides whether a case
closes. A confident wrong number is worse than an honest range, so the catalogue
holds itself to three rules, and `watch-core.test.js` enforces the ones a test
can reach:

1. **Every dimension names its source.** `src` on each case, resolved through
   `SOURCES` to a label and a URL, surfaced in the UI.
2. **Anything off a listing rather than a spec sheet is flagged** `approx: true`,
   and the UI renders it with a leading `≈`.
3. **Where sources disagree, the disagreement is carried, not averaged.** The
   62MAS ships in two families (a 40 mm/15 mm-thick one and a 41 mm/11.2 mm one)
   that take different crystals; the SKX013 is quoted at 37 mm and 38 mm
   depending on where the caliper sits; the 1970 6105 has 19 mm lugs while the
   SKX-platform conversion cases are commonly 20 mm. All three are in the
   catalogue's `note` fields and shown on the page.

Two known conflicts are recorded rather than resolved. The NH35's outside
diameter is republished as both 27.40 mm and 28.4 mm — the second is the dial
seat, not the movement, so the catalogue carries 27.40 and says so. And retailer
pages disagree on whether the NH36's day module makes it taller than the NH35's
5.32 mm; most restate 5.32, so that is what is carried, with the caveat attached
to the movement.

---

## 3. How the render works

All of it is generated. Nothing is an authored asset.

**A watch is a solid of revolution.** The case flank, bezel, crystal, rehaut,
crown and case back are all lathed: `lathe(profile, segments, radiusAt)` revolves
a 2D silhouette, and `radiusAt` modulates the radius by angle so the same builder
produces a round diver, a superelliptical cushion (Turtle, Willard), a flattened
tonneau (Samurai) and a lobed shroud (Tuna). Profile points carry an optional
`s` flag: smooth points average their normals across the join (a crystal dome),
unmarked ones crease (a machined edge). That one flag is what separates a domed
sapphire from a faceted one, so it has its own test.

**The silhouette comes from the spec sheet.** `caseProfile` builds the profile
out of the catalogue's diameter and thickness, so the rendered case is exactly as
tall and as wide as the numbers say, and the lugs literally end at the recorded
lug-to-lug. Change a dimension and the picture changes with it.

**The flat parts are discs.** Dial, bezel insert and rehaut are annuli and cones
with radial UVs, and the dial and insert are painted into 2D canvases from
`dialLayout` / `bezelLayout` — declarative layouts the tests can check without a
canvas anywhere. Hands are extruded outlines, stacked so the seconds hand sits on
top.

**Lume is a second texture.** The dial and insert painters emit an albedo canvas
and a lume mask; "lights out" collapses the lighting and multiplies the mask by
the compound's glow colour, so C3 reads green and BGW9 reads blue, as they do.

**The shading is a small metal model,** not a PBR pipeline: two directional
lights, an environment approximated from the reflected vector (bright sky over
dark floor — that gradient sliding across a flank is the whole read of polished
steel), a Fresnel term, a circumferential brush streak for brushed and blasted
finishes, and a separate glass path for the crystal that is nearly invisible
face-on and bright at glancing angles, the way an AR-coated sapphire behaves.

One detail that is not geometry at all: the seconds hand ticks six times a
second, because the NH35 runs at 21,600 A/h and a smooth sweep would be the
wrong watch.

---

## 4. The AliExpress index

AliExpress is the primary hardware source for this domain, so the catalogue
carries a **pre-indexed** sourcing table: for every case and every part, the
search phrases that actually return it, the brands that make it, the price band
to expect, and the pitfalls worth knowing before ordering.

**It is a search index, not a scrape, and that is deliberate.** AliExpress
answers server-side fetches with a 503, so a scrape would be unreliable; a cache
of listing IDs would be stale within weeks as sellers rotate stock; and — the
part that decides it — fetching on a visitor's behalf would put their build in
front of a third party. The index resolves entirely locally:
`aliSearchUrl(query)` builds the `/w/wholesale-<slug>.html` form as a **string**,
and nothing in this feature ever calls it. `src/watch.test.js` pins that by
replacing `globalThis.fetch` with a throwing stub and asserting it is never
reached. Consequences: the links keep working when a listing disappears, the
page needs no network beyond its own assets, and the whole thing sits inside the
privacy posture (invariant 4) without needing an exception.

The twenty case families indexed, grouped by fitment platform:

- **SKX007 / SRPD platform** (28.5 mm dial, 31.5 mm crystal, 38 / 31.8 mm
  insert, separate chapter ring) — the platform most of the market is built on,
  and the reason so many "conversion" cases are SKX cases wearing a different
  shell: SKX007, SKX007 without crown guards, SKX007 with the crown at 3,
  Sub-style, slim Sub, Turtle conversion, Captain Willard 6105, Samurai, Tuna,
  Marinemaster 300, Planet Ocean style, Explorer style, field 38.
- **SKX013 (mini)** — SKX013, mini Turtle conversion.
- **SRP Turtle** — the native SRP777 dimensions, with its own crystal and insert
  family that do **not** interchange with SKX parts.
- **Case-specific** — 62MAS, Sumo, Alpinist, Monster: cases that take their own
  ring parts, sold with the case. The compatibility engine treats a mismatch
  here as a sourcing **note**, not an error, because it is a fact about where to
  buy the part rather than a reason to block the build.

The brand table (`ALI_BRANDS`) ranks the makers a case names — San Martin
(premium finishing), Heimdallr / Proxima / Thorn / Tandorio / Steeldive /
Baltany / Merkur (mid), Sharkey / Miuksi / Corgeut / Bliger / Addiesdive
(budget, wide range, batch-to-batch variance) — and every brand a case names must
exist in it, which is a test.

---

## 5. The compatibility engine

`checkBuild` returns issues at three levels and **never blocks the render**: an
impossible build still draws, with the problems listed beside it. That is the
honest posture for a tool whose point is showing you what a combination looks
like.

- **error** — it cannot be assembled as specified. A dated movement under a
  no-date dial (the single most common mod-build mistake, in both directions);
  an NH36 without a day window, or a day window without an NH36; an NH34 with
  only three hands; a ring part built for another shared platform.
- **warning** — it assembles but something is off. A GMT movement with no
  24-hour scale anywhere; an insert chosen for a case with no rotating bezel; a
  minute hand that overhangs or falls short of the track; a crystal and case back
  that overrun the case's height budget.
- **note** — a sourcing fact. A case-specific platform needing its ring parts
  bought with the case; lumed hands over a dial with no lume.

Every issue is bilingual, names the slot it belongs to, and is tested for both —
including a check that the English and Swedish strings actually differ, which is
how a half-translated entry gets caught.

---

## 6. Endpoint

`GET /api/watch/catalog` — public, cacheable for an hour, committed data only.

| Call | Answers |
|---|---|
| *(no params)* | the case index, every parts family, the platforms, the brand table, the sources |
| `?case=<id>` | one case family, expanded, with its platform |
| `?slot=<key>` | one parts family |
| `?build=<code>` | a permalink code resolved into its spec sheet, fit check and sourcing rows — the whole page's answer, without the page |

It exists for the **non-browser** caller: an agent, an MCP client or a shell in
the sandbox can ask what a case measures and what to search for without running
WebGL. Unknown ids answer 404 with the valid set, because a caller that guessed
wrong should be told what exists.

---

## 6a. Reachable from the chat (feedback #49)

The builder shipped, and the same day a demo session typed **"Seiko watch
demo"** into the chat. It got a full research pass over the open web that
found four irrelevant sources and concluded there was *"no usable information
about Seiko watch demos"* — while the tool that answers the question exactly
sat one route away. The note that came with the report generalised it: *"all
individual capabilities should be callable like this, show me x demo for
instance."*

So the builder has an entry in the capability-demo registry
(`public/js/demo-core.js`, façade `src/demos.js`) as a `page` surface. When
the deterministic EN+SV gate fires, both tiers' chats mount a card into
`/watch/` above the reply, and `src/pipeline.js` re-runs the same gate to set
the answer prompts' `demoSurface` — so the model opens by naming the tool and
pointing at the link instead of researching the web for a capability this site
ships.

A card, not an embed: `/watch/` is a WebGL builder with its own catalogue,
permalink codec and sourcing table. Inlining it would put a second copy of the
page inside a chat turn; the card says the capability exists and takes the
reader one tap into it. (The `/space/` scenes DO embed — they are a canvas and
a caption — which is why the registry distinguishes the two kinds.)

The subject patterns are deliberately asymmetric. `watch` is a common English
verb, so the bare noun never fires on its own — it needs a build/mod word or a
show verb beside it ("watch out for rate limits" must stay a research
question). The movement families (`nh35`/`nh36`/`nh38`), `watch builder` and
`klockbyggare` are unmistakable and fire alone. `demo-core.test.js` pins both
directions.

---

## 7. Testing

`public/js/watch-core.test.js` (70 checks) and `src/watch.test.js` (11) run in
`npm test`. They cover catalogue integrity (unique ids, resolvable references,
EN+SV everywhere, plausible millimetres, crystal smaller than case and larger
than dial), the permalink codec's fail-soft decode, every compatibility rule,
the spec-sheet maths, the sourcing index's URL shapes, and the geometry: well-
formed meshes with unit normals and in-range 16-bit indices for every case ×
every strap, the smooth/crease distinction, and a regression guard on the strap
arc — a sign error in its transform once sent one arm sweeping up through the
case.

What is **not** tested here is how any of it looks. That is verified in a
browser, which is where this project's rendering bugs have always come from
(the **live-verify** skill).

## 8. Known limits

- The movement is never modelled. A display case back shows a tinted disc, not a
  rotor — the geometry budget is better spent on the parts a modder chooses.
- Crown guards are carried as a catalogue flag and drawn into the case
  silhouette, not as separate machined lobes.
- Dial finishes are painted approximations. A real sunburst changes with the
  angle of the light in a way a static texture cannot reproduce.
- Prices are bands from listing surveys, not live. They will drift; the page
  says so.
- WebGL is required for the 3D view. Without it the page still renders the spec
  sheet, the fit check and the sourcing links, and says why the canvas is gone.
