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
