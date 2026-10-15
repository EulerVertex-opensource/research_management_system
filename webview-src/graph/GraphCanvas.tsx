import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdgeView, GraphNodeView } from '../../src/models/graph';
import { kindLabel } from '../../src/domain/copy';
import { COLOR, DEFINITION_COLOR, nodeStyle, tint } from './colors';
import type { FoldView } from './graphModel';
import { Layout, NODE_H, NODE_W, layout } from './layout';

interface Props {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  required: string[];
  /** Finished branches folded into chips (the "Why isn't it done?" view). */
  folds?: FoldView[];
  /** What holds each result up; edges out of such a result are drawn thick in its color. */
  blocking?: Map<string, 'stuck' | 'needs_you'>;
  selectedId?: string;
  /** Nodes to emphasize (the rest are dimmed), e.g. a focus neighborhood. */
  highlight?: Set<string>;
  onSelect: (id: string) => void;
  /** A click on empty canvas (not a drag): closes the open card. */
  onBackground?: () => void;
  /** The card a clicked result opens into, drawn next to it on the canvas. */
  renderCard?: (id: string) => React.ReactNode;
  height?: number | string;
}

const CARD_W = 380;

const FOLD_H = 46;
const EDGE = {
  done: { color: COLOR.approved, width: 1.2, opacity: 0.45 },
  working: { color: COLOR.active, width: 1.8, opacity: 0.9 },
  stuck: { color: COLOR.error, width: 3, opacity: 1 },
  needs_you: { color: COLOR.waiting, width: 3, opacity: 1 },
  other: { color: COLOR.muted, width: 1.2, opacity: 0.6 },
} as const;
type EdgeKind = keyof typeof EDGE;

/**
 * SVG rendering read top to bottom, with pan (drag the background), zoom
 * (wheel, around the cursor), and fit. A click on a result opens its card next
 * to it. Below 60% zoom only titles are drawn.
 */
