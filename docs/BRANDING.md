# Branding — the tier naming rule in full

The complete branding rule (CLAUDE.md keeps the condensed version; this is
the full text with rationale, moved 2026-07-17). The `.sl` slash-spacing
measurement procedure is the **slash-spacing** skill.

**Branding rule (2026-07-10, amended 2026-07-12 and 2026-07-13):** the two
product tiers are ALWAYS written as their full URL without the scheme, in
**CamelCase** (2026-07-12 directive), with the wordplay tail in bold:
DeepResearch.**Se/cure** (the client-side tier) and
DeepResearch.**Se/rver** (the signed-in tier) — in UI text, headers,
docs, and prompts alike (plain text drops the bold, never the full-URL
form). **Whenever the two are named together — a sentence, a list, table
columns, paired diagrams — ALWAYS put Se/cure FIRST, then Se/rver
(secure-first, 2026-07-13 directive).** A single tier named in its own
context (the app's own header, a /cure page pointing at /rver) is exempt;
the rule governs the PAIR's order. The capital tail-S makes the wordplay read as the word it hides:
**Se/cure** → "Secure", **Se/rver** → "Server". No space inside the URL.
Where running copy needs a SHORT name, use the slashed tail alone —
**Se/cure** and **Se/rver** — the included slash is the distinguishing
marker. In the rendered UI the slash is pulled in with a `.sl` span
(`margin: 0 -.12em`) so it reads even tighter — but that constant is
correct only for regular-weight text: the right tightening is
FONT-DEPENDENT (bold ink is wider — at `-.12em` the slash touches the
letters), so any new/changed `.sl` context gets its margin MEASURED, not
eyeballed, with `scripts/slash-gap.mjs` per the **slash-spacing** skill
(scoped override next to the surface's `.sl` rule; e.g. `b .sl
{ margin: 0 -.04em }` on the help page). The CamelCase is a DISPLAY
convention only: functional URLs, `href`s, `fetch`/route paths, publish
slugs, and host strings stay lowercase (`/cure`, `/rver`,
`deepresearch.se`) — the host is case-insensitive, the paths are not.
The acronyms DRC/DRS are INTERNAL names (code identifiers, CLAUDE.md,
skills, commit messages) and must not appear in user-facing copy
(2026-07-12 directive: having a third name pair confuses readers).
