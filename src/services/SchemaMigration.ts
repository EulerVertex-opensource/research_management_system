import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { LoopFiles, researchDigest } from './ResearchLoopModel';
import { parseMarkdown } from './Frontmatter';
import { AssetInput, ordinalTitleFixes } from './AssetOrder';
import { planDefinitionMigration } from './DefinitionMigration';
import { MANAGED_LINK_BLOCK, ideaPlanProblems, resolveIdeaType, stripManagedLinkBlocks } from './ProofIdeas';
import { readApprovals, writeApprovals } from './ApprovalStore';
import { isLegacyProject, legacyRequiredResults } from '../domain/project';
import { sectionContent, sectionHeadings } from '../domain/sections';

/**
 * Upgrade a research project to the current schema in one pass:
 * definitions out of assets, plans out of ideas, then the current schema
 * (plans record success as a status; no stored `used_in`, numbered titles, or
 * managed link blocks; `source.kind: original`; project.md with
 * `required_results` frontmatter), then report broken idea and plan references.
 *
 * Steps run against `OverlayFiles`, so a preview and an apply are the same code
 * and nothing touches disk until `flush`.
 */

export interface MigrationReport { notes: string[]; review: string[] }
export interface FileChange { file: string; before?: string; after: string | null }

/** In-memory writes and deletes over a base file set. */
export class OverlayFiles implements LoopFiles {
  private readonly pending = new Map<string, string | null>();
  constructor(private readonly base: LoopFiles) {}

  async readFile(file: string): Promise<string> {
    if (this.pending.has(file)) {
      const value = this.pending.get(file);
      if (value === null || value === undefined) throw new Error(`ENOENT: ${file}`);
      return value;
    }
    return this.base.readFile(file);
  }
  async writeFile(file: string, content: string): Promise<void> { this.pending.set(file, content); }
  async deleteFile(file: string): Promise<void> { this.pending.set(file, null); }
  async exists(file: string): Promise<boolean> {
    return this.pending.has(file) ? this.pending.get(file) !== null : this.base.exists(file);
  }
  async listFiles(dir: string, extension = '.md'): Promise<string[]> {
    const listed = new Set(await this.base.listFiles(dir, extension));
    for (const [file, value] of this.pending) {
      if (path.posix.dirname(file) !== dir || !file.endsWith(extension)) continue;
      if (value === null) listed.delete(file); else listed.add(file);
    }
    return [...listed].sort();
  }

  /** Net changes against the base, skipping writes that leave a file as it was. */
  async changes(): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for (const [file, after] of [...this.pending].sort(([a], [b]) => a.localeCompare(b))) {
      const before = await this.base.readFile(file).catch(() => undefined);
      if (after === null ? before === undefined : before === after) continue;
      changes.push({ file, before, after });
    }
    return changes;
  }

  async flush(): Promise<FileChange[]> {
    const changes = await this.changes();
    for (const change of changes) {
      if (change.after !== null) await this.base.writeFile(change.file, change.after);
    }
    for (const change of changes) {
      if (change.after !== null) continue;
      if (this.base.deleteFile) await this.base.deleteFile(change.file);
      else throw new Error(`Cannot delete ${change.file} here; remove it by hand.`);
    }
    this.pending.clear();
    return changes;
  }
}

const idOf = (file: string) => path.posix.basename(file, '.md');
const ORDINAL_TITLE = /^title:\s*["']?\d{3,}\. /m;
/** `  kind: self_proved` under `source:`; renamed to `original`. */
const LEGACY_SOURCE_LINE = /^[ \t]+kind:[ \t]*self_proved[ \t]*$/m;

async function readAll(files: LoopFiles, folder: string): Promise<Array<{ file: string; raw: string }>> {
  return Promise.all((await files.listFiles(folder)).map(async (file) => ({ file, raw: await files.readFile(file) })));
}

function frontmatterBlock(raw: string): { block: string; start: number; end: number } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  return match ? { block: match[1], start: match[0].indexOf(match[1]), end: match[0].indexOf(match[1]) + match[1].length } : undefined;
}

/** Edit frontmatter lines in place so a migration diff shows only the fields it changes. */
function editFrontmatter(raw: string, edit: (lines: string[]) => string[]): string {
  const front = frontmatterBlock(raw);
  if (!front) return raw;
  const lines = edit(front.block.split(/\r?\n/));
  return raw.slice(0, front.start) + lines.join('\n') + raw.slice(front.end);
}

