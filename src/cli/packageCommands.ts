import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_PATH } from '../services/ProjectPathsCore';
import { PackageService } from '../services/PackageService';
import { ExportPlan, ImportPlan, PackageProvenance, PackageSource, RemovePlan, ResearchPackage, packageFileName, parsePackage, serializePackage } from '../domain/packages';
import type { ProjectPaths } from '../models/types';
import { NodeLoopFiles, loadProjectPaths, loadSyncConfig } from './nodeFiles';
import { NodeGitRunner } from './nodeGit';
import type { ResearchLoopCore } from '../services/ResearchLoopCore';

/**
 * `research-loop package ...`: export this project as a research package,
 * import one into the library, update or remove it. Every command previews
 * by default and writes only with --apply.
 */

export const PACKAGE_USAGE = `  package export [--name N --cite KEY] [--exports a,b] [--version X.Y.Z] [--location id="Theorem 1.2"]... [--out FILE] [--apply]   (this project's approved results as a .rpkg.json package)
  package import <file.rpkg.json|project folder> [--as alias] [--apply]   (vendor a package into the library as lib_<alias>_* results)
  package update <alias> [<file|folder>] [--apply]   (bring a new version; shows what changed)
  package remove <alias> [--force] [--apply]
  package approve <alias> --interactive   (the researcher, in their own terminal: accept every result of the package at once)
  package list | package verify`;

interface PackageArgs { positional: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> }
interface PackageContext {
  root: string;
  out: (value: unknown) => void;
  json: boolean;
  /** A loop stage is in progress: importing would change files outside the stage. */
  loopRunning: boolean;
  extensionVersion?: string;
  core: ResearchLoopCore;
  /** Ask the researcher on their terminal; throws when none is attached (an agent's shell). */
  confirm: (text: string, word: string, elsewhere: string) => boolean;
}

const flag = (args: PackageArgs, name: string) => typeof args.flags[name] === 'string' ? args.flags[name] as string : undefined;
const toPosix = (value: string) => value.split(path.sep).join('/');
const bullets = (title: string, items: string[]) => items.length ? `${title}\n${items.map((item) => `  - ${item}`).join('\n')}` : '';

/** A remote URL safe to record: https only, credentials removed (Overleaf URLs can carry a token). */
export function shareableRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!/^https?:\/\//.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch { return undefined; }
}

async function provenance(root: string, paths: ProjectPaths, extensionVersion?: string): Promise<PackageProvenance> {
  const git = new NodeGitRunner(root);
  const head = await git.run(['rev-parse', 'HEAD']);
  const remoteName = (await loadSyncConfig(root).catch(() => undefined))?.remote ?? 'origin';
  const remote = await git.run(['remote', 'get-url', remoteName]);
  const status = await git.run(['status', '--porcelain', '--', paths.researchRoot === '.' ? paths.assets : paths.researchRoot, paths.bibliography, paths.paperIndex]);
  return {
    ...(head.code === 0 && head.stdout.trim() ? { commit: head.stdout.trim() } : {}),
    ...(remote.code === 0 && shareableRemote(remote.stdout) ? { remote: shareableRemote(remote.stdout) } : {}),
    exportedAt: new Date().toISOString(),
    ...(extensionVersion ? { extensionVersion } : {}),
    ...(status.code === 0 && status.stdout.trim() ? { dirty: true } : {}),
  };
}

/** Read a package from a .rpkg.json file, or build one from another project's folder (a `-dev` version when it changed since its last release). */
export async function loadPackage(spec: string, root: string, extensionVersion?: string): Promise<{ pkg: ResearchPackage; source: PackageSource }> {
  if (/^(https?:|git@|ssh:|git:)/.test(spec)) throw new Error('Importing straight from a git URL is not supported yet: clone the project and import its folder, or import an exported .rpkg.json file.');
  const full = path.resolve(root, spec);
  if (!fs.existsSync(full)) throw new Error(`No such file or folder: ${spec}`);
  const relative = toPosix(path.relative(root, full)) || '.';
  if (fs.statSync(full).isDirectory()) {
    if (path.resolve(full) === path.resolve(root)) throw new Error('A project cannot import itself.');
    if (!fs.existsSync(path.join(full, PROJECT_CONFIG_PATH))) throw new Error(`${spec} is not a Research Assistant project (no ${PROJECT_CONFIG_PATH}).`);
    const paths = await loadProjectPaths(full);
    const plan = await new PackageService(new NodeLoopFiles(full), paths).previewExport(await provenance(full, paths, extensionVersion), { dev: true });
    if (!plan.ok || !plan.package) throw new Error(`The project at ${spec} cannot be exported yet:\n${plan.blockers.map((item) => `- ${item}`).join('\n')}`);
    return { pkg: plan.package, source: { type: 'project', path: relative } };
  }
  return { pkg: parsePackage(fs.readFileSync(full, 'utf8')), source: { type: 'file', path: relative } };
}

