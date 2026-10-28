import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { LoopState, STATE_DIR, sharedFolders, stageSignature } from './ResearchLoopModel';
import { LOOP_COMMAND, MAINTENANCE_COMMAND } from './AgentProviders';
import { folderNoteProblem, layoutProblem, projectRelative } from '../domain/layout';

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
  // An autonomous run is bounded by its budget instead; the chat compacts its own context.
  const autonomous = Boolean(state.autonomy && !state.autonomy.handedOverAt);
  if (!autonomous && record.blocks >= state.autopilot.iterationCap) return { block: false, capReached: true };
  if (input.stop_hook_active && record.lastSignature === stageSignature(state)) return { block: false };
  const reason = `Research loop is running (stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}). Continue: run ${LOOP_COMMAND} next and follow it; earlier stages are summarized in its context pack, so do not reread their files. ${instruction ?? ''}`.trim();
  return { block: true, reason };
}

/** The research problems present when the researcher's turn began, and how often Stop has sent the agent back since. */
export interface GuardRecord { baseline: string[]; blocks: number }
export const GUARD_PATH = `${STATE_DIR}/guard.json`;
/** Consecutive Stop blocks for new problems before the turn may end anyway (the dashboard still shows them). */
export const GUARD_BLOCK_CAP = 2;

/**
 * Whether Stop sends the agent back to fix research problems this turn
 * introduced, however the files were written (a script, a folder move, an
 * agent without PreToolUse hooks). Problems already present when the turn
 * began never trap the agent. Pure; the caller persists the record.
 */
