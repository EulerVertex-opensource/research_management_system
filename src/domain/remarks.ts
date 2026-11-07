import { normalizeProse, sha } from './digests';
import { sectionContent, statementPart, stripManagedBlocks } from './sections';

/**
 * Remarks: annotations on a result or definition, for people to read. A remark
 * explains (the idea behind a proof, why a step is needed, a picture to keep in
 * mind, where a proof came from); it never claims anything a result relies on,
 * which is an idea or a result instead. Remarks are not graph nodes: nothing
 * depends on them, no approval or check covers them, and the loop writes them
 * but never reads them. One file per remark, so collaborators adding remarks
 * never conflict. Pure; no I/O.
 */

export const REMARK_STATUS_LIST = ['active', 'archived'] as const;
export type RemarkStatus = (typeof REMARK_STATUS_LIST)[number];
/** Where a remark was written: the teaching chat, the loop's own chat, or elsewhere (extraction, the dashboard, migration). */
export const REMARK_FROM_LIST = ['teaching', 'loop', 'other'] as const;
export type RemarkFrom = (typeof REMARK_FROM_LIST)[number];
export const REMARK_ORIGIN_LIST = ['researcher', 'agent'] as const;
export type RemarkOrigin = (typeof REMARK_ORIGIN_LIST)[number];
/** New remarks the loop may write on its current target within one stage, so the researcher's own are not drowned out. */
export const LOOP_REMARKS_PER_STAGE = 2;

export interface RemarkData {
  type: 'remark';
  title: string;
  /** The asset or definition it annotates. */
  target: string;
  /** Where in the target, e.g. "step 3"; optional. */
  anchor?: string;
  /** Whose remark it is: the researcher's, even when an agent worded it, or an agent's own. */
  origin: RemarkOrigin;
  from: RemarkFrom;
  status: RemarkStatus;
  /** The target's text the remark was written for (see remarkTargetDigest); a later change makes it stale, not wrong. */
  target_digest: string;
  at: string;
  tags?: string[];
}

export interface Remark extends RemarkData { id: string; body: string; file: string }

export const REMARK_ID = /^remark_[a-z0-9]+$/;

/**
 * What a remark was written against: the target's proof when it has one, else
 * its statement. Prose-normalized and without managed blocks, so relinking or
 * reflowing never makes a remark stale.
 */
export function remarkTargetDigest(content: string): string {
  const body = stripManagedBlocks(content);
  const proof = sectionContent(body, 'Proof');
  return sha(normalizeProse(proof || statementPart(body)));
}

/** Problems with one remark file, each prefixed with its ID; `targets` holds every asset and definition ID. */
export function remarkProblems(id: string, data: Record<string, any>, content: string, targets?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!REMARK_ID.test(id)) problems.push(`${id}: remark files are named remark_<id>.md; write remarks with remark add.`);
  if (data.type !== 'remark') problems.push(`${id}: type must be remark.`);
  if (typeof data.title !== 'string' || !data.title.trim()) problems.push(`${id}: title is required.`);
  if (typeof data.target !== 'string' || !data.target) problems.push(`${id}: target names the asset or definition the remark is on.`);
  else if (targets && !targets.has(data.target)) problems.push(`${id}: target ${data.target} is not an asset or definition.`);
  if (!(REMARK_ORIGIN_LIST as readonly unknown[]).includes(data.origin)) problems.push(`${id}: origin must be ${REMARK_ORIGIN_LIST.join(' or ')}.`);
  if (!(REMARK_FROM_LIST as readonly unknown[]).includes(data.from)) problems.push(`${id}: from must be one of ${REMARK_FROM_LIST.join(', ')}.`);
  if (!(REMARK_STATUS_LIST as readonly unknown[]).includes(data.status)) problems.push(`${id}: status must be ${REMARK_STATUS_LIST.join(' or ')}.`);
  if (data.anchor !== undefined && typeof data.anchor !== 'string') problems.push(`${id}: anchor is a short text such as "step 3".`);
  if (typeof data.target_digest !== 'string' || !data.target_digest) problems.push(`${id}: target_digest is stamped by remark add.`);
  if (!content.trim()) problems.push(`${id}: the remark is empty.`);
  return problems;
}

/** Relation fields that may never name a remark: remarks are annotations, so nothing depends on them. */
export function remarkReferenceProblems(nodeId: string, data: Record<string, any>, remarkIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const field of ['depends_on', 'uses_definitions', 'related_assets', 'inspired_by', 'adapts', 'serves']) {
    const value = data[field];
    for (const ref of Array.isArray(value) ? value : []) if (remarkIds.has(String(ref))) problems.push(`${nodeId}: ${field} names the remark ${ref}; remarks are annotations, and nothing depends on them.`);
  }
  for (const field of ['target_asset', 'refutes', 'derived_from']) if (typeof data[field] === 'string' && remarkIds.has(data[field])) problems.push(`${nodeId}: ${field} names the remark ${data[field]}; remarks are annotations, and nothing depends on them.`);
  return problems;
}

/** Who may change an existing remark: the loop only its own; the teaching chat and the researcher any, at the researcher's request. */
export function remarkEditProblem(remark: Pick<RemarkData, 'from'>, by: RemarkFrom, id: string): string | undefined {
  if (by === 'loop' && remark.from !== 'loop') return `${id} was written ${remark.from === 'teaching' ? 'in the teaching chat' : 'outside the loop'}; the loop may change only its own remarks. Add a new remark instead.`;
  return undefined;
}

/** A one-line label for listings: where it came from, and whether it predates the target's current text. */
export function remarkLabel(remark: Pick<RemarkData, 'origin' | 'from' | 'status'>, stale: boolean): string {
  const who = remark.origin === 'researcher' ? "the researcher's" : remark.from === 'loop' ? "the loop's, not checked by anyone" : "an agent's, not checked by anyone";
  return [who, stale ? 'written for an earlier version of the result' : '', remark.status === 'archived' ? 'archived' : ''].filter(Boolean).join('; ');
}
