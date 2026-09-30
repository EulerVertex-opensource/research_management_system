import React, { useMemo, useState } from 'react';
import type { GraphAction, GraphNodeView, GraphPayload } from '../../src/models/graph';
import { AttentionFilter, MAX_VISIBLE, ViewOptions, adjacency, reach, visibleGraph } from './graphModel';
import { GraphCanvas } from './GraphCanvas';
import { COLOR, FLAG_META } from './colors';
import { buttonStyle } from './AttentionList';

interface Props {
  payload: GraphPayload;
  options: ViewOptions;
  onOptions: (options: ViewOptions) => void;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onImpact: (id: string) => void;
  onNavigate: (id: string) => void;
  onAction: (action: GraphAction) => void;
}

const FILTERS: { value: AttentionFilter; label: string }[] = [
  { value: 'all', label: 'All states' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'awaiting_approval', label: 'Waiting for approval' },
  { value: 'parked', label: 'Parked' },
  { value: 'active', label: 'Loop working on' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'manuscript_stale', label: 'Stale in manuscript' },
  { value: 'uncovered', label: 'Not in manuscript' },
];

export const inputStyle: React.CSSProperties = { padding: '3px 6px', fontSize: 12, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))', borderRadius: 2 };

export function Toggle({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (value: boolean) => void; title?: string }) {
  return <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }} title={title}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function Detail({ node, payload, onImpact, onNavigate, onAction, onFocus, focused }: { node: GraphNodeView; payload: GraphPayload; onImpact: (id: string) => void; onNavigate: (id: string) => void; onAction: (action: GraphAction) => void; onFocus: () => void; focused: boolean }) {
  const parked = node.flags.includes('parked');
  const loopRunning = payload.loop?.status === 'running' || payload.loop?.status === 'paused';
  return (
    <div style={{ width: 280, flexShrink: 0, borderLeft: `1px solid ${COLOR.border}`, padding: 12, overflow: 'auto', fontSize: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{node.id}{node.required ? ' ★' : ''}</div>
      <div style={{ marginTop: 2 }}>{node.title}</div>
      <div style={{ color: COLOR.muted, marginTop: 4 }}>{node.type} · {node.status}</div>
      {node.flags.length > 0 && <ul style={{ margin: '8px 0', paddingLeft: 16 }}>{node.flags.map((flag) => <li key={flag} style={{ color: FLAG_META[flag].color }}>{FLAG_META[flag].label}</li>)}</ul>}
      {node.blocks.length > 0 && <div style={{ marginTop: 6 }}><b>Serves:</b> {node.blocks.join(', ')}</div>}
      {node.definitions.length > 0 && <div style={{ marginTop: 6 }}><b>Uses definitions:</b> {node.definitions.join(', ')}</div>}
      <div style={{ marginTop: 6 }}><b>Attempts:</b> {node.counts.plans} ({node.counts.failedPlans} failed, {node.counts.pendingPlans} pending) · <b>Ideas:</b> {node.counts.ideas}</div>
      <div style={{ marginTop: 6 }}><b>In manuscript:</b> {node.sections.length ? node.sections.join(', ') : 'nowhere'}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <button style={buttonStyle('primary')} onClick={() => onImpact(node.id)}>Show impact</button>
        <button style={buttonStyle('secondary')} onClick={onFocus}>{focused ? 'Show whole scope' : 'Focus on neighbors'}</button>
        <button style={buttonStyle('secondary')} onClick={() => onNavigate(node.id)}>Edit in dashboard</button>
        <button style={buttonStyle('secondary')} onClick={() => onAction({ action: 'openNode', id: node.id })}>Open file</button>
        {loopRunning && node.kind === 'asset' && (parked
          ? <button style={buttonStyle('secondary')} onClick={() => onAction({ action: 'unpark', assetId: node.id })}>Unpark</button>
          : node.status === 'draft' && <button style={buttonStyle('secondary')} onClick={() => onAction({ action: 'park', assetId: node.id })} title="The loop skips it until you unpark it">Park</button>)}
        {node.status === 'draft' && node.kind === 'asset' && (
          <button style={buttonStyle('secondary')} title="Copies an instruction and opens the agent chat"
            onClick={() => onAction({ action: 'agent', prompt: `Work on ${node.id} next in the research loop: falsify it if it has not been checked, otherwise plan and prove it. Read only its context; do not change its statement without asking me.` })}>
            Work on it in chat ↗
          </button>
        )}
      </div>
    </div>
  );
}

export function ProgressView({ payload, options, onOptions, selectedId, onSelect, onImpact, onNavigate, onAction }: Props) {
  const [ignoreCap, setIgnoreCap] = useState(false);
  const visible = useMemo(() => visibleGraph(payload, options, ignoreCap), [payload, options, ignoreCap]);
  const selected = payload.nodes.find((node) => node.id === selectedId);
  const highlight = useMemo(() => {
    if (!selectedId || options.focus) return undefined;
    const { deps, dependants } = adjacency(visible.edges);
    return new Set([...reach([selectedId], deps, 1), ...reach([selectedId], dependants, 1)]);
  }, [selectedId, visible.edges, options.focus]);
  const set = (patch: Partial<ViewOptions>) => onOptions({ ...options, ...patch });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${COLOR.border}`, flexWrap: 'wrap' }}>
        <input placeholder="Search ID or title" value={options.search} onChange={(event) => set({ search: event.target.value })} style={{ ...inputStyle, width: 160 }} />
        <select value={options.filter} onChange={(event) => set({ filter: event.target.value as AttentionFilter })} style={inputStyle}>
          {FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
        </select>
        <select value={options.scope} onChange={(event) => set({ scope: event.target.value as ViewOptions['scope'] })} style={inputStyle} title="Required scope: only what the required results depend on">
          <option value="required">Required results' scope</option>
          <option value="all">All results</option>
        </select>
        <Toggle label="Definitions" checked={options.showDefinitions} onChange={(value) => set({ showDefinitions: value })} title="Draw definitions as nodes instead of chips" />
        <Toggle label="Archived" checked={options.showInactive} onChange={(value) => set({ showInactive: value })} />
        {options.focus && (
          <span style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
            Focus {options.focus.id}, depth
            <select value={options.focus.depth} onChange={(event) => set({ focus: { ...options.focus!, depth: Number(event.target.value) } })} style={inputStyle}>
              {[1, 2, 3, 5].map((depth) => <option key={depth} value={depth}>{depth}</option>)}
            </select>
            <button style={buttonStyle('secondary')} onClick={() => set({ focus: undefined })}>Clear</button>
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: COLOR.muted }}>
          {visible.nodes.length} shown · {visible.hidden} hidden{visible.reduced ? ` · ${visible.reduced} implied edges omitted` : ''}
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {visible.overCap ? (
            <div style={{ padding: 24, fontSize: 13 }}>
              More than {MAX_VISIBLE} nodes match. Narrow it with the search, a state filter, or focus on one result (select it in Attention or Coverage).
              <div style={{ marginTop: 10 }}><button style={buttonStyle('secondary')} onClick={() => setIgnoreCap(true)}>Draw them anyway</button></div>
            </div>
          ) : visible.nodes.length ? (
            <GraphCanvas nodes={visible.nodes} edges={visible.edges} required={payload.required} selectedId={selectedId} highlight={highlight}
              onSelect={(id) => onSelect(id === selectedId ? undefined : id)} onOpen={onNavigate} />
          ) : (
            <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>
              {payload.required.length ? 'Nothing matches these filters.' : 'No required results yet: list them in project.md to see their dependency graph, or switch to "All results".'}
            </div>
          )}
        </div>
        {selected && (
          <Detail node={selected} payload={payload} onImpact={onImpact} onNavigate={onNavigate} onAction={onAction}
            focused={options.focus?.id === selected.id}
            onFocus={() => set({ focus: options.focus?.id === selected.id ? undefined : { id: selected.id, depth: 1 } })} />
        )}
      </div>
    </div>
  );
}
