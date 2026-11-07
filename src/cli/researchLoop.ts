import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { ResearchLoopCore } from '../services/ResearchLoopCore';
import { PROJECT_CONFIG_PATH } from '../services/ProjectPathsCore';
import { BRIDGE_PATH, CONTEXT_PACK_PATH, DRIVER_PATH, dashboardLinkPath, isWaitingForHuman, REPORT_OUTCOMES, ReportOutcome, SYNC_PATH, StageReport, stageSignature } from '../services/ResearchLoopModel';
import { CONTEXT_RESET_TOKENS, GUARD_PATH, GuardRecord, HookInput, SESSIONS_PATH, SessionRole, contextOutput, contextResetDecision, contextTokensFrom, denyOutput, guardDecision, isHandbackPrompt, loopRemarkDecision, parseSessionRoles, preToolUseDecision, researchReads, roleSignal, sessionRole, stopBlockOutput, stopDecision, systemMessageOutput, teachingToolDecision, waitingContextNote, withSessionRole, nextSessionRole, writingToolDecision, WRITING_NOTE } from '../services/ResearchLoopHooks';
import { TEACH_PROMPT_PATTERN } from '../domain/understandingLevels';
import { hasContextPack } from '../services/ResearchContext';
import { AgentSignal, noteAgentActivity } from '../services/AgentActivity';
import { AGENT_PROVIDERS, MAINTENANCE_COMMAND } from '../services/AgentProviders';
import { migrateApprovals } from '../services/ApprovalStore';
import { LoopGit } from '../services/LoopGit';
import { PublishPreview, ResearchSync } from '../services/ResearchSync';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths, loadSyncConfig } from './nodeFiles';
import { NodeGitRunner, openGit, runShell } from './nodeGit';
import { applyInterlinks } from '../services/ResearchInterlinks';
import { locateNodeFile } from '../domain/registry';
import { toIdeaKind } from '../domain/nodeKinds';
import { vocabularyReminder } from '../domain/researcherText';
import { LEVEL_LABEL, toLevel } from '../domain/understanding';
import { Teaching } from '../services/Teaching';
import { REMARK_FROM_LIST, RemarkFrom, remarkLabel } from '../domain/remarks';
import { PACKAGE_USAGE, runPackage } from './packageCommands';

declare const __EXTENSION_VERSION__: string | undefined;
const EXTENSION_VERSION = typeof __EXTENSION_VERSION__ === 'string' ? __EXTENSION_VERSION__ : undefined;

interface Args { positional: string[]; flags: Record<string, string | true>; lists: Record<string, string[]> }

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, lists: {} };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      const value = next !== undefined && !next.startsWith('--') ? (index++, next) : true;
      args.flags[key] = value;
      if (value !== true) (args.lists[key] ??= []).push(value);
    } else args.positional.push(arg);
  }
  return args;
}

const USAGE = `Usage: research-loop <command> [options]
  status [--brief] [--json]
  start --provider claude|codex [--goal "..."] [--session ID] [--force]
  extend --goal "..." [--provider claude|codex] [--session ID] [--force]   (add a new goal to an approved project)
  resume [--session ID] [--provider claude|codex] [--force] [--focus id,id] | pause | stop
  focus [<required id>...] | focus clear   (the required results the researcher wants first)
  next [--json]
  context [--json] [--budget N]   (compile the current stage's context pack; next does this too)
  show <id|paper_slug|project> [--section Heading]... [--full]   (one node or paper part on request)
  report <${REPORT_OUTCOMES.join('|')}> --summary "..." [--plan ID] [--asset ID] [--counterexample ID] [--question "..."] [--assumed-definitions a,b] [--confirm]
  search status <asset>   (the object-search board: obstructions, near-misses, directions tried)
  search request <asset> [--rounds N]   (only when the researcher asks: more counterexample search, even on a checked asset)
  teach list [--json]   (verified results, those new to the researcher first, each after what it rests on)
  teach pack <id>   (the material for teaching one verified result)
  teach mark <id> --level black_box|idea|full|none [--note "..."] --interactive   (the researcher, in their own terminal)
  teach revise <id> --file <draft.md|->   (a rewording the researcher asked for: ## Proof with ## Changes; the loop checks and applies it)
  teach style [--add "rule"]   (the project's proof style; --add after the researcher agreed to keep a rule)
  validate [--fix]
  park <asset> --reason TEXT [--note TEXT] | unpark <asset>
  budget status | budget allocate <asset> <n> --reason "..."   (autonomous mode: give a stuck result n more attempts with a new direction)
  idea add --title "..." --body "..." [--kind approach|question|observation|test_case|risk|conjecture] [--asset ID]... [--tag TAG]... [--origin agent|researcher]   (agent by default; researcher only for the researcher's own idea in their words)
  remark add --target ID --title "..." --body "..." --origin researcher|agent --from teaching|loop|other [--anchor "step 3"] [--tag TAG]...   (an annotation on a result: an explanation for people, never a claim a result relies on)
  remark edit <remarkId> [--title "..."] [--body "..."] [--anchor "..."] --from teaching|loop|other   (the loop edits only its own remarks)
  remark archive <remarkId> --from teaching|loop|other
  remark list [--target ID] [--all] [--json]
  idea resolve <ideaId> --by <decision, plan, or asset ID> [--note "..."]
  idea convert <ideaId> --asset ID --goal "..." --steps "line per step" --verification "..."
  conjecture list [--json]   (conjectures ranked against the goals, best first)
  conjecture request <ideaId|conjecture>   (the researcher asks: make this conjecture idea precise, or search this conjecture, whatever the settings allow)
  conjecture promote <id> --as lemma|theorem|proposition   (stage draft_project only: make a conjecture a goal; list it under required_results next)
  conjecture demote <id> --note "<why it is still believed>" [--serves id,id]   (a draft result no goal needs any more becomes a conjecture)
  question pending | question answer --text "..." | question skip | question poll <id>
  handoff [--note "..."]   (write a shared handoff for the next collaborator)
  library search <words...> [--type T] [--collection C] [--limit N]   (find known results to reuse)
  library list [--collection C] [--unapproved]
  library promote <lib_id> [--as <id>]   (copy a library result into the project as a draft to change it)
${PACKAGE_USAGE}
  sync status [--no-fetch] | sync pull [--remote NAME] [--continue] | sync prepare [--latex] [--no-fetch] [--note "..."]
  sync publish [--message "..."] [--interactive]   (needs the researcher's confirmation in VS Code or the terminal)
  migrate-approvals   (split research/approvals.json into one file per approved target)
  restore-approvals   (re-apply status: approved where the researcher's approval record still matches the content)
  hook <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd>   (reads hook JSON on stdin)
  precommit   (git pre-commit hook: refuse commits that add research file problems)
Global: --project ROOT (default: nearest .research-assistant.json above cwd)`;

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

