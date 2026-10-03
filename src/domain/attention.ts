import type { LoopState } from '../services/ResearchLoopModel';
import type { AttentionButton, AttentionItem, AttentionPriority, GraphNodeView, SectionView } from '../models/graph';

/**
 * The researcher's attention queue, derived from the loop state, the research
 * graph, and manuscript freshness; never stored, so it cannot drift. Priorities:
 *   P0  the loop or the manuscript is wrong or blocked on a human answer
 *   P1  a review that blocks a required result; a stale statement in the paper
 *   P2  stuck research, uncovered results, other stale sections
 *   P3  reviews off the critical path; sections never locked
 * Within a priority: more blocked required results first, then oldest first.
 */

export interface AttentionInput {
  state?: LoopState;
  nodes: Map<string, GraphNodeView>;
  sections: SectionView[];
  /** Required results no brief presents; `pending` ones are still under research. */
  uncovered: { id: string; pending: boolean }[];
  required: string[];
}

const open = (id: string): AttentionButton => ({ label: 'Open', action: { action: 'openNode', id }, kind: 'secondary' });

export function computeAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { state, nodes } = input;
  const blocksOf = (id: string) => nodes.get(id)?.blocks ?? [];
  const sectionsOf = (id: string) => nodes.get(id)?.sections ?? [];

  if (state?.pendingQuestion) {
    const question = state.pendingQuestion;
    const target = question.assetId;
    items.push({
      key: `question:${question.id}`, priority: 0, category: 'question',
      title: question.kind === 'goals' ? 'The loop needs your research goal' : `Question from the loop${target ? ` about ${target}` : ''}`,
      reason: question.prompt, target, blocks: target ? blocksOf(target) : input.required, sections: target ? sectionsOf(target) : [], since: question.createdAt,
      buttons: [
        ...(question.options ?? []).map((option): AttentionButton => ({ label: option, action: { action: 'answer', questionId: question.id, text: option }, kind: 'secondary' })),
        { label: 'Answer…', action: { action: 'answer', questionId: question.id, text: '' }, kind: 'primary', needsText: 'Your answer' },
        ...(target ? [open(target)] : []),
      ],
    });
  }

  for (const request of state?.approvalQueue ?? []) {
    const target = request.target;
    const node = nodes.get(target);
    if (request.kind === 'counterexample') {
      const refuted = node?.refutes;
      items.push({
        key: `approval:${request.id}`, priority: 0, category: 'counterexample',
        title: `Confirm or reject counterexample ${target}${refuted ? ` to ${refuted}` : ''}`, reason: request.reason, target,
        blocks: refuted ? blocksOf(refuted) : blocksOf(target), sections: refuted ? sectionsOf(refuted) : [], since: request.requestedAt,
        buttons: [
          { label: 'Confirm counterexample', action: { action: 'approve', requestId: request.id }, kind: 'primary' },
          { label: 'Reject…', action: { action: 'requestChanges', requestId: request.id, text: '' }, needsText: 'Why is it not a counterexample?' },
          open(target),
        ],
      });
      continue;
    }
    const blocks = request.kind === 'project' ? input.required : blocksOf(target);
    const critical = request.kind === 'project' || blocks.length > 0;
    const label = request.kind === 'citation' ? 'Check the citation of' : request.kind === 'project' ? 'Approve' : request.kind === 'definition' ? 'Approve definition' : 'Approve proof of';
    items.push({
      key: `approval:${request.id}`, priority: critical ? 1 : 3, category: 'approval',
      title: request.kind === 'project' ? 'Approve project.md (goals and required results)' : `${label} ${target}${node ? ` — ${node.title}` : ''}`,
      reason: request.reason, target: request.kind === 'project' ? undefined : target, blocks, sections: request.kind === 'project' ? [] : sectionsOf(target), since: request.requestedAt,
      buttons: [
        { label: request.kind === 'citation' ? 'Citation checked' : 'Approve', action: { action: 'approve', requestId: request.id }, kind: 'primary' },
        { label: 'Request changes…', action: { action: 'requestChanges', requestId: request.id, text: '' }, needsText: 'What should change?' },
        ...(request.kind === 'project' ? [] : [open(target)]),
      ],
    });
  }

  for (const id of input.required) {
    const node = nodes.get(id);
    if (node && ['deprecated', 'archived'].includes(node.status)) {
      items.push({
        key: `required:${id}`, priority: 0, category: 'required_inactive', title: `Required result ${id} is ${node.status}`,
        reason: 'The project still requires it. Revise the goals: drop it or give the revised statement a new asset ID.', target: id, blocks: [id], sections: node.sections,
        buttons: [{ label: 'Revise goals in chat', action: { action: 'agent', prompt: `Required result ${id} is ${node.status}. Revise project.md with me: drop it from required_results or give the revised statement a new asset ID.` }, kind: 'primary' }, open(id)],
      });
    }
  }

  for (const section of input.sections) {
    if (section.state === 'invalid') {
      items.push({
        key: `section:${section.id}`, priority: 0, category: 'manuscript_invalid', title: `Section ${section.title} presents results that no longer hold`,
        reason: section.reasons.join('; '), section: section.id, blocks: [], sections: [section.id],
        buttons: [
          { label: 'Discuss in chat', action: { action: 'agent', prompt: `Manuscript section ${section.id} is invalid: ${section.reasons.join('; ')}. Run manuscript-writing prepare ${section.id}, explain what no longer holds, and propose options before editing anything.` }, kind: 'primary' },
          { label: 'Open TeX', action: { action: 'openTex', section: section.id, line: section.blocks.find((block) => block.state === 'invalid')?.lines?.[0] }, kind: 'secondary' },
        ],
      });
    } else if (section.state === 'stale') {
      const statement = section.reasons.some((reason) => /\bstatement\b/.test(reason));
      const blocks = section.blocks.filter((block) => block.state === 'stale');
      items.push({
        key: `section:${section.id}`, priority: statement ? 1 : 2, category: 'manuscript_stale',
        title: `Section ${section.title} is out of date${blocks.length ? ` (${blocks.length} block${blocks.length > 1 ? 's' : ''})` : ''}`,
        reason: section.reasons.join('; '), section: section.id, blocks: [], sections: [section.id],
        buttons: [
          { label: 'Update in chat', action: { action: 'agent', prompt: `Use the draft-latex skill to update manuscript section ${section.id}: run manuscript-writing prepare ${section.id} and revise only the stale blocks and passages it lists (${section.reasons.join('; ')}). Respect each block's policy and leave current blocks unchanged. Do not lock the section; I will review it.` }, kind: 'primary' },
          { label: 'Open TeX', action: { action: 'openTex', section: section.id, line: blocks[0]?.lines?.[0] }, kind: 'secondary' },
          { label: 'Lock (reviewed)', action: { action: 'lock', section: section.id }, kind: 'secondary' },
        ],
      });
    } else if (section.state === 'unlocked' && section.texExists) {
      items.push({
        key: `section:${section.id}`, priority: 3, category: 'unlocked', title: `Section ${section.title} is not locked`,
        reason: 'Lock it after reviewing the TeX so later research changes are tracked against it.', section: section.id, blocks: [], sections: [section.id],
        buttons: [{ label: 'Lock (reviewed)', action: { action: 'lock', section: section.id }, kind: 'primary' }, { label: 'Open TeX', action: { action: 'openTex', section: section.id }, kind: 'secondary' }],
      });
    }
  }

  for (const [id, info] of Object.entries(state?.parked ?? {})) {
    const node = nodes.get(id);
    items.push({
      key: `parked:${id}`, priority: 2, category: 'parked', title: `${id} is parked${node ? ` — ${node.title}` : ''}`,
      reason: `${info.reason}${node?.counts.failedPlans ? `; ${node.counts.failedPlans} failed attempt(s)` : ''}${info.note ? `: ${info.note}` : ''}`,
      target: id, blocks: blocksOf(id), sections: sectionsOf(id), since: info.at,
      buttons: [
        { label: 'Discuss a new approach', action: { action: 'agent', prompt: `Asset ${id} is parked (${info.reason}). Read its failed plans and related ideas, then discuss a genuinely different approach with me before writing a new plan.` }, kind: 'primary' },
        { label: 'Unpark', action: { action: 'unpark', assetId: id }, kind: 'secondary' },
        open(id),
      ],
    });
  }

  for (const item of input.uncovered.filter((entry) => !entry.pending)) {
    items.push({
      key: `uncovered:${item.id}`, priority: 2, category: 'uncovered', title: `${item.id} is approved but not in the manuscript`,
      reason: 'No section brief presents this required result.', target: item.id, blocks: [], sections: [],
      buttons: [{ label: 'Plan it in chat', action: { action: 'agent', prompt: `Use the plan-manuscript skill to place the required result ${item.id} into the manuscript outline (an existing section brief or a new section), and update the introduction or conclusion briefs if the contribution changed. Leave current sections unchanged; then draft only the affected sections with draft-latex.` }, kind: 'primary' }, open(item.id)],
    });
  }

  // Undated items (derived from files, not waiting since a moment) go after dated ones; plain comparison keeps ISO dates in order.
  const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return items.sort((a, b) => a.priority - b.priority || b.blocks.length - a.blocks.length
    || (a.since === undefined ? 1 : 0) - (b.since === undefined ? 1 : 0) || compare(a.since ?? '', b.since ?? '') || compare(a.key, b.key));
}

export const PRIORITY_LABELS: Record<AttentionPriority, string> = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };
