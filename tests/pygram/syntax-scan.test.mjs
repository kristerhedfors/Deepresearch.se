// The syntax-gap scanner, tested as C, on the host.
//
// pygram/variant/pygram_compat.h carries pygram_missing_syntax(): given the
// source of a program that has ALREADY failed to parse, it names the construct
// CPython accepts and MicroPython's parser does not — `match`, `{**d}`,
// `except*`, a positional-only `/`, parenthesized with-items — so the program
// leaves by the exit-90 contract instead of exit 1 with "SyntaxError: invalid
// syntax". Without it, every one of those is a MISMATCH, and the worst-shaped
// one: an agent reading that line concludes its own correct program is broken.
//
// The scanner is the only part of pygram that guesses. Everything else answers
// a question with a definite answer — is this module frozen, does this type
// have this attribute — while this one reads text and decides what a parser
// meant. So it gets a battery, and the battery is bigger on the NEGATIVE side
// than the positive: a false positive sends a program that pygram could have
// run away to CPython, and a false positive on a program CPython also rejects
// turns a plain exit 1 into a 90.
//
// It runs on the HOST, not in pygram. The function is pure C over a char* with
// no MicroPython types in it, so `cc` compiles it straight out of the header —
// which means this test needs no pygram build, no i386 toolchain and no VM,
// and so it runs in CI beside the unit tests rather than behind the build gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADER = join(HERE, "..", "..", "pygram", "variant", "pygram_compat.h");

/**
 * Slice the pure-C half of the header out and wrap it in a main().
 *
 * The cut is deliberately anchored on the two markers below rather than on a
 * line count: the header grows, and a test that silently compiled half a
 * scanner would pass while testing nothing.
 */
function extractScanner(headerText) {
  const start = headerText.indexOf("#define PYGRAM_SYNTAX_DEPTH");
  const end = headerText.indexOf("// Set by ports/unix/main.c");
  assert.ok(start > 0, "PYGRAM_SYNTAX_DEPTH marker missing from pygram_compat.h");
  assert.ok(end > start, "the runtime-hook marker moved; re-anchor this extraction");
  let body = headerText.slice(start, end);
  // Drop the trailing doc comment that introduces the runtime hooks.
  const tail = body.lastIndexOf("/*");
  if (tail > 0) body = body.slice(0, tail);
  return body;
}

function buildScanner() {
  const dir = mkdtempSync(join(tmpdir(), "pygram-scan-"));
  const src = join(dir, "scan.c");
  const bin = join(dir, "scan");
  writeFileSync(
    src,
    [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <ctype.h>",
      "#include <stdbool.h>",
      extractScanner(readFileSync(HEADER, "utf8")),
      "int main(int argc, char **argv) {",
      "    const char *r = pygram_missing_syntax(argv[1]);",
      '    printf("%s\\n", r ? r : "(none)");',
      "    return 0;",
      "}",
    ].join("\n"),
  );
  // -Wall -Werror is the point as much as the battery is: this header is
  // compiled into an i386 build that is slow to produce, so a warning found
  // here is a build cycle not spent.
  const cc = spawnSync("cc", ["-Wall", "-Werror", "-O1", "-o", bin, src], { encoding: "utf8" });
  assert.equal(cc.status, 0, `the scanner does not compile cleanly:\n${cc.stderr}`);
  return { bin, dir };
}

const { bin, dir } = buildScanner();
process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const scan = (src) => execFileSync(bin, [src], { encoding: "utf8" }).trim();

const MATCH_STMT = "match statement";
const CASE_CLAUSE = "match statement (case clause)";
const EXCEPT_STAR = "except* (exception groups)";
const POSONLY = "positional-only parameter (def f(a, /, b))";
const DICT_UNPACK = "dict unpacking in a literal ({**d})";
const WITH_PARENS = "parenthesized with-items";
const NONE = "(none)";

// Every entry here was run under CPython 3.11 and under a pygram build: CPython
// executes it, pygram's parser rejects it. That is what makes it a divergence
// rather than a language-reference exercise.
test("detects the constructs CPython accepts and MicroPython cannot parse", () => {
  const cases = [
    ['x = 1\nmatch x:\n    case 1: print("one")', MATCH_STMT],
    ["match (a, b):\n    case _: pass", MATCH_STMT],
    ["match command.split():\n    case [x]: pass", MATCH_STMT],
    ["    case 1:\n        pass", CASE_CLAUSE],
    ["try:\n    pass\nexcept* ValueError:\n    pass", EXCEPT_STAR],
    ["try:\n    pass\nexcept*ValueError:\n    pass", EXCEPT_STAR],
    ["def f(a, /, b): return a + b", POSONLY],
    ["def f(a, /): return a", POSONLY],
    ["def f(a,/,b): return a", POSONLY],
    ['print({**a, "b": 1})', DICT_UNPACK],
    ['print({"a": 1, **d})', DICT_UNPACK],
    ["merged = {**defaults, **overrides}", DICT_UNPACK],
    ['with (open("a") as f,): pass', WITH_PARENS],
    ['with (open("a") as f, open("b") as g):\n    pass', WITH_PARENS],
    // the form the syntax exists FOR — the `as` is on a later line than the
    // `(`, which a line-bounded scan misses entirely
    ['with (\n    open("a") as f,\n    open("b") as g,\n):\n    pass', WITH_PARENS],
    ['with (\n    open("a") as f,\n):\n    pass', WITH_PARENS],
  ];
  for (const [src, want] of cases) {
    assert.equal(scan(src), want, `scanning:\n${src}`);
  }
});

