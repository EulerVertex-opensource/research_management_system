import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { researchDigest } from '../domain/digests';
import { ImpactNode, ManuscriptImpact, SectionBinding, manuscriptImpact } from '../domain/manuscriptImpact';
import { parseMarkdown } from './Frontmatter';
import { LoopFiles } from './ResearchLoopModel';
import { currentProjectRevision, projectRevisionHistory, readApprovals } from './ApprovalStore';
import { SectionBrief, WritingSection, parseSectionBrief, parseWritingOutline } from './ManuscriptWriting';

/**
 * Reads what manuscript impact needs through the loop's file interface, so the
 * manuscript CLI and the research loop (extension, CLI, hooks) share one reader.
 */

export type ManuscriptPaths = Pick<ProjectPaths, 'researchRoot' | 'projectMd' | 'assets' | 'definitions' | 'sections' | 'writingRoot' | 'writingOutline' | 'writingSections'>;

export const bindingsFolder = (paths: ManuscriptPaths) => path.posix.join(paths.writingRoot, 'bindings');
export const bindingPath = (paths: ManuscriptPaths, id: string) => `${bindingsFolder(paths)}/${id}.json`;
export const sectionTexPath = (paths: ManuscriptPaths, id: string) => `${paths.sections}/${id}.tex`;

/** Every asset and definition; approved means `status: approved` not contradicted by a shared approval record. */
export async function loadImpactNodes(files: LoopFiles, paths: ManuscriptPaths): Promise<Map<string, ImpactNode>> {
  const approvals = (await readApprovals(files, paths.researchRoot)).records;
  const nodes = new Map<string, ImpactNode>();
  for (const [kind, folder] of [['asset', paths.assets], ['definition', paths.definitions]] as const) {
    for (const file of await files.listFiles(folder)) {
      const raw = await files.readFile(file);
      let data: Record<string, any>;
      try { data = parseMarkdown(raw).data; } catch { continue; }
      const id = path.posix.basename(file, '.md');
      const record = approvals.find((entry) => entry.kind === kind && entry.target === id);
      nodes.set(id, { id, kind, raw, data, approved: data.status === 'approved' && (!record || record.digest === researchDigest(raw, kind)) });
    }
  }
  return nodes;
}

/** project.md and its approved revision number, if the current text is approved. */
export async function loadProjectRevision(files: LoopFiles, paths: ManuscriptPaths): Promise<{ project: string; revision?: number }> {
  const project = await files.readFile(paths.projectMd).catch(() => '');
  if (!project) return { project };
  const approvals = (await readApprovals(files, paths.researchRoot)).records;
  return { project, revision: currentProjectRevision(await projectRevisionHistory(files, paths.researchRoot, approvals), project)?.revision };
}

export async function readSectionBinding(files: LoopFiles, paths: ManuscriptPaths, id: string): Promise<SectionBinding | undefined> {
  const file = bindingPath(paths, id);
  const raw = await files.readFile(file).catch(() => '');
  if (!raw.trim()) return undefined;
  const binding = JSON.parse(raw) as SectionBinding;
  if (binding.version !== 1 || binding.section !== id || !Array.isArray(binding.sources)) throw new Error(`Invalid binding ${file}`);
  return binding;
}

export async function readSectionBriefFile(files: LoopFiles, paths: ManuscriptPaths, section: WritingSection): Promise<SectionBrief> {
  const brief = parseSectionBrief(await files.readFile(`${paths.writingSections}/${section.id}.md`), section.id);
  if (brief.title !== section.title) throw new Error(`Outline title and brief title differ for ${section.id}`);
  return brief;
}

/** Impact of the current research on the manuscript; undefined when there is no writing outline yet. */
export async function loadManuscriptImpact(files: LoopFiles, paths: ManuscriptPaths, only?: string): Promise<ManuscriptImpact | undefined> {
  const raw = await files.readFile(paths.writingOutline).catch(() => '');
  let outline: WritingSection[];
  try { outline = parseWritingOutline(raw); } catch { return undefined; }
  if (only && !outline.some((section) => section.id === only)) throw new Error(`Section ${only} is not listed in the writing outline`);
  const { project, revision } = await loadProjectRevision(files, paths);
  const sections = await Promise.all(outline.filter((section) => !only || section.id === only).map(async (section) => ({
    id: section.id, title: section.title,
    brief: await readSectionBriefFile(files, paths, section).catch(() => undefined),
    binding: await readSectionBinding(files, paths, section.id),
    texRaw: await files.readFile(sectionTexPath(paths, section.id)).catch(() => undefined),
  })));
  return manuscriptImpact({ project, projectRevision: revision, sections, nodes: await loadImpactNodes(files, paths) });
}
