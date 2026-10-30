/**
 * OSE Dungeon Turn Tracker
 * A Foundry VTT (v13/v14) module that recreates the Old-School Essentials
 * Dungeon Time Tracker sheet: 1 box = 1 turn (10 min), 6 boxes = 1 hour,
 * 144 boxes = 1 day.
 */

const MODULE_ID = "ose-dungeon-turn-tracker";
const TURNS_PER_HOUR = 6;
const HOURS_PER_DAY = 24;
const TURNS_PER_DAY = TURNS_PER_HOUR * HOURS_PER_DAY;
const SECONDS_PER_TURN = 600;

const PRESETS = {
  torch:   { duration: "6",    marker: "T" },
  lantern: { duration: "24",   marker: "L" },
  lightC:  { duration: "12",   marker: "S" },
  lightMU: { duration: "7",    marker: "S" },
  potion:  { duration: "1d6+6", marker: "P" },
  custom:  { duration: "6",    marker: "★" }
};

const L = (key, data) => data
  ? game.i18n.format(`OSEDTT.${key}`, data)
  : game.i18n.localize(`OSEDTT.${key}`);

const setting = key => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

function getState() {
  const s = foundry.utils.deepClone(game.settings.get(MODULE_ID, "state") ?? {});
  s.turn = Number(s.turn) || 0;
  s.timers = Array.isArray(s.timers) ? s.timers : [];
  s.rests = Array.isArray(s.rests) ? s.rests : [];
  s.notes = s.notes ?? "";
  return s;
}

async function saveState(s) {
  // Drop timers / rests that are more than a day in the past to keep the setting small
  const cutoff = s.turn - TURNS_PER_DAY * 2;
  s.timers = s.timers.filter(t => t.end > cutoff);
  s.rests = s.rests.filter(r => r > cutoff);
  await game.settings.set(MODULE_ID, "state", s);
}

