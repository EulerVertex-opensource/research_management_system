import * as fs from 'fs/promises';
import * as path from 'path';
import { parseMarkdown } from '../services/Frontmatter';
import { NodeLoopFiles, loadProjectConfig, loadProjectPaths } from './nodeFiles';
import { openGit } from './nodeGit';
import { SectionBrief, parseSectionBrief, parseWritingOutline, sectionTexSkeleton, syncInputBlock, validSectionId, WritingSection } from '../services/ManuscriptWriting';
import { bindingPath, loadImpactNodes, loadManuscriptImpact, loadProjectRevision, readSectionBinding } from '../services/ManuscriptImpactLoader';
import { lockBinding, renderImpact, sectionImpact } from '../domain/manuscriptImpact';
import { ProjectPaths } from '../models/types';
import { isCited } from '../domain/schema';
import { findNodeFile } from '../domain/registry';

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
      const found = Boolean(await findNodeFile(paths.files, paths.config, 'asset', id) ?? await findNodeFile(paths.files, paths.config, 'definition', id));
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
  for (const asset of selectedAssets) await visit('asset', asset);

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
  const usage = 'Usage: manuscript-writing <sync | prepare SECTION_ID [--full] | impact [SECTION_ID] [--json] | lock SECTION_ID> [--preview | --apply] [--project PROJECT_ROOT]';
  if (!['sync', 'prepare', 'impact', 'lock'].includes(action)) throw new Error(usage);
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project needs a path');
  if (args.includes('--apply') && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  const allowed = new Set(['--project', '--preview', '--apply', '--json', '--full']);
  const positional = args.slice(1).filter((arg, index) => {
    const previous = args[index];
    return previous !== '--project' && !allowed.has(arg);
  });
  if (action === 'sync' && positional.length) throw new Error('sync takes no section ID');
  if ((action === 'prepare' || action === 'lock') && positional.length !== 1) throw new Error(`${action} needs one section ID`);
  if (action === 'impact' && positional.length > 1) throw new Error('impact takes at most one section ID');
  const root = path.resolve(projectIndex >= 0 ? args[projectIndex + 1] : process.cwd());
  const paths = await projectPaths(root);
  const mode: Mode = args.includes('--apply') ? 'apply' : 'preview';
  if (action === 'prepare') await prepare(paths, positional[0], mode, args.includes('--full'));
  else if (action === 'impact') await impact(paths, positional[0], args.includes('--json'));
  else if (action === 'lock') await lock(paths, positional[0], mode);
  else await sync(paths, mode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
