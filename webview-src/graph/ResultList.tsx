import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphAction, GraphNodeView, GraphPayload } from '../../src/models/graph';
import { isPrerequisiteEdge } from '../../src/models/graph';
import type { FocusedGraph } from './graphModel';
import { layout } from './layout';
import { ResultCard, boxStyle } from './ResultCard';
import { COLOR, tint } from './colors';

interface Props {
  graph: FocusedGraph;
  payload: GraphPayload;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onAction: (action: GraphAction) => void;
  onDetails: (id: string) => void;
}

/** Reading order of the graph: top to bottom, left to right, so prerequisites come first and main results last. */
export function readingOrder(ids: string[], edges: Array<{ from: string; to: string; type?: string }>, required: string[]): string[] {
  const placed = layout(ids.map((id) => ({ id, required: required.includes(id) })), edges.filter((edge) => !edge.type || isPrerequisiteEdge({ type: edge.type })));
  return [...ids].sort((a, b) => {
    const pa = placed.positions.get(a)!; const pb = placed.positions.get(b)!;
    return pa.y - pb.y || pa.x - pb.x;
  });
}

/** The graph as a vertical list of boxes; click one to show it in the panel next to the list. */
export function ResultList({ graph, payload, selectedId, onSelect, onAction, onDetails }: Props) {
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
  const refs = useRef(new Map<string, HTMLElement>());
  const byId = useMemo(() => new Map(payload.nodes.map((node) => [node.id, node])), [payload.nodes]);
  const order = useMemo(() => readingOrder([...graph.nodes.map((node) => node.id), ...graph.folds.map((fold) => fold.id)], graph.edges, payload.required), [graph, payload.required]);

  // A result chosen elsewhere ("Show in Results", the graph) scrolls into view, out of its fold if need be.
  useEffect(() => {
    if (!selectedId) return;
    const fold = graph.folds.find((item) => item.members.includes(selectedId));
    if (fold) setOpenFolds((current) => new Set([...current, fold.id]));
    const timer = setTimeout(() => refs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    return () => clearTimeout(timer);
  }, [selectedId]);

  const card = (node: GraphNodeView) => (
    <ResultCard key={node.id} node={node} payload={payload} expanded={false} selected={node.id === selectedId} onToggle={() => onSelect(node.id === selectedId ? undefined : node.id)}
      onAction={onAction} onDetails={onDetails}
      innerRef={(element: HTMLElement | null) => { if (element) refs.current.set(node.id, element); else refs.current.delete(node.id); }} />
  );

  if (!order.length) return null;
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '10px 12px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {order.map((id) => {
        const fold = graph.folds.find((item) => item.id === id);
        if (!fold) { const node = byId.get(id); return node ? card(node) : null; }
        const expanded = openFolds.has(fold.id);
        const members = readingOrder(fold.members, payload.edges, payload.required).map((member) => byId.get(member)).filter((node): node is GraphNodeView => Boolean(node));
        return (
          <section key={fold.id} style={{ ...boxStyle(tint(COLOR.approved, 50)), background: tint(COLOR.approved, 7) }}>
            <button aria-expanded={expanded} onClick={() => setOpenFolds((current) => { const next = new Set(current); if (next.has(fold.id)) next.delete(fold.id); else next.add(fold.id); return next; })}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', border: 'none', background: 'transparent', color: 'var(--vscode-foreground)', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}>
              <span style={{ color: COLOR.approved, fontWeight: 700 }}>✓</span>
              <span style={{ fontWeight: 600 }}>{fold.members.length === 1 ? fold.title : `${fold.members.length} finished results`}</span>
              <span style={{ color: COLOR.muted }}>{fold.members.length === 1 ? 'done' : `${fold.title} and ${fold.members.length - 1} more, all done`} · used by {byId.get(fold.parent)?.title ?? fold.parent}</span>
              <span aria-hidden="true" style={{ marginLeft: 'auto', color: COLOR.muted, fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>{members.map(card)}</div>}
          </section>
        );
      })}
    </div>
  );
}
