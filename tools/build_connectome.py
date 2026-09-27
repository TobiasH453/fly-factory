"""Build the browser brain for Fly Factory.

1. load the FlyWire v783 connectome (Shiu et al. 2024 packaging) + FlyWire annotations
2. define sensory input populations and motor/descending readout populations
3. run the full 139k-neuron LIF model (tools/lif_ref.py) on every stimulus condition
   the game can produce (single inputs over their rate range, combinations, Opto-Lab
   activations; several seeds) and reject any condition that ignites runaway activity
4. keep every neuron that spikes in any condition (+ all populations) and every synapse
   among them -> activity-pruned subnetwork.  Neurons that never spike cannot influence
   anything, so for these conditions the subnetwork reproduces the full brain exactly.
5. validate: identical-seed runs must match exactly; held-out seeds / rates are compared
6. export src/data/{brain.bin, neurons.bin, ghost.bin, meta.json, reference_rates.json}
   and docs/validation.md

Usage:  python tools/build_connectome.py
"""
from __future__ import annotations

import json
import multiprocessing as mp
import struct
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_data import fetch  # noqa: E402
from lif_ref import DT, Network  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data"
DOCS = ROOT / "docs"

T_MS = 1000.0
PRUNE_SEEDS = (1, 2, 3)
HELDOUT_SEEDS = (101, 102, 103, 104, 105)
IGNITION_ACTIVE = 6000  # runaway ignition recruits >10k neurons; normal responses stay below ~4k

# Shiu et al. 2024 sugar GRNs (example.ipynb); 20 of 21 IDs are unchanged in v783
SHIU_SUGAR = [
    720575940624963786, 720575940630233916, 720575940637568838, 720575940638202345,
    720575940617000768, 720575940630797113, 720575940632889389, 720575940621754367,
    720575940621502051, 720575940640649691, 720575940639332736, 720575940616885538,
    720575940639198653, 720575940620900446, 720575940617937543, 720575940632425919,
    720575940633143833, 720575940612670570, 720575940628853239, 720575940629176663,
    720575940611875570,
]
SHIU_MN9 = 720575940660219265  # MN9 (CB0701) from Shiu et al. example.ipynb

# ---------------------------------------------------------------- global state (fork-shared)
NET: Network | None = None
CONDS: dict[str, dict[int, float]] = {}
SILENCE: dict[str, list[int]] = {}


def _run(job):
    name, seed = job
    counts, _, _ = NET.run(CONDS[name], T_MS, silenced=SILENCE.get(name), seed=seed)
    return name, seed, counts


def run_all(net: Network, conds: dict, seeds, silence=None, procs=4):
    global NET, CONDS, SILENCE
    NET, CONDS, SILENCE = net, conds, silence or {}
    jobs = [(c, s) for c in conds for s in seeds]
    ctx = mp.get_context("fork")
    with ctx.Pool(procs) as pool:
        res = pool.map(_run, jobs, chunksize=1)
    out: dict[str, dict[int, np.ndarray]] = {}
    for name, seed, counts in res:
        out.setdefault(name, {})[seed] = counts
    return out


