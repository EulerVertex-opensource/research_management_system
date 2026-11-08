import type { ProjectPaths } from '../models/types';
import type { CitationView, ExportPreviewView, ExportRequest, ImportPreviewView, PackagesPayload } from '../models/packages';
import type { ResearchLoopCore } from './ResearchLoopCore';
import { LoopFiles } from './ResearchLoopModel';
import { PackageService } from './PackageService';
import { CollectionService } from './CollectionService';
import type { CollectionRemovePlan } from '../domain/collections';
import { gitProvenance, loadPackage, sourceSpec } from './PackageSources';
import { parseMarkdown } from './Frontmatter';
import { ImportPlan, PackageManifest, RemovePlan, citationCheck, citationTemplate, latestRelease, packageFileName, serializePackage } from '../domain/packages';

/**
 * The dashboard's package actions: each returns plain data for the webview,
 * and every change goes through the same PackageService and loop core as the
 * CLI. No `vscode` import: dialogs and confirmations stay with the caller.
 */

type WithCore = <T>(action: (core: ResearchLoopCore) => Promise<T>) => Promise<T>;

export class PackageActions {
  readonly service: PackageService;
  readonly collections: CollectionService;

  constructor(
    private readonly files: LoopFiles,
    private readonly paths: ProjectPaths,
    private readonly root: string,
    private readonly withCore: WithCore,
    private readonly extensionVersion?: string,
  ) {
    this.service = new PackageService(files, paths);
    this.collections = new CollectionService(files, paths);
  }

  async overview(): Promise<PackagesPayload> {
    const problems = await this.service.problems();
    const installed = [];
    for (const { lock } of await this.service.installed()) {
      const status = await this.withCore((core) => core.packageStatus(lock.alias)).catch(() => undefined);
      installed.push({
        alias: lock.alias, package: lock.package, version: lock.version, results: Object.keys(lock.nodes).length,
        pending: status?.pending.length ?? Object.keys(lock.nodes).length, accepted: Boolean(status?.approved),
        ...(status?.approvedVersion && status.approvedVersion !== lock.version ? { approvedVersion: status.approvedVersion } : {}),
        source: sourceSpec(lock.source),
        problems: problems.filter((problem) => problem.startsWith(`${this.paths.library}/${lock.alias}/`)),
      });
    }
    const manifest = await this.service.manifest().catch(() => undefined);
    const released = latestRelease(await this.service.releases().catch(() => []))?.version;
    const collections = await this.collections.summaries();
    return { library: this.paths.library, ...(manifest ? { manifest } : {}), installed, collections, ...(released ? { released } : {}) };
  }

  private exportOptions(request: ExportRequest) {
    const manifest: Partial<PackageManifest> = {
      ...(request.name !== undefined ? { name: request.name.trim() } : {}),
      ...(request.exports !== undefined ? { exports: request.exports } : {}),
      ...(request.locations ? { locations: Object.fromEntries(Object.entries(request.locations).map(([id, text]) => [id, text.trim()]).filter(([, text]) => text)) } : {}),
    };
    return { manifest, ...(request.citation !== undefined ? { citation: request.citation } : {}), ...(request.version?.trim() ? { version: request.version.trim() } : {}) };
  }

  async previewExport(request: ExportRequest = {}): Promise<ExportPreviewView> {
    const provenance = await gitProvenance(this.root, this.paths, this.extensionVersion);
    const plan = await this.service.previewExport(provenance, this.exportOptions(request));
    const saved = await this.service.citation();
    const input = await this.service.exportInput(plan.manifest, provenance, request.citation);
    const candidates = input.nodes.filter((node) => node.origin === 'project' && node.kind === 'asset').map((node) => {
      let title = node.id;
      try { title = String(parseMarkdown(node.raw).data.title ?? node.id); } catch { /* keep the ID */ }
      return { id: node.id, title, approved: node.approved, required: input.requiredResults.includes(node.id) };
    }).sort((a, b) => Number(b.required) - Number(a.required) || a.title.localeCompare(b.title));
    return {
      ok: plan.ok, blockers: plan.blockers, warnings: plan.warnings, manifest: plan.manifest, exports: plan.exports, closure: plan.closure,
      version: plan.version, ...(plan.previous ? { previous: plan.previous } : {}), bump: plan.bump, changes: plan.changes, unchanged: plan.unchanged,
      candidates, citation: request.citation ?? (saved || citationTemplate(plan.manifest.name)), citationSaved: Boolean(saved),
    };
  }

