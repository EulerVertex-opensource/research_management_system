import * as path from 'path';
import { ApprovalFile, ApprovalRecord, LoopFiles, sharedFolders } from './ResearchLoopModel';
import { PROJECT_FACETS, ProjectFacet, projectFacets, researchDigest } from '../domain/digests';
import { RequiredResult, requiredResults } from '../domain/project';

/**
 * Approvals stored one file per target (`approvals/project.json`,
 * `approvals/assets/<id>.json`, `approvals/definitions/<id>.json`,
 * `approvals/specifications/<id>.json`, `approvals/remarks/<id>.json`) so two
 * collaborators approving different results never touch the same file. The
 * legacy single `approvals.json` is still read and is removed on the next write.
 */

export function legacyApprovalsPath(researchRoot: string): string {
  return researchRoot === '.' ? 'approvals.json' : path.posix.join(researchRoot, 'approvals.json');
}

export function approvalRecordPath(researchRoot: string, kind: ApprovalRecord['kind'], target: string): string {
  const folder = sharedFolders(researchRoot).approvals;
  return kind === 'project' ? `${folder}/project.json` : `${folder}/${kind === 'asset' ? 'assets' : kind === 'specification' ? 'specifications' : kind === 'remark' ? 'remarks' : 'definitions'}/${target}.json`;
}

/** Every file that holds approval records, legacy file included. */
export async function approvalFiles(files: LoopFiles, researchRoot: string): Promise<string[]> {
  const folder = sharedFolders(researchRoot).approvals;
  const found: string[] = [];
  for (const file of [legacyApprovalsPath(researchRoot), `${folder}/project.json`]) if (await files.exists(file)) found.push(file);
  for (const sub of ['assets', 'definitions', 'specifications', 'remarks']) found.push(...await files.listFiles(`${folder}/${sub}`, '.json'));
  return found;
}

export function isApprovalPath(researchRoot: string, file: string): boolean {
  const folder = sharedFolders(researchRoot).approvals;
  return file === legacyApprovalsPath(researchRoot) || file === folder || file.startsWith(`${folder}/`);
}

const key = (record: Pick<ApprovalRecord, 'kind' | 'target'>) => `${record.kind}:${record.target}`;

export async function readApprovals(files: LoopFiles, researchRoot: string): Promise<ApprovalFile> {
  const byKey = new Map<string, ApprovalRecord>();
  const legacy = await files.readFile(legacyApprovalsPath(researchRoot)).catch(() => '');
  if (legacy.trim()) {
    const parsed = JSON.parse(legacy) as ApprovalFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('Invalid approvals file.');
    for (const record of parsed.records) byKey.set(key(record), record);
  }
  for (const file of await approvalFiles(files, researchRoot)) {
    if (file === legacyApprovalsPath(researchRoot)) continue;
    const raw = await files.readFile(file).catch(() => '');
    if (!raw.trim()) continue;
    let record: ApprovalRecord;
    try { record = JSON.parse(raw) as ApprovalRecord; } catch { throw new Error(`Invalid approval record ${file}.`); }
    if (!record || typeof record.kind !== 'string' || typeof record.target !== 'string' || typeof record.digest !== 'string') throw new Error(`Invalid approval record ${file}.`);
    byKey.set(key(record), record);
  }
  return { version: 1, records: [...byKey.values()] };
}

async function remove(files: LoopFiles, file: string): Promise<void> {
  if (files.deleteFile) await files.deleteFile(file);
  else await files.writeFile(file, '');
}

/** Write the split files that differ, delete records that are gone, and retire the legacy file. Returns the paths touched. */
export async function writeApprovals(files: LoopFiles, researchRoot: string, file: ApprovalFile): Promise<string[]> {
  const touched: string[] = [];
  const wanted = new Map(file.records.map((record) => [approvalRecordPath(researchRoot, record.kind, record.target), record]));
  for (const [target, record] of wanted) {
    const content = JSON.stringify(record, null, 2) + '\n';
    if ((await files.readFile(target).catch(() => undefined)) === content) continue;
    await files.writeFile(target, content);
    touched.push(target);
  }
  for (const existing of await approvalFiles(files, researchRoot)) {
    if (wanted.has(existing)) continue;
    if (existing !== legacyApprovalsPath(researchRoot) && !(await files.readFile(existing).catch(() => '')).trim()) continue;
    await remove(files, existing);
    touched.push(existing);
  }
  return touched;
}

/** Split a legacy approvals.json into per-target files. Returns true when a migration happened. */
export async function migrateApprovals(files: LoopFiles, researchRoot: string): Promise<boolean> {
  if (!(await files.exists(legacyApprovalsPath(researchRoot)))) return false;
  await writeApprovals(files, researchRoot, await readApprovals(files, researchRoot));
  return true;
}

