// @ts-check
// Country-of-processing badges for the model / provider selectors.
//
// Every LLM provider processes the conversation wherever it is hosted, so each
// selector prefixes a provider (or a model) with the flag of that destination:
// data goes where your provider resides. Berget is EU (Sweden); OpenAI,
// Anthropic and Groq are US. A local / on-device option — nothing leaves the
// browser — gets NO flag.
//
// Pure, dependency-free and SHARED so the mapping lives in exactly one place:
// the DRS composer dropdown (`models.js`), the /cure provider picker + model
// dropdown (`cure/drc.js`, `cure/index.html`), and the introspection route
// picker (`introspect-core.js`) all read from here. Node-testable.

/** @typedef {{ country: string, flag: string }} Region */

/** @type {Record<string, Region>} */
export const PROVIDER_REGIONS = {
  berget: { country: "Sweden", flag: "🇸🇪" },
  openai: { country: "United States", flag: "🇺🇸" },
  anthropic: { country: "United States", flag: "🇺🇸" },
  groq: { country: "United States", flag: "🇺🇸" },
};

/**
 * The processing region for a provider key ("berget" | "openai" | "anthropic"
 * | "groq"), or null for an unknown / local one (render no flag). Never throws.
 * @param {unknown} providerKey
 * @returns {Region | null}
 */
export function regionForProvider(providerKey) {
  if (typeof providerKey !== "string") return null;
  return PROVIDER_REGIONS[providerKey.toLowerCase()] || null;
}

/**
 * The flag for a provider key, or "" for unknown / local. Never throws.
 * @param {unknown} providerKey
 * @returns {string}
 */
export function flagForProvider(providerKey) {
  const r = regionForProvider(providerKey);
  return r ? r.flag : "";
}

/**
 * The processing region for a DRS `/api/models` catalog entry. The catalog
 * marks secondary providers explicitly (`provider: "anthropic" | "openai"`); a
 * Berget entry has no `provider` field, so an absent one means Berget.
 * @param {{ provider?: string } | null | undefined} entry
 * @returns {Region | null}
 */
export function regionForModelEntry(entry) {
  return regionForProvider(entry?.provider || "berget");
}

/**
 * A flag-prefixed label: `"🇸🇪 Mistral Small"`. With no flag the name is
 * returned unchanged (a local option). Never throws.
 * @param {string} flag
 * @param {string} name
 * @returns {string}
 */
export function labelWithFlag(flag, name) {
  return flag ? `${flag} ${name}` : String(name ?? "");
}
