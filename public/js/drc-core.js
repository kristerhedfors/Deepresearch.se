// DRC's pure core (DRC = "deep research secure", C for CLIENT-side — the
// public tier at /cure; its remote sibling DRS, "deep research server",
// is the signed-in app at /rver). The page (public/cure/drc.js) wires
// this to the DOM: everything derivable and everything cryptographic,
// built on the project-vault primitives (vault.js) so DRC invents no new
// crypto.
//
// ONE master secret (the vault's DR1-… format — generated with the same
// 160-bit CSPRNG routine, saved in the user's password manager) is the
// user's entire keyring. HKDF-SHA-256 with INDEPENDENT info strings derives
// every downstream value, so no derived value reveals any other or the
// secret itself:
//
//   refHash — 80 bits, the PUBLIC project reference: the <hash> in
//       /my/project-<hash> and the username field the password manager
//       files the secret under. A bookmark label, deliberately NOT a
//       capability — knowing it grants nothing.
//   blobId / blobKey — where the sealed project state rests (the
//       BROWSER-LOCAL store, drc-store.js) and the AES-256-GCM key it is
//       sealed with. Neither ever leaves the browser in any form.
//
// The provider API keys (OpenAI / Groq / Berget) live INSIDE the sealed state and
// go straight from the browser to the provider (drc-providers.js) — for
// DRC the Deepresearch server serves static files and public replay JSONs
// and is in NO other path: it never sees a key, a message, or the state.
// The state blob reuses the vault's archive sealing verbatim
// (encryptVaultArchive/decryptVaultArchive — 12-byte IV + AES-256-GCM).
//
// NOTE: the HKDF info strings and the state-kind constant below predate
// the DRC name ("…free…") and are FROZEN — they are derivation/format
// constants; changing them would silently break every existing secret
// and sealed state.

// Imported from the vault's PURE core module — NOT vault.js: vault.js's
// store/load orchestration statically imports the DRS storage stack
// (history-store/opfs/projects), which is not publicly served, and a 401
// anywhere in the /cure module graph kills the whole client tier (found
// live 2026-07-11: /cure was dead with the static "d5" stamp because this
// import pulled that chain in). vault-core.js is dependency-free and
// allowlisted in src/index.js's isPublicAsset.
import {
  bytesToB64,
  decodeCrockford,
  decryptVaultArchive,
  encodeCrockford,
  encryptVaultArchive,
  generateVaultSecret,
  normalizeVaultSecret,
  vaultSecretValid,
} from "./vault-core.js";

export {
  generateVaultSecret as generateDrcSecret,
  normalizeVaultSecret,
  vaultSecretValid as drcSecretValid,
  bytesToB64,
};

export const DRC_STATE_KIND = "deepresearch-free-project";
// v2 moved the provider keys into the sealed state; v3 added the client-
// side RAG index (rag — drc-rag.js), sealed like everything else; v4 added
// localBaseUrl (the user's own local/custom OpenAI-compatible inference
// server — drc-providers.js's keyless `local` entry); v5 added onDevice
// (the phone-local Bonsai inference knob — ondevice-engine.js).
export const DRC_STATE_V = 5;

// ---- derivation ---------------------------------------------------------------

async function hkdfMaster(secret) {
  const ikm = decodeCrockford(normalizeVaultSecret(secret));
  return crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
}

const HKDF = (info) => ({
  name: "HKDF",
  hash: "SHA-256",
  salt: new Uint8Array(32),
  info: new TextEncoder().encode(info),
});

/**
 * Everything the DRC page needs, from the one secret.
 * @param {string} secret
 * @returns {Promise<{refHash: string, blobId: string, blobKey: CryptoKey}>}
 */
