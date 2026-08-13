/*
 * pygram — the MicroPython unix-port variant behind docs/PYGRAM.md.
 *
 * This file is the ENTIRE C-level configuration of pygram. Everything else the
 * variant contributes is a frozen Python module (pygram/lib) or the small port
 * patch in ../patches. Keeping it that shallow is deliberate: tracking upstream
 * MicroPython has to stay a rebase, not a merge (docs/PYGRAM-RESEARCH.md §6).
 *
 * Two forces shape every line below.
 *
 *   1. COLD BYTES. The sandbox root filesystem is an ext2 image streamed block
 *      by block over a WebSocket, so the first run of a binary pays for its ELF
 *      over a network (docs/SANDBOX-PERFORMANCE.md §1). Every feature that is
 *      not on the corpus's critical path is turned off, and the size gate is
 *      700,000 B stripped (scripts/pygram-gate.mjs).
 *
 *   2. PATH PROBES. MicroPython searches sys.path BEFORE consulting its frozen
 *      module table, at three statx calls per path entry per module. Trimming
 *      the default path cut a five-import workload from 56 file syscalls to 26
 *      (docs/PYGRAM-RESEARCH.md §2.5). `.frozen` alone is required — removing
 *      it too breaks frozen imports entirely.
 *
 * LAYOUT NOTE, and it cost a build: the unix port compiles with -Werror, and a
 * plain `#define X (0)` here for anything mpconfigvariant_common.h also defines
 * is a hard "redefined" error, not a warning. So this file has three sections —
 * settings the common header READS (before the include), the include itself,
 * and overrides of what the common header SET (after it, each #undef'd first).
 * Anything mpconfigport.h defines unconditionally cannot be overridden from
 * here at all; those live in the port patch instead.
 *
 * MIT, same as MicroPython.
 */

// ---------------------------------------------------------------------------
// 1. Before the common header — settings it reads, or does not touch.
// ---------------------------------------------------------------------------

// Base feature level. EXTRA_FEATURES is what the `standard` unix variant uses;
// it is the level at which `re` and `json` exist at all.
#define MICROPY_CONFIG_ROM_LEVEL (MICROPY_CONFIG_ROM_LEVEL_EXTRA_FEATURES)

// sys.path — the probe pin (docs/PYGRAM-RESEARCH.md §2.5). The port patch
// removes the implicit "" (cwd) entry main() prepends; this removes the three
// inherited directories that do not exist in the sandbox and cost a statx
// each, per module, per import. What remains is exactly ['.frozen'].
#define MICROPY_PY_SYS_PATH_DEFAULT ".frozen"

// re — the largest Tier 0 module (docs/PYGRAM-SUBSET.md §3.3, 13 entries).
// Match objects need .start()/.end()/.span()/.groups(); without them the frozen
// re shims (findall/finditer/split) cannot be written in Python at all. These
// are ordinary build options, gated off in `standard` only because its ROM
// level is below EVERYTHING. Turning them on measured NEGATIVE net size in the
// prototype, once the frozen shims replaced C code (§2.5).
#define MICROPY_PY_RE_MATCH_SPAN_START_END (1)
#define MICROPY_PY_RE_MATCH_GROUPS (1)
#define MICROPY_PY_RE_SUB (1)

// deflate's COMPRESSOR defaults to FULL_FEATURES, one level above this
// variant; the decompressor is already in. The frozen zlib shim needs both.
#define MICROPY_PY_DEFLATE (1)
#define MICROPY_PY_DEFLATE_COMPRESS (1)

// hashlib's md5 and sha1 are NOT a flag, which is worth recording so nobody
// spends the afternoon again. They default to MICROPY_PY_SSL, but turning them
// on by name does not build: unlike sha256 (which has a vendored implementation
// in lib/crypto-algorithms), both are implemented ONLY against mbedtls or
// axtls, so switching them on demands an SSL submodule — the one thing this
// build avoids, since it would put a second network dependency and a large
// crypto stack behind a 350 KB binary. sha256 is on and covers the corpus's
// main digest use; md5/sha1 belong in the frozen shim stdlib as pure Python if
// they are ever needed.

// Language surface the corpus needs and EXTRA_FEATURES does not give.
#define MICROPY_PY_BUILTINS_SLICE_ATTRS (1)
#define MICROPY_PY_BUILTINS_STR_CENTER (1)
#define MICROPY_PY_BUILTINS_STR_PARTITION (1)
#define MICROPY_PY_BUILTINS_STR_SPLITLINES (1)
#define MICROPY_PY_BUILTINS_ROUND_INT (1)
#define MICROPY_PY_BUILTINS_NEXT2 (1)
#define MICROPY_PY_ALL_SPECIAL_METHODS (1)
#define MICROPY_PY_REVERSE_SPECIAL_METHODS (1)
#define MICROPY_COMP_RETURN_IF_EXPR (1)
#define MICROPY_MODULE_ATTR_DELEGATION (1)

// input() is out of scope (§5): the bash-lite loop is non-interactive by
// construction, and sys.stdin.read() is the observed idiom. help() is a
// REPL affordance with no REPL to sit in.
#define MICROPY_PY_BUILTINS_INPUT (0)
#define MICROPY_PY_BUILTINS_HELP (0)

// The native emitter is auto-enabled on i386 by mpconfigport.h. pygram never
// emits native code (@micropython.native is not Python), so it is pure size.
#define MICROPY_EMIT_X86 (0)

