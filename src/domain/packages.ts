import { parseMarkdown, stringifyMarkdown } from '../services/Frontmatter';
import { proofDigest, researchDigest, sha, sortKeys, statementDigest } from './digests';
import { stripManagedBlocks } from './sections';
import { LIBRARY_KIND_FOLDERS, LIBRARY_PREFIX, PACKAGE_LOCK_FILE, ResultKind } from './registry';
import { CONJECTURE_TYPE } from './nodeKinds';
import { sourceKind } from './schema';
import {
  appendBibEntries, appendPaperSections, bibField, bibUrl, parseBibEntries, paperSections, removeBibEntries, removePaperSections, renameBibKey, sameIdentifier, sameWork,
} from './bibtex';

/**
 * Research packages: a finished project exported like a library module and
 * imported into another project's library. The design follows package
 * managers:
 *
 * - The public API is the approved results in `exports` (by default the
 *   project's required results) and everything they depend on; ideas, plans,
 *   checks, and all manuscript files stay behind.
 * - A statement is the interface and a proof the implementation, so versions
 *   follow semver from the statement and proof digests.
 * - An import is vendored: copied under `<library>/<alias>/` and pinned by a
 *   lockfile that records every node's digest, so local edits are detected
 *   and an update can say exactly what changed.
 * - A node keeps its upstream identity (`imported_from`) apart from its local
 *   ID (`lib_<alias>_<id>`), so two packages never collide and an update maps
 *   each node to its file.
 * - Only the citations the exported nodes use travel, merged into the
 *   importer's bibliography by the work they name.
 *
 * Pure: every function takes snapshots and returns plans; services apply them.
 */

export const PACKAGE_FORMAT = 'research-package';
export const PACKAGE_FORMAT_VERSION = 1;
export const LOCK_VERSION = 1;
export const PACKAGE_FILE_EXTENSION = '.rpkg.json';

const SLUG = /^[a-z][a-z0-9_]*$/;
const ALIAS = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_ALIAS = 24;

// ---------- types ----------

export interface PackageManifest {
  /** Global package name, lowercase snake_case. */
  name: string;
  /** Result IDs to export; absent means the project's required results. */
  exports?: string[];
  /**
   * Upstream ID → where an importer cites it (e.g. "Theorem 1.2"). Kept here, not per export,
   * so every build cites the same place: a location is part of an imported statement's source.
   */
  locations?: Record<string, string>;
}

export interface ReleaseNode { statement: string; proof: string }
export interface PackageRelease {
  version: string;
  /** contentDigest of the exported package (version-independent). */
  digest: string;
  commit?: string;
  exportedAt: string;
  exports: string[];
  nodes: Record<string, ReleaseNode>;
}

export interface UpstreamApproval { by?: string; at?: string; commit?: string }
export interface PackageNode { id: string; kind: ResultKind; raw: string; approval?: UpstreamApproval; location?: string }
export interface PackageProvenance { commit?: string; remote?: string; exportedAt: string; extensionVersion?: string; dirty?: boolean }

export interface ResearchPackage {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  name: string;
  version: string;
  provenance: PackageProvenance;
  /** How an importer cites this project: its BibTeX entry and paper-index section. */
  cite: { key: string; bibtex: string; paper?: string };
  exports: string[];
  nodes: PackageNode[];
  /** BibTeX entries the nodes cite, by key (the cite entry is separate). */
  bib: Record<string, string>;
  /** Paper-index sections for those keys. */
  papers: Record<string, string>;
  digest: string;
}

export type PackageSource = { type: 'file'; path: string } | { type: 'project'; path: string } | { type: 'git'; url: string; ref?: string };
export type BibAction = 'added' | 'reused' | 'renamed';

export interface LockNode {
  upstream: string;
  kind: ResultKind;
  /** researchDigest of the vendored file: what a local edit would change. */
  digest: string;
  statement: string;
  proof: string;
  approval?: UpstreamApproval;
}

export interface PackageLock {
  lockVersion: number;
  package: string;
  alias: string;
  version: string;
  /** The imported package's digest. */
  digest: string;
  source: PackageSource;
  resolved?: string;
  importedAt: string;
  /** Local IDs of the package's exports. */
  exports: string[];
  nodes: Record<string, LockNode>;
  /** Upstream BibTeX key → key in this project and what the import did. */
  bib: Record<string, { as: string; action: BibAction }>;
  /** Paper-index sections the import added (removed again with the package). */
  papers: string[];
}

export type Bump = 'initial' | 'major' | 'minor' | 'patch' | 'none';
export interface VersionChanges { added: string[]; removed: string[]; statement: string[]; proof: string[]; exportsAdded: string[]; exportsRemoved: string[] }

// ---------- semver ----------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export const isVersion = (value: string) => SEMVER.test(value);

export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return a.localeCompare(b);
  for (let index = 1; index <= 3; index++) {
    const diff = Number(x[index]) - Number(y[index]);
    if (diff) return Math.sign(diff);
  }
  // A prerelease sorts before its release.
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4].localeCompare(y[4]);
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = SEMVER.exec(version);
  if (!match || bump === 'initial') return '1.0.0';
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return version;
}

