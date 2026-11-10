import { normalizeProse, sha, statementDigest } from './digests';
import { ROUTE_ORIGINS, RouteOrigin, isRoutePlan, routeLemmas } from './routeSchema';
import { hasSectionContent, sectionContent } from './sections';

export { ROUTE_ORIGINS, isRoutePlan, routeLemmas, routePlanProblems } from './routeSchema';
export type { RouteOrigin } from './routeSchema';

/**
 * Parallel proof routes. A route is a plan with `route_lemmas`: it proves its target from those
 * lemmas (and the target's own depends_on) by a reduction written under `## Reduction` in the plan,
 * not in the asset, so several routes to one result can be worked on side by side. A result is an OR
 * node (any one route proves it), a route an AND node (its reduction and every lemma). When one
 * route is complete the loop commits it: the reduction becomes the result's proof and the lemmas
 * join its depends_on; the other routes are superseded. Pure: shared by the loop core, the CLI, the
 * graph view model, and the tests.
 */

/** `frozen`: alive but beyond the number of routes the researcher lets run at once. */
export type RouteState = 'live' | 'reduced' | 'suspended' | 'dead' | 'failed' | 'won' | 'superseded' | 'abandoned' | 'frozen';
export type ReductionState = 'none' | 'written' | 'verified' | 'failed';

export interface RoutePlanInput { id: string; data: Record<string, any>; content: string }

/** What the loop knows of one lemma of a route. */
export interface RouteLemmaStatus {
  /** Approved (or a library or cited result accepted): the route may rely on it. */
  settled: boolean;
  /** A confirmed counterexample refutes it. */
  refuted?: boolean;
  /** Deprecated, archived, or missing. */
  inactive?: boolean;
  /** Set aside; the route waits until it comes back. */
  parked?: boolean;
}

export interface RouteDeath { kind: 'refuted' | 'inactive' | 'cycle'; lemma: string }

export interface RouteInfo {
  planId: string;
  target: string;
  title: string;
  origin: RouteOrigin;
  forkedFrom?: string;
  lemmas: string[];
  state: RouteState;
  reduction: ReductionState;
  settledLemmas: number;
  /** Why the route is dead, or which lemmas hold it while suspended. */
  death?: RouteDeath;
  suspendedBy?: string[];
  supersededBy?: string;
}

/** Digest of a route's `## Reduction`, stamped by the loop when the reduction is reported and when it is verified. */
export function reductionDigest(content: string): string {
  return sha(normalizeProse(sectionContent(content, 'Reduction')));
}

export function reductionState(plan: RoutePlanInput): ReductionState {
  if (plan.data.status === 'failed') return 'failed';
  const written = typeof plan.data.reduction_digest === 'string' && hasSectionContent(plan.content, 'Reduction');
  if (!written) return 'none';
  const current = reductionDigest(plan.content);
  if (plan.data.reduction_digest !== current) return 'none';
  return plan.data.reduction_verified_digest === current ? 'verified' : 'written';
}

/** The route a plan describes, with its state derived from the plan and its lemmas. */
export function routeInfo(plan: RoutePlanInput, lemma: (id: string) => RouteLemmaStatus): RouteInfo {
  const lemmas = routeLemmas(plan.data);
  const statuses = lemmas.map((id) => [id, lemma(id)] as const);
  const reduction = reductionState(plan);
  const info: RouteInfo = {
    planId: plan.id,
    target: String(plan.data.target_asset ?? ''),
    title: typeof plan.data.route_title === 'string' && plan.data.route_title.trim() ? plan.data.route_title.trim() : plan.id,
    origin: (ROUTE_ORIGINS as readonly string[]).includes(plan.data.origin) ? plan.data.origin : 'agent',
    ...(typeof plan.data.forked_from === 'string' ? { forkedFrom: plan.data.forked_from } : {}),
    lemmas,
    state: 'live',
    reduction,
    settledLemmas: statuses.filter(([, status]) => status.settled).length,
  };
  switch (plan.data.status) {
    case 'succeeded': return { ...info, state: 'won' };
    case 'superseded': return { ...info, state: 'superseded', ...(typeof plan.data.superseded_by === 'string' ? { supersededBy: plan.data.superseded_by } : {}) };
    case 'abandoned': return { ...info, state: 'abandoned' };
    case 'failed': return { ...info, state: 'failed' };
  }
  const refuted = statuses.find(([, status]) => status.refuted);
  if (refuted) return { ...info, state: 'dead', death: { kind: 'refuted', lemma: refuted[0] } };
  const inactive = statuses.find(([, status]) => status.inactive);
  if (inactive) return { ...info, state: 'dead', death: { kind: 'inactive', lemma: inactive[0] } };
  const parked = statuses.filter(([, status]) => status.parked && !status.settled).map(([id]) => id);
  if (parked.length) return { ...info, state: 'suspended', suspendedBy: parked };
  return { ...info, state: reduction === 'verified' ? 'reduced' : 'live' };
}

