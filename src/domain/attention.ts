import type { LoopState } from '../services/ResearchLoopModel';
import type { AttentionButton, AttentionItem, AttentionPriority, GraphNodeView, SectionView } from '../models/graph';
import { URGENCY_LABEL, acceptLabel, approvalTitle, isProvable, listTitles, parkClause } from './copy';
import { setAsideButtons } from './loopHealth';
import { MANUSCRIPT_CHAT_NOTE } from './chatRoles';

/**
 * The researcher's "Needs you" list, derived from the loop state, the research
 * graph, and manuscript freshness; never stored, so it cannot drift. Groups
 * (URGENCY_LABEL) are about consequences:
 *   0  waiting on you now: a question, broken goals, or anything the stopped loop waits on
 *   1  holds up a main result: reviews, set-aside results and counterexamples on its path; a paper section that is wrong or has a stale statement
 *   2  can wait: set-aside results off the main path, results missing from the paper, other stale sections
 *   3  before you finish: citations and known results to check; the loop works on without them, but the project is done only once they are checked
 *   4  housekeeping: reviews off the main path, sections never marked as reviewed
 * Within a group: more blocked main results first, then oldest first.
 */

export interface AttentionInput {
  state?: LoopState;
  nodes: Map<string, GraphNodeView>;
  sections: SectionView[];
  /** Required results no brief presents; `pending` ones are still under research. */
  uncovered: { id: string; pending: boolean }[];
  required: string[];
  /** Nodes the stopped loop waits on; their items move to group 0. */
  stoppedOn?: string[];
  /** Results marked for re-check: node ID → the changed node it rests on. */
  recheck?: Record<string, string>;
}

const open = (id: string): AttentionButton => ({ label: 'Open', action: { action: 'openNode', id }, kind: 'secondary' });

