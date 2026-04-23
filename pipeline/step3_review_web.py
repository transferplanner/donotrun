"""Step 3 (browser): HTTP server backing the review UI at pipeline/review_ui/index.html.

Replaces the Tkinter app (step3_review_ui.py) which was broken by macOS
system-Python Tcl/Tk 8.5. Browser + canvas renders reliably.

Endpoints:
  GET  /                       -> serve review_ui/index.html
  GET  /api/stations           -> list merged/*.json filenames
  GET  /api/station?f=NAME     -> read merged JSON
  GET  /api/image?f=REL_PATH   -> stream image from data/raw_maps/, CMYK->RGB
  POST /api/save?f=NAME        -> write JSON to data/output/reviewed/NAME
"""
from __future__ import annotations

import io
import json
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image

from . import config

HOST = "127.0.0.1"
PORT = 8765
UI_DIR = Path(__file__).resolve().parent / "review_ui"
INDEX_HTML = UI_DIR / "index.html"
MERGED_DIR = config.OUTPUT_DIR / "merged"
REVIEWED_DIR = config.OUTPUT_DIR / "reviewed"
FINAL_DIR = config.OUTPUT_DIR / "final"
FP_DIR = config.OUTPUT_DIR / "fingerprints"
SRC_DIR = config.ROOT / "src"


def _safe_name(name: str) -> str:
    # strip any path components; allow only simple filenames
    return Path(name).name


def _safe_rel(rel: str) -> Path | None:
    # resolve under RAW_MAPS_DIR, refuse escapes
    base = config.RAW_MAPS_DIR.resolve()
    target = (base / rel).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # quieter log
        sys.stderr.write("[step3web] " + (fmt % args) + "\n")

    # ---- helpers ----
    def _send_json(self, status: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, msg: str) -> None:
        self._send_json(status, {"error": msg})

    # ---- routes ----
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        path = parsed.path

        if path == "/" or path == "/index.html":
            if not INDEX_HTML.exists():
                return self._error(500, f"index.html missing at {INDEX_HTML}")
            return self._send_bytes(200, INDEX_HTML.read_bytes(), "text/html; charset=utf-8")

        if path == "/user" or path == "/user.html":
            p = UI_DIR / "user.html"
            if not p.exists():
                return self._error(500, f"user.html missing at {p}")
            return self._send_bytes(200, p.read_bytes(), "text/html; charset=utf-8")

        if path == "/api/stations":
            MERGED_DIR.mkdir(parents=True, exist_ok=True)
            files = sorted(p.name for p in MERGED_DIR.glob("*.json"))
            return self._send_json(200, {"files": files})

        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            base = SRC_DIR.resolve()
            target = (base / rel).resolve()
            try:
                target.relative_to(base)
            except ValueError:
                return self._error(403, "forbidden")
            if not target.exists() or not target.is_file():
                return self._error(404, f"static not found: {rel}")
            ctype = "application/javascript; charset=utf-8" if target.suffix == ".js" \
                else "text/plain; charset=utf-8"
            return self._send_bytes(200, target.read_bytes(), ctype)

        if path == "/api/graph":
            # Prefer final/ (has auto-links), fallback reviewed/, then merged/
            fname = _safe_name((qs.get("f") or [""])[0])
            if not fname:
                return self._error(400, "missing ?f=")
            for d in (FINAL_DIR, REVIEWED_DIR, MERGED_DIR):
                p = d / fname
                if p.exists():
                    try:
                        data = json.loads(p.read_text(encoding="utf-8"))
                        data["_source_stage"] = d.name
                        return self._send_json(200, data)
                    except Exception as e:
                        return self._error(500, f"bad json in {d.name}: {e}")
            return self._error(404, f"graph not found: {fname}")

        if path == "/api/floor-map":
            fp_map = FP_DIR / "_floor_map.json"
            if not fp_map.exists():
                return self._send_json(200, {})
            try:
                return self._send_json(200, json.loads(fp_map.read_text(encoding="utf-8")))
            except Exception as e:
                return self._error(500, f"bad floor_map: {e}")

        if path == "/api/fingerprints":
            FP_DIR.mkdir(parents=True, exist_ok=True)
            files = sorted(p.name for p in FP_DIR.glob("*.json") if not p.name.startswith("_"))
            return self._send_json(200, {"files": files})

        if path == "/api/fingerprint":
            fname = _safe_name((qs.get("f") or [""])[0])
            if not fname:
                return self._error(400, "missing ?f=")
            p = FP_DIR / fname
            if not p.exists():
                return self._error(404, f"fingerprint not found: {fname}")
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception as e:
                return self._error(500, f"bad json: {e}")
            return self._send_json(200, data)

        if path == "/api/station":
            fname = _safe_name((qs.get("f") or [""])[0])
            if not fname:
                return self._error(400, "missing ?f=")
            p = MERGED_DIR / fname
            if not p.exists():
                return self._error(404, f"not found: {fname}")
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception as e:
                return self._error(500, f"bad json: {e}")
            return self._send_json(200, data)

        if path == "/api/image":
            rel = (qs.get("f") or [""])[0]
            if not rel:
                return self._error(400, "missing ?f=")
            target = _safe_rel(rel)
            if target is None or not target.exists():
                return self._error(404, f"image not found: {rel}")
            try:
                img = Image.open(target)
                if img.mode != "RGB":
                    img = img.convert("RGB")
                # Downscale large scans so the browser stays snappy
                img.thumbnail((2400, 2400), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
                return self._send_bytes(200, buf.getvalue(), "image/jpeg")
            except Exception as e:
                return self._error(500, f"image read failed: {e}")

        return self._error(404, f"no route: {path}")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path != "/api/save":
            return self._error(404, f"no route: {parsed.path}")
        fname = _safe_name((qs.get("f") or [""])[0])
        if not fname:
            return self._error(400, "missing ?f=")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._error(400, f"bad json body: {e}")
        REVIEWED_DIR.mkdir(parents=True, exist_ok=True)
        out = REVIEWED_DIR / fname
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._send_json(200, {"saved": str(out)})


def main() -> int:
    if not INDEX_HTML.exists():
        print(f"[step3web] WARNING: {INDEX_HTML} missing — UI won't load")
    MERGED_DIR.mkdir(parents=True, exist_ok=True)
    REVIEWED_DIR.mkdir(parents=True, exist_ok=True)
    url = f"http://{HOST}:{PORT}/"
    print(f"[step3web] serving {UI_DIR}")
    print(f"[step3web] merged : {MERGED_DIR}")
    print(f"[step3web] reviewed: {REVIEWED_DIR}")
    print(f"[step3web] open {url}")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[step3web] bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