/** Transcript tail read for the latest usage record; a page image can make one line hundreds of KB. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** How much context the hook's chat carries, from the end of its transcript; undefined when unknown. */
function chatContextTokens(input: HookInput): number | undefined {
  if (!input.transcript_path) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(input.transcript_path, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line may start mid-record when the tail is cut.
    return contextTokensFrom(length < size ? lines.slice(1) : lines);
  } catch { return undefined; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ } }
}

/**
 * The running extension records the hash of the driver it ships. A different
 * copy (an older build left in the skills folder) must not touch loop state:
 * older engines misread newer files and revert approvals.
 */
function staleDriver(root: string): string | undefined {
  let expected: string | undefined;
  try { expected = (JSON.parse(fs.readFileSync(path.join(root, DRIVER_PATH), 'utf8')) as { sha256?: string }).sha256; } catch { return undefined; }
  if (!expected || !process.argv[1]) return undefined;
  let actual: string;
  try { actual = crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'); } catch { return undefined; }
  if (actual === expected) return undefined;
  return `This research-loop driver (${process.argv[1]}) differs from the one the Research Assistant extension ships, so it will not change loop state. The researcher should run "Research Assistant: Refresh Project Setup" (or reload VS Code) to install the current driver; then continue.`;
}

async function openCore(root: string, iterationCap?: number, git?: LoopGit): Promise<ResearchLoopCore> {
  const paths = await loadProjectPaths(root);
  // Identity, context budgets, and the loop policy are read from the project files on use.
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths, { iterationCap, git, extensionVersion: EXTENSION_VERSION });
  await core.load();
  return core;
}

function describePreview(preview: PublishPreview): string {
  return [
    `Publish to: ${preview.targets.join(' and ')}`,
    preview.files.length ? `Files to commit (${preview.files.length}):\n${preview.files.slice(0, 40).map((entry) => `  ${entry.code.trim() || '?'} ${entry.path}`).join('\n')}${preview.files.length > 40 ? `\n  ... and ${preview.files.length - 40} more` : ''}` : 'No new files to commit.',
    preview.ahead ? `Local commits not yet shared: ${preview.ahead}` : '',
    `Commit message:\n${preview.message.split('\n').map((line) => `  ${line}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

/** Ask on the controlling terminal; agents' shells have none, so this cannot be answered by an agent. */
function confirmOnTty(text: string, word = 'publish', elsewhere = 'run sync publish --interactive yourself in a terminal, or confirm in VS Code'): boolean {
  let fd: number;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch { throw new Error(`No terminal is attached; ${elsewhere}.`); }
  try {
    fs.writeSync(fd, `${text}\n\nType "${word}" to confirm: `);
    let answer = '';
    const buffer = Buffer.alloc(1);
    while (fs.readSync(fd, buffer, 0, 1, null) === 1 && buffer[0] !== 10) answer += buffer.toString('utf8');
    return answer.trim().toLowerCase() === word;
  } finally { fs.closeSync(fd); }
}

/** Told to every chat on the project, so the results it names in chat open in the dashboard when clicked (see dashboardLinkPath). */
const LINK_HINT = `When you name a result, definition, plan, or idea in chat, write its title as a dashboard link, which opens its page in the Research Assistant dashboard: [Title](${dashboardLinkPath('<id>')}), with exactly this relative path (not an absolute one, not vscode://). For a remark, copy the link add_remark or remark add|list returns (it opens the page of the result the remark is on). Link the research file itself only when the researcher wants the raw file.`;

/** Ask the researcher in VS Code through the extension bridge; undefined when the extension is not running. */
async function confirmInExtension(root: string, text: string): Promise<boolean | undefined> {
  let bridge: { port: number; token: string; pid?: number } | undefined;
  try { bridge = JSON.parse(fs.readFileSync(path.join(root, BRIDGE_PATH), 'utf8')); } catch { return undefined; }
  if (!bridge?.port || !bridge.token) return undefined;
  if (bridge.pid) { try { process.kill(bridge.pid, 0); } catch { return undefined; } }
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ name: 'confirm_publish', arguments: { detail: text } }), signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { confirmed?: boolean };
    return typeof body.confirmed === 'boolean' ? body.confirmed : undefined;
  } catch { return undefined; }
}

