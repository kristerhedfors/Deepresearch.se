# pygram frozen shim: CPython-shaped `re` over MicroPython's re1.5 engine
# (aliased as `_re` by the variant). Adds findall/finditer/split/escape,
# named groups, the I/M/S flags, CPython sub() semantics, and rewrites the
# constructs re1.5 would silently mis-compile. See pygram/lib/README.md.
import ure as _re

NOFLAG = 0
T = TEMPLATE = 1
I = IGNORECASE = 2
L = LOCALE = 4
M = MULTILINE = 8
S = DOTALL = 16
U = UNICODE = 32
X = VERBOSE = 64
A = ASCII = 256
DEBUG = 128


class error(Exception):
    pass


def _unsupported(tok):
    raise NotImplementedError("pygram: unsupported: argument: re(" + tok + ")")


def _swapcase(c):
    return c.upper() if c.islower() else c.lower()


def _fold_class(cls):
    # [a-z] -> [A-Za-z]; also correct for negated classes. The extra members
    # go straight after the '[' (or '[^') so they can never form a range with
    # what follows.
    head = 2 if cls[1:2] == "^" else 1
    body = cls[head:-1]
    add = []
    k = 0
    n = len(body)
    while k < n:
        c = body[k]
        if c == "\\":
            k += 2
            continue
        if body[k + 1 : k + 2] == "-" and k + 2 < n:
            e = body[k + 2]
            if c.isalpha() and e.isalpha():
                add.append(_swapcase(c) + "-" + _swapcase(e))
            k += 3
            continue
        if c.isalpha():
            add.append(_swapcase(c))
        k += 1
    return cls[:head] + "".join(add) + body + "]"


def _reps(spec):
    # "3" -> (3, 3); "2,4" -> (2, 4); "2," -> (2, None); else None
    if "," in spec:
        a, _, b = spec.partition(",")
    else:
        a, b = spec, spec
    if not a.isdigit() or (b != "" and not b.isdigit()):
        return None
    return (int(a), int(b) if b else None)


def _prep(pat, flags):
    """Rewrite a CPython pattern into one re1.5 compiles with the same meaning.

    Returns (native_pattern, name->group index, starts_with_^, ends_with_$).
    """
    ic = flags & I
    out = []
    names = {}
    gi = 0
    i = 0
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == "\\":
            nx = pat[i + 1 : i + 2]
            if nx in ("b", "B", "A", "Z", "G"):
                _unsupported("\\" + nx)  # re1.5 would match these as literals
            if nx.isdigit():
                _unsupported("\\" + nx)  # backreferences are not supported
            out.append(c + nx)
            i += 2
            continue
        if c == "[":
            j = i + 1
            if pat[j : j + 1] == "^":
                j += 1
            if pat[j : j + 1] == "]":
                j += 1
            while j < n and pat[j] != "]":
                j += 2 if pat[j] == "\\" else 1
            if j >= n:
                raise error("unterminated character set")
            cls = pat[i : j + 1]
            out.append(_fold_class(cls) if ic else cls)
            i = j + 1
            continue
        if c == "(":
            if pat[i : i + 4] == "(?P<":
                j = pat.find(">", i)
                if j < 0:
                    raise error("unterminated group name")
                gi += 1
                names[pat[i + 4 : j]] = gi
                out.append("(")
                i = j + 1
                continue
            if pat[i : i + 3] == "(?:":
                out.append("(?:")
                i += 3
                continue
            if pat[i : i + 2] == "(?":
                _unsupported(pat[i : i + 3])
            gi += 1
            out.append("(")
            i += 1
            continue
        if c == ".":
            # re1.5's Any matches \n too, CPython's . does not unless DOTALL.
            out.append("." if flags & S else "[^\n]")
            i += 1
            continue
        if c == "{" and out:
            j = pat.find("}", i)
            r = _reps(pat[i + 1 : j]) if j > 0 else None
            if r is not None:
                atom = out[-1]
                if atom[:1] == "(":
                    _unsupported("{n,m} on a group")
                lo, hi = r
                if hi is None:
                    if lo == 0:
                        rep = [atom + "*"]
                    else:
                        rep = [atom] * (lo - 1) + [atom + "+"]
                else:
                    rep = [atom] * lo + [atom + "?"] * (hi - lo)
                out[-1:] = rep
                i = j + 1
                continue
        if ic and c.isalpha():
            out.append("[" + c.lower() + c.upper() + "]")
            i += 1
            continue
        out.append(c)
        i += 1
    return ("".join(out), names, out[:1] == ["^"], out[-1:] == ["$"])


class Match:
    def __init__(self, m, names, off, string):
        self._m = m
        self._names = names
        self._off = off
        self.string = string

    def _idx(self, g):
        if isinstance(g, str):
            if g not in self._names:
                raise IndexError("no such group")
            return self._names[g]
        return g

    def group(self, *a):
        if len(a) == 0:
            return self._m.group(0)
        if len(a) == 1:
            return self._m.group(self._idx(a[0]))
        return tuple(self._m.group(self._idx(x)) for x in a)

    def groups(self, default=None):
        g = self._m.groups()
        if default is None:
            return g
        return tuple(default if x is None else x for x in g)

    def groupdict(self, default=None):
        d = {}
        for k in self._names:
            v = self._m.group(self._names[k])
            d[k] = default if v is None else v
        return d

    def start(self, g=0):
        v = self._m.start(self._idx(g))
        return v if v < 0 else v + self._off

    def end(self, g=0):
        v = self._m.end(self._idx(g))
        return v if v < 0 else v + self._off

    def span(self, g=0):
        return (self.start(g), self.end(g))

    def __repr__(self):
        return "<re.Match object; span=" + repr(self.span()) + ">"


