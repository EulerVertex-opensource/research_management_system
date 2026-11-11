import React, { useMemo } from 'react';
import type { GraphAction, GraphNodeView, GraphPayload, RouteView } from '../../src/models/graph';
import { buttonStyle } from './AttentionList';
import { COLOR, nodeStyle, tint } from './colors';
import { useTechnical } from '../technical';

/**
 * Parallel routes to one result: a route proves it from a few lemmas by a short reduction, and the
 * first route complete wins. The Routes view draws them side by side (the result above, one diamond
 * per route, the lemmas below, a lemma several routes share drawn once between them), or lists them;
 * the result card and the route map review reuse the list rows.
 */

export const ROUTE_STATE_LABEL: Record<RouteView['state'], string> = {
  live: 'Open', reduced: 'Needs only its lemmas', suspended: 'Waits on a set-aside lemma', frozen: 'Waits its turn',
  dead: 'Ruled out', failed: 'Failed', won: 'Proved the result', superseded: 'Set aside: another route won', abandoned: 'Dropped',
};

export const ROUTE_STATE_COLOR: Record<RouteView['state'], string> = {
  live: COLOR.active, reduced: COLOR.active, suspended: COLOR.waiting, frozen: COLOR.muted,
  dead: COLOR.error, failed: COLOR.error, won: COLOR.approved, superseded: COLOR.inactive, abandoned: COLOR.inactive,
};

const ORIGIN_LABEL: Record<RouteView['origin'], string> = { researcher: 'yours', agent: 'agent', fork: 'fork', copy: 'copy' };
const REDUCTION_MARK: Record<RouteView['reduction'], { mark: string; hint: string }> = {
  none: { mark: '—', hint: 'The step from the lemmas to the result is not written yet' },
  written: { mark: '…', hint: 'The step from the lemmas is written; an independent check is next' },
  verified: { mark: '✓', hint: 'The step from the lemmas to the result holds' },
  failed: { mark: '✗', hint: 'The step from the lemmas to the result failed' },
};

const OPEN_STATES = new Set<RouteView['state']>(['live', 'reduced', 'suspended', 'frozen']);
export const isOpen = (route: RouteView) => OPEN_STATES.has(route.state);

/** The routes to a result, open ones first (the most promising first), then the rest. */
export function routesTo(payload: GraphPayload, target: string): RouteView[] {
  const rank = (route: RouteView) => (isOpen(route) ? 0 : route.state === 'won' ? 1 : 2);
  return (payload.routes ?? []).filter((route) => route.target === target)
    .sort((a, b) => rank(a) - rank(b) || (a.left ?? Infinity) - (b.left ?? Infinity) || (a.round ?? 0) - (b.round ?? 0));
}

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
      {node?.progress === 'done' ? '✓ ' : ''}{node?.title ?? id}{shared ? ' · shared' : ''}{node?.claimedBy && node.progress !== 'done' ? ` · ${node.claimedBy === 'you' ? 'you' : node.claimedBy.split('@')[0]}` : ''}
    </button>
  );
}

