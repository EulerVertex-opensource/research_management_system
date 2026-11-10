import { hasSectionContent } from './sections';

/**
 * The schema of a route plan (see routes.ts). Kept apart from routes.ts, which needs node's crypto
 * for its digests, because the schema reaches the webview through domain/schema.ts.
 */

export const ROUTE_ORIGINS = ['researcher', 'agent', 'fork'] as const;
export type RouteOrigin = (typeof ROUTE_ORIGINS)[number];

/** One worker of a round of routes: the direction it plans in, and whose it is. */
export interface RouteSlot { slot: number; direction: string; label: string; origin: RouteOrigin; ideaId?: string }
/**
 * A round of routes to one result in progress (stages route, route_merge, review_routes). `asked`:
 * the researcher was asked for routes of their own this round (or need not be: autonomous, a fork).
 */
export interface RouteRound { target: string; round: number; slots: RouteSlot[]; fork?: string; asked?: boolean }

/** A plan is a route when it carries `route_lemmas`, even an empty list (a route that proves its target directly). */
export function isRoutePlan(data: Record<string, any> | undefined): boolean {
  return Boolean(data) && data!.type === 'plan' && Array.isArray(data!.route_lemmas);
}

export function routeLemmas(data: Record<string, any>): string[] {
  return Array.isArray(data.route_lemmas) ? data.route_lemmas.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0) : [];
}

/**
 * Schema problems particular to a route plan (the common plan checks still apply). Also catches a
 * non-route plan marked `superseded`, which only a committed route can make.
 */
export function routePlanProblems(id: string, data: Record<string, any>, content: string): string[] {
  if (!isRoutePlan(data)) return data.status === 'superseded' ? [`${id}: only a route (a plan with route_lemmas) can be superseded.`] : [];
  const problems: string[] = [];
  const raw = data.route_lemmas as unknown[];
  if (!raw.every((item) => typeof item === 'string' && item.trim())) problems.push(`${id}: route_lemmas must be a list of asset IDs.`);
  const lemmas = routeLemmas(data);
  if (new Set(lemmas).size !== lemmas.length) problems.push(`${id}: route_lemmas lists a lemma twice.`);
  if (typeof data.target_asset === 'string' && lemmas.includes(data.target_asset)) problems.push(`${id}: a route cannot use its own target ${data.target_asset} as a lemma.`);
  if (typeof data.route_title !== 'string' || !data.route_title.trim()) problems.push(`${id}: a route needs route_title, a short name for the researcher (e.g. "via energy decay").`);
  if (!(ROUTE_ORIGINS as readonly unknown[]).includes(data.origin)) problems.push(`${id}: a route needs origin ${ROUTE_ORIGINS.join('|')}.`);
  if (data.origin === 'fork') {
    if (typeof data.forked_from !== 'string' || !data.forked_from) problems.push(`${id}: a forked route names the result it starts from in forked_from.`);
    else if (!lemmas.includes(data.forked_from)) problems.push(`${id}: a forked route uses the result it starts from: list ${data.forked_from} in route_lemmas.`);
  } else if (data.forked_from !== undefined) problems.push(`${id}: forked_from belongs to a route with origin fork.`);
  if (data.status === 'superseded' && (typeof data.superseded_by !== 'string' || !data.superseded_by)) problems.push(`${id}: a superseded route names the route that won in superseded_by.`);
  if ((data.status === 'pending' || data.status === 'failed') && !hasSectionContent(content, 'Route')) problems.push(`${id}: a route needs ## Route: one line per lemma, saying what it gives the reduction.`);
  if (data.reduction_digest !== undefined && !hasSectionContent(content, 'Reduction')) problems.push(`${id}: reduction_digest without a ## Reduction.`);
  return problems;
}