export function guardDecision(record: GuardRecord | undefined, problems: string[]): { block: boolean; reason?: string; record: GuardRecord } {
  if (!record) return { block: false, record: { baseline: problems, blocks: 0 } };
  const before = new Set(record.baseline);
  const fresh = problems.filter((problem) => !before.has(problem));
  if (!fresh.length) return { block: false, record: { ...record, blocks: 0 } };
  if (record.blocks >= GUARD_BLOCK_CAP) return { block: false, record };
  const shown = fresh.slice(0, 12).map((problem) => `- ${problem}`);
  if (fresh.length > shown.length) shown.push(`- ... and ${fresh.length - shown.length} more`);
  const reason = [
    `Research files: this turn left ${fresh.length} new problem(s) in the research folders:`,
    ...shown,
    'Fix them before finishing: move misplaced files into the research layout (raw materials to research-local/), rename clashing IDs, and repair broken references.',
    `Do not delete research content just to silence a problem; if a fix needs the researcher's decision, say so and stop. Check with: ${MAINTENANCE_COMMAND} validate`,
  ].join('\n');
  return { block: true, reason, record: { ...record, blocks: record.blocks + 1 } };
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
  const folders = [paths.assets, paths.definitions, paths.plans, paths.ideas, paths.papers, shared.checks, shared.candidates, ...(paths.library ? [paths.library] : [])];
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

/** A path a write creates, with the full content when the tool supplies it. */
interface Creation { target: string; isDir?: boolean; content?: string; fromShell?: boolean }

/**
 * Paths a write-type call would create. Edits and deletes of existing files
 * are not creations: moving content out of a misplaced file stays possible.
 */
function creationsOf(input: HookInput, isShell: boolean, root: string | undefined, exists: (relative: string) => boolean): Creation[] {
  const tool = input.tool_input ?? {};
  const created: Creation[] = [];
  const name = (input.tool_name ?? '').toLowerCase();
  if (/^(write|notebookedit)$/.test(name)) {
    const target = typeof tool.file_path === 'string' ? tool.file_path : typeof tool.notebook_path === 'string' ? tool.notebook_path : undefined;
    if (target) created.push({ target, content: name === 'write' && typeof tool.content === 'string' ? tool.content : undefined });
  }
  const patch = typeof tool.patch === 'string' ? tool.patch : typeof tool.input === 'string' ? tool.input : !isShell && typeof tool.command === 'string' ? tool.command : '';
  for (const block of patch.split(/^(?=\*\*\* )/m)) {
    const add = /^\*\*\* Add File: (.+)$/m.exec(block);
    if (add) created.push({ target: add[1].trim(), content: block.split('\n').slice(1).filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n') });
    const move = /^\*\*\* Move to: (.+)$/m.exec(block);
    if (move) created.push({ target: move[1].trim() });
  }
  if (isShell) {
    const command = typeof tool.command === 'string' ? tool.command : Array.isArray(tool.command) ? tool.command.join(' ') : '';
    for (const match of command.matchAll(/[\w./-]+\.[A-Za-z][A-Za-z0-9]*\b/g)) created.push({ target: match[0], fromShell: true });
    for (const match of command.matchAll(/\bmkdir\s+([^;&|<>\n]+)/g)) {
      for (const arg of match[1].trim().split(/\s+/)) if (arg && !arg.startsWith('-')) created.push({ target: arg.replace(/^['"]|['"]$/g, ''), isDir: true, fromShell: true });
    }
    created.push(...copyDestinations(command, root, exists));
  }
  return created;
}

const COPY_COMMAND = /^(?:mv|cp|rsync|ln|git\s+mv)$/;
const looksLikeDir = (target: string) => target.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(path.posix.basename(target));

/**
 * Where mv, cp, git mv, rsync, and ln put what they copy: the last argument
 * (or `-t DIR`), or each source's name inside it when it is an existing
 * folder. Folders count too, so `cp -r raw research/library/x/sources` is
 * checked although no file name in the command says so.
 */
function copyDestinations(command: string, root: string | undefined, exists: (relative: string) => boolean): Creation[] {
  const created: Creation[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const verb = words[0] === 'git' ? words.slice(0, 2).join(' ') : words[0];
    if (!verb || !COPY_COMMAND.test(verb)) continue;
    const args: string[] = [];
    let into: string | undefined;
    const rest = words.slice(verb.split(' ').length);
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '-t') into = rest[++i];
      else if (rest[i].startsWith('--target-directory=')) into = rest[i].slice('--target-directory='.length);
      else if (!rest[i].startsWith('-')) args.push(rest[i]);
    }
    const destination = into ?? (args.length > 1 ? args.pop() : undefined);
    // Remote rsync targets (host:path) never land in the project.
    if (!destination || destination.includes(':')) continue;
    const relative = projectRelative(destination, root);
    const intoFolder = into !== undefined || (relative !== undefined && looksLikeDir(destination) && exists(relative));
    if (!intoFolder) { created.push({ target: destination, isDir: looksLikeDir(destination), fromShell: true }); continue; }
    for (const source of args) {
      const name = path.posix.basename(source.replace(/\/+$/, ''));
      if (name) created.push({ target: `${destination.replace(/\/+$/, '')}/${name}`, isDir: looksLikeDir(source), fromShell: true });
    }
  }
  return created;
}

/**
 * Deny agent writes that would forge an approval or touch loop-internal files,
 * and writes that would put a file outside the research layout. Library files
 * may be added and edited like any research file (git keeps the history);
 * only setting them approved is the researcher's. `exists` (project-relative)
 * lets a shell command still read, move, or delete a misplaced file.
 */
export function preToolUseDecision(paths: ProjectPaths, input: HookInput, root?: string, exists: (relative: string) => boolean = () => false): ToolDecision {
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
  const shellWrites = !isShell || /(?:^|[^<])>|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brsync\b|\bln\b|\brm\b|\btruncate\b|\bpython|\bnode\b|\bperl\b/.test(text);
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
  if (paths.library) {
    for (const target of targets.filter((item) => under(item, paths.library, root))) {
      if (APPROVED.test(text) || (isShell && shellWrites && /status:\s*['"]?approved/.test(text))) {
        return { deny: true, reason: `Research loop: ${target} may not be set to status: approved by the agent. Library results are approved by the researcher; leave it draft.` };
      }
    }
  }
  // The loop stamps a plan's verified proof after an independent check confirms it; an agent stamping it would skip that check.
  if (shellWrites && /verified_proof_digest/.test(text) && (isShell || targets.some((target) => under(target, paths.plans, root)))) {
    return { deny: true, reason: 'Research loop: only the loop records that a proof was verified (verified_proof_digest). Write ## Verdict in the plan and report confirmed or rejected.' };
  }
  if (isShell && shellWrites && /status:\s*['"]?approved/.test(text) && (text.includes(paths.assets) || text.includes(paths.definitions))) {
    return { deny: true, reason: 'Research loop: shell commands may not set status: approved on assets or definitions.' };
  }
  for (const creation of isShell && !shellWrites && !/\bmkdir\b/.test(text) ? [] : creationsOf(input, isShell, root, exists)) {
    const relative = projectRelative(creation.target, root);
    if (!relative || (creation.fromShell && exists(relative))) continue;
    const problem = layoutProblem(paths, relative, creation.isDir) ?? (creation.content !== undefined ? folderNoteProblem(paths, relative, creation.content) : undefined);
    if (problem) return { deny: true, reason: `Research layout: ${problem}` };
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
