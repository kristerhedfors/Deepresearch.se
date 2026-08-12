// @ts-check
// The end-to-end test of a GENERATED APP — the thing that decides whether an
// Agent Studio capture is worth keeping.
//
// Owner directive (2026-08-11): "When apps are created, also browse to the app
// and use it! Make sure llm api keys are not visually revealed if submitted.
// Only keep those app studio creation videos that also pass end2end test of the
// generated app."
//
// Two halves, split the way the rest of this pipeline is split:
//
//   exerciseApp(page, url, opts) -> observations   IMPURE. Playwright. Runs
//     INSIDE the capture while the recorder is rolling, so everything it does
//     is on camera: it opens the published /app/<slug>/, types a fake key into
//     every key-ish field, asks the app something and presses send.
//
//   gradeApp(observations) -> { pass, checks, failures }   PURE. Seven checks
//     with stable ids, unit-tested. This is what the gate reads.
//
// THE SEVENTH CHECK, AND WHY IT EXISTS (owner directive, 2026-08-12, capture
// #CAP-22). The first six certified a dead app as working. #CAP-22's stored
// verdict is `pass: true` with all six green — including
// `app_interactive: "typed into textarea#input and pressed button#send"` —
// while the clip's own final frame shows the published app answering its
// visitor "Error: could not get a response." `app_interactive` typed and
// clicked and NEVER ASKED WHETHER A REPLY CAME BACK, so pressing a button that
// leads nowhere was a pass. `app_answered` is that missing assertion: after
// send, the page must actually GAIN a reply, and that reply must not be an
// error message.
//
// WHY THE HALVES ARE SPLIT. The interesting judgements ("is that field masked",
// "is a 401 a failure") are decisions, not browser work, and a decision that
// can only be exercised by launching Chromium against a live deploy is a
// decision nobody re-checks. gradeApp is a function of a JSON object.
//
// THE SENTINEL RULE (safety, non-negotiable). The key typed into the app is a
// FAKE constant — SENTINEL_KEY — and there is deliberately NO code path in this
// module that reads a key out of the environment, a file or an option. Two
// reasons. It is typed while RECORDING, so if the field is not masked the value
// is in the video, which is exactly the failure being tested for. And it is
// sent to a real provider endpoint, which will reject it. A real key must never
// be typed into a recording under any circumstance.
//
// Consequently a 401/403/429 or a failed fetch from a provider is the EXPECTED
// outcome and must not fail the run — see isProviderNoise, which is applied to
// console AND page errors.
//
// WHERE THE APP RUNS. `/app/<slug>/` is served with
// `Content-Security-Policy: sandbox allow-scripts …` and no `allow-same-origin`
// (src/build-pub.js), so the document sits in an OPAQUE origin: `localStorage`,
// `sessionStorage` and `document.cookie` all throw SecurityError there rather
// than returning empty. Every probe is therefore individually caught, and a
// storage that cannot be read is recorded as "unavailable" — which is the
// strongest possible form of "the key was not persisted", not a missing
// measurement.
//
// NEVER THROWS. exerciseApp is total: every step is caught and becomes an
// observation. It runs in the middle of a recording that is otherwise fine, and
// an exception here would cost the whole clip (invariant 2 — a helper phase
// degrades, it does not break the request).
//
// This module imports NOTHING. Its unit tests run under the root `npm test` on
// a checkout where `cd tests && npm install` has never happened, so it must not
// pull in `@playwright/test` — the `page` is passed in instead.

/**
 * The fake key typed into every generated app. Findable on purpose (a single
 * distinctive token the reveal scan can search the whole page for) and harmless
 * on purpose (no provider will ever accept it).
 *
 * Do not parameterise this. An option that could carry a real key is a way to
 * put a real key in a video.
 */
// DELIBERATELY SHORT. `scripts/scan-secrets` (the pre-commit/pre-push hook)
// matches `sk-[A-Za-z0-9_-]{24,}`, so a longer sentinel is a credential-shaped
// literal and BLOCKS THE COMMIT — which is the hook working correctly, since
// it cannot know this one is fake. Twenty-one characters after `sk-` stays
// under that rule while keeping the `sk-` prefix the app kit detects OpenAI by
// (`/^sk-(?!ant-)/`, prefix only, no length requirement). If you lengthen this,
// the hook will stop you; shorten or rename it instead of passing --no-verify.
export const SENTINEL_KEY = "sk-FAKE-CAPTURE-SENTINEL";

/** The seven checks, in the order they are reported. Stable ids — a gate keys on them. */
export const CHECK_IDS = [
  "app_loads",
  "no_page_errors",
  "key_field_masked",
  "key_not_revealed",
  "key_not_persisted",
  "app_interactive",
  "app_answered",
];

/**
 * How much NEW text (with the prompt we typed subtracted) counts as the app
 * having replied. Low on purpose: a one-line answer is still an answer, and the
 * sharp half of `app_answered` is the error-string test below, not this.
 */
export const MIN_REPLY_CHARS = 20;

/**
 * Error-shaped things a generated app writes where its answer should be.
 *
 * DUPLICATED, deliberately and narrowly. The full bilingual registry is
 * `scripts/capture-guard.mjs`'s FAILURE_SIGNS, and this module may not import
 * it: app-e2e.mjs is contractually import-free so the root `npm test` can load
 * it on a checkout where `cd tests && npm install` never happened. So the four
 * shapes actually observed in published apps live here too, and
 * `scripts/capture-guard.test.mjs` cross-checks the two lists against the same
 * verbatim strings so they cannot drift apart in silence.
 *
 * EN and SV in matched pairs (CLAUDE.md invariant 6). The Swedish patterns
 * avoid `\b`, which treats å/ä/ö as non-word characters.
 */
