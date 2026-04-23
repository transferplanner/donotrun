"""Geometry helpers for indoor graph generation."""
from __future__ import annotations

import math
from typing import Iterable


def euclidean(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def relative_to_meters(rx: float, ry: float, width_m: float, height_m: float) -> tuple[float, float]:
    """Convert 0-1000 relative grid to metric (x east, y south)."""
    return rx / 1000.0 * width_m, ry / 1000.0 * height_m


def bbox(points: Iterable[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs, ys = zip(*points)
    return min(xs), min(ys), max(xs), max(ys)
