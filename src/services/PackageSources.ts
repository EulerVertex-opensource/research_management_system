import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_PATH } from './ProjectPathsCore';
import { PackageService } from './PackageService';
import { PackageProvenance, PackageSource, ResearchPackage, parsePackage } from '../domain/packages';
import type { ProjectPaths } from '../models/types';
import { NodeLoopFiles, loadProjectPaths, loadSyncConfig } from '../cli/nodeFiles';
import { NodeGitRunner } from '../cli/nodeGit';

/**
 * Where packages come from: a `.rpkg.json` file, or another project's folder
 * built on the spot. Node-only (fs, git); shared by the CLI and the extension.
 */

const toPosix = (value: string) => value.split(path.sep).join('/');

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

export async function gitProvenance(root: string, paths: ProjectPaths, extensionVersion?: string): Promise<PackageProvenance> {
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
    const plan = await new PackageService(new NodeLoopFiles(full), paths).previewExport(await gitProvenance(full, paths, extensionVersion), { dev: true });
    if (!plan.ok || !plan.package) throw new Error(`The project at ${spec} cannot be exported yet:\n${plan.blockers.map((item) => `- ${item}`).join('\n')}`);
    return { pkg: plan.package, source: { type: 'project', path: relative } };
  }
  return { pkg: parsePackage(fs.readFileSync(full, 'utf8')), source: { type: 'file', path: relative } };
}
