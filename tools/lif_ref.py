"""Reference leaky integrate-and-fire simulator for the FlyWire connectome.

Re-implements the model of Shiu et al. 2024 (github.com/philshiu/Drosophila_brain_model,
model.py) with the same constants and the same Brian2 semantics, but event-driven
and compiled with numba so the whole 139k-neuron brain runs in seconds:

    dv/dt = (v_0 - v + g) / t_mbr     (unless refractory)
    dg/dt = -g / tau                  (unless refractory)
    spike: v > v_th and not refractory  ->  v = v_rst, g = 0
    synapse: g_post += w_syn * (sign x synapse count), delivered after t_dly
    stimulation: PoissonInput on v with weight w_syn * f_poi, refractory 0 for stimulated cells
    silencing: outgoing synapses of a neuron have no effect

Per 0.1 ms step we follow Brian2's default schedule: state update ('groups'),
threshold, synaptic delivery + Poisson input ('synapses'), reset.  The linear
ODE is integrated exactly (Brian2 method='linear').  Neurons at rest (v == v_0,
g == 0) are skipped; a neuron is returned to the rest set once it is within
1e-6 mV of rest, which is the only (negligible) deviation from Brian2.

The browser engine (src/brain/engine.ts) implements exactly the same algorithm.
"""
from __future__ import annotations

import math

import numba as nb
import numpy as np

DT = 0.1  # ms
V_0 = -52.0
V_RST = -52.0
V_TH = -45.0
T_MBR = 20.0
TAU = 5.0
T_RFC_STEPS = 22  # 2.2 ms
DELAY_STEPS = 18  # 1.8 ms
W_SYN = 0.275  # mV per synapse
F_POI = 250.0
REST_EPS = 1e-6

A_V = math.exp(-DT / T_MBR)
C_G = math.exp(-DT / TAU)
B_VG = TAU / (TAU - T_MBR) * (C_G - A_V)


@nb.njit(cache=True)
def _simulate(indptr, indices, weights, n, n_steps, stim_idx, stim_p, silenced, seed, rec_idx):
    """Run one trial.

    weights are already in mV.  stim_p is per-step Poisson probability (rate * dt).
    Returns per-neuron spike counts and a (step, rec_slot) spike list for rec_idx neurons.
    """
    np.random.seed(seed)
    v = np.full(n, V_0)
    g = np.zeros(n)
    last = np.full(n, -1_000_000, dtype=np.int64)
    rfc = np.full(n, T_RFC_STEPS, dtype=np.int64)
    for k in range(stim_idx.shape[0]):
        rfc[stim_idx[k]] = 0
    counts = np.zeros(n, dtype=np.int32)

    is_active = np.zeros(n, dtype=np.bool_)
    active = np.empty(n, dtype=np.int32)
    n_active = 0
    ring = np.empty((DELAY_STEPS, n), dtype=np.int32)
    ring_n = np.zeros(DELAY_STEPS, dtype=np.int32)
    spk = np.empty(n, dtype=np.int32)
    not_ref = np.zeros(n, dtype=np.bool_)

    rec_slot = np.full(n, -1, dtype=np.int32)
    for k in range(rec_idx.shape[0]):
        rec_slot[rec_idx[k]] = k
    rec_cap = 1024
    rec_t = np.empty(rec_cap, dtype=np.int32)
    rec_i = np.empty(rec_cap, dtype=np.int32)
    n_rec = 0

    for s in range(n_steps):
        # --- groups: exact linear update for non-refractory active cells
        n_spk = 0
        for a in range(n_active):
            i = active[a]
            nr = (s - last[i]) >= rfc[i]
            not_ref[i] = nr
            if nr:
                vi = V_0 + (v[i] - V_0) * A_V + g[i] * B_VG
                g[i] = g[i] * C_G
                v[i] = vi
            # --- thresholds
            if nr and v[i] > V_TH:
                spk[n_spk] = i
                n_spk += 1
        # --- synapses: delayed delivery of spikes from step s - DELAY
        slot = s % DELAY_STEPS
        for q in range(ring_n[slot]):
            j = ring[slot, q]
            for e in range(indptr[j], indptr[j + 1]):
                post = indices[e]
                g[post] += weights[e]
                if not is_active[post]:
                    is_active[post] = True
                    active[n_active] = post
                    n_active += 1
        # --- synapses: Poisson input onto v
        for k in range(stim_idx.shape[0]):
            if np.random.random() < stim_p[k]:
                i = stim_idx[k]
                v[i] += W_SYN * F_POI
                if not is_active[i]:
                    is_active[i] = True
                    active[n_active] = i
                    n_active += 1
        # --- resets + queue spikes
        ring_n[slot] = 0
        for q in range(n_spk):
            i = spk[q]
            v[i] = V_RST
            g[i] = 0.0
            last[i] = s
            counts[i] += 1
            if not silenced[i]:
                ring[slot, ring_n[slot]] = i
                ring_n[slot] += 1
            if rec_slot[i] >= 0:
                if n_rec == rec_cap:
                    rec_cap *= 2
                    nt = np.empty(rec_cap, dtype=np.int32)
                    ni = np.empty(rec_cap, dtype=np.int32)
                    nt[:n_rec] = rec_t[:n_rec]
                    ni[:n_rec] = rec_i[:n_rec]
                    rec_t = nt
                    rec_i = ni
                rec_t[n_rec] = s
                rec_i[n_rec] = rec_slot[i]
                n_rec += 1
        # --- return quiescent cells to the rest set
        w_ = 0
        for a in range(n_active):
            i = active[a]
            if abs(v[i] - V_0) < REST_EPS and abs(g[i]) < REST_EPS and (s - last[i]) >= rfc[i]:
                v[i] = V_0
                g[i] = 0.0
                is_active[i] = False
            else:
                active[w_] = i
                w_ += 1
        n_active = w_
    return counts, rec_t[:n_rec], rec_i[:n_rec]


