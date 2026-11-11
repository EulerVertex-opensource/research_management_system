/**
 * The researcher-facing vocabulary: every loop stage, park reason, node state,
 * urgency group and recurring button label the dashboard, the status bar and
 * the popups show. Files, loop state, the CLI and the agent keep the internal
 * names; only this module turns them into words. No imports, so the webview
 * can use it too.
 */

/** What the loop is doing, as a phrase that follows "The agent is …" or stands alone. `{result}` is a node title. */
const STAGE_TEXT: Record<string, string> = {
  discuss_goals: 'agreeing on the goals with you',
  draft_project: 'writing up the goals',
  review_project: 'waiting for you to accept the goals',
  scaffold: 'setting up the results to prove',
  sources: 'reading your sources',
  select: 'choosing what to work on next',
  search_refute: 'looking for a counterexample to {result}',
  search_construct: 'searching for {result}',
  search_summary: 'summing up the search for {result}',
  verify_counterexample: 'checking a possible counterexample to {result}',
  verify_construction: 'checking a candidate for {result}',
  plan: 'planning a proof of {result}',
  execute: 'proving {result}',
  verify_proof: 'checking the proof of {result}',
  verify_node: 'checking {result} before it is approved',
  conjecture: 'making a conjecture precise',
  route: 'planning routes to {result}',
  route_merge: 'merging the routes to {result}',
  review_routes: 'waiting for you to review the routes to {result}',
  reduce: 'writing how a route reaches {result}',
  verify_reduction: 'checking how a route reaches {result}',
  batch: 'working on several results side by side',
  waiting: 'stopped until you act',
  ready: 'done with every main result',
};

/** A stage as a lower-case phrase, e.g. "proving Key bound"; `mode` tells the two kinds of search apart. */
export function stageText(stage: string, result?: string, mode?: string): string {
  const key = stage === 'search' ? (mode === 'construct' ? 'search_construct' : 'search_refute') : stage;
  const template = STAGE_TEXT[key] ?? 'working';
  return template.replace(' {result}', result ? ` ${result}` : '').replace('{result}', result ?? '');
}

export function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Why a result is set aside, as a short label (graph nodes) and as a clause after "set aside" (cards). */
export function parkLabel(reason: string): string {
  if (reason === 'search_exhausted') return 'Search ran out';
  if (reason === 'counterexample_pending') return 'On hold';
  if (reason === 'researcher') return 'Set aside by you';
  if (reason === 'agent_gave_up') return 'Set aside by the agent';
  return 'Set aside';
}

export function parkClause(reason: string, failedPlans = 0): string {
  if (reason === 'search_exhausted') return 'because its search ran out without a match';
  if (reason === 'counterexample_pending') return 'while a possible counterexample waits for you';
  if (reason === 'researcher') return 'by you';
  if (reason === 'agent_gave_up') return 'by the agent, working on its own, after its attempts ran out';
  if (reason === 'three_failures') return failedPlans ? `after ${failedPlans} failed proof attempt${failedPlans > 1 ? 's' : ''}` : 'after repeated failed proof attempts';
  return reason ? `(${reason.replace(/_/g, ' ')})` : '';
}

/** The five states a result takes on the graph, plus retired ones. */
export type NodeProgress = 'done' | 'working' | 'needs_you' | 'stuck' | 'waiting' | 'stalled' | 'inactive';

export const PROGRESS_LABEL: Record<NodeProgress, string> = {
  done: 'Done', working: 'Agent working', needs_you: 'Needs you', stuck: 'Stuck', waiting: 'Waiting', stalled: 'Agent stopped', inactive: 'Retired',
};

/** Legend text for each state. */
export const PROGRESS_LEGEND: Array<{ state: NodeProgress; label: string }> = [
  { state: 'done', label: 'Done' },
  { state: 'working', label: 'Agent working' },
  { state: 'needs_you', label: 'Needs you' },
  { state: 'stuck', label: 'Stuck' },
  { state: 'waiting', label: 'Waiting on other results' },
];

/** Urgency groups of the Needs you list, replacing P0–P3. */
export const URGENCY_LABEL: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'Waiting on you now',
  1: 'Holds up a main result',
  2: 'Can wait',
  3: 'Before you finish',
  4: 'Housekeeping',
};

export const URGENCY_HINT: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'The loop or the agent cannot go on until you act.',
  1: 'A main result waits on this; other work continues.',
  2: 'Nothing is held up, but the paper or the research lags behind.',
  3: 'Research goes on without these, but the project counts as done only after you check them.',
  4: 'Tidying up; nothing depends on it.',
};

/** Results whose review is a proof review; a conjecture's review is of its statement. */
const PROVABLE = new Set(['theorem', 'lemma', 'proposition', 'corollary', 'claim']);

/** "Theorem", "Lemma", …; a node's type as a capitalized noun. */
export function kindLabel(type: string): string {
  return capitalize((type || 'result').replace(/_/g, ' '));
}

export function isProvable(type: string): boolean {
  return PROVABLE.has(type);
}

/** Card title for an approval request about `title` (a node title). */
export function approvalTitle(kind: string, title: string, type: string, library = false): string {
  if (kind === 'project') return 'Accept the goals in project.md';
  if (kind === 'definition') return `Review the definition of ${title}`;
  if (kind === 'specification') return `Accept the required properties of ${title}`;
  if (kind === 'routes') return `Review the routes to ${title}`;
  if (kind === 'citation') return `Check the citation for ${title}`;
  if (kind === 'package') return `Accept the imported package ${title}`;
  if (kind === 'counterexample') return `Check a possible counterexample: ${title}`;
  if (library) return `Accept the known result ${title}`;
  return isProvable(type) ? `Review the proof of ${title}` : `Review ${kindLabel(type).toLowerCase()} ${title}`;
}

