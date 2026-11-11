import * as path from 'path';
import { ProjectPaths } from '../models/types';
import { CONTEXT_PACK_PATH, LoopState, STATE_DIR, sharedFolders, stageSignature } from './ResearchLoopModel';
import { LOOP_COMMAND, MAINTENANCE_COMMAND } from './AgentProviders';
import { folderNoteProblem, layoutProblem, projectRelative } from '../domain/layout';
import { UNDERSTANDING_PATH } from '../domain/understandingLevels';
import { projectShellWrite, shellScriptOf } from './ShellWrites';
import { WRITE_PROMPT_PATTERN } from '../domain/chatRoles';
import { importedCollectionOf } from '../domain/packages';
import { PACKAGE_DIR } from '../domain/registry';

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
  /** PreCompact: manual | auto. */
  trigger?: string;
  /** The chat's transcript (JSONL); its last usage record tells how much context the chat carries. */
  transcript_path?: string;
}

/** `counted`: the block counts toward the continuation cap (an autonomous run is bounded by its budget instead). */
export interface StopDecision { block: boolean; reason?: string; capReached?: boolean; counted?: boolean }
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
  return { block: true, reason, counted: !autonomous };
}

/**
 * Context the driver's chat may carry before the loop starts the next stage in
 * a fresh chat. Every request rereads the whole chat, and once it idles past
 * the prompt cache's lifetime (waiting on the researcher or a long subagent)
 * all of it is written again; the loop's files rebuild a fresh chat cheaply.
 */
export const CONTEXT_RESET_TOKENS = 200_000;

/**
 * Tokens the chat sent with its latest request, from the transcript's last
 * lines (oldest first): a Claude Code assistant record's usage, or a Codex
 * token_count event. Subagent (sidechain) records are skipped.
 */
export function contextTokensFrom(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let record: any;
    try { record = JSON.parse(lines[i]); } catch { continue; }
    const usage = record?.type === 'assistant' && !record.isSidechain ? record.message?.usage : undefined;
    if (usage && typeof usage.input_tokens === 'number') return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const codex = record?.type === 'event_msg' && record.payload?.type === 'token_count' ? record.payload.info?.last_token_usage : undefined;
    if (codex && typeof codex.input_tokens === 'number') return codex.input_tokens;
  }
  return undefined;
}

const thousands = (tokens: number) => `~${Math.round(tokens / 1000)}K`;

/**
 * Whether the driver's `next` should start the stage in a fresh chat instead:
 * the chat is over CONTEXT_RESET_TOKENS. An autonomous run is left alone (no
 * one is there to open the fresh chat; the chat compacts itself). Returns the
 * denial reason; the caller pauses the loop and frees its lock.
 */
export function contextResetDecision(state: LoopState | undefined, input: HookInput, tokens: number | undefined): string | undefined {
  if (!state || state.status !== 'running' || tokens === undefined || tokens < CONTEXT_RESET_TOKENS) return undefined;
  if (state.autonomy && !state.autonomy.handedOverAt) return undefined;
  if (!runsLoopNext(input)) return undefined;
  return `Research loop: this chat carries ${thousands(tokens)} tokens of context, so the loop paused before the next stage; it continues more cheaply in a fresh chat, rebuilt from the files. Do not run anything else. Tell the researcher in two lines that the work so far is saved, and that they continue with /clear (Codex: a new thread) and then the research-loop skill.`;
}

/** The tool call runs `research-loop next`: where the driver's chat size is measured and checked. */
export function runsLoopNext(input: HookInput): boolean {
  return loopCalls(input).some((call) => call.command === 'next');
}

/**
 * PreCompact (Claude Code turns the hook's stdout into instructions for the
 * compaction summary): what the driver's summary keeps. The loop rebuilds from
 * its files after compaction, so the summary carries only what no file holds;
 * a copy of proofs or verdicts would go stale. Undefined without a loop.
 */
