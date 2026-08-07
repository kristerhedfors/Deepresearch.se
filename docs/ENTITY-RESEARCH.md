# Entity research

The method the pipeline injects when a request asks for an OSINT-class dossier:
settle **which** subject is being profiled before profiling it, and size the
report to the research time the user bought. Added 2026-08-07 for feedback #64.

Modules: `public/js/entity-research-core.js` (the bilingual gate and the block),
`src/entity-research.js` (the enrichment). No outbound request, no model call,
no stored data.

## 1. What it is, and what it is not

Two rules appended to the conversation before triage runs, so every later phase
sees them. The block names no subject and asserts no fact about anyone: it is a
regex pair and a small table of constants, 550 to 945 words depending on the
tier.

It is the sibling of person research (`docs/PERSON-RESEARCH.md`), not a
replacement. That module fires on a request about a named **individual** and
supplies the method and privacy guardrails such a request needs; this one fires
on the request **shape** and answers what to do when the name does not resolve
to one subject, and how large the finished report should be. Both may fire on
the same turn, and on an OSINT question about a founder they usually do.

Like its sibling it resolves nothing. Every other core enrichment turns
something the message names into data: a snapshot, a catalog, a corpus row. This
one appends procedure, because the gap feedback #64 exposed was not missing
data.

## 2. Why it exists

Live feedback #64. A user wrote *"Osint on revsec"* and got one competent report
covering four unrelated organisations that share the name: a consultancy
acquired by Accenture in 2020, two different AI-security products, and a South
African property manager. Nothing in the pipeline treats "the name resolves to
more than one subject" as a reason to stop and ask, so it became a section
heading instead, and a passage went on reconciling headcounts and founding dates
belonging to different companies.

The reporter's two complaints, verbatim:

> you must ask WHICH of the identified entities to produce an osint report for
> when there are more than one options available

> the osint reports produced for named entities should scale in comprehensiveness
> based on research depth setting where the largest one should resemble a TIBER
> threat intel report and if more shallow, a reduced scaled down version

Picking a candidate is the tempting shortcut and it fails twice: the pipeline
cannot know which RevSec was meant, and a profile fused from several subjects is
confidently wrong about every one of them. That is the **silent identity merge**
of `docs/PERSON-RESEARCH.md` §6 at organisation scale, and the conflicting
figures it produces read as a finding about one company when they are an
artefact of the merge.

## 3. Where it plugs in

An entry in the `src/enrichment.js` `CORE_ENRICHMENTS` registry, **last**, after
`person_research`, so on an OSINT question about a named individual the two
blocks read in that order: the person method and its guardrails first, then how
to resolve the subject and how big the answer should be. Each runner sees the
conversation as the previous one left it, and person research's block carries no
dossier phrase, so it cannot trigger this gate by itself.

`enabled: () => true`. There is no knob, no chat mode and no request field: the
intent gate inside the runner decides, and the runner is silent otherwise.
`runEnrichments` runs before triage (`src/pipeline.js`), so the planner, the
search waves and synthesis all see the block. The append goes through
`appendToLast` (`src/conversation.js`), which adds a new text part rather than
rewriting the message, so an attached screenshot survives.

A firing turn emits the SSE step `entity_research` ("Applying the
entity-research method…", then "Entity-research method applied") whose finished
details name the tier, `Report depth: full`. That is deliberate: half the
feedback is about the report coming out at the right size, and a size nobody can
see is a size nobody can tell went wrong. One Workers Logs line,
`entity_research.applied`, carries `{ tier, words }` and nothing else — not the
name, not the message, and no `chat_logs` meta field carries it today. The same
counters land in `state.entityResearch`.

## 4. The gate

`entityResearchIntent(text)` is a disjunction of two patterns, English and
Swedish, at equal breadth (invariant 6):

| family | English | Swedish |
|---|---|---|
| the word itself | osint (and the observed `osynt` slip), open-source intelligence, open sources **about** X | öppna källor **om** X, underrättelser, underrättelserapport |
| commercial and compliance | due diligence, KYC, background check, company/vendor/supplier check, vetting, dossier | bakgrundskoll, bakgrundskontroll, bakgrundsundersökning, personkontroll, företagskontroll |
| security framing | threat intel(ligence), CTI report, TIBER-EU, GTIR, CBEST, threat picture/assessment/analysis, intelligence report/profile/assessment | hotbild, hotanalys, hotbedömning, hotundersökning |
| footprint | attack surface, external footprint, digital footprint, adversary profile/assessment | angreppsyta, attackyta, digitalt fotavtryck, fotavtryck på internet |
| mapping | map (out) the company/organisation/firm/entity/vendor/group | kartläggning av företaget/organisationen/aktören |

**It stands alone.** Person research's gate is conjunctive (a research shape AND
a person referent), which is what lets its shape list be broad. This one cannot
be: `revsec` is a bare token with no role word, no company suffix and no
pronoun, so any referent test would veto exactly the request the rule exists
for. The phrase list does that work instead — each entry already means a
dossier, and nobody writes "due diligence" or "hotbild" about a topic they have
not named.

