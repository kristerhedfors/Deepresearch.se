// pygram frozen shim stdlib — differential tests against real CPython 3.11.
//
// The shims in pygram/lib are pure Python, so they can be run under CPython
// directly. That is the whole point of this file: every case below is executed
// TWICE in the same interpreter version — once against CPython's own stdlib and
// once against pygram/lib — and the two outputs must be byte-identical.
// Reasoning about what CPython does is exactly how silent semantic divergence
// (docs/PYGRAM-SUBSET.md §6) gets shipped, so nothing here is asserted from
// memory: CPython is the oracle, live, on every run.
//
// The shim run does not get CPython's modules underneath it either. The driver
// installs RESTRICTED stand-ins for the MicroPython C modules the shims import
// (`ure`, `uos`, `ujson`, `uhashlib`, `ucollections`), each cut back to the
// surface MicroPython actually ships — `uos.stat` returns a bare 10-tuple,
// `uhashlib` has no hexdigest(), `ure` has no findall/split/flags/named groups
// and models re1.5's quirks (`.` matches \n, `$` is end-of-string only,
// `\d\w\s` are ASCII). So a shim that leaned on a CPython convenience fails
// here rather than in the sandbox.
//
// No pygram binary is needed, which is why this suite is cheap enough to sit in
// `npm test`. The binary-level check is tests/pygram/conformance.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "..", "pygram", "lib");

/**
 * Cases. `code` is a whole program; its stdout is what gets compared. Anything
 * that touches the filesystem runs in its own scratch directory, so a case can
 * create files without seeing another case's.
 */
