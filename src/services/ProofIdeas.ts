import * as path from 'path';
import matter from 'gray-matter';
import { FileService } from './FileService';

const ASSET_START = '<!-- research-assistant:proof-ideas:start -->';
const ASSET_END = '<!-- research-assistant:proof-ideas:end -->';
const IDEA_START = '<!-- research-assistant:idea-links:start -->';
const IDEA_END = '<!-- research-assistant:idea-links:end -->';
const ASSET_TYPES = new Set(['theorem', 'lemma', 'proposition', 'example', 'construction', 'remark']);

export interface ProofIdeaFile { filePath: string; raw: string }
export interface ProofIdeaChange { filePath: string; before: string; after: string }
type ParsedIdea = ProofIdeaFile & { id: string; data: Record<string, unknown>; body: string; role?: 'idea' | 'plan' };
type AssetGroups = { pending: ParsedIdea[]; failed: ParsedIdea[]; records: ParsedIdea[]; draft: ParsedIdea[]; archived: ParsedIdea[] };

export function resolveIdeaType(data: Record<string, unknown>): 'idea' | 'plan' | undefined {
  if (data.type === 'plan') return 'plan';
  if (data.type !== 'idea') return undefined;
  if (data.kind === 'direction') return 'idea';
  if (data.kind === 'proof_plan') return 'plan';
  if (data.kind !== undefined) return undefined;
  if (typeof data.target_asset === 'string' && (data.status === 'pending' || data.status === 'failed')) return 'plan';
  if (!data.target_asset && (data.status === 'draft' || data.status === 'archived')) return 'idea';
  return undefined;
}