export function latestRelease(releases: PackageRelease[]): PackageRelease | undefined {
  return [...releases].sort((a, b) => compareVersions(a.version, b.version)).pop();
}

// ---------- helpers ----------

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const canonical = (value: unknown) => JSON.stringify(sortKeys(value) ?? null);
const dependencies = (data: Record<string, any>) => [...list(data.depends_on), ...list(data.uses_definitions)];

/** Markdown links to other research files become their text: local paths mean nothing in another project. */
function flattenFileLinks(text: string): string {
  return text.replace(/(?<!!)\[([^\]]+)\]\((?![a-z]+:)[^)\s]*\.md(?:#[^)\s]*)?\)/gi, '$1');
}

/**
 * The text of a node as it travels: the frontmatter an importer needs
 * (type, title, kind, source, dependencies, tags), the body without managed
 * blocks or links into this project. Status and relations that point outside
 * the export (derived_from, refutes, serves) are dropped.
 */
export function exportedRaw(raw: string, id: string): string {
  const parsed = parseMarkdown(raw);
  const source = parsed.data;
  const data: Record<string, unknown> = { type: source.type, title: typeof source.title === 'string' ? source.title : id };
  if (typeof source.definition_kind === 'string' && source.definition_kind !== 'definition') data.definition_kind = source.definition_kind;
  if (source.source && typeof source.source === 'object') data.source = JSON.parse(JSON.stringify(source.source));
  data.depends_on = list(source.depends_on);
  if (source.type !== 'definition') data.uses_definitions = list(source.uses_definitions);
  data.tags = list(source.tags);
  const content = flattenFileLinks(stripManagedBlocks(parsed.content)).replace(/\n{3,}/g, '\n\n');
  return stringifyMarkdown(content, data);
}

/** Digest of what a package says, apart from its version and where it was exported from. */
export function contentDigest(pkg: Pick<ResearchPackage, 'name' | 'cite' | 'exports' | 'nodes' | 'bib' | 'papers'>): string {
  return sha(canonical({
    name: pkg.name, cite: pkg.cite, exports: pkg.exports, bib: pkg.bib, papers: pkg.papers,
    nodes: pkg.nodes.map(({ approval: _approval, ...node }) => node),
  }));
}

const packageDigest = (pkg: Omit<ResearchPackage, 'digest'>) => sha(`${contentDigest(pkg)}\n${pkg.version}`);

// ---------- export ----------

export interface ExportNodeInput {
  id: string;
  kind: ResultKind;
  origin: 'project' | 'library';
  raw: string;
  /** Approved with a record that still matches the content. */
  approved: boolean;
  approval?: UpstreamApproval;
}

export interface ExportInput {
  manifest: PackageManifest;
  /** This work's own BibTeX entry (research/package/citation.bib): how importers cite the results proved here. */
  citation: string;
  requiredResults: string[];
  nodes: ExportNodeInput[];
  bib: string;
  papersIndex: string;
  releases: PackageRelease[];
  provenance: PackageProvenance;
}

export interface ExportOptions {
  /** Overrides the manifest's exports for this export. */
  exports?: string[];
  version?: string;
  /** Upstream ID → location an importer cites (e.g. "Theorem 1.2"), over the manifest's locations. */
  locations?: Record<string, string>;
  /** A build from a working copy (importing from a project folder): changed content gets a `-dev` version and no release. */
  dev?: boolean;
}

export interface ExportPlan {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  exports: string[];
  closure: Array<{ id: string; kind: ResultKind; title: string; origin: 'project' | 'library' }>;
  version: string;
  previous?: string;
  bump: Bump;
  changes: VersionChanges;
  /** Nothing changed since the latest release: export writes no new release. */
  unchanged: boolean;
  package?: ResearchPackage;
  release?: PackageRelease;
}

export function manifestProblems(manifest: Partial<PackageManifest> | undefined): string[] {
  if (!manifest || manifest.name === undefined) return ['No package name yet: give the package a name (package export --name N, or the Export dialog).'];
  const problems: string[] = [];
  if (typeof manifest.name !== 'string' || !SLUG.test(manifest.name)) problems.push(`Package name ${String(manifest.name || '(none)')} must be lowercase snake_case (letters, digits, underscores).`);
  if (manifest.exports !== undefined && !(Array.isArray(manifest.exports) && manifest.exports.every((item) => typeof item === 'string'))) problems.push('Manifest exports must be a list of result IDs.');
  if (manifest.locations !== undefined && !(manifest.locations && typeof manifest.locations === 'object' && !Array.isArray(manifest.locations) && Object.values(manifest.locations).every((item) => typeof item === 'string'))) problems.push('Manifest locations must map result IDs to text.');
  return problems;
}

export const CITATION_MISSING = "No citation for this project yet: write its BibTeX entry (Settings → This project's citation, or the Export dialog). Importers cite this work for the results proved here.";

/**
 * Check this work's own BibTeX entry: exactly one entry, with a key that can
 * serve as a paper-index slug in importing projects. A missing stable link is
 * a warning: importers need one before they share.
 */
export function citationCheck(text: string): { key?: string; entry?: string; problems: string[]; warnings: string[] } {
  if (!text.trim()) return { problems: [CITATION_MISSING], warnings: [] };
  const entries = parseBibEntries(text);
  if (!entries.length) return { problems: ['The citation is not a BibTeX entry (@article{key, ...}).'], warnings: [] };
  const problems: string[] = [];
  const warnings: string[] = [];
  if (entries.length > 1) problems.push(`The citation holds ${entries.length} entries (${entries.map((entry) => entry.key).join(', ')}); keep only this work's.`);
  const [entry] = entries;
  if (!SLUG.test(entry.key)) problems.push(`The citation key ${entry.key} must be lowercase snake_case (letters, digits, underscores): importing projects use it as a paper-index slug.`);
  if (!bibField(entry.raw, 'title')) problems.push('The citation needs a title.');
  if (!bibField(entry.raw, 'author')) warnings.push('The citation has no author.');
  if (!bibUrl(entry.raw)) warnings.push('The citation has no url, doi, or eprint: importing projects need a stable link before they share.');
  return { key: entry.key, entry: entry.raw.trim(), problems, warnings };
}

/** A starting point for this work's citation. */
export function citationTemplate(name?: string, title?: string, year = new Date().getFullYear()): string {
  const key = name && SLUG.test(name) ? name : 'this_work';
  return `@unpublished{${key},\n  author = {},\n  title  = {${title ?? ''}},\n  year   = {${year}},\n  note   = {In preparation},\n  url    = {}\n}\n`;
}

/** The exported nodes with everything they depend on, dependencies first. */
export function exportClosure(nodes: ExportNodeInput[], exports: string[]): { order: string[]; missing: string[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, from?: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) { missing.push(from ? `${from} depends on ${id}, which does not exist.` : `Export ${id} is not a result or definition in this project.`); return; }
    for (const dep of dependencies(parseMarkdown(node.raw).data)) visit(dep, id);
    order.push(id);
  };
  for (const id of exports) visit(id);
  return { order, missing };
}

