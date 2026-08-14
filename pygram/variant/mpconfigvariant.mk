# pygram — make-level configuration of the MicroPython unix variant.
#
# The .h file next to this one owns the C feature switches; this file owns the
# things the port's Makefile decides before the compiler runs: which optional
# subsystems get compiled and linked at all, and what the binary is called.
#
# Everything switched off here is off for one of two reasons: it drags in a git
# submodule (which would make the build need more network than the two pinned
# downloads), or it drags in a shared library (which would make the binary
# dynamic, and a dynamic binary loses on the only metric that matters —
# docs/PYGRAM-RESEARCH.md §1).

PROG = pygram

# btree needs lib/berkeley-db-1.xx, a git submodule. `import btree` is not in
# the corpus and never will be.
MICROPY_PY_BTREE = 0

# ffi links libffi (submodule or system .so) and exists to call into C
# libraries — the opposite of a self-contained static binary.
MICROPY_PY_FFI = 0

# Networking and TLS: the sandbox guest has no usable network
# (docs/PYGRAM-SUBSET.md §5) and axtls is another submodule.
MICROPY_PY_SOCKET = 0
MICROPY_PY_SSL = 0
MICROPY_SSL_AXTLS = 0

# One WASM CPU; threading buys nothing and links libpthread.
MICROPY_PY_THREAD = 0

# termios and readline serve the REPL, which is out of scope.
MICROPY_PY_TERMIOS = 0
MICROPY_USE_READLINE = 0

# The only filesystem pygram sees is the guest's own, through the POSIX VFS
# (which mpconfigport.h turns on unconditionally). FAT and littlefs are block
# devices that do not exist here, and each links its own driver.
MICROPY_VFS_FAT = 0
MICROPY_VFS_LFS1 = 0
MICROPY_VFS_LFS2 = 0

# Frozen stdlib. This is the mechanism, not a nicety: a stdlib that lives as
# .py files on disk is a stdlib fetched over a WebSocket one file at a time.
FROZEN_MANIFEST ?= $(VARIANT_DIR)/manifest.py

# manifest.py globs this directory rather than naming modules, so the shim
# stdlib in pygram/lib can grow without any build file changing. It has to
# arrive as an environment variable: makemanifest.py's $(VAR) substitution is
# applied inside freeze(), which is too late for the manifest's own isdir check.
export PYGRAM_LIB_DIR := $(abspath $(VARIANT_DIR)/lib)

# >>> SHARED TOOLCHAIN BLOCK — do not move the markers.
# Everything between this line and the closing marker is EXTRACTED VERBATIM by
# `scripts/pygram-build.sh --stock` into the control variant's makefile. That is
# how the stock-MicroPython benchmark control is kept apples-to-apples: libc,
# architecture, optimisation level and strip state cannot drift between the two
# builds, because there is only one copy of these lines in the repository.
# Editing them changes BOTH binaries. Anything below the closing marker is a
# pygram config choice and is deliberately NOT shared — that is what the
# benchmark measures (docs/PYGRAM-BENCH-LEDGER.md).
#
# The static musl link. CC/LD come in from the environment (scripts/pygram-build.sh
# points them at the musl-i386 wrapper it builds); this file only asks for the
# static link and the i386 linker emulation.
#
# -Wl,-m,elf_i386 is load-bearing and cost a build to find: the musl-gcc wrapper
# does not propagate -m32 to the linker's emulation, so without it the link
# fails with "skipping incompatible .../libc.a" (docs/PYGRAM-RESEARCH.md §2.1).
CFLAGS += -m32
LDFLAGS += -m32 -static -Wl,-m,elf_i386

# -Os over the port's default, plus dead-section stripping (the port already
# passes --gc-sections). Size is the product here, not speed: pygram's warm
# interpreter init is 0.96 ms against a 0.92 ms empty-C-program floor
# (docs/PYGRAM-RESEARCH.md §2.7), so there is nothing left to win on speed.
COPT = -Os -DNDEBUG

# musl has no __stack_chk_fail_local, and the guard is pointless in a binary
# whose whole input is a program the caller already controls.
CFLAGS += -fno-stack-protector
# <<< SHARED TOOLCHAIN BLOCK

# Error strings stay as plain text in .rodata rather than being compressed.
# Two reasons, both correctness rather than taste:
#   - docs/PYGRAM-SUBSET.md §6 makes several exception messages contractual
#     ("invalid literal for int() with base 10: 'abc'"), and
#   - the unsupported contract has to print a NotImplementedError's message from
#     inside the VM (pygram_unsupported.h), which a compressed ROM string cannot
#     be turned back into at that point.
# Measured cost: about 8 KB against a 700 KB budget.
MICROPY_ROM_TEXT_COMPRESSION = 0
