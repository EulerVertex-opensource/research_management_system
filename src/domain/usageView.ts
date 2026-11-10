import { USAGE_ROLES, UsageRole, UsageSpan, UsageStopReason, UsageTotals, UsageView, tokensOf } from '../models/usage';
import { TranscriptKind, UsageCompaction, UsageMinute, UsageQuota, UsageStop } from './usageParse';

/**
 * The Usage card from the loop's events and its chats' usage: which stretch
 * (a run, or an autonomous stretch of one), which chats worked in it (the
 * driver chats and their workers), and where the tokens went (by role, by
 * stage, by result). Pure; the collector reads the transcripts.
 */

type LoopEvent = Record<string, unknown>;

/** One chat's usage: a driver chat, or a worker it started. */
export interface UsageThread {
  id: string;
  provider: TranscriptKind;
  role: UsageRole;
  /** A worker's driver chat. */
  parent?: string;
  label?: string;
  minutes: UsageMinute[];
  compactions: UsageCompaction[];
  stops?: UsageStop[];
  quota?: UsageQuota;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const timeOf = (value: unknown) => { const at = Date.parse(text(value)); return Number.isFinite(at) ? at : undefined; };

/** Runs, and the autonomous stretches inside them, newest first. */
export function usageSpans(events: LoopEvent[]): UsageSpan[] {
  const runs = new Map<string, { from: string; to?: string; provider?: string; autonomous: UsageSpan[]; open?: UsageSpan }>();
  for (const event of events) {
    const runId = text(event.runId);
    const at = text(event.at);
    if (!runId || timeOf(at) === undefined) continue;
    let run = runs.get(runId);
    if (!run) { run = { from: at, autonomous: [] }; runs.set(runId, run); }
    if (event.type === 'started' && text(event.provider)) run.provider = text(event.provider);
    if (event.type === 'stopped') { run.to = at; if (run.open) { run.open.to = at; run.open = undefined; } }
    if (event.type === 'resumed' && run.to) run.to = undefined;
    if (event.type === 'autonomy_started' && !run.open) { run.open = { id: `auto:${runId}:${at}`, kind: 'autonomous', runId, from: at }; run.autonomous.push(run.open); }
    if ((event.type === 'autonomy_handover' || event.type === 'autonomy_off') && run.open) { run.open.to = at; run.open = undefined; }
  }
  const ordered = [...runs.entries()].sort((a, b) => a[1].from.localeCompare(b[1].from));
  const groups: UsageSpan[][] = ordered.map(([runId, run], index) => {
    // A run that was never stopped ends where the next one starts.
    const to = run.to ?? ordered[index + 1]?.[1].from;
    for (const stretch of run.autonomous) if (!stretch.to && to) stretch.to = to;
    const provider = run.provider ? { provider: run.provider } : {};
    return [{ id: `run:${runId}`, kind: 'run', runId, from: run.from, ...(to ? { to } : {}), ...provider }, ...[...run.autonomous].reverse().map((stretch) => ({ ...stretch, ...provider }))];
  });
  return groups.reverse().flat();
}

const zero = (): UsageTotals => ({ fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 });
function addMinute(totals: UsageTotals, minute: UsageMinute): void {
  totals.fresh += minute[1]; totals.cacheRead += minute[2]; totals.cacheWrite += minute[3]; totals.output += minute[4]; totals.requests += minute[5];
}
const minuteTokens = (minute: UsageMinute) => minute[1] + minute[2] + minute[3] + minute[4];

/** The latest entry at or before `at` in a list sorted by time. */
function latestAt<T extends { at: number }>(list: T[], at: number): T | undefined {
  let low = 0; let high = list.length - 1; let found: T | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (list[middle].at <= at) { found = list[middle]; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/** At most `limit` points, keeping each bucket's largest value. */
function thin(points: Array<[number, number]>, limit: number): Array<[number, number]> {
  if (points.length <= limit) return points;
  const from = points[0][0]; const span = points[points.length - 1][0] - from || 1;
  const buckets = new Map<number, [number, number]>();
  for (const point of points) {
    const key = Math.min(limit - 1, Math.floor(((point[0] - from) / span) * limit));
    const kept = buckets.get(key);
    if (!kept || point[1] > kept[1]) buckets.set(key, point);
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
}

/** No request from any chat for this long is a stall worth showing. */
export const STALL_MS = 30 * 60_000;

/** What an agent's error message says stopped it. */
export function stopReason(message: string): UsageStopReason {
  if (/usage limit|session limit|rate limit|weekly limit|quota/i.test(message)) return 'usage limit';
  if (/compact/i.test(message)) return 'compaction failed';
  return 'error';
}

export const CONTEXT_POINTS = 400;
export const CUMULATIVE_POINTS = 240;
const ASSETS_SHOWN = 6;

export interface UsageViewInput {
  events: LoopEvent[];
  threads: UsageThread[];
  /** The span to show; the newest when absent or unknown. */
  span?: string;
  now: number;
  resetTokens: number;
  title?: (id: string) => string;
  problems?: string[];
}

export function buildUsageView(input: UsageViewInput): UsageView {
  const spans = usageSpans(input.events);
  const chosen = spans.find((span) => span.id === input.span) ?? spans[0];
  const byRole = Object.fromEntries(USAGE_ROLES.map((role) => [role, zero()])) as Record<UsageRole, UsageTotals>;
  const view: UsageView = { spans, total: zero(), byRole, context: [], compactions: [], cumulative: [], stages: [], assets: [], resetTokens: input.resetTokens, chats: { drivers: 0, workers: 0 }, providers: [], stalls: [], problems: input.problems ?? [] };
  if (!chosen) return view;
  const from = timeOf(chosen.from)!;
  const to = chosen.to ? timeOf(chosen.to)! : input.now;
  Object.assign(view, { selected: chosen.id, from: chosen.from, ...(chosen.to ? { to: chosen.to } : {}) });
  // A minute bucket counts when it overlaps the stretch.
  const inside = (at: number) => at + 60_000 > from && at <= to;

  const stages = input.events
    .filter((event) => event.type === 'stage' && text(event.runId) === chosen.runId && timeOf(event.at) !== undefined)
    .map((event) => ({ at: timeOf(event.at)!, stage: text(event.stage) || 'other', assetId: text(event.assetId) }))
    .sort((a, b) => a.at - b.at);

  const drivers = input.threads.filter((thread) => thread.role === 'driver' && thread.minutes.some((minute) => inside(minute[0])));
  const driverIds = new Set(drivers.map((thread) => thread.id));
  const workers = input.threads.filter((thread) => thread.role !== 'driver' && thread.parent && driverIds.has(thread.parent) && thread.minutes.some((minute) => inside(minute[0])));
  view.chats = { drivers: drivers.length, workers: workers.length };
  view.providers = [...new Set(drivers.map((thread) => thread.provider))].sort();

  const stageTotals = new Map<string, { tokens: number; requests: number }>();
  const assetTokens = new Map<string, number>();
  const timeline: Array<[number, UsageRole, number]> = [];
  for (const thread of [...drivers, ...workers]) {
    for (const minute of thread.minutes) {
      if (!inside(minute[0])) continue;
      addMinute(view.total, minute);
      addMinute(byRole[thread.role], minute);
      const tokens = minuteTokens(minute);
      const stage = latestAt(stages, minute[0]);
      const name = stage?.stage ?? 'other';
      const entry = stageTotals.get(name) ?? { tokens: 0, requests: 0 };
      entry.tokens += tokens; entry.requests += minute[5];
      stageTotals.set(name, entry);
      if (stage?.assetId) assetTokens.set(stage.assetId, (assetTokens.get(stage.assetId) ?? 0) + tokens);
      timeline.push([minute[0], thread.role, tokens]);
    }
    if (thread.quota && inside(thread.quota.at) && (!view.quota || view.quota.at < thread.quota.at)) view.quota = thread.quota;
  }

  for (const thread of drivers) {
    const points = thread.minutes.filter((minute) => inside(minute[0]) && minute[6] > 0).map((minute): [number, number] => [minute[0], minute[6]]);
    if (points.length) view.context.push({ thread: thread.id, provider: thread.provider, points: thin(points, CONTEXT_POINTS) });
    for (const compaction of thread.compactions) if (compaction.at >= from && compaction.at <= to) view.compactions.push({ thread: thread.id, ...compaction });
  }
  view.compactions.sort((a, b) => a.at - b.at);

  // Stalls: gaps between requests (any chat of the stretch), explained by the error that ended a turn just before.
  const active = [...new Set(timeline.map((entry) => entry[0]))].sort((a, b) => a - b);
  const stops = [...drivers, ...workers].flatMap((thread) => (thread.stops ?? []).map((stop) => ({ ...stop, driver: thread.role === 'driver' })))
    .filter((stop) => stop.at >= from && stop.at <= to).sort((a, b) => a.at - b.at);
  const explain = (start: number, end: number) => {
    const inside = stops.filter((stop) => stop.at >= start - 2 * 60_000 && stop.at < end);
    const stop = inside.filter((item) => item.driver).pop() ?? inside.pop();
    return stop ? { reason: stopReason(stop.message), message: stop.message } : {};
  };
  for (let i = 1; i < active.length; i += 1) {
    const start = active[i - 1] + 60_000;
    if (active[i] - start >= STALL_MS) view.stalls.push({ from: start, to: active[i], ...explain(start, active[i]) });
  }
  // A stretch that ends stopped on an error: the stall runs to its end.
  if (active.length) {
    const start = active[active.length - 1] + 60_000;
    const tail = explain(start, to + 1);
    if (tail.reason && to - start >= STALL_MS) view.stalls.push({ from: start, to, ...tail });
  }

  const total = tokensOf(view.total) || 1;
  view.stages = [...stageTotals.entries()].map(([stage, entry]) => ({ stage, tokens: entry.tokens, share: entry.tokens / total, requests: entry.requests })).sort((a, b) => b.tokens - a.tokens);
  view.assets = [...assetTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, ASSETS_SHOWN).map(([id, tokens]) => ({ id, title: input.title?.(id) ?? id, tokens, share: tokens / total }));

  // Cumulative by role, in at most CUMULATIVE_POINTS steps across the stretch.
  timeline.sort((a, b) => a[0] - b[0]);
  if (timeline.length) {
    const start = Math.min(from, timeline[0][0]);
    const end = Math.max(start + 60_000, Math.min(to, timeline[timeline.length - 1][0] + 60_000));
    const step = (end - start) / CUMULATIVE_POINTS;
    const running = [0, 0, 0, 0];
    let index = 0;
    view.cumulative.push([start, 0, 0, 0, 0]);
    for (let i = 1; i <= CUMULATIVE_POINTS; i += 1) {
      const until = start + step * i;
      let moved = false;
      while (index < timeline.length && timeline[index][0] < until) { running[USAGE_ROLES.indexOf(timeline[index][1])] += timeline[index][2]; index += 1; moved = true; }
      if (moved || i === CUMULATIVE_POINTS) view.cumulative.push([Math.round(until), running[0], running[1], running[2], running[3]]);
    }
  }
  return view;
}

const compact = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${Math.round(tokens / 1e3)}K` : String(Math.round(tokens)));
const percent = (share: number) => `${Math.round(share * 100)}%`;
const pad = (value: number) => String(value).padStart(2, '0');
/** Local time to the minute: "2026-11-08 22:10". */
const minuteText = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? iso : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`; };

const agentName = (provider: string) => (provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : provider);
const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

/** A span in a line: "run 2026-11-08 22:10 → 2026-11-09 06:30". */
export function spanLabel(span: UsageSpan): string {
  return `${span.kind === 'autonomous' ? 'autonomous' : 'run'} ${minuteText(span.from)} → ${span.to ? minuteText(span.to) : 'now'}`;
}

/** The view as text for the terminal (research-loop usage). */
export function usageText(view: UsageView): string {
  const span = view.spans.find((item) => item.id === view.selected);
  if (!span) return 'No research loop run yet.';
  const total = tokensOf(view.total);
  const lines = [`Usage: ${spanLabel(span)} [${span.id}]`];
  if (!total) {
    lines.push(view.chats.drivers ? 'No usage recorded in this stretch.' : 'No driver chat found for this stretch (its transcripts may be gone, or it predates usage tracking).');
  } else {
    const input = view.total.fresh + view.total.cacheRead + view.total.cacheWrite;
    lines.push(`Total ${compact(total)} tokens in ${view.total.requests} requests: ${compact(view.total.fresh)} fresh input, ${compact(view.total.cacheRead)} cache reads, ${compact(view.total.cacheWrite)} cache writes, ${compact(view.total.output)} output (cache hit ${percent(input ? view.total.cacheRead / input : 0)}).`);
    lines.push(`Chats: ${view.chats.drivers} driver, ${view.chats.workers} worker${view.providers.length ? ` (${view.providers.map(agentName).join(' and ')})` : ''}.`);
    if (view.stalls.length) lines.push('Stopped: ' + view.stalls.map((stall) => `${hours(stall.to - stall.from)} from ${minuteText(new Date(stall.from).toISOString())}${stall.reason ? ` after ${stall.reason === 'error' ? `an error (${stall.message})` : `a ${stall.reason === 'usage limit' ? 'usage limit' : 'failed compaction'}`}` : ' (no activity)'}`).join('; ') + '.');
    lines.push('By role: ' + (Object.entries(view.byRole) as Array<[string, UsageTotals]>).filter(([, totals]) => tokensOf(totals)).map(([role, totals]) => `${role} ${compact(tokensOf(totals))} (${percent(tokensOf(totals) / total)})`).join(', '));
    lines.push('By stage: ' + view.stages.map((stage) => `${stage.stage} ${compact(stage.tokens)} (${percent(stage.share)})`).join(', '));
    if (view.assets.length) lines.push('Top results: ' + view.assets.map((asset) => `${asset.id} ${compact(asset.tokens)}`).join(', '));
    const peaks = view.context.map((series) => Math.max(...series.points.map((point) => point[1])));
    if (peaks.length) lines.push(`Driver context: peak ${compact(Math.max(...peaks))}; ${view.compactions.length} compaction(s)${view.compactions.length ? ` (${view.compactions.map((item) => `${minuteText(new Date(item.at).toISOString())}${item.before ? ` at ${compact(item.before)}` : ''}`).join(', ')})` : ''}.`);
  }
  const quota = view.quota;
  if (quota) lines.push(`Codex limits: ${[quota.primary && `${quota.primary.usedPercent}% of the ${quota.primary.windowMinutes ? `${Math.round(quota.primary.windowMinutes / 60)}h` : 'short'} window`, quota.secondary && `${quota.secondary.usedPercent}% of the ${quota.secondary.windowMinutes ? `${Math.round(quota.secondary.windowMinutes / 1440)}-day` : 'long'} window`].filter(Boolean).join(', ')}.`);
  for (const problem of view.problems) lines.push(`Note: ${problem}`);
  return lines.join('\n');
}
