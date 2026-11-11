import type { LoopState } from '../services/ResearchLoopModel';
import type { DecisionInfo } from '../services/ResearchRecords';
import type { ResearchNode } from '../models/types';
import type { GraphNodeView, IntakeView, RepairNodeView, RepairState } from '../models/graph';
import { normalizeProse, sha } from './digests';
import { sectionContent, stripManagedBlocks } from './sections';
import { CONJECTURE_TYPE, INACTIVE_STATUSES, PROVABLE_TYPES } from './nodeKinds';

/**
 * The researcher's own results on the dashboard (Results → Repair): each intake
 * (`start --intake`), and where each of its results stands in the repair, derived
 * from the shared records (intake, proof_check, repair_request decisions, repair
 * plans) and the loop state. Never stored, so it cannot drift from the files.
 */

const TEXT_LIMIT = 8000;
const clip = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);
const proofOf = (body: string) => stripManagedBlocks(sectionContent(body, 'Proof')).trim();
const digestOf = (body: string) => sha(normalizeProse(sectionContent(body, 'Proof')));

/** Every intake, newest first, with how it closed and the next goals it offered. */
export function intakeViews(decisions: DecisionInfo[], nodes: ResearchNode[]): IntakeView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const closes = new Map(decisions.filter((item) => item.kind === 'intake_closed').map((item) => [item.target, item]));
  return decisions.filter((item) => item.kind === 'intake' && item.ids?.length)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item): IntakeView => {
      const close = closes.get(item.id);
      return {
        id: item.id, at: item.createdAt, ids: item.ids!, main: item.main ?? [], ...(item.source ? { source: item.source } : {}),
        ...(close ? { closed: {
          at: close.createdAt, summary: close.text === '(no text)' ? '' : close.text, required: close.ids ?? [],
          candidates: (close.candidates ?? []).filter((id) => byId.has(id)).map((id) => {
            const node = byId.get(id)!;
            return { id, title: node.title || id, kind: node.type === 'idea' ? 'idea' as const : 'conjecture' as const, open: node.type === 'idea' ? node.status === 'draft' : node.type === CONJECTURE_TYPE };
          }),
        } } : {}),
      };
    });
}

export interface RepairInput {
  intakes: IntakeView[];
  decisions: DecisionInfo[];
  nodes: ResearchNode[];
  graph: Map<string, GraphNodeView>;
  state?: LoopState;
}

/** Where each result of an intake stands; a result in several intakes is shown in the newest. */
export function repairViews(input: RepairInput): Map<string, RepairNodeView> {
  const { state } = input;
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const plans = input.nodes.filter((node) => node.type === 'plan');
  const consent = new Set(input.decisions.filter((item) => item.kind === 'repair_request').map((item) => item.target));
  const checks = [...input.decisions].filter((item) => item.kind === 'proof_check').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const running = state?.status === 'running';
  const activeStage = (id: string): string | undefined => {
    if (!state || !running) return undefined;
    if (state.stage === 'batch') return state.current.batch?.items.find((item) => !item.done && item.assetId === id)?.stage;
    return state.current.assetId === id ? state.stage : undefined;
  };
  const queued = (id: string) => Boolean(state?.approvalQueue.some((item) => item.target === id && (item.kind === 'asset' || item.kind === 'citation')));
  const views = new Map<string, RepairNodeView>();
  for (const intake of input.intakes) {
    for (const id of intake.ids) {
      if (views.has(id)) continue;
      const node = byId.get(id);
      const view = input.graph.get(id);
      if (!node || !view || node.type === 'definition' || !PROVABLE_TYPES.has(node.type)) continue;
      const mine = plans.filter((plan) => (plan as unknown as Record<string, unknown>).target_asset === id);
      const repairs = mine.filter((plan) => (plan as unknown as Record<string, unknown>).purpose === 'repair');
      const failed = repairs.filter((plan) => plan.status === 'failed' || plan.status === 'abandoned').length;
      const base = { intake: intake.id, failed };
      const set = (state: RepairState, extra: Partial<RepairNodeView> = {}) => views.set(id, { ...base, state, ...extra });
      if (INACTIVE_STATUSES.has(node.status ?? '')) { set('retired'); continue; }
      const proof = proofOf(node.body);
      const digest = digestOf(node.body);
      const vouching = mine.filter((plan) => plan.status === 'succeeded' && (plan as unknown as Record<string, unknown>).proof_digest === digest);
      const repaired = vouching.find((plan) => (plan as unknown as Record<string, unknown>).purpose === 'repair');
      const diff = repaired ? { plan: repaired.id, previous: clip(sectionContent(repaired.body, 'Previous proof').trim()), proof: clip(proof), gap: sectionContent(repaired.body, 'Gap').trim() || undefined } : {};
      if (view.progress === 'done') { set('done', { how: repaired ? 'repaired' : vouching.length ? 'proved' : 'sound', ...diff }); continue; }
      const parked = state?.parked[id];
      if (parked) { set('stuck', { ...(parked.note ? { note: parked.note } : {}), ...diff }); continue; }
      const stage = activeStage(id);
      if (!proof) { set('to_prove', stage ? { active: true } : {}); continue; }
      const verdict = checks.filter((item) => item.target === id && item.digest === digest).pop();
      const pending = repairs.find((plan) => plan.status === 'pending');
      const gapOf = (plan?: ResearchNode) => (plan && sectionContent(plan.body, 'Gap').trim()) || verdict?.text.trim() || undefined;
      if (repaired) {
        const verified = (repaired as unknown as Record<string, unknown>).verified_proof_digest === digest;
        if (verified || queued(id)) set('review', { how: 'repaired', ...diff });
        else set('repairing', { ...diff, ...(stage ? { active: true } : {}), note: 'Repaired; its check is next' });
        continue;
      }
      if (pending || (stage && (stage === 'plan' || stage === 'execute') && consent.has(id) && verdict?.reason === 'rejected')) {
        set('repairing', { ...(pending ? { plan: pending.id } : {}), gap: gapOf(pending), ...(stage ? { active: true } : {}) });
        continue;
      }
      if (stage === 'verify_node') { set('checking', { active: true }); continue; }
      if (verdict?.reason === 'rejected') { set(consent.has(id) ? 'needs_repair' : 'gap', { gap: verdict.text.trim() }); continue; }
      if (verdict?.reason === 'confirmed' || queued(id)) { set('review', { how: 'sound' }); continue; }
      set('unchecked');
    }
  }
  return views;
}

/** The required results added since an intake closed: a new goal, which retires its hand-off card. */
export function goalsSince(required: string[], closedRequired: string[]): string[] {
  return required.filter((id) => !closedRequired.includes(id));
}