function formatElapsed(turns) {
  const minutes = turns * 10;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  parts.push(`${hours}h`);
  parts.push(`${mins}min`);
  return parts.join(" ");
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

/* -------------------------------------------- */
/*  Turn logic (GM only)                        */
/* -------------------------------------------- */

async function setTurn(target) {
  if (!game.user.isGM) return;
  const s = getState();
  target = Math.max(0, Math.floor(target));
  const prev = s.turn;
  if (target === prev) return;

  const wanderingEvents = [];
  const noticeEvents = [];

  if (target > prev) {
    for (let n = prev + 1; n <= target; n++) {
      await processTurn(n, s, wanderingEvents, noticeEvents);
    }
  }

  s.turn = target;
  await saveState(s);

  if (setting("syncWorldTime")) {
    await game.time.advance((target - prev) * SECONDS_PER_TURN);
  }

  await postEvents(wanderingEvents, noticeEvents, target - prev);
}

async function processTurn(n, s, wanderingEvents, noticeEvents) {
  const wInterval = Math.max(1, Number(setting("wanderingInterval")) || 2);
  const rInterval = Math.max(1, Number(setting("restInterval")) || 6);

  // Wandering monster check
  if (n % wInterval === 0) {
    if (setting("autoRoll")) {
      const chance = Number(setting("wanderingChance")) || 1;
      const roll = await new Roll("1d6").evaluate();
      wanderingEvents.push({ turn: n, roll, encounter: roll.total <= chance });
    } else {
      wanderingEvents.push({ turn: n, roll: null, encounter: null });
    }
  }

  // Rest reminder: once per hour unless the party rested during that hour
  if (n % rInterval === 0) {
    const rested = s.rests.some(r => r > n - rInterval && r <= n);
    if (!rested) noticeEvents.push({ turn: n, text: L("Chat.MustRest") });
  }

  // Timers expiring this turn
  for (const t of s.timers) {
    if (t.end === n) noticeEvents.push({ turn: n, text: L("Chat.Expired", { label: escapeHTML(t.label) }) });
  }
}

async function postEvents(wanderingEvents, noticeEvents, delta) {
  const speaker = { alias: L("Title") };
  const gmWhisper = ChatMessage.getWhisperRecipients("GM").map(u => u.id);

  if (wanderingEvents.length) {
    let content = `<div class="osedtt-chat"><h3>${L("Chat.WanderingTitle")}</h3>`;
    const encounters = [];
    for (const ev of wanderingEvents) {
      if (!ev.roll) {
        content += `<p>${L("Chat.WanderingManual", { turn: ev.turn })}</p>`;
        continue;
      }
      if (ev.encounter) encounters.push(ev.turn);
      if (delta === 1) {
        content += await ev.roll.render();
        content += `<p class="${ev.encounter ? "osedtt-encounter" : "osedtt-quiet"}">${ev.encounter ? L("Chat.Encounter") : L("Chat.NoEncounter")}</p>`;
      } else {
        content += `<p>${L("Chat.TurnShort", { turn: ev.turn })}: <strong>${ev.roll.total}</strong> — ${ev.encounter ? `<span class="osedtt-encounter">${L("Chat.Encounter")}</span>` : L("Chat.NoEncounter")}</p>`;
      }
    }
    content += `</div>`;
    await ChatMessage.create({
      speaker,
      content,
      whisper: setting("whisperWandering") ? gmWhisper : [],
      sound: CONFIG.sounds?.dice
    });
    if (encounters.length) ui.notifications.warn(L("Notify.Encounter", { turns: encounters.join(", ") }));
  }

  if (noticeEvents.length) {
    let content = `<div class="osedtt-chat"><h3>${L("Chat.NoticeTitle")}</h3>`;
    for (const ev of noticeEvents) {
      content += `<p>${delta > 1 ? `${L("Chat.TurnShort", { turn: ev.turn })}: ` : ""}${ev.text}</p>`;
    }
    content += `</div>`;
    await ChatMessage.create({ speaker, content });
  }
}

async function rest() {
  if (!game.user.isGM) return;
  const s = getState();
  s.rests.push(s.turn + 1);
  await saveState(s);
  await setTurn(s.turn + 1);
}

async function addTimer({ label, duration, type = "custom" }) {
  if (!game.user.isGM) return;
  const s = getState();
  let turns = Number(duration);
  let rollText = "";
  if (!Number.isFinite(turns)) {
    const roll = await new Roll(String(duration)).evaluate();
    turns = roll.total;
    rollText = ` (${duration} = ${turns})`;
  }
  turns = Math.max(1, Math.floor(turns));
  const marker = PRESETS[type]?.marker ?? "★";
  s.timers.push({
    id: foundry.utils.randomID(),
    label: label || L(`Preset.${type}`),
    type,
    marker,
    start: s.turn,
    end: s.turn + turns
  });
  await saveState(s);
  if (rollText) ui.notifications.info(`${label}${rollText}`);
}

async function removeTimer(id) {
  if (!game.user.isGM) return;
  const s = getState();
  s.timers = s.timers.filter(t => t.id !== id);
  await saveState(s);
}

async function resetTracker() {
  if (!game.user.isGM) return;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: L("Reset") },
    content: `<p>${L("ResetConfirm")}</p>`
  });
  if (!ok) return;
  const s = getState();
  await saveState({ turn: 0, timers: [], rests: [], notes: s.notes });
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

class DungeonTurnTracker extends ApplicationV2 {
  static instance = null;

  constructor(options = {}) {
    super(options);
    this.day = null;      // null = follow the current turn
  }

  static DEFAULT_OPTIONS = {
    id: "ose-dungeon-turn-tracker",
    classes: ["osedtt"],
    tag: "div",
    window: {
      title: "OSEDTT.Title",
      icon: "fa-solid fa-hourglass-half",
      resizable: true
    },
    position: { width: 760, height: "auto" },
    actions: {
      advance: DungeonTurnTracker.#onAdvance,
      back: DungeonTurnTracker.#onBack,
      rest: DungeonTurnTracker.#onRest,
      setTurn: DungeonTurnTracker.#onSetTurn,
      addPreset: DungeonTurnTracker.#onAddPreset,
      addTimer: DungeonTurnTracker.#onAddTimer,
      removeTimer: DungeonTurnTracker.#onRemoveTimer,
      prevDay: DungeonTurnTracker.#onPrevDay,
      nextDay: DungeonTurnTracker.#onNextDay,
      currentDay: DungeonTurnTracker.#onCurrentDay,
      reset: DungeonTurnTracker.#onReset
    }
  };

