# LinkedIn article series — full drafts

The project's LinkedIn/blog series exists in two forms:

- **Abstracts** — the nine short abstracts (Swedish) live in
  `public/js/account-articles.js` (`ARTICLES`), rendered in the admin account
  panel so the owner can read/copy them from any device. Tested by
  `public/js/account-articles.test.js` (nine entries, `n:1..9`, balanced `<p>`
  tags, branding form).
- **Full drafts** — the expanded, publishable articles live here, one file per
  article (`NN-slug.md`). The abstract is the seed; the file here is the
  full text.

Keep the two consistent: when a full draft's framing changes, update the
matching abstract's `title`/`body` in the same change (and vice versa).

Series framing (mission, 2026-07-13): the project is **research and innovation
on the privacy capabilities of LLM applications** — a deliberate
**80% project** (capabilities and architecture over the final 20% of UI
polish). Every claim is meant to be verifiable in the repo and on `/pulse`.
The weekend/phone origin is the origin, not the identity — kept in full only on
`/story`, referenced lightly elsewhere. Branding: DeepResearch.**Se/cure** and
DeepResearch.**Se/rver**, Se/cure first (see `docs/BRANDING.md`).

## Drafts

| # | Title | File | Status |
|---|-------|------|--------|
| 1 | Introduktion: ett 80-procentsprojekt om AI, LLM-applikationer och bevisbar privacy | `01-intro.md` | draft |
