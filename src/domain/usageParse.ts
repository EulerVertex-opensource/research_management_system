/**
 * Token usage read from the agents' own chat transcripts (Claude Code and
 * Codex JSONL), one line at a time so a transcript is read incrementally.
 *
 * Normalized to four kinds: fresh input, cache reads, cache writes, output.
 * Claude Code writes one line per content block, each repeating the message's
 * usage, so a message counts once (by id). Codex reports a running total per
 * thread (its own usage only; subagents are threads of their own), so a
 * request counts as the growth of that total. Usage is bucketed per minute.
 */

export type TranscriptKind = 'claude' | 'codex';

/** [minute (ms since epoch), fresh, cacheRead, cacheWrite, output, requests, largest context seen (tokens)]. */
export type UsageMinute = [number, number, number, number, number, number, number];

export interface UsageCompaction { at: number; trigger?: string; before?: number; after?: number }
/** A turn that ended on an error (a usage limit, a failed compaction): the chat stops until someone writes to it. */
export interface UsageStop { at: number; message: string }

export interface QuotaWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number }
/** Codex's own rate-limit report, the latest seen. */
export interface UsageQuota { at: number; primary?: QuotaWindow; secondary?: QuotaWindow }

export interface FileUsage {
  kind: TranscriptKind;
  /** Bytes consumed so far: the next read starts here (always at a line start). */
  offset: number;
  minutes: UsageMinute[];
  compactions: UsageCompaction[];
  stops?: UsageStop[];
  quota?: UsageQuota;
  /** Claude: the last messages counted, [id, fresh, cacheRead, cacheWrite, output], to skip their repeated lines. */
  recent?: Array<[string, number, number, number, number]>;
  /** Codex: the thread's running total so far, [input (cached included), cached, cacheWrite, output]. */
  totals?: [number, number, number, number];
  /** Codex: the latest request's context, for a compaction's "before". */
  lastContext?: number;
}

const RECENT_KEPT = 64;
const MINUTE = 60_000;

