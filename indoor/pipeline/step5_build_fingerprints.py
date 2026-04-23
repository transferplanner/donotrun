"""Step 5: Normalize data.go.kr fingerprint dumps into per-station JSON.

Input:  data/output/wifi_raw/fingerprint_<sid>.json  (from fetch_wifi)
Output: data/output/fingerprints/<station_name>.json

Key transforms:
  - data.go.kr labels lat/lng reversed — we swap them.
  - `인프라정보` ("BSSID;RSSI;stddev/...") is parsed into an array.
  - Raw floor code (e.g. AB01) is kept under `floor_raw`. A mapping file
    `data/output/fingerprints/_floor_map.json` lets us translate raw codes to
    graph-facing labels (B1/B2/1F) once known — edit by hand per station.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from . import config

RAW_DIR = config.OUTPUT_DIR / "wifi_raw"
OUT_DIR = config.OUTPUT_DIR / "fingerprints"
OUT_DIR.mkdir(parents=True, exist_ok=True)
FLOOR_MAP_FILE = OUT_DIR / "_floor_map.json"


def _load_floor_map() -> dict:
    if FLOOR_MAP_FILE.exists():
        return json.loads(FLOOR_MAP_FILE.read_text(encoding="utf-8"))
    return {}


def _parse_infra(s: str) -> list[dict]:
    """'bssid;rssi;stddev/bssid;rssi;stddev/' -> list of {bssid, rssi, stddev}"""
    out = []
    for seg in (s or "").split("/"):
        if not seg:
            continue
        parts = seg.split(";")
        if len(parts) < 2:
            continue
        try:
            out.append({
                "bssid": parts[0].strip().lower(),
                "rssi": int(parts[1]),
                "stddev": float(parts[2]) if len(parts) > 2 and parts[2] else 0.0,
            })
        except (ValueError, IndexError):
            continue
    return out


def _parse_headings(s: str) -> list[int]:
    return [int(x) for x in re.split(r"[/,\s]+", s or "") if x.isdigit()]


def build(sid: str, station_name: str) -> dict:
    src = RAW_DIR / f"fingerprint_{sid}.json"
    if not src.exists():
        raise SystemExit(f"missing {src} — run fetch_wifi fingerprint --sid {sid} first")
    rows = json.loads(src.read_text(encoding="utf-8"))
    floor_map = _load_floor_map().get(sid, {})

    cells = []
    skipped = 0
    for r in rows:
        raw_floor = r.get("층정보") or ""
        # null/empty string in floor_map means "skip this floor"
        # (e.g. cells belonging to a line the current graph doesn't model).
        if raw_floor in floor_map and floor_map[raw_floor] in (None, ""):
            skipped += 1
            continue
        # Lat/lng labels are swapped in the upstream dataset
        try:
            lng = float(r.get("위도") or 0)
            lat = float(r.get("경도") or 0)
        except ValueError:
            lat = lng = 0.0
        cells.append({
            "index": r.get("인덱스"),
            "lat": lat,
            "lng": lng,
            "planar_x": float(r.get("평면좌표엑스") or 0),
            "planar_y": float(r.get("평면좌표와이") or 0),
            "floor_raw": raw_floor,
            "floor": floor_map.get(raw_floor, raw_floor),
            "headings": _parse_headings(r.get("수집방위각", "")),
            "aps": _parse_infra(r.get("인프라정보", "")),
        })
    if skipped:
        print(f"[step5] {station_name}: skipped {skipped} cells (floor_map null)")

    return {
        "station_id": sid,
        "station_name": station_name,
        "data_date": rows[0].get("데이터기준일") if rows else None,
        "cell_count": len(cells),
        "floors_raw": sorted({c["floor_raw"] for c in cells}),
        "needs_floor_map": not floor_map,
        "cells": cells,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--sid", required=True, help="역사아이디 (from fetch_wifi meta)")
    p.add_argument("--name", required=True, help="station name for output filename, e.g. 강남역")
    args = p.parse_args()

    data = build(args.sid, args.name)
    out = OUT_DIR / f"{args.name}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[step5] {args.name}: {data['cell_count']} cells, floors={data['floors_raw']}")
    print(f"[step5] wrote {out}")
    if data["needs_floor_map"]:
        print(f"[step5] ⚠️  floor mapping empty for sid={args.sid}. "
              f"Edit {FLOOR_MAP_FILE} to map raw codes to B1/B2/1F/etc.")
        sample = {args.sid: {f: "?" for f in data["floors_raw"]}}
        print(f"[step5] suggested template:\n{json.dumps(sample, ensure_ascii=False, indent=2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