  static toggle() {
    if (!game.user.isGM && !setting("playersCanView")) {
      ui.notifications.warn(L("Notify.NoAccess"));
      return;
    }
    const app = DungeonTurnTracker.instance ??= new DungeonTurnTracker();
    if (app.rendered) app.close();
    else app.render({ force: true });
  }

  static refresh() {
    const app = DungeonTurnTracker.instance;
    if (app?.rendered) app.render();
  }

  get currentDay() {
    const s = getState();
    const followDay = Math.floor(Math.max(s.turn - 1, 0) / TURNS_PER_DAY);
    return this.day ?? followDay;
  }

  async _prepareContext() {
    return { state: getState(), isGM: game.user.isGM };
  }

  async _renderHTML(context) {
    const { state, isGM } = context;
    const day = this.currentDay;
    const dayStart = day * TURNS_PER_DAY;
    const wInterval = Math.max(1, Number(setting("wanderingInterval")) || 2);
    const rInterval = Math.max(1, Number(setting("restInterval")) || 6);
    const rests = new Set(state.rests);

    // Markers for timers ending on each turn
    const markers = {};
    for (const t of state.timers) {
      (markers[t.end] ??= []).push(t);
    }

    let grid = "";
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      let labels = "";
      let boxes = "";
      for (let i = 1; i <= TURNS_PER_HOUR; i++) {
        const n = dayStart + h * TURNS_PER_HOUR + i;   // absolute turn number of this box
        const letters = `${n % wInterval === 0 ? "W" : ""}${n % rInterval === 0 ? "R" : ""}`;
        labels += `<span class="osedtt-label">${letters}</span>`;

        const classes = ["osedtt-box"];
        if (n <= state.turn) classes.push("done");
        if (n === state.turn + 1) classes.push("next");
        if (rests.has(n)) classes.push("rested");
        const ms = markers[n] ?? [];
        const mark = ms.map(t => t.marker).join("");
        const tip = [`${L("Chat.TurnShort", { turn: n })} · ${formatElapsed(n)}`, ...ms.map(t => `${t.label} ✕`)];
        if (rests.has(n)) tip.push(L("Rested"));
        boxes += `<div class="${classes.join(" ")}" ${isGM ? `data-action="setTurn"` : ""} data-turn="${n}" data-tooltip="${escapeHTML(tip.join("<br>"))}">
          ${rests.has(n) ? `<span class="osedtt-r">R</span>` : ""}${mark ? `<span class="osedtt-mark">${escapeHTML(mark)}</span>` : ""}
        </div>`;
      }
      grid += `<div class="osedtt-hour">
        <div class="osedtt-labels">${labels}</div>
        <div class="osedtt-boxes">${boxes}</div>
        <div class="osedtt-hour-num">${h + 1}h</div>
      </div>`;
    }

    const active = state.timers.filter(t => t.end > state.turn).sort((a, b) => a.end - b.end);
    let timers = active.map(t => {
      const left = t.end - state.turn;
      return `<li class="osedtt-timer ${left <= 1 ? "warn" : ""}">
        <span class="osedtt-timer-mark">${escapeHTML(t.marker)}</span>
        <span class="osedtt-timer-label">${escapeHTML(t.label)}</span>
        <span class="osedtt-timer-left">${L("TurnsLeft", { n: left })}</span>
        ${isGM ? `<a data-action="removeTimer" data-id="${t.id}" data-tooltip="${L("Remove")}"><i class="fa-solid fa-xmark"></i></a>` : ""}
      </li>`;
    }).join("");
    if (!timers) timers = `<li class="osedtt-empty">${L("NoTimers")}</li>`;

    const turnOfDay = state.turn - Math.floor(Math.max(state.turn - 1, 0) / TURNS_PER_DAY) * TURNS_PER_DAY;
    const nextW = Math.ceil((state.turn + 1) / wInterval) * wInterval - state.turn;

