import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { LoopState, STATE_DIR, sharedFolders, stageSignature } from './ResearchLoopModel';
import { LOOP_COMMAND } from './AgentProviders';

/** Hook stdin shape shared by Claude Code and Codex. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  prompt?: string;
  /** SessionStart: startup | resume | clear | compact. */
  source?: string;
}

export interface StopDecision { block: boolean; reason?: string; capReached?: boolean }
export interface ToolDecision { deny: boolean; reason?: string }

const APPROVED = /^[+>\s]*status:\s*['"]?approved\b/m;
/** Git commands that rewrite or share history; the loop's sync commands run them with validation around them. */
const RAW_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:pull|push|rebase|merge|reset\s+--hard|cherry-pick)\b/;

/** Decide whether the Stop hook keeps the agent working. Pure; the caller persists any counter changes. */
export function stopDecision(state: LoopState | undefined, input: HookInput, instruction: string | undefined): StopDecision {
  if (!state || state.status !== 'running') return { block: false };
  if (state.pendingQuestion) return { block: false };
  // review_project waits on the researcher's approval just like waiting; pushing the agent there only burns turns.
  if (state.stage === 'waiting' || state.stage === 'ready' || state.stage === 'review_project') return { block: false };
  const session = input.session_id ?? 'unknown';
  const record = state.autopilot.sessions[session] ?? { blocks: 0, lastSignature: '', lastBlockAt: '' };
  if (record.blocks >= state.autopilot.iterationCap) return { block: false, capReached: true };
  if (input.stop_hook_active && record.lastSignature === stageSignature(state)) return { block: false };
  const reason = `Research loop is running (stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}). Continue: run ${LOOP_COMMAND} next and follow it; earlier stages are summarized in its context pack, so do not reread their files. ${instruction ?? ''}`.trim();
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

/**
 * Research files (or folders) a read-type tool call touches, relative to the
 * project root. Used only to audit reads outside the context pack.
 */
export function researchReads(paths: ProjectPaths, input: HookInput, root?: string): string[] {
  const tool = input.tool_input ?? {};
  const raw: string[] = [];
  for (const key of ['file_path', 'path', 'pattern', 'glob']) if (typeof tool[key] === 'string') raw.push(tool[key] as string);
  const command = typeof tool.command === 'string' ? tool.command : Array.isArray(tool.command) ? tool.command.join(' ') : '';
  if (command) for (const match of command.matchAll(/[\w./-]+/g)) raw.push(match[0]);
  const shared = sharedFolders(paths.researchRoot);
  const folders = [paths.assets, paths.definitions, paths.plans, paths.ideas, paths.papers, shared.checks];
  const result = new Set<string>();
  for (const value of raw) {
    let relative = value.replace(/\\/g, '/');
    if (root && relative.startsWith(root.replace(/\\/g, '/') + '/')) relative = relative.slice(root.length + 1);
    relative = relative.replace(/^\.\//, '').replace(/\/+$/, '');
    const folder = folders.find((item) => relative === item || relative.startsWith(`${item}/`));
    if (!folder) continue;
    // A glob or a folder is recorded as the folder itself.
    result.add(/[*?[{]/.test(relative) ? folder : relative);
  }
  return [...result];
}

/** Deny agent writes that would forge an approval or touch loop-internal files. */
export function preToolUseDecision(paths: ProjectPaths, input: HookInput, root?: string): ToolDecision {
  const tool = (input.tool_name ?? '').toLowerCase();
  const writes = /write|edit|patch|shell|bash|notebook/.test(tool);
  if (!writes) return { deny: false };
  const targets = targetsOf(input);
  const text = textsOf(input);
  const approvalsFile = path.posix.join(paths.researchRoot, 'approvals.json');
  const shared = sharedFolders(paths.researchRoot);
  const isShell = /shell|bash/.test(tool);
  if (isShell && RAW_GIT.test(text)) {
    return { deny: true, reason: `Research loop: do not run git pull/push/rebase/merge directly. Use ${LOOP_COMMAND} sync status | sync pull | sync prepare; publishing (sync publish) needs the researcher's confirmation.` };
  }
  const shellWrites = !isShell || /(?:^|[^<])>|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bpython|\bnode\b|\bperl\b/.test(text);
  for (const target of targets) {
    if (shellWrites && (under(target, approvalsFile, root) || target.endsWith('/approvals.json') || under(target, shared.approvals, root) || under(target, STATE_DIR, root))) {
      return { deny: true, reason: `Research loop: ${target} is written only by the researcher through the extension. Approvals are never set by the agent.` };
    }
    if (shellWrites && (under(target, shared.decisions, root) || under(target, shared.handoffs, root))) {
      return { deny: true, reason: `Research loop: ${target} is a shared decision or handoff record written only by the loop (${LOOP_COMMAND} park/unpark/handoff, or the researcher's answers).` };
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

/**
 * Hook stdout in the JSON form both Claude Code and Codex accept (Codex 0.153
 * ships the same schemas): context via hookSpecificOutput.additionalContext,
 * Stop blocking via decision/reason, PreToolUse denial via permissionDecision.
 */
export function contextOutput(event: 'SessionStart' | 'UserPromptSubmit', context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

export function stopBlockOutput(reason: string): string {
  return JSON.stringify({ decision: 'block', reason });
}

export function denyOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
