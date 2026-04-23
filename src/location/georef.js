// Georeference a fingerprint floor (lat/lng) onto a graph floor (0..1000 xy).
//
// We don't yet have manually-surveyed anchors, so we fit a rough
// axis-aligned transform by matching bounding boxes:
//
//   lng ∈ [lngMin, lngMax]  →  x ∈ [xMin, xMax]
//   lat ∈ [latMin, latMax]  →  y ∈ [yMax, yMin]   (flipped: north → top)
//
// This assumes the floor plan is roughly north-up and axis-aligned with WGS84,
// which holds for most subway station diagrams. For off-axis stations we'll
// replace this with a manually-picked 2-3 anchor affine fit.
//
// Usage:
//   const t = fitBboxTransform(cells, nodes);      // both on same floor
//   const [x, y] = applyTransform(t, {lat, lng});  // x,y in 0..1000
//   const conf = t ? t.confidence : 0;

function _bbox(pts, xKey, yKey) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  let n = 0;
  for (const p of pts) {
    const x = p[xKey], y = p[yKey];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x === 0 && y === 0) continue; // sentinel for missing coord
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    n += 1;
  }
  if (n < 2) return null;
  return { xMin, xMax, yMin, yMax, count: n };
}

/**
 * @param {Array<{lat:number,lng:number}>} cells — fingerprint cells on one floor
 * @param {Array<{x:number,y:number}>} nodes    — graph nodes on matched floor (0..1000 coords)
 * @returns {null | {
 *   project: (fix:{lat:number,lng:number}) => [number, number],
 *   confidence: number,
 *   srcBbox: object, dstBbox: object,
 * }}
 */
/**
 * @param {{flipLng?:boolean, flipLat?:boolean}} [axes] — per-station image orientation
 *   flipLng=true → image x grows westward (Seoul subway isometric convention for some stations)
 *   flipLat=true → image y grows northward (unusual; default assumes north-up)
 */
export function fitBboxTransform(cells, nodes, axes = {}) {
  const src = _bbox(cells, 'lng', 'lat'); // lng=x, lat=y
  const dst = _bbox(nodes, 'x', 'y');
  if (!src || !dst) return null;

  const lngRange = src.xMax - src.xMin;
  const latRange = src.yMax - src.yMin;
  const xRange = dst.xMax - dst.xMin;
  const yRange = dst.yMax - dst.yMin;
  if (lngRange <= 0 || latRange <= 0 || xRange <= 0 || yRange <= 0) return null;

  const flipLng = !!axes.flipLng;
  const flipLat = !!axes.flipLat; // default: north→top (y shrinks as lat grows)

  const confidence = Math.min(1, Math.log10(1 + src.count) / 3)
                   * Math.min(1, Math.log10(1 + dst.count) / 2);

  const project = (fix) => {
    const lat = Number(fix.lat), lng = Number(fix.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [500, 500];
    const tLng = (lng - src.xMin) / lngRange;   // 0..1 west→east (natural)
    const tLat = (lat - src.yMin) / latRange;   // 0..1 south→north (natural)
    const tx = flipLng ? 1 - tLng : tLng;
    const ty = flipLat ? tLat : 1 - tLat;       // default flips: north→top
    const x = dst.xMin + tx * xRange;
    const y = dst.yMin + ty * yRange;
    return [x, y];
  };

  return { project, confidence, srcBbox: src, dstBbox: dst, axes: { flipLng, flipLat } };
}

/**
 * Build a per-graph-floor transform map.
 *
 * Fingerprint cells carry raw floor codes (e.g. "AB01"), while the graph uses
 * its own labels ("B1", "1F"). `floorMap` translates codes → graph labels; we
 * then group cells by graph-floor and fit one transform per floor.
 *
 * @param {{cells:Array}} fp — normalized fingerprint doc
 * @param {{floors:Array}} graph
 * @param {Object<string,string>} [floorMap] — override raw→label, else use cell.floor
 * @returns {Map<number, ReturnType<typeof fitBboxTransform>>}
 */
export function buildFloorTransforms(fp, graph, floorMap, axes) {
  const out = new Map();
  if (!fp?.cells || !graph?.floors) return out;

  const byGraphFloor = new Map();
  for (const cell of fp.cells) {
    const raw = cell.floor_raw || cell.floor;
    const label = (floorMap && floorMap[raw]) || cell.floor || raw;
    const idx = graph.floors.findIndex(f => f.floor === label);
    if (idx < 0) continue;
    let arr = byGraphFloor.get(idx);
    if (!arr) { arr = []; byGraphFloor.set(idx, arr); }
    arr.push(cell);
  }

  for (const [idx, cells] of byGraphFloor) {
    const nodes = graph.floors[idx].nodes || [];
    const t = fitBboxTransform(cells, nodes, axes);
    if (t) out.set(idx, t);
  }
  return out;
}