const CASES = [
  // ---- base64 -----------------------------------------------------------
  ["base64-roundtrip", `import base64
b = base64.b64encode(b"hello world")
print(b, base64.b64decode(b), base64.b64decode(b.decode()))`],
  ["base64-urlsafe", `import base64
raw = bytes([251, 255, 190])
print(base64.urlsafe_b64encode(raw), base64.urlsafe_b64decode(base64.urlsafe_b64encode(raw)))`],
  ["base64-padding", `import base64
for n in range(1, 6):
    print(n, base64.b64encode(b"x" * n), base64.b64decode(base64.b64encode(b"x" * n)))`],
  ["base64-empty", `import base64
print(base64.b64encode(b""), base64.b64decode(b""))`],
  ["base64-altchars", `import base64
print(base64.b64encode(bytes([251, 255, 190]), b"@$"))`],

  // ---- os.path ----------------------------------------------------------
  ["ospath-join", `import os.path as p
print(p.join("a", "b", "c.txt"), p.join("/a", "b"), p.join("a", "/b"), p.join("a/", "b"), p.join("", "b"))`],
  ["ospath-split", `import os.path as p
for s in ["a/b/c.txt", "c.txt", "/a", "/", "a/", "", "//a//b"]:
    print(repr(s), p.split(s), repr(p.dirname(s)), repr(p.basename(s)))`],
  ["ospath-splitext", `import os.path as p
for s in ["a/b/c.txt", ".bashrc", "a.tar.gz", "noext", "a/.x", "x.", "a.b/c"]:
    print(repr(s), p.splitext(s))`],
  ["ospath-normpath", `import os.path as p
for s in ["a//b/../c", "./a", "../a", "/../a", "//a/b", "///a", "", ".", "a/b/../.."]:
    print(repr(s), repr(p.normpath(s)))`],
  ["ospath-stat", `import os, os.path as p
open("f.txt", "w").write("12345")
os.makedirs("d/e", exist_ok=True)
os.makedirs("d/e", exist_ok=True)
print(p.exists("f.txt"), p.isfile("f.txt"), p.isdir("f.txt"))
print(p.exists("d/e"), p.isfile("d/e"), p.isdir("d/e"))
print(p.exists("nope"), p.isfile("nope"), p.isdir("nope"))
print(p.getsize("f.txt"), os.stat("f.txt").st_size, os.stat("f.txt")[6])`],
  ["ospath-abspath", `import os, os.path as p
print(p.abspath("x") == p.join(os.getcwd(), "x"), p.abspath("/a/../b"), p.isabs("/a"), p.isabs("a"))`],
  ["os-walk", `import os
os.makedirs("w/sub", exist_ok=True)
open("w/one.txt", "w").write("")
open("w/sub/two.txt", "w").write("")
n = 0
for root, dirs, files in os.walk("w"):
    n += len(files)
print(n)
print(sorted(os.listdir("w")))`],
  ["os-environ", `import os
print(os.environ.get("PYGRAM_NOPE", "default"))
print("PATH" in os.environ, "PYGRAM_NOPE" in os.environ)
print(os.getenv("PYGRAM_NOPE", "d2"))`],
  ["os-remove-rename", `import os, os.path as p
open("t1", "w").write("x")
os.rename("t1", "t2")
print(p.exists("t1"), p.exists("t2"))
os.remove("t2")
print(p.exists("t2"))`],

  // ---- re ---------------------------------------------------------------
  ["re-findall", `import re
print(re.findall(r"\\d+", "a1 bb22 c333"))
print(re.findall(r"a*", "abc"))
print(re.findall(r"(\\w)=(\\d)", "a=1 b=2"))
print(re.findall(r"(a)|(b)", "ab"))
print(re.findall(r"zzz", "abc"))`],
  ["re-finditer", `import re
for m in re.finditer(r"\\d+", "a1 bb22 c333"):
    print(m.group(0), m.start(), m.end(), m.span())`],
  ["re-split", `import re
print(re.split(r"[,;]\\s*", "a, b;c ,d"))
print(re.split(r",", "a,b,c", 1))
print(re.split(r"(,)", "a,b"))
print(re.split(r"x*", "abc"))`],
  ["re-sub", `import re
print(re.sub(r"foo+", "BAR", "foo fooo food"))
print(re.sub(r"(\\w+)=(\\w+)", r"\\2:\\1", "a=1 b=2"))
print(re.sub(r"a", "X", "aaaa", count=2))
print(re.sub(r"\\d+", lambda m: str(int(m.group()) + 1), "a1 b9"))
print(re.subn(r"a", "X", "banana"))
print(re.sub(r"a", "-\\n-", "za"))`],
  ["re-match-vs-search", `import re
print(bool(re.match(r"bar", "foobar")), bool(re.search(r"bar", "foobar")))
print(re.search(r"zzz", "abc") is None)
m = re.search(r"b+", "abbbc")
print(m.group(0), m.start(), m.end(), m.span())`],
  ["re-named-groups", `import re
m = re.search(r"(?P<k>\\w+)=(?P<v>\\d+)", "port=8080")
print(m.group("k"), m.group("v"), m.groups(), m.group(1, 2))
print(sorted(m.groupdict().items()))
print(sorted(re.compile(r"(?P<a>x)(?P<b>y)").groupindex.items()))`],
  ["re-flags", `import re
print(re.findall(r"^\\w+", "one two\\nthree four", re.M))
rx = re.compile(r"error", re.I)
print(len(rx.findall("Error ERROR error")), rx.findall("Error ERROR error"))
print(re.findall(r"[a-f]+", "ABCxyz", re.I))
print(re.sub(r"a", "-", "AaA", flags=re.I))`],
  ["re-dot-newline", `import re
print(re.findall(r"a.c", "a\\nc abc"))
print(re.findall(r"a.c", "a\\nc abc", re.S))
print(re.sub(r"#.*", "", "x #c\\ny"))`],
  ["re-anchors", `import re
print(re.findall(r"^a", "aaa"))
print(re.findall(r"^a", "a\\na\\na", re.M))
print(re.search(r"c$", "abc") is not None, re.search(r"c$", "abc\\n") is not None)
print(re.findall(r"\\w+$", "one two"))`],
  ["re-escape", `import re
print(re.escape("a.b*c"))
print(re.escape("a b+c[d]{e}|f^g$h#i&j~k"))
print(re.findall(re.escape("a.c"), "a.c abc"))`],
  ["re-groups-unmatched", `import re
m = re.search(r"(a)(b)?", "a")
print(m.groups(), m.groups("-"), m.group(2), m.span(2))`],
  ["re-braces", `import re
print(re.findall(r"\\d{3}", "12 345 6789"))
print(re.findall(r"a{2,3}", "a aa aaa aaaa"))
print(re.findall(r"x{2,}", "x xx xxxx"))
print(re.findall(r"[ab]{2}", "ab ba a"))`],
  ["re-compile-methods", `import re
rx = re.compile(r"(\\d+)")
print(rx.findall("a1b22"), rx.split("a1b22"), rx.sub("#", "a1b22"), rx.pattern)
print(rx.search("a1b22").group(1), rx.match("1ab") is not None, rx.match("a1") is None)
print(re.fullmatch(r"\\d+", "123") is not None, re.fullmatch(r"\\d+", "123a") is None)`],

  // ---- collections ------------------------------------------------------
  ["counter-basic", `from collections import Counter
c = Counter("mississippi")
print(c.most_common(2), c["s"], c["zzz"], sum(c.values()))
print(c.most_common())
print(sorted(c.items()))`],
  ["counter-ties", `from collections import Counter
c = Counter()
for w in "d c b a d c b d c d".split():
    c[w] = c.get(w, 0) + 1
print(c.most_common())
print(c.most_common(2))`],
  ["counter-from-iterable", `from collections import Counter
c = Counter(w for line in ["a b a\\n", "c a b\\n"] for w in line.split())
print(c.most_common(3), len(c), "a" in c)`],
  ["counter-update", `from collections import Counter
c = Counter("abc")
c.update("bcd")
print(sorted(c.items()), c.total())`],
  ["defaultdict-int", `from collections import defaultdict
d = defaultdict(int)
for w in "a b a c a".split():
    d[w] += 1
print(dict(sorted(d.items())), len(d), d["nope"], sorted(d.items()))`],
  ["defaultdict-list", `from collections import defaultdict
d = defaultdict(list)
d["a"].append(1)
d["a"].append(2)
print(sorted(d.items()))`],
  ["defaultdict-none", `from collections import defaultdict
d = defaultdict(None)
try:
    d["x"]
except KeyError as e:
    print("KeyError", e)`],

  // ---- json -------------------------------------------------------------
  ["json-dumps-basic", `import json
print(json.dumps({"a": 1}))
print(json.dumps({"b": 2, "a": [1, {"z": None}]}, sort_keys=True, separators=(",", ":")))
print(json.dumps([1, "a", True, None, 1.5]))
print(json.dumps({}), json.dumps([]), json.dumps("x"), json.dumps(3))`],
  ["json-dumps-unicode", `import json
print(json.dumps({"s": "\\u00e5\\u00e4\\u00f6"}, ensure_ascii=False))
print(json.dumps({"s": "\\u00e5\\u00e4\\u00f6"}))
print(json.dumps("tab\\there\\nnl\\"q\\\\b"))
print(json.dumps("\\u0001\\u007f\\U0001f600"))`],
  ["json-dumps-indent", `import json
print(json.dumps([1, "a", True, None], indent=2))
print(json.dumps({"b": [1, 2], "a": {"c": 3}}, indent=2, sort_keys=True))
print(json.dumps({"a": [], "b": {}}, indent=2, sort_keys=True))
print(json.dumps({"a": 1}, indent="\\t"))`],
  ["json-loads", `import json
d = json.loads('{"items":[{"id":1,"tags":["x"]},{"id":2,"tags":[]}]}')
print([i["id"] for i in d["items"] if i["tags"]])
print(json.loads("[1, 2.5, true, null]"))`],
  ["json-bad-input", `import json
try:
    json.loads("{not json")
except ValueError:
    print("invalid ValueError")
try:
    json.loads("{not json")
except json.JSONDecodeError:
    print("invalid JSONDecodeError")`],
  ["json-roundtrip-file", `import json
with open("d.json", "w") as f:
    json.dump({"k": [1, 2, 3]}, f)
with open("d.json") as f:
    print(json.load(f)["k"][1])
print(open("d.json").read())`],

  // ---- hashlib ----------------------------------------------------------
  ["hashlib-hexdigest", `import hashlib
print(hashlib.sha256(b"hello").hexdigest())
print(hashlib.sha1(b"abcd").hexdigest())
print(hashlib.md5(b"abc" * 10).hexdigest())`],
  ["hashlib-update", `import hashlib
h = hashlib.sha1()
for chunk in [b"ab", b"cd"]:
    h.update(chunk)
print(h.hexdigest(), h.hexdigest())
print(hashlib.sha256(b"").hexdigest())
print(hashlib.new("sha256", b"hello").hexdigest())`],

  // ---- glob -------------------------------------------------------------
  ["glob-pattern", `import glob, os
os.makedirs("g", exist_ok=True)
for n in ["a.py", "b.py", "c.txt", ".hidden.py"]:
    open(os.path.join("g", n), "w").write("")
print(sorted(glob.glob("g/*.py")))
print(sorted(glob.glob("g/?.py")))
print(sorted(glob.glob("g/[ab].py")))
print(sorted(glob.glob("g/*")))
print(glob.glob("g/a.py"), glob.glob("g/nope.py"), glob.glob("nodir/*.py"))`],

  // ---- textwrap ---------------------------------------------------------
  ["textwrap-fill-dedent", `import textwrap
print(textwrap.fill("one two three four five six", width=12))
print(textwrap.dedent("    a\\n    b\\n"), end="")
print(repr(textwrap.dedent("\\n    heredoc program\\n")))
print(repr(textwrap.dedent("  a\\n    b\\n")))
print(repr(textwrap.dedent("a\\n  b\\n")))`],
  ["textwrap-shorten", `import textwrap
print(textwrap.shorten("a very long sentence indeed here", width=20))
print(textwrap.shorten("short", width=20))
print(repr(textwrap.wrap("a bb ccc dddd", width=6)))`],

  // ---- datetime ---------------------------------------------------------
  ["datetime-format", `import datetime
d = datetime.datetime(2024, 5, 1, 14, 32, 0)
print(d.strftime("%Y-%m-%d %H:%M:%S"), d.date().isoformat(), d.year)
print(d.isoformat(), str(d), d.strftime("%d/%b/%Y %I:%M %p %a %B"))`],
  ["datetime-arith", `import datetime
d = datetime.date(2024, 1, 31) + datetime.timedelta(days=1)
print(d, (datetime.date(2024, 3, 1) - datetime.date(2024, 1, 1)).days)
print(datetime.date(2023, 3, 1) - datetime.date(2023, 1, 1))
print(datetime.date(2024, 2, 29) + datetime.timedelta(days=366))
print(datetime.date(2024, 5, 1).weekday(), datetime.date(2024, 5, 1).isoweekday())`],
  ["datetime-iso", `import datetime
print(datetime.datetime.fromisoformat("2024-05-01T14:32:00").hour)
print(datetime.datetime.fromisoformat("2024-05-01 14:32:05").isoformat())
print(datetime.date.fromisoformat("2024-05-01"))
print(datetime.date(2026, 8, 13).isoformat())`],
  ["datetime-ordinal", `import datetime
for y, m, d in [(1, 1, 1), (1970, 1, 1), (2000, 3, 1), (2024, 12, 31), (9999, 12, 31)]:
    o = datetime.date(y, m, d).toordinal()
    print(o, datetime.date.fromordinal(o))`],
  ["timedelta-str", `import datetime
print(datetime.timedelta(days=60), datetime.timedelta(seconds=90))
print(datetime.timedelta(days=1, hours=2, minutes=3, seconds=4))
print(datetime.timedelta(days=1).days, datetime.timedelta(hours=25).days)
print(datetime.timedelta(seconds=1) < datetime.timedelta(seconds=2))`],

  // ---- csv --------------------------------------------------------------
  ["csv-writer", `import sys, csv
w = csv.writer(sys.stdout)
w.writerow(["a", "b,c", 'say "hi"'])
w.writerow([1, None, "line\\nbreak"])
w.writerows([["x"], ["y", "z"]])`],
  ["csv-reader", `import csv
rows = list(csv.reader(["a,b,c\\n", "1,2,3\\n", '"q,q",2,"say ""hi"""\\n', "\\n", "last"]))
for r in rows:
    print(r)`],
  ["csv-dictreader", `import csv
open("data.csv", "w").write("name,qty\\na,2\\nb,40\\n")
with open("data.csv") as f:
    rows = list(csv.DictReader(f))
print(sum(int(r["qty"]) for r in rows))
print([sorted(r.items()) for r in rows])`],

  // ---- urllib.parse -----------------------------------------------------
  ["urllib-quote", `from urllib.parse import quote, unquote, quote_plus, unquote_plus
print(quote("a b/c?"), quote("a b/c?", safe=""))
print(unquote("a%20b"), unquote("no-escapes"), unquote("%C3%A5%C3%A4%C3%B6"))
print(quote("\\u00e5\\u00e4\\u00f6"), quote_plus("x y&z"), unquote_plus("x+y"))`],
  ["urllib-encode", `from urllib.parse import urlencode
print(urlencode([("q", "x y"), ("n", 2)]))
print(urlencode([("a", "b/c")]))`],
  ["urllib-parse", `from urllib.parse import urlparse, parse_qs, parse_qsl
u = urlparse("https://deepresearch.se/api/pub?slug=a&n=2")
print(u.netloc, u.path, parse_qs(u.query)["slug"], u.scheme, u.query, repr(u.fragment))
print(parse_qsl("a=1&b=2&a=3"), sorted(parse_qs("a=1&b=2&a=3").items()))
print(tuple(urlparse("/just/a/path")))
print(urlparse("https://h:8080/p#f").port, urlparse("https://h:8080/p#f").hostname)`],

  // ---- statistics -------------------------------------------------------
  ["statistics", `import statistics
xs = [1, 2, 3, 4, 10]
print(statistics.mean(xs), statistics.median(xs))
print(statistics.mean([1, 2]), statistics.median([1, 2, 3, 4]))
print(statistics.mean([1.5, 2.5]), statistics.median_low(xs), statistics.median_high(xs))`],

  // ---- shutil / tempfile / pathlib --------------------------------------
  ["shutil-copy", `import shutil, os
open("src.txt", "w").write("hi")
shutil.copy("src.txt", "dst.txt")
print(open("dst.txt").read(), os.path.exists("dst.txt"))
os.makedirs("sub", exist_ok=True)
shutil.copy("src.txt", "sub")
print(open("sub/src.txt").read())`],
  ["tempfile", `import tempfile, os
with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
    f.write("scratch")
    path = f.name
print(os.path.exists(path), open(path).read(), path.endswith(".txt"))
os.remove(path)`],
  ["pathlib", `from pathlib import Path
Path("p.txt").write_text("hello\\n")
print(Path("p.txt").read_text().strip(), Path("p.txt").suffix, Path("p.txt").exists())
p = Path("a") / "b" / "c.tar.gz"
print(str(p), p.name, p.stem, p.suffix, str(p.parent), p.parts)
print(str(Path("x.txt").with_suffix(".md")), Path("nope").exists(), Path("p.txt").is_file())`],

  // ---- contextlib -------------------------------------------------------
  ["contextlib", `import contextlib
@contextlib.contextmanager
def tag(name):
    print("<" + name + ">")
    yield name
    print("</" + name + ">")
with tag("a") as t:
    print("body", t)
with contextlib.suppress(ValueError):
    raise ValueError("swallowed")
print("after")`],
];