export function emptyFileUsage(kind: TranscriptKind): FileUsage {
  return { kind, offset: 0, minutes: [], compactions: [] };
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function timeOf(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function add(usage: FileUsage, at: number, fresh: number, cacheRead: number, cacheWrite: number, output: number, requests: number, context: number): void {
  const minute = Math.floor(at / MINUTE) * MINUTE;
  const list = usage.minutes;
  let index = list.length - 1;
  // Lines arrive in time order; a late one finds its bucket from the end.
  while (index >= 0 && list[index][0] > minute) index -= 1;
  let bucket = index >= 0 && list[index][0] === minute ? list[index] : undefined;
  if (!bucket) { bucket = [minute, 0, 0, 0, 0, 0, 0]; list.splice(index + 1, 0, bucket); }
  bucket[1] += fresh; bucket[2] += cacheRead; bucket[3] += cacheWrite; bucket[4] += output; bucket[5] += requests;
  bucket[6] = Math.max(bucket[6], context);
}

/** Consume one complete transcript line. `mainChain`: a chat's own transcript, whose sidechain lines (if any) are not its own. */
export function consumeLine(usage: FileUsage, line: string, mainChain = true): void {
  if (usage.kind === 'claude') consumeClaude(usage, line, mainChain);
  else consumeCodex(usage, line);
}

const STOP_MESSAGE_CHARS = 200;
function addStop(usage: FileUsage, at: number, message: unknown): void {
  const text = typeof message === 'string' ? message.trim() : '';
  (usage.stops ??= []).push({ at, message: (text || 'The turn ended on an error.').slice(0, STOP_MESSAGE_CHARS) });
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return undefined; }
}

function consumeClaude(usage: FileUsage, line: string, mainChain: boolean): void {
  if (line.includes('"compact_boundary"')) {
    const record = parse(line);
    const at = timeOf(record?.timestamp);
    if (record?.subtype === 'compact_boundary' && at !== undefined) {
      const meta = record.compactMetadata ?? {};
      usage.compactions.push({ at, ...(typeof meta.trigger === 'string' ? { trigger: meta.trigger } : {}), ...(num(meta.preTokens) ? { before: meta.preTokens } : {}), ...(num(meta.postTokens) ? { after: meta.postTokens } : {}) });
    }
    return;
  }
  if (!line.includes('"type":"assistant"')) return;
  const record = parse(line);
  if (record?.type !== 'assistant' || (mainChain && record.isSidechain)) return;
  const message = record.message ?? {};
  // The error that ended a turn (retries are logged as system api_error lines and are not stops).
  if (record.isApiErrorMessage === true) {
    const at = timeOf(record.timestamp);
    const content = Array.isArray(message.content) ? message.content.find((block: any) => typeof block?.text === 'string')?.text : undefined;
    if (at !== undefined) addStop(usage, at, content ?? record.error);
    return;
  }
  const raw = message.usage;
  const at = timeOf(record.timestamp);
  if (!raw || at === undefined || message.model === '<synthetic>') return;
  const fresh = num(raw.input_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  const output = num(raw.output_tokens);
  const id = typeof message.id === 'string' ? message.id : undefined;
  const recent = usage.recent ?? (usage.recent = []);
  const seen = id ? recent.find((entry) => entry[0] === id) : undefined;
  if (seen) {
    // A repeated line of a message already counted: only what grew since.
    const grew = [Math.max(0, fresh - seen[1]), Math.max(0, cacheRead - seen[2]), Math.max(0, cacheWrite - seen[3]), Math.max(0, output - seen[4])];
    if (grew.some(Boolean)) add(usage, at, grew[0], grew[1], grew[2], grew[3], 0, fresh + cacheRead + cacheWrite);
    seen[1] = Math.max(seen[1], fresh); seen[2] = Math.max(seen[2], cacheRead); seen[3] = Math.max(seen[3], cacheWrite); seen[4] = Math.max(seen[4], output);
    return;
  }
  add(usage, at, fresh, cacheRead, cacheWrite, output, 1, fresh + cacheRead + cacheWrite);
  if (id) { recent.push([id, fresh, cacheRead, cacheWrite, output]); if (recent.length > RECENT_KEPT) recent.splice(0, recent.length - RECENT_KEPT); }
}

const CODEX_COMPACTED = /^\{"timestamp":"([^"]+)"(?:,"ordinal":\d+)?,"type":"compacted"/;

function window(raw: any): QuotaWindow | undefined {
  if (!raw || typeof raw.used_percent !== 'number') return undefined;
  return { usedPercent: raw.used_percent, ...(num(raw.window_minutes) ? { windowMinutes: raw.window_minutes } : {}), ...(num(raw.resets_at) ? { resetsAt: raw.resets_at } : {}) };
}

function consumeCodex(usage: FileUsage, line: string): void {
  const compacted = CODEX_COMPACTED.exec(line.slice(0, 200));
  if (compacted) {
    const at = timeOf(compacted[1]);
    if (at !== undefined) usage.compactions.push({ at, ...(usage.lastContext ? { before: usage.lastContext } : {}) });
    return;
  }
  if (line.includes('"task_complete"') && line.includes('"error":{')) {
    const record = parse(line);
    const at = timeOf(record?.timestamp);
    if (record?.payload?.type === 'task_complete' && record.payload.error && at !== undefined) addStop(usage, at, record.payload.error.message);
    return;
  }
  if (!line.includes('"token_count"')) return;
  const record = parse(line);
  const payload = record?.payload;
  const at = timeOf(record?.timestamp);
  if (record?.type !== 'event_msg' || payload?.type !== 'token_count' || at === undefined) return;
  const limits = payload.rate_limits;
  if (limits && (!usage.quota || usage.quota.at <= at)) {
    const primary = window(limits.primary);
    const secondary = window(limits.secondary);
    if (primary || secondary) usage.quota = { at, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  }
  const total = payload.info?.total_token_usage;
  if (!total) return;
  const now: [number, number, number, number] = [num(total.input_tokens), num(total.cached_input_tokens), num(total.cache_write_input_tokens), num(total.output_tokens)];
  const before = usage.totals ?? [0, 0, 0, 0];
  usage.totals = now;
  const grew = now.map((value, index) => Math.max(0, value - before[index]));
  const context = num(payload.info?.last_token_usage?.input_tokens);
  if (context) usage.lastContext = context;
  if (!grew.some(Boolean)) return;
  // Codex counts cached and cache-write tokens inside input_tokens.
  add(usage, at, Math.max(0, grew[0] - grew[1] - grew[2]), grew[1], grew[2], grew[3], 1, context);
}