/**
 * What exporting would produce: the closure, the problems that block it, the
 * version (proposed from the changes since the latest release unless given),
 * and the package itself when nothing blocks.
 */
export function planExport(input: ExportInput, options: ExportOptions = {}): ExportPlan {
  const blockers = manifestProblems(input.manifest);
  const warnings: string[] = [];
  const exports = [...new Set(options.exports ?? input.manifest.exports ?? input.requiredResults)];
  if (!exports.length) blockers.push('Nothing to export: list result IDs under exports, or add required results to project.md.');
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const { order, missing } = exportClosure(input.nodes, exports);
  blockers.push(...missing);

  const bibEntries = new Map(parseBibEntries(input.bib).map((entry) => [entry.key, entry.raw]));
  const papers = paperSections(input.papersIndex);
  const locations: Record<string, string> = { ...(input.manifest.locations ?? {}), ...(options.locations ?? {}) };
  const nodes: PackageNode[] = [];
  const bib: Record<string, string> = {};
  const paperBodies: Record<string, string> = {};
  for (const id of order) {
    const node = byId.get(id)!;
    const data = parseMarkdown(node.raw).data;
    if (!node.approved) blockers.push(`${id}: not approved. Only approved results are exported; approve it, or leave the results that need it out of the exports.`);
    if (data.type === CONJECTURE_TYPE) blockers.push(`${id}: is a conjecture, so results that depend on it are conditional and cannot be exported.`);
    const kind = sourceKind(data.source);
    if (kind === 'paper' || kind === 'textbook') {
      const paperId = String(data.source.paper_id ?? '');
      const entry = bibEntries.get(paperId);
      if (!entry) blockers.push(`${id}: cites ${paperId || '(no paper_id)'}, which has no BibTeX entry in the bibliography.`);
      else bib[paperId] = entry.trim();
      if (papers.has(paperId)) paperBodies[paperId] = papers.get(paperId)!;
      else if (paperId) warnings.push(`${paperId}: not in the paper index; importers get an index entry without a description.`);
    }
    const location = locations[id]?.trim();
    nodes.push({ id, kind: node.kind, raw: exportedRaw(node.raw, id), ...(node.approval ? { approval: node.approval } : {}), ...(location ? { location } : {}) });
  }
  for (const id of Object.keys(locations)) if (!order.includes(id)) warnings.push(`Location given for ${id}, which is not exported.`);

  const citation = citationCheck(input.citation);
  blockers.push(...citation.problems);
  warnings.push(...citation.warnings);
  const citeKey = citation.key ?? '';
  if (input.provenance.dirty) warnings.push('Research files have uncommitted changes; the package records the last commit, which does not include them.');

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  if (citeKey && bib[citeKey]) blockers.push(`The citation key ${citeKey} is also a paper this project cites; give this work its own key.`);
  const cite = { key: citeKey, bibtex: citation.entry ?? '', ...(papers.has(citeKey) ? { paper: papers.get(citeKey)! } : {}) };
  const body = { name: input.manifest.name, cite, exports, nodes, bib: sortKeys(bib) as Record<string, string>, papers: sortKeys(paperBodies) as Record<string, string> };
  const digest = contentDigest(body);

  // Version: what changed against the latest release.
  const last = latestRelease(input.releases);
  const current: Record<string, ReleaseNode> = Object.fromEntries(nodes.map((node) => [node.id, { statement: statementDigest(node.raw), proof: proofDigest(node.raw) }]));
  const changes: VersionChanges = { added: [], removed: [], statement: [], proof: [], exportsAdded: [], exportsRemoved: [] };
  let bump: Bump = 'initial';
  if (last) {
    for (const id of Object.keys(current)) {
      const before = last.nodes[id];
      if (!before) changes.added.push(id);
      else if (before.statement !== current[id].statement) changes.statement.push(id);
      else if (before.proof !== current[id].proof) changes.proof.push(id);
    }
    changes.removed = Object.keys(last.nodes).filter((id) => !current[id]);
    changes.exportsAdded = exports.filter((id) => !last.exports.includes(id));
    changes.exportsRemoved = last.exports.filter((id) => !exports.includes(id));
    bump = changes.removed.length || changes.statement.length || changes.exportsRemoved.length ? 'major'
      : changes.added.length || changes.exportsAdded.length ? 'minor'
        : changes.proof.length || last.digest !== digest ? 'patch' : 'none';
  }
  const unchanged = bump === 'none';
  const proposed = last ? bumpVersion(last.version, bump) : '1.0.0';
  let version = options.version ?? proposed;
  if (options.dev && !unchanged && !options.version) version = `${proposed}-dev`;
  if (!isVersion(version)) blockers.push(`Version ${version} is not semver (major.minor.patch).`);
  else if (last && options.version) {
    const order = compareVersions(version, last.version);
    if (!unchanged && order <= 0) blockers.push(`Version ${version} must be later than the latest release ${last.version}.`);
    if (unchanged && order < 0) blockers.push(`Version ${version} is earlier than the latest release ${last.version}.`);
    const required = SEMVER.exec(proposed)!;
    const given = SEMVER.exec(version)!;
    if (!unchanged && order > 0 && (Number(given[1]) < Number(required[1]) || (Number(given[1]) === Number(required[1]) && Number(given[2]) < Number(required[2])))) {
      blockers.push(`Version ${version} understates the change: the changes since ${last.version} need at least ${proposed} (${bump}).`);
    }
  }

  const closure = order.map((id) => {
    const node = byId.get(id)!;
    return { id, kind: node.kind, title: String(parseMarkdown(node.raw).data.title ?? id), origin: node.origin };
  });
  const plan: ExportPlan = { ok: !blockers.length, blockers, warnings, exports, closure, version, ...(last ? { previous: last.version } : {}), bump, changes, unchanged };
  if (!plan.ok) return plan;
  const withoutDigest: Omit<ResearchPackage, 'digest'> = {
    format: PACKAGE_FORMAT, formatVersion: PACKAGE_FORMAT_VERSION, name: body.name, version, provenance: input.provenance,
    cite: body.cite, exports: body.exports, nodes: body.nodes, bib: body.bib, papers: body.papers,
  };
  plan.package = { ...withoutDigest, digest: packageDigest(withoutDigest) };
  if (!unchanged && !(options.dev && !options.version)) {
    plan.release = { version, digest, ...(input.provenance.commit ? { commit: input.provenance.commit } : {}), exportedAt: input.provenance.exportedAt, exports, nodes: current };
  }
  return plan;
}

