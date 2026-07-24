// @ts-check
// SOURCE PEEK — the pure core behind tappable file references in
// introspection answers (feedback #10, 2026-07-24). Answers in developer
// mode cite the site's own files constantly (`src/pipeline.js`,
// `agent-spec-core.js:34-45`); the view module (source-peek.js) turns those
// inline-code mentions into tap targets that open the file from the
// committed source snapshot in a popover — syntax highlighted, markdown
// rendered. This module is the I/O-free half (the bash-core.js pattern):
// reference parsing, snapshot path resolution, language classification, and
// a small dependency-free tokenizer. Node-tested in source-peek-core.test.js.
//
// The tokenizer returns TOKENS ({ t, c }), never HTML — the view builds DOM
// spans with textContent, so nothing here needs escaping and nothing can
// inject markup. Class ids: "c" comment, "s" string, "k" keyword, "n" number,
// "" plain.

// Extensions a reference must carry to read as one of this repo's files.
// A closed list on purpose: with `\w+` any inline-code `example.com` or
// `v1.5` would light up as a tap target and dead-end in a "not found"
// popover. Everything the snapshot bundles is covered (bundle-source.mjs
// walks git-tracked TEXT files).
const KNOWN_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "toml", "yml", "yaml",
  "html", "css", "svg", "xml", "txt", "sh", "sql", "py",
]);

// `path`, `path:12`, `path:12-34` (hyphen or en/em dash — answers write both).
// Segments allow the repo's real name characters (@, ., -, _); the extension
// is validated against KNOWN_EXTENSIONS after the match.
const REF_RE =
  /^(?:\.\/|\/)?((?:[\w@.-]+\/)*[\w@.-]+\.([A-Za-z][A-Za-z0-9]{0,7}))(?::(\d{1,5})(?:\s*[-–—]\s*(\d{1,5}))?)?$/;

export const MAX_REF_CHARS = 160;

/**
 * Parses one inline-code text as a repo file reference.
 * @param {unknown} text
 * @returns {{ path: string, start: number|null, end: number|null } | null}
 */
export function parseSourceRef(text) {
  const s = String(text || "").trim();
  if (!s || s.length > MAX_REF_CHARS) return null;
  if (s.includes("..") || s.includes("//") || /\s/.test(s)) return null;
  const m = REF_RE.exec(s);
  if (!m) return null;
  if (!KNOWN_EXTENSIONS.has(m[2].toLowerCase())) return null;
  const start = m[3] ? Number(m[3]) : null;
  let end = m[4] ? Number(m[4]) : start;
  if (start !== null && end !== null && end < start) end = start;
  return { path: m[1], start, end };
}

/**
 * Resolves a parsed reference path against the snapshot's file list. Returns
 * every match, best first: an exact path, else a case-insensitive exact, else
 * path-suffix matches (`js/foo.js`, bare `foo.js`), else basename matches
 * (answers sometimes misplace the directory). One entry means "open it";
 * several mean "let the user pick"; none, "not in the snapshot".
 * @param {string[]} paths every snapshot path (snapshot order)
 * @param {string} refPath
 * @returns {string[]}
 */
export function resolveSourcePath(paths, refPath) {
  const all = Array.isArray(paths) ? paths : [];
  const ref = String(refPath || "");
  if (!ref) return [];
  const lower = ref.toLowerCase();
  if (all.includes(ref)) return [ref];
  const ciExact = all.filter((p) => p.toLowerCase() === lower);
  if (ciExact.length) return ciExact;
  const bySuffix = all.filter((p) => p.toLowerCase().endsWith("/" + lower));
  if (bySuffix.length) return bySuffix;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return all.filter((p) => {
    const pl = p.toLowerCase();
    return pl === base || pl.endsWith("/" + base);
  });
}

/**
 * The highlight language for a snapshot path.
 * @param {string} path
 * @returns {"js"|"json"|"md"|"css"|"html"|"hash"|"text"}
 */
export function languageForPath(path) {
  const p = String(path || "").toLowerCase();
  const ext = p.slice(p.lastIndexOf(".") + 1);
  if (["js", "mjs", "cjs", "ts", "tsx", "jsx"].includes(ext)) return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  if (ext === "css") return "css";
  if (["html", "svg", "xml"].includes(ext)) return "html";
  if (["toml", "yml", "yaml", "sh", "py"].includes(ext)) return "hash";
  return "text";
}

