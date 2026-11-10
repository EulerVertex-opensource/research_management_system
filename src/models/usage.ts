/** The Activity page's Usage card: token usage of the loop's chats and their workers, from the agents' transcripts. */

export type UsageRole = 'driver' | 'light' | 'deep' | 'other';
export const USAGE_ROLES: UsageRole[] = ['driver', 'light', 'deep', 'other'];

export interface UsageTotals { fresh: number; cacheRead: number; cacheWrite: number; output: number; requests: number }

/** A stretch to look at: a whole run, or one autonomous stretch of it. */
export interface UsageSpan {
  id: string;
  kind: 'run' | 'autonomous';
  runId: string;
  from: string;
  /** Absent while it goes on. */
  to?: string;
  provider?: string;
}

export type UsageStopReason = 'usage limit' | 'compaction failed' | 'error';

export interface UsageQuotaWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number }

export interface UsageView {
  /** Newest first; autonomous stretches follow their run. */
  spans: UsageSpan[];
  selected?: string;
  from?: string;
  to?: string;
  total: UsageTotals;
  byRole: Record<UsageRole, UsageTotals>;
  /** The driver chats' context size: one series per chat, [ms, tokens]. */
  context: Array<{ thread: string; provider: string; points: Array<[number, number]> }>;
  compactions: Array<{ at: number; thread: string; trigger?: string; before?: number; after?: number }>;
  /** Cumulative tokens over time: [ms, driver, light, deep, other]. */
  cumulative: Array<[number, number, number, number, number]>;
  stages: Array<{ stage: string; tokens: number; share: number; requests: number }>;
  assets: Array<{ id: string; title: string; tokens: number; share: number }>;
  /** Codex's own rate-limit report, the latest in this stretch. */
  quota?: { at: number; primary?: UsageQuotaWindow; secondary?: UsageQuotaWindow };
  /** Where a non-autonomous loop moves to a fresh chat. */
  resetTokens: number;
  chats: { drivers: number; workers: number };
  /** The agents that drove this stretch ('claude', 'codex'), from its driver chats. */
  providers: string[];
  /**
   * Stretches with no request from any of its chats for a while: after a turn
   * ended on an error (`reason`, with the agent's own `message`), or for no
   * recorded reason (waiting on the researcher, a long tool call, a closed chat).
   */
  stalls: Array<{ from: number; to: number; reason?: UsageStopReason; message?: string }>;
  /** Transcripts that could not be found or read. */
  problems: string[];
}

export const tokensOf = (totals: UsageTotals) => totals.fresh + totals.cacheRead + totals.cacheWrite + totals.output;
