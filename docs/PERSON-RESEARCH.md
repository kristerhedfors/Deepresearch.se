# Person research

The method the pipeline injects when a request is to research a named
individual's public professional record. Shipped 2026-08-05.

Modules: `public/js/person-research-core.js` (the bilingual gate and the block),
`src/person-research.js` (the enrichment). No outbound request, no model call,
no stored data.

## 1. What it is, and what it is not

A person question is a different kind of question, and a general-purpose
research pipeline does not know that. It does not know that a company register
outranks a founder profile, that five outlets running one press release are one
source, that two people with the same name silently become one biography, or
that most of what could be collected about a private individual must not be.

So the enrichment appends a methodology block to the conversation before triage
runs. Every later phase sees it: the planner writes queries against the source
ladder, the search waves inherit the language rule, synthesis writes to the
output structure and the guardrails.

The block carries **no facts about anyone**. It is a protocol, held near 700
words because it rides in the context of every person turn. This document is the
long form, and it costs nothing per request.

## 2. Why it exists

Live feedback #60 (`chat_logs` #1305). A user attached a LinkedIn screenshot of
a startup founder and wrote *"Write a report about what you can find on this
founder"*. The answer restated the screenshot.

Two things were missing, and they are two separate fixes. The picture's text was
never read — that is `src/image-read.js`, which transcribes an attachment before
anything plans research. And even with a name in hand, nothing told the pipeline
how to research a person. That is this module. The user's own follow-up asked
for exactly it: *"do deep research on HOW to properly do research on personal
profiles like this, I want a detailed osint writeup on the individual in these
cases."*

## 3. Where it plugs in

An entry in the `src/enrichment.js` registry, on the same footing as the source
snapshot and the ancient-sample corpus: core, reaching nothing outside this
deployment. `runPersonResearchEnrichment(ctx)` reads the latest user message,
runs the gate, and — when it fires — emits a visible step and appends the block
to the last message with `appendToLast`, which adds a new text part so an
attached screenshot survives.

The gate is conjunctive. It needs a **research shape** and a **person
referent**, and either half alone is a different question:

| message | shape | referent | fires |
|---|---|---|---|
| what can you find on this founder | ✓ | ✓ | yes |
| what can you find about this API | ✓ | — | no |
| this founder gave a good talk | — | ✓ | no |
| vad kan du hitta om den här grundaren | ✓ | ✓ | yes |
| skriv en rapport om elbilsmarknaden | ✓ | — | no |

A miss costs a less careful report. A false fire spends about 900 tokens and
pushes person-shaped caveats into an answer nobody asked for, so the gate stays
conservative.

Both halves take Swedish with the same breadth as English (invariant 6):
definite forms (`grundaren`, `profilen`, `VD:n`), indefinite forms behind a
demonstrative (`den här kandidaten`), the objective pronouns, and the
ASCII-typed variants a phone keyboard without å/ä/ö produces (`sla upp`, `ta
reda pa`, `vem ar`). Every pattern uses lookaround boundaries with the `u` flag,
never `\b` — JavaScript defines `\b` over `[A-Za-z0-9_]`, so an alternative
anchored against an accented letter can never match and the Swedish half of a
gate dies while the English half keeps working. The repo-wide guard is
`src/swedish-boundary.test.js`.

One asymmetry decides where the bare subject pronouns are admitted. In English
"she", "him" and "her" are only ever people. In Swedish "han" is also the Han
dynasty and "hen" is a bird, so `han/hon/hen` count only when the message is
Swedish-shaped; the objective forms `honom/henne/hens` need no such context.

## 4. The nine-phase protocol

The block compresses this into six imperative sections. The order matters more
than any individual step: every phase before phase 4 exists to stop the
collection starting on the wrong person.

1. **Purpose framing and scope lock.** Write down why the research is being done
   and what decision it feeds before searching. The purpose sets what is
   proportionate — a co-investor check and an idle curiosity permit different
   depths of the same search — and it is the only thing that can later justify a
   sensitive category being in scope. Scope written after collection is a
   rationalisation.
2. **Identity resolution.** A name is not an identity. Fix the subject with the
   name plus at least one anchor: employer, city, alma mater, a stable handle,
   an ORCID. Then run a **collision census** — search the bare name and see how
   many distinct people carry it. The census result is a finding and belongs in
   the report; a common name is a permanent caveat on everything that follows.
3. **Claim extraction.** Turn the profile, the pitch or the bio into a list of
   discrete, checkable claims: this role at this company between these dates,
   this degree from this institution, this round raised, this patent, this
   award. Claims are the unit of work from here on. Research organised per
   person produces a narrative; research organised per claim produces a table
   that can be checked.
