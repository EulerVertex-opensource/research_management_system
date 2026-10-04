import * as path from 'path';
import type { ProjectPaths } from '../models/types';
import { LIBRARY_KIND_FOLDERS, COLLECTION_FILE } from './registry';

/**
 * What may exist under the research folders. Discovery reads only the
 * configured folders, flat, so a file anywhere else (a topic subfolder, an
 * index or overview note, a new top-level folder) is invisible to the
 * dashboard, the validator, and the loop. These rules make such files
 * impossible to write (PreToolUse) and visible when they exist (validate).
 * Pure: shared by the extension, the bundled CLIs, and tests.
 */

export type LayoutPaths = Pick<ProjectPaths, 'researchRoot' | 'projectMd' | 'paperIndex' | 'assets' | 'definitions' | 'ideas' | 'plans'>
  & Partial<Pick<ProjectPaths, 'papers' | 'library' | 'writingRoot' | 'writingOutline' | 'writingSections'>>;

const NODE_FILE = /^[a-z][a-z0-9_]*\.md$/;
const LIBRARY_FILE = /^lib_[a-z0-9_]+\.md$/;
const COLLECTION = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG = /^[a-z][a-z0-9_]*$/;
const SECTION_FILE = /^[a-z0-9][a-z0-9_-]*\.md$/;
const PAPER_FILES = new Set(['metadata.yaml', 'paper.md']);

const join = (root: string, child: string) => (root === '.' ? child : `${root}/${child}`);
const isUnder = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);
const childParts = (file: string, folder: string) => file.slice(folder.length + 1).split('/');