export async function deriveDrcProfile(secret) {
  if (!vaultSecretValid(secret)) {
    throw new Error("That doesn't look like a valid secret (DR1-… with 32 characters).");
  }
  const master = await hkdfMaster(secret);
  const bits = (info, n) => crypto.subtle.deriveBits(HKDF(info), master, n);
  const refHash = encodeCrockford(new Uint8Array(await bits("deepresearch.se free ref v1", 80))).toLowerCase();
  const blobId = encodeCrockford(new Uint8Array(await bits("deepresearch.se free blob id v1", 160)));
  const blobKey = await crypto.subtle.deriveKey(
    HKDF("deepresearch.se free blob key v1"),
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { refHash, blobId, blobKey };
}

// ---- the project state --------------------------------------------------------

// {v, kind, updatedAt, keys: {openai?, groq?, berget?}, providerId?, model?,
//  research, conversations: [{id, title, messages, createdAt, updatedAt}],
//  rag: {embedder?, docs: []}}
// — everything the page persists, the provider API keys AND the RAG index
// (chunk text + vectors, drc-rag.js) included, sealed as one blob under
// blobKey. Conversations are plain {role, content} text turns.
export function emptyDrcState() {
  return {
    v: DRC_STATE_V,
    kind: DRC_STATE_KIND,
    updatedAt: Date.now(),
    keys: {},
    providerId: null,
    model: null,
    research: true,
    // The research time target in seconds the composer slider sets — the
    // Se/rver slider mirrored (public/js/timescale.js, 15 s–10 min): the roof
    // on research time AND the report tier it buys (drc-research.js
    // drcPlanForBudget). Absent (older blobs) or garbage reads as the 60 s
    // default — the pre-slider behavior — so no version bump is needed. (A
    // short-lived interim shape stored a `depth` TIER ID instead; migration
    // maps it onto this time scale.)
    budgetS: 60,
    // Experimental in-browser Linux execution sandbox (the DRC counterpart of
    // the server's bash_lite_mcp knob). Default OFF; an absent field (older
    // blobs) reads as off. Purely client-side here, like everything in DRC.
    bashLite: false,
    // Developer mode (the DRC counterpart of the server's developer_mode
    // knob): unlocks introspection mode — the deployed source snapshot as
    // context (fetched as a public static file; the server stays out of the
    // data path) and, with bashLite also on, the /src sandbox mount. Default
    // OFF; an absent field (older blobs) reads as off.
    developerMode: false,
    // The per-user web-search BACKEND (public/js/websearch-backends-core.js).
    // Se/cure is the expert tier, so it can point web search at the user's OWN
    // self-hosted service, called STRAIGHT from the browser (server in no data
    // path). "grant" = the default server-proxied grant path (used only when a
    // grant is present); "searxng" / "exa_compatible" = a browser-direct
    // self-hosted service. `key` lives inside the sealed state like the provider
    // keys. Absent (older blobs) reads as the grant default.
    searchBackend: { backend: "grant", baseUrl: "", key: "", results: 6 },
    // The user's own OpenAI-compatible LOCAL inference server (Ollama /
    // LM Studio / llama.cpp): the base URL the keyless `local` provider
    // entry (drc-providers.js) calls, e.g. http://localhost:11434/v1.
    // Setting it is what "configures" that provider (no API key exists);
    // with it, model calls leave for the user's OWN machine and no third
    // party receives the conversation at all. Empty/absent (older blobs)
    // reads as not configured.
    localBaseUrl: "",
    // ON-DEVICE inference (the phone-local Bonsai models — ondevice-engine.js,
    // docs/BONSAI-27B-PHONE-INFERENCE.md): the settings knob that reveals the
    // feature. Default OFF and absent-reads-as-off (older blobs) — while off,
    // not a byte of the engine, runtime, or weights loads (the bandwidth
    // guarantee); the weights themselves download only through the explicit
    // consent popup, never from flipping this.
    onDevice: false,
    conversations: [],
    rag: { docs: [] },
  };
}

/** @param {any} s @returns {boolean} */
export function validateDrcState(s) {
  const ok = !!(
    s &&
    typeof s === "object" &&
    (s.v === 1 || s.v === 2 || s.v === 3 || s.v === 4 || s.v === DRC_STATE_V) && // older blobs still open
    s.kind === DRC_STATE_KIND &&
    Array.isArray(s.conversations) &&
    s.conversations.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        Array.isArray(c.messages) &&
        c.messages.every((m) => m && typeof m.role === "string" && typeof m.content === "string"),
    )
  );
  return (
    ok &&
    (s.keys === undefined || (s.keys && typeof s.keys === "object" && !Array.isArray(s.keys))) &&
    (s.rag === undefined || (s.rag && typeof s.rag === "object" && Array.isArray(s.rag.docs))) &&
    (s.localBaseUrl === undefined || typeof s.localBaseUrl === "string") &&
    (s.onDevice === undefined || typeof s.onDevice === "boolean") &&
    (s.budgetS === undefined || typeof s.budgetS === "number")
  );
}

