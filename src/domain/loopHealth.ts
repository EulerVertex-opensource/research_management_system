import type { LoopState } from '../services/ResearchLoopModel';
import type { AgentActivity } from '../services/AgentActivity';
import type { AttentionButton, LoopBlocker, LoopHealth } from '../models/graph';
import {
  CONTINUE_PROMPT, KEEP_TRYING_HINT, acceptLabel, approvalTitle, capitalize, elapsed, keepTryingLabel, listTitles, newIdeaLabel, parkClause, plural, stageText,
} from './copy';
import { teachPrompt } from './understandingLevels';

/**
 * Whose turn it is and why, derived from the loop state and the research graph;
 * never stored, so it cannot drift. One answer per situation, checked in this
 * order: not running, paused, a question, the goals, stopped (nothing
 * actionable), done, no agent in a turn (none picked the loop up, it handed
 * back, or it went quiet), a result set aside on a main result's path, a
 * review a main result waits on, and plain work.
 */

/** `cited`: taken from the literature (a cited source or a library result); checking it never holds up the research. */
export interface HealthNode { title: string; type?: string; refutes?: string; counts?: { failedPlans: number }; cited?: unknown }

export interface HealthInput {
  state?: LoopState;
  nodes: Map<string, HealthNode>;
  /** `from` depends on `to`. */
  edges: Array<{ from: string; to: string; type?: string }>;
  required: string[];
  now: string;
  /** No loop activity for this long while a stage runs means the agent has stopped. */
  stallMinutes?: number;
  /** The agent's own liveness record. Without one (an older driver), any save of the loop state counts as activity. */
  agent?: AgentActivity;
  /** No sign of the agent for this long, with no command in flight, means it may have stopped. */
  quietMinutes?: number;
}

export const STALL_MINUTES = 20;
export const QUIET_MINUTES = 5;

const openNode = (id: string, label = 'Open'): AttentionButton => ({ label, action: { action: 'openNode', id }, kind: 'secondary' });

/** The chat prompts the set-aside buttons copy; agent-facing, so they keep the internal names. */
export function newApproachPrompt(id: string, reason: string): string {
  return reason === 'search_exhausted'
    ? `The construction search for ${id} is parked: its limits ran out. Run research-loop search status ${id}, read the board and its observation ideas, then discuss with me a new direction or a relaxed specification (a new asset ID) before the search restarts.`
    : `Asset ${id} is parked (${reason}). Read its failed plans and related ideas, then discuss a genuinely different approach with me before writing a new plan.`;
}

export function setAsideButtons(id: string, reason: string): AttentionButton[] {
  return [
    { label: newIdeaLabel(reason), action: { action: 'agent', prompt: newApproachPrompt(id, reason) }, kind: 'primary' },
    { label: keepTryingLabel(reason), action: { action: 'unpark', assetId: id }, kind: 'secondary', hint: KEEP_TRYING_HINT },
  ];
}

