// @ts-check
// THE MCP TOOL SEAM OF THE EXTENSION REGISTRY — which third-party capabilities
// are callable as tools, and which extension each one belongs to.
//
// src/extensions.js owns the six seams an integration has inside a CHAT turn
// (its knob, its request state, its enrichment, its log meta, its capability
// line, and the agent context block that decides who may reach it). This module
// owns the seventh, which lives outside a chat turn entirely: the tools an
// external agent can call over /mcp.
//
// It is a SEPARATE module rather than another field on the descriptors for one
// reason, and it is a hard one. src/mcp-config.js — the per-account exposure
// config — must know every tool id that can exist, and it is a pure leaf: it
// imports nothing, which is what lets src/mcp.js hold it statically without
// dragging the pipeline into src/mcp.test.js. src/extensions.js is not pure (it
// imports the enrichment runners, which import the provider clients), so
// importing it from mcp-config.js would pull berget.js into the config layer.
// Splitting the tool seam into this pure module keeps both properties: one
// registry of tools, importable from anywhere.
//
// The rule it inherits is the important one: **src/mcp.js never names a
// service.** It asks this module which tools exist, which extension a tool
// belongs to, and which of them spend money; the answer to "may this account use
// it" comes from the same per-account knob the chat enrichment obeys, and the
// runner arrives behind a dynamic import (src/extension-tools-run.js). Adding an
// integration's tools is an entry here plus its own two modules — no core file
// is edited, exactly as invariant 7 requires.

import { MAPS_MCP_TOOLS } from "./maps-tools.js";
import { SHODAN_MCP_TOOLS } from "./shodan-tools.js";

/**
 * One integration's tool family.
 *
 * `extension` is the src/extensions.js descriptor id, and it is what ties a tool
 * to the account knob that consents to reaching that third party. `group` and
 * `blurb` are the Settings-screen copy, in the same shape as the core catalog
 * entries in src/mcp-config.js. `spends` marks a tool that reaches a metered API
 * (and so takes a concurrency slot and passes the research quota gate) —
 * everything registered here does, but the flag stays explicit because the day
 * one of them stops spending, forgetting to say so would silently meter a free
 * call.
 *
 * @typedef {{
 *   extension: string,
 *   group: string,
 *   tools: Array<{ name: string, description: string, input_schema: any }>,
 *   blurbs: Record<string, string>,
 *   spends: string[],
 * }} ExtensionToolFamily
 */

/** @type {ExtensionToolFamily[]} */
export const EXTENSION_TOOL_FAMILIES = [
  {
    extension: "maps",
    group: "Places & imagery",
    tools: MAPS_MCP_TOOLS,
    blurbs: {
      street_view_look:
        "Stands at an address or coordinate, optionally walks a given distance in a given " +
        "direction, and describes what is actually visible there in words — including an " +
        "answer to a question about the view. Imagery is fetched and described server-side; " +
        "no pictures are returned. Costs an imagery lookup plus one vision-model description, " +
        "and needs the Google Maps & Street View knob on.",
      place_nearby:
        "Lists places near a standpoint with each one's distance and compass direction. " +
        "One place-search request, no imagery, and needs the same knob.",
    },
    spends: ["street_view_look", "place_nearby"],
  },
  {
    extension: "shodan",
    group: "Host intelligence",
    tools: SHODAN_MCP_TOOLS,
    blurbs: {
      host_intel:
        "Looks up what an internet-facing host is running, or searches Shodan's index. " +
        "Reads records Shodan already holds — nothing is scanned — and needs the Shodan " +
        "host intelligence knob on.",
      host_search:
        "Searches Shodan's index for machines matching a query, and counts how many match " +
        "in total — broken down by country, port, product or organization. The population " +
        "question rather than the single-host one; same knob, nothing scanned.",
      domain_intel:
        "Lists a domain's known subdomains and DNS records from Shodan's DNS database, " +
        "including names that were never scanned. Stored observations, not a live lookup.",
      cve_intel:
        "Explains a CVE — severity, exploitation probability, known-exploited status, " +
        "affected products — or lists the vulnerabilities affecting a product. Reads " +
        "Shodan's public vulnerability database, which costs no query credits.",
    },
    // Every one of these reaches Shodan, so every one is metered and gated. That
    // includes cve_intel, whose upstream is free: the flag decides whether the
    // call passes the research quota gate and takes a concurrency slot, and an
    // outbound tool with neither is an unbounded one (docs/MCP-COST.md §4b).
    spends: ["host_intel", "host_search", "domain_intel", "cve_intel"],
  },
];

/** Every extension tool definition, in registry order, in MCP's key shape
 * (`inputSchema`, where the shared definitions use Anthropic's `input_schema`). */
export const EXTENSION_MCP_TOOLS = EXTENSION_TOOL_FAMILIES.flatMap((family) =>
  family.tools.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema })),
);

/** Tool name → the extensions.js descriptor id that owns it. */
export const EXTENSION_TOOL_EXTENSION = Object.fromEntries(
  EXTENSION_TOOL_FAMILIES.flatMap((family) => family.tools.map((tool) => [tool.name, family.extension])),
);

/** Tool name → the Settings-screen label of the knob that must be on. Used only
 * for the refusal message; the decision itself is settings.js's. */
export const EXTENSION_TOOL_LABEL = Object.fromEntries(
  EXTENSION_TOOL_FAMILIES.flatMap((family) => family.tools.map((tool) => [tool.name, family.group])),
);

/** @type {Set<string>} */
export const EXTENSION_TOOL_NAMES = new Set(Object.keys(EXTENSION_TOOL_EXTENSION));

/** The subset that reaches a metered API — src/mcp.js folds this into its
 * spending set, so these hold a concurrency slot and pass the quota gate. */
export const EXTENSION_SPENDING_TOOLS = new Set(EXTENSION_TOOL_FAMILIES.flatMap((f) => f.spends));

/** The per-account exposure catalog rows for these tools, in the shape
 * src/mcp-config.js's MCP_TOOL_CATALOG uses. Default ON like every other tool:
 * the knob is what keeps a third-party call opt-in, and making an account flip
 * two switches to reach one capability is a way to make it look broken. */
export const EXTENSION_MCP_CATALOG = EXTENSION_TOOL_FAMILIES.flatMap((family) =>
  family.tools.map((tool) => ({
    id: tool.name,
    group: family.group,
    label: tool.name,
    blurb: family.blurbs[tool.name] || "",
    def: true,
  })),
);

/**
 * What to tell a caller whose account has the tool exposed but the extension's
 * knob off. Written for the client's MODEL, which will decide what to do next:
 * it must not read as a bug, a rate limit, or something a retry fixes, because
 * none of those is true — a person has to turn it on.
 * @param {string} name
 * @returns {string}
 */
export function extensionOffMessage(name) {
  const group = EXTENSION_TOOL_LABEL[name] || "this integration";
  return (
    `The ${name} tool is available on this server but switched off for this account: ` +
    `"${group}" is an opt-in integration that sends data to a third party, so it stays off ` +
    `until the account holder enables it in Settings. Nothing was looked up and nothing was ` +
    `spent. Retrying will not help — answer from what you already know, or ask them to enable it.`
  );
}
