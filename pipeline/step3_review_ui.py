"""Step 3: Tkinter review UI for step2 outputs.

Loads data/output/merged/*.json, overlays nodes + links on the original JPEG,
lets the operator drag/add/delete nodes, switch floors, edit labels, save.
"""
from __future__ import annotations

import json
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, simpledialog

from PIL import Image, ImageTk

from . import config
from .utils import io_helpers

NODE_R = 7
TYPE_COLORS = {
    "gate": "#ffd400",
    "exit": "#00d66b",
    "stair": "#4aa3ff",
    "escalator": "#4aa3ff",
    "elevator": "#a46bff",
    "corridor": "#ff8c4a",
    "junction": "#ff8c4a",
    "toilet": "#ff4aa3",
    "info": "#ffffff",
    "platform_edge": "#ff3040",
    "transfer_point": "#00d6c6",
    "fare_machine": "#bbbbbb",
}
DEFAULT_COLOR = "#4aa3ff"


class ReviewApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("dont-run-indoor — review")
        self.root.geometry("1200x820")

        top = tk.Frame(root, bg="#2a2a2a")
        top.pack(fill="x")
        tk.Button(top, text="Open merged", command=self.open_json).pack(side="left")
        tk.Button(top, text="Save reviewed", command=self.save_json).pack(side="left")
        tk.Button(top, text="Add node (A)", command=self.add_node_mode).pack(side="left")
        tk.Button(top, text="Delete (Del)", command=self.delete_selected).pack(side="left")
        self.floor_var = tk.StringVar(value="—")
        self.floor_menu = tk.OptionMenu(top, self.floor_var, "—", command=self._on_floor_change)
        self.floor_menu.pack(side="left", padx=8)
        self.status = tk.Label(top, text="ready — click 'Open merged' to load a station",
                               anchor="w", bg="#2a2a2a", fg="#eeeeee")
        self.status.pack(side="left", fill="x", expand=True, padx=8)

        self.canvas = tk.Canvas(root, bg="#111", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)

        self.data: dict | None = None
        self.json_path: Path | None = None
        self.img_tk: ImageTk.PhotoImage | None = None
        self.img_w = self.img_h = 0
        self.floor_index = 0
        self.selected: str | None = None
        self.drag = False
        self.mode = "select"

        self.canvas.bind("<Button-1>", self.on_click)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Double-Button-1>", self.on_double)
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self._last_canvas_size = (0, 0)
        root.bind("a", lambda _e: self.add_node_mode())
        root.bind("<Delete>", lambda _e: self.delete_selected())
        root.bind("<BackSpace>", lambda _e: self.delete_selected())

        # Defer auto-load until after the window has been mapped so the canvas
        # has a real size for thumbnail scaling.
        root.after(200, self._auto_load)

    def _auto_load(self) -> None:
        merged_dir = config.OUTPUT_DIR / "merged"
        self._set_status(f"scanning {merged_dir}")
        if not merged_dir.exists():
            self._set_status(f"merged/ missing: {merged_dir}")
            return
        files = sorted(merged_dir.glob("*.json"))
        if not files:
            self._set_status("no merged JSONs found — click 'Open merged'")
            return
        self._load_path(files[0])
        self._set_status(f"auto-loaded {files[0].name} ({len(files)} in merged/)")

    # ---- status ----
    def _set_status(self, msg: str) -> None:
        self.status.config(text=msg)
        print("[step3]", msg, flush=True)
        try:
            log = config.OUTPUT_DIR / "step3_debug.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            pass

    # ---- file I/O ----
    def open_json(self) -> None:
        init = config.OUTPUT_DIR / "merged"
        init.mkdir(parents=True, exist_ok=True)
        path = filedialog.askopenfilename(initialdir=str(init), filetypes=[("JSON", "*.json")])
        if not path:
            return
        self._load_path(Path(path))

    def _load_path(self, path: Path) -> None:
        self.json_path = path
        self.data = io_helpers.read_json(path)
        # Floor dropdown
        menu = self.floor_menu["menu"]
        menu.delete(0, "end")
        for i, f in enumerate(self.data.get("floors", [])):
            label = f.get("floor", f"floor_{i}")
            menu.add_command(label=label, command=lambda v=label, idx=i: self._select_floor(idx))
        self._select_floor(0)

    def save_json(self) -> None:
        if not self.data or not self.json_path:
            self._set_status("nothing to save")
            return
        out = config.OUTPUT_DIR / "reviewed" / self.json_path.name
        io_helpers.write_json(out, self.data)
        self._set_status(f"saved → {out}")

    # ---- floor ----
    def _select_floor(self, idx: int) -> None:
        self.floor_index = idx
        floor = self.data["floors"][idx]
        self.floor_var.set(floor.get("floor", f"floor_{idx}"))
        self.selected = None
        self._load_image_for_current_floor()
        self._redraw()

    def _on_floor_change(self, value: str) -> None:
        for i, f in enumerate(self.data.get("floors", [])):
            if f.get("floor") == value:
                self._select_floor(i)
                return

    def _on_canvas_resize(self, event) -> None:
        w, h = event.width, event.height
        prev_w, prev_h = self._last_canvas_size
        self._last_canvas_size = (w, h)
        # Reload the image if canvas grew significantly (initial mount or window resize)
        if self.data and (abs(w - prev_w) > 20 or abs(h - prev_h) > 20) and w > 100 and h > 100:
            self._load_image_for_current_floor()
        self._redraw()

    def _load_image_for_current_floor(self) -> None:
        src = self.data.get("_source_image") if self.data else None
        if not src:
            self.img_tk = None
            self._set_status("no _source_image in JSON")
            return
        img_path = config.RAW_MAPS_DIR / src
        if not img_path.exists():
            self.img_tk = None
            self._set_status(f"image missing: {img_path}")
            return
        try:
            img = Image.open(img_path)
            if img.mode != "RGB":
                img = img.convert("RGB")
            cw = self.canvas.winfo_width()
            ch = self.canvas.winfo_height()
            # Avoid sub-100 sizes that happen before first layout pass
            if cw < 100: cw = 1160
            if ch < 100: ch = 760
            img.thumbnail((cw, ch), Image.LANCZOS)
            self.img_tk = ImageTk.PhotoImage(img)
            self.img_w, self.img_h = img.size
            self._set_status(f"loaded {img_path.name}  {self.img_w}×{self.img_h}  "
                             f"floor={self.floor_var.get()}  "
                             f"nodes={len(self.data['floors'][self.floor_index]['nodes'])}")
        except Exception as e:
            self.img_tk = None
            self._set_status(f"image load failed: {e}")

    # ---- rendering ----
    def _redraw(self) -> None:
        self.canvas.delete("all")
        if self.img_tk:
            self.canvas.create_image(0, 0, anchor="nw", image=self.img_tk)
        if not self.data:
            return
        floor = self.data["floors"][self.floor_index]
        node_by_id = {n["id"]: n for n in floor["nodes"]}

        # Draw links (intra-floor only, to keep the picture readable)
        for link in floor.get("links", []):
            to = link.get("to", "")
            if isinstance(to, str) and to.startswith("F"):
                continue
            a = node_by_id.get(link.get("from"))
            b = node_by_id.get(to)
            if not a or not b:
                continue
            ax, ay = self._rel_to_canvas(a["x"], a["y"])
            bx, by = self._rel_to_canvas(b["x"], b["y"])
            self.canvas.create_line(ax, ay, bx, by, fill="#4af4", width=1)

        # Draw nodes
        for n in floor["nodes"]:
            cx, cy = self._rel_to_canvas(n["x"], n["y"])
            color = TYPE_COLORS.get(n.get("type", ""), DEFAULT_COLOR)
            if n["id"] == self.selected:
                self.canvas.create_oval(cx - NODE_R - 4, cy - NODE_R - 4,
                                        cx + NODE_R + 4, cy + NODE_R + 4,
                                        outline="#ffffff", width=2)
            self.canvas.create_oval(cx - NODE_R, cy - NODE_R, cx + NODE_R, cy + NODE_R,
                                    fill=color, outline="#000", width=1)
            label = n.get("label") or n["id"]
            self.canvas.create_text(cx + NODE_R + 3, cy, anchor="w", text=label,
                                    fill="#ffffff", font=("Helvetica", 10, "bold"))

    def _rel_to_canvas(self, rx: float, ry: float) -> tuple[float, float]:
        return rx / 1000.0 * self.img_w, ry / 1000.0 * self.img_h

    def _canvas_to_rel(self, cx: float, cy: float) -> tuple[float, float]:
        if self.img_w == 0 or self.img_h == 0:
            return cx, cy
        return cx * 1000.0 / self.img_w, cy * 1000.0 / self.img_h

    # ---- interactions ----
    def on_click(self, ev) -> None:
        if not self.data:
            return
        floor = self.data["floors"][self.floor_index]
        if self.mode == "add":
            rx, ry = self._canvas_to_rel(ev.x, ev.y)
            new_id = f"n{len(floor['nodes']) + 1}"
            floor["nodes"].append({"id": new_id, "type": "corridor", "label": new_id, "x": rx, "y": ry})
            self.mode = "select"
            self.selected = new_id
            self._set_status(f"added {new_id} — double-click to edit label/type")
            self._redraw()
            return
        self.selected = None
        for n in floor["nodes"]:
            cx, cy = self._rel_to_canvas(n["x"], n["y"])
            if (ev.x - cx) ** 2 + (ev.y - cy) ** 2 <= (NODE_R + 4) ** 2:
                self.selected = n["id"]
                self.drag = True
                break
        self._redraw()

    def on_drag(self, ev) -> None:
        if not self.drag or not self.selected:
            return
        floor = self.data["floors"][self.floor_index]
        node = next((n for n in floor["nodes"] if n["id"] == self.selected), None)
        if not node:
            return
        node["x"], node["y"] = self._canvas_to_rel(ev.x, ev.y)
        self._redraw()

    def on_release(self, _ev) -> None:
        self.drag = False

    def on_double(self, _ev) -> None:
        if not self.selected:
            return
        floor = self.data["floors"][self.floor_index]
        node = next((n for n in floor["nodes"] if n["id"] == self.selected), None)
        if not node:
            return
        new_label = simpledialog.askstring("Edit label", "Label:", initialvalue=node.get("label", ""))
        if new_label is not None:
            node["label"] = new_label
        new_type = simpledialog.askstring(
            "Edit type",
            "Type (gate|exit|stair|escalator|elevator|corridor|junction|toilet|info|platform_edge|transfer_point|fare_machine):",
            initialvalue=node.get("type", ""))
        if new_type:
            node["type"] = new_type
        self._redraw()

    def add_node_mode(self) -> None:
        self.mode = "add"
        self._set_status("click anywhere on the canvas to drop a new node")

    def delete_selected(self) -> None:
        if not self.selected or not self.data:
            return
        floor = self.data["floors"][self.floor_index]
        floor["nodes"] = [n for n in floor["nodes"] if n["id"] != self.selected]
        floor["links"] = [l for l in floor.get("links", [])
                          if l.get("from") != self.selected and l.get("to") != self.selected]
        self._set_status(f"deleted {self.selected}")
        self.selected = None
        self._redraw()


def main() -> int:
    root = tk.Tk()
    ReviewApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
