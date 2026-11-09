/**
 * Canonical vocabulary of research nodes. Pure: shared by the extension, the
 * bundled CLIs, and the webview, so every list below exists exactly once.
 */

/** Current on-disk schema; `research-maintenance migrate` upgrades older projects. */
export const SCHEMA_VERSION = 3;

/** Schema 3 retired `remark`: assumptions and conventions are definitions, explanations are remarks (domain/remarks.ts). */
export const ASSET_TYPE_LIST = ['theorem', 'lemma', 'proposition', 'example', 'construction', 'conjecture'] as const;
export type AssetType = (typeof ASSET_TYPE_LIST)[number];
export const ASSET_TYPES: ReadonlySet<string> = new Set(ASSET_TYPE_LIST);
/** Asset types the loop falsifies and proves; examples are not proved. */
export const PROVABLE_TYPES: ReadonlySet<string> = new Set(['theorem', 'lemma', 'proposition', 'construction']);
/**
 * A conjecture is a precise statement the project believes but has not committed to prove: it
 * lies outside the required results, the loop searches it for counterexamples but never plans a
 * proof, and it may be stated in the paper. Promotion retypes it to one of these and makes it a
 * goal; demotion turns a draft result that no goal needs any more back into a conjecture.
 */
export const CONJECTURE_TYPE = 'conjecture';
export const PROMOTED_TYPES = ['theorem', 'lemma', 'proposition'] as const;

export const NODE_TYPE_LIST = [...ASSET_TYPE_LIST, 'definition', 'idea', 'plan'] as const;

/**
 * What a definition node fixes. All three are agreed on, never proved, and the results that rely
 * on one list it in `uses_definitions`, so a change makes them stale. `definition` introduces a
 * concept or notation; `assumption` is a hypothesis results take for granted in part of the
 * project ("from here on, $\Omega$ is bounded"); `convention` fixes notation or a normalization
 * without mathematical content. Assumptions for the whole project stay in project.md.
 */
export const DEFINITION_KIND_LIST = ['definition', 'assumption', 'convention'] as const;
export type DefinitionKind = (typeof DEFINITION_KIND_LIST)[number];
/** A definition node's kind; absent means `definition`. */
export function definitionKindOf(data: { definition_kind?: unknown } | undefined): DefinitionKind {
  const value = data?.definition_kind;
  return (DEFINITION_KIND_LIST as readonly unknown[]).includes(value) ? value as DefinitionKind : 'definition';
}
/** Title prefix per kind: `Definition (concept)`, `Assumption (bounded domain)`, `Convention (constants)`. */
export const DEFINITION_TITLE_PREFIX: Readonly<Record<DefinitionKind, string>> = { definition: 'Definition', assumption: 'Assumption', convention: 'Convention' };
/** A definition node's title from its concept, and the concept back from a title of any kind. */
export const definitionTitle = (kind: DefinitionKind, concept: string) => `${DEFINITION_TITLE_PREFIX[kind]} (${concept})`;
export const definitionConcept = (title: string) => title.replace(/^(?:Definition|Assumption|Convention) \((.*)\)$/, '$1');
export type NodeType = (typeof NODE_TYPE_LIST)[number];

/** Review and lifecycle status of assets and definitions. */
export const NODE_STATUS_LIST = ['draft', 'approved', 'deprecated', 'archived'] as const;
export type NodeStatus = (typeof NODE_STATUS_LIST)[number];
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['draft', 'approved']);
export const INACTIVE_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'archived']);

/**
 * Every idea status; which ones an idea may take depends on its kind (IDEA_STATUSES_BY_KIND).
 * `resolved`: answered, or turned into an asset (see `resolved_by`). A plan that uses an idea
 * never resolves it: the plan lists it in `inspired_by`, and the idea stays usable elsewhere.
 * `refuted` (an observation found false, ## Refutation) and `obstructed` (an approach shown not to
 * work in general, ## Obstruction) are kept as warnings for similar results; `archived`: dropped.
 */
export const IDEA_STATUS_LIST = ['draft', 'resolved', 'refuted', 'obstructed', 'archived'] as const;
export type IdeaStatus = (typeof IDEA_STATUS_LIST)[number];
/** What an idea is for, so context retrieval can tell a question from an approach. */
/** `conjecture`: a statement believed true but not yet precise or checked; the loop may turn it into a conjecture asset. */
export const IDEA_KIND_LIST = ['approach', 'question', 'observation', 'test_case', 'risk', 'conjecture'] as const;
export type IdeaKind = (typeof IDEA_KIND_LIST)[number];

/**
 * Statuses per idea kind. Approaches and observations are reused across results, so being used
 * changes nothing about them; an observation that keeps recurring is promoted to a lemma
 * (`resolved` by it). A test case is tried per result (the search records say where), so it is
 * only open or dropped.
 */
export const IDEA_STATUSES_BY_KIND: Readonly<Record<IdeaKind, readonly IdeaStatus[]>> = {
  approach: ['draft', 'resolved', 'obstructed', 'archived'],
  observation: ['draft', 'resolved', 'refuted', 'archived'],
  test_case: ['draft', 'archived'],
  question: ['draft', 'resolved', 'archived'],
  risk: ['draft', 'resolved', 'archived'],
  conjecture: ['draft', 'resolved', 'archived'],
};
/** Kinds a plan uses without using them up: they stay open for other results. */
export const REUSABLE_IDEA_KINDS: ReadonlySet<string> = new Set(['approach', 'observation']);
/** Statuses that warn similar results off a route: shown with the reason, never hidden like `archived`. */
export const WARNING_IDEA_STATUSES: ReadonlySet<string> = new Set(['refuted', 'obstructed']);
/** The section a warning status needs. */
export const WARNING_SECTION: Readonly<Record<string, string>> = { refuted: 'Refutation', obstructed: 'Obstruction' };
/** Distinct results whose plans used one open observation before the loop suggests promoting it to a lemma. */
export const PROMOTION_TARGETS = 2;

/** An idea kind from loose input: a valid kind as given, `question` for open-question tags, else `approach`. */
export function toIdeaKind(value: unknown, tags: readonly string[] = []): IdeaKind {
  if ((IDEA_KIND_LIST as readonly unknown[]).includes(value)) return value as IdeaKind;
  return tags.includes('open-question') ? 'question' : 'approach';
}

/** The statuses an idea of this kind may take; a missing kind reads as `approach`, as everywhere else. */
export function ideaStatusesFor(kind: unknown): readonly IdeaStatus[] {
  return IDEA_STATUSES_BY_KIND[toIdeaKind(kind)];
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

export function statusesFor(type: string, ideaKind?: unknown): readonly string[] {
  if (type === 'idea') return ideaStatusesFor(ideaKind);
  if (type === 'plan') return PLAN_STATUS_LIST;
  return NODE_STATUS_LIST;
}
