/**
 * Lane layout for the commit graph. Pure: the host only sends commits with
 * their parent hashes; all geometry is computed here and drawn as SVG by the
 * CommitList component.
 */
import type { Commit } from './types';

export const LANE_W = 16;
export const ROW_H = 26;
export const PAD = 10;

const COLORS = [
  '#4ea3ff', '#42c767', '#e0a92b', '#d05ce3',
  '#ef5b8c', '#26c6da', '#ff8a4c', '#9b8cff',
];

export function laneColor(lane: number): string {
  return COLORS[((lane % COLORS.length) + COLORS.length) % COLORS.length];
}

export interface GraphNode {
  row: number;
  lane: number;
  color: string;
}

export interface GraphEdge {
  fromLane: number;
  fromRow: number;
  toLane: number;
  /** Row of the parent commit, or null when it isn't in the loaded window. */
  toRow: number | null;
  color: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  laneCount: number;
}

/**
 * Assign each commit a lane and produce edges to parents. First parent
 * reclaims the node's lane; other parents take free slots.
 */
export function computeGraph(commits: readonly Commit[]): Graph {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.hash, i));

  const lanes: (string | null)[] = []; // expected parent hash per lane (or null)
  const freeSlot = (): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] == null) {
        return i;
      }
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let maxLane = 0;

  commits.forEach((c, row) => {
    let myLane = lanes.indexOf(c.hash);
    if (myLane === -1) {
      myLane = freeSlot();
    }
    lanes[myLane] = null; // release; first parent will reclaim
    nodes.push({ row, lane: myLane, color: laneColor(myLane) });

    c.parents.forEach((p, pi) => {
      let pl = lanes.indexOf(p);
      if (pl === -1) {
        pl = pi === 0 ? myLane : freeSlot();
        lanes[pl] = p;
      }
      edges.push({
        fromLane: myLane,
        fromRow: row,
        toLane: pl,
        toRow: rowOf.has(p) ? (rowOf.get(p) as number) : null,
        color: laneColor(pl),
      });
    });

    maxLane = Math.max(maxLane, lanes.length - 1, myLane);
  });

  return { nodes, edges, laneCount: maxLane + 1 };
}

export function laneX(lane: number): number {
  return PAD + lane * LANE_W + LANE_W / 2;
}

export function rowY(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

/** SVG path for an edge, matching the original webview's curve shape. */
export function edgePath(e: GraphEdge): string {
  const xF = laneX(e.fromLane);
  const yF = rowY(e.fromRow);
  const xT = laneX(e.toLane);
  const yT = e.toRow == null ? yF + ROW_H * 1.5 : rowY(e.toRow);
  if (e.fromLane === e.toLane) {
    return `M ${xF} ${yF} L ${xT} ${yT}`;
  }
  const yMid = yF + ROW_H;
  return `M ${xF} ${yF} C ${xF} ${yF + ROW_H / 2}, ${xT} ${yMid - ROW_H / 2}, ${xT} ${yMid} L ${xT} ${yT}`;
}
