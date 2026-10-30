import type { HistoryEntry, LoopTone } from '../models/graph';
import { approvalTitle, parkClause, plural } from './copy';

/**
 * The Activity timeline: loop events (events.jsonl) as sentences for
 * the researcher, newest first. Events with nothing to tell (stage `select`,
 * context bookkeeping) are left out.
 */

type LoopEvent = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const clip = (value: string, max = 220) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const REPORT_TONE: Record<string, LoopTone> = {
  proved: 'success', confirmed: 'success', complete: 'success', summarized: 'neutral', searched: 'neutral',
  failed: 'warning', rejected: 'warning', candidate: 'warning', question: 'warning', none: 'neutral',
};

export function describeEvent(event: LoopEvent, title: (id: string) => string, type: (id: string) => string = () => ''): Omit<HistoryEntry, 'at'> | undefined {
  const asset = text(event.assetId) || text(event.target);
  const name = asset ? title(asset) : '';
  const entry = (line: string, tone: LoopTone = 'neutral'): Omit<HistoryEntry, 'at'> => ({ text: line, tone, ...(asset ? { target: asset } : {}) });
  switch (event.type) {
    case 'started': return entry('The research loop started.', 'info');
    case 'resumed': return entry('The loop resumed.', 'info');
    case 'stopped': return entry('The loop was stopped.');
    case 'extended': return entry(`New goal added: ${clip(text(event.goal), 120)}`, 'info');
    case 'paused': return entry(/^Autopilot stopped/.test(text(event.reason)) ? 'The loop paused itself: it reached its limit of automatic continuations.' : 'The loop was paused.', 'warning');
    case 'stage': {
      const stage = text(event.stage);
      if (stage === 'waiting') return entry('Stopped: nothing left that the agent can work on.', 'error');
      if (stage === 'ready') return entry('Every main result is done.', 'success');
      if (stage === 'plan') return entry(`Started planning a proof of ${name}.`);
      if (stage === 'execute') return entry(`Started proving ${name}.`);
      if (stage === 'verify_proof') return entry(`Started checking the proof of ${name}.`);
      if (stage === 'search') return entry(`Started a search round on ${name}.`);
      if (stage === 'verify_counterexample') return entry(`Started checking a possible counterexample to ${name}.`);
      if (stage === 'verify_construction') return entry(`Started checking a candidate for ${name}.`);
      if (stage === 'scaffold') return entry('Started setting up the results to prove.');
      if (stage === 'draft_project') return entry('Started writing up the goals.');
      return undefined;
    }
    case 'report': {
      const summary = clip(text(event.summary));
      return summary ? entry(summary, REPORT_TONE[text(event.outcome)] ?? 'neutral') : undefined;
    }
    case 'parked': return entry(`Set ${name} aside ${parkClause(text(event.reason))}.`, 'error');
    case 'unparked': return entry(`${name} is back in the queue.`, 'info');
    case 'revision_started': return entry(`Checking the rewording of ${name}'s proof you asked for in the teaching chat.`, 'info');
    case 'revision_rejected': return entry(`The rewording of ${name}'s proof did not pass the check; the previous proof is back.`, 'warning');
    case 'revision_discarded': return entry(`A rewording of ${name} was dropped: ${text(event.reason)}.`, 'warning');
    case 'remarks_updated': return entry(`Your remarks on ${name} were saved.`);
    case 'approved': return entry(text(event.source) === 'auto' ? `${name} was approved automatically.` : `You accepted ${name}.`, 'success');
    case 'auto_approved': return entry(`${name} was approved automatically.`, 'success');
    case 'approval_requested': return entry(`Asked you: ${approvalTitle(text(event.kind), name, type(asset))}.`, 'warning');
    case 'approval_resolved': return event.decision === 'changes_requested' ? entry(`You asked for changes to ${name}.`, 'info') : undefined;
    case 'approval_invalidated': {
      const id = text(event.id);
      return { text: `${title(id)} changed after it was accepted; it needs your review again.`, tone: 'warning', target: id };
    }
    case 'refuted': return { text: `${name} is disproved by ${title(text(event.exampleId))}.`, tone: 'error', target: asset };
    case 'counterexample_rejected': return { text: `You rejected the possible counterexample ${title(text(event.exampleId))}.`, tone: 'info' };
    case 'construction_found': return entry(`Found a candidate for ${name}.`, 'success');
    case 'proof_verified': return entry(`An independent check confirmed the proof of ${name}.`, 'success');
    case 'proof_rejected': return entry(`An independent check found a gap in the proof of ${name}; the agent will try another approach.`, 'warning');
    case 'search_round': return entry(`Search round ${Number(event.round) || '?'} on ${name}: ${plural(Number(event.candidates) || 0, 'candidate')}.`);
    case 'search_finished': return entry(`The search on ${name} finished${event.rounds ? ` after ${plural(Number(event.rounds), 'round')}` : ''}.`);
    case 'question': return entry(`The agent asked you a question${name ? ` about ${name}` : ''}.`, 'warning');
    case 'question_answered': return entry(event.decision === 'skip' ? 'You skipped a question.' : 'You answered the agent’s question.', 'info');
    case 'question_expired': return entry('A question went unanswered; the agent used its default.');
    case 'agent_retry': return entry(`No direction from you: the agent is trying one new approach on ${name}.`, 'warning');
    case 'autonomy_started': return entry('The agent started working on its own; it asks you nothing until it hands the loop back.', 'info');
    case 'autonomy_decided': return entry(`The agent decided a question itself${name ? ` about ${name}` : ''}; it is kept as an idea for you.`);
    case 'autonomy_deciding': return entry(`The attempts for ${name} ran out; the agent decides itself whether to go on.`, 'warning');
    case 'budget_allocated': return entry(`The agent gave ${name} ${plural(Number(event.attempts) || 0, 'more attempt')} with a new approach of its own.`, 'info');
    case 'autonomy_revision': return entry(`With ${plural(Array.isArray(event.setAside) ? event.setAside.length : 0, 'set-aside result')} in the way, the agent is reassessing what the goals still need; yours stay.`, 'warning');
    case 'autonomy_handover': return entry(`The autonomous run ended: ${text(event.reason)}. Over to you.`, 'warning');
    case 'recheck_flagged': { const id = text(event.id); return { text: `${title(id)} needs a re-check: ${title(text(event.because))} changed.`, tone: 'warning', target: id }; }
    case 'recheck_cleared': { const id = text(event.id); return { text: `You confirmed ${title(id)} still holds.`, tone: 'success', target: id }; }
    case 'auto_mode_reset': return entry('Automatic approval was switched on outside the dashboard, so it was turned off.', 'warning');
    case 'plans_abandoned': return entry(`Dropped ${plural(Array.isArray(event.plans) ? event.plans.length : 0, 'proof plan')} for ${name}.`);
    case 'idea_saved': {
      const related = Array.isArray(event.relatedAssets) ? event.relatedAssets.map(String) : [];
      return { text: `Saved an idea${related.length ? ` about ${title(related[0])}` : ''}.`, tone: 'neutral', ...(related[0] ? { target: related[0] } : {}) };
    }
    default: return undefined;
  }
}

/** True for events the Activity timeline shows; context bookkeeping and the like are not. */
export function isTimelineEvent(event: LoopEvent): boolean {
  return describeEvent(event, (id) => id) !== undefined;
}

/** Newest first, at most `limit` lines. */
export function buildHistory(events: LoopEvent[], title: (id: string) => string, type?: (id: string) => string, limit = 60): HistoryEntry[] {
  const lines: HistoryEntry[] = [];
  for (const event of [...events].reverse()) {
    const described = describeEvent(event, title, type);
    if (described) lines.push({ at: text(event.at), ...described });
    if (lines.length >= limit) break;
  }
  return lines;
}
