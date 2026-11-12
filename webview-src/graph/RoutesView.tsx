import React, { useMemo, useState } from 'react';
import type { GraphAction, GraphNodeView, GraphPayload, RouteView } from '../../src/models/graph';
import { buttonStyle } from './AttentionList';
import { COLOR, nodeStyle, tint } from './colors';
import { useTechnical } from '../technical';
import { RoutePoint, RoutePointKind, commonDeps, isBlocker, isConnected, isOpen, orderLemmas, resultBlockers, routePoint, routesTo, sharedLemmas } from './routeModel';

export { isOpen, routesTo, sharedLemmas } from './routeModel';

/**
 * Parallel routes to one result: a route proves it from a few lemmas by a short reduction, and the
 * first route complete wins. The Routes view draws one column per route (its lemmas top to bottom,
 * then its reduction, then the result below every column), closed routes included, and marks the
 * one place that holds each route; or it lists them. The result card and the route map review reuse
 * the list rows.
 */

export const ROUTE_STATE_LABEL: Record<RouteView['state'], string> = {
  live: 'Being worked on', reduced: 'Needs only its lemmas', suspended: 'Waits on a set-aside lemma', frozen: 'Waits its turn',
  dead: 'Ruled out', failed: 'Failed', won: 'Proved the result', superseded: 'Set aside: another route won', abandoned: 'Dropped',
};

export const ROUTE_STATE_COLOR: Record<RouteView['state'], string> = {
  live: COLOR.active, reduced: COLOR.active, suspended: COLOR.waiting, frozen: COLOR.muted,
  dead: COLOR.error, failed: COLOR.error, won: COLOR.approved, superseded: COLOR.inactive, abandoned: COLOR.inactive,
};

const ORIGIN_LABEL: Record<RouteView['origin'], string> = { researcher: 'yours', agent: 'agent', fork: 'fork' };
const REDUCTION_MARK: Record<RouteView['reduction'], { mark: string; hint: string }> = {
  none: { mark: '—', hint: 'The step from the lemmas to the result is not written yet' },
  written: { mark: '…', hint: 'The step from the lemmas is written; an independent check is next' },
  verified: { mark: '✓', hint: 'The step from the lemmas to the result holds' },
  failed: { mark: '✗', hint: 'The step from the lemmas to the result failed' },
};

/** Results that have routes, main results first. */
export function routedResults(payload: GraphPayload): string[] {
  const targets = [...new Set((payload.routes ?? []).map((route) => route.target))];
  return targets.sort((a, b) => Number(payload.required.includes(b)) - Number(payload.required.includes(a)));
}

/** One line on a result's routes, e.g. "3 routes · best needs 1 more step". */
export function routesSummary(routes: RouteView[]): string {
  const open = routes.filter(isOpen);
  const won = routes.find((route) => route.state === 'won');
  if (won) return `Proved through the route ${won.title}`;
  if (!open.length) return routes.length ? `${routes.length === 1 ? 'Its route' : `All ${routes.length} routes`} failed or ${routes.length === 1 ? 'was' : 'were'} ruled out` : 'No routes yet';
  const best = open.reduce((a, b) => ((a.left ?? Infinity) <= (b.left ?? Infinity) ? a : b));
  const best_ = best.left === 0 ? ' · one is complete' : best.left !== null ? ` · best needs ${best.left} more step${best.left === 1 ? '' : 's'}` : '';
  return `${open.length} open route${open.length === 1 ? '' : 's'}${best_}`;
}

function why(route: RouteView, title: (id: string) => string): string {
  if (route.death) return `${title(route.death.lemma)} ${route.death.kind === 'refuted' ? 'has a counterexample' : route.death.kind === 'cycle' ? 'would make it circular' : 'was retired'}`;
  if (route.suspendedBy?.length) return `Waits on ${route.suspendedBy.map(title).join(', ')}`;
  return '';
}

