// The app kit is a CLASSIC script, not a module — a published build loads it
// with a plain <script src>, because an opaque-origin sandbox is the least
// forgiving place to rely on module resolution. So the suite loads it the way
// a browser does: evaluate the source against a stub global and inspect the one
// object it defines.
//
// The load-bearing test here is PARITY. The kit's registry is a copy of the
// site's own (public/js/drc-providers.js) plus the country flags
// (public/js/provider-region.js), and a copy that drifts is worse than no copy:
// every app Agent Studio has ever published carries a frozen snapshot of it, so
// a provider added or re-curated on the site must be added or re-curated here
// in the same commit.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DRC_PROVIDERS } from "../js/drc-providers.js";
import { PROVIDER_REGIONS } from "../js/provider-region.js";

const KIT_PATH = fileURLToPath(new URL("./dr-provider-kit.js", import.meta.url));
const SOURCE = readFileSync(KIT_PATH, "utf8");

/** Evaluate the kit against a fresh stub global, exactly as a script tag would. */
function loadKit(extraGlobals = {}) {
  const globalStub = {};
  const names = ["window", "fetch", "TextDecoder", "setTimeout", "clearTimeout", ...Object.keys(extraGlobals)];
  const values = [
    globalStub,
    extraGlobals.fetch ?? globalThis.fetch,
    globalThis.TextDecoder,
    globalThis.setTimeout,
    globalThis.clearTimeout,
    ...Object.values(extraGlobals),
  ];
  new Function(...names, SOURCE)(...values);
  return globalStub.DRKit;
}

describe("app kit — shape", () => {
  test("is self-contained: no imports, no build step, one global", () => {
    assert.ok(!/^\s*import\s/m.test(SOURCE), "the kit must not import anything");
    assert.ok(!/^\s*export\s/m.test(SOURCE), "the kit must not use module exports");
    const kit = loadKit();
    assert.ok(kit, "defines window.DRKit");
    for (const fn of ["detectProvider", "listModels", "mountModelPicker", "chat", "chatStream"]) {
      assert.equal(typeof kit[fn], "function", `${fn} is exported`);
    }
  });
});

describe("app kit — parity with the site's own provider registry", () => {
  const kit = loadKit();
  const byId = (list, id) => list.find((p) => p.id === id);
  // `local` is the site's id for the keyless escape hatch; the kit calls the
  // same entry `custom`, because "local" reads as on-device to someone opening
  // a generated app. Same entry, mapped here.
  const KIT_ID = { local: "custom" };

  test("carries every provider the site can call from a browser", () => {
    const expected = DRC_PROVIDERS.map((p) => KIT_ID[p.id] || p.id).sort();
    assert.deepEqual(kit.PROVIDERS.map((p) => p.id).sort(), expected);
  });

  for (const site of DRC_PROVIDERS) {
    const id = KIT_ID[site.id] || site.id;
    test(`${id}: base URL, key pattern and wire match the site`, () => {
      const mine = byId(kit.PROVIDERS, id);
      assert.ok(mine, `${id} is in the kit`);
      assert.equal(mine.base, site.base);
      assert.equal(String(mine.keyPattern), String(site.keyPattern));
      assert.equal(mine.wire ?? undefined, site.wire ?? undefined);
      assert.deepEqual(mine.fallbackModels, site.fallbackModels ?? []);
    });

    test(`${id}: the curation rule accepts and rejects the same ids`, () => {
      const mine = byId(kit.PROVIDERS, id);
      // Sampled across every catalog the registry curates, so one rule's
      // regex cannot quietly diverge from its twin.
      const samples = [
        "gpt-5.6-sol", "gpt-5.4-mini", "gpt-4o", "gpt-5.6-audio-preview", "text-embedding-3-small",
        "claude-opus-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022",
        "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "whisper-large-v3", "meta-llama/llama-guard-4-12b",
        "zai-org/GLM-5.2", "meta-llama/Llama-3.1-8B-Instruct", "some/model-gguf", "intfloat/multilingual-e5-large",
        "mistralai/Mistral-Small-3.2-24B-Instruct-2506", "KBLab/kb-whisper-large", "BAAI/bge-reranker-v2-m3",
        "qwen3:8b", "nomic-embed-text",
      ];
      const siteFilter = site.modelFilter || (() => true);
      for (const s of samples) {
        assert.equal(mine.modelFilter(s), siteFilter(s), `${id} disagrees on "${s}"`);
      }
    });
  }

  test("flags and countries match the shared country-of-processing map", () => {
    for (const p of kit.PROVIDERS) {
      // The site's keyless entry is deliberately flagless in both places: only
      // whoever configured that endpoint knows where it is hosted.
      const region = PROVIDER_REGIONS[p.id] || null;
      assert.equal(p.flag, region ? region.flag : "", `${p.id} flag`);
      assert.equal(p.country, region ? region.country : "", `${p.id} country`);
    }
  });
});

