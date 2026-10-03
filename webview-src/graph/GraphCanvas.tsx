import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdgeView, GraphNodeView } from '../../src/models/graph';
import { COLOR, FLAG_META, nodeColor, statusColor } from './colors';
import { Layout, NODE_H, NODE_W, layout } from './layout';

interface Props {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  required: string[];
  selectedId?: string;
  /** Nodes to emphasize (the rest are dimmed), e.g. a focus neighborhood. */
  highlight?: Set<string>;
  showLanes?: boolean;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  height?: number | string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** SVG rendering with pan (drag the background), zoom (wheel, around the cursor), and fit. Below 60% zoom only IDs are drawn. */
export function GraphCanvas({ nodes, edges, required, selectedId, highlight, showLanes = true, onSelect, onOpen, height = '100%' }: Props) {
  const placed: Layout = useMemo(() => layout(nodes, edges, required), [nodes, edges, required]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | undefined>();

  const fit = () => {
    const element = box.current;
    if (!element || !placed.width) return;
    const k = Math.min(1.2, Math.max(0.25, Math.min(element.clientWidth / placed.width, element.clientHeight / placed.height)));
    setView({ x: (element.clientWidth - placed.width * k) / 2, y: 8, k });
  };
  // Refit only when the set of drawn nodes changes, not on every refresh, so the researcher's zoom survives agent edits.
  const signature = nodes.map((node) => node.id).sort().join(',');
  useEffect(fit, [signature]);

  const onWheel = (event: React.WheelEvent) => {
    const rect = box.current!.getBoundingClientRect();
    const px = event.clientX - rect.left; const py = event.clientY - rect.top;
    setView((current) => {
      const k = Math.min(2.5, Math.max(0.15, current.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      return { k, x: px - ((px - current.x) * k) / current.k, y: py - ((py - current.y) * k) / current.k };
    });
  };
  const onMouseDown = (event: React.MouseEvent) => {
    if ((event.target as Element).closest('[data-node]')) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
  };
  const onMouseMove = (event: React.MouseEvent) => {
    if (!drag.current) return;
    const start = drag.current;
    setView((current) => ({ ...current, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y }));
  };
  const endDrag = () => { drag.current = undefined; };
  const detailed = view.k >= 0.6;

  return (
    <div ref={box} style={{ position: 'relative', height, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag}>
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 4, zIndex: 1 }}>
        <button onClick={() => setView((current) => ({ ...current, k: Math.min(2.5, current.k * 1.2) }))} style={miniButton} title="Zoom in">+</button>
        <button onClick={() => setView((current) => ({ ...current, k: Math.max(0.15, current.k / 1.2) }))} style={miniButton} title="Zoom out">−</button>
        <button onClick={fit} style={miniButton} title="Fit to view">Fit</button>
      </div>
      <svg width="100%" height="100%" role="img" aria-label="Research dependency graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill={COLOR.muted} />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {showLanes && placed.bands.map((band) => (
            <g key={band.lane}>
              <rect x={0} y={band.y} width={placed.width} height={band.height} fill="var(--vscode-editor-foreground)" opacity={0.03} rx={6} />
              <text x={8} y={band.y + 15} fontSize={11} fill={COLOR.muted} fontWeight={600}>
                {band.lane === 'shared' ? 'Shared by several required results' : band.lane === 'other' ? 'Not required' : `Serves ${band.lane}`}
              </text>
            </g>
          ))}
          {edges.map((edge) => {
            const from = placed.positions.get(edge.to); const to = placed.positions.get(edge.from);
            if (!from || !to) return null;
            const x1 = from.x + NODE_W; const y1 = from.y + NODE_H / 2; const x2 = to.x; const y2 = to.y + NODE_H / 2;
            const bend = Math.max(30, Math.abs(x2 - x1) / 2);
            const dim = highlight && !(highlight.has(edge.from) && highlight.has(edge.to));
            return (
              <path key={`${edge.from}>${edge.to}:${edge.type}`} d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                fill="none" stroke={edge.type === 'refutes' ? COLOR.error : COLOR.muted} strokeWidth={1.2}
                strokeDasharray={edge.type === 'uses_definition' ? '4 3' : edge.type === 'refutes' ? '2 2' : undefined}
                opacity={dim ? 0.12 : 0.7} markerEnd="url(#arrow)" />
            );
          })}
          {nodes.map((node) => {
            const at = placed.positions.get(node.id);
            if (!at) return null;
            const color = nodeColor(node);
            const dim = highlight && !highlight.has(node.id);
            const selected = node.id === selectedId;
            const counts = [node.counts.plans ? `${node.counts.plans} attempt${node.counts.plans > 1 ? 's' : ''}${node.counts.failedPlans ? ` (${node.counts.failedPlans} failed)` : ''}` : '', node.counts.ideas ? `${node.counts.ideas} idea${node.counts.ideas > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
            const chips = node.definitions.length ? `uses ${node.definitions.join(', ')}` : '';
            return (
              <g key={node.id} data-node={node.id} transform={`translate(${at.x},${at.y})`} opacity={dim ? 0.25 : 1} style={{ cursor: 'pointer' }}
                onClick={() => onSelect(node.id)} onDoubleClick={() => onOpen?.(node.id)}>
                <title>{`${node.id} — ${node.title}\n${node.type}, ${node.status}${node.origin === 'library' ? `, library result (${node.collection ?? ''}): known, not proved here` : ''}${node.flags.length ? `\n${node.flags.map((flag) => FLAG_META[flag].label).join('\n')}` : ''}${node.sections.length ? `\nIn sections: ${node.sections.join(', ')}` : ''}`}</title>
                <rect width={NODE_W} height={NODE_H} rx={6} fill={COLOR.card} stroke={selected ? COLOR.active : color} strokeWidth={selected ? 2.5 : node.required ? 2 : 1.2}
                  strokeDasharray={node.origin === 'library' ? '1 3' : node.kind === 'definition' ? '4 2' : undefined} />
                <rect width={5} height={NODE_H} rx={2} fill={statusColor(node.status)} />
                <text x={12} y={17} fontSize={12} fontWeight={700} fill="var(--vscode-foreground)">{clip(node.id, 22)}{node.required ? ' ★' : ''}{node.origin === 'library' ? <tspan fontWeight={400} fill={COLOR.muted}> · library</tspan> : null}</text>
                <text x={NODE_W - 8} y={17} fontSize={12} textAnchor="end">
                  {node.flags.map((flag) => <tspan key={flag} fill={FLAG_META[flag].color}>{FLAG_META[flag].symbol}</tspan>)}
                </text>
                {detailed && <text x={12} y={33} fontSize={11} fill="var(--vscode-foreground)" opacity={0.85}>{clip(node.title, 30)}</text>}
                {detailed && (chips || counts) && <text x={12} y={48} fontSize={10} fill={COLOR.muted}>{clip([counts, chips].filter(Boolean).join(' · '), 36)}</text>}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export const miniButton: React.CSSProperties = {
  padding: '2px 8px', fontSize: 12, border: '1px solid var(--vscode-panel-border)', borderRadius: 3, cursor: 'pointer',
  background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
};
