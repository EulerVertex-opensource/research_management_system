import * as fs from 'fs/promises';
import * as path from 'path';
import { parseMarkdown } from '../services/Frontmatter';
import { loadProjectConfig, loadProjectPaths } from './nodeFiles';
import { parseSectionBrief, parseWritingOutline, sectionTexSkeleton, syncInputBlock, validSectionId, WritingSection } from '../services/ManuscriptWriting';
import { isCited } from '../domain/schema';

type Mode = 'preview' | 'apply';
interface Paths {
  root: string;
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

async function readBrief(paths: Paths, section: WritingSection, checkAssetFiles: boolean): Promise<string[]> {
  const file = path.join(paths.briefs, `${section.id}.md`);
  const brief = parseSectionBrief(await fs.readFile(file, 'utf8'), section.id);
  if (brief.title !== section.title) throw new Error(`Outline title and brief title differ for ${section.id}`);
  if (checkAssetFiles) {
    for (const id of brief.assets) {
      try { await fs.access(path.join(paths.assets, `${id}.md`)); }
      catch { throw new Error(`Section ${section.id} references unknown asset: ${id}`); }
    }
  }
  return brief.assets;
}

async function sectionsAndBriefs(paths: Paths): Promise<{ section: WritingSection; assets: string[] }[]> {
  const sections = parseWritingOutline(await fs.readFile(paths.outline, 'utf8'));
  return Promise.all(sections.map(async (section) => ({
    section, assets: await readBrief(paths, section, true),
  })));
}

function nodeIds(value: unknown, field: string, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !validSectionId(item))) {
    throw new Error(`Invalid ${field} in node ${id}`);
  }
  return value;
}

async function prepare(paths: Paths, id: string, mode: Mode): Promise<void> {
  if (!validSectionId(id)) throw new Error(`Invalid section ID: ${id}`);
  const sections = parseWritingOutline(await fs.readFile(paths.outline, 'utf8'));
  const selected = sections.find((entry) => entry.id === id);
  if (!selected) throw new Error(`Section ${id} is not listed in the writing outline`);
  const selectedAssets = await readBrief(paths, selected, false);
  const assetFiles = new Set<string>();
  const definitionFiles = new Set<string>();
  const paperIds = new Set<string>();

  const visit = async (kind: 'asset' | 'definition', nodeId: string): Promise<void> => {
    const folder = kind === 'asset' ? paths.assets : paths.definitions;
    const seen = kind === 'asset' ? assetFiles : definitionFiles;
    const file = path.join(folder, `${nodeId}.md`);
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

  const texFile = path.join(paths.sections, `${id}.tex`);
  const existing = await fs.access(texFile).then(() => true, () => false);
  process.stdout.write(`Section: ${id}\nTeX: ${path.relative(paths.root, texFile)} (${existing ? 'existing; preserve edits' : 'missing; create on --apply'})\n`);
  process.stdout.write(`Brief: ${path.relative(paths.root, path.join(paths.briefs, `${id}.md`))}\n`);
  for (const file of [...assetFiles, ...definitionFiles]) process.stdout.write(`Context: ${path.relative(paths.root, file)}\n`);
  for (const file of [paths.main, ...paths.macros, ...(paths.notations ? [paths.notations] : [])]) process.stdout.write(`Preamble: ${path.relative(paths.root, file)}\n`);
  for (const key of paperIds) process.stdout.write(`Citation: ${key}\n`);
  if (mode === 'apply' && !existing) {
    await fs.mkdir(paths.sections, { recursive: true });
    await fs.writeFile(texFile, sectionTexSkeleton(id, selected.title, selectedAssets), { flag: 'wx' });
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];
  if (action !== 'sync' && action !== 'prepare') throw new Error('Usage: manuscript-writing <sync | prepare SECTION_ID> [--preview | --apply] [--project PROJECT_ROOT]');
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project needs a path');
  if (args.includes('--apply') && args.includes('--preview')) throw new Error('Choose --preview or --apply');
  const allowed = new Set(['--project', '--preview', '--apply']);
  const positional = args.slice(1).filter((arg, index) => {
    const previous = args[index];
    return previous !== '--project' && !allowed.has(arg);
  });
  if (action === 'sync' && positional.length) throw new Error('sync takes no section ID');
  if (action === 'prepare' && positional.length !== 1) throw new Error('prepare needs one section ID');
  const root = path.resolve(projectIndex >= 0 ? args[projectIndex + 1] : process.cwd());
  const paths = await projectPaths(root);
  const mode: Mode = args.includes('--apply') ? 'apply' : 'preview';
  if (action === 'prepare') await prepare(paths, positional[0], mode);
  else await sync(paths, mode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