describe("app kit — key detection", () => {
  const kit = loadKit();

  test("routes each key shape to its provider", () => {
    assert.equal(kit.detectProvider("sk-proj-abc123").id, "openai");
    assert.equal(kit.detectProvider("sk-ant-api03-abc").id, "anthropic");
    assert.equal(kit.detectProvider("gsk_abc123").id, "groq");
    assert.equal(kit.detectProvider("hf_abc123").id, "huggingface");
    assert.equal(kit.detectProvider("sk_ber_abc123").id, "berget");
  });

  test("an Anthropic key is never taken for an OpenAI one", () => {
    // The bug feedback #6 reported on the site itself; the copy must not
    // reintroduce it.
    assert.equal(kit.detectProvider("sk-ant-api03-xyz").id, "anthropic");
  });

  test("an unknown shape leaves the choice to the user", () => {
    assert.equal(kit.detectProvider("nonsense"), null);
    assert.equal(kit.detectProvider(""), null);
    assert.equal(kit.detectProvider(undefined), null);
  });
});

describe("app kit — model listing", () => {
  const kit = loadKit();

  test("curates and orders a live catalog, newest generation first", () => {
    const ids = kit.filterAndSortModels(
      [{ id: "gpt-5.4-mini" }, { id: "gpt-4o" }, { id: "gpt-5.6-sol" }, { id: "text-embedding-3-small" }],
      kit.provider("openai").modelFilter,
    );
    assert.deepEqual(ids, ["gpt-5.6-sol", "gpt-5.4-mini"]);
  });

  test("drops models the provider reports as down", () => {
    const ids = kit.filterAndSortModels(
      [{ id: "gpt-5.6-sol", status: { up: false } }, { id: "gpt-5.4-mini" }],
      kit.provider("openai").modelFilter,
    );
    assert.deepEqual(ids, ["gpt-5.4-mini"]);
  });

  test("a live fetch wins", async () => {
    const kitWithFetch = loadKit({
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: "claude-opus-5" }] }) }),
    });
    const ids = await kitWithFetch.listModels(kitWithFetch.provider("anthropic"), "sk-ant-x");
    assert.deepEqual(ids, ["claude-opus-5"]);
  });

  test("a failed fetch still yields a usable dropdown (the static fallback)", async () => {
    const kitWithFetch = loadKit({ fetch: async () => ({ ok: false, status: 401 }) });
    const ids = await kitWithFetch.listModels(kitWithFetch.provider("openai"), "sk-wrong");
    assert.deepEqual(ids, kitWithFetch.provider("openai").fallbackModels);
  });

  test("Anthropic's browser opt-in header is sent, or the preflight is rejected", async () => {
    let seen = null;
    const kitWithFetch = loadKit({
      fetch: async (url, init) => {
        seen = { url, headers: init.headers };
        return { ok: true, json: async () => ({ data: [{ id: "claude-opus-5" }] }) };
      },
    });
    await kitWithFetch.listModels(kitWithFetch.provider("anthropic"), "sk-ant-x");
    assert.equal(seen.url, "https://api.anthropic.com/v1/models");
    assert.equal(seen.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(seen.headers["x-api-key"], "sk-ant-x");
    assert.ok(!seen.headers.authorization, "no Bearer header on the Anthropic wire");
  });
});