export function hasSectionContent(body: string, heading: string): boolean {
  const match = new RegExp(`^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(body);
  return Boolean(match && match[1].trim());
}

function relativeLink(source: string, target: string): string {
  const link = path.posix.relative(path.posix.dirname(source), target);
  return link.startsWith('.') ? link : `./${link}`;
}

function label(file: ProofIdeaFile): string {
  return String(matter(file.raw).data.title ?? path.posix.basename(file.filePath, '.md')).replace(/[\[\]\r\n]/g, ' ');
}

function list(source: string, files: ParsedIdea[]): string {
  return [...files].sort((a, b) => a.filePath.localeCompare(b.filePath))
    .map((file) => `- [${label(file)}](${relativeLink(source, file.filePath)})`).join('\n') || '- None.';
}

function upsert(raw: string, startMark: string, endMark: string, section: string | null): string | null {
  const start = raw.indexOf(startMark);
  const end = raw.indexOf(endMark);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) return null;
  if (start >= 0) {
    if (section) return raw.slice(0, start) + section + raw.slice(end + endMark.length);
    return raw.slice(0, start).trimEnd() + '\n' + raw.slice(end + endMark.length).replace(/^\s*/, '');
  }
  return section ? raw.trimEnd() + '\n\n' + section + '\n' : raw;
}

/** Plan changes to managed link sections, keeping mathematical prose and frontmatter intact. */
export function planProofIdeaLinks(assets: ProofIdeaFile[], ideas: ProofIdeaFile[]): { changes: ProofIdeaChange[]; issues: string[] } {
  const issues: string[] = [];
  const actualAssets = assets.filter((asset) => {
    try { return ASSET_TYPES.has(matter(asset.raw).data.type); }
    catch { issues.push(`${asset.filePath}: invalid YAML`); return false; }
  });
  const assetById = new Map(actualAssets.map((a) => [path.posix.basename(a.filePath, '.md'), a]));
  const parsed: ParsedIdea[] = [];
  for (const idea of ideas) {
    try {
      const result = matter(idea.raw);
      if (result.data.type !== 'idea' && result.data.type !== 'plan' && result.data.type !== 'proof_record') continue;
      parsed.push({ ...idea, id: path.posix.basename(idea.filePath, '.md'), data: result.data, body: result.content, role: resolveIdeaType(result.data) });
    } catch { issues.push(`${idea.filePath}: invalid YAML`); }
  }
  const directions = new Map(parsed.filter((node) => node.role === 'idea' && (node.data.status === 'draft' || node.data.status === 'archived')).map((node) => [node.id, node]));
  const groups = new Map<string, AssetGroups>();
  const groupFor = (id: string): AssetGroups => {
    const group = groups.get(id) ?? { pending: [], failed: [], records: [], draft: [], archived: [] };
    groups.set(id, group);
    return group;
  };
  const changes: ProofIdeaChange[] = [];
  for (const node of parsed) {
    const { data, body } = node;
    const relatedLinks: string[] = [];
    if (node.role === 'idea') {
      if (data.status !== 'draft' && data.status !== 'archived') {
        issues.push(`${node.filePath}: direction status must be draft or archived`);
        continue;
      }
      if (data.target_asset !== undefined) issues.push(`${node.filePath}: directions cannot have target_asset`);
      if (data.related_assets !== undefined && !Array.isArray(data.related_assets)) issues.push(`${node.filePath}: related_assets must be an array`);
      const related = Array.isArray(data.related_assets) ? data.related_assets : [];
      for (const id of [...new Set(related)]) {
        const asset = typeof id === 'string' ? assetById.get(id) : undefined;
        if (!asset) { issues.push(`${node.filePath}: related_assets contains a missing asset: ${String(id)}`); continue; }
        groupFor(id)[data.status as 'draft' | 'archived'].push(node);
        relatedLinks.push(`- [${label(asset)}](${relativeLink(node.filePath, asset.filePath)})`);
      }
      const section = relatedLinks.length ? `${IDEA_START}\n## Related assets\n\n${relatedLinks.join('\n')}\n${IDEA_END}` : null;
      const after = upsert(node.raw, IDEA_START, IDEA_END, section);
      if (after === null) issues.push(`${node.filePath}: incomplete managed idea links section`);
      else if (after !== node.raw) changes.push({ filePath: node.filePath, before: node.raw, after });
      continue;
    }
    if (data.type !== 'proof_record' && node.role !== 'plan') {
      issues.push(`${node.filePath}: idea or plan type cannot be determined`);
      continue;
    }
    const target = data.target_asset;
    const asset = typeof target === 'string' ? assetById.get(target) : undefined;
    if (!asset) { issues.push(`${node.filePath}: target_asset is missing or does not name an asset`); continue; }
    if (node.role === 'plan' && data.status !== 'pending' && data.status !== 'failed') {
      issues.push(`${node.filePath}: proof plan status must be pending or failed`);
      continue;
    }
    if (node.role === 'plan' && (!/^## Goal\s*$/m.test(body) || !/^## Plan\s*$/m.test(body) || !/^## Verification\s*$/m.test(body) || !/^\d+\. \[[ xX]\] .+/m.test(body))) {
      issues.push(`${node.filePath}: plan needs Goal, Plan, Verification, and an ordered checklist`);
      continue;
    }
    if (node.role === 'plan' && data.status === 'failed' && !hasSectionContent(body, 'Failure')) {
      issues.push(`${node.filePath}: failed plan needs a Failure explanation`);
      continue;
    }
    if (data.type === 'proof_record' && (data.status !== undefined || !hasSectionContent(body, 'Outcome'))) {
      issues.push(`${node.filePath}: proof record needs no status and an Outcome section`);
      continue;
    }
    const backlink = relativeLink(node.filePath, asset.filePath);
    if (!body.includes(`](${backlink})`) && !body.includes(`](${backlink.replace(/^\.\//, '')})`)) {
      issues.push(`${node.filePath}: missing relative Markdown link to target asset`);
      continue;
    }
    groupFor(target as string)[data.type === 'proof_record' ? 'records' : data.status as 'pending' | 'failed'].push(node);
    if (data.inspired_by !== undefined && !Array.isArray(data.inspired_by)) issues.push(`${node.filePath}: inspired_by must be an array`);
    const origins = Array.isArray(data.inspired_by) ? [...new Set(data.inspired_by)] : [];
    for (const id of origins) {
      const direction = typeof id === 'string' ? directions.get(id) : undefined;
      if (!direction) { issues.push(`${node.filePath}: inspired_by contains a missing direction: ${String(id)}`); continue; }
      relatedLinks.push(`- [${label(direction)}](${relativeLink(node.filePath, direction.filePath)})`);
    }
    const section = relatedLinks.length ? `${IDEA_START}\n## Inspired by\n\n${relatedLinks.join('\n')}\n${IDEA_END}` : null;
    const after = upsert(node.raw, IDEA_START, IDEA_END, section);
    if (after === null) issues.push(`${node.filePath}: incomplete managed idea links section`);
    else if (after !== node.raw) changes.push({ filePath: node.filePath, before: node.raw, after });
  }
  for (const asset of actualAssets) {
    const group = groupFor(path.posix.basename(asset.filePath, '.md'));
    const section = `${ASSET_START}\n## Proof plans\n\n### Pending\n\n${list(asset.filePath, group.pending)}\n\n### Failed\n\n${list(asset.filePath, group.failed)}\n\n### Proof records\n\n${list(asset.filePath, group.records)}\n\n## Research directions\n\n### Draft directions\n\n${list(asset.filePath, group.draft)}\n\n### Archived directions\n\n${list(asset.filePath, group.archived)}\n${ASSET_END}`;
    const after = upsert(asset.raw, ASSET_START, ASSET_END, section);
    if (after === null) issues.push(`${asset.filePath}: incomplete managed Proof plans section`);
    else if (after !== asset.raw) changes.push({ filePath: asset.filePath, before: asset.raw, after });
  }
  return { changes, issues };
}

export async function syncProofIdeaLinks(fileService: FileService, assetFolder: string, ideaFolder: string, planFolder: string): Promise<{ updated: number; issues: string[] }> {
  const [assetPaths, ideaPaths, planPaths] = await Promise.all([
    fileService.listFiles(assetFolder, '.md'), fileService.listFiles(ideaFolder, '.md'), fileService.listFiles(planFolder, '.md'),
  ]);
  const read = async (filePath: string) => ({ filePath, raw: await fileService.readFile(filePath) });
  const [assets, ideas] = await Promise.all([Promise.all(assetPaths.map(read)), Promise.all([...ideaPaths, ...planPaths].map(read))]);
  const plan = planProofIdeaLinks(assets, ideas);
  for (const change of plan.changes) await fileService.writeFile(change.filePath, change.after);
  return { updated: plan.changes.length, issues: plan.issues };
}
