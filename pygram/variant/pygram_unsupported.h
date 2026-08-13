/*
 * pygram — the unsupported-module half of the fallback contract.
 *
 * docs/PYGRAM-SUBSET.md §7 rule 4 draws a line that matters more than it looks:
 *
 *   - A module CPython itself does not have in this image (PIL, numpy) must
 *     raise ModuleNotFoundError and exit 1, exactly as CPython does. That is a
 *     program that RAN CORRECTLY and found its dependency missing.
 *
 *   - A module that exists in CPython but not in pygram (subprocess, argparse,
 *     zlib, csv) must exit 90 with one greppable stderr line. That is pygram
 *     being too small, and it is what lets an agent loop — or a shell wrapper —
 *     retry the same line with real python3 instead of rewriting the program.
 *
 * Collapsing those two into one exit code would make the retry undecidable, so
 * this header carries the only thing that can tell them apart: the list of
 * top-level module names CPython ships.
 *
 * The list is CPython 3.11's `sys.stdlib_module_names`, 217 names, packed as one
 * \0-separated blob (~1.6 KB of .rodata) rather than an array of pointers,
 * because on i386 the pointer array alone would cost half as much again.
 *
 * Modules pygram DOES provide never reach this code: the import resolves and
 * nothing is raised. So the table needs no exclusions and no maintenance when
 * a frozen shim lands in pygram/lib.
 *
 * MIT, same as MicroPython.
 */

#ifndef PYGRAM_UNSUPPORTED_H
#define PYGRAM_UNSUPPORTED_H

#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// mp_obj_is_instance_type() lives here and py/builtinimport.c does not pull it
// in on its own; including it from this header rather than from the port patch
// keeps the patch to the two call sites.
#include "py/obj.h"
#include "py/objtype.h"
#include "py/runtime.h"

// CPython 3.11 sys.stdlib_module_names, minus the leading-underscore internals.
static const char pygram_cpython_stdlib[] =
    "abc\0aifc\0antigravity\0argparse\0array\0ast\0asynchat\0asyncio\0"
    "asyncore\0atexit\0audioop\0base64\0bdb\0binascii\0bisect\0builtins\0"
    "bz2\0cProfile\0calendar\0cgi\0cgitb\0chunk\0cmath\0cmd\0code\0codecs\0"
    "codeop\0collections\0colorsys\0compileall\0concurrent\0configparser\0"
    "contextlib\0contextvars\0copy\0copyreg\0crypt\0csv\0ctypes\0curses\0"
    "dataclasses\0datetime\0dbm\0decimal\0difflib\0dis\0distutils\0"
    "doctest\0email\0encodings\0ensurepip\0enum\0errno\0faulthandler\0"
    "fcntl\0filecmp\0fileinput\0fnmatch\0fractions\0ftplib\0functools\0gc\0"
    "genericpath\0getopt\0getpass\0gettext\0glob\0graphlib\0grp\0gzip\0"
    "hashlib\0heapq\0hmac\0html\0http\0idlelib\0imaplib\0imghdr\0imp\0"
    "importlib\0inspect\0io\0ipaddress\0itertools\0json\0keyword\0lib2to3\0"
    "linecache\0locale\0logging\0lzma\0mailbox\0mailcap\0marshal\0math\0"
    "mimetypes\0mmap\0modulefinder\0msilib\0msvcrt\0multiprocessing\0"
    "netrc\0nis\0nntplib\0nt\0ntpath\0nturl2path\0numbers\0opcode\0"
    "operator\0optparse\0os\0ossaudiodev\0pathlib\0pdb\0pickle\0"
    "pickletools\0pipes\0pkgutil\0platform\0plistlib\0poplib\0posix\0"
    "posixpath\0pprint\0profile\0pstats\0pty\0pwd\0py_compile\0pyclbr\0"
    "pydoc\0pydoc_data\0pyexpat\0queue\0quopri\0random\0re\0readline\0"
    "reprlib\0resource\0rlcompleter\0runpy\0sched\0secrets\0select\0"
    "selectors\0shelve\0shlex\0shutil\0signal\0site\0smtpd\0smtplib\0"
    "sndhdr\0socket\0socketserver\0spwd\0sqlite3\0sre_compile\0"
    "sre_constants\0sre_parse\0ssl\0stat\0statistics\0string\0stringprep\0"
    "struct\0subprocess\0sunau\0symtable\0sys\0sysconfig\0syslog\0"
    "tabnanny\0tarfile\0telnetlib\0tempfile\0termios\0textwrap\0this\0"
    "threading\0time\0timeit\0tkinter\0token\0tokenize\0tomllib\0trace\0"
    "traceback\0tracemalloc\0tty\0turtle\0turtledemo\0types\0typing\0"
    "unicodedata\0unittest\0urllib\0uu\0uuid\0venv\0warnings\0wave\0"
    "weakref\0webbrowser\0winreg\0winsound\0wsgiref\0xdrlib\0xml\0xmlrpc\0"
    "zipapp\0zipfile\0zipimport\0zlib\0zoneinfo\0";

// Is `name` (a top-level module name, no dots) one CPython ships?
static inline bool pygram_is_cpython_stdlib(const char *name, size_t len) {
    for (const char *p = pygram_cpython_stdlib; *p; p += strlen(p) + 1) {
        if (strlen(p) == len && memcmp(p, name, len) == 0) {
            return true;
        }
    }
    return false;
}