export function compactInstructions(state: LoopState | undefined): string | undefined {
  if (!state || (state.status !== 'running' && state.status !== 'paused')) return undefined;
  const autonomous = Boolean(state.autonomy && !state.autonomy.handedOverAt);
  return [
    `Research loop: this chat drives the research loop (${state.status}, stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}${autonomous ? ', autonomous run' : ''}).`,
    `Everything the loop needs is in files, and it rebuilds from them after compaction: ${STATE_DIR}/state.json, the stage's context pack ${CONTEXT_PACK_PATH}, and the research folders. Keep the summary short.`,
    `Keep: that this chat drives the research loop and continues with ${LOOP_COMMAND} next${autonomous ? ' (no one is watching: continue without asking)' : ''}; what the current step was in the middle of (the command or subagent running, what is left of this step); and, quoted, anything the researcher said in this chat that no file records yet (instructions, preferences, answers).`,
    'Leave out: proof text, file contents, earlier stages and their verdicts, subagent reports already recorded with report, and the loop\'s status lines. They are in the files, and a copy in the summary goes stale.',
  ].join('\n');
}

/** Shown to the researcher when the loop hands them a long chat to answer in. */
export function waitingContextNote(tokens: number): string {
  return `Research loop: this chat carries ${thousands(tokens)} tokens of context. If you answer more than an hour from now, /clear first (Codex: a new thread) and answer there: the loop resumes from its files, while this chat would be reloaded in full.`;
}

