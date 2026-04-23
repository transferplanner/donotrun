// Dijkstra shortest path on the station graph (node-link JSON from step4).
// Cross-floor link ids are encoded as "F<floorIndex>:<nodeId>".

function key(floorIdx, nodeId) { return `${floorIdx}:${nodeId}`; }

function buildAdjacency(graph) {
  const adj = new Map();
  const nodeIndex = new Map();
  graph.floors.forEach((floor, fi) => {
    floor.nodes.forEach((n) => {
      nodeIndex.set(key(fi, n.id), { ...n, _floor: fi });
      if (!adj.has(key(fi, n.id))) adj.set(key(fi, n.id), []);
    });
    for (const link of floor.links || []) {
      const from = key(fi, link.from);
      // "F<idx>:<id>" syntax for cross-floor
      let to;
      if (typeof link.to === "string" && link.to.startsWith("F")) {
        const m = link.to.match(/^F(\d+):(.+)$/);
        to = m ? key(Number(m[1]), m[2]) : key(fi, link.to);
      } else {
        to = key(fi, link.to);
      }
      const w = Number(link.weight_m) || 1;
      adj.get(from).push({ to, w, kind: link.kind });
      if (!adj.has(to)) adj.set(to, []);
      adj.get(to).push({ to: from, w, kind: link.kind });
    }
  });
  return { adj, nodeIndex };
}

/**
 * @param {object} graph  final station graph
 * @param {{floor:number,nodeId:string}} start
 * @param {{floor:number,nodeId:string}} goal
 */
export function shortestPath(graph, start, goal) {
  const { adj, nodeIndex } = buildAdjacency(graph);
  const src = key(start.floor, start.nodeId);
  const dst = key(goal.floor, goal.nodeId);
  if (!adj.has(src) || !adj.has(dst)) return null;

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  dist.set(src, 0);

  // Simple array-backed priority queue (binary heap would be faster for large graphs)
  const queue = [[0, src]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === dst) break;
    for (const edge of adj.get(u) || []) {
      const nd = d + edge.w;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, u);
        queue.push([nd, edge.to]);
      }
    }
  }

  if (!dist.has(dst)) return null;
  const path = [];
  let cur = dst;
  while (cur) {
    path.unshift(nodeIndex.get(cur));
    cur = prev.get(cur);
  }
  return { totalMeters: dist.get(dst), nodes: path };
}