export const REPLY_ERROR_PATTERNS = [
  // "Error: could not get a response." — #CAP-22's final frame, verbatim.
  { id: "error_prefix", lang: "en", re: /^[\s*_#>`-]*error\b\s*[:!,—–-]/im },
  { id: "error_prefix", lang: "sv", re: /^[\s*_#>`-]*fel\s*[:!,—–-]/im },
  {
    id: "no_response_produced",
    lang: "en",
    re: /(?:could|can|would)\s*n(?:o|')?t\s+(?:get|give|generate|produce|provide|return|fetch|receive)[^.\n]{0,32}(?:response|answer|reply)|unable to (?:get|give|generate|produce|provide|return)[^.\n]{0,32}(?:response|answer|reply)/i,
  },
  {
    id: "no_response_produced",
    lang: "sv",
    re: /kunde inte (?:få|hämta|ge|generera|producera|leverera|lämna|returnera)[^.\n]{0,32}svar/i,
  },
  // "401 — You didn't provide an API key…" — #CAP-21's final frame, on an app
  // whose key field was visibly filled.
  {
    id: "api_key_missing",
    lang: "en",
    re: /(?:did\s*n(?:o|')?t|does\s*n(?:o|')?t|have\s*n(?:o|')?t|never)\s+provide[sd]?\s+(?:an?\s+|your\s+)?api[\s_-]?key|api[\s_-]?key\s+(?:is\s+)?(?:missing|required|not (?:set|provided|configured|stored|found))/i,
  },
  {
    id: "api_key_missing",
    lang: "sv",
    re: /(?:angav|gav|skickade)\s+(?:ingen|inte någon)\s+api[\s_-]?nyckel|api[\s_-]?nyckel(?:n|en)?\s+(?:saknas|krävs)/i,
  },
  // The app kit's own hosted-mode failure states.
  {
    id: "hosted_access_unavailable",
    lang: "en",
    re: /hosted model access is unavailable|published without a live grant|hosted allowance is used up/i,
  },
  {
    id: "hosted_access_unavailable",
    lang: "sv",
    re: /värdbaserade modellåtkomst är inte tillgänglig|publicerades utan ett aktivt tillstånd|värdbaserade kvot är slut/i,
  },
];

/**
 * Does this look like an error where the app's reply should be? Returns the
 * matching sign's id, or null. PURE.
 * @param {any} value
 * @returns {string | null}
 */
export function replyLooksBroken(value) {
  const s = text(value);
  if (!s.trim()) return null;
  for (const sign of REPLY_ERROR_PATTERNS) {
    if (sign.re.test(s)) return sign.id;
  }
  return null;
}

/**
 * The text a send ADDED to the page: the tail after the part that was already
 * there, or the whole thing when the app re-rendered instead of appending.
 * @param {any} before
 * @param {any} after
 * @returns {string}
 */
export function addedText(before, after) {
  const b = text(before);
  const a = text(after);
  if (b && a.startsWith(b)) return a.slice(b.length);
  return a;
}

/**
 * What is left of a reply once the question we typed into the app is taken back
 * out. An app that echoes the prompt into its transcript and then answers
 * nothing has "grown" by the length of the prompt, which is not a reply.
 * @param {any} added
 * @param {any} prompt
 * @returns {string}
 */
export function replyBody(added, prompt) {
  const p = text(prompt).trim();
  let s = text(added);
  if (p) s = s.split(p).join(" ");
  return s.replace(/\s+/g, " ").trim();
}

/** What exerciseApp asks the app, when it finds something to type into. */
export const DEFAULT_PROMPT = "Hello! Give me one short sentence about the sea.";

/** Defaults for the exercise. All of them are time, and all are overridable. */
export const EXERCISE_DEFAULTS = {
  /** per Playwright action */
  timeout: 15_000,
  /** the initial navigation */
  navTimeout: 30_000,
  /** after load, before anything is measured */
  settleMs: 1_200,
  /** after the sentinel is typed — the kit fetches a model list and 401s */
  afterKeyMs: 2_500,
  /** after send is pressed — the answer request goes out and fails */
  afterSendMs: 4_000,
};

// The marker attributes the page-side scans stamp on the elements they find, so
// Node can address the same element again without re-running the heuristics.
const KEY_MARK = "data-dre2e-key";
const PROMPT_MARK = "data-dre2e-prompt";
const SEND_MARK = "data-dre2e-send";

// ---------------------------------------------------------------------------
// Provider / network noise — the sentinel's own 401
// ---------------------------------------------------------------------------

/** Hosts a generated app talks to. A message naming one is provider traffic. */
const PROVIDER_HOSTS =
  /(api\.openai\.com|api\.anthropic\.com|api\.berget\.ai|generativelanguage\.googleapis\.com|openrouter\.ai|api\.mistral\.ai|api\.groq\.com|api\.cohere\.(com|ai)|api\.deepseek\.com|api\.together\.(ai|xyz)|api-inference\.huggingface\.co|router\.huggingface\.co|api\.x\.ai|api\.perplexity\.ai|:11434|ollama)/i;

/**
 * THE CHECKER'S OWN NOISE — errors this module provokes, in every app, always.
 *
 * Held apart from the provider patterns below because these two groups are
 * justified by completely different things. This group is caused by the probe
 * itself and is therefore noise unconditionally. The provider group is noise
 * only because a FAKE KEY WAS TYPED, and that premise does not hold for a
 * hosted app (see isProviderNoise).
 */
const SANDBOX_NOISE = [
  // THE SANDBOX DENYING STORAGE. `/app/<slug>/` is served into an opaque
  // origin, so reading localStorage/sessionStorage/cookies throws a
  // SecurityError — and this checker's OWN key_not_persisted probe is what
  // provokes it. The probe catches its own throw (a denial is a pass, and a
  // stronger one than an empty store), but Chromium ALSO reports it on the
  // page-error channel, where it was landing as "the app threw".
  //
  // Without this, every generated app fails no_page_errors on an error the
  // checker caused. Observed on the first live run: two builds that touch no
  // storage anywhere in their source both failed with this exact message.
  /the document is sandboxed and lacks the '?allow-same-origin'? flag/i,
  /securityerror[^\n]{0,80}(localstorage|sessionstorage|cookie)/i,
  /(localstorage|sessionstorage)[^\n]{0,60}(denied|sandbox|not available|access is denied)/i,
];

/**
 * Message shapes that mean "the network said no", not "the app is broken".
 *
 * Deliberately generous. The cost of a false NEGATIVE here is one capture kept
 * that should have been reviewed by eye; the cost of a false POSITIVE is a good
 * recording thrown away because a fake key was correctly rejected — and that
 * failure mode would fire on EVERY run, which is how a gate gets switched off.
 *
 * That generosity is bought entirely by the sentinel. When no key is typed it
 * is unpaid for, and these same shapes are the app's real failure — which is
 * why isProviderNoise takes `sentinelTyped`.
 */
const NOISE_PATTERNS = [
  /failed to load resource/i,
  /the server responded with a status of/i,
  /net::err_/i,
  /\berr_(failed|aborted|connection|name_not_resolved|internet_disconnected|timed_out|cert)/i,
  /failed to fetch/i,
  /network\s?error/i,
  /^load failed$/i,
  /fetch failed/i,
  /\b(401|403|429)\b/,
  /\b(?:status|statuscode|http|code)\b[^\n]{0,24}\b[45]\d\d\b/i,
  /unauthor[iz]s?ed|forbidden|invalid[\s_-]*api[\s_-]*key|incorrect api key|authentication (failed|error)/i,
  /rate[\s_-]?limit|quota (exceeded|exhausted)|insufficient[_ ]quota/i,
  /cors|cross-origin|access-control-allow-origin|preflight/i,
  /refused to connect|violates the following content security policy/i,
  /aborterror|the operation was aborted|signal is aborted/i,
  // THE SANDBOX DENYING STORAGE. `/app/<slug>/` is served into an opaque
  // origin, so reading localStorage/sessionStorage/cookies throws a
  // SecurityError — and this checker's OWN key_not_persisted probe is what
  // provokes it. The probe catches its own throw (a denial is a pass, and a
  // stronger one than an empty store), but Chromium ALSO reports it on the
  // page-error channel, where it was landing as "the app threw".
  //
  // Without this, every generated app fails no_page_errors on an error the
  // checker caused. Observed on the first live run: two builds that touch no
  // storage anywhere in their source both failed with this exact message.
  ...SANDBOX_NOISE,
];

/**
 * Is this console/page message the sentinel key being rejected (or any other
 * network weather), rather than the app being broken?
 * @param {any} text
 * @returns {boolean}
 */
export function isProviderNoise(text, opts) {
  const s = typeof text === "string" ? text : text && typeof text.text === "string" ? text.text : String(text ?? "");
  if (!s.trim()) return false;
  // Checked BEFORE everything else, the host match included: this message
  // arrives FROM a provider host and carries a 401, so it would otherwise match
  // two separate noise rules on its way past.
  if (KEY_NEVER_SENT.test(s)) return false;
  // NO KEY TYPED, NO AMNESTY. Every provider rule below is justified by one
  // sentence — "the sentinel is fake, so of course it was rejected". A HOSTED
  // app has no key field, so nothing was typed and that sentence is simply
  // untrue; a 401, a failed fetch or a rate-limit from a hosted app is the app
  // failing, and swallowing it is how #CAP-22 v2 passed. Its stored verdict
  // reads "5 provider/network messages ignored — the sentinel key is rejected
  // on purpose" on a run where `key_field_masked` recorded "no key field — this
  // app does not ask for a key", while the clip's last frame shows the app
  // answering "Error: could not get a response." Those five ignored messages
  // were the failure.
  //
  // Defaults to true so an unaware caller keeps the old behaviour: the risk
  // worth guarding is a BYOK run losing its amnesty and throwing away good
  // recordings on every single run.
  const sentinelTyped = !opts || opts.sentinelTyped == null ? true : !!opts.sentinelTyped;
  if (!sentinelTyped) return SANDBOX_NOISE.some((re) => re.test(s));
  if (PROVIDER_HOSTS.test(s)) return true;
  return NOISE_PATTERNS.some((re) => re.test(s));
}

/**
 * THE ONE 401 THAT IS NOT NOISE: the key was never SENT.
 *
 * The filter above is deliberately generous about provider rejections, because
 * the sentinel is fake and its rejection fires on every single run. But
 * "rejected" and "never arrived" are different facts, and only one of them is
 * expected. OpenAI says **"Incorrect API key provided: sk-…"** when a key is
 * present and wrong — the sentinel working as designed — and **"You didn't
 * provide an API key. You need to provide your API key in an Authorization
 * header…"** when the header is absent or malformed. The second means the app
 * collected a key and then failed to put it on the wire, which is the app being
 * broken.
 *
 * #CAP-21 is exactly that: its final frame shows the key field filled (masked
 * dots), a model selected, and that verbatim 401 — and the clip passed
 * `no_page_errors` with the note "6 provider/network messages ignored — the
 * sentinel key is rejected on purpose". The filter swallowed the one message
 * that was evidence.
 *
 * Safe to be strict here: `exerciseApp` types the sentinel into EVERY key-ish
 * field before it presses send, so by the time this message can appear the app
 * has been given a key.
 */
const KEY_NEVER_SENT =
  /(?:did|does|do|have|has)\s*n(?:o|')?t\s+provide[sd]?\s+(?:an?\s+|your\s+)?api[\s_-]?key|never provide[sd]?\s+(?:an?\s+|your\s+)?api[\s_-]?key|authorization header\s+(?:is\s+)?(?:missing|malformed|required|empty)|missing (?:the )?authorization header|api[\s_-]?key\s+(?:is\s+)?(?:missing|not provided|not set)/i;

/**
 * The sentinel, removed from anything written into an artifact. The value is
 * fake, so this is hygiene rather than security: `meta.json` and a terminal
 * summary should not carry something that reads like a key, and a reader
 * grepping a capture directory for `sk-` should find nothing.
 * @param {any} s
 * @returns {string}
 */
function redact(s) {
  return String(s ?? "").split(SENTINEL_KEY).join("‹sentinel›");
}

/** @param {any} e */
function msg(e) {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return redact(raw || "unknown error").split("\n")[0].slice(0, 300);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The page half — serialized into the browser, so it may not close over anything
// ---------------------------------------------------------------------------

/* c8 ignore start — these run in the browser, not in Node */

/**
 * Find every key-ish input and stamp it with an index, so Node can address the
 * same elements afterwards.
 *
 * DETECTING BY `type=password` ALONE WOULD BE CIRCULAR: masking is the property
 * under test, so a detector that only finds masked fields can never fail. The
 * name/placeholder/label match is what makes an UNMASKED key field findable.
 * @param {[string, string]} args [markAttr, sentinel-unused]
 */
function pageScanKeyFields(args) {
  const mark = args[0];
  // Matched against a NORMALISED haystack (camel humps split, separators to
  // spaces, lowercased) — `keyInput` has no word boundary a regex can see, and
  // `keyInput` is precisely what one of the two published apps calls its field.
  // Swedish alongside English, as every routing gate in this repo is
  // (invariant 6), and with explicit boundary classes rather than `\b`, which
  // treats å/ä/ö as non-word characters.
  const KEYISH = /(^|[^a-zåäöé])(api key|apikey|api|key|token|secret|nyckel|hemlig|authorization|bearer)([^a-zåäöé]|$)/;
  // A field whose name only ever said "api" because it is the API's BASE URL,
  // its model or its endpoint is not a key field, and flagging one would fail a
  // perfectly well-behaved app on a masking rule that does not apply to it.
  const NOT_KEY = /(base ?url|endpoint|host|origin|proxy|model|prompt|message|question|search|query|adress|fr(a|å)ga)/;
  const normalise = (s) =>
    String(s || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_./:]+/g, " ")
      .toLowerCase();
  const out = [];
  const fields = Array.prototype.slice.call(document.querySelectorAll("input, textarea"));
  let i = 0;
  for (const el of fields) {
    const type = String(el.getAttribute("type") || el.type || "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "range", "file", "color", "submit", "button", "image"].includes(type)) continue;
    let labelText = "";
    try {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) labelText = lab.textContent || "";
      }
      if (!labelText && el.closest) {
        const wrap = el.closest("label");
        if (wrap) labelText = wrap.textContent || "";
      }
    } catch (e) {
      /* an exotic id that CSS.escape refused — the other signals still decide */
    }
    const haystack = normalise(
      [
        el.id || "",
        el.name || "",
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("autocomplete") || "",
        labelText,
      ].join(" "),
    );
    const byName = KEYISH.test(haystack) && !NOT_KEY.test(haystack);
    const byType = type === "password";
    if (!byName && !byType) continue;
    const idx = i++;
    el.setAttribute(mark, String(idx));
    let textSecurity = "";
    try {
      const cs = getComputedStyle(el);
      textSecurity = String(cs.webkitTextSecurity || cs.getPropertyValue("-webkit-text-security") || "");
    } catch (e) {
      /* no computed style (a detached node) — `type` still decides */
    }
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    out.push({
      index: idx,
      tag: String(el.tagName || "").toLowerCase(),
      id: el.id || null,
      name: el.name || null,
      placeholder: el.getAttribute("placeholder") || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      type,
      textSecurity,
      matchedBy: byType && byName ? "type+name" : byType ? "type" : "name",
      visible: !!(rect.width > 0 && rect.height > 0),
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
    });
  }
  return out;
}

/**
 * Re-read the masking of the already-marked key fields. Called again after the
 * key is typed and again at the very end: a field that starts masked and is
 * later switched to plain text has still put the key on screen.
 * @param {[string]} args
 */
function pageReadMasking(args) {
  const mark = args[0];
  const out = [];
  for (const el of Array.prototype.slice.call(document.querySelectorAll("[" + mark + "]"))) {
    let textSecurity = "";
    try {
      const cs = getComputedStyle(el);
      textSecurity = String(cs.webkitTextSecurity || cs.getPropertyValue("-webkit-text-security") || "");
    } catch (e) {
      /* see pageScanKeyFields */
    }
    out.push({
      index: Number(el.getAttribute(mark)),
      type: String(el.getAttribute("type") || el.type || "text").toLowerCase(),
      textSecurity,
      valueLength: String(el.value || "").length,
    });
  }
  return out;
}

/**
 * Where — if anywhere — the sentinel turned up. Everything is probed
 * separately: in an opaque origin the storage getters throw, and one throw must
 * not cost the other five answers.
 * @param {[string, string]} args [sentinel, keyMark]
 */
function pageScanReveal(args) {
  const sentinel = args[0];
  const keyMark = args[1];
  const has = (/** @type {any} */ v) => typeof v === "string" && v.indexOf(sentinel) !== -1;
  const where = (/** @type {any} */ el) => {
    if (!el || !el.tagName) return "?";
    const t = String(el.tagName).toLowerCase();
    return t + (el.id ? "#" + el.id : el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : "");
  };

  const out = {
    origin: "",
    visibleText: false,
    attribute: false,
    attributeWhere: null,
    domText: false,
    domTextWhere: null,
    localStorage: false,
    sessionStorage: false,
    cookie: false,
    url: false,
    storageErrors: [],
  };

  try {
    out.origin = String(location.origin);
  } catch (e) {
    /* nothing to say */
  }
  try {
    out.visibleText = has(document.body ? document.body.innerText || document.body.textContent || "" : "");
  } catch (e) {
    out.storageErrors.push("innerText: " + (e && e.message));
  }

  // Attributes and text nodes, walked rather than string-matched on outerHTML,
  // so the finding can name the element it is in. The key field's OWN `value`
  // attribute is skipped: the specification forbids echoing the key into
  // another element, not the field the user typed it into.
  try {
    for (const el of Array.prototype.slice.call(document.querySelectorAll("*"))) {
      const isKeyField = el.hasAttribute && el.hasAttribute(keyMark);
      for (const at of Array.prototype.slice.call(el.attributes || [])) {
        if (isKeyField && at.name === "value") continue;
        if (has(at.value)) {
          out.attribute = true;
          out.attributeWhere = where(el) + "[" + at.name + "]";
          break;
        }
      }
      if (out.attribute) break;
    }
  } catch (e) {
    out.storageErrors.push("attributes: " + (e && e.message));
  }

  try {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
    let node = walker.nextNode();
    while (node) {
      if (has(node.nodeValue)) {
        const parent = node.parentElement;
        // A textarea's own child text is its default value, not a leak.
        if (!(parent && parent.hasAttribute && parent.hasAttribute(keyMark))) {
          out.domText = true;
          out.domTextWhere = where(parent);
          break;
        }
      }
      node = walker.nextNode();
    }
  } catch (e) {
    out.storageErrors.push("textNodes: " + (e && e.message));
  }

  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const store = name === "localStorage" ? localStorage : sessionStorage;
      let hit = false;
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i) || "";
        if (has(k) || has(store.getItem(k) || "")) {
          hit = true;
          break;
        }
      }
      out[name] = hit;
    } catch (e) {
      // An opaque origin has no storage at all — the strongest possible form of
      // "the key was not persisted".
      out.storageErrors.push(name + ": " + (e && e.message));
    }
  }

  try {
    out.cookie = has(document.cookie);
  } catch (e) {
    out.storageErrors.push("cookie: " + (e && e.message));
  }
  try {
    out.url = has(location.href) || has(decodeURIComponent(location.href));
  } catch (e) {
    out.storageErrors.push("url: " + (e && e.message));
  }
  return out;
}

/**
 * The thing to type into and the thing to press. Key fields (already marked)
 * are excluded from the first, or the exercise would type the prompt over the
 * sentinel.
 * @param {[string, string, string]} args [keyMark, promptMark, sendMark]
 */
function pageFindInteractive(args) {
  const keyMark = args[0];
  const promptMark = args[1];
  const sendMark = args[2];
  // EN + SV, matched on a normalised label with explicit boundary classes —
  // `\b` treats å/ä/ö as non-word characters, which is how a bilingual gate
  // silently stops working (invariant 6).
  const SEND_WORDS =
    /(^|[^a-zåäöé])(send|ask|submit|go|run|start|chat|generate|search|answer|skicka|sand|sänd|fraga|fråga|kor|kör|starta|svara|sok|sök)([^a-zåäöé]|$)/;
  const normalise = (s) =>
    String(s || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_./:]+/g, " ")
      .toLowerCase();
  const visible = (/** @type {any} */ el) => {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    return r.width > 0 && r.height > 0;
  };
  const describe = (/** @type {any} */ el, /** @type {string} */ extra) => ({
    tag: String(el.tagName || "").toLowerCase(),
    id: el.id || null,
    text: String(el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40),
    visible: visible(el),
    detail: extra,
  });

  /** the prompt field: a text-ish input or textarea that is not a key field */
  let prompt = null;
  const candidates = Array.prototype.slice.call(document.querySelectorAll("textarea, input, [contenteditable=''], [contenteditable='true']"));
  for (const el of candidates) {
    if (el.hasAttribute && el.hasAttribute(keyMark)) continue;
    if (el.disabled || el.readOnly) continue;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "input") {
      const type = String(el.getAttribute("type") || el.type || "text").toLowerCase();
      if (!["text", "search", "email", "url", "tel", ""].includes(type)) continue;
    }
    if (!visible(el)) continue;
    // A textarea beats a one-line input: an app that has both usually wants the
    // question in the textarea.
    if (!prompt || (tag === "textarea" && String(prompt.tagName).toLowerCase() !== "textarea")) prompt = el;
  }
  if (prompt) prompt.setAttribute(promptMark, "1");

  /** the send control: word match first, then a submit, then any button */
  let send = null;
  let best = -1;
  const buttons = Array.prototype.slice.call(
    document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]"),
  );
  for (const el of buttons) {
    if (el.disabled) continue;
    if (!visible(el)) continue;
    const label = normalise(
      [el.textContent || "", el.value || "", el.id || "", el.getAttribute("aria-label") || "", el.title || ""].join(" "),
    );
    const type = String(el.getAttribute("type") || "").toLowerCase();
    let score = 1;
    if (type === "submit") score = 3;
    if (SEND_WORDS.test(label)) score = 5;
    if (score > best) {
      best = score;
      send = el;
    }
  }
  if (send) send.setAttribute(sendMark, "1");

  return {
    prompt: prompt ? describe(prompt, "prompt field") : null,
    send: send ? describe(send, best >= 5 ? "matched a send word" : best === 3 ? "type=submit" : "first visible button") : null,
  };
}

