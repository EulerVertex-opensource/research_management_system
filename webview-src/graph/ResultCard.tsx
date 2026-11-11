import React from 'react';
import type { GraphAction, GraphNodeView, GraphPayload } from '../../src/models/graph';
import { isPrerequisiteEdge } from '../../src/models/graph';
import { KEEP_TRYING_HINT, isProvable as isProvableType, keepTryingLabel, kindLabel } from '../../src/domain/copy';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { ActionRow, buttonStyle } from './AttentionList';
import { useTechnical } from '../technical';
import { COLOR, CITED_COLOR, DEFINITION_COLOR, nodeStyle, tint } from './colors';
import { LEVEL_HINT, LEVEL_LABEL, STATE_LABEL, UNDERSTANDING_LEVELS } from '../../src/domain/understandingLevels';
import { RepairSection } from './ProofDiff';
import { RouteRow, isOpen, routesSummary, routesTo, sharedLemmas } from './RoutesView';

/**
 * One result as a box: its state, title and one line of detail; opened, it
 * shows the statement, what it holds up, what the researcher can do, and two
 * ways on (the other view of the graph, and the result's own page). The list
 * and the graph both use it, so a result looks the same in either.
 */

interface Props {
  node: GraphNodeView;
  payload: GraphPayload;
  expanded: boolean;
  /** Shown in the panel next to the list. */
  selected?: boolean;
  onToggle: () => void;
  onAction: (action: GraphAction) => void;
  /** The result's page in the dashboard. */
  onDetails: (id: string) => void;
  /** A way to the result somewhere else, e.g. "Show in Results" from the Needs you page. */
  elsewhere?: { label: string; onClick: () => void };
  /** "What it rests on" and "What rests on it": narrow the Results view to that part of the research. */
  onTrace?: (direction: 'up' | 'down') => void;
  /** The graph's floating card: no collapsed state, a close button instead. */
  onClose?: () => void;
  /** Show the routes to this result in the Results view's Routes mode. */
  onShowRoutes?: (id: string) => void;
  innerRef?: React.Ref<HTMLElement>;
}

/** The small colored state label. */
export function StatePill({ node }: { node: GraphNodeView }) {
  const style = nodeStyle(node);
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '0 8px', borderRadius: 9, background: tint(style.color, 30), whiteSpace: 'nowrap' }}>{node.progressLabel}</span>;
}

/** Where the researcher stands on a verified result: new to them, changed, or the level they marked. */
export function UnderstandingPill({ node }: { node: GraphNodeView }) {
  const understanding = node.understanding;
  if (!understanding) return null;
  const behind = understanding.state !== 'understood';
  const text = understanding.state === 'understood' && understanding.level ? `You: ${LEVEL_LABEL[understanding.level].toLowerCase()}` : understanding.state === 'new' ? 'New to you' : 'Changed since you studied it';
  return <span title={STATE_LABEL[understanding.state]} style={{ fontSize: 11, fontWeight: 600, padding: '0 6px', borderRadius: 8, border: `1px solid ${behind ? COLOR.waiting : COLOR.border}`, color: behind ? COLOR.waiting : COLOR.muted, whiteSpace: 'nowrap' }}>{text}</span>;
}