function removeKey(lines: string[], key: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!new RegExp(`^${key}:`).test(lines[index])) { out.push(lines[index]); continue; }
    while (index + 1 < lines.length && /^(\s+|-\s)/.test(lines[index + 1])) index++;
  }
  return out;
}

function setKey(lines: string[], key: string, value: string): string[] {
  const at = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (at >= 0) {
    let next = at + 1;
    while (next < lines.length && /^(\s+|-\s)/.test(lines[next])) next++;
    return [...lines.slice(0, at), `${key}: ${value}`, ...lines.slice(next)];
  }
  const typeLine = lines.findIndex((line) => /^type:/.test(line));
  return [...lines.slice(0, typeLine + 1), `${key}: ${value}`, ...lines.slice(typeLine + 1)];
}

/** Why a project needs `migrate`; empty when it is current. */
export async function migrationReasons(files: LoopFiles, paths: ProjectPaths): Promise<string[]> {
  const reasons = new Set<string>();
  const project = await files.readFile(paths.projectMd).catch(() => '');
  if (project.trim() && isLegacyProject(project)) reasons.add('project.md predates required_results frontmatter');
  for (const { raw } of await readAll(files, paths.assets)) {
    if (/^type:\s*definition\s*$/m.test(raw)) reasons.add('definitions stored under assets');
    if (ORDINAL_TITLE.test(raw)) reasons.add('numbered titles');
    if (/^used_in:/m.test(raw)) reasons.add('stored used_in lists');
  }
  for (const { raw } of await readAll(files, paths.definitions)) {
    if (ORDINAL_TITLE.test(raw)) reasons.add('numbered titles');
    if (/^used_in:/m.test(raw)) reasons.add('stored used_in lists');
  }
  for (const { raw } of await readAll(files, paths.ideas)) {
    if (/^type:\s*proof_record\s*$/m.test(raw) || /^target_asset:/m.test(raw)) reasons.add('plans stored under ideas');
    if (/^kind:/m.test(raw)) reasons.add('ideas with a legacy kind field');
  }
  for (const { raw } of await readAll(files, paths.plans)) if (/^type:\s*proof_record\s*$/m.test(raw)) reasons.add('proof_record files');
  for (const folder of [paths.assets, paths.definitions, paths.ideas, paths.plans]) {
    for (const { raw } of await readAll(files, folder)) {
      if (new RegExp(MANAGED_LINK_BLOCK.source).test(raw)) reasons.add('managed link blocks in node files');
      if (LEGACY_SOURCE_LINE.test(raw)) reasons.add('source.kind self_proved');
    }
  }
  return [...reasons];
}

async function moveDefinitionsOutOfAssets(files: LoopFiles, paths: ProjectPaths, report: MigrationReport): Promise<void> {
  const inputs = async (folder: string): Promise<AssetInput[]> => (await readAll(files, folder)).map(({ file, raw }) => ({ id: idOf(file), raw }));
  const [assets, definitions, ideas] = await Promise.all([inputs(paths.assets), inputs(paths.definitions), inputs(paths.ideas)]);
  if (!assets.some((item) => /^type:\s*definition\s*$/m.test(item.raw))) return;
  const plan = planDefinitionMigration(assets, definitions, ideas);
  const original = new Map(assets.map((item) => [item.id, item.raw]));
  for (const item of plan.updatedAssets) if (item.raw !== original.get(item.id)) await files.writeFile(`${paths.assets}/${item.id}.md`, item.raw);
  for (const item of plan.moved) {
    await files.writeFile(`${paths.definitions}/${item.id}.md`, item.raw);
    await files.deleteFile!(`${paths.assets}/${item.id}.md`);
    report.review.push(`${paths.definitions}/${item.id}.md: moved from assets; confirm it is a commonly used definition and keep project-specific conditions as linked remark assets.`);
  }
  report.review.push(...plan.review);
}

