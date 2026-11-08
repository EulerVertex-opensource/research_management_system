import { parseMarkdown } from '../services/Frontmatter';
import { CITED_SOURCE_KINDS } from './nodeKinds';
import { COLLECTION_FILE, ResultKind } from './registry';

/**
 * Library collections the researcher fills by extraction: results taken from a
 * paper, a set of notes, or a thesis. Unlike an imported package, nothing
 * upstream vouches for them: each result is checked against its source one by
 * one, and the files stay editable. `collection.md` may say where the
 * collection comes from:
 *
 *   ---
 *   title: Smith, Rigidity of collapsing manifolds
 *   kind: paper
 *   paper_id: smith2021
 *   ---
 *   One paragraph on the source.
 *
 * Pure: shared by the extension, the bundled CLIs, and tests.
 */

export const COLLECTION_KINDS = ['paper', 'note', 'thesis', 'other'] as const;
export type CollectionKind = typeof COLLECTION_KINDS[number];

export interface CollectionMeta {
  title?: string;
  kind?: CollectionKind;
  paper_id?: string;
  description: string;
}

export interface CollectionNode {
  id: string;
  file: string;
  kind: ResultKind;
  title: string;
  status?: string;
  source?: { kind?: string; paper_id?: string; location?: string };
}

export interface CollectionSummary {
  name: string;
  kind: CollectionKind;
  /** Whether collection.md states the kind; otherwise it is inferred from the results. */
  declared: boolean;
  title?: string;
  paperId?: string;
  results: number;
  approved: number;
  /** Draft results in library order: the ones that wait to be checked against the source. */
  drafts: string[];
  problems: string[];
}

export const collectionFile = (library: string, name: string) => `${library}/${name}/${COLLECTION_FILE}`;

/** collection.md's frontmatter and paragraph; a file without frontmatter takes its title from its first heading. */
export function parseCollectionMeta(raw: string, file = COLLECTION_FILE): { meta: CollectionMeta; problems: string[] } {
  const problems: string[] = [];
  let data: Record<string, unknown> = {};
  let content = raw;
  try { const parsed = parseMarkdown(raw); data = parsed.data ?? {}; content = parsed.content; } catch (error) {
    problems.push(`${file}: invalid frontmatter (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).`);
  }
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const description = content.replace(/^#\s+.+$/m, '').trim();
  const meta: CollectionMeta = { description };
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : heading;
  if (title) meta.title = title;
  if (data.kind !== undefined) {
    if (typeof data.kind === 'string' && (COLLECTION_KINDS as readonly string[]).includes(data.kind)) meta.kind = data.kind as CollectionKind;
    else problems.push(`${file}: kind must be one of ${COLLECTION_KINDS.join(', ')}.`);
  }
  if (data.paper_id !== undefined) {
    if (typeof data.paper_id === 'string' && data.paper_id.trim()) meta.paper_id = data.paper_id.trim();
    else problems.push(`${file}: paper_id must be a paper ID from the paper index.`);
  }
  return { meta, problems };
}

const citedPaper = (node: CollectionNode): string | undefined =>
  node.source && CITED_SOURCE_KINDS.has(node.source.kind as never) && node.source.paper_id ? node.source.paper_id : undefined;

/**
 * What a collection is and what it needs. A collection.md that names a paper
 * holds every result to it: each must cite that paper (with a location, which
 * the node validator requires of any citation). Without a declared kind, a
 * collection whose results all cite one paper is that paper's.
 */
export function summarizeCollection(
  name: string,
  metaRaw: string | undefined,
  nodes: CollectionNode[],
  options: { library: string; paperIds?: Set<string> },
): CollectionSummary {
  const file = collectionFile(options.library, name);
  const { meta, problems } = metaRaw === undefined ? { meta: { description: '' } as CollectionMeta, problems: [] as string[] } : parseCollectionMeta(metaRaw, file);
  const cited = new Set(nodes.map(citedPaper));
  const inferredPaper = nodes.length && cited.size === 1 ? [...cited][0] : undefined;
  const kind: CollectionKind = meta.kind ?? (inferredPaper ? 'paper' : 'other');
  const paperId = meta.paper_id ?? (kind === 'paper' ? inferredPaper : undefined);
  if (meta.kind === 'paper' && !meta.paper_id) problems.push(`${file}: a paper collection names its paper: add paper_id (the paper's ID in the paper index).`);
  if (meta.paper_id && options.paperIds && !options.paperIds.has(meta.paper_id)) problems.push(`${file}: paper_id ${meta.paper_id} is not in the paper index; add the paper first.`);
  if (meta.paper_id && meta.kind && meta.kind !== 'paper') problems.push(`${file}: paper_id is for kind: paper; remove it or change the kind.`);
  if (meta.kind === 'paper' && meta.paper_id) {
    for (const node of nodes) {
      const paper = citedPaper(node);
      if (!paper) problems.push(`${node.file}: collection ${name} is from paper ${meta.paper_id}; cite it (source kind paper, paper_id ${meta.paper_id}, and the location).`);
      else if (paper !== meta.paper_id) problems.push(`${node.file}: collection ${name} is from paper ${meta.paper_id}, but this result cites ${paper}; move it to that paper's collection or fix the source.`);
    }
  }
  return {
    name, kind, declared: Boolean(meta.kind), ...(meta.title ? { title: meta.title } : {}), ...(paperId ? { paperId } : {}),
    results: nodes.length,
    approved: nodes.filter((node) => node.status === 'approved').length,
    drafts: nodes.filter((node) => node.status === 'draft').map((node) => node.id),
    problems,
  };
}

export interface CollectionRemovePlan {
  ok: boolean;
  name: string;
  conflicts: string[];
  warnings: string[];
  deletes: string[];
  /** The paper the collection came from; it stays in the paper index and the bibliography. */
  paperId?: string;
}

/**
 * Remove a whole collection: its results, collection.md, and their approval
 * records. Results elsewhere that still use one block it. The paper stays:
 * it was indexed before the extraction, may carry the researcher's notes and
 * PDF, and is removed (if at all) from Papers.
 */
export function planCollectionRemove(
  summary: Pick<CollectionSummary, 'name' | 'paperId'>,
  nodes: CollectionNode[],
  options: { references: Map<string, string[]>; metaFile?: string; approvalFiles?: string[] },
): CollectionRemovePlan {
  const conflicts: string[] = [];
  for (const node of nodes) {
    const users = options.references.get(node.id) ?? [];
    if (users.length) conflicts.push(`${node.id} is still used by ${users.join(', ')}.`);
  }
  const warnings = summary.paperId ? [`The paper ${summary.paperId} stays in Papers and in the bibliography; remove it there if this project no longer needs it.`] : [];
  return {
    ok: !conflicts.length, name: summary.name, conflicts, warnings,
    deletes: [...nodes.map((node) => node.file), ...(options.metaFile ? [options.metaFile] : []), ...(options.approvalFiles ?? [])],
    ...(summary.paperId ? { paperId: summary.paperId } : {}),
  };
}
