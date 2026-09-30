import type { GraphEdgeView, GraphNodeView } from '../../src/models/graph';

/**
 * Layered layout in lanes. Columns are dependency depth (prerequisites on the
 * left, required results on the right); horizontal bands group nodes by the
 * required result they serve, with dependencies shared by several results in
 * a "shared" band on top. Rows inside a band follow the barycenter of each
 * node's prerequisites, which keeps most edges short and uncrossed.
 */

export const NODE_W = 196;
export const NODE_H = 56;
const COL_GAP = 64;
const ROW_GAP = 12;
const BAND_GAP = 18;
const BAND_HEADER = 22;
const PAD = 16;

export interface Positioned { id: string; x: number; y: number }
export interface Band { lane: string; y: number; height: number }
export interface Layout { positions: Map<string, Positioned>; bands: Band[]; width: number; height: number }

export function laneOrder(nodes: GraphNodeView[], required: string[]): string[] {
  const present = new Set(nodes.map((node) => node.lane));
  return ['shared', ...required, 'other', ...[...present].sort()].filter((lane, index, all) => present.has(lane) && all.indexOf(lane) === index);
}

/** Longest-path depth over the visible edges; a cycle is cut where it is found. */
export function layers(nodes: GraphNodeView[], edges: GraphEdgeView[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const deps = new Map<string, string[]>();
  for (const edge of edges) if (ids.has(edge.from) && ids.has(edge.to)) deps.set(edge.from, [...(deps.get(edge.from) ?? []), edge.to]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(deps.get(id) ?? []).map(visit)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) visit(node.id);
  return depth;
}

export function layout(nodes: GraphNodeView[], edges: GraphEdgeView[], required: string[]): Layout {
  const depth = layers(nodes, edges);
  const deps = new Map<string, string[]>();
  for (const edge of edges) deps.set(edge.from, [...(deps.get(edge.from) ?? []), edge.to]);
  const positions = new Map<string, Positioned>();
  const bands: Band[] = [];
  const columns = Math.max(0, ...[...depth.values()]) + 1;
  let top = PAD;
  for (const lane of laneOrder(nodes, required)) {
    const members = nodes.filter((node) => node.lane === lane);
    const byLayer = new Map<number, GraphNodeView[]>();
    for (const node of members) byLayer.set(depth.get(node.id) ?? 0, [...(byLayer.get(depth.get(node.id) ?? 0) ?? []), node]);
    const row = new Map<string, number>();
    // Place each column by the mean row of its prerequisites already placed (in any band, weighted by their y).
    const rank = (node: GraphNodeView) => {
      const placed = (deps.get(node.id) ?? []).map((id) => positions.get(id)?.y ?? (row.has(id) ? top + row.get(id)! * (NODE_H + ROW_GAP) : undefined)).filter((value): value is number => value !== undefined);
      return placed.length ? placed.reduce((sum, value) => sum + value, 0) / placed.length : Number.MAX_SAFE_INTEGER;
    };
    let rows = 0;
    for (let layer = 0; layer < columns; layer++) {
      const column = (byLayer.get(layer) ?? []).slice().sort((a, b) => rank(a) - rank(b) || Number(b.required) - Number(a.required) || a.id.localeCompare(b.id));
      column.forEach((node, index) => row.set(node.id, index));
      rows = Math.max(rows, column.length);
    }
    const height = BAND_HEADER + rows * (NODE_H + ROW_GAP);
    for (const node of members) {
      positions.set(node.id, { id: node.id, x: PAD + (depth.get(node.id) ?? 0) * (NODE_W + COL_GAP), y: top + BAND_HEADER + row.get(node.id)! * (NODE_H + ROW_GAP) });
    }
    bands.push({ lane, y: top, height });
    top += height + BAND_GAP;
  }
  return { positions, bands, width: PAD * 2 + columns * NODE_W + Math.max(0, columns - 1) * COL_GAP, height: Math.max(top, PAD * 2) };
}
