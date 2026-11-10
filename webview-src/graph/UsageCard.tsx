import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageRole, UsageSpan, UsageView } from '../../src/models/usage';
import { tokensOf } from '../../src/models/usage';
import { COLOR, tint } from './colors';

/**
 * The Activity page's Usage card: where the loop's tokens went in a run or an
 * autonomous stretch, read from the agents' own transcripts. Two charts on one
 * time axis (the driver chats' context size; cumulative tokens by role), and
 * the same numbers as tables (by role, by stage, by result).
 */

export interface UsageState { view?: UsageView; error?: string }

/** Fixed per role: a role keeps its color whichever roles are shown. */
const ROLE_COLOR: Record<UsageRole, string> = {
  driver: 'var(--ra-series-1, #2a78d6)',
  light: 'var(--ra-series-2, #eb6834)',
  deep: 'var(--ra-series-3, #1baf7a)',
  other: 'var(--ra-series-4, #eda100)',
};
const ROLE_LABEL: Record<UsageRole, string> = { driver: 'Driver chat', light: 'Light workers', deep: 'Deep workers', other: 'Other subagents' };
const ROLES: UsageRole[] = ['driver', 'light', 'deep', 'other'];

const ink = 'var(--vscode-foreground)';
const card: React.CSSProperties = { border: `1px solid ${COLOR.border}`, borderRadius: 8, background: COLOR.card, padding: '12px 16px' };
const caption: React.CSSProperties = { fontSize: 11, color: COLOR.muted };

export function compactTokens(tokens: number): string {
  const short = (value: number, digits: number) => value.toFixed(digits).replace(/\.0$/, '');
  if (tokens >= 1e9) return `${short(tokens / 1e9, 1)}B`;
  if (tokens >= 1e6) return `${short(tokens / 1e6, tokens >= 1e8 ? 0 : 1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}K`;
  return String(Math.round(tokens));
}
const percent = (share: number) => `${share > 0 && share < 0.01 ? '<1' : Math.round(share * 100)}%`;
const pad = (value: number) => String(value).padStart(2, '0');
const clock = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;
const day = (at: Date) => at.toLocaleDateString([], { month: 'short', day: 'numeric' });
const moment = (ms: number) => { const at = new Date(ms); return `${day(at)} ${clock(at)}`; };