class Network:
    """CSR connectome (rows = presynaptic neuron)."""

    def __init__(self, pre: np.ndarray, post: np.ndarray, w_count: np.ndarray, n: int):
        order = np.lexsort((post, pre))
        pre, post, w_count = pre[order], post[order], w_count[order]
        self.n = int(n)
        self.indptr = np.zeros(n + 1, dtype=np.int64)
        np.add.at(self.indptr, pre + 1, 1)
        self.indptr = np.cumsum(self.indptr)
        self.indices = post.astype(np.int32)
        self.w_count = w_count.astype(np.int32)
        self.weights = self.w_count.astype(np.float64) * W_SYN

    @property
    def n_edges(self) -> int:
        return int(self.indices.shape[0])

    def run(self, stim: dict[int, float], t_ms: float = 1000.0, silenced=None, seed: int = 0, record=None):
        """stim: {neuron_index: rate_hz}.  Returns (counts, rec_t_steps, rec_slot)."""
        stim_idx = np.array(list(stim.keys()), dtype=np.int64)
        stim_p = np.array([r * DT * 1e-3 for r in stim.values()], dtype=np.float64)
        sil = np.zeros(self.n, dtype=np.bool_)
        if silenced is not None and len(silenced):
            sil[np.asarray(silenced, dtype=np.int64)] = True
        rec = np.asarray(record if record is not None else [], dtype=np.int64)
        n_steps = int(round(t_ms / DT))
        return _simulate(self.indptr, self.indices, self.weights, self.n, n_steps,
                         stim_idx, stim_p, sil, seed, rec)

    def subnetwork(self, keep: np.ndarray) -> tuple["Network", np.ndarray]:
        """Induced subnetwork on `keep` (sorted global indices). Returns (net, keep)."""
        keep = np.unique(keep)
        remap = np.full(self.n, -1, dtype=np.int64)
        remap[keep] = np.arange(keep.shape[0])
        pre = np.repeat(np.arange(self.n), np.diff(self.indptr))
        m = (remap[pre] >= 0) & (remap[self.indices] >= 0)
        sub = Network(remap[pre[m]], remap[self.indices[m]], self.w_count[m], keep.shape[0])
        return sub, keep
