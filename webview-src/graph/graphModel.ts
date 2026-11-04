import type { AttentionItem, GraphEdgeView, GraphFlag, GraphNodeView, GraphPayload, SectionView } from '../../src/models/graph';
import { isPrerequisiteEdge } from '../../src/models/graph';

/**
 * Pure selection logic for the Graph tab: which nodes and edges to draw, so a
 * large project stays readable. Defaults: only the required results' closure,
 * assets only (definitions as chips), no inactive nodes, and transitively
 * implied edges removed.
 */

export const MAX_VISIBLE = 150;

export type AttentionFilter = 'all' | 'attention' | GraphFlag | 'draft' | 'approved';

/** The graph's three views: one main result's tree, only what needs the researcher, or everything with filters. */
export type GraphMode = 'goal' | 'needs' | 'all';

export interface ViewOptions {
  /** Results as an ordered list of boxes, or as the graph. */
  display: 'list' | 'graph';
  /** Unset until the researcher picks one: "goal" while a main result is unfinished, else "all". */
  mode?: GraphMode;
  /** The main result the "goal" view shows; defaults to the one the loop's status points at. */
  goal?: string;
  scope: 'required' | 'all';
  showDefinitions: boolean;
  showInactive: boolean;
  search: string;
  filter: AttentionFilter;
  focus?: { id: string; depth: number };
  /** Only what one result rests on ("up") or what rests on it ("down"), in either display. */
  trace?: { id: string; direction: 'up' | 'down' };
}

export const DEFAULT_OPTIONS: ViewOptions = { display: 'list', scope: 'required', showDefinitions: false, showInactive: false, search: '', filter: 'all' };

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
    keep = reach(hits, adjacency(baseEdges.filter(isPrerequisiteEdge)).dependants);
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
  const kept = baseEdges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  // Only prerequisites are reduced: a serves or refutes edge never implies, nor is implied by, a dependency.
  const reduced = transitiveReduction(kept.filter(isPrerequisiteEdge));
  const overCap = !ignoreCap && nodes.length > MAX_VISIBLE;
  return { nodes: overCap ? [] : nodes, edges: overCap ? [] : [...reduced.edges, ...kept.filter((edge) => !isPrerequisiteEdge(edge))], reduced: reduced.removed, hidden: payload.nodes.length - nodes.length, overCap };
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
  const { deps, dependants } = adjacency(payload.edges.filter(isPrerequisiteEdge));
  const down = reach([id], dependants);
  const upstreamIds = new Set(deps.get(id) ?? []);
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  const downstream = [...down].filter((item) => item !== id).map((item) => byId.get(item)).filter((item): item is GraphNodeView => Boolean(item));
  const upstream = [...upstreamIds].map((item) => byId.get(item)).filter((item): item is GraphNodeView => Boolean(item));
  const keep = new Set([...down, ...upstreamIds]);
  const graphNodes = payload.nodes.filter((item) => keep.has(item.id));
  const graphEdges = transitiveReduction(payload.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to) && isPrerequisiteEdge(edge))).edges;
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

/** A finished branch folded into one chip under the result that rests on it. */
export interface FoldView { id: string; parent: string; members: string[]; title: string }

export interface FocusedGraph { nodes: GraphNodeView[]; edges: GraphEdgeView[]; folds: FoldView[] }

const PREREQUISITE = (edge: GraphEdgeView) => isPrerequisiteEdge(edge);

/**
 * "Still to do": everything `goal` rests on that is not finished, with
 * each fully finished branch folded into a chip under the result that uses it.
 */
export function goalGraph(payload: GraphPayload, goal: string): FocusedGraph {
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const { deps } = adjacency(payload.edges.filter(PREREQUISITE));
  const done = new Map<string, boolean>();
  const finished = (id: string, seen = new Set<string>()): boolean => {
    if (done.has(id)) return done.get(id)!;
    if (seen.has(id)) return false;
    seen.add(id);
    const value = byId.get(id)?.progress === 'done' && (deps.get(id) ?? []).every((dep) => finished(dep, seen));
    done.set(id, value);
    return value;
  };
  const nodes = new Map<string, GraphNodeView>();
  const folds: FoldView[] = [];
  const edges: GraphEdgeView[] = [];
  const visit = (id: string) => {
    if (nodes.has(id) || !byId.has(id)) return;
    nodes.set(id, byId.get(id)!);
    const prerequisites = (deps.get(id) ?? []).filter((dep) => byId.has(dep));
    const finishedOnes = prerequisites.filter((dep) => finished(dep));
    for (const dep of prerequisites.filter((item) => !finished(item))) { visit(dep); edges.push(payload.edges.find((edge) => edge.from === id && edge.to === dep && PREREQUISITE(edge))!); }
    if (finishedOnes.length) {
      const members = [...reach(finishedOnes, deps)].filter((member) => byId.has(member));
      const fold: FoldView = { id: `fold:${id}`, parent: id, members, title: byId.get(finishedOnes[0])!.title };
      folds.push(fold);
      edges.push({ from: id, to: fold.id, type: 'depends_on' });
    }
  };
  visit(goal);
  return { nodes: [...nodes.values()], edges, folds };
}