/** Upgrades any accepted stored shape to the current one, in place. */
export function migrateDrcState(s) {
  s.v = DRC_STATE_V;
  if (!s.keys || typeof s.keys !== "object") s.keys = {};
  if (s.research === undefined) s.research = true;
  if (s.providerId === undefined) s.providerId = null;
  if (!s.rag || typeof s.rag !== "object" || !Array.isArray(s.rag.docs)) s.rag = { docs: [] };
  if (typeof s.localBaseUrl !== "string") s.localBaseUrl = "";
  if (typeof s.onDevice !== "boolean") s.onDevice = false;
  if (typeof s.budgetS !== "number" || !Number.isFinite(s.budgetS)) {
    // The interim depth-tier shape (2026-07-16, lived less than a day) stored
    // a tier ID; map it onto the time scale it stood for. Everything older
    // gets the 60 s default — the pre-slider behavior.
    s.budgetS = { brief: 30, standard: 60, extended: 240, full: 480 }[s.depth] || 60;
  }
  delete s.depth;
  return s;
}

/**
 * @param {object} state
 * @param {CryptoKey} blobKey
 * @returns {Promise<Uint8Array>} the wire/stored form
 */
export function sealDrcState(state, blobKey) {
  return encryptVaultArchive(state, blobKey);
}

/**
 * @param {Uint8Array} bytes
 * @param {CryptoKey} blobKey
 * @returns {Promise<object>} throws on wrong key/tamper; caller validates shape
 */
export function openDrcState(bytes, blobKey) {
  return decryptVaultArchive(bytes, blobKey);
}

// ---- encrypted backup (.drc file export/import) --------------------------------
//
// A Se/cure project's ONLY copy is one browser's localStorage, which the
// browser may silently evict (iOS Safari especially) — so the sealed blob
// can be downloaded as a `.drc` file and restored later, on this device or
// another. The file IS the stored ciphertext (putSealedProject's bytes),
// nothing re-encrypted and nothing new invented: opening it takes the same
// DR1-… secret, so the file is exactly as unreadable at rest as the
// localStorage row it mirrors.

// The export filename carries the public reference so a folder of backups
// is tellable apart — the refHash is deliberately NOT a capability, so the
// name reveals nothing (see the derivation notes above).
/** @param {string} refHash */
export function drcBackupFileName(refHash) {
  return "project-" + refHash + ".drc";
}

/**
 * Open an exported .drc backup with its secret: derive the profile,
 * decrypt, validate, migrate — the store's own open path, fed from a file.
 * Returns null on a wrong secret, tampered/corrupted file, or unrecognized
 * shape (fail-soft: the caller shows one message, never a crash).
 * @param {Uint8Array} bytes
 * @param {string} secret
 * @returns {Promise<{profile: {refHash: string, blobId: string, blobKey: CryptoKey}, state: any} | null>}
 */
export async function openDrcBackup(bytes, secret) {
  if (!vaultSecretValid(secret)) return null;
  try {
    const profile = await deriveDrcProfile(secret);
    const opened = await openDrcState(bytes, profile.blobKey);
    if (!validateDrcState(opened)) return null;
    return { profile, state: migrateDrcState(opened) };
  } catch {
    return null; // wrong secret or tamper — AES-GCM authentication failed
  }
}

// A conversation's display title: its first user line, like the main app.
/** @param {{role: string, content: string}[]} messages */
export function deriveDrcTitle(messages) {
  const first = messages.find((m) => m.role === "user")?.content || "New chat";
  const line = first.split("\n").find((l) => l.trim()) || "New chat";
  return line.trim().slice(0, 80);
}
