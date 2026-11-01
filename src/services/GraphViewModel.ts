import { ProjectPaths, ResearchNode } from '../models/types';
import { CoverageCell, CoverageRow, GraphEdgeView, GraphFlag, GraphNodeView, GraphPayload, SectionView } from '../models/graph';
import { buildGraph, nodeKey } from '../domain/graph';
import { nodeKindOf } from '../domain/nodeKinds';
import { requiredAssetIds } from '../domain/project';
import { computeAttention } from '../domain/attention';
import { computeLoopHealth } from '../domain/loopHealth';
import { buildHistory } from '../domain/history';
import { NodeProgress, isProvable, needsLabel, parkLabel } from '../domain/copy';
import { sectionReasons } from '../domain/manuscriptImpact';
import { parseTexBlocks } from '../domain/texBlocks';
import { statementPart, stripManagedBlocks } from '../domain/sections';
import { isCited } from '../domain/schema';
import { LoopFiles, LoopState, isApproved } from './ResearchLoopModel';
import { AgentActivity, readAgentActivity } from './AgentActivity';
import { readApprovals } from './ApprovalStore';
import { ManuscriptModel, loadManuscriptModel } from './ManuscriptImpactLoader';

/**
 * Builds the Graph tab payload: compact node views (no bodies), mathematical
 * edges, the attention queue, manuscript sections and the coverage matrix.
 * `buildGraphPayload` is pure; `collectGraphPayload` reads the files.
 */

export interface GraphInputs {
  nodes: ResearchNode[];
  project: string;
  projectApproved: boolean;
  state?: LoopState;
  /** The agent's own liveness record, so the Overview tells a running loop from an agent at work. */
  agent?: AgentActivity;
  manuscript?: ManuscriptModel;
  sectionsDir: string;
  now: string;
  /** Recent loop events (events.jsonl), oldest first, for the timeline. */
  events?: Array<Record<string, unknown>>;
  /** Results marked for re-check: node ID → the changed node it rests on. */
  recheck?: Record<string, string>;
}

const RESEARCH_KINDS = new Set(['asset', 'definition']);

