import { AGENT_PATH, LoopFiles } from './ResearchLoopModel';

/**
 * Whether an agent is driving the loop right now. Written only from the
 * agent's side (its hooks, the CLI it runs, the MCP bridge it calls), never by
 * the extension, so the extension's own saves (a researcher's edit, a setting,
 * an approval) cannot look like agent work. Kept apart from state.json so a
 * write on every tool call neither races the loop's state nor redraws the
 * dashboard. Shared by the extension and the CLI; must not import vscode.
 */
export interface AgentActivity {
  /** `open`: the agent is in a turn; `ended`: it handed control back (Stop without continuing, or its chat session ended). */
  turn: 'open' | 'ended';
  /** The agent's last sign of life, or when its turn ended. */
  at: string;
  sessionId?: string;
  endedBy?: 'stop' | 'session_end';
  /** A shell command in flight, bracketed by PreToolUse and PostToolUse: a long computation is not silence. */
  tool?: { name: string; startedAt: string };
}

export type AgentSignal =
  | { kind: 'active'; sessionId?: string; tool?: { name: string; phase: 'start' | 'end' }; throttle?: boolean }
  | { kind: 'ended'; by: 'stop' | 'session_end'; sessionId?: string };

/** Tool hooks fire on every call; within this window an unchanged open turn is not rewritten. */
export const ACTIVITY_THROTTLE_MS = 30_000;

export function parseAgentActivity(text: string | undefined): AgentActivity | undefined {
  if (!text?.trim()) return undefined;
  try {
    const value = JSON.parse(text) as Partial<AgentActivity>;
    if ((value.turn !== 'open' && value.turn !== 'ended') || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return undefined;
    return value as AgentActivity;
  } catch { return undefined; }
}

export async function readAgentActivity(files: LoopFiles): Promise<AgentActivity | undefined> {
  return parseAgentActivity(await files.readFile(AGENT_PATH).catch(() => undefined));
}

/** The record after a signal, or undefined when nothing needs writing. Pure. */
export function nextAgentActivity(previous: AgentActivity | undefined, signal: AgentSignal, now: string): AgentActivity | undefined {
  const sessionId = signal.sessionId ?? previous?.sessionId;
  if (signal.kind === 'ended') {
    // Another chat closing says nothing about the session that drives the loop.
    if (signal.by === 'session_end' && previous?.sessionId && signal.sessionId && previous.sessionId !== signal.sessionId) return undefined;
    return { turn: 'ended', at: now, endedBy: signal.by, ...(sessionId ? { sessionId } : {}) };
  }
  const tool = signal.tool?.phase === 'start' ? { name: signal.tool.name, startedAt: now }
    : signal.tool?.phase === 'end' ? undefined
    : previous?.turn === 'open' ? previous.tool : undefined;
  if (signal.throttle && previous?.turn === 'open' && previous.sessionId === sessionId && !signal.tool
    && Date.parse(now) - Date.parse(previous.at) < ACTIVITY_THROTTLE_MS) return undefined;
  return { turn: 'open', at: now, ...(sessionId ? { sessionId } : {}), ...(tool ? { tool } : {}) };
}

/** Record a signal from the agent's side; best effort, never fails the caller. */
export async function noteAgentActivity(files: LoopFiles, signal: AgentSignal, now = new Date().toISOString()): Promise<void> {
  try {
    const next = nextAgentActivity(await readAgentActivity(files), signal, now);
    if (next) await files.writeFile(AGENT_PATH, JSON.stringify(next) + '\n');
  } catch { /* liveness is advisory */ }
}