/** Routes still being worked on (not frozen, suspended, dead, or finished). */
export const isActiveRoute = (route: RouteInfo) => route.state === 'live' || route.state === 'reduced';
/** Routes that may still prove their target, now or once a lemma comes back. */
export const isOpenRoute = (route: RouteInfo) => isActiveRoute(route) || route.state === 'suspended' || route.state === 'frozen';

/**
 * Keep at most `maxLive` routes per target active: the cheapest stay, the rest are frozen until one
 * of them dies. Researcher routes win ties, then the order given (oldest first).
 */
export function applyBeam(routes: RouteInfo[], maxLive: number, cost: (route: RouteInfo) => number): RouteInfo[] {
  const byTarget = new Map<string, RouteInfo[]>();
  for (const route of routes) byTarget.set(route.target, [...(byTarget.get(route.target) ?? []), route]);
  const frozen = new Set<string>();
  for (const group of byTarget.values()) {
    const active = group.filter(isActiveRoute);
    if (active.length <= maxLive) continue;
    const ranked = rankRoutes(active, cost);
    for (const route of ranked.slice(Math.max(1, maxLive))) frozen.add(route.planId);
  }
  return routes.map((route) => frozen.has(route.planId) ? { ...route, state: 'frozen' } : route);
}

function rankRoutes(routes: RouteInfo[], cost: (route: RouteInfo) => number): RouteInfo[] {
  return routes.map((route, index) => ({ route, index, cost: cost(route) }))
    .sort((a, b) => a.cost - b.cost || Number(b.route.origin === 'researcher') - Number(a.route.origin === 'researcher') || a.index - b.index)
    .map((entry) => entry.route);
}

// ---------- proof numbers ----------

/** The AND-OR graph the scheduler reads. */
export interface ProofGraph {
  settled(id: string): boolean;
  /** Refuted, deprecated, archived, or missing: nothing can prove it here. */
  dead(id: string): boolean;
  /** Unsettled depends_on of a result: every route needs them. */
  deps(id: string): string[];
  /** Every route to the result, whatever its state. */
  routes(id: string): RouteInfo[];
  /** Estimated work for a result with no active route (its classic plans, or a new round of routes). */
  leafCost(id: string): number;
}

/**
 * Proof numbers: how much is still to prove. A settled result costs 0, a dead one Infinity; an open
 * result costs its unsettled depends_on plus its cheapest active route, or its leaf cost when it has
 * none. A route costs 1 for an unverified reduction plus its lemmas. A cycle makes the branch that
 * closes it Infinity, so a route that would rest on its own target is never chosen.
 */
export class ProofNumbers {
  private memo = new Map<string, number>();
  constructor(private readonly graph: ProofGraph) {}

  ofAsset(id: string, visiting: Set<string> = new Set()): number {
    if (this.graph.settled(id)) return 0;
    if (this.graph.dead(id)) return Infinity;
    if (visiting.has(id)) return Infinity;
    const cached = this.memo.get(id);
    if (cached !== undefined) return cached;
    visiting.add(id);
    let cycle = false;
    const guard = (value: number) => { if (value === Infinity) cycle = true; return value; };
    let total = 0;
    for (const dep of this.graph.deps(id)) total += guard(this.ofAsset(dep, visiting));
    const active = this.graph.routes(id).filter(isActiveRoute);
    total += active.length ? Math.min(...active.map((route) => guard(this.ofRoute(route, visiting)))) : this.graph.leafCost(id);
    visiting.delete(id);
    // A value that met a cycle depends on the path that reached it: do not reuse it elsewhere.
    if (!cycle) this.memo.set(id, total);
    return total;
  }

  ofRoute(route: RouteInfo, visiting: Set<string> = new Set()): number {
    if (!isActiveRoute(route)) return Infinity;
    let total = route.reduction === 'verified' ? 0 : 1;
    for (const lemma of route.lemmas) total += this.ofAsset(lemma, visiting);
    return total;
  }
}

/** What the scheduler hands the loop next. */
export type RouteStep =
  | { kind: 'reduce'; planId: string; target: string }
  | { kind: 'verify_reduction'; planId: string; target: string }
  | { kind: 'commit'; planId: string; target: string }
  | { kind: 'asset'; id: string };

/**
 * The most-proving step toward `goal`: descend through the result's unsettled depends_on first (as
 * the loop always has), then its cheapest active route; in a route, its reduction first (the cheapest
 * way to rule a route out), then its lemmas, the ones most routes share first. A route whose
 * reduction is verified and whose lemmas are all settled is ready to commit. `actionable` lets the
 * loop skip results it cannot work on now (waiting on approval, parked, and so on).
 */