function spanText(span: UsageSpan): string {
  const from = new Date(span.from);
  const to = span.to ? new Date(span.to) : undefined;
  const end = !to ? 'now' : to.toDateString() === from.toDateString() ? clock(to) : moment(to.getTime());
  return `${span.kind === 'autonomous' ? ' Autonomous' : 'Run'} · ${moment(from.getTime())} → ${end}`;
}

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(240, Math.floor(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 0 and up to four round steps (1, 2, 5 × 10^k) covering `max`. */
function valueTicks(max: number): number[] {
  const raw = Math.max(max, 1) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const STEP_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
/** Ticks on the local clock (whole steps of local time), so a daylight-saving change does not shift the labels. */
function timeTicks(from: number, to: number, count: number): number[] {
  const minutes = STEP_MINUTES.find((candidate) => (to - from) / (candidate * 60_000) <= count) ?? STEP_MINUTES[STEP_MINUTES.length - 1];
  const ticks: number[] = [];
  const at = new Date(from);
  at.setSeconds(0, 0);
  // The first whole step at or after `from`, on the local clock.
  if (minutes >= 1440) { at.setHours(0, 0); if (at.getTime() < from) at.setDate(at.getDate() + 1); }
  else at.setHours(0, Math.ceil((at.getHours() * 60 + at.getMinutes()) / minutes) * minutes);
  while (at.getTime() <= to && ticks.length < 100) {
    ticks.push(at.getTime());
    if (minutes >= 1440) at.setDate(at.getDate() + minutes / 1440);
    else {
      at.setHours(0, Math.floor((at.getHours() * 60 + at.getMinutes() + minutes) / minutes) * minutes);
      // The clock fell back: the same wall time again; step on in real time.
      if (at.getTime() <= ticks[ticks.length - 1]) at.setTime(ticks[ticks.length - 1] + minutes * 60_000);
    }
  }
  return ticks;
}

const PAD = { left: 44, right: 12, top: 10, bottom: 22 };

interface Frame { width: number; height: number; from: number; to: number; max: number; x: (ms: number) => number; y: (tokens: number) => number }

function makeFrame(width: number, height: number, from: number, to: number, max: number): Frame {
  const span = Math.max(to - from, 60_000);
  return {
    width, height, from, to, max,
    x: (ms) => PAD.left + ((ms - from) / span) * (width - PAD.left - PAD.right),
    y: (tokens) => height - PAD.bottom - (tokens / max) * (height - PAD.top - PAD.bottom),
  };
}

/** Recessive axes: horizontal gridlines with token labels, time labels below. */
function Axes({ frame }: { frame: Frame }) {
  const multiDay = new Date(frame.from).toDateString() !== new Date(frame.to).toDateString();
  return (
    <g fontSize={10} fill={COLOR.muted}>
      {valueTicks(frame.max).filter((value) => value <= frame.max).map((value) => (
        <g key={value}>
          <line x1={PAD.left} x2={frame.width - PAD.right} y1={frame.y(value)} y2={frame.y(value)} stroke={COLOR.border} strokeWidth={1} opacity={value === 0 ? 1 : 0.6} />
          <text x={PAD.left - 6} y={frame.y(value) + 3} textAnchor="end">{compactTokens(value)}</text>
        </g>
      ))}
      {timeTicks(frame.from, frame.to, Math.max(2, Math.floor((frame.width - PAD.left) / 90))).map((at) => {
        const date = new Date(at);
        const label = multiDay && date.getHours() === 0 && date.getMinutes() === 0 ? day(date) : multiDay && (frame.to - frame.from) > 2 * 86_400_000 ? `${day(date)} ${clock(date)}` : clock(date);
        return <text key={at} x={frame.x(at)} y={frame.height - 6} textAnchor="middle">{label}</text>;
      })}
    </g>
  );
}

interface Hover { x: number; lines: Array<{ label: string; value: string; color?: string }>; title: string }

/** A chart surface with a crosshair and tooltip; `pick` turns a time under the pointer into what to show. */
type Stall = UsageView['stalls'][number];
const STALL_TEXT: Record<NonNullable<Stall['reason']>, string> = { 'usage limit': 'usage limit', 'compaction failed': 'compaction failed', error: 'error' };
const duration = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);
export const stallLabel = (stall: Stall) => `Stopped ${duration(stall.to - stall.from)}${stall.reason ? ` · ${STALL_TEXT[stall.reason]}` : ' · no activity'}`;
const stallColor = (stall: Stall) => (stall.reason ? COLOR.waiting : COLOR.muted);

/** Stalls as bands behind the data, named when there is room. */
function StallBands({ frame, stalls, named }: { frame: Frame; stalls: Stall[]; named: boolean }) {
  return (
    <g>
      {stalls.map((stall) => {
        const x1 = Math.max(PAD.left, frame.x(stall.from)); const x2 = Math.min(frame.width - PAD.right, frame.x(stall.to));
        if (x2 - x1 < 2) return null;
        const label = stallLabel(stall);
        return (
          <g key={stall.from}>
            <rect x={x1} y={PAD.top} width={x2 - x1} height={frame.height - PAD.top - PAD.bottom} fill={tint(stallColor(stall), 16)} />
            {named && (() => {
              // The full name where it fits, else just how long.
              const shown = x2 - x1 > label.length * 5.6 + 8 ? label : x2 - x1 > 34 ? duration(stall.to - stall.from) : '';
              return shown && <text x={(x1 + x2) / 2} y={PAD.top + 12} textAnchor="middle" fontSize={10} fill={ink}>{shown}</text>;
            })()}
          </g>
        );
      })}
    </g>
  );
}

function ChartSurface({ frame, children, pick, label, stalls, named = false }: { frame: Frame; children: React.ReactNode; pick: (ms: number) => Hover | undefined; label: string; stalls: Stall[]; named?: boolean }) {
  const [hover, setHover] = useState<Hover | undefined>();
  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    if (px < PAD.left || px > frame.width - PAD.right) { setHover(undefined); return; }
    const ms = frame.from + ((px - PAD.left) / (frame.width - PAD.left - PAD.right)) * (frame.to - frame.from);
    const picked = pick(ms);
    const stall = picked ? undefined : stalls.find((item) => ms >= item.from && ms <= item.to);
    setHover(stall ? { x: px, title: `${moment(stall.from)} → ${moment(stall.to)}`, lines: [{ label: stallLabel(stall), value: '' }, ...(stall.message ? [{ label: stall.message.slice(0, 120), value: '' }] : [])] } : picked);
  };
  return (
    <div style={{ position: 'relative' }}>
      <svg width={frame.width} height={frame.height} role="img" aria-label={label} onMouseMove={move} onMouseLeave={() => setHover(undefined)} style={{ display: 'block' }}>
        <StallBands frame={frame} stalls={stalls} named={named} />
        <Axes frame={frame} />
        {children}
        {hover && <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={frame.height - PAD.bottom} stroke={COLOR.muted} strokeWidth={1} strokeDasharray="3 3" />}
      </svg>
      {hover && (
        <div style={{ position: 'absolute', top: 4, left: Math.min(hover.x + 10, frame.width - 190), width: 180, pointerEvents: 'none', background: COLOR.card, border: `1px solid ${COLOR.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.18)', zIndex: 1 }}>
          <div style={{ color: COLOR.muted, marginBottom: 3 }}>{hover.title}</div>
          {hover.lines.map((line) => (
            <div key={line.label} style={{ display: 'flex', alignItems: 'center', gap: 6, color: ink }}>
              {line.color && <span style={{ width: 8, height: 8, borderRadius: 2, background: line.color, flex: 'none' }} />}
              <span style={{ flex: 1 }}>{line.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{line.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Requests further apart than this leave a gap in the line: an idle chat is not a gradual decline. */
const IDLE_GAP_MS = 30 * 60_000;

function linePath(points: Array<[number, number]>, frame: Frame): string {
  return points.map((point, index) => `${index && point[0] - points[index - 1][0] <= IDLE_GAP_MS ? 'L' : 'M'}${frame.x(point[0]).toFixed(1)},${frame.y(point[1]).toFixed(1)}`).join(' ');
}

/** Across an idle gap the chat still holds its context: flat until the next request, where it drops if it was compacted. */
function holdPath(points: Array<[number, number]>, frame: Frame): string {
  const parts: string[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const [before, after] = [points[index - 1], points[index]];
    if (after[0] - before[0] > IDLE_GAP_MS) parts.push(`M${frame.x(before[0]).toFixed(1)},${frame.y(before[1]).toFixed(1)} H${frame.x(after[0]).toFixed(1)} V${frame.y(after[1]).toFixed(1)}`);
  }
  return parts.join(' ');
}

function ContextChart({ view, width, from, to }: { view: UsageView; width: number; from: number; to: number }) {
  const peak = Math.max(0, ...view.context.flatMap((series) => series.points.map((point) => point[1])));
  const frame = makeFrame(width, 170, from, to, valueTicks(Math.max(peak, view.resetTokens) * 1.05).slice(-1)[0]);
  const many = view.context.length > 1;
  const pick = (ms: number): Hover | undefined => {
    let best: { point: [number, number]; chat: number } | undefined;
    view.context.forEach((series, chat) => { for (const point of series.points) if (!best || Math.abs(point[0] - ms) < Math.abs(best.point[0] - ms)) best = { point, chat }; });
    if (!best || Math.abs(frame.x(best.point[0]) - frame.x(ms)) > 24) return undefined;
    const compaction = view.compactions.find((item) => Math.abs(item.at - best!.point[0]) < 90_000);
    return {
      x: frame.x(best.point[0]), title: moment(best.point[0]),
      lines: [
        { label: many ? `Context (chat ${best.chat + 1} of ${view.context.length})` : 'Context', value: compactTokens(best.point[1]), color: ROLE_COLOR.driver },
        ...(compaction ? [{ label: `Compacted${compaction.trigger ? ` (${compaction.trigger})` : ''}`, value: compaction.before ? `from ${compactTokens(compaction.before)}` : '' }] : []),
      ],
    };
  };
  return (
    <ChartSurface frame={frame} pick={pick} label={`Driver chat context size, peak ${compactTokens(peak)}`} stalls={view.stalls} named>
      <line x1={PAD.left} x2={width - PAD.right} y1={frame.y(view.resetTokens)} y2={frame.y(view.resetTokens)} stroke={COLOR.muted} strokeWidth={1} strokeDasharray="5 4" />
      <text x={width - PAD.right} y={frame.y(view.resetTokens) - 4} textAnchor="end" fontSize={10} fill={COLOR.muted}>{compactTokens(view.resetTokens)}: a supervised loop moves to a fresh chat</text>
      {view.context.map((series) => (
        <g key={series.thread}>
          <path fill="none" stroke={ROLE_COLOR.driver} strokeWidth={1.5} strokeDasharray="2 4" opacity={0.7} d={holdPath(series.points, frame)} />
          <path fill="none" stroke={ROLE_COLOR.driver} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" d={linePath(series.points, frame)} />
        </g>
      ))}
      {view.compactions.map((item) => {
        const x = frame.x(item.at); const y = frame.y(item.before ?? peak) - 4;
        return <path key={`${item.thread}:${item.at}`} d={`M${x - 5},${y - 8} L${x + 5},${y - 8} L${x},${y} Z`} fill={COLOR.muted} stroke={COLOR.card} strokeWidth={2} paintOrder="stroke"><title>Compacted {moment(item.at)}</title></path>;
      })}
    </ChartSurface>
  );
}

function CumulativeChart({ view, width, from, to, roles }: { view: UsageView; width: number; from: number; to: number; roles: UsageRole[] }) {
  const points = view.cumulative;
  const top = (point: (typeof points)[number]) => roles.reduce((sum, role) => sum + point[1 + ROLES.indexOf(role)], 0);
  const max = Math.max(1, ...points.map(top));
  const frame = makeFrame(width, 170, from, to, valueTicks(max).slice(-1)[0]);
  // Bands from the bottom (driver) up; each band's upper edge is the running sum.
  const bands = roles.map((role, index) => {
    const below = (point: (typeof points)[number]) => roles.slice(0, index).reduce((sum, item) => sum + point[1 + ROLES.indexOf(item)], 0);
    const upper = points.map((point) => `${frame.x(point[0]).toFixed(1)},${frame.y(below(point) + point[1 + ROLES.indexOf(role)]).toFixed(1)}`);
    const lower = [...points].reverse().map((point) => `${frame.x(point[0]).toFixed(1)},${frame.y(below(point)).toFixed(1)}`);
    return { role, d: `M${upper.join(' L')} L${lower.join(' L')} Z` };
  });
  const pick = (ms: number): Hover | undefined => {
    if (!points.length) return undefined;
    let point = points[0];
    for (const candidate of points) if (candidate[0] <= ms) point = candidate;
    return {
      x: frame.x(point[0]), title: `By ${moment(point[0])}`,
      lines: [...roles.map((role) => ({ label: ROLE_LABEL[role], value: compactTokens(point[1 + ROLES.indexOf(role)]), color: ROLE_COLOR[role] })), { label: 'Total', value: compactTokens(top(point)) }],
    };
  };
  return (
    <ChartSurface frame={frame} pick={pick} label={`Cumulative tokens by role, ${compactTokens(max)} in all`} stalls={view.stalls}>
      {bands.map((band) => <path key={band.role} d={band.d} fill={ROLE_COLOR[band.role]} fillOpacity={0.85} stroke={COLOR.card} strokeWidth={2} strokeLinejoin="round" />)}
    </ChartSurface>
  );
}

function Legend({ roles, view }: { roles: UsageRole[]; view: UsageView }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11, color: ink }}>
      {roles.map((role) => (
        <span key={role} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: ROLE_COLOR[role] }} />
          {ROLE_LABEL[role]} <span style={{ color: COLOR.muted, fontVariantNumeric: 'tabular-nums' }}>{compactTokens(tokensOf(view.byRole[role]))}</span>
        </span>
      ))}
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div style={{ flex: '1 1 110px', minWidth: 0, padding: '8px 10px', borderRadius: 6, background: COLOR.sunken, border: `1px solid ${COLOR.border}` }}>
      <div style={caption}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: ink }}>{value}</div>
      {detail && <div style={{ ...caption, marginTop: 2 }}>{detail}</div>}
    </div>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <div style={{ height: 8, borderRadius: 4, background: COLOR.sunken, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%`, height: '100%', borderRadius: 4, background: ROLE_COLOR.driver }} />
    </div>
  );
}

const cell: React.CSSProperties = { padding: '3px 6px', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const stageName = (stage: string) => stage.replace(/_/g, ' ');

export function UsageCard({ usage, span, onSpan, onShow }: { usage: UsageState | undefined; span: string | undefined; onSpan: (span: string) => void; onShow: (id: string) => void }) {
  const [ref, width] = useWidth();
  const view = usage?.view;
  const roles = useMemo(() => (view ? ROLES.filter((role) => tokensOf(view.byRole[role]) > 0) : []), [view]);
  const total = view ? tokensOf(view.total) : 0;
  const from = view?.from ? Date.parse(view.from) : 0;
  const to = view ? (view.to ? Date.parse(view.to) : Math.max(Date.now(), ...view.cumulative.map((point) => point[0]))) : 0;
  const chosen = view?.spans.find((item) => item.id === view.selected);
  const input = view ? view.total.fresh + view.total.cacheRead + view.total.cacheWrite : 0;
  const peak = view ? Math.max(0, ...view.context.flatMap((series) => series.points.map((point) => point[1]))) : 0;
  const quota = view?.quota;
  const stopped = view ? view.stalls.reduce((sum, stall) => sum + stall.to - stall.from, 0) : 0;
  const windowName = (minutes?: number) => (!minutes ? '' : minutes >= 1440 ? `${Math.round(minutes / 1440)}-day window` : `${Math.round(minutes / 60)}h window`);

  return (
    <section style={card} ref={ref}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Usage</h3>
        {view && view.spans.length > 0 && (
          <select value={span ?? view.selected} onChange={(event) => onSpan(event.target.value)} aria-label="Run or autonomous stretch"
            style={{ fontSize: 12, padding: '2px 4px', maxWidth: '100%', background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)', border: `1px solid var(--vscode-dropdown-border, ${COLOR.border})`, borderRadius: 4 }}>
            {view.spans.map((item) => <option key={item.id} value={item.id}>{spanText(item)}</option>)}
          </select>
        )}
        {view && view.providers.length > 0 && <span style={caption}>{view.providers.map((provider) => (provider === 'codex' ? 'Codex' : 'Claude Code')).join(' + ')}</span>}
        {quota && <span style={caption} title="Codex's own report, the latest in this stretch">· Codex limits {[quota.primary && `${windowName(quota.primary.windowMinutes).replace(' window', '')} ${quota.primary.usedPercent}%`, quota.secondary && `${windowName(quota.secondary.windowMinutes).replace(' window', '')} ${quota.secondary.usedPercent}%`].filter(Boolean).join(', ')}</span>}
      </div>
      {!usage && <div style={{ fontSize: 12, color: COLOR.muted }}>Reading the chat transcripts…</div>}
      {usage?.error && <div style={{ fontSize: 12, color: COLOR.muted }}>Usage could not be read: {usage.error}</div>}
      {view && !view.spans.length && <div style={{ fontSize: 12, color: COLOR.muted }}>No research loop run yet.</div>}
      {view && chosen && !total && (
        <div style={{ fontSize: 12, color: COLOR.muted }}>{view.chats.drivers ? 'No usage recorded in this stretch.' : 'No driver chat found for this stretch: its transcripts may be gone, or it ran before usage tracking.'}</div>
      )}
      {view && chosen && total > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tile label="Tokens" value={compactTokens(total)} detail={`${view.total.requests.toLocaleString()} requests · ${compactTokens(view.total.output)} output`} />
            <Tile label="Driver share" value={percent(tokensOf(view.byRole.driver) / total)} detail={`${view.chats.drivers} driver chat${view.chats.drivers === 1 ? '' : 's'} · ${view.chats.workers} worker${view.chats.workers === 1 ? '' : 's'}`} />
            <Tile label="Cache hit" value={percent(input ? view.total.cacheRead / input : 0)} detail={`${compactTokens(view.total.fresh)} fresh input`} />
            <Tile label="Peak driver context" value={compactTokens(peak)} detail={`${view.compactions.length} compaction${view.compactions.length === 1 ? '' : 's'}`} />
            {stopped > 0 && <Tile label="Stopped" value={duration(stopped)} detail={[...new Set(view.stalls.map((stall) => (stall.reason ? STALL_TEXT[stall.reason] : 'no activity')))].join(' · ')} />}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Driver chat context</div>
            <div style={{ ...caption, marginBottom: 4 }}>How much the driver chat sends with each request; a drop is a compaction (▼) or a fresh chat.</div>
            {view.context.length ? <ContextChart view={view} width={width} from={from} to={to} /> : <div style={caption}>No driver requests in this stretch.</div>}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Tokens over time</div>
            <div style={{ ...caption, marginBottom: 6 }}>Cumulative, by who used them. Cache reads count here; they cost far less than fresh input.</div>
            <Legend roles={roles} view={view} />
            <CumulativeChart view={view} width={width} from={from} to={to} roles={roles} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>By stage</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ ...caption, textAlign: 'left' }}><th style={cell}>Stage</th><th style={{ ...cell, width: '40%' }}>Share</th><th style={{ ...cell, textAlign: 'right' }}>Tokens</th><th style={{ ...cell, textAlign: 'right' }}>Requests</th></tr></thead>
                <tbody>
                  {view.stages.map((stage) => (
                    <tr key={stage.stage} style={{ borderTop: `1px solid ${COLOR.border}` }}>
                      <td style={cell}>{stageName(stage.stage)}</td>
                      <td style={cell} title={percent(stage.share)}><ShareBar share={stage.share} /></td>
                      <td style={{ ...cell, textAlign: 'right' }}>{compactTokens(stage.tokens)}</td>
                      <td style={{ ...cell, textAlign: 'right', color: COLOR.muted }}>{stage.requests.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>By role</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ ...caption, textAlign: 'left' }}><th style={cell}>Role</th><th style={{ ...cell, textAlign: 'right' }}>Tokens</th><th style={{ ...cell, textAlign: 'right' }}>Share</th><th style={{ ...cell, textAlign: 'right' }}>Output</th></tr></thead>
                <tbody>
                  {roles.map((role) => (
                    <tr key={role} style={{ borderTop: `1px solid ${COLOR.border}` }}>
                      <td style={cell}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: ROLE_COLOR[role], marginRight: 6 }} />{ROLE_LABEL[role]}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{compactTokens(tokensOf(view.byRole[role]))}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{percent(tokensOf(view.byRole[role]) / total)}</td>
                      <td style={{ ...cell, textAlign: 'right', color: COLOR.muted }}>{compactTokens(view.byRole[role].output)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.assets.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 4px' }}>Results that used the most</div>
                  <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {view.assets.map((asset) => (
                      <li key={asset.id} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
                        <button onClick={() => onShow(asset.id)} title={`${asset.title} (${asset.id})`} style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>
                          <span style={{ display: 'block', color: COLOR.link, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.title}</span>
                          {/* Results with the same opening words (successive versions) are told apart by their ids. */}
                          <span style={{ ...caption, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{asset.id}</span>
                        </button>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{compactTokens(asset.tokens)}</span>
                        <span style={{ ...caption, width: 32, textAlign: 'right' }}>{percent(asset.share)}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {view && view.problems.length > 0 && <div style={{ ...caption, marginTop: 10 }}>{view.problems.slice(0, 3).join(' ')}{view.problems.length > 3 ? ` (${view.problems.length - 3} more)` : ''}</div>}
    </section>
  );
}
