"""Central configuration for the indoor preprocessing pipeline."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(override=True)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_MAPS_DIR = DATA_DIR / "raw_maps"
SAMPLE_DIR = DATA_DIR / "sample"
OUTPUT_DIR = DATA_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Claude Vision
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
VISION_MODEL = os.getenv("VISION_MODEL", "claude-sonnet-4-5-20250929")
VISION_MAX_TOKENS = 8192

# Node/link generation
LINK_MAX_DISTANCE_M = 25.0   # KDTree radius for candidate links
LINK_KNN = 6                 # top-K neighbors per node
WALKABLE_NODE_TYPES = {
    "corridor", "junction", "stair", "escalator", "elevator",
    "gate", "exit", "platform_edge", "transfer_point", "fare_machine",
}

# Wi-Fi positioning constants (reference values, tune per station)
TX_POWER_DBM = -45.0
PATH_LOSS_EXPONENT = 2.8
RSSI_FLOOR_DBM = -95.0

# Public CSV schemas (data.go.kr / 서울열린데이터광장)
STATION_MASTER_CSV = SAMPLE_DIR / "station_master.csv"
EXIT_INFO_CSV = SAMPLE_DIR / "exit_info.csv"
FACILITY_INFO_CSV = SAMPLE_DIR / "facility_info.csv"
TRANSFER_INFO_CSV = SAMPLE_DIR / "transfer_info.csv"
TDATA_WIFI_CSV = SAMPLE_DIR / "tdata_wifi.csv"
KISA_WIFI_CSV = SAMPLE_DIR / "kisa_wifi.csv"
