// The DeepResearch.se app kit — the STANDARD key + model picker for apps built
// by Agent Studio and published at /app/<slug>/ (feedback #66, 2026-08-10).
//
// WHY IT EXISTS. Every generated agent that talks to a model needs the same
// three things: an API key input, the list of models that key can actually
// reach, and an honest statement of WHERE the conversation is processed. Each
// build was inventing them again — usually a bare key field and a hardcoded
// model id, sometimes a dropdown with no country of processing at all. The
// owner asked for one standard: paste a key, the models load themselves, and
// the dropdown looks like this site's own — flag-prefixed, same providers.
//
// WHAT IT IS. A dependency-free CLASSIC script (no imports, no build step):
// load it with <script src="js/dr-provider-kit.js"></script> and it defines
// exactly one global, `window.DRKit`. It is INJECTED into a published build
// automatically whenever a file references it (src/app-kit.js →
// src/build-pub.js), so a build never writes this file itself.
//
// TWO MODES, and the difference is a privacy difference the app must state.
//   • BRING YOUR OWN KEY (DRKit.mountModelPicker) — the original, and the same
//     posture Se/cure keeps: every request goes from the visitor's browser
//     DIRECTLY to the provider they configured, and this site's server is in no
//     data path at all.
//   • HOSTED (DRKit.hosted) — no key at all: the app runs on the site's own
//     model access, pinned to a model, through the quota-metered Se/rver-token
//     LLM proxy. The conversation therefore DOES cross this site's server.
//     That is the point (an app you hand to someone must work when they open
//     it) and it is disclosed: `.note()` returns the sentence that says so.
//
// PRIVACY POSTURE of the key path — and the reason the kit is a
// copy rather than a call home: every request it makes goes from the visitor's
// browser DIRECTLY to the provider they configured. This site's server is in no
// data path here. The key stays in a variable on the page (never localStorage,
// which an opaque-origin sandbox has no access to anyway, and never a log), and
// nothing but the key and the conversation is ever sent. It is not shown
// either: the picker masks the key field it is handed, so a build that forgot
// `type="password"` still cannot render a live credential in plain text.
//
// The registry below MIRRORS public/js/drc-providers.js (ids, base URLs, key
// patterns, curation rules, fallback catalogs) and public/js/provider-region.js
// (the flags). That parity is enforced by
// public/app-kit/dr-provider-kit.test.js — when a provider is added, changed or
// re-curated there, this file changes in the same commit or the suite fails.

