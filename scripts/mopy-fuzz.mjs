#!/usr/bin/env node
// mopy's differential fuzzer — generate only what mopy CLAIMS, then disagree
// with CPython about it.
//
//   node scripts/mopy-fuzz.mjs                      # 200 batches, random seed
//   node scripts/mopy-fuzz.mjs --seed 7 --batches 500
//   node scripts/mopy-fuzz.mjs --seed 7 --json      # machine-readable findings
//   node scripts/mopy-fuzz.mjs --repro '1e16'       # one expression, both engines
//
// WHY THIS EXISTS, given tests/mopy/conformance.mjs already runs a corpus.
//
// The corpus is HARVESTED: it is what agents really typed, which makes it the
// right thing to rank a build order by and the wrong thing to establish
// correctness with. It only ever covers the ground someone happened to walk
// over. mopy answers 68.6% of it — but "no MISMATCH on 472 observed programs"
// and "agrees with CPython" are very different claims, and only the first one
// is evidence for the second in proportion to how much of mopy's surface those
// 472 programs touch. Nobody knows that number, and it is certainly not 1.
//
// So this generates programs instead, from mopy's OWN declared vocabulary —
// the BUILTINS table in builtins.rs, the six method tables in methods.rs, the
// module attrs in modules.rs. Those tables are not documentation: route.rs
// reads them to decide statically whether mopy can run a program. Generating
// from them means every probe is something mopy asserts it handles.
//
// THE ORACLE IS EXACT, which is the part that makes this cheap. mopy refuses by
// exiting 90 with `mopy: unsupported: <kind>: <detail>`, so it says for itself
// whether it claimed a program:
//
//   exit 90        NOT-CLAIMED. Not a finding. This is the design working —
//                  docs/MOPY.md §5's three refusals (i64 overflow, set
//                  iteration order, repr of non-ASCII) live here, and so does
//                  every feature not built yet.
//   same answer    MATCH.
//   anything else  MISMATCH — mopy said it could and then disagreed. A real
//                  semantic gap, every time, with no judgement call.
//
// There is no third possibility to argue about, which is what separates this
// from a fuzzer that needs a human to triage its output.
//
// HOW A FINDING LOCALISES ITSELF. Each batch is a few hundred INDEPENDENT
// probes, each of the form
//
//     try:
//         print(repr(<expr>))
//     except BaseException as e:
//         print("!", type(e).__name__)
//
// so a probe is exactly one output line whatever it does — repr() escapes
// newlines, and an exception becomes a line naming its class rather than a
// traceback nobody can compare. Line N of the output is probe N, so diffing
// the two outputs names the failing expression directly; there is no
// bisection step. Batching is only for speed: a spawn costs ~2 ms and a probe
// costs microseconds, so one-probe-per-spawn would spend all its time in
// fork(). The shrinker then reduces the single expression that failed.
//
// WHAT IS DELIBERATELY NOT GENERATED. Anything whose answer CPython does not
// fix: no clock, no PRNG, no id()/hash(), no iteration over a set, no file or
// network I/O, no `input`. A fuzzer that reports unspecified behaviour trains
// its reader to skim, and the one real finding then goes past unread.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ---------------------------------------------------------------------------
// The binaries
// ---------------------------------------------------------------------------

/**
 * The musl-static mopy, preferred over the glibc one for the reason
 * docs/MOPY.md §7 gives: the dynamic loader's five file opens are the entire
 * startup gap, so measuring or testing the wrong binary quietly measures
 * something else. Correctness does not depend on which, but keeping one rule
 * across both tools means a repro line copied from here works there.
 */