/** A package file's contents, checked: format, version, shape, and digest. */
export function parsePackage(text: string): ResearchPackage {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error('Not a research package: the file is not JSON.'); }
  if (!value || value.format !== PACKAGE_FORMAT) throw new Error('Not a research package (format is not research-package).');
  if (typeof value.formatVersion !== 'number' || value.formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new Error(`This package uses format version ${String(value.formatVersion)}, newer than this Research Assistant reads (${PACKAGE_FORMAT_VERSION}); update the extension.`);
  }
  const problems: string[] = [];
  if (typeof value.name !== 'string' || !SLUG.test(value.name)) problems.push('name');
  if (typeof value.version !== 'string' || !isVersion(value.version)) problems.push('version');
  if (!value.cite || typeof value.cite.key !== 'string' || !SLUG.test(value.cite.key) || typeof value.cite.bibtex !== 'string') problems.push('cite');
  if (!Array.isArray(value.exports) || !value.exports.every((item: unknown) => typeof item === 'string')) problems.push('exports');
  if (!Array.isArray(value.nodes) || !value.nodes.every((node: any) => node && typeof node.id === 'string' && SLUG.test(node.id) && (node.kind === 'asset' || node.kind === 'definition') && typeof node.raw === 'string')) problems.push('nodes');
  if (!value.bib || typeof value.bib !== 'object' || !value.papers || typeof value.papers !== 'object') problems.push('bib/papers');
  if (!value.provenance || typeof value.provenance !== 'object') problems.push('provenance');
  if (problems.length) throw new Error(`Invalid research package: bad ${problems.join(', ')}.`);
  const { digest, ...rest } = value as ResearchPackage;
  if (digest !== packageDigest(rest)) throw new Error('The package was changed after export (its digest does not match); ask for a fresh export.');
  return value as ResearchPackage;
}