Two entries carry their own bound. `open sources` and `öppna källor` need a
connective (`about|on|regarding|for`, `om|på|kring|för`), because the bare noun
phrase is ordinary prose. `map out` needs an organisational object, spelled out:
"map out the market" is a research question, "map out the company Acme" is a
dossier.

Deliberately excluded:

- **"report on", "research", "look up", "what can you find"** — the ordinary
  research vocabulary of every other turn this pipeline serves. A gate standing
  alone cannot claim them.
- **`säkerhetsgranskning` / "security assessment"**, left out of **both** arms.
  In both languages those words usually mean a code or system review, which
  introspection's OWASP assessment default already serves. The pair is ambiguous
  on both sides, so invariant 6's equal breadth is satisfied by dropping it from
  both arms rather than adding an ambiguous English twin to match an ambiguous
  Swedish one.

Every pattern is built through `re()`, with lookaround boundaries and the `u`
flag. JavaScript defines `\b` over `[A-Za-z0-9_]`, so `/\bunderrättelse\b/` can
never match and the Swedish half of a gate dies while the English half keeps
working; the repo-wide guard is `src/swedish-boundary.test.js`. Accented
alternatives carry ASCII forms (`underrattelse`, `oppna kallor`, `kartlaggning
av foretaget`), because a phone keyboard without å/ä/ö is a common way this gate
is addressed.

## 5. Subject resolution

The first half of the block, identical at every tier:

1. **The name is a string, not a subject.** Before writing, read back over the
   numbered sources actually retrieved and count the distinct subjects carrying
   it: separate legal entities, a company and an unrelated product, a business
   and a person, one brand in different countries, an acquired firm and its
   acquirer's residual listing.
2. **One subject:** profile it, and say in one line what fixed the
   identification — the domain, the registration number, the location, the role.
3. **Two or more:** no merged report and no silent pick. Answer with a short
   disambiguation turn and nothing else: one line per candidate (what it is,
   where, one separating fact, the bracketed source number), then one closing
   question offering the candidates as numbered options, all of them, or one the
   answer did not list. Roughly 250 words, no partial profile stapled on.
4. **Unless the request already resolves it.** An anchor in the user's own
   message — a domain, a country, a sector, a role, "the one acquired by
   Accenture" — answers the question, so profile that subject without asking.
5. **Never ask twice.** If the previous assistant turn already asked, whatever
   the user said next is the answer; if it is still ambiguous, profile the
   best-supported candidate and say at the top which one was chosen and which
   were set aside.
6. **The collision is itself a finding**, even in a single-subject report: a
   reader searching that name later will land on the others too.

Rules 4 and 5 are the brakes, and they are why this fix does not become the next
complaint. Over-clarifying is this project's most reported failure mode:
feedback #47 was three clarifying turns in a row with web search explicitly on
and not one query run, feedback #58 a clarifying question asked over an
already-playing demo. The ask is also post-search and evidence-bound — only
after the searches have run, only when the sources themselves show two or more
subjects, and showing the candidates with citations. One candidate is never a
question.

## 6. Report depth

The second half, keyed on `state.plan.reportTier`, which `src/budget.js`
`reportTierFor(budgetS)` derives from the research-time slider:

| research time | tier | what the block asks for |
|---|---|---|
| < 60 s | `brief` | Two or three sentences on what the subject is, who runs it and where; a handful of cited key facts; the single most significant gap. No headings, no tables, no scenario work. |
| 60–179 s | `standard` | A focused profile: bold conclusion, then identity and legal form, what it does, ownership and leadership, footprint, and what could not be established. Threat framing is one closing paragraph. |
| 180–419 s | `extended` | A structured intelligence profile under eight headings, from summary and subject identification through people, technology and third parties to assessment, gaps and limitations. Tables where figures are compared, conflicts reconciled explicitly. |
| ≥ 420 s | `full` | The TIBER-shaped targeted threat intelligence report of §7. |