/**
 * Cases where the shim CANNOT match CPython, and the divergence is deliberate.
 * They are asserted as differences so that the day a shim starts agreeing (or
 * diverges in a new way) the suite says so, instead of the README quietly
 * going stale. `note` is the reason; it belongs in pygram/lib/README.md too.
 */
const DIVERGENCES = [
  {
    id: "re-ascii-classes",
    code: `import re
print(re.findall(r"\\w+", "\\u00e5\\u00e4\\u00f6 abc"))`,
    note: "re1.5's \\w/\\d/\\s are ASCII bytes; CPython's are unicode",
  },
  {
    id: "counter-repr",
    code: `from collections import Counter
print(repr(Counter("aab")))`,
    note: "Counter.__repr__ is reimplemented; CPython orders by count, and the shim matches that, but dict repr spacing of a native subclass differs under MicroPython",
    expectSame: true,
  },
];

const DRIVER = String.raw`
import sys, io, json, os as _real_os, traceback

MODE = sys.argv[1]
LIB = sys.argv[2]
CASES = json.loads(sys.stdin.read())

if MODE == "shim":
    import re as _re, os as _os, hashlib as _hashlib, json as _json
    import collections as _collections, binascii as _binascii

    # --- ure: MicroPython's re1.5, modelled honestly -----------------------
    # Only compile/match/search exist; match objects expose group(int),
    # groups(), start/end/span(int). No flags, no named groups, no findall.
    # Engine quirks reproduced: '.' matches \n (Any), '$' is end-of-string
    # only (Eol), \d\w\s are ASCII.
    class _MPMatch:
        # _shift maps an offset in whatever slice the engine was pointed at
        # back to a character index in the whole subject, which is what the C
        # match object reports because its caps point into the original buffer.
        def __init__(self, m, _shift=None):
            self._m = m
            self._shift = _shift or (lambda i: i)
        def group(self, n):
            if not isinstance(n, int):
                raise TypeError("MicroPython match.group takes an int")
            return self._m.group(n)
        def groups(self):
            return self._m.groups()
        def start(self, n=0):
            i = self._m.start(n)
            return i if i < 0 else self._shift(i)
        def end(self, n=0):
            i = self._m.end(n)
            return i if i < 0 else self._shift(i)
        def span(self, n=0):
            return (self.start(n), self.end(n))

    def _reject(pat):
        for bad in ("(?P<", "(?=", "(?!", "(?<"):
            if bad in pat:
                raise AssertionError("re1.5 cannot compile " + bad + " in " + repr(pat))
        i = 0
        while i < len(pat):
            if pat[i] == "\\":
                if pat[i + 1:i + 2] in ("b", "B", "A", "Z"):
                    raise AssertionError("re1.5 has no " + pat[i:i + 2])
                i += 2
                continue
            if pat[i] == "{" and _re.match(r"\{\d+(,\d*)?\}", pat[i:]):
                raise AssertionError("re1.5 has no {n,m} in " + repr(pat))
            i += 1

    def _eol(pat):
        # re1.5's Eol matches only at the very end of the subject.
        out = []
        i = 0
        while i < len(pat):
            c = pat[i]
            if c == "\\":
                out.append(pat[i:i + 2]); i += 2; continue
            if c == "[":
                j = i + 1
                if pat[j:j + 1] == "^": j += 1
                if pat[j:j + 1] == "]": j += 1
                while j < len(pat) and pat[j] != "]":
                    j += 2 if pat[j] == "\\" else 1
                out.append(pat[i:j + 1]); i = j + 1; continue
            out.append("\\Z" if c == "$" else c)
            i += 1
        return "".join(out)

    class _MPPattern:
        def __init__(self, pat):
            _reject(pat)
            self._r = _re.compile(_eol(pat), _re.DOTALL | _re.ASCII)
        def search(self, s, pos=None, endpos=None):
            if pos is None and endpos is None:
                m = self._r.search(s)
                return _MPMatch(m) if m else None
            # pos and endpos are BYTE offsets, and .span() answers in
            # CHARACTERS. That asymmetry is not a quirk of this stub: in
            # extmod/modre.c, re_exec_helper advances subj.begin by the raw
            # integer while match_span_helper converts the result back with
            # utf8_ptr_to_index. Modelling pos as a character index here would
            # make the shim's ASCII gate look like belt-and-braces, and the
            # test would stop covering the reason it exists.
            b = s.encode()
            start = min(max(pos or 0, 0), len(b))
            if endpos is not None:
                b = b[:min(max(endpos, start), len(b))]
            m = self._r.search(b[start:].decode("utf-8", "replace"))
            if not m:
                return None
            return _MPMatch(m, _shift=lambda i: len(
                b[:start + len(m.string[:i].encode())].decode("utf-8", "replace")))
        def match(self, s):
            m = self._r.match(s)
            return _MPMatch(m) if m else None
        def sub(self, repl, s, count=0):
            # re_sub_helper's own loop, divergences included — this is the fast
            # path pygram/lib/re.py delegates to, and the point of the stub is
            # that a wrong delegation FAILS here rather than in production.
            out, at, n = [], 0, 0
            while True:
                m = self._r.search(s, at)
                if not m or m.start() == m.end():
                    break            # an empty match ENDS the native loop
                out.append(s[at:m.start()])
                i, t = 0, repl
                while i < len(t):
                    if t[i] != "\\":
                        out.append(t[i]); i += 1; continue
                    i += 1
                    if t[i:i + 2] == "g<":
                        i += 2       # \g<number> only; \g<name> is not parsed
                    if i < len(t) and t[i].isdigit():
                        g = ""
                        while i < len(t) and t[i].isdigit():
                            g += t[i]; i += 1
                        if i < len(t) and t[i] == ">":
                            i += 1
                        out.append(m.group(int(g)) or "")
                    elif t[i:i + 1] == "\\":
                        out.append("\\"); i += 1
                    # anything else: the backslash is simply dropped, so \n
                    # comes out as the letter n
                at = m.end()
                n += 1
                if count > 0 and n >= count:
                    break
            out.append(s[at:])
            return "".join(out)

    ure = type(sys)("ure")
    ure.compile = lambda pat, flags=0: _MPPattern(pat)
    ure.search = lambda pat, s: _MPPattern(pat).search(s)
    ure.match = lambda pat, s: _MPPattern(pat).match(s)
    ure.sub = lambda pat, repl, s, count=0: _MPPattern(pat).sub(repl, s, count)

    # --- uos: only the names MicroPython's C os module has -----------------
    uos = type(sys)("uos")
    for _n in ("getcwd", "chdir", "listdir", "mkdir", "remove", "rename",
               "rmdir", "unlink", "statvfs", "urandom"):
        setattr(uos, _n, getattr(_os, _n))
    uos.stat = lambda p: tuple(_os.stat(p))     # a bare 10-tuple, no attributes
    uos.getenv = lambda k: _os.environ.get(k)   # returns None, not KeyError
    uos.putenv = lambda k, v: _os.environ.__setitem__(k, v)
    uos.sep = "/"

    # --- ujson / uhashlib / ucollections -----------------------------------
    ujson = type(sys)("ujson")
    ujson.loads = _json.loads
    ujson.load = _json.load

    class _MPHash:
        def __init__(self, h):
            self._h = h
        def update(self, b):
            self._h.update(b)
        def digest(self):
            return self._h.digest()        # deliberately no hexdigest()

    uhashlib = type(sys)("uhashlib")
    for _n in ("sha256", "sha1", "md5"):
        def _mk(name=_n):
            return lambda data=b"": _MPHash(getattr(_hashlib, name)(data))
        setattr(uhashlib, _n, _mk())

    ucollections = type(sys)("ucollections")
    ucollections.deque = _collections.deque
    ucollections.namedtuple = _collections.namedtuple
    ucollections.OrderedDict = _collections.OrderedDict

    for _mod in (ure, uos, ujson, uhashlib, ucollections):
        sys.modules[_mod.__name__] = _mod

    # Drop the CPython modules the shims replace, then put pygram/lib first.
    for _n in ("re", "os", "os.path", "json", "hashlib", "collections",
               "base64", "glob", "textwrap", "datetime", "csv", "urllib",
               "urllib.parse", "statistics", "shutil", "tempfile", "pathlib",
               "contextlib", "posixpath"):
        sys.modules.pop(_n, None)
    sys.path.insert(0, LIB)

out = {}
for case in CASES:
    cid, code = case["id"], case["code"]
    d = _real_os.path.join(case["cwd"], cid)
    _real_os.makedirs(d, exist_ok=True)
    _real_os.chdir(d)
    buf = io.StringIO()
    saved = sys.stdout
    sys.stdout = buf
    try:
        exec(compile(code, cid, "exec"), {"__name__": "__main__"})
        status = "ok"
    except BaseException as e:
        status = type(e).__name__ + ": " + str(e)
    finally:
        sys.stdout = saved
    out[cid] = [status, buf.getvalue()]

sys.stdout.write(json.dumps(out))
sys.stdout.flush()
_real_os._exit(0)
`;

