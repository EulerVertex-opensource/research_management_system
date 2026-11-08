import type { ProjectPaths } from '../models/types';
import type { CollectionView } from '../models/packages';
import { LoopFiles } from './ResearchLoopModel';
import { approvalRecordPath } from './ApprovalStore';
import { parseMarkdown } from './Frontmatter';
import { PackageService } from './PackageService';
import { LIBRARY_KIND_FOLDERS, PACKAGE_LOCK_FILE, ResultKind, idOf, libraryCollections } from '../domain/registry';
import { bibField, parseBibEntries } from '../domain/bibtex';
import { CollectionNode, CollectionRemovePlan, collectionFile, planCollectionRemove, summarizeCollection } from '../domain/collections';

/**
 * Reads the library's hand-filled collections (from papers, notes, a thesis)
 * into the summaries `domain/collections.ts` computes, and removes a whole
 * collection. Imported packages are left to PackageService. No `vscode` import.
 */

export class CollectionService {
  constructor(private readonly files: LoopFiles, private readonly paths: ProjectPaths) {}

  /** Collections that are not imported packages and hold at least one file. */
  async names(): Promise<string[]> {
    const names: string[] = [];
    for (const name of await libraryCollections(this.files, this.paths)) {
      const root = `${this.paths.library}/${name}`;
      if (await this.files.exists(`${root}/${PACKAGE_LOCK_FILE}`)) continue;
      const nodes = await this.nodes(name);
      if (nodes.length || await this.files.exists(collectionFile(this.paths.library, name))) names.push(name);
    }
    return names;
  }

  async nodes(name: string): Promise<CollectionNode[]> {
    const nodes: CollectionNode[] = [];
    for (const [kind, folder] of Object.entries(LIBRARY_KIND_FOLDERS) as Array<[ResultKind, string]>) {
      for (const file of await this.files.listFiles(`${this.paths.library}/${name}/${folder}`, '.md')) {
        let data: Record<string, any> = {};
        try { data = parseMarkdown(await this.files.readFile(file)).data; } catch { /* reported by the node validator */ }
        const source = data.source && typeof data.source === 'object' ? data.source : undefined;
        nodes.push({
          id: idOf(file), file, kind, title: String(data.title ?? idOf(file)),
          ...(typeof data.status === 'string' ? { status: data.status } : {}),
          ...(source ? { source: { kind: source.kind, paper_id: source.paper_id, location: source.location } } : {}),
        });
      }
    }
    return nodes;
  }

  private async paperIds(): Promise<Set<string>> {
    const index = await this.files.readFile(this.paths.paperIndex).catch(() => '');
    return new Set(index.match(/^##\s+([a-z][a-z0-9_]*)\s*$/gm)?.map((heading) => heading.replace(/^##\s+/, '').trim()) ?? []);
  }

  async summaries(): Promise<CollectionView[]> {
    const paperIds = await this.paperIds();
    const bib = new Map(parseBibEntries(await this.files.readFile(this.paths.bibliography).catch(() => '')).map((entry) => [entry.key, entry.raw]));
    const views: CollectionView[] = [];
    for (const name of await this.names()) {
      const metaFile = collectionFile(this.paths.library, name);
      const metaRaw = await this.files.exists(metaFile) ? await this.files.readFile(metaFile) : undefined;
      const summary = summarizeCollection(name, metaRaw, await this.nodes(name), { library: this.paths.library, paperIds });
      const raw = summary.paperId ? bib.get(summary.paperId) : undefined;
      const paperTitle = raw ? bibField(raw, 'title')?.replace(/[{}]/g, '') : undefined;
      views.push({ ...summary, ...(paperTitle ? { paperTitle } : {}), ...(summary.paperId && paperIds.has(summary.paperId) ? { paperIndexed: true } : {}) });
    }
    return views;
  }

  async problems(): Promise<string[]> {
    return (await this.summaries()).flatMap((summary) => summary.problems);
  }

  async previewRemove(name: string): Promise<CollectionRemovePlan> {
    if (!(await this.names()).includes(name)) throw new Error(`No collection named ${name} in ${this.paths.library} (an imported package is removed as a package).`);
    const nodes = await this.nodes(name);
    const summary = (await this.summaries()).find((item) => item.name === name)!;
    const references = (await new PackageService(this.files, this.paths).importProject(name)).references ?? new Map<string, string[]>();
    const metaFile = collectionFile(this.paths.library, name);
    const approvalFiles: string[] = [];
    for (const node of nodes) {
      const file = approvalRecordPath(this.paths.researchRoot, node.kind, node.id);
      if (await this.files.exists(file)) approvalFiles.push(file);
    }
    return planCollectionRemove(summary, nodes, { references, ...(await this.files.exists(metaFile) ? { metaFile } : {}), approvalFiles });
  }

  async applyRemove(plan: CollectionRemovePlan): Promise<void> {
    if (!plan.ok) throw new Error(`Cannot remove:\n${plan.conflicts.map((item) => `- ${item}`).join('\n')}`);
    if (!this.files.deleteFile) throw new Error('This file system cannot delete files.');
    for (const file of plan.deletes) await this.files.deleteFile(file);
    if (this.files.deleteEmptyDir) {
      const root = `${this.paths.library}/${plan.name}`;
      for (const folder of [...Object.values(LIBRARY_KIND_FOLDERS).map((kind) => `${root}/${kind}`), root]) await this.files.deleteEmptyDir(folder);
    }
  }
}

/** Problems of the hand-filled collections: collection.md well formed, and a paper collection's results cite that paper. */
export function collectionProblemsIn(files: LoopFiles, paths: ProjectPaths): Promise<string[]> {
  return new CollectionService(files, paths).problems();
}