function LemmaChip({ node, id, shared, onSelect }: { node?: GraphNodeView; id: string; shared: boolean; onSelect: (id: string) => void }) {
  const style = node ? nodeStyle(node) : { color: COLOR.muted, dashed: true };
  return (
    <button onClick={() => onSelect(id)} title={node ? `${node.title}: ${node.progressLabel}` : id}
      style={{ fontSize: 11.5, padding: '1px 8px', borderRadius: 10, cursor: 'pointer', color: 'var(--vscode-foreground)', border: `1px ${style.dashed ? 'dashed' : 'solid'} ${style.color}`, background: tint(style.color, 12), maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {node?.progress === 'done' ? '✓ ' : ''}{node?.title ?? id}{shared ? ' · shared' : ''}
    </button>
  );
}

/** One route as a row: title, whose, state, the reduction, the lemmas as chips. */
export function RouteRow({ route, payload, shared, onSelect, actions }: { route: RouteView; payload: GraphPayload; shared: Set<string>; onSelect: (id: string) => void; actions?: React.ReactNode }) {
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const title = (id: string) => byId.get(id)?.title ?? id;
  const color = ROUTE_STATE_COLOR[route.state];
  const technical = useTechnical();
  const reason = why(route, title) || (route.closedReason ? `${route.state === 'failed' ? 'Failed' : 'Dropped'}: ${route.closedReason}` : '');
  return (
    <div style={{ border: `1px solid ${tint(color, 50)}`, borderRadius: 6, background: tint(color, isOpen(route) ? 8 : 3), padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 5, opacity: isOpen(route) || route.state === 'won' ? 1 : 0.75 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: color, borderRadius: 8, padding: '0 7px' }}>{ROUTE_STATE_LABEL[route.state]}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{route.title}</span>
        <span style={{ fontSize: 11, color: COLOR.muted }}>{ORIGIN_LABEL[route.origin]}{route.forkedFrom ? ` from ${title(route.forkedFrom)}` : ''}{technical ? ` · ${route.planId}` : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontSize: 11.5, color: COLOR.muted }}>
          <span title={REDUCTION_MARK[route.reduction].hint}>step from lemmas {REDUCTION_MARK[route.reduction].mark}</span>
          {route.lemmas.length > 0 && <span>lemmas {route.settledLemmas}/{route.lemmas.length}</span>}
          {isOpen(route) && route.left !== null && <span>{route.left === 0 ? 'complete' : `${route.left} step${route.left === 1 ? '' : 's'} left`}</span>}
          {actions}
        </span>
      </div>
      {route.lemmas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {route.lemmas.map((id) => <LemmaChip key={id} id={id} node={byId.get(id)} shared={shared.has(id)} onSelect={onSelect} />)}
        </div>
      )}
      {route.lemmas.length === 0 && <div style={{ fontSize: 11.5, color: COLOR.muted }}>A direct proof: no lemma first.</div>}
      {reason && <div style={{ fontSize: 11.5, color }}>{reason}</div>}
    </div>
  );
}

export const dropPrompt = (route: RouteView, title: string) => `Drop the route "${route.title}" to ${title}: run research-loop route drop ${route.planId} --reason "<my reason; ask me if I did not say>", then continue the loop.`;
export const addRoutePrompt = (id: string, title: string) => `I want to add a route of my own to ${title}. Ask me for it, record it as my approach idea (record_idea with origin researcher, related to ${id}), then run research-loop route request ${id} and continue the loop.`;

