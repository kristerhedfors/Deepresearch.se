// @ts-check
// THE RUN VERIFICATION GATE — is what was just recorded a capture of the
// product working, or a capture of it failing?
//
// Owner directive (2026-08-12, capture reviews #CAP-21 and #CAP-22, both swiped
// left): "It says 'error, could not give a response', you should have caught
// this error! What is missing? No end2end? Could you also have a look at the
// last frame of the video? That would tell you it went wrong, make sure you
// have full visibility and verify at least that far before presenting the user
// with the video for final validation."
//
// WHAT WAS MISSING. The recorder decided a run had succeeded from ONE signal:
// the `.stats` footer landing (tests/capture.mjs, the sampler's `state.done`).
// That footer is emitted by the server from a `finally` (src/chat.js — the
// `done` stats event runs on every exit path, INCLUDING after an `{error}`
// event), so a turn that ended in a red error message looks exactly like a turn
// that ended in an answer. Nothing anywhere read the answer itself. The Agent
// Studio app-gate (tests/app-e2e.mjs) reads a lot, but none of its six checks
// look at what the app WROTE on screen either: an app that catches its own
// failure and renders "Error: you didn't provide an api key" loads, throws
// nothing, masks its fields and is interactive — six green checks over a
// visibly broken app.
//
// So this module is the missing judgement, and it is PURE on purpose: no
// filesystem, no browser, no clock, no network. The driver samples the page's
// end state, hands the numbers and the strings here, and gets back a verdict it
// writes into `meta.json`. Which means the interesting cases — a Swedish error
// answer, an app that says the key is missing, a run that produced forty
// characters — are unit tests rather than a live re-recording.
//
// TWO RULES IT IS BUILT AROUND.
//
//   1. PRECISION OVER REACH on the answer text. A gate that fires on a good
//      answer costs a good recording, fires on every run, and gets switched off
//      — the same reasoning tests/app-e2e.mjs's `isProviderNoise` is built on,
//      pointing the other way. So the phrases below are ERROR-SHAPED
//      ("kunde inte ge något svar", "Error:"), never merely negative ("kunde
//      inte", which is ordinary Swedish prose in a research answer). Anything
//      inside a `.content.error-text` element is a failure regardless of its
//      wording, because the product itself already decided that.
//
//   2. EQUAL SWEDISH AND ENGLISH (CLAUDE.md invariant 6). Every sign carries an
//      `en` AND an `sv` pattern, and `capture-guard.test.mjs` fails the build if
//      one is added without the other. Half the capture matrix is `--lang sv`;
//      an English-only gate would pass every Swedish failure.
//      The Swedish patterns avoid `\b` — JS word boundaries treat å/ä/ö as
//      non-word characters, which is how a bilingual regex silently stops
//      working (see the palaeogenomics skill).
//
// WHERE THE STRINGS COME FROM. Product text, not invention:
//   public/js/stream.js        setError's messages ("No response received.",
//                              "Something went wrong.", "Network error: …",
//                              "Stopped before any response arrived.")
//   public/js/turns.js         `.content.error-text` — the class setError puts
//                              on the bubble, which is the structural signal
//   public/js/drc-research.js  "No <provider> API key is stored."
//   public/app-kit/…-kit.js    the published apps' own EN/SV strings, including
//                              "This app's hosted model access is unavailable"
//                              / "Appens värdbaserade modellåtkomst är inte
//                              tillgänglig" and the used-up allowance
//   src/chat.js                "Worker error: …", "Server not configured: …"

/**
 * Below this many characters, an answer is not an answer. A real reply to a
 * starter prompt is hundreds of characters; the failure shapes seen so far
 * ("Error: could not give a response") are well under this, and an EMPTY
 * assistant bubble — the run that recorded a blank final frame — is zero.
 */
export const MIN_ANSWER_CHARS = 40;

/**
 * @typedef {Object} FailureSign
 * @property {string} id     stable id, reported in the verdict
 * @property {"en"|"sv"} lang
 * @property {RegExp} re
 * @property {string} what   one clause, said back to a human
 */

/**
 * The error-shaped phrases, EN and SV in matched pairs (invariant 6).
 *
 * Every `id` MUST appear once per language. The parity test enforces it, so a
 * new sign cannot be added English-first with "Swedish later" — which is the
 * failure mode invariant 6 exists to prevent.
 * @type {FailureSign[]}
 */
