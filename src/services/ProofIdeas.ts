import * as path from 'path';
import { parseMarkdown } from './Frontmatter';
import { ASSET_TYPES, INACTIVE_STATUSES } from '../domain/nodeKinds';
import { planProblems } from '../domain/schema';

/**
 * Relations between ideas, plans, and assets are stored only as forward
 * frontmatter (`related_assets`, `target_asset`, `inspired_by`); lists of an
 * asset's plans and ideas are derived where they are shown (dashboard,
 * `research-loop show`). This module checks those references.
 */

export interface ProofIdeaFile { filePath: string; raw: string }

/** Link blocks older versions wrote into node bodies; derived data, removed by `research-maintenance migrate`. */
export const MANAGED_LINK_BLOCK = /\n*<!-- research-assistant:(?:proof-ideas|idea-links):start -->[\s\S]*?<!-- research-assistant:(?:proof-ideas|idea-links):end -->\n?/g;

export function stripManagedLinkBlocks(raw: string): string {
  const stripped = raw.replace(MANAGED_LINK_BLOCK, '\n\n');
  return stripped === raw ? raw : `${stripped.trimEnd()}\n`;
}

/** Idea or plan role, including schema-1 files (ideas with kind, proof_record) until they are migrated. */
export function resolveIdeaType(data: Record<string, unknown>): 'idea' | 'plan' | undefined {
  if (data.type === 'plan' || data.type === 'proof_record') return 'plan';
  if (data.type !== 'idea') return undefined;
  if (data.kind === 'direction') return 'idea';
  if (data.kind === 'proof_plan') return 'plan';
  if (data.kind !== undefined) return undefined;
  if (typeof data.target_asset === 'string' && (data.status === 'pending' || data.status === 'failed')) return 'plan';
  if (!data.target_asset && (data.status === 'draft' || data.status === 'resolved' || data.status === 'archived')) return 'idea';
  return undefined;
}

/** Problems with the references between ideas, plans, and assets, one line per problem, prefixed with the file. */
export function ideaPlanProblems(assets: ProofIdeaFile[], ideasAndPlans: ProofIdeaFile[]): string[] {
  const issues: string[] = [];
  const assetStatus = new Map<string, string>();
  for (const asset of assets) {
    try {
      const data = parseMarkdown(asset.raw).data;
      if (ASSET_TYPES.has(data.type)) assetStatus.set(path.posix.basename(asset.filePath, '.md'), String(data.status));
    } catch { issues.push(`${asset.filePath}: invalid YAML`); }
  }
  const parsed: Array<ProofIdeaFile & { id: string; data: Record<string, any>; body: string }> = [];
  for (const file of ideasAndPlans) {
    try { const result = parseMarkdown(file.raw); parsed.push({ ...file, id: path.posix.basename(file.filePath, '.md'), data: result.data, body: result.content }); }
    catch { issues.push(`${file.filePath}: invalid YAML`); }
  }
  const ideas = new Set(parsed.filter((node) => resolveIdeaType(node.data) === 'idea').map((node) => node.id));
  for (const node of parsed) {
    const role = resolveIdeaType(node.data);
    if (role === 'idea') {
      if (node.data.target_asset !== undefined) issues.push(`${node.filePath}: ideas cannot have target_asset; write a plan instead`);
      if (node.data.related_assets !== undefined && !Array.isArray(node.data.related_assets)) issues.push(`${node.filePath}: related_assets must be an array`);
      for (const id of Array.isArray(node.data.related_assets) ? node.data.related_assets : []) {
        if (!assetStatus.has(String(id))) issues.push(`${node.filePath}: related_assets contains a missing asset: ${String(id)}`);
      }
      continue;
    }
    if (role !== 'plan') { issues.push(`${node.filePath}: idea or plan type cannot be determined`); continue; }
    const target = node.data.target_asset;
    if (typeof target !== 'string' || !assetStatus.has(target)) { issues.push(`${node.filePath}: target_asset is missing or does not name an asset`); continue; }
    // Schema-1 proof records read as succeeded plans; migration rewrites them.
    const status = node.data.type === 'proof_record' ? 'succeeded' : node.data.status;
    const problem = planProblems(node.id, { ...node.data, type: 'plan', status }, node.body)[0];
    if (problem) issues.push(`${node.filePath}: ${problem.slice(node.id.length + 2)}`);
    if (status === 'pending' && INACTIVE_STATUSES.has(assetStatus.get(target)!)) issues.push(`${node.filePath}: pending plan targets ${assetStatus.get(target)} asset ${target}; set it abandoned with an ## Outcome`);
    if (node.data.inspired_by !== undefined && !Array.isArray(node.data.inspired_by)) issues.push(`${node.filePath}: inspired_by must be an array`);
    for (const id of Array.isArray(node.data.inspired_by) ? node.data.inspired_by : []) {
      if (!ideas.has(String(id))) issues.push(`${node.filePath}: inspired_by contains a missing idea: ${String(id)}`);
    }
  }
  return issues;
}
