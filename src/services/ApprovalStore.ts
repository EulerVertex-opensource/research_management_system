import * as path from 'path';
import { ApprovalFile, ApprovalRecord, LoopFiles, sharedFolders } from './ResearchLoopModel';

/**
 * Approvals stored one file per target (`approvals/project.json`,
 * `approvals/assets/<id>.json`, `approvals/definitions/<id>.json`) so two
 * collaborators approving different results never touch the same file. The
 * legacy single `approvals.json` is still read and is removed on the next write.
 */

export function legacyApprovalsPath(researchRoot: string): string {
  return researchRoot === '.' ? 'approvals.json' : path.posix.join(researchRoot, 'approvals.json');
}

export function approvalRecordPath(researchRoot: string, kind: ApprovalRecord['kind'], target: string): string {
  const folder = sharedFolders(researchRoot).approvals;
  return kind === 'project' ? `${folder}/project.json` : `${folder}/${kind === 'asset' ? 'assets' : 'definitions'}/${target}.json`;
}

/** Every file that holds approval records, legacy file included. */
export async function approvalFiles(files: LoopFiles, researchRoot: string): Promise<string[]> {
  const folder = sharedFolders(researchRoot).approvals;
  const found: string[] = [];
  for (const file of [legacyApprovalsPath(researchRoot), `${folder}/project.json`]) if (await files.exists(file)) found.push(file);
  for (const sub of ['assets', 'definitions']) found.push(...await files.listFiles(`${folder}/${sub}`, '.json'));
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
