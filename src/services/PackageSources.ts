import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_CONFIG_PATH, pathsFromConfigText } from './ProjectPathsCore';
import { PackageService } from './PackageService';
import { PackageProvenance, PackageSource, ResearchPackage, parsePackage } from '../domain/packages';
import type { ProjectPaths } from '../models/types';
import { NodeLoopFiles, loadProjectPaths, loadSyncConfig } from '../cli/nodeFiles';
import { NodeGitRunner } from '../cli/nodeGit';

/**
 * Where packages come from: a `.rpkg.json` file, another project's folder
 * built on the spot, or a git URL fetched into a local cache and built at the
 * commit a ref names. Node-only (fs, git); shared by the CLI and the extension.
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

/** A git source: `<url>` or `<url>#<ref>` (a branch, tag, or commit), like npm's git dependencies. */
export function parseGitSpec(spec: string): { url: string; ref?: string } | undefined {
  const trimmed = spec.trim();
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@[^:]+:)/.test(trimmed)) return undefined;
  const hash = trimmed.lastIndexOf('#');
  const url = hash > 0 ? trimmed.slice(0, hash) : trimmed;
  const ref = hash > 0 ? trimmed.slice(hash + 1).trim() : '';
  return { url, ...(ref ? { ref } : {}) };
}

/** The spec of a recorded git source, to fetch it again. */
export function gitSpec(source: { url: string; ref?: string }): string {
  return source.ref ? `${source.url}#${source.ref}` : source.url;
}