export function mostProvingStep(goal: string, graph: ProofGraph, actionable: (id: string) => boolean, blocked: (step: RouteStep) => boolean = () => false): RouteStep | undefined {
  const numbers = new ProofNumbers(graph);
  const share = new Map<string, number>();
  const seen = new Set<string>();
  const countShares = (id: string) => {
    if (seen.has(id)) return; seen.add(id);
    for (const dep of graph.deps(id)) countShares(dep);
    for (const route of graph.routes(id).filter(isActiveRoute)) for (const lemma of route.lemmas) { share.set(lemma, (share.get(lemma) ?? 0) + 1); countShares(lemma); }
  };
  countShares(goal);
  const visited = new Set<string>();
  const descend = (id: string, path: Set<string>): RouteStep | undefined => {
    if (graph.settled(id) || graph.dead(id) || path.has(id) || visited.has(id)) return undefined;
    visited.add(id);
    const inner = new Set(path).add(id);
    const deps = graph.deps(id).filter((dep) => !graph.settled(dep)).sort((a, b) => numbers.ofAsset(a) - numbers.ofAsset(b));
    for (const dep of deps) { const step = descend(dep, inner); if (step) return step; }
    if (deps.length) return undefined;
    const routes = graph.routes(id).filter(isActiveRoute);
    if (!routes.length) return actionable(id) ? { kind: 'asset', id } : undefined;
    for (const route of rankRoutes(routes, (candidate) => numbers.ofRoute(candidate))) {
      if (numbers.ofRoute(route) === Infinity) continue;
      if (route.reduction !== 'verified') {
        const step: RouteStep = { kind: route.reduction === 'written' ? 'verify_reduction' : 'reduce', planId: route.planId, target: id };
        // Another worker has the reduction (a batch): this route's lemmas may go on meanwhile.
        if (!blocked(step)) return step;
      }
      const open = route.lemmas.filter((lemma) => !graph.settled(lemma))
        .sort((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0) || numbers.ofAsset(a) - numbers.ofAsset(b));
      if (!open.length) { if (route.reduction === 'verified') return { kind: 'commit', planId: route.planId, target: id }; continue; }
      for (const lemma of open) { const step = descend(lemma, inner); if (step) return step; }
    }
    return undefined;
  };
  return descend(goal, new Set());
}

// ---------- the route map the researcher reviews ----------

type LemmaRaw = (id: string) => string | undefined;

/** Digest of one route as the researcher reviews it: its lemmas, its `## Route`, and each lemma's statement (not its reduction). */
export function routeDigest(route: RoutePlanInput, lemmaRaw: LemmaRaw): string {
  const lemmas = [...routeLemmas(route.data)].sort();
  return sha([route.id, lemmas.join(','), normalizeProse(sectionContent(route.content, 'Route')), ...lemmas.map((id) => { const raw = lemmaRaw(id); return `${id}:${raw ? statementDigest(raw) : 'missing'}`; })].join('\n'));
}

const openRoutes = (routes: RoutePlanInput[]) => routes.filter((route) => isRoutePlan(route.data) && route.data.status === 'pending');

/**
 * Digest of a result's route map: its statement and each open route's digest. A new route, a dropped
 * one, or a changed lemma statement changes it; it names the version a review request is about.
 */
export function routeMapDigest(goalRaw: string, routes: RoutePlanInput[], lemmaRaw: LemmaRaw): string {
  return sha([statementDigest(goalRaw), ...openRoutes(routes).map((route) => routeDigest(route, lemmaRaw)).sort()].join('\n---\n'));
}

/** Per-route digests of a route map, as an approval records them. */
export function routeMapEntries(routes: RoutePlanInput[], lemmaRaw: LemmaRaw): Record<string, string> {
  return Object.fromEntries(openRoutes(routes).map((route) => [route.id, routeDigest(route, lemmaRaw)]));
}

/**
 * Whether an approved map still covers the open routes: the result's statement is the one approved,
 * and every open route was in the map as it stands. A route that failed or was dropped since leaves
 * the map without a new review; a new route or a changed lemma statement needs one.
 */
export function routeMapCovered(approved: { statement?: string; routes: Record<string, string> }, goalRaw: string, routes: RoutePlanInput[], lemmaRaw: LemmaRaw): boolean {
  if (approved.statement !== statementDigest(goalRaw)) return false;
  return openRoutes(routes).every((route) => approved.routes[route.id] === routeDigest(route, lemmaRaw));
}

// ---------- rounds of routes ----------

/** Directions for the agent's slots in a round of routes, taken in turn so later rounds try new ones. */
export const ROUTE_DIRECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'adapt', label: 'Adapt the proof of the closest known result (a library analogue) to this setting' },
  { id: 'intermediate', label: 'Through an intermediate estimate, invariant, or structure result, stated as a lemma' },
  { id: 'direct', label: 'A direct argument from the definitions and the dependencies' },
  { id: 'contradiction', label: 'By contradiction or compactness: assume it fails and extract a limiting object' },
  { id: 'special_case', label: 'Prove a special or model case first, then reduce the general case to it' },
  { id: 'forward', label: 'Forward from results already proved in the project: what they give toward the target' },
];

/**
 * The researcher's answer to "do you have routes in mind?", one route per entry: separated by new
 * lines, semicolons, or numbering ("1) ... 2) ..."). An answer that only says no gives none.
 */
export function splitRoutes(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || /^(no|none|nothing|nope|n\/a|没有|无)[.!。]?$/i.test(trimmed)) return [];
  return trimmed
    .split(/\n+|;|；|(?:^|\s)(?=\(?\d+[).]\s)/)
    .map((part) => part.replace(/^\s*\(?\d+[).]\s*/, '').replace(/^[-*•]\s*/, '').trim())
    .filter((part) => part.length > 2);
}