describe("app kit — the picker", () => {
  // A DOM stub small enough to be honest about what the picker touches:
  // value, options, textContent, hidden, and change/input listeners.
  function el(tag = "div") {
    const node = {
      tag,
      tagName: String(tag).toUpperCase(),
      value: "",
      hidden: false,
      title: "",
      textContent: "",
      children: [],
      listeners: {},
      ownerDocument: { createElement: (t) => el(t) },
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      },
      appendChild(child) {
        this.children.push(child);
        if (this.children.length === 1 && !this.value) this.value = child.value ?? "";
        return child;
      },
      fire(type) {
        return Promise.all((this.listeners[type] || []).map((fn) => fn()));
      },
    };
    return node;
  }

  // A pasted key is a live credential. The build prompt (APP_KIT_NOTE) asks
  // every generated app for type="password"; the kit does not depend on the
  // model having complied, because an unmasked field shows the key to whoever
  // is looking at the screen — or watching a recording of the app being used.
  describe("the key field is masked by the kit, not by whoever wired it", () => {
    test("a bare <input> comes back masked", () => {
      const kit = loadKit();
      const keyInput = el("input"); // no type, no autocomplete, no spellcheck
      kit.mountModelPicker({ keyInput, modelSelect: el("select") });
      assert.equal(keyInput.type, "password");
      assert.equal(keyInput.autocomplete, "off");
      assert.equal(keyInput.spellcheck, false);
    });

    test("masking is the initial state, not a lock on the app's own reveal toggle", () => {
      const kit = loadKit();
      const keyInput = el("input");
      kit.mountModelPicker({ keyInput, modelSelect: el("select") });
      keyInput.type = "text"; // the app's own "show key" button
      assert.equal(keyInput.type, "text", "the kit sets the field once, at mount");
    });

    test("anything that is not an <input> is left alone", () => {
      // `type` is read-only on a <textarea>, and the kit runs under "use
      // strict" — assigning it there would throw and take the mount with it.
      const kit = loadKit();
      const keyInput = el("textarea");
      const picker = kit.mountModelPicker({ keyInput, modelSelect: el("select") });
      assert.equal(keyInput.type, undefined);
      assert.equal(typeof picker.state, "function", "the picker still mounted");
    });
  });

  test("pasting a key auto-loads the models into a flagged dropdown", async () => {
    const kit = loadKit({
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }] }) }),
    });
    const keyInput = el("input");
    const modelSelect = el("select");
    const status = el("p");
    const picker = kit.mountModelPicker({ keyInput, modelSelect, status });

    keyInput.value = "sk-proj-abc";
    await keyInput.fire("change");

    assert.deepEqual(picker.models(), ["gpt-5.6-sol", "gpt-5.4-mini"]);
    assert.deepEqual(
      modelSelect.children.map((o) => o.textContent),
      ["🇺🇸 gpt-5.6-sol", "🇺🇸 gpt-5.4-mini"],
    );
    assert.equal(modelSelect.children[0].title, "Processed in United States");
    assert.match(status.textContent, /OpenAI/);
    assert.equal(picker.ready(), true);
    assert.equal(picker.state().provider.id, "openai");
    assert.equal(picker.state().apiKey, "sk-proj-abc");
  });

  test("a Berget key gets the Swedish flag — the country is per provider, not global", async () => {
    const kit = loadKit({
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506" }] }) }),
    });
    const keyInput = el("input");
    const modelSelect = el("select");
    const picker = kit.mountModelPicker({ keyInput, modelSelect });
    keyInput.value = "sk_ber_abc";
    await keyInput.fire("change");
    assert.equal(picker.state().provider.id, "berget");
    assert.match(modelSelect.children[0].textContent, /^🇸🇪 /);
  });

  test("an unrecognised key says so instead of silently listing nothing", async () => {
    const kit = loadKit();
    const keyInput = el("input");
    const modelSelect = el("select");
    const status = el("p");
    kit.mountModelPicker({ keyInput, modelSelect, status });
    keyInput.value = "not-a-key";
    await keyInput.fire("change");
    assert.match(status.textContent, /not recognised/i);
    assert.equal(modelSelect.hidden, true);
  });

  test("the status line and the privacy note exist in Swedish too", async () => {
    // The site's rule: anything a user reads exists in both languages.
    const kit = loadKit({
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: "gpt-5.6-sol" }] }) }),
    });
    const keyInput = el("input");
    const modelSelect = el("select");
    const status = el("p");
    const picker = kit.mountModelPicker({ keyInput, modelSelect, status, lang: "sv" });
    assert.match(status.textContent, /API-nyckel/);
    keyInput.value = "sk-proj-abc";
    await keyInput.fire("change");
    assert.match(status.textContent, /modell/);
    assert.match(picker.note(), /Din nyckel stannar/);
  });

  test("the provider dropdown lists every provider, flagged", () => {
    const kit = loadKit();
    const sel = el("select");
    kit.fillProviderSelect(sel);
    assert.equal(sel.children.length, kit.PROVIDERS.length);
    assert.equal(sel.children[0].textContent, "🇺🇸 OpenAI");
    const custom = sel.children[sel.children.length - 1];
    assert.equal(custom.textContent, "Any OpenAI-compatible endpoint", "no invented flag for an unknown host");
  });

  test("an explicit provider pick overrides key detection", async () => {
    const kit = loadKit({ fetch: async () => ({ ok: false, status: 500 }) });
    const keyInput = el("input");
    const modelSelect = el("select");
    const providerSelect = el("select");
    const picker = kit.mountModelPicker({ keyInput, modelSelect, providerSelect });
    providerSelect.value = "groq";
    keyInput.value = "sk-proj-abc"; // looks like OpenAI
    await providerSelect.fire("change");
    assert.equal(picker.state().provider.id, "groq");
  });
});

