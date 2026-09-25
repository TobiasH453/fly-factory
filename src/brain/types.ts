export interface PopulationMeta {
  label: string;
  kind: "input" | "output";
  desc: string;
  nodes: number[];
}

export interface ChannelMeta {
  pop: string;
  canonical_condition: string;
  canonical_hz: number;
  threshold_hz: number;
}

export interface BrainMeta {
  version: number;
  source: Record<string, string>;
  params: Record<string, number>;
  full_brain: { neurons: number; connections: number };
  n: number;
  nnz: number;
  synapses: number;
  envelope_hz: Record<string, number>;
  opto_hz: number;
  populations: Record<string, PopulationMeta>;
  channels: Record<string, ChannelMeta>;
  types: string[];
  neuron_type: number[];
  root_ids: string[];
}

/** One report from the brain, covering `windowMs` of simulated time. */
export interface BrainFrame {
  /** simulated time at the end of the window (ms) */
  t: number;
  windowMs: number;
  /** mean firing rate (Hz) of each population in this window, in `popNames` order */
  popRates: Float32Array;
  /** indices of neurons that spiked in the window */
  spikes: Uint16Array;
  /** spike count per neuron in `spikes` (same order) */
  spikeCounts: Uint8Array;
  activeNeurons: number;
  /** simulated ms per wall-clock ms over the last second */
  dilation: number;
}

export type ToBrain =
  | { type: "init"; brain: ArrayBuffer; meta: BrainMeta }
  | { type: "inputs"; rates: Record<string, number> }
  | { type: "opto"; pop: string; hz: number }
  | { type: "silence"; pop: string; on: boolean }
  | { type: "reset" }
  | { type: "pause"; paused: boolean };

export type FromBrain =
  | { type: "ready"; n: number; nnz: number; popNames: string[] }
  | ({ type: "frame" } & BrainFrame)
  | { type: "error"; message: string };
