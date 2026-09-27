/**
 * Leaky integrate-and-fire engine for the FlyWire connectome.
 *
 * Same model, constants and per-step schedule as Shiu et al. 2024 (Brian2) and as
 * tools/lif_ref.py, which generated and validated the shipped subnetwork:
 *
 *   dv/dt = (v0 - v + g) / t_mbr ,  dg/dt = -g / tau        (frozen while refractory)
 *   spike when v > v_th (not refractory) -> v = v_rst, g = 0, refractory 2.2 ms
 *   each spike adds w_syn * (sign x synapse count) to g of every target after 1.8 ms
 *   stimulated neurons receive Poisson kicks of w_syn * f_poi on v and have no refractory period
 *
 * Step order (Brian2 default schedule): state update -> threshold -> synaptic delivery +
 * Poisson input -> reset.  The linear ODE is integrated exactly.  Only neurons away from
 * rest are updated (event-driven), which is exact up to a 1e-6 mV rest tolerance.
 */

export const DT = 0.1; // ms
export const V_0 = -52;
export const V_RST = -52;
export const V_TH = -45;
export const T_MBR = 20;
export const TAU = 5;
export const T_RFC_STEPS = 22;
export const DELAY_STEPS = 18;
export const W_SYN = 0.275;
export const F_POI = 250;
const REST_EPS = 1e-6;

const A_V = Math.exp(-DT / T_MBR);
const C_G = Math.exp(-DT / TAU);
const B_VG = (TAU / (TAU - T_MBR)) * (C_G - A_V);

export interface Connectome {
  n: number;
  nnz: number;
  indptr: Uint32Array;
  indices: Uint16Array | Uint32Array;
  /** signed synapse counts (sign = predicted transmitter) */
  counts: Int16Array;
}

export function parseBrainBin(buf: ArrayBuffer): Connectome {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "FLYB") throw new Error("not a brain.bin file");
  const n = dv.getUint32(8, true);
  const nnz = dv.getUint32(12, true);
  let off = 16;
  const indptr = new Uint32Array(buf.slice(off, off + (n + 1) * 4));
  off += (n + 1) * 4;
  const indices = new Uint16Array(buf.slice(off, off + nnz * 2));
  off += nnz * 2;
  const counts = new Int16Array(buf.slice(off, off + nnz * 2));
  return { n, nnz, indptr, indices, counts };
}