// No REPL: the loop is non-interactive and -i is explicitly out of scope, and
// the port patch removes do_repl() outright. MICROPY_HELPER_REPL stays ON even
// so — shared/runtime/pyexec.c is compiled unconditionally and calls
// mp_repl_continue_with_input()/mp_repl_get_ps2() from code the linker later
// discards, so switching it off only breaks the build. The line-editing
// affordances behind it are what actually cost bytes, and those do come off.
#define MICROPY_REPL_EVENT_DRIVEN (0)
#define MICROPY_REPL_AUTO_INDENT (0)
#define MICROPY_REPL_EMACS_KEYS (0)

// Concurrency and networking are out of scope (§5): one WASM CPU, and no
// usable network in the guest.
#define MICROPY_PY_THREAD (0)
#define MICROPY_PY_ASYNCIO (0)
#define MICROPY_PY_SELECT (0)
#define MICROPY_PY_SOCKET (0)
#define MICROPY_PY_SSL (0)
#define MICROPY_PY_NETWORK (0)
#define MICROPY_PY_BLUETOOTH (0)

// Debug and instrumentation surfaces.
#define MICROPY_PY_MICROPYTHON_MEM_INFO (0)
#define MICROPY_PY_SYS_SETTRACE (0)
#define MICROPY_TRACKED_ALLOC (0)

// Float repr must be CPython's shortest round-trip: docs/PYGRAM-SUBSET.md §6
// requires 0.1 + 0.2 -> 0.30000000000000004 AND 9.7 -> 9.7, and the default
// APPROX implementation gets the first right while printing the second as
// 9.699999999999999. EXACT is the only setting that satisfies `float-repr`.
#define MICROPY_FLOAT_FORMAT_IMPL (MICROPY_FLOAT_FORMAT_IMPL_EXACT)

// Detailed error reporting stays ON. The messages are not decoration: §6 makes
// several of them contractual ("invalid literal for int() with base 10: 'abc'"),
// and the terse mode would replace the module name in an ImportError with
// "module not found", which is exactly the string the unsupported contract
// needs (pygram_unsupported.h).
#define MICROPY_ERROR_REPORTING (MICROPY_ERROR_REPORTING_DETAILED)

// ---------------------------------------------------------------------------
// 2. Extra Unix features: float, mpz bigints, the unix os/time modules.
// ---------------------------------------------------------------------------
#include "../mpconfigvariant_common.h"

// ---------------------------------------------------------------------------
// 3. After the common header — take back what it switched on.
// ---------------------------------------------------------------------------

// Bare-metal / hardware surfaces with nothing behind them in a browser VM.
#undef MICROPY_PY_MACHINE
#define MICROPY_PY_MACHINE (0)
#undef MICROPY_PY_MACHINE_PULSE
#define MICROPY_PY_MACHINE_PULSE (0)
#undef MICROPY_PY_MACHINE_PIN_BASE
#define MICROPY_PY_MACHINE_PIN_BASE (0)
#undef MICROPY_PY_WEBSOCKET
#define MICROPY_PY_WEBSOCKET (0)
#undef MICROPY_PY_SELECT_POSIX_OPTIMISATIONS
#define MICROPY_PY_SELECT_POSIX_OPTIMISATIONS (0)

// Loading .mpy files off disk is exactly the filesystem walk pygram exists to
// avoid, and there is nowhere to put one in the sandbox image anyway.
#undef MICROPY_PERSISTENT_CODE_LOAD
#define MICROPY_PERSISTENT_CODE_LOAD (0)
#undef MICROPY_VFS_ROM
#define MICROPY_VFS_ROM (0)

// Allocation bookkeeping: size on every path, and a cost per allocation.
#undef MICROPY_MEM_STATS
#define MICROPY_MEM_STATS (0)
#undef MICROPY_MALLOC_USES_ALLOCATED_SIZE
#define MICROPY_MALLOC_USES_ALLOCATED_SIZE (0)
#undef MICROPY_DEBUG_PRINTERS
#define MICROPY_DEBUG_PRINTERS (0)

// sys.atexit is a MicroPython extension, not CPython's atexit module.
#undef MICROPY_PY_SYS_ATEXIT
#define MICROPY_PY_SYS_ATEXIT (0)

// os.system would be a back door around the §5 subprocess decision: a one-liner
// that shells out pays the 6.5 ms spawn floor plus a cold ELF for something the
// agent could have written as the next line of its own bash block. It has to be
// absent, not merely discouraged — a fake that WORKS keeps the expensive
// pattern alive.
#undef MICROPY_PY_OS_SYSTEM
#define MICROPY_PY_OS_SYSTEM (0)

#undef MICROPY_USE_READLINE_HISTORY
#define MICROPY_USE_READLINE_HISTORY (0)

// ---------------------------------------------------------------------------
// 4. pygram's own identity, consumed by the port patch.
// ---------------------------------------------------------------------------

// `--version` must NOT claim a CPython version (docs/PYGRAM-SUBSET.md §2): a
// caller that reads "Python 3.x" off this binary and then assumes the whole
// stdlib is the exact failure the subset contract exists to prevent.
#define PYGRAM_VERSION "0.1"
#define PYGRAM_VERSION_LINE "pygram " PYGRAM_VERSION " (python subset)"

// The unsupported contract (docs/PYGRAM-SUBSET.md §7): exit 90, one line on
// stderr, nothing else. 90 is clear of 0/1/2, of 126/127 and of 128+n, so a
// caller can branch on it and retry the same line with real python3.
#define PYGRAM_UNSUPPORTED_EXIT (90)
