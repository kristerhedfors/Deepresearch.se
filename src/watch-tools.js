// @ts-check
// The NHxx watch builder AS A TOOL FAMILY — the MCP side of feedback #52
// ("Make it an mcp server with a bunch of tools").
//
// Six tools over the SAME pure core the inline chat builder runs on
// (public/js/watch-core.js + public/js/watch-chat-core.js, via the src/watch.js
// and src/watch-chat.js façades), so an external agent, a shell in the sandbox
// and a chat turn all get the identical catalogue, the identical compatibility
// verdict and the identical text-command parser:
//
//   watch_catalog     what exists — the slots, or one slot's options in full
//   watch_case        one case family's real millimetres and platform
//   watch_build       resolve a build → spec sheet, fit check, permalink
//   watch_command     apply plain-language commands → new build + what changed
//   watch_check       compatibility only, for a build an agent is considering
//   watch_sourcing    where the parts come from, with price bands
//
// TWO PROPERTIES WORTH KEEPING.
//
//   NO NETWORK, EVER. Every answer is derived from committed data. The
//   AliExpress rows are a curated SEARCH index — query strings and price bands
//   — so watch_sourcing builds URLs as strings and never fetches one
//   (docs/WATCH-BUILDER.md §4). Nothing here can leak a caller's build, and
//   nothing here can fail because a listing disappeared.
//
//   NO MODEL, EITHER. watch_command is the regex parser, not an LLM call, so
//   the tool family costs nothing to run and cannot fail soft into nonsense.
//   That also keeps invariant 1 intact: these tools are what an agent calls
//   INSTEAD of the pipeline reaching for function calling.
//
// Definitions carry Anthropic's `input_schema` key, matching src/sdk-tools.js —
// src/mcp.js renames it to MCP's `inputSchema` when it lists them. Every tool
// returns TEXT (JSON, pretty-printed): an MCP result is text content, and a
// model reads a labelled JSON object more reliably than prose.

import {
  CASES,
  PLATFORMS,
  SLOTS,
  SOURCES,
  buildSpec,
  caseIndex,
  checkBuild,
  decodeBuild,
  encodeBuild,
  normalizeBuild,
  slotOptions,
  sourcingFor,
} from "./watch.js";
import { changeSummary, parseWatchCommand, suggestCommands } from "./watch-chat.js";

/** Every tool name this module serves, for src/mcp.js's dispatch check. */
export const WATCH_TOOL_NAMES = new Set([
  "watch_catalog",
  "watch_case",
  "watch_build",
  "watch_command",
  "watch_check",
  "watch_sourcing",
]);

const SLOT_KEYS = SLOTS.map((s) => s.key);

// A build argument is accepted three ways, because the three callers differ: an
// agent that has ids uses `build`, one that has a permalink from the /watch/
// page or a chat turn uses `code`, and one that has neither gets the default.
const BUILD_ARG = {
  build: {
    type: "object",
    description:
      "The build as slot → part id, e.g. {\"case\":\"62mas\",\"dial\":\"62mas-cream\"}. " +
      `Slots: ${SLOT_KEYS.join(", ")}. Any slot left out (or naming an unknown ` +
      "part) falls back to the default build's part, so a partial object is valid.",
  },
  code: {
    type: "string",
    description:
      "A permalink code instead of `build` — the \"slot:id;slot:id\" string the " +
      "/watch/ page puts in its URL fragment and every tool here returns as `code`.",
  },
};

