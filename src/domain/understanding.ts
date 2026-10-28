import { parseMarkdown } from '../services/Frontmatter';
import { normalizeProse, proofDigest, sha } from './digests';
import { sectionContent, statementPart } from './sections';
import { UnderstandingLevel, UnderstandingState, toLevel } from './understandingLevels';

export * from './understandingLevels';

/**
 * What the researcher has understood of the verified results: a personal,
 * local record (`research-local/understanding.json`, never shared), so the
 * teaching chat explains what is new to this researcher, in dependency order.
 * Only the researcher sets it (a popup, the dashboard, or a terminal); agents
 * never write it. Pure; shared by the extension, the CLI, and the webview.
 */

/** One mark: the level, the statement and proof it was given for (digests and text, so a later change can be explained as a diff). */
export interface UnderstandingMark {
  level: UnderstandingLevel;
  at: string;
  statement: string;
  proof?: string;
  note?: string;
  snapshot: { statement: string; proof?: string };
}
export interface UnderstandingFile { version: 1; marks: Record<string, UnderstandingMark> }

export function parseUnderstanding(text: string | undefined): UnderstandingFile {
  const empty: UnderstandingFile = { version: 1, marks: {} };
  if (!text?.trim()) return empty;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return empty; }
  const marks = raw && typeof raw === 'object' && (raw as Record<string, unknown>).marks;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return empty;
  const kept: Record<string, UnderstandingMark> = {};
  for (const [id, value] of Object.entries(marks as Record<string, any>)) {
    const level = toLevel(value?.level);
    if (!level || typeof value.statement !== 'string' || typeof value.at !== 'string') continue;
    kept[id] = { level, at: value.at, statement: value.statement, ...(typeof value.proof === 'string' ? { proof: value.proof } : {}), ...(typeof value.note === 'string' && value.note ? { note: value.note } : {}),
      snapshot: { statement: String(value.snapshot?.statement ?? ''), ...(typeof value.snapshot?.proof === 'string' ? { proof: value.snapshot.proof } : {}) } };
  }
  return { version: 1, marks: kept };
}

export const serializeUnderstanding = (file: UnderstandingFile) => JSON.stringify(file, null, 2) + '\n';

/** The statement and proof as the researcher reads them, and their digests: wording changes count, frontmatter does not. */
export function understandingParts(raw: string): { statement: string; proof?: string; statementDigest: string; proofDigest?: string } {
  const { content } = parseMarkdown(raw);
  const statement = statementPart(content).trim();
  const proof = sectionContent(content, 'Proof').trim();
  return { statement, statementDigest: sha(normalizeProse(statement)), ...(proof ? { proof, proofDigest: proofDigest(raw) } : {}) };
}

export function markFor(raw: string, level: UnderstandingLevel, at: string, note?: string): UnderstandingMark {
  const parts = understandingParts(raw);
  return {
    level, at, statement: parts.statementDigest, ...(parts.proofDigest ? { proof: parts.proofDigest } : {}), ...(note?.trim() ? { note: note.trim() } : {}),
    snapshot: { statement: parts.statement, ...(parts.proof ? { proof: parts.proof } : {}) },
  };
}

export function understandingState(mark: UnderstandingMark | undefined, raw: string): { state: UnderstandingState; level?: UnderstandingLevel } {
  if (!mark) return { state: 'new' };
  const parts = understandingParts(raw);
  if (mark.statement !== parts.statementDigest) return { state: 'statement_changed' };
  if (mark.level !== 'black_box' && mark.proof !== parts.proofDigest) return { state: 'proof_changed', level: 'black_box' };
  return { state: 'understood', level: mark.level };
}

/** A verified result as the teaching chat and the dashboard see it. */
export interface StudyItem {
  id: string;
  kind: 'asset' | 'definition';
  type: string;
  title: string;
  /** `approved` by the researcher (or auto mode), or `checked`: a proof an independent verification confirmed. */
  verified: 'approved' | 'checked';
  hasProof: boolean;
  required: boolean;
  failedPlans: number;
  state: UnderstandingState;
  /** The level that still holds now; undefined when nothing does. */
  level?: UnderstandingLevel;
  /** The level the teaching chat aims for: the key idea for main results and hard-won proofs, the statement otherwise. */
  suggested: UnderstandingLevel;
  /** Verified results it rests on that the researcher does not know yet, even as black boxes. */
  waitingOn: string[];
  /** When it was verified, if the loop's records say. */
  verifiedAt?: string;
  note?: string;
}

export const isBehind = (item: Pick<StudyItem, 'state'>) => item.state !== 'understood';

export interface StudyInput {
  id: string;
  kind: 'asset' | 'definition';
  type: string;
  title: string;
  raw: string;
  verified: 'approved' | 'checked';
  /** Project nodes it rests on: depends_on and uses_definitions. */
  prerequisites: string[];
  required: boolean;
  failedPlans: number;
  verifiedAt?: string;
}

/** Study items in dependency order (what a result rests on comes first), each with its state against the marks. */
export function studyItems(inputs: StudyInput[], marks: Record<string, UnderstandingMark>): StudyItem[] {
  const byId = new Map(inputs.map((input) => [input.id, input]));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)!.prerequisites) visit(dep);
    order.push(id);
  };
  // Definitions first, then results by title, so the order is stable as files are added.
  [...inputs].sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'definition' ? -1 : 1)).forEach((input) => visit(input.id));
  const items = new Map<string, StudyItem>();
  for (const id of order) {
    const input = byId.get(id)!;
    const { state, level } = understandingState(marks[id], input.raw);
    const hasProof = Boolean(understandingParts(input.raw).proof);
    items.set(id, {
      id, kind: input.kind, type: input.type, title: input.title, verified: input.verified, hasProof, required: input.required, failedPlans: input.failedPlans,
      state, ...(level ? { level } : {}),
      suggested: hasProof && (input.required || input.failedPlans > 0) ? 'idea' : 'black_box',
      waitingOn: input.prerequisites.filter((dep) => byId.has(dep) && !items.get(dep)?.level),
      ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}), ...(marks[id]?.note ? { note: marks[id].note } : {}),
    });
  }
  return order.map((id) => items.get(id)!);
}
