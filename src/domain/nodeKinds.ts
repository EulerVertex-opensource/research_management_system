/**
 * Canonical vocabulary of research nodes. Pure: shared by the extension, the
 * bundled CLIs, and the webview, so every list below exists exactly once.
 */

/** Current on-disk schema; `research-maintenance migrate` upgrades older projects. */
export const SCHEMA_VERSION = 2;

export const ASSET_TYPE_LIST = ['theorem', 'lemma', 'proposition', 'example', 'construction', 'remark'] as const;
export type AssetType = (typeof ASSET_TYPE_LIST)[number];
export const ASSET_TYPES: ReadonlySet<string> = new Set(ASSET_TYPE_LIST);
/** Asset types the loop falsifies and proves; examples and remarks are not proved. */
export const PROVABLE_TYPES: ReadonlySet<string> = new Set(['theorem', 'lemma', 'proposition', 'construction']);

export const NODE_TYPE_LIST = [...ASSET_TYPE_LIST, 'definition', 'idea', 'plan'] as const;
export type NodeType = (typeof NODE_TYPE_LIST)[number];

/** Review and lifecycle status of assets and definitions. */
export const NODE_STATUS_LIST = ['draft', 'approved', 'deprecated', 'archived'] as const;
export type NodeStatus = (typeof NODE_STATUS_LIST)[number];
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['draft', 'approved']);
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'archived']);

/** `resolved`: answered, or turned into a plan or lemma (see `resolved_by`); `archived`: dropped. */
export const IDEA_STATUS_LIST = ['draft', 'resolved', 'archived'] as const;
export type IdeaStatus = (typeof IDEA_STATUS_LIST)[number];
/** What an idea is for, so context retrieval can tell a question from an approach. */
export const IDEA_KIND_LIST = ['approach', 'question', 'observation', 'test_case', 'risk'] as const;
export type IdeaKind = (typeof IDEA_KIND_LIST)[number];

/** An idea kind from loose input: a valid kind as given, `question` for open-question tags, else `approach`. */
export function toIdeaKind(value: unknown, tags: readonly string[] = []): IdeaKind {
  if ((IDEA_KIND_LIST as readonly unknown[]).includes(value)) return value as IdeaKind;
  return tags.includes('open-question') ? 'question' : 'approach';
}

/** A plan is one proof attempt for one target asset; `succeeded` replaces the legacy proof_record type. */
export const PLAN_STATUS_LIST = ['pending', 'failed', 'succeeded', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUS_LIST)[number];

export type ResearchStatus = NodeStatus | IdeaStatus | PlanStatus;

/**
 * Where a node's content comes from. `paper` and `textbook` are citations: the
 * loop checks the citation instead of proving. `original` was produced in this
 * project; `note` is an informal source (talk, notes, folklore) and is still
 * proved here.
 */
export const SOURCE_KIND_LIST = ['paper', 'textbook', 'original', 'note'] as const;
export type SourceKind = (typeof SOURCE_KIND_LIST)[number];
export const CITED_SOURCE_KINDS: ReadonlySet<string> = new Set(['paper', 'textbook']);
/** Schema-2 name of `original`; still read, rewritten by `research-maintenance migrate`. */
export const LEGACY_SOURCE_KINDS: Readonly<Record<string, SourceKind>> = { self_proved: 'original' };

/** Failed plans since the researcher's last direction before the loop asks for help. */
export const MAX_FAILED_PLANS = 3;

/** The folder a node type lives in. */
export type NodeKind = 'asset' | 'definition' | 'idea' | 'plan';
export function nodeKindOf(type: unknown): NodeKind | undefined {
  if (typeof type !== 'string') return undefined;
  if (ASSET_TYPES.has(type)) return 'asset';
  if (type === 'definition' || type === 'idea' || type === 'plan') return type;
  return undefined;
}

export function statusesFor(type: string): readonly string[] {
  if (type === 'idea') return IDEA_STATUS_LIST;
  if (type === 'plan') return PLAN_STATUS_LIST;
  return NODE_STATUS_LIST;
}