export function GraphCanvas({ nodes, edges, required, folds = [], blocking, selectedId, highlight, onSelect, onBackground, renderCard, height = '100%' }: Props) {
  const requiredSet = useMemo(() => new Set(required), [required]);
  const placed: Layout = useMemo(() => layout([...nodes.map((node) => ({ id: node.id, required: requiredSet.has(node.id) })), ...folds.map((fold) => ({ id: fold.id }))], edges.filter((edge) => edge.type !== 'refutes')), [nodes, folds, edges, requiredSet]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | undefined>();
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** The researcher panned or zoomed: stop refitting on resize. */
  const touched = useRef(false);
  /** Bumped by every fit, so an open card can make room again after the graph is refitted. */
  const [fits, setFits] = useState(0);

  const fit = () => {
    const element = box.current;
    // Not laid out yet (a hidden or just-mounted panel): fit once it has a size.
    if (!element || !placed.width || !element.clientWidth || !element.clientHeight) return;
    const k = Math.min(1.1, Math.max(0.25, Math.min(element.clientWidth / placed.width, element.clientHeight / placed.height)));
    setView({ x: (element.clientWidth - placed.width * k) / 2, y: 8, k });
    setFits((count) => count + 1);
  };
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Refit when the set of drawn nodes changes (not on every refresh, so the researcher's zoom survives agent edits) and when the panel is resized before they zoomed.
  const signature = [...nodes.map((node) => node.id), ...folds.map((fold) => fold.id)].sort().join(',');
  useEffect(() => { touched.current = false; fit(); }, [signature]);
  useEffect(() => { if (!touched.current) fit(); }, [size.w, size.h]);

  // Opening a card next to a result: if neither side has room, slide the graph so the card fits to the right of it.
  useEffect(() => {
    if (!selectedId || !renderCard || !size.w) return;
    const at = placed.positions.get(selectedId);
    if (!at) return;
    const width = Math.min(CARD_W, size.w - 16);
    const left = view.x + at.x * view.k; const right = view.x + (at.x + NODE_W) * view.k;
    if (right + 12 + width <= size.w - 8 || left - 12 - width >= 8) return;
    if (16 + (right - left) + 12 + width > size.w - 8) return; // too narrow either way: the card overlaps
    setView((current) => ({ ...current, x: current.x + 16 - left }));
  }, [selectedId, size.w, fits]);

  const onWheel = (event: React.WheelEvent) => {
    if ((event.target as Element).closest('[data-card]')) return;
    touched.current = true;
    const rect = box.current!.getBoundingClientRect();
    const px = event.clientX - rect.left; const py = event.clientY - rect.top;
    setView((current) => {
      const k = Math.min(2.5, Math.max(0.15, current.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      return { k, x: px - ((px - current.x) * k) / current.k, y: py - ((py - current.y) * k) / current.k };
    });
  };
  const onMouseDown = (event: React.MouseEvent) => {
    if ((event.target as Element).closest('[data-node],[data-card],button')) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMouseMove = (event: React.MouseEvent) => {
    if (!drag.current) return;
    const start = drag.current;
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4) { start.moved = true; touched.current = true; }
    setView((current) => ({ ...current, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y }));
  };
  const endDrag = (event?: React.MouseEvent) => {
    const start = drag.current;
    drag.current = undefined;
    if (event && start && !start.moved) onBackground?.();
  };
  const detailed = view.k >= 0.6;

  const edgeKind = (edge: GraphEdgeView): EdgeKind => {
    const prerequisite = byId.get(edge.to);
    if (!prerequisite) return 'done'; // a folded branch
    if (prerequisite.progress === 'done') return 'done';
    if (prerequisite.progress === 'working') return 'working';
    return blocking?.get(edge.to) ?? 'other';
  };
  const drawn = edges.filter((edge) => edge.type !== 'refutes').map((edge) => ({ edge, kind: edgeKind(edge) }));
  const rank: Record<EdgeKind, number> = { done: 0, other: 1, working: 2, needs_you: 3, stuck: 4 };
  drawn.sort((a, b) => rank[a.kind] - rank[b.kind]);

  return (
    <div ref={box} style={{ position: 'relative', height, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={() => { drag.current = undefined; }}>
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 4, zIndex: 1 }}>
        <button onClick={() => setView((current) => ({ ...current, k: Math.min(2.5, current.k * 1.2) }))} style={miniButton} title="Zoom in" aria-label="Zoom in">+</button>
        <button onClick={() => setView((current) => ({ ...current, k: Math.max(0.15, current.k / 1.2) }))} style={miniButton} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => { touched.current = false; fit(); }} style={miniButton} title="Fit to view">Fit</button>
      </div>
      <svg width="100%" height="100%" role="img" aria-label="Research dependency graph: prerequisites above, main results below">
        <defs>
          {(Object.keys(EDGE) as EdgeKind[]).map((kind) => (
            <marker key={kind} id={`arrow-${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth={kind === 'stuck' || kind === 'needs_you' ? 4.5 : 7} markerHeight={kind === 'stuck' || kind === 'needs_you' ? 4.5 : 7} orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={EDGE[kind].color} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {drawn.map(({ edge, kind }) => {
            const top = placed.positions.get(edge.to); const bottom = placed.positions.get(edge.from);
            if (!top || !bottom) return null;
            const x1 = top.x + NODE_W / 2; const y1 = top.y + NODE_H; const x2 = bottom.x + NODE_W / 2; const y2 = bottom.y;
            const bend = Math.max(24, (y2 - y1) / 2);
            const style = EDGE[kind];
            const dim = highlight && !(highlight.has(edge.from) && (highlight.has(edge.to) || edge.to.startsWith('fold:')));
            return (
              <path key={`${edge.from}>${edge.to}:${edge.type}`} d={`M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2 - 2}`}
                fill="none" stroke={style.color} strokeWidth={style.width} strokeDasharray={edge.type === 'uses_definition' && style.width < 2 ? '4 3' : undefined}
                opacity={dim ? 0.12 : style.opacity} markerEnd={`url(#arrow-${kind})`} />
            );
          })}
          {folds.map((fold) => {
            const at = placed.positions.get(fold.id);
            if (!at) return null;
            const dim = highlight && !highlight.has(fold.parent);
            return (
              <g key={fold.id} transform={`translate(${at.x},${at.y + NODE_H - FOLD_H})`} opacity={dim ? 0.3 : 1}>
                <title>{`Finished: ${fold.members.map((id) => byId.get(id)?.title ?? id).join(', ')}`}</title>
                <foreignObject width={NODE_W} height={FOLD_H}>
                  <div style={{ height: FOLD_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 6, border: `1px solid ${tint(COLOR.approved, 55)}`, background: tint(COLOR.approved, 10), fontSize: 12, overflow: 'hidden' }}>
                    <span style={{ color: COLOR.approved, fontWeight: 700 }}>✓</span>
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fold.title}</span>
                      <span style={{ color: COLOR.muted, fontSize: 11 }}>{fold.members.length > 1 ? `+ ${fold.members.length - 1} more · all done` : 'Done'}</span>
                    </span>
                  </div>
                </foreignObject>
              </g>
            );
          })}
          {nodes.map((node) => {
            const at = placed.positions.get(node.id);
            if (!at) return null;
            const style = nodeStyle(node);
            const dim = highlight && !highlight.has(node.id);
            const selected = node.id === selectedId;
            const isRequired = requiredSet.has(node.id);
            const closure = node.closure;
            return (
              <g key={node.id} data-node={node.id} transform={`translate(${at.x},${at.y})`} opacity={dim ? 0.3 : 1} style={{ cursor: 'pointer' }}
                onClick={() => onSelect(node.id)}>
                <title>{`${node.title}\n${node.progressLabel}${node.progressDetail ? ` · ${node.progressDetail}` : ''}\n${kindLabel(node.type)} · ${node.id}\nClick to open its card.`}</title>
                <foreignObject width={NODE_W} height={NODE_H}>
                  <div style={{
                    height: NODE_H, boxSizing: 'border-box', borderRadius: 6, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden',
                    background: tint(style.color, node.progress === 'waiting' || node.progress === 'inactive' ? 4 : 13),
                    border: `${isRequired ? 2 : 1.5}px ${style.dashed ? 'dashed' : 'solid'} ${style.color}`,
                    boxShadow: selected ? '0 0 0 2px var(--vscode-focusBorder, #fff)' : undefined, color: 'var(--vscode-foreground)',
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '0 7px', borderRadius: 9, background: tint(style.color, 30), color: 'var(--vscode-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.progressLabel}</span>
                      {isRequired && <span style={{ fontSize: 11, fontWeight: 700, color: COLOR.waiting, whiteSpace: 'nowrap' }}>★ Main</span>}
                      {node.kind === 'definition' && <span style={{ fontSize: 10.5, fontWeight: 700, color: DEFINITION_COLOR, whiteSpace: 'nowrap', letterSpacing: 0.3 }}>DEFINITION</span>}
                    </span>
                    <span style={{ fontSize: detailed ? 12.5 : 14, fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.title}</span>
                    {detailed && <span style={{ fontSize: 10.5, color: COLOR.muted, fontFamily: 'var(--vscode-editor-font-family, monospace)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{kindLabel(node.type)}{node.origin === 'library' ? ' · known result' : node.cited ? ' · cited' : ''} · {node.id}</span>}
                    {detailed && (node.progressDetail || closure) && (
                      <span style={{ fontSize: 11, color: node.progress === 'done' || node.progress === 'waiting' ? COLOR.muted : style.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {node.progressDetail || (closure ? `${closure.done} of ${closure.total} parts done` : '')}
                      </span>
                    )}
                    {detailed && closure && (
                      <span style={{ display: 'block', height: 4, borderRadius: 2, background: tint(COLOR.muted, 30), overflow: 'hidden', flexShrink: 0 }}>
                        <span style={{ display: 'block', height: 4, width: `${Math.round((100 * closure.done) / Math.max(1, closure.total))}%`, background: COLOR.approved }} />
                      </span>
                    )}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>
      {selectedId && renderCard && placed.positions.has(selectedId) && (() => {
        const at = placed.positions.get(selectedId)!;
        const width = size.w ? Math.min(CARD_W, size.w - 16) : CARD_W;
        let left = view.x + (at.x + NODE_W) * view.k + 12;
        if (size.w && left + width > size.w - 8) left = view.x + at.x * view.k - width - 12;
        if (size.w) left = Math.max(8, Math.min(left, size.w - width - 8));
        const top = Math.max(8, size.h ? Math.min(view.y + at.y * view.k, size.h - 160) : view.y + at.y * view.k);
        return (
          <div data-card="" style={{ position: 'absolute', left, top, width, maxHeight: size.h ? size.h - top - 8 : undefined, overflow: 'auto', zIndex: 2, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.45)', background: 'var(--vscode-editor-background)', cursor: 'auto' }}>
            {renderCard(selectedId)}
          </div>
        );
      })()}
    </div>
  );
}

export const miniButton: React.CSSProperties = {
  padding: '2px 8px', fontSize: 12, border: '1px solid var(--vscode-panel-border)', borderRadius: 3, cursor: 'pointer',
  background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
};