# ---------------------------------------------------------------- populations
def define_populations(ann: pd.DataFrame, idx: dict[int, int]):
    ct = ann.cell_type.fillna("")
    side = ann.side.fillna("")
    sub = ann.cell_sub_class.fillna("")

    def W(mask):
        return [int(i) for i in np.where(mask.values)[0]]

    def typ(t, s=None):
        m = ct == t
        if s:
            m &= side == s
        return W(m)

    mn9_r = idx[SHIU_MN9]
    mn9_l = [i for i in typ("CB0701") if i != mn9_r]
    P = {
        # ---- sensory inputs
        "sugar": dict(label="Sugar GRNs", kind="input", nodes=[idx[s] for s in SHIU_SUGAR if s in idx],
                      desc="Labellar sugar gustatory receptor neurons (Shiu et al. 2024 set)"),
        "bitter": dict(label="Bitter GRNs", kind="input", nodes=W((sub == "bitter") & (side == "left")),
                       desc="Labellar bitter gustatory receptor neurons (LB1a-e)"),
        "dust": dict(label="Head bristles + JO-F", kind="input",
                     nodes=W(ct.str.match(r"^JO-F") | (sub == "head bristle")),
                     desc="Head mechanosensory bristles and Johnston's organ F neurons (touch of dust)"),
        "wind": dict(label="JO-C/E (wind)", kind="input", nodes=W(ct.str.match(r"^JO-[CE]")),
                     desc="Johnston's organ C/E neurons: antennal deflection by wind/gravity"),
        "hearing": dict(label="JO-A/B (hearing)", kind="input", nodes=W(ct.str.match(r"^JO-[AB]")),
                        desc="Johnston's organ A/B neurons: near-field sound"),
        "loomL": dict(label="Looming L (LC4+LPLC2)", kind="input",
                      nodes=typ("LC4", "left") + typ("LPLC2", "left"),
                      desc="Loom-sensitive visual projection neurons, left eye"),
        "loomR": dict(label="Looming R (LC4+LPLC2)", kind="input",
                      nodes=typ("LC4", "right") + typ("LPLC2", "right"),
                      desc="Loom-sensitive visual projection neurons, right eye"),
        # ---- readouts (motor / descending)
        "MN9": dict(label="MN9 (proboscis)", kind="output", nodes=[mn9_r] + mn9_l,
                    desc="Proboscis motor neuron MN9 (CB0701): feeding initiation"),
        "GF": dict(label="Giant Fiber (DNp01)", kind="output", nodes=typ("DNp01"),
                   desc="Giant Fiber descending neurons: escape take-off"),
        "DNa02L": dict(label="DNa02 L", kind="output", nodes=typ("DNa02", "left"), desc="Steering (turn)"),
        "DNa02R": dict(label="DNa02 R", kind="output", nodes=typ("DNa02", "right"), desc="Steering (turn)"),
        "DNa01L": dict(label="DNa01 L", kind="output", nodes=typ("DNa01", "left"), desc="Steering (turn)"),
        "DNa01R": dict(label="DNa01 R", kind="output", nodes=typ("DNa01", "right"), desc="Steering (turn)"),
        "MDN": dict(label="MDN (moonwalker)", kind="output", nodes=typ("MDN"), desc="Backward walking"),
        "DNp09": dict(label="DNp09 (forward)", kind="output", nodes=typ("DNp09"), desc="Forward walking"),
        "escL": dict(label="Loom DNs L", kind="output", nodes=typ("DNp02", "left") + typ("DNp04", "left") + typ("DNp11", "left"),
                     desc="DNp02/DNp04/DNp11 left: lateralized looming responses"),
        "escR": dict(label="Loom DNs R", kind="output", nodes=typ("DNp02", "right") + typ("DNp04", "right") + typ("DNp11", "right"),
                     desc="DNp02/DNp04/DNp11 right: lateralized looming responses"),
    }
    for k, p in P.items():
        assert p["nodes"], f"population {k} is empty"
    return P


def pick_grooming_dns(ann, P, full):
    """Descending neurons driven by head mechanosensation (dust + wind) but ~silent otherwise."""
    sup = ann.super_class.fillna("")
    dn = np.where((sup == "descending").values)[0]

    def rate(name):
        return np.mean([full[name][s] for s in PRUNE_SEEDS], axis=0) / (T_MS / 1000.0)

    mech = np.minimum(rate("dust@80"), rate("wind@120"))
    other = np.maximum.reduce([rate("sugar@150"), rate("bitter@100"), rate("loomL@150"),
                               rate("loomR@150"), rate("hearing@150")])
    score = mech[dn] - 2.0 * other[dn]
    order = dn[np.argsort(-score)]
    chosen = [int(i) for i in order[:6] if mech[i] >= 15.0 and other[i] <= 5.0]
    if len(chosen) < 2:  # fall back: strongest dust responders
        chosen = [int(i) for i in dn[np.argsort(-rate("dust@80")[dn])][:4]]
    return chosen


