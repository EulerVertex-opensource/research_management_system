import * as fs from 'fs/promises';
import * as path from 'path';
import { parseMarkdown } from '../services/Frontmatter';
import { NodeLoopFiles, loadProjectConfig, loadProjectPaths } from './nodeFiles';
import { openGit } from './nodeGit';
import { SectionBrief, adoptManuscript, adoptedBrief, adoptedOutline, parseSectionBrief, parseWritingOutline, sectionHeadingTitle, sectionTexSkeleton, syncInputBlock, validSectionId, WritingSection } from '../services/ManuscriptWriting';
import { bindingPath, loadImpactNodes, loadManuscriptImpact, loadProjectRevision, readSectionBinding } from '../services/ManuscriptImpactLoader';
import { lockBinding, renderImpact, sectionImpact } from '../domain/manuscriptImpact';
import { ProjectPaths } from '../models/types';
import { isCited } from '../domain/schema';
import { findNodeFile } from '../domain/registry';
import { Remarks } from '../services/Remarks';

type Mode = 'preview' | 'apply';
interface Paths {
  root: string;
  /** Project-relative paths, for the shared loop file readers. */
  config: ProjectPaths;
  files: NodeLoopFiles;
  project: string;
  latexRoot: string;
  main: string;
  sections: string;
  outline: string;
  briefs: string;
  assets: string;
  definitions: string;
  bibliography: string;
  macros: string[];
  notations: string | null;
}

function within(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Invalid configured path: ${relative}`);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Configured path leaves the project: ${relative}`);
  return full;
}

async function projectPaths(root: string): Promise<Paths> {
  const [config, raw] = await Promise.all([loadProjectPaths(root), loadProjectConfig(root)]);
  const inside = (relative: string): string => within(root, relative);
  return {
    root, latexRoot: inside(raw.latex.projectRoot),
    config, files: new NodeLoopFiles(root),
    project: inside(config.projectMd),
    main: inside(config.mainTex),
    sections: inside(config.sections),
    outline: inside(config.writingOutline),
    briefs: inside(config.writingSections),
    assets: inside(config.assets),
    definitions: inside(config.definitions),
    bibliography: inside(config.bibliography),
    macros: config.macroFiles.map(inside),
    notations: config.notations ? inside(config.notations) : null,
  };
}

async function readBrief(paths: Paths, section: WritingSection, checkAssetFiles: boolean): Promise<SectionBrief> {
  const file = path.join(paths.briefs, `${section.id}.md`);
  const brief = parseSectionBrief(await fs.readFile(file, 'utf8'), section.id);
  if (brief.title !== section.title) throw new Error(`Outline title and brief title differ for ${section.id}`);
  if (checkAssetFiles) {
    for (const id of brief.assets) {
      const found = Boolean(await findNodeFile(paths.files, paths.config, 'asset', id) ?? await findNodeFile(paths.files, paths.config, 'definition', id))
        || (id.startsWith('remark_') && await paths.files.exists(`${paths.config.remarks}/${id}.md`));
      if (!found) throw new Error(`Section ${section.id} references unknown asset: ${id}`);
    }
  }
  return brief;
}

async function sectionsAndBriefs(paths: Paths): Promise<{ section: WritingSection; assets: string[] }[]> {
  const sections = parseWritingOutline(await fs.readFile(paths.outline, 'utf8'));
  return Promise.all(sections.map(async (section) => ({
    section, assets: (await readBrief(paths, section, true)).assets,
  })));
}

const POLICY_ACTION = {
  managed: 'Rewrite this block from its sources.',
  assisted: 'Propose a patch to this block; the researcher confirms it.',
  manual: 'Do not edit; tell the researcher what changed.',
} as const;

const texFileOf = (paths: Paths, id: string) => path.join(paths.sections, `${id}.tex`);

function nodeIds(value: unknown, field: string, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !validSectionId(item))) {
    throw new Error(`Invalid ${field} in node ${id}`);
  }
  return value;
}

