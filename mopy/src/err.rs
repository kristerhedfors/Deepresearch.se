//! Errors, and the unsupported-feature contract that makes routing safe.
//!
//! mopy inherits pygram's contract verbatim (`docs/PYGRAM-SUBSET.md`):
//!
//!   exit 90, one line on **stderr**: `mopy: unsupported: <kind>: <detail>`
//!
//! 90 is clear of 0/1/2 (python's own), 126/127 (shell) and 128+n (signals), so
//! the dispatcher can branch on it unambiguously and retry with the next
//! interpreter. Two rules from the pygram experience carry over:
//!
//!   * The line goes to **stderr**. pygram once wrote tracebacks to stdout and
//!     poisoned every `… | wc -l` pipeline while the exit code looked right.
//!   * A program's OWN `NotImplementedError` must keep its traceback and exit 1.
//!     Only the runtime's own refusal takes 90.

use std::fmt;

pub const UNSUPPORTED_EXIT: i32 = 90;

#[derive(Debug, Clone)]
pub enum MopyError {
    /// A construct outside the subset. Safe to retry on another interpreter.
    Unsupported { kind: String, detail: String },
    /// A syntax error. CPython would also fail, so this is NOT routed onward
    /// as a capability gap — but it is reported the way CPython reports it.
    Syntax { line: u32, msg: String },
    /// A Python-level exception the program could have caught.
    Exc(Exc),
    /// `sys.exit(n)` / SystemExit.
    Exit(i32),
}

#[derive(Debug, Clone)]
pub struct Exc {
    pub kind: &'static str,
    pub msg: String,
}

impl MopyError {
    pub fn syntax(line: u32, msg: &str) -> Self {
        MopyError::Syntax {
            line,
            msg: msg.to_string(),
        }
    }
    pub fn exc(kind: &'static str, msg: impl Into<String>) -> Self {
        MopyError::Exc(Exc {
            kind,
            msg: msg.into(),
        })
    }
    pub fn is_unsupported(&self) -> bool {
        matches!(self, MopyError::Unsupported { .. })
    }
}

impl fmt::Display for MopyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MopyError::Unsupported { kind, detail } => {
                write!(f, "mopy: unsupported: {kind}: {detail}")
            }
            MopyError::Syntax { line, msg } => write!(f, "  line {line}\nSyntaxError: {msg}"),
            MopyError::Exc(e) => {
                if e.msg.is_empty() {
                    write!(f, "{}", e.kind)
                } else {
                    write!(f, "{}: {}", e.kind, e.msg)
                }
            }
            MopyError::Exit(n) => write!(f, "SystemExit: {n}"),
        }
    }
}

pub fn unsupported(kind: &str, detail: &str) -> MopyError {
    MopyError::Unsupported {
        kind: kind.to_string(),
        detail: detail.to_string(),
    }
}

pub type R<T> = Result<T, MopyError>;

pub fn type_err(msg: impl Into<String>) -> MopyError {
    MopyError::exc("TypeError", msg)
}
pub fn value_err(msg: impl Into<String>) -> MopyError {
    MopyError::exc("ValueError", msg)
}
pub fn name_err(name: &str) -> MopyError {
    MopyError::exc("NameError", format!("name '{name}' is not defined"))
}
pub fn index_err(msg: impl Into<String>) -> MopyError {
    MopyError::exc("IndexError", msg)
}
pub fn key_err(msg: impl Into<String>) -> MopyError {
    MopyError::exc("KeyError", msg)
}
pub fn attr_err(msg: impl Into<String>) -> MopyError {
    MopyError::exc("AttributeError", msg)
}
pub fn zero_div(msg: &str) -> MopyError {
    MopyError::exc("ZeroDivisionError", msg)
}