/*
 * Write the one contract line and exit 90.
 *
 * Exiting from inside the VM rather than raising a catchable exception is
 * deliberate. The whole point of the 90 is that the CALLER — the shell, the
 * agent loop — sees it; a program that wrapped `import csv` in try/except
 * ImportError would not have taken that branch under CPython either, because
 * under CPython the import succeeds. Suppressing the signal to emulate a
 * branch CPython never takes would be the silent divergence §6 exists to
 * prevent.
 *
 * write(2) rather than mp_printf keeps this callable from anywhere in the VM.
 * stdout in the unix port is unbuffered (write(2) per chunk, see
 * ports/unix/unix_mphal.c), so exiting cannot lose output the program already
 * produced — which §7 rule 3 allows a runtime 90 to leave behind.
 */
static inline NORETURN void pygram_exit_unsupported(const char *kind, const char *a, const char *b) {
    char line[160];
    static const char prefix[] = "pygram: unsupported: ";
    size_t n = 0;
    const char *piece[5] = { prefix, kind, ": ", a, b };
    for (int i = 0; i < 5; i++) {
        if (piece[i] == NULL) {
            continue;
        }
        size_t l = strlen(piece[i]);
        if (l > sizeof(line) - n - 2) {
            l = sizeof(line) - n - 2;
        }
        memcpy(line + n, piece[i], l);
        n += l;
    }
    line[n++] = '\n';
    // One line, nothing else (§7 rule 5). A short write here would only ever
    // happen on a closed stderr, where there is nothing useful left to do.
    ssize_t ignored = write(STDERR_FILENO, line, n);
    (void)ignored;
    exit(PYGRAM_UNSUPPORTED_EXIT);
}

/*
 * Called from py/builtinimport.c at the two points where a failed import is
 * about to become an ImportError. If the module is one CPython has, this exits
 * 90; otherwise it returns and the normal ImportError is raised.
 *
 * The name reported is the full dotted path that failed to resolve
 * ("http.server"), while the table lookup uses its top-level package — so
 * `import os.path` is recognised as unsupported even though the table holds
 * only "os".
 */
static inline void pygram_check_unsupported_module(const char *name) {
    const char *dot = strchr(name, '.');
    size_t top = dot ? (size_t)(dot - name) : strlen(name);
    if (pygram_is_cpython_stdlib(name, top)) {
        pygram_exit_unsupported("module", name, NULL);
    }
}

/*
 * Called from py/runtime.c at the point where a failed attribute lookup is
 * about to become an AttributeError.
 *
 * Two of the three cases are pygram being too small rather than the program
 * being wrong, and §7 says so with `attribute: str.casefold` as its example:
 *
 *   - a missing attribute on a STDLIB MODULE (`re.findall`), and
 *   - a missing method on a BUILT-IN TYPE (`str.casefold`).
 *
 * The third — a missing attribute on a user-defined class — is an ordinary
 * program error and keeps CPython's exit 1. MP_TYPE_FLAG_INSTANCE_TYPE is what
 * separates them: it marks a type created by a `class` statement.
 *
 * KNOWN IMPRECISION, stated rather than hidden: pygram cannot tell a method
 * CPython has from a typo. `"x".casefold()` and `"x".casefld()` both report
 * unsupported, where CPython gives AttributeError and exit 1 for the second.
 * Closing that would mean carrying CPython's full attribute table for every
 * stdlib module and built-in type — tens of KB of .rodata against a 700 KB
 * budget — to improve the diagnosis of a typo. The cost of being wrong here is
 * bounded: the caller retries with real python3 and gets the accurate error.
 */
static inline void pygram_check_unsupported_attr(mp_obj_t base, qstr attr) {
    const char *attr_str = qstr_str(attr);
    // Dunders are protocol probes, not library surface: reporting
    // `attribute: str.__aiter__` would be noise, and several of them are
    // looked up speculatively by the runtime itself.
    if (attr_str[0] == '_') {
        return;
    }
    if (mp_obj_is_type(base, &mp_type_module)) {
        mp_obj_t dest[2];
        mp_load_method_maybe(base, MP_QSTR___name__, dest);
        if (dest[0] == MP_OBJ_NULL || !mp_obj_is_qstr(dest[0])) {
            return;
        }
        const char *mod = qstr_str(mp_obj_str_get_qstr(dest[0]));
        const char *dot = strchr(mod, '.');
        size_t top = dot ? (size_t)(dot - mod) : strlen(mod);
        if (!pygram_is_cpython_stdlib(mod, top)) {
            return;
        }
        char qualified[96];
        size_t l = strlen(mod);
        if (l > sizeof(qualified) - 2) {
            l = sizeof(qualified) - 2;
        }
        memcpy(qualified, mod, l);
        qualified[l] = '.';
        qualified[l + 1] = '\0';
        pygram_exit_unsupported("attribute", qualified, attr_str);
    }
    const mp_obj_type_t *type = mp_obj_get_type(base);
    if (type == NULL || mp_obj_is_instance_type(type) || mp_obj_is_type(base, &mp_type_type)) {
        return;
    }
    char qualified[96];
    const char *tname = qstr_str(type->name);
    size_t l = strlen(tname);
    if (l > sizeof(qualified) - 2) {
        l = sizeof(qualified) - 2;
    }
    memcpy(qualified, tname, l);
    qualified[l] = '.';
    qualified[l + 1] = '\0';
    pygram_exit_unsupported("attribute", qualified, attr_str);
}

#endif // PYGRAM_UNSUPPORTED_H
