// @ts-check
// Server façade over the shared citation-reconciliation core.
//
// The core lives under public/js/ because the Se/cure tier imports it directly
// in the browser (CLAUDE.md "Code layout"); this re-export is how the Worker
// reaches the same implementation. The exports must BE the core's functions —
// src/facade-contract.test.js discovers this file and pins that identity, so a
// re-implementation here cannot quietly ship.
export { citationAudit, citationNote, citationNumbers, splitSourcesTail } from "../public/js/citations-core.js";