(function (global) {
  "use strict";

  // ---- the providers -------------------------------------------------------
  //
  // The admission ticket is CORS: each of these serves its OpenAI-compatible
  // (or, for Anthropic, Messages-API) endpoints with headers permitting a
  // direct call from page JavaScript. `flag`/`country` state where the
  // conversation is processed — data goes where the provider resides. The
  // custom entry gets NO flag: only the person who configured it knows where
  // that endpoint is hosted, so claiming a country would be a guess.

  var PROVIDERS = [
    {
      id: "openai",
      label: "OpenAI",
      base: "https://api.openai.com/v1",
      flag: "🇺🇸",
      country: "United States",
      // sk-… but NOT sk-ant-… — the most specific prefix owns the key, or an
      // Anthropic key gets routed to the wrong wire.
      keyPattern: /^sk-(?!ant-)/,
      fallbackModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"],
      // Curated, not exhaustive: the current language-model generation only.
      modelFilter: function (id) {
        return (
          /^gpt-5\.\d/.test(id) &&
          !/(audio|realtime|image|tts|transcribe|embedding|moderation|search|codex)/.test(id)
        );
      },
      params: function (maxTokens) {
        return { max_completion_tokens: maxTokens, reasoning_effort: "none" };
      },
    },
    {
      id: "anthropic",
      label: "Anthropic",
      base: "https://api.anthropic.com/v1",
      flag: "🇺🇸",
      country: "United States",
      keyPattern: /^sk-ant-/,
      // Not the OpenAI wire: the Messages API, adapted at the wire below so
      // callers of this kit only ever deal with one message shape.
      wire: "anthropic",
      fallbackModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
      // /v1/models returns dated ids (claude-haiku-4-5-20251001) beside every
      // legacy family, so the current prefixes are matched with a boundary.
      modelFilter: function (id) {
        return /^claude-(opus-5|sonnet-5|haiku-4-5)\b/.test(id);
      },
      params: function (maxTokens) {
        return { max_tokens: maxTokens };
      },
    },
    {
      id: "groq",
      label: "Groq",
      base: "https://api.groq.com/openai/v1",
      flag: "🇺🇸",
      country: "United States",
      keyPattern: /^gsk_/,
      fallbackModels: [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
      ],
      modelFilter: function (id) {
        return (
          /^(llama-3\.3-|llama-3\.1-8b|llama-4|openai\/gpt-oss-|moonshotai\/kimi-k2|qwen)/.test(id) &&
          !/(whisper|tts|guard|embedding|allam)/i.test(id)
        );
      },
      params: function (maxTokens) {
        return { max_tokens: maxTokens };
      },
    },
    {
      id: "huggingface",
      label: "Hugging Face",
      // The router — one OpenAI-compatible front door over whichever inference
      // provider serves the model. The flag states what is certain (the
      // conversation reaches a US endpoint), not where the second hop lands.
      base: "https://router.huggingface.co/v1",
      flag: "🇺🇸",
      country: "United States",
      keyPattern: /^hf_/,
      fallbackModels: [
        "zai-org/GLM-5.2",
        "deepseek-ai/DeepSeek-V4-Pro",
        "moonshotai/Kimi-K2.6",
        "openai/gpt-oss-120b",
        "meta-llama/Llama-3.1-8B-Instruct",
      ],
      modelFilter: function (id) {
        return id.indexOf("/") !== -1 && !/(gguf|guard|-base-pt|embed|rerank|whisper|tts|moderation)/i.test(id);
      },
      params: function (maxTokens) {
        return { max_tokens: maxTokens };
      },
    },
    {
      id: "berget",
      label: "Berget",
      base: "https://api.berget.ai/v1",
      flag: "🇸🇪",
      country: "Sweden",
      keyPattern: /^sk_ber_/,
      fallbackModels: [
        "moonshotai/Kimi-K2.6",
        "zai-org/GLM-4.7-FP8",
        "mistralai/Mistral-Medium-3.5-128B",
        "openai/gpt-oss-120b",
        "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      ],
      // Vendor-path ids, chat-dominated catalog: curation means excluding the
      // non-chat modalities it hosts, not picking generations.
      modelFilter: function (id) {
        return id.indexOf("/") !== -1 && !/(whisper|rerank|embed|-e5-|tts|guard)/i.test(id);
      },
      params: function (maxTokens) {
        return { max_tokens: maxTokens };
      },
    },
    {
      // The escape hatch that keeps the named providers from being the
      // boundary: ANY OpenAI-compatible endpoint the user runs or trusts
      // (Ollama, LM Studio, llama.cpp, a hosted service). Keyless — the base
      // URL is the whole configuration — and deliberately flagless.
      id: "custom",
      label: "Any OpenAI-compatible endpoint",
      base: "http://localhost:11434/v1",
      flag: "",
      country: "",
      keyPattern: null,
      keyless: true,
      fallbackModels: [],
      modelFilter: function (id) {
        return !/(embed|whisper|rerank|guard|tts|moderation)/i.test(id);
      },
      params: function (maxTokens) {
        return { max_tokens: maxTokens };
      },
    },
  ];

  /** The registry entry with this id, or null. */
  function provider(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
  }

  /**
   * The provider a pasted key belongs to, or null for a shape no pattern
   * knows (the picker then leaves the choice to the user). The patterns are
   * mutually exclusive by construction, so no match depends on order.
   */
  function detectProvider(key) {
    var k = typeof key === "string" ? key.trim() : "";
    if (!k) return null;
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      if (p.keyPattern && p.keyPattern.test(k)) return p;
    }
    return null;
  }

  /** "🇸🇪 Mistral Small" — the name unchanged when there is no flag. */
  function labelWithFlag(flag, name) {
    return flag ? flag + " " + name : String(name == null ? "" : name);
  }

  // The headers one call needs. Anthropic authenticates with x-api-key plus a
  // version header AND requires its explicit browser opt-in, or the preflight
  // is rejected outright — the header that makes a browser-direct Claude call
  // possible at all. A keyless endpoint gets no Authorization header: "Bearer
  // undefined" makes some servers 401.
  function wireHeaders(p, apiKey) {
    if (p && p.wire === "anthropic") {
      var h = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      if (apiKey) h["x-api-key"] = apiKey;
      return h;
    }
    var o = { "content-type": "application/json" };
    if (apiKey) o.authorization = "Bearer " + apiKey;
    return o;
  }

  /**
   * The curated, ordered model-id list out of a raw /models `data` array:
   * the ids the provider's rule accepts, newest generation first. Models the
   * provider reports as down are dropped — picking one gets an error on every
   * call, and the newest-first sort loves to put exactly those first.
   */
  function filterAndSortModels(data, modelFilter) {
    return (Array.isArray(data) ? data : [])
      .filter(function (m) {
        return !(m && m.status && m.status.up === false);
      })
      .map(function (m) {
        return m && m.id;
      })
      .filter(function (id) {
        return typeof id === "string" && modelFilter(id);
      })
      .sort()
      .reverse();
  }

  /**
   * The models this key can reach — live from the provider, the static
   * fallback when the fetch fails. A wrong key still gets a dropdown to try;
   * the send surfaces the real error.
   * @returns {Promise<string[]>}
   */
  function listModels(p, apiKey, opts) {
    var o = opts || {};
    var base = o.baseUrl || (p && p.base);
    return fetch(base + "/models", { headers: wireHeaders(p, apiKey) })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then(function (data) {
        var ids = filterAndSortModels(data && data.data, (p && p.modelFilter) || function () { return true; });
        if (ids.length) return ids;
        throw new Error("empty");
      })
      .catch(function () {
        return (p && p.fallbackModels ? p.fallbackModels : []).slice();
      });
  }

  // ---- the HOSTED provider -------------------------------------------------
  //
  // The entry above are all BRING-YOUR-OWN-KEY: the visitor pastes a credential
  // and the browser calls that provider directly. That is the right shape for a
  // Se/cure-style flavour, and the wrong shape for most agents someone actually
  // wants to share: "Error: you didn't provide an api key" is the first thing
  // every visitor met, on an app whose whole point was to be handed to someone
  // (capture #CAP-22, 2026-08-12 — the owner's ask: build agents that run on
  // the key the site already has, pinned to a model, so the app needs nothing
  // but its own interface).
  //
  // So a published app can instead run HOSTED: the site's own Berget key, a
  // model pinned at publish time, through the Se/rver-token LLM proxy
  // (/api/server-token/llm) on a signed, quota-metered grant minted for the
  // app's owner. THE SERVER-TOKEN GUARANTEE is what makes that safe to embed in
  // a public page: the grant reaches upstream completions ONLY — never any
  // Se/rver data, and never a login — and it is metered, so the exposure is a
  // bounded number of completions rather than an account.
  //
  // It is deliberately NOT in PROVIDERS: that array mirrors the site's own
  // browser-callable registry (drc-providers.js) under a parity test, and the
  // hosted route is not a provider a key can be pasted for.
  //
  // The honest posture, which the app must show (see hostedNote): a hosted
  // conversation goes to THIS SITE's server and on to Berget on the server's
  // key. That is the opposite of the bring-your-own-key posture, and the
  // difference is the user's to know.
  var HOSTED = {
    id: "hosted",
    label: "DeepResearch.se",
    base: "", // filled from the published config — a path, resolved per page
    flag: "🇸🇪",
    country: "Sweden",
    hosted: true,
    keyPattern: null,
    fallbackModels: [],
    modelFilter: function (id) {
      return !/(embed|whisper|rerank|guard|tts|moderation)/i.test(id);
    },
    params: function (maxTokens) {
      return { max_tokens: maxTokens };
    },
  };

  /** The config the publish layer injects (js/dr-app-config.js), or {}. */
  function hostedConfig() {
    var c = global.DR_APP_CONFIG;
    return c && typeof c === "object" ? c : {};
  }

  // ---- the picker ----------------------------------------------------------
  //
  // Both languages, because this site's rule is that anything a user reads
  // exists in Swedish and English alike.

  var TEXT = {
    en: {
      detected: function (p, n) {
        return labelWithFlag(p.flag, p.label) + " — " + n + (n === 1 ? " model" : " models") + " available";
      },
      processed: function (c) {
        return c ? "Processed in " + c : "";
      },
      loading: "Loading models…",
      unknown: "Key not recognised — choose the provider yourself.",
      empty: "Paste an API key to load the available models.",
      note: function (c) {
        return c
          ? "Your key stays in this page and is sent only to this provider. The conversation is processed in " + c + "."
          : "Your key stays in this page and is sent only to the endpoint you configured.";
      },
      hostedReady: function (model) {
        return "Ready — running on " + model + ", no API key needed.";
      },
      hostedOff: "This app's hosted model access is unavailable — it was published without a live grant.",
      hostedSpent: "This app's hosted allowance is used up. Its owner can republish or raise the quota.",
      hostedNote: function (c) {
        return (
          "Runs on DeepResearch.se's own model access — you need no API key. Messages go to this site's server and on to its model provider" +
          (c ? ", processed in " + c : "") +
          "; usage is metered against the allowance this app was published with."
        );
      },
    },
    sv: {
      detected: function (p, n) {
        return labelWithFlag(p.flag, p.label) + " — " + n + (n === 1 ? " modell" : " modeller") + " tillgängliga";
      },
      processed: function (c) {
        return c ? "Behandlas i " + c : "";
      },
      loading: "Hämtar modeller…",
      unknown: "Nyckeln känns inte igen — välj leverantör själv.",
      empty: "Klistra in en API-nyckel för att hämta tillgängliga modeller.",
      note: function (c) {
        return c
          ? "Din nyckel stannar på den här sidan och skickas bara till den här leverantören. Konversationen behandlas i " + c + "."
          : "Din nyckel stannar på den här sidan och skickas bara till den slutpunkt du angett.";
      },
      hostedReady: function (model) {
        return "Klar — kör på " + model + ", ingen API-nyckel behövs.";
      },
      hostedOff: "Appens värdbaserade modellåtkomst är inte tillgänglig — den publicerades utan ett aktivt tillstånd.",
      hostedSpent: "Appens värdbaserade kvot är slut. Ägaren kan publicera om eller höja kvoten.",
      hostedNote: function (c) {
        return (
          "Kör på DeepResearch.se:s egen modellåtkomst — du behöver ingen API-nyckel. Meddelandena går till den här sajtens server och vidare till dess modellleverantör" +
          (c ? ", behandlas i " + c : "") +
          "; användningen räknas av mot den kvot appen publicerades med."
        );
      },
    },
  };

  function textFor(lang) {
    return TEXT[lang === "sv" ? "sv" : "en"];
  }

  /** Fill a <select> with the standard flag-prefixed provider options. */
  function fillProviderSelect(sel, currentId) {
    if (!sel) return;
    sel.textContent = "";
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      var opt = sel.ownerDocument.createElement("option");
      opt.value = p.id;
      opt.textContent = labelWithFlag(p.flag, p.label);
      if (p.country) opt.title = "Processed in " + p.country;
      sel.appendChild(opt);
    }
    if (currentId) sel.value = currentId;
  }

  /**
   * Mask the key field the app handed us, rather than trusting it to have done
   * so. A pasted key is a live credential; an unmasked field shows it to
   * whoever is looking at the screen — or watching a recording of it. The
   * build prompt asks for type="password", but "the two apps published so far
   * happened to do it" is luck, not a guarantee, so the kit makes it
   * structural: a bare <input> comes back masked.
   *
   * Only the INITIAL state is set, once at mount — an app's own "show key"
   * toggle still works, it just cannot start revealed. Anything that is not an
   * <input> is left alone (`type` is read-only on a <textarea>, and assigning
   * it under "use strict" throws), and the whole thing is caught anyway: this
   * is a hardening step, never a reason the picker fails to mount.
   */
  function maskKeyField(el) {
    if (!el) return;
    if (el.tagName && el.tagName !== "INPUT") return;
    try {
      if (el.type !== "password") el.type = "password";
      el.autocomplete = "off";
      el.spellcheck = false;
    } catch (e) {
      /* an element that refuses — its own markup then decides. */
    }
  }

  /**
   * Fill a model <select> with flag-prefixed options for one provider, keeping
   * the current selection when it survives the new list. Shared by the
   * bring-your-own-key picker and the hosted controller so a hosted app's
   * dropdown looks exactly like every other one.
   */
  function fillModelSelect(sel, ids, p, t) {
    if (!sel) return;
    var list = ids || [];
    var previous = sel.value;
    sel.textContent = "";
    for (var i = 0; i < list.length; i++) {
      var opt = sel.ownerDocument.createElement("option");
      opt.value = list[i];
      opt.textContent = labelWithFlag(p ? p.flag : "", list[i]);
      var note = t.processed(p ? p.country : "");
      if (note) opt.title = note;
      sel.appendChild(opt);
    }
    if (previous && list.indexOf(previous) !== -1) sel.value = previous;
    sel.hidden = list.length === 0;
  }

  /**
   * Wire an API-key input to a model <select>: the provider follows the pasted
   * key, the models load themselves, and every option carries the flag of the
   * country the conversation is processed in.
   *
   * Options: { keyInput, modelSelect, providerSelect?, baseUrlInput?, status?,
   *            lang?, onChange? }. Returns a controller:
   *   .state()   → { provider, apiKey, model, baseUrl } — pass it to chat()
   *   .models()  → the currently listed ids
   *   .refresh() → re-run detection + the model fetch now
   *   .ready()   → true when a model can actually be called
   */
  function mountModelPicker(opts) {
    var o = opts || {};
    var keyInput = o.keyInput || null;
    var modelSelect = o.modelSelect || null;
    var providerSelect = o.providerSelect || null;
    var baseUrlInput = o.baseUrlInput || null;
    var status = o.status || null;
    var t = textFor(o.lang);
    var onChange = typeof o.onChange === "function" ? o.onChange : function () {};

    var current = null; // the active provider entry
    var models = [];
    var token = 0; // guards against an older fetch resolving last

    maskKeyField(keyInput);
    if (providerSelect) fillProviderSelect(providerSelect, null);

    function key() {
      return keyInput && keyInput.value ? String(keyInput.value).trim() : "";
    }

    function baseUrl() {
      var v = baseUrlInput && baseUrlInput.value ? String(baseUrlInput.value).trim() : "";
      return v || (current ? current.base : "");
    }

    function say(msg) {
      if (status) status.textContent = msg;
    }

    function state() {
      return {
        provider: current,
        apiKey: current && current.keyless ? "" : key(),
        model: modelSelect && modelSelect.value ? modelSelect.value : models[0] || "",
        baseUrl: baseUrl(),
      };
    }

    function ready() {
      var s = state();
      return !!(s.provider && s.model && (s.apiKey || s.provider.keyless));
    }

    function renderModels(ids) {
      models = ids || [];
      fillModelSelect(modelSelect, models, current, t);
    }

    function load() {
      var k = key();
      // The provider is whatever the key says, unless the user overrode it.
      var picked = providerSelect && providerSelect.value ? provider(providerSelect.value) : null;
      var detected = detectProvider(k);
      current = picked || detected || current;
      if (detected && providerSelect && !picked) providerSelect.value = detected.id;

      if (!current) {
        renderModels([]);
        say(k ? t.unknown : t.empty);
        onChange(state());
        return Promise.resolve([]);
      }
      if (!k && !current.keyless) {
        renderModels([]);
        say(t.empty);
        onChange(state());
        return Promise.resolve([]);
      }

      say(t.loading);
      var mine = ++token;
      return listModels(current, k, { baseUrl: baseUrl() }).then(function (ids) {
        if (mine !== token) return ids; // a newer key won the race
        renderModels(ids);
        say(ids.length ? t.detected(current, ids.length) : t.unknown);
        onChange(state());
        return ids;
      });
    }

    if (keyInput) {
      keyInput.addEventListener("change", load);
      // Pasting a key should just work, without leaving the field. Debounced so
      // a typed key does not fire a request per character.
      var timer = null;
      keyInput.addEventListener("input", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, 400);
      });
    }
    if (providerSelect) providerSelect.addEventListener("change", load);
    if (baseUrlInput) baseUrlInput.addEventListener("change", load);
    if (modelSelect) {
      modelSelect.addEventListener("change", function () {
        onChange(state());
      });
    }

    say(t.empty);
    if (key()) load();

    return {
      state: state,
      models: function () {
        return models.slice();
      },
      ready: ready,
      refresh: load,
      note: function () {
        return t.note(current ? current.country : "");
      },
    };
  }

  /**
   * The HOSTED counterpart of mountModelPicker: no key input, no provider
   * detection, a model pinned when the app was published. Returns the SAME
   * controller shape, so an app switches between the two by changing one call
   * and `DRKit.chat` / `DRKit.chatStream` need no idea which it got.
   *
   * Options: { model?, token?, base?, modelSelect?, status?, lang?, onChange? }
   * — everything omitted comes from the injected `window.DR_APP_CONFIG`. Pass
   * `modelSelect` only when the app should let the visitor choose from the
   * hosted catalog; the pinned model is the default and needs no control at
   * all.
   *   .state()      → { provider, apiKey, model, baseUrl } — pass it to chat()
   *   .ready()      → true when a call can actually be made
   *   .available()  → same, but reads as what it is: was a grant published?
   *   .note()       → the honest one-line posture, in the app's language
   *   .refresh()    → load the hosted catalog into modelSelect (if given one)
   */
  function hosted(opts) {
    var o = opts || {};
    var cfg = hostedConfig();
    var t = textFor(o.lang);
    var status = o.status || null;
    var modelSelect = o.modelSelect || null;
    var onChange = typeof o.onChange === "function" ? o.onChange : function () {};

    var token = o.token || cfg.token || "";
    var base = o.base || cfg.base || "";
    var pinned = o.model || cfg.model || "";
    var p = {};
    for (var k in HOSTED) if (Object.prototype.hasOwnProperty.call(HOSTED, k)) p[k] = HOSTED[k];
    p.base = base;
    if (cfg.country) p.country = cfg.country;
    if (cfg.flag != null) p.flag = cfg.flag;

    var models = pinned ? [pinned] : [];

    function say(msg) {
      if (status) status.textContent = msg;
    }

    function model() {
      return (modelSelect && modelSelect.value) || pinned || models[0] || "";
    }

    function state() {
      return { provider: p, apiKey: token, model: model(), baseUrl: base };
    }

    function available() {
      return !!(token && base && model());
    }

    function refresh() {
      if (!available() || !modelSelect) return Promise.resolve(models.slice());
      return listModels(p, token, { baseUrl: base }).then(function (ids) {
        // The pinned model leads the list: it is what the app was published
        // with, and a catalog reshuffle must not silently move the app onto a
        // different model.
        var list = ids && ids.length ? ids.slice() : models.slice();
        var at = list.indexOf(pinned);
        if (pinned && at > 0) list.splice(at, 1);
        if (pinned && at !== 0) list.unshift(pinned);
        models = list;
        fillModelSelect(modelSelect, models, p, t);
        onChange(state());
        return models.slice();
      });
    }

    fillModelSelect(modelSelect, models, p, t);
    say(available() ? t.hostedReady(model()) : t.hostedOff);
    onChange(state());

    return {
      state: state,
      models: function () {
        return models.slice();
      },
      ready: available,
      available: available,
      refresh: refresh,
      note: function () {
        return available() ? t.hostedNote(p.country) : t.hostedOff;
      },
      exhaustedNote: function () {
        return t.hostedSpent;
      },
    };
  }

  // ---- calling the model ---------------------------------------------------
  //
  // Anthropic speaks the Messages API rather than chat completions. Rather than
  // make every generated app learn two dialects, it is adapted AT THE WIRE:
  // the same OpenAI-style [{role, content}] array goes in, plain text comes out.

  function toAnthropicPayload(messages, model, maxTokens, stream) {
    var system = [];
    var out = [];
    for (var i = 0; i < (messages || []).length; i++) {
      var m = messages[i];
      if (!m) continue;
      if (m.role === "system") {
        if (typeof m.content === "string" && m.content) system.push(m.content);
        continue;
      }
      var role = m.role === "assistant" ? "assistant" : "user";
      var text = typeof m.content === "string" ? m.content : "";
      if (!text) continue;
      var prev = out[out.length - 1];
      // Consecutive same-role turns are merged: the Messages API requires
      // strictly alternating roles.
      if (prev && prev.role === role) prev.content += "\n\n" + text;
      else out.push({ role: role, content: text });
    }
    var payload = { model: model, max_tokens: maxTokens, stream: !!stream, messages: out };
    if (system.length) payload.system = system.join("\n\n");
    return payload;
  }

  function buildPayload(session, messages, opts) {
    var o = opts || {};
    var maxTokens = o.maxTokens || 2048;
    var p = session.provider;
    if (p && p.wire === "anthropic") return toAnthropicPayload(messages, session.model, maxTokens, o.stream);
    var payload = { model: session.model, messages: messages, stream: !!o.stream };
    var extra = p && p.params ? p.params(maxTokens) : { max_tokens: maxTokens };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    if (o.temperature != null) payload.temperature = o.temperature;
    return payload;
  }

  function endpoint(session) {
    var p = session.provider;
    var base = session.baseUrl || (p && p.base) || "";
    return base + (p && p.wire === "anthropic" ? "/messages" : "/chat/completions");
  }

  // Providers report failures in several shapes; surface the most specific
  // message rather than a bare status code, since the key is the usual cause.
  function errorDetail(res) {
    return res.text().then(
      function (body) {
        var msg = "";
        try {
          var j = JSON.parse(body);
          msg = (j && j.error && (j.error.message || j.error)) || j.message || "";
        } catch (e) {
          msg = body.slice(0, 200);
        }
        return new Error(res.status + (msg ? " — " + msg : ""));
      },
      function () {
        return new Error(String(res.status));
      },
    );
  }

  function request(session, messages, opts) {
    return fetch(endpoint(session), {
      method: "POST",
      headers: wireHeaders(session.provider, session.apiKey),
      body: JSON.stringify(buildPayload(session, messages, opts)),
      signal: opts && opts.signal,
    }).then(function (res) {
      if (!res.ok) return errorDetail(res).then(function (err) { throw err; });
      return res;
    });
  }

  /**
   * One complete reply as a string.
   * @returns {Promise<string>}
   */
  function chat(session, messages, opts) {
    return request(session, messages, opts || {}).then(function (res) {
      return res.json().then(function (data) {
        if (session.provider && session.provider.wire === "anthropic") {
          return (data && data.content ? data.content : [])
            .filter(function (b) { return b && b.type === "text"; })
            .map(function (b) { return b.text; })
            .join("");
        }
        var choice = data && data.choices && data.choices[0];
        return (choice && choice.message && choice.message.content) || "";
      });
    });
  }

  /**
   * Stream a reply, calling onDelta(text) for each fragment. Resolves with the
   * full text. Both wires are parsed here so the caller sees only text.
   * @returns {Promise<string>}
   */
  function chatStream(session, messages, onDelta, opts) {
    var o = opts || {};
    o.stream = true;
    var emit = typeof onDelta === "function" ? onDelta : function () {};
    var anthropic = !!(session.provider && session.provider.wire === "anthropic");
    return request(session, messages, o).then(function (res) {
      if (!res.body || !res.body.getReader) {
        // No streaming body available — fall back to the whole answer, so the
        // app still works rather than showing nothing.
        return chat(session, messages, { maxTokens: o.maxTokens, signal: o.signal }).then(function (text) {
          if (text) emit(text);
          return text;
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var full = "";

      function handleLine(line) {
        if (line.indexOf("data:") !== 0) return;
        var raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") return;
        var evt;
        try {
          evt = JSON.parse(raw);
        } catch (e) {
          return;
        }
        var text = "";
        if (anthropic) {
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
            text = evt.delta.text || "";
          }
        } else {
          var choice = evt.choices && evt.choices[0];
          text = (choice && choice.delta && choice.delta.content) || "";
        }
        if (text) {
          full += text;
          emit(text);
        }
      }

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buffer) handleLine(buffer);
            return full;
          }
          buffer += decoder.decode(r.value, { stream: true });
          var parts = buffer.split("\n");
          buffer = parts.pop() || "";
          for (var i = 0; i < parts.length; i++) handleLine(parts[i].replace(/\r$/, ""));
          return pump();
        });
      }
      return pump();
    });
  }

  global.DRKit = {
    PROVIDERS: PROVIDERS,
    HOSTED: HOSTED,
    provider: provider,
    detectProvider: detectProvider,
    labelWithFlag: labelWithFlag,
    filterAndSortModels: filterAndSortModels,
    listModels: listModels,
    fillProviderSelect: fillProviderSelect,
    fillModelSelect: fillModelSelect,
    mountModelPicker: mountModelPicker,
    hosted: hosted,
    hostedConfig: hostedConfig,
    chat: chat,
    chatStream: chatStream,
  };
})(typeof window !== "undefined" ? window : this);
