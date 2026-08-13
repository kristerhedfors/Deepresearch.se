# pygram-capture

pygram is a minimal Python-subset runtime for the in-browser sandbox. It only
has to run the python that actually gets run here — the one-liners Claude Code
reaches for a hundred times a day. This directory captures those invocations
from live dev environments and merges them into a committed corpus,
`tests/pygram/corpus.jsonl`, which is the target pygram is built against.

Nothing here guesses at what python "should" support. The corpus is a
recording.

## The two feeds

| Feed | Catches | Misses |
| --- | --- | --- |
| `python-shim` on `$PATH` | every process that actually reached an interpreter, including nested ones, subshells, pipelines, Makefiles, `uv run`, and anything a script spawns | programs that never ran (typed then abandoned), and program text held in a `.py` file rather than on the command line |
| `.claude/hooks/pygram-capture.sh` (PreToolUse, Bash) | the full command STRING before it runs — heredocs, `Write`-then-run patterns, commands that fail before exec | anything not issued through the Bash tool |

Both append to the same log, one JSON object per line:

```
$PYGRAM_LOG              # default ~/.pygram/invocations.jsonl
```

`harvest.mjs` reads that log, plus Claude Code transcripts (`~/.claude/projects/**/*.jsonl`,
which is how sessions from before the shim was installed still contribute),
plus the existing corpus, and merges all three.

```
python-shim ─┐
hook ────────┼─> ~/.pygram/invocations.jsonl ─┐
             │                                ├─> harvest.mjs ─> tests/pygram/corpus.jsonl
~/.claude/projects/**/*.jsonl ────────────────┤
tests/pygram/corpus.jsonl (existing) ─────────┘
```

## Install

```sh
scripts/pygram-capture/install            # copies the shim to ~/.local/bin/{python,python3}
scripts/pygram-capture/install --status   # what is installed, is it current, is it on PATH
scripts/pygram-capture/install --uninstall
```

Idempotent — re-running refreshes the installed copy and says whether anything
changed. It **refuses** to overwrite a target that is not one of our shims
(that would silently swap one interpreter for another); pass `--force` to move
the incumbent aside as `<name>.pygram-backup`, which `--uninstall` restores.

`~/.local/bin` is already first on `$PATH` in this environment. Elsewhere, set
`PYGRAM_BIN` to a directory that is.

### The hook (add this to `.claude/settings.json` yourself)