/** @param {string} path @returns {boolean} rendered-markdown candidate */
export function isMarkdownPath(path) {
  return languageForPath(path) === "md";
}

const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "delete", "do", "else", "export", "extends", "false", "finally",
  "for", "from", "function", "get", "if", "import", "in", "instanceof", "let",
  "new", "null", "of", "return", "set", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
  "yield",
]);

// One master regex per language, alternatives in priority order; text between
// matches stays plain. No lookbehind anywhere — older iOS Safari lacks it.
/** @type {Record<string, RegExp>} */
const LANG_RES = {
  js: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^\\`])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\b\d[\w.]*|\b[A-Za-z_$][\w$]*/g,
  json: /"(?:\\.|[^"\\\n])*"?|-?\b\d[\w.+-]*|\b(?:true|false|null)\b/g,
  css: /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n]*"?|'[^'\n]*'?|@[\w-]+|#[0-9a-fA-F]{3,8}\b|\b\d[\w.%]*/g,
  html: /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][^<>]*>?/g,
  hash: /"(?:\\.|[^"\\\n])*"?|'[^'\n]*'?|#[^\n]*|\b\d[\w.]*/g,
};

/** @param {string} lang @param {string} tok @returns {string} */
function classify(lang, tok) {
  const c0 = tok[0];
  if (lang === "js") {
    if (c0 === "/" && (tok[1] === "/" || tok[1] === "*")) return "c";
    if (c0 === "`" || c0 === '"' || c0 === "'") return "s";
    if (c0 >= "0" && c0 <= "9") return "n";
    return JS_KEYWORDS.has(tok) ? "k" : "";
  }
  if (lang === "json") {
    if (c0 === '"') return "s";
    if (tok === "true" || tok === "false" || tok === "null") return "k";
    return "n";
  }
  if (lang === "css") {
    if (c0 === "/") return "c";
    if (c0 === '"' || c0 === "'") return "s";
    if (c0 === "@") return "k";
    return "n";
  }
  if (lang === "html") return c0 === "<" && tok[1] === "!" ? "c" : "k";
  // hash family
  if (c0 === "#") return "c";
  if (c0 === '"' || c0 === "'") return "s";
  return "n";
}

/**
 * Tokenizes source text for highlighting. Markdown gets a line-based pass
 * (headings, fence markers); unknown languages come back as one plain token.
 * @param {string} text
 * @param {string} lang a languageForPath value
 * @returns {Array<{ t: string, c: string }>} tokens covering the full text
 */
export function tokenizeSource(text, lang) {
  const src = String(text ?? "");
  if (!src) return [];
  if (lang === "md") {
    return src.split("\n").flatMap((line, i) => {
      /** @type {Array<{ t: string, c: string }>} */
      const out = i > 0 ? [{ t: "\n", c: "" }] : [];
      if (/^#{1,6}\s/.test(line)) out.push({ t: line, c: "k" });
      else if (/^\s{0,3}```/.test(line)) out.push({ t: line, c: "c" });
      else if (line) out.push({ t: line, c: "" });
      return out;
    });
  }
  const re = LANG_RES[lang];
  if (!re) return [{ t: src, c: "" }];
  /** @type {Array<{ t: string, c: string }>} */
  const tokens = [];
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) tokens.push({ t: src.slice(last, m.index), c: "" });
    tokens.push({ t: m[0], c: classify(lang, m[0]) });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1; // safety: never loop in place
  }
  if (last < src.length) tokens.push({ t: src.slice(last), c: "" });
  return tokens;
}

/**
 * Splits a token stream into per-line span lists (a token spanning a newline
 * is divided, its class carried over) — exactly what the view renders, one
 * element per line so a `:line` reference can scroll to and mark its range.
 * @param {Array<{ t: string, c: string }>} tokens
 * @returns {Array<Array<{ t: string, c: string }>>}
 */
export function tokenLines(tokens) {
  /** @type {Array<Array<{ t: string, c: string }>>} */
  const lines = [[]];
  for (const tok of Array.isArray(tokens) ? tokens : []) {
    const parts = String(tok.t).split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ t: parts[i], c: tok.c });
    }
  }
  return lines;
}

/**
 * Convenience: text → per-line highlight spans.
 * @param {string} text @param {string} lang
 * @returns {Array<Array<{ t: string, c: string }>>}
 */
export function highlightLines(text, lang) {
  return tokenLines(tokenizeSource(text, lang));
}