/** The routes listed: open ones, then the rest folded. */
export function RouteList({ payload, target, onSelect, onAction }: { payload: GraphPayload; target: string; onSelect: (id: string) => void; onAction: (action: GraphAction) => void }) {
  const routes = routesTo(payload, target);
  const title = payload.nodes.find((node) => node.id === target)?.title ?? target;
  const shared = sharedLemmas(routes.filter(isOpen));
  const open = routes.filter((route) => isOpen(route) || route.state === 'won');
  const closed = routes.filter((route) => !open.includes(route));
  const loopOn = payload.loop?.status === 'running' || payload.loop?.status === 'paused';
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {open.map((route) => (
        <RouteRow key={route.planId} route={route} payload={payload} shared={shared} onSelect={onSelect}
          actions={loopOn && isOpen(route) ? <button style={{ ...buttonStyle('secondary'), padding: '0 8px' }} title="Copies an instruction and opens the agent chat" onClick={() => onAction({ action: 'agent', prompt: dropPrompt(route, title) })}>Drop ↗</button> : undefined} />
      ))}
      {closed.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: COLOR.muted }}>{closed.length} route{closed.length === 1 ? '' : 's'} no longer open</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {closed.map((route) => <RouteRow key={route.planId} route={route} payload={payload} shared={new Set()} onSelect={onSelect} />)}
          </div>
        </details>
      )}
      {loopOn && !routes.some((route) => route.state === 'won') && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={buttonStyle('secondary')} title="Copies an instruction and opens the agent chat" onClick={() => onAction({ action: 'agent', prompt: addRoutePrompt(target, title) })}>Add a route of mine ↗</button>
          <button style={buttonStyle('secondary')} title="Copies an instruction and opens the agent chat" onClick={() => onAction({ action: 'agent', prompt: `Plan another round of routes to ${title}: run research-loop route request ${target}, then continue the loop.` })}>Another round ↗</button>
        </div>
      )}
    </div>
  );
}


// ---------- the route map: one column per route, the result below ----------

const OPEN_W = 240; const CLOSED_W = 200; const GAP = 14; const DIVIDER_W = 18; const RESULT_W = 380; const FAN_H = 34;

export const POINT_COLOR: Record<RoutePointKind, string> = {
  dead: COLOR.error, stuck: COLOR.error, needs_you: COLOR.waiting, waiting: COLOR.muted, closed: COLOR.inactive, won: COLOR.approved, next: COLOR.active,
};
export const POINT_ICON: Record<RoutePointKind, string> = { dead: '⛔', stuck: '⛔', needs_you: '⛔', waiting: '⏸', closed: '—', won: '✓', next: '▶' };

const clamp = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
const letterOf = (index: number) => String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : '');

/** How the flow runs down a column at one spot: through settled lemmas, open ones, or cut off. */
type Flow = 'done' | 'open' | 'broken' | 'won' | 'closed';
const FLOW: Record<Flow, { color: string; width: number; dashed: boolean }> = {
  done: { color: COLOR.approved, width: 2, dashed: false },
  open: { color: COLOR.active, width: 1.5, dashed: false },
  broken: { color: COLOR.muted, width: 1.5, dashed: true },
  won: { color: COLOR.approved, width: 3, dashed: false },
  closed: { color: COLOR.inactive, width: 1.5, dashed: true },
};

function Segment({ flow, grow = false, cut, height = 14 }: { flow: Flow; grow?: boolean; cut?: RoutePointKind; height?: number }) {
  const style = FLOW[flow];
  return (
    <div aria-hidden style={{ flex: grow ? 1 : undefined, minHeight: cut ? 26 : height, display: 'flex', justifyContent: 'center', position: 'relative' }}>
      <div style={{ borderLeft: `${style.width}px ${style.dashed ? 'dashed' : 'solid'} ${style.color}` }} />
      {cut && (
        <span style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 16, height: 16, borderRadius: 8, background: POINT_COLOR[cut], color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</span>
      )}
    </div>
  );
}

function Tag({ point }: { point: RoutePoint }) {
  const color = POINT_COLOR[point.kind];
  const strong = isBlocker(point) && point.kind !== 'waiting';
  return (
    <span title={point.label} style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 8, padding: '0 6px', whiteSpace: 'nowrap', color: strong ? '#fff' : color, background: strong ? color : tint(color, 18), border: strong ? 'none' : `1px solid ${tint(color, 60)}` }}>
      {POINT_ICON[point.kind]} {point.tag}
    </span>
  );
}

interface Pointer { highlight?: string; onHover: (id: string | undefined) => void; onSelect: (id: string) => void }

