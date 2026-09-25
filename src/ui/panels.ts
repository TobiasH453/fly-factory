import type { BrainClient } from "../brain/client";
import type { BrainMeta } from "../brain/types";
import { type EconState, UPGRADES, available } from "../game/economy";
import type { ToolId } from "../game/tools";
import { NEURAL_MODES, type WorkerFly } from "../game/workerFly";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export const TOOLS: { id: ToolId; ico: string; name: string; hint: string }[] = [
  { id: "command", ico: "👉", name: "Command", hint: "Click the floor to send the worker there · click the worker to send it back to work" },
  { id: "sugar", ico: "🍬", name: "Sugar", hint: "Drop a sugar cube near the worker's mouth · sugar GRNs → MN9 decides whether it eats" },
  { id: "bitter", ico: "🧪", name: "Bitter", hint: "Spray bitter mist · bitter GRNs suppress MN9, and it laces nearby sugar" },
  { id: "blower", ico: "💨", name: "Blower", hint: "Hold to blow air at the worker · deflects antennae + head bristles, blows dust off" },
  { id: "swat", ico: "🗞️", name: "Swat", hint: "Swing a newspaper at the worker · looming → LC4/LPLC2 → Giant Fiber escape (or BONK)" },
];

/** Worker card, money card, event log, toolbar. */
export class Hud {
  private modeEl = $("#w-mode");
  private badgeEl = $("#w-badge");
  private energyFill = $("#w-energy .fill");
  private energyVal = $("#w-energy .val");
  private dustFill = $("#w-dust .fill");
  private dustVal = $("#w-dust .val");
  private statsEl = $("#w-stats");
  private cashEl = $("#cash");
  private subEl = $("#cash-sub");
  private logEl = $("#log");
  private hintEl = $("#tool-hint");
  private earnHist: { t: number; earned: number }[] = [];
  private t = 0;
  tool: ToolId = "command";
  onTool: (t: ToolId) => void = () => {};
  onToggle: (panel: string) => void = () => {};

