// Shared by account.js's message-center admin section and admin.js's full
// notification center — the pieces of alert/pending-user rendering that are
// genuinely identical between the two views (their surrounding markup and
// verbosity differ deliberately, per CLAUDE.md's admin-has-more-features
// design, so only the truly shared fragments live here).

/**
 * @param {*} s  coerced to string
 * @returns {string} with &<>"' HTML-entity-escaped
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * Abbreviated count for tight UI slots — "12.3K", "4M". One implementation
 * for admin.js's usage tables and account-views.js's usage bars (the two
 * carried byte-identical copies).
 * @param {*} v  coerced to a number, NaN → 0
 * @returns {string}
 */
export function formatCount(v) {
  const n = Number(v) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(n);
}

// The alert severity badge — identical markup in both views.
export function alertSeverityBadge(alert) {
  const cls = alert.severity === "critical" ? "critical" : "pending";
  return `<span class="badge ${cls}">${escapeHtml(alert.severity)}</span>`;
}

// "New sign-in awaiting approval: NAME" — identical text in both views'
// pending-user rows (only the surrounding markup differs).
export function pendingApprovalLine(user) {
  return `New sign-in awaiting approval: ${escapeHtml(user.name || user.email)}`;
}