class Pattern:
    def __init__(self, pattern, flags=0, _notrim=False):
        native, names, anchored, dollar = _prep(pattern, flags)
        self.pattern = pattern
        self.flags = flags
        self.groupindex = names
        self._r = _re.compile(native)
        self._names = names
        self._anchored = anchored
        self._dollar = dollar and not _notrim
        self._full = None

    def fullmatch(self, string):
        if self._full is None:
            # `(?:…)$` is non-capturing, so group numbering is unchanged; the
            # trailing-newline trim is suppressed because CPython's fullmatch
            # has to consume the newline too.
            self._full = Pattern("(?:" + self.pattern + ")$", self.flags, True)
            self._full._names = self._names
        return self._full.match(string)

    def search(self, string):
        for m in _find(self, string):
            return m
        return None

    def match(self, string):
        m = self._r.match(_trim(self, string))
        return Match(m, self._names, 0, string) if m else None

    def findall(self, string):
        return _findall(self, string)

    def finditer(self, string):
        return _find(self, string)

    def split(self, string, maxsplit=0):
        return _split(self, string, maxsplit)

    def sub(self, repl, string, count=0):
        return _subn(self, repl, string, count)[0]

    def subn(self, repl, string, count=0):
        return _subn(self, repl, string, count)


def _trim(p, s):
    # CPython's `$` also matches just before a trailing newline; re1.5's Eol
    # only matches at the very end. Drop that newline before matching.
    if p._dollar and not (p.flags & M) and s[-1:] == "\n":
        return s[:-1]
    return s


def _segments(p, s):
    if p.flags & M:
        off = 0
        for line in s.split("\n"):
            yield line, off
            off += len(line) + 1
    else:
        yield _trim(p, s), 0


def _find(p, s):
    for seg, base in _segments(p, s):
        pos = 0
        ln = len(seg)
        while pos <= ln:
            m = p._r.search(seg[pos:] if pos else seg)
            if m is None:
                break
            st, en = m.span()
            yield Match(m, p._names, base + pos, s)
            if p._anchored:
                break
            pos += en if en > st else st + 1


def _findall(p, s):
    out = []
    for m in _find(p, s):
        g = m._m.groups()
        if not g:
            out.append(m._m.group(0))
        elif len(g) == 1:
            out.append("" if g[0] is None else g[0])
        else:
            out.append(tuple("" if x is None else x for x in g))
    return out


def _split(p, s, maxsplit):
    out = []
    last = 0
    k = 0
    for m in _find(p, s):
        if maxsplit and k >= maxsplit:
            break
        st, en = m.span()
        out.append(s[last:st])
        for g in m._m.groups():
            out.append(g)
        last = en
        k += 1
    out.append(s[last:])
    return out


_TEMPLATE_ESC = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "f": "\f",
    "v": "\v",
    "a": "\a",
    "b": "\b",
    "0": "\0",
    "\\": "\\",
}


def _expand(m, t):
    if "\\" not in t:
        return t
    out = []
    i = 0
    n = len(t)
    while i < n:
        c = t[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        i += 1
        c = t[i : i + 1]
        if c == "g" and t[i + 1 : i + 2] == "<":
            j = t.find(">", i)
            if j < 0:
                raise error("unterminated group name")
            k = t[i + 2 : j]
            v = m.group(int(k) if k.isdigit() else k)
            out.append("" if v is None else v)
            i = j + 1
        elif c and c in "123456789":
            j = i
            while j < n and t[j].isdigit() and j - i < 2:
                j += 1
            v = m.group(int(t[i:j]))
            out.append("" if v is None else v)
            i = j
        else:
            out.append(_TEMPLATE_ESC.get(c, c))
            i += 1
    return "".join(out)


def _subn(p, repl, s, count):
    fn = repl if callable(repl) else None
    out = []
    last = 0
    n = 0
    prev = -1
    for m in _find(p, s):
        st, en = m.span()
        if st == en and st == prev:
            continue  # CPython skips an empty match abutting the previous one
        out.append(s[last:st])
        out.append(fn(m) if fn else _expand(m, repl))
        last = en
        prev = en
        n += 1
        if count and n >= count:
            break
    out.append(s[last:])
    return ("".join(out), n)


_cache = {}


def compile(pattern, flags=0):
    if isinstance(pattern, Pattern):
        return pattern
    key = pattern + "\x00" + str(flags)
    p = _cache.get(key)
    if p is None:
        if len(_cache) > 24:
            _cache.clear()
        p = Pattern(pattern, flags)
        _cache[key] = p
    return p


def search(pattern, string, flags=0):
    return compile(pattern, flags).search(string)


def match(pattern, string, flags=0):
    return compile(pattern, flags).match(string)


def fullmatch(pattern, string, flags=0):
    return compile(pattern, flags).fullmatch(string)


def findall(pattern, string, flags=0):
    return _findall(compile(pattern, flags), string)


def finditer(pattern, string, flags=0):
    return _find(compile(pattern, flags), string)


def split(pattern, string, maxsplit=0, flags=0):
    return _split(compile(pattern, flags), string, maxsplit)


def sub(pattern, repl, string, count=0, flags=0):
    return _subn(compile(pattern, flags), repl, string, count)[0]


def subn(pattern, repl, string, count=0, flags=0):
    return _subn(compile(pattern, flags), repl, string, count)


_SPECIAL = "()[]{}?*+-|^$\\.&~# \t\n\r\v\f"


def escape(pattern):
    out = []
    for c in pattern:
        if c in _SPECIAL:
            out.append("\\")
        out.append(c)
    return "".join(out)


def purge():
    _cache.clear()