function describeExport(plan: ExportPlan & { manifest: { name?: string } }, applied?: string): string {
  const change = plan.unchanged ? `unchanged since ${plan.previous}` : plan.previous ? `${plan.bump} change since ${plan.previous}` : 'first release';
  const changes = plan.changes;
  return [
    `Package ${plan.manifest.name ?? '(unnamed)'} ${plan.version} (${change})`,
    `Exports: ${plan.exports.join(', ') || '(none)'}`,
    bullets(`Results and definitions included (${plan.closure.length}):`, plan.closure.map((node) => `${node.id} (${node.kind}${node.origin === 'library' ? ', library' : ''}): ${node.title}`)),
    bullets('Changes:', [
      ...changes.added.map((id) => `added ${id}`), ...changes.removed.map((id) => `removed ${id}`),
      ...changes.statement.map((id) => `statement changed: ${id}`), ...changes.proof.map((id) => `proof changed: ${id}`),
      ...changes.exportsAdded.map((id) => `newly exported: ${id}`), ...changes.exportsRemoved.map((id) => `no longer exported: ${id}`),
    ]),
    bullets('Blocked:', plan.blockers),
    bullets('Warnings:', plan.warnings),
    applied ? `Wrote ${applied}.${plan.release ? ` Recorded release ${plan.version}; commit research/package/ so collaborators share the history.` : ''}` : plan.ok ? 'Run again with --apply to write the package.' : '',
  ].filter(Boolean).join('\n');
}

function describeImport(pkg: ResearchPackage, plan: ImportPlan, update: boolean, applied: boolean): string {
  const diff = plan.diff;
  return [
    update ? `Update ${plan.alias}: ${pkg.name} ${diff?.from ?? '?'} → ${pkg.version}${diff ? ` (${diff.bump})` : ''}` : `Import ${pkg.name} ${pkg.version} as ${plan.alias} into ${plan.collection}/`,
    diff ? bullets('Changes:', [
      ...diff.added.map((id) => `added ${id}`), ...diff.removed.map((id) => `removed ${id}`),
      ...diff.statement.map((id) => `statement changed: ${id} (results here that use it need re-approval)`), ...diff.proof.map((id) => `proof changed: ${id}`),
    ]) : bullets(`Results and definitions (${plan.nodes.length}):`, plan.nodes.map((node) => `${node.id} ← ${node.upstream} (${node.kind}): ${node.title}`)),
    bullets('Bibliography:', plan.bibChanges.filter((item) => !item.unchanged).map((item) => item.action === 'renamed' ? `${item.key} → ${item.as} (renamed: the key is taken by another work)` : item.action === 'reused' ? `${item.key}${item.as !== item.key ? ` → ${item.as}` : ''} (already in the bibliography)` : `${item.key} (added)`)),
    bullets('Conflicts:', plan.conflicts),
    bullets('Warnings:', plan.warnings),
    applied
      ? `${update ? 'Updated' : 'Imported'}. The researcher reviews and approves the package's results in the dashboard (Library, collection ${plan.alias}); the loop then uses them as known.`
      : plan.ok ? 'Run again with --apply to write these files.' : '',
  ].filter(Boolean).join('\n');
}

function describeRemove(alias: string, plan: RemovePlan, applied: boolean): string {
  return [
    `Remove package ${alias}: ${plan.deletes.length} file(s)${plan.removedBibKeys.length ? `, BibTeX entries ${plan.removedBibKeys.join(', ')}` : ''}`,
    bullets('Conflicts:', plan.conflicts),
    bullets('Warnings:', plan.warnings),
    applied ? 'Removed.' : plan.ok ? 'Run again with --apply to remove.' : 'Repoint those results first, or pass --force.',
  ].filter(Boolean).join('\n');
}

