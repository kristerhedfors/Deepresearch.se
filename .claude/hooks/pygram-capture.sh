#!/bin/sh
# pygram-capture: PreToolUse hook for the Bash tool.
#
# The python-shim (scripts/pygram-capture/python-shim) catches every invocation
# that actually reaches an interpreter. This hook catches the COMMAND STRING —
# which is the only place some programs are visible at all: a heredoc body
# (`python3 <<'PY' … PY`), a `uv run` wrapper, or a Write-then-run pattern where
# the program is in a file the shim only sees as a path. Both feeds land in the
# same $PYGRAM_LOG and are merged by scripts/pygram-capture/harvest.mjs.
#
# It NEVER blocks and NEVER decides permission: it prints {"continue":true} and
# exits 0 on every path, including its own failures. Deliberately no
# permissionDecision field — allowing the call here would bypass the normal
# permission prompt for every Bash command in the session.
#
# COST. This runs before EVERY Bash tool call in the repo, and almost none of
# them are python, so the no-match path must be nearly free. Measured in this
# container: spawning node first and deciding afterwards cost 54 ms per Bash
# command. Everything below the payload read is therefore fork-free — the
# payload is read with the `read` builtin (not `cat`), screened with a `case`
# (not `grep`), and node is spawned ONLY once that screen matches: ~3 ms
# otherwise. The screen is deliberately BROADER than the JS regexes that follow
# it: an over-match costs one wasted node spawn, a miss loses a corpus entry
# forever. The JS regexes stay the precise filter, so a loose screen can never
# put noise in the log.
#
# Environment:
#   PYGRAM_LOG        log path (default $HOME/.pygram/invocations.jsonl)
#   PYGRAM_CAPTURE=0  disable capture (the hook still answers, doing nothing)
ok() {
  printf '{"continue":true,"suppressOutput":true}\n'
  exit 0
}

[ "${PYGRAM_CAPTURE:-1}" = "0" ] && ok

# The event JSON arrives on stdin, and the JS below is itself fed to node on
# stdin — so the payload is read FIRST and handed over in the environment. The
# read loop is a shell builtin: no `cat`, no subshell, no fork. Lines are
# concatenated because the payload is JSON, where a newline between tokens is
# insignificant whitespace (and in practice it arrives on one line anyway).
PYGRAM_HOOK_PAYLOAD=""
while IFS= read -r _l || [ -n "$_l" ]; do
  PYGRAM_HOOK_PAYLOAD="$PYGRAM_HOOK_PAYLOAD$_l"
  _l=""
done
[ -n "$PYGRAM_HOOK_PAYLOAD" ] || ok

# --- the cheap pre-screen (no forks) -----------------------------------------
# Note the payload is raw JSON, so a tab or newline inside the command arrives
# as the two characters \t or \n — none of these patterns depend on real
# whitespace. `*py*-c*` is the deliberately loose stand-in for the JS
# `py\s+-c`; the runners are listed by name rather than screening on " run "
# alone, which `npm run …` would trip on nearly every build command.
case "$PYGRAM_HOOK_PAYLOAD" in
  *python*) : ;;
  *py*-c*) : ;;
  *"uv run"* | *"pipx run"* | *"poetry run"* | *"hatch run"* | *"pdm run"* | *"rye run"*) : ;;
  *"<<"*)
    # A heredoc only interests us when a python-ish delimiter is in play; the JS
    # side accepts PY / PYTHON / PYEOF / EOFPY, all of which contain "PY".
    case "$PYGRAM_HOOK_PAYLOAD" in
      *PY*) : ;;
      *) ok ;;
    esac
    ;;
  *) ok ;;
esac

command -v node >/dev/null 2>&1 || ok # no node: nothing to parse the payload with
export PYGRAM_HOOK_PAYLOAD

node - <<'PYGRAM_HOOK_JS' 2>/dev/null || true
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Any of these in a Bash command means a python program may be in it. Kept
// broad on purpose: a false positive costs one extra log line, a miss costs a
// corpus entry we can never recover.
const PYTHONISH = [
  /(?:^|[\s;&|(){}`$"'=])python[0-9.]*(?:\s|$)/,
  /(?:^|[\s;&|(){}`$])py\s+-c(?:\s|$)/,
  /(?:^|[\s;&|(){}`$])(?:uv|pipx|poetry|hatch|pdm|rye)\s+run(?:\s|$)/,
  /<<-?\s*['"]?(?:PY|PYTHON|PYEOF|EOFPY)\b/,
];

function main() {
  const raw = process.env.PYGRAM_HOOK_PAYLOAD || "";
  if (!raw) return;
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  const tool = ev.tool_name || ev.toolName || "";
  if (tool !== "Bash") return;
  const input = ev.tool_input || ev.toolInput || {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return;
  if (!PYTHONISH.some((re) => re.test(command))) return;

  const rec = {
    kind: "bash_command",
    ts: new Date().toISOString(),
    session: ev.session_id || process.env.CLAUDE_CODE_SESSION_ID || null,
    cwd: ev.cwd || process.cwd(),
    tool,
    command,
    description: typeof input.description === "string" ? input.description : null,
    transcript: ev.transcript_path || null,
  };

  let log = process.env.PYGRAM_LOG || "";
  if (!log) {
    const home = process.env.HOME || os.homedir() || "";
    if (home) log = path.join(home, ".pygram", "invocations.jsonl");
  }
  const candidates = [log, path.join(process.env.TMPDIR || os.tmpdir(), `pygram-${process.getuid ? process.getuid() : 0}`, "invocations.jsonl")];
  for (const target of candidates) {
    if (!target) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, JSON.stringify(rec) + "\n");
      return;
    } catch {
      // unwritable — try the next candidate, then give up silently
    }
  }
}

try {
  main();
} catch {
  // a capture failure must never surface to the tool call
}
PYGRAM_HOOK_JS

ok