  constructor() {
    const bar = $("#toolbar");
    TOOLS.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "tool";
      b.dataset.tool = t.id;
      b.title = t.hint;
      b.innerHTML = `<span class="key">${i + 1}</span><span class="ico">${t.ico}</span><span class="name">${t.name}</span>`;
      b.onclick = () => this.setTool(t.id);
      bar.appendChild(b);
    });
    const sep = document.createElement("div");
    sep.className = "sep";
    bar.appendChild(sep);
    for (const [id, ico, name, key] of [["neuroscope", "🧠", "Brain", "B"], ["opto", "🔬", "Opto Lab", "O"], ["shop", "🛒", "Shop", "S"]]) {
      const b = document.createElement("button");
      b.className = "tool toggle";
      b.dataset.panel = id;
      b.innerHTML = `<span class="key">${key}</span><span class="ico">${ico}</span><span class="name">${name}</span>`;
      b.onclick = () => this.onToggle(id);
      bar.appendChild(b);
    }
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const n = Number(e.key);
      if (n >= 1 && n <= TOOLS.length) this.setTool(TOOLS[n - 1].id);
      const k = e.key.toLowerCase();
      if (k === "b") this.onToggle("neuroscope");
      if (k === "o") this.onToggle("opto");
      if (k === "s") this.onToggle("shop");
    });
    this.setTool("command");
  }

  setTool(t: ToolId) {
    this.tool = t;
    document.querySelectorAll<HTMLElement>(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    this.hintEl.textContent = TOOLS.find((x) => x.id === t)!.hint;
    this.onTool(t);
  }

  setPanelState(panel: string, open: boolean) {
    document.querySelectorAll<HTMLElement>(`.tool[data-panel="${panel}"]`).forEach((b) => b.classList.toggle("on", open));
  }

  log(msg: string, kind: "neural" | "info" | "warn" = "info") {
    const el = document.createElement("div");
    el.className = `log-item ${kind}`;
    el.innerHTML = kind === "neural" ? `<span class="tag">NEURAL</span>${escapeHtml(msg)}` : escapeHtml(msg);
    this.logEl.appendChild(el);
    while (this.logEl.children.length > 6) this.logEl.firstElementChild!.remove();
    setTimeout(() => (el.style.opacity = "0"), 9000);
    setTimeout(() => el.remove(), 9700);
  }

  update(dt: number, w: WorkerFly, econ: EconState) {
    this.t += dt;
    const neural = NEURAL_MODES.has(w.mode);
    const names: Record<string, string> = {
      working: "Working", walking: "Walking to work", waiting: "Waiting for eggs", commanded: "Following orders",
      hungry: "Hungry", exhausted: "Exhausted", feeding: "Eating", grooming: "Grooming", escaping: "Escaping!",
      dazed: "Dazed", moonwalk: "Moonwalking", sprint: "Sprinting", turning: "Turning",
    };
    this.modeEl.textContent = names[w.mode] ?? w.mode;
    this.badgeEl.textContent = neural ? "neural" : "scripted";
    this.badgeEl.className = `badge ${neural ? "neural" : "scripted"}`;
    this.badgeEl.title = neural ? "This behaviour is being decided by the simulated connectome right now" : "Game logic (walking between stations)";
    const e = Math.round(w.energy * 100);
    this.energyFill.style.width = `${e}%`;
    this.energyFill.style.background = w.energy < 0.25 ? "var(--danger)" : "var(--good)";
    this.energyVal.textContent = `${e}%`;
    const d = Math.round(w.dust * 100);
    this.dustFill.style.width = `${d}%`;
    this.dustFill.style.background = "#b29a6a";
    this.dustVal.textContent = `${d}%`;
    const s = w.stats;
    this.statsEl.textContent = `meals ${s.feeds} · grooms ${s.grooms} · escapes ${s.escapes} · bonks ${s.bonks} · trips ${s.trips}`;

    this.cashEl.textContent = `$${Math.floor(econ.money).toLocaleString()}`;
    this.earnHist.push({ t: this.t, earned: econ.earned });
    while (this.earnHist.length > 2 && this.t - this.earnHist[0].t > 60) this.earnHist.shift();
    const h0 = this.earnHist[0];
    const span = Math.max(10, this.t - h0.t);
    const perMin = ((econ.earned - h0.earned) / span) * 60;
    this.subEl.textContent = `${econ.flies.toLocaleString()} flies made · $${perMin.toFixed(0)}/min`;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Opto Lab: optogenetic activation / silencing of any population, like Shiu et al.'s run_exp. */
export class OptoLab {
  private sliders: Record<string, HTMLInputElement> = {};
  private checks: Record<string, HTMLInputElement> = {};
  private vals: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement, private meta: BrainMeta, private brain: BrainClient, private log: (m: string, k?: "neural" | "info" | "warn") => void) {
    const body = $(".body", root);
    body.innerHTML = `
      <p class="note">Drive any population with Poisson spikes (optogenetic activation) or silence it (its synapses stop
      transmitting), exactly like the <code>run_exp</code> manipulations of Shiu et al. 2024. The worker's behaviour follows
      from whatever its descending neurons do.</p>
      <div class="presets"></div>
      <div class="section-title">Readout neurons (descending / motor)</div><div class="outs"></div>
      <div class="section-title">Sensory neurons</div><div class="ins"></div>`;
    const presets: [string, () => void][] = [
      ["🕺 Moonwalk (MDN)", () => this.apply({ MDN: 150 })],
      ["↺ Spin left (DNa02 L)", () => this.apply({ DNa02L: 150 })],
      ["🏃 Sprint (DNp09)", () => this.apply({ DNp09: 150 })],
      ["👅 Tongue out (MN9)", () => this.apply({ MN9: 150 })],
      ["🧼 Itch (grooming DNs)", () => this.apply({ groom: 150 })],
      ["🍭 Phantom sugar", () => this.apply({ sugar: 150 })],
      ["😶 No appetite: silence MN9", () => this.apply({}, ["MN9"])],
      ["🦁 Fearless: silence GF", () => this.apply({}, ["GF"])],
      ["↩ Reset", () => this.apply({})],
    ];
    const pre = $(".presets", body);
    for (const [label, fn] of presets) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      pre.appendChild(b);
    }
    for (const [name, p] of Object.entries(meta.populations)) {
      const row = document.createElement("div");
      row.className = "opto-row";
      const cap = p.kind === "input" ? meta.envelope_hz[name] ?? meta.opto_hz : meta.opto_hz;
      row.innerHTML = `<div class="top"><span>${p.label}</span><span class="spacer"></span><span class="v">0 Hz</span></div>
        <div class="desc">${p.desc} · ${p.nodes.length} neuron${p.nodes.length > 1 ? "s" : ""}</div>
        <input type="range" min="0" max="${cap}" step="5" value="0" aria-label="${p.label} activation rate">
        <label><input type="checkbox"> silence</label>`;
      const slider = $<HTMLInputElement>('input[type="range"]', row);
      const check = $<HTMLInputElement>('input[type="checkbox"]', row);
      this.sliders[name] = slider;
      this.checks[name] = check;
      this.vals[name] = $(".v", row);
      slider.oninput = () => {
        this.vals[name].textContent = `${slider.value} Hz`;
        this.brain.setOpto(name, Number(slider.value));
      };
      slider.onchange = () => {
        if (Number(slider.value) > 0) this.log(`Opto Lab: ${p.label} activated at ${slider.value} Hz`, "info");
      };
      check.onchange = () => {
        this.brain.setSilenced(name, check.checked);
        this.log(`Opto Lab: ${p.label} ${check.checked ? "silenced" : "restored"}`, "info");
      };
      $(p.kind === "input" ? ".ins" : ".outs", body).appendChild(row);
    }
  }

  apply(act: Record<string, number>, silence: string[] = []) {
    for (const name of Object.keys(this.meta.populations)) {
      const hz = act[name] ?? 0;
      this.sliders[name].value = String(hz);
      this.vals[name].textContent = `${hz} Hz`;
      this.brain.setOpto(name, hz);
      const s = silence.includes(name);
      this.checks[name].checked = s;
      this.brain.setSilenced(name, s);
    }
    const parts = [...Object.entries(act).map(([k, v]) => `${this.meta.populations[k].label} ${v} Hz`), ...silence.map((s) => `${this.meta.populations[s].label} silenced`)];
    this.log(parts.length ? `Opto Lab: ${parts.join(", ")}` : "Opto Lab reset", "info");
  }
}

/** Upgrade shop list (mirrors the neon buy pads on the floor). */
export class Shop {
  constructor(private root: HTMLElement, private onBuy: (id: string) => void) {}

  render(econ: EconState) {
    const body = $(".body", this.root);
    const avail = available(econ);
    const owned = UPGRADES.filter((u) => econ.owned.includes(u.id));
    body.innerHTML = `<p class="note">Upgrades also appear as glowing pads on the factory floor. Click either to buy.</p>`;
    for (const u of avail) {
      const el = document.createElement("div");
      el.className = "shop-item";
      el.innerHTML = `<span class="n">${u.name}</span><span class="d">${u.desc}</span>`;
      const b = document.createElement("button");
      b.className = "primary";
      b.textContent = `$${u.cost}`;
      b.disabled = econ.money < u.cost;
      b.onclick = () => this.onBuy(u.id);
      el.appendChild(b);
      body.appendChild(el);
    }
    if (!avail.length) body.insertAdjacentHTML("beforeend", `<p class="note">Everything bought. What a factory!</p>`);
    if (owned.length) body.insertAdjacentHTML("beforeend", `<div class="shop-owned">Owned: ${owned.map((u) => u.name).join(", ")}</div>`);
  }
}