This directory deliberately does not edit `.claude/settings.json`. Add the
`PreToolUse` block below to the existing `"hooks"` object:

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/pygram-capture.sh\""
      }
    ]
  }
]
```

In place, alongside what is already configured:

```json
{
  "hooks": {
    "SessionStart": [ /* … unchanged … */ ],
    "UserPromptSubmit": [ /* … unchanged … */ ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/pygram-capture.sh\""
          }
        ]
      }
    ]
  }
}
```

The hook prints `{"continue":true,"suppressOutput":true}` on every path,
including its own failures, and exits 0. It carries **no** `permissionDecision`
field on purpose: answering `allow` here would auto-approve every Bash command
in the session, which is a much bigger change than a capture harness is allowed
to make.

Both claims were checked against the installed CLI (Claude Code 2.1.42), not
assumed. Its hook-output schema declares `continue` (boolean, optional,
"Whether Claude should continue after hook (default: true)"), `suppressOutput`
(boolean, optional, "Hide stdout from transcript"), `stopReason` (used only
when `continue` is false), and `hookSpecificOutput`. For PreToolUse,
`hookSpecificOutput.permissionDecision` is `.optional()`, and the dispatcher
reads it as `if (out.hookSpecificOutput?.hookEventName === "PreToolUse" &&
out.hookSpecificOutput.permissionDecision) { … }` — with no
`hookSpecificOutput` at all, `permissionBehavior` is never assigned and the
normal permission flow runs untouched. `{"continue":true,"suppressOutput":true}`
is therefore exactly "observe and get out of the way".

### Cost

This runs before every Bash tool call in the repo, and hardly any of them are
python, so the no-match path has to be nearly free. Measured here, 20
iterations per case:

| Payload | Per call |
| --- | --- |
| non-python (`ls -la`) | **2.7 ms** |
| non-python that looks busy (`npm run build && git status`) | **3.4 ms** |
| python (`python3 -c "print(1+1)"`) | **66 ms** |
| *(rejected design: spawn node first, decide after)* | *73 ms on every command* |

The difference is entirely in where the decision happens. The hook reads stdin
with the `read` builtin, screens the payload with a `case` statement, and
spawns `node` only when that screen matches — so the ~66 ms interpreter start
is paid only by commands that can actually produce a corpus entry.

The shell screen is deliberately broader than the JS regexes that follow it
(an over-match costs one wasted node spawn; a miss loses a corpus entry
forever), and the JS regexes remain the precise filter, so a loose screen can
never put noise in the log. Runners are screened by name (`uv run`, `pipx
run`, …) rather than on `" run "`, which every `npm run …` in the repo would
otherwise trip.

## Harvest

```sh
node scripts/pygram-capture/harvest.mjs                 # merge into tests/pygram/corpus.jsonl
node scripts/pygram-capture/harvest.mjs --dry-run       # report, write nothing
node scripts/pygram-capture/harvest.mjs --no-transcripts
node scripts/pygram-capture/harvest.mjs --log X --corpus Y --transcripts Z
```

One record per DISTINCT program:

```json
{"id":"py-0a1b2c3d4e5f","program":"print(1)","argv_tail":[],"source":"shim","first_seen":"2026-08-13T21:00:00.000Z","count":12,"stdin_sample":null}
```

| Field | Meaning |
| --- | --- |
| `id` | `py-` + 12 hex of sha256 over the NORMALIZED program text |
| `program` | the actual python source, after redaction (see below) |
| `argv_tail` | argv after the program (`python -c PROG a b` → `["a","b"]`) |
| `source` | strongest provenance seen: `shim` > `hook` > `transcript` > `manual` |
| `first_seen` | earliest timestamp across all sightings |
| `count` | number of distinct sightings, never decreasing |
| `stdin_sample` | `null` unless known — the shim must not read stdin, so only hand-curated (`manual`) records ever carry one |

Normalization for the dedup hash unifies line endings, strips per-line trailing
whitespace, and drops surrounding blank lines. It does **not** touch
indentation: in Python that is syntax, and two programs indented differently
are two programs.

Re-running is safe. Counts come from stable sighting keys (log line number,
transcript `tool_use` id) rather than being incremented, so a second harvest
over the same inputs produces a byte-identical file and does not even touch it.
Records the current inputs no longer mention — a rotated log, a hand-written
`manual` entry — are carried over untouched.

Skipped: invocations with no inline source (`python script.py`, `python -m
json.tool`, `python --version`), empty programs, and anything over 64 KiB.

`source: "hook"` extends the shim/transcript/manual set: it is the
PreToolUse-captured variant of the transcript class (the same command string,
seen earlier and more reliably), and it is ranked above `transcript` for
exactly that reason.

## Privacy

**The log is not safe to publish. The corpus is committed.** A captured `-c`
program is arbitrary text from this repo's working sessions — file contents,
paths, occasionally a token pasted into a one-liner.

* `~/.pygram/invocations.jsonl` stays local. It is not in the repo and must not
  be committed, pasted into an issue, or attached to a PR.
* `harvest.mjs` redacts before writing. Every program, argv tail, and stdin
  sample is matched against the repo's canonical credential patterns — the same
  set as `scripts/scan-secrets` (OpenAI `sk-`, Berget `sk_ber_`, Groq `gsk_`,
  AWS `AKIA`, GitHub `ghp_`/`github_pat_`, Google `AIza`, Slack `xox*`, PEM
  private-key blocks) — and matches become `[REDACTED <prefix> <n> chars]`.
  Redaction happens BEFORE the hash, so the `id` is a function of the text that
  actually gets written, and re-harvesting the raw log cannot fork a record.
  The marker cannot re-match, so redaction is idempotent.
* Keep the two pattern lists in sync. `scripts/scan-secrets` is the canonical
  one (owned by the security-posture skill §1); `SECRET_PATTERNS` in
  `harvest.mjs` mirrors it.
* Redaction is a backstop, not a promise. Run `scripts/scan-secrets` before
  committing a corpus refresh, and read the diff — a secret in a shape nobody
  has a pattern for still reads as ordinary program text.
* `PYGRAM_CAPTURE=0` disables both the shim's logging and the hook.

## Environment

| Variable | Effect |
| --- | --- |
| `PYGRAM_LOG` | log path (default `~/.pygram/invocations.jsonl`; falls back to `$TMPDIR/pygram-<uid>/` when `$HOME` is unwritable, then gives up silently) |
| `PYGRAM_CAPTURE=0` | disable capture entirely; the shim still execs python |
| `PYGRAM_CAPTURE_EXIT=1` | shim waits for the child instead of exec-ing it, adding an `{"kind":"exit"}` record with `exit_code` and `wall_ms` |
| `PYGRAM_BIN` | install target directory (default `~/.local/bin`) |
| `PYGRAM_TRANSCRIPTS` | transcript root for the harvest (default `~/.claude/projects`) |
| `PYGRAM_CORPUS` | corpus path for the harvest (default `tests/pygram/corpus.jsonl`) |

## What the shim does and does not promise

The wrapped run is transparent: stdin/stdout/stderr are inherited untouched
(nothing in the shim reads stdin), and because it `exec`s, the interpreter's
exit code and signal behaviour are its own — a `SIGTERM`ed run is reported as a
signal death, not as exit 143 from a shell.

**Exit code and wall time are therefore NOT captured by default.** An `exec`
leaves no at-exit path, so the record is written pre-exec with
`"exit_code":null,"wall_ms":null`. `PYGRAM_CAPTURE_EXIT=1` buys them back by
waiting for the child, at the price of one extra process in the middle: a
signal that kills the interpreter then surfaces as exit `128+n` rather than
propagating as a signal death. Correctness of the wrapped run outranks
completeness of the log, so that mode is opt-in.

Logging never fails the command. If `$HOME` is unwritable it falls back to
`$TMPDIR`; if that fails too it logs nothing and runs python anyway. The
interpreter is resolved by scanning `$PATH` minus the shim's own directory and
skipping any file carrying the shim's marker, so it can never exec into itself
however many copies are installed.

It costs about **9 ms** per invocation (measured here, 30 iterations:
13.8 ms bare → 22.5 ms through the shim). The fork budget is what that buys:
one `date`, one `awk` to encode the record, and the append. The PATH scan
resolves absolute entries as text and reads candidates with the shell's own
`read` builtin, so it adds no processes at all — an earlier version that ran
`cd`+`pwd` per PATH directory and called `dirname` cost 15.5 ms instead. This
is a dev-environment capture harness: `PYGRAM_CAPTURE=0` removes the logging
cost, and `--uninstall` removes the shim.

## Tests

```sh
node --test scripts/pygram-capture/harvest.test.mjs
```

Covers dedup, normalization, redaction, command extraction (quoting, heredocs,
runners), and re-run idempotency.

> **Note:** `package.json`'s test glob is `scripts/*.test.mjs`, which is one
> level shallower than this file. `npm test` therefore does NOT pick it up
> today. Adding `scripts/*/*.test.mjs` to the `test` script closes the gap;
> that edit is left to the owner of `package.json`.
