"""Step 1: Run Claude Vision over every JPEG in data/raw_maps/ and emit per-station JSON.

Usage:
    python -m pipeline.step1_vision_extract              # all JPEGs
    python -m pipeline.step1_vision_extract --only 강남역
"""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

from . import config
from .utils import io_helpers
from .utils.vision_client import extract_station_graph


def run(only: str | None = None) -> int:
    jpegs = (
        sorted(config.RAW_MAPS_DIR.rglob("*.jpg"))
        + sorted(config.RAW_MAPS_DIR.rglob("*.jpeg"))
        + sorted(config.RAW_MAPS_DIR.rglob("*.JPG"))
        + sorted(config.RAW_MAPS_DIR.rglob("*.JPEG"))
        + sorted(config.RAW_MAPS_DIR.rglob("*.png"))
    )
    if only:
        jpegs = [p for p in jpegs if only in p.stem]
    if not jpegs:
        print(f"[step1] no JPEGs in {config.RAW_MAPS_DIR}", file=sys.stderr)
        return 1

    ok = 0
    fail = 0
    for jpeg in jpegs:
        out_path = config.OUTPUT_DIR / "vision" / f"{io_helpers.slugify(jpeg.stem)}.json"
        if out_path.exists():
            print(f"[step1] skip (cached): {jpeg.name}")
            ok += 1
            continue
        try:
            print(f"[step1] extracting: {jpeg.name}")
            data = extract_station_graph(jpeg)
            data["_source_image"] = str(jpeg.relative_to(config.RAW_MAPS_DIR))
            # Validate floor enum; tag non-conforming floors for human review instead of silently accepting
            VALID_FLOORS = {"B4", "B3", "B2", "B1", "1F", "2F", "3F"}
            for f in data.get("floors", []):
                if f.get("floor") not in VALID_FLOORS:
                    f.setdefault("hints", []).append(f"NON_STANDARD_FLOOR: '{f.get('floor')}'")
            # Override station_name from filename: "222 강남역" → "강남역"
            stem = jpeg.stem
            parts = stem.split(" ", 1)
            guessed = parts[1] if len(parts) == 2 and parts[0].replace("-", "").replace(".", "").isdigit() else stem
            # Strip trailing suffixes like "(1차수정)" or "-수정8"
            import re
            guessed = re.sub(r"\s*[\(\-].*$", "", guessed).strip()
            data["station_name"] = guessed
            # Line from parent folder
            data["line"] = jpeg.parent.name
            io_helpers.write_json(out_path, data)
            ok += 1
        except Exception as e:
            fail += 1
            print(f"[step1] FAIL {jpeg.name}: {e}", file=sys.stderr)
            traceback.print_exc()

    print(f"[step1] done. ok={ok} fail={fail}")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="substring filter on station filename")
    args = ap.parse_args()
    sys.exit(run(only=args.only))
