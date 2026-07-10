// The battle overlay: renders the server's battle state, sends one intent
// per turn, and plays the returned event list back as log lines + HP-bar
// updates. All rules live server-side — this file only presents. The event
// vocabulary it renders is the BattleEvent typedef in src/tokemon.js.

const TYPE_LABEL = {
  neural: "Neural",
  compute: "Compute",
  data: "Data",
  code: "Code",
  spark: "Spark",
  logic: "Logic",
  adversarial: "Adversarial",
  phantom: "Phantom",
};

const BALL_LABEL = { tokeball: "Tokeball", megaball: "Megaball", hyperball: "Hyperball" };
const HEAL_LABEL = { potion: "Patch (+20)", superpotion: "Hotfix (+50)", revive: "Reboot" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {HTMLElement} root  Where the overlay element is appended.
 * @param {{
 *   onAction: (action: object) => Promise<{events?: object[], battle?: object|null, save?: object}>,
 *   onEnd?: (result: string, save: object) => void,
 * }} hooks  onAction posts one battle intent; onEnd fires after the
 *   overlay closes (won/lost/caught/fled).
 * @returns {{open: (battle: object, save: object) => void, isOpen: () => boolean}}
 */
export function createBattleUI(root, { onAction, onEnd }) {
  let save = null;
  let battle = null;
  let busy = false;
  let moveNames = {}; // moveId → display name, learned from the party payload

  const el = document.createElement("div");
  el.id = "tk-battle";
  el.hidden = true;
  root.appendChild(el);

  const active = () => save?.party.find((c) => c.uid === battle?.activeUid) || null;

  function hpBar(hp, maxHp) {
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const cls = pct < 20 ? "crit" : pct < 50 ? "low" : "";
    return `<div class="tk-hpbar"><div class="tk-hpfill ${cls}" style="width:${pct}%"></div></div>
      <span class="tk-hpnum">${hp}/${maxHp}</span>`;
  }

  function creatureCard(c, side) {
    if (!c) return "";
    const types = (c.types || []).map((t) => `<span class="tk-type tk-type-${t}">${TYPE_LABEL[t]}</span>`).join("");
    return `<div class="tk-card tk-${side}">
      <div class="tk-card-head"><span class="tk-emoji">${c.emoji || "❔"}</span>
        <b>${esc(c.name)}</b> <span class="tk-lv">Lv ${c.level}</span> ${types}
        ${side === "foe" && c.count > 1 ? `<span class="tk-lv">${c.idx + 1}/${c.count}</span>` : ""}</div>
      ${hpBar(c.hp, c.maxHp)}
    </div>`;
  }

  function actionsHtml() {
    const me = active();
    if (!me) return "";
    const moves = me.moves
      .map(
        (m) => `<button class="tk-move tk-type-${m.type}" data-move="${m.id}" ${m.pp <= 0 || busy ? "disabled" : ""}>
          ${esc(m.name)}<small>${TYPE_LABEL[m.type]} · ${m.power} · PP ${m.pp}/${m.maxPp}</small></button>`,
      )
      .join("");
    const balls = Object.entries(BALL_LABEL)
      .filter(([id]) => save.items[id] > 0)
      .map(([id, label]) => `<button data-ball="${id}" ${busy ? "disabled" : ""}>${label} ×${save.items[id]}</button>`)
      .join("");
    const heals = Object.entries(HEAL_LABEL)
      .filter(([id]) => save.items[id] > 0)
      .map(([id, label]) => `<button data-item="${id}" ${busy ? "disabled" : ""}>${label} ×${save.items[id]}</button>`)
      .join("");
    const switches = save.party
      .filter((c) => c.uid !== me.uid && c.hp > 0)
      .map((c) => `<button data-switch="${c.uid}" ${busy ? "disabled" : ""}>${c.emoji} ${esc(c.name)} Lv ${c.level} (${c.hp}/${c.maxHp})</button>`)
      .join("");
    const wild = battle.kind === "wild";
    return `
      <div class="tk-moves">${moves}</div>
      <div class="tk-actrow">
        ${wild ? `<div class="tk-sub"><span>Catch:</span>${balls || "<i>no balls</i>"}</div>` : ""}
        <div class="tk-sub"><span>Items:</span>${heals || "<i>none</i>"}</div>
        ${switches ? `<div class="tk-sub"><span>Switch:</span>${switches}</div>` : ""}
        ${wild ? `<button class="tk-run" data-run ${busy ? "disabled" : ""}>Run</button>` : ""}
      </div>`;
  }

  function render() {
    if (!battle) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const header = battle.kind === "villain" ? `<div class="tk-villain">🦹 Villain <b>${esc(battle.villain)}</b> challenges you!</div>` : "";
    el.innerHTML = `
      <div class="tk-battle-box">
        ${header}
        ${creatureCard(battle.foe, "foe")}
        ${creatureCard(activeAsCard(), "self")}
        <div class="tk-log" id="tk-log"></div>
        <div class="tk-actions">${actionsHtml()}</div>
      </div>`;
    el.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => act({ type: "move", move: b.dataset.move })));
    el.querySelectorAll("[data-ball]").forEach((b) => b.addEventListener("click", () => act({ type: "catch", ball: b.dataset.ball })));
    el.querySelectorAll("[data-item]").forEach((b) => b.addEventListener("click", () => act({ type: "item", item: b.dataset.item, uid: active()?.uid })));
    el.querySelectorAll("[data-switch]").forEach((b) => b.addEventListener("click", () => act({ type: "switch", uid: b.dataset.switch })));
    el.querySelector("[data-run]")?.addEventListener("click", () => act({ type: "run" }));
  }

  function activeAsCard() {
    const me = active();
    if (!me) return null;
    return { ...me, types: me.types };
  }

  function logLine(text, cls = "") {
    const log = el.querySelector("#tk-log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function nameOfMove(id) {
    return moveNames[id] || id.replace(/_/g, " ");
  }

  function learnMoveNames(s) {
    for (const c of [...(s?.party || []), ...(s?.box || [])]) {
      for (const m of c.moves || []) moveNames[m.id] = m.name;
    }
  }

  // Present one server event as a log line (and update cards where cheap).
  function describe(e) {
    const meName = active()?.name || "Your Tokemon";
    const foeName = battle?.foe?.name ? `Wild ${battle.foe.name}` : "The foe";
    const attacker = e.who === "player" ? meName : foeName;
    switch (e.t) {
      case "hit": {
        let extra = "";
        if (e.mult > 1) extra = " It's super effective!";
        else if (e.mult < 1) extra = " Not very effective…";
        if (e.crit) extra += " Critical hit!";
        return `${attacker} used ${nameOfMove(e.move)} — ${e.dmg} damage.${extra}`;
      }
      case "miss":
        return `${attacker} used ${nameOfMove(e.move)}… it missed!`;
      case "immune":
        return `${attacker}'s ${nameOfMove(e.move)} doesn't affect the target.`;
      case "faint":
        return e.who === "foe" ? `${foeName} fainted!` : `${meName} fainted!`;
      case "xp":
        return `${meName} gained ${e.gained} XP.`;
      case "levelup":
        return `${meName} grew to level ${e.level}!`;
      case "learned":
        return `${meName} learned ${nameOfMove(e.move)}!`;
      case "forgot":
        return `${meName} forgot ${nameOfMove(e.move)}.`;
      case "evolved":
        return `What?! ${meName} is evolving… it became ${e.to.charAt(0).toUpperCase() + e.to.slice(1)}!`;
      case "caught":
        return `Gotcha! It was caught and sent to your ${e.where}!`;
      case "broke_free":
        return "Oh no — it broke free!";
      case "escaped":
        return "Got away safely.";
      case "escape_failed":
        return "Couldn't escape!";
      case "switched":
        return e.forced ? "Go — next Tokemon!" : "Come back! Go!";
      case "foe_next":
        return `The villain sends out ${e.foe?.name} (Lv ${e.foe?.level})!`;
      case "item_used":
        return "Item used.";
      case "reward":
        return `Victory spoils: ${Object.entries(e.reward).map(([k, v]) => `${v}× ${BALL_LABEL[k] || HEAL_LABEL[k] || k}`).join(", ")}.`;
      case "end":
        return e.result === "won" ? "You won the battle!" : e.result === "lost" ? "You're out of able Tokemon… you black out." : null;
      default:
        return null;
    }
  }

  // Send one intent, then play the returned events back sequentially (paced
  // sleeps, live HP updates on hits) before adopting the new server state.
  async function act(action) {
    if (busy || !battle) return;
    busy = true;
    render(); // disable buttons
    let result;
    try {
      result = await onAction(action);
    } catch (err) {
      busy = false;
      logLine(err.message || "That didn't work.", "tk-err");
      render();
      return;
    }
    // Play events over the CURRENT card state, then adopt the new state.
    for (const e of result.events || []) {
      const text = describe(e);
      if (text) logLine(text, e.t === "hit" && e.who === "foe" ? "tk-foe-line" : "");
      // Live HP updates mid-playback for hits.
      if (e.t === "hit") {
        const card = e.who === "player" ? el.querySelector(".tk-foe") : el.querySelector(".tk-self");
        const target = e.who === "player" ? result.battle?.foe : null;
        if (card && e.defenderHp !== undefined) {
          const num = card.querySelector(".tk-hpnum");
          const max = target?.maxHp || Number(num?.textContent.split("/")[1] || 1);
          const fill = card.querySelector(".tk-hpfill");
          const pct = Math.max(0, Math.min(100, (e.defenderHp / max) * 100));
          if (fill) fill.style.width = `${pct}%`;
          if (num) num.textContent = `${e.defenderHp}/${max}`;
        }
      }
      await sleep(e.t === "hit" || e.t === "faint" ? 550 : 350);
    }
    save = result.save || save;
    learnMoveNames(save);
    battle = result.battle || null;
    busy = false;
    if (!battle) {
      const end = (result.events || []).find((x) => x.t === "end");
      await sleep(900);
      el.hidden = true;
      onEnd?.(end?.result || "done", save);
    } else {
      render();
    }
  }

  return {
    open(b, s) {
      battle = b;
      save = s;
      learnMoveNames(s);
      busy = false;
      render();
      if (battle.kind === "wild" && battle.foe) logLine(`A wild ${battle.foe.name} (Lv ${battle.foe.level}) appeared!`);
      if (battle.kind === "villain") logLine(`Villain ${battle.villain} wants to fight! (${battle.foe.count} Tokemon)`);
    },
    isOpen: () => !el.hidden,
  };
}