/** "What it rests on" / "What rests on it": the result and everything reachable from it in one direction, without folds. */
export function traceGraph(payload: GraphPayload, id: string, direction: 'up' | 'down'): FocusedGraph {
  const edges = payload.edges.filter(PREREQUISITE);
  const { deps, dependants } = adjacency(edges);
  const keep = reach([id], direction === 'up' ? deps : dependants);
  const nodes = payload.nodes.filter((node) => keep.has(node.id));
  return { nodes, edges: transitiveReduction(edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to))).edges, folds: [] };
}

/** "Held up": results that need the researcher or are stuck, and the main results they hold up. */
export function needsGraph(payload: GraphPayload): FocusedGraph {
  const edges = payload.edges.filter(PREREQUISITE);
  const { dependants } = adjacency(edges);
  const roots = payload.nodes.filter((node) => ['needs_you', 'stuck', 'stalled'].includes(node.progress)).map((node) => node.id);
  const keep = reach(roots, dependants);
  const nodes = payload.nodes.filter((node) => keep.has(node.id));
  return { nodes, edges: transitiveReduction(edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to))).edges, folds: [] };
}

/**
 * The color of what holds a result up: its own state when it needs the
 * researcher or is stuck, else that of its first unfinished prerequisite that
 * does. Undefined when nothing on its path is blocked.
 */
export function blockingStates(payload: GraphPayload): Map<string, 'stuck' | 'needs_you'> {
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const { deps } = adjacency(payload.edges.filter(PREREQUISITE));
  const result = new Map<string, 'stuck' | 'needs_you' | undefined>();
  const visit = (id: string): 'stuck' | 'needs_you' | undefined => {
    if (result.has(id)) return result.get(id);
    result.set(id, undefined);
    const progress = byId.get(id)?.progress;
    let value: 'stuck' | 'needs_you' | undefined;
    if (progress === 'stuck') value = 'stuck';
    else if (progress === 'needs_you' || progress === 'stalled') value = 'needs_you';
    else if (progress === 'waiting' || progress === 'inactive') {
      const found = (deps.get(id) ?? []).map(visit).filter(Boolean);
      value = found.includes('stuck') ? 'stuck' : found[0];
    }
    result.set(id, value);
    return value;
  };
  for (const node of payload.nodes) visit(node.id);
  return new Map([...result].filter((entry): entry is [string, 'stuck' | 'needs_you'] => entry[1] !== undefined));
}

/** The main result to show first: the one the loop's status points at, else the first not yet done. */
export function defaultGoal(payload: GraphPayload): string | undefined {
  const chainEnd = payload.health.chain[payload.health.chain.length - 1];
  if (chainEnd && payload.required.includes(chainEnd)) return chainEnd;
  const present = payload.required.filter((id) => payload.nodes.some((node) => node.id === id));
  return present.find((id) => payload.nodes.find((node) => node.id === id)?.progress !== 'done') ?? present[0];
}

/**
 * Everything that waits for the researcher, most urgent first: the Needs you
 * items, led by any reason the stopped loop gives that no item covers (a
 * missing definition, a dependency cycle).
 */
export function waitingItems(payload: GraphPayload): AttentionItem[] {
  const covered = new Set(payload.attention.map((item) => item.target).filter(Boolean));
  const extra = payload.health.key !== 'stopped' ? [] : payload.health.blockers
    .filter((blocker) => !blocker.target || !covered.has(blocker.target))
    .map((blocker, index): AttentionItem => ({
      key: `blocker:${index}:${blocker.target ?? blocker.title}`, priority: 0, category: 'loop', title: blocker.title, reason: blocker.detail,
      why: '', ifIgnored: 'The loop stays stopped.', target: blocker.target, blocks: [], sections: [], buttons: blocker.buttons,
    }));
  return [...extra, ...payload.attention];
}