/** A turn that is a subagent's hand-back or a background task's notice, not the researcher writing. */
export function isHandbackPrompt(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && /^\s*(?:Another Claude session sent a message:|<task-notification>)/.test(prompt);
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
  if (isShell && /\bpackage\s+approve\b/.test(text)) {
    return { deny: true, reason: `Research loop: accepting an imported package is the researcher's decision. Tell them it waits in the dashboard (Needs you), or that they can run ${LOOP_COMMAND} package approve <alias> --interactive in their own terminal.` };
  }
  const shellWrites = !isShell || /(?:^|[^<])>|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brsync\b|\bln\b|\brm\b|\btruncate\b|\bpython|\bnode\b|\bperl\b/.test(text);
  for (const target of targets) {
    if (shellWrites && under(target, UNDERSTANDING_PATH, root)) {
      return { deny: true, reason: `Research loop: ${target} records what the researcher understood, and only the researcher sets it (the mark_understood popup, the dashboard, or ${LOOP_COMMAND} teach mark --interactive in their own terminal).` };
    }
    if (shellWrites && (under(target, approvalsFile, root) || target.endsWith('/approvals.json') || under(target, shared.approvals, root) || under(target, STATE_DIR, root))) {
      return { deny: true, reason: `Research loop: ${target} is written only by the researcher through the extension. Approvals are never set by the agent.` };
    }
    if (shellWrites && (under(target, shared.decisions, root) || under(target, shared.handoffs, root))) {
      return { deny: true, reason: `Research loop: ${target} is a shared decision or handoff record written only by the loop (${LOOP_COMMAND} park/unpark/handoff, or the researcher's answers).` };
    }
    if (paths.remarks && under(target, paths.remarks, root) && (shellWrites || !isShell)) {
      return { deny: true, reason: `Research loop: ${target} is a remark; write remarks only with ${LOOP_COMMAND} remark add|edit|archive (or add_remark), which check the target and stamp the version it was written for.` };
    }
    if ((under(target, paths.assets, root) || under(target, paths.definitions, root)) && APPROVED.test(text)) {
      return { deny: true, reason: `Research loop: ${target} may not be set to status: approved by the agent. Leave it draft and call request_approval so the researcher can approve it.` };
    }
  }
  // Imported packages are vendored and pinned by their lockfile; this project's package folder holds its release history. Both change only through the package commands.
  const packageFolder = paths.researchRoot === '.' ? undefined : path.posix.join(paths.researchRoot, PACKAGE_DIR);
  for (const target of shellWrites ? targets : []) {
    const relative = projectRelative(target, root);
    if (relative === undefined) continue;
    const collection = importedCollectionOf(relative, paths.library, exists);
    if (collection) {
      return { deny: true, reason: `Research loop: ${target} belongs to the imported package ${collection}, which is read-only (it must match its lockfile). To change a result, copy it into the project with ${LOOP_COMMAND} library promote <lib_id>; to bring a new version, ${LOOP_COMMAND} package update ${collection}.` };
    }
    if (packageFolder && under(relative, packageFolder)) {
      return { deny: true, reason: `Research loop: ${target} is this project's package manifest and release history; it changes only through ${LOOP_COMMAND} package export (or the dashboard).` };
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
 * Which chats teach, which write the manuscript, and which drive the loop, by
 * session ID. A teaching chat (the teach skill) and a writing chat (the
 * manuscript skills) work beside the loop's own chat: they never take the
 * loop's lock, are never sent on by the Stop hook, and never drive the loop.
 * A session that has driven the loop is never taken for either.
 */
export const SESSIONS_PATH = `${STATE_DIR}/sessions.json`;
export type SessionRole = 'teach' | 'write' | 'drive';
export type SessionRoles = Record<SessionRole, Record<string, string>>;
const ROLES_KEPT = 20;
const ROLE_NAMES = ['teach', 'write', 'drive'] as const;

export function parseSessionRoles(text: string | undefined): SessionRoles {
  const roles: SessionRoles = { teach: {}, write: {}, drive: {} };
  try {
    const raw = JSON.parse(text ?? '') as Partial<SessionRoles>;
    for (const role of ROLE_NAMES) if (raw?.[role] && typeof raw[role] === 'object') roles[role] = { ...raw[role] };
  } catch { /* none yet */ }
  return roles;
}

/** Record a session's role; a chat beside the loop is either teaching or writing, never both. */
export function withSessionRole(roles: SessionRoles, role: SessionRole, session: string, at: string): SessionRoles {
  const next = { ...roles };
  const beside: SessionRole[] = role === 'drive' ? [] : ['teach', 'write'];
  for (const name of [role, ...beside]) {
    const entries = Object.entries(roles[name]).filter(([id]) => id !== session);
    next[name] = Object.fromEntries(name === role ? [...entries, [session, at]].slice(-ROLES_KEPT) : entries);
  }
  return next;
}

export function sessionRole(roles: SessionRoles, session: string | undefined): SessionRole | undefined {
  if (!session) return undefined;
  if (roles.drive[session]) return 'drive';
  if (roles.teach[session]) return 'teach';
  return roles.write[session] ? 'write' : undefined;
}

/**
 * The role a chat takes from a turn's signal, or undefined to keep the one it
 * has. A driver stays the driver. Only the researcher's own prompt moves a chat
 * beside the loop: between teaching and writing (a teaching chat running a
 * manuscript preview stays a teaching chat), or from writing to driving when
 * they invoke the loop there (a chat that organized their manuscript often
 * wrote the manuscript plan on the way). A teaching chat never drives, and no
 * command the agent runs makes a chat beside the loop its driver.
 */
export function nextSessionRole(known: SessionRole | undefined, signal: SessionRole | undefined, fromPrompt: boolean): SessionRole | undefined {
  if (!signal || known === 'drive' || known === signal) return undefined;
  if (!known) return signal;
  if (signal === 'drive') return known === 'write' && fromPrompt ? 'drive' : undefined;
  return fromPrompt ? signal : undefined;
}

/** A prompt invoking the research-loop skill (Claude Code /research-loop, Codex $research-loop), or the dashboard's "continue the research loop". */
export const LOOP_PROMPT_PATTERN = /(?:^|\s)[/$]research-loop\b|\bcontinue the research loop\b/i;
const LOOP_CALL = /research-loop\.cjs["']?\s+([a-z-]+)(?:\s+([a-z-]+))?/g;
const DRIVING_COMMANDS = new Set(['start', 'resume', 'extend', 'next', 'report']);
const MANUSCRIPT_CALL = /manuscript-writing\.cjs\b/;

/** The research-loop commands a shell call runs, as `command sub`. */
function loopCalls(input: HookInput): Array<{ command: string; sub?: string }> {
  return [...shellScriptOf(input.tool_input?.command).matchAll(LOOP_CALL)].map((match) => ({ command: match[1], sub: match[2] }));
}

/**
 * What a turn says about its chat: a prompt naming the teach skill, a
 * manuscript skill, or the loop's; or a command that teaches, writes the
 * manuscript, or drives the loop.
 */
export function roleSignal(event: string, input: HookInput, teachPrompt: RegExp, writePrompt: RegExp = WRITE_PROMPT_PATTERN): SessionRole | undefined {
  if (event === 'UserPromptSubmit') {
    if (typeof input.prompt !== 'string') return undefined;
    if (teachPrompt.test(input.prompt)) return 'teach';
    if (writePrompt.test(input.prompt)) return 'write';
    // The researcher invoking the loop's skill in a chat asks that chat to drive.
    return LOOP_PROMPT_PATTERN.test(input.prompt) ? 'drive' : undefined;
  }
  if (event !== 'PreToolUse') return undefined;
  const calls = loopCalls(input);
  if (calls.some((call) => DRIVING_COMMANDS.has(call.command))) return 'drive';
  if (calls.some((call) => call.command === 'teach')) return 'teach';
  return MANUSCRIPT_CALL.test(shellScriptOf(input.tool_input?.command)) ? 'write' : undefined;
}

/** Commands a teaching chat may run: reading, the teach commands, and recording the researcher's doubts as ideas. */
function teachingMayRun(call: { command: string; sub?: string }): boolean {
  if (['status', 'show', 'teach', 'library'].includes(call.command)) return true;
  if (call.command === 'search') return call.sub === 'status';
  if (call.command === 'idea') return call.sub === 'add';
  if (call.command === 'remark') return ['add', 'edit', 'archive', 'list'].includes(call.sub ?? '');
  return false;
}

export const TEACHING_ORIGIN_REASON = 'This chat is the teaching chat, where an idea may be the researcher\'s or yours: say whose it is before recording it. Origin researcher when the researcher raised it (their doubt, their route, a statement they believe), even if you helped word it; origin agent when it is your own suggestion, even if they agreed to record it. Set origin on record_idea, or pass --origin researcher|agent to idea add, and say in the body who raised it.';

/** Ideas a call records without saying whose they are: record_idea without origin, or idea add without --origin. */
function unattributedIdeas(input: HookInput): boolean {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  if (/record_idea$/.test(tool)) return args.origin !== 'agent' && args.origin !== 'researcher';
  const command = typeof args.command === 'string' ? args.command : Array.isArray(args.command) ? args.command.join(' ') : '';
  const adds = loopCalls(input).filter((call) => call.command === 'idea' && call.sub === 'add').length;
  return adds > 0 && [...command.matchAll(/--origin[\s=]+["']?(?:agent|researcher)\b/g)].length < adds;
}

const commandOf = (input: HookInput) => { const args = input.tool_input ?? {}; return typeof args.command === 'string' ? args.command : Array.isArray(args.command) ? args.command.join(' ') : ''; };

/** Where the remarks a call writes say they come from: add_remark's from, or each remark add|edit|archive's --from (undefined when one does not say). */
function remarkSources(input: HookInput): Array<string | undefined> {
  const args = input.tool_input ?? {};
  if (/add_remark$/.test(input.tool_name ?? '')) return [typeof args.from === 'string' ? args.from : undefined];
  const writes = loopCalls(input).filter((call) => call.command === 'remark' && call.sub !== 'list').length;
  if (!writes) return [];
  const said = [...commandOf(input).matchAll(/--from[\s=]+["']?([a-z]+)/g)].map((match) => match[1]);
  return Array.from({ length: writes }, (_, index) => said[index]);
}

/** remark add calls (or add_remark) that do not say whose remark it is. */
function unattributedRemarks(input: HookInput): boolean {
  const args = input.tool_input ?? {};
  if (/add_remark$/.test(input.tool_name ?? '')) return args.origin !== 'agent' && args.origin !== 'researcher';
  const adds = loopCalls(input).filter((call) => call.command === 'remark' && call.sub === 'add').length;
  return adds > 0 && [...commandOf(input).matchAll(/--origin[\s=]+["']?(?:agent|researcher)\b/g)].length < adds;
}

/**
 * manuscript-writing and research-maintenance calls that write (the
 * invocation, up to the next shell separator, carries --apply). Without it
 * every subcommand only previews or reports, which a teaching chat may run.
 */
const APPLY_CALL = /(manuscript-writing|research-maintenance)\.cjs["']?\s+([^;&|\n]*)/g;
function applyWrites(input: HookInput): { script: string; sub: string } | undefined {
  for (const match of shellScriptOf(input.tool_input?.command).matchAll(APPLY_CALL)) {
    if (/(?:^|\s)["']?--apply\b/.test(match[2])) return { script: match[1], sub: match[2].trim().split(/\s+/)[0] || '' };
  }
  return undefined;
}

export const TEACHING_REMARK_REASON ='This chat is the teaching chat: write remarks with from teaching (add_remark from: "teaching", or remark ... --from teaching), and say whose each one is (origin researcher when the researcher said it, even if you worded it; origin agent for your own explanation).';

/**
 * A teaching chat reads and explains; it never drives the loop or edits the
 * project, by an edit tool or by shell, and says whose each idea it records
 * is. `readFile` (absolute path) lets it see whether a script a shell command
 * runs writes files.
 */
export function teachingToolDecision(paths: ProjectPaths, input: HookInput, root?: string, readFile?: (absolute: string) => string | undefined): ToolDecision {
  const tool = (input.tool_name ?? '').toLowerCase();
  const refused = loopCalls(input).find((call) => !teachingMayRun(call));
  if (refused) return { deny: true, reason: `This chat is the teaching chat: it explains verified results and never drives the loop (research-loop ${refused.command}${refused.sub ? ` ${refused.sub}` : ''}). The loop runs in its own chat; tell the researcher to ask there.` };
  const applied = applyWrites(input);
  if (applied?.script === 'manuscript-writing') return { deny: true, reason: `This chat is the teaching chat: it does not change the manuscript (manuscript-writing ${applied.sub} --apply). It may run impact or a --preview to show how the paper presents a result; the paper is written with the manuscript skills. Tell the researcher: invoking one themselves (/draft-latex or /plan-manuscript; Codex $draft-latex) turns this chat into a writing chat, or they can open a new chat for it.` };
  if (applied) return { deny: true, reason: `This chat is the teaching chat: it does not edit project files (research-maintenance ${applied.sub} --apply). It may run validate or a --preview; maintenance is done in the loop's own chat or another chat.` };
  if (unattributedIdeas(input)) return { deny: true, reason: TEACHING_ORIGIN_REASON };
  if (unattributedRemarks(input) || remarkSources(input).some((from) => from !== 'teaching')) return { deny: true, reason: TEACHING_REMARK_REASON };
  if (/shell|bash/.test(tool)) {
    const write = projectShellWrite(shellScriptOf(input.tool_input?.command), { root, cwd: input.cwd ?? root, readFile });
    return write ? { deny: true, reason: `This chat is the teaching chat: it does not edit project files, and this command would write ${write}. Read with the teach commands; record a doubt or idea with record_idea and an explanation with add_remark. A scratch file (a rewording draft, a worked example) goes in a temporary folder outside the project, such as $TMPDIR, named by its path.` } : { deny: false };
  }
  if (!/write|edit|patch|notebook/.test(tool)) return { deny: false };
  const inProject = targetsOf(input).filter((target) => !path.isAbsolute(target) || (root !== undefined && (target === root || target.startsWith(root + path.sep))));
  if (inProject.length) return { deny: true, reason: `This chat is the teaching chat: it does not edit project files (${inProject[0]}). Record a doubt or idea with record_idea and an explanation with add_remark; changes are made in the loop's own chat.` };
  return { deny: false };
}

/** research-loop commands that drive the loop or change what it works on: the loop's own chat runs them, never a writing chat. */
const WRITING_REFUSED = new Set([...DRIVING_COMMANDS, 'pause', 'stop', 'park', 'unpark', 'focus', 'handoff']);
const writingRefuses = (call: { command: string; sub?: string }) => WRITING_REFUSED.has(call.command)
  || (call.command === 'search' && call.sub === 'request') || (call.command === 'conjecture' && call.sub === 'request')
  || (call.command === 'budget' && call.sub === 'allocate') || (call.command === 'idea' && (call.sub === 'convert' || call.sub === 'promote'))
  || (call.command === 'repair' && call.sub === 'request');

export const WRITING_NOTE = 'Research Assistant: this chat writes the manuscript (plan-manuscript, draft-latex, revise-manuscript-prose, check-notation). It never drives the research loop: do not run research-loop next, report, resume, or other commands that move the loop, and do not prove results here. A result the paper needs but nobody proved goes under ## Gaps of its brief (or as an idea) for the loop. The loop runs in its own chat; if the researcher wants this chat to drive it, they invoke the research-loop skill here themselves (/research-loop; Codex $research-loop).';

/** A writing chat edits the manuscript and its plans; it never drives the loop, which runs in its own chat. */
export function writingToolDecision(input: HookInput): ToolDecision {
  const refused = loopCalls(input).find(writingRefuses);
  if (refused) return { deny: true, reason: `This chat writes the manuscript; it never drives the research loop (research-loop ${refused.command}${refused.sub ? ` ${refused.sub}` : ''}). The loop runs in its own chat. Tell the researcher: to drive the loop from this chat, they invoke the research-loop skill here themselves (/research-loop; Codex $research-loop), or they open a new chat for it. Record what the paper needs from the loop under ## Gaps of the section brief or with idea add.` };
  return { deny: false };
}

/** Stages that check work independently: the checker never sees remarks, which are explanations nobody checked. */
const CHECKING_STAGES = new Set(['verify_proof', 'verify_node', 'verify_counterexample', 'verify_construction', 'verify_reduction']);

/**
 * Remark rules in the loop's own chat: its remarks say from loop (never posing
 * as the teaching chat), and a checking stage reads no remarks at all.
 */
export function loopRemarkDecision(paths: ProjectPaths, input: HookInput, stage: string | undefined, root?: string): ToolDecision {
  if (remarkSources(input).some((from) => from === 'teaching')) return { deny: true, reason: 'Research loop: remarks written in the loop\'s chat say from loop (add_remark from: "loop", or remark add --from loop); from teaching is the teaching chat\'s.' };
  if (!stage || !CHECKING_STAGES.has(stage) || !paths.remarks) return { deny: false };
  const tool = input.tool_input ?? {};
  const named = ['file_path', 'path', 'pattern', 'glob'].map((key) => tool[key]).filter((value): value is string => typeof value === 'string');
  const command = commandOf(input);
  const readsRemarks = named.some((value) => under(value, paths.remarks, root) || value.includes(`${paths.remarks}/`) || value.endsWith(paths.remarks))
    || (command && (command.includes(paths.remarks) || loopCalls(input).some((call) => call.command === 'remark')));
  return readsRemarks ? { deny: true, reason: `Research loop: a checking stage does not read remarks (${paths.remarks}/). They are explanations nobody checked; check the proof against the statement and what it cites.` } : { deny: false };
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

/** A note for the researcher's eyes, not the agent's. */
export function systemMessageOutput(message: string): string {
  return JSON.stringify({ systemMessage: message });
}

export function denyOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
