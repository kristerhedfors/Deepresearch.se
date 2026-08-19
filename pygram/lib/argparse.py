# pygram frozen shim: argparse — the subset an agent's one-liner reaches for.
# See pygram/lib/README.md.
#
# ArgumentParser/add_argument/parse_args; positionals with every nargs form;
# long, short, --flag=value, bundled and `--`-terminated optionals; the six
# string actions; and the error paths (unrecognised argument, missing required,
# bad type=, bad choice) which write usage to stderr and exit 2 like CPython.
# _parse_known_args/_get_values/_parse_optional are CPython 3.11's, transcribed.
# Only _match_arguments_partial's regex is replaced — by the equivalent greedy
# assignment over the same per-nargs (min, max) bounds, since re1.5 cannot
# express that pattern and importing re here would cost bytes.
#
# Everything else is refused BY NAME through _u() (exit 90), never accepted and
# ignored: -h/--help (our layout is not CPython's, and a close-but-different
# help would MISMATCH on stdout), subparsers, argument groups, mutually
# exclusive groups, parse_known_args, set_defaults, custom action classes,
# nargs=REMAINDER, FileType, formatter classes, parents=, prefix_chars=,
# fromfile_prefix_chars=. Any other ArgumentParser attribute goes the same way
# through __getattr__.
import sys

SUPPRESS = "==SUPPRESS=="
OPTIONAL = "?"
ZERO_OR_MORE = "*"
ONE_OR_MORE = "+"
REMAINDER = "..."
PARSER = "A..."

_ACTS = ("store", "store_true", "store_false", "store_const", "append",
         "count", "help")
_KW = ("action", "nargs", "const", "default", "type", "choices", "required",
       "help", "metavar", "dest")


def _u(kind, what):
    raise NotImplementedError("pygram: unsupported: " + kind + ": " + what)


class ArgumentError(Exception):
    pass


class ArgumentTypeError(Exception):
    pass


class _Refused:
    def __init__(self, *a, **k):
        _u("attribute", "argparse." + type(self).__name__)


class Action(_Refused): pass
class FileType(_Refused): pass
class HelpFormatter(_Refused): pass
class RawTextHelpFormatter(HelpFormatter): pass
class RawDescriptionHelpFormatter(HelpFormatter): pass
class ArgumentDefaultsHelpFormatter(HelpFormatter): pass
class MetavarTypeHelpFormatter(HelpFormatter): pass
class BooleanOptionalAction(_Refused): pass


def _isident(s):
    if not s or s[0].isdigit():
        return False
    for c in s:
        if not (c.isalpha() or c.isdigit() or c == "_"):
            return False
    return True


def _isneg(s):  # CPython's _negative_number_matcher: ^-\d+$|^-\d*\.\d+$
    if len(s) < 2 or s[0] != "-":
        return False
    i, sep, f = s[1:].partition(".")
    if not sep:
        return i.isdigit()
    return f.isdigit() and (not i or i.isdigit())


def _name(a):
    if a.option_strings:
        return "/".join(a.option_strings)
    return a.dest if a.metavar is None else a.metavar


def _bounds(n):  # 'A' tokens this nargs may take: (min, max); -1 = unbounded
    if n is None:
        return (1, 1)
    if n == OPTIONAL:
        return (0, 1)
    if n == ZERO_OR_MORE:
        return (0, -1)
    if n == ONE_OR_MORE:
        return (1, -1)
    return (n, n)


# Namespace attribute ORDER, which its repr prints. MicroPython's INSTANCE map
# is an open-addressing hash map — unlike the Python-level dict it is not
# insertion ordered — so self.__dict__ cannot carry it. Holding the order in an
# instance attribute instead would add a key to __dict__/vars(), a worse
# divergence than keeping it out here.
_ORD = []


def _ord(ns):
    for e in _ORD:
        if e[0] is ns:
            return e[1]
    e = (ns, [])
    _ORD.append(e)
    return e[1]


class Namespace:
    def __init__(self, **kw):
        for k in kw:
            setattr(self, k, kw[k])

    def __setattr__(self, k, v):
        o = _ord(self)
        if k not in o:
            o.append(k)
        object.__setattr__(self, k, v)

    def __eq__(self, other):
        return isinstance(other, Namespace) and self.__dict__ == other.__dict__

    def __contains__(self, k):
        return hasattr(self, k)

    def __repr__(self):
        p, star = [], {}
        for k in _ord(self):
            if not hasattr(self, k):
                continue
            if _isident(k):
                p.append("%s=%r" % (k, getattr(self, k)))
            else:
                star[k] = getattr(self, k)
        if star:
            p.append("**%r" % (star,))
        return "Namespace(" + ", ".join(p) + ")"