export const WATCH_TOOLS = [
  {
    name: "watch_catalog",
    description:
      "What the NHxx watch builder can build. With no arguments: the movement " +
      "family's fixed dimensions, every case with its real millimetres, and the " +
      "list of slots. With `slot`: that parts family in full, every option with " +
      "its ids, names and specs. This is the tool to call FIRST — the other " +
      "tools take part ids from it.",
    input_schema: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          description: `One parts family to expand. One of: ${SLOT_KEYS.join(", ")}.`,
          enum: SLOT_KEYS,
        },
      },
    },
  },
  {
    name: "watch_case",
    description:
      "One case family in full: diameter, lug-to-lug, thickness, lug width, " +
      "water resistance, crown position, which parts platform it shares, and " +
      "whether the figures are spec-sheet or listing (approximate).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The case id, e.g. \"skx007\", \"62mas\", \"tuna\"." },
      },
      required: ["id"],
    },
  },
  {
    name: "watch_build",
    description:
      "Resolve a build into its spec sheet, compatibility verdict, sourcing rows " +
      "and permalink. The single call that answers \"what would this combination " +
      "actually be\" — dimensions, movement figures, parts cost band, and every " +
      "fit problem, without rendering anything.",
    input_schema: { type: "object", properties: { ...BUILD_ARG } },
  },
  {
    name: "watch_command",
    description:
      "Drive the builder in plain language. Give it a build and one or more " +
      "commands (\"pepsi bezel\", \"snowflake hands and a jubilee bracelet\", " +
      "\"svart urtavla\", \"surprise me\", \"reset the build\") and it returns the " +
      "new build, exactly what changed, the fit verdict, and further commands " +
      "worth trying. English and Swedish both. This is the same deterministic " +
      "parser the site's inline chat builder uses — no model in the loop.",
    input_schema: {
      type: "object",
      properties: {
        ...BUILD_ARG,
        command: {
          type: "string",
          description: "The command text, e.g. \"make the dial sunburst blue and fit a pepsi bezel\".",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          description: "Several commands applied in order instead of one `command`.",
        },
        lang: { type: "string", description: "\"en\" (default) or \"sv\" — the language of the returned summary.", enum: ["en", "sv"] },
      },
    },
  },
  {
    name: "watch_check",
    description:
      "Compatibility only: can this build be assembled, and what is wrong with " +
      "it. Errors mean it cannot go together as specified; warnings mean it can " +
      "but something will look or work oddly; notes are catalogue caveats.",
    input_schema: { type: "object", properties: { ...BUILD_ARG } },
  },
  {
    name: "watch_sourcing",
    description:
      "Where the parts for a build come from: the brands that make each one, the " +
      "price band to expect, what to watch out for in a listing, and prepared " +
      "AliExpress search URLs. Built locally from a curated index — this tool " +
      "never contacts a marketplace.",
    input_schema: {
      type: "object",
      properties: {
        ...BUILD_ARG,
        slot: { type: "string", description: "Narrow to one slot's row.", enum: SLOT_KEYS },
      },
    },
  },
];

/**
 * The build an argument object names: `build` ids, else a `code` permalink, else
 * the default. Total — normalizeBuild fills every slot, so there is no invalid
 * build to reject and a caller's typo degrades to the default part rather than
 * an error the model then has to reason about.
 * @param {Record<string, any>} args
 * @returns {Record<string, string>}
 */
function buildFromArgs(args) {
  if (args && args.build && typeof args.build === "object") return normalizeBuild(args.build);
  if (args && typeof args.code === "string" && args.code) return normalizeBuild(decodeBuild(args.code));
  return normalizeBuild(null);
}

/**
 * The shape every tool returns a build in — ids, permalink, spec, fit. Kept in
 * one place so the six tools cannot describe the same build differently.
 * @param {Record<string, string>} build
 */
function buildReport(build) {
  const fit = checkBuild(build);
  return {
    build,
    code: encodeBuild(build),
    permalink: `https://deepresearch.se/watch/#${encodeURIComponent(encodeBuild(build))}`,
    spec: buildSpec(build),
    fit: {
      ok: fit.ok,
      errors: fit.issues.filter((x) => x.level === "error").map((x) => ({ slot: x.slot, problem: x.en })),
      warnings: fit.issues.filter((x) => x.level === "warning").map((x) => ({ slot: x.slot, problem: x.en })),
      notes: fit.issues.filter((x) => x.level === "note").map((x) => ({ slot: x.slot, note: x.en })),
    },
  };
}

