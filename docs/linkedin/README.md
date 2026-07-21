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
| 1 | Grattis — allt till alla | `01-kimi-k3-no-moat.md` | `n:1` | draft (full text in collection) — **series lead / news hook** off Kimi K3's July 2026 launch. No frontmatter note (kept deliberately clean); headline is celebratory ("congratulations — everything to everyone"). Flow: Kimi K3 closes the gap → the value transfer, capability is everyone's now → what you can build today on Fable 5 **and** open peers → **and you can build it from a phone** (deepresearch.se as a brief two-week `/pulse` example) → honest compute caveat, closing on "you get the software you ask for — if you have the compute." Numeric claims are source-linked in-file. |
| 2 | Introduktion: ett 80-procentsprojekt om AI, LLM-applikationer och bevisbar privacy | `02-intro.md` | `n:2` | draft (full text in collection) — the real introduction to the project, following the news lead that used it as an example. |
| 3 | Noll beroenden: 137 000 rader utan node_modules | `03-zero-dependencies.md` | `n:7` | draft (full text in collection) |
| 4 | Distribuerade säkra forskningsutrymmen (förladda, dela, försegla, aggregera) | `04-distributed-workspaces.md` | `n:11` | draft (full text in collection) — spec-first; the seal-back/aggregate feature it documents is tracked as **F-18** in `FEATURES.md`. |
