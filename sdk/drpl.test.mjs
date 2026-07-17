// DRPL/1 reference tooling — unit suite (sdk/drpl.mjs).
//
// Pins the language's structural guarantees: validation accept/reject, the
// deterministic topological canonicalization, the id-blind / prose-blind
// fingerprint invariance, the three comparison levels' visibility rules, the
// spine projection's dataflow rewiring, and — against the two committed
// example documents — the reference pair's headline property: the server and
// client pipelines are IDENTICAL at spine-shape and differ at placement.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRPL_V,
  PHASE_KINDS,
  canonicalForm,
  diffDrpl,
  fingerprint,
  parseCliFlags,
  spineProject,
  topoOrder,
  validateDrpl,
} from "./drpl.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));
const SERVER = "docs/examples/pipeline-server.drpl.json";
const SECURE = "docs/examples/pipeline-secure.drpl.json";

/** A minimal valid document to mutate in rejection tests. */
function doc() {
  return {
    drpl: DRPL_V,
    id: "test/pipeline",
    phases: [
      {
        id: "triage",
        kind: "triage",
        needs: [],
        exec: { at: "client" },
        calls: [{ party: "model-provider", carries: ["question"] }],
        model: { route: "planning", mode: "json", tools: false },
        failure: { policy: "soft" },
      },
      {
        id: "synthesis",
        kind: "synthesis",
        needs: ["triage"],
        exec: { at: "client" },
        calls: [{ party: "model-provider", carries: ["conversation"] }],
        model: { route: "answer", mode: "stream", tools: false },
        failure: { policy: "hard" },
      },
    ],
  };
}

test("validateDrpl: the minimal document and both committed examples validate", () => {
  assert.deepEqual(validateDrpl(doc()), []);
  assert.deepEqual(validateDrpl(load(SERVER)), []);
  assert.deepEqual(validateDrpl(load(SECURE)), []);
});

test("validateDrpl: rejections name the problem", () => {
  const bad = (mutate, re) => {
    const d = doc();
    mutate(d);
    const problems = validateDrpl(d);
    assert.ok(problems.length, "expected a problem");
    assert.ok(problems.some((p) => re.test(p)), `${re} not in: ${problems.join(" | ")}`);
  };
  bad((d) => (d.drpl = 2), /drpl must be 1/);
  bad((d) => delete d.id, /id must be/);
  bad((d) => (d.phases = []), /non-empty/);
  bad((d) => (d.phases[1].id = "triage"), /duplicate phase id/);
  bad((d) => (d.phases[0].kind = "brainstorm"), /unknown kind/);
  bad((d) => (d.phases[0].needs = ["nowhere"]), /needs unknown phase/);
  bad((d) => (d.phases[0].needs = ["synthesis"]), /cycle/);
  bad((d) => (d.phases[0].exec = { at: "edge" }), /exec\.at/);
  bad((d) => (d.phases[0].failure = { policy: "retry" }), /failure\.policy/);
  bad((d) => (d.phases[0].calls = [{ party: "model-provider", carries: [] }]), /carries/);
  bad((d) => (d.phases[0].calls = [{ party: "the-cloud", carries: ["question"] }]), /unknown party/);
  bad((d) => (d.phases[0].model = { route: "fast", mode: "json" }), /model\.route/);
  bad((d) => (d.phases[0].repeats = { max: 0 }), /repeats/);
});

test("validateDrpl: x- extension kinds and parties are open vocabulary", () => {
  const d = doc();
  d.phases[0].kind = "x-deduplicate";
  d.phases[0].calls = [{ party: "x-blockchain-oracle", carries: ["hash"] }];
  assert.deepEqual(validateDrpl(d), []);
  assert.ok(PHASE_KINDS.includes("triage"));
});

test("topoOrder: deterministic (lexicographic within a rank), null on cycle", () => {
  const phases = [
    { id: "b", needs: [] },
    { id: "a", needs: [] },
    { id: "c", needs: ["a", "b"] },
  ];
  assert.deepEqual(topoOrder(phases), ["a", "b", "c"]);
  assert.equal(topoOrder([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }]), null);
});