function LemmaCard({ id, node, point, others, pointer }: { id: string; node?: GraphNodeView; point?: RoutePoint; others: string[]; pointer: Pointer }) {
  const style = node ? nodeStyle(node) : { color: COLOR.muted, dashed: true };
  const blocker = point && isBlocker(point);
  const lit = pointer.highlight === id;
  const border = blocker ? `2px solid ${POINT_COLOR[point!.kind]}` : `1.5px ${style.dashed ? 'dashed' : 'solid'} ${style.color}`;
  return (
    <button onClick={(event) => { event.stopPropagation(); pointer.onSelect(id); }} onMouseEnter={() => pointer.onHover(id)} onMouseLeave={() => pointer.onHover(undefined)}
      title={node ? `${node.title}: ${node.progressLabel}${point ? `. ${point.label}` : ''}` : `${id}: not in the project`}
      style={{ width: '100%', textAlign: 'left', cursor: 'pointer', borderRadius: 6, padding: '6px 9px', border, background: tint(blocker ? POINT_COLOR[point!.kind] : style.color, blocker ? 16 : 10), color: 'var(--vscode-foreground)', boxShadow: lit ? `0 0 0 2px ${COLOR.active}` : undefined, display: 'flex', flexDirection: 'column', gap: 3, font: 'inherit' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, ...clamp(2) }}>{node?.progress === 'done' ? '✓ ' : ''}{node?.title ?? id}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 6px', alignItems: 'center', fontSize: 11, color: COLOR.muted }}>
        {point?.tag !== node?.progressLabel && <span>{node?.progressLabel ?? 'Missing'}</span>}
        {others.length > 0 && <span title={`Also needed by route${others.length === 1 ? '' : 's'} ${others.join(', ')}`}>🔗 also {others.join(', ')}</span>}
        {point && <Tag point={point} />}
      </span>
      {blocker && <span style={{ fontSize: 11, color: POINT_COLOR[point!.kind], ...clamp(2) }}>{point!.label}</span>}
    </button>
  );
}

function RouteHeader({ route, letter, point, best, title }: { route: RouteView; letter: string; point: RoutePoint; best: boolean; title: (id: string) => string }) {
  const color = ROUTE_STATE_COLOR[route.state];
  const technical = useTechnical();
  const pointColor = POINT_COLOR[point.kind];
  const atLemma = point.at !== 'route' && point.at !== 'reduction';
  const line = point.kind === 'won' ? ''
    : isBlocker(point) && atLemma ? `${POINT_ICON[point.kind]} Held at ${title(point.at)}${point.more ? ` (+${point.more} more)` : ''}`
    : point.kind === 'next' ? `▶ ${atLemma ? `${point.tag}: ${title(point.at)}` : point.label}`
    : `${POINT_ICON[point.kind]} ${point.label}${point.more ? ` (+${point.more} more held)` : ''}`;
  return (
    <div title={technical ? route.planId : undefined} style={{ border: `1px solid ${tint(color, 55)}`, borderRadius: 6, background: tint(color, 9), padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ width: 18, height: 18, borderRadius: 9, border: `1.5px solid ${color}`, color, fontSize: 10.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{letter}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: '#fff', background: color, borderRadius: 8, padding: '0 7px' }}>{ROUTE_STATE_LABEL[route.state]}</span>
        {best && <span style={{ fontSize: 10.5, color: COLOR.active, fontWeight: 600 }}>best</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, ...clamp(2) }}>{route.title}</div>
      <div style={{ fontSize: 11, color: COLOR.muted }}>
        {ORIGIN_LABEL[route.origin]}{route.forkedFrom ? ` from ${title(route.forkedFrom)}` : ''}
        {route.lemmas.length > 0 ? ` · lemmas ${route.settledLemmas}/${route.lemmas.length}` : ''}
        {isOpen(route) && route.left !== null ? ` · ${route.left === 0 ? 'complete' : `${route.left} step${route.left === 1 ? '' : 's'} left`}` : ''}
      </div>
      {line && <div title={point.label} style={{ fontSize: 11.5, color: point.kind === 'next' ? COLOR.muted : pointColor, fontWeight: isBlocker(point) ? 600 : 400, ...clamp(3) }}>{line}</div>}
    </div>
  );
}

