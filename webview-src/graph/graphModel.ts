import type { GraphEdgeView, GraphFlag, GraphNodeView, GraphPayload, SectionView } from '../../src/models/graph';

/**
 * Pure selection logic for the Graph tab: which nodes and edges to draw, so a
 * large project stays readable. Defaults: only the required results' closure,
 * assets only (definitions as chips), no inactive nodes, and transitively
 * implied edges removed.
 */

export const MAX_VISIBLE = 150;

export type AttentionFilter = 'all' | 'attention' | GraphFlag | 'draft' | 'approved';

export interface ViewOptions {
  scope: 'required' | 'all';
  showDefinitions: boolean;
  showInactive: boolean;
  search: string;
  filter: AttentionFilter;
  focus?: { id: string; depth: number };
}

export const DEFAULT_OPTIONS: ViewOptions = { scope: 'required', showDefinitions: false, showInactive: false, search: '', filter: 'all' };

export interface VisibleGraph {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  /** Edges left out because another path implies them. */
  reduced: number;
  /** Nodes the filters hid. */
  hidden: number;
  overCap: boolean;
}

const INACTIVE = new Set(['deprecated', 'archived']);
const ATTENTION_FLAGS: GraphFlag[] = ['awaiting_approval', 'question', 'counterexample', 'parked', 'manuscript_stale', 'manuscript_invalid', 'uncovered'];

export function needsAttention(node: GraphNodeView): boolean {
  return node.flags.some((flag) => ATTENTION_FLAGS.includes(flag));
}

function matches(node: GraphNodeView, filter: AttentionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return needsAttention(node);
  if (filter === 'draft' || filter === 'approved') return node.status === filter;
  return node.flags.includes(filter);
}

/** Map from a node to what it depends on, and to what depends on it, over the given edges. */
export function adjacency(edges: GraphEdgeView[]): { deps: Map<string, string[]>; dependants: Map<string, string[]> } {
  const deps = new Map<string, string[]>();
  const dependants = new Map<string, string[]>();
  for (const edge of edges) {
    deps.set(edge.from, [...(deps.get(edge.from) ?? []), edge.to]);
    dependants.set(edge.to, [...(dependants.get(edge.to) ?? []), edge.from]);
  }
  return { deps, dependants };
}

export function reach(start: string[], next: Map<string, string[]>, depth = Infinity): Set<string> {
  const seen = new Set(start);
  let frontier = [...start];
  for (let level = 0; level < depth && frontier.length; level++) {
    const upcoming: string[] = [];
    for (const id of frontier) for (const other of next.get(id) ?? []) if (!seen.has(other)) { seen.add(other); upcoming.push(other); }
    frontier = upcoming;
  }
  return seen;
}

/**
 * Drop an edge a→b when b is still reachable from a without it: in a
 * dependency graph most such edges restate what a longer chain already shows.
 */
export function transitiveReduction(edges: GraphEdgeView[]): { edges: GraphEdgeView[]; removed: number } {
  const kept: GraphEdgeView[] = [];
  const { deps } = adjacency(edges);
  for (const edge of edges) {
    const others = (deps.get(edge.from) ?? []).filter((id) => id !== edge.to);
    const implied = others.length > 0 && reach(others, deps).has(edge.to);
    if (!implied) kept.push(edge);
  }
  return { edges: kept, removed: edges.length - kept.length };
}

export function visibleGraph(payload: GraphPayload, options: ViewOptions, ignoreCap = false): VisibleGraph {
  const inScope = (node: GraphNodeView) => node.inScope || (node.refutes !== undefined && payload.nodes.some((other) => other.id === node.refutes && other.inScope));
  const base = payload.nodes.filter((node) =>
    (options.showDefinitions || node.kind === 'asset')
    && (options.showInactive || !INACTIVE.has(node.status))
    && (options.scope === 'all' || inScope(node)));
  const baseIds = new Set(base.map((node) => node.id));
  const baseEdges = payload.edges.filter((edge) => baseIds.has(edge.from) && baseIds.has(edge.to));
  const { deps, dependants } = adjacency(baseEdges);
  let keep = new Set(baseIds);

  const search = options.search.trim().toLowerCase();
  if (search || options.filter !== 'all') {
    const hits = base.filter((node) => (!search || node.id.toLowerCase().includes(search) || node.title.toLowerCase().includes(search)) && matches(node, options.filter)).map((node) => node.id);
    // Keep each hit's path up to the required results it serves, so it stays in context (refutations are not such a path).
    keep = reach(hits, adjacency(baseEdges.filter((edge) => edge.type !== 'refutes')).dependants);
  }
  if (options.focus && baseIds.has(options.focus.id)) {
    const both = new Map<string, string[]>();
    for (const [id, list] of deps) both.set(id, [...(both.get(id) ?? []), ...list]);
    for (const [id, list] of dependants) both.set(id, [...(both.get(id) ?? []), ...list]);
    const near = reach([options.focus.id], both, options.focus.depth);
    keep = new Set([...keep].filter((id) => near.has(id)));
    keep.add(options.focus.id);
  }
  const nodes = base.filter((node) => keep.has(node.id));
  const reduced = transitiveReduction(baseEdges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)));
  const overCap = !ignoreCap && nodes.length > MAX_VISIBLE;
  return { nodes: overCap ? [] : nodes, edges: overCap ? [] : reduced.edges, reduced: reduced.removed, hidden: payload.nodes.length - nodes.length, overCap };
}

export interface ImpactResult {
  node?: GraphNodeView;
  /** What the node rests on (one step). */
  upstream: GraphNodeView[];
  /** Everything that transitively rests on it. */
  downstream: GraphNodeView[];
  graph: { nodes: GraphNodeView[]; edges: GraphEdgeView[] };
  sections: { section: SectionView; via: string[]; blocks: { id: string; via: string[]; lines?: [number, number]; state: string }[] }[];
  unaffected: SectionView[];
}

/** The change-impact view: one step upstream, every dependant downstream, and the manuscript passages that present any of them. */
export function impactOf(payload: GraphPayload, id: string): ImpactResult {
  const node = payload.nodes.find((item) => item.id === id);
  const { deps, dependants } = adjacency(payload.edges.filter((edge) => edge.type !== 'refutes'));
  const down = reach([id], dependants);
  const upstreamIds = new Set(deps.get(id) ?? []);
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  const downstream = [...down].filter((item) => item !== id).map((item) => byId.get(item)).filter((item): item is GraphNodeView => Boolean(item));
  const upstream = [...upstreamIds].map((item) => byId.get(item)).filter((item): item is GraphNodeView => Boolean(item));
  const keep = new Set([...down, ...upstreamIds]);
  const graphNodes = payload.nodes.filter((item) => keep.has(item.id));
  const graphEdges = transitiveReduction(payload.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to) && edge.type !== 'refutes')).edges;
  const affected: ImpactResult['sections'] = [];
  const unaffected: SectionView[] = [];
  for (const section of payload.sections) {
    const presented = new Set([...section.sources, ...section.bound]);
    const via = [...down].filter((item) => presented.has(item));
    const blocks = section.blocks.map((block) => ({ id: block.id, via: block.sources.filter((source) => down.has(source)), lines: block.lines, state: block.state })).filter((block) => block.via.length);
    if (via.length || blocks.length) affected.push({ section, via, blocks });
    else unaffected.push(section);
  }
  return { node, upstream, downstream, graph: { nodes: graphNodes, edges: graphEdges }, sections: affected, unaffected };
}
