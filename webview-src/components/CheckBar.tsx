import React from 'react';
import type { ResearchNode } from '../../src/models/types';
import { CITED_SOURCE_KINDS } from '../../src/domain/nodeKinds';
import { COLOR, tint } from '../graph/colors';
import { buttonStyle } from '../graph/AttentionList';

/**
 * Above a known result extracted from a paper or notes that is not checked
 * yet: where in the source to look, and the one act of checking it. While the
 * researcher goes through a collection, it also counts what is left and moves
 * on. An extracted result is never accepted in bulk: a transcription slip
 * (a dropped hypothesis, a wrong theorem number) would become a known result
 * the loop never proves again.
 */

interface Props {
  node: ResearchNode;
  /** Unchecked results left in the collection, this one included. */
  remaining: number;
  /** The researcher is going through the collection. */
  reviewing: boolean;
  onCheck: () => void;
  onSkip: () => void;
  onStop: () => void;
  onOpenPaper: (paperId: string) => void;
}

/** Whether a result needs the check bar: an unchecked one in a collection that is not an imported package. */
export function needsCheck(node: ResearchNode | null | undefined, packages: Set<string>): node is ResearchNode {
  return Boolean(node && node.origin === 'library' && node.status === 'draft' && !(node.collection && packages.has(node.collection)));
}

/** Unchecked results of a collection in library order. */
export function uncheckedIn(nodes: ResearchNode[], collection: string | undefined): ResearchNode[] {
  return nodes
    .filter((node) => node.origin === 'library' && node.status === 'draft' && node.collection === collection)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
}

/** The next unchecked result after `current` (wrapping around), leaving out the ones skipped; undefined when none is left. */
export function nextToCheck(nodes: ResearchNode[], collection: string | undefined, current: string | undefined, skipped: Set<string> = new Set()): ResearchNode | undefined {
  const queue = uncheckedIn(nodes, collection);
  const at = queue.findIndex((node) => node.id === current);
  const ordered = at < 0 ? queue : [...queue.slice(at + 1), ...queue.slice(0, at)];
  return ordered.find((node) => node.id !== current && !skipped.has(node.id));
}

export function CheckBar({ node, remaining, reviewing, onCheck, onSkip, onStop, onOpenPaper }: Props) {
  const source = node.source;
  const cited = Boolean(source && CITED_SOURCE_KINDS.has(source.kind));
  const missing = cited && (!source?.paper_id || !source.location?.trim());
  const where = cited
    ? <><strong>{source!.paper_id ?? 'the paper'}</strong>{source!.location ? <>, {source!.location}</> : null}</>
    : source?.kind === 'original' ? <>the work named in the text below</> : <>its source</>;
  return (
    <div role="region" aria-label="Check against the source" style={{ padding: '8px 14px', borderBottom: `1px solid ${COLOR.border}`, background: tint(COLOR.waiting, 10), fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Check against the source:</span>
        <span>{where}</span>
        {(reviewing || remaining > 1) && <span style={{ marginLeft: 'auto', color: COLOR.muted, whiteSpace: 'nowrap' }}>{remaining} left in {node.collection}</span>}
      </div>
      <div style={{ color: COLOR.muted, fontSize: 11 }}>
        {missing
          ? 'Add the paper and the exact location under Source below first, so the check can be traced.'
          : 'Compare the statement below with the source: every hypothesis, the constants, the conclusion. If something differs, edit it below first.'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={onCheck} disabled={missing} style={{ ...buttonStyle('primary'), ...(missing ? { opacity: 0.5, cursor: 'default' } : {}) }}
          title="Mark it as checked; the research loop then uses it as known and never re-proves it. An edit later makes it unchecked again.">
          ✓ Matches the source
        </button>
        {cited && source?.paper_id && <button onClick={() => onOpenPaper(source.paper_id!)} style={buttonStyle('secondary')} title={`Open the PDF of ${source.paper_id}`}>Open paper</button>}
        {(reviewing || remaining > 1) && <button onClick={onSkip} style={buttonStyle('secondary')} title="Leave it unchecked for now and go to the next one">Skip</button>}
        {reviewing && <button onClick={onStop} style={buttonStyle('secondary')}>Stop</button>}
      </div>
    </div>
  );
}