async function prepare(paths: Paths, id: string, mode: Mode, full: boolean): Promise<void> {
  if (!validSectionId(id)) throw new Error(`Invalid section ID: ${id}`);
  const sections = parseWritingOutline(await fs.readFile(paths.outline, 'utf8'));
  const selected = sections.find((entry) => entry.id === id);
  if (!selected) throw new Error(`Section ${id} is not listed in the writing outline`);
  const brief = await readBrief(paths, selected, false);
  const selectedAssets = brief.assets;
  const assetFiles = new Set<string>();
  const definitionFiles = new Set<string>();
  const paperIds = new Set<string>();

  const visit = async (kind: 'asset' | 'definition', nodeId: string): Promise<void> => {
    // Project or library node; a brief source may name a definition the section introduces.
    let relative = await findNodeFile(paths.files, paths.config, kind, nodeId);
    if (!relative && kind === 'asset') {
      relative = await findNodeFile(paths.files, paths.config, 'definition', nodeId);
      if (relative) kind = 'definition';
    }
    const seen = kind === 'asset' ? assetFiles : definitionFiles;
    const file = relative ? path.join(paths.root, relative) : path.join(kind === 'asset' ? paths.assets : paths.definitions, `${nodeId}.md`);
    if (seen.has(file)) return;
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch { throw new Error(`Missing ${kind} dependency: ${nodeId}`); }
    const data = parseMarkdown(raw).data;
    if (data.status !== 'approved') throw new Error(`Cannot draft from ${kind} ${nodeId}: status is ${String(data.status ?? 'missing')}`);
    seen.add(file);
    if (isCited(data.source)) {
      if (typeof data.source.paper_id !== 'string' || !data.source.paper_id.trim()) {
        throw new Error(`Cited source for ${nodeId} has no paper_id`);
      }
      paperIds.add(data.source.paper_id);
    }
    if (kind === 'asset') {
      for (const dependency of nodeIds(data.depends_on, 'depends_on', nodeId)) await visit('asset', dependency);
      for (const definition of nodeIds(data.uses_definitions, 'uses_definitions', nodeId)) await visit('definition', definition);
    } else {
      for (const dependency of nodeIds(data.depends_on, 'depends_on', nodeId)) await visit('definition', dependency);
    }
  };
  // Remarks the brief presents: approved for the paper, presented as written (as a remark after the result, or folded into the prose).
  const remarkLines: string[] = [];
  const remarkSources = brief.sources.filter((source) => source.id.startsWith('remark_'));
  if (remarkSources.length) {
    const listed = new Map((await new Remarks(paths.files, paths.config).list({ includeArchived: true })).map((remark) => [remark.id, remark]));
    for (const source of remarkSources) {
      const remark = listed.get(source.id);
      if (!remark) throw new Error(`Missing remark: ${source.id}`);
      if (remark.status !== 'active') throw new Error(`Cannot draft from remark ${source.id}: it is archived.`);
      if (!remark.approved) throw new Error(`Cannot draft from remark ${source.id}: the researcher has not approved it for the paper (dashboard: the remark under its result, "approve for the paper").`);
      remarkLines.push(`Remark: ${remark.file} (on ${remark.target}${remark.anchor ? `, ${remark.anchor}` : ''}${remark.stale ? '; written for an earlier version of the result: check it still fits, and tell the researcher if it does not' : ''})`);
    }
  }
  for (const asset of selectedAssets.filter((id) => !id.startsWith('remark_'))) await visit('asset', asset);

  if (paperIds.size) {
    const bib = await fs.readFile(paths.bibliography, 'utf8');
    const bibKeys = new Set(Array.from(bib.matchAll(/@([A-Za-z]+)\s*[{(]\s*([^,\s]+)\s*,/g))
      .filter((match) => !['comment', 'preamble', 'string'].includes(match[1].toLowerCase()))
      .map((match) => match[2]));
    for (const key of paperIds) if (!bibKeys.has(key)) throw new Error(`Missing BibTeX key for cited paper: ${key}`);
  }

  for (const file of [paths.main, ...paths.macros, ...(paths.notations ? [paths.notations] : [])]) {
    try { await fs.access(file); }
    catch { throw new Error(`Missing configured manuscript preamble file: ${path.relative(paths.root, file)}`); }
  }

  const texFile = texFileOf(paths, id);
  const existing = await fs.access(texFile).then(() => true, () => false);
  process.stdout.write(`Section: ${id}\nTeX: ${path.relative(paths.root, texFile)} (${existing ? 'existing; preserve edits' : 'missing; create on --apply'})\n`);
  process.stdout.write(`Brief: ${path.relative(paths.root, path.join(paths.briefs, `${id}.md`))}\n`);
  // With a lock, only what changed since then is context; the rest is already in the TeX.
  const binding = await readSectionBinding(paths.files, paths.config, id);
  let context = [...assetFiles, ...definitionFiles];
  if (binding && existing && !full) {
    const { project } = await loadProjectRevision(paths.files, paths.config);
    const impact = sectionImpact({ id, title: selected.title, brief, binding, texRaw: await fs.readFile(texFile, 'utf8') }, await loadImpactNodes(paths.files, paths.config), project);
    const changed = new Set([...impact.stale.map((item) => item.id), ...impact.added, ...impact.invalid.map((item) => item.id)]);
    const bound = new Set(binding.sources.map((source) => source.id));
    const isChanged = (file: string) => { const node = path.basename(file, '.md'); return changed.has(node) || !bound.has(node); };
    process.stdout.write(`Lock: ${impact.state}${impact.lockedRevision ? ` at project revision ${impact.lockedRevision}` : ''}; locked ${binding.lockedAt}\n`);
    for (const item of impact.stale) process.stdout.write(`Changed: ${item.id} (${item.components.join(', ')})\n`);
    for (const facet of impact.facets) process.stdout.write(`Changed: project ${facet} (read that part of ${path.relative(paths.root, paths.project)})\n`);
    const tex = path.relative(paths.root, texFile);
    for (const block of impact.blocks.filter((item) => item.state !== 'current')) {
      const where = block.lines ? `${tex}:${block.lines[0]}-${block.lines[1]}` : `${tex} (block removed)`;
      const reasons = [...block.invalid.map((problem) => `${problem.id} ${problem.reason}`), ...block.stale.map((item) => `${item.id} ${item.components.join('+')}`)].join('; ');
      process.stdout.write(`Block: ${block.id} ${where} [${block.policy}] — ${reasons}. ${POLICY_ACTION[block.policy]}\n`);
    }
    if (impact.blocks.length) {
      for (const item of impact.outside) process.stdout.write(`Outside blocks: ${item.id} ${item.components.join('+')} changed; check the prose around the blocks.\n`);
      const current = impact.blocks.filter((item) => item.state === 'current').map((item) => item.id);
      if (current.length) process.stdout.write(`Current blocks (leave unchanged): ${current.join(', ')}\n`);
      if (!impact.outside.length && !impact.facets.length && !impact.added.length) process.stdout.write('Read only the listed block lines of the TeX, not the whole section.\n');
    }
    for (const node of impact.added) process.stdout.write(`Added to brief: ${node}\n`);
    for (const node of impact.removed) process.stdout.write(`Removed from brief: ${node}\n`);
    const unchanged = context.filter((file) => !isChanged(file)).map((file) => path.basename(file, '.md'));
    if (unchanged.length) process.stdout.write(`Unchanged since lock (already in the TeX; do not reread): ${unchanged.join(', ')}\n`);
    context = context.filter(isChanged);
  }
  for (const file of context) process.stdout.write(`Context: ${path.relative(paths.root, file)}\n`);
  for (const line of remarkLines) process.stdout.write(`${line}\n`);
  for (const file of [paths.main, ...paths.macros, ...(paths.notations ? [paths.notations] : [])]) process.stdout.write(`Preamble: ${path.relative(paths.root, file)}\n`);
  for (const key of paperIds) process.stdout.write(`Citation: ${key}\n`);
  if (mode === 'apply' && !existing) {
    await fs.mkdir(paths.sections, { recursive: true });
    await fs.writeFile(texFile, sectionTexSkeleton(id, selected.title, brief.sources), { flag: 'wx' });
    process.stdout.write(`Created ${path.relative(paths.root, texFile)}\n`);
  }
}

async function sync(paths: Paths, mode: Mode): Promise<void> {
  const sections = await sectionsAndBriefs(paths);
  const inputs: string[] = [];
  for (const { section } of sections) {
    const texFile = path.join(paths.sections, `${section.id}.tex`);
    try { await fs.access(texFile); }
    catch { throw new Error(`Missing TeX section: ${path.relative(paths.root, texFile)}. Run prepare ${section.id} --apply first.`); }
    inputs.push(path.relative(paths.latexRoot, texFile).split(path.sep).join('/').replace(/\.tex$/, ''));
  }
  const main = await fs.readFile(paths.main, 'utf8');
  const result = syncInputBlock(main, inputs);
  process.stdout.write(`--- ${path.relative(paths.root, paths.main)} current inputs\n${result.before || '(empty)\n'}+++ ${path.relative(paths.root, paths.main)} proposed inputs\n${result.after}`);
  if (result.updated === main) {
    process.stdout.write('Inputs already match the outline.\n');
  } else if (mode === 'apply') {
    await fs.writeFile(paths.main, result.updated);
    process.stdout.write('Applied manuscript input order.\n');
  } else {
    process.stdout.write('Preview only; run with --apply to update the marked block.\n');
  }
}

/** Section IDs already used by a section file or a brief, so a split never overwrites either. */
async function takenSectionIds(paths: Paths): Promise<string[]> {
  const ids = async (dir: string, extension: string) => (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((file) => file.endsWith(extension)).map((file) => file.slice(0, -extension.length));
  return [...await ids(paths.sections, '.tex'), ...await ids(paths.briefs, '.md')];
}

/**
 * Bring an existing manuscript under the outline: split its inline sections
 * into section files (text unchanged), or mark its existing section inputs,
 * then write the outline and one brief per section.
 */
async function adopt(paths: Paths, mode: Mode): Promise<void> {
  const outline = await fs.readFile(paths.outline, 'utf8').catch(() => undefined);
  let planned: WritingSection[] = [];
  try { if (outline !== undefined) planned = parseWritingOutline(outline); }
  catch (error) { if (!(error instanceof Error && /has no sections/.test(error.message))) throw error; }
  if (planned.length) throw new Error(`${paths.config.writingOutline} already lists sections; the manuscript is adopted. Use plan-manuscript and sync.`);

  const main = await fs.readFile(paths.main, 'utf8');
  const mainName = path.relative(paths.root, paths.main).split(path.sep).join('/');
  const sectionsDir = path.relative(paths.latexRoot, paths.sections).split(path.sep).join('/') || '.';
  const result = adoptManuscript(main, sectionsDir, await takenSectionIds(paths));
  const rel = (file: string) => path.relative(paths.root, file).split(path.sep).join('/');
  if (result.mode === 'inputs') {
    for (const section of result.sections) {
      const tex = await fs.readFile(texFileOf(paths, section.id), 'utf8').catch(() => { throw new Error(`${mainName}:${section.lines[0]} inputs ${rel(texFileOf(paths, section.id))}, which does not exist.`); });
      section.title = sectionHeadingTitle(tex) ?? section.id;
    }
  }
  const briefFile = (id: string) => path.join(paths.briefs, `${id}.md`);
  const existingBriefs = (await Promise.all(result.sections.map(async (section) => (await fs.access(briefFile(section.id)).then(() => true, () => false)) ? rel(briefFile(section.id)) : undefined))).filter(Boolean);
  if (existingBriefs.length) throw new Error(`Briefs already exist for: ${existingBriefs.join(', ')}. Remove them or add the sections to the outline by hand.`);

  const [first, last] = result.lines;
  process.stdout.write(result.mode === 'split'
    ? `Adopt ${mainName}: split lines ${first}-${last} at ${result.sections.length} \\section heading(s) into section files.\n`
    : `Adopt ${mainName}: its section inputs (lines ${first}-${last}) already use ${sectionsDir}/; add the section markers around them.\n`);
  for (const [index, section] of result.sections.entries()) {
    const where = result.mode === 'split' ? `${mainName}:${section.lines[0]}-${section.lines[1]} -> ${rel(texFileOf(paths, section.id))}` : rel(texFileOf(paths, section.id));
    process.stdout.write(`  ${index + 1}. ${section.id} "${section.title}" ${where}\n`);
  }
  if (result.mode === 'split') {
    process.stdout.write(`Stays in ${mainName}: the preamble and front matter above line ${first} (title, abstract), and lines ${last + 1}-end (bibliography, \\end{document}).\n`);
    for (const item of result.left) process.stdout.write(`Not split: "${item.title}" at line ${item.line} comes after the bibliography; it stays in ${mainName}.\n`);
    process.stdout.write('The section files hold the moved lines unchanged and in order, so the compiled document should not change; compile once to confirm.\n');
    process.stdout.write(`Moving text out of ${mainName} detaches Overleaf comments and tracked changes on it: confirm with the researcher before --apply.\n`);
  }
  process.stdout.write(`Outline: ${paths.config.writingOutline} lists the ${result.sections.length} section(s); one brief each in ${paths.config.writingSections}/ with assets: [] to fill from the extracted nodes.\n`);
  if (mode !== 'apply') { process.stdout.write('Preview only; run with --apply to write the files.\n'); return; }

  if (result.mode === 'split') {
    await fs.mkdir(paths.sections, { recursive: true });
    for (const section of result.sections) await fs.writeFile(texFileOf(paths, section.id), section.text!, { flag: 'wx' });
  }
  await fs.mkdir(paths.briefs, { recursive: true });
  for (const section of result.sections) {
    const origin = result.mode === 'split' ? `${mainName} lines ${section.lines[0]}-${section.lines[1]}` : rel(texFileOf(paths, section.id));
    await fs.writeFile(briefFile(section.id), adoptedBrief(section, origin), { flag: 'wx' });
  }
  await fs.mkdir(path.dirname(paths.outline), { recursive: true });
  await fs.writeFile(paths.outline, adoptedOutline(outline, result.sections));
  await fs.writeFile(paths.main, result.updated);
  process.stdout.write(`Adopted: ${result.sections.length} section(s). Next: extract nodes, fill each brief's sources, and wrap the passages that present them in blocks.\n`);
}

async function impact(paths: Paths, only: string | undefined, json: boolean): Promise<void> {
  const result = await loadManuscriptImpact(paths.files, paths.config, only);
  if (!result) throw new Error(`No writing outline at ${paths.config.writingOutline}; plan the manuscript first.`);
  process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : renderImpact(result) + '\n');
}

async function lock(paths: Paths, id: string, mode: Mode): Promise<void> {
  if (!validSectionId(id)) throw new Error(`Invalid section ID: ${id}`);
  const selected = parseWritingOutline(await fs.readFile(paths.outline, 'utf8')).find((entry) => entry.id === id);
  if (!selected) throw new Error(`Section ${id} is not listed in the writing outline`);
  const texFile = texFileOf(paths, id);
  const texRaw = await fs.readFile(texFile, 'utf8').catch(() => { throw new Error(`Missing TeX section: ${path.relative(paths.root, texFile)}. Draft it before locking.`); });
  const { project, revision } = await loadProjectRevision(paths.files, paths.config);
  const git = await openGit(paths.root);
  const binding = lockBinding({
    section: id, tex: path.relative(paths.root, texFile).split(path.sep).join('/'), texRaw, brief: await readBrief(paths, selected, true), nodes: await loadImpactNodes(paths.files, paths.config),
    project, projectRevision: revision, lockedAt: new Date().toISOString(), performedBy: await git?.userEmail(),
  });
  const file = path.join(paths.root, bindingPath(paths.config, id));
  process.stdout.write(`Binding: ${path.relative(paths.root, file)}\nProject revision: ${revision ?? 'unapproved'}\n`);
  for (const source of binding.sources) process.stdout.write(`Source: ${source.id} (${source.uses.join(', ')})${source.via === 'direct' ? '' : ` via ${source.via}`}\n`);
  if (Object.keys(binding.facets).length) process.stdout.write(`Project facets: ${Object.keys(binding.facets).join(', ')}\n`);
  for (const block of binding.blocks ?? []) process.stdout.write(`Block: ${block.id} [${block.policy}] ${block.sources.map((source) => `${source.id}@${source.components.join('+')}`).join(', ')}\n`);
  if (!binding.blocks?.length) process.stdout.write('No block markers: the section is tracked as a whole.\n');
  if (mode === 'apply') {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(binding, null, 2) + '\n');
    process.stdout.write('Locked: the section is recorded as reconciled with the current research.\n');
  } else {
    process.stdout.write('Preview only; lock with --apply after the researcher has reviewed the TeX.\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];
  const usage = 'Usage: manuscript-writing <adopt | sync | prepare SECTION_ID [--full] | impact [SECTION_ID] [--json] | lock SECTION_ID> [--preview | --apply] [--project PROJECT_ROOT]';
  if (!['adopt', 'sync', 'prepare', 'impact', 'lock'].includes(action)) throw new Error(usage);
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project needs a path');
  if (args.includes('--apply') && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  const allowed = new Set(['--project', '--preview', '--apply', '--json', '--full']);
  const positional = args.slice(1).filter((arg, index) => {
    const previous = args[index];
    return previous !== '--project' && !allowed.has(arg);
  });
  if ((action === 'sync' || action === 'adopt') && positional.length) throw new Error(`${action} takes no section ID`);
  if ((action === 'prepare' || action === 'lock') && positional.length !== 1) throw new Error(`${action} needs one section ID`);
  if (action === 'impact' && positional.length > 1) throw new Error('impact takes at most one section ID');
  const root = path.resolve(projectIndex >= 0 ? args[projectIndex + 1] : process.cwd());
  const paths = await projectPaths(root);
  const mode: Mode = args.includes('--apply') ? 'apply' : 'preview';
  if (action === 'prepare') await prepare(paths, positional[0], mode, args.includes('--full'));
  else if (action === 'impact') await impact(paths, positional[0], args.includes('--json'));
  else if (action === 'lock') await lock(paths, positional[0], mode);
  else if (action === 'adopt') await adopt(paths, mode);
  else await sync(paths, mode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