function run(mode, cases, scratch) {
  const driver = join(scratch, "driver.py");
  writeFileSync(driver, DRIVER);
  const r = spawnSync("python3", [driver, mode, LIB], {
    input: JSON.stringify(cases.map((c) => ({ ...c, cwd: join(scratch, mode) }))),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(
      `driver (${mode}) failed: status=${r.status}\n${r.stderr || ""}`,
    );
  }
  return JSON.parse(r.stdout);
}

const scratch = mkdtempSync(join(tmpdir(), "pygram-shims-"));
const all = [
  ...CASES.map(([id, code]) => ({ id, code })),
  ...DIVERGENCES.map(({ id, code }) => ({ id, code })),
];

let cpython, shim, setupError;
try {
  cpython = run("cpython", all, scratch);
  shim = run("shim", all, scratch);
} catch (e) {
  setupError = e;
}

test("the differential drivers both run", () => {
  if (setupError) throw setupError;
  assert.equal(Object.keys(cpython).length, all.length);
  assert.equal(Object.keys(shim).length, all.length);
});

for (const [id] of CASES) {
  test(`shim matches CPython — ${id}`, () => {
    if (setupError) throw setupError;
    assert.equal(
      shim[id][0],
      cpython[id][0],
      `outcome differs: shim ${shim[id][0]} vs cpython ${cpython[id][0]}`,
    );
    assert.equal(shim[id][1], cpython[id][1]);
  });
}

for (const d of DIVERGENCES) {
  test(`known divergence — ${d.id} (${d.note})`, () => {
    if (setupError) throw setupError;
    const same =
      shim[d.id][0] === cpython[d.id][0] && shim[d.id][1] === cpython[d.id][1];
    if (d.expectSame) {
      assert.ok(same, `expected agreement, got ${JSON.stringify(shim[d.id])}`);
    } else {
      assert.ok(
        !same,
        `expected a divergence but the two agreed — update pygram/lib/README.md`,
      );
    }
  });
}

test("scratch cleanup", () => {
  rmSync(scratch, { recursive: true, force: true });
});
