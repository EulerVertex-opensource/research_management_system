import * as crypto from 'crypto';
import { parseMarkdown } from '../services/Frontmatter';
import { LEGACY_SOURCE_KINDS } from './nodeKinds';
import { approvedProjectParts, projectSection, requiredResults } from './project';
import { sectionContent, statementPart, stripManagedBlocks } from './sections';

/**
 * Content digests of research files. Approval digests cover what a researcher
 * approves; component digests split a node (statement, proof, source) and the
 * project (problem, scope, contribution, required) so a manuscript binding can
 * go stale only when the part it presents changes. Node-only: uses crypto.
 */

export const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export function normalizeProse(text: string): string {
  return stripManagedBlocks(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Frontmatter keys a digest ignores: presentation, lifecycle, and fields older schemas stored. */
const UNAPPROVED_KEYS = ['status', 'title', 'used_in', 'tags', 'proof_digest', 'resolved_by'];

/** Frontmatter as a digest sees it: unapproved keys dropped, legacy names mapped so a rename never invalidates an approval. */
export function approvedData(data: Record<string, any>): Record<string, any> {
  const result = { ...data };
  for (const key of UNAPPROVED_KEYS) delete result[key];
  if (result.source && typeof result.source === 'object' && LEGACY_SOURCE_KINDS[result.source.kind]) result.source = { ...result.source, kind: LEGACY_SOURCE_KINDS[result.source.kind] };
  return result;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  return value;
}

const canonical = (value: unknown) => JSON.stringify(sortKeys(value) ?? null);

/** Digest of the parts of a node or the project that a researcher approves. */
export function researchDigest(raw: string, kind: 'project' | 'asset' | 'definition'): string {
  if (kind === 'project') {
    return sha(approvedProjectParts(raw).map(normalizeProse).join('\n'));
  }
  const parsed = parseMarkdown(raw);
  return sha(canonical(approvedData(parsed.data)) + '\n' + normalizeProse(parsed.content));
}

/** Digest of the statement alone; changes here invalidate dependants and freeze proofs. */
export function statementDigest(raw: string): string {
  const parsed = parseMarkdown(raw);
  return sha(canonical(approvedData(parsed.data)) + '\n' + normalizeProse(statementPart(parsed.content)));
}

/** Digest of an asset's `## Proof`, stamped on the plan that produced it so a later edit marks that plan outdated. */
export function proofDigest(raw: string): string { return sha(normalizeProse(sectionContent(parseMarkdown(raw).content, 'Proof'))); }

/** The parts of a node a manuscript can present; `source` is the citation (paper and location). */
export const ASSET_COMPONENTS = ['statement', 'proof', 'source'] as const;
export type AssetComponent = typeof ASSET_COMPONENTS[number];

/**
 * Component digests of an asset or definition. Unlike statementDigest, the
 * statement component leaves out `source`, so moving a citation does not make
 * a presented statement stale.
 */
export function assetComponents(raw: string): Record<AssetComponent, string> {
  const parsed = parseMarkdown(raw);
  const { source, ...rest } = approvedData(parsed.data);
  return {
    statement: sha(canonical(rest) + '\n' + normalizeProse(statementPart(parsed.content))),
    proof: proofDigest(raw),
    source: sha(canonical(source)),
  };
}

/** The parts of project.md a manuscript section can depend on; rhetorical sections bind to these. */
export const PROJECT_FACETS = ['problem', 'scope', 'contribution', 'required'] as const;
export type ProjectFacet = typeof PROJECT_FACETS[number];

export function projectFacets(raw: string): Record<ProjectFacet, string> {
  const section = (heading: string) => sha(normalizeProse(projectSection(raw, heading)));
  return {
    problem: section('Main Problem'),
    scope: section('Scope and Assumptions'),
    contribution: section('Intended Contribution'),
    required: sha(canonical(requiredResults(raw))),
  };
}
