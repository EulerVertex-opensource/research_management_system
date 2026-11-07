import * as path from 'path';
import type { ProjectPaths } from '../models/types';
import { LoopFiles, isApproved } from './ResearchLoopModel';
import { approvalRecordPath, readApprovals } from './ApprovalStore';
import { parseMarkdown } from './Frontmatter';
import { requiredAssetIds } from '../domain/project';
import { RELATION_FIELDS } from '../domain/schema';
import { LIBRARY_KIND_FOLDERS, PACKAGE_DIR, PACKAGE_LOCK_FILE, ResultKind, idOf, libraryCollections, listNodeFiles, locateNodeFile } from '../domain/registry';
import { texCitations } from '../domain/bibtex';
import {
  CollectionSnapshot, ExportInput, ExportNodeInput, ExportOptions, ExportPlan, ImportOptions, ImportPlan, ImportProject, PackageLock, PackageManifest, PackageProvenance,
  PackageRelease, RemovePlan, ResearchPackage, lockPath, packageProblems, parseLock, planExport, planImport, planRemove,
} from '../domain/packages';

/**
 * Reads a project into the snapshots `domain/packages.ts` plans over, and
 * applies the plans. Used by the research-loop CLI and the extension alike;
 * no `vscode` import.
 */

export const packageFolder = (paths: Pick<ProjectPaths, 'researchRoot'>) => paths.researchRoot === '.' ? PACKAGE_DIR : `${paths.researchRoot}/${PACKAGE_DIR}`;

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export interface InstalledPackage { lock: PackageLock; file: string }

export class PackageService {
  constructor(private readonly files: LoopFiles, private readonly paths: ProjectPaths) {}

  get manifestPath(): string { return `${packageFolder(this.paths)}/manifest.json`; }
  get releasesPath(): string { return `${packageFolder(this.paths)}/releases.json`; }

  async manifest(): Promise<PackageManifest | undefined> {
    const raw = await this.files.readFile(this.manifestPath).catch(() => '');
    if (!raw.trim()) return undefined;
    try { return JSON.parse(raw) as PackageManifest; } catch { throw new Error(`${this.manifestPath}: invalid JSON.`); }
  }

