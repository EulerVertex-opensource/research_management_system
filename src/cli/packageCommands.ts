import * as fs from 'fs';
import * as path from 'path';
import { PackageService } from '../services/PackageService';
import { gitProvenance, loadPackage, sourceSpec } from '../services/PackageSources';
import { ExportPlan, ImportPlan, RemovePlan, ResearchPackage, packageFileName, serializePackage } from '../domain/packages';
import { NodeLoopFiles, loadProjectPaths } from './nodeFiles';
import type { ResearchLoopCore } from '../services/ResearchLoopCore';

/**
 * `research-loop package ...`: export this project as a research package,
 * import one into the library, update or remove it. Every command previews
 * by default and writes only with --apply.
 */

export const PACKAGE_USAGE = `  package export [--name N --cite KEY] [--exports a,b] [--version X.Y.Z] [--location id="Theorem 1.2"]... [--out FILE] [--apply]   (this project's approved results as a .rpkg.json package)
  package import <file.rpkg.json|project folder|git URL[#ref]> [--as alias] [--apply]   (vendor a package into the library as lib_<alias>_* results)
  package update <alias> [<file|folder|git URL[#ref]>] [--ref REF] [--apply]   (bring a new version from where it came, or elsewhere; shows what changed)
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
const bullets = (title: string, items: string[]) => items.length ? `${title}\n${items.map((item) => `  - ${item}`).join('\n')}` : '';

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
      ? `${update ? 'Updated' : 'Imported'}. ${update && plan.diff?.bump === 'none' ? 'Nothing changed.' : `The researcher accepts the package in the dashboard (Library or Needs you), or with package approve ${plan.alias} --interactive in their own terminal; the loop then uses its results as known.`}`
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
        out(`${lock.alias} | ${lock.package} ${lock.version} | ${Object.keys(lock.nodes).length} results | ${approval} | from ${sourceSpec(lock.source)}${lock.resolved && lock.source.type === 'git' ? ` (${lock.resolved.slice(0, 8)})` : ''}`);
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
      const origin = await gitProvenance(root, paths, context.extensionVersion);
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
      if (!third) throw new Error('package import <file.rpkg.json|project folder|git URL[#ref]> [--as alias] [--apply]');
      const { pkg, source, resolved } = await loadPackage(third, root, context.extensionVersion);
      const plan = await service.previewImport(pkg, { alias: flag(args, 'as'), source, ...(resolved ? { resolved } : {}), now: new Date().toISOString() });
      if (apply && plan.ok) { guardLoop(); await service.applyImport(plan); }
      out(json ? { ...plan, writes: plan.writes.map((write) => write.file), bib: undefined, papersIndex: undefined, applied: apply && plan.ok } : describeImport(pkg, plan, false, apply && plan.ok));
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    case 'update': {
      if (!third) throw new Error('package update <alias> [<file|folder|git URL[#ref]>] [--ref REF] [--apply]');
      const lock = await service.lockFor(third);
      const spec = args.positional[3] ?? sourceSpec(lock.source, flag(args, 'ref'));
      const { pkg, source, resolved } = await loadPackage(spec, root, context.extensionVersion);
      const plan = await service.previewUpdate(third, pkg, { source, ...(resolved ? { resolved } : {}), now: new Date().toISOString() });
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
