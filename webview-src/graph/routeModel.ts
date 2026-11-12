import type { GraphEdgeView, GraphNodeView, GraphPayload, RouteView } from '../../src/models/graph';

/**
 * The routes to a result as the Routes view reads them, kept free of React so tests can load it:
 * which routes are open, the order a route's lemmas are drawn in, and for each route the one place
 * that holds it (its blocker) or, when nothing does, where it goes next.
 */

const OPEN_STATES = new Set<RouteView['state']>(['live', 'reduced', 'suspended', 'frozen']);
export const isOpen = (route: RouteView) => OPEN_STATES.has(route.state);
/** Drawn joined to the result: the routes that may still prove it, and the one that did. */
export const isConnected = (route: RouteView) => isOpen(route) || route.state === 'won';

/** The routes to a result, open ones first (the most promising first), then the rest. */
export function routesTo(payload: GraphPayload, target: string): RouteView[] {
  const rank = (route: RouteView) => (isOpen(route) ? 0 : route.state === 'won' ? 1 : 2);
  return (payload.routes ?? []).filter((route) => route.target === target)
    .sort((a, b) => rank(a) - rank(b) || (a.left ?? Infinity) - (b.left ?? Infinity) || (a.round ?? 0) - (b.round ?? 0));
}

/** Lemmas that two or more of the given routes need. */
export function sharedLemmas(routes: RouteView[]): Set<string> {
  const count = new Map<string, number>();
  for (const route of routes) for (const lemma of route.lemmas) count.set(lemma, (count.get(lemma) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
}

/** What every route to the result needs besides its own lemmas: the result's own depends_on. */
export function commonDeps(target: string, edges: GraphEdgeView[]): string[] {
  return [...new Set(edges.filter((edge) => edge.from === target && edge.type === 'depends_on').map((edge) => edge.to))];
}

const settled = (node: GraphNodeView | undefined) => node?.progress === 'done';

/**
 * A route's lemmas top to bottom: a lemma another one of them depends on goes above it; otherwise
 * settled lemmas first, then the order the route lists them.
 */
export function orderLemmas(route: RouteView, edges: GraphEdgeView[], byId: Map<string, GraphNodeView>): string[] {
  const members = new Set(route.lemmas);
  const before = new Map(route.lemmas.map((id) => [id, new Set<string>()]));
  for (const edge of edges) if (edge.type === 'depends_on' && members.has(edge.from) && members.has(edge.to) && edge.from !== edge.to) before.get(edge.from)!.add(edge.to);
  const rank = (id: string) => (settled(byId.get(id)) ? 0 : 1) * route.lemmas.length + route.lemmas.indexOf(id);
  const placed: string[] = [];
  const left = new Set(route.lemmas);
  while (left.size) {
    const ready = [...left].filter((id) => [...before.get(id)!].every((dep) => !left.has(dep)));
    // A cycle among them: take the best-ranked one anyway.
    const next = (ready.length ? ready : [...left]).reduce((a, b) => (rank(a) <= rank(b) ? a : b));
    placed.push(next);
    left.delete(next);
  }
  return placed;
}

/**
 * Blockers stop a route (dead, stuck, needs you) or hold it (waiting); `closed` routes were set aside
 * by someone; `won` proved the result; `next` is where an unblocked route goes next.
 */
export type RoutePointKind = 'dead' | 'stuck' | 'needs_you' | 'waiting' | 'closed' | 'won' | 'next';

export interface RoutePoint {
  kind: RoutePointKind;
  /** A lemma ID, 'reduction' (the step from the lemmas to the result), or 'route' (the route as a whole). */
  at: string;
  /** A word or two for the tag on the card. */
  tag: string;
  /** One sentence on what holds the route, or what comes next. */
  label: string;
  /** Other lemmas that hold the same route. */
  more: number;
}

export const BLOCKER_KINDS = new Set<RoutePointKind>(['dead', 'stuck', 'needs_you', 'waiting']);
export const isBlocker = (point: RoutePoint) => BLOCKER_KINDS.has(point.kind);
const SEVERITY: Record<RoutePointKind, number> = { dead: 0, stuck: 1, needs_you: 2, waiting: 3, closed: 4, next: 5, won: 6 };

interface Hold { at: string; kind: 'stuck' | 'needs_you'; tag: string; label: string }

/** The lemmas holding an open route: set aside, waiting for the researcher, or stuck. */
function holdsOf(route: RouteView, order: string[], byId: Map<string, GraphNodeView>): Hold[] {
  const holds: Hold[] = [];
  const aside = new Set(route.suspendedBy ?? []);
  for (const id of order) {
    const node = byId.get(id);
    if (settled(node)) continue;
    if (aside.has(id)) holds.push({ at: id, kind: 'needs_you', tag: 'Set aside', label: 'Set aside: bring it back, or drop the route' });
    else if (node?.progress === 'needs_you') holds.push({ at: id, kind: 'needs_you', tag: 'Needs you', label: node.progressDetail || 'Waits for you' });
    else if (node?.progress === 'stuck') holds.push({ at: id, kind: 'stuck', tag: 'Stuck', label: node.progressDetail || 'The agent is stuck on it' });
    else if (node?.progress === 'stalled') holds.push({ at: id, kind: 'needs_you', tag: 'Agent stopped', label: node.progressDetail || 'The agent stopped on it' });
  }
  return holds;
}

const DEATH: Record<NonNullable<RouteView['death']>['kind'], { tag: string; label: string }> = {
  refuted: { tag: 'Counterexample', label: 'Has a counterexample: the route cannot work' },
  inactive: { tag: 'Retired', label: 'Retired or missing: the route cannot use it' },
  cycle: { tag: 'Circular', label: 'Would make the proof circular' },
};

/** The one place that holds a route, or where it goes next. `order` is the drawn order of its lemmas. */
export function routePoint(route: RouteView, byId: Map<string, GraphNodeView>, options: { order?: string[]; routes?: RouteView[]; loopAsset?: string } = {}): RoutePoint {
  const order = options.order ?? route.lemmas;
  switch (route.state) {
    case 'won': return { kind: 'won', at: 'route', tag: 'Proved', label: 'Proved the result', more: 0 };
    case 'superseded': {
      const winner = options.routes?.find((item) => item.planId === route.supersededBy);
      return { kind: 'closed', at: 'route', tag: 'Set aside', label: `Set aside: ${winner ? winner.title : 'another route'} won`, more: 0 };
    }
    case 'abandoned': return { kind: 'closed', at: 'route', tag: 'Dropped', label: route.closedReason ? `Dropped: ${route.closedReason}` : 'Dropped', more: 0 };
    case 'failed': return { kind: 'dead', at: 'route', tag: 'Failed', label: route.closedReason ? `Failed: ${route.closedReason}` : 'Failed', more: 0 };
    case 'dead': {
      if (!route.death) return { kind: 'dead', at: 'route', tag: 'Ruled out', label: 'Ruled out', more: 0 };
      return { kind: 'dead', at: route.death.lemma, ...DEATH[route.death.kind], more: 0 };
    }
  }
  const holds = holdsOf(route, order, byId);
  if (route.state === 'frozen') return { kind: 'waiting', at: 'route', tag: 'Waits its turn', label: 'Waits its turn: cheaper routes go first', more: holds.length };
  const worst = [...holds].sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind])[0];
  if (worst) return { kind: worst.kind, at: worst.at, tag: worst.tag, label: worst.label, more: holds.length - 1 };
  if (route.state === 'suspended') return { kind: 'needs_you', at: 'route', tag: 'Set aside', label: 'Waits on a set-aside lemma', more: 0 };
  // Not held: the loop writes and checks the step from the lemmas first, then works on the lemmas.
  const open = order.filter((id) => !settled(byId.get(id)));
  if (options.loopAsset && open.includes(options.loopAsset)) return { kind: 'next', at: options.loopAsset, tag: 'Agent on it', label: 'The agent is working on it now', more: 0 };
  if (route.reduction === 'none') return { kind: 'next', at: 'reduction', tag: 'Next', label: 'Next: write the step from the lemmas to the result', more: 0 };
  if (route.reduction === 'written') return { kind: 'next', at: 'reduction', tag: 'Next', label: 'Next: check the step from the lemmas to the result', more: 0 };
  if (open.length) return { kind: 'next', at: open[0], tag: 'Next', label: 'Next lemma to prove', more: 0 };
  return { kind: 'next', at: 'reduction', tag: 'Complete', label: 'Complete: ready to prove the result', more: 0 };
}

