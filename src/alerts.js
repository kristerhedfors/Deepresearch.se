// Operational alerts: surfaces production issues (Berget errors, wallet
// depletion, etc.) in the admin panel and as a notification badge, instead
// of only living in Workers Logs where nobody's looking. Rows are
// upserted by `type` (a small, stable set of buckets) rather than one row
// per occurrence — a recurring issue bumps `count`/`last_seen_at` and
// un-acknowledges itself (worth re-surfacing), rather than flooding the
// table. Fails soft: no DB binding means alerts are silently a no-op, same
// as every other D1-backed feature in this app.

import { getDb } from "./db.js";

// Classifies a caught pipeline error into a stable alert type + severity +
// human message. Keep this list small and meaningful — it's read by admins,
// not a log dump. Unmatched errors fall into a generic bucket rather than
// each becoming their own type.
export function classifyChatError(message) {
  const msg = String(message || "");
  if (/INSUFFICIENT_WALLET_BALANCE|insufficient_quota/i.test(msg)) {
    return {
      type: "berget_insufficient_balance",
      severity: "critical",
      message: "Berget wallet balance is depleted — every research request will fail until it's topped up at berget.ai.",
    };
  }
  if (/empty response \d+ times? in a row/i.test(msg)) {
    return {
      type: "chat_empty_completion",
      severity: "warning",
      message: "A model returned an empty response for a research request even after retrying (see model-profiles.js's maxCompletionAttempts).",
    };
  }
  if (/finish_reason.*dropped connection/i.test(msg)) {
    return {
      type: "chat_dropped_stream",
      severity: "warning",
      message: "A model's response stream dropped mid-flight with no error frame (Berget-side connection instability).",
    };
  }
  return {
    type: "chat_stream_failed",
    severity: "warning",
    message: "A research request failed with an unexpected error.",
  };
}

// Maps an Exa search-backend failure (src/exa.js's exaErrorKind) to a
// stable operational alert, or null for transient kinds not worth
// surfacing to an admin. The Exa credit-exhaustion case is the direct
// analogue of Berget wallet depletion above: a 402 makes EVERY search
// return zero results, so a research run silently degrades to an ungrounded
// answer with no visible signal that the search provider is the problem —
// exactly the kind of invisible outage this alert center exists to catch.
// Rate-limits and one-off HTTP/network blips are transient and return null
// so they don't flap the notification badge.
export function exaSearchAlert(kind) {
  if (kind === "no_credits") {
    return {
      type: "exa_insufficient_credits",
      severity: "critical",
      message: "Exa web-search credits are exhausted — every research query returns zero results, so answers fall back to ungrounded model knowledge until credits are topped up at dashboard.exa.ai.",
    };
  }
  if (kind === "auth") {
    return {
      type: "exa_auth_failed",
      severity: "critical",
      message: "Exa rejected the API key (401/403) — web search is failing for every request until the EXA_API_KEY secret is fixed.",
    };
  }
  return null;
}

// Suggested remediation per alert type — looked up at READ time (not
// stored on the row) so wording improvements apply retroactively to
// existing rows and don't require a migration. Keyed by the same stable
// types classifyChatError() produces; unmatched/custom types (a future
// raiseAlert() call this file doesn't know about yet) fall back to a
// generic "check Workers Logs" pointer rather than showing nothing.
const REMEDIATIONS = {
  berget_insufficient_balance:
    "Top up the Berget.ai account balance in their dashboard (billing/wallet section) — every research request fails until it's funded again. Confirm it's resolved by sending any chat message; a 402 error means it's still empty.",
  chat_empty_completion:
    "Usually a transient model quirk — the pipeline already retries once automatically before this fires, so this alert means BOTH attempts came back empty. If one specific model keeps recurring here, consider a model-profiles.js override (e.g. widening the retry) once the pattern is clearly evidenced across several occurrences, not a one-off.",
  chat_dropped_stream:
    "Known Berget-side connection instability for certain models, not fixable from this codebase — see tests/MODEL-EVAL-FINDINGS.md's open issues. No action needed unless the rate climbs sharply; that would suggest a new, different root cause worth investigating via Workers Logs.",
  chat_stream_failed:
    "Check Workers Logs for the chat.stream_failed event (search by request id or timeframe) to see the actual error — this is a catch-all for failures that don't match a more specific known pattern yet.",
  exa_insufficient_credits:
    "Top up Exa search credits at dashboard.exa.ai — until then every query returns HTTP 402 and research answers are ungrounded (no web sources). Confirm it's resolved by running any web-search request and checking the sources list is populated again.",
  exa_auth_failed:
    "Verify the EXA_API_KEY secret in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) — Exa is returning 401/403, so the key is missing, revoked, or wrong. Re-set it, then send any web-search request to confirm results return.",
};
const DEFAULT_REMEDIATION = "Check Workers Logs for this alert's timeframe to see the underlying error in full.";

function withRemediation(row) {
  return { ...row, remediation: REMEDIATIONS[row.type] || DEFAULT_REMEDIATION };
}

export async function raiseAlert(env, type, severity, message, detail) {
  const db = await getDb(env);
  if (!db) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO alerts (type, severity, message, detail, count, first_seen_at, last_seen_at, acknowledged_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, NULL)
       ON CONFLICT(type) DO UPDATE SET
         severity = excluded.severity,
         message = excluded.message,
         detail = excluded.detail,
         count = count + 1,
         last_seen_at = excluded.last_seen_at,
         acknowledged_at = NULL`,
    )
    .bind(type, severity, message, detail ? String(detail).slice(0, 500) : null, now, now)
    .run()
    .catch(() => {}); // best-effort — an alerting bug must never break the chat
}

export async function listAlerts(env) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare(`SELECT * FROM alerts ORDER BY (acknowledged_at IS NOT NULL), last_seen_at DESC`)
    .all();
  return (results || []).map(withRemediation);
}

export async function countOpenAlerts(env) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL`).first();
  return row?.n || 0;
}

export async function acknowledgeAlert(env, id) {
  const db = await getDb(env);
  if (!db) return;
  await db.prepare(`UPDATE alerts SET acknowledged_at = ? WHERE id = ?`).bind(Date.now(), id).run();
}
