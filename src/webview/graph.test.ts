import { describe, expect, it } from 'vitest';
import { computeGraph, edgePath, laneColor, laneX, rowY, LANE_W, PAD, ROW_H } from './graph';
import type { Commit } from './types';

function commit(hash: string, parents: string[]): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents,
    authorName: 'A',
    authorEmail: 'a@example.com',
    authorDate: '2026-01-01T00:00:00+00:00',
    subject: hash,
    refs: [],
  };
}

describe('computeGraph', () => {
  it('lays a linear history out on a single lane', () => {
    const commits = [commit('c3', ['c2']), commit('c2', ['c1']), commit('c1', [])];
    const g = computeGraph(commits);

    expect(g.laneCount).toBe(1);
    expect(g.nodes.map((n) => n.lane)).toEqual([0, 0, 0]);
    // Two parent edges (the root has none), all staying in lane 0.
    expect(g.edges).toHaveLength(2);
    expect(g.edges.every((e) => e.fromLane === 0 && e.toLane === 0)).toBe(true);
    expect(g.edges[0].toRow).toBe(1);
  });

  it('gives a side branch its own lane and joins it back at the merge', () => {
    // m (merge of b+f) -> b -> a, with f -> a on a feature branch.
    const commits = [
      commit('m', ['b', 'f']),
      commit('b', ['a']),
      commit('f', ['a']),
      commit('a', []),
    ];
    const g = computeGraph(commits);

    expect(g.laneCount).toBe(2);
    // The merge commit sits on lane 0; the second parent occupies lane 1.
    expect(g.nodes[0].lane).toBe(0);
    const mergeEdges = g.edges.filter((e) => e.fromRow === 0);
    expect(mergeEdges.map((e) => e.toLane).sort()).toEqual([0, 1]);
    // The feature commit really renders on lane 1.
    expect(g.nodes[2].lane).toBe(1);
    // Both sides converge on the shared root.
    const rootEdges = g.edges.filter((e) => e.toRow === 3);
    expect(rootEdges).toHaveLength(2);
  });

  it('marks edges to parents outside the loaded window with toRow null', () => {
    const g = computeGraph([commit('tip', ['missing'])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].toRow).toBeNull();
  });

  it('handles an empty commit list', () => {
    const g = computeGraph([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.laneCount).toBe(1);
  });

  it('keeps unrelated roots on separate lanes', () => {
    const commits = [commit('x2', ['x1']), commit('y1', []), commit('x1', [])];
    const g = computeGraph(commits);
    expect(g.nodes[0].lane).not.toBe(g.nodes[1].lane);
  });
});

describe('geometry helpers', () => {
  it('centers nodes inside their lane and row', () => {
    expect(laneX(0)).toBe(PAD + LANE_W / 2);
    expect(rowY(0)).toBe(ROW_H / 2);
    expect(rowY(3)).toBe(3 * ROW_H + ROW_H / 2);
  });

  it('draws a straight segment for same-lane edges and a curve otherwise', () => {
    const straight = edgePath({ fromLane: 0, fromRow: 0, toLane: 0, toRow: 1, color: '#fff' });
    expect(straight).toContain('L');
    expect(straight).not.toContain('C');
    const curved = edgePath({ fromLane: 0, fromRow: 0, toLane: 1, toRow: 2, color: '#fff' });
    expect(curved).toContain('C');
  });

  it('cycles lane colors and tolerates negative lanes', () => {
    expect(laneColor(0)).toBe(laneColor(8));
    expect(laneColor(-1)).toBe(laneColor(7));
  });
});