/** One route as a row: title, whose, state, the reduction, the lemmas as chips. */
export function RouteRow({ route, payload, shared, onSelect, actions }: { route: RouteView; payload: GraphPayload; shared: Set<string>; onSelect: (id: string) => void; actions?: React.ReactNode }) {
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const title = (id: string) => byId.get(id)?.title ?? id;
  const color = ROUTE_STATE_COLOR[route.state];
  const technical = useTechnical();
  const reason = why(route, title);
  return (
    <div style={{ border: `1px solid ${tint(color, 50)}`, borderRadius: 6, background: tint(color, isOpen(route) ? 8 : 3), padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 5, opacity: isOpen(route) || route.state === 'won' ? 1 : 0.75 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: color, borderRadius: 8, padding: '0 7px' }}>{ROUTE_STATE_LABEL[route.state]}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{route.title}</span>
        <span style={{ fontSize: 11, color: COLOR.muted }}>{ORIGIN_LABEL[route.origin]}{route.forkedFrom ? ` from ${title(route.forkedFrom)}` : ''}{route.copiedFrom ? ` of ${route.copiedFrom}` : ''}{route.createdBy && route.claimedBy !== 'you' ? ` · by ${route.createdBy.split('@')[0]}` : ''}{technical ? ` · ${route.planId}` : ''}</span>
        {route.claimedBy && isOpen(route) && <span style={{ fontSize: 11, color: COLOR.active }} title="This collaborator's loop holds the route now">on it: {route.claimedBy === 'you' ? 'you' : route.claimedBy.split('@')[0]}</span>}
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

/** Lemmas that two or more of the given routes need. */
export function sharedLemmas(routes: RouteView[]): Set<string> {
  const count = new Map<string, number>();
  for (const route of routes) for (const lemma of route.lemmas) count.set(lemma, (count.get(lemma) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
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
  // Several collaborators' routes: anyone may run a copy of another's route (its creator reduces the original).
  const team = new Set((payload.routes ?? []).map((route) => route.createdBy).filter(Boolean)).size > 1;
  const copyPrompt = (route: RouteView) => `Run a copy of the route "${route.title}" to ${title}: run research-loop route copy ${route.planId}, then continue the loop.`;
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {open.map((route) => (
        <RouteRow key={route.planId} route={route} payload={payload} shared={shared} onSelect={onSelect}
          actions={loopOn && isOpen(route) ? <>
            {team && <button style={{ ...buttonStyle('secondary'), padding: '0 8px' }} title="A route of yours with the same lemmas; copies an instruction and opens the agent chat" onClick={() => onAction({ action: 'agent', prompt: copyPrompt(route) })}>Run a copy ↗</button>}
            <button style={{ ...buttonStyle('secondary'), padding: '0 8px' }} title="Copies an instruction and opens the agent chat" onClick={() => onAction({ action: 'agent', prompt: dropPrompt(route, title) })}>Drop ↗</button>
          </> : undefined} />
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

const GOAL_W = 340; const GOAL_H = 46; const COL_W = 230; const LEMMA_W = 190; const LEMMA_H = 44; const DIAMOND = 13;
const ROW_GOAL = 20; const ROW_ROUTE = 120; const ROW_LEMMA = 260;
const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The routes drawn: the result on top, a diamond per route, the lemmas below. */
export function RouteMap({ payload, target, selectedId, onSelect }: { payload: GraphPayload; target: string; selectedId?: string; onSelect: (id: string | undefined) => void }) {
  const routes = useMemo(() => routesTo(payload, target).filter((route) => route.state !== 'superseded' && route.state !== 'abandoned'), [payload, target]);
  const folded = routesTo(payload, target).filter((route) => route.state === 'superseded' || route.state === 'abandoned');
  const byId = new Map(payload.nodes.map((node) => [node.id, node]));
  const goal = byId.get(target);
  const shared = sharedLemmas(routes.filter(isOpen));
  // Lemma columns: each under the routes that need it, a shared one between them, then spread apart;
  // the canvas is as wide as the wider row, and every row is centred in it.
  const routeRow = routes.length * COL_W;
  const ideal = (index: number) => COL_W * index + COL_W / 2;
  const lemmaIds = [...new Set(routes.flatMap((route) => route.lemmas))];
  const placed = lemmaIds.map((id) => {
    const xs = routes.map((route, index) => (route.lemmas.includes(id) ? ideal(index) : undefined)).filter((x): x is number => x !== undefined);
    return { id, x: xs.reduce((a, b) => a + b, 0) / xs.length };
  }).sort((a, b) => a.x - b.x);
  for (let index = 1; index < placed.length; index++) placed[index].x = Math.max(placed[index].x, placed[index - 1].x + LEMMA_W + 14);
  const lemmaMin = placed.length ? placed[0].x - LEMMA_W / 2 : 0;
  const lemmaMax = placed.length ? placed[placed.length - 1].x + LEMMA_W / 2 : 0;
  const canvasWidth = Math.max(GOAL_W + 40, routeRow, lemmaMax - lemmaMin + 20);
  const routeOffset = (canvasWidth - routeRow) / 2;
  const routeX = (index: number) => routeOffset + ideal(index);
  // Keep each lemma under its routes where it fits, else shift the whole row back inside the canvas.
  let shift = routeOffset;
  if (lemmaMin + shift < 10) shift = 10 - lemmaMin;
  if (lemmaMax + shift > canvasWidth - 10) shift = canvasWidth - 10 - lemmaMax;
  for (const item of placed) item.x += shift;
  const lemmaX = new Map(placed.map((item) => [item.id, item.x]));
  const goalStyle = goal ? nodeStyle(goal) : { color: COLOR.muted, dashed: true };
  const edge = (route: RouteView) => ({ stroke: ROUTE_STATE_COLOR[route.state], width: route.state === 'won' ? 3 : isOpen(route) ? 1.8 : 1.2, dash: route.state === 'dead' || route.state === 'failed' || route.state === 'frozen' || route.state === 'suspended' ? '5 4' : undefined });
  const box = (x: number, y: number, w: number, h: number, node: GraphNodeView | undefined, id: string, label: string, note: string) => {
    const chars = Math.floor(w / 6.6);
    const style = node ? nodeStyle(node) : { color: COLOR.muted, dashed: true };
    const selected = selectedId === id;
    return (
      <g key={id} style={{ cursor: 'pointer' }} onClick={(event) => { event.stopPropagation(); onSelect(selected ? undefined : id); }}>
        <rect x={x - w / 2} y={y} width={w} height={h} rx={6} fill={tint(style.color, 14)} stroke={selected ? COLOR.active : style.color} strokeWidth={selected ? 2.5 : 1.5} strokeDasharray={style.dashed ? '5 3' : undefined} />
        <text x={x} y={y + 18} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="var(--vscode-foreground)">{clipText(label, Math.floor(chars * 0.85))}</text>
        <text x={x} y={y + 34} textAnchor="middle" fontSize={11} fill={COLOR.muted}>{clipText(note, chars)}</text>
      </g>
    );
  };
  return (
    <div style={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }} onClick={() => onSelect(undefined)}>
      <svg width={canvasWidth} height={ROW_LEMMA + LEMMA_H + 24} style={{ display: 'block', margin: '8px auto 0', flexShrink: 0 }} role="img" aria-label={`Routes to ${goal?.title ?? target}`}>
        {routes.map((route, index) => {
          const style = edge(route);
          return (
            <g key={`edges:${route.planId}`}>
              <line x1={canvasWidth / 2} y1={ROW_GOAL + GOAL_H} x2={routeX(index)} y2={ROW_ROUTE - DIAMOND} stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={0.85} />
              {route.lemmas.map((lemma) => <line key={lemma} x1={routeX(index)} y1={ROW_ROUTE + DIAMOND + 38} x2={lemmaX.get(lemma)!} y2={ROW_LEMMA} stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={0.75} />)}
            </g>
          );
        })}
        {box(canvasWidth / 2, ROW_GOAL, GOAL_W, GOAL_H, goal, target, goal?.title ?? target, `${goal?.progressLabel ?? ''} · ${routesSummary(routesTo(payload, target))}`)}
        {routes.map((route, index) => {
          const color = ROUTE_STATE_COLOR[route.state];
          const x = routeX(index);
          const filled = route.reduction === 'verified';
          return (
            <g key={route.planId}>
              <title>{`${route.title} — ${ROUTE_STATE_LABEL[route.state]}. ${REDUCTION_MARK[route.reduction].hint}.`}</title>
              <polygon points={`${x},${ROW_ROUTE - DIAMOND} ${x + DIAMOND},${ROW_ROUTE} ${x},${ROW_ROUTE + DIAMOND} ${x - DIAMOND},${ROW_ROUTE}`} fill={filled ? color : tint(color, 18)} stroke={color} strokeWidth={1.8} strokeDasharray={route.reduction === 'written' ? '3 2' : undefined} />
              <text x={x} y={ROW_ROUTE + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={filled ? '#fff' : color}>{REDUCTION_MARK[route.reduction].mark}</text>
              <text x={x} y={ROW_ROUTE + DIAMOND + 15} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--vscode-foreground)">{clipText(route.title, 30)}</text>
              <text x={x} y={ROW_ROUTE + DIAMOND + 30} textAnchor="middle" fontSize={11} fill={color}>{clipText(`${ORIGIN_LABEL[route.origin]} · ${ROUTE_STATE_LABEL[route.state]}${isOpen(route) && route.left !== null ? ` · ${route.left} left` : ''}`, 40)}</text>
            </g>
          );
        })}
        {placed.map(({ id, x }) => box(x, ROW_LEMMA, LEMMA_W, LEMMA_H, byId.get(id), id, byId.get(id)?.title ?? id, `${byId.get(id)?.progressLabel ?? 'missing'}${shared.has(id) ? ' · shared' : ''}`))}
      </svg>
      {folded.length > 0 && (
        <div style={{ padding: '4px 14px 10px', fontSize: 11.5, color: COLOR.muted, textAlign: 'center' }}>
          Not drawn: {folded.map((route) => `${route.title} (${ROUTE_STATE_LABEL[route.state].toLowerCase()})`).join(' · ')}
        </div>
      )}
    </div>
  );
}


/** Legend for the route map. */
export function RouteLegend() {
  const item = (color: string, label: string, dash?: boolean) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 18, height: 0, borderTop: `2px ${dash ? 'dashed' : 'solid'} ${color}` }} />{label}
    </span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '7px 14px', borderTop: `1px solid ${COLOR.border}`, fontSize: 11, color: COLOR.muted, alignItems: 'center' }}>
      <span>◇ a route: ✓ its step from the lemmas holds, … written, — not yet</span>
      {item(COLOR.active, 'open')}
      {item(COLOR.approved, 'proved the result')}
      {item(COLOR.error, 'failed or ruled out', true)}
      {item(COLOR.muted, 'waits its turn', true)}
      <span>A lemma two routes need is drawn once, between them</span>
    </div>
  );
}