/** A URL safe to record for any scheme: https without credentials, others as given (ssh carries none). */
function recordableUrl(url: string): string {
  return /^https?:\/\//.test(url) ? shareableRemote(url) ?? url : url;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

async function gitMust(git: NodeGitRunner, args: string[], what: string): Promise<string> {
  const result = await git.run(args);
  if (result.code !== 0) throw new Error(`${what}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return result.stdout;
}

/**
 * Fetch a git source into this project's local cache (a bare partial clone
 * under research-local/package-cache/, ignored by git) and resolve the ref to
 * a commit. Uses the researcher's own git credentials; never prompts.
 */
export async function fetchGitSource(root: string, url: string, ref?: string): Promise<{ cache: string; commit: string }> {
  if (ref && !REF.test(ref)) throw new Error(`Not a git ref: ${ref}`);
  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const cache = path.join(root, 'research-local', 'package-cache', key);
  const local = new NodeGitRunner(root);
  if (!fs.existsSync(path.join(cache, 'HEAD'))) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    await gitMust(local, ['clone', '--bare', '--quiet', '--filter=blob:none', url, cache], `Could not fetch ${recordableUrl(url)}`);
  } else {
    const git = new NodeGitRunner(cache);
    await git.run(['remote', 'set-url', 'origin', url]);
    await gitMust(git, ['fetch', '--quiet', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], `Could not fetch ${recordableUrl(url)}`);
  }
  const git = new NodeGitRunner(cache);
  let resolved = await git.run(['rev-parse', '--verify', '--quiet', `${ref ?? 'HEAD'}^{commit}`]);
  if (resolved.code !== 0 && ref) {
    // A commit that no branch or tag names: ask for it directly.
    await git.run(['fetch', '--quiet', 'origin', ref]);
    resolved = await git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  }
  if (resolved.code !== 0) throw new Error(`${recordableUrl(url)} has no ${ref ? `branch, tag, or commit ${ref}` : 'default branch'}.`);
  return { cache, commit: resolved.stdout.trim() };
}

/** Build a package from a project folder; `provenance` says where it came from. */
async function buildFromProject(folder: string, label: string, provenance: PackageProvenance): Promise<ResearchPackage> {
  const paths = await loadProjectPaths(folder);
  const plan = await new PackageService(new NodeLoopFiles(folder), paths).previewExport(provenance, { dev: true });
  if (!plan.ok || !plan.package) throw new Error(`The project at ${label} cannot be exported yet:\n${plan.blockers.map((item) => `- ${item}`).join('\n')}`);
  return plan.package;
}

/**
 * Build the package a git source holds at a commit: check out only the
 * research files (config, research folders, bibliography, paper index) into a
 * scratch folder, build there, and remove it. The version is the release the
 * commit records when its content matches, else a `-dev` prerelease.
 */
async function packageFromGit(root: string, url: string, ref: string | undefined, extensionVersion?: string): Promise<{ pkg: ResearchPackage; commit: string }> {
  const { cache, commit } = await fetchGitSource(root, url, ref);
  const git = new NodeGitRunner(cache);
  const config = await git.run(['show', `${commit}:${PROJECT_CONFIG_PATH}`]);
  if (config.code !== 0) throw new Error(`${recordableUrl(url)}${ref ? `#${ref}` : ''} is not a Research Assistant project (no ${PROJECT_CONFIG_PATH} at ${commit.slice(0, 8)}).`);
  const paths = pathsFromConfigText(config.stdout);
  const wanted = [PROJECT_CONFIG_PATH, paths.researchRoot === '.' ? '.' : paths.researchRoot, paths.bibliography, paths.paperIndex];
  const present = (await gitMust(git, ['ls-tree', '--name-only', commit, '--', ...new Set(wanted)], 'Could not read the project')).split('\n').filter(Boolean);
  const tree = fs.mkdtempSync(path.join(cache, '..', `tree-${commit.slice(0, 8)}-`));
  try {
    // One checkout fetches the blobs it needs in a batch, unlike reading files one by one from a partial clone.
    await gitMust(new NodeGitRunner(tree), [`--git-dir=${cache}`, `--work-tree=${tree}`, 'checkout', commit, '--', ...present], 'Could not check out the research files');
    const pkg = await buildFromProject(tree, `${recordableUrl(url)}${ref ? `#${ref}` : ''}`, {
      commit, remote: recordableUrl(url), exportedAt: new Date().toISOString(), ...(extensionVersion ? { extensionVersion } : {}),
    });
    return { pkg, commit };
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * Read a package from a .rpkg.json file, build one from another project's
 * folder, or fetch one from git (`<url>` or `<url>#<ref>`). Folder and git
 * builds get a `-dev` version when the content changed since their last release.
 */
export async function loadPackage(spec: string, root: string, extensionVersion?: string): Promise<{ pkg: ResearchPackage; source: PackageSource; resolved?: string }> {
  const git = parseGitSpec(spec);
  if (git) {
    const { pkg, commit } = await packageFromGit(root, git.url, git.ref, extensionVersion);
    return { pkg, source: { type: 'git', url: recordableUrl(git.url), ...(git.ref ? { ref: git.ref } : {}) }, resolved: commit };
  }
  const full = path.resolve(root, spec);
  if (!fs.existsSync(full)) throw new Error(`No such file or folder: ${spec}`);
  const relative = toPosix(path.relative(root, full)) || '.';
  if (fs.statSync(full).isDirectory()) {
    if (path.resolve(full) === path.resolve(root)) throw new Error('A project cannot import itself.');
    if (!fs.existsSync(path.join(full, PROJECT_CONFIG_PATH))) throw new Error(`${spec} is not a Research Assistant project (no ${PROJECT_CONFIG_PATH}).`);
    const paths = await loadProjectPaths(full);
    return { pkg: await buildFromProject(full, spec, await gitProvenance(full, paths, extensionVersion)), source: { type: 'project', path: relative } };
  }
  return { pkg: parsePackage(fs.readFileSync(full, 'utf8')), source: { type: 'file', path: relative } };
}

/** The spec to update an installed package from: its recorded source, with the ref replaced when given. */
export function sourceSpec(source: PackageSource, ref?: string): string {
  if (source.type === 'git') return gitSpec({ url: source.url, ...(ref ?? source.ref ? { ref: ref ?? source.ref } : {}) });
  if (ref) throw new Error('--ref applies only to packages imported from git.');
  return source.path;
}