/** The accept button for an approval request. */
export function acceptLabel(kind: string, type: string): string {
  if (kind === 'project') return 'Accept the goals';
  if (kind === 'definition') return 'Accept definition';
  if (kind === 'specification') return 'Accept the properties';
  if (kind === 'routes') return 'Work on these routes';
  if (kind === 'citation') return 'The citation matches';
  if (kind === 'package') return 'Accept package';
  if (kind === 'counterexample') return 'Yes, it is a counterexample';
  return isProvable(type) ? 'Accept proof' : 'Accept';
}

/** The short node label while an approval waits, e.g. "Needs your review". */
export function needsLabel(kind: string | undefined): string {
  if (kind === 'counterexample') return 'Check counterexample';
  if (kind === 'citation') return 'Check citation';
  if (kind === 'package') return 'Accept package';
  if (kind === 'specification') return 'Accept properties';
  if (kind === 'routes') return 'Review routes';
  if (kind === 'question') return 'Question for you';
  return 'Needs your review';
}

/** "Main Theorem", "Main Theorem and Sharpness", "A, B and 2 more". */
export function listTitles(titles: string[], max = 2): string {
  if (titles.length <= max) return titles.length === 2 ? `${titles[0]} and ${titles[1]}` : titles.join('');
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Minutes, hours or days since `then`, e.g. "42 min", "3 h". */
export function elapsed(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** The instruction the "continue" buttons copy for the chat. */
export const CONTINUE_PROMPT = 'Continue the research loop: run research-loop next and follow it.';

/** Tooltip of every button that copies an instruction for the agent chat. */
export const CHAT_BUTTON_HINT = 'Copies an instruction and opens the agent chat; paste it there.';

/** The two ways on from a set-aside result: the researcher's own idea, or back to the agent unchanged (unpark). */
export function newIdeaLabel(reason: string): string {
  return reason === 'search_exhausted' ? 'Discuss a new direction' : 'Give the agent an idea';
}

export function keepTryingLabel(reason: string): string {
  return reason === 'search_exhausted' ? 'Let the agent keep searching' : 'Let the agent keep trying';
}

export const KEEP_TRYING_HINT = 'No new idea from you: it goes back in the agent’s queue, and the agent tries again on its own, knowing what failed before.';

/** Where one of the researcher's own results stands in the repair (Results → Repair): the label, and the color group on the graph. */
export const REPAIR_LABEL: Record<string, string> = {
  unchecked: 'Not checked yet', checking: 'Agent checking', gap: 'Gap: your call', needs_repair: 'Gap: to repair',
  repairing: 'Agent repairing', review: 'Waits for your review', stuck: 'Repair stuck', to_prove: 'To prove', done: 'Done', retired: 'Retired',
};

const REPAIR_PROGRESS: Record<string, NodeProgress> = {
  unchecked: 'waiting', checking: 'working', gap: 'needs_you', needs_repair: 'waiting', repairing: 'working',
  review: 'needs_you', stuck: 'stuck', done: 'done', retired: 'inactive',
};

/** The graph color group of a repair state; a result to prove keeps its own. `active`: an agent works on it now. */
export function repairProgress(state: string, own: NodeProgress, active?: boolean): NodeProgress {
  if (state === 'to_prove') return own;
  if (state === 'repairing' && !active) return 'waiting';
  return REPAIR_PROGRESS[state] ?? own;
}

/** One line under the title in the repair view. */
export function repairDetail(repair: { state: string; how?: string; gap?: string; failed: number; active?: boolean; note?: string }): string {
  const firstLine = (text?: string) => (text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  const clipped = (text: string) => (text.length > 90 ? `${text.slice(0, 87)}…` : text);
  const attempts = repair.failed ? ` (${repair.failed} failed attempt${repair.failed > 1 ? 's' : ''})` : '';
  switch (repair.state) {
    case 'gap': return clipped(`Gap: ${firstLine(repair.gap)}. Ask the loop to repair it, or fix it yourself`);
    case 'needs_repair': return clipped(`Gap: ${firstLine(repair.gap)}${attempts}`);
    case 'repairing': return repair.note ? `${repair.note}${attempts}` : `${repair.active ? 'Being repaired now' : 'Repair under way, paused'}${attempts}`;
    case 'review': return repair.how === 'repaired' ? 'Repaired and checked: compare it with your version' : 'Your proof passed the check as written';
    case 'done': return repair.how === 'repaired' ? 'Repaired, approved' : repair.how === 'proved' ? 'Proved here, approved' : 'Sound as written, approved';
    case 'stuck': return clipped(repair.note ? `Set aside: ${firstLine(repair.note)}` : `Set aside${attempts}`);
    case 'unchecked': return 'Your proof waits for its independent check';
    case 'checking': return 'The agent checks your proof as written';
    case 'to_prove': return 'Came without a proof; the loop proves it';
    default: return '';
  }
}

/** Legend of the repair view. */
export const REPAIR_LEGEND: Array<{ state: NodeProgress; label: string }> = [
  { state: 'done', label: 'Done' },
  { state: 'working', label: 'Agent checking or repairing' },
  { state: 'needs_you', label: 'Waits for you (review, or a gap to decide on)' },
  { state: 'stuck', label: 'Repair stuck' },
  { state: 'waiting', label: 'Not checked yet, or a gap waiting its turn' },
];
