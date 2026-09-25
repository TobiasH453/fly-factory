"""Download the FlyWire v783 connectome (as packaged by Shiu et al. 2024) and the
FlyWire cell-type annotations into tools/.cache.

Sources
-------
- github.com/philshiu/Drosophila_brain_model  (MIT) - Completeness_783.csv, Connectivity_783.parquet
  fallback: github.com/eonsystemspbc/fly-brain   data/2025_*_783.*  (same data)
- github.com/flyconnectome/flywire_annotations - Supplemental_file1_neuron_annotations.tsv
"""
from __future__ import annotations

import shutil
import subprocess
import urllib.request
from pathlib import Path

CACHE = Path(__file__).resolve().parent / ".cache"
SHIU = CACHE / "shiu"
ANNOT = CACHE / "flywire_annotations.tsv"
ANNOT_URL = (
    "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/"
    "supplemental_files/Supplemental_file1_neuron_annotations.tsv"
)


def _sparse_clone(url: str, dest: Path, paths: list[str]) -> None:
    subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", url, str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "sparse-checkout", "set", "--no-cone", *paths], check=True)


def fetch() -> tuple[Path, Path, Path]:
    CACHE.mkdir(parents=True, exist_ok=True)
    comp, con = SHIU / "Completeness_783.csv", SHIU / "Connectivity_783.parquet"
    if not (comp.exists() and con.exists()):
        shutil.rmtree(SHIU, ignore_errors=True)
        try:
            _sparse_clone("https://github.com/philshiu/Drosophila_brain_model", SHIU,
                          ["/Completeness_783.csv", "/Connectivity_783.parquet", "/model.py"])
        except subprocess.CalledProcessError:
            shutil.rmtree(SHIU, ignore_errors=True)
            _sparse_clone("https://github.com/eonsystemspbc/fly-brain", SHIU,
                          ["/data/2025_Completeness_783.csv", "/data/2025_Connectivity_783.parquet"])
            (SHIU / "data" / "2025_Completeness_783.csv").rename(comp)
            (SHIU / "data" / "2025_Connectivity_783.parquet").rename(con)
    if not ANNOT.exists():
        urllib.request.urlretrieve(ANNOT_URL, ANNOT)
    return comp, con, ANNOT


if __name__ == "__main__":
    for p in fetch():
        print(p, p.stat().st_size)