  async releases(): Promise<PackageRelease[]> {
    const raw = await this.files.readFile(this.releasesPath).catch(() => '');
    if (!raw.trim()) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value as PackageRelease[] : [];
    } catch { throw new Error(`${this.releasesPath}: invalid JSON (merge conflict?).`); }
  }

  // ---------- export ----------

  async exportInput(manifest: PackageManifest, provenance: PackageProvenance): Promise<ExportInput> {
    const records = (await readApprovals(this.files, this.paths.researchRoot)).records;
    const nodes: ExportNodeInput[] = [];
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
        const raw = await this.files.readFile(file);
        const id = idOf(file);
        let data: Record<string, any>;
        try { data = parseMarkdown(raw).data; } catch { continue; }
        const record = records.find((item) => item.kind === kind && item.target === id);
        const approved = data.status === 'approved' && isApproved(records, kind, id, raw);
        nodes.push({
          id, kind, origin: locateNodeFile(file, this.paths)?.origin ?? 'project', raw, approved,
          ...(approved && record ? { approval: { ...(record.performed_by ? { by: record.performed_by } : {}), at: record.approvedAt, ...(record.base_commit ? { commit: record.base_commit } : {}) } } : {}),
        });
      }
    }
    return {
      manifest,
      requiredResults: requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => '')),
      nodes,
      bib: await this.files.readFile(this.paths.bibliography).catch(() => ''),
      papersIndex: await this.files.readFile(this.paths.paperIndex).catch(() => ''),
      releases: await this.releases(),
      provenance,
    };
  }

  /** What exporting would produce. `manifest` fills in or overrides the saved one (first export). */
  async previewExport(provenance: PackageProvenance, options: ExportOptions & { manifest?: Partial<PackageManifest> } = {}): Promise<ExportPlan & { manifest: PackageManifest }> {
    const saved = await this.manifest();
    const manifest = { ...(saved ?? {}), ...(options.manifest ?? {}) } as PackageManifest;
    if (options.manifest?.exports === undefined && saved?.exports === undefined) delete manifest.exports;
    // Locations accumulate: a new one is added to those saved, never replacing them all.
    const locations = { ...(saved?.locations ?? {}), ...(options.manifest?.locations ?? {}) };
    if (Object.keys(locations).length) manifest.locations = locations; else delete manifest.locations;
    return { ...planExport(await this.exportInput(manifest, provenance), options), manifest };
  }

  /** Export: save the manifest and record the release (unless nothing changed). Returns the plan with the package to write. */
  async export(provenance: PackageProvenance, options: ExportOptions & { manifest?: Partial<PackageManifest> } = {}): Promise<ExportPlan & { manifest: PackageManifest }> {
    const plan = await this.previewExport(provenance, options);
    if (!plan.ok || !plan.package) throw new Error(`Cannot export:\n${plan.blockers.map((item) => `- ${item}`).join('\n')}`);
    const saved = await this.manifest();
    if (JSON.stringify(saved) !== JSON.stringify(plan.manifest)) await this.files.writeFile(this.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);
    if (plan.release) await this.files.writeFile(this.releasesPath, `${JSON.stringify([...await this.releases(), plan.release], null, 2)}\n`);
    return plan;
  }

  // ---------- installed packages ----------

  async installed(): Promise<InstalledPackage[]> {
    const result: InstalledPackage[] = [];
    for (const collection of await libraryCollections(this.files, this.paths)) {
      const file = lockPath(this.paths.library, collection);
      if (!(await this.files.exists(file))) continue;
      result.push({ lock: parseLock(await this.files.readFile(file), file), file });
    }
    return result;
  }

  async lockFor(alias: string): Promise<PackageLock> {
    const file = lockPath(this.paths.library, alias);
    if (!(await this.files.exists(file))) throw new Error(`No imported package named ${alias} (package list shows them).`);
    return parseLock(await this.files.readFile(file), file);
  }

  /** The project as an import sees it. With `alias`, references and citations from inside that collection do not count. */
  async importProject(alias?: string): Promise<ImportProject> {
    const inside = alias ? `${this.paths.library}/${alias}/` : undefined;
    const nodeIds = new Set<string>();
    const references = new Map<string, string[]>();
    const citedElsewhere = new Set<string>();
    const approved = new Set<string>();
    const library = (await libraryCollections(this.files, this.paths)).flatMap((collection) => Object.values(LIBRARY_KIND_FOLDERS).map((kind) => `${this.paths.library}/${collection}/${kind}`));
    for (const folder of [this.paths.assets, this.paths.definitions, this.paths.ideas, this.paths.plans, ...library]) {
      for (const file of await this.files.listFiles(folder)) {
        const id = idOf(file);
        nodeIds.add(id);
        if (inside && file.startsWith(inside)) {
          if (/^status:\s*approved\s*$/m.test(await this.files.readFile(file).catch(() => ''))) approved.add(id);
          continue;
        }
        let data: Record<string, any>;
        try { data = parseMarkdown(await this.files.readFile(file)).data; } catch { continue; }
        for (const field of RELATION_FIELDS) {
          for (const target of [...list(data[field]), ...(typeof data[field] === 'string' ? [data[field]] : [])]) {
            references.set(target, [...(references.get(target) ?? []), id]);
          }
        }
        if (data.source && typeof data.source === 'object' && typeof data.source.paper_id === 'string') citedElsewhere.add(data.source.paper_id);
      }
    }
    for (const file of [this.paths.mainTex, ...await this.files.listFiles(this.paths.sections, '.tex')]) {
      for (const key of texCitations(await this.files.readFile(file).catch(() => ''))) citedElsewhere.add(key);
    }
    return {
      library: this.paths.library,
      ownPackage: (await this.manifest().catch(() => undefined))?.name,
      nodeIds,
      collections: await libraryCollections(this.files, this.paths),
      locks: (await this.installed()).map((item) => item.lock),
      bib: await this.files.readFile(this.paths.bibliography).catch(() => ''),
      papersIndex: await this.files.readFile(this.paths.paperIndex).catch(() => ''),
      references,
      citedElsewhere,
      approved,
    };
  }

  // ---------- import, update, remove ----------

  async previewImport(pkg: ResearchPackage, options: ImportOptions): Promise<ImportPlan> {
    return planImport(pkg, await this.importProject(), options);
  }

  async previewUpdate(alias: string, pkg: ResearchPackage, options: Omit<ImportOptions, 'alias'>): Promise<ImportPlan> {
    const installed = await this.lockFor(alias);
    return planImport(pkg, await this.importProject(alias), { ...options, alias }, installed);
  }

  async applyImport(plan: ImportPlan): Promise<void> {
    if (!plan.ok) throw new Error(`Cannot import:\n${plan.conflicts.map((item) => `- ${item}`).join('\n')}`);
    // The lockfile goes last: a crash part-way leaves files the validator reports, never a lock that vouches for missing ones.
    const lock = plan.writes.filter((write) => path.posix.basename(write.file) === PACKAGE_LOCK_FILE);
    for (const write of plan.writes.filter((item) => !lock.includes(item))) await this.files.writeFile(write.file, write.content);
    for (const file of plan.deletes) await this.remove(file);
    if (plan.bib !== undefined) await this.files.writeFile(this.paths.bibliography, plan.bib);
    if (plan.papersIndex !== undefined) await this.files.writeFile(this.paths.paperIndex, plan.papersIndex);
    for (const write of lock) await this.files.writeFile(write.file, write.content);
  }

  async previewRemove(alias: string, options: { force?: boolean } = {}): Promise<RemovePlan> {
    const lock = await this.lockFor(alias);
    const plan = planRemove(lock, await this.importProject(alias), options);
    // The package's approval record, and any per-result records of its results, go with it.
    const records = [approvalRecordPath(this.paths.researchRoot, 'package', alias), ...Object.entries(lock.nodes).map(([id, node]) => approvalRecordPath(this.paths.researchRoot, node.kind, id))];
    for (const file of records) if (await this.files.exists(file)) plan.deletes.push(file);
    return plan;
  }

  async applyRemove(plan: RemovePlan): Promise<void> {
    if (!plan.ok) throw new Error(`Cannot remove:\n${plan.conflicts.map((item) => `- ${item}`).join('\n')}`);
    for (const file of plan.deletes) await this.remove(file);
    if (plan.bib !== undefined) await this.files.writeFile(this.paths.bibliography, plan.bib);
    if (plan.papersIndex !== undefined) await this.files.writeFile(this.paths.paperIndex, plan.papersIndex);
  }

  private async remove(file: string): Promise<void> {
    if (!this.files.deleteFile) throw new Error('This file system cannot delete files.');
    await this.files.deleteFile(file);
  }

  // ---------- validation ----------

  async problems(): Promise<string[]> {
    return packageProblemsIn(this.files, this.paths);
  }
}

