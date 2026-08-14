# pygram frozen shim: csv (excel dialect only: comma, '"' quoting,
# QUOTE_MINIMAL, \r\n terminator). See pygram/lib/README.md.

QUOTE_MINIMAL = 0
QUOTE_ALL = 1
QUOTE_NONNUMERIC = 2
QUOTE_NONE = 3


# Keywords CPython's csv accepts that this shim does NOT implement, each with
# the value its behaviour already matches. A caller passing the matching value
# is asking for what it already does, so that is allowed; any other value is
# asking for behaviour that is not here.
#
# Silently swallowing these in **kw is the bug this table exists to close:
# csv.writer(f, quoting=csv.QUOTE_ALL) used to write a,b where CPython writes
# "a","b" — at exit 0, with nothing on stderr.
_KW_UNIMPLEMENTED = (
    ("quoting", QUOTE_MINIMAL),
    ("dialect", "excel"),
    ("doublequote", True),
    ("skipinitialspace", False),
    ("strict", False),
    ("escapechar", None),
)


def _check_kw(kw):
    for name, matches_our_behaviour in _KW_UNIMPLEMENTED:
        if name in kw and kw[name] != matches_our_behaviour:
            raise NotImplementedError(
                "pygram: unsupported: argument: csv(" + name + ")"
            )



class Error(Exception):
    pass


def _parse(s, delim, quote):
    """Parse one record. Returns (row, complete) — incomplete means an open
    quote, i.e. the record spans more input."""
    row = []
    field = []
    inq = False
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if inq:
            if c == quote:
                if s[i + 1 : i + 2] == quote:
                    field.append(quote)
                    i += 2
                    continue
                inq = False
                i += 1
                continue
            field.append(c)
            i += 1
            continue
        if c == quote and not field:
            inq = True
            i += 1
            continue
        if c == delim:
            row.append("".join(field))
            field = []
            i += 1
            continue
        if c == "\r" or c == "\n":
            if not row and not field:
                return [], True  # a blank line is an empty record in CPython
            row.append("".join(field))
            return row, True
        field.append(c)
        i += 1
    if inq:
        return None, False
    row.append("".join(field))
    return row, True


def reader(f, delimiter=",", quotechar='"', **kw):
    _check_kw(kw)
    buf = ""
    for line in f:
        buf += line
        row, done = _parse(buf, delimiter, quotechar)
        if done:
            yield row
            buf = ""
    if buf:
        row, done = _parse(buf, delimiter, quotechar)
        if row:
            yield row


class DictReader:
    def __init__(self, f, fieldnames=None, restval=None, **kw):
        self._r = reader(f, **kw)
        self.fieldnames = fieldnames
        self.restval = restval

    def __iter__(self):
        return self

    def __next__(self):
        if self.fieldnames is None:
            self.fieldnames = next(self._r)
        row = next(self._r)
        while row == []:
            row = next(self._r)
        d = {}
        for i in range(len(self.fieldnames)):
            d[self.fieldnames[i]] = row[i] if i < len(row) else self.restval
        return d


class _Writer:
    def __init__(self, f, delimiter=",", quotechar='"', lineterminator="\r\n", **kw):
        _check_kw(kw)
        self._f = f
        self.delimiter = delimiter
        self.quotechar = quotechar
        self.lineterminator = lineterminator

    def _field(self, v):
        if v is None:
            return ""
        s = v if isinstance(v, str) else str(v)
        if (
            self.delimiter in s
            or self.quotechar in s
            or "\r" in s
            or "\n" in s
        ):
            return (
                self.quotechar
                + s.replace(self.quotechar, self.quotechar * 2)
                + self.quotechar
            )
        return s

    def writerow(self, row):
        line = self.delimiter.join(self._field(v) for v in row) + self.lineterminator
        self._f.write(line)
        return len(line)

    def writerows(self, rows):
        for r in rows:
            self.writerow(r)


def writer(f, **kw):
    return _Writer(f, **kw)


class DictWriter:
    def __init__(self, f, fieldnames, restval="", **kw):
        self.fieldnames = fieldnames
        self.restval = restval
        self._w = _Writer(f, **kw)

    def writeheader(self):
        self._w.writerow(self.fieldnames)

    def writerow(self, d):
        self._w.writerow([d.get(k, self.restval) for k in self.fieldnames])

    def writerows(self, rows):
        for r in rows:
            self.writerow(r)