async function runSync(sub: string | undefined, args: Args, root: string, core: ResearchLoopCore, git: LoopGit, out: (value: unknown) => void, json: boolean): Promise<void> {
  const sync = new ResearchSync(core, new NodeLoopFiles(root), git, await loadSyncConfig(root), runShell(root));
  const lines = (title: string, items: string[]) => items.length ? `${title}\n${items.map((item) => `- ${item}`).join('\n')}` : '';
  switch (sub) {
    case 'status': {
      const status = await sync.status({ fetch: args.flags['no-fetch'] !== true });
      out(status);
      return;
    }
    case 'pull': {
      const result = await sync.pull({ remote: typeof args.flags.remote === 'string' ? args.flags.remote : undefined, continue: args.flags.continue === true });
      if (json) { out(result); } else {
        out([result.status === 'conflict' ? 'Sync stopped on conflicts.' : result.status === 'up_to_date' ? '' : 'Pulled collaborators\' changes:', lines('', result.summary).trim(), lines('Problems (loop paused):', result.problems), lines('Warnings:', result.warnings), result.next ? `Next: ${result.next}` : ''].filter(Boolean).join('\n'));
      }
      if (result.status === 'conflict' || result.problems.length) process.exitCode = 1;
      return;
    }
    case 'prepare': {
      const result = await sync.prepare({ latex: args.flags.latex === true, fetch: args.flags['no-fetch'] !== true, note: typeof args.flags.note === 'string' ? args.flags.note : undefined });
      if (json) { out(result); } else {
        const checks = result.checks.map((check) => `${check.ok ? (check.warning ? 'WARN' : 'PASS') : 'FAIL'} ${check.name}${check.details.length ? `\n${check.details.map((detail) => `     ${detail}`).join('\n')}` : ''}`).join('\n');
        out([result.ok ? 'Ready to share.' : 'Not ready to share; fix the FAIL items and run sync prepare again.', checks, lines('What would be shared:', result.summary), result.handoff ? `Handoff written: ${result.handoff}` : '', result.ok ? 'The researcher publishes with: sync publish (confirmation required).' : ''].filter(Boolean).join('\n\n'));
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'publish': {
      const interactive = args.flags.interactive === true;
      const result = await sync.publish(async (preview) => {
        const text = describePreview(preview);
        if (interactive) return confirmOnTty(text);
        const answer = await confirmInExtension(root, text);
        if (answer !== undefined) return answer;
        throw new Error('Publishing needs the researcher\'s confirmation. Open the project in VS Code with Research Assistant running (a dialog will ask), or run sync publish --interactive yourself in a terminal.');
      }, { message: typeof args.flags.message === 'string' ? args.flags.message : undefined });
      if (json) out(result);
      else out([lines('', result.summary).trim(), lines('Warnings:', result.warnings)].filter(Boolean).join('\n'));
      if (result.status === 'conflict' || result.status === 'blocked') process.exitCode = 1;
      return;
    }
    default:
      throw new Error('sync status|pull|prepare|publish');
  }
}

/**
 * Link prose mentions in the asset and definition files the agent changed: the
 * current stage's files while the loop runs (so no file outside the stage is
 * touched), otherwise the uncommitted ones.
 */
async function linkChangedNodes(root: string, core: ResearchLoopCore, running: boolean): Promise<string[]> {
  const paths = await loadProjectPaths(root);
  let changed: string[];
  if (running) {
    const { added, modified } = await core.changedFiles();
    changed = [...added, ...modified];
  } else {
    const status = await new NodeGitRunner(root).run(['status', '--porcelain', '--untracked-files=all', '--', paths.assets, paths.definitions, paths.library]);
    if (status.code !== 0) return [];
    changed = status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  }
  return applyInterlinks(new NodeLoopFiles(root), paths, changed.filter((file) => file.endsWith('.md') && locateNodeFile(file, paths)));
}

/** Guard records by session; only the most recent sessions are kept. */
async function readGuard(files: NodeLoopFiles): Promise<Record<string, GuardRecord>> {
  try { const value = JSON.parse(await files.readFile(GUARD_PATH)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

async function writeGuard(files: NodeLoopFiles, session: string, record: GuardRecord): Promise<void> {
  const records = await readGuard(files);
  delete records[session];
  records[session] = record;
  const kept = Object.fromEntries(Object.entries(records).slice(-20));
  await files.writeFile(GUARD_PATH, JSON.stringify(kept) + '\n');
}

/** Note the research problems present as a turn begins; a resumed session keeps its record. */
async function guardBaseline(root: string, core: ResearchLoopCore, session: string, fresh: boolean): Promise<void> {
  const files = new NodeLoopFiles(root);
  if (!fresh && (await readGuard(files))[session]) return;
  await writeGuard(files, session, { baseline: await core.validateAll(), blocks: 0 });
}

/** The reason to send the agent back for problems this turn introduced, if any. */
async function guardStop(root: string, core: ResearchLoopCore, session: string): Promise<string | undefined> {
  const files = new NodeLoopFiles(root);
  const decision = guardDecision((await readGuard(files))[session], await core.validateAll());
  await writeGuard(files, session, decision.record);
  return decision.block ? decision.reason : undefined;
}

/**
 * Record what this turn says about its chat (see SessionRoles) and return the
 * chat's role. A chat that has driven the loop stays the driver; one that
 * becomes a teaching or writing chat gives back a lock it took before the
 * hooks knew what it was.
 */
async function noteSessionRole(root: string, core: ResearchLoopCore, event: string, input: HookInput): Promise<SessionRole | undefined> {
  const session = input.session_id;
  const files = new NodeLoopFiles(root);
  const roles = parseSessionRoles(await files.readFile(SESSIONS_PATH).catch(() => ''));
  const known = sessionRole(roles, session);
  const signal = roleSignal(event, input, TEACH_PROMPT_PATTERN);
  const role = session ? nextSessionRole(known, signal, event === 'UserPromptSubmit') : undefined;
  if (!session || !role) return known;
  await files.writeFile(SESSIONS_PATH, JSON.stringify(withSessionRole(roles, role, session, new Date().toISOString())) + '\n');
  if (role !== 'drive') await core.releaseLock(session);
  return role;
}

/** What happens to a rewording now, said so the teacher can tell the researcher; a rewording is applied only by a running loop. */
function revisionNext(core: ResearchLoopCore): string {
  const state = core.current;
  const applied = 'checks the reworded proof independently and, if it holds, puts it in place (the previous proof stays until then)';
  if (!state || state.status === 'idle' || state.status === 'stopped') return `Nothing applies it yet: the research loop is not running. Tell the researcher to start it (Research Assistant: Start Research Loop, then /research-loop or $research-loop in a chat); the loop then ${applied}.`;
  if (state.status === 'paused') return `The research loop is paused. Tell the researcher to resume it (Research Assistant: Resume Research Loop); the loop then ${applied}.`;
  if (state.stage === 'waiting' || state.stage === 'ready') return `The loop is waiting. Tell the researcher to ask the agent in the loop's chat to continue; it then ${applied}.`;
  return `The loop ${applied} after its current step.`;
}

const TEACHING_NOTE = 'Research loop: this chat is the teaching chat. Explain verified results with the teach skill; do not run research-loop next, report, or other commands that drive the loop, and do not edit project files. The loop runs in its own chat.';

async function runHook(event: string, args: Args): Promise<void> {
  let input: HookInput = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  const root = typeof args.flags.project === 'string' ? path.resolve(args.flags.project) : findProjectRoot(input.cwd ?? process.cwd());
  if (!root) return;
  const stale = staleDriver(root);
  if (stale) {
    // Only speak up where the agent reads it; never validate, block, or rewrite anything from a stale engine.
    if (event === 'SessionStart' || event === 'UserPromptSubmit') process.stdout.write(contextOutput(event, `Research loop: ${stale}`) + '\n');
    if (event !== 'PreToolUse') return;
  }
  let core: ResearchLoopCore;
  try { core = await openCore(root); } catch { return; }
  const state = core.current;
  const session = input.session_id;
  let role: SessionRole | undefined;
  try { role = stale ? undefined : await noteSessionRole(root, core, event, input); } catch { role = undefined; }
  if (role === 'teach') { await runTeachingHook(event, root, input); return; }
  if (role === 'write') { await runWritingHook(event, root, core, input); return; }
  // Only the driver, or a chat already holding the lock, acts for the loop. Any other chat (one the hooks cannot
  // place yet) never takes a free lock, is never sent on at Stop, and never consumes the researcher's answers.
  const mayDrive = role === 'drive' || Boolean(session && state?.lock?.sessionId === session);
  // Liveness for the dashboard: only a running loop's agent, and never a stale driver.
  const note = (signal: AgentSignal) => (mayDrive && state?.status === 'running' && !stale ? noteAgentActivity(new NodeLoopFiles(root), signal) : Promise.resolve());
  const shellTool = state ? AGENT_PROVIDERS[state.provider]?.shellTool : undefined;
  const toolPhase = (phase: 'start' | 'end') => (shellTool && input.tool_name === shellTool ? { name: shellTool, phase } : undefined);
  switch (event) {
    case 'SessionStart':
    case 'UserPromptSubmit': {
      // Every turn, loop or not: what was wrong before the turn is not the agent's to fix at Stop.
      try { await guardBaseline(root, core, session ?? 'unknown', event === 'UserPromptSubmit'); } catch { /* the guard never blocks a turn from starting */ }
      if (!state || (state.status !== 'running' && state.status !== 'paused' && !state.pendingQuestion)) {
        // Any chat on the project names results; how to link them holds with or without a loop.
        if (event === 'SessionStart') process.stdout.write(contextOutput(event, `Research Assistant: ${LINK_HINT}`) + '\n');
        return;
      }
      if (!mayDrive) {
        const holder = state.lock && state.lock.sessionId !== session ? `another session (${state.lock.sessionId}) is driving the loop` : 'no chat is driving it right now';
        process.stdout.write(contextOutput(event, `Research loop: the loop is ${state.status} (stage ${state.stage}); ${holder}. This chat drives it only when the researcher asks for the loop here (the research-loop skill); otherwise do what the researcher asked, and do not run research-loop next.\n${LINK_HINT}`) + '\n');
        return;
      }
      // Only a chat that drives the loop takes over a lock its holder let go quiet.
      if (session && !core.heartbeat(session, false, role === 'drive')) {
        process.stdout.write(contextOutput(event, `Research loop: another session (${state.lock?.sessionId}) is driving the loop. Do not run research-loop next here unless the researcher asks you to take over with --force.`) + '\n');
        return;
      }
      // A subagent's hand-back is not the researcher's turn: the full status already sits in this chat.
      if (event === 'UserPromptSubmit' && isHandbackPrompt(input.prompt)) {
        process.stdout.write(contextOutput(event, core.briefStatus({ compact: true })) + '\n');
        await core.consumeAnswers();
        await core.touch(session);
        return;
      }
      let brief = `${core.briefStatus()}\n${LINK_HINT}`;
      try {
        const sync = JSON.parse(fs.readFileSync(path.join(root, SYNC_PATH), 'utf8')) as { phase?: string; conflicted?: string[] };
        if (sync.phase === 'conflict') brief += `\nGit sync stopped on conflicts in ${sync.conflicted?.join(', ') ?? 'research files'}; the researcher resolves them, then run sync pull --continue. Do not resolve mathematical conflicts yourself.`;
      } catch { /* no sync yet */ }
      if (event === 'SessionStart' && state.status === 'running' && hasContextPack(state.stage) && fs.existsSync(path.join(root, CONTEXT_PACK_PATH))) {
        brief += `\nThe current stage's context is compiled in ${CONTEXT_PACK_PATH}${input.source === 'compact' || input.source === 'clear' ? ' (the chat was compacted or cleared: rebuild from the files, not from memory)' : ''}. Earlier stages are summarized there; do not reread their files.`;
      }
      process.stdout.write(contextOutput(event, brief) + '\n');
      await core.consumeAnswers();
      await core.touch(session);
      // A prompt starts a turn; opening a chat does not.
      if (event === 'UserPromptSubmit') await note({ kind: 'active', sessionId: session });
      return;
    }
    case 'PostToolUse': {
      await note({ kind: 'active', sessionId: session, tool: toolPhase('end'), throttle: true });
      // Audit only: note research files read outside the current context pack.
      if (!mayDrive || !state || state.status !== 'running') return;
      const paths = await loadProjectPaths(root);
      for (const file of researchReads(paths, input, root)) await core.noteRead(file, input.tool_name ?? '');
      return;
    }
    case 'PreToolUse': {
      const paths = await loadProjectPaths(root);
      const remarkRule = loopRemarkDecision(paths, input, state?.status === 'running' ? state.stage : undefined, root);
      if (remarkRule.deny) { process.stdout.write(denyOutput(remarkRule.reason ?? 'Denied by the research loop.') + '\n'); return; }
      // Read tools reach this hook only for the remark rule above.
      if (/^(read|grep|glob)$/i.test(input.tool_name ?? '')) return;
      await note({ kind: 'active', sessionId: session, tool: toolPhase('start'), throttle: true });
      // A chat that has just started driving (it runs next) takes the loop's lock now, not only at Stop.
      if (role === 'drive' && session && state && state.lock?.sessionId !== session) await core.touch(session, false, true);
      const decision = preToolUseDecision(paths, input, root, (relative) => fs.existsSync(path.join(root, relative)));
      if (decision.deny) { process.stdout.write(denyOutput(decision.reason ?? 'Denied by the research loop.') + '\n'); return; }
      // The driver starts the next stage in a fresh chat once this one has grown large.
      const reset = state?.lock?.sessionId === session ? contextResetDecision(state, input, chatContextTokens(input)) : undefined;
      if (reset && session) {
        await note({ kind: 'ended', by: 'stop', sessionId: session });
        await core.pause('Paused to continue in a fresh chat: the previous chat had grown large. Resume with /clear (Codex: a new thread) and the research-loop skill; the loop rebuilds from the files.');
        await core.releaseLock(session);
        process.stdout.write(denyOutput(reset) + '\n');
      }
      return;
    }
    case 'Stop': {
      // Best effort: a malformed node is skipped here and reported by validate.
      try { await linkChangedNodes(root, core, state?.status === 'running'); } catch { /* keep the Stop decision independent of linking */ }
      // Checked on disk rather than per tool call, so files a script or a folder move wrote are caught too.
      let guard: string | undefined;
      try { guard = await guardStop(root, core, session ?? 'unknown'); } catch { guard = undefined; }
      if (guard) {
        await note({ kind: 'active', sessionId: session });
        process.stdout.write(stopBlockOutput(guard) + '\n');
        return;
      }
      if (!state || state.status !== 'running') return;
      // A chat that does not hold the lock is never sent on: the driver may only be waiting on a long subagent.
      if (!mayDrive || (session && !core.heartbeat(session, false, role === 'drive'))) return;
      await core.validateWorkspace({ fix: true });
      let instruction: string | undefined;
      try { const next = await core.next(); instruction = next.blocked ? undefined : next.instruction; } catch { instruction = undefined; }
      const decision = stopDecision(core.current, input, instruction);
      if (decision.capReached) {
        await note({ kind: 'ended', by: 'stop', sessionId: session });
        await core.pause(`Autopilot stopped after ${state.autopilot.iterationCap} automatic continuations in this session. To shed accumulated context, resume in a fresh chat (Claude Code: /clear; Codex: a new thread) with the research-loop skill; the loop rebuilds from the files.`);
        return;
      }
      // The agent hands control back: say so, rather than counting its last breath as activity.
      if (!decision.block) {
        await core.touch(session);
        await note({ kind: 'ended', by: 'stop', sessionId: session });
        // Handing a long chat to the researcher: a fresh chat may answer, so free the lock for it.
        const tokens = chatContextTokens(input);
        const current = core.current;
        if (session && current && tokens !== undefined && tokens >= CONTEXT_RESET_TOKENS && (isWaitingForHuman(current) || current.stage === 'review_project')) {
          await core.releaseLock(session);
          process.stdout.write(systemMessageOutput(waitingContextNote(tokens)) + '\n');
        }
        return;
      }
      const key = session ?? 'unknown';
      const record = state.autopilot.sessions[key] ?? { blocks: 0, lastSignature: '', lastBlockAt: '' };
      if (decision.counted) record.blocks += 1;
      record.lastSignature = stageSignature(state); record.lastBlockAt = new Date().toISOString();
      state.autopilot.sessions[key] = record;
      await core.touch(session);
      await note({ kind: 'active', sessionId: session });
      process.stdout.write(stopBlockOutput(decision.reason ?? 'Continue the research loop.') + '\n');
      return;
    }
    case 'SessionEnd': {
      await note({ kind: 'ended', by: 'session_end', sessionId: session });
      return;
    }
    default:
      return;
  }
}

/**
 * Hooks in the teaching chat: it reads beside the loop, so it never takes the
 * lock, consumes the driver's answers, counts as the agent's activity, or is
 * sent on at Stop; it only gets told what it is and kept from driving or editing.
 */
async function runTeachingHook(event: string, root: string, input: HookInput): Promise<void> {
  if (event === 'SessionStart' || event === 'UserPromptSubmit') { process.stdout.write(contextOutput(event, `${TEACHING_NOTE}\n${LINK_HINT}`) + '\n'); return; }
  if (event !== 'PreToolUse') return;
  const paths = await loadProjectPaths(root);
  const readScript = (file: string) => { try { return fs.statSync(file).size <= 1_000_000 ? fs.readFileSync(file, 'utf8') : undefined; } catch { return undefined; } };
  const teaching = teachingToolDecision(paths, input, root, readScript);
  const decision = teaching.deny ? teaching : preToolUseDecision(paths, input, root, (relative) => fs.existsSync(path.join(root, relative)));
  if (decision.deny) process.stdout.write(denyOutput(decision.reason ?? 'Denied by the research loop.') + '\n');
}

/**
 * Hooks in a writing chat: it edits the manuscript beside the loop, so like
 * the teaching chat it never takes the lock, consumes the driver's answers,
 * counts as the agent's activity, or is sent on at Stop. It keeps the checks
 * on files it writes (layout, approvals, research problems it leaves) and may
 * not drive the loop.
 */
async function runWritingHook(event: string, root: string, core: ResearchLoopCore, input: HookInput): Promise<void> {
  const session = input.session_id ?? 'unknown';
  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    try { await guardBaseline(root, core, session, event === 'UserPromptSubmit'); } catch { /* the guard never blocks a turn from starting */ }
    process.stdout.write(contextOutput(event, `${WRITING_NOTE}\n${LINK_HINT}`) + '\n');
    return;
  }
  if (event === 'PreToolUse') {
    const paths = await loadProjectPaths(root);
    const remarkRule = loopRemarkDecision(paths, input, undefined, root);
    if (remarkRule.deny) { process.stdout.write(denyOutput(remarkRule.reason ?? 'Denied by the research loop.') + '\n'); return; }
    if (/^(read|grep|glob)$/i.test(input.tool_name ?? '')) return;
    const writing = writingToolDecision(input);
    const decision = writing.deny ? writing : preToolUseDecision(paths, input, root, (relative) => fs.existsSync(path.join(root, relative)));
    if (decision.deny) process.stdout.write(denyOutput(decision.reason ?? 'Denied by the research loop.') + '\n');
    return;
  }
  if (event === 'Stop') {
    // No interlinking here: it rewrites node files the loop's own chat may be in the middle of editing.
    let guard: string | undefined;
    try { guard = await guardStop(root, core, session); } catch { guard = undefined; }
    if (guard) process.stdout.write(stopBlockOutput(guard) + '\n');
  }
}

/** Run git with an optional index file and stdin; rejects on a non-zero exit. */
function gitIn(cwd: string, args: string[], options: { index?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) };
    const child = execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(String(stdout))));
    // A git that exits before reading stdin must not crash the hook (EPIPE); its exit code is the answer.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  });
}

/** Export the research files of HEAD (or of the index) to `out` and validate that copy as a whole. */
async function validateTree(root: string, top: string, prefix: string, scope: string[], out: string, index?: string): Promise<string[]> {
  const pathspec = scope.map((item) => path.posix.join(prefix, item));
  const files = await gitIn(top, ['ls-files', '-z', '--', ...pathspec], { index });
  if (files) await gitIn(top, ['checkout-index', '-z', '--stdin', `--prefix=${out}/`], { index, input: files });
  const project = path.join(out, prefix);
  // An untracked config still says where the research folders are.
  if (!fs.existsSync(path.join(project, PROJECT_CONFIG_PATH))) { fs.mkdirSync(project, { recursive: true }); fs.copyFileSync(path.join(root, PROJECT_CONFIG_PATH), path.join(project, PROJECT_CONFIG_PATH)); }
  return (await openCore(project)).validateAll();
}

/**
 * Git pre-commit check: refuse a commit whose staged research files have
 * problems the last commit did not. Both trees are exported and validated as a
 * whole, so a problem that was already there never blocks a commit, and a
 * failure of the check itself lets the commit through.
 */
async function runPreCommit(args: Args): Promise<void> {
  const root = typeof args.flags.project === 'string' ? path.resolve(args.flags.project) : findProjectRoot(process.cwd());
  if (!root) return;
  let scratch: string | undefined;
  let fresh: string[];
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'research-precommit-'));
    const top = (await gitIn(root, ['rev-parse', '--show-toplevel'])).trim();
    const prefix = path.relative(fs.realpathSync(top), fs.realpathSync(root)).split(path.sep).join('/');
    const paths = await loadProjectPaths(root);
    const scope = [PROJECT_CONFIG_PATH, paths.researchRoot];
    let before: string[] = [];
    if (await gitIn(top, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)) {
      const index = path.join(scratch, 'head.index');
      await gitIn(top, ['read-tree', 'HEAD'], { index });
      before = await validateTree(root, top, prefix, scope, path.join(scratch, 'head'), index);
    }
    const known = new Set(before);
    fresh = (await validateTree(root, top, prefix, scope, path.join(scratch, 'staged'))).filter((problem) => !known.has(problem));
  } catch (error: unknown) {
    process.stderr.write(`Research Assistant: pre-commit check skipped (${error instanceof Error ? error.message : String(error)}).\n`);
    return;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!fresh.length) return;
  process.stderr.write([
    `Research Assistant: this commit would add ${fresh.length} problem(s) to the research files:`,
    ...fresh.slice(0, 20).map((problem) => `- ${problem}`),
    ...(fresh.length > 20 ? [`- ... and ${fresh.length - 20} more`] : []),
    `Fix them and commit again (check with ${MAINTENANCE_COMMAND} validate). To commit anyway: git commit --no-verify.`,
  ].join('\n') + '\n');
  process.exitCode = 1;
}