export const FAILURE_SIGNS = [
  // "Error: …" / "Fel: …" as the OPENING of a line. Anchored, because "error"
  // mid-sentence is ordinary technical prose in a research answer ("the margin
  // of error is …", "ett fel i mätningen").
  {
    id: "error_prefix",
    lang: "en",
    re: /^[\s*_#>`-]*error\b\s*[:!,—–-]/im,
    what: "the reply opens with an error line",
  },
  {
    id: "error_prefix",
    lang: "sv",
    re: /^[\s*_#>`-]*fel\s*[:!,—–-]/im,
    what: "svaret inleds med en felrad",
  },

  // The literal thing #CAP-22 recorded. The verbatim string in the clip's final
  // frame is "Error: could not get a response." — GET, not "give", which is why
  // the verb list is wide and the object list ("response|answer|reply") is what
  // carries the precision.
  {
    id: "no_response_produced",
    lang: "en",
    re: /(?:could|can|would)\s*n(?:o|')?t\s+(?:get|give|generate|produce|provide|return|fetch|receive)[^.\n]{0,32}(?:response|answer|reply)|unable to (?:get|give|generate|produce|provide|return)[^.\n]{0,32}(?:response|answer|reply)|failed to (?:get|generate|produce|fetch)[^.\n]{0,32}(?:response|answer|reply)/i,
    what: "the reply says it could not get a response",
  },
  {
    id: "no_response_produced",
    lang: "sv",
    re: /kunde inte (?:få|hämta|ge|generera|producera|leverera|lämna|returnera)[^.\n]{0,32}svar|kan inte (?:ge|generera|lämna)[^.\n]{0,32}svar|misslyckades med att (?:hämta|generera)[^.\n]{0,32}svar/i,
    what: "svaret säger att det inte kunde få något svar",
  },

  // setError's own wording (public/js/stream.js).
  {
    id: "no_response_received",
    lang: "en",
    re: /no (?:response|answer) (?:was )?received|stopped before any response arrived|the (?:private )?request failed|the on-device model failed/i,
    what: "no response arrived at all",
  },
  {
    id: "no_response_received",
    lang: "sv",
    re: /inget svar (?:mottogs|togs emot|kom|erhölls|hittades)|avbröts innan (?:något |ett )?svar/i,
    what: "inget svar mottogs",
  },

  {
    id: "something_went_wrong",
    lang: "en",
    re: /something went wrong|worker error\s*:|server not configured\s*:|an? (?:unexpected|internal) error/i,
    what: "the turn ended in a generic failure message",
  },
  {
    id: "something_went_wrong",
    lang: "sv",
    re: /något gick fel|ett fel (?:uppstod|inträffade|har uppstått)|internt fel|serverfel/i,
    what: "turen slutade i ett allmänt felmeddelande",
  },

  {
    id: "network_error",
    lang: "en",
    re: /network error\s*:|connection error|cut off by a connection|was interrupted on the server|could ?n(?:o|')?t resume your previous research/i,
    what: "the connection failed mid-answer",
  },
  {
    id: "network_error",
    lang: "sv",
    re: /nätverksfel|anslutningsfel|anslutningen (?:bröts|avbröts)|förbindelsen (?:bröts|avbröts)/i,
    what: "anslutningen bröts under svaret",
  },

  // #CAP-21: the published app told its first visitor the key was missing —
  // after the key field had been filled on camera.
  //
  // Deliberately NOT matched: the app kit's own resting prompt ("Paste an API
  // key to load the available models" / "Klistra in en API-nyckel …"), which is
  // a legitimate idle state for a bring-your-own-key Se/cure flavour, and the
  // hosted mode's SUCCESS line ("no API key needed" / "ingen API-nyckel
  // behövs"), which says the opposite of a failure with nearly the same words.
  {
    id: "api_key_missing",
    lang: "en",
    re: /(?:did\s*n(?:o|')?t|does\s*n(?:o|')?t|have\s*n(?:o|')?t|has\s*n(?:o|')?t|never)\s+provide[sd]?\s+(?:an?\s+|your\s+)?api[\s_-]?key|api[\s_-]?key\s+(?:is\s+)?(?:missing|required|not (?:set|provided|configured|stored|found))|(?:no|missing)\s+(?:\S+\s+)?api[\s_-]?key\s+(?:is\s+)?(?:stored|set|provided|configured|found|supplied)|authorization header\s+(?:is\s+)?(?:missing|malformed|required)|missing (?:the )?authorization header/i,
    what: "the app says no API key was provided",
  },
  {
    id: "api_key_missing",
    lang: "sv",
    re: /(?:angav|gav|skickade|lämnade)\s+(?:ingen|inte någon|ingen giltig)\s+api[\s_-]?nyckel|api[\s_-]?nyckel(?:n|en)?\s+(?:saknas|krävs|är ogiltig|är felaktig|är inte (?:angiven|sparad|lagrad))|ingen api[\s_-]?nyckel\s+(?:angavs|har angetts|är (?:sparad|lagrad|angiven)|hittades)/i,
    what: "appen säger att ingen API-nyckel angavs",
  },

  {
    id: "api_key_rejected",
    lang: "en",
    re: /(?:invalid|incorrect|expired|unauthori[sz]ed)[\s_-]*api[\s_-]?key|authentication (?:failed|error)/i,
    what: "the provider rejected the key",
  },
  {
    id: "api_key_rejected",
    lang: "sv",
    re: /(?:ogiltig|felaktig|utgången)\s+api[\s_-]?nyckel|autentiseringen? (?:misslyckades|fel)|nyckeln känns inte igen/i,
    what: "leverantören avvisade nyckeln",
  },

  // The published app kit's hosted-mode failure states (public/app-kit/
  // dr-provider-kit.js) — a build whose grant never landed, or whose allowance
  // is spent, greets its visitor with these and does nothing else.
  {
    id: "hosted_access_unavailable",
    lang: "en",
    re: /hosted model access is unavailable|published without a live grant|hosted allowance is used up/i,
    what: "the published app has no working model access",
  },
  {
    id: "hosted_access_unavailable",
    lang: "sv",
    re: /värdbaserade modellåtkomst är inte tillgänglig|publicerades utan ett aktivt tillstånd|värdbaserade kvot är slut/i,
    what: "den publicerade appen saknar fungerande modellåtkomst",
  },

  {
    id: "quota_exhausted",
    lang: "en",
    re: /(?:quota|allowance|budget) (?:exceeded|exhausted|is used up|has run out)|rate limit(?:ed)? — |insufficient[_ ]quota/i,
    what: "the run hit a quota wall",
  },
  {
    id: "quota_exhausted",
    lang: "sv",
    re: /(?:kvoten?|utrymmet|budgeten) (?:är slut|överskreds|har tagit slut|är förbrukad)|för många förfrågningar/i,
    what: "körningen slog i en kvotgräns",
  },
];

/**
 * Console messages that are the weather rather than the app breaking. Kept
 * SEPARATE from tests/app-e2e.mjs's `isProviderNoise`, which is deliberately
 * generous and treats an invalid-API-key message as noise — correct on the
 * console channel of an app being typed a fake key into, and exactly wrong for
 * the visible-text judgement this module makes.
 */
const CONSOLE_NOISE = [
  /failed to load resource/i,
  /the server responded with a status of/i,
  /net::err_/i,
  /\berr_(failed|aborted|connection|name_not_resolved|internet_disconnected|timed_out|cert)/i,
  /failed to fetch|fetch failed|^load failed$/i,
  /\b(401|403|429)\b/,
  /cors|cross-origin|access-control-allow-origin|preflight/i,
  /refused to connect|violates the following content security policy/i,
  /aborterror|the operation was aborted|signal is aborted/i,
  /the document is sandboxed and lacks the '?allow-same-origin'? flag/i,
  /securityerror[^\n]{0,80}(localstorage|sessionstorage|cookie)/i,
  /downloadable font|preload|was not used within a few seconds/i,
];

/**
 * Is this console line ambient noise rather than the page breaking?
 * @param {any} line
 * @returns {boolean}
 */
export function isConsoleNoise(line) {
  const s = textOf(line);
  if (!s.trim()) return true;
  return CONSOLE_NOISE.some((re) => re.test(s));
}

/**
 * Every failure sign present in a piece of text, in declaration order.
 * @param {any} value
 * @returns {Array<{ id: string, lang: string, what: string }>}
 */
export function matchFailureText(value) {
  const s = textOf(value);
  if (!s.trim()) return [];
  const out = [];
  const seen = new Set();
  for (const sign of FAILURE_SIGNS) {
    if (!sign.re.test(s)) continue;
    const key = `${sign.id}:${sign.lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: sign.id, lang: sign.lang, what: sign.what });
  }
  return out;
}

/**
 * The driver's content signature, read back apart.
 *
 * The format is `msgs|steps|finished|answerLen|step|stats` — pinned by
 * tests/capture.mjs's `contentSignature` and by its unit test. Parsed here so
 * the LAST sample of a timeline can be judged ("the run ended with a
 * zero-length answer") without the guard having to import the recorder.
 * @param {any} sig
 * @returns {{ msgs: number, steps: number, finished: number, answerLen: number, step: string, stats: boolean } | null}
 */
export function parseSignature(sig) {
  const s = typeof sig === "string" ? sig : "";
  if (!s) return null;
  const parts = s.split("|");
  if (parts.length < 6) return null;
  const num = (/** @type {string} */ v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };
  return {
    msgs: num(parts[0]),
    steps: num(parts[1]),
    finished: num(parts[2]),
    answerLen: num(parts[3]),
    // The label may itself have contained a separator; everything between the
    // fourth field and the last one is the label.
    step: parts.slice(4, -1).join("|"),
    stats: parts[parts.length - 1] === "1",
  };
}

/**
 * @typedef {Object} ObservedRun   what the driver read off the page at the end
 * @property {string} [agent]
 * @property {string} [mode]
 * @property {string} [answerText]      the last assistant bubble's text, whole
 * @property {boolean} [errorElement]   a `.content.error-text` bubble exists
 * @property {string} [errorText]       that bubble's text
 * @property {boolean} [statsPresent]   the `done` stats footer landed
 * @property {number} [steps]
 * @property {number} [finishedSteps]
 * @property {string[]} [consoleErrors] console errors seen during the run
 * @property {string | null} [lastSignature]  the timeline's final sample
 * @property {boolean} [timedOut]
 * @property {string | null} [driverError]    what captureRun already knew
 * @property {any} [appE2E]             the Agent Studio verdict, when there was one
 * @property {string} [appText]         the built app's visible text after use
 */

/**
 * @typedef {Object} RunVerdict
 * @property {boolean} ok
 * @property {Array<{ id: string, detail: string }>} reasons
 * @property {string} summary  one line, or "" when it passed
 */

/**
 * Did this recording capture the product working? PURE.
 *
 * Every failure is NAMED rather than collapsed into a boolean, because the
 * point of the gate is that a reviewer — or a later session — can read
 * `meta.json` and know what went wrong without decoding an mp4.
 *
 * Garbage in does not throw: an empty record fails with "no assistant answer
 * was observed", which is the right verdict for a run whose end state could not
 * be read at all.
 * @param {ObservedRun} [observed]
 * @returns {RunVerdict}
 */
export function gradeRun(observed = {}) {
  const o = observed && typeof observed === "object" ? observed : {};
  /** @type {Array<{ id: string, detail: string }>} */
  const reasons = [];
  const add = (/** @type {string} */ id, /** @type {string} */ detail) => reasons.push({ id, detail });

  const answer = textOf(o.answerText).trim();
  const errorText = textOf(o.errorText).trim();

  // 1. What the driver already knew. Folded in here so ONE verdict describes
  //    the run — a meta.json with `ok: false` and an empty reason list would be
  //    the same invisibility this gate exists to end.
  if (o.driverError) add("driver_error", `the recorder reported: ${clip(o.driverError, 200)}`);
  if (o.timedOut === true) add("timed_out", "the turn never finished inside the run timeout");

  // 2. The product's own error state. Structural, so it holds for wording this
  //    module has never seen: `setError` puts `error-text` on the bubble
  //    (public/js/turns.js) for every error a turn can hit.
  if (o.errorElement === true) {
    add("error_state", `the answer is rendered as an error${errorText ? `: ${clip(errorText, 200)}` : ""}`);
  }

  // 3. The words on screen — the transcript and, for an Agent Studio run, the
  //    published app the capture walked to and used.
  for (const hit of matchFailureText(errorText)) {
    add(`error_text:${hit.id}`, `${hit.what} (${hit.lang}) — ${clip(errorText, 160)}`);
  }
  for (const hit of matchFailureText(answer)) {
    add(`answer_text:${hit.id}`, `${hit.what} (${hit.lang}) — ${clip(answer, 160)}`);
  }
  const appText = textOf(o.appText).trim();
  for (const hit of matchFailureText(appText)) {
    add(`app_text:${hit.id}`, `the built app's own screen: ${hit.what} (${hit.lang}) — ${clip(appText, 160)}`);
  }

  // 4. Nothing to show. A blank or one-line assistant bubble is the failure the
  //    owner saw as a blank final frame, and no phrase list can catch it.
  if (!answer) {
    add("empty_answer", "no assistant answer was observed on the page at the end of the run");
  } else if (answer.length < MIN_ANSWER_CHARS) {
    add("empty_answer", `the answer is ${answer.length} characters — too short to be one: ${clip(answer, 160)}`);
  }

  // 5. The turn never reported done. Skipped when the timeout already said so,
  //    which is the same fact from the other side.
  if (o.statsPresent === false && o.timedOut !== true) {
    add("turn_unfinished", "the turn never reported its completion stats");
  }

  // 6. The timeline's last sample. A run whose final signature is missing was
  //    never observed reaching a resting state; one whose final answer length
  //    is zero ended on an empty bubble, whatever the DOM read said.
  const last = parseSignature(o.lastSignature);
  if (o.lastSignature != null && !last) {
    add("no_final_content", "the timeline's last sample is not a readable content signature");
  } else if (o.lastSignature == null) {
    add("no_final_content", "the timeline recorded no final content signature");
  } else if (last && last.answerLen === 0) {
    add("no_final_content", "the run's last sampled frame had no assistant text on it");
  }

  // 7. The Agent Studio app gate, when it ran (tests/app-e2e.mjs).
  const app = o.appE2E && typeof o.appE2E === "object" ? o.appE2E : null;
  if (app && app.pass === false) {
    const failures = Array.isArray(app.failures) ? app.failures : [];
    add("app_e2e", `the built app failed its end-to-end test: ${clip(failures.join("; ") || "no detail", 240)}`);
  }

  // 8. The page throwing on its own account.
  const console_ = (Array.isArray(o.consoleErrors) ? o.consoleErrors : []).map(textOf).filter((s) => !isConsoleNoise(s));
  if (console_.length) {
    add("page_errors", `${console_.length} uncaught page error${console_.length === 1 ? "" : "s"}: ${clip(console_.slice(0, 3).join(" | "), 240)}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    summary: reasons.length ? reasons.map((r) => r.detail).join("; ") : "",
  };
}

/**
 * The verdict as the block a batch summary prints — LOUD, because the whole
 * failure being addressed is a bad run that looked fine in the terminal.
 * Total: a summary that throws on an odd verdict is a summary nobody can print.
 * @param {any} verdict
 * @param {string} [slug]
 * @returns {string}
 */
export function formatRunVerdict(verdict, slug = "") {
  const v = verdict && typeof verdict === "object" ? verdict : {};
  const reasons = Array.isArray(v.reasons) ? v.reasons : [];
  const head = `run ${v.ok === true ? "✓ VERIFIED" : "✗ FAILED VERIFICATION"}${slug ? `  ${slug}` : ""}`;
  if (v.ok === true) return head + "\n";
  const lines = [head];
  if (!reasons.length) lines.push("    (no reasons recorded — the end state could not be read)");
  for (const r of reasons) {
    const o = r && typeof r === "object" ? r : {};
    lines.push(`    ✗ ${String(o.id || "?").padEnd(24)} ${clip(String(o.detail || ""), 200)}`);
  }
  lines.push("  do NOT present this clip as a good capture.");
  return lines.join("\n") + "\n";
}

/** @param {any} v */
function textOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.text === "string") return v.text;
  return v == null ? "" : String(v);
}

/** @param {any} s @param {number} max */
function clip(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
