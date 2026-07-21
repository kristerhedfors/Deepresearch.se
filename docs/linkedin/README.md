# LinkedIn article series — full drafts

The project's LinkedIn/blog series exists in three linked forms:

- **Abstracts** — the short abstracts (Swedish) live in
  `public/js/account-articles.js` (`ARTICLES`), each an entry's `body` (its
  intent). Rendered in the admin account panel so the owner can read/copy them
  from any device. Tested by `public/js/account-articles.test.js`.
- **Full drafts** — the expanded, publishable articles live HERE, one file per
  article (`NN-slug.md`). The abstract is the seed; the file here is the full
  text and the drafting **source of truth**.
- **Full articles in the collection** — each written draft is also converted to
  HTML and attached to its abstract as the entry's `article` field (stored in
  `public/js/account-articles-full.js` and imported by `account-articles.js`),
  so the account panel shows BOTH the intent and the actual article, both in
  Swedish.

Keep all three consistent: when a full draft's framing changes, update the
matching abstract's `title`/`body` AND re-convert the draft into
`account-articles-full.js` in the same change (and vice versa). The conversion
is a plain Markdown→HTML pass starting at the first `##` heading (dropping the
H1 title and the frontmatter note), `**bold**`→`<b>`, `*italic*`→`<i>`,
`` `code` ``→`<code>`, `##`→`<h4>`; keep the branding tail bold
(`DeepResearch.<b>Se/cure</b>`) and never let the internal `DRC`/`DRS` acronyms
appear.

Series framing (mission, 2026-07-13): the project is **research and innovation
on the privacy capabilities of LLM applications** — a deliberate
**80% project** (capabilities and architecture over the final 20% of UI
polish). Every claim is meant to be verifiable in the repo and on `/pulse`.
The weekend/phone origin is the origin, not the identity — kept in full only on
`/story`, referenced lightly elsewhere. Branding: DeepResearch.**Se/cure** and
DeepResearch.**Se/rver**, Se/cure first (see `docs/BRANDING.md`).

## Drafts

Full drafts are written and numbered here in **publishing order** (the order the
owner chooses to publish them), which is not the same as the recommended-order
`n` of the phone-readable abstracts in `account-articles.js` — the abstracts are
the backlog, the files here are the drafts as they get written. The `Abstract`
column maps each file back to its seed abstract (and where its full text is
attached in the collection).

| # | Title | File | Abstract | Status |
|---|-------|------|----------|--------|
| 1 | Introduktion: ett 80-procentsprojekt om AI, LLM-applikationer och bevisbar privacy | `01-intro.md` | `n:1` | draft (full text in collection) |
| 2 | Noll beroenden: 137 000 rader utan node_modules | `02-zero-dependencies.md` | `n:6` | draft (full text in collection) |
| 3 | Distribuerade säkra forskningsutrymmen (förladda, dela, försegla, aggregera) | `03-distributed-workspaces.md` | `n:10` | draft (full text in collection) — spec-first; the seal-back/aggregate feature it documents is tracked as **F-18** in `FEATURES.md`. |
| 4 | "We have no moat": Kimi K3 och det försvunna glappet mellan öppna och stängda vikter | `04-kimi-k3-no-moat.md` | — (standalone) | draft (draft-only; not yet mirrored into the collection) — news-hook piece off Kimi K3's July 2026 launch, tying the vanished open/closed-weights gap to the Se/cure never-cloud mission and DistillSDK. Numeric claims are source-linked in-file. |
