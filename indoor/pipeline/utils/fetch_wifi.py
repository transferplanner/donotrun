"""Fetch Seoul Metro Wi-Fi fingerprint data from data.go.kr (odcloud).

Four relevant namespaces:
  15044365 — AP installation counts per station (no coords; not useful for positioning)
  15050126 — Per-AP RSSI statistics (역사아이디, 인프라아이디, avg/min/max RSSI)
  15050127 — Wi-Fi positioning fingerprints (역사아이디, 층정보, 인프라정보, 위도/경도, 평면XY)
  15050128 — Station metadata (역사아이디 ↔ 역사이름)

Usage:
  python3 -m pipeline.utils.fetch_wifi meta                  # dump all stations
  python3 -m pipeline.utils.fetch_wifi meta --name 강남      # find station id
  python3 -m pipeline.utils.fetch_wifi fingerprint --sid 222 # positioning cells
  python3 -m pipeline.utils.fetch_wifi rssi        --sid 222 # per-AP signal stats
  python3 -m pipeline.utils.fetch_wifi counts                # install counts (sanity)

Raw JSON responses are saved under data/output/wifi_raw/.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from .. import config

RAW_DIR = config.OUTPUT_DIR / "wifi_raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)

# Latest UUID per namespace (from OAS docs). Update when new revisions land.
# key env candidates: the user's 3 keys are tried in order, whichever grants access wins.
KEY_ENVS = ("SEOUL_SUBWAY_AP_KEY", "SEOUL_SUBWAY_STATION_AP", "WIFI_LOCATION_KEY")

ENDPOINTS: dict[str, dict] = {
    "counts":       {"ns": "15044365", "uuid": "4c4b02d3-885f-4d8e-8103-a4aec9f62694"},
    "rssi":         {"ns": "15050126", "uuid": "87e40bde-ab8c-4acd-95da-cd71a105d209"},
    "meta":         {"ns": "15050128", "uuid": "c37615e0-8a38-4684-a2e6-ef2b5171c192"},
    "fingerprint":  {"ns": "15050127", "uuid": "592961c4-9d64-4aef-8ea8-968f56f86a4a"},
}
BASE = "https://api.odcloud.kr/api/{ns}/v1/uddi:{uuid}"


def _load_keys() -> list[str]:
    keys = [os.getenv(k) for k in KEY_ENVS]
    keys = [k for k in keys if k]
    if not keys:
        raise SystemExit(
            "no API keys found in env. Expected one of: " + ", ".join(KEY_ENVS)
        )
    return keys


def _get(url: str, timeout: int = 30) -> dict:
    req = Request(url, headers={"User-Agent": "dont-run-indoor/0.1"})
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _fetch_one_page(ep: str, key: str, page: int, per_page: int) -> dict:
    info = ENDPOINTS[ep]
    url = BASE.format(**info) + "?" + urlencode(
        {"page": page, "perPage": per_page, "serviceKey": key, "returnType": "JSON"}
    )
    return _get(url)


def fetch_all(ep: str, per_page: int = 1000, max_pages: int = 200) -> list[dict]:
    """Walk pagination. Tries each key in .env until one is accepted."""
    keys = _load_keys()
    rows: list[dict] = []
    used_key = None

    for key in keys:
        try:
            first = _fetch_one_page(ep, key, 1, per_page)
            used_key = key
            break
        except HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:200]
            print(f"[fetch_wifi] {ep} key#{keys.index(key)+1} rejected ({e.code}): {body}")
        except URLError as e:
            print(f"[fetch_wifi] {ep} network error on key#{keys.index(key)+1}: {e}")
    if used_key is None:
        raise SystemExit(f"[fetch_wifi] no key accepted for {ep}")

    total = int(first.get("totalCount") or 0)
    rows.extend(first.get("data") or [])
    (RAW_DIR / f"{ep}_page1.json").write_text(
        json.dumps(first, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[fetch_wifi] {ep} page 1/{(total + per_page - 1)//per_page}  got {len(rows)}/{total}")

    page = 2
    while len(rows) < total and page <= max_pages:
        try:
            data = _fetch_one_page(ep, used_key, page, per_page)
        except HTTPError as e:
            print(f"[fetch_wifi] {ep} page {page} HTTP {e.code} — stopping")
            break
        rows.extend(data.get("data") or [])
        (RAW_DIR / f"{ep}_page{page}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[fetch_wifi] {ep} page {page}  got {len(rows)}/{total}")
        page += 1
        time.sleep(0.2)
    return rows


# ---------- commands ----------
def cmd_counts(_args):
    rows = fetch_all("counts")
    out = RAW_DIR / "counts_all.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fetch_wifi] counts → {out}  ({len(rows)} rows)")


def cmd_meta(args):
    rows = fetch_all("meta")
    if args.name:
        rows = [r for r in rows if args.name in (r.get("역사이름") or "")]
    out = RAW_DIR / ("meta_match.json" if args.name else "meta_all.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fetch_wifi] meta → {out}  ({len(rows)} rows)")
    if args.name:
        for r in rows[:10]:
            print(f"  역사아이디={r.get('역사아이디')}  이름={r.get('역사이름')}  타입={r.get('수집타입')}")


def _filter_sid(rows: list[dict], sid: str) -> list[dict]:
    return [r for r in rows if str(r.get("역사아이디")) == str(sid)]


def cmd_fingerprint(args):
    rows = fetch_all("fingerprint")
    if args.sid:
        rows = _filter_sid(rows, args.sid)
    out = RAW_DIR / (f"fingerprint_{args.sid}.json" if args.sid else "fingerprint_all.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fetch_wifi] fingerprint → {out}  ({len(rows)} cells)")
    if rows:
        sample = rows[0]
        print("  sample keys:", list(sample.keys()))
        print("  sample row:", json.dumps(sample, ensure_ascii=False)[:400])


def cmd_rssi(args):
    rows = fetch_all("rssi")
    if args.sid:
        rows = _filter_sid(rows, args.sid)
    out = RAW_DIR / (f"rssi_{args.sid}.json" if args.sid else "rssi_all.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fetch_wifi] rssi → {out}  ({len(rows)} rows)")


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    for name, fn in [("counts", cmd_counts), ("meta", cmd_meta),
                     ("fingerprint", cmd_fingerprint), ("rssi", cmd_rssi)]:
        s = sub.add_parser(name)
        if name == "meta":
            s.add_argument("--name", help="filter by station name substring, e.g. 강남")
        if name in ("fingerprint", "rssi"):
            s.add_argument("--sid", help="역사아이디 to filter")
        s.set_defaults(func=fn)

    args = p.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