export function buildGraphPayload(input: GraphInputs): GraphPayload {
  const { state, manuscript } = input;
  const all = input.nodes.map((node) => ({ node, kind: nodeKindOf(node.type) })).filter((entry): entry is { node: ResearchNode; kind: 'asset' | 'definition' | 'idea' | 'plan' } => Boolean(entry.kind));
  const graph = buildGraph({ project: input.project, nodes: all.map(({ node, kind }) => ({ id: node.id, kind, data: node as unknown as Record<string, any> })) });
  const required = requiredAssetIds(input.project);
  const math = ['depends_on', 'uses_definition'] as const;
  const kinds = new Map(all.map((entry) => [entry.node.id, entry.kind]));
  const keyOf = (id: string) => nodeKey(kinds.get(id) ?? 'asset', id);
  const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

  // Which required results each node serves.
  const blocks = new Map<string, string[]>();
  for (const id of required) {
    for (const reached of [id, ...graph.reachable([keyOf(id)], math).map(idOf)]) blocks.set(reached, [...(blocks.get(reached) ?? []), id]);
  }
  // The library can be large: show only its nodes the research reaches or a project node references directly, as boundary leaves.
  const referenced = new Set(all.filter((entry) => !entry.node.origin).flatMap((entry) => [...(entry.node.depends_on ?? []), ...(entry.node.uses_definitions ?? [])]));
  const research = all.filter((entry) => RESEARCH_KINDS.has(entry.kind) && (!entry.node.origin || blocks.has(entry.node.id) || referenced.has(entry.node.id)));
  const ids = new Set(research.map((entry) => entry.node.id));

  // Manuscript: who presents what, and which nodes a stale or invalid lock points at.
  const presentedIn = new Map<string, string[]>();
  const staleBecause = new Set<string>();
  const invalidBecause = new Set<string>();
  for (const section of manuscript?.sections ?? []) for (const source of section.brief?.sources ?? []) presentedIn.set(source.id, [...(presentedIn.get(source.id) ?? []), section.id]);
  for (const section of manuscript?.impact.sections ?? []) {
    for (const item of section.stale) staleBecause.add(item.id);
    for (const item of section.invalid) invalidBecause.add(item.id);
  }
  const uncovered = manuscript?.impact.uncovered ?? required.filter((id) => !presentedIn.has(id)).map((id) => ({ id, pending: !isResearchApproved(id) }));
  function isResearchApproved(id: string): boolean {
    const known = manuscript?.nodes.get(id);
    if (known) return known.approved;
    return research.find((entry) => entry.node.id === id)?.node.status === 'approved';
  }

  const plans = all.filter((entry) => entry.kind === 'plan').map((entry) => entry.node);
  const ideas = all.filter((entry) => entry.kind === 'idea').map((entry) => entry.node);
  const refutedBy = new Map<string, ResearchNode[]>();
  for (const { node } of research) if (typeof node.refutes === 'string' && node.refutes) refutedBy.set(node.refutes, [...(refutedBy.get(node.refutes) ?? []), node]);
  const awaiting = new Set((state?.approvalQueue ?? []).filter((item) => item.kind !== 'project').map((item) => item.target));
  const approvalKinds = new Map((state?.approvalQueue ?? []).filter((item) => item.kind !== 'project').map((item) => [item.target, item.kind as string]));
  const statusOf = new Map(research.map(({ node }) => [node.id, node.status ?? 'draft']));
  const titleOf = new Map(research.map(({ node }) => [node.id, node.title || node.id]));

  const nodes: GraphNodeView[] = research.map(({ node, kind }) => {
    const served = blocks.get(node.id) ?? [];
    const isRequired = required.includes(node.id);
    const flags: GraphFlag[] = [];
    if (awaiting.has(node.id)) flags.push('awaiting_approval');
    if (state?.pendingQuestion?.assetId === node.id) flags.push('question');
    if ((refutedBy.get(node.id) ?? []).some((example) => example.status === 'draft')) flags.push('counterexample');
    if ((refutedBy.get(node.id) ?? []).some((example) => example.status === 'approved')) flags.push('refuted');
    if (state?.parked[node.id]) flags.push('parked');
    if (state?.status === 'running' && state.current.assetId === node.id) flags.push('active');
    if (state?.status === 'running' && state.current.assetId === node.id && state.current.search) flags.push('searching');
    if (uncovered.some((item) => item.id === node.id && !item.pending)) flags.push('uncovered');
    if (staleBecause.has(node.id)) flags.push('manuscript_stale');
    if (invalidBecause.has(node.id)) flags.push('manuscript_invalid');
    const targeting = plans.filter((plan) => plan.target_asset === node.id);
    const failedPlans = targeting.filter((plan) => plan.status === 'failed').length;
    return {
      id: node.id, kind: kind as 'asset' | 'definition', type: node.type, title: node.title || node.id, status: node.status ?? 'draft',
      required: isRequired, inScope: served.length > 0,
      lane: isRequired ? node.id : served.length === 1 ? served[0] : served.length > 1 ? 'shared' : 'other',
      flags,
      definitions: (node.uses_definitions ?? []).filter((id) => ids.has(id)),
      counts: {
        plans: targeting.length,
        failedPlans,
        pendingPlans: targeting.filter((plan) => plan.status === 'pending').length,
        ideas: ideas.filter((idea) => (idea.related_assets ?? []).includes(node.id)).length,
      },
      sections: presentedIn.get(node.id) ?? [],
      blocks: served,
      ...(typeof node.refutes === 'string' && node.refutes ? { refutes: node.refutes } : {}),
      ...(node.origin ? { origin: node.origin, collection: node.collection } : {}),
      filePath: node.filePath,
      statement: statementOf(node.body ?? ''),
      ...(input.recheck?.[node.id] ? { recheck: input.recheck[node.id] } : {}),
      ...citedOf(node),
      ...progressOf(node, flags, failedPlans, kind),
    };
  });

  /** The graph state of one node: the most urgent fact about it wins. */
  function progressOf(node: ResearchNode, flags: GraphFlag[], failedPlans: number, kind: string): { progress: NodeProgress; progressLabel: string; progressDetail: string } {
    const result = (progress: NodeProgress, progressLabel: string, progressDetail = '') => ({ progress, progressLabel, progressDetail });
    const status = node.status ?? 'draft';
    if (['deprecated', 'archived'].includes(status)) return result('inactive', 'Retired', status === 'deprecated' ? 'Deprecated' : 'Archived');
    if (flags.includes('refuted')) return result('stuck', 'Disproved', 'An accepted counterexample refutes it');
    const parked = state?.parked[node.id];
    if (flags.includes('counterexample') || parked?.reason === 'counterexample_pending') return result('needs_you', needsLabel('counterexample'), 'A possible counterexample waits for you');
    if (parked) {
      const detail = parked.reason === 'three_failures' ? `${failedPlans || 'Several'} proof attempt${failedPlans === 1 ? '' : 's'} failed`
        : parked.reason === 'search_exhausted' ? 'No match found' : parked.reason === 'researcher' ? 'You set it aside'
        : parked.reason === 'agent_gave_up' ? parked.note || 'The agent, working on its own, gave up on it' : '';
      return result('stuck', parkLabel(parked.reason), detail);
    }
    if (flags.includes('question')) return result('needs_you', needsLabel('question'), 'The agent asked you something');
    const changed = input.recheck?.[node.id];
    if (changed) return result('needs_you', 'Needs re-check', `${titleOf.get(changed) ?? changed} changed after it was proved`);
    // Taken from the literature but not checked yet: nothing waits on the check, so it reads as not done, not as a call for action.
    const cited = citedOf(node).cited;
    if (cited && status === 'draft') return result('waiting', 'Not checked', cited.kind === 'library' ? 'Known result · check before you finish' : `${citationText(cited)} · check before you finish`);
    if (flags.includes('awaiting_approval')) {
      const kind = approvalKinds.get(node.id);
      const detail = kind === 'definition' ? 'Definition written' : kind === 'citation' ? 'Quoted from a paper' : kind === 'specification' ? 'Properties written'
        : node.origin ? 'Known result to accept' : isProvable(node.type) ? 'Proof written' : 'Waiting for you';
      return result('needs_you', needsLabel(kind), detail);
    }
    if (status === 'approved') {
      if (kind === 'definition') return result('done', cited ? 'Cited' : 'Agreed', cited ? citationText(cited) : '');
      if (node.origin) return result('done', 'Known result', 'From the literature');
      return cited ? result('done', 'Cited', citationText(cited)) : result('done', 'Done');
    }
    if (flags.includes('active')) {
      const stage = state?.stage ?? '';
      const label = flags.includes('searching') ? 'Agent searching' : stage === 'plan' ? 'Agent planning' : stage === 'execute' ? 'Agent proving' : stage.startsWith('verify') ? 'Agent checking' : 'Agent working';
      return result('working', label, state?.current.search ? `Search round ${state.current.search.round}` : '');
    }
    const unfinished = [...(node.depends_on ?? []), ...(node.uses_definitions ?? [])].filter((id) => ids.has(id) && statusOf.get(id) !== 'approved');
    if (unfinished.length) return result('waiting', 'Waiting', unfinished.length === 1 ? `Needs ${titleOf.get(unfinished[0]) ?? unfinished[0]} first` : `Needs ${unfinished.length} results first`);
    if (kind === 'definition') return result('waiting', 'Not agreed yet', 'Agree on it before you finish');
    return result('waiting', 'Not started', 'Ready to start');
  }

  const edges: GraphEdgeView[] = [];
  for (const { node } of research) {
    for (const id of node.depends_on ?? []) if (ids.has(id)) edges.push({ from: node.id, to: id, type: 'depends_on' });
    for (const id of node.uses_definitions ?? []) if (ids.has(id)) edges.push({ from: node.id, to: id, type: 'uses_definition' });
    if (typeof node.refutes === 'string' && ids.has(node.refutes)) edges.push({ from: node.id, to: node.refutes, type: 'refutes' });
  }

  const sections: SectionView[] = (manuscript?.sections ?? []).map((section) => {
    const impact = manuscript!.impact.sections.find((item) => item.id === section.id)!;
    const blocks = impact.blocks.map((block) => ({
      id: block.id, policy: block.policy, state: block.state,
      sources: section.binding?.blocks?.find((bound) => bound.id === block.id)?.sources.map((source) => source.id) ?? [],
      ...(block.lines ? { lines: block.lines } : {}),
      reasons: [...block.invalid.map((problem) => `${problem.id} ${problem.reason}`), ...block.stale.map((item) => `${item.id} ${item.components.join('+')} changed`)],
    }));
    // Unlocked sections still show their marked blocks, so the impact view can point at them.
    if (!section.binding && section.texRaw) {
      for (const block of parseTexBlocks(section.texRaw).blocks) blocks.push({ id: block.id, policy: block.policy, state: 'current', sources: block.sources.map((source) => source.id), lines: [block.startLine, block.endLine], reasons: [] });
    }
    return {
      id: section.id, title: section.title, state: impact.state,
      texPath: `${input.sectionsDir}/${section.id}.tex`, texExists: section.texRaw !== undefined,
      ...(impact.lockedRevision ? { lockedRevision: impact.lockedRevision } : {}),
      sources: section.brief?.sources.map((source) => source.id) ?? [],
      bound: section.binding?.sources.map((source) => source.id) ?? [],
      blocks,
      reasons: [...sectionReasons(impact), ...(impact.blocks.length ? impact.outside.map((item) => `outside blocks: ${item.id} ${item.components.join('+')} changed`) : [])],
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const coverage: CoverageRow[] = nodes
    .filter((node) => node.kind === 'asset' && (node.inScope || node.sections.length) && !['deprecated', 'archived'].includes(node.status))
    .sort((a, b) => Number(b.required) - Number(a.required) || a.id.localeCompare(b.id))
    .map((node) => {
      const cells: Record<string, CoverageCell> = {};
      for (const section of manuscript?.sections ?? []) {
        const impact = manuscript!.impact.sections.find((item) => item.id === section.id)!;
        const source = section.brief?.sources.find((item) => item.id === node.id);
        const bound = section.binding?.sources.find((item) => item.id === node.id);
        if (!source && !bound) continue;
        const blockIds = (section.binding?.blocks ?? []).filter((block) => block.sources.some((item) => item.id === node.id)).map((block) => block.id);
        const state = impact.invalid.some((item) => item.id === node.id) ? 'invalid'
          : impact.stale.some((item) => item.id === node.id) || impact.added.includes(node.id) ? 'stale'
          : !section.binding ? 'planned'
          : !source ? 'dependency'
          : 'current';
        cells[section.id] = { state, uses: source?.uses ?? bound?.uses ?? [], blocks: blockIds };
      }
      return { id: node.id, title: node.title, required: node.required, uncovered: node.required && !node.sections.length, cells };
    });

  // Main results: how much of what they rest on is done.
  const prerequisites = new Map<string, string[]>();
  for (const edge of edges) if (edge.type !== 'refutes') prerequisites.set(edge.from, [...(prerequisites.get(edge.from) ?? []), edge.to]);
  for (const id of required) {
    const main = byId.get(id);
    if (!main) continue;
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) for (const next of prerequisites.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    main.closure = { done: [...seen].filter((item) => byId.get(item)?.progress === 'done').length, total: seen.size };
  }

  const health = computeLoopHealth({ state, agent: input.agent, nodes: byId, edges, required, now: input.now });
  if ((health.key === 'stalled' || health.key === 'agent_idle') && state?.current.assetId) {
    const current = byId.get(state.current.assetId);
    // Nobody works on it: neither the card nor the graph may say otherwise.
    if (current) current.flags = current.flags.filter((flag) => flag !== 'active' && flag !== 'searching');
    if (current && current.progress === 'working') Object.assign(current, health.key === 'stalled'
      ? { progress: 'stalled', progressLabel: 'Agent stopped', progressDetail: 'No activity from the agent' }
      : { progress: 'stalled', progressLabel: 'No agent working', progressDetail: 'The loop is on, but no agent is working on it' });
  }
  const attention = computeAttention({ state, nodes: byId, sections, uncovered, required, recheck: input.recheck, stoppedOn: health.key === 'stopped' ? health.blockers.map((item) => item.target).filter((id): id is string => Boolean(id)) : [] });
  // The loop itself can be what waits on the researcher: an agent gone quiet, a pause, or a stopped loop's reasons that are not nodes.
  if (health.key === 'stalled' || health.key === 'agent_idle' || health.key === 'paused') {
    attention.unshift({ key: `loop:${health.key}`, priority: 0, category: 'loop', title: health.headline.replace(/\.$/, ''), reason: health.body, why: health.key === 'paused' ? 'The loop does not move while it is paused.' : 'No agent is working on the research.', ifIgnored: health.ifIgnored, blocks: [], sections: [], buttons: health.buttons });
  }
  if (health.key === 'stopped') {
    for (const [index, blocker] of health.blockers.entries()) {
      if (blocker.target && attention.some((item) => item.target === blocker.target)) continue;
      attention.unshift({ key: `loop:blocker:${index}`, priority: 0, category: 'loop', title: blocker.title, reason: '', why: blocker.detail, ifIgnored: 'The loop stays stopped.', ...(blocker.target ? { target: blocker.target } : {}), blocks: [], sections: [], buttons: blocker.buttons });
    }
  }
  const history = buildHistory(input.events ?? [], (id) => byId.get(id)?.title ?? id, (id) => byId.get(id)?.type ?? '');

  return {
    generatedAt: input.now,
    required,
    ...(manuscript?.revision ? { projectRevision: manuscript.revision } : {}),
    projectApproved: input.projectApproved,
    ...(state ? { loop: { status: state.status, stage: state.stage, ...(state.current.assetId ? { assetId: state.current.assetId } : {}) } } : {}),
    ...(manuscript ? { manuscriptState: manuscript.impact.state } : {}),
    nodes, edges, attention, sections, coverage, health, history,
  };
}

const STATEMENT_LIMIT = 4000;

function citedOf(node: ResearchNode): { cited?: GraphNodeView['cited'] } {
  if (isCited(node.source)) return { cited: { kind: node.source!.kind, ...(node.source!.paper_id ? { paper: node.source!.paper_id } : {}), ...(node.source!.location ? { location: node.source!.location } : {}) } };
  return node.origin === 'library' ? { cited: { kind: 'library' } } : {};
}

/** "From smith2021, Thm 3.2" */
function citationText(cited: NonNullable<GraphNodeView['cited']>): string {
  if (cited.kind === 'library') return 'From the literature';
  return `From ${cited.paper ?? `a ${cited.kind}`}${cited.location ? `, ${cited.location}` : ''}`;
}


/** The statement as written above the proof, without its heading or managed blocks. */
function statementOf(body: string): string {
  const text = stripManagedBlocks(statementPart(body)).replace(/^## (?:Statement|Definition)[ \t]*\r?\n/m, '').trim();
  return text.length > STATEMENT_LIMIT ? `${text.slice(0, STATEMENT_LIMIT)}…` : text;
}

/** Read everything the Graph tab needs through the loop file interface. */
export async function collectGraphPayload(files: LoopFiles, paths: ProjectPaths, nodes: ResearchNode[], state: LoopState | undefined, events: Array<Record<string, unknown>> = [], recheck: Record<string, string> = {}): Promise<GraphPayload> {
  const project = await files.readFile(paths.projectMd).catch(() => '');
  const approvals = (await readApprovals(files, paths.researchRoot).catch(() => ({ records: [] }))).records;
  const manuscript = await loadManuscriptModel(files, paths).catch(() => undefined);
  const agent = await readAgentActivity(files);
  return buildGraphPayload({
    nodes, project, projectApproved: Boolean(project) && isApproved(approvals, 'project', 'project', project),
    state, agent, manuscript, sectionsDir: paths.sections, now: new Date().toISOString(), events, recheck,
  });
}