# ---------------------------------------------------------------- conditions
def stim(P, *specs):
    d: dict[int, float] = {}
    for name, hz in specs:
        for i in P[name]["nodes"]:
            d[int(i)] = float(hz)
    return d


ENVELOPE = {  # max Poisson rate (Hz) the game may drive each input with
    "sugar": 150.0, "bitter": 100.0, "dust": 80.0, "wind": 120.0, "hearing": 150.0,
    "loomL": 150.0, "loomR": 150.0,
}
OPTO_HZ = 150.0


def sensory_conditions(P):
    C = {}
    for name, rates in {
        "sugar": (40, 80, 150), "bitter": (40, 70, 100), "dust": (30, 55, 80),
        "wind": (40, 80, 120), "hearing": (80, 150), "loomL": (60, 150), "loomR": (60, 150),
    }.items():
        for r in rates:
            C[f"{name}@{r}"] = stim(P, (name, r))
    E = ENVELOPE
    C["loomLR@150"] = stim(P, ("loomL", 150), ("loomR", 150))
    C["sugar+bitter"] = stim(P, ("sugar", E["sugar"]), ("bitter", E["bitter"]))
    C["sugar+bitter40"] = stim(P, ("sugar", E["sugar"]), ("bitter", 40))
    C["sugar+dust"] = stim(P, ("sugar", E["sugar"]), ("dust", E["dust"]))
    C["sugar+wind"] = stim(P, ("sugar", E["sugar"]), ("wind", E["wind"]))
    C["dust+wind"] = stim(P, ("dust", E["dust"]), ("wind", E["wind"]))
    C["bitter+dust"] = stim(P, ("bitter", E["bitter"]), ("dust", E["dust"]))
    C["loom+dust"] = stim(P, ("loomL", 150), ("loomR", 150), ("dust", E["dust"]))
    C["loom+sugar"] = stim(P, ("loomL", 150), ("sugar", E["sugar"]))
    C["everything"] = stim(P, *[(k, v) for k, v in E.items()])
    return C


def opto_conditions(P, names):
    return {f"opto:{n}": stim(P, (n, OPTO_HZ)) for n in names}


# ---------------------------------------------------------------- export helpers
def coarse_group(row) -> int:
    sup = row.super_class if isinstance(row.super_class, str) else ""
    return {"sensory": 1, "ascending": 2, "central": 3, "optic": 4, "visual_projection": 4,
            "visual_centrifugal": 4, "descending": 5, "motor": 6, "endocrine": 7}.get(sup, 3)


def write_brain_bin(path: Path, sub: Network):
    n, nnz = sub.n, sub.n_edges
    assert n < 65536
    assert np.abs(sub.w_count).max() < 32768
    with open(path, "wb") as f:
        f.write(b"FLYB")
        f.write(struct.pack("<III", 1, n, nnz))
        f.write(sub.indptr.astype("<u4").tobytes())
        f.write(sub.indices.astype("<u2").tobytes())
        f.write(sub.w_count.astype("<i2").tobytes())


