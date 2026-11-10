import React, { useEffect, useMemo, useState } from 'react';
import type { GraphAction, GraphPayload } from '../../src/models/graph';
import { PROGRESS_LEGEND } from '../../src/domain/copy';
import { AttentionFilter, GraphMode, MAX_VISIBLE, ViewOptions, adjacency, blockingStates, defaultGoal, goalGraph, impactOf, needsGraph, reach, traceGraph, visibleGraph } from './graphModel';
import { GraphCanvas } from './GraphCanvas';
import { buttonStyle } from './AttentionList';
import { ResultCard } from './ResultCard';
import { ResultList } from './ResultList';
import { RouteLegend, RouteList, RouteMap, routedResults, routesSummary, routesTo } from './RoutesView';
import { CITED_COLOR, COLOR, DEFINITION_COLOR, PROGRESS_STYLE, SECTION_STATE_COLOR, SECTION_STATE_LABEL, nodeStyle, tint } from './colors';

interface Props {
  payload: GraphPayload;
  options: ViewOptions;
  onOptions: (options: ViewOptions) => void;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
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
  { id: 'goal', label: 'Still to do', hint: 'What one main result still needs; finished branches are folded' },
  { id: 'needs', label: 'Held up', hint: 'Results that are stuck or wait for you, and the main results they hold up' },
  { id: 'all', label: 'Everything', hint: 'Every result, with search and filters' },
  { id: 'routes', label: 'Routes', hint: 'The routes to one result, side by side: the first one complete proves it' },
];

const DISPLAYS: { id: ViewOptions['display']; label: string; hint: string }[] = [
  { id: 'list', label: '☰ List', hint: 'Results in reading order, prerequisites first' },
  { id: 'graph', label: '◇ Graph', hint: 'Results as a graph, prerequisites above' },
];

function segment(active: boolean, large = false): React.CSSProperties {
  return {
    padding: large ? '4px 14px' : '3px 10px', fontSize: large ? 13 : 12, border: 'none', cursor: 'pointer',
    background: active ? COLOR.solid : COLOR.card, color: active ? '#ffffff' : 'var(--vscode-foreground)',
  };
}

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