/** Small fast seedable PRNG (mulberry32) so tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LifEngine {
  readonly n: number;
  readonly c: Connectome;
  readonly weights: Float32Array;
  /** membrane potential (mV) and synaptic drive (mV) */
  readonly v: Float64Array;
  readonly g: Float64Array;
  /** cumulative spike counts since last resetCounts() */
  readonly counts: Uint32Array;
  /** step index */
  step = 0;

  private last: Int32Array;
  private rfc: Uint8Array;
  private isActive: Uint8Array;
  private active: Int32Array;
  private nActive = 0;
  private ring: Int32Array;
  private ringN: Int32Array;
  private spk: Int32Array;
  private silenced: Uint8Array;

  // Poisson stimulation (geometric waiting times == per-step Bernoulli(rate*dt))
  private rate: Float64Array;
  private stimList: number[] = [];
  private nextKick: Float64Array;

  private rng: () => number;
  /** optional per-spike hook (neuron index); used for visualisation */
  onSpike: ((i: number) => void) | null = null;

  constructor(c: Connectome, rng: () => number = Math.random) {
    this.c = c;
    this.n = c.n;
    this.rng = rng;
    const n = c.n;
    this.weights = new Float32Array(c.nnz);
    for (let e = 0; e < c.nnz; e++) this.weights[e] = c.counts[e] * W_SYN;
    this.v = new Float64Array(n).fill(V_0);
    this.g = new Float64Array(n);
    this.counts = new Uint32Array(n);
    this.last = new Int32Array(n).fill(-1_000_000);
    this.rfc = new Uint8Array(n).fill(T_RFC_STEPS);
    this.isActive = new Uint8Array(n);
    this.active = new Int32Array(n);
    this.ring = new Int32Array(DELAY_STEPS * n);
    this.ringN = new Int32Array(DELAY_STEPS);
    this.spk = new Int32Array(n);
    this.silenced = new Uint8Array(n);
    this.rate = new Float64Array(n);
    this.nextKick = new Float64Array(n).fill(Infinity);
  }

  get activeCount(): number {
    return this.nActive;
  }

  get timeMs(): number {
    return this.step * DT;
  }

  /** Set the Poisson stimulation rate (Hz) of one neuron. rate 0 removes the stimulus. */
  setRate(i: number, hz: number): void {
    const was = this.rate[i];
    if (hz === was) return;
    this.rate[i] = hz;
    if (hz > 0) {
      if (!(was > 0)) this.stimList.push(i);
      this.rfc[i] = 0; // Shiu et al.: no refractory period for Poisson targets
      this.nextKick[i] = this.step + this.drawWait(hz);
    } else {
      const k = this.stimList.indexOf(i);
      if (k >= 0) this.stimList.splice(k, 1);
      this.rfc[i] = T_RFC_STEPS;
      this.nextKick[i] = Infinity;
    }
  }

  setRates(nodes: ArrayLike<number>, hz: number): void {
    for (let k = 0; k < nodes.length; k++) this.setRate(nodes[k], hz);
  }

  getRate(i: number): number {
    return this.rate[i];
  }

  /** Silencing (Shiu et al.): the neuron's outgoing synapses have no effect. */
  setSilenced(nodes: ArrayLike<number>, on: boolean): void {
    for (let k = 0; k < nodes.length; k++) this.silenced[nodes[k]] = on ? 1 : 0;
  }

  clearSilenced(): void {
    this.silenced.fill(0);
  }

  isSilenced(i: number): boolean {
    return this.silenced[i] === 1;
  }

  resetCounts(): void {
    this.counts.fill(0);
  }

  /** Reset the whole network to rest (keeps stimulation settings). */
  resetState(): void {
    this.v.fill(V_0);
    this.g.fill(0);
    this.last.fill(-1_000_000);
    this.isActive.fill(0);
    this.nActive = 0;
    this.ringN.fill(0);
    this.step = 0;
    for (const i of this.stimList) this.nextKick[i] = this.drawWait(this.rate[i]);
  }

  /** steps until the next Poisson event, >= 1 (geometric with p = rate * dt) */
  private drawWait(hz: number): number {
    const p = hz * DT * 1e-3;
    if (p >= 1) return 1;
    const u = 1 - this.rng();
    return 1 + Math.floor(Math.log(u) / Math.log1p(-p));
  }

  private activate(i: number): void {
    if (this.isActive[i] === 0) {
      this.isActive[i] = 1;
      this.active[this.nActive++] = i;
    }
  }

  /** Advance the network by `steps` time steps of 0.1 ms. */
  run(steps: number): void {
    const { v, g, last, rfc, active, spk, ring, ringN, silenced, weights, counts } = this;
    const { indptr, indices } = this.c;
    const n = this.n;
    for (let r = 0; r < steps; r++) {
      const s = this.step;
      // groups + thresholds
      let nSpk = 0;
      const nAct = this.nActive;
      for (let a = 0; a < nAct; a++) {
        const i = active[a];
        if (s - last[i] >= rfc[i]) {
          const vi = V_0 + (v[i] - V_0) * A_V + g[i] * B_VG;
          g[i] *= C_G;
          v[i] = vi;
          if (vi > V_TH) spk[nSpk++] = i;
        }
      }
      // synapses: delayed delivery
      const slot = s % DELAY_STEPS;
      const base = slot * n;
      const q = ringN[slot];
      for (let k = 0; k < q; k++) {
        const j = ring[base + k];
        const e1 = indptr[j + 1];
        for (let e = indptr[j]; e < e1; e++) {
          const post = indices[e];
          g[post] += weights[e];
          this.activate(post);
        }
      }
      // synapses: Poisson input on v
      const sl = this.stimList;
      for (let k = 0; k < sl.length; k++) {
        const i = sl[k];
        if (this.nextKick[i] <= s) {
          v[i] += W_SYN * F_POI;
          this.activate(i);
          this.nextKick[i] = s + this.drawWait(this.rate[i]);
        }
      }
      // resets + queue spikes
      let m = 0;
      for (let k = 0; k < nSpk; k++) {
        const i = spk[k];
        v[i] = V_RST;
        g[i] = 0;
        last[i] = s;
        counts[i]++;
        if (silenced[i] === 0) ring[base + m++] = i;
        if (this.onSpike) this.onSpike(i);
      }
      ringN[slot] = m;
      // back to rest
      let w = 0;
      const nA = this.nActive;
      for (let a = 0; a < nA; a++) {
        const i = active[a];
        if (Math.abs(v[i] - V_0) < REST_EPS && Math.abs(g[i]) < REST_EPS && s - last[i] >= rfc[i]) {
          v[i] = V_0;
          g[i] = 0;
          this.isActive[i] = 0;
        } else {
          active[w++] = i;
        }
      }
      this.nActive = w;
      this.step = s + 1;
    }
  }
}