/** One thing holding up a result: a lemma and the open routes it holds. */
export interface ResultBlocker {
  id: string;
  kind: 'dead' | 'stuck' | 'needs_you';
  tag: string;
  label: string;
  /** The open routes it holds (plan IDs). */
  routes: string[];
  /** One of the result's own prerequisites: it holds every route. */
  common: boolean;
}

/**
 * What holds a result up, the worst first and then the one holding the most routes: the lemmas
 * holding its open routes, and its own prerequisites that wait for the researcher or are stuck.
 */
export function resultBlockers(target: string, payload: GraphPayload, byId: Map<string, GraphNodeView>): ResultBlocker[] {
  const open = routesTo(payload, target).filter(isOpen);
  if (!open.length) return [];
  const found = new Map<string, ResultBlocker>();
  for (const id of commonDeps(target, payload.edges)) {
    const node = byId.get(id);
    if (settled(node) || !node || !['needs_you', 'stuck', 'stalled'].includes(node.progress)) continue;
    const stuck = node.progress === 'stuck';
    found.set(id, { id, kind: stuck ? 'stuck' : 'needs_you', tag: stuck ? 'Stuck' : node.progress === 'stalled' ? 'Agent stopped' : 'Needs you', label: node.progressDetail || node.progressLabel, routes: open.map((route) => route.planId), common: true });
  }
  for (const route of open) {
    for (const hold of holdsOf(route, route.lemmas, byId)) {
      const entry = found.get(hold.at) ?? { id: hold.at, kind: hold.kind, tag: hold.tag, label: hold.label, routes: [], common: false };
      if (!entry.routes.includes(route.planId)) entry.routes.push(route.planId);
      found.set(hold.at, entry);
    }
  }
  return [...found.values()].sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || b.routes.length - a.routes.length);
}
