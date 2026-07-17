# Documentation drift log

Append-only ledger of **Class C** documentation drift — cases where the
code and a capability/architecture/privacy-posture claim in the canonical
docs disagreed, and the owner ruled which side was wrong. Maintained by the
**docs-drift-validation** skill; see it for the full workflow. Class M
(mechanical) drift is not logged here — it lands via **update-docs**.

Each entry records the finding, the owner's verdict, and how the checkmark
was given, so future validation runs can tell an owner-validated posture
change from an unexamined one. Only append, and only after the checkmark.

Entry format:

```
## YYYY-MM-DD — <one-line finding>
- **Doc claim:** <doc file> — "<quoted claim>"
- **Code:** <file:line summary> (introduced by <commit(s)>)
- **Verdict:** intended | regression — by owner via <PR #n merge / approving comment / AskUserQuestion>
- **Action:** <doc rewrite landed in …> | <code fix routed via …, doc unchanged>
```

---

*(no entries yet)*