export function ProgressView({ payload, options, onOptions, selectedId, onSelect, onNavigate, onAction }: Props) {
  const [ignoreCap, setIgnoreCap] = useState(false);
  const set = (patch: Partial<ViewOptions>) => onOptions({ ...options, ...patch });
  const goals = payload.required.filter((id) => payload.nodes.some((node) => node.id === id));
  const unfinished = goals.filter((id) => payload.nodes.find((node) => node.id === id)?.progress !== 'done');
  // With every main result done, one folded tree says little: start from everything instead.
  const chosen: GraphMode = options.mode ?? (unfinished.length ? 'goal' : 'all');
  const routed = routedResults(payload);
  const mode: GraphMode = chosen === 'goal' && !goals.length ? 'all' : chosen;
  // The routes view shows one result with routes: the one asked for, else the loop's current one, else the first.
  const routeTarget = options.goal && routed.includes(options.goal) ? options.goal : payload.loop?.assetId && routed.includes(payload.loop.assetId) ? payload.loop.assetId : routed[0];
  const goal = options.goal && goals.includes(options.goal) ? options.goal : defaultGoal(payload);
  const list = options.display === 'list';
  const trace = options.trace && payload.nodes.some((node) => node.id === options.trace!.id) ? options.trace : undefined;
  const traced = trace ? payload.nodes.find((node) => node.id === trace.id) : undefined;
  const blocking = useMemo(() => blockingStates(payload), [payload]);
  const focused = useMemo(() => {
    if (trace) return { ...traceGraph(payload, trace.id, trace.direction), overCap: false, hidden: 0, reduced: 0 };
    if (mode === 'goal' && goal) return { ...goalGraph(payload, goal), overCap: false, hidden: 0, reduced: 0 };
    if (mode === 'needs') return { ...needsGraph(payload), overCap: false, hidden: 0, reduced: 0 };
    if (mode === 'routes') return { nodes: [], edges: [], folds: [], overCap: false, hidden: 0, reduced: 0 };
    // A list stays readable with many results; only the graph has a size cap.
    return { ...visibleGraph(payload, { ...options, focus: undefined }, ignoreCap || list), folds: [] };
  }, [payload, mode, goal, options, ignoreCap, list, trace]);
  const impact = useMemo(() => (trace?.direction === 'down' ? impactOf(payload, trace.id) : undefined), [payload, trace]);
  const selected = payload.nodes.find((node) => node.id === selectedId);

  // "Show in Results" from elsewhere: bring the node into view.
  useEffect(() => {
    if (!selectedId || focused.nodes.some((node) => node.id === selectedId) || focused.folds.some((fold) => fold.members.includes(selectedId))) return;
    const node = payload.nodes.find((item) => item.id === selectedId);
    if (!node) return;
    const target = node.blocks.find((id) => goals.includes(id));
    if (target && node.progress !== 'done') onOptions({ ...options, trace: undefined, mode: 'goal', goal: target });
    else onOptions({ ...options, trace: undefined, mode: 'all', scope: 'all', filter: 'all', search: '' });
  }, [selectedId]);

  const highlight = useMemo(() => {
    if (!selectedId || trace) return undefined;
    const { deps, dependants } = adjacency(focused.edges);
    return new Set([...reach([selectedId], deps, 1), ...reach([selectedId], dependants, 1)]);
  }, [selectedId, focused.edges, trace]);

  /** Blocked main results first, then unfinished, then done. */
  const goalRank = (id: string) => { const tone = blocking.get(id); return tone === 'stuck' ? 0 : tone === 'needs_you' ? 1 : unfinished.includes(id) ? 2 : 3; };
  const goalMark = (id: string) => ['✕', '!', '•', '✓'][goalRank(id)];
  const caption = trace ? ''
    : mode === 'goal' && goal ? `What ${payload.nodes.find((node) => node.id === goal)?.title ?? goal} still needs, ${list ? 'prerequisites first' : 'prerequisites above'}. Finished branches are folded.`
    : mode === 'needs' ? 'Results that are stuck or wait for you, and the main results they hold up.'
    : mode === 'routes' ? (routeTarget ? `${routesSummary(routesTo(payload, routeTarget))}. Each route proves the result from its lemmas; the first one complete wins.` : '')
    : `${focused.nodes.length} shown · ${focused.hidden} hidden by the filters.`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: COLOR.canvas }}>
      <div style={{ display: 'flex', gap: '6px 10px', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${COLOR.border}`, flexWrap: 'wrap', background: COLOR.card }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <h2 style={{ margin: '0 8px 0 0', fontSize: 15, fontWeight: 600 }}>Results</h2>
          {!trace && <div role="group" aria-label="Which results" style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden' }}>
            {MODES.map((item) => (
              <button key={item.id} aria-pressed={mode === item.id} title={item.hint} onClick={() => set({ mode: item.id })} style={segment(mode === item.id)}>{item.label}</button>
            ))}
          </div>}
          {!trace && mode === 'goal' && goals.length > 0 && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
              <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>Main result</span>
              <select value={goal} onChange={(event) => set({ goal: event.target.value })} style={{ ...inputStyle, maxWidth: 420, minWidth: 0 }}>
                {[...goals].sort((a, b) => goalRank(a) - goalRank(b)).map((id) => {
                  const node = payload.nodes.find((item) => item.id === id)!;
                  return <option key={id} value={id}>{goalMark(id)} {node.title}{node.closure ? ` (${node.closure.done}/${node.closure.total} done)` : ''}</option>;
                })}
              </select>
              <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>{goals.length - unfinished.length} of {goals.length} done</span>
            </label>
          )}
          {!trace && mode === 'routes' && routed.length > 0 && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
              <span style={{ color: COLOR.muted, whiteSpace: 'nowrap' }}>Routes to</span>
              <select value={routeTarget} onChange={(event) => set({ goal: event.target.value })} style={{ ...inputStyle, maxWidth: 420, minWidth: 0 }}>
                {routed.map((id) => <option key={id} value={id}>{payload.required.includes(id) ? '★ ' : ''}{payload.nodes.find((item) => item.id === id)?.title ?? id} ({routesSummary(routesTo(payload, id))})</option>)}
              </select>
            </label>
          )}
          {!trace && mode === 'all' && <>
            <input placeholder="Search" aria-label="Search title or ID" value={options.search} onChange={(event) => set({ search: event.target.value })} style={{ ...inputStyle, width: 150 }} />
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
        <div role="group" aria-label="Show as" style={{ display: 'flex', border: `1px solid ${COLOR.border}`, borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
          {DISPLAYS.map((item) => (
            <button key={item.id} aria-pressed={options.display === item.id} title={item.hint} onClick={() => set({ display: item.id })} style={segment(options.display === item.id, true)}>{item.label}</button>
          ))}
        </div>
      </div>
      {trace && traced && (
        // Tracing is a temporary narrowing: say so plainly, with the way back right next to it.
        <div role="status" style={{ margin: '8px 12px 0', padding: '6px 10px', borderRadius: 6, border: `1px solid ${tint(COLOR.active, 60)}`, background: tint(COLOR.active, 10), display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span>{trace.direction === 'up'
            ? <>Showing only what <b>{traced.title}</b> rests on ({focused.nodes.length - 1} {focused.nodes.length === 2 ? 'result' : 'results'}).</>
            : <>Showing only what rests on <b>{traced.title}</b>: {focused.nodes.length - 1} {focused.nodes.length === 2 ? 'result' : 'results'}{impact?.sections.length ? ` and ${impact.sections.length} ${impact.sections.length === 1 ? 'section' : 'sections'} of the paper` : ''} would need a new look if it changed.</>}</span>
          <button style={{ ...buttonStyle('primary'), marginLeft: 'auto' }} onClick={() => set({ trace: undefined })}>Show everything</button>
        </div>
      )}
      {caption && <div style={{ padding: '5px 14px 0', fontSize: 11.5, color: COLOR.muted }}>{caption} Click a result to see it on the right.</div>}
      <div style={{ flex: 1, minHeight: 260, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {mode === 'routes' && !trace ? (
            routeTarget
              ? (list
                ? <RouteList payload={payload} target={routeTarget} onSelect={(id) => onSelect(id === selectedId ? undefined : id)} onAction={onAction} />
                : <RouteMap payload={payload} target={routeTarget} selectedId={selectedId} onSelect={onSelect} />)
              : <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>No result has routes yet. With routes on (Settings → Parallel routes), a main result not yet attempted gets several routes planned side by side.</div>
          ) : focused.overCap ? (
            <div style={{ padding: 24, fontSize: 13 }}>
              More than {MAX_VISIBLE} results match. Narrow it with the search or a state filter, or switch to the list.
              <div style={{ marginTop: 10 }}><button style={buttonStyle('secondary')} onClick={() => setIgnoreCap(true)}>Draw them anyway</button></div>
            </div>
          ) : focused.nodes.length && list ? (
            <ResultList graph={focused} payload={payload} selectedId={selectedId} onSelect={onSelect} onAction={onAction} onDetails={onNavigate} />
          ) : focused.nodes.length ? (
            <GraphCanvas nodes={focused.nodes} edges={focused.edges} folds={focused.folds} required={payload.required} blocking={blocking} selectedId={selectedId}
              highlight={trace ? new Set([trace.id]) : highlight}
              onSelect={(id) => onSelect(id === selectedId ? undefined : id)} onBackground={() => onSelect(undefined)} />
          ) : (
            <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>
              {mode === 'needs' ? 'Nothing is stuck and nothing waits for you.' : payload.required.length ? 'Nothing matches these filters.' : 'No main results yet: list them in project.md to see what they rest on, or choose "Everything".'}
            </div>
          )}
        </div>
        {selected && (
          <aside aria-label="Selected result" style={{ width: 360, flexShrink: 0, borderLeft: `1px solid ${COLOR.border}`, background: COLOR.sunken, overflow: 'auto', padding: 10, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ResultCard node={selected} payload={payload} expanded onToggle={() => undefined} onAction={onAction} onDetails={onNavigate}
              onTrace={(direction) => set({ trace: { id: selected.id, direction } })} onClose={() => onSelect(undefined)}
              onShowRoutes={mode === 'routes' && routeTarget === selected.id ? undefined : (id) => set({ mode: 'routes', goal: id, trace: undefined })} />
            {impact && trace?.id === selected.id && <PaperPassages impact={impact} onAction={onAction} />}
          </aside>
        )}
      </div>
      {!list && (mode === 'routes' && !trace ? <RouteLegend /> : <Legend />)}
    </div>
  );
}

/** The parts of the paper that present a result or what rests on it, each a link into the TeX. */
function PaperPassages({ impact, onAction }: { impact: ReturnType<typeof impactOf>; onAction: (action: GraphAction) => void }) {
  return (
    <section style={{ fontSize: 12 }}>
      <b>In the paper</b>
      {impact.sections.length ? (
        <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
          {impact.sections.map(({ section, blocks }) => (
            <li key={section.id} style={{ marginBottom: 4 }}>
              <a href="#" onClick={(event) => { event.preventDefault(); onAction({ action: 'openTex', section: section.id }); }} style={{ color: SECTION_STATE_COLOR[section.state] }}>{section.title}</a>
              <span style={{ color: COLOR.muted }}> ({SECTION_STATE_LABEL[section.state] ?? section.state})</span>
              {blocks.some((block) => block.lines) && (
                <span style={{ color: COLOR.muted }}> · {blocks.filter((block) => block.lines).map((block, index) => (
                  <a key={block.id} href="#" onClick={(event) => { event.preventDefault(); onAction({ action: 'openTex', section: section.id, line: block.lines![0] }); }} style={{ color: COLOR.link, marginLeft: index ? 6 : 0 }}>lines {block.lines![0]}–{block.lines![1]}</a>
                ))}</span>
              )}
            </li>
          ))}
        </ul>
      ) : <div style={{ color: COLOR.muted, marginTop: 4 }}>No section of the paper presents it or what rests on it.</div>}
    </section>
  );
}