/**
 * The document's own vital signs.
 * @param {[string]} args
 */
function pageReadDoc(args) {
  let text = "";
  try {
    text = (document.body && (document.body.innerText || document.body.textContent)) || "";
  } catch (e) {
    /* a document with no body */
  }
  let html = "";
  try {
    html = document.documentElement ? document.documentElement.outerHTML : "";
  } catch (e) {
    /* see above */
  }
  return {
    title: String(document.title || "").slice(0, 200),
    readyState: String(document.readyState || ""),
    bodyTextLength: text.trim().length,
    htmlLength: html.length,
    elements: document.querySelectorAll("*").length,
    url: String(location.href),
  };
}

/**
 * Set a value the way a user would be seen to, when Playwright's own fill
 * refused (a field behind an overlay, a custom element that hides its input).
 * @param {[string, string]} args [selector, value]
 */
function pageForceFill(args) {
  const el = document.querySelector(args[0]);
  if (!el) return false;
  el.focus && el.focus();
  el.value = args[1];
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** @param {[string]} args */
function pageClearMarks(args) {
  for (const attr of args[0].split(",")) {
    for (const el of Array.prototype.slice.call(document.querySelectorAll("[" + attr + "]"))) {
      el.removeAttribute(attr);
    }
  }
  return true;
}

/* c8 ignore stop */

// ---------------------------------------------------------------------------
// The exercise
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AppObservations
 * @property {string} url
 * @property {boolean} loaded
 * @property {number | null} status
 * @property {string} title
 * @property {number} bodyTextLength
 * @property {number} htmlLength
 * @property {Array<any>} keyFields
 * @property {any} reveal
 * @property {any} interaction
 * @property {Array<{type: string, text: string, noise: boolean}>} consoleErrors
 * @property {Array<{text: string, noise: boolean}>} pageErrors
 * @property {Array<{step: string, message: string}>} errors
 * @property {Array<{url: string, why: string}>} assetFailures
 * @property {any} network
 * @property {number} durationMs
 */

/** A blank observations record — the shape is the contract, so it is one place. */
function emptyObservations(url = "") {
  return /** @type {AppObservations} */ ({
    url: String(url || ""),
    loaded: false,
    status: null,
    title: "",
    readyState: "",
    origin: "",
    bodyTextLength: 0,
    htmlLength: 0,
    elements: 0,
    keyFields: [],
    sentinelTyped: 0,
    reveal: {
      visibleText: false,
      attribute: false,
      attributeWhere: null,
      domText: false,
      domTextWhere: null,
      localStorage: false,
      sessionStorage: false,
      cookie: false,
      url: false,
      console: false,
      requestUrl: false,
      storageErrors: [],
    },
    interaction: { promptField: null, sendButton: null, filled: false, clicked: false, forced: false, error: null, threw: [] },
    // What the app WROTE when it was used. Null when send was never pressed
    // (app_interactive owns that verdict) or when the page's text could not be
    // read at all — a missing measurement is recorded in `errors` instead, and
    // `app_answered` does not invent a failure out of one.
    reply: null,
    consoleErrors: [],
    pageErrors: [],
    errors: [],
    // The app's OWN files that never arrived. Observed, not graded: it is not
    // one of the six checks, and inventing a seventh would change the contract
    // the gate is written against. It is recorded and printed because it is the
    // most informative thing there is about a published app that renders and
    // then does nothing — a `<script type="module">` is fetched in CORS mode,
    // and `/app/<slug>/` is served into an OPAQUE origin, so the module is
    // blocked and the app is inert with no error of its own. One of the two
    // apps published on 2026-08-11 is in exactly that state.
    assetFailures: [],
    network: { failed: [], errorStatuses: [] },
    durationMs: 0,
  });
}

/**
 * Drive one published app: open it, put the sentinel in every key field, ask it
 * something, press send — and write down everything that happened.
 *
 * Total by construction. Each step is wrapped, and a step that fails records
 * itself in `errors` and lets the next one run: half an observation still
 * grades (a page that never loaded fails `app_loads` and that is the right
 * answer), whereas a throw would take the recording with it.
 *
 * @param {any} page a Playwright Page, already open
 * @param {string} url the published app, e.g. https://…/app/<slug>/
 * @param {Partial<typeof EXERCISE_DEFAULTS> & { prompt?: string }} [opts]
 * @returns {Promise<AppObservations>}
 */
export async function exerciseApp(page, url, opts = {}) {
  const o = { ...EXERCISE_DEFAULTS, prompt: DEFAULT_PROMPT, ...(opts || {}) };
  const obs = emptyObservations(url);
  const startedAt = Date.now();

  if (!page || typeof page.goto !== "function") {
    obs.errors.push({ step: "setup", message: "no usable Playwright page was passed" });
    obs.durationMs = Date.now() - startedAt;
    return obs;
  }

  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T> | T} fn
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  const step = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      obs.errors.push({ step: name, message: msg(e) });
      return fallback;
    }
  };

  // The app's own directory — everything under it is a file the BUILD shipped,
  // so a failure there is the app being broken rather than a provider saying no.
  const appPrefix = String(url || "").split("?")[0].replace(/[^/]*$/, "");
  const ownFile = (/** @type {string} */ u) => !!appPrefix && u.startsWith(appPrefix) && u !== appPrefix;
  const noteAssetFailure = (/** @type {string} */ u, /** @type {string} */ why) => {
    if (!ownFile(u) || obs.assetFailures.length >= 10) return;
    obs.assetFailures.push({ url: redact(u).slice(0, 200), why });
  };

  // --- listeners. Attached here, so only what happens during the exercise
  // counts, and removed at the end so a shared page is left as it was found.
  const onConsole = (/** @type {any} */ m) => {
    try {
      const type = String(m.type ? m.type() : "");
      if (type !== "error") return;
      const text = String(m.text ? m.text() : "");
      if (text.includes(SENTINEL_KEY)) obs.reveal.console = true;
      obs.consoleErrors.push({ type, text: redact(text).slice(0, 400), noise: isProviderNoise(text) });
    } catch {
      /* a console message that would not read is not worth a failed run */
    }
  };
  const onPageError = (/** @type {any} */ e) => {
    const text = redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400);
    obs.pageErrors.push({ text, noise: isProviderNoise(text) });
  };
  const onRequestFailed = (/** @type {any} */ req) => {
    try {
      const u = String(req.url ? req.url() : "");
      if (u.includes(SENTINEL_KEY)) obs.reveal.requestUrl = true;
      const failure = redact(req.failure?.()?.errorText || "");
      if (obs.network.failed.length < 10) obs.network.failed.push({ url: redact(u).slice(0, 200), failure });
      noteAssetFailure(u, failure || "the request failed");
    } catch {
      /* see onConsole */
    }
  };
  const onResponse = (/** @type {any} */ res) => {
    try {
      const status = Number(res.status ? res.status() : 0);
      const u = String(res.url ? res.url() : "");
      if (u.includes(SENTINEL_KEY)) obs.reveal.requestUrl = true;
      if (status >= 400 && obs.network.errorStatuses.length < 10) {
        obs.network.errorStatuses.push({ url: redact(u).slice(0, 200), status });
      }
      if (status >= 400) noteAssetFailure(u, `HTTP ${status}`);
    } catch {
      /* see onConsole */
    }
  };
  // A dialog nobody answers freezes the page — and the recording — for the rest
  // of the run. Harmless if the caller already attached one: the second accept
  // rejects and is swallowed.
  const onDialog = (/** @type {any} */ d) => {
    try {
      d.accept().catch(() => {});
    } catch {
      /* already handled */
    }
  };

  try {
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    page.on("dialog", onDialog);
  } catch (e) {
    obs.errors.push({ step: "listeners", message: msg(e) });
  }

  try {
    // --- 1. open it
    const res = await step(
      "goto",
      () => page.goto(url, { waitUntil: "domcontentloaded", timeout: o.navTimeout }),
      null,
    );
    if (res) {
      obs.status = typeof res.status === "function" ? res.status() : null;
      obs.loaded = true;
    }
    await step("load", () => page.waitForLoadState("load", { timeout: o.timeout }), null);
    await sleep(o.settleMs);

    // --- 2. vital signs
    const doc = await step("readDoc", () => page.evaluate(pageReadDoc, [""]), null);
    if (doc) {
      obs.title = doc.title;
      obs.readyState = doc.readyState;
      obs.bodyTextLength = doc.bodyTextLength;
      obs.htmlLength = doc.htmlLength;
      obs.elements = doc.elements;
      if (!obs.loaded && doc.htmlLength > 0) obs.loaded = true; // an already-open page
    }

    // --- 3. every key-ish field, masked or not
    const found = await step("scanKeyFields", () => page.evaluate(pageScanKeyFields, [KEY_MARK, ""]), []);
    obs.keyFields = (found || []).map((f) => ({
      ...f,
      masked: isMaskedSample(f),
      everUnmasked: !isMaskedSample(f),
      filled: false,
      error: null,
    }));

    // --- 4. type the SENTINEL into each (never a real key — see the header)
    for (const field of obs.keyFields) {
      const selector = `[${KEY_MARK}="${field.index}"]`;
      const filled = await step(
        `fill:${field.id || field.index}`,
        async () => {
          try {
            await page.fill(selector, SENTINEL_KEY, { timeout: Math.min(o.timeout, 8_000) });
            return true;
          } catch {
            // A field Playwright will not type into (covered, custom element)
            // still has to be measured, so set it the blunt way.
            return await page.evaluate(pageForceFill, [selector, SENTINEL_KEY]);
          }
        },
        false,
      );
      field.filled = !!filled;
      if (filled) obs.sentinelTyped++;
      else field.error = "could not type into this field";
    }

    // Let the kit react: the sentinel matches OpenAI's key pattern, so it
    // resolves a provider and fetches a model list, which 401s. That is the
    // expected outcome and the reason isProviderNoise exists.
    if (obs.keyFields.length) await sleep(o.afterKeyMs);
    await mergeMasking(page, obs, step);

    // --- 5. did it leak?
    const reveal1 = await step("scanReveal", () => page.evaluate(pageScanReveal, [SENTINEL_KEY, KEY_MARK]), null);
    mergeReveal(obs, reveal1);
    if (reveal1 && reveal1.origin) obs.origin = reveal1.origin;

    // --- 6. use it
    const found2 = await step(
      "findInteractive",
      () => page.evaluate(pageFindInteractive, [KEY_MARK, PROMPT_MARK, SEND_MARK]),
      null,
    );
    obs.interaction.promptField = found2?.prompt || null;
    obs.interaction.sendButton = found2?.send || null;

    if (found2?.prompt) {
      obs.interaction.filled = await step(
        "fillPrompt",
        async () => {
          try {
            await page.fill(`[${PROMPT_MARK}]`, String(o.prompt), { timeout: Math.min(o.timeout, 8_000) });
            return true;
          } catch {
            return await page.evaluate(pageForceFill, [`[${PROMPT_MARK}]`, String(o.prompt)]);
          }
        },
        false,
      );
    }

    if (found2?.send) {
      const errorsBefore = obs.pageErrors.length;
      // The page as it reads BEFORE send, so the reply can be told apart from
      // the furniture that was already on screen.
      const textBefore = await step("readTextBefore", () => page.evaluate(pageReadBodyText, [""]), null);
      try {
        await page.click(`[${SEND_MARK}]`, { timeout: Math.min(o.timeout, 8_000) });
        obs.interaction.clicked = true;
      } catch (first) {
        try {
          await page.click(`[${SEND_MARK}]`, { timeout: 5_000, force: true });
          obs.interaction.clicked = true;
          obs.interaction.forced = true;
        } catch (second) {
          obs.interaction.error = `pressing ${describeControl(found2.send)} failed: ${msg(second)}`;
        }
      }
      if (obs.interaction.clicked) {
        await sleep(o.afterSendMs);
        // An exception thrown by the click HANDLER is "pressing it threw" just
        // as much as a click that would not land — filtered, because the
        // sentinel's 401 arrives through exactly this path.
        obs.interaction.threw = obs.pageErrors
          .slice(errorsBefore)
          .filter((p) => !p.noise)
          .map((p) => p.text);

        // DID IT ANSWER? The whole of check seven. Read the page again and keep
        // both the added text and the whole of it: the added text is the reply
        // when the app appends to a transcript, and the whole is the fallback
        // for an app that re-renders its output area in place.
        const textAfter = await step("readTextAfter", () => page.evaluate(pageReadBodyText, [""]), null);
        if (typeof textAfter === "string") {
          const before = typeof textBefore === "string" ? textBefore : "";
          obs.reply = {
            beforeChars: before.trim().length,
            afterChars: textAfter.trim().length,
            prompt: String(o.prompt),
            added: redact(addedText(before, textAfter)).slice(0, 2_000),
            text: redact(textAfter).slice(0, 4_000),
          };
        }
      }
    }

    // --- 7. the second look. An app that echoes the key into a status line
    // does it AFTER the request comes back, which is after the first scan.
    const reveal2 = await step("scanReveal2", () => page.evaluate(pageScanReveal, [SENTINEL_KEY, KEY_MARK]), null);
    mergeReveal(obs, reveal2);
    await mergeMasking(page, obs, step);

    await step("clearMarks", () => page.evaluate(pageClearMarks, [[KEY_MARK, PROMPT_MARK, SEND_MARK].join(",")]), null);
  } catch (e) {
    // Belt and braces: every step above is already wrapped, so reaching here
    // means something outside them (a closed context) went wrong.
    obs.errors.push({ step: "exercise", message: msg(e) });
  } finally {
    for (const [event, fn] of /** @type {Array<[string, any]>} */ ([
      ["console", onConsole],
      ["pageerror", onPageError],
      ["requestfailed", onRequestFailed],
      ["response", onResponse],
      ["dialog", onDialog],
    ])) {
      try {
        page.off?.(event, fn);
      } catch {
        /* an older Playwright without off() — the page is about to close anyway */
      }
    }
    obs.durationMs = Date.now() - startedAt;
  }

  return obs;
}