describe("app kit — calling the model", () => {
  const capture = () => {
    const calls = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "hi" } }] }),
        };
      },
    };
  };

  test("the OpenAI wire gets chat/completions and its own token param", async () => {
    const c = capture();
    const kit = loadKit({ fetch: c.fetch });
    const session = { provider: kit.provider("openai"), apiKey: "sk-x", model: "gpt-5.6-sol", baseUrl: "" };
    const text = await kit.chat(session, [{ role: "user", content: "hi" }], { maxTokens: 64 });
    assert.equal(text, "hi");
    assert.equal(c.calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(c.calls[0].body.max_completion_tokens, 64);
    assert.equal(c.calls[0].init.headers.authorization, "Bearer sk-x");
  });

  test("the Anthropic wire is adapted here, so an app writes one message shape", async () => {
    const calls = [];
    const kit = loadKit({
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "yo" }] }) };
      },
    });
    const session = { provider: kit.provider("anthropic"), apiKey: "sk-ant-x", model: "claude-opus-5", baseUrl: "" };
    const text = await kit.chat(
      session,
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      { maxTokens: 32 },
    );
    assert.equal(text, "yo");
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].body.system, "be brief", "system turns move to the top-level field");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "a\n\nb" }], "same-role turns are merged");
    assert.equal(calls[0].body.max_tokens, 32);
  });

  test("a provider error surfaces its message, not a bare status", async () => {
    const kit = loadKit({
      fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "bad key" } }) }),
    });
    const session = { provider: kit.provider("openai"), apiKey: "sk-x", model: "gpt-5.6-sol", baseUrl: "" };
    await assert.rejects(() => kit.chat(session, [{ role: "user", content: "hi" }]), /401 — bad key/);
  });

  test("streaming yields text deltas on both wires", async () => {
    const sse = (lines) => ({
      ok: true,
      body: {
        getReader() {
          const chunks = lines.map((l) => new TextEncoder().encode(l));
          let i = 0;
          return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
        },
      },
    });

    const oai = loadKit({
      fetch: async () => sse([
        'data: {"choices":[{"delta":{"content":"he"}}]}\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n',
        "data: [DONE]\n",
      ]),
    });
    const seen = [];
    const oaiText = await oai.chatStream(
      { provider: oai.provider("groq"), apiKey: "gsk_x", model: "llama-3.1-8b-instant", baseUrl: "" },
      [{ role: "user", content: "hi" }],
      (d) => seen.push(d),
    );
    assert.equal(oaiText, "hello");
    assert.deepEqual(seen, ["he", "llo"]);

    const ant = loadKit({
      fetch: async () => sse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n',
        'data: {"type":"message_stop"}\n',
      ]),
    });
    const antText = await ant.chatStream(
      { provider: ant.provider("anthropic"), apiKey: "sk-ant-x", model: "claude-opus-5", baseUrl: "" },
      [{ role: "user", content: "hi" }],
      () => {},
    );
    assert.equal(antText, "ok");
  });
});