4. **Collection along the source ladder** (§5), per claim, strongest rung first.
   Stop on a claim when a rung 1-3 source settles it.
5. **Corroboration** (§6). Independence is about origin, not URL count.
6. **Entity expansion.** Follow the companies, not the person: a company number
   reached from an officer appointment yields co-directors, address history,
   filing dates and dissolutions, and reconciles registry-side roles against the
   self-reported ones. Expansion is bounded by the purpose — the people around
   the subject are third parties who never asked to be researched, and appear
   only where a role makes them part of the record.
7. **Timeline construction.** Place every claim on a date axis and mark each row
   documented or self-reported. Overlaps and gaps are visible here and nowhere
   else: two simultaneous full-time roles, a company incorporated before the
   founding date given in press, a title that changes only in the archived
   copies of a page.
8. **Gap analysis.** List what was searched without result, and what evidence
   would settle each open question. Absence of a source is absence of a source.
9. **Confidence-rated writeup** (§7).

## 5. The source ladder

Six rungs, strongest first. The rule that makes it a ladder rather than a list:
**only rungs 1-3, which are independent of the subject, can raise a claim to
verified. Rungs 4-6 establish what was said, not what is true.**

### Rung 1 — statutory registries and regulatory filings

[SEC EDGAR](https://www.sec.gov/edgar/search/) (a Form D names the officers and
directors of a private raise, with dates and amounts),
[Companies House](https://find-and-update.company-information.service.gov.uk/)
(officer appointments and terminations, persons with significant control,
filing history), [Bolagsverket](https://bolagsverket.se) and
[allabolag](https://www.allabolag.se) for Sweden.

Traps. A registry entry is authoritative for *what was filed*, not for what is
true — a director can be appointed and never act. Officer records carry a
service address, which is a filing artefact and not evidence of where anyone
lives, and personal data incidentally present in a filing stays out of the
report (§8). [OpenCorporates](https://opencorporates.com) is a mirror with
uneven refresh: use it to find the company number, then follow it back to the
registry and cite that.

### Rung 2 — intellectual property

Patents via [Google Patents](https://patents.google.com),
[USPTO](https://ppubs.uspto.gov/pubwebapp/) or
[Espacenet](https://worldwide.espacenet.com); trademark registers for the
same jurisdictions.

Traps. Inventor is not assignee — being named on a patent assigned to an
employer says nothing about ownership or seniority. An application is not a
grant, and most of what is cited as "holds N patents" is applications. Priority
dates are the useful part: they anchor when work was actually done, often years
before any public claim. Trademark filings can date a stealth venture before its
first press mention.

### Rung 3 — the scholarly and technical record

[ORCID](https://orcid.org) and [OpenAlex](https://openalex.org) for
disambiguation — both exist precisely because same-name collisions break
bibliometrics — plus DOIs and venue type. A preprint is not a peer-reviewed
paper, and the distinction is machine-readable (`docs/SCHOLAR.md` §2 has the
per-backend rules this repo already applies). On GitHub, a handle is not a
person until an anchor ties them together: a commit email, a linked profile, a
named employer.

Traps. Author-name search without an ORCID merges people. Citation counts
measure a paper, not a person, and sorting a literature by them answers with
methods papers nobody asked about.

### Rung 4 — independent press and awards

Separate originated reporting from rewritten press releases, contributed posts
and paid placements. The tell is usually structural: identical phrasing across
outlets, a "contributor" byline, no named reporter, a publication date clustered
within hours of a company announcement.

[Crunchbase](https://www.crunchbase.com) and PitchBook are **discovery, not
evidence**. Their profile content is frequently entered by the subject or their
company, so a Crunchbase page corroborating a LinkedIn profile is one source
agreeing with itself.

### Rung 5 — company-controlled and self-published surfaces

Team pages, company blogs, conference bios, podcast descriptions. These
establish what the subject and their employer chose to say, which is worth
knowing and is not verification.

The [Wayback Machine](https://web.archive.org) is the highest-leverage tool on
this rung, and often in the whole protocol. An archived team page catches title
drift, quiet departures and rewritten founding stories, and it gives a date to a
claim that the live page presents as timeless. Check the capture date, not the
page's own stated date.

### Rung 6 — the profile itself

LinkedIn, a personal site, a CV supplied by the subject. Self-reported
throughout. It is where the claims come from and never where they are settled.

## 6. Verification

Two independent sources for any contested or high-consequence claim.
**Independence is about origin, not URL count.** Five outlets running one press
release are one source. LinkedIn plus Crunchbase is usually one source. A
company blog post and the company's own filing are two records of the same
assertion by the same party.

Three failure modes to hunt by name:

- **Circular reporting** — outlet A cites outlet B, which cites A's earlier
  piece. Follow every claim to its first appearance and date it.
- **Self-report laundering** — a self-reported claim acquires third-party
  authority by being repeated in a profile, a directory, an award listing and
  then a news piece that sourced the directory.
- **The silent identity merge** — two people with the same name fuse into one
  biography, and nothing in the resulting document looks wrong. This is what the
  collision census in phase 2 exists to bound.

Label every claim's provenance as one of: self-reported, company-controlled,
third-party, registry. Cite with **two dates** — the document's date and the
retrieval date — plus the stable record identifier (accession number, company
number, publication number, DOI), because URLs rot and registry search links
usually do not survive a session.

Absence of a source is absence of a source, and never evidence of anything. Most
legitimate professional activity leaves no public trace. Say where you looked
when you found nothing, so a reader can tell a thin record from a thin search.

This is the [Berkeley Protocol](https://www.ohchr.org/en/publications/policy-and-methodological-publications/berkeley-protocol-digital-open-source-investigations)'s
three-axis model in a smaller frame: verify the **source** (who published it and
what their access was), the **item** (is this file or record what it purports to
be, and is it the original), and the **content** (does what it asserts hold up
against everything else). The three are independent — a trustworthy source can
republish a fabricated item, and an authentic item can assert something false.

## 7. The writeup

The core artefact is a **claim / evidence / confidence table**, one row per
claim: the claim, who asserts it, its status, its provenance class, and the key
evidence with dates.

Statuses: `verified`, `partially verified`, `self-reported only`,
`unverifiable`, `contested`.

Then:

- a **timeline**, each row marked documented or self-reported;
- an **entity map** reconciling registry-side roles against self-reported ones;
- **open questions**, each saying what evidence would resolve it;
- a **numbered source list** with both dates and the record identifiers;
- **limitations**: namesake risk, what was searched without result, what was out
  of scope and why.

Keep **likelihood** separate from **analytic confidence**. Likelihood is how
probable the claim is; confidence is how good the evidence base for that
judgement is, and they move independently — a high-likelihood claim resting on
one self-reported source is not a confident finding.
[ICD 203](https://www.dni.gov/files/documents/ICD/ICD%20203%20Analytic%20Standards.pdf)
is the standard worth borrowing here: use a consistent likelihood vocabulary,
state confidence separately, and never combine the two in a single sentence
("high confidence that it probably happened" tells a reader nothing).

## 8. Guardrails

The governing test: **report only facts of the kind that would appear in a
professional profile the subject might publish themselves.**

Hard prohibitions:

| Not reported | Why |
|---|---|
| Home address, personal phone, personal email, any private contact detail — including one incidentally present in a filing | Not professional-record information; a registry's service address is a filing artefact |
| National identity numbers (personnummer, SSN) | Identity-theft vector; never proportionate to a professional question |
| Family, relationships, children | Third parties who are not the subject of the research |
| Inference of ethnicity, health, religion, politics, sexuality or any other special category — **including by assembling facts whose combination would disclose one** | GDPR Art. 9; see below |
| Exact date of birth | Identity-theft vector; a birth year suffices where age is genuinely relevant |
| Criminal, litigation or credit history | Only where the stated purpose specifically requires it, and then from the primary record |
| Non-professional online activity; de-anonymising a pseudonymous account | Outside the professional record by definition |
| Face matching or reverse image search on a likeness | Biometric processing of a special category |
| Non-public systems, paywalled records obtained around the paywall | Not open source |
| Contacting the subject or their colleagues under any pretext | Not open source, and a pretext is a deception |

Two positive obligations:

- **The subject may be a private individual.** A founder is not automatically a
  public figure. Scrutiny scales to the actual public role — a person running a
  regulated company that took outside money has accepted more of it than someone
  who registered a company and has never made a public claim.
- **Adverse or ambiguous findings need the subject's comment** before anyone
  acts on them. This is the right of reply, and it is also the cheapest
  correction mechanism available: most identity merges and date errors collapse
  the moment the subject is asked.

And the standing editorial rule: report roles, dates and documents. Never infer
character, competence or motive, and never read a gap in the record as a red
flag. A person with no public trace is the normal case.

### 8.1 Grounding

**Berkeley Protocol on Digital Open Source Investigations** (UN OHCHR /
Human Rights Center, Berkeley, 2022) — the six-phase investigation cycle this
protocol's phases mirror, the source/item/content verification model in §6, and
data minimisation as an investigative discipline rather than only a legal one.
Its **mosaic effect** warning is the one that most directly constrains this
feature: individually harmless public facts, compiled, become a capability that
none of them had separately. A dossier on a person *is* mosaic construction, so
the compilation itself has to be justified by the purpose — which is why phase 1
comes before any collection.

**GDPR Art. 5(1)(c)**, [data minimisation](https://gdpr-info.eu/art-5-gdpr/) —
adequate, relevant and limited to what is necessary for the purpose. In practice
this is the rule that decides what is left *out* of a report whose facts are all
public and all true.

**GDPR [Art. 9](https://gdpr-info.eu/art-9-gdpr/)**, special categories, read
with **CJEU C-184/20** (*OT v Vyriausioji tarnybinės etikos komisija*,
1 August 2022). The Court held that publishing personal data **liable to
indirectly disclose** a special category is itself processing of
special-category data. Inference counts, and so does juxtaposition: naming a
spouse alongside a subject can disclose sexual orientation, and a set of
memberships can disclose religion or politics without either word appearing.
That is why the prohibition above extends to *assembling* facts whose
combination discloses a category.

**ICO guidance on recruitment and selection** (employment practices) — vetting
must be proportionate to the role's actual risk, the subject should know it is
happening, and adverse information gets a right of reply before a decision rests
on it. The proportionality and right-of-reply obligations in §8 come from here.

**GIJN** and **Bellingcat** for practice rather than doctrine: work from primary
documents, archive everything at retrieval time, record the retrieval date, and
publish the method alongside the findings so the work can be re-run.

**ICD 203** for the analytic language in §7.

## 9. Scraping

[LinkedIn's User Agreement §8.2](https://www.linkedin.com/legal/user-agreement)
forbids using software or automation to scrape or copy profiles. Separately,
*hiQ Labs v. LinkedIn* (9th Cir. 2022) held that the **CFAA** does not reach
scraping of publicly visible pages — no authorisation is being circumvented when
no authorisation is required. The two are not in conflict, and the case did not
end where the headline did: hiQ settled in a **stipulated judgment of $500,000**
with a **permanent injunction**, on breach-of-contract and related grounds. Not
a crime, still not permitted.

The practical rule this platform follows:

- Reading a page a human opened, or reasoning over text the user supplied
  (including a screenshot they attached), is fine.
- Automating retrieval **across** profiles is not, whatever the CFAA says about
  it.

This is the same posture `docs/SCHOLAR.md` §1 takes towards Google Scholar's
`robots.txt`, and for the same reason: the terms of the surface are the terms,
independent of whether breaking them is actionable.

## 10. What this feature does not do

- **No outbound request and no model call.** The gate is a regex pair and the
  block is a constant. Collection is the ordinary search pipeline's job, under
  whatever web-search backend the tier already uses.
- **No name detection.** The gate never tries to extract a person's name from
  free text. Names are matched by nothing here — the referent is a role word, a
  pronoun or a platform name, and the subject's actual identity reaches the
  pipeline through the message and, for a screenshot, through
  `src/image-read.js`.
- **Nothing about the subject is logged.** The one log line and the one state
  entry record that the method was applied and how large the block was.
- **No stored dossier.** There is no accumulation across turns and no per-person
  record anywhere in this deployment.

## 11. Search-query playbook

Per claim, not per person. `X` is the subject, `Anchor` an employer, city or
institution.

| Goal | Query shape |
|---|---|
| Collision census | `"X"` bare, then `"X" -Anchor` to see who else is there |
| Identity anchor | `"X" "Anchor"`, `"X" site:linkedin.com/in`, `"X" ORCID` |
| Company role | `"X" site:find-and-update.company-information.service.gov.uk`, allabolag/Bolagsverket by name, then by company number |
| Funding event | `"Company" "Form D" site:sec.gov`, `"Company" raised "Series A"` restricted to originated reporting |
| Patents | `inventor:"X"` on Google Patents; then the assignee and the priority date |
| Publications | ORCID id if known; OpenAlex author search plus institution; never a bare name |
| Title drift | The employer's team page on `web.archive.org`, three or more captures spread over the claimed tenure |
| Local record | The same queries in the subject's own language — a Swedish founder's registry footprint and local press never surface from English queries |

The language rule earns its place in the block for a measured reason: the
registry, the local business press and the university page are in the subject's
language, and an English-only search of a Swedish or German subject returns the
self-published English surfaces and nothing else — the exact rungs that cannot
verify anything.

## 12. Tests

`public/js/person-research-core.test.js` — the gate on the verbatim reported
message, the shape/referent conjunction, the topic questions that must stay
silent, the "Swedish language parity" suite of matched EN/SV pairs (the
enforcement pattern from `src/googlemaps.test.js`), and content assertions for
the ladder rule, every hard prohibition and the `USING THIS BLOCK` tail.

`src/person-research.test.js` — the enrichment contract: silent and the
conversation unchanged when the gate misses, block appended plus a visible step
when it fires, the multipart case where an attached screenshot has to survive
the append, and the fail-soft cases.
