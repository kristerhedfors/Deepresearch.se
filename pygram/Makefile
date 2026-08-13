# pygram — the one entry point.
#
# Everything here delegates to scripts/pygram-build.sh, which is where the
# pinned versions, the musl-i386 build and the reasoning live. This file exists
# so `make` in this directory does the obvious thing.
#
#   make            build pygram/build/pygram
#   make verify     build, then run the size/opens gate and the conformance battery
#   make gate       the gate alone, against an existing binary
#   make conformance  the corpus diff against the system CPython
#   make clean      drop the built binary (keeps the musl + MicroPython cache)
#   make distclean  drop the cache too — the next build re-downloads

PYGRAM_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT := $(PYGRAM_DIR)..
BIN := $(PYGRAM_DIR)build/pygram
WORK ?= $(PYGRAM_DIR).build

.PHONY: all build verify gate conformance clean distclean

all: build

build:
	@bash $(ROOT)/scripts/pygram-build.sh

verify:
	@bash $(ROOT)/scripts/pygram-build.sh --verify

gate: $(BIN)
	@node $(ROOT)/scripts/pygram-gate.mjs $(BIN) --compare

conformance: $(BIN)
	@PYGRAM_BIN=$(abspath $(BIN)) node $(ROOT)/tests/pygram/conformance.mjs

$(BIN):
	@bash $(ROOT)/scripts/pygram-build.sh

clean:
	rm -rf $(PYGRAM_DIR)build

# The musl build is the slow part (about a minute) and the MicroPython checkout
# is a download. Both are cached, so distclean is for "prove it works from
# nothing", not for routine use.
distclean:
	rm -rf $(PYGRAM_DIR)build $(WORK)
