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

## The two SDKs: Platform SDK and Agent SDK (2026-07-27 directive)

**The public names are the Platform SDK and the Agent SDK.** They are the two
SDKs distilled from this repo, and Agent Studio sits at their seam:

- The **Platform SDK** builds a whole DeepResearch-like platform — the module
  catalog `sdk/MANIFEST.json` plus one skill playbook per module.
- The **Agent SDK** defines a single agent — the spec registry
  `sdk/AGENTS.json`, `docs/AGENT-PLATFORM.md`, `public/js/agent-spec-core.js`.

**DistillSDK is the Platform SDK's INTERNAL codename**, with exactly the same
split as DRC/DRS: fine in code identifiers, comments, CLAUDE.md, skills and
commit messages; never in user-facing copy. That includes **prompts and
context blocks**, which is the trap this rule was written for — whatever
briefs the model is what the model repeats to the user. The codename reached
a live answer as the step label "distilling a flavour with DistillSDK"
(feedback #41), which was wrong twice over: the internal name, and the wrong
SDK for a single-agent build. `sdk-core.js`, `agent-spec-core.js` and
`prompts.js` carry unit tests asserting the codename appears in no
model-visible string.

Where an existing published text launched the codename deliberately — the
Swedish article series in `public/js/account-articles*.js` — it stays as
written; it is a dated record, not live UI.

## Workspace, not "project" (2026-07-25 directive)

**A named place where research happens is a WORKSPACE, in both tiers.** The
Se/rver tier's "project" and the Se/cure tier's link-sealed session are the
same concept in two forms — a **Se/rver workspace** and a **Se/cure
workspace** — and user-facing copy says so. One noun, two kinds; secure-first
ordering applies to the pair like any other.

This is a DISPLAY rule with the same internal/external split as DRC/DRS:

- **Say workspace** in UI labels, help text, notices, prompts, docs, and
  reader-facing prose.
- **Do not rename code.** `/api/projects*`, R2 `projects/{uid}/…`,
  `public/js/projects.js`, `project-context.js`, the `projects` IndexedDB
  store, and the `project` fields inside stored records keep their names.
  Renaming a live route or a stored record's shape buys nothing and breaks
  existing data.
- When a doc must name the stored artifact, write **workspace record** and
  give the identifier once: *the workspace record (`projects/{uid}/{id}`)*.
- "Project" survives for the repository itself ("this research and innovation
  project") and in the endpoint-bound compound **project vault**
  (`/api/vault/:id`); prefer **workspace vault** where the prose isn't naming
  the endpoint.

The complete specification of both kinds is `docs/WORKSPACES.md`.
