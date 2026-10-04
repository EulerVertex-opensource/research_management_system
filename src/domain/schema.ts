import {
  ASSET_TYPES, AssetType, CITED_SOURCE_KINDS, IDEA_KIND_LIST, IDEA_STATUS_LIST, IdeaKind, IdeaStatus, LEGACY_SOURCE_KINDS, NODE_STATUS_LIST, NodeKind, NodeStatus,
  PLAN_STATUS_LIST, PlanStatus, SOURCE_KIND_LIST, SourceKind,
} from './nodeKinds';
import { CHECKLIST_STEP, hasSection, hasSectionContent } from './sections';

/**
 * What a valid research node holds, per kind. Files are loose YAML, so these
 * types describe the contract and `nodeProblems` enforces it; the loop
 * validator, the dashboard, and the maintenance CLI all call it.
 */
export interface NodeSource { kind: SourceKind; paper_id?: string; location?: string }
interface NodeBase { title: string; tags?: string[] }
export interface ResultNodeData extends NodeBase {
  type: AssetType; status: NodeStatus; source?: NodeSource; depends_on?: string[]; uses_definitions?: string[];
  /** The library result this project node was promoted from. */
  derived_from?: string;
  /** Only on a counterexample (`type: example`). */
  refutes?: string;
}
export interface DefinitionNodeData extends NodeBase { type: 'definition'; status: NodeStatus; source?: NodeSource; depends_on?: string[]; derived_from?: string }
export interface IdeaNodeData extends NodeBase {
  type: 'idea'; status: IdeaStatus; idea_kind?: IdeaKind; related_assets?: string[]; origin?: string;
  /** The decision, plan, or asset that resolved it. */
  resolved_by?: string;
}
export interface PlanNodeData extends NodeBase {
  type: 'plan'; status: PlanStatus; target_asset: string; inspired_by?: string[];
  /** Stamped by the loop on success: digest of the target's `## Proof` this plan produced. */
  proof_digest?: string;
}
export type NodeData = ResultNodeData | DefinitionNodeData | IdeaNodeData | PlanNodeData;

/**
 * Relation fields each kind may carry. Only forward relations are stored;
 * reverse ones (used in, plans of, refuted by) are derived by `reverseRelations`.
 */
export const RELATION_FIELDS = ['depends_on', 'uses_definitions', 'related_assets', 'target_asset', 'inspired_by', 'refutes', 'derived_from'] as const;
/** Relations that hold one node ID rather than a list. */
const SINGLE_RELATIONS = new Set(['target_asset', 'refutes', 'derived_from']);
export const NODE_RELATIONS: Record<NodeKind, readonly string[]> = {
  asset: ['depends_on', 'uses_definitions', 'refutes', 'derived_from'],
  definition: ['depends_on', 'derived_from'],
  idea: ['related_assets'],
  plan: ['target_asset', 'inspired_by'],
};
/** Fields older schemas stored that v2 derives or dropped. */
export const RETIRED_FIELDS = ['used_in', 'kind'] as const;

/** Remove relation fields that do not apply to the node's kind, and retired fields, keeping everything else. */
export function stripForeignFields(kind: NodeKind, data: Record<string, unknown>, type?: string): Record<string, unknown> {
  const allowed = new Set(NODE_RELATIONS[kind]);
  if (kind === 'asset' && type !== 'example') allowed.delete('refutes');
  for (const field of [...RELATION_FIELDS, ...RETIRED_FIELDS]) if (!allowed.has(field)) delete data[field];
  return data;
}

const isStringList = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

export interface NodeCheckOptions {
  /** Accept `approved`: false for files an agent wrote, true for committed files the researcher approved. */
  allowApproved?: boolean;
  /** Indexed paper IDs; when given, paper sources must name one and a location. */
  paperIds?: Set<string>;
}