test("spineProject: optional phases drop with transitive dataflow rewiring", () => {
  const d = doc();
  // triage → opt1(optional) → opt2(optional) → synthesis: synthesis must
  // inherit triage through BOTH dropped hops.
  d.phases = [
    d.phases[0],
    { ...d.phases[1], id: "opt1", kind: "notes", optional: true, needs: ["triage"], failure: { policy: "soft" } },
    { ...d.phases[1], id: "opt2", kind: "notes", optional: true, needs: ["opt1"], failure: { policy: "soft" } },
    { ...d.phases[1], needs: ["opt2"] },
  ];
  const spine = spineProject(d);
  assert.deepEqual(spine.phases.map((p) => p.id), ["triage", "synthesis"]);
  assert.deepEqual(spine.phases[1].needs, ["triage"]);
  assert.equal(d.phases.length, 4, "input untouched");
});

test("fingerprint: blind to prose, field order, and phase ids — id-blind by canonical position", () => {
  const a = doc();
  const base = fingerprint(a, "full");
  const b = doc();
  b.title = "Some title";
  b.phases[0].notes = "prose prose";
  b.phases[0].title = "Triage!";
  b.meta = { anything: true };
  assert.equal(fingerprint(b, "full"), base, "prose/meta never counts");
  const c = doc();
  c.phases = c.phases.map((p) => {
    const flipped = {};
    for (const k of Object.keys(p).reverse()) flipped[k] = p[k];
    return flipped;
  });
  assert.equal(fingerprint(c, "full"), base, "key order never counts");
  const d = doc();
  d.phases[0].id = "analyse";
  d.phases[1].needs = ["analyse"];
  assert.equal(fingerprint(d, "full"), base, "phase ids never count");
});

test("fingerprint levels: shape is placement-blind; placement sees exec/calls/model; full sees loop bounds", () => {
  const a = doc();
  const b = doc();
  b.phases[0].exec = { at: "server" };
  b.phases[0].calls = [{ party: "search-provider", carries: ["search-queries"] }];
  assert.equal(fingerprint(b, "shape"), fingerprint(a, "shape"));
  assert.notEqual(fingerprint(b, "placement"), fingerprint(a, "placement"));

  const c = doc();
  c.phases[0].repeats = { max: 2 };
  const c2 = doc();
  c2.phases[0].repeats = { max: 5 };
  assert.notEqual(fingerprint(c, "shape"), fingerprint(a, "shape"), "repeatability itself is shape");
  assert.equal(fingerprint(c, "shape"), fingerprint(c2, "shape"), "the bound is not");
  assert.notEqual(fingerprint(c, "full"), fingerprint(c2, "full"), "full sees the bound");
});

test("canonicalForm: level label distinguishes spine projections", () => {
  assert.equal(canonicalForm(doc(), "shape").level, "shape");
  assert.equal(canonicalForm(doc(), "shape", { spine: true }).level, "spine-shape");
});

test("the committed examples: the two tiers are the SAME research at spine-shape, different placement", () => {
  const server = load(SERVER);
  const secure = load(SECURE);
  assert.equal(
    fingerprint(server, "shape", { spine: true }),
    fingerprint(secure, "shape", { spine: true }),
    "the required research spine must be structurally identical across the pair",
  );
  assert.notEqual(fingerprint(server, "shape"), fingerprint(secure, "shape"), "the optional phases differ by design");
  assert.notEqual(
    fingerprint(server, "placement", { spine: true }),
    fingerprint(secure, "placement", { spine: true }),
    "placement (who runs it, who receives what) is exactly what differs",
  );

  const d = diffDrpl(server, secure, "placement", { spine: true });
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.same, []);
  assert.deepEqual(d.changed.map((c) => c.id).sort(), ["gap-check", "search", "synthesis", "triage", "validation"]);
  for (const c of d.changed) assert.ok(c.fields.includes("at"), `${c.id} must differ on exec.at`);

  const full = diffDrpl(server, secure, "shape");
  assert.deepEqual(full.removed.sort(), ["enrichment", "notes"]);
  assert.deepEqual(full.added.sort(), ["recall", "web-search"]);
});

test("parseCliFlags: level + spine compose, files pass through", () => {
  assert.deepEqual(parseCliFlags(["a.json", "--level", "placement", "--spine", "b.json"]), {
    level: "placement",
    spine: true,
    rest: ["a.json", "b.json"],
  });
  assert.deepEqual(parseCliFlags(["a.json"]), { level: "shape", spine: false, rest: ["a.json"] });
});