export async function runPackage(sub: string | undefined, args: PackageArgs, context: PackageContext): Promise<void> {
  const { root, out, json } = context;
  const paths = await loadProjectPaths(root);
  const service = new PackageService(new NodeLoopFiles(root), paths);
  const apply = args.flags.apply === true;
  const third = args.positional[2];
  const guardLoop = () => {
    if (apply && context.loopRunning) throw new Error('A research loop stage is in progress; pause the loop (research-loop pause) before changing packages, since this changes the library and the bibliography outside the stage.');
  };
  switch (sub) {
    case 'list': {
      const installed = await service.installed();
      if (json) { out(installed.map((item) => item.lock)); return; }
      if (!installed.length) { out('No packages imported.'); return; }
      for (const { lock } of installed) {
        const status = await context.core.packageStatus(lock.alias).catch(() => undefined);
        const approval = !status ? '?' : status.approved ? `accepted${status.approvedVersion && status.approvedVersion !== lock.version ? ` (${status.approvedVersion} reviewed earlier)` : ''}` : `${status.pending.length} to review`;
        out(`${lock.alias} | ${lock.package} ${lock.version} | ${Object.keys(lock.nodes).length} results | ${approval} | from ${lock.source.type === 'git' ? lock.source.url : lock.source.path}`);
      }
      return;
    }
    case 'verify': {
      const problems = await service.problems();
      if (json) out({ problems });
      else out(problems.length ? problems.join('\n') : 'All imported packages match their lockfiles.');
      if (problems.length) process.exitCode = 1;
      return;
    }
    case 'export': {
      const manifest = {
        ...(flag(args, 'name') ? { name: flag(args, 'name') } : {}),
        ...(flag(args, 'cite') ? { cite: flag(args, 'cite') } : {}),
        ...(flag(args, 'exports') ? { exports: flag(args, 'exports')!.split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      };
      const locations: Record<string, string> = {};
      for (const item of args.lists.location ?? []) {
        const at = item.indexOf('=');
        if (at <= 0) throw new Error(`--location expects id=location, got ${item}`);
        locations[item.slice(0, at).trim()] = item.slice(at + 1).trim();
      }
      // Locations are saved in the manifest so every later build (and a folder import) cites the same place.
      const options = { manifest: { ...manifest, ...(Object.keys(locations).length ? { locations } : {}) }, version: flag(args, 'version') };
      const origin = await provenance(root, paths, context.extensionVersion);
      if (!apply) {
        const plan = await service.previewExport(origin, options);
        out(json ? { ...plan, package: undefined } : describeExport(plan));
        if (!plan.ok) process.exitCode = 1;
        return;
      }
      const plan = await service.export(origin, options);
      const target = path.resolve(root, flag(args, 'out') ?? path.join('research-local', 'packages', packageFileName(plan.package!)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serializePackage(plan.package!), 'utf8');
      out(json ? { ...plan, package: undefined, file: target } : describeExport(plan, target));
      return;
    }
    case 'import': {
      if (!third) throw new Error('package import <file.rpkg.json|project folder> [--as alias] [--apply]');
      const { pkg, source } = await loadPackage(third, root, context.extensionVersion);
      const plan = await service.previewImport(pkg, { alias: flag(args, 'as'), source, now: new Date().toISOString() });
      if (apply && plan.ok) { guardLoop(); await service.applyImport(plan); }
      out(json ? { ...plan, writes: plan.writes.map((write) => write.file), bib: undefined, papersIndex: undefined, applied: apply && plan.ok } : describeImport(pkg, plan, false, apply && plan.ok));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    case 'update': {
      if (!third) throw new Error('package update <alias> [<file|folder>] [--apply]');
      const lock = await service.lockFor(third);
      const spec = args.positional[3] ?? (lock.source.type === 'git' ? undefined : lock.source.path);
      if (!spec) throw new Error(`${third} came from git; pass the file or folder to update from.`);
      const { pkg, source } = await loadPackage(spec, root, context.extensionVersion);
      const plan = await service.previewUpdate(third, pkg, { source, now: new Date().toISOString() });
      const details: Array<{ id: string; reason: string }> = [];
      if (apply && plan.ok) {
        guardLoop();
        await service.applyImport(plan);
        // Changed results lose their approval; approved results here that rest on a changed statement are reverted or flagged, per the rigor setting.
        await context.core.reconcile(undefined, { details });
      }
      const affected = details.map((item) => `${item.id}: ${item.reason.replace(/^recheck:/, 'recheck, rests on ').replace(/^content_changed$/, 'changed in the new version').replace(/^dependency_changed:/, 'reverted, rests on ')}`);
      out(json ? { ...plan, writes: plan.writes.map((write) => write.file), bib: undefined, papersIndex: undefined, applied: apply && plan.ok, reconciled: details } : [describeImport(pkg, plan, true, apply && plan.ok), bullets('Approvals affected:', affected)].filter(Boolean).join('\n'));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    case 'remove': {
      if (!third) throw new Error('package remove <alias> [--force] [--apply]');
      const plan = await service.previewRemove(third, { force: args.flags.force === true });
      if (apply && plan.ok) { guardLoop(); await service.applyRemove(plan); }
      out(json ? { ...plan, bib: undefined, papersIndex: undefined, applied: apply && plan.ok } : describeRemove(third, plan, apply && plan.ok));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    case 'approve': {
      if (!third) throw new Error('package approve <alias> --interactive');
      const lock = await service.lockFor(third);
      // Only the researcher accepts results: in VS Code (Needs you) or here, typed at their own terminal.
      if (args.flags.interactive !== true) throw new Error(`Only the researcher accepts a package: in the dashboard (Needs you), or by running package approve ${third} --interactive in their own terminal.`);
      const status = await context.core.packageStatus(third);
      if (status.approved) { out(`${lock.package} ${lock.version} (${third}) is already accepted.`); return; }
      const question = `Accept package ${lock.package} ${lock.version} as known results? ${Object.keys(lock.nodes).length} results and definitions in ${paths.library}/${third}; the research loop will use them without re-proving them.`;
      if (!context.confirm(question, 'yes', 'accept it in VS Code instead (Needs you)')) { out('Not accepted.'); return; }
      const ids = await context.core.approvePackage(third, 'terminal');
      out(json ? { approved: ids } : `Accepted ${lock.package} ${lock.version}: ${ids.length} results now count as known.`);
      return;
    }
    default:
      throw new Error(`package export|import|update|remove|approve|list|verify\n${PACKAGE_USAGE}`);
  }
}
