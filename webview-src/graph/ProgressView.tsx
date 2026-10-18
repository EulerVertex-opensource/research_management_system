import React, { useEffect, useMemo, useState } from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { PROGRESS_LEGEND } from '../../src/domain/copy';
import { AttentionFilter, GraphMode, MAX_VISIBLE, ViewOptions, adjacency, blockingStates, defaultGoal, goalGraph, needsGraph, reach, visibleGraph } from './graphModel';
import { GraphCanvas } from './GraphCanvas';
import { buttonStyle } from './AttentionList';
import { ResultCard } from './ResultCard';
import { ResultList } from './ResultList';
import { CITED_COLOR, COLOR, DEFINITION_COLOR, PROGRESS_STYLE, nodeStyle, tint } from './colors';

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
  { value: 'awaiting_approval', label: 'Waiting for your review' },
  { value: 'parked', label: 'Set aside' },
  { value: 'active', label: 'Agent working on it' },
  { value: 'draft', label: 'Not done yet' },
  { value: 'approved', label: 'Done' },
  { value: 'manuscript_stale', label: 'Out of date in the paper' },
  { value: 'uncovered', label: 'Not in the paper yet' },
];

const MODES: { id: GraphMode; label: string; hint: string }[] = [
  { id: 'goal', label: 'Why isn’t it done?', hint: 'What one main result rests on; finished branches are folded' },
  { id: 'needs', label: 'Only what needs me', hint: 'Results that need you or are stuck, and the main results they hold up' },
  { id: 'all', label: 'Everything', hint: 'Every result, with search and filters' },
];

export const inputStyle: React.CSSProperties = { padding: '3px 6px', fontSize: 12, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))', borderRadius: 2 };

export function Toggle({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (value: boolean) => void; title?: string }) {
  return <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }} title={title}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function Legend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '7px 14px', borderTop: `1px solid ${COLOR.border}`, fontSize: 11, color: COLOR.muted, alignItems: 'center' }}>
      {PROGRESS_LEGEND.map(({ state, label }) => (
        <span key={state} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, boxSizing: 'border-box', background: tint(PROGRESS_STYLE[state].color, 14), border: `1.5px ${PROGRESS_STYLE[state].dashed ? 'dashed' : 'solid'} ${PROGRESS_STYLE[state].color}` }} />{label}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 11, height: 11, borderRadius: 3, boxSizing: 'border-box', background: tint(DEFINITION_COLOR, 14), border: `1.5px solid ${DEFINITION_COLOR}` }} />Definition</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 11, height: 11, borderRadius: 3, boxSizing: 'border-box', background: tint(CITED_COLOR, 14), border: `1.5px solid ${CITED_COLOR}` }} />Cited from a paper or the library</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 20, height: 3, background: COLOR.error }} />Thick line: what holds it up</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 18, height: 9, borderRadius: 3, background: tint(COLOR.approved, 12), border: `1px solid ${tint(COLOR.approved, 55)}` }} />Finished branch, folded</span>
      <span>Prerequisites above, main results below</span>
    </div>
  );
}