The same slider drives `REPORT_TIER_STRUCTURE` in `src/prompts.js` and the
per-tier token caps in `budget.js` (`synthMaxTokens` 4096 / 4096 / 6144 / 8192),
so a dossier and an ordinary answer scale off one control rather than two.

These are one report at four sizes, not four documents. Every tier answers what
the subject is, what it does and what is publicly exposed; `full` adds the
apparatus and `brief` reduces to the paragraph a reader can act on. Each entry
is a scaffold rather than a form: `extended` and `full` both say to drop a
section the sources cannot support, because an empty "Third parties" heading
claims a search that found nothing was a search that was never run.

The blocks run 550 / 555 / 666 / 945 words against a test floor of 300 and a
ceiling of 1000, and at `full` the block rides alongside person research's ~875
words. An unknown or absent tier falls back to `standard`.

One seam to know about: enrichments run before triage, and triage's complexity
clamp (`applyComplexityToPlan`) drops `extended`/`full` to `standard` for a
question it calls simple. The block was written at the slider's tier by then, so
a dossier request classified simple at a long budget carries a deeper scaffold
than synthesis's own tier guidance. If that combination turns out to be common,
the fix is to read the tier after triage rather than duplicate the clamp here.

## 7. The TIBER-EU tier

**What is real.** The ECB's
[TIBER-EU Targeted Threat Intelligence Report Guidance](https://www.ecb.europa.eu/pub/pdf/annex/ecb.tiber_targeted_threat_intelligence_report_guidance_2025.en.pdf)
(January 2025) prescribes required **content**, not headings: §4 says the report
"may be drafted in any preferred format, provided that all required information
is included", and no ECB document publishes a section template. Chapter 2's
required content is the scope of the intelligence research; an assessment of
what actionable intelligence can be found about the entity; a threat landscape
analysis; threat profiles of the actors; at least three end-to-end threat
scenarios covering availability, integrity and confidentiality; and optionally a
"scenario X". MITRE ATT&CK is named outright by the 2025 edition as the model
for TTPs, the 2020 edition's "highly recommended" hedge having been dropped. The
Generic Threat Landscape is national or sectoral and optional; the targeted
report is the entity-specific one, and the mandatory one.

**What is example.** Since the ECB prescribes no template, four of the headings
are lifted from
[TIBER-NO's published guidance](https://www.norges-bank.no/contentassets/67dfddb1ef9b4f8ea6e64bb3ed005471/tiber-no-targeted-threat-intelligence-report-guidance-v0.2.pdf)
(Norges Bank), which labels its own structure an example precisely because the
ECB supplies none: **executive summary**, **business overview from an
intelligence perspective**, **threat actors** (TIBER-NO splits this into actor
assessment and actor profiling) and **threat scenarios**. Our **digital
presence** heading covers what TIBER-NO calls intelligence on the entity's
digital presence, organised as people, processes and technology because the ECB
guidance organises the attack surface that way.

The other three headings are ours, carrying ECB content items TIBER-NO gives no
heading of its own. **Scope of the research** is Chapter 2's first required
item, and it leads for a reason unrelated to TIBER: it is what lets a reader
tell an absence from an omission, the same discipline the search ledger enforces
on ordinary answers (`docs/ARCHITECTURE.md` §4.3e). **Assessment and
confidence** and **gaps and limitations** close the report, with likelihood and
analytic confidence required to be stated separately.

Threat actors are ranked and each one evidenced, with the exclusions explained.
Scenarios run end to end, with ATT&CK tactics and techniques by identifier in an
actor / objective / tactic / technique / procedure table — the shape the ECB
guidance uses in its own worked example.

**What is deliberately absent.** STIX, MISP, the Admiralty (5x5x5) grading
scale, ICD 203's probability lexicon, the Cyber Kill Chain and the Diamond Model
appear in **no** ECB TIBER document; they belong to the CBEST / STAR-FS lineage
or to other traditions entirely, and a prompt presenting them as TIBER
requirements teaches the model to write a confident forgery. Each is pinned out
by name in the core test. ICD 203 is excluded as a *TIBER requirement* rather
than as a bad idea: the tier still requires likelihood and analytic confidence
to be stated separately, and `docs/PERSON-RESEARCH.md` §7 cites it directly.

## 8. Scope honesty and the legal line

The last line of the `full` tier is why the tier can ship at all. A real TIBER-EU
targeted threat intelligence report is written under contract by an engaged
intelligence provider, with the entity's consent, inside a controlled engagement
with a white team and a red team. The ECB requires that provider to respect
national law and the GDPR and to demonstrate ethical conduct, and active
reconnaissance is not the intelligence provider's to run: the guidance is
explicit that it "can look up which IP addresses belong to the entity, but
cannot perform port scanning".

This pipeline has none of that. It reads published sources for a reader who may
have no relationship with the subject at all. So the block requires the report
to say, in its scope section, that it is a **desk study built from public
sources**; that it is **not a commissioned TIBER-EU engagement**, with no
engaged provider, no white team, no consent from the subject and no red team;
that nothing in it involved scanning, probing, logging in, buying data or any
other contact with the subject's systems; and that its findings are not to be
presented as tested. Resembling the report's structure is the instruction.
Claiming to be one is not.

Where the subject is a person, or where the dossier reaches individuals around
one, person research's guardrails apply on the same turn and bound what may be
collected at all (`docs/PERSON-RESEARCH.md` §8): the public professional record
only, no special categories by inference or juxtaposition, no de-anonymising, no
contact under a pretext.

## 9. What this feature does not do

- **No lookup, no data, no model call, no outbound request.** The gate is a
  regex pair and the block a constant per tier; collection stays the ordinary
  search pipeline's job. Its only failure mode is not firing, which costs a less
  careful report, and the enrichment test replaces `globalThis.fetch` with a
  thrower to keep it that way.
- **No name detection.** Nothing here extracts a subject's name; the gate
  matches the request shape, and the subject reaches the pipeline through the
  message itself.
- **Nothing about the subject is logged, and no dossier is stored.** One log
  line and one state entry record the tier and the block's size, and the test
  asserts that `revsec` never appears in the logs. There is no accumulation
  across turns and no per-subject record in this deployment.
- **The block never routes the request.** It is appended to the user's message,
  and the pipeline's source gates read `ctx.gateLastUser` — the clean message
  plus the transcription of the user's own attachment, and nothing the pipeline
  wrote (`docs/ARCHITECTURE.md` §4.3c). Feedback #61 is why that separation
  exists, and this block argues for keeping it: it names TIBER-EU, MITRE ATT&CK,
  attack surface and threat actors, the exact vocabulary that would drag an
  ordinary company question into a security source leg if a gate could read it.
- **Server side only.** A Worker enrichment, on `/api/chat` and `/mcp` alike
  (both build a plan, so the tier is present on both). The Se/cure client
  pipeline does not carry it.

## 10. Tests

`public/js/entity-research-core.test.js` — the gate on the verbatim reported
message, on a bare unclassifiable name and across both languages; the ordinary
research and Swedish topic questions that must stay silent; a "Swedish language
parity" suite of sixteen matched EN/SV pairs (the enforcement pattern from
`src/googlemaps.test.js`); the `\b` trap demonstrated live, including the
assertion that `/\bunderrättelse\b/` fails on a string it visibly contains; the
ASCII-typed forms. Then the block: the resolution rules with both brakes, one
tier header per tier and no other, word counts that increase with the tier, the
`brief` tier's absence of MITRE and executive summaries, the fallback to
`standard`, the TIBER content contract, the ATT&CK naming, the scope-honesty
lines, the 300–1000 word budget, and the `USING THIS BLOCK` tail that stops a
model citing the method among its findings. Every deliberate exclusion is pinned
as a negative assertion rather than left to a comment, so a later widening has to
argue with a named case.

`src/entity-research.test.js` — the enrichment contract from
`src/enrichment.js`. On a non-dossier turn: the same array reference back, no
step, no state, no log. On a dossier turn: the block appended after the user's
own words, two steps under the registry id, the tier named in the finished
step's details, counters that carry no subject. Then the tier read from the plan
for all four values, the fallback for an absent, empty or malformed plan, the
fail-soft cases (a null or non-array conversation, an absent ctx, an image-only
message, a missing step helper, a frozen state bag), and the multipart case
where an attached image survives the append.

`src/extensions.test.js` — the core-purity guard (invariant 7) lists
`./entity-research.js` among the modules `enrichment.js` may import. It names
TIBER-EU and MITRE ATT&CK the way the person block names a company register, as
vocabulary rather than a service anyone integrates with, and it has no knob, no
secret, no state slice and no descriptor: an attack-surface question can reach
both this module and the Shodan extension, and this one would behave identically
in a deployment where Shodan had never been registered.
