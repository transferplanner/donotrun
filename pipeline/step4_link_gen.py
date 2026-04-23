"""Step 4: Auto-generate walkable links between nodes using KDTree k-NN + radius filter.

Inputs:  data/output/reviewed/*.json  (falls back to merged/)
Output:  data/output/final/<station>.json  with `links: [{from, to, weight_m, kind}]`
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from . import config
from .utils import io_helpers


def _link_kind(a_type: str, b_type: str) -> str:
    if "stair" in (a_type, b_type):
        return "stair"
    if "escalator" in (a_type, b_type):
        return "escalator"
    if "elevator" in (a_type, b_type):
        return "elevator"
    return "walk"


def _generate_for_floor(floor: dict, scale_m: float = 100.0) -> list[dict]:
    """scale_m: how many meters the 0-1000 grid maps to (tune per station)."""
    nodes = [n for n in floor["nodes"] if n.get("type", "corridor") in config.WALKABLE_NODE_TYPES]
    if len(nodes) < 2:
        return []
    pts = np.array([[n["x"], n["y"]] for n in nodes], dtype=float)
    tree = cKDTree(pts)
    k = min(config.LINK_KNN + 1, len(nodes))
    dists, idxs = tree.query(pts, k=k)
    links: list[dict] = []
    seen: set[tuple[str, str]] = set()
    grid_to_m = scale_m / 1000.0
    for i, (dist_row, idx_row) in enumerate(zip(dists, idxs)):
        for d, j in zip(dist_row[1:], idx_row[1:]):  # skip self
            meters = float(d) * grid_to_m
            if meters > config.LINK_MAX_DISTANCE_M:
                continue
            a, b = nodes[i], nodes[j]
            key = tuple(sorted((a["id"], b["id"])))
            if key in seen:
                continue
            seen.add(key)
            links.append({
                "from": a["id"],
                "to": b["id"],
                "weight_m": round(meters, 2),
                "kind": _link_kind(a.get("type", ""), b.get("type", "")),
            })
    return links


def run() -> int:
    src_dir = config.OUTPUT_DIR / "reviewed"
    if not src_dir.exists() or not any(src_dir.glob("*.json")):
        src_dir = config.OUTPUT_DIR / "merged"
        print(f"[step4] reviewed/ empty — falling back to {src_dir}")
    out_dir = config.OUTPUT_DIR / "final"
    out_dir.mkdir(parents=True, exist_ok=True)

    for path in sorted(src_dir.glob("*.json")):
        data = io_helpers.read_json(path)
        for floor in data.get("floors", []):
            floor["links"] = _generate_for_floor(floor)
        # Cross-floor links: stair/escalator/elevator with matching labels across floors
        _link_vertical(data)
        io_helpers.write_json(out_dir / path.name, data)
        print(f"[step4] {path.name}: "
              f"{sum(len(f.get('links', [])) for f in data.get('floors', []))} links")
    return 0


VERTICAL_TYPES = {"stair", "escalator", "elevator"}
FLOOR_ORDER = ["B4", "B3", "B2", "B1", "1F", "2F", "3F"]


def _floor_index(label: str) -> int:
    try:
        return FLOOR_ORDER.index(label)
    except ValueError:
        return -1


def _link_vertical(data: dict) -> None:
    """Add cross-floor links using three signals:

    1. Same-label stair/escalator/elevator across adjacent floors.
    2. `meta.connects_floor` hint on any node → nearest compatible node on that floor.
    3. Exit nodes → nearest vertical-transport node on `connects_floor`.
    """
    floors = data.get("floors", [])
    if len(floors) < 2:
        return

    # Pre-index nodes per floor for fast nearest lookup
    per_floor: dict[str, list[tuple[dict, int]]] = {}  # floor_label → [(node, floor_idx)]
    for i, f in enumerate(floors):
        per_floor[f.get("floor", "")] = [(n, i) for n in f.get("nodes", [])]

    def add_link(src_floor_idx: int, src_id: str, dst_floor_idx: int, dst_id: str, kind: str):
        vertical_gap = abs(dst_floor_idx - src_floor_idx)
        floor = floors[src_floor_idx]
        floor.setdefault("links", []).append({
            "from": src_id,
            "to": f"F{dst_floor_idx}:{dst_id}",
            "weight_m": round(8.0 * max(vertical_gap, 1), 2),  # ~8m per level including stair run
            "kind": kind,
        })

    def nearest(target_nodes: list[tuple[dict, int]], x: float, y: float,
                type_filter: set[str] | None = None) -> tuple[dict, int] | None:
        candidates = [(n, i) for (n, i) in target_nodes
                      if not type_filter or n.get("type") in type_filter]
        if not candidates:
            return None
        return min(candidates, key=lambda e: (e[0]["x"] - x) ** 2 + (e[0]["y"] - y) ** 2)

    seen_pairs: set[tuple[str, str]] = set()

    def register(a_fi: int, a_id: str, b_fi: int, b_id: str, kind: str):
        key = tuple(sorted(((a_fi, a_id), (b_fi, b_id))))
        if key in seen_pairs:
            return
        seen_pairs.add(key)
        add_link(a_fi, a_id, b_fi, b_id, kind)

    # (1) Same-label vertical transport across adjacent floors
    by_label: dict[str, list[tuple[int, dict]]] = {}
    for fi, f in enumerate(floors):
        for n in f.get("nodes", []):
            if n.get("type") in VERTICAL_TYPES:
                by_label.setdefault(n.get("label", "").strip(), []).append((fi, n))
    for label, entries in by_label.items():
        if not label or len(entries) < 2:
            continue
        entries.sort(key=lambda e: e[0])
        for (i_a, a), (i_b, b) in zip(entries, entries[1:]):
            register(i_a, a["id"], i_b, b["id"], a.get("type", "stair"))

    # (2) meta.connects_floor on any node (typically exit → B1 concourse)
    for fi, f in enumerate(floors):
        for n in f.get("nodes", []):
            target_floor = (n.get("meta") or {}).get("connects_floor")
            if not target_floor or target_floor == f.get("floor"):
                continue
            targets = per_floor.get(target_floor)
            if not targets:
                continue

            if n.get("type") == "exit":
                # Prefer gate → stair/escalator → any
                hit = (nearest(targets, n["x"], n["y"], {"stair", "escalator", "elevator"})
                       or nearest(targets, n["x"], n["y"], {"gate"})
                       or nearest(targets, n["x"], n["y"]))
                kind = "walk"
            elif n.get("type") in VERTICAL_TYPES:
                hit = nearest(targets, n["x"], n["y"], VERTICAL_TYPES | {"corridor", "junction"})
                kind = n.get("type", "stair")
            else:
                hit = nearest(targets, n["x"], n["y"], VERTICAL_TYPES)
                kind = "walk"

            if hit:
                target_node, target_fi = hit
                register(fi, n["id"], target_fi, target_node["id"], kind)


if __name__ == "__main__":
    sys.exit(run())