/** @param {unknown} value */
function asText(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Run one watch tool. Pure: no env, no network, no model. Throws only on an
 * unknown name — every other bad input degrades to a described default, which is
 * what keeps a tool-calling model from getting stuck in an error loop.
 *
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {string} the tool result text (JSON)
 */
export function runWatchTool(name, args = {}) {
  const a = args && typeof args === "object" ? args : {};

  if (name === "watch_catalog") {
    const slot = typeof a.slot === "string" ? a.slot : "";
    if (slot) {
      const options = slotOptions(slot);
      if (!options.length) {
        return asText({ error: `No such slot: ${slot}`, slots: SLOT_KEYS });
      }
      const meta = SLOTS.find((s) => s.key === slot);
      return asText({ slot, name: meta ? meta.name.en : slot, count: options.length, options });
    }
    return asText({
      movement: { family: "Seiko/TMI NHxx", dialDia: 28.5, handTubes: { hour: 1.5, minute: 0.9, second: 0.2 } },
      slots: SLOTS.map((s) => ({ key: s.key, name: s.name.en, options: slotOptions(s.key).length })),
      cases: caseIndex(),
      platforms: PLATFORMS,
      sources: SOURCES,
      note:
        "Every dimension traces to a published source in `sources`; anything flagged approx is a " +
        "listing figure, not a spec sheet. Call watch_catalog with `slot` for a parts family's options.",
    });
  }

  if (name === "watch_case") {
    const id = typeof a.id === "string" ? a.id : "";
    const row = caseIndex().find((c) => c.id === id);
    if (!row) return asText({ error: `No such case: ${id || "(none given)"}`, cases: CASES.map((c) => c.id) });
    const full = CASES.find((c) => c.id === id);
    return asText({
      case: { ...row, blurb: full ? full.blurb : null, note: full ? full.note : null },
      platform: PLATFORMS[/** @type {keyof typeof PLATFORMS} */ (row.platform)] || null,
    });
  }

  if (name === "watch_build") {
    const build = buildFromArgs(a);
    return asText({ ...buildReport(build), sourcing: sourcingFor(build) });
  }

  if (name === "watch_command") {
    const lang = a.lang === "sv" ? "sv" : "en";
    const commands = Array.isArray(a.commands)
      ? a.commands.filter((c) => typeof c === "string")
      : typeof a.command === "string" && a.command
        ? [a.command]
        : [];
    if (!commands.length) {
      return asText({
        error: "Give a `command` string (or a `commands` array).",
        examples: ["pepsi bezel", "snowflake hands and a jubilee bracelet", "svart urtavla", "surprise me", "reset the build"],
      });
    }
    let build = buildFromArgs(a);
    /** @type {any[]} */
    const applied = [];
    commands.forEach((command, i) => {
      const parsed = parseWatchCommand(command, build, { seed: i + 1 });
      build = parsed.build;
      applied.push({
        command,
        recognized: parsed.touched,
        reset: parsed.reset,
        randomized: parsed.randomized,
        view: parsed.view,
        changed: parsed.changes.map((c) => ({ slot: c.slot, from: c.from.id, to: c.to.id, summary: `${c.slotName.en}: ${c.from.name.en} → ${c.to.name.en}` })),
        summary: changeSummary(parsed.changes, lang, { reset: parsed.reset, randomized: parsed.randomized, view: parsed.view }),
      });
    });
    return asText({
      ...buildReport(build),
      applied,
      suggestions: suggestCommands(build, lang, applied.length),
      note:
        "A command that changed nothing has recognized:false — the vocabulary is the catalogue's own " +
        "part names plus their common trade names, so call watch_catalog for a slot's options if a " +
        "command missed. `view` carries display-only commands (lights out, top view).",
    });
  }

  if (name === "watch_check") {
    const build = buildFromArgs(a);
    const report = buildReport(build);
    return asText({ build: report.build, code: report.code, fit: report.fit });
  }

  if (name === "watch_sourcing") {
    const build = buildFromArgs(a);
    const slot = typeof a.slot === "string" ? a.slot : "";
    const rows = sourcingFor(build).filter((r) => !slot || r.slot === slot);
    if (slot && !rows.length) return asText({ error: `No sourcing row for slot: ${slot}`, slots: SLOT_KEYS });
    return asText({
      code: encodeBuild(build),
      priceUsd: buildSpec(build).priceUsd,
      rows,
      note: "Search URLs are built locally from a curated query index. This tool does not contact aliexpress.com.",
    });
  }

  throw new Error(`Unknown watch tool: ${name}`);
}