    const controls = isGM ? `
      <div class="osedtt-controls">
        <button type="button" data-action="back" data-tooltip="${L("BackTip")}"><i class="fa-solid fa-rotate-left"></i> −1</button>
        <button type="button" class="osedtt-primary" data-action="advance"><i class="fa-solid fa-forward-step"></i> ${L("Advance")}</button>
        <button type="button" data-action="rest" data-tooltip="${L("RestTip")}"><i class="fa-solid fa-campground"></i> ${L("Rest")}</button>
        <span class="osedtt-sep"></span>
        <button type="button" data-action="addPreset" data-type="torch"><i class="fa-solid fa-fire"></i> ${L("Preset.torch")}</button>
        <button type="button" data-action="addPreset" data-type="lantern"><i class="fa-solid fa-lightbulb"></i> ${L("Preset.lantern")}</button>
        <button type="button" data-action="addTimer"><i class="fa-solid fa-plus"></i> ${L("Timer")}</button>
        <span class="osedtt-sep"></span>
        <button type="button" data-action="reset" data-tooltip="${L("Reset")}"><i class="fa-solid fa-trash-can"></i></button>
      </div>` : "";

    return `
      <section class="osedtt-wrap">
        <header class="osedtt-header">
          <div class="osedtt-stats">
            <div><span class="osedtt-big">${state.turn}</span> ${L("TotalTurns")}</div>
            <div>${L("Elapsed")}: <strong>${formatElapsed(state.turn)}</strong></div>
            <div>${L("TurnOfDay")}: <strong>${turnOfDay}/${TURNS_PER_DAY}</strong></div>
            <div>${L("NextW")}: <strong>${nextW}</strong></div>
          </div>
          <div class="osedtt-daynav">
            <a data-action="prevDay"><i class="fa-solid fa-chevron-left"></i></a>
            <a data-action="currentDay" data-tooltip="${L("CurrentDay")}">${L("Day")} ${day + 1}</a>
            <a data-action="nextDay"><i class="fa-solid fa-chevron-right"></i></a>
          </div>
        </header>
        ${controls}
        <div class="osedtt-legend">
          <span><b>W</b> ${L("Legend.W")}</span>
          <span><b>R</b> ${L("Legend.R")}</span>
          <span><b>T</b> ${L("Legend.T")}</span>
          <span><b>L</b> ${L("Legend.L")}</span>
        </div>
        <div class="osedtt-grid">${grid}</div>
        <div class="osedtt-bottom">
          <div class="osedtt-timers">
            <h4>${L("ActiveTimers")}</h4>
            <ul>${timers}</ul>
          </div>
          <div class="osedtt-notes">
            <h4>${L("Notes")}</h4>
            <textarea name="notes" ${isGM ? "" : "readonly"}>${escapeHTML(state.notes)}</textarea>
          </div>
        </div>
      </section>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const ta = this.element.querySelector("textarea[name=notes]");
    if (ta && game.user.isGM) {
      ta.addEventListener("change", async ev => {
        const s = getState();
        s.notes = ev.target.value;
        await saveState(s);
      });
    }
  }

  async close(options) {
    this.day = null;
    return super.close(options);
  }

  /* ---- Actions ---- */

  static async #onAdvance() {
    this.day = null;
    await setTurn(getState().turn + 1);
  }

  static async #onBack() {
    this.day = null;
    await setTurn(getState().turn - 1);
  }

  static async #onRest() {
    this.day = null;
    await rest();
  }

  static async #onSetTurn(event, target) {
    const n = Number(target.dataset.turn);
    const current = getState().turn;
    // Clicking the last ticked box un-ticks it
    const goal = n === current ? n - 1 : n;
    if (goal - current > TURNS_PER_HOUR) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: L("Title") },
        content: `<p>${L("JumpConfirm", { n: goal - current })}</p>`
      });
      if (!ok) return;
    }
    await setTurn(goal);
  }

  static async #onAddPreset(event, target) {
    const type = target.dataset.type;
    await addTimer({ label: L(`Preset.${type}`), duration: PRESETS[type].duration, type });
  }

  static async #onAddTimer() {
    const options = Object.keys(PRESETS)
      .map(k => `<option value="${k}" data-duration="${PRESETS[k].duration}">${L(`Preset.${k}`)} (${PRESETS[k].duration})</option>`)
      .join("");
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: L("AddTimer") },
      content: `
        <div class="form-group"><label>${L("Type")}</label>
          <select name="type" onchange="this.form.duration.value=this.selectedOptions[0].dataset.duration">${options}</select></div>
        <div class="form-group"><label>${L("Label")}</label>
          <input type="text" name="label" placeholder="${L("LabelHint")}"></div>
        <div class="form-group"><label>${L("Duration")}</label>
          <input type="text" name="duration" value="${PRESETS.torch.duration}"></div>
        <p class="hint">${L("DurationHint")}</p>`,
      ok: {
        label: L("Add"),
        callback: (event, button) => {
          const f = button.form.elements;
          return { type: f.type.value, label: f.label.value.trim(), duration: f.duration.value.trim() };
        }
      },
      rejectClose: false
    });
    if (!result?.duration) return;
    if (!result.label) result.label = L(`Preset.${result.type}`);
    await addTimer(result);
  }

  static async #onRemoveTimer(event, target) {
    await removeTimer(target.dataset.id);
  }

  static #onPrevDay() {
    this.day = Math.max(0, this.currentDay - 1);
    this.render();
  }

  static #onNextDay() {
    this.day = this.currentDay + 1;
    this.render();
  }

  static #onCurrentDay() {
    this.day = null;
    this.render();
  }

  static async #onReset() {
    this.day = null;
    await resetTracker();
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);

  reg("state", {
    scope: "world",
    config: false,
    type: Object,
    default: { turn: 0, timers: [], rests: [], notes: "" },
    onChange: () => DungeonTurnTracker.refresh()
  });

  reg("wanderingInterval", {
    name: "OSEDTT.Settings.wanderingInterval.name",
    hint: "OSEDTT.Settings.wanderingInterval.hint",
    scope: "world", config: true, type: Number, default: 2,
    onChange: () => DungeonTurnTracker.refresh()
  });

  reg("wanderingChance", {
    name: "OSEDTT.Settings.wanderingChance.name",
    hint: "OSEDTT.Settings.wanderingChance.hint",
    scope: "world", config: true, type: Number, default: 1,
    range: { min: 0, max: 6, step: 1 }
  });

  reg("autoRoll", {
    name: "OSEDTT.Settings.autoRoll.name",
    hint: "OSEDTT.Settings.autoRoll.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  reg("whisperWandering", {
    name: "OSEDTT.Settings.whisperWandering.name",
    hint: "OSEDTT.Settings.whisperWandering.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  reg("restInterval", {
    name: "OSEDTT.Settings.restInterval.name",
    hint: "OSEDTT.Settings.restInterval.hint",
    scope: "world", config: true, type: Number, default: 6,
    onChange: () => DungeonTurnTracker.refresh()
  });

  reg("syncWorldTime", {
    name: "OSEDTT.Settings.syncWorldTime.name",
    hint: "OSEDTT.Settings.syncWorldTime.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg("playersCanView", {
    name: "OSEDTT.Settings.playersCanView.name",
    hint: "OSEDTT.Settings.playersCanView.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.keybindings.register(MODULE_ID, "toggle", {
    name: "OSEDTT.Keybind.toggle",
    editable: [],
    onDown: () => { DungeonTurnTracker.toggle(); return true; }
  });

  game.keybindings.register(MODULE_ID, "advance", {
    name: "OSEDTT.Keybind.advance",
    editable: [],
    restricted: true,
    onDown: () => { setTurn(getState().turn + 1); return true; }
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    open: () => DungeonTurnTracker.toggle(),
    advance: (n = 1) => setTurn(getState().turn + n),
    setTurn,
    rest,
    addTimer,
    getState
  };
});

// Button in the Token controls (left toolbar)
Hooks.on("getSceneControlButtons", controls => {
  const tool = {
    name: "osedtt",
    title: "OSEDTT.Title",
    icon: "fa-solid fa-hourglass-half",
    button: true,
    visible: game.user.isGM || setting("playersCanView"),
    onChange: () => DungeonTurnTracker.toggle()
  };
  try {
    if (Array.isArray(controls)) {
      controls.find(c => c.name === "token")?.tools.push(tool);
    } else {
      const tokens = controls.tokens ?? controls.token;
      if (!tokens) return;
      tool.order = Object.keys(tokens.tools ?? {}).length;
      tokens.tools[tool.name] = tool;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Could not add scene control button`, err);
  }
});