/** `input#keyInput` — how a control is named back to a person. */
function describeControl(c) {
  if (!c) return "the control";
  const tag = c.tag || "element";
  const id = c.id ? `#${c.id}` : "";
  const text = c.text ? ` “${c.text}”` : "";
  return `${tag}${id}${text}`;
}

/** A field is masked when the browser will not render its value. */
function isMaskedSample(f) {
  if (!f) return false;
  const type = String(f.type || "").toLowerCase();
  const sec = String(f.textSecurity || "").toLowerCase();
  return type === "password" || (!!sec && sec !== "none");
}

/** Fold a fresh masking read into the fields, remembering any unmasked moment. */
async function mergeMasking(page, obs, step) {
  if (!obs.keyFields.length) return;
  const now = await step("readMasking", () => page.evaluate(pageReadMasking, [KEY_MARK]), null);
  for (const sample of now || []) {
    const field = obs.keyFields.find((f) => f.index === sample.index);
    if (!field) continue;
    field.type = sample.type;
    field.textSecurity = sample.textSecurity;
    field.valueLength = sample.valueLength;
    const masked = isMaskedSample(sample);
    if (!masked) field.everUnmasked = true;
    field.masked = masked && !field.everUnmasked;
  }
}

/** OR a reveal scan into the record: seen once is seen. */
function mergeReveal(obs, scan) {
  if (!scan) return;
  for (const k of ["visibleText", "attribute", "domText", "localStorage", "sessionStorage", "cookie", "url"]) {
    if (scan[k]) obs.reveal[k] = true;
  }
  if (scan.attributeWhere && !obs.reveal.attributeWhere) obs.reveal.attributeWhere = scan.attributeWhere;
  if (scan.domTextWhere && !obs.reveal.domTextWhere) obs.reveal.domTextWhere = scan.domTextWhere;
  for (const e of scan.storageErrors || []) {
    if (!obs.reveal.storageErrors.includes(e)) obs.reveal.storageErrors.push(String(e).slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
// The grade — PURE
// ---------------------------------------------------------------------------

/** @param {any} v */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** @param {any} v */
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** @param {any} v */
function text(v) {
  return typeof v === "string" ? v : v && typeof v.text === "string" ? v.text : String(v ?? "");
}

/** A console/page error entry, however it was recorded, judged for noise. */
function isNoiseEntry(e, sentinelTyped) {
  // The cached `noise` flag is stamped as the message ARRIVES, which is before
  // the key is typed, so it cannot know whether the sentinel ever went in. When
  // it did not, re-judge from the text rather than trusting a verdict reached
  // under the wrong premise.
  if (sentinelTyped === false) return isProviderNoise(text(e), { sentinelTyped: false });
  if (e && typeof e === "object" && typeof e.noise === "boolean") return e.noise;
  return isProviderNoise(text(e));
}

/**
 * @typedef {Object} AppCheck
 * @property {string} id
 * @property {boolean} ok
 * @property {string} detail  one sentence, true whether it passed or failed
 */

/**
 * Seven checks over one observations record. PURE — no clock, no network, no
 * filesystem — so every verdict in the table below is reproducible from a JSON
 * file, and the interesting cases (a 401, an app with no key field, a half
 * written observations object) are unit tests rather than a live experiment.
 *
 * Garbage in does NOT throw: an empty or malformed record simply fails, which
 * is the correct verdict for a capture whose exercise did not survive.
 *
 * @param {any} observations
 * @returns {{ pass: boolean, checks: AppCheck[], failures: string[] }}
 */
export function gradeApp(observations) {
  const o = obj(observations);
  /** @type {AppCheck[]} */
  const checks = [];
  const add = (/** @type {string} */ id, /** @type {boolean} */ ok, /** @type {string} */ detail) =>
    checks.push({ id, ok, detail });

  // 1. app_loads --------------------------------------------------------------
  const status = Number.isFinite(Number(o.status)) && o.status != null ? Number(o.status) : null;
  const bodyLen = Number(o.bodyTextLength) || 0;
  const httpOk = status == null || status < 400;
  const loadedOk = o.loaded === true && bodyLen > 0 && httpOk;
  // The app's own files that never arrived are REPORTED, not graded — this is
  // not a seventh check, and the gate's contract is the six. It is said out
  // loud because it is the one thing that explains a published app which
  // renders and then does nothing: a `<script type="module">` is fetched in
  // CORS mode, and `/app/<slug>/` is served into an opaque origin, so the
  // module is blocked and the page sits there inert with no error of its own.
  // The app's own files that never arrived FAIL this check (owner directive,
  // 2026-08-11: "only keep those app studio creation videos that also pass
  // end2end test of the generated app"). An app whose own script never loads
  // renders, throws nothing, and does nothing — its buttons have no handlers.
  // A clip of that is a demo of a broken build, which is exactly what the gate
  // exists to keep out of the deck, so a merely-reported note was too weak.
  //
  // This is not hypothetical: the Socratic Tutor published on 2026-08-11 is
  // inert for this reason. A `<script type="module">` is fetched in CORS mode
  // and `/app/<slug>/` is served into an opaque origin (src/build-pub.js), so
  // the module is blocked — silently, because a blocked module raises no page
  // error. That is a real platform limitation for module-based builds, not a
  // flaw in this check.
  const assets = arr(o.assetFailures);
  const assetNote = assets.length
    ? `; ${assets.length} of its own files did not load (${assets
        .slice(0, 2)
        .map((a) => `${text(obj(a).url).split("/").pop()} ${text(obj(a).why)}`)
        .join(", ")}) — the app is inert`
    : "";
  add(
    "app_loads",
    loadedOk && assets.length === 0,
    (o.loaded !== true
      ? "the page never loaded" + (arr(o.errors).length ? ` (${text(arr(o.errors)[0]?.message)})` : "")
      : !httpOk
        ? `the app answered HTTP ${status}`
        : bodyLen > 0
          ? `loaded${status ? ` (HTTP ${status})` : ""} with ${bodyLen} characters of text`
          : "loaded but the body has no text — a blank page is not a working app") + assetNote,
  );

  // 2. no_page_errors ---------------------------------------------------------
  // The sentinel key is fake, so a 401/403 and a failed fetch are the EXPECTED
  // outcome; they are filtered rather than counted. What remains is the app
  // throwing on its own account.
  //
  // ONLY when a key was actually typed. A hosted app has no key field, so there
  // is no fake rejection to forgive and a provider error is the app failing —
  // the filter narrows to this checker's own sandbox noise instead.
  const pageErrs = arr(o.pageErrors);
  const consoleErrs = arr(o.consoleErrors);
  const typed = Number(o.sentinelTyped) > 0;
  const realPage = pageErrs.filter((e) => !isNoiseEntry(e, typed)).map(text);
  const realConsole = consoleErrs.filter((e) => !isNoiseEntry(e, typed)).map(text);
  const real = [...realPage, ...realConsole];
  const ignored = pageErrs.length + consoleErrs.length - real.length;
  add(
    "no_page_errors",
    real.length === 0,
    real.length === 0
      ? `no uncaught errors${
          ignored
            ? typed
              ? ` (${ignored} provider/network message${ignored === 1 ? "" : "s"} ignored — the sentinel key is rejected on purpose)`
              : ` (${ignored} message${ignored === 1 ? "" : "s"} ignored — this checker's own sandbox probes; no key was typed, so provider errors are NOT forgiven)`
            : ""
        }`
      : `${real.length} uncaught error${real.length === 1 ? "" : "s"}: ${real.slice(0, 3).map((t) => t.slice(0, 120)).join(" | ")}`,
  );

  // 3. key_field_masked -------------------------------------------------------
  // NO KEY FIELD AT ALL IS A PASS. Not every generated app takes a key, and
  // absence is not a masking failure.
  const fields = arr(o.keyFields);
  const unmasked = fields.filter((f) => obj(f).masked !== true);
  add(
    "key_field_masked",
    unmasked.length === 0,
    fields.length === 0
      ? "no key field — this app does not ask for a key"
      : unmasked.length === 0
        ? `${fields.length} key field${fields.length === 1 ? "" : "s"} masked`
        : unmasked
            .map((f) => {
              const c = obj(f);
              // A field that IS type=password now but was not earlier still put
              // the key on screen, and the video keeps that frame forever.
              const late = c.type === "password" && c.everUnmasked === true;
              return (
                `${describeControl(c)} is ${late ? "masked now, but was plain text while the key was typed" : `type="${c.type || "?"}"`}` +
                " — a pasted key is readable on screen, and on camera"
              );
            })
            .join("; "),
  );

  // 4. key_not_revealed -------------------------------------------------------
  const reveal = obj(o.reveal);
  const revealedWhere = [];
  if (reveal.visibleText) revealedWhere.push("the page's visible text");
  if (reveal.attribute) revealedWhere.push(`an attribute (${reveal.attributeWhere || "unknown element"})`);
  if (reveal.domText) revealedWhere.push(`the DOM text of ${reveal.domTextWhere || "an element"}`);
  add(
    "key_not_revealed",
    revealedWhere.length === 0,
    revealedWhere.length === 0
      ? Number(o.sentinelTyped) > 0
        ? "the key appears nowhere in the page"
        : "no key was typed, so nothing could be revealed"
      : `the key was echoed into ${revealedWhere.join(" and ")}`,
  );

  // 5. key_not_persisted ------------------------------------------------------
  const persistedWhere = [];
  if (reveal.localStorage) persistedWhere.push("localStorage");
  if (reveal.sessionStorage) persistedWhere.push("sessionStorage");
  if (reveal.cookie) persistedWhere.push("a cookie");
  if (reveal.url) persistedWhere.push("the URL");
  const denied = arr(reveal.storageErrors).length > 0;
  add(
    "key_not_persisted",
    persistedWhere.length === 0,
    persistedWhere.length === 0
      ? denied
        ? "nothing stored (the sandbox denies storage access outright, which is stronger)"
        : "nothing in storage, cookies or the URL"
      : `the key was written to ${persistedWhere.join(", ")}`,
  );

  // 6. app_interactive --------------------------------------------------------
  const inter = obj(o.interaction);
  const threw = arr(inter.threw).map(text);
  const why = [];
  if (!inter.promptField) why.push("nothing to type into");
  if (!inter.sendButton) why.push("nothing to press");
  if (inter.sendButton && !inter.clicked) why.push(text(inter.error) || "the control could not be pressed");
  if (threw.length) why.push(`pressing it threw: ${threw[0].slice(0, 140)}`);
  add(
    "app_interactive",
    why.length === 0,
    why.length === 0
      ? `typed into ${describeControl(inter.promptField)} and pressed ${describeControl(inter.sendButton)}${inter.forced ? " (forced)" : ""}`
      : why.join("; "),
  );

  // 7. app_answered ------------------------------------------------------------
  // The check #CAP-22 needed and did not have. `app_interactive` proves a
  // control could be pressed; this one proves pressing it DID something, and
  // that what it did was not print an error where the answer goes.
  //
  // A record with no `reply` at all passes: send was never pressed (check six
  // already fails), or the page's text could not be read (a missing
  // measurement, recorded in `errors`, is not evidence of a broken app). Every
  // real exercise that presses send produces one.
  //
  // KNOWN AND INTENDED CONSEQUENCE: a build in BRING-YOUR-OWN-KEY mode fails
  // this check, because the key it is given is the sentinel and the sentinel
  // cannot buy an answer. That is not a false positive — it is the reason
  // hosted mode is the default the build prompts teach (PR #426): an app that
  // needs a key nobody has is an app whose capture shows an error on camera,
  // and the owner rejected exactly such a clip. The remedy is to build hosted,
  // not to soften this check; a genuinely never-cloud Se/cure flavour can be
  // captured, it just cannot be captured USING it.
  const reply = o.reply == null ? null : obj(o.reply);
  const replyAdded = reply ? text(reply.added) || text(reply.text) : "";
  const answered = replyBody(replyAdded, reply ? reply.prompt : "");
  const brokenBy = reply ? replyLooksBroken(replyAdded) || replyLooksBroken(text(reply.text)) : null;
  add(
    "app_answered",
    !reply || (!brokenBy && answered.length >= MIN_REPLY_CHARS),
    !reply
      ? "no reply was observed (nothing was sent, or the page text could not be read)"
      : brokenBy
        ? `the app answered with an error (${brokenBy}): ${(answered || replyAdded).slice(0, 160)}`
        : answered.length >= MIN_REPLY_CHARS
          ? `the app replied with ${answered.length} characters: ${answered.slice(0, 100)}`
          : `nothing came back — the page gained ${answered.length} characters after send, so the button leads nowhere`,
  );

  const failures = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  return { pass: failures.length === 0, checks, failures };
}

// ---------------------------------------------------------------------------
// The verdict block
// ---------------------------------------------------------------------------

/**
 * The short readable block a batch summary prints: one line per check, then the
 * failures spelled out. Total, like everything else here — a summary that
 * throws on an odd result is a summary nobody can print.
 * @param {any} result gradeApp's return, optionally carrying { url, slug }
 * @returns {string}
 */
export function formatAppVerdict(result) {
  const r = obj(result);
  const checks = arr(r.checks);
  const failures = arr(r.failures);
  const pass = r.pass === true;
  const where = r.slug || r.url || "";
  const ok = checks.filter((c) => obj(c).ok === true).length;

  const lines = [
    `app e2e ${pass ? "✓ PASS" : "✗ FAIL"}  ${ok}/${checks.length || CHECK_IDS.length} checks` + (where ? `  ${where}` : ""),
  ];
  for (const c of checks) {
    const check = obj(c);
    lines.push(`    ${check.ok ? "✓" : "✗"} ${String(check.id || "?").padEnd(17)} ${String(check.detail || "").slice(0, 150)}`);
  }
  if (!checks.length) lines.push("    (no checks — the exercise produced nothing to grade)");
  if (failures.length) {
    lines.push("  not published because:");
    for (const f of failures) lines.push(`    - ${text(f).slice(0, 200)}`);
  }
  return lines.join("\n") + "\n";
}
