import { PROMOTION_TARGETS, toIdeaKind } from './nodeKinds';

/**
 * Where ideas were used, derived from the plans' `inspired_by`; never stored on
 * the idea, so using an idea for one result changes nothing about it and it
 * stays open for the next. Pure: shared by the dashboard, the context packs,
 * and the CLI.
 */

export interface PlanRef { id: string; target_asset?: string; status?: string; inspired_by?: readonly string[] }
export interface IdeaRef { id: string; title?: string; status?: string; idea_kind?: string }

export interface IdeaUse { plan: string; target: string; status: string }
export interface IdeaUsage {
  /** Every plan that lists the idea, in ID order. */
  uses: IdeaUse[];
  /** Distinct results those plans target, abandoned plans aside (they were never carried out). */
  targets: string[];
  /** Results a plan using the idea proved. */
  succeeded: string[];
}

export function ideaUsage(plans: readonly PlanRef[]): Map<string, IdeaUsage> {
  const usage = new Map<string, IdeaUsage>();
  for (const plan of [...plans].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!plan.target_asset) continue;
    for (const idea of plan.inspired_by ?? []) {
      const entry = usage.get(idea) ?? { uses: [], targets: [], succeeded: [] };
      const status = plan.status ?? 'pending';
      entry.uses.push({ plan: plan.id, target: plan.target_asset, status });
      if (status !== 'abandoned' && !entry.targets.includes(plan.target_asset)) entry.targets.push(plan.target_asset);
      if (status === 'succeeded' && !entry.succeeded.includes(plan.target_asset)) entry.succeeded.push(plan.target_asset);
      usage.set(idea, entry);
    }
  }
  return usage;
}

/** One line for a pack or a listing: "used for a (succeeded), b (failed)". Empty when unused. */
export function usageLine(usage: IdeaUsage | undefined): string {
  if (!usage?.uses.length) return '';
  const byTarget = new Map<string, string[]>();
  for (const use of usage.uses) byTarget.set(use.target, [...(byTarget.get(use.target) ?? []), use.status]);
  return `used for ${[...byTarget].map(([target, statuses]) => `${target} (${[...new Set(statuses)].join(', ')})`).join(', ')}`;
}

export interface TriedRecord { target: string; round?: number; slot?: number; statement_digest?: string; outcome?: string }

/** A test case's search records, one per result it was tried for; reads the single record schema 3 wrote. */
export function triedRecords(data: Record<string, unknown>): TriedRecord[] {
  const raw = data.tried_in;
  const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return items.filter((item): item is TriedRecord => Boolean(item) && typeof item === 'object' && typeof (item as Record<string, unknown>).target === 'string');
}

export interface PromotionCandidate { id: string; title: string; targets: string[] }

/**
 * Open observations plans for several results rely on: each should become a
 * lemma those results depend on, so a proof never rests on an unproved idea.
 */
export function promotionCandidates(ideas: readonly IdeaRef[], usage: Map<string, IdeaUsage>): PromotionCandidate[] {
  return ideas
    .filter((idea) => toIdeaKind(idea.idea_kind) === 'observation' && (idea.status ?? 'draft') === 'draft' && (usage.get(idea.id)?.targets.length ?? 0) >= PROMOTION_TARGETS)
    .map((idea) => ({ id: idea.id, title: idea.title || idea.id, targets: usage.get(idea.id)!.targets }))
    .sort((a, b) => b.targets.length - a.targets.length || a.id.localeCompare(b.id));
}
