import { sectionContent } from './sections';

/**
 * Rewording a verified result at the researcher's request, from the teaching
 * chat. The teacher only proposes; the loop applies a proposal between stages,
 * and a reworded proof always goes through the independent check before it
 * stands. Remarks once lived here as a managed block inside the result; they
 * are now remark files of their own (domain/remarks.ts), and the helpers below
 * remain only to read and migrate that block. Remarks were a managed block, so they
 * never change what was approved or verified. Pure; no I/O.
 */

/** Proposals waiting for the loop, one per result; local, like the rest of the loop's run state. */
export const REVISIONS_DIR = '.research-assistant-loop/revisions';
export const revisionPath = (id: string) => `${REVISIONS_DIR}/${id}.json`;

/** The project's proof style, shared by collaborators: execute-proof writes new proofs to it, and the teacher rewords to it. */
export const STYLE_FILE = 'style.md';

export interface ProofRevision {
  id: string;
  /** The reworded `## Proof`, if the proof changes. */
  proof?: string;
  /** What was reworded and why, for the verifier and the record. */
  changes?: string;
  /** Legacy: remarks proposed before schema 3; the loop turns them into a remark file. */
  remarks?: string;
  /** Digests of the statement and proof the teacher reworded, so a proposal made against an older version is never applied. */
  baseStatement: string;
  baseProof?: string;
  at: string;
}

/** A draft as the teacher writes it: `## Proof` with `## Changes`. Never a statement; remarks are written with remark add. */
export function parseRevisionDraft(markdown: string): { proof?: string; changes?: string } {
  const body = markdown.replace(/^\uFEFF?---[\s\S]*?\n---[ \t]*\n/, '');
  const headings = [...body.matchAll(/^## (.+?)[ \t]*$/gm)].map((match) => match[1]);
  if (headings.includes('Remarks')) throw new Error('Remarks are no longer part of a rewording: write each one with add_remark (or remark add --target <id> --from teaching), and keep only ## Proof and ## Changes in the draft.');
  const before = body.split(/^## /m)[0].replace(/^# .*$/gm, '').trim();
  if (before || headings.some((heading) => !['Proof', 'Changes'].includes(heading))) {
    throw new Error('A revision holds only ## Proof and ## Changes; it never changes the statement, and nothing else may be in the draft.');
  }
  const proof = sectionContent(body, 'Proof') || undefined;
  const changes = sectionContent(body, 'Changes') || undefined;
  if (!proof) throw new Error('The draft needs ## Proof: the reworded proof.');
  if (!changes) throw new Error('A reworded proof needs ## Changes: what was reworded and why, so the independent check knows where to look.');
  return { proof, changes };
}

const REMARKS_START = '<!-- research-assistant:remarks:start -->';
const REMARKS_END = '<!-- research-assistant:remarks:end -->';
const REMARKS_BLOCK = /\n*<!-- research-assistant:remarks:start -->[\s\S]*?<!-- research-assistant:remarks:end -->\n?/;
/** The legacy remarks block inside a result file; schema 3 moves its text into a remark file. */
export const REMARKS_BLOCK_PATTERN = REMARKS_BLOCK;

/** The researcher's remarks in a node body, without the block markers and heading. */
export function remarksOf(body: string): string {
  const match = REMARKS_BLOCK.exec(body);
  return match ? match[0].replace(REMARKS_START, '').replace(REMARKS_END, '').replace(/^\s*### Remarks[ \t]*\n/, '').trim() : '';
}

/**
 * The body with its remarks replaced (or removed when empty), at the end. The
 * heading is `###` so the block never ends the section it sits in: digests
 * strip the whole block, so remarks change no approval and no verification.
 */
export function withRemarks(body: string, remarks: string): string {
  const rest = body.replace(REMARKS_BLOCK, '\n').trimEnd();
  return remarks.trim() ? `${rest}\n\n${REMARKS_START}\n### Remarks\n\n${remarks.trim()}\n${REMARKS_END}\n` : `${rest}\n`;
}

/** The body with `## Proof` replaced; the remarks stay where they are. */
export function withProof(body: string, proof: string): string {
  const remarks = remarksOf(body);
  const rest = body.replace(REMARKS_BLOCK, '\n');
  const section = /^## Proof[ \t]*\r?\n[\s\S]*?(?=^## |^<!-- research-assistant:|(?![\s\S]))/m;
  const replaced = section.test(rest) ? rest.replace(section, `## Proof\n\n${proof.trim()}\n\n`) : `${rest.trimEnd()}\n\n## Proof\n\n${proof.trim()}\n`;
  return withRemarks(replaced, remarks);
}

/** A reworded proof may not open new `## ` sections: they would split the asset. */
export function proofDraftProblem(proof: string): string | undefined {
  return /^## /m.test(proof) ? 'The reworded proof may not contain "## " headings; use ### or bold step labels.' : undefined;
}
