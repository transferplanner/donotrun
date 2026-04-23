// Wi-Fi fingerprint KNN matcher.
//
// Upstream data (data.go.kr 15050127) ships pre-scanned RSSI vectors per cell:
//   { index, lat, lng, planar_x, planar_y, floor, aps: [{bssid, rssi, stddev}] }
// For a live scan we intersect BSSIDs with each cell, compute RMS RSSI distance,
// then take a weighted centroid of the top-K cells. Floor is decided by a
// weighted majority vote across the same K cells.
//
// Usage:
//   const wp = new WifiPositioning(cells);
//   const fix = wp.match(scans); // [{bssid, rssi}]
//   // fix → { lat, lng, planar_x, planar_y, floor, confidence, shared, cellIndex }
//
// `match()` returns null when fewer than MIN_SHARED APs overlap any cell.

const MIN_SHARED = 2;       // need at least 2 common APs to trust a match
const TOP_K = 5;            // cells considered for centroid/floor vote
const MISSING_RSSI = -100;  // penalty for APs only present on one side
const RSSI_FLOOR = -95;     // drop weaker scans as noise

function _rms(vec) {
  if (!vec.length) return Infinity;
  let s = 0;
  for (const v of vec) s += v * v;
  return Math.sqrt(s / vec.length);
}

export class WifiPositioning {
  /**
   * @param {Array<{
   *   index:number, lat:number, lng:number,
   *   planar_x?:number, planar_y?:number, floor?:string, floor_raw?:string,
   *   aps: Array<{bssid:string, rssi:number, stddev?:number}>
   * }>} cells
   */
  constructor(cells) {
    this.cells = cells || [];
    // BSSID → list of cell indexes, for fast candidate lookup
    this.bssidIndex = new Map();
    this.cells.forEach((cell, ci) => {
      for (const ap of cell.aps || []) {
        const b = String(ap.bssid || '').toLowerCase();
        if (!b) continue;
        let arr = this.bssidIndex.get(b);
        if (!arr) {
          arr = [];
          this.bssidIndex.set(b, arr);
        }
        arr.push(ci);
      }
    });
  }

  /**
   * @param {Array<{bssid:string, rssi:number}>} scans
   * @param {{ k?:number, minShared?:number }} [opts]
   */
  match(scans, opts = {}) {
    const k = opts.k ?? TOP_K;
    const minShared = opts.minShared ?? MIN_SHARED;

    // Normalize + filter scan
    const scanMap = new Map();
    for (const s of scans || []) {
      const b = String(s.bssid || '').toLowerCase();
      if (!b) continue;
      const r = Number(s.rssi);
      if (!Number.isFinite(r) || r < RSSI_FLOOR) continue;
      scanMap.set(b, r);
    }
    if (scanMap.size < minShared) return null;

    // Collect candidate cells via BSSID inverted index
    const candidates = new Set();
    for (const b of scanMap.keys()) {
      const arr = this.bssidIndex.get(b);
      if (arr) for (const ci of arr) candidates.add(ci);
    }
    if (!candidates.size) return null;

    // Score each candidate cell
    const scored = [];
    for (const ci of candidates) {
      const cell = this.cells[ci];
      const cellMap = new Map();
      for (const ap of cell.aps || []) {
        cellMap.set(String(ap.bssid).toLowerCase(), ap.rssi);
      }

      const diffs = [];
      let shared = 0;
      for (const [b, r] of scanMap) {
        const cr = cellMap.get(b);
        if (cr != null) {
          diffs.push(r - cr);
          shared += 1;
        } else {
          diffs.push(r - MISSING_RSSI);
        }
      }
      if (shared < minShared) continue;

      const rms = _rms(diffs);
      // Score: smaller rms and more shared APs → better. Inverse weight.
      const weight = shared / (rms + 1);
      scored.push({ ci, cell, rms, shared, weight });
    }
    if (!scored.length) return null;

    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, k);

    // Weighted centroid (lat/lng + planar)
    let wsum = 0, latS = 0, lngS = 0, pxS = 0, pyS = 0;
    const floorVote = new Map();
    for (const t of top) {
      const w = t.weight;
      wsum += w;
      latS += (t.cell.lat || 0) * w;
      lngS += (t.cell.lng || 0) * w;
      pxS += (t.cell.planar_x || 0) * w;
      pyS += (t.cell.planar_y || 0) * w;
      const f = t.cell.floor || t.cell.floor_raw;
      if (f) floorVote.set(f, (floorVote.get(f) || 0) + w);
    }

    let floor;
    let bestFloor = 0;
    for (const [f, w] of floorVote) {
      if (w > bestFloor) { bestFloor = w; floor = f; }
    }

    const best = top[0];
    const confidence = Math.min(1, best.shared / 10) * Math.exp(-best.rms / 20);

    return {
      lat: latS / wsum,
      lng: lngS / wsum,
      planar_x: pxS / wsum,
      planar_y: pyS / wsum,
      floor,
      confidence,
      shared: best.shared,
      rms: best.rms,
      cellIndex: best.cell.index ?? best.ci,
      candidates: top.map((t) => ({
        cellIndex: t.cell.index ?? t.ci,
        floor: t.cell.floor || t.cell.floor_raw,
        rms: t.rms,
        shared: t.shared,
      })),
    };
  }
}
