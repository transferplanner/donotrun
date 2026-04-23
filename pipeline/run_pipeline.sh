#!/usr/bin/env bash
# Usage: ./run_pipeline.sh [station_substr]
set -euo pipefail
cd "$(dirname "$0")/.."

FILTER="${1:-}"
ARGS=()
if [[ -n "$FILTER" ]]; then ARGS+=(--only "$FILTER"); fi

echo "=== step1: vision extract ==="
python -m pipeline.step1_vision_extract "${ARGS[@]}"

echo "=== step2: db merge ==="
python -m pipeline.step2_db_merge

echo "=== step3: review UI is manual — run separately ==="
echo "    python -m pipeline.step3_review_ui"

echo "=== step4: link generation ==="
python -m pipeline.step4_link_gen

echo "done. outputs in data/output/final/"