export function computeLoopHealth(input: HealthInput): LoopHealth {
  const { state, nodes, required } = input;
  const title = (id: string) => nodes.get(id)?.title || id;
  const dependants = new Map<string, string[]>();
  for (const edge of input.edges) if (edge.type !== 'refutes' && edge.type !== 'serves') dependants.set(edge.to, [...(dependants.get(edge.to) ?? []), edge.from]);
  const requiredSet = new Set(required);
  /** Shortest path from `id` to a main result through what depends on it. */
  const pathToMain = (id: string): string[] => {
    const start = nodes.get(id)?.refutes ?? id;
    const previous = new Map<string, string | undefined>([[start, undefined]]);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      if (requiredSet.has(current)) {
        const path: string[] = [];
        for (let step: string | undefined = current; step !== undefined; step = previous.get(step)) path.unshift(step);
        return start === id ? path : [id, ...path];
      }
      for (const next of dependants.get(current) ?? []) if (!previous.has(next)) { previous.set(next, current); queue.push(next); }
    }
    return [id];
  };
  const mainsOf = (id: string): string[] => {
    const start = nodes.get(id)?.refutes ?? id;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const next of dependants.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    return required.filter((main) => seen.has(main));
  };
  const mainTitles = (id: string) => mainsOf(id).map(title);
  const verb = (subjects: string[], singular: string, many: string) => (subjects.length === 1 ? singular : many);

  const base = {
    chain: [] as string[], blockers: [] as LoopBlocker[], buttons: [] as AttentionButton[], body: '',
    ...(state?.lastSummary ? { last: { at: state.lastSummary.at, text: state.lastSummary.summary } } : {}),
    ...(state?.status === 'running' && input.agent ? { agentAt: input.agent.at } : {}),
  };

  if (!state || state.status === 'idle' || state.status === 'stopped') {
    return { ...base, key: 'idle', turn: 'nobody', tone: 'neutral', eyebrow: 'Research loop', headline: 'The research loop is not running.',
      body: 'Start it here, or type /research-loop in the agent chat. It picks up from the research files.',
      buttons: [{ label: 'Start the loop', action: { action: 'loop', op: 'start' }, kind: 'primary' }],
      ifIgnored: 'Nothing happens until you start it.', statusBar: { text: '', level: 'normal' }, signature: 'idle' };
  }

  const batchOpen = state.stage === 'batch' ? (state.current.batch?.items ?? []).filter((item) => !item.done) : [];
  const doing = batchOpen.length ? `working on ${batchOpen.map((item) => title(item.assetId)).join(', ')} side by side` : stageText(state.stage, state.current.assetId ? title(state.current.assetId) : undefined, state.current.search?.mode);

  if (state.status === 'paused') {
    const reason = state.lastError ?? '';
    const cap = /^Autopilot stopped after (\d+)/.exec(reason);
    const handedBack = /^Autonomous run finished: (.*?)\.?$/.exec(reason);
    const body = cap
      ? `The agent made ${cap[1]} automatic continuations in one chat session, the limit set in Settings. Resume in a fresh chat so it starts from a clean context; it rebuilds everything from the files.`
      : handedBack ? `The agent worked on its own until ${handedBack[1]}. Its handoff and the Overview show what it proved, what it set aside, and what waits for your review. Resuming starts a new run with a fresh budget.`
      : !reason || /^Paused by the researcher/.test(reason) ? 'You paused it. The research files are unchanged.' : `Reason: ${reason}`;
    return { ...base, key: 'paused', turn: 'researcher', tone: 'warning', eyebrow: 'Loop paused',
      headline: cap ? 'The loop paused itself after its limit of automatic continuations.' : handedBack ? 'The autonomous run is over; the loop is back with you.' : 'The loop is paused.', body,
      buttons: [{ label: 'Resume the loop', action: { action: 'loop', op: 'resume' }, kind: 'primary' }],
      ifIgnored: 'Nothing moves until you resume it.', statusBar: { text: 'Research: paused', level: 'warning' }, signature: `paused:${reason}` };
  }

  const question = state.pendingQuestion;
  if (question) {
    const buttons: AttentionButton[] = [
      ...(question.options ?? []).map((option): AttentionButton => ({ label: option, action: { action: 'answer', questionId: question.id, text: option }, kind: 'secondary' })),
      { label: 'Answer…', action: { action: 'answer', questionId: question.id, text: '' }, kind: 'primary', needsText: 'Your answer' },
    ];
    if (question.kind === 'goals') {
      return { ...base, key: 'goals', turn: 'researcher', tone: 'warning', eyebrow: 'Your turn', headline: 'The loop needs your research goal.', body: question.prompt, buttons,
        ifIgnored: 'The loop waits for your goal.', statusBar: { text: 'Research: waiting for your goal', level: 'warning' }, signature: `question:${question.id}` };
    }
    const about = question.assetId ? title(question.assetId) : undefined;
    return { ...base, key: 'needs_you', turn: 'researcher', tone: 'warning', eyebrow: 'The agent is asking you',
      headline: about ? `The agent has a question about ${about}.` : 'The agent has a question.', body: question.prompt,
      chain: question.assetId ? pathToMain(question.assetId) : [], buttons,
      ifIgnored: question.kind === 'blocked' && about ? `If you do not answer in time, ${about} is set aside.` : 'If you do not answer in time, the agent goes on with the default it stated and keeps the question as an idea.',
      statusBar: { text: 'Research: the agent is asking you a question', level: 'warning' }, signature: `question:${question.id}` };
  }

  const projectRequest = state.approvalQueue.find((item) => item.kind === 'project');
  if (state.stage === 'review_project' || projectRequest) {
    return { ...base, key: 'goals', turn: 'researcher', tone: 'warning', eyebrow: 'Your turn', headline: 'Accept the goals in project.md.',
      body: 'The agent wrote up the goals and the main results to prove. Nothing is proved until you accept them.',
      buttons: projectRequest ? [
        { label: 'Accept the goals', action: { action: 'approve', requestId: projectRequest.id }, kind: 'primary' },
        { label: 'Ask for changes…', action: { action: 'requestChanges', requestId: projectRequest.id, text: '' }, kind: 'secondary', needsText: 'What should change?' },
      ] : [],
      ifIgnored: 'The loop waits for your goals.', statusBar: { text: 'Research: waiting for you to accept the goals', level: 'warning' }, signature: 'review_project' };
  }
  if (state.stage === 'discuss_goals') {
    return { ...base, key: 'goals', turn: 'researcher', tone: 'warning', eyebrow: 'Your turn', headline: 'Agree on the goals with the agent in the chat.',
      body: 'The agent waits for you to describe the problem, the main claim and its constraints.',
      buttons: [{ label: 'Open the agent chat', action: { action: 'loop', op: 'openChat' }, kind: 'primary' }],
      ifIgnored: 'The loop waits for your goals.', statusBar: { text: 'Research: waiting for your goals', level: 'warning' }, signature: 'discuss_goals' };
  }

  if (state.stage === 'waiting') {
    const hasCounterexample = state.approvalQueue.some((item) => item.kind === 'counterexample');
    const reasons = state.waitingOn ?? [
      ...state.approvalQueue.map((item) => ({ kind: 'approval' as const, target: item.target, detail: item.kind })),
      ...Object.entries(state.parked).map(([id, info]) => ({ kind: 'parked' as const, target: id, detail: info.reason })),
    ];
    const blockers: LoopBlocker[] = [];
    for (const reason of reasons) {
      const mains = mainTitles(reason.target);
      const holds = mains.length ? `${listTitles(mains)} ${verb(mains, 'waits', 'wait')} on it.` : 'No main result depends on it.';
      if (reason.kind === 'approval') {
        const request = state.approvalQueue.find((item) => item.target === reason.target);
        if (!request) continue;
        const node = nodes.get(reason.target);
        blockers.push({ target: reason.target, title: approvalTitle(request.kind, title(reason.target), node?.type ?? '', Boolean(node?.cited) && request.kind === 'asset'), detail: node?.cited ? 'Quoted from the literature; the project counts as done once you check it.' : holds, buttons: [
          openNode(reason.target, 'Read it'),
          { label: acceptLabel(request.kind, node?.type ?? ''), action: { action: 'approve', requestId: request.id }, kind: 'primary' },
        ] });
      } else if (reason.kind === 'parked') {
        const info = state.parked[reason.target];
        if (!info || (info.reason === 'counterexample_pending' && hasCounterexample)) continue;
        blockers.push({ target: reason.target, title: `${title(reason.target)} is set aside ${parkClause(info.reason, nodes.get(reason.target)?.counts?.failedPlans)}`.trim(),
          detail: mains.length ? `It holds up ${listTitles(mains)}.` : 'No main result depends on it.', buttons: setAsideButtons(reason.target, info.reason) });
      } else if (reason.kind === 'missing_definition') {
        const user = reason.detail ? title(reason.detail) : undefined;
        blockers.push({ title: `The definition “${reason.target.replace(/_/g, ' ')}” is used but never written down`, detail: user ? `${user} uses it; the agent may not invent definitions.` : 'The agent may not invent definitions.',
          buttons: [{ label: 'Draft it in chat', action: { action: 'agent', prompt: `The definition ${reason.target}${reason.detail ? ` (used by ${reason.detail})` : ''} has no file. Draft it as a definition node with me, then ask me to review it; do not approve it.` }, kind: 'primary' }] });
      } else if (reason.kind === 'study') {
        const count = Number(reason.target) || 0;
        blockers.push({ title: `${plural(count, 'verified result')} ${count === 1 ? 'waits' : 'wait'} for you to study ${count === 1 ? 'it' : 'them'}`,
          detail: `You asked the loop to start no new proof while ${reason.detail ?? 'that many'} or more are new to you. Study them in a separate chat, or mark what you know in Results; then tell the agent in its own chat to continue.`,
          buttons: [{ label: 'Study them in a new chat', action: { action: 'agent', prompt: teachPrompt() }, kind: 'primary' }] });
      } else {
        blockers.push({ target: reason.target, title: `${title(reason.target)} depends on itself through a cycle`, detail: 'Two or more results each list the other as a prerequisite.',
          buttons: [{ label: 'Fix it in chat', action: { action: 'agent', prompt: `research-loop reports a dependency cycle at ${reason.target}. Show me the cycle in depends_on and propose how to break it; change nothing until I agree.` }, kind: 'primary' }] });
      }
    }
    const count = blockers.length;
    return { ...base, key: 'stopped', turn: 'researcher', tone: 'error', eyebrow: 'Loop stopped · nothing it can do without you',
      headline: count ? `The loop has stopped. ${count === 1 ? 'One thing needs' : `${count} things need`} you before it can continue.` : 'The loop has stopped: there is nothing it can work on.',
      body: 'Every remaining result is set aside, waiting for your review, or waiting on one of those.', blockers,
      ifIgnored: 'Nothing happens. The loop stays stopped until at least one of these is resolved.',
      statusBar: { text: count ? `Research: stopped — ${plural(count, 'thing')} ${count === 1 ? 'needs' : 'need'} you` : 'Research: stopped', level: 'error' },
      signature: `stopped:${reasons.map((reason) => `${reason.kind}:${reason.target}`).sort().join(',')}` };
  }

  if (state.stage === 'ready') {
    return { ...base, key: 'done', turn: 'researcher', tone: 'success', eyebrow: 'All done', headline: 'Every main result is proved and accepted.',
      body: 'Add a goal to keep going, or work on the paper items below.',
      buttons: [{ label: 'Add a goal', action: { action: 'loop', op: 'extend' }, kind: 'primary' }],
      ifIgnored: 'Nothing else happens.', statusBar: { text: 'Research: all main results done — add a goal?', level: 'normal' }, signature: 'ready' };
  }

  // Whether an agent is in a turn. Only the agent's own record counts (its hooks, commands, and tool calls):
  // the extension saves the loop state too (a researcher's edit, a setting), and that is not the agent working.
  const now = Date.parse(input.now);
  const agent = input.agent;
  const chain = state.current.assetId ? pathToMain(state.current.assetId) : [];
  const continueButton: AttentionButton = { label: 'Copy “continue” and open chat', action: { action: 'agent', prompt: CONTINUE_PROMPT }, kind: 'primary' };
  const agentIdle = (variant: string, eyebrow: string, headline: string, body: string, ifIgnored: string): LoopHealth => ({
    ...base, key: 'agent_idle', turn: 'nobody', tone: 'warning', eyebrow, headline, body, chain, buttons: [continueButton], ifIgnored,
    statusBar: { text: 'Research: no agent is working — continue in chat', level: 'normal' }, signature: `agent_idle:${variant}` });
  const runningSince = state.runningSince ? Date.parse(state.runningSince) : NaN;
  const agentAt = agent ? Date.parse(agent.at) : NaN;
  // Started or resumed from the dashboard: running, but nobody has continued it in a chat yet.
  if (Number.isFinite(runningSince) && !(agentAt >= runningSince)) {
    return agentIdle('waiting', 'Loop on · no agent yet', 'The loop is on, but no agent has picked it up yet.',
      `Next: ${doing}. Continue in the agent chat; the agent picks up from the research files.`, 'Nothing moves until an agent continues the loop.');
  }
  if (agent?.turn === 'ended') {
    return agentIdle('ended', 'Loop on · no agent working', 'No agent is working on the loop right now.',
      `The agent ${agent.endedBy === 'session_end' ? 'chat session ended' : 'ended its turn'} while ${doing}. Nothing is lost: continue in the agent chat and it picks up from there.`,
      'Nothing moves until an agent continues the loop.');
  }
  const activity = Math.max(...(agent ? [agent.at, state.lastSummary?.at] : [state.updatedAt, state.lock?.heartbeatAt, state.lastSummary?.at])
    .map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite));
  const quietFor = Number.isFinite(now) && Number.isFinite(activity) ? now - activity : 0;
  if (quietFor >= (input.stallMinutes ?? STALL_MINUTES) * 60000) {
    const since = elapsed(activity, now);
    return { ...base, key: 'stalled', turn: 'nobody', tone: 'error', eyebrow: 'Nobody is working right now',
      headline: `The agent stopped responding ${since} ago.`,
      body: `It was ${doing}. The loop is fine and nothing is lost; the agent’s chat session most likely ended or reached its turn limit.`,
      chain, buttons: [continueButton],
      ifIgnored: 'Nothing moves. The research stays where it is.',
      statusBar: { text: `Research: the agent stopped ${since} ago`, level: 'error' }, signature: `stalled:${state.current.stageStartedAt}` };
  }
  // An interrupted turn or a closed chat leaves no signal; a command in flight is work, not silence.
  const quietMinutes = input.quietMinutes ?? QUIET_MINUTES;
  if (agent && !agent.tool && quietFor >= quietMinutes * 60000) {
    return agentIdle('quiet', 'The agent may have stopped', `The agent has been quiet for over ${quietMinutes} minutes.`,
      `It was ${doing}. If you interrupted it or closed its chat, continue there; a long computation looks the same.`,
      'If the agent is still working, it carries on; otherwise nothing moves.');
  }

  const setAside = Object.entries(state.parked)
    .filter(([, info]) => info.reason !== 'counterexample_pending')
    .map(([id, info]) => ({ id, info, mains: mainsOf(id) }))
    .filter((entry) => entry.mains.length)
    .sort((a, b) => b.mains.length - a.mains.length || a.info.at.localeCompare(b.info.at));
  if (setAside.length) {
    const { id, info, mains } = setAside[0];
    const names = mains.map(title);
    const failed = nodes.get(id)?.counts?.failedPlans ?? 0;
    const what = info.reason === 'search_exhausted' ? 'The search used all its rounds without a match. It will not search again on its own.'
      : info.reason === 'researcher' ? 'You set it aside.'
      : `The agent tried ${failed > 1 ? `${failed} different proofs` : 'to prove it'} and none worked. It will not try again on its own.`;
    return { ...base, key: 'set_aside', turn: 'agent', tone: 'warning',
      eyebrow: `The agent is still working · ${setAside.length === 1 ? 'one result needs' : `${setAside.length} results need`} your idea`,
      headline: `${title(id)} is set aside, and it holds up ${listTitles(names)}.`,
      body: `${what} Meanwhile the agent is ${doing}.`, chain: pathToMain(id),
      buttons: [...setAsideButtons(id, info.reason), openNode(id)],
      ifIgnored: `The agent finishes its other work and then stops. ${listTitles(names)} ${verb(names, 'stays', 'stay')} unproved.`,
      statusBar: { text: 'Research: a result is set aside — needs your idea', level: 'warning' },
      signature: `set_aside:${setAside.map((entry) => entry.id).sort().join(',')}` };
  }

  // Citations and known results do not hold anything up (the loop builds on them at once); they wait in "Before you finish".
  const critical = state.approvalQueue.filter((item) => item.kind === 'counterexample' || (item.kind !== 'citation' && !nodes.get(item.target)?.cited && mainsOf(item.target).length));
  if (critical.length) {
    const request = critical.slice().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
    const node = nodes.get(request.target);
    const names = mainTitles(request.target);
    const more = state.approvalQueue.length - 1;
    const counterexample = request.kind === 'counterexample';
    return { ...base, key: 'needs_you', turn: 'researcher', tone: 'warning', eyebrow: 'Your turn · the agent continues with other work',
      headline: `${approvalTitle(request.kind, title(request.target), node?.type ?? '')}.`,
      body: `${counterexample && node?.refutes ? `If it holds, ${title(node.refutes)} is false. ` : names.length ? `${listTitles(names)} ${verb(names, 'waits', 'wait')} on it. ` : ''}Meanwhile the agent is ${doing}.${more > 0 ? ` ${plural(more, 'more item')} ${more === 1 ? 'waits' : 'wait'} for you below.` : ''}`,
      chain: pathToMain(request.target),
      buttons: [
        openNode(request.target, counterexample ? 'Open the example' : node?.type && /^(theorem|lemma|proposition|corollary|claim)$/.test(node.type) ? 'Read the proof' : 'Read it'),
        { label: acceptLabel(request.kind, node?.type ?? ''), action: { action: 'approve', requestId: request.id }, kind: 'primary' },
        counterexample
          ? { label: 'Not a counterexample…', action: { action: 'requestChanges', requestId: request.id, text: '' }, kind: 'secondary', needsText: 'Why is it not a counterexample?' }
          : { label: 'Ask for changes…', action: { action: 'requestChanges', requestId: request.id, text: '' }, kind: 'secondary', needsText: 'What should change?' },
      ],
      ifIgnored: names.length ? `${listTitles(names)} ${verb(names, 'keeps', 'keep')} waiting. The agent finishes its other work, then stops.` : 'The agent finishes its other work, then stops.',
      statusBar: { text: `Research: ${plural(state.approvalQueue.length, 'review')} waiting for you`, level: 'normal' },
      signature: `needs:${critical.map((item) => item.id).sort().join(',')}` };
  }

  const queued = state.approvalQueue.length;
  const round = state.current.search?.round;
  return { ...base, key: 'working', turn: 'agent', tone: 'info', eyebrow: 'The agent is working', headline: `${capitalize(doing)}.`,
    body: round ? `Search round ${round}.` : '', chain: state.current.assetId ? pathToMain(state.current.assetId) : [],
    ifIgnored: queued ? `The agent keeps working; the ${plural(queued, 'item')} below can wait.` : 'Nothing is needed from you right now.',
    statusBar: { text: `Research: ${doing.length > 60 ? `${doing.slice(0, 59)}…` : doing}`, level: 'normal' }, signature: 'working' };
}