/** Package problems of a project: vendored files unedited and complete, no stray imported_from. */
export async function packageProblemsIn(files: LoopFiles, paths: ProjectPaths): Promise<string[]> {
  const collections: CollectionSnapshot[] = [];
  const imported = new Set<string>();
  for (const collection of await libraryCollections(files, paths)) {
    const lockFile = lockPath(paths.library, collection);
    if (!(await files.exists(lockFile))) continue;
    imported.add(collection);
    const nodeFiles: CollectionSnapshot['nodeFiles'] = [];
    for (const [kind, folder] of Object.entries(LIBRARY_KIND_FOLDERS) as Array<[ResultKind, string]>) {
      for (const file of await files.listFiles(`${paths.library}/${collection}/${folder}`)) nodeFiles.push({ file, id: idOf(file), kind, raw: await files.readFile(file) });
    }
    collections.push({ collection, lockFile, lockRaw: await files.readFile(lockFile), nodeFiles });
  }
  const strays: Array<{ file: string }> = [];
  for (const kind of ['asset', 'definition'] as const) {
    for (const file of await listNodeFiles(files, paths, kind)) {
      const location = locateNodeFile(file, paths);
      if (location?.origin === 'library' && location.collection && imported.has(location.collection)) continue;
      const raw = await files.readFile(file);
      if (!/^imported_from:/m.test(raw)) continue;
      try { if (parseMarkdown(raw).data.imported_from !== undefined) strays.push({ file }); } catch { /* reported by the node validator */ }
    }
  }
  return packageProblems(collections, strays);
}
