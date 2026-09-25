import type { BrainFrame, BrainMeta } from "./types";

/** Motor drives decoded from descending / motor neuron activity. */
export interface MotorState {
  /** smoothed firing rate (Hz) per population */
  rates: Record<string, number>;
  /** each drive = smoothed rate / threshold, so >= 1 means "above threshold" */
  feed: number;
  groom: number;
  escape: number;
  /** true on the frame the Giant Fiber crosses threshold */
  escapeTrigger: boolean;
  /** -1: looming DNs on the left are more active (threat from left) ... +1 right */
  threatSide: number;
  /** yaw command from DNa02/DNa01 right - left, -1 (left) .. +1 (right) */
  turn: number;
  forward: number;
  backward: number;
}

const TAU_MS = 90;
const TAU_FAST_MS = 30;

export class Decoder {
  private idx: Record<string, number>;
  private smooth: Record<string, number> = {};
  private fast: Record<string, number> = {};
  private gfAbove = false;
  state: MotorState;

  constructor(
    private meta: BrainMeta,
    popNames: string[],
  ) {
    this.idx = Object.fromEntries(popNames.map((n, i) => [n, i]));
    for (const n of popNames) {
      this.smooth[n] = 0;
      this.fast[n] = 0;
    }
    this.state = this.compute(false);
  }

  thr(ch: string): number {
    return this.meta.channels[ch]?.threshold_hz ?? 10;
  }

  push(f: BrainFrame): MotorState {
    const a = 1 - Math.exp(-f.windowMs / TAU_MS);
    const af = 1 - Math.exp(-f.windowMs / TAU_FAST_MS);
    for (const [n, i] of Object.entries(this.idx)) {
      const r = f.popRates[i];
      this.smooth[n] += a * (r - this.smooth[n]);
      this.fast[n] += af * (r - this.fast[n]);
    }
    const gfOn = (this.fast.GF ?? 0) >= this.thr("escape");
    const trigger = gfOn && !this.gfAbove;
    this.gfAbove = gfOn;
    this.state = this.compute(trigger);
    return this.state;
  }

  private compute(trigger: boolean): MotorState {
    const s = this.smooth;
    const g = (k: string) => s[k] ?? 0;
    const escL = g("escL") / this.thr("escL");
    const escR = g("escR") / this.thr("escR");
    const tl = (g("DNa02L") + 0.5 * g("DNa01L")) / this.thr("turnL");
    const tr = (g("DNa02R") + 0.5 * g("DNa01R")) / this.thr("turnR");
    const tsum = tl + tr;
    return {
      rates: { ...s },
      feed: g("MN9") / this.thr("feed"),
      groom: g("groom") / this.thr("groom"),
      escape: (this.fast.GF ?? 0) / this.thr("escape"),
      escapeTrigger: trigger,
      threatSide: escL + escR > 0.05 ? (escR - escL) / (escL + escR) : 0,
      turn: tsum > 0.2 ? Math.max(-1, Math.min(1, (tr - tl) / Math.max(1, tsum))) : 0,
      forward: g("DNp09") / this.thr("forward"),
      backward: g("MDN") / this.thr("backward"),
    };
  }
}
