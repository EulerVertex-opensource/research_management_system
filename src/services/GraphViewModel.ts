import { ProjectPaths, ResearchNode } from '../models/types';
import { CoverageCell, CoverageRow, GraphEdgeView, GraphFlag, GraphNodeView, GraphPayload, SectionView } from '../models/graph';
import { buildGraph, nodeKey } from '../domain/graph';
import { nodeKindOf } from '../domain/nodeKinds';
import { requiredAssetIds } from '../domain/project';
import { computeAttention } from '../domain/attention';
import { sectionReasons } from '../domain/manuscriptImpact';
import { parseTexBlocks } from '../domain/texBlocks';
import { LoopFiles, LoopState, isApproved } from './ResearchLoopModel';
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
  manuscript?: ManuscriptModel;
  sectionsDir: string;
  now: string;
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
    return {
      id: node.id, kind: kind as 'asset' | 'definition', type: node.type, title: node.title || node.id, status: node.status ?? 'draft',
      required: isRequired, inScope: served.length > 0,
      lane: isRequired ? node.id : served.length === 1 ? served[0] : served.length > 1 ? 'shared' : 'other',
      flags,
      definitions: (node.uses_definitions ?? []).filter((id) => ids.has(id)),
      counts: {
        plans: targeting.length,
        failedPlans: targeting.filter((plan) => plan.status === 'failed').length,
        pendingPlans: targeting.filter((plan) => plan.status === 'pending').length,
        ideas: ideas.filter((idea) => (idea.related_assets ?? []).includes(node.id)).length,
      },
      sections: presentedIn.get(node.id) ?? [],
      blocks: served,
      ...(typeof node.refutes === 'string' && node.refutes ? { refutes: node.refutes } : {}),
      ...(node.origin ? { origin: node.origin, collection: node.collection } : {}),
      filePath: node.filePath,
    };
  });

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

  const attention = computeAttention({ state, nodes: byId, sections, uncovered, required });

  return {
    generatedAt: input.now,
    required,
    ...(manuscript?.revision ? { projectRevision: manuscript.revision } : {}),
    projectApproved: input.projectApproved,
    ...(state ? { loop: { status: state.status, stage: state.stage, ...(state.current.assetId ? { assetId: state.current.assetId } : {}) } } : {}),
    ...(manuscript ? { manuscriptState: manuscript.impact.state } : {}),
    nodes, edges, attention, sections, coverage,
  };
}

/** Read everything the Graph tab needs through the loop file interface. */
export async function collectGraphPayload(files: LoopFiles, paths: ProjectPaths, nodes: ResearchNode[], state: LoopState | undefined): Promise<GraphPayload> {
  const project = await files.readFile(paths.projectMd).catch(() => '');
  const approvals = (await readApprovals(files, paths.researchRoot).catch(() => ({ records: [] }))).records;
  const manuscript = await loadManuscriptModel(files, paths).catch(() => undefined);
  return buildGraphPayload({
    nodes, project, projectApproved: Boolean(project) && isApproved(approvals, 'project', 'project', project),
    state, manuscript, sectionsDir: paths.sections, now: new Date().toISOString(),
  });
}

