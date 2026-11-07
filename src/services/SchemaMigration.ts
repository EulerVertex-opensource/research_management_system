import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { LoopFiles, researchDigest, sharedFolders, statementDigest } from './ResearchLoopModel';
import { parseMarkdown } from './Frontmatter';
import { AssetInput, ordinalTitleFixes } from './AssetOrder';
import { planDefinitionMigration } from './DefinitionMigration';
import { MANAGED_LINK_BLOCK, ideaPlanProblems, resolveIdeaType, stripManagedLinkBlocks } from './ProofIdeas';
import { readApprovals, writeApprovals } from './ApprovalStore';
import { isLegacyProject, legacyRequiredResults } from '../domain/project';
import { sectionContent, sectionHeadings } from '../domain/sections';
import { SCHEMA_VERSION, definitionTitle } from '../domain/nodeKinds';
import { assetComponents } from '../domain/digests';
import { remarkTargetDigest } from '../domain/remarks';
import { REMARKS_BLOCK_PATTERN, remarksOf } from '../domain/revisions';

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
  async listDirs(dir: string): Promise<string[]> { return this.base.listDirs ? this.base.listDirs(dir) : []; }

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
  for (const { raw } of [...await readAll(files, paths.assets), ...await readAll(files, paths.definitions)]) if (REMARKS_BLOCK_PATTERN.test(raw)) reasons.add('remarks stored inside result files');
  for (const { raw } of await readAll(files, paths.assets)) {
    if (/^type:\s*remark\s*$/m.test(raw)) reasons.add('remark assets (type: remark) to sort into assumptions, conventions, results, and remarks');
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
    report.review.push(`${paths.definitions}/${item.id}.md: moved from assets; confirm it defines a concept a result uses, or mark a standing assumption or convention with definition_kind.`);
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
  const frontmatter = ['---', 'type: project', `schema_version: ${SCHEMA_VERSION}`, required.length ? 'required_results:' : 'required_results: []',
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

// ---------- schema 3: remarks become annotations; remark assets are sorted ----------

/** How the researcher sorted one `type: remark` asset (see `migrate --remarks`). */
export interface RemarkClassification {
  as: 'assumption' | 'convention' | 'lemma' | 'proposition' | 'example' | 'remark';
  /** For `remark`: the result or definition it annotates. */
  target?: string;
  /** For `remark`: whose it is; researcher by default. */
  origin?: 'researcher' | 'agent';
}
export type RemarkMigrationPlan = Record<string, RemarkClassification>;
export const REMARK_CLASSES = ['assumption', 'convention', 'lemma', 'proposition', 'example', 'remark'] as const;

export interface MigrationOptions {
  /** How each remark asset is sorted; remark assets it leaves out stay in place and are listed for review. */
  remarkPlan?: RemarkMigrationPlan;
  /** Timestamp for remarks the migration writes. */
  now?: string;
}

/** What one migration run must not carry over, and the files it removed. */
interface CarryState { noCarry: Set<string>; removed: Set<string> }

const remarkIdFor = (source: string) => `remark_${source.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
const listOf = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

function remarkFile(paths: ProjectPaths, id: string, data: Record<string, unknown>, body: string): { file: string; raw: string } {
  const lines = ['---', ...Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', '', body.trim(), ''];
  return { file: `${paths.remarks}/${id}.md`, raw: lines.join('\n') };
}

/** The file of a project asset or definition by ID, as the migration has it now. */
async function nodeFile(files: LoopFiles, paths: ProjectPaths, id: string): Promise<string | undefined> {
  for (const folder of [paths.assets, paths.definitions]) if (await files.exists(`${folder}/${id}.md`)) return `${folder}/${id}.md`;
  return undefined;
}

/** Sort `type: remark` assets as the researcher decided. Assumptions and conventions become definitions (moved by the next step). */
async function sortRemarkAssets(files: LoopFiles, paths: ProjectPaths, plan: RemarkMigrationPlan, now: string, report: MigrationReport, carry: CarryState): Promise<void> {
  const remarkAssets = (await readAll(files, paths.assets)).filter(({ raw }) => /^type:\s*remark\s*$/m.test(raw));
  if (!remarkAssets.length) return;
  const unsorted: string[] = [];
  const toRemarks: Array<{ id: string; file: string; raw: string; sort: RemarkClassification }> = [];
  for (const { file, raw } of remarkAssets) {
    const id = idOf(file);
    const sort = plan[id];
    if (!sort) { unsorted.push(id); continue; }
    if (!(REMARK_CLASSES as readonly string[]).includes(sort.as)) throw new Error(`${id}: sort it as one of ${REMARK_CLASSES.join(', ')}, not ${String(sort.as)}.`);
    const data = parseMarkdown(raw).data;
    if (sort.as === 'assumption' || sort.as === 'convention') {
      const assetDeps = listOf(data.depends_on);
      if (assetDeps.length) throw new Error(`${file}: it depends on the results ${assetDeps.join(', ')}, but an ${sort.as} rests only on definitions. Remove those dependencies or sort it differently, then migrate again.`);
      const concept = String(data.title ?? id).replace(/^(?:Remark|Assumption|Convention|Definition)\s*\((.*)\)$/, '$1');
      const uses = listOf(data.uses_definitions);
      const updated = editFrontmatter(raw, (lines) => {
        let next = removeKey(removeKey(lines, 'uses_definitions'), 'depends_on');
        next = setKey(setKey(next, 'type', 'definition'), 'definition_kind', sort.as);
        next = setKey(next, 'title', JSON.stringify(definitionTitle(sort.as as 'assumption' | 'convention', concept)));
        return [...next, uses.length ? 'depends_on:' : 'depends_on: []', ...uses.map((use) => `  - ${use}`)];
      });
      await files.writeFile(file, updated);
      report.notes.push(`${id}: now a definition with definition_kind ${sort.as}; results that depended on it list it in uses_definitions.`);
    } else if (sort.as === 'remark') {
      toRemarks.push({ id, file, raw, sort });
    } else {
      const provable = sort.as !== 'example';
      await files.writeFile(file, editFrontmatter(raw, (lines) => provable ? setKey(setKey(lines, 'type', sort.as), 'status', 'draft') : setKey(lines, 'type', sort.as)));
      if (provable) { carry.noCarry.add(id); report.review.push(`${file}: now a ${sort.as} to prove (status draft); its earlier approval agreed to a remark, not to a proof.`); }
      else report.notes.push(`${id}: now an example.`);
    }
  }
  for (const { id, file, raw, sort } of toRemarks) {
    if (!sort.target) throw new Error(`${id}: a remark needs the target it annotates ("target": "<asset or definition ID>").`);
    if (toRemarks.some((other) => other.id === sort.target)) throw new Error(`${id}: its target ${sort.target} becomes a remark too; a remark annotates a result or definition.`);
    const targetFile = await nodeFile(files, paths, sort.target);
    if (!targetFile) throw new Error(`${id}: no asset or definition named ${sort.target}.`);
    const parsed = parseMarkdown(raw);
    const remark = remarkFile(paths, remarkIdFor(id), {
      type: 'remark', title: String(parsed.data.title ?? id), target: sort.target, origin: sort.origin === 'agent' ? 'agent' : 'researcher', from: 'other', status: 'active',
      target_digest: remarkTargetDigest(parseMarkdown(await files.readFile(targetFile)).content), at: now,
    }, parsed.content);
    if (await files.exists(remark.file)) throw new Error(`${remark.file} already exists.`);
    await files.writeFile(remark.file, remark.raw);
    await files.deleteFile!(file);
    carry.removed.add(id);
    // Nothing may depend on a remark: drop it from the dependencies of the results that listed it.
    for (const node of await readAll(files, paths.assets)) {
      const data = parseMarkdown(node.raw).data;
      if (!listOf(data.depends_on).includes(id)) continue;
      const deps = listOf(data.depends_on).filter((dep) => dep !== id);
      await files.writeFile(node.file, editFrontmatter(node.raw, (lines) => [...removeKey(lines, 'depends_on'), deps.length ? 'depends_on:' : 'depends_on: []', ...deps.map((dep) => `  - ${dep}`)]));
      report.review.push(`${node.file}: no longer depends on ${id}, which became a remark on ${sort.target}; add a real dependency if its proof used it.`);
    }
    for (const idea of await readAll(files, paths.ideas)) if (listOf(parseMarkdown(idea.raw).data.related_assets).includes(id)) report.review.push(`${idea.file}: related_assets names ${id}, now the remark ${remarkIdFor(id)} on ${sort.target}; point it at ${sort.target}.`);
    report.notes.push(`${id}: now the remark ${remarkIdFor(id)} on ${sort.target}.`);
  }
  if (unsorted.length) report.review.push(`Remark assets still to sort: ${unsorted.join(', ')}. Decide for each whether it is an assumption, a convention, a result (lemma, proposition, example), or a remark on another result, write the decisions to a JSON file such as {"${unsorted[0]}": {"as": "assumption"}} ({"as": "remark", "target": "<id>"} for a remark), and run migrate --remarks <file>.`);
}

/** Remarks kept inside result files (the old teaching-chat remarks block) move into remark files of their own. */
async function moveRemarkBlocks(files: LoopFiles, paths: ProjectPaths, now: string, report: MigrationReport): Promise<void> {
  let moved = 0;
  for (const folder of [paths.assets, paths.definitions]) {
    for (const { file, raw } of await readAll(files, folder)) {
      if (!REMARKS_BLOCK_PATTERN.test(raw)) continue;
      const parsed = parseMarkdown(raw);
      const text = remarksOf(parsed.content);
      const stripped = raw.replace(new RegExp(REMARKS_BLOCK_PATTERN.source), '\n').replace(/\n{3,}$/, '\n').replace(/\s*$/, '\n');
      if (text) {
        const remark = remarkFile(paths, remarkIdFor(`${idOf(file)}notes`), {
          type: 'remark', title: 'Remarks from the teaching chat', target: idOf(file), origin: 'researcher', from: 'teaching', status: 'active',
          target_digest: remarkTargetDigest(parseMarkdown(stripped).content), at: now,
        }, text);
        await files.writeFile(remark.file, remark.raw);
      }
      await files.writeFile(file, stripped);
      moved++;
    }
  }
  if (moved) report.notes.push(`Moved the remarks of ${moved} result(s) into ${paths.remarks}/; they no longer live inside the result files.`);
}

/**
 * Carry approvals and stored digests over to the migrated files. Only nodes
 * whose approval matched before the migration are carried, and only the
 * changes the migration made: a node it turned into a result to prove is not.
 * Approvals move with a node from assets to definitions; plans, checks,
 * candidates, and manuscript bindings that recorded an old digest get the new one.
 */
async function carryDigests(files: LoopFiles, paths: ProjectPaths, before: Map<string, { kind: 'asset' | 'definition'; raw: string }>, carry: CarryState, report: MigrationReport): Promise<void> {
  const map = new Map<string, string>();
  const approvals = await readApprovals(files, paths.researchRoot);
  let carried = 0;
  for (const [id, old] of before) {
    if (carry.noCarry.has(id) || carry.removed.has(id)) continue;
    const file = await nodeFile(files, paths, id);
    if (!file) continue;
    const raw = await files.readFile(file);
    if (raw === old.raw) continue;
    const kind = file.startsWith(`${paths.definitions}/`) ? 'definition' : 'asset';
    const pairs: Array<[string, string]> = [[statementDigest(old.raw), statementDigest(raw)], [researchDigest(old.raw, old.kind), researchDigest(raw, kind)]];
    const oldParts = assetComponents(old.raw); const newParts = assetComponents(raw);
    for (const part of ['statement', 'proof', 'source'] as const) pairs.push([oldParts[part], newParts[part]]);
    for (const [from, to] of pairs) if (from !== to) map.set(from, to);
    const record = approvals.records.find((item) => item.kind === old.kind && item.target === id);
    if (record && record.digest === researchDigest(old.raw, old.kind)) {
      record.kind = kind;
      record.digest = researchDigest(raw, kind);
      carried++;
    }
  }
  // A node the migration made a result to prove keeps no approval: it agreed to a remark, not to a proof.
  approvals.records = approvals.records.filter((record) => !((record.kind === 'asset' || record.kind === 'definition') && (carry.noCarry.has(record.target) || carry.removed.has(record.target))));
  await writeApprovals(files, paths.researchRoot, approvals);
  if (carried) report.notes.push(`Carried ${carried} approval(s) over to the migrated files; nothing that was not approved became approved.`);
  if (!map.size) return;
  const shared = sharedFolders(paths.researchRoot);
  const writing = paths.writingRoot;
  let updated = 0;
  for (const [folder, extension] of [[paths.plans, '.md'], [shared.checks, '.md'], [shared.candidates, '.md'], [`${writing}/bindings`, '.json'], [paths.writingSections, '.md']] as const) {
    for (const file of await files.listFiles(folder, extension)) {
      const raw = await files.readFile(file);
      const next = raw.replace(/\b[0-9a-f]{64}\b/g, (digest) => map.get(digest) ?? digest);
      if (next !== raw) { await files.writeFile(file, next); updated++; }
    }
  }
  if (updated) report.notes.push(`Updated the recorded versions in ${updated} plan, check, or manuscript file(s), so the migration marks nothing stale.`);
}

/** Run every migration step on `files` (use an OverlayFiles to preview). Throws before writing when a step cannot proceed safely. */
export async function migrateProject(files: LoopFiles, paths: ProjectPaths, options: MigrationOptions = {}): Promise<MigrationReport> {
  const report: MigrationReport = { notes: [], review: [] };
  const now = options.now ?? new Date().toISOString();
  const before = new Map<string, { kind: 'asset' | 'definition'; raw: string }>();
  for (const [kind, folder] of [['asset', paths.assets], ['definition', paths.definitions]] as const) for (const { file, raw } of await readAll(files, folder)) before.set(idOf(file), { kind, raw });
  const carry: CarryState = { noCarry: new Set(), removed: new Set() };
  await sortRemarkAssets(files, paths, options.remarkPlan ?? {}, now, report, carry);
  await moveDefinitionsOutOfAssets(files, paths, report);
  await moveRemarkBlocks(files, paths, now, report);
  await movePlansOutOfIdeas(files, paths, report);
  await upgradeNodes(files, paths, report);
  await upgradeProject(files, paths, report);
  await carryDigests(files, paths, before, carry, report);
  report.review.push(...ideaPlanProblems((await readAll(files, paths.assets)).map(({ file, raw }) => ({ filePath: file, raw })), [...await readAll(files, paths.ideas), ...await readAll(files, paths.plans)].map(({ file, raw }) => ({ filePath: file, raw }))));
  return report;
}
