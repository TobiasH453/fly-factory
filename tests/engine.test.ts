import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Connectome, DELAY_STEPS, DT, LifEngine, T_MBR, TAU, V_0, V_TH, W_SYN, mulberry32, parseBrainBin,
} from "../src/brain/engine";
import type { BrainMeta } from "../src/brain/types";

const data = (f: string) => new URL(`../src/data/${f}`, import.meta.url);

function tiny(edges: [number, number, number][], n: number): Connectome {
  const sorted = [...edges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const indptr = new Uint32Array(n + 1);
  for (const [pre] of sorted) indptr[pre + 1]++;
  for (let i = 0; i < n; i++) indptr[i + 1] += indptr[i];
  return {
    n,
    nnz: sorted.length,
    indptr,
    indices: Uint16Array.from(sorted.map((e) => e[1])),
    counts: Int16Array.from(sorted.map((e) => e[2])),
  };
}

describe("LIF engine (Shiu et al. 2024 semantics)", () => {
  it("stays exactly at rest without input", () => {
    const e = new LifEngine(tiny([[0, 1, 5]], 2));
    e.run(5000);
    expect(e.v[0]).toBe(V_0);
    expect(e.v[1]).toBe(V_0);
    expect(e.activeCount).toBe(0);
  });

  it("delivers a spike after 1.8 ms and integrates the alpha synapse exactly", () => {
    const count = 10;
    const e = new LifEngine(tiny([[0, 1, count]], 2), mulberry32(1));
    e.setRate(0, 1e5); // p >= 1: a kick every step
    let spikeStep = -1;
    e.onSpike = (i) => {
      if (i === 0 && spikeStep < 0) {
        spikeStep = e.step;
        e.setRate(0, 0);
      }
    };
    const trace: number[] = [];
    for (let s = 0; s < 400; s++) {
      e.run(1);
      trace.push(e.v[1]);
    }
    expect(spikeStep).toBeGreaterThanOrEqual(0);
    // first effect on v: g jumps at step spike+DELAY (synapse phase), v moves on the following step
    const firstMove = trace.findIndex((v) => v !== V_0);
    expect(firstMove).toBe(spikeStep + DELAY_STEPS + 1);
    // analytic peak of u(t) = w * tau/(tau - t_mbr) * (e^{-t/tau} - e^{-t/t_mbr})
    const w = count * W_SYN;
    let peak = 0;
    for (let k = 1; k < 2000; k++) {
      const t = k * DT;
      peak = Math.max(peak, w * (TAU / (TAU - T_MBR)) * (Math.exp(-t / TAU) - Math.exp(-t / T_MBR)));
    }
    const simPeak = Math.max(...trace) - V_0;
    expect(simPeak).toBeCloseTo(peak, 6);
  });

  it("inhibitory synapses hyperpolarise", () => {
    const e = new LifEngine(tiny([[0, 1, -20]], 2), mulberry32(2));
    e.setRate(0, 1e5);
    e.run(3);
    e.setRate(0, 0);
    e.run(60);
    expect(e.v[1]).toBeLessThan(V_0);
  });

  it("enough coincident excitation makes the target spike; silencing blocks it", () => {
    const run = (silence: boolean) => {
      const e = new LifEngine(tiny([[0, 1, 200]], 2), mulberry32(3));
      if (silence) e.setSilenced([0], true);
      e.setRate(0, 200);
      e.run(10000);
      return e.counts[1];
    };
    expect(run(false)).toBeGreaterThan(50);
    expect(run(true)).toBe(0);
    expect(V_TH).toBe(-45);
  });

  it("Poisson stimulation fires stimulated neurons at the requested rate", () => {
    const e = new LifEngine(tiny([], 50), mulberry32(4));
    for (let i = 0; i < 50; i++) e.setRate(i, 100);
    e.run(20000); // 2 s
    let s = 0;
    for (let i = 0; i < 50; i++) s += e.counts[i];
    const rate = s / 50 / 2;
    expect(rate).toBeGreaterThan(92);
    expect(rate).toBeLessThan(108);
  });
});

describe("shipped FlyWire subnetwork reproduces the Python full-brain reference", () => {
  const buf = readFileSync(data("brain.bin"));
  const conn = parseBrainBin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const meta = JSON.parse(readFileSync(data("meta.json"), "utf8")) as BrainMeta;
  const ref = JSON.parse(readFileSync(data("reference_rates.json"), "utf8")) as Record<
    string,
    { stim: Record<string, number>; rates: Record<string, number> }
  >;

  it("matches metadata", () => {
    expect(conn.n).toBe(meta.n);
    expect(conn.nnz).toBe(meta.nnz);
  });

  for (const [cond, r] of Object.entries(ref)) {
    it(`condition ${cond}`, () => {
      const trials = 3;
      const sums: Record<string, number> = {};
      for (let t = 0; t < trials; t++) {
        const e = new LifEngine(conn, mulberry32(100 + t));
        for (const [i, hz] of Object.entries(r.stim)) e.setRate(Number(i), hz);
        e.run(10000); // 1 s
        for (const pop of Object.keys(r.rates)) {
          const nodes = meta.populations[pop].nodes;
          let s = 0;
          for (const i of nodes) s += e.counts[i];
          sums[pop] = (sums[pop] ?? 0) + s / nodes.length / trials;
        }
      }
      for (const [pop, want] of Object.entries(r.rates)) {
        const got = sums[pop];
        const tol = Math.max(6, want * 0.12);
        expect(Math.abs(got - want), `${pop}: JS ${got.toFixed(1)} Hz vs Python ${want.toFixed(1)} Hz`).toBeLessThanOrEqual(tol);
      }
    });
  }
});
