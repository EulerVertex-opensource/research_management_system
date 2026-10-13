/**
 * Layered layout, read top to bottom: prerequisites (and known results from
 * the library) on top, each result below what it rests on, and the main
 * results at the bottom. Rows are dependency depth; inside a row, nodes follow
 * the mean position of their prerequisites, then of their dependants, which
 * keeps most edges short and uncrossed.
 */

export const NODE_W = 216;
export const NODE_H = 104;
const COL_GAP = 28;
const ROW_GAP = 56;
const PAD = 16;

export interface LayoutItem { id: string; required?: boolean }
/** `from` depends on `to`: `to` is drawn above `from`. */
export interface LayoutEdge { from: string; to: string }
export interface Positioned { id: string; x: number; y: number }
export interface Layout { positions: Map<string, Positioned>; width: number; height: number }

/** Longest-path depth from the prerequisites over the visible edges; a cycle is cut where it is found. */
export function layers(items: LayoutItem[], edges: LayoutEdge[]): Map<string, number> {
  const ids = new Set(items.map((item) => item.id));
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
  for (const item of items) visit(item.id);
  // Main results nothing else rests on sit on the bottom row, so every goal reads as the end of its tree.
  const bottom = Math.max(0, ...depth.values());
  const users = new Map<string, string[]>();
  for (const edge of edges) if (ids.has(edge.from) && ids.has(edge.to)) users.set(edge.to, [...(users.get(edge.to) ?? []), edge.from]);
  for (const item of items) if (item.required && !users.has(item.id)) depth.set(item.id, bottom);
  // A result with no prerequisites (a known result, a folded branch) sits just above the first result that uses it, not on the top row.
  for (const item of items) {
    if (deps.has(item.id) || !users.has(item.id)) continue;
    depth.set(item.id, Math.max(0, Math.min(...users.get(item.id)!.map((user) => depth.get(user) ?? 1)) - 1));
  }
  return depth;
}

export function layout(items: LayoutItem[], edges: LayoutEdge[]): Layout {
  const depth = layers(items, edges);
  const ids = new Set(items.map((item) => item.id));
  const visible = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const deps = new Map<string, string[]>();
  const dependants = new Map<string, string[]>();
  for (const edge of visible) {
    deps.set(edge.from, [...(deps.get(edge.from) ?? []), edge.to]);
    dependants.set(edge.to, [...(dependants.get(edge.to) ?? []), edge.from]);
  }
  const rowCount = Math.max(0, ...depth.values()) + 1;
  const rows: LayoutItem[][] = Array.from({ length: rowCount }, () => []);
  for (const item of items) rows[depth.get(item.id) ?? 0].push(item);
  const order = new Map<string, number>();
  const mean = (neighbours: string[] | undefined) => {
    const known = (neighbours ?? []).map((id) => order.get(id)).filter((value): value is number => value !== undefined);
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : undefined;
  };
  const place = (row: LayoutItem[], key: (item: LayoutItem) => number | undefined) => {
    row.sort((a, b) => (key(a) ?? Number.MAX_SAFE_INTEGER) - (key(b) ?? Number.MAX_SAFE_INTEGER) || Number(b.required) - Number(a.required) || a.id.localeCompare(b.id));
    const offset = (row.length - 1) / 2;
    row.forEach((item, index) => order.set(item.id, index - offset));
  };
  for (const row of rows) place(row, () => undefined);
  for (const row of rows) place(row, (item) => mean(deps.get(item.id)) ?? order.get(item.id));
  for (const row of [...rows].reverse()) place(row, (item) => mean(dependants.get(item.id)) ?? order.get(item.id));
  for (const row of rows.slice(1)) place(row, (item) => mean(deps.get(item.id)) ?? order.get(item.id));

  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * COL_GAP;
  const positions = new Map<string, Positioned>();
  rows.forEach((row, index) => {
    const rowWidth = row.length * NODE_W + Math.max(0, row.length - 1) * COL_GAP;
    const left = (width - rowWidth) / 2;
    row.forEach((item, column) => positions.set(item.id, { id: item.id, x: left + column * (NODE_W + COL_GAP), y: PAD + index * (NODE_H + ROW_GAP) }));
  });
  return { positions, width, height: PAD * 2 + rowCount * NODE_H + Math.max(0, rowCount - 1) * ROW_GAP };
}