export function mopyBin(env = process.env) {
  if (env.MOPY_BIN) return resolve(env.MOPY_BIN);
  const candidates = [
    join(ROOT, "mopy/target/x86_64-unknown-linux-musl/release/mopy"),
    join(ROOT, "mopy/target/release/mopy"),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

/**
 * A real CPython ELF, not whatever is first on PATH.
 *
 * pygram's capture shim installs itself as `python3` early on PATH, and it
 * EXECS the real interpreter — so resolving by name still produces correct
 * answers while logging every probe this fuzzer generates as a real agent
 * invocation. The next harvest would fold hundreds of thousands of synthetic
 * one-liners into the corpus as observed evidence and destroy the frequency
 * table that ranks the build order. This is the same trap
 * tests/pygram/conformance.mjs documents; PYGRAM_CAPTURE=0 below is the
 * second line of defence.
 */
export function referencePython(env = process.env) {
  const dirs = (env.PATH || "").split(":").filter(Boolean);
  for (const name of [env.PYTHON_BIN, "python3.11", "python3"].filter(Boolean)) {
    if (name.includes("/") && existsSync(name)) return name;
    for (const d of dirs) {
      const p = join(d, name);
      if (!existsSync(p)) continue;
      const head = spawnSync("head", ["-c", "4", p], { encoding: "latin1" });
      if (head.stdout && head.stdout.startsWith("\x7fELF")) return p;
    }
  }
  return "python3";
}

// ---------------------------------------------------------------------------
// A seeded PRNG, so every finding is reproducible from its seed
// ---------------------------------------------------------------------------

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The vocabulary — mopy's own tables, transcribed with types
// ---------------------------------------------------------------------------
//
// Every entry here appears in mopy/src/builtins.rs BUILTINS,
// mopy/src/methods.rs's six tables, or mopy/src/modules.rs. The TYPES are this
// file's addition: generating `"abc".zfill(3)` needs to know zfill wants an
// int, or nine probes in ten are a TypeError and the fuzzer spends its budget
// confirming that both interpreters can raise TypeError.
//
// Keeping the tables in sync with the Rust is checked by
// scripts/mopy-fuzz.test.mjs, which parses the Rust and fails on drift — a
// method added to mopy and not here is surface that silently never gets fuzzed,
// which is the failure mode that matters.

const STR_METHODS = {
  capitalize: [], casefold: [], count: ["str"], encode: [], endswith: ["str"],
  find: ["str"], format: [], index: ["str"], isalnum: [], isalpha: [],
  isdigit: [], islower: [], isnumeric: [], isspace: [], isupper: [],
  join: ["strlist"], ljust: ["smallint"], lower: [], lstrip: [], partition: ["str"],
  removeprefix: ["str"], removesuffix: ["str"], replace: ["str", "str"],
  rfind: ["str"], rindex: ["str"], rjust: ["smallint"], rpartition: ["str"],
  rsplit: [], rstrip: [], split: [], splitlines: [], startswith: ["str"],
  strip: [], swapcase: [], title: [], upper: [], zfill: ["smallint"],
};

const LIST_METHODS = {
  append: ["int"], clear: [], copy: [], count: ["int"], extend: ["intlist"],
  index: ["int"], insert: ["smallint", "int"], pop: [], remove: ["int"],
  reverse: [], sort: [],
};

const DICT_METHODS = {
  clear: [], copy: [], get: ["str"], items: [], keys: [], pop: ["str"],
  popitem: [], setdefault: ["str"], update: ["dict"], values: [],
};

const BYTES_METHODS = {
  decode: [], endswith: ["bytes"], find: ["bytes"], hex: [], join: ["byteslist"],
  lower: [], lstrip: [], replace: ["bytes", "bytes"], rsplit: [], rstrip: [],
  split: [], startswith: ["bytes"], strip: [], upper: [],
};

// Set methods are in mopy's table but every probe that would PRINT a set is a
// NOT-CLAIMED (docs/MOPY.md §5: set iteration order is refused, deliberately).
// So sets are only ever generated where the result collapses to something
// ordered — a length, a membership test, a sorted() — and the methods that
// return sets are exercised through those.
const SET_METHODS = {
  difference: ["set"], intersection: ["set"], issubset: ["set"],
  issuperset: ["set"], symmetric_difference: ["set"], union: ["set"],
};

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const TYPES = ["int", "float", "str", "bytes", "list", "dict", "bool"];

export function makeGenerator(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  // Integer literals stay well inside i64 so that `bigint` refusals do not eat
  // the budget: mopy is RIGHT to refuse those and a NOT-CLAIMED teaches
  // nothing. The boundary itself is worth probing, so a small share of literals
  // sit near it deliberately.
  const intLit = () => {
    // `-9223372036854775808` is not a literal: it is unary minus applied to
    // 9223372036854775808, which is past i64, so mopy refuses at LEX time and
    // takes the whole batch with it. The bound is reached from the other side.
    if (chance(0.05)) return pick(["2**62", "-2**62", "9223372036854775807", "(-9223372036854775807 - 1)"]);
    if (chance(0.25)) return String(int(-3, 3));
    if (chance(0.5)) return String(int(-1000, 1000));
    return String(int(-(2 ** 31), 2 ** 31));
  };

  // Floats are where the pygram pass found its worst bug (print(100.0) giving
  // 1e+02), so the literal set is built to walk every notation boundary CPython
  // switches at rather than to look varied.
  const floatLit = () =>
    pick([
      "0.0", "-0.0", "1.0", "10.0", "99.0", "100.0", "1000.0", "12345.0",
      "0.5", "-0.5", "1.5", "2.675", "0.1", "0.2", "1/3", "2/3",
      "1e15", "1e16", "1e17", "1e22", "1e-4", "1e-5", "1e100", "5e-324",
      "1.7976931348623157e308", "0.1+0.2", "float('inf')", "-float('inf')",
      String(int(-10000, 10000) / 100),
    ]);

  const strLit = () => {
    if (chance(0.08)) return pick(['"räksmörgås"', '"Ärlig"', '"åäö"', '"naïve"']);
    return pick([
      '""', '"a"', '"abc"', '"Hello World"', '" padded "', '"a b  c"',
      '"\\t\\n"', '"AbC"', '"123"', '"12.5"', '"a,b,,c"', '"-"', '("x" * 3)',
      '"MiXeD cAsE"', '"...."', '"0"', '"a\\\\b"', '"it\'s"', '"line1\\nline2"',
    ]);
  };

  const bytesLit = () => pick(['b""', 'b"a"', 'b"abc"', 'b"\\x00\\xff"', 'b" x "', 'b"a,b"']);

  const listLit = (d) => {
    const n = int(0, 4);
    const items = [];
    for (let i = 0; i < n; i++) items.push(gen(chance(0.7) ? "int" : pick(TYPES), d + 1));
    return "[" + items.join(", ") + "]";
  };

  const intListLit = () => "[" + Array.from({ length: int(0, 5) }, () => intLit()).join(", ") + "]";
  const strListLit = () => "[" + Array.from({ length: int(0, 4) }, () => strLit()).join(", ") + "]";
  const bytesListLit = () => "[" + Array.from({ length: int(0, 3) }, () => bytesLit()).join(", ") + "]";

  const dictLit = (d) => {
    const n = int(0, 3);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(`${strLit()}: ${gen(chance(0.6) ? "int" : pick(TYPES), d + 1)}`);
    return "{" + parts.join(", ") + "}";
  };

  const setLit = () => "{" + Array.from({ length: int(1, 4) }, () => intLit()).join(", ") + "}";

  /** Generate an expression of (approximately) `type`. */
  function gen(type, d = 0) {
    // Depth cap: past it, only literals, so a program always terminates.
    if (d > 3) return atom(type);
    switch (type) {
      case "smallint":
        return String(int(0, 8));
      case "intlist":
        return intListLit();
      case "strlist":
        return strListLit();
      case "byteslist":
        return bytesListLit();
      case "set":
        return setLit();
      case "int":
        return chance(0.55) ? atom("int") : intExpr(d);
      case "float":
        return chance(0.55) ? atom("float") : floatExpr(d);
      case "str":
        return chance(0.5) ? atom("str") : strExpr(d);
      case "bytes":
        return chance(0.6) ? atom("bytes") : bytesExpr(d);
      case "list":
        return chance(0.5) ? atom("list") : listExpr(d);
      case "dict":
        return chance(0.7) ? atom("dict") : dictExpr(d);
      case "bool":
        return boolExpr(d);
      default:
        return gen(pick(TYPES), d);
    }
  }

  function atom(type) {
    switch (type) {
      case "int": return intLit();
      case "float": return floatLit();
      case "str": return strLit();
      case "bytes": return bytesLit();
      case "list": return listLit(3);
      case "dict": return dictLit(3);
      case "bool": return pick(["True", "False"]);
      case "smallint": return String(int(0, 8));
      case "set": return setLit();
      default: return intLit();
    }
  }

  function intExpr(d) {
    return pick([
      () => `(${gen("int", d + 1)} ${pick(["+", "-", "*", "//", "%", "&", "|", "^", "<<", ">>"])} ${gen("int", d + 1)})`,
      () => `abs(${gen("int", d + 1)})`,
      () => `len(${gen(pick(["str", "list", "dict", "bytes"]), d + 1)})`,
      () => `int(${gen(pick(["float", "bool"]), d + 1)})`,
      () => `int(${pick(['"42"', '"-7"', '"0"', '" 12 "', '"ff", 16', '"0b101", 2', '"z"'])})`,
      () => `round(${gen("float", d + 1)})`,
      () => `sum(${intListLit()})`,
      () => `ord(${pick(['"a"', '"Z"', '"0"', '" "'])})`,
      () => `${pick(["min", "max"])}(${intListLit() || "[1]"} or [0])`,
      () => `divmod(${gen("int", d + 1)}, ${pick(["3", "-3", "7", "10"])})[${int(0, 1)}]`,
      () => `-${gen("int", d + 1)}`,
      () => `${gen("str", d + 1)}.${pick(["find", "count", "rfind"])}(${strLit()})`,
    ])();
  }

  function floatExpr(d) {
    return pick([
      () => `(${gen("float", d + 1)} ${pick(["+", "-", "*"])} ${gen("float", d + 1)})`,
      () => `(${gen("int", d + 1)} / ${pick(["3", "7", "-3", "2", "10"])})`,
      () => `round(${gen("float", d + 1)}, ${int(0, 6)})`,
      () => `abs(${gen("float", d + 1)})`,
      () => `float(${pick(['"1.5"', '"-0.25"', '"1e10"', '"inf"', '"nan"', '"  2.5 "'])})`,
      () => `float(${gen("int", d + 1)})`,
      () => `(${gen("float", d + 1)} ** ${pick(["2", "0.5", "-1", "0"])})`,
      () => `(${gen("float", d + 1)} ${pick(["//", "%"])} ${pick(["1.0", "2.5", "-3.0"])})`,
    ])();
  }

  function strExpr(d) {
    return pick([
      () => {
        const m = pick(Object.keys(STR_METHODS));
        const args = STR_METHODS[m].map((t) => gen(t, d + 1)).join(", ");
        return `${gen("str", d + 1)}.${m}(${args})`;
      },
      () => `(${gen("str", d + 1)} + ${gen("str", d + 1)})`,
      () => `(${gen("str", d + 1)} * ${int(0, 3)})`,
      () => `str(${gen(pick(["int", "float", "bool", "list", "dict", "bytes"]), d + 1)})`,
      () => `repr(${gen(pick(["int", "float", "str", "bool"]), d + 1)})`,
      () => `${gen("str", d + 1)}[${slice(d)}]`,
      () => `${pick(["hex", "oct", "bin"])}(${gen("int", d + 1)})`,
      () => `chr(${pick(["65", "97", "48", "32", "955", "10"])})`,
      () => `format(${gen(pick(["int", "float"]), d + 1)}, ${pick(['""', '"d"', '".2f"', '">8"', '"08.3f"', '"+"', '"x"', '"e"', '"g"', '","'])})`,
      () => `"{}".format(${gen(pick(["int", "float", "str"]), d + 1)})`,
      // Only NUMERIC interpolations. A string subexpression would embed a
      // double quote inside the f-string — `f"{"abc"}"` — which is a
      // SyntaxError in CPython 3.11 (PEP 701 allows it only from 3.12), and a
      // syntax error takes down the whole BATCH rather than one probe.
      () => `f"{${quoteFree(gen(pick(["int", "float"]), d + 1))}}"`,
      () => `f"{${quoteFree(gen(pick(["int", "float"]), d + 1))}:${pick([".2f", "5d", "<6", "^7", "+.1f", "x", "e"])}}"`,
      () => `${gen("bytes", d + 1)}.decode()`,
      () => `${strLit()}.join(${strListLit()})`,
    ])();
  }

  function bytesExpr(d) {
    return pick([
      () => {
        const m = pick(Object.keys(BYTES_METHODS));
        const args = BYTES_METHODS[m].map((t) => gen(t, d + 1)).join(", ");
        return `${gen("bytes", d + 1)}.${m}(${args})`;
      },
      () => `(${gen("bytes", d + 1)} + ${gen("bytes", d + 1)})`,
      () => `${gen("str", d + 1)}.encode()`,
      () => `bytes(${intListLit().replace(/-?\d+/g, (m) => String(Math.abs(+m) % 256))})`,
      () => `${gen("bytes", d + 1)}[${slice(d)}]`,
    ])();
  }

  function listExpr(d) {
    return pick([
      () => {
        const m = pick(Object.keys(LIST_METHODS));
        const args = LIST_METHODS[m].map((t) => gen(t, d + 1)).join(", ");
        // The mutators return None; wrap so the probe shows the LIST, which is
        // where a divergence would be.
        return `(lambda _l: (_l.${m}(${args}), _l)[1])(${intListLit()})`;
      },
      () => `sorted(${pick([intListLit(), strListLit()])})`,
      () => `sorted(${strListLit()}, key=len)`,
      () => `list(${pick([`range(${int(0, 6)})`, `range(${int(-3, 3)}, ${int(3, 9)})`, `range(${int(0, 9)}, ${int(-3, 3)}, -${int(1, 3)})`])})`,
      () => `list(${gen(pick(["str", "dict", "bytes"]), d + 1)})`,
      () => `${gen("str", d + 1)}.split(${chance(0.5) ? "" : strLit()})`,
      () => `${gen("list", d + 1)}[${slice(d)}]`,
      () => `(${gen("list", d + 1)} + ${intListLit()})`,
      () => `[x ${pick(["* 2", "+ 1", "** 2", "% 3"])} for x in ${intListLit()}]`,
      () => `[x for x in ${intListLit()} if x ${pick([">", "<", ">=", "=="])} ${int(-3, 3)}]`,
      () => `list(enumerate(${strListLit()}${chance(0.5) ? "" : ", " + int(0, 3)}))`,
      () => `list(zip(${intListLit()}, ${strListLit()}))`,
      () => `list(map(abs, ${intListLit()}))`,
      () => `list(filter(None, ${intListLit()}))`,
      () => `list(reversed(${intListLit()}))`,
      () => `${gen("list", d + 1)} * ${int(0, 2)}`,
      () => `sorted(${intListLit()}, reverse=True)`,
    ])();
  }

  function dictExpr(d) {
    return pick([
      () => {
        const m = pick(Object.keys(DICT_METHODS));
        const args = DICT_METHODS[m].map((t) => gen(t, d + 1)).join(", ");
        return `(lambda _d: (_d.${m}(${args}), _d)[1])(${dictLit(d + 1)})`;
      },
      () => `dict(${pick(["", `a=${intLit()}`, `a=${intLit()}, b=${intLit()}`])})`,
      () => `dict(zip(${strListLit()}, ${intListLit()}))`,
      () => `{k: v for k, v in zip(${strListLit()}, ${intListLit()})}`,
      () => dictLit(d + 1),
    ])();
  }

  function boolExpr(d) {
    return pick([
      () => `(${gen("int", d + 1)} ${pick(["<", "<=", ">", ">=", "==", "!="])} ${gen("int", d + 1)})`,
      () => `(${gen("str", d + 1)} ${pick(["<", ">", "==", "!="])} ${gen("str", d + 1)})`,
      () => `(${gen("float", d + 1)} ${pick(["<", ">", "==", "!="])} ${gen("float", d + 1)})`,
      () => `(${gen("int", d + 1)} == ${gen("float", d + 1)})`,
      () => `bool(${gen(pick(TYPES), d + 1)})`,
      () => `(${gen("str", d + 1)} in ${gen("str", d + 1)})`,
      () => `(${gen("int", d + 1)} in ${intListLit()})`,
      () => `${pick(["all", "any"])}(${intListLit()})`,
      () => `isinstance(${gen(pick(TYPES), d + 1)}, ${pick(["int", "float", "str", "bytes", "list", "dict", "bool"])})`,
      () => `not ${gen(pick(TYPES), d + 1)}`,
      () => `(${gen("bool", d + 1)} ${pick(["and", "or"])} ${gen("bool", d + 1)})`,
      // A set that never exposes its ORDER: mopy refuses order, not sets.
      () => `(${setLit()} ${pick(["<=", ">=", "==", "!="])} ${setLit()})`,
      () => `(len(${setLit()} ${pick(["|", "&", "-", "^"])} ${setLit()}) ${pick(["==", ">"])} ${int(0, 3)})`,
    ])();
  }

  /**
   * An expression safe to interpolate into a double-quoted f-string.
   *
   * CPython 3.11 cannot reuse the enclosing quote inside the braces, so any
   * subexpression carrying a string literal — `int("ff", 16)` reaches the
   * numeric slots — is a SyntaxError. A syntax error fails the whole FILE, so
   * one bad probe silently costs 200 comparisons rather than one.
   */
  function quoteFree(e) {
    return e.includes('"') || e.includes("'") ? intLit() : e;
  }

  function slice(d) {
    const p = () => (chance(0.35) ? "" : String(int(-4, 5)));
    if (chance(0.25)) return String(int(-3, 3));
    if (chance(0.25)) return `${p()}:${p()}:${pick(["1", "2", "-1", "-2", "3"])}`;
    return `${p()}:${p()}`;
  }

  /** One probe: an expression whose value or exception becomes one output line. */
  function probe() {
    return gen(pick(TYPES.concat(["bool", "bool"])), 0);
  }

  return { probe, gen, pick, chance, int };
}

// ---------------------------------------------------------------------------
// Running a batch
// ---------------------------------------------------------------------------

/**
 * Wrap expressions as one-line probes.
 *
 * `repr` rather than `print(x)` because repr never emits a newline, so probe N
 * is always line N and the diff localises without bisection. BaseException
 * rather than Exception so a probe that trips SystemExit or KeyboardInterrupt
 * still reports rather than ending the batch — a single unguarded exception
 * would truncate every probe after it and read as hundreds of divergences.
 */

// The exception classes a probe reports by NAME, leaves before their bases so
// the first matching clause is the precise one.
//
// A chain of named `except` clauses, rather than the obvious
// `except BaseException as e: print(type(e).__name__)`. mopy does not implement
// `type()` of an exception (nor `e.__class__`), so the obvious form made mopy
// exit 90 on EVERY path where an exception was raised — and the fuzzer scored
// that NOT-CLAIMED and moved on. The whole "both engines raise, but not the
// same thing" class was invisible for the first run, and so was "mopy raises
// where CPython answers". A probe wrapper that cannot observe half the
// behaviour is worse than a smaller probe that can, because the run still
// reports a number.
//
// `repr(e)` would also work and would carry the message, but the messages
// legitimately differ between two interpreters and every probe would report a
// divergence. The class is the part that is contractual.
const REPORTED_EXCEPTIONS = [
  "ZeroDivisionError", "OverflowError", "FileNotFoundError", "FileExistsError",
  "PermissionError", "IndexError", "KeyError", "UnicodeDecodeError",
  "NotImplementedError", "AssertionError", "AttributeError", "TypeError",
  "ValueError", "NameError", "UnboundLocalError", "StopIteration",
  "ArithmeticError", "LookupError", "RuntimeError", "OSError",
];

export function buildProgram(exprs) {
  const out = [];
  for (const e of exprs) {
    out.push("try:");
    out.push(`    print(repr(${e}))`);
    for (const exc of REPORTED_EXCEPTIONS) {
      out.push(`except ${exc}:`);
      out.push(`    print("! ${exc}")`);
    }
    out.push("except BaseException:");
    out.push('    print("! other")');
  }
  return out.join("\n") + "\n";
}

export function run(bin, program, timeoutMs = 20_000) {
  const cwd = mkdtempSync(join(tmpdir(), "mopy-fuzz-"));
  try {
    // THE PROGRAM GOES IN A FILE, NOT IN argv.
    //
    // `-c` was the obvious choice and it silently destroyed a whole run. Each
    // probe carries a chain of named `except` clauses, so a 200-probe batch is
    // ~9,000 lines — past ARG_MAX. spawnSync then failed for BOTH engines, both
    // returned empty stdout, the comparison found them equal, and the run
    // reported 12,000 probes and zero divergences. A harness that cannot run
    // the program reports a clean bill of health, which is worse than a crash,
    // and it is the same shape as the pygram gate's strace parser reading a
    // 110-line trace as zero file opens: a measurement bug that inverts into a
    // pass. A file has no size limit, and judge() below now refuses to score a
    // run that did not happen.
    const src = join(cwd, "probe.py");
    writeFileSync(src, program);
    const r = spawnSync(bin, [src], {
      encoding: "utf8",
      timeout: timeoutMs,
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      input: "",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LC_ALL: "C.UTF-8",
        PWD: cwd,
        // See referencePython(): keeps generated probes out of the harvested
        // corpus. Both engines get it; neither should ever log a fuzz run.
        PYGRAM_CAPTURE: "0",
        MOPY_CAPTURE: "0",
      },
    });
    if (r.error && r.error.code === "ETIMEDOUT") return { stdout: "", stderr: "<timeout>", code: null, timedOut: true };
    if (r.error) return { stdout: "", stderr: String(r.error.message), code: null, spawnFailed: true };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const UNSUPPORTED_RE = /^mopy: unsupported: ([\w-]+): (.+)$/m;

/**
 * Compare one expression across both engines.
 *
 * Returns "not-claimed" when mopy exits 90 — that is the contract working, and
 * counting it as anything else would drown the real findings.
 */
export function judge(expr, mopyOut, refOut) {
  // A run that did not happen is not a match. Two empty stdouts compare equal,
  // so without this a spawn failure or a timeout on BOTH engines scores as a
  // clean probe — which is exactly how an ARG_MAX overflow once reported 12,000
  // passing probes while running none of them.
  if (mopyOut.spawnFailed || refOut.spawnFailed) {
    return { verdict: "harness-error", why: `spawn failed: ${mopyOut.stderr || refOut.stderr}` };
  }
  if (mopyOut.timedOut || refOut.timedOut) {
    return { verdict: "harness-error", why: "timed out" };
  }
  if (mopyOut.code === 90) return { verdict: "not-claimed" };
  if (mopyOut.stdout === refOut.stdout) return { verdict: "match" };
  return { verdict: "mismatch", expr, want: refOut.stdout.trim(), got: mopyOut.stdout.trim() };
}

/**
 * The same guard for a BATCH: the probe count must equal the line count, or the
 * two outputs are not aligned and comparing them line by line is meaningless.
 * A batch that comes back short has failed partway, and a probe whose neighbour
 * truncated would be reported as a divergence it did not cause.
 */
export function batchUsable(out, expected) {
  if (out.spawnFailed || out.timedOut) return false;
  if (out.code === 90) return true; // a refusal legitimately stops early
  return out.stdout.split("\n").length - 1 === expected;
}

// ---------------------------------------------------------------------------
// Shrinking
// ---------------------------------------------------------------------------

/**
 * Reduce a failing expression to the smallest one that still disagrees.
 *
 * A generated expression is a nest four deep, and the divergence is usually in
 * one leaf: `(("AbC".swapcase() + "x") * 2)[1:]` fails because of `swapcase`,
 * and reporting the nest hides that. This tries a set of structural
 * simplifications, keeps any that preserves the disagreement, and repeats
 * until nothing helps.
 *
 * Each candidate is verified to STILL DIVERGE before being accepted, so the
 * shrinker can never invent a different failure than the one it was given —
 * which is the way a shrinker usually wastes an afternoon.
 */
export function shrink(expr, runMopy, runRef, budget = 60) {
  let best = expr;
  let spent = 0;
  const diverges = (e) => {
    if (spent++ > budget) return false;
    const prog = buildProgram([e]);
    const m = runMopy(prog);
    if (m.code === 90) return false;
    const r = runRef(prog);
    return m.stdout !== r.stdout && r.stdout.trim() !== "" && !r.stdout.startsWith("! Syntax");
  };
  let improved = true;
  while (improved) {
    improved = false;
    for (const cand of candidates(best)) {
      if (cand === best || cand.length >= best.length) continue;
      if (diverges(cand)) {
        best = cand;
        improved = true;
        break;
      }
    }
  }
  return best;
}

/** Structural simplifications, smallest-first. */
export function candidates(e) {
  const out = [];
  // Peel one layer of parentheses.
  if (e.startsWith("(") && e.endsWith(")")) out.push(e.slice(1, -1));
  // Any balanced parenthesised subexpression, on its own.
  for (let i = 0; i < e.length; i++) {
    if (e[i] !== "(") continue;
    let depth = 0;
    for (let j = i; j < e.length; j++) {
      if (e[j] === "(") depth++;
      else if (e[j] === ")") {
        depth--;
        if (depth === 0) {
          const inner = e.slice(i + 1, j);
          if (inner && !inner.includes(",")) out.push(inner);
          break;
        }
      }
    }
  }
  // Drop a trailing method call or subscript.
  const trail = /^(.*?)(\.\w+\([^()]*\)|\[[^\]]*\])$/.exec(e);
  if (trail && trail[1]) out.push(trail[1]);
  // Drop a leading unary minus / not.
  if (e.startsWith("-") || e.startsWith("not ")) out.push(e.replace(/^(-|not )/, ""));
  // Simplify a binary operand to a literal.
  const bin = /^(.+?) ([-+*/%<>=!&|^]+|\/\/|\*\*|<<|>>|and|or|in) (.+)$/.exec(e);
  if (bin) {
    out.push(bin[1]);
    out.push(bin[3]);
  }
  return [...new Set(out)].sort((a, b) => a.length - b.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? dflt : argv[i + 1];
  };
  const asJson = argv.includes("--json");
  const seed = Number(flag("seed", String((Math.random() * 1e9) | 0)));
  const batches = Number(flag("batches", "200"));
  const perBatch = Number(flag("probes", "150"));
  const repro = flag("repro", null);

  const MOPY = mopyBin();
  const PY = referencePython();
  if (!existsSync(MOPY)) {
    console.error(`mopy binary not found at ${MOPY} — build it with: bash scripts/mopy-build.sh`);
    process.exitCode = 1;
    return;
  }

  const runMopy = (p) => run(MOPY, p);
  const runRef = (p) => run(PY, p);

  if (repro !== null) {
    const prog = buildProgram([repro]);
    const m = runMopy(prog);
    const r = runRef(prog);
    console.log(`expr    ${repro}`);
    console.log(`cpython ${JSON.stringify(r.stdout)}  exit ${r.code}`);
    console.log(`mopy    ${JSON.stringify(m.stdout)}  exit ${m.code}`);
    if (m.code === 90) console.log(`        ${m.stderr.trim()}`);
    console.log(`verdict ${judge(repro, m, r).verdict}`);
    return;
  }

  if (!asJson) {
    console.log(`mopy    ${MOPY}`);
    console.log(`cpython ${PY}`);
    console.log(`seed    ${seed}   batches ${batches} x ${perBatch} probes\n`);
  }

  const rand = mulberry32(seed);
  const gen = makeGenerator(rand);
  const findings = new Map();
  let claimed = 0;
  let notClaimed = 0;
  let harnessErrors = 0;
  const refusalKinds = new Map();

  for (let b = 0; b < batches; b++) {
    const exprs = Array.from({ length: perBatch }, () => gen.probe());
    const prog = buildProgram(exprs);
    const m = runMopy(prog);
    const r = runRef(prog);

    if (!batchUsable(m, exprs.length) || !batchUsable(r, exprs.length)) {
      harnessErrors++;
      console.error(
        `HARNESS ERROR in batch ${b}: mopy exit ${m.code} (${m.stdout.split("\n").length - 1}/${exprs.length} lines)` +
          `, cpython exit ${r.code} (${r.stdout.split("\n").length - 1}/${exprs.length} lines)` +
          `${m.stderr ? " — " + m.stderr.split("\n")[0] : ""}`,
      );
      continue;
    }

    // A refusal is per-PROGRAM, not per-probe: mopy exits 90 on the first probe
    // it cannot serve and the batch stops there. So a refused batch is re-run
    // probe by probe — the expensive path, taken only when it is needed, which
    // keeps the common case at one spawn pair per 150 probes.
    if (m.code === 90) {
      const kind = UNSUPPORTED_RE.exec(m.stderr);
      if (kind) refusalKinds.set(kind[1], (refusalKinds.get(kind[1]) || 0) + 1);
      for (const e of exprs) {
        const p1 = buildProgram([e]);
        const mm = runMopy(p1);
        if (mm.code === 90) {
          notClaimed++;
          const k = UNSUPPORTED_RE.exec(mm.stderr);
          if (k) refusalKinds.set(k[1], (refusalKinds.get(k[1]) || 0) + 1);
          continue;
        }
        claimed++;
        const rr = runRef(p1);
        const v = judge(e, mm, rr);
        if (v.verdict === "mismatch") record(findings, v, runMopy, runRef);
      }
      continue;
    }

    claimed += exprs.length;
    if (m.stdout === r.stdout) continue;

    // Line N is probe N. Find every line that differs and report those probes.
    const ml = m.stdout.split("\n");
    const rl = r.stdout.split("\n");
    for (let i = 0; i < exprs.length; i++) {
      if (ml[i] === rl[i]) continue;
      record(findings, { verdict: "mismatch", expr: exprs[i], want: rl[i], got: ml[i] }, runMopy, runRef);
    }
  }

  const list = [...findings.values()].sort((a, b) => b.count - a.count);
  if (asJson) {
    console.log(JSON.stringify({ seed, batches, perBatch, claimed, notClaimed, harnessErrors, findings: list }, null, 1));
    return;
  }

  console.log(`probes   ${claimed + notClaimed}   claimed ${claimed}   not-claimed ${notClaimed}`);
  if (harnessErrors) {
    // Loud, and it fails the run. A fuzzer that quietly skips batches reports a
    // smaller number of findings from a smaller amount of work and looks like
    // progress.
    console.log(`\nHARNESS ERRORS: ${harnessErrors} batch(es) did not run. The result below is NOT a clean bill of health.`);
  }
  if (refusalKinds.size) {
    const top = [...refusalKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`refusals ${top.map(([k, n]) => `${k}:${n}`).join("  ")}`);
  }
  console.log(`\n${list.length} distinct divergence(s):\n`);
  for (const f of list) {
    console.log(`  ${String(f.count).padStart(4)}x  ${f.shrunk}`);
    console.log(`         cpython  ${f.want}`);
    console.log(`         mopy     ${f.got}`);
    if (f.shrunk !== f.expr) console.log(`         (from    ${f.expr.slice(0, 110)})`);
    console.log();
  }
  process.exitCode = list.length || harnessErrors ? 1 : 0;
}

function record(findings, v, runMopy, runRef) {
  const shrunk = shrink(v.expr, runMopy, runRef);
  // Key on the SHRUNK form plus the answers, so a hundred generated nests
  // around one broken method collapse into one line.
  const key = `${shrunk} ${v.want} ${v.got}`;
  const prior = findings.get(key);
  if (prior) {
    prior.count++;
    return;
  }
  let want = v.want;
  let got = v.got;
  if (shrunk !== v.expr) {
    const p = buildProgram([shrunk]);
    want = runRef(p).stdout.trim();
    got = runMopy(p).stdout.trim();
  }
  findings.set(key, { expr: v.expr, shrunk, want, got, count: 1 });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
