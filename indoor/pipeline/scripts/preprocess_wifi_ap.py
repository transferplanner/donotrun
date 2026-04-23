"""Merge SK T-data Wi-Fi dump + KISA public Wi-Fi CSV into a station-local AP table.

Outputs: data/output/wifi/<station>.json
  [{bssid, ssid, lat, lng, floor?, x_rel?, y_rel?, tx_power_dbm?}]

Usage:
    python -m pipeline.scripts.preprocess_wifi_ap --station 강남역
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from .. import config
from ..utils import io_helpers


def _load(path: Path) -> pd.DataFrame:
    if not path.exists():
        print(f"[wifi] missing: {path.name}", file=sys.stderr)
        return pd.DataFrame()
    return pd.read_csv(path)


def run(station: str) -> int:
    tdata = _load(config.TDATA_WIFI_CSV)
    kisa = _load(config.KISA_WIFI_CSV)
    if tdata.empty and kisa.empty:
        print("[wifi] no Wi-Fi CSVs available", file=sys.stderr)
        return 1

    frames: list[pd.DataFrame] = []
    if not tdata.empty:
        sub = tdata[tdata["station"] == station].copy()
        sub["source"] = "tdata"
        frames.append(sub)
    if not kisa.empty and "station" in kisa.columns:
        sub = kisa[kisa["station"] == station].copy()
        sub["source"] = "kisa"
        frames.append(sub)
    if not frames:
        print(f"[wifi] no rows for {station}")
        return 2

    merged = pd.concat(frames, ignore_index=True)
    merged = merged.drop_duplicates(subset=["bssid"], keep="first")

    out_path = config.OUTPUT_DIR / "wifi" / f"{io_helpers.slugify(station)}.json"
    io_helpers.write_json(out_path, merged.to_dict(orient="records"))
    print(f"[wifi] {station}: {len(merged)} APs → {out_path}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--station", required=True)
    args = ap.parse_args()
    sys.exit(run(args.station))
