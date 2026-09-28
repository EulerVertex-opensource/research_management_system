import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { LoopState, STATE_DIR, stageSignature } from './ResearchLoopModel';

/** Hook stdin shape shared by Claude Code and Codex. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  prompt?: string;
}

export interface StopDecision { block: boolean; reason?: string; capReached?: boolean }
export interface ToolDecision { deny: boolean; reason?: string }

const APPROVED = /^[+>\s]*status:\s*['"]?approved\b/m;

/** Decide whether the Stop hook keeps the agent working. Pure; the caller persists any counter changes. */
export function stopDecision(state: LoopState | undefined, input: HookInput, instruction: string | undefined): StopDecision {
  if (!state || state.status !== 'running') return { block: false };
  if (state.pendingQuestion) return { block: false };
  if (state.stage === 'waiting' || state.stage === 'ready') return { block: false };
  const session = input.session_id ?? 'unknown';
  const record = state.autopilot.sessions[session] ?? { blocks: 0, lastSignature: '', lastBlockAt: '' };
  if (record.blocks >= state.autopilot.iterationCap) return { block: false, capReached: true };
  if (input.stop_hook_active && record.lastSignature === stageSignature(state)) return { block: false };
  const reason = `Research loop is running (stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}). Continue: run research-loop next and follow it. ${instruction ?? ''}`.trim();
  return { block: true, reason };
}

function targetsOf(input: HookInput): string[] {
  const tool = input.tool_input ?? {};
  const targets: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path']) if (typeof tool[key] === 'string') targets.push(tool[key] as string);
  const patch = typeof tool.patch === 'string' ? tool.patch : typeof tool.input === 'string' ? tool.input : '';
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete|Move to) File: (.+)$/gm)) targets.push(match[1].trim());
  const command = typeof tool.command === 'string' ? tool.command : Array.isArray(tool.command) ? tool.command.join(' ') : '';
  for (const match of command.matchAll(/[\w./-]+\.(?:md|json|jsonl)\b/g)) targets.push(match[0]);
  return targets;
}

function textsOf(input: HookInput): string {
  const tool = input.tool_input ?? {};
  const parts: string[] = [];
  for (const key of ['content', 'new_string', 'patch', 'input', 'command', 'new_source']) if (typeof tool[key] === 'string') parts.push(tool[key] as string);
  if (Array.isArray(tool.edits)) for (const edit of tool.edits as Array<Record<string, unknown>>) if (typeof edit.new_string === 'string') parts.push(edit.new_string);
  if (Array.isArray(tool.command)) parts.push(tool.command.join(' '));
  return parts.join('\n');
}

function under(target: string, folder: string, root?: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  const relative = root && normalized.startsWith(root.replace(/\\/g, '/') + '/') ? normalized.slice(root.length + 1) : normalized;
  return relative === folder || relative.startsWith(`${folder}/`) || relative.includes(`/${folder}/`);
}

/** Deny agent writes that would forge an approval or touch loop-internal files. */
export function preToolUseDecision(paths: ProjectPaths, input: HookInput, root?: string): ToolDecision {
  const tool = (input.tool_name ?? '').toLowerCase();
  const writes = /write|edit|patch|shell|bash|notebook/.test(tool);
  if (!writes) return { deny: false };
  const targets = targetsOf(input);
  const text = textsOf(input);
  const approvalsFile = path.posix.join(paths.researchRoot, 'approvals.json');
  const isShell = /shell|bash/.test(tool);
  const shellWrites = !isShell || /(?:^|[^<])>|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bpython|\bnode\b|\bperl\b/.test(text);
  for (const target of targets) {
    if (shellWrites && (under(target, approvalsFile, root) || target.endsWith('/approvals.json') || under(target, STATE_DIR, root))) {
      return { deny: true, reason: `Research loop: ${target} is written only by the researcher through the extension. Approvals are never set by the agent.` };
    }
    if ((under(target, paths.assets, root) || under(target, paths.definitions, root)) && APPROVED.test(text)) {
      return { deny: true, reason: `Research loop: ${target} may not be set to status: approved by the agent. Leave it draft and call request_approval so the researcher can approve it.` };
    }
  }
  if (isShell && shellWrites && /status:\s*['"]?approved/.test(text) && (text.includes(paths.assets) || text.includes(paths.definitions))) {
    return { deny: true, reason: 'Research loop: shell commands may not set status: approved on assets or definitions.' };
  }
  return { deny: false };
}