/**
 * Project revisions: an append-only history beside `approvals/project.json`.
 * Each researcher approval of a changed project.md adds `rev-NNNN.json`, so a
 * manuscript can say which revision it was reconciled against. The revision
 * number is derived from this history, never written in project.md.
 */
export interface ProjectRevision {
  revision: number; digest: string; facets: Record<ProjectFacet, string>; required_results: RequiredResult[];
  approvedAt: string; performed_by?: string; base_commit?: string;
}

export function projectRevisionsFolder(researchRoot: string): string {
  return `${sharedFolders(researchRoot).approvals}/project-revisions`;
}

export async function readProjectRevisions(files: LoopFiles, researchRoot: string): Promise<ProjectRevision[]> {
  const revisions: ProjectRevision[] = [];
  for (const file of await files.listFiles(projectRevisionsFolder(researchRoot), '.json')) {
    const raw = await files.readFile(file).catch(() => '');
    if (!raw.trim()) continue;
    let revision: ProjectRevision;
    try { revision = JSON.parse(raw) as ProjectRevision; } catch { throw new Error(`Invalid project revision ${file}.`); }
    if (!revision || !Number.isInteger(revision.revision) || typeof revision.digest !== 'string') throw new Error(`Invalid project revision ${file}.`);
    revisions.push(revision);
  }
  return revisions.sort((a, b) => a.revision - b.revision);
}

/** The latest revision whose digest matches project.md as it is now; undefined when the current text is unapproved. */
export function currentProjectRevision(revisions: ProjectRevision[], project: string): ProjectRevision | undefined {
  const digest = researchDigest(project, 'project');
  return [...revisions].reverse().find((revision) => revision.digest === digest);
}

/**
 * The revision history, with a project approved before revisions existed read
 * as revision 1 (from `approvals/project.json`, without facets). Nothing is
 * written, so opening an older project never leaves uncommitted files.
 */
export async function projectRevisionHistory(files: LoopFiles, researchRoot: string, approvals: ApprovalRecord[]): Promise<ProjectRevision[]> {
  const stored = await readProjectRevisions(files, researchRoot);
  if (stored.length) return stored;
  const record = approvals.find((entry) => entry.kind === 'project');
  return record ? [legacyRevision(record)] : [];
}

function legacyRevision(record: ApprovalRecord): ProjectRevision {
  return { revision: 1, digest: record.digest, facets: {} as Record<ProjectFacet, string>, required_results: [], approvedAt: record.approvedAt, ...(record.performed_by ? { performed_by: record.performed_by } : {}) };
}

/**
 * Append a revision for a newly approved project.md unless the latest one already has its digest.
 * `previous` is the project approval this one replaces; with no stored history it counts as revision 1.
 * Returns the path written, if any.
 */
export async function appendProjectRevision(files: LoopFiles, researchRoot: string, project: string, record: Pick<ApprovalRecord, 'approvedAt' | 'performed_by' | 'base_commit'>, previous?: ApprovalRecord): Promise<string | undefined> {
  const stored = await readProjectRevisions(files, researchRoot);
  const history = stored.length || !previous ? stored : [legacyRevision(previous)];
  const digest = researchDigest(project, 'project');
  if (history.at(-1)?.digest === digest && stored.length) return undefined;
  const number = history.at(-1)?.digest === digest ? history.at(-1)!.revision : (history.at(-1)?.revision ?? 0) + 1;
  const revision: ProjectRevision = {
    revision: number, digest, facets: projectFacets(project), required_results: requiredResults(project), approvedAt: record.approvedAt,
    ...(record.performed_by ? { performed_by: record.performed_by } : {}), ...(record.base_commit ? { base_commit: record.base_commit } : {}),
  };
  const file = `${projectRevisionsFolder(researchRoot)}/rev-${String(revision.revision).padStart(4, '0')}.json`;
  await files.writeFile(file, JSON.stringify(revision, null, 2) + '\n');
  return file;
}

export interface ProjectRevisionDiff { addedRequired: string[]; removedRequired: string[]; changedFacets: ProjectFacet[] }

/** What changed between two project revisions: required results gained or dropped, and which facets moved. */
export function diffProjectRevisions(from: Pick<ProjectRevision, 'facets' | 'required_results'>, to: Pick<ProjectRevision, 'facets' | 'required_results'>): ProjectRevisionDiff {
  const before = from.required_results.map((item) => item.id);
  const after = to.required_results.map((item) => item.id);
  return {
    addedRequired: after.filter((id) => !before.includes(id)),
    removedRequired: before.filter((id) => !after.includes(id)),
    changedFacets: PROJECT_FACETS.filter((facet) => from.facets[facet] !== to.facets[facet]),
  };
}