/** The project-relative form of a tool's path argument, or undefined when it leaves the project. */
export function projectRelative(target: string, root?: string): string | undefined {
  let value = target.replace(/\\/g, '/');
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && (value === base || value.startsWith(`${base}/`))) value = value.slice(base.length + 1);
  else if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return undefined;
  value = path.posix.normalize(value.replace(/^\.\//, '')).replace(/\/+$/, '');
  return value === '..' || value.startsWith('../') ? undefined : value;
}

function folders(paths: LayoutPaths) {
  const shared = (child: string) => join(paths.researchRoot, child);
  const writing = paths.writingRoot ?? shared('writing');
  return {
    nodes: [paths.assets, paths.definitions, paths.ideas, paths.plans, shared('checks')],
    records: [shared('decisions'), shared('handoffs')],
    approvals: shared('approvals'),
    writing,
    bindings: `${writing}/bindings`,
    sections: paths.writingSections ?? `${writing}/sections`,
    outline: paths.writingOutline ?? `${writing}/outline.md`,
    legacy: [shared('workflows')],
  };
}

/** Folders the rules govern. With the legacy root `.` only the configured folders are governed, never the manuscript. */
function governed(paths: LayoutPaths): string[] {
  const f = folders(paths);
  const list = [...f.nodes, ...f.records, f.approvals, f.writing, ...(paths.papers ? [paths.papers] : []), ...(paths.library ? [paths.library] : [])];
  return paths.researchRoot === '.' ? list : [paths.researchRoot, ...list];
}

export function isGoverned(paths: LayoutPaths, file: string): boolean {
  return file === paths.projectMd || file === paths.paperIndex || governed(paths).some((folder) => isUnder(file, folder));
}

/** Files older versions created that a project may still hold; reported as notes, never as problems. */
export function isLegacyLayoutPath(paths: LayoutPaths, file: string): boolean {
  return folders(paths).legacy.some((folder) => isUnder(file, folder)) || file === join(paths.researchRoot, 'approvals.json');
}

function allowedFile(paths: LayoutPaths, file: string): boolean {
  const f = folders(paths);
  const parent = path.posix.dirname(file);
  const base = path.posix.basename(file);
  if (file === paths.projectMd || file === paths.paperIndex || file === f.outline) return true;
  if (paths.researchRoot !== '.' && file === `${paths.researchRoot}/README.md`) return true;
  if (f.nodes.includes(parent)) return NODE_FILE.test(base);
  if (f.records.includes(parent)) return base.endsWith('.md');
  if (isUnder(file, f.approvals)) return /\.jsonl?$/.test(base);
  if (parent === f.sections) return SECTION_FILE.test(base);
  if (parent === f.bindings) return /^[a-z0-9][a-z0-9_-]*\.json$/.test(base);
  if (paths.library && file.startsWith(`${paths.library}/`)) {
    const parts = childParts(file, paths.library);
    if (!COLLECTION.test(parts[0])) return false;
    if (parts.length === 2) return parts[1] === COLLECTION_FILE;
    return parts.length === 3 && Object.values(LIBRARY_KIND_FOLDERS).includes(parts[1] as never) && LIBRARY_FILE.test(parts[2]);
  }
  if (paths.papers && file.startsWith(`${paths.papers}/`)) {
    const parts = childParts(file, paths.papers);
    if (!SLUG.test(parts[0])) return false;
    return (parts.length === 2 && PAPER_FILES.has(parts[1])) || (parts.length > 2 && parts[1] === 'figures');
  }
  return false;
}

function allowedDir(paths: LayoutPaths, dir: string): boolean {
  const f = folders(paths);
  const fixed = [...governed(paths), f.bindings, f.sections];
  // A configured folder, or a folder on the way to one (custom layouts may nest them).
  if (fixed.some((folder) => folder === dir || folder.startsWith(`${dir}/`))) return true;
  if (isUnder(dir, f.approvals)) return true;
  if (paths.library && dir.startsWith(`${paths.library}/`)) {
    const parts = childParts(dir, paths.library);
    return COLLECTION.test(parts[0]) && (parts.length === 1 || (parts.length === 2 && Object.values(LIBRARY_KIND_FOLDERS).includes(parts[1] as never)));
  }
  if (paths.papers && dir.startsWith(`${paths.papers}/`)) {
    const parts = childParts(dir, paths.papers);
    return SLUG.test(parts[0]) && (parts.length === 1 || parts[1] === 'figures');
  }
  return false;
}

/** Where a misplaced file's content belongs, named with this project's folders. */
function destinations(paths: LayoutPaths): string {
  return [
    `results and definitions as one node file each directly in ${paths.assets}/ or ${paths.definitions}/ (extract-research-nodes)`,
    `loose notes, questions, and directions in ${paths.ideas}/`,
    ...(paths.papers ? [`papers as ${paths.papers}/<slug>/paper.md and metadata.yaml (import-math-paper)`] : []),
    ...(paths.library ? [`known results in ${paths.library}/<collection>/assets|definitions/`] : []),
  ].join('; ');
}

/**
 * Why a file or folder may not exist at this project-relative path, or
 * undefined when it may (or when the path is outside the research folders).
 */
export function layoutProblem(paths: LayoutPaths, file: string, isDir = false): string | undefined {
  if (!isGoverned(paths, file) || isLegacyLayoutPath(paths, file)) return undefined;
  if (isDir ? allowedDir(paths, file) : allowedFile(paths, file)) return undefined;
  const f = folders(paths);
  const nodeFolder = [...f.nodes, ...(paths.library ? [paths.library] : [])].find((folder) => file.startsWith(`${folder}/`));
  const parent = path.posix.dirname(file);
  if (!isDir && f.nodes.includes(parent)) {
    return `${file}: files in ${parent}/ are research nodes named <id>.md (lowercase snake_case). Index, README, overview, and other folder notes are not allowed; group nodes with tags. Put the content in ${destinations(paths)}.`;
  }
  if (nodeFolder && nodeFolder !== paths.library) {
    return `${file}: ${nodeFolder}/ is flat; subfolders are invisible to the dashboard and the loop. Write each node directly in ${nodeFolder}/ and group with tags.`;
  }
  return `${file} is outside the research layout, so the dashboard and the loop never read it. No new folders or folder notes; put the content in ${destinations(paths)}. Keep raw materials outside the research folders (source PDFs in research-local/).`;
}

/**
 * A note written into a node folder without frontmatter is a folder note, not
 * a node (it would show up as an untyped remark). Checked on full-content writes.
 */
export function folderNoteProblem(paths: LayoutPaths, file: string, content: string): string | undefined {
  const parent = path.posix.dirname(file);
  const inNodeFolder = folders(paths).nodes.includes(parent)
    || Boolean(paths.library && file.startsWith(`${paths.library}/`) && childParts(file, paths.library).length === 3);
  if (!inNodeFolder || /^﻿?---\r?\n/.test(content)) return undefined;
  return `${file}: a node file starts with YAML frontmatter (type, title, status). A note without it is a folder note, which is not allowed; put the content in ${destinations(paths)}.`;
}

/** The file interface a layout walk needs. */
export interface LayoutLister {
  listFiles(relativeDir: string, extension?: string): Promise<string[]>;
  listDirs?(relativeDir: string): Promise<string[]>;
}

/** Walk the research folders: misplaced files and folders (a folder is reported once), and legacy leftovers. */
export async function layoutReport(files: LayoutLister, paths: LayoutPaths): Promise<{ problems: string[]; legacy: string[] }> {
  const problems: string[] = [];
  const legacy: string[] = [];
  // Older test doubles pass partial paths and list no folders; they see a clean layout.
  if (typeof paths.researchRoot !== 'string' || !files.listDirs) return { problems, legacy };
  const seen = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const file of await files.listFiles(dir, '')) {
      if (path.posix.basename(file).startsWith('.')) continue;
      if (isLegacyLayoutPath(paths, file)) { legacy.push(file); continue; }
      const problem = layoutProblem(paths, file);
      if (problem) problems.push(problem);
    }
    for (const child of await files.listDirs!(dir)) {
      if (isLegacyLayoutPath(paths, child)) { legacy.push(`${child}/`); continue; }
      if (!isGoverned(paths, child)) continue;
      const problem = layoutProblem(paths, child, true);
      if (problem) { problems.push(problem); continue; }
      await visit(child);
    }
  };
  for (const root of paths.researchRoot === '.' ? governed(paths) : [paths.researchRoot]) await visit(root);
  return { problems, legacy };
}