function text(value: string | true | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

/** A comma- or space-separated list of IDs. */
function ids(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, sub, third] = args.positional;
  if (!command || command === 'help' || args.flags.help) { process.stdout.write(USAGE + '\n'); return; }
  if (command === 'hook') { await runHook(sub, args); return; }
  if (command === 'precommit') { await runPreCommit(args); return; }
  const root = typeof args.flags.project === 'string' ? path.resolve(args.flags.project) : findProjectRoot(process.cwd());
  if (!root) throw new Error('No .research-assistant.json found; run from the project or pass --project.');
  const stale = staleDriver(root);
  if (stale && command !== 'status') throw new Error(stale);
  const json = args.flags.json === true;
  const cap = typeof args.flags['iteration-cap'] === 'string' ? Number(args.flags['iteration-cap']) : undefined;
  const git = await openGit(root);
  const core = await openCore(root, cap, git);
  const session = typeof args.flags.session === 'string' ? args.flags.session : undefined;
  const out = (value: unknown) => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  // The agent drives the loop through these commands: each is a sign of life (status is also what a researcher runs in a terminal).
  const alive = () => (command !== 'status' && command !== 'teach' && core.current?.status === 'running' && !stale ? noteAgentActivity(new NodeLoopFiles(root), { kind: 'active', sessionId: session }) : Promise.resolve());
  await alive();
  switch (command) {
    case 'status': {
      if (json) out(core.statusSummary());
      else if (args.flags.brief) out(`${core.briefStatus()}\n${LINK_HINT}`);
      else {
        out(`${core.briefStatus()}\n${LINK_HINT}`);
        const manuscript = await core.manuscriptStatus();
        if (manuscript) out(manuscript);
        const audit = await core.contextAudit();
        if (audit.tokens !== undefined) out(`Context: pack ~${audit.tokens}/${audit.budget} tokens; ${audit.requests.length} show request(s)${audit.requests.length ? ` (${audit.requests.join(', ')})` : ''}; ${audit.outside.length} read(s) outside the pack${audit.outside.length ? ` (${audit.outside.slice(0, 8).join(', ')})` : ''}.`);
        const events = await core.recentEvents(8); if (events.length) out('Recent events:\n' + events.map((event) => `- ${String(event.at)} ${String(event.type)}${event.stage ? ` ${String(event.stage)}` : ''}${event.assetId ? ` ${String(event.assetId)}` : ''}${event.summary ? ` — ${String(event.summary)}` : ''}`).join('\n')); }
      return;
    }
    case 'start': {
      const provider = args.flags.provider === 'codex' ? 'codex' : 'claude';
      await core.start(provider, { goal: typeof args.flags.goal === 'string' ? args.flags.goal : undefined, sessionId: session, force: args.flags.force === true });
      await alive();
      const next = await core.next();
      out(json ? { ...core.statusSummary(), instruction: next.instruction } : `Started (${provider}). ${next.instruction}`);
      return;
    }
    case 'extend': {
      const provider = args.flags.provider === 'codex' ? 'codex' : args.flags.provider === 'claude' ? 'claude' : undefined;
      await core.extend(text(args.flags.goal, 'goal'), { provider, sessionId: session, force: args.flags.force === true });
      await alive();
      const next = await core.next();
      out(json ? { ...core.statusSummary(), instruction: next.instruction } : `Extending the project. ${next.instruction}`);
      return;
    }
    case 'resume': { await core.resume({ sessionId: session, provider: args.flags.provider === 'codex' ? 'codex' : args.flags.provider === 'claude' ? 'claude' : undefined, force: args.flags.force === true, focus: typeof args.flags.focus === 'string' ? ids(args.flags.focus) : undefined }); await alive(); const next = await core.next(); out(json ? { ...core.statusSummary(), instruction: next.instruction } : next.instruction); return; }
    case 'pause': { await core.pause(); out('Paused.'); return; }
    case 'stop': { await core.stop(); out('Stopped.'); return; }
    case 'next': {
      if (session && !(await core.touch(session, args.flags.force === true))) throw new Error(`Another session (${core.current?.lock?.sessionId}) is driving this loop; pass --force to take over.`);
      const next = await core.next();
      // Where the agent stops and tells the researcher what waits on them: a long autopilot run has had no prompt to carry the link rule.
      const instruction = next.stage === 'waiting' || next.stage === 'ready' ? `${next.instruction}\n${LINK_HINT}` : next.instruction;
      if (json) out({ stage: next.stage, blocked: next.blocked, instruction, brief: next.brief });
      else out(`Stage: ${next.stage}\n${instruction}`);
      return;
    }
    case 'context': {
      const state = core.current;
      if (!state) throw new Error('No research loop has been started.');
      if (!hasContextPack(state.stage)) { out(json ? { stage: state.stage, context: null } : `Stage ${state.stage} has no context pack; run next.`); return; }
      const budget = typeof args.flags.budget === 'string' ? Number(args.flags.budget) : undefined;
      const pack = await core.contextPack(budget && budget > 0 ? budget : undefined);
      out(json ? { file: CONTEXT_PACK_PATH, tokens: pack.tokens, manifest: pack.manifest, files: pack.files, omitted: pack.omitted } : pack.text);
      return;
    }
    case 'show': {
      const id = text(sub, 'id');
      out(await core.show(id, args.lists.section ?? [], args.flags.full === true));
      return;
    }
    case 'report': {
      const outcome = sub as ReportOutcome;
      if (!REPORT_OUTCOMES.includes(outcome)) throw new Error(`report needs an outcome: ${REPORT_OUTCOMES.join('|')}`);
      const report: StageReport = {
        outcome, summary: typeof args.flags.summary === 'string' ? args.flags.summary : '',
        planId: typeof args.flags.plan === 'string' ? args.flags.plan : undefined,
        assetId: typeof args.flags.asset === 'string' ? args.flags.asset : undefined,
        counterexampleId: typeof args.flags.counterexample === 'string' ? args.flags.counterexample : undefined,
        question: typeof args.flags.question === 'string' ? args.flags.question : undefined,
        assumedDefinitions: typeof args.flags['assumed-definitions'] === 'string' ? args.flags['assumed-definitions'].split(',').map((item) => item.trim()).filter(Boolean) : undefined,
        confirm: args.flags.confirm === true || undefined,
      };
      if (outcome !== 'question' && !report.summary.trim()) throw new Error('--summary is required');
      const result = await core.report(report);
      await core.touch(session);
      const reminder = vocabularyReminder(report.summary);
      out(json ? { ...result, ...core.statusSummary(), ...(reminder ? { reminder } : {}) } : [`${result.message}\nStage: ${result.stage}`, reminder].filter(Boolean).join('\n'));
      return;
    }
    case 'validate': {
      const result = await core.validateWorkspace({ fix: args.flags.fix === true });
      if (json) out(result);
      else { for (const problem of result.problems) out(`PROBLEM ${problem}`); for (const id of result.fixed) out(`FIXED ${id} reverted to draft`); if (!result.problems.length) out('No approval problems found.'); }
      if (result.problems.length && !args.flags.fix) process.exitCode = 1;
      return;
    }
    case 'park': {
      const note = typeof args.flags.note === 'string' ? args.flags.note : undefined;
      await core.park(text(sub, 'asset'), text(args.flags.reason, 'reason'), note);
      out([`Parked ${sub}.`, vocabularyReminder(note ?? '')].filter(Boolean).join('\n'));
      return;
    }
    case 'unpark': { await core.unpark(text(sub, 'asset')); out(`Unparked ${sub}.`); return; }
    case 'focus': {
      const focus = sub === 'clear' ? await core.setFocus([]) : sub ? await core.setFocus(ids([sub, ...args.positional.slice(2)].join(','))) : core.current?.focus ?? [];
      out(json ? { focus } : focus.length ? `Focus: ${focus.join(', ')}. The loop works toward these first.` : 'No focus: the loop works toward every required result.');
      return;
    }
    case 'budget': {
      if (sub === 'status') {
        const run = core.current?.autonomy;
        const settings = await core.loopSettings();
        const summary = !settings.autonomy.enabled ? 'Autonomous mode is off.' : !run ? 'Autonomous mode is on; the run starts at the next step.'
          : run.handedOverAt ? `The autonomous run handed back at ${run.handedOverAt} after ${run.spent} attempt(s); resuming starts a new run.` : core.autonomyNote(run);
        out(json ? { enabled: settings.autonomy.enabled, autonomy: run ?? null, budget: settings.autonomyBudget, hours: settings.autonomyHours } : summary);
        return;
      }
      if (sub === 'allocate') {
        out(await core.allocate(text(third, 'asset'), Number(text(args.positional[3], 'n')), text(args.flags.reason, 'reason')));
        await core.touch(session);
        return;
      }
      throw new Error('budget status|allocate <asset> <n> --reason "..."');
    }
    case 'idea': {
      if (sub === 'add') {
        const tags = args.lists.tag ?? [];
        // An agent's idea is never presented as the researcher's: researcher only when said so.
        const origin = args.flags.origin ?? 'agent';
        if (origin !== 'agent' && origin !== 'researcher') throw new Error('--origin must be agent or researcher.');
        const id = await core.saveIdea(text(args.flags.title, 'title'), text(args.flags.body, 'body'), args.lists.asset ?? [], origin, tags, toIdeaKind(args.flags.kind, tags));
        out(json ? { ideaId: id } : `Saved idea ${id}.`);
        return;
      }
      if (sub === 'convert') {
        const id = await core.convertIdea(text(third, 'ideaId'), text(args.flags.asset, 'asset'), text(args.flags.goal, 'goal'), text(args.flags.steps, 'steps'), text(args.flags.verification, 'verification'));
        out(json ? { planId: id } : `Created plan ${id} from ${third}.`);
        return;
      }
      if (sub === 'resolve') {
        await core.resolveIdea(text(third, 'ideaId'), text(args.flags.by, 'by'), typeof args.flags.note === 'string' ? args.flags.note : undefined);
        out(json ? { resolved: third } : `Resolved idea ${third}.`);
        return;
      }
      throw new Error('idea add|convert|resolve');
    }
    case 'remark': {
      const from = (): RemarkFrom => {
        const value = args.flags.from;
        if (!(REMARK_FROM_LIST as readonly unknown[]).includes(value)) throw new Error(`--from must be one of ${REMARK_FROM_LIST.join(', ')}: where the remark is written.`);
        return value as RemarkFrom;
      };
      const optional = (key: string) => typeof args.flags[key] === 'string' ? args.flags[key] as string : undefined;
      if (sub === 'add') {
        const origin = args.flags.origin;
        if (origin !== 'agent' && origin !== 'researcher') throw new Error('--origin must be researcher or agent: whose remark it is.');
        const remark = await core.addRemark({ target: text(args.flags.target, 'target'), title: text(args.flags.title, 'title'), body: text(args.flags.body, 'body'), origin, from: from(), anchor: optional('anchor'), tags: args.lists.tag ?? [] });
        out(json ? { remarkId: remark.id, path: remark.file, link: remark.link } : `Saved remark ${remark.id} on ${remark.target} (${remark.file}). Link it in chat as ${remark.link}; it opens the result's page in the dashboard, where the remark is listed.`);
        return;
      }
      if (sub === 'edit') {
        const remark = await core.editRemark(text(third, 'remarkId'), { title: optional('title'), body: optional('body'), anchor: optional('anchor') }, from());
        out(json ? { remarkId: remark.id } : `Updated remark ${remark.id}.`);
        return;
      }
      if (sub === 'archive') {
        const remark = await core.archiveRemark(text(third, 'remarkId'), from());
        out(json ? { remarkId: remark.id } : `Archived remark ${remark.id}.`);
        return;
      }
      if (sub === 'list') {
        const service = core.remarks();
        const remarks = await Promise.all((await service.list({ target: optional('target'), includeArchived: args.flags.all === true })).map(async (remark) => ({ ...remark, link: await service.link(remark) })));
        out(json ? { remarks } : remarks.length ? remarks.map((remark) => `${remark.id} on ${remark.target}${remark.anchor ? ` (${remark.anchor})` : ''}: ${remark.link} [${remarkLabel(remark, remark.stale)}]`).join('\n') : 'No remarks.');
        return;
      }
      throw new Error('remark add|edit|archive|list');
    }
    case 'conjecture': {
      if (sub === 'list') {
        const ranked = await core.conjectureList();
        out(json ? { conjectures: ranked } : ranked.length ? ranked.map((item) => `${item.id}: ${item.reason}; ${item.agreed ? 'statement agreed' : item.falsified ? 'no counterexample found' : 'not yet checked'}`).join('\n') : 'No active conjectures.');
        return;
      }
      if (sub === 'request') { out(await core.requestConjecture(text(third, 'id'))); return; }
      if (sub === 'promote') { out(await core.promoteConjecture(text(third, 'id'), text(args.flags.as, 'as'))); await core.touch(session); return; }
      if (sub === 'demote') {
        out(await core.demoteToConjecture(text(third, 'id'), typeof args.flags.note === 'string' ? args.flags.note : '', typeof args.flags.serves === 'string' ? ids(args.flags.serves) : []));
        await core.touch(session);
        return;
      }
      throw new Error('conjecture list|request|promote|demote');
    }
    case 'question': {
      const state = core.current;
      if (sub === 'pending') { out(state?.pendingQuestion ?? 'No pending question.'); return; }
      if (sub === 'poll') { const answer = state?.answers.find((entry) => entry.questionId === third); out(answer ?? { answered: false }); return; }
      if (sub === 'answer' || sub === 'skip') {
        if (!state?.pendingQuestion) throw new Error('No pending question.');
        if (sub === 'answer' && typeof args.flags.text !== 'string') throw new Error('--text is required');
        await core.answerQuestion(state.pendingQuestion.id, sub === 'answer' ? 'answer' : 'skip', typeof args.flags.text === 'string' ? args.flags.text : '', 'chat');
        const next = await core.next();
        out(json ? core.statusSummary() : `Recorded. ${next.instruction}`);
        return;
      }
      throw new Error('question pending|answer|skip|poll');
    }
    case 'library': {
      if (sub === 'search' || sub === 'list') {
        const query = sub === 'search' ? args.positional.slice(2).join(' ') : '';
        if (sub === 'search' && !query.trim()) throw new Error('library search needs words to search for.');
        const limit = typeof args.flags.limit === 'string' ? Number(args.flags.limit) : undefined;
        const hits = await core.librarySearch(query, {
          type: typeof args.flags.type === 'string' ? args.flags.type : undefined,
          collection: typeof args.flags.collection === 'string' ? args.flags.collection : undefined,
          limit: sub === 'list' ? limit ?? Number.MAX_SAFE_INTEGER : limit, unapproved: args.flags.unapproved === true,
        });
        if (json) { out(hits); return; }
        if (!hits.length) { out(sub === 'search' ? 'No library results match.' : 'The library is empty.'); return; }
        for (const hit of hits) out(`${hit.id} | ${hit.type} | ${hit.approved ? 'approved' : hit.status === 'approved' ? 'approval stale' : hit.status} | ${hit.collection ?? ''} | ${hit.title}${hit.summary ? `\n    ${hit.summary}` : ''}`);
        if (sub === 'search') out(`Use one in depends_on/uses_definitions by ID; read it with: show <id>.`);
        return;
      }
      if (sub === 'promote') {
        const file = await core.promote(text(third, 'lib_id'), typeof args.flags.as === 'string' ? args.flags.as : undefined);
        out(json ? { file } : `Promoted ${third} to ${file} (draft, derived_from: ${third}). Point project references at the new ID where the changed version is meant.`);
        return;
      }
      throw new Error('library search|list|promote');
    }
    case 'package': {
      await runPackage(sub, args, { root, out, json, loopRunning: core.current?.status === 'running', extensionVersion: EXTENSION_VERSION });
      return;
    }
    case 'search': {
      if (sub === 'status') {
        const assetId = text(third, 'asset');
        out(json ? await core.searchProgressFor(assetId) : await core.searchBoard(assetId));
        return;
      }
      if (sub === 'request') {
        const rounds = typeof args.flags.rounds === 'string' ? Number(args.flags.rounds) : undefined;
        out(await core.requestSearch(text(third, 'asset'), rounds));
        await core.touch(session);
        return;
      }
      throw new Error('search status|request <asset>');
    }
    case 'teach': {
      const teaching = new Teaching(new NodeLoopFiles(root), await loadProjectPaths(root));
      if (sub === 'list') { out(json ? await teaching.overview() : await teaching.listText()); return; }
      if (sub === 'pack') { out(await teaching.packText(text(third, 'id'))); return; }
      if (sub === 'mark') {
        const id = text(third, 'id');
        const value = text(args.flags.level, 'level');
        const level = value === 'none' ? 'none' : toLevel(value);
        if (!level) throw new Error('--level is black_box, idea, full, or none');
        // Only the researcher says what they understood: in VS Code (mark_understood) or here, typed at their own terminal.
        if (args.flags.interactive !== true) throw new Error('Only the researcher marks what they understood: use the mark_understood popup, the Results view, or run teach mark ... --interactive yourself in a terminal.');
        const note = typeof args.flags.note === 'string' ? args.flags.note : undefined;
        if (!confirmOnTty(`Mark ${id} as understood: ${level === 'none' ? 'forget the mark' : LEVEL_LABEL[level]}${note ? ` (note: ${note})` : ''}?`, 'yes', 'mark it in VS Code instead (the popup or the Results view)')) { out('Not marked.'); return; }
        const item = await teaching.mark(id, level, { note, at: new Date().toISOString() });
        out(json ? item ?? null : `Marked ${id}: ${level === 'none' ? 'forgotten' : LEVEL_LABEL[level]}.`);
        return;
      }
      if (sub === 'revise') {
        const id = text(third, 'id');
        const source = text(args.flags.file, 'file');
        const draft = source === '-' ? await readStdin() : fs.readFileSync(path.resolve(source), 'utf8');
        const revision = await teaching.propose(id, draft, new Date().toISOString());
        out(json ? revision : `Saved the reworded proof for ${id}. ${revisionNext(core)}`);
        return;
      }
      if (sub === 'style') {
        if (typeof args.flags.add === 'string') { const file = await teaching.addStyle(args.flags.add); out(`Added to ${file}; new proofs and rewordings follow it. It is shared with collaborators when the researcher publishes.`); return; }
        out((await teaching.styleText()) || 'No proof style recorded yet (teach style --add "..." once the researcher agrees to keep a rule).');
        return;
      }
      throw new Error('teach list|pack <id>|mark <id> --level L --interactive|revise <id> --file F|style [--add "rule"]');
    }
    case 'handoff': {
      const file = await core.writeHandoff(typeof args.flags.note === 'string' ? args.flags.note : undefined);
      out(json ? { file } : `Wrote ${file}. Share it with sync prepare, then the researcher publishes.`);
      return;
    }
    case 'sync': {
      if (!git) throw new Error('This project is not a git repository; sync needs git (for Overleaf: git clone the Overleaf project URL).');
      await runSync(sub, args, root, core, git, out, json);
      return;
    }
    case 'restore-approvals': {
      const restored = await core.restoreApprovals();
      out(json ? { restored } : restored.length ? `Restored approval of ${restored.length} node(s) whose approval record still matches: ${restored.join(', ')}.` : 'No approvals to restore.');
      return;
    }
    case 'migrate-approvals': {
      const migrated = await migrateApprovals(new NodeLoopFiles(root), (await loadProjectPaths(root)).researchRoot);
      out(migrated ? 'Split approvals.json into research/approvals/ (one file per target). Commit the result.' : 'Nothing to migrate.');
      return;
    }
    default:
      throw new Error(`Unknown command ${command}\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { parseArgs, crypto };