class _Act:
    def __init__(self, opts, dest, act, nargs, const, dflt, typ, choices,
                 req, hlp, metavar):
        self.option_strings = opts
        self.dest = dest
        self.act = act
        self.nargs = nargs
        self.const = const
        self.default = dflt
        self.type = typ
        self.choices = choices
        self.required = req
        self.help = hlp
        self.metavar = metavar

    def __call__(self, parser, ns, values, ostr=None):
        a = self.act
        if a == "store":
            setattr(ns, self.dest, values)
        elif a == "append":
            it = getattr(ns, self.dest, None)
            if it is None:
                it = []
            elif type(it) is list:
                it = it[:]          # CPython copies; never mutate the default
            else:
                _u("argument", "argparse.add_argument(action=append, default=)")
            it.append(values)
            setattr(ns, self.dest, it)
        elif a == "count":
            c = getattr(ns, self.dest, None)
            setattr(ns, self.dest, (0 if c is None else c) + 1)
        elif a == "help":
            _u("argument", "argparse(" + (ostr or "--help") + ")")
        else:
            setattr(ns, self.dest, self.const)


class ArgumentParser:
    def __init__(self, prog=None, description=None, add_help=True,
                 allow_abbrev=True, usage=None, **kw):
        for k in kw:
            _u("argument", "argparse.ArgumentParser(" + k + "=)")
        self.prog = sys.argv[0].rsplit("/", 1)[-1] if prog is None else prog
        self.description = description
        self.usage = usage
        self.allow_abbrev = allow_abbrev
        self._actions = []
        self._opts = {}
        self._neg = False
        if add_help:
            self.add_argument("-h", "--help", action="help", default=SUPPRESS,
                              help="show this help message and exit")

    def __getattr__(self, name):
        # add_subparsers, add_argument_group, parse_known_args, set_defaults,
        # print_help, … — refused by name rather than silently missing.
        if name[:2] == "__":
            raise AttributeError(name)
        _u("attribute", "argparse.ArgumentParser." + name)

    def add_argument(self, *args, **kw):
        for k in kw:
            if k not in _KW:
                _u("argument", "argparse.add_argument(" + k + "=)")
        act = kw.get("action", "store")
        if not isinstance(act, str):
            _u("argument", "argparse.add_argument(action=<class>)")
        if act not in _ACTS:
            _u("argument", "argparse.add_argument(action=" + act + ")")
        n = kw.get("nargs")
        if n == REMAINDER or n == PARSER:
            _u("argument", "argparse.add_argument(nargs=REMAINDER)")
        if n is not None and not isinstance(n, int) and \
                n not in (OPTIONAL, ZERO_OR_MORE, ONE_OR_MORE):
            _u("argument", "argparse.add_argument(nargs=%r)" % (n,))
        if isinstance(kw.get("metavar"), tuple):
            _u("argument", "argparse.add_argument(metavar=<tuple>)")

        if not args or (len(args) == 1 and args[0][0] != "-"):
            if args and "dest" in kw:
                raise ValueError("dest supplied twice for positional argument")
            if "required" in kw:
                raise TypeError("'required' is invalid for positionals")
            dest, opts = args[0], []
            req = n not in (OPTIONAL, ZERO_OR_MORE) or \
                (n == ZERO_OR_MORE and "default" not in kw)
        else:
            opts = list(args)
            for o in opts:
                if o[0] != "-":
                    raise ValueError("invalid option string %r" % o)
            dest = kw.get("dest")
            if dest is None:
                lg = [o for o in opts if len(o) > 1 and o[1] == "-"]
                d = (lg[0] if lg else opts[0]).lstrip("-")
                if not d:
                    raise ValueError("dest= is required for %r" % opts[0])
                dest = d.replace("-", "_")
            req = kw.get("required", False)

        const, dflt = kw.get("const"), kw.get("default")
        if act == "store_true":
            const, n = True, 0
            if "default" not in kw:
                dflt = False
        elif act == "store_false":
            const, n = False, 0
            if "default" not in kw:
                dflt = True
        elif act in ("store_const", "count", "help"):
            n = 0
        else:
            if n == 0:
                raise ValueError("nargs for store actions must be != 0")
            if const is not None and n != OPTIONAL:
                raise ValueError("nargs must be %r to supply const" % OPTIONAL)
        t = kw.get("type")
        if t is not None and not callable(t):
            raise ValueError("%r is not callable" % (t,))
        a = _Act(opts, dest, act, n, const, dflt, t, kw.get("choices"), req,
                 kw.get("help"), kw.get("metavar"))
        self._actions.append(a)
        for o in opts:
            if o in self._opts:
                raise ArgumentError("conflicting option string: " + o)
            self._opts[o] = a
            if _isneg(o):
                self._neg = True
        return a

    def _usage(self):
        if self.usage is not None:
            return "usage: " + self.usage.replace("%(prog)s", self.prog) + "\n"
        p = [self.prog]
        for a in self._actions:
            m = a.metavar or (a.dest.upper() if a.option_strings else a.dest)
            if a.option_strings:
                s = a.option_strings[0] + ("" if a.nargs == 0 else " " + m)
                p.append(s if a.required else "[" + s + "]")
            elif a.nargs == OPTIONAL:
                p.append("[" + m + "]")
            elif a.nargs == ZERO_OR_MORE:
                p.append("[" + m + " ...]")
            elif a.nargs == ONE_OR_MORE:
                p.append(m + " [" + m + " ...]")
            else:
                p.append(m)
        return "usage: " + " ".join(p) + "\n"

    def exit(self, status=0, message=None):
        if message:
            sys.stderr.write(message)
        sys.exit(status)

    def error(self, message):
        sys.stderr.write(self._usage())
        self.exit(2, "%s: error: %s\n" % (self.prog, message))

    def parse_args(self, args=None, namespace=None):
        ns, extras = self._parse(args, namespace)
        if extras:
            self.error("unrecognized arguments: " + " ".join(extras))
        return ns

    def _parse(self, args, ns):
        args = sys.argv[1:] if args is None else list(args)
        if ns is None:
            ns = Namespace()
        for a in self._actions:
            if a.dest is not SUPPRESS and a.default is not SUPPRESS \
                    and not hasattr(ns, a.dest):
                setattr(ns, a.dest, a.default)
        try:
            return self._known(args, ns)
        except ArgumentError as e:
            self.error(str(e))

    def _known(self, argv, ns):
        # 'O' where an option sits, 'A' for anything else, '-' for the first
        # `--`; everything after that `--` is forced to 'A'.
        oix, pat, i, n = {}, [], 0, len(argv)
        while i < n:
            if argv[i] == "--":
                pat.append("-")
                for i in range(i + 1, n):
                    pat.append("A")
                break
            t = self._parse_optional(argv[i])
            if t is None:
                pat.append("A")
            else:
                oix[i] = t
                pat.append("O")
            i += 1
        pat = "".join(pat)
        seen, extras = [], []

        def take(a, strs, ostr=None):
            if a not in seen:
                seen.append(a)
            v = self._get_values(a, strs)
            if v is not SUPPRESS:
                a(self, ns, v, ostr)

        pos = [a for a in self._actions if not a.option_strings]
        start = 0
        maxo = max(oix) if oix else -1
        while start <= maxo:
            nxt = min([k for k in oix if k >= start])
            if start != nxt:
                end = self._eat_pos(pos, argv, pat, start, take)
                if end > start:
                    start = end
                    continue
                start = end
            if start not in oix:
                extras.extend(argv[start:nxt])
                start = nxt
            start = self._eat_opt(oix, argv, pat, start, take, extras)
        extras.extend(argv[self._eat_pos(pos, argv, pat, start, take):])

        missing = []
        for a in self._actions:
            if a in seen:
                continue
            if a.required:
                missing.append(_name(a))
            elif a.default is not None and isinstance(a.default, str) \
                    and hasattr(ns, a.dest) and a.default is getattr(ns, a.dest):
                setattr(ns, a.dest, self._get_value(a, a.default))
        if missing:
            self.error("the following arguments are required: " +
                       ", ".join(missing))
        return ns, extras

    def _parse_optional(self, s):
        if not s or s[0] != "-":
            return None
        if s in self._opts:
            return (self._opts[s], s, None, None)
        if len(s) == 1:
            return None
        o, sep, ea = s.partition("=")
        if sep and o in self._opts:
            return (self._opts[o], o, sep, ea)
        tups = self._opt_tuples(s)
        if len(tups) > 1:
            self.error("ambiguous option: %s could match %s"
                       % (s, ", ".join([t[1] for t in tups])))
        elif len(tups) == 1:
            return tups[0]
        if _isneg(s) and not self._neg:
            return None
        if " " in s:
            return None
        return (None, s, None, None)

    def _opt_tuples(self, s):
        r = []
        if s[1] == "-":
            if self.allow_abbrev:
                pre, sep, ea = s.partition("=")
                if not sep:
                    sep = ea = None
                for o in self._opts:
                    if o.startswith(pre):
                        r.append((self._opts[o], o, sep, ea))
        else:
            for o in self._opts:
                if o == s[:2]:
                    r.append((self._opts[o], o, "", s[2:]))
                elif o.startswith(s):
                    r.append((self._opts[o], o, None, None))
        return r

    def _match_opt(self, a, pat):
        mn, mx = _bounds(a.nargs)
        k = 0
        while k < len(pat) and pat[k] == "A" and (mx < 0 or k < mx):
            k += 1
        if k < mn:
            raise ArgumentError("argument %s: expected %s argument(s)"
                                % (_name(a), mn))
        return k

    def _eat_opt(self, oix, argv, pat, start, take, extras):
        a, ostr, sep, ea = oix[start]
        tuples = []
        while True:
            if a is None:
                extras.append(argv[start])
                return start + 1
            if ea is not None:
                c = self._match_opt(a, "A")
                if c == 0 and ostr[1] != "-" and ea != "":
                    # -xyz is -x -y -z while the leading ones take no argument
                    if sep or ea[0] == "-":
                        raise ArgumentError("ignored explicit argument %r" % ea)
                    ch = ostr[0]
                    tuples.append((a, [], ostr))
                    ostr = ch + ea[0]
                    if ostr not in self._opts:
                        extras.append(ch + ea)
                        stop = start + 1
                        break
                    a, ea = self._opts[ostr], ea[1:]
                    if not ea:
                        sep = ea = None
                    elif ea[0] == "=":
                        sep, ea = "=", ea[1:]
                    else:
                        sep = ""
                elif c == 1:
                    stop = start + 1
                    tuples.append((a, [ea], ostr))
                    break
                else:
                    raise ArgumentError("ignored explicit argument %r" % ea)
            else:
                s2 = start + 1
                stop = s2 + self._match_opt(a, pat[s2:])
                tuples.append((a, argv[s2:stop], ostr))
                break
        for t in tuples:
            take(t[0], t[1], t[2])
        return stop

    def _eat_pos(self, pos, argv, pat, start, take):
        counts = self._match_partial(pos, pat[start:])
        for j in range(len(counts)):
            take(pos[j], argv[start:start + counts[j]])
            start += counts[j]
        del pos[:len(counts)]
        return start

    def _match_partial(self, actions, pat):
        # CPython concatenates one regex group per action and re.match()es it,
        # dropping trailing actions until something matches. Every group here
        # consumes a prefix of the leading A/- run, so greedy-with-backtracking
        # reduces to: give each action all it can take while reserving the
        # minimum the later ones still need.
        run = 0
        while run < len(pat) and pat[run] != "O":
            run += 1
        seg = pat[:run]
        avail = seg.count("A")
        for i in range(len(actions), 0, -1):
            bs = [_bounds(a.nargs) for a in actions[:i]]
            need = 0
            for b in bs:
                need += b[0]
            if need > avail:
                continue
            out, left, p = [], avail, 0
            for b in bs:
                need -= b[0]
                t = left - need
                if b[1] >= 0 and t > b[1]:
                    t = b[1]
                left -= t
                # A-count back to a token count, swallowing the `--` marker the
                # way the `-*` around CPython's group does
                q, got = p, 0
                while got <= t:
                    while q < run and seg[q] == "-":
                        q += 1
                    if got == t:
                        break
                    q += 1
                    got += 1
                out.append(q - p)
                p = q
            return out
        return []

    def _get_values(self, a, strs):
        if not a.option_strings:
            try:
                strs.remove("--")
            except ValueError:
                pass
        if not strs and a.nargs == OPTIONAL:
            v = a.const if a.option_strings else a.default
            if isinstance(v, str):
                v = self._get_value(a, v)
                self._check(a, v)
        elif not strs and a.nargs == ZERO_OR_MORE and not a.option_strings:
            v = strs if a.default is None else a.default
            self._check(a, v)
        elif len(strs) == 1 and a.nargs in (None, OPTIONAL):
            v = self._get_value(a, strs[0])
            self._check(a, v)
        else:
            v = [self._get_value(a, x) for x in strs]
            for x in v:
                self._check(a, x)
        return v

    def _get_value(self, a, s):
        if a.type is None:
            return s
        try:
            return a.type(s)
        except ArgumentTypeError as e:
            raise ArgumentError("argument %s: %s" % (_name(a), e))
        except (TypeError, ValueError):
            raise ArgumentError("argument %s: invalid %s value: %r"
                                % (_name(a), getattr(a.type, "__name__", "?"), s))

    def _check(self, a, v):
        if a.choices is not None and v not in a.choices:
            raise ArgumentError(
                "argument %s: invalid choice: %r (choose from %s)"
                % (_name(a), v, ", ".join([repr(c) for c in a.choices])))