export function ProgressView({ payload, options, onOptions, selectedId, onSelect, onImpact, onNavigate, onAction }: Props) {
  const [ignoreCap, setIgnoreCap] = useState(false);
  const set = (patch: Partial<ViewOptions>) => onOptions({ ...options, ...patch });
  const goals = payload.required.filter((id) => payload.nodes.some((node) => node.id === id));
  const unfinished = goals.filter((id) => payload.nodes.find((node) => node.id === id)?.progress !== 'done');
  // With every main result done, one folded tree says little: start from everything instead.
  const chosen: GraphMode = options.mode ?? (unfinished.length ? 'goal' : 'all');
  const mode: GraphMode = chosen === 'goal' && !goals.length ? 'all' : chosen;
  const goal = options.goal && goals.includes(options.goal) ? options.goal : defaultGoal(payload);
  const list = options.display === 'list';
  const blocking = useMemo(() => blockingStates(payload), [payload]);
  const focused = useMemo(() => {
    if (mode === 'goal' && goal) return { ...goalGraph(payload, goal), overCap: false, hidden: 0, reduced: 0 };
    if (mode === 'needs') return { ...needsGraph(payload), overCap: false, hidden: 0, reduced: 0 };
    // A list stays readable with many results; only the graph has a size cap.
    return { ...visibleGraph(payload, options, ignoreCap || list), folds: [] };
  }, [payload, mode, goal, options, ignoreCap, list]);
  const selected = payload.nodes.find((node) => node.id === selectedId);

  // "Show on graph" from elsewhere: bring the node into view.
  useEffect(() => {
    if (!selectedId || focused.nodes.some((node) => node.id === selectedId) || focused.folds.some((fold) => fold.members.includes(selectedId))) return;
    const node = payload.nodes.find((item) => item.id === selectedId);
    if (!node) return;
    const target = node.blocks.find((id) => goals.includes(id));
    if (target && node.progress !== 'done') onOptions({ ...options, mode: 'goal', goal: target });
    else onOptions({ ...options, mode: 'all', scope: 'all', filter: 'all', search: '', focus: undefined });
  }, [selectedId]);

  const highlight = useMemo(() => {
    if (!selectedId || options.focus) return undefined;
    const { deps, dependants } = adjacency(focused.edges);
    return new Set([...reach([selectedId], deps, 1), ...reach([selectedId], dependants, 1)]);
  }, [selectedId, focused.edges, options.focus]);

  /** Blocked main results first, then unfinished, then done. */
  const goalRank = (id: string) => { const tone = blocking.get(id); return tone === 'stuck' ? 0 : tone === 'needs_you' ? 1 : unfinished.includes(id) ? 2 : 3; };
  const goalMark = (id: string) => ['✕', '!', '•', '✓'][goalRank(id)];
  /** A neighborhood narrows only the "Everything" view. */
  const focusActive = mode === 'all' && Boolean(options.focus && payload.nodes.some((node) => node.id === options.focus!.id));
  const showIn = (display: ViewOptions['display'], id: string) => { onOptions({ ...options, display }); onSelect(id); };
  const caption = mode === 'goal' && goal
    ? `What ${payload.nodes.find((node) => node.id === goal)?.title ?? goal} rests on, ${list ? 'prerequisites first' : 'prerequisites above'}. Finished branches are folded${list ? '.' : '; thick lines lead from what is blocked to what it holds up.'}`
    : mode === 'needs' ? 'Only the results that need you or are stuck, and the main results they hold up.'
    : `${focused.nodes.length} shown · ${focused.hidden} hidden by the filters.`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: '6px 10px', alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px', borderBottom: `1px solid ${COLOR.border}`, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {mode === 'goal' && goals.length > 3 && (
            // Many main results: one compact picker, so the toolbar never pushes the results out of view.
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
              <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>Main result</span>
              <select value={goal} onChange={(event) => set({ goal: event.target.value })} style={{ ...inputStyle, maxWidth: 460, minWidth: 0 }}>
                {[...goals].sort((a, b) => goalRank(a) - goalRank(b)).map((id) => {
                  const node = payload.nodes.find((item) => item.id === id)!;
                  return <option key={id} value={id}>{goalMark(id)} {node.title}{node.closure ? ` (${node.closure.done}/${node.closure.total} done)` : ''}</option>;
                })}
              </select>
              <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>{goals.length - unfinished.length} of {goals.length} done</span>
            </label>
          )}
          {mode === 'goal' && goals.length > 0 && goals.length <= 3 && <>
            <span style={{ fontSize: 12, color: COLOR.muted }}>Main results</span>
            {goals.map((id) => {
              const node = payload.nodes.find((item) => item.id === id)!;
              const active = id === goal;
              const tone = blocking.get(id);
              const dot = tone === 'stuck' ? COLOR.error : tone === 'needs_you' ? COLOR.waiting : nodeStyle(node).color;
              return (
                <button key={id} aria-pressed={active} onClick={() => set({ goal: id })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', fontSize: 12, borderRadius: 4, cursor: 'pointer', color: 'var(--vscode-foreground)', background: active ? 'var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.25))' : 'transparent', border: `1px solid ${active ? 'var(--vscode-focusBorder)' : COLOR.border}` }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: dot }} />
                  <span style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>★ {node.title}</span>
                  {node.closure && <span style={{ color: COLOR.muted }}>{node.closure.done}/{node.closure.total} done</span>}
                </button>
              );
            })}
          </>}
          {mode === 'all' && <>
            <input placeholder="Search title or ID" aria-label="Search title or ID" value={options.search} onChange={(event) => set({ search: event.target.value })} style={{ ...inputStyle, width: 150 }} />
            <select aria-label="State" value={options.filter} onChange={(event) => set({ filter: event.target.value as AttentionFilter })} style={inputStyle}>
              {FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
            </select>
            <select aria-label="Scope" value={options.scope} onChange={(event) => set({ scope: event.target.value as ViewOptions['scope'] })} style={inputStyle}>
              <option value="required">Only what the main results need</option>
              <option value="all">All results</option>
            </select>
            <Toggle label="Definitions" checked={options.showDefinitions} onChange={(value) => set({ showDefinitions: value })} title="Draw definitions as nodes" />
            <Toggle label="Retired" checked={options.showInactive} onChange={(value) => set({ showInactive: value })} title="Show deprecated and archived results" />
          </>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="group" aria-label="Show as" style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }}>
          {(['list', 'graph'] as const).map((display) => (
            <button key={display} aria-pressed={options.display === display} onClick={() => set({ display })} title={display === 'list' ? 'Results in order, prerequisites first' : 'Results as a graph, prerequisites above'}
              style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: options.display === display ? 'var(--vscode-button-background)' : 'transparent', color: options.display === display ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>
              {display === 'list' ? 'List' : 'Graph'}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Which results" style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }}>
          {MODES.map((item) => (
            <button key={item.id} aria-pressed={mode === item.id} title={item.hint} onClick={() => set({ mode: item.id, focus: undefined })}
              style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: mode === item.id ? 'var(--vscode-button-background)' : 'transparent', color: mode === item.id ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>
              {item.label}
            </button>
          ))}
        </div>
        </div>
      </div>
      {focusActive && options.focus && (
        // Showing a neighborhood is a temporary narrowing: say so plainly, with the way back right next to it.
        <div role="status" style={{ margin: '8px 12px 0', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--vscode-focusBorder)', background: tint(COLOR.active, 10), display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span>Showing only the results around <b>{payload.nodes.find((node) => node.id === options.focus!.id)?.title ?? options.focus.id}</b>, up to</span>
          <select aria-label="Steps away" value={options.focus.depth} onChange={(event) => set({ focus: { ...options.focus!, depth: Number(event.target.value) } })} style={inputStyle}>
            {[1, 2, 3, 5].map((depth) => <option key={depth} value={depth}>{depth} step{depth > 1 ? 's' : ''} away</option>)}
          </select>
          <button style={{ ...buttonStyle('primary'), marginLeft: 'auto' }} onClick={() => set({ focus: undefined })}>Show everything</button>
        </div>
      )}
      <div style={{ padding: '5px 14px 0', fontSize: 11.5, color: COLOR.muted }}>{caption} {list ? 'Click a result to open it.' : 'Click a result to open its card.'}</div>
      <div style={{ flex: 1, minHeight: 260 }}>
        {focused.overCap ? (
          <div style={{ padding: 24, fontSize: 13 }}>
            More than {MAX_VISIBLE} results match. Narrow it with the search or a state filter, or pick one result and show only its neighbors.
            <div style={{ marginTop: 10 }}><button style={buttonStyle('secondary')} onClick={() => setIgnoreCap(true)}>Draw them anyway</button></div>
          </div>
        ) : focused.nodes.length && list ? (
          <ResultList graph={focused} payload={payload} selectedId={selectedId} onSelect={onSelect} onAction={onAction} onDetails={onNavigate} onShowInGraph={(id) => showIn('graph', id)} />
        ) : focused.nodes.length ? (
          <GraphCanvas nodes={focused.nodes} edges={focused.edges} folds={focused.folds} required={payload.required} blocking={blocking} selectedId={selectedId} highlight={highlight}
            onSelect={(id) => onSelect(id === selectedId ? undefined : id)} onBackground={() => onSelect(undefined)}
            renderCard={(id) => {
              const node = payload.nodes.find((item) => item.id === id);
              return node ? <ResultCard node={node} payload={payload} expanded onToggle={() => undefined} onAction={onAction} onDetails={onNavigate}
                elsewhere={{ label: 'Show in list', onClick: () => showIn('list', id) }} onClose={() => onSelect(undefined)} /> : null;
            }} />
        ) : (
          <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>
            {mode === 'needs' ? 'Nothing needs you and nothing is stuck.' : payload.required.length ? 'Nothing matches these filters.' : 'No main results yet: list them in project.md to see what they rest on, or choose "All results".'}
          </div>
        )}
      </div>
      {!list && <Legend />}
      {!list && mode === 'all' && (selected || focusActive) && (
        <div style={{ borderTop: `1px solid ${COLOR.border}`, padding: '6px 14px', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
          {selected && <>
            <span style={{ color: COLOR.muted }}>{selected.title}:</span>
            {options.focus?.id !== selected.id && <button style={buttonStyle('secondary')} onClick={() => set({ focus: { id: selected.id, depth: options.focus?.depth ?? 1 } })}>Only its neighbors</button>}
            <button style={buttonStyle('secondary')} onClick={() => onImpact(selected.id)}>What depends on this?</button>
          </>}
          {focusActive && <button style={{ ...buttonStyle('primary'), marginLeft: 'auto' }} onClick={() => set({ focus: undefined })}>Show everything</button>}
        </div>
      )}
    </div>
  );
}