export function computeAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { state, nodes } = input;
  const blocksOf = (id: string) => nodes.get(id)?.blocks ?? [];
  const sectionsOf = (id: string) => nodes.get(id)?.sections ?? [];
  const title = (id: string) => nodes.get(id)?.title || id;
  const mains = (ids: string[]) => listTitles(ids.map(title));
  const waits = (ids: string[]) => (ids.length ? `${mains(ids)} ${ids.length === 1 ? 'waits' : 'wait'} on it.` : 'No main result depends on it yet.');
  const keepsWaiting = (ids: string[]) => (ids.length ? `${mains(ids)} ${ids.length === 1 ? 'keeps' : 'keep'} waiting. Other work continues.` : 'Nothing is held up.');

  if (state?.pendingQuestion) {
    const question = state.pendingQuestion;
    const target = question.assetId;
    items.push({
      key: `question:${question.id}`, priority: 0, category: 'question',
      title: question.kind === 'goals' ? 'The loop needs your research goal' : `The agent asks${target ? ` about ${title(target)}` : ''}`,
      reason: question.prompt, why: 'The agent waits for your answer.',
      ifIgnored: question.kind === 'goals' ? 'The loop waits for your goal.' : 'After a while the agent goes on with the default it stated.',
      target, blocks: target ? blocksOf(target) : input.required, sections: target ? sectionsOf(target) : [], since: question.createdAt,
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
        key: `approval:${request.id}`, priority: 1, category: 'counterexample',
        title: refuted ? `Check a possible counterexample to ${title(refuted)}` : `Check the possible counterexample ${title(target)}`, reason: request.reason,
        why: refuted ? `If it holds, ${title(refuted)} is false and the goals must change.` : 'It may refute a result the project needs.',
        ifIgnored: refuted ? `${title(refuted)} stays on hold.` : 'The result it targets stays on hold.', target,
        blocks: refuted ? blocksOf(refuted) : blocksOf(target), sections: refuted ? sectionsOf(refuted) : [], since: request.requestedAt,
        buttons: [
          { label: 'Open the example', action: { action: 'openNode', id: target }, kind: 'primary' },
          { label: acceptLabel('counterexample', ''), action: { action: 'approve', requestId: request.id }, kind: 'secondary' },
          { label: 'Not a counterexample…', action: { action: 'requestChanges', requestId: request.id, text: '' }, needsText: 'Why is it not a counterexample?' },
        ],
      });
      continue;
    }
    if (request.kind === 'package') {
      // An imported package: results approved in another project, accepted here once as known results.
      const members = [...nodes.values()].filter((item) => item.origin === 'library' && item.collection === target).sort((a, b) => a.id.localeCompare(b.id));
      items.push({
        key: `approval:${request.id}`, priority: 3, category: 'approval', title: approvalTitle('package', target, ''),
        reason: request.reason, why: 'Its results were proved and approved in another project. Check that you accept them, once for the whole package.',
        ifIgnored: 'Research continues on top of it, but the project cannot count as done.',
        blocks: [...new Set(members.flatMap((item) => item.blocks ?? []))], sections: [], since: request.requestedAt,
        buttons: [
          ...(members.length ? [{ label: 'Read its results', action: { action: 'openNode', id: members[0].id }, kind: 'primary' } as AttentionButton] : []),
          { label: acceptLabel('package', ''), action: { action: 'approve', requestId: request.id }, kind: 'secondary' },
        ],
      });
      continue;
    }
    const library = node?.origin === 'library';
    if (request.kind === 'citation' || (request.kind === 'asset' && library)) {
      // Taken from the literature: the loop already builds on it; checking it is the last step before the project counts as done.
      const source = node?.cited;
      const from = library ? `the library${node?.collection ? ` (${node.collection})` : ''}` : source?.paper ? `${source.paper}${source.location ? `, ${source.location}` : ''}` : 'a cited source';
      items.push({
        key: `approval:${request.id}`, priority: 3, category: 'approval', title: approvalTitle(request.kind, title(target), node?.type ?? '', library),
        reason: '', why: `It is quoted from ${from}. Check that the statement matches the source.`,
        ifIgnored: 'Research continues on top of it, but the project cannot count as done.',
        target, blocks: blocksOf(target), sections: sectionsOf(target), since: request.requestedAt,
        buttons: [
          { label: 'Read it', action: { action: 'openNode', id: target }, kind: 'primary' },
          { label: acceptLabel(request.kind, node?.type ?? ''), action: { action: 'approve', requestId: request.id }, kind: 'secondary' },
          { label: 'Ask for changes…', action: { action: 'requestChanges', requestId: request.id, text: '' }, needsText: 'What does not match the source?' },
        ],
      });
      continue;
    }
    const project = request.kind === 'project';
    const blocks = project ? input.required : blocksOf(target);
    const critical = project || blocks.length > 0;
    const type = node?.type ?? '';
    const proof = request.kind === 'asset' && isProvable(type) && node?.origin !== 'library';
    items.push({
      key: `approval:${request.id}`, priority: critical ? 1 : 4, category: 'approval',
      title: approvalTitle(request.kind, title(target), type, node?.origin === 'library'),
      reason: request.reason, why: project ? 'Nothing is proved until you accept the goals.' : waits(blocks), ifIgnored: project ? 'The loop waits for your goals.' : keepsWaiting(blocks),
      target: project ? undefined : target, blocks, sections: project ? [] : sectionsOf(target), since: request.requestedAt,
      buttons: [
        ...(project ? [] : [{ label: proof ? 'Read the proof' : 'Read it', action: { action: 'openNode', id: target }, kind: 'primary' } as AttentionButton]),
        { label: acceptLabel(request.kind, type), action: { action: 'approve', requestId: request.id }, kind: project ? 'primary' : 'secondary' },
        { label: 'Ask for changes…', action: { action: 'requestChanges', requestId: request.id, text: '' }, needsText: 'What should change?' },
      ],
    });
  }

  for (const id of input.required) {
    const node = nodes.get(id);
    if (node && ['deprecated', 'archived'].includes(node.status)) {
      items.push({
        key: `required:${id}`, priority: 0, category: 'required_inactive', title: `The main result ${title(id)} was retired (${node.status})`,
        reason: '', why: 'The goals still list it, so the loop cannot finish.', ifIgnored: 'The loop keeps asking to revise the goals.',
        target: id, blocks: [id], sections: node.sections,
        buttons: [{ label: 'Revise the goals in chat', action: { action: 'agent', prompt: `Required result ${id} is ${node.status}. Revise project.md with me: drop it from required_results or give the revised statement a new asset ID.` }, kind: 'primary' }, open(id)],
      });
    }
  }

  for (const section of input.sections) {
    if (section.state === 'invalid') {
      items.push({
        key: `section:${section.id}`, priority: 1, category: 'manuscript_invalid', title: `Section “${section.title}” shows results that no longer hold`,
        reason: section.reasons.join('; '), why: 'Readers would see statements that are not proved.', ifIgnored: 'The paper stays wrong in this section.',
        section: section.id, blocks: [], sections: [section.id],
        buttons: [
          { label: 'Discuss it in chat', action: { action: 'agent', prompt: `Use the draft-latex skill: manuscript section ${section.id} is invalid (${section.reasons.join('; ')}). Run manuscript-writing prepare ${section.id}, explain what no longer holds, and propose options before editing anything. ${MANUSCRIPT_CHAT_NOTE}` }, kind: 'primary' },
          { label: 'Open the TeX', action: { action: 'openTex', section: section.id, line: section.blocks.find((block) => block.state === 'invalid')?.lines?.[0] }, kind: 'secondary' },
        ],
      });
    } else if (section.state === 'stale') {
      const statement = section.reasons.some((reason) => /\bstatement\b/.test(reason));
      const blocks = section.blocks.filter((block) => block.state === 'stale');
      items.push({
        key: `section:${section.id}`, priority: statement ? 1 : 2, category: 'manuscript_stale',
        title: `Section “${section.title}” is out of date${blocks.length ? ` (${blocks.length} passage${blocks.length > 1 ? 's' : ''})` : ''}`,
        reason: section.reasons.join('; '), why: statement ? 'A statement it shows changed after you marked it as reviewed.' : 'The research changed after you marked it as reviewed.',
        ifIgnored: 'Nothing breaks. The paper lags behind the research.', section: section.id, blocks: [], sections: [section.id],
        buttons: [
          { label: 'Update it in chat', action: { action: 'agent', prompt: `Use the draft-latex skill to update manuscript section ${section.id}: run manuscript-writing prepare ${section.id} and revise only the stale blocks and passages it lists (${section.reasons.join('; ')}). Respect each block's policy and leave current blocks unchanged. Do not lock the section; I will review it. ${MANUSCRIPT_CHAT_NOTE}` }, kind: 'primary' },
          { label: 'Open the TeX', action: { action: 'openTex', section: section.id, line: blocks[0]?.lines?.[0] }, kind: 'secondary' },
          { label: 'Mark as reviewed', action: { action: 'lock', section: section.id }, kind: 'secondary' },
        ],
      });
    } else if (section.state === 'unlocked' && section.texExists) {
      items.push({
        key: `section:${section.id}`, priority: 4, category: 'unlocked', title: `Section “${section.title}” has never been marked as reviewed`,
        reason: '', why: 'Until you do, later changes to the results are not checked against it.', ifIgnored: 'You will not be told when it goes out of date.',
        section: section.id, blocks: [], sections: [section.id],
        buttons: [{ label: 'Mark as reviewed', action: { action: 'lock', section: section.id }, kind: 'primary' }, { label: 'Open the TeX', action: { action: 'openTex', section: section.id }, kind: 'secondary' }],
      });
    }
  }

  const counterexampleQueued = (state?.approvalQueue ?? []).some((item) => item.kind === 'counterexample');
  for (const [id, info] of Object.entries(state?.parked ?? {})) {
    // The counterexample card already covers a result on hold for one.
    if (info.reason === 'counterexample_pending' && counterexampleQueued) continue;
    const node = nodes.get(id);
    const blocks = blocksOf(id);
    items.push({
      key: `parked:${id}`, priority: blocks.length ? 1 : 2, category: 'parked',
      title: `${title(id)} is set aside ${parkClause(info.reason, node?.counts?.failedPlans)}`.trim(),
      reason: info.note && !/^no new direction/.test(info.note) ? info.note : '',
      why: blocks.length ? `It holds up ${mains(blocks)}.` : 'No main result depends on it.',
      ifIgnored: blocks.length ? `${mains(blocks)} ${blocks.length === 1 ? 'stays' : 'stay'} unproved. Other work continues.` : 'Nothing is held up.',
      target: id, blocks, sections: sectionsOf(id), since: info.at,
      buttons: [...setAsideButtons(id, info.reason), open(id)],
    });
  }

  for (const [id, changed] of Object.entries(input.recheck ?? {})) {
    if (!nodes.has(id)) continue;
    const blocks = blocksOf(id);
    items.push({
      key: `recheck:${id}`, priority: blocks.length ? 1 : 2, category: 'recheck',
      title: `${title(id)} may no longer hold: ${title(changed)} changed`,
      reason: '', why: `It was proved for the earlier version of ${title(changed)}.`,
      ifIgnored: 'It keeps counting as done, though what it rests on has changed.',
      target: id, blocks, sections: sectionsOf(id),
      buttons: [
        { label: 'Read it', action: { action: 'openNode', id }, kind: 'primary' },
        { label: 'Still holds', action: { action: 'confirmRecheck', id }, kind: 'secondary' },
        { label: 'Ask the agent to re-check', action: { action: 'agent', prompt: `${changed} changed after ${id} was proved. Re-read the proof of ${id} against the current ${changed} and tell me whether it still holds and what would need to change; edit nothing.` }, kind: 'secondary' },
      ],
    });
  }

  for (const item of input.uncovered.filter((entry) => !entry.pending)) {
    items.push({
      key: `uncovered:${item.id}`, priority: 2, category: 'uncovered', title: `${title(item.id)} is proved but not in the paper yet`,
      reason: '', why: 'No section of the paper presents this main result.', ifIgnored: 'The paper leaves out a main result.',
      target: item.id, blocks: [], sections: [],
      buttons: [{ label: 'Plan it in chat', action: { action: 'agent', prompt: `Use the plan-manuscript skill to place the required result ${item.id} into the manuscript outline (an existing section brief or a new section), and update the introduction or conclusion briefs if the contribution changed. Leave current sections unchanged; then draft only the affected sections with draft-latex. ${MANUSCRIPT_CHAT_NOTE}` }, kind: 'primary' }, open(item.id)],
    });
  }

  const stopped = new Set(input.stoppedOn ?? []);
  for (const item of items) if (item.target && stopped.has(item.target)) item.priority = 0;

  // Undated items (derived from files, not waiting since a moment) go after dated ones; plain comparison keeps ISO dates in order.
  const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return items.sort((a, b) => a.priority - b.priority || b.blocks.length - a.blocks.length
    || (a.since === undefined ? 1 : 0) - (b.since === undefined ? 1 : 0) || compare(a.since ?? '', b.since ?? '') || a.key.localeCompare(b.key, 'en', { numeric: true }));
}

export const PRIORITY_LABELS: Record<AttentionPriority, string> = URGENCY_LABEL;