export function serializePackage(pkg: ResearchPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function packageFileName(pkg: Pick<ResearchPackage, 'name' | 'version'>): string {
  return `${pkg.name}-${pkg.version}${PACKAGE_FILE_EXTENSION}`;
}

// ---------- import ----------

export interface ImportProject {
  library: string;
  /** This project's own package name, so it never imports itself. */
  ownPackage?: string;
  /** Every node ID in the project; IDs are global across research folders. */
  nodeIds: Set<string>;
  collections: string[];
  locks: PackageLock[];
  bib: string;
  papersIndex: string;
  /** Node ID → nodes outside the collection being changed that refer to it. */
  references?: Map<string, string[]>;
  /** BibTeX keys cited outside the collection being changed (nodes and TeX). */
  citedElsewhere?: Set<string>;
  /**
   * Local IDs in the collection being updated whose files say approved. They are written approved
   * again, so reconciling afterwards reverts exactly the changed ones and flags what rests on them.
   */
  approved?: Set<string>;
}

export interface ImportOptions {
  alias?: string;
  source: PackageSource;
  resolved?: string;
  now: string;
}

export interface FileWrite { file: string; content: string }

export interface PackageDiff {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  statement: string[];
  proof: string[];
  bump: Bump;
}

export interface ImportPlan {
  ok: boolean;
  conflicts: string[];
  warnings: string[];
  alias: string;
  collection: string;
  writes: FileWrite[];
  deletes: string[];
  /** New bibliography and paper-index text, when they change. */
  bib?: string;
  papersIndex?: string;
  lock: PackageLock;
  nodes: Array<{ id: string; upstream: string; kind: ResultKind; title: string }>;
  bibChanges: Array<{ key: string; as: string; action: BibAction; /** Same key and action as the installed version (an update). */ unchanged?: boolean }>;
  /** Against the installed version, for an update. */
  diff?: PackageDiff;
}

export const defaultAlias = (name: string) => name;

export function aliasProblem(alias: string): string | undefined {
  if (!ALIAS.test(alias)) return `Alias ${alias} must be lowercase letters and digits, words joined by single underscores.`;
  if (alias.length > MAX_ALIAS) return `Alias ${alias} is longer than ${MAX_ALIAS} characters; choose a shorter one with --as (it prefixes every imported ID).`;
  return undefined;
}

export const lockPath = (library: string, alias: string) => `${library}/${alias}/${PACKAGE_LOCK_FILE}`;

/** The imported package (a library collection with a lockfile) a project-relative path lies in, if any. */
export function importedCollectionOf(file: string, library: string | undefined, exists: (relative: string) => boolean): string | undefined {
  if (!library || !file.startsWith(`${library}/`)) return undefined;
  const collection = file.slice(library.length + 1).split('/')[0];
  return collection && exists(lockPath(library, collection)) ? collection : undefined;
}
export const vendoredPath = (library: string, alias: string, kind: ResultKind, id: string) => `${library}/${alias}/${LIBRARY_KIND_FOLDERS[kind]}/${id}.md`;

/** Upstream ID → local ID: `lib_<alias>_<id>`, the upstream `lib_` dropped; a clash inside the package keeps it. */
export function localIds(pkg: Pick<ResearchPackage, 'nodes'>, alias: string): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const rest = (id: string) => id.startsWith(LIBRARY_PREFIX) ? id.slice(LIBRARY_PREFIX.length) : id;
  // Project results first, so they get the plain names.
  const ordered = [...pkg.nodes].sort((a, b) => Number(a.id.startsWith(LIBRARY_PREFIX)) - Number(b.id.startsWith(LIBRARY_PREFIX)) || a.id.localeCompare(b.id));
  for (const node of ordered) {
    let local = `${LIBRARY_PREFIX}${alias}_${rest(node.id)}`;
    if (used.has(local)) local = `${LIBRARY_PREFIX}${alias}_${node.id}`;
    used.add(local);
    map.set(node.id, local);
  }
  return map;
}

function ownedBibKeys(lock: PackageLock | undefined): Set<string> {
  return new Set(Object.values(lock?.bib ?? {}).filter((item) => item.action !== 'reused').map((item) => item.as));
}

