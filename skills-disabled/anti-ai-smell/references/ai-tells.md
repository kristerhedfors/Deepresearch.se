# AI-tell rubric — the patterns to strip, and how

The checklist behind the **anti-ai-smell** skill. It is a field guide, not a
rulebook: every item below shows up in genuine human writing too, so treat a
hit as "look here," not "delete on sight." The goal is prose that reads like a
person wrote it on purpose, with the facts intact.

Grouped from most to least worth your attention. The vocabulary and phrase
lists at the bottom are what the Vale style checks mechanically; the structural
and epistemic tells at the top are the ones only a human read catches.

## Sourcing

Distilled from the community references, not invented here:

- Wikipedia: *Signs of AI Writing* — the ~15k-word field guide from WikiProject
  AI Cleanup, built from thousands of caught submissions. The stable base.
- The *AI tells* rubric (lmmx gist) — the deepest catalogue of voice/epistemic
  tells.
- vale-ai-tells, no-slop, anti-ai-slop-writing — the vocabulary/phrase lists.

Kept deliberately off the "humanizer" SaaS lane (Undetectable.ai, StealthGPT
and kin): those rewrite text to beat a detector, mangle meaning in the process,
and chase a moving target. Wrong tool for documentation that has to stay true.

## 1. Structural tells (a human read catches these)

- **The tricolon reflex.** Everything comes in threes — "fast, cheap, and
  reliable," three-item lists, three parallel clauses. Real emphasis is
  uneven. Break the pattern: two items, or four, or one with a reason.
- **Symmetric load-balancing.** Every section the same length and rhythm. Real
  thinking is jagged — three paragraphs on the hard part, one line on the
  obvious part. Let sections be the length the content earns.
- **Throat-clearing openers.** "In today's fast-paced world…", "In the realm
  of…", "Deep learning has revolutionized…". Cut it. Open on the concrete
  thing — a fact, a number, the actual first step.
- **The clean wrap-up.** "In conclusion, X represents a promising direction…",
  a closing paragraph that restates significance and adds nothing. Delete it or
  end on the last real point.
- **Rhetorical-question scaffolding.** "So what does this mean? It means…",
  "Why does this matter?" followed by a bullet list. State it directly.
- **Bold/emoji/heading excess.** Bolding every other phrase, emoji bullets,
  Title Case On Everything. Reserve bold for genuine terms of art.

## 2. Epistemic texture (the deepest tell)

- **No situated author.** Text that emerges from nowhere, addressed to no one,
  with no stake. Ground claims in who did what and why it's here.
- **Uniform confidence.** Every claim asserted at the same pitch regardless of
  how sure it is. Real writing hedges the uncertain parts and commits to the
  sure ones. (This repo's docs already do this well — "still experimental,"
  "untested," "design checklist, not a supported path." Keep that.)
- **Vague attribution.** "Studies show," "experts agree," "it is widely known."
  Name the source or drop the claim.
- **Fake hedging vs. real hedging.** "Essentially," "technically," "actually"
  used as theatrical reveals, not genuine uncertainty. Real hedges: "as far as
  I can tell," "untested," "I think."

## 3. Sentence-level tells

- **Nominalization.** Actions frozen into nouns: "conduct a review of" → 
  "review," "provide protection for" → "protect," "make a decision" → "decide."
- **Copula inflation.** "serves as," "stands as," "acts as," "functions as"
  where "is" is meant. Say "is."
- **Adverb inflation.** "fundamentally," "substantially," "critically,"
  "seamlessly," "effectively" doing no semantic work. Cut them.
- **Verb upgrading.** "revolutionized" for "changed," "leverage" for "use,"
  "utilize" for "use," "showcase" for "show."
- **Participle chains.** "Doing X, enabling Y, ensuring Z" strung after the
  main clause. Break into sentences.
- **Negative parallelism.** "It's not just X, it's Y." "Not merely A but B."
  A strong tell. Rewrite as a direct claim.
- **Em-dash overuse.** Multiple em-dashes per paragraph as an all-purpose
  connector. Some are fine and this repo uses them heavily as house style —
  the fix is *reduce the density*, not eliminate. Swap some for periods,
  commas, parentheses, or colons.

## 4. Documentation-specific

- **Explaining the obvious.** "This section describes how to configure X" as a
  heading's first line. Just describe it.
- **Promotional tone.** "powerful," "robust," "seamless," "cutting-edge,"
  "state-of-the-art," "game-changer," "supercharge." Documentation states what
  a thing does and its limits, not how great it is.
- **Restating the heading.** A section that opens by rephrasing its own title.
- **Padding transitions.** "It's worth noting that," "As mentioned above,"
  "Importantly," "Note that" where the sentence stands alone. Cut.

## 5. Source-code-specific (comments & identifiers)

Load this only when a doc discusses code style; **do not rewrite code in the
de-smell pass** (owner constraint). For reference:

- **AI external comments** — comments that reference "the conversation," "as
  suggested," "per the discussion above," or link to a chat platform. Delete;
  the code and its tests are the record.
- **Narrating the obvious** — `// increment i by 1` above `i++`. Comments
  explain *why*, not *what*.
- **Over-commenting** — a comment on every line. Prefer self-documenting names
  and a comment only where intent isn't obvious.

## Vocabulary fingerprints (Vale checks these)

Words that spike in AI text. Not banned outright — flagged for a second look,
because most have a legitimate use. Prefer the plain alternative when the
AI-favoured word adds nothing.

| AI-favoured | Plain alternative |
|---|---|
| delve (into) | look at, examine, dig into |
| leverage | use |
| utilize | use |
| facilitate | help, ease |
| foster | encourage, support |
| underscore | show, stress |
| showcase | show |
| boast (a feature) | have, include |
| tapestry | (cut — almost never literal) |
| landscape (figurative) | field, area |
| realm | area, field |
| testament (to) | shows, proof of |
| pivotal | key, central |
| crucial | important, key |
| vital | important |
| comprehensive | complete, full, thorough |
| multifaceted | complex, many-sided |
| robust | (say what you mean: reliable, well-tested) |
| seamless / seamlessly | smooth, direct (or cut) |
| vibrant | (cut — filler) |
| myriad | many |
| plethora | many, plenty |
| nuanced | (say the actual distinction) |
| holistic | whole, end-to-end |
| paradigm | model, approach |
| ecosystem (figurative) | set of tools, stack |
| harness (verb) | use |
| empower | let, enable |
| elevate | improve, raise |
| unlock | enable, allow |
| streamline | simplify, speed up |
| game-changer / game-changing | (cut — say the effect) |
| cutting-edge / state-of-the-art | (cut, or name the version) |

## Phrase templates (Vale checks these)

- "In today's {fast-paced, rapidly evolving, ever-changing} {world, landscape,
  era}…"
- "In the {world, realm} of…"
- "It's {important, worth noting, crucial} to note that…"
- "plays a {crucial, pivotal, vital, key} role"
- "When it comes to…"
- "At the end of the day…"
- "That being said…"
- "Needless to say…"
- "It's not just X, it's Y" / "not merely X but Y"
- "Whether you're a … or a …, "
- "Look no further"
- "the world of"

## The one rule that outranks all of the above

**Preserve every fact, number, invariant, dated directive, branding form, and
code identifier verbatim.** De-smelling changes prose texture, never meaning.
If removing a tell would drop or soften a factual claim, keep the claim and
find a plainer way to say it. A slightly AI-flavoured true sentence beats a
clean false one.
