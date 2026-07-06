// Per-user "History Key": lets the browser encrypt/decrypt its own
// locally-stored chat history (public/js/history-store.js) without the
// server ever seeing conversation content.
//
// Threat model this is built for:
//   - Offline extraction of the browser's storage (an IndexedDB file pulled
//     from a stolen device or a disk image) recovers only ciphertext — this
//     key is fetched fresh, once per page load, over an authenticated
//     request, and is NEVER written to any persistent browser storage
//     (not localStorage, not IndexedDB), so it isn't there to find at rest.
//   - A server compromise recovers HISTORY_KEY_SECRET (and could therefore
//     derive any given user's key on demand), but recovers no ciphertext —
//     conversation content itself never leaves the browser, ever.
//   - Only the COMBINATION — a live compromise able to mint the key, AND
//     access to that specific browser's storage — can decrypt anything.
//     That is disclosed as a limitation at /help/, not hidden.
//
// Derivation is deterministic (HMAC-SHA256, same construction as auth.js's
// session HMAC): the same signed-in identity always re-derives the same
// key. This does not sync history across devices — each browser's
// IndexedDB is its own — it only means one identity never needs a stored
// key, just the ability to re-authenticate.
//
// Fails closed like auth.js's admin secrets: without HISTORY_KEY_SECRET
// configured, callers must not fall back to an unencrypted alternative —
// that would defeat the entire point.

export function historyKeyConfigured(env) {
  return !!env.HISTORY_KEY_SECRET;
}

export async function deriveHistoryKey(env, userId) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.HISTORY_KEY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`history-key.v1.${userId}`));
  return bufToBase64(sig);
}

function bufToBase64(buf) {
  let binary = "";
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
