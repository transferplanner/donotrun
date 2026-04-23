"""Thin wrapper around Anthropic Claude for vision extraction."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from anthropic import Anthropic

from .. import config

_client: Anthropic | None = None


def _client_singleton() -> Anthropic:
    global _client
    if _client is None:
        if not config.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        _client = Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


EXTRACTION_PROMPT = """You are extracting a routable graph from a Korean subway station indoor guide map (역 이용 안내도).

Return ONLY valid JSON (no prose, no markdown fences). Schema:
{
  "station_name": "한국어 역명 (e.g., '강남역'). If unreadable, return empty string.",
  "line": "호선 (e.g., '2호선', '신분당선'). If unreadable, empty string.",
  "floors": [
    {
      "floor": "ENUM — ONLY one of: B4 | B3 | B2 | B1 | 1F | 2F | 3F. No other values.",
      "role": "concourse | platform | transfer | mezzanine | exit_level",
      "nodes": [
        {
          "id": "unique short string, e.g., 'b1_gate_a', 'b2_plat_n1'",
          "type": "ENUM — gate | exit | stair | escalator | elevator | corridor | junction | toilet | info | fare_machine | platform_edge | transfer_point",
          "label": "human-readable Korean label, e.g., '1번 출구', '개찰구 A', '상행 승강장'",
          "x": "float 0-1000 relative horizontal (origin top-left)",
          "y": "float 0-1000 relative vertical",
          "meta": { "exit_no": int|null, "direction": "상행|하행|내선|외선|null", "connects_floor": "B2|null" }
        }
      ],
      "hints": ["short notes for human review"]
    }
  ]
}

CRITICAL RULES:
1. `floor` MUST be exactly one of the enum values. Map Vision-observed labels like "대합실", "지하 구조", "환승층" to the correct B1/B2 based on the depth shown. NEVER invent floor strings like "Transfer_Level" or "지하 구조 (메인)".
2. If the map shows a concourse (대합실) with fare gates, that is typically B1 (role=concourse).
3. If the map shows train platforms with tracks and platform edges, that is typically B2 (role=platform). Always include:
   - platform_edge nodes at key points along each platform (at least 2 per platform: one near each end)
   - stair/escalator/elevator nodes that connect up to B1
   - Mark `meta.direction` as 상행/하행/내선/외선 when visible.
4. For transfer stations, represent transfer corridors as corridor/junction nodes on the appropriate floor (do NOT create a separate "transfer" floor unless the map clearly shows a distinct physical level).
5. Every exit must have `type: "exit"` and `meta.exit_no` set to the integer exit number visible in the signage.
6. Every stair/escalator/elevator should have `meta.connects_floor` naming the floor it reaches.
7. Coordinates: estimate as best you can from the visible artwork. Do not round to grid points.
8. Only emit nodes you can actually see on the map. Do NOT hallucinate facilities.
9. Put any low-confidence readings in `hints`, not in nodes.
10. Output MUST be a single valid JSON object and nothing else.
"""


def extract_station_graph(jpeg_path: Path) -> dict[str, Any]:
    client = _client_singleton()
    img_b64 = base64.standard_b64encode(jpeg_path.read_bytes()).decode("ascii")
    ext = jpeg_path.suffix.lower()
    media_type = "image/png" if ext == ".png" else "image/jpeg"

    resp = client.messages.create(
        model=config.VISION_MODEL,
        max_tokens=config.VISION_MAX_TOKENS,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": img_b64},
                    },
                    {"type": "text", "text": EXTRACTION_PROMPT},
                ],
            }
        ],
    )
    text = "".join(block.text for block in resp.content if block.type == "text").strip()
    # Strip possible fences defensively
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # Save raw response for inspection and try a light repair
        from .. import config as _cfg
        debug_path = _cfg.OUTPUT_DIR / "vision_debug" / (jpeg_path.stem + ".raw.txt")
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        debug_path.write_text(text, encoding="utf-8")
        # Trim to last complete brace and retry
        last = text.rfind("}")
        if last > 0:
            repaired = text[: last + 1]
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        raise RuntimeError(
            f"Vision response not parseable as JSON; raw saved to {debug_path}"
        ) from e
