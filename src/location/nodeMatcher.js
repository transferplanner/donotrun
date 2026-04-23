// Map a fused (x,y,floor) estimate onto the nearest graph node.
// Uses plain linear scan (nodes per station are small; KDTree not required).

export class NodeMatcher {
  /** @param {{floors: Array<{floor:string, nodes:Array<{id,x,y,type,label}>}>}} stationGraph */
  constructor(stationGraph) {
    this.graph = stationGraph;
  }

  /**
   * @param {{x:number,y:number,floor?:string}} est
   * @returns {{node:object, floor:string, distance:number}|null}
   */
  match(est) {
    let best = null;
    for (const floor of this.graph.floors) {
      if (est.floor && floor.floor !== est.floor) continue;
      for (const n of floor.nodes) {
        const d = Math.hypot(n.x - est.x, n.y - est.y);
        if (!best || d < best.distance) {
          best = { node: n, floor: floor.floor, distance: d };
        }
      }
    }
    return best;
  }
}
