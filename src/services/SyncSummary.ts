import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { parseMarkdown } from './Frontmatter';
import { NameStatus } from './LoopGit';
import { SharedFolders, statementDigest } from './ResearchLoopModel';
import { parseLog } from './ResearchRecords';
import { hasSection, sectionContent } from '../domain/sections';
import { locateNodeFile } from '../domain/registry';

/**
 * Turn a git name-status diff of the research folders into lines a
 * mathematician reads: which results appeared, which statements changed,
 * which plans failed, who decided what. Pure apart from the two readers.
 */

export interface SummaryContext {
  paths: ProjectPaths;
  shared: SharedFolders;
  before(file: string): Promise<string | undefined>;
  after(file: string): Promise<string | undefined>;
}

function front(raw: string | undefined): { data: Record<string, any>; content: string } | undefined {
  if (raw === undefined) return undefined;
  try { const parsed = parseMarkdown(raw); return { data: parsed.data, content: parsed.content }; } catch { return undefined; }
}

const id = (file: string) => path.posix.basename(file, path.posix.extname(file));
const firstLine = (text: string) => text.trim().split('\n').find((line) => line.trim())?.trim().slice(0, 120) ?? '';

export async function summarizeResearchChanges(changes: NameStatus[], context: SummaryContext): Promise<string[]> {
  const { paths, shared } = context;
  const lines: string[] = [];
  const other: string[] = [];
  const folderOf = (file: string) => path.posix.dirname(file);
  for (const change of changes) {
    const file = change.path;
    const folder = folderOf(file);
    const before = change.status === 'A' ? undefined : await context.before(change.from ?? file);
    const after = change.status === 'D' ? undefined : await context.after(file);
    const old = front(before); const now = front(after);
    const name = id(file);
    const location = locateNodeFile(file, paths);
    if (location) {
      const kind = `${location.origin === 'library' ? 'library ' : ''}${location.kind === 'definition' ? 'definition' : String(now?.data.type ?? old?.data.type ?? 'asset')}`;
      if (change.status === 'D') { lines.push(`Removed ${kind} ${name}.`); continue; }
      if (change.status === 'A' || !old) { lines.push(`New ${String(now?.data.status ?? 'draft')} ${kind} ${name}${now?.data.title ? ` (${String(now.data.title)})` : ''}.`); continue; }
      const parts: string[] = [];
      if (before && after && statementDigest(before) !== statementDigest(after)) parts.push('statement changed');
      else if (old.content !== now?.content) parts.push(hasSection(now?.content ?? '', 'Proof') ? 'proof updated' : 'text edited');
      if (old.data.status !== now?.data.status) parts.push(`${String(old.data.status)} → ${String(now?.data.status)}`);
      lines.push(`${kind[0].toUpperCase()}${kind.slice(1)} ${name}: ${parts.join(', ') || 'metadata changed'}.`);
    } else if (folder === paths.plans) {
      if (change.status === 'D') { lines.push(`Removed plan ${name}.`); continue; }
      const target = String(now?.data.target_asset ?? '?');
      const succeeded = (front: typeof now) => front?.data.status === 'succeeded' || front?.data.type === 'proof_record';
      if (succeeded(now)) { if (!succeeded(old)) lines.push(`Plan ${name} succeeded: proof of ${target} recorded.`); continue; }
      if (now?.data.status === 'failed' && old?.data.status !== 'failed') lines.push(`Failed plan ${name} for ${target}: ${firstLine(sectionContent(now.content, 'Failure'))}`);
      else if (change.status === 'A') lines.push(`New ${String(now?.data.status ?? '')} plan ${name} for ${target}.`);
    } else if (folder === paths.ideas) {
      if (change.status === 'A') lines.push(`New idea ${name}: ${String(now?.data.title ?? '')}.`);
    } else if (paths.remarks && folder === paths.remarks) {
      if (change.status === 'A') lines.push(`New remark on ${String(now?.data.target ?? '?')}: ${String(now?.data.title ?? '')}.`);
      else if (now?.data.status === 'archived' && old?.data.status !== 'archived') lines.push(`Remark on ${String(now.data.target ?? '?')} archived: ${String(now.data.title ?? '')}.`);
    } else if (folder === shared.checks) {
      if (change.status !== 'A') continue;
      if (now?.data.type === 'search_round') lines.push(`Search round ${String(now.data.round ?? '?')} on ${String(now.data.target_asset ?? '?')} by ${String(now.data.performed_by ?? 'unknown')}: ${firstLine(sectionContent(now.content, 'Obstructions')) || 'no obstructions recorded'}`);
      else lines.push(`Falsification check on ${String(now?.data.target_asset ?? '?')} by ${String(now?.data.performed_by ?? 'unknown')}: ${String(now?.data.outcome ?? '')}.`);
    } else if (folder === shared.candidates) {
      if (change.status === 'A') lines.push(`Search candidate ${name} for ${String(now?.data.target_asset ?? '?')}: ${String(now?.data.status ?? '')}${sectionContent(now?.content ?? '', 'Failure') ? ` — ${firstLine(sectionContent(now!.content, 'Failure'))}` : ''}.`);
      else if (now?.data.status === 'archived' && old?.data.status !== 'archived') lines.push(`Search candidate ${name} rejected by independent verification.`);
    } else if (folder === shared.log) {
      // A log only grows: what is new are the records the other side did not have.
      const seen = new Set(parseLog(before ?? '').map((record) => record.id));
      for (const record of parseLog(after ?? '').filter((item) => !seen.has(item.id))) {
        const by = String(record.performed_by ?? 'unknown');
        if (record.type === 'handoff') lines.push(`Handoff from ${by}${Array.isArray(record.working_on) && record.working_on.length ? ` (working on ${record.working_on.join(', ')})` : ''}.`);
        else if (record.type === 'decision' && record.kind === 'idea_update') lines.push(`Idea ${String(record.target)} updated by ${by}${record.idea?.status ? `: ${String(record.idea.status)}` : ''}.`);
        else if (record.type === 'decision') lines.push(`Decision (${String(record.kind)}) on ${String(record.target)} by ${by}: ${firstLine(String(record.text ?? ''))}`);
      }
    } else if (folder === shared.decisions) {
      if (change.status === 'A') lines.push(`Decision (${String(now?.data.kind ?? '?')}) on ${String(now?.data.target ?? '?')} by ${String(now?.data.performed_by ?? 'unknown')}: ${firstLine(now?.content ?? '')}`);
    } else if (folder === shared.handoffs) {
      if (change.status === 'A') lines.push(`Handoff from ${String(now?.data.performed_by ?? 'unknown')}${Array.isArray(now?.data.working_on) && now!.data.working_on.length ? ` (working on ${now!.data.working_on.join(', ')})` : ''}.`);
    } else if (file.startsWith(`${shared.approvals}/`) || file === path.posix.join(paths.researchRoot, 'approvals.json')) {
      if (file.endsWith('approvals.json')) continue;
      let record: Record<string, any> | undefined;
      try { record = after ? JSON.parse(after) : undefined; } catch { record = undefined; }
      if (change.status === 'D') lines.push(`Approval of ${name} withdrawn.`);
      else if (record) lines.push(`Approval of ${String(record.kind)} ${String(record.target)} recorded by ${String(record.performed_by ?? record.source ?? 'unknown')}.`);
    } else if (file === paths.projectMd) {
      lines.push('Project goals (project.md) changed.');
    } else if (file === paths.paperIndex) {
      const count = (raw: string | undefined) => (raw?.match(/^##\s+[a-z][a-z0-9_]*\s*$/gm) ?? []).length;
      const added = count(after) - count(before);
      lines.push(added > 0 ? `Paper index: ${added} new paper(s).` : 'Paper index edited.');
    } else other.push(file);
  }
  if (other.length) lines.push(`Other files changed: ${other.slice(0, 8).join(', ')}${other.length > 8 ? ` and ${other.length - 8} more` : ''}.`);
  return lines;
}