/** The researcher's own mark for a verified result, and a way to have it explained in a teaching chat. */
function UnderstandingRow({ node, onAction }: { node: GraphNodeView; onAction: (action: GraphAction) => void }) {
  const understanding = node.understanding;
  if (!understanding) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <label style={{ color: COLOR.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
        What you know of it:
        <select value={understanding.level ?? ''} title="Only you set this; it stays on this computer"
          onChange={(event) => onAction({ action: 'understand', id: node.id, level: (event.target.value || 'none') as typeof UNDERSTANDING_LEVELS[number] | 'none' })}
          style={{ background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)', border: '1px solid var(--vscode-dropdown-border)', fontSize: 12 }}>
          <option value="">{understanding.state === 'statement_changed' ? 'Studied an older version' : 'Not studied yet'}</option>
          {UNDERSTANDING_LEVELS.map((level) => <option key={level} value={level} title={LEVEL_HINT[level]}>{LEVEL_LABEL[level]}{level === understanding.suggested ? ' (suggested)' : ''}</option>)}
        </select>
      </label>
      <button style={buttonStyle('secondary')} title="Copies a teaching prompt and opens the agent chat: start a new chat beside the loop and paste it"
        onClick={() => onAction({ action: 'teach', id: node.id })}>Walk me through it ↗</button>
    </div>
  );
}

/** The box every list in the dashboard uses: a thin border, a slight fill, rounded corners. */
export function boxStyle(color: string = COLOR.border, selected = false): React.CSSProperties {
  return {
    border: `1px solid ${selected ? COLOR.active : color}`, borderRadius: 6, background: COLOR.card,
    boxShadow: selected ? `0 0 0 1px ${COLOR.active}` : undefined,
  };
}

export function ResultCard({ node, payload, expanded, onToggle, onAction, onDetails, elsewhere, onTrace, onClose, onShowRoutes, innerRef, selected = false }: Props) {
  const routes = routesTo(payload, node.id);
  const style = nodeStyle(node);
  const byId = new Map(payload.nodes.map((item) => [item.id, item]));
  const prerequisites = payload.edges.filter((edge) => edge.from === node.id && isPrerequisiteEdge(edge)).map((edge) => byId.get(edge.to)).filter((item): item is GraphNodeView => Boolean(item));
  const holds = node.blocks.filter((id) => id !== node.id).map((id) => byId.get(id)?.title ?? id);
  const item = payload.attention.find((entry) => entry.target === node.id);
  const loopRunning = payload.loop?.status === 'running' || payload.loop?.status === 'paused';
  const parked = node.flags.includes('parked');
  const required = payload.required.includes(node.id);
  const open = expanded || Boolean(onClose);
  const technical = useTechnical();
  return (
    <article ref={innerRef as React.Ref<HTMLElement>} data-result={node.id}
      style={{ ...boxStyle(tint(style.color, 55), selected || (expanded && !onClose)), borderStyle: style.dashed ? 'dashed' : 'solid', background: tint(style.color, node.progress === 'waiting' || node.progress === 'inactive' ? 3 : 8) }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={onClose ? undefined : onToggle}
        onKeyDown={(event) => { if (!onClose && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onToggle(); } }}
        style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3, cursor: onClose ? 'default' : 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatePill node={node} />
          {required && <span style={{ fontSize: 11, fontWeight: 700, color: COLOR.waiting }}>★ Main result</span>}
          {node.kind === 'definition' && <span style={{ fontSize: 11, fontWeight: 700, color: DEFINITION_COLOR, padding: '0 6px', borderRadius: 8, border: `1px solid ${DEFINITION_COLOR}` }}>Definition</span>}
          {node.cited && node.progress !== 'done' && <span style={{ fontSize: 11, fontWeight: 600, color: CITED_COLOR }}>Cited</span>}
          <UnderstandingPill node={node} />
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {onClose
              ? <button onClick={onClose} aria-label="Close" title="Close" style={{ ...buttonStyle('secondary'), padding: '0 7px' }}>×</button>
              : <span aria-hidden="true" style={{ color: COLOR.muted, fontSize: 11 }}>{expanded ? '▾' : selected ? '◂' : '▸'}</span>}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600 }} title={node.id}>{node.title}</div>
        <div style={{ fontSize: 11, color: COLOR.muted, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>{kindLabel(node.type)}{node.origin === 'library' ? ' · known result' : node.cited ? ' · cited' : ''}{technical && <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}> · {node.id}</span>}</span>
          {node.progressDetail && <span style={{ color: node.progress === 'done' || node.progress === 'waiting' ? COLOR.muted : style.color }}>{node.progressDetail}</span>}
          {node.closure && <span>{node.closure.done} of {node.closure.total} parts done</span>}
        </div>
      </div>
      {open && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={{ borderTop: `1px solid ${COLOR.border}`, paddingTop: 8 }}>
            {node.statement
              ? <MarkdownPreview content={node.statement} style={{ fontSize: 13, maxHeight: 280, overflow: 'auto' }} />
              : <div style={{ color: COLOR.muted }}>No statement written yet.</div>}
          </div>
          {(item?.why || item?.ifIgnored) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {item?.why && <div><span style={{ color: COLOR.muted }}>Why it matters: </span>{item.why}</div>}
              {item?.ifIgnored && <div><span style={{ color: COLOR.muted }}>If you do nothing: </span>{item.ifIgnored}</div>}
            </div>
          )}
          <div style={{ color: COLOR.muted, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
            <span>{holds.length ? `Holds up ${holds.length === 1 ? 'the main result' : `${holds.length} main results`}: ${holds.slice(0, 3).join(', ')}${holds.length > 3 ? ` and ${holds.length - 3} more` : ''}` : required ? 'A main result' : 'No main result rests on it'}</span>
            <span>{prerequisites.length ? `Prerequisites: ${prerequisites.filter((entry) => entry.progress === 'done').length} of ${prerequisites.length} done` : 'No prerequisites'}</span>
            {node.counts.plans > 0 && !routes.length && <span>Proof attempts: {node.counts.plans} ({node.counts.failedPlans} failed)</span>}
            {node.counts.remarks > 0 && <span title="Explanations from the teaching chat or the loop; Open shows them">Remarks: {node.counts.remarks}</span>}
            {node.sections.length > 0 && <span>In the paper: {node.sections.join(', ')}</span>}
            {technical && <span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{node.filePath}</span>}
          </div>
          {node.repair && <RepairSection node={node} onAction={onAction} onDetails={onDetails} />}
          {routes.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>Routes</b><span style={{ color: COLOR.muted }}>{routesSummary(routes)}</span>
                {onShowRoutes && <button style={{ ...buttonStyle('secondary'), marginLeft: 'auto', padding: '0 8px' }} onClick={() => onShowRoutes(node.id)}>See them side by side</button>}
              </div>
              {routes.filter((route) => isOpen(route) || route.state === 'won').slice(0, 4).map((route) => (
                <RouteRow key={route.planId} route={route} payload={payload} shared={sharedLemmas(routes.filter(isOpen))} onSelect={onDetails} />
              ))}
            </section>
          )}
          {item && <ActionRow buttons={item.buttons.filter((button) => button.action.action !== 'openNode')} onAction={onAction} onNavigate={onDetails} />}
          <UnderstandingRow node={node} onAction={onAction} />
          {onTrace && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button style={buttonStyle('secondary')} onClick={() => onTrace('up')} title="Show only the results it rests on">What it rests on</button>
              <button style={buttonStyle('secondary')} onClick={() => onTrace('down')} title="Show only the results, and the parts of the paper, that rest on it">What rests on it</button>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {elsewhere && <button style={buttonStyle('primary')} onClick={elsewhere.onClick}>{elsewhere.label}</button>}
            <button style={buttonStyle('secondary')} onClick={() => onDetails(node.id)}>Open</button>
            {loopRunning && node.kind === 'asset' && !item && (parked
              ? <button style={buttonStyle('secondary')} title={KEEP_TRYING_HINT} onClick={() => onAction({ action: 'unpark', assetId: node.id })}>{keepTryingLabel('')}</button>
              : node.status === 'draft' && <button style={buttonStyle('secondary')} onClick={() => onAction({ action: 'park', assetId: node.id })} title="The loop skips it until you bring it back">Set aside</button>)}
            {loopRunning && node.status === 'approved' && node.kind === 'asset' && isProvableType(node.type) && payload.required.some((id) => payload.nodes.find((entry) => entry.id === id)?.progress !== 'done') && (
              <button style={buttonStyle('secondary')} title="Plan routes that start from this result toward an unfinished result; copies an instruction and opens the agent chat"
                onClick={() => onAction({ action: 'agent', prompt: `Plan routes that start from ${node.title} (${node.id}): run research-loop route fork ${node.id} --toward <result> for the unfinished result it can help most (ask me if it is not clear which), then continue the loop.` })}>
                Fork a route from here ↗
              </button>
            )}
            {node.status === 'draft' && node.kind === 'asset' && !parked && (
              <button style={buttonStyle('secondary')} title="Copies an instruction and opens the agent chat"
                onClick={() => onAction({ action: 'agent', prompt: `Work on ${node.id} next in the research loop: search it for a counterexample if it has not been checked, otherwise plan and prove it. Read only its context; do not change its statement without asking me.` })}>
                Work on it in chat ↗
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