function Diamond({ route, point }: { route: RouteView; point: RoutePoint }) {
  const color = ROUTE_STATE_COLOR[route.state];
  const filled = route.reduction === 'verified';
  const here = point.at === 'reduction' || (point.kind === 'dead' && point.at === 'route' && route.reduction === 'failed');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${REDUCTION_MARK[route.reduction].hint}.${here ? ` ${point.label}.` : ''}`}>
      <svg width={30} height={30} style={{ display: 'block' }}>
        <polygon points="15,2 28,15 15,28 2,15" fill={filled ? color : tint(color, 18)} stroke={here ? POINT_COLOR[point.kind] : color} strokeWidth={here ? 2.5 : 1.8} strokeDasharray={route.reduction === 'written' ? '3 2' : undefined} />
        <text x={15} y={19} textAnchor="middle" fontSize={11} fontWeight={700} fill={filled ? '#fff' : color}>{REDUCTION_MARK[route.reduction].mark}</text>
      </svg>
      <span style={{ fontSize: 10.5, color: COLOR.muted }}>step from the lemmas</span>
      {here && point.kind !== 'dead' && <Tag point={point} />}
    </div>
  );
}

function RouteColumn({ route, letter, width, best, order, point, usedBy, byId, pointer }: {
  route: RouteView; letter: string; width: number; best: boolean; order: string[]; point: RoutePoint; usedBy: Map<string, string[]>; byId: Map<string, GraphNodeView>; pointer: Pointer;
}) {
  const connected = isConnected(route);
  const title = (id: string) => byId.get(id)?.title ?? id;
  const blockAt = isBlocker(point) ? order.indexOf(point.at) : -1;
  const routeCut = point.at === 'route' && point.kind !== 'won';
  const flowAfter = (index: number): Flow => {
    if (route.state === 'won') return 'won';
    if (routeCut) return 'closed';
    if (blockAt >= 0 && index >= blockAt) return 'broken';
    if (index >= 0 && order.slice(0, index + 1).every((id) => byId.get(id)?.progress === 'done')) return 'done';
    return 'open';
  };
  const last = order.length - 1;
  return (
    <div style={{ width, flexShrink: 0, display: 'flex', flexDirection: 'column', opacity: connected ? 1 : 0.62 }}>
      <RouteHeader route={route} letter={letter} point={point} best={best} title={title} />
      <Segment flow={flowAfter(-1) === 'done' ? 'open' : flowAfter(-1)} />
      {order.map((id, index) => (
        <React.Fragment key={id}>
          <LemmaCard id={id} node={byId.get(id)} point={point.at === id ? point : undefined} pointer={pointer}
            others={connected ? (usedBy.get(id) ?? []).filter((other) => other !== letter) : []} />
          {index < last && <Segment flow={flowAfter(index)} cut={index === blockAt ? point.kind : undefined} />}
        </React.Fragment>
      ))}
      {order.length === 0 && <div style={{ fontSize: 11.5, color: COLOR.muted, textAlign: 'center', border: `1px dashed ${COLOR.border}`, borderRadius: 6, padding: '6px 8px' }}>A direct proof: no lemma first</div>}
      <Segment flow={flowAfter(last)} grow cut={last >= 0 && last === blockAt ? point.kind : undefined} />
      <Diamond route={route} point={point} />
      {connected
        ? <Segment flow={route.state === 'won' ? 'won' : flowAfter(last)} height={10} />
        : <div aria-label="Not joined to the result" style={{ textAlign: 'center', fontSize: 11, color: COLOR.inactive, paddingTop: 2 }}>┆<br />✕</div>}
    </div>
  );
}

function Chip({ id, node, pointer, held }: { id: string; node?: GraphNodeView; pointer: Pointer; held?: RoutePoint }) {
  const style = node ? nodeStyle(node) : { color: COLOR.muted, dashed: true };
  return (
    <button onClick={(event) => { event.stopPropagation(); pointer.onSelect(id); }} onMouseEnter={() => pointer.onHover(id)} onMouseLeave={() => pointer.onHover(undefined)}
      title={node ? `${node.title}: ${node.progressLabel}` : id}
      style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', color: 'var(--vscode-foreground)', border: held ? `2px solid ${POINT_COLOR[held.kind]}` : `1px ${style.dashed ? 'dashed' : 'solid'} ${style.color}`, background: tint(style.color, 12), boxShadow: pointer.highlight === id ? `0 0 0 2px ${COLOR.active}` : undefined, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: 'inherit' }}>
      {node?.progress === 'done' ? '✓ ' : held ? `${POINT_ICON[held.kind]} ` : ''}{node?.title ?? id} · {node?.progressLabel ?? 'missing'}
    </button>
  );
}

/** What holds the result up, across its open routes, the worst first; or that nothing does. */
function BlockerBar({ payload, target, routes, letters, byId, pointer, points }: {
  payload: GraphPayload; target: string; routes: RouteView[]; letters: Map<string, string>; byId: Map<string, GraphNodeView>; pointer: Pointer; points: Map<string, RoutePoint>;
}) {
  const title = (id: string) => byId.get(id)?.title ?? id;
  const won = routes.find((route) => route.state === 'won');
  const open = routes.filter(isOpen);
  const blockers = won ? [] : resultBlockers(target, payload, byId);
  const frozen = open.filter((route) => route.state === 'frozen').length;
  const best = open[0];
  const bestPoint = best ? points.get(best.planId) : undefined;
  const tone = won ? COLOR.approved : !open.length ? COLOR.error : blockers.length ? POINT_COLOR[blockers[0].kind] : COLOR.active;
  const heading = won ? `Proved through the route ${won.title}`
    : !open.length ? (routes.length ? 'Every route is closed: each column says why' : 'No routes yet')
    : blockers.length ? 'What holds this result up' : 'Nothing is blocking';
  const row = (blocker: (typeof blockers)[number]) => (
    <div key={blocker.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'center', fontSize: 12 }}>
      <span style={{ color: POINT_COLOR[blocker.kind] }}>⛔</span>
      <button onClick={(event) => { event.stopPropagation(); pointer.onSelect(blocker.id); }} onMouseEnter={() => pointer.onHover(blocker.id)} onMouseLeave={() => pointer.onHover(undefined)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: COLOR.link, fontWeight: 600, font: 'inherit', textDecoration: pointer.highlight === blocker.id ? 'underline' : undefined }}>{title(blocker.id)}</button>
      <Tag point={{ kind: blocker.kind, at: blocker.id, tag: blocker.tag, label: blocker.label, more: 0 }} />
      <span style={{ color: COLOR.muted }}>
        {blocker.common ? 'needed by every route' : `holds ${blocker.routes.length === open.length && open.length > 1 ? 'every open route' : `route${blocker.routes.length === 1 ? '' : 's'} ${blocker.routes.map((id) => letters.get(id) ?? '?').join(', ')}`} (${blocker.routes.length} of ${open.length} open)`}
        {blocker.label ? ` · ${blocker.label}` : ''}
      </span>
    </div>
  );
  const footer = [
    routesSummary(routes),
    best && bestPoint?.kind === 'next' ? `${letters.get(best.planId)} ${best.title}: ${bestPoint.at === 'reduction' ? bestPoint.label.toLowerCase() : `${bestPoint.tag.toLowerCase()} ${title(bestPoint.at)}`}` : '',
    frozen ? `${frozen} route${frozen === 1 ? ' waits its' : 's wait their'} turn` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ margin: '8px 12px 0', padding: '7px 11px', borderRadius: 6, border: `1px solid ${tint(tone, 55)}`, background: tint(tone, 8), display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: tone }}>{heading}</div>
      {blockers.slice(0, 3).map(row)}
      {blockers.length > 3 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11.5, color: COLOR.muted }}>{blockers.length - 3} more</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>{blockers.slice(3).map(row)}</div>
        </details>
      )}
      <div style={{ fontSize: 11.5, color: COLOR.muted }}>{footer}</div>
    </div>
  );
}

/**
 * The routes drawn: one column per route, its lemmas top to bottom, its reduction below them, and
 * the result below every open column. Closed routes stand on the right, dimmed and not joined to the
 * result, each saying why it closed. Each route marks the one place that holds it.
 */
export function RouteMap({ payload, target, selectedId, onSelect, hideClosed = false }: { payload: GraphPayload; target: string; selectedId?: string; onSelect: (id: string | undefined) => void; hideClosed?: boolean }) {
  const [hover, setHover] = useState<string>();
  const byId = useMemo(() => new Map(payload.nodes.map((node) => [node.id, node])), [payload]);
  const all = useMemo(() => routesTo(payload, target), [payload, target]);
  const connected = all.filter(isConnected);
  const closed = all.filter((route) => !isConnected(route)).sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
  const shownClosed = hideClosed ? [] : closed;
  const columns = [...connected, ...shownClosed];
  const letters = new Map(columns.map((route, index) => [route.planId, letterOf(index)]));
  // Closed routes keep their letter when hidden, so the bar can still name them.
  closed.forEach((route, index) => { if (!letters.has(route.planId)) letters.set(route.planId, letterOf(connected.length + index)); });
  const shared = sharedLemmas(connected);
  const usedBy = new Map<string, string[]>();
  for (const route of connected) for (const lemma of route.lemmas) if (shared.has(lemma)) usedBy.set(lemma, [...(usedBy.get(lemma) ?? []), letters.get(route.planId)!]);
  const orders = new Map(all.map((route) => [route.planId, orderLemmas(route, payload.edges, byId)]));
  const points = new Map(all.map((route) => [route.planId, routePoint(route, byId, { order: orders.get(route.planId), routes: all, loopAsset: payload.loop?.assetId })]));
  const pointer: Pointer = { highlight: hover ?? selectedId, onHover: setHover, onSelect: (id) => onSelect(id === selectedId ? undefined : id) };
  const goal = byId.get(target);
  const goalStyle = goal ? nodeStyle(goal) : { color: COLOR.muted, dashed: true };
  const deps = commonDeps(target, payload.edges);
  const heldDeps = new Map(resultBlockers(target, payload, byId).filter((item) => item.common).map((item) => [item.id, { kind: item.kind, at: item.id, tag: item.tag, label: item.label, more: 0 } as RoutePoint]));
  // Geometry: open columns share a block as wide as the result at least, centred in it.
  const connectedW = connected.length ? connected.length * OPEN_W + (connected.length - 1) * GAP : 0;
  const blockW = Math.max(connectedW, RESULT_W);
  const offset = (blockW - connectedW) / 2;
  const columnX = (index: number) => offset + index * (OPEN_W + GAP) + OPEN_W / 2;
  const closedW = shownClosed.length ? GAP + DIVIDER_W + GAP + shownClosed.length * CLOSED_W + (shownClosed.length - 1) * GAP : 0;
  const width = blockW + closedW;
  const fan = (route: RouteView) => ({ stroke: ROUTE_STATE_COLOR[route.state], width: route.state === 'won' ? 3 : 1.8, dash: route.state === 'frozen' || route.state === 'suspended' ? '5 4' : undefined });
  const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: COLOR.muted, textTransform: 'uppercase', paddingBottom: 6 };
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }} onClick={() => onSelect(undefined)}>
      <BlockerBar payload={payload} target={target} routes={all} letters={letters} byId={byId} pointer={pointer} points={points} />
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px 14px' }}>
        <div role="group" aria-label={`Routes to ${goal?.title ?? target}`} style={{ width, margin: '0 auto' }}>
          <div style={{ display: 'flex' }}>
            <div style={{ ...sectionLabel, width: blockW - offset, paddingLeft: offset }}>{connected.length ? `Open · best first${connected.some((route) => route.state === 'won') ? ' · and the winner' : ''}` : 'No open route'}</div>
            {shownClosed.length > 0 && <div style={{ ...sectionLabel, paddingLeft: GAP + DIVIDER_W + GAP }}>Closed · {shownClosed.length}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <div style={{ width: blockW, display: 'flex', justifyContent: 'center', gap: GAP, alignItems: 'stretch', flexShrink: 0 }}>
              {connected.map((route, index) => (
                <RouteColumn key={route.planId} route={route} letter={letters.get(route.planId)!} width={OPEN_W} best={index === 0 && isOpen(route) && connected.length > 1}
                  order={orders.get(route.planId)!} point={points.get(route.planId)!} usedBy={usedBy} byId={byId} pointer={pointer} />
              ))}
            </div>
            {shownClosed.length > 0 && <>
              <div aria-hidden style={{ width: DIVIDER_W, margin: `0 ${GAP}px`, display: 'flex', justifyContent: 'center', flexShrink: 0 }}><div style={{ borderLeft: `1px dashed ${COLOR.border}` }} /></div>
              <div style={{ display: 'flex', gap: GAP, alignItems: 'stretch' }}>
                {shownClosed.map((route) => (
                  <RouteColumn key={route.planId} route={route} letter={letters.get(route.planId)!} width={CLOSED_W} best={false}
                    order={orders.get(route.planId)!} point={points.get(route.planId)!} usedBy={usedBy} byId={byId} pointer={pointer} />
                ))}
              </div>
            </>}
          </div>
          <div style={{ width: blockW, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {connected.length > 0
              ? <svg width={blockW} height={FAN_H} style={{ display: 'block' }} aria-hidden>
                {connected.map((route, index) => {
                  const style = fan(route); const x = columnX(index); const cx = blockW / 2;
                  return <path key={route.planId} d={`M ${x} 0 C ${x} ${FAN_H / 2}, ${cx} ${FAN_H / 2}, ${cx} ${FAN_H}`} fill="none" stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={0.85} />;
                })}
              </svg>
              : <div style={{ height: 14 }} />}
            {deps.length > 0 && <>
              <div style={{ width: Math.min(blockW, 720), boxSizing: 'border-box', border: `1px dashed ${COLOR.border}`, borderRadius: 6, padding: '6px 9px', background: COLOR.card, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 11, color: COLOR.muted }}>Needed by every route{deps.every((id) => byId.get(id)?.progress === 'done') ? ' · all done' : ''}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {deps.map((id) => <Chip key={id} id={id} node={byId.get(id)} pointer={pointer} held={heldDeps.get(id)} />)}
                </div>
              </div>
              <Segment flow={connected.some((route) => route.state === 'won') ? 'won' : 'open'} height={12} />
            </>}
            <button onClick={(event) => { event.stopPropagation(); pointer.onSelect(target); }} onMouseEnter={() => setHover(target)} onMouseLeave={() => setHover(undefined)}
              style={{ width: RESULT_W, boxSizing: 'border-box', textAlign: 'center', cursor: 'pointer', borderRadius: 8, padding: '8px 12px', font: 'inherit', color: 'var(--vscode-foreground)', border: `2px ${goalStyle.dashed ? 'dashed' : 'solid'} ${goalStyle.color}`, background: tint(goalStyle.color, 14), boxShadow: pointer.highlight === target ? `0 0 0 2px ${COLOR.active}` : undefined, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, ...clamp(2) }}>{payload.required.includes(target) ? '★ ' : ''}{goal?.title ?? target}</span>
              <span style={{ fontSize: 11.5, color: COLOR.muted }}>{goal?.progressLabel ?? 'Missing'} · {routesSummary(all)}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Legend for the route map. */
export function RouteLegend() {
  const line = (flow: Flow, label: string) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 0, height: 14, borderLeft: `${FLOW[flow].width}px ${FLOW[flow].dashed ? 'dashed' : 'solid'} ${FLOW[flow].color}` }} />{label}
    </span>
  );
  const mark = (kind: RoutePointKind, label: string) => <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ color: POINT_COLOR[kind] }}>{POINT_ICON[kind]}</span>{label}</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '7px 14px', borderTop: `1px solid ${COLOR.border}`, fontSize: 11, color: COLOR.muted, alignItems: 'center' }}>
      <span>Each column is a route: its lemmas, then ◇ the step from them (✓ holds, … written, — not yet)</span>
      {line('done', 'lemmas done so far')}
      {line('open', 'still to prove')}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 14, borderRadius: 7, background: COLOR.error, color: '#fff', fontSize: 9, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✕</span>cut: the route is held here</span>
      {mark('needs_you', 'blocker (red: dead or stuck, amber: needs you)')}
      {mark('waiting', 'waits its turn')}
      {mark('next', 'next step')}
      <span>🔗 a lemma another route needs too</span>
      <span>Closed routes: dimmed, on the right, not joined to the result</span>
    </div>
  );
}
