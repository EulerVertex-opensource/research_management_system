import React, { useMemo } from 'react';
import type { GraphAction, GraphNodeView } from '../../src/models/graph';
import { REPAIR_LABEL, repairDetail } from '../../src/domain/copy';
import { buttonStyle } from './AttentionList';
import { COLOR, tint } from './colors';

/** Tokens a proof diff compares: words, with the space after them, so a change reads in whole words. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

/** Above this many token pairs the word diff is skipped and both versions are shown whole. */
const DIFF_CELLS = 4_000_000;

/**
 * A word diff of the researcher's proof and the repaired one (longest common subsequence),
 * adjacent parts of one kind merged. Undefined when the proofs are too long to compare here.
 */
export function wordDiff(before: string, after: string): DiffPart[] | undefined {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > DIFF_CELLS) return undefined;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i].trim() === b[j].trim() ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].trim() === b[j].trim()) { push('same', b[j]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) push('removed', a[i++]);
    else push('added', b[j++]);
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);
  return parts;
}

/** The researcher's proof against the repaired one: removed words struck through, added words highlighted. */
export function ProofDiff({ previous, proof }: { previous: string; proof: string }) {
  const parts = useMemo(() => wordDiff(previous, proof), [previous, proof]);
  const box: React.CSSProperties = { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, maxHeight: 320, overflow: 'auto', padding: 8, borderRadius: 4, border: `1px solid ${COLOR.border}`, background: COLOR.card };
  if (!parts) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ color: COLOR.muted }}>Too long to compare word by word; both versions in full:</div>
        <b>Your version</b><div style={box}>{previous}</div>
        <b>Repaired</b><div style={box}>{proof}</div>
      </div>
    );
  }
  return (
    <div style={box} aria-label="Your proof compared with the repaired proof">
      {parts.map((part, index) => part.kind === 'same' ? <span key={index}>{part.text}</span>
        : part.kind === 'added' ? <ins key={index} style={{ textDecoration: 'none', background: tint(COLOR.approved, 28) }} title="Added by the repair">{part.text}</ins>
        : <del key={index} style={{ color: COLOR.error, background: tint(COLOR.error, 12) }} title="In your version, changed by the repair">{part.text}</del>)}
    </div>
  );
}

/** A result's place in the repair of the researcher's own results, on its card. */
export function RepairSection({ node, onAction, onDetails }: { node: GraphNodeView; onAction: (action: GraphAction) => void; onDetails: (id: string) => void }) {
  const repair = node.repair!;
  const [comparing, setComparing] = React.useState(repair.state === 'review' && repair.how === 'repaired');
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 5, borderTop: `1px solid ${COLOR.border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b>Repair</b><span>{REPAIR_LABEL[repair.state] ?? repair.state}</span>
        <span style={{ color: COLOR.muted }}>{repairDetail(repair)}</span>
      </div>
      {repair.gap && <div><span style={{ color: COLOR.muted }}>The check found: </span>{repair.gap}</div>}
      {repair.failed > 0 && <div style={{ color: COLOR.muted }}>{repair.failed} repair attempt{repair.failed > 1 ? 's' : ''} failed; your proof stayed as you wrote it.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {repair.previous && repair.proof && <button style={buttonStyle(comparing ? 'secondary' : 'primary')} onClick={() => setComparing(!comparing)}>{comparing ? 'Hide the comparison' : 'Compare with your version'}</button>}
        {repair.plan && <button style={buttonStyle('secondary')} onClick={() => onDetails(repair.plan!)} title="The repair plan: the gap, your proof as written, and what was changed">Open the repair plan</button>}
        {repair.state === 'gap' && (
          <button style={buttonStyle('secondary')} title="Copies an instruction and opens the agent chat"
            onClick={() => onAction({ action: 'agent', prompt: `I ask the loop to repair my proof of ${node.title} (${node.id}): run research-loop repair request ${node.id}, then continue the loop. Keep the rest of my argument as I wrote it.` })}>
            Let the loop repair it ↗
          </button>
        )}
      </div>
      {comparing && repair.previous && repair.proof && <ProofDiff previous={repair.previous} proof={repair.proof} />}
    </section>
  );
}