def main():
    t0 = time.time()
    comp_p, con_p, ann_p = fetch()
    comp = pd.read_csv(comp_p, index_col=0)
    con = pd.read_parquet(con_p, columns=["Presynaptic_Index", "Postsynaptic_Index", "Excitatory x Connectivity"])
    net = Network(con.Presynaptic_Index.values, con.Postsynaptic_Index.values,
                  con["Excitatory x Connectivity"].values, len(comp))
    ids = comp.index.values
    idx = {int(r): i for i, r in enumerate(ids)}
    ann = pd.read_csv(ann_p, sep="\t", low_memory=False).set_index("root_id").reindex(ids)
    print(f"loaded {net.n} neurons, {net.n_edges} connections in {time.time()-t0:.0f}s")

    P = define_populations(ann, idx)
    for k, p in P.items():
        print(f"  {k:8s} {len(p['nodes']):4d}  {p['label']}")

    # ---- 1. sensory conditions on the full brain
    conds = sensory_conditions(P)
    full = run_all(net, conds, PRUNE_SEEDS)
    grooming = pick_grooming_dns(ann, P, full)
    P["groom"] = dict(label="Grooming DNs", kind="output", nodes=grooming,
                      desc="Descending neurons selected by response to head mechanosensation "
                           "(dust/wind) and not to taste or looming: " +
                           ", ".join(sorted({str(ann.iloc[i].cell_type) for i in grooming})))
    print("grooming DNs:", [(ann.iloc[i].cell_type, ann.iloc[i].side) for i in grooming])

    # ---- 2. Opto-Lab activations of readout populations
    opto_names = ["MN9", "GF", "DNa02L", "DNa02R", "DNa01L", "DNa01R", "MDN", "DNp09", "escL", "escR", "groom"]
    oconds = opto_conditions(P, opto_names)
    full.update(run_all(net, oconds, PRUNE_SEEDS))
    conds.update(oconds)

    # ---- 3. ignition check
    report_rows = []
    ignited = []
    for name in conds:
        act = [int((full[name][s] > 0).sum()) for s in PRUNE_SEEDS]
        report_rows.append((name, act))
        if max(act) > IGNITION_ACTIVE:
            ignited.append((name, act))
    if ignited:
        print("RUNAWAY conditions (tighten ENVELOPE):", ignited)
        sys.exit(1)

    # ---- 4. prune
    keep = set()
    for name in conds:
        for s in PRUNE_SEEDS:
            keep.update(np.where(full[name][s] > 0)[0].tolist())
    for p in P.values():
        keep.update(p["nodes"])
    keep = np.array(sorted(keep), dtype=np.int64)
    sub, keep = net.subnetwork(keep)
    g2l = {int(g): i for i, g in enumerate(keep)}
    print(f"subnetwork: {sub.n} neurons, {sub.n_edges} synaptic connections "
          f"({int(np.abs(sub.w_count).sum())} synapses)")

    def local(d):
        return {g2l[i]: r for i, r in d.items()}

    sconds = {k: local(v) for k, v in conds.items()}

    # ---- 5. validation
    def pop_rates(counts, nodes):
        return float(np.mean(counts[nodes])) / (T_MS / 1000.0)

    sub_same = run_all(sub, sconds, PRUNE_SEEDS)
    exact = all(np.array_equal(sub_same[c][s], full[c][s][keep]) for c in conds for s in PRUNE_SEEDS)
    print("identical-seed exact match:", exact)

    # held-out: new seeds + in-between rates never used for pruning
    held = {}
    E = ENVELOPE
    for name, r in [("sugar", 110), ("bitter", 85), ("dust", 65), ("wind", 100), ("loomL", 110), ("loomR", 90)]:
        held[f"{name}@{r}"] = stim(P, (name, r))
    held["sugar+bitter70"] = stim(P, ("sugar", 150), ("bitter", 70))
    held["sugar+dust+wind"] = stim(P, ("sugar", 120), ("dust", 60), ("wind", 90))
    held["everything"] = stim(P, *[(k, v) for k, v in E.items()])
    full_h = run_all(net, held, HELDOUT_SEEDS)
    sub_h = run_all(sub, {k: local(v) for k, v in held.items()}, HELDOUT_SEEDS)
    readouts = [k for k, p in P.items() if p["kind"] == "output"]
    held_rows = []
    worst = 0.0
    for c in held:
        for pop in readouts:
            nodes_g = P[pop]["nodes"]
            nodes_l = [g2l[i] for i in nodes_g]
            fr = np.mean([pop_rates(full_h[c][s], nodes_g) for s in HELDOUT_SEEDS])
            sr = np.mean([pop_rates(sub_h[c][s], nodes_l) for s in HELDOUT_SEEDS])
            if fr > 0.5 or sr > 0.5:
                held_rows.append((c, pop, fr, sr))
                worst = max(worst, abs(fr - sr))
        extra = [int(((full_h[c][s] > 0) & ~np.isin(np.arange(net.n), keep)).sum()) for s in HELDOUT_SEEDS]
        held_rows.append((c, "_outside_", float(np.mean(extra)), 0.0))
    print(f"held-out worst readout deviation: {worst:.2f} Hz")

    # ---- 6. channel calibration (full-brain rates under canonical stimuli)
    def mean_rate(cond, pop, res=full):
        return float(np.mean([pop_rates(res[cond][s], P[pop]["nodes"]) for s in PRUNE_SEEDS]))

    canon = {
        "feed": ("MN9", "sugar@150"),
        "groom": ("groom", "dust@80"),
        "escape": ("GF", "loomLR@150"),
        "escL": ("escL", "loomL@150"),
        "escR": ("escR", "loomR@150"),
        "turnL": ("DNa02L", "opto:DNa02L"),
        "turnR": ("DNa02R", "opto:DNa02R"),
        "forward": ("DNp09", "opto:DNp09"),
        "backward": ("MDN", "opto:MDN"),
    }
    channels = {}
    for ch, (pop, cond) in canon.items():
        r = mean_rate(cond, pop)
        channels[ch] = dict(pop=pop, canonical_condition=cond, canonical_hz=round(r, 2),
                            threshold_hz=round(max(2.0, 0.25 * r), 2))
    print("channels:", json.dumps(channels, indent=1))

    # ---- 7. export
    OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    write_brain_bin(OUT / "brain.bin", sub)

    sub_ann = ann.iloc[keep]
    pos_nm = np.stack([sub_ann.pos_x.values * 4.0, sub_ann.pos_y.values * 4.0, sub_ann.pos_z.values * 40.0], 1)
    all_nm = np.stack([ann.pos_x.values * 4.0, ann.pos_y.values * 4.0, ann.pos_z.values * 40.0], 1)
    ok = np.isfinite(all_nm).all(1)
    center = np.nanmean(all_nm[ok], 0)
    scale = 1.0 / np.nanmax(np.abs(all_nm[ok] - center))
    pos = np.nan_to_num((pos_nm - center) * scale).astype("<f4")
    grp = np.array([coarse_group(r) for r in sub_ann.itertuples()], dtype="<u1")
    with open(OUT / "neurons.bin", "wb") as f:
        f.write(b"FLYN")
        f.write(struct.pack("<I", sub.n))
        f.write(pos.tobytes())
        f.write(grp.tobytes())
    rng = np.random.default_rng(0)
    ghost_idx = rng.choice(np.where(ok)[0], 24000, replace=False)
    ghost = np.clip(((all_nm[ghost_idx] - center) * scale) * 32767, -32767, 32767).astype("<i2")
    (OUT / "ghost.bin").write_bytes(b"FLYG" + struct.pack("<I", len(ghost_idx)) + ghost.tobytes())

    types = sub_ann.cell_type.fillna(sub_ann.super_class.fillna("?")).astype(str).tolist()
    tdict = sorted(set(types))
    tpos = {t: i for i, t in enumerate(tdict)}
    meta = dict(
        version=1,
        source=dict(
            connectome="FlyWire FAFB v783 (Dorkenwald et al. 2024, Schlegel et al. 2024), CC-BY 4.0",
            model="Shiu et al. 2024 Nature, github.com/philshiu/Drosophila_brain_model (MIT)",
            annotations="github.com/flyconnectome/flywire_annotations",
        ),
        params=dict(dt_ms=DT, v0=-52.0, v_rst=-52.0, v_th=-45.0, t_mbr_ms=20.0, tau_ms=5.0,
                    t_rfc_ms=2.2, delay_ms=1.8, w_syn_mV=0.275, f_poi=250.0),
        full_brain=dict(neurons=int(net.n), connections=int(net.n_edges)),
        n=int(sub.n), nnz=int(sub.n_edges), synapses=int(np.abs(sub.w_count).sum()),
        envelope_hz=ENVELOPE, opto_hz=OPTO_HZ,
        populations={k: dict(label=p["label"], kind=p["kind"], desc=p["desc"],
                             nodes=[g2l[i] for i in p["nodes"]]) for k, p in P.items()},
        channels=channels,
        types=tdict,
        neuron_type=[tpos[t] for t in types],
        root_ids=[str(int(r)) for r in ids[keep]],
    )
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    # reference rates for the JS engine parity test (subnetwork, prune seeds)
    ref = {}
    for c in ["sugar@150", "sugar+bitter", "dust@80", "loomLR@150", "wind@120", "opto:MDN"]:
        ref[c] = dict(
            stim={str(k): v for k, v in sconds[c].items()},
            rates={pop: float(np.mean([pop_rates(sub_same[c][s], meta["populations"][pop]["nodes"])
                                       for s in PRUNE_SEEDS]))
                   for pop in readouts},
            active=float(np.mean([(sub_same[c][s] > 0).sum() for s in PRUNE_SEEDS])),
        )
    (OUT / "reference_rates.json").write_text(json.dumps(ref, indent=0))

    # ---- validation report
    L = ["# Brain validation", "",
         "Generated by `tools/build_connectome.py`. All simulations use the Shiu et al. 2024 LIF model "
         "(dt 0.1 ms, 1 s trials) on the FlyWire v783 connectome.", "",
         f"- Full brain: **{net.n:,} neurons, {net.n_edges:,} connections**",
         f"- Shipped activity-pruned subnetwork: **{sub.n:,} neurons, {sub.n_edges:,} connections "
         f"({int(np.abs(sub.w_count).sum()):,} synapses)**",
         f"- Identical-seed runs, subnetwork vs full brain, every neuron's spike count: "
         f"**{'exact match' if exact else 'MISMATCH'}**",
         f"- Held-out seeds/rates, worst readout-population deviation: **{worst:.2f} Hz**", "",
         "## Pathway checks (full brain, mean of seeds)", "",
         "| check | value |", "|---|---|"]
    checks = [
        ("Sugar GRNs @150 Hz -> MN9", mean_rate("sugar@150", "MN9")),
        ("Sugar + bitter -> MN9 (suppression)", mean_rate("sugar+bitter", "MN9")),
        ("Dust (bristles+JO-F) @80 Hz -> grooming DNs", mean_rate("dust@80", "groom")),
        ("Wind (JO-C/E) @120 Hz -> grooming DNs", mean_rate("wind@120", "groom")),
        ("Looming both eyes @150 Hz -> Giant Fiber", mean_rate("loomLR@150", "GF")),
        ("Looming left -> left loom DNs", mean_rate("loomL@150", "escL")),
        ("Looming left -> right loom DNs", mean_rate("loomL@150", "escR")),
        ("Sugar @150 -> Giant Fiber (should be ~0)", mean_rate("sugar@150", "GF")),
    ]
    for label, v in checks:
        L.append(f"| {label} | {v:.1f} Hz |")
    L += ["", "## Conditions used for pruning (active neurons per seed)", "", "| condition | active |", "|---|---|"]
    for name, act in report_rows:
        L.append(f"| `{name}` | {', '.join(map(str, act))} |")
    L += ["", "## Held-out comparison (full brain vs subnetwork, Hz)", "",
          "| condition | readout | full | subnetwork |", "|---|---|---|---|"]
    for c, pop, fr, sr in held_rows:
        if pop == "_outside_":
            L.append(f"| `{c}` | neurons spiking outside subnetwork (full brain) | {fr:.1f} | - |")
        else:
            L.append(f"| `{c}` | {pop} | {fr:.1f} | {sr:.1f} |")
    L += ["", "## Channel calibration", "", "| channel | population | canonical | threshold |", "|---|---|---|---|"]
    for ch, c in channels.items():
        L.append(f"| {ch} | {c['pop']} | {c['canonical_hz']} Hz (`{c['canonical_condition']}`) | {c['threshold_hz']} Hz |")
    L += ["", "## Notes", "",
          "- Bitter GRNs at 150 Hz can stochastically ignite a runaway loop through SMP/MB dopaminergic "
          "neurons (SMP108, SMP177, CRE011, PPL107 ...) that recruits >10k neurons. The game therefore "
          f"caps every input at the envelope above ({', '.join(f'{k} {v:g} Hz' for k, v in ENVELOPE.items())}), "
          "inside which no condition ignited.",
          "- Grooming DNs are selected from data: " + P["groom"]["desc"] + ".",
          ""]
    (DOCS / "validation.md").write_text("\n".join(L))
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
