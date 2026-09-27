import { DT, LifEngine, parseBrainBin } from "./engine";
import type { BrainFrame, BrainMeta, ToBrain } from "./types";

const FRAME_MS = 25; // simulated ms per report
const MAX_DEBT_MS = 120; // never try to catch up more than this
const SLICE_BUDGET_MS = 10; // wall-clock budget per slice so the thread stays responsive

/**
 * Runs the LIF engine in (approximately) real time and reports population rates.
 * Used inside the Web Worker, or on the main thread as a fallback.
 */
export class BrainHost {
  readonly engine: LifEngine;
  readonly meta: BrainMeta;
  readonly popNames: string[];
  private popNodes: Int32Array[];
  private inputs: Record<string, number> = {};
  private opto: Record<string, number> = {};
  private silenced = new Set<string>();
  private debt = 0;
  private lastWall = -1;
  private paused = false;
  // window accumulators
  private winCounts: Uint8Array;
  private winList: number[] = [];
  private dilHist: { wall: number; sim: number }[] = [];

  constructor(brain: ArrayBuffer, meta: BrainMeta, private emit: (f: BrainFrame) => void) {
    this.meta = meta;
    this.engine = new LifEngine(parseBrainBin(brain));
    this.popNames = Object.keys(meta.populations);
    this.popNodes = this.popNames.map((k) => Int32Array.from(meta.populations[k].nodes));
    this.winCounts = new Uint8Array(this.engine.n);
    this.engine.onSpike = (i) => {
      if (this.winCounts[i] === 0) this.winList.push(i);
      if (this.winCounts[i] < 255) this.winCounts[i]++;
    };
  }

  handle(msg: ToBrain): void {
    switch (msg.type) {
      case "inputs":
        this.inputs = msg.rates;
        this.applyRates();
        break;
      case "opto":
        this.opto[msg.pop] = msg.hz;
        this.applyRates();
        break;
      case "silence": {
        const nodes = this.meta.populations[msg.pop]?.nodes;
        if (!nodes) return;
        if (msg.on) this.silenced.add(msg.pop);
        else this.silenced.delete(msg.pop);
        // re-apply all so overlapping populations stay silenced
        this.engine.clearSilenced();
        for (const p of this.silenced) this.engine.setSilenced(this.meta.populations[p].nodes, true);
        break;
      }
      case "reset":
        this.opto = {};
        this.silenced.clear();
        this.engine.clearSilenced();
        this.applyRates();
        this.engine.resetState();
        break;
      case "pause":
        this.paused = msg.paused;
        break;
    }
  }

  /** Per-neuron Poisson rate = max over all populations it belongs to (inputs clamped to the validated envelope). */
  private applyRates(): void {
    const target = new Float64Array(this.engine.n);
    const env = this.meta.envelope_hz;
    for (const [pop, hzRaw] of Object.entries(this.inputs)) {
      const p = this.meta.populations[pop];
      if (!p || !(hzRaw > 0)) continue;
      const hz = Math.min(hzRaw, env[pop] ?? this.meta.opto_hz);
      for (const i of p.nodes) target[i] = Math.max(target[i], hz);
    }
    for (const [pop, hzRaw] of Object.entries(this.opto)) {
      const p = this.meta.populations[pop];
      if (!p || !(hzRaw > 0)) continue;
      const cap = p.kind === "input" ? (env[pop] ?? this.meta.opto_hz) : this.meta.opto_hz;
      const hz = Math.min(hzRaw, cap);
      for (const i of p.nodes) target[i] = Math.max(target[i], hz);
    }
    for (let i = 0; i < target.length; i++) {
      // quantise so tiny input jitter doesn't redraw Poisson clocks every frame
      const hz = Math.round(target[i]);
      if (hz !== this.engine.getRate(i)) this.engine.setRate(i, hz);
    }
  }

  /** Advance toward wall-clock time; call often (every few ms). */
  pump(nowMs: number): void {
    if (this.lastWall < 0) this.lastWall = nowMs;
    const wall = nowMs - this.lastWall;
    this.lastWall = nowMs;
    if (this.paused) return;
    this.debt = Math.min(this.debt + wall, MAX_DEBT_MS);
    const start = performance.now();
    let sim = 0;
    while (this.debt >= FRAME_MS && performance.now() - start < SLICE_BUDGET_MS) {
      this.engine.run(Math.round(FRAME_MS / DT));
      this.debt -= FRAME_MS;
      sim += FRAME_MS;
      this.emitFrame();
    }
    this.dilHist.push({ wall, sim });
    if (this.dilHist.length > 120) this.dilHist.shift();
  }

  private emitFrame(): void {
    const e = this.engine;
    const sec = FRAME_MS / 1000;
    const popRates = new Float32Array(this.popNames.length);
    for (let p = 0; p < this.popNodes.length; p++) {
      const nodes = this.popNodes[p];
      let s = 0;
      for (let k = 0; k < nodes.length; k++) s += this.winCounts[nodes[k]];
      popRates[p] = s / nodes.length / sec;
    }
    const spikes = Uint16Array.from(this.winList);
    const spikeCounts = new Uint8Array(spikes.length);
    for (let k = 0; k < spikes.length; k++) {
      spikeCounts[k] = this.winCounts[spikes[k]];
      this.winCounts[spikes[k]] = 0;
    }
    this.winList.length = 0;
    let w = 0;
    let s = 0;
    for (const h of this.dilHist) {
      w += h.wall;
      s += h.sim;
    }
    this.emit({
      t: e.timeMs,
      windowMs: FRAME_MS,
      popRates,
      spikes,
      spikeCounts,
      activeNeurons: e.activeCount,
      dilation: w > 0 ? s / w : 1,
    });
  }
}