  /** This project's citation for the Settings page: the saved entry checked, or a template. */
  async citationView(name?: string): Promise<CitationView> {
    const saved = await this.service.citation();
    const manifestName = name ?? (await this.service.manifest().catch(() => undefined))?.name;
    const text = saved || citationTemplate(manifestName);
    const check = saved ? citationCheck(saved) : { problems: [], warnings: [] };
    return { path: this.service.citationPath, text, saved: Boolean(saved), ...(check.key ? { key: check.key } : {}), problems: check.problems, warnings: check.warnings };
  }

  /** Save this project's citation; an invalid entry is not written and its problems come back. */
  async saveCitation(text: string): Promise<CitationView> {
    const check = citationCheck(text);
    if (check.problems.length) return { path: this.service.citationPath, text, saved: Boolean(await this.service.citation()), problems: check.problems, warnings: check.warnings };
    await this.service.saveCitation(text);
    return this.citationView();
  }

  /** Export: saves the manifest and the release, and returns the package text to write where the researcher chose. */
  async export(request: ExportRequest): Promise<{ fileName: string; text: string; version: string; recorded: boolean }> {
    const provenance = await gitProvenance(this.root, this.paths, this.extensionVersion);
    const plan = await this.service.export(provenance, this.exportOptions(request));
    return { fileName: packageFileName(plan.package!), text: serializePackage(plan.package!), version: plan.version, recorded: Boolean(plan.release) };
  }

  /** The file name an export would get, for the save dialog. */
  async exportFileName(request: ExportRequest): Promise<string | undefined> {
    const preview = await this.previewExport(request);
    return preview.ok && preview.manifest.name ? packageFileName({ name: preview.manifest.name, version: preview.version }) : undefined;
  }

  private async plan(source: string, alias: string | undefined, update: string | undefined): Promise<{ plan: ImportPlan; name: string; version: string }> {
    const { pkg, source: origin, resolved } = await loadPackage(source, this.root, this.extensionVersion);
    const options = { source: origin, ...(resolved ? { resolved } : {}), now: new Date().toISOString() };
    const plan = update ? await this.service.previewUpdate(update, pkg, options) : await this.service.previewImport(pkg, { ...options, alias: alias?.trim() || undefined });
    return { plan, name: pkg.name, version: pkg.version };
  }

  async previewImport(source: string, alias?: string, update?: string): Promise<ImportPreviewView> {
    const { plan, name, version } = await this.plan(source, alias, update);
    return {
      ok: plan.ok, source, ...(update ? { update } : {}), name, version, alias: plan.alias,
      nodes: plan.nodes, bibChanges: plan.bibChanges, conflicts: plan.conflicts, warnings: plan.warnings, ...(plan.diff ? { diff: plan.diff } : {}),
    };
  }

  /** Where an update comes from by default: the installed package's recorded source (a git source fetches its ref again). */
  async updateSource(alias: string): Promise<string> {
    return sourceSpec((await this.service.lockFor(alias)).source);
  }

  private async guardLoop(): Promise<void> {
    const running = await this.withCore(async (core) => core.current?.status === 'running');
    if (running) throw new Error('A research loop stage is in progress. Pause the loop first: changing packages changes the library and the bibliography outside the stage.');
  }

  /** Import or update; returns what to tell the researcher. */
  async import(source: string, alias?: string, update?: string): Promise<{ message: string; affected: string[] }> {
    await this.guardLoop();
    const { plan, name, version } = await this.plan(source, alias, update);
    await this.service.applyImport(plan);
    const details: Array<{ id: string; reason: string }> = [];
    // An update re-opens changed results, and reverts or flags results here that rest on a changed statement.
    if (update) await this.withCore((core) => core.reconcile(undefined, { details }));
    const affected = details.map((item) => item.id);
    const message = update
      ? `Updated ${plan.alias} to ${name} ${version}.${affected.length ? ` Approvals affected: ${affected.join(', ')}.` : ''}`
      : `Imported ${name} ${version} as ${plan.alias} (${plan.nodes.length} results). Accept the package to use them as known.`;
    return { message, affected };
  }

  previewRemove(alias: string): Promise<RemovePlan> {
    return this.service.previewRemove(alias);
  }

  async remove(alias: string): Promise<void> {
    await this.guardLoop();
    await this.service.applyRemove(await this.service.previewRemove(alias));
  }

  previewRemoveCollection(name: string): Promise<CollectionRemovePlan> {
    return this.collections.previewRemove(name);
  }

  /** Remove a collection extracted from a paper or notes; its paper stays indexed. */
  async removeCollection(name: string): Promise<void> {
    await this.guardLoop();
    await this.collections.applyRemove(await this.collections.previewRemove(name));
  }

  approve(alias: string, source: string): Promise<string[]> {
    return this.withCore((core) => core.approvePackage(alias, source));
  }
}