async function movePlansOutOfIdeas(files: LoopFiles, paths: ProjectPaths, report: MigrationReport): Promise<void> {
  const all = [...await readAll(files, paths.assets), ...await readAll(files, paths.definitions), ...await readAll(files, paths.ideas), ...await readAll(files, paths.plans)];
  const moves = new Map<string, string>();
  for (const { file, raw } of all.filter((item) => path.posix.dirname(item.file) === paths.ideas)) {
    let data: Record<string, unknown>;
    try { data = parseMarkdown(raw).data; } catch { report.review.push(`${file}: invalid YAML; left in place.`); continue; }
    if (resolveIdeaType(data) === 'plan') {
      const destination = `${paths.plans}/${path.posix.basename(file)}`;
      if (all.some((item) => item.file === destination)) throw new Error(`${file}: cannot move to ${destination}, which already exists.`);
      moves.set(file, destination);
    } else if (data.type !== 'idea' || resolveIdeaType(data) !== 'idea') {
      report.review.push(`${file}: unsupported or uncertain idea metadata; left in place.`);
    }
  }
  for (const { file, raw } of all) {
    const nextPath = moves.get(file) ?? file;
    // Rebase ordinary relative links whose source or target moved.
    let updated = raw.replace(/(\[[^\]\n]+\]\()([^)\n]+)(\))/g, (full, open: string, href: string, close: string) => {
      if (/^(?:[a-z]+:|#|\/)/i.test(href)) return full;
      const [target, suffix = ''] = href.split(/(?=[#?])/u, 2);
      const oldTarget = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      const newTarget = moves.get(oldTarget) ?? oldTarget;
      if (nextPath === file && newTarget === oldTarget) return full;
      const relative = path.posix.relative(path.posix.dirname(nextPath), newTarget);
      return `${open}${relative.startsWith('.') ? relative : `./${relative}`}${suffix}${close}`;
    });
    if (moves.has(file)) updated = editFrontmatter(updated, (lines) => removeKey(/^type:\s*idea\s*$/m.test(updated) ? setKey(lines, 'type', 'plan') : lines, 'kind'));
    else if (path.posix.dirname(file) === paths.ideas && /^kind:\s*direction\s*$/m.test(updated)) updated = editFrontmatter(updated, (lines) => setKey(removeKey(lines, 'kind'), 'idea_kind', 'approach'));
    if (nextPath !== file) { await files.writeFile(nextPath, updated); await files.deleteFile!(file); }
    else if (updated !== raw) await files.writeFile(file, updated);
  }
  if (moves.size) report.notes.push(`Moved ${moves.size} plan file(s) from ${paths.ideas}/ to ${paths.plans}/.`);
}

async function upgradeNodes(files: LoopFiles, paths: ProjectPaths, report: MigrationReport): Promise<void> {
  let records = 0; let titles = 0; let usedIn = 0; let questions = 0; let sources = 0; let blocks = 0;
  for (const folder of [paths.assets, paths.definitions]) {
    const nodes = await readAll(files, folder);
    for (const change of ordinalTitleFixes(nodes.map(({ file, raw }) => ({ id: idOf(file), raw })))) {
      await files.writeFile(`${folder}/${change.id}.md`, change.raw);
      titles++;
    }
  }
  for (const folder of [paths.assets, paths.definitions, paths.ideas, paths.plans]) {
    for (const { file, raw } of await readAll(files, folder)) {
      let updated = raw;
      if (/^used_in:/m.test(updated)) { updated = editFrontmatter(updated, (lines) => removeKey(lines, 'used_in')); usedIn++; }
      if (LEGACY_SOURCE_LINE.test(updated)) { updated = editFrontmatter(updated, (lines) => lines.map((line) => line.replace(/^([ \t]+kind:[ \t]*)self_proved([ \t]*)$/, '$1original$2'))); sources++; }
      const withoutBlocks = stripManagedLinkBlocks(updated);
      if (withoutBlocks !== updated) { updated = withoutBlocks; blocks++; }
      if (folder === paths.plans && /^type:\s*proof_record\s*$/m.test(updated)) {
        updated = editFrontmatter(updated, (lines) => setKey(setKey(lines, 'type', 'plan'), 'status', 'succeeded'));
        records++;
      }
      if (folder === paths.ideas) {
        let data: Record<string, unknown> = {};
        try { data = parseMarkdown(updated).data; } catch { /* reported by validate */ }
        if (data.idea_kind === undefined && Array.isArray(data.tags) && data.tags.includes('open-question')) {
          updated = editFrontmatter(updated, (lines) => setKey(lines, 'idea_kind', 'question'));
          questions++;
        }
      }
      if (updated !== raw) await files.writeFile(file, updated);
    }
  }
  if (records) report.notes.push(`${records} proof_record file(s) became plans with status succeeded.`);
  if (titles) report.notes.push(`Removed dependency numbers from ${titles} title(s); the dashboard and \`validate\` show the order.`);
  if (usedIn) report.notes.push(`Dropped stored used_in from ${usedIn} file(s); reverse links are derived.`);
  if (questions) report.notes.push(`Marked ${questions} open-question idea(s) as idea_kind: question.`);
  if (sources) report.notes.push(`Renamed source.kind self_proved to original in ${sources} file(s); approvals are unaffected.`);
  if (blocks) report.notes.push(`Removed managed link blocks from ${blocks} file(s); the dashboard derives plan and idea lists.`);
}

/** Schema-1 project.md → frontmatter `required_results` and the contract sections, keeping every paragraph. */
export function upgradeProjectText(raw: string): { text: string; review: string[] } {
  const review: string[] = [];
  const required = legacyRequiredResults(raw);
  const title = /^# .+$/m.exec(raw)?.[0] ?? '# Project';
  const section = (heading: string) => sectionContent(raw, heading);
  const templateNote = /^List one stable asset ID per bullet[^\n]*$/m;
  const requiredProse = section('Required Results').split(/\r?\n/).filter((line) => line.trim() && !/^\s*-\s/.test(line) && !templateNote.test(line)).join('\n');
  const legacyNotes = [
    ['Known Results', section('Known Results')],
    ['Open Questions', section('Open Questions')],
    ['Writing Status', section('Writing Status')],
    ['Required Results (notes)', requiredProse],
  ].filter(([, text]) => text) as Array<[string, string]>;
  const known = new Set(['Main Problem', 'Background', 'Current Goals', 'Required Results', 'Known Results', 'Open Questions', 'Writing Status']);
  const extra = sectionHeadings(raw).filter((heading) => !known.has(heading));
  const background = [section('Background'), ...legacyNotes.map(([heading, text]) => `### Earlier notes: ${heading}\n\n${text}`)].filter(Boolean).join('\n\n');
  if (section('Current Goals')) review.push('project.md: ## Current Goals became ## Intended Contribution; check the wording and fill ## Scope and Assumptions.');
  if (legacyNotes.length) review.push(`project.md: ${legacyNotes.map(([heading]) => heading).join(', ')} moved under ## Background; the dashboard now derives known results, open questions (question ideas), and writing status, so turn open questions into ideas and trim what is redundant.`);
  const frontmatter = ['---', 'type: project', 'schema_version: 2', required.length ? 'required_results:' : 'required_results: []',
    ...required.flatMap((item) => [`  - id: ${item.id}`, ...(item.role ? [`    role: ${JSON.stringify(item.role)}`] : [])]), '---'].join('\n');
  const body = [
    title,
    ...[['Main Problem', section('Main Problem')], ['Scope and Assumptions', ''], ['Intended Contribution', section('Current Goals')], ['Background', background],
      ...extra.map((heading) => [heading, section(heading)])]
      .map(([heading, text]) => `## ${heading}${text ? `\n\n${text}` : ''}`),
  ].join('\n\n');
  return { text: `${frontmatter}\n\n${body}\n`, review };
}

async function upgradeProject(files: LoopFiles, paths: ProjectPaths, report: MigrationReport): Promise<void> {
  const raw = await files.readFile(paths.projectMd).catch(() => '');
  if (!raw.trim() || !isLegacyProject(raw)) return;
  const { text, review } = upgradeProjectText(raw);
  await files.writeFile(paths.projectMd, text);
  report.notes.push('project.md now lists required results in frontmatter.');
  report.review.push(...review);
  // Carry a still-valid project approval over to the new digest; never approve anything that was not approved.
  const approvals = await readApprovals(files, paths.researchRoot);
  const record = approvals.records.find((item) => item.kind === 'project' && item.target === 'project');
  if (!record) return;
  if (record.digest === researchDigest(raw, 'project')) {
    record.digest = researchDigest(text, 'project');
    await writeApprovals(files, paths.researchRoot, approvals);
    report.notes.push('Carried the project approval over to the new project.md layout.');
  } else {
    report.review.push('project.md: its approval was already stale before migration; the researcher must approve the project again.');
  }
}

/** Run every migration step on `files` (use an OverlayFiles to preview). Throws before writing when a step cannot proceed safely. */
export async function migrateProject(files: LoopFiles, paths: ProjectPaths): Promise<MigrationReport> {
  const report: MigrationReport = { notes: [], review: [] };
  await moveDefinitionsOutOfAssets(files, paths, report);
  await movePlansOutOfIdeas(files, paths, report);
  await upgradeNodes(files, paths, report);
  await upgradeProject(files, paths, report);
  report.review.push(...ideaPlanProblems((await readAll(files, paths.assets)).map(({ file, raw }) => ({ filePath: file, raw })), [...await readAll(files, paths.ideas), ...await readAll(files, paths.plans)].map(({ file, raw }) => ({ filePath: file, raw }))));
  return report;
}