/** Problems with one node's frontmatter and required sections, each prefixed with its ID. Empty when valid. */
export function nodeProblems(kind: NodeKind, id: string, data: Record<string, any>, content: string, options: NodeCheckOptions = {}): string[] {
  if (data.type === undefined && data.title === undefined && data.status === undefined) {
    return [`${id}: not a research node (no frontmatter). Node folders hold one node per file; index, README, overview, and other folder notes are not allowed.`];
  }
  const problems: string[] = [];
  const statuses: readonly string[] = options.allowApproved ? NODE_STATUS_LIST : NODE_STATUS_LIST.filter((status) => status !== 'approved');
  if (typeof data.title !== 'string' || !data.title.trim()) problems.push(`${id}: title is required.`);
  for (const field of RELATION_FIELDS) if (!SINGLE_RELATIONS.has(field) && !isStringList(data[field])) problems.push(`${id}: ${field} must be a list of node IDs.`);
  if (data.derived_from !== undefined && typeof data.derived_from !== 'string') problems.push(`${id}: derived_from must be one node ID.`);
  switch (kind) {
    case 'asset': {
      if (!ASSET_TYPES.has(data.type)) problems.push(`${id}: invalid asset type.`);
      if (!statuses.includes(data.status)) problems.push(`${id}: agent-written assets must stay draft; approval is a researcher action.`);
      problems.push(...sourceProblems(id, data.source, options.paperIds));
      if (data.type === 'example' && data.refutes !== undefined && (typeof data.refutes !== 'string' || !hasSection(content, 'Assumptions') || !hasSection(content, 'Calculation'))) {
        problems.push(`${id}: counterexample needs refutes, Assumptions, and Calculation.`);
      }
      break;
    }
    case 'definition':
      if (data.type !== 'definition' || !statuses.includes(data.status) || !content.trim()) problems.push(`${id}: invalid draft definition.`);
      problems.push(...sourceProblems(id, data.source, options.paperIds));
      break;
    case 'idea':
      if (data.type !== 'idea' || !(IDEA_STATUS_LIST as readonly string[]).includes(data.status) || !content.trim()) problems.push(`${id}: invalid idea (type idea, status ${IDEA_STATUS_LIST.join(', ')}, non-empty body).`);
      if (data.idea_kind !== undefined && !(IDEA_KIND_LIST as readonly string[]).includes(data.idea_kind)) problems.push(`${id}: idea_kind must be one of ${IDEA_KIND_LIST.join(', ')}.`);
      break;
    case 'plan':
      problems.push(...planProblems(id, data, content));
      break;
  }
  return problems;
}

export function planProblems(id: string, data: Record<string, any>, content: string): string[] {
  if (data.type === 'proof_record') return [`${id}: proof_record is a legacy type; run \`research-maintenance migrate\` to turn it into a plan with status succeeded.`];
  if (data.type !== 'plan') return [`${id}: plan folder files must have type plan.`];
  if (!(PLAN_STATUS_LIST as readonly string[]).includes(data.status) || typeof data.target_asset !== 'string') {
    return [`${id}: invalid proof plan (needs status ${PLAN_STATUS_LIST.join('|')} and target_asset).`];
  }
  if (data.status === 'succeeded') return hasSectionContent(content, 'Outcome') ? [] : [`${id}: a succeeded plan needs ## Outcome naming where the proof lives.`];
  if (data.status === 'abandoned') return [];
  if (!hasSection(content, 'Goal') || !hasSection(content, 'Plan') || !hasSection(content, 'Verification') || !CHECKLIST_STEP.test(content)) {
    return [`${id}: invalid proof plan (needs Goal, Plan checklist, Verification).`];
  }
  if (data.status === 'failed' && !hasSectionContent(content, 'Failure')) return [`${id}: failed plan needs an obstruction under ## Failure.`];
  return [];
}

function sourceProblems(id: string, source: any, paperIds: Set<string> | undefined): string[] {
  if (source === undefined || source === null) return [];
  const kind = sourceKind(source);
  if (!kind) return [`${id}: source.kind must be one of ${SOURCE_KIND_LIST.join(', ')}.`];
  if (CITED_SOURCE_KINDS.has(kind) && paperIds && (!paperIds.has(source.paper_id) || !source.location)) return [`${id}: ${kind} source needs an indexed paper_id and precise location.`];
  return [];
}

/** The source kind with legacy names mapped (`self_proved` → `original`), or undefined when unknown. */
export function sourceKind(source: unknown): SourceKind | undefined {
  const raw = (source as { kind?: unknown } | null | undefined)?.kind;
  if (typeof raw !== 'string') return undefined;
  const kind = LEGACY_SOURCE_KINDS[raw] ?? raw;
  return (SOURCE_KIND_LIST as readonly string[]).includes(kind) ? kind as SourceKind : undefined;
}

/** True when the node is established by citing a paper or textbook rather than proved in this project. */
export function isCited(source: unknown): boolean {
  const kind = sourceKind(source);
  return kind !== undefined && CITED_SOURCE_KINDS.has(kind);
}

/** First-duplicate report for filename IDs, which are global across every research folder. */
export function duplicateIds(files: string[]): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const file of files) {
    const id = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const earlier = seen.get(id);
    if (earlier) problems.push(`${file}: node ID ${id} is already used by ${earlier}; IDs are global across research folders.`);
    else seen.set(id, file);
  }
  return problems;
}