function lockDiff(old: PackageLock, next: PackageLock): PackageDiff {
  const added = Object.keys(next.nodes).filter((id) => !old.nodes[id]);
  const removed = Object.keys(old.nodes).filter((id) => !next.nodes[id]);
  const statement: string[] = [];
  const proof: string[] = [];
  for (const [id, node] of Object.entries(next.nodes)) {
    const before = old.nodes[id];
    if (!before) continue;
    if (before.statement !== node.statement) statement.push(id);
    else if (before.proof !== node.proof) proof.push(id);
  }
  const exportsRemoved = old.exports.some((id) => !next.exports.includes(id));
  const bump: Bump = removed.length || statement.length || exportsRemoved ? 'major' : added.length || next.exports.some((id) => !old.exports.includes(id)) ? 'minor' : proof.length || old.digest !== next.digest ? 'patch' : 'none';
  return { from: old.version, to: next.version, added, removed, statement, proof, bump };
}

/**
 * The files, bibliography, paper index, and lockfile an import (or, with the
 * installed lock, an update) would write. Nothing is applied; `conflicts`
 * lists what blocks it.
 */
export function planImport(pkg: ResearchPackage, project: ImportProject, options: ImportOptions, installed?: PackageLock): ImportPlan {
  const alias = installed?.alias ?? options.alias ?? defaultAlias(pkg.name);
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const aliasIssue = aliasProblem(alias);
  if (aliasIssue) conflicts.push(aliasIssue);
  if (project.ownPackage && pkg.name === project.ownPackage) conflicts.push(`${pkg.name} is this project's own package; a project cannot import itself.`);
  if (installed && installed.package !== pkg.name) conflicts.push(`${alias} holds package ${installed.package}, not ${pkg.name}.`);
  if (!installed) {
    const other = project.locks.find((lock) => lock.package === pkg.name);
    if (other) conflicts.push(`Package ${pkg.name} is already imported as ${other.alias}; use package update ${other.alias}.`);
    else if (project.collections.includes(alias)) conflicts.push(`The library already has a collection named ${alias}; choose another alias with --as.`);
  }

  const ids = localIds(pkg, alias);
  const owned = new Set(Object.keys(installed?.nodes ?? {}));
  for (const local of ids.values()) if (project.nodeIds.has(local) && !owned.has(local)) conflicts.push(`Node ID ${local} already exists in this project; choose another alias with --as.`);

  // Bibliography: drop what the installed version added, then merge the package's entries by the work they name.
  const citedElsewhere = project.citedElsewhere ?? new Set<string>();
  const previouslyOwned = ownedBibKeys(installed);
  let bib = removeBibEntries(project.bib, previouslyOwned);
  const entries = parseBibEntries(bib);
  const byKey = new Map(entries.map((entry) => [entry.key, entry.raw]));
  const incoming: Array<[string, string]> = [[pkg.cite.key, pkg.cite.bibtex], ...Object.entries(pkg.bib).filter(([key]) => key !== pkg.cite.key)];
  const bibMap = new Map<string, string>();
  const bibChanges: ImportPlan['bibChanges'] = [];
  const additions: string[] = [];
  for (const [key, raw] of incoming) {
    if (!raw.trim()) { conflicts.push(`The package has no BibTeX entry for ${key}.`); continue; }
    let as = key;
    let action: BibAction = 'added';
    const existing = byKey.get(key);
    const sameIdElsewhere = [...byKey].find(([other, text]) => other !== key && sameIdentifier(text, raw));
    if (existing && sameWork(existing, raw)) action = 'reused';
    else if (sameIdElsewhere) { as = sameIdElsewhere[0]; action = 'reused'; }
    else if (existing) {
      action = 'renamed';
      as = `${key}_${alias}`;
      for (let index = 2; byKey.has(as) && !sameWork(byKey.get(as)!, raw); index++) as = `${key}_${alias}_${index}`;
      if (byKey.has(as)) action = 'reused';
    }
    if (action !== 'reused') { additions.push(renameBibKey(raw, as)); byKey.set(as, raw); }
    bibMap.set(key, as);
    const before = installed?.bib[key];
    bibChanges.push({ key, as, action, ...(before && before.as === as && before.action === action ? { unchanged: true } : {}) });
  }
  bib = appendBibEntries(bib, additions);
  // Entries the installed version added that the new one no longer needs stay only while something else cites them.
  const nowOwned = new Set(bibChanges.filter((item) => item.action !== 'reused').map((item) => item.as));
  const orphans = [...previouslyOwned].filter((key) => !nowOwned.has(key) && citedElsewhere.has(key));
  if (orphans.length) {
    const original = new Map(parseBibEntries(project.bib).map((entry) => [entry.key, entry.raw]));
    bib = appendBibEntries(bib, orphans.map((key) => original.get(key)!).filter(Boolean));
    warnings.push(`Kept BibTeX entries cited elsewhere in this project, no longer managed by the package: ${orphans.join(', ')}.`);
  }

  // Paper index: one section per key the package uses, unless the project already has it. Sections
  // the installed version added are rewritten from the new package, or dropped unless cited elsewhere.
  const stillUsed = (slug: string) => bibChanges.some((item) => item.as === slug);
  let papersIndex = removePaperSections(project.papersIndex, new Set((installed?.papers ?? []).filter((slug) => stillUsed(slug) || !citedElsewhere.has(slug))));
  const sections = paperSections(papersIndex);
  const newSections: Array<{ slug: string; body: string }> = [];
  for (const { key, as } of bibChanges) {
    if (sections.has(as) || newSections.some((section) => section.slug === as)) continue;
    const raw = key === pkg.cite.key ? pkg.cite.bibtex : pkg.bib[key];
    const given = key === pkg.cite.key ? pkg.cite.paper : pkg.papers[key];
    const url = bibUrl(raw ?? '') ?? (key === pkg.cite.key && pkg.provenance.remote && /^https?:\/\//.test(pkg.provenance.remote) ? pkg.provenance.remote : undefined);
    const body = given?.trim() || [`Cited by the research package ${pkg.name}.`, url ? `- URL: ${url}` : ''].filter(Boolean).join('\n');
    if (!/https?:\/\//.test(body) && !url) warnings.push(`${as}: no stable URL known; add one to its paper-index section before sharing (sync prepare checks it).`);
    newSections.push({ slug: as, body: /https?:\/\//.test(body) || !url ? body : `${body}\n- URL: ${url}` });
  }
  papersIndex = appendPaperSections(papersIndex, newSections);

  // Nodes: local IDs, upstream identity, citations in place of "proved here".
  const writes: FileWrite[] = [];
  const lockNodes: Record<string, LockNode> = {};
  const nodes: ImportPlan['nodes'] = [];
  const citeAs = bibMap.get(pkg.cite.key) ?? pkg.cite.key;
  for (const node of [...pkg.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const local = ids.get(node.id)!;
    const parsed = parseMarkdown(node.raw);
    const data = parsed.data;
    const mapDeps = (field: string) => list(data[field]).map((dep) => {
      const mapped = ids.get(dep);
      if (!mapped) conflicts.push(`The package is incomplete: ${node.id} depends on ${dep}, which it does not contain.`);
      return mapped ?? dep;
    });
    const kind = sourceKind(data.source);
    let source: Record<string, string>;
    if (kind === 'paper' || kind === 'textbook') {
      const paperId = String(data.source.paper_id ?? '');
      const mapped = bibMap.get(paperId);
      if (!mapped) conflicts.push(`The package is incomplete: ${node.id} cites ${paperId}, which has no BibTeX entry in it.`);
      source = { kind, paper_id: mapped ?? paperId, location: String(data.source.location ?? node.location ?? '').trim() || `as cited in ${pkg.name}` };
    } else {
      source = { kind: 'paper', paper_id: citeAs, location: node.location?.trim() || `result ${node.id} of ${pkg.name}` };
    }
    const keepApproved = Boolean(installed && project.approved?.has(local));
    const out: Record<string, unknown> = { type: data.type, title: typeof data.title === 'string' ? data.title : node.id, status: keepApproved ? 'approved' : 'draft' };
    if (typeof data.definition_kind === 'string') out.definition_kind = data.definition_kind;
    out.source = source;
    out.depends_on = mapDeps('depends_on');
    if (node.kind === 'asset') out.uses_definitions = mapDeps('uses_definitions');
    out.tags = list(data.tags);
    out.imported_from = { package: pkg.name, id: node.id };
    const content = stringifyMarkdown(parsed.content, out);
    writes.push({ file: vendoredPath(project.library, alias, node.kind, local), content });
    lockNodes[local] = {
      upstream: node.id, kind: node.kind,
      digest: researchDigest(content, node.kind), statement: statementDigest(content), proof: proofDigest(content),
      ...(node.approval ? { approval: node.approval } : {}),
    };
    nodes.push({ id: local, upstream: node.id, kind: node.kind, title: String(out.title) });
  }

  const deletes = Object.entries(installed?.nodes ?? {}).filter(([id]) => !lockNodes[id]).map(([id, node]) => vendoredPath(project.library, alias, node.kind, id));
  const lock: PackageLock = {
    lockVersion: LOCK_VERSION, package: pkg.name, alias, version: pkg.version, digest: pkg.digest,
    source: options.source, ...(options.resolved ?? pkg.provenance.commit ? { resolved: options.resolved ?? pkg.provenance.commit } : {}),
    importedAt: options.now,
    exports: pkg.exports.map((id) => ids.get(id) ?? id),
    nodes: lockNodes,
    bib: Object.fromEntries(bibChanges.map((item) => [item.key, { as: item.as, action: item.action }])),
    papers: newSections.map((section) => section.slug),
  };
  writes.push({ file: lockPath(project.library, alias), content: `${JSON.stringify(lock, null, 2)}\n` });

  let diff: PackageDiff | undefined;
  if (installed) {
    diff = lockDiff(installed, lock);
    for (const id of diff.removed) {
      const users = project.references?.get(id) ?? [];
      if (users.length) conflicts.push(`${id} is gone from ${pkg.name} ${pkg.version} but ${users.join(', ')} still use${users.length === 1 ? 's' : ''} it; repoint them first.`);
    }
    if (installed.version === pkg.version && installed.digest !== pkg.digest) warnings.push(`The package content changed but its version is still ${pkg.version}.`);
    if (compareVersions(pkg.version, installed.version) < 0) warnings.push(`This is a downgrade from ${installed.version} to ${pkg.version}.`);
  }
  for (const node of pkg.nodes) if (!node.approval) warnings.push(`${node.id}: the package records no upstream approval.`);

  return {
    ok: !conflicts.length, conflicts: [...new Set(conflicts)], warnings, alias, collection: `${project.library}/${alias}`,
    writes, deletes,
    ...(bib !== project.bib ? { bib } : {}), ...(papersIndex !== project.papersIndex ? { papersIndex } : {}),
    lock, nodes, bibChanges, ...(diff ? { diff } : {}),
  };
}

// ---------- removal ----------

export interface RemovePlan {
  ok: boolean;
  /** The collection the package occupies; its emptied folders are removed too. */
  alias: string;
  conflicts: string[];
  warnings: string[];
  deletes: string[];
  bib?: string;
  papersIndex?: string;
  removedBibKeys: string[];
}

/** Delete a package's files and the citations only it used. Refused while nodes outside it still refer to it, unless forced. */
export function planRemove(lock: PackageLock, project: ImportProject, options: { force?: boolean } = {}): RemovePlan {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  for (const id of Object.keys(lock.nodes)) {
    const users = project.references?.get(id) ?? [];
    if (!users.length) continue;
    (options.force ? warnings : conflicts).push(`${id} is still used by ${users.join(', ')}.`);
  }
  const cited = project.citedElsewhere ?? new Set<string>();
  const removedBibKeys = [...ownedBibKeys(lock)].filter((key) => !cited.has(key));
  const kept = [...ownedBibKeys(lock)].filter((key) => cited.has(key));
  if (kept.length) warnings.push(`Keeping BibTeX entries cited elsewhere: ${kept.join(', ')}.`);
  const bib = removeBibEntries(project.bib, new Set(removedBibKeys));
  const papersIndex = removePaperSections(project.papersIndex, new Set(lock.papers.filter((slug) => !cited.has(slug))));
  const deletes = [...Object.entries(lock.nodes).map(([id, node]) => vendoredPath(project.library, lock.alias, node.kind, id)), lockPath(project.library, lock.alias)];
  return {
    ok: !conflicts.length, alias: lock.alias, conflicts, warnings, deletes, removedBibKeys,
    ...(bib !== project.bib ? { bib } : {}), ...(papersIndex !== project.papersIndex ? { papersIndex } : {}),
  };
}

// ---------- validation ----------

export function parseLock(raw: string, file: string): PackageLock {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error(`${file}: invalid JSON (merge conflict?).`); }
  if (!value || typeof value !== 'object' || typeof value.package !== 'string' || typeof value.alias !== 'string' || !value.nodes || typeof value.nodes !== 'object') throw new Error(`${file}: not a package lockfile.`);
  if (typeof value.lockVersion !== 'number' || value.lockVersion > LOCK_VERSION) throw new Error(`${file}: lockfile version ${String(value.lockVersion)} is newer than this Research Assistant reads; update the extension.`);
  return { exports: [], bib: {}, papers: [], ...value } as PackageLock;
}

export interface CollectionSnapshot {
  collection: string;
  lockFile: string;
  lockRaw: string;
  nodeFiles: Array<{ file: string; id: string; kind: ResultKind; raw: string }>;
}

/**
 * Problems with imported packages: the lockfile parses and matches its
 * folder, every vendored file is present and unedited, and nothing else was
 * added to the collection. `strays` are nodes outside imported collections
 * that still claim an upstream package.
 */
export function packageProblems(collections: CollectionSnapshot[], strays: Array<{ file: string }> = []): string[] {
  const problems: string[] = [];
  const readOnly = 'Imported packages are read-only: change a result with library promote, or bring a new version with package update.';
  for (const collection of collections) {
    let lock: PackageLock;
    try { lock = parseLock(collection.lockRaw, collection.lockFile); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); continue; }
    if (lock.alias !== collection.collection) problems.push(`${collection.lockFile}: alias ${lock.alias} does not match its folder ${collection.collection}.`);
    const files = new Map(collection.nodeFiles.map((node) => [node.id, node]));
    for (const [id, node] of Object.entries(lock.nodes)) {
      const file = files.get(id);
      if (!file) { problems.push(`${collection.lockFile}: ${id} from package ${lock.package} is missing. Restore it with git, or run package update ${lock.alias}.`); continue; }
      if (file.kind !== node.kind) problems.push(`${file.file}: package ${lock.package} lists ${id} as ${node.kind}.`);
      else if (researchDigest(file.raw, node.kind) !== node.digest) problems.push(`${file.file}: edited after import from ${lock.package} ${lock.version}. ${readOnly}`);
    }
    for (const node of collection.nodeFiles) {
      if (!lock.nodes[node.id]) problems.push(`${node.file}: not part of package ${lock.package}. ${readOnly} Put new known results in another collection.`);
    }
  }
  for (const stray of strays) problems.push(`${stray.file}: has imported_from but is not in an imported package; remove the field (library promote does this).`);
  return problems;
}