// The negative side is the one that matters. A false positive here does real
// damage: it routes a program pygram CAN run to the 90, and it re-labels a
// genuine typo as "pygram is too small".
test("does not fire on valid pygram programs", () => {
  const clean = [
    'print("fine")',
    "print(6 / 2)",
    "print(sum([1, 2]) / 2)",
    "def f(a, b): return a / b",
    "def ratio(num, den):\n    return num/den",
    "def f(**k): return k\nprint(f(**{'a': 1}))",
    "print(max(*[1, 2]))",
    "print(2 ** 3)",
    "print({1, 2})",
    "print({'a': 1})",
    "print(1 == 1, 1 != 2, 1 <= 2, 1 >= 0)",
    "try:\n    pass\nexcept ValueError:\n    pass",
    "class A(B): pass",
    "class A:\n    x = 1",
    'with open("a") as f: pass',
    'with open("a") as f, open("b") as g: pass',
    'with (lambda: 1)() as f: pass',
    'with (open("a")) as f: pass',
    'with (\n    open("a")\n) as f: pass',
    'x = (\n    1,\n)\nwith open("a") as f: pass',
    "",
  ];
  for (const src of clean) {
    assert.equal(scan(src), NONE, `false positive on:\n${src}`);
  }
});

// `match` and `case` are SOFT keywords: CPython still lets them be ordinary
// names, and they are common ones — `m = re.match(...)` is in this repo's own
// corpus. Flagging those would mean every program that fails to parse for any
// other reason and happens to call re.match gets blamed on the match statement.
test("treats match and case as the soft keywords they are", () => {
  const clean = [
    "match = 1\nprint(match)",
    "m = re.match(p, s)\nprint(m)",
    'd = {"match": 1}\nprint(d["match"])',
    "case = 2\nprint(case)",
    "for case in cases:\n    print(case)",
    "matches = []\nprint(matches)",
    "print(matching)",
    "def match(a, b):\n    return a == b",
  ];
  for (const src of clean) {
    assert.equal(scan(src), NONE, `false positive on a soft keyword:\n${src}`);
  }
});

// Everything the scanner looks for can appear inside a string or a comment, and
// this repo's corpus is full of programs that manipulate Python source as data.
test("skips comments and string literals", () => {
  const clean = [
    'print("match x:")',
    "# match x:\nprint(1)",
    'def f():\n    """match x:\n    case 1: pass"""\n    return 1',
    "src = '''\nmatch x:\n    case 1: pass\n'''\nprint(len(src))",
    'import re\nprint(re.findall(r"a{**}", "a"))',
    'print("def f(a, /, b)")',
    "print('except* Error')",
    'print("{**d}")',
    'print("with (a as b,):")',
    'esc = "he said \\"match x:\\""\nprint(esc)',
  ];
  for (const src of clean) {
    assert.equal(scan(src), NONE, `false positive inside a literal:\n${src}`);
  }
});

// `f(**kw)` is supported and extremely common; `{**d}` is not. The two differ
// only by which bracket is open, which is the whole reason the scanner tracks a
// bracket stack instead of matching on `**`.
test("tells {**d} apart from f(**kw) by the enclosing bracket", () => {
  assert.equal(scan("def f(**kw): pass\nf(**{'a': 1})"), NONE);
  assert.equal(scan("print(dict(**a))"), NONE);
  assert.equal(scan("print([*a, *b])"), NONE);
  assert.equal(scan("print({**a})"), DICT_UNPACK);
  assert.equal(scan("print(f({**a}))"), DICT_UNPACK);
  assert.equal(scan("print({'k': f(**a)})"), NONE);
});

// A division inside a call argument list is indistinguishable from a
// positional-only marker unless the separators are checked, and division in a
// call is far more common than `/` in a signature.
test("tells a positional-only marker apart from division", () => {
  assert.equal(scan("print(total / count)"), NONE);
  assert.equal(scan("f(a / b, c)"), NONE);
  assert.equal(scan("f(a, b / c)"), NONE);
  assert.equal(scan("print(len(x) / 2, y / 3)"), NONE);
  assert.equal(scan("def f(a, /, b): pass"), POSONLY);
});

// Deep nesting must not run the fixed bracket stack off its end. The scanner
// runs while the process is already failing, so a crash here replaces a wrong
// exit code with no output at all.
test("survives pathological input without crashing", () => {
  assert.equal(scan("(".repeat(200) + ")".repeat(200)), NONE);
  assert.equal(scan("{".repeat(200)), NONE);
  assert.equal(scan(")".repeat(200)), NONE);
  assert.equal(scan('"' + "unterminated"), NONE);
  assert.equal(scan("'''never closed"), NONE);
  assert.equal(scan("#" + "x".repeat(5000)), NONE);
  assert.equal(scan("\n".repeat(1000) + "match x:\n    case 1: pass"), MATCH_STMT);
  // a brace nest deeper than the stack must not report a phantom {**d}
  assert.equal(scan("f(" + "[".repeat(60) + "**" ), NONE);
});
