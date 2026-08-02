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
  and [Exquisite Timepieces](https://www.exquisitetimepieces.com/blog/all-about-the-seiko-willard/) (6105 Willard).

AliExpress's own `wiki-ssr` "reference articles" were dropped as a source on
2026-07-30. They are machine-generated and carry outright false claims — the
NH36 one calls the calibre a Seagull running at 28,800 vph, and it is a Seiko
Instruments movement running at 21,600. The one crystal claim that rested on
that page (Hardlex hardness) now cites
[namokiMODS' crystal comparison](https://www.namokimods.com/blogs/where-to-buy/mineral-hardlex-sapphire-what-crystal-to-choose)
and is stated as a ranking rather than a number, because Seiko publishes no
hardness figure for Hardlex.

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

### 3.1 The case back, and what an exhibition one shows

A **solid** back is a puck that plugs the bore. A **display (exhibition)** back
is a ring with a sapphire in the middle of it, and the interior it opens onto is
its own mesh — `movement` (the mainplate and the spacer ring), `movementBridges`
(barrel bridge, train bridge, balance cock, balance wheel, screws), `rotor` and
`movementJewels`. The renderer draws the window with the crystal, blended and
without a depth write; everything else is opaque.

Three things about this are worth keeping in mind before changing it:

* **The interior is built either way.** Behind a solid back nobody sees it, and
  it is what closes the case — the ray test over every case still has to pass
  with the window cut.
* **The mainplate is deliberately darker than the bridges.** The bridges stand
  0.3 mm proud of a disc, this renderer has no shadows, and at that scale shape
  alone is a suggestion. Contrast comes from the material table, not the mesh.
* **The lighting rig dips under the horizon with the camera.** It follows the
  camera's yaw but used to keep every light above the horizon whatever the
  pitch, which left the whole underside of the watch lit by the hemisphere's
  ground term alone. Below the horizon the key is also deliberately shallower
  than its mirror image, because a key straight down the camera's axis lights
  no side walls and a movement comes out as a flat grey disc. Above the horizon
  nothing changed — `dip` is exactly 1 there.
* **The floor lift is 0.06, and it used to be 0.45.** That is the same dip's
  other half — how far the floor is raised toward the sky as the camera drops —
  and at 0.45 it was blowing the whole movement out. It took the dark studio's
  floor from 0.055 to 0.297, the floor-bounce term multiplied it again, and
  every conductor on the underside landed on the tonemap's shoulder, where the
  material table's 0.52-against-0.66 reflectance flattened to 0.813 against
  0.913. Measured over the window: **mean 0.846, sd 0.062** — a movement
  rendered as a blank white disc, which is what feedback #59 was looking at
  when it said the reflections were odd.

  The diagnosis is worth repeating because the obvious suspects were all
  innocent. Serving patched shaders through Playwright's `page.route` (no repo
  edit) and masking to the window: killing the analytic lights moved the mean
  by 0.005, because on a CONDUCTOR the rig contributes almost nothing and
  `studio()` contributes everything; halving exposure moved the mean and left
  the spread alone. Only the floor lift moved sd. Dielectrics — the cushion the
  lift was added for — are lit by the rig and barely notice the ground;
  conductors are the opposite, which is why one number could be right for the
  cushion and ruinous for the calibre. After: **mean 0.635, sd 0.171**, and the
  contrast went back where the bullet above says it belongs, into the material
  table (mainplate `reflect` 0.24 / `env` 0.30, bridges 0.72 / 0.85 — `env` is
  this renderer's only occlusion term, since it has neither shadows nor AO).

  Two things measured as worthless and recorded so nobody re-argues them:
  anisotropy and heavier grain on the bridges. They are flat surfaces, so the
  reflected ray does not move across them.

An **engraving** is not a shape. It is a decal — `casebackArt`, a disc lying on
the back face with the same radial UVs a dial uses, carrying a relief map and
almost no albedo, because an engraved back is dimensionally identical to a plain
one. It exists only when something is actually engraved, and never on a display
back. The painter mirrors and half-turns its canvas: a downward-facing annulus
emits the upward disc UVs seen from the other side, so text painted without that
flip comes out back to front.

The **cushion and the strap can be put down** (`setWrist`, `setStrap`). Both sit
directly behind the case back — a bracelet's fold-over clasp closes at 6
o'clock, which is across the middle of it — so the "case back" view drops both,
the way you would take the watch off to look at it.

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
about Seiko watch demos"* — while the tool that answers exactly that question
sat one route away. The report did not stop at the one case: *"all individual
capabilities should be callable like this, show me x demo for instance."*

So the builder has an entry in the capability-demo registry
(`public/js/demo-core.js`, façade `src/demos.js`). When the deterministic EN+SV
gate fires, both tiers' chats mount it above the reply, and `src/pipeline.js`
re-runs the same gate so the answer knows it is there — instead of researching
the web for a capability this site ships.

The first version mounted a **card** linking into `/watch/`, on the reasoning
that a WebGL builder with its own catalogue, permalink codec and sourcing table
is a page rather than a canvas. §6b is what happened to that reasoning.

The subject patterns are deliberately asymmetric. `watch` is a common English
verb, so the bare noun never fires on its own — it needs a build/mod word or a
show verb beside it ("watch out for rate limits" must stay a research
question). The movement families (`nh35`/`nh36`/`nh38`), `watch builder` and
`klockbyggare` are unmistakable and fire alone. `demo-core.test.js` pins both
directions.

---

## 6b. Driven BY the chat (feedback #52)

The card was the wrong shape, and the next day's report said why in one
sentence:

> *"i want the watch builder to be inline so I get the watch animation here and
> suggestions on what one can change through text commands. Make it an mcp
> server with a bunch of tools and every new reply contains a new watch
> animation with text on what changed"*

Every clause of that is a different objection to a link. A link is somewhere
else; it cannot be *driven by* the conversation that produced it, and a
conversation cannot report what changed in a page it does not own. So the
builder moved into the turn.

### The thread

A watch **thread** is derived, never stored — `watchThread(userTexts)` in
`public/js/watch-chat-core.js` walks the user side of a conversation and returns
the build as it stands at the turn being answered. It

- **opens** on a demo ask (§6a's gate, unchanged, so "Seiko watch demo" and
  "visa mig klockbyggaren" open it exactly as they used to open the card),
- **carries forward** while each following message is watch talk, applying its
  commands to the build the previous turn ended on,
- **closes** on a message that is neither, and stays closed until another
  explicit ask.

Closing matters as much as opening. A conversation that asks for a watch and
then asks about something else must not get a watch bolted onto the second
answer, and "watch talk" is deliberately narrow: a slot word, a part name, a
view command, or a reset. Every one of the three is a unit test.

Being derived is what makes a reload honest. There is no embeds-registry entry
and no stored build; the same messages replay to the same watch, which is also
why the reroll ("surprise me", "slumpa") is a seeded xorshift rather than
`Math.random()` — a reader reopening the conversation has to see the watch the
answer describes. The reroll also **repairs** itself: a rolled build that the
compatibility engine rejects is scanned slot by slot for an option that strictly
reduces the error count, so a demo never opens on a watch that cannot be
assembled. Random retries did not converge — a GMT movement needs the one
four-hand set, which a coin flip finds about never.

### The commands

`parseWatchCommand(text, build)` is a scored alias index over the catalogue, no
model in it. Two tiers of term:

- **strong** — unique enough across the whole catalogue to set its slot with no
  slot word anywhere: "pepsi", "jubilee", "snowflake", "62MAS", "mini turtle".
- **weak** — real names that are ambiguous alone, above all the colours, since
  "black" is a dial, an insert *and* a finish. These count only within 30
  characters of one of their slot's words.

Ties break on the longest match, which is what makes "mini turtle" beat
"turtle" and "sunburst blue" beat "blue" without an ordering rule to maintain.
Weak terms are additionally scored by **proximity**, because in *"blue dial and
green bezel"* both colours sit inside the dial's window and only the distance
says which one the dial was meant to be.

Two traps this cost real time on, both worth knowing before extending the table:

- **The Swedish `\b`.** `/\bblå\b/` never fires — `å` is not an ASCII word
  character, so there is no boundary after it (invariant 6; the
  **palaeogenomics** skill is the standing reference). The pattern that works is
  a `(?![a-zà-ÿ])` lookahead.
- **Swedish compounds.** A slot word cannot be seen inside one: `/\bglas\b/`
  does not match "safirglas", so the compound forms are listed explicitly.

An intra-word hyphen is load-bearing too. Flattening it in "Unsigned,
screw-down" made that part's own name stop matching the command that names it,
and the shorter "signed" then matched *inside* "unsigned" and fitted the
opposite crown.

The suggested next commands are generated the same way round, which is the
property that makes them trustworthy: `commandFor` renders one uniform shape —
`change the <slot> to <part>` / `byt <slot> till <part>` — and a unit test
round-trips **every option in the catalogue, in both languages**, through the
parser. The uniform phrasing is deliberate: it sidesteps the article and
definite-form grammar that per-slot wording needs in two languages, and it puts
the slot word next to the value where the proximity rule wants it. Suggestions
are also checked against the compatibility engine first, so the tool never
talks a reader into a build it will then complain about, and they rotate with
the turn number so consecutive replies do not offer the same three things.

### What the turn shows, and what the model is told

`public/js/watch-embed.js` mounts `mountWatch`'s stage without the page's
panel: the render, the what-changed line over it, the spec line, the fit
warnings, the suggestion chips and a link into the full builder at this build's
permalink. The chips send the command they show when a tier has lent the embed
its composer (`setDemoCommandSender`, one call per tier at boot); unset, they
are read-only hints, which still answers the ask. Where WebGL is unavailable the
mount returns null and the caller falls through to §6a's card — the honest
degrade, since the builder does still exist.

Two costs the inline version has that the card did not, and their answers: each
embed is a WebGL context with its own animation loop, so an
`IntersectionObserver` drives the renderer's `setRunning` and an off-screen
watch stops drawing; and the parts catalogue is the biggest pure-data module in
the client, so `demo-mount.js`'s `watchOpenedIn` pre-gate answers "could a
thread be open here" using `demo-core.js` alone — a conversation that never
mentions watches never fetches a byte of it.

The model gets `watchPromptBlock` as the answer prompts' `watchBuild` input: the
full build, its dimensions, what this message changed, and the fit verdict, with
instructions to open by saying what changed and close by offering further
commands. That is the *"text on what changed"* half of the request, and it is
generated from the same build the embed rendered — one core, so the answer
cannot describe a different watch than the one on screen.

### The tools, and why they are gone

The last clause of #52 — *"make it an mcp server with a bunch of tools"* — was
built: `src/watch-tools.js`, six tools on `POST /mcp` (`watch_catalog`,
`watch_case`, `watch_build`, `watch_command`, `watch_check`,
`watch_sourcing`) over the same two cores the inline builder runs on.

**They were removed on 2026-08-02 (owner directive): this feature needs no MCP
surface.** The module, its tests and its six entries in `src/mcp-config.js`'s
catalog are deleted.

The reasoning is worth keeping, because it is a general one. An MCP tool earns
its place when an agent without a browser needs the answer — which is why the
literature and SDK families are still there. The watch builder is a browser
surface and a chat surface: the people using it are looking at a rendered
watch, and the conversational half already answers in plain language through
`watchThread` and `parseWatchCommand`, with no protocol in the way. Six tools
were carrying a maintenance cost — schemas, an exposure switch each, a
catalog⇔tool-list mirror test — against a caller nobody could name.

Nothing about the builder's capability changed with them. `GET
/api/watch/catalog` (§6) still answers the non-browser caller: a shell in the
sandbox, a script, an agent that wants a case's real millimetres without
running WebGL. That endpoint was always the honest seam for that job.

---

## 6c. Building talk, not just demo talk (feedback #55 and #56)

The inline builder shipped, and the next session that wanted one did not get
it. The message was **"Build me a fancy seiko watch"**; the reply was a
research essay about the Prospex Marinemaster and the Presage Cocktail Time,
and the report that followed was one sentence long:

> *"I see no watch animation. Whenever there is talk about building, creating,
> designing watches I want the default to be to create a watch in every
> response and take user input for the next animation in the next response in
> the convo."*

### Why nothing mounted

Two independent misses, both in `public/js/demo-core.js`, and both the same
mistake — a hand-written combination that missed the combinations people type.

1. The unmistakable phrase was `/\bbuild (a|your|my|the) (own )?watch\b/`: a
   determiner **immediately** after the verb. "Build **me** a **fancy** seiko
   watch" has an indirect object and an adjective in that gap, so it fell out.
2. The subject-plus-verb path had no verb to offer either. `SHOW_VERBS.en`
   carried `/\bbuilder?\b/`, which matches "builder" and never "build" — the
   `?` binds the `r`, not the `er`. Nothing in the message was a show verb.

So the gate returned null, no builder mounted, no `watchBuild` block reached
the answer prompt, and the pipeline researched the open web for the capability
it was sitting on. That is feedback #49's failure again, one layer in.

### The second verb family

A surface now has a `subject` (the noun), an `always` (phrases that need no
verb), a `deny` (collocations that borrow a subject word for something else),
and an **`action`** — its own MAKE verbs, which qualify a subject exactly as a
SHOW verb does. Build, design, create, make, mod, customise, configure,
assemble, draw; bygga, designa, skapa, göra, modda, anpassa, montera, rita,
skräddarsy. `action` is per-entry rather than global because "build" is
meaningless for a `/space/` scene: you look at the Moon, you do not assemble
one.

The patterns are **composed** from a verb list times an object list, which is
the direct answer to how the old one broke. The object half is required — it is
what keeps the nominal "the design of the Seiko 5" from reading as an
imperative — and each surface's own nouns are listed straight after the verb
too, because Swedish suffixes the article onto the noun and "designa urtavlan"
has no determiner to find.

`deny` is new with this pass and exists for one shape: "build a watch list of
stocks" satisfies the subject and the verb, and "watch list" is the only thing
in it about a watch. A denied phrase vetoes the entry in either language.

### The thread survives a clarifying answer

The logged session ran: the ask, then the assistant asking whether "fancy"
meant features or looks, then the user answering **"Features"**. That one-word
answer is the turn the report was written about, and `isWatchTalk("features")`
is false — so even with the gate fixed, the thread would have closed on it.

The close rule is not loosened, because it earns its keep: an unrelated
question must never be answered with a watch bolted onto it. Instead a bare
**continuation fragment** buys the thread exactly one turn of grace, and a
second non-watch turn closes it as before. A fragment is deterministic and
deliberately narrow, the same shape as `isBareShowAsk`: short, no question
mark, no interrogative or imperative opener in either language, and not an ask
for some other surface. Real watch talk hands the grace back, so a long build
session never runs out of it.

### The app door

The last line of feedback #56 argued the opposite way: *"building through the
chatbot interface is unavoidably clunky and the wrong approach — send user to
the app immediately."* The owner kept both, so the inline card now **leads**
with the link instead of trailing it. `builderLink(build)` renders
`/watch/#<permalink>` — the same hash `/watch/` writes into its own address bar
— so the app opens on the exact watch the conversation reached and nothing is
retyped. The no-WebGL degrade carries it too, and `watchPromptBlock` tells the
answer the door is there so it can point at it once without claiming the user
has to leave.

---

## 6d. The third round (feedback #59)

The same reporter came back a third time, and the report is the most useful
this feature has had. It is worth reading as four different KINDS of finding,
because they needed four different kinds of answer.

### Findable, not merely present

Five of the things asked for had already shipped:

> *"Dial selection is whack, please add separate selections for the different
> aspects of a dial such as color, style (sunburst excetera), indices (sub
> style for example) and other important things. Same goes with hands. And
> strap, I need to be able to choose strap color."*

Dial colour, finish, construction, index style, calendar, lume, diameter, feet
and strap colour were all `AXIS_SLOTS`, all rendered, all reachable. **The
defect was that none of those words appeared anywhere on the page.** §6c's fine
tuning was filed under one heading at the FOOT of the picker, behind eight
disclosures labelled `Dial detail`, `Strap detail` and the like. Measured on a
390×844 phone — the reporter's own device class — the dial's colour control sat
roughly **3,200 px below the dial row it belongs to**, and a scan for the word
"colour" inside the Strap row returned nothing at all.

That trade recurs, so it is worth stating as a rule: **#56 asked for the picker
to open on the decisions a build is made of, and the collapse that answered it
is what buried the variables.** Both reports are right, and the resolution is
not to pick one.

- **A group is addressed to its part.** Each axis names the slot it modifies
  (`over`), so `slotForGroup` / `axisGroupsBySlot` render the dial's variables
  inside the dial's own row. A group whose slot cannot be worked out still
  draws, under the old heading — the catalogue can grow one this page has never
  heard of without it vanishing.
- **A shut fold says what is in it.** `axisSummary` produces *"8 more choices:
  Colour · Finish · Construction · Index style · Calendar · Lume · Diameter ·
  Feet"*, and `shortAxisName` takes the group's subject off the front in both
  languages, or eight axes read as the word "dial" eight times. A variable
  already moved shows its value there, so the fold never hides a decision.
- **One control opens all of them**, and one sentence under the PARTS heading
  names the things the report went looking for.

Nothing was added to the catalogue for this. The measure of the fix is that the
words a reader searches for are on the page with nothing opened.

### The hands really were missing

One clause of that sentence was not a discoverability problem. Counting the
axis table at the time: **dial 9, strap 10, hands 0.** Hands were whole named
sets, so Mercedes hands in gold or a red seconds hand were not expressible.

Five axes now sit over the slot — `handColor`, `handSecondColor` (both over one
`HAND_COLOURS` list, with a `roles` field so a seconds-only accent warns rather
than blocks when applied to the whole set), `handFinish`, `handLume` (a
`DIAL_LUME_OPTIONS` clone minus `full-lume`) and `handLength`. Length is
expressed as *which dial the set was cut for*, derived from `DIAL_DIAMETERS` so
no millimetre is invented, and it makes the minute-hand overhang warning
reachable for the first time. Shape is deliberately not an axis.

Four things only rendering found, all now written into the code: a metal has no
diffuse term and the hands share one material, so a red seconds hand rendered
**white** until a two-colour set was drawn as lacquer; the same bug hid the GMT
accent; plating is not its own material, so a `gold` spec came out paler than
the tint over `hands-polished`; and it is the constant lume term, not the
material, that washes a tint out — colours separate cleanly only with lume off.

### A case is sold as a set

> *"Bezel insert, crystal, caseback and crown are practically never bought
> separately from the case. … Chapter rings are usually not bought separately
> and are integrated with the case."*

True about the market, and it landed in two stages.

First the model, and the shape of it matters: **bundling is a fact about the
SLOT, not about the SKU.** Which slots a case set fills is knowable and is now
derived for every case — crystal, case back and crown always, the insert where
there is a rotating bezel, the chapter ring always (loose in the box on the
shared platforms, machined into the case on a case-specific family, which is
the report's second sentence taken literally). Which PART is in a slot is
knowable for the crown only, because every case entry records whether the crown
it ships with is signed. Everything else stays `null`. The catalogue's own
SKX007 entry explains why: *"cheap listings ship a mineral crystal and a hollow
bezel; 'sapphire' in the title is not always sapphire in the box."* A $25
Sharkey set and a $120 San Martin set both include a crystal and they are not
the same crystal, so naming one would be a fabricated price claim wearing a
default's clothes. Where the set's own part is unrecorded the band carries
**both ends** (`0 … high`) rather than picking one.

Then the presentation, because the data knowing better is invisible.
`sourcingView` / `orderSummary` turn the table into a numbered list of parcels
— *"This build is 4 separate orders: the case set, which brings 5 more parts
with it, plus dial, hands and strap"* — with the bundled slots indented under
the case row and priced as the bundle, not the part. A `[0, high]` band renders
as "≈ USD 0–45 (if you swap it)".

**"Keep what the case comes with"** (`KEEP_ID = "stock"`) is the choice that
makes the distinction expressible, and keeping it apart from "not fitted" is
the whole safety property: `resolveBuild` reports it as `kept`, never
`omitted`, so an SKX007 with `chapterRing: none` still warns that the dial
floats and an SKX013 with `chapterRing: none` is still a hard error, while
`stock` raises neither — a kept ring is a fitted ring.

Finally the collapse itself (owner directive, 2026-08-02), which is the strong
version of the report and was argued against before it was approved: the five
slots carry `fromCase: true` and are **out of the primary picker**.
`caseBuild(caseId)` is the single definition of what a case gives,
`normalizeBuild` fills the five from it, and `kitOverrides` reports the
difference. One disclosure under the case row — *"Swap a part the case came
with"*, shut by default — holds them, and its shut summary names every swapped
part and carries a ⚠ if the fit check has something to say about one of them,
because a fold that can hide a decision is worse than no fold. **11 primary
rows became 6; the phone picker went from 2,663 px to 1,503 px; the default
permalink from 174 characters to 74.**

Two things the collapse cost, and what was done about them. A bug fell out
of it that had been there all along: the chat's what-changed list read both
ends through `part()`, a deliberate miss for `"stock"`, so a command like
"pepsi bezel" reported *no change at all*. And the default build lost its
bezel markings — the insert stand-in is deliberately unmarked so the catalogue
never claims which insert is in the box, which is right about the SKU and
wrong about the picture, since the default is an SKX diver. A case sold with a
120-click dive bezel ships a DIVE insert, scale and lume pip included; that is
a derivation from `cs.bezel`, the same reasoning `stockPartFor` uses to name
the crown, and it still names no part.

### The reflections, and what was actually wrong

> *"Reflections still look odd, possibly because of the all black background.
> Add another background that's toggle able to test out this theory."*

The instrument was built — `SCENES` and `sceneFor` in `watch-materials.js`,
`setScene` on the stage, with the clear colour, `uSky`, `uGround` and the
bounce all coming from one scene record so a scene's background and its
reflections can never disagree again. Then the theory was tested rather than
assumed, and the answer is **right about the symptom, wrong about the cause.**

Masked to the subject, dark and grey measure the same watch to three decimals
(polished mean 0.486 vs 0.487, sd 0.212 both). No watch pixel changes, so the
metal cannot have improved. What a lighter background fixes is the READ: the
case sits in a room, and **15.6% of a PVD build sits below 0.15 luminance** and
simply disappears against black. That is why `studio-grey` is now the default
(owner-approved), with `studio-dark` still selectable and value-for-value.

The odd reflections had a different cause entirely, and it is the floor-lift
blowout in §3.1 — a shading defect no background could fix.

### The strap, the cushion, and one number doing two jobs

> *"strap/bracelet sits weirdly with a bend near the lugs which has no reason
> to be there."*

There was a real modelling error behind that. `STRAP_EXIT.degrees` =
`arccos(R/(R+d))` answers *at what angle around the wrist the strap first
touches it*, and `strapPath` computed it honestly per case. `STRAP_DRAPE.drop`
was the same figure a second time, used as *the angle below horizontal at which
the band leaves the lug*. A spring bar sits half a lug-to-lug **out** from the
centreline, not above it, so the taut span really runs at 67–76°. Leaving at
30° and arriving at 76° made the lead-in absorb about 45° over a 25 mm chord:
measured **6.4°/mm four millimetres from the lug tip**, then an over-plunge and
a swing back — two inflections before the wrap. The exit is now derived and the
lead-in is the straight taut span: **0.00°/mm until first contact**, then the
wrap's constant 1.97°/mm.

A softer exit was tried and rejected with a reason, recorded in `STRAP_EXIT`'s
note so it is not rediscovered: both lines start at the spring bar, so any
curve leaving flatter must bend back to the same tangent point and brings the
artifact back. Two drifted seams were fixed with it — `lugAnchor` used
`thick × 0.3` where `buildMeshes` drills at `thick × 0.245`, and
`STRAP_DRAPE.wristR` carried an independent 30 mm for the object
`WRIST_HOLDER` measures at 27 mm.

The cushion is now `dia + 2×4 mm` instead of a 93 mm forearm, and it deforms:
the crown stands 1.5 mm above the case-back plane, and the leather inside the
case's own bottom-rim footprint is pushed down onto it — a 33 mm flat with a
ridge of displaced leather around it. Because the footprint is the case's rim,
a cushion case leaves a cushion-shaped print. The buckle is one swept frame of
round stock with radiused corners, a hinge pin and a tapered prong, replacing
five axis-aligned boxes; butterfly clasps are offered on bracelets; and there
are six distinct clasp geometries where every bracelet used to draw the same
two plates.

### The cases

Three new families, all from real NHxx-fitment listings with their own
`SOURCES` rows and their disagreements carried in notes: `royal-oak` (37/48/9.95
mm octagon, integrated bracelet), `prx` (36/42/11 mm barrel, integrated
bracelet with a published 24→18 mm taper) and `explorer-2` (36/43/11.6 mm tool
case, fixed 24-hour bezel, and the one new case whose crystal diameter a vendor
actually publishes at 29.5 mm). `sub` and `sub-slim` were given their own
slab-and-chamfer archetype — they had been sharing the SKX's flank, which is a
large part of why they did not resemble anything — and the Alpinist was
re-sourced from namokiMODS' NMK951 rather than the Seiko original.

An **integrated bracelet** is a case flag plus its own geometry
(`integratedBraceletOf` / `integratedPlan` / `integratedBraceletAssembly`),
returning `strapAssembly`'s exact shape so the seam is three lines. It is also
why `strap` is a kit slot: on these cases the bracelet is bought with the case.
It is deliberately NOT in `KEEPABLE_SLOTS`, though — a machined-in bracelet is
not a keep-or-buy decision, it is what the case IS, and offering the choice
would imply a swap that cannot happen.

---

## 7. Testing

`public/js/watch-core.test.js`, `src/watch.test.js`,
`public/js/watch-chat-core.test.js` (the conversational core — thread
open/carry/close, EN+SV command parity, the whole-catalogue command round trip,
reroll determinism and repair, the suggestions' validity) and, since feedback
#59, one file per slice of that report — `watch-cases.test.js`,
`watch-strap.test.js`, `watch-hands.test.js`, `watch-kits.test.js`,
`watch-sourcing.test.js`, `watch-collapse.test.js`, `watch-scene.test.js` and
`watch-shading.test.js` — all run in `npm test`.

That one-file-per-slice split is not tidiness. #59 was worked by parallel
agents on disjoint territory, and a shared test file is the one thing that
makes disjoint territory collide; separate files merged without a single
conflict. The catalogue-wide integrity checks stay in `watch-core.test.js`.

Together they cover catalogue integrity (unique ids, resolvable references,
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

### Rendering it in a container

Four traps cost real time during #59 and are worth knowing before writing
another verification script:

- **`npx wrangler dev` does not run here** — it wants a Docker socket for the
  container binding and dies without one. `/watch/` is static assets, so
  `cd public && python3 -m http.server <port>` serves the same module graph.
- **Pick a PRIVATE port and assert on served content.** Two separate sessions
  lost work to this: a sibling's server was already holding the agreed port, so
  the "verification" rendered somebody else's working tree and looked fine. If a
  render disagrees with what the source says, check what the port is actually
  serving before believing either.
- **`page.screenshot()` never returns** on this canvas under SwiftShader. Read
  the pixels out with `canvas.toDataURL()` instead.
- **A hash-only `page.goto('#…')` is not a reload.** Navigate to `about:blank`
  first, or the build you think you loaded is the previous one. For the same
  reason `localStorage.setItem` after the first `goto` is a no-op — use
  `addInitScript`.

And one habit rather than a trap: **measure, don't squint.** The blown-out
movement in §3.1 was found by masking to the subject and computing mean and sd
of luminance, and the fix was chosen because sd tripled. The eye agreed
afterwards, but it could not have told 0.062 from 0.171 across two screenshots.

## 8. Known limits

- The movement is a silhouette, not a replica (§3.1). Mainplate, three bridges,
  balance, rotor, screws and four jewels are enough to read as a calibre through
  an exhibition back; nobody publishes bridge outlines for these movements, so
  drawing down to the click spring would be dressing a guess up as a drawing.
- **The three bridges do not separate from each other.** Barrel bridge, train
  bridge and balance cock are one mesh under one material key, so the material
  table cannot give them different tones the way it separates them from the
  mainplate. Fixing it means splitting the mesh, not retuning the shading.
- **`studio-light` still washes the movement out** (sd 0.110 against 0.171 in
  the default scene). That is structural to its 0.22 floor, and fixing it is a
  retune of the scene rather than of the calibre.
- Which insert, crystal, chapter ring or case back a case set actually ships is
  not knowable from the sources, so a kept part stands in unmarked rather than
  naming a SKU (§6d). The one exception is the crown, derived from the case's
  own `signed` flag, and the one concession to the picture is that a case with
  a rotating dive bezel gets a dive insert's scale and pip.
- The Explorer II's bezel carries no 24-hour numerals and the Royal Oak no
  bezel screws: the insert painter only runs for a `dive120` bezel. The
  Alpinist's second crown at 4 o'clock is recorded as `crown2: { rendered:
  false }` rather than faked.
- Crown guards are carried as a catalogue flag and drawn into the case
  silhouette, not as separate machined lobes.
- Dial finishes are painted approximations. A real sunburst changes with the
  angle of the light in a way a static texture cannot reproduce.
- Prices are bands from listing surveys, not live. They will drift; the page
  says so.
- WebGL is required for the 3D view. Without it the page still renders the spec
  sheet, the fit check and the sourcing links, and says why the canvas is gone;
  in a chat turn the inline builder degrades to the link card (§6b).
- The command parser knows the catalogue's vocabulary, not the whole hobby. It
  covers every part's EN and SV name plus the trade names people actually type,
  and reports a command it did not recognise rather than guessing — but a phrasing
  nobody has typed yet will simply miss. The fix is a term in the alias table,
  not a model in the loop.
