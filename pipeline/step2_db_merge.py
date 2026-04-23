"""Step 2: Merge public CSV metadata (station master, exits, facilities, transfers) into
per-station graphs produced by step1.

Inputs:
    data/output/vision/<station>.json
    data/sample/station_master.csv
    data/sample/exit_info.csv
    data/sample/facility_info.csv
    data/sample/transfer_info.csv

Output:
    data/output/merged/<station>.json
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from . import config
from .utils import io_helpers


def _safe_read(path: Path) -> pd.DataFrame:
    if not path.exists():
        print(f"[step2] missing: {path.name} (skipping that join)", file=sys.stderr)
        return pd.DataFrame()
    return pd.read_csv(path)


def run() -> int:
    vision_dir = config.OUTPUT_DIR / "vision"
    out_dir = config.OUTPUT_DIR / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not vision_dir.exists():
        print("[step2] no vision outputs — run step1 first", file=sys.stderr)
        return 1

    stations = _safe_read(config.STATION_MASTER_CSV)
    exits = _safe_read(config.EXIT_INFO_CSV)
    facilities = _safe_read(config.FACILITY_INFO_CSV)
    transfers = _safe_read(config.TRANSFER_INFO_CSV)

    for vj in sorted(vision_dir.glob("*.json")):
        data = io_helpers.read_json(vj)
        name = data.get("station_name", vj.stem)

        meta = {}
        if not stations.empty:
            row = stations[stations["name"] == name]
            if not row.empty:
                meta["master"] = row.iloc[0].to_dict()

        if not exits.empty:
            meta["exits"] = exits[exits["station"] == name].to_dict(orient="records")
        if not facilities.empty:
            meta["facilities"] = facilities[facilities["station"] == name].to_dict(orient="records")
        if not transfers.empty:
            meta["transfers"] = transfers[transfers["station"] == name].to_dict(orient="records")

        data["metadata"] = meta
        io_helpers.write_json(out_dir / vj.name, data)
        print(f"[step2] merged: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(run())
