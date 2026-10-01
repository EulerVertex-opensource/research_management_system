import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ResearchLoopCore } from '../services/ResearchLoopCore';
import { BRIDGE_PATH, CONTEXT_PACK_PATH, DRIVER_PATH, LoopStage, ReportOutcome, SYNC_PATH, StageReport, stageSignature } from '../services/ResearchLoopModel';
import { HookInput, contextOutput, denyOutput, preToolUseDecision, researchReads, stopBlockOutput, stopDecision } from '../services/ResearchLoopHooks';
import { hasContextPack } from '../services/ResearchContext';
import { migrateApprovals } from '../services/ApprovalStore';
import { LoopGit } from '../services/LoopGit';
import { PublishPreview, ResearchSync } from '../services/ResearchSync';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths, loadSyncConfig } from './nodeFiles';
import { openGit, runShell } from './nodeGit';
import { toIdeaKind } from '../domain/nodeKinds';

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
  resume [--session ID] [--provider claude|codex] [--force] | pause | stop
  next [--json]
  context [--json] [--budget N]   (compile the current stage's context pack; next does this too)
  show <id|paper_slug|project> [--section Heading]... [--full]   (one node or paper part on request)
  report <complete|none|candidate|confirmed|rejected|proved|failed|question> --summary "..." [--plan ID] [--counterexample ID] [--question "..."] [--assumed-definitions a,b]
  validate [--fix]
  park <asset> --reason TEXT [--note TEXT] | unpark <asset>
  idea add --title "..." --body "..." [--kind approach|question|observation|test_case|risk] [--asset ID]... [--tag TAG]... [--origin researcher|agent]
  idea resolve <ideaId> --by <decision, plan, or asset ID> [--note "..."]
  idea convert <ideaId> --asset ID --goal "..." --steps "line per step" --verification "..."
  question pending | question answer --text "..." | question skip | question poll <id>
  handoff [--note "..."]   (write a shared handoff for the next collaborator)
  library search <words...> [--type T] [--collection C] [--limit N]   (find known results to reuse)
  library list [--collection C] [--unapproved]
  library promote <lib_id> [--as <id>]   (copy a library result into the project as a draft to change it)
  sync status [--no-fetch] | sync pull [--remote NAME] [--continue] | sync prepare [--latex] [--no-fetch] [--note "..."]
  sync publish [--message "..."] [--interactive]   (needs the researcher's confirmation in VS Code or the terminal)
  migrate-approvals   (split research/approvals.json into one file per approved target)
  restore-approvals   (re-apply status: approved where the researcher's approval record still matches the content)
  hook <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop>   (reads hook JSON on stdin)
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
  const sync = await loadSyncConfig(root).catch(() => undefined);
  const contextBudgets = await loadContextBudgets(root);
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths, { iterationCap, git, identity: sync?.identity, extensionVersion: EXTENSION_VERSION, contextBudgets });
  await core.load();
  return core;
}

/** Optional `contextBudgets: { <stage>: tokens }` in .research-assistant.json. */
async function loadContextBudgets(root: string): Promise<Partial<Record<LoopStage, number>> | undefined> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.research-assistant.json'), 'utf8')) as { contextBudgets?: Record<string, unknown> };
    const budgets = Object.entries(raw.contextBudgets ?? {}).filter(([, value]) => typeof value === 'number' && value > 0);
    return budgets.length ? Object.fromEntries(budgets) as Partial<Record<LoopStage, number>> : undefined;
  } catch { return undefined; }
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
function confirmOnTty(text: string): boolean {
  let fd: number;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch { throw new Error('No terminal is attached; run sync publish --interactive yourself in a terminal, or confirm in VS Code.'); }
  try {
    fs.writeSync(fd, `${text}\n\nType "publish" to confirm: `);
    let answer = '';
    const buffer = Buffer.alloc(1);
    while (fs.readSync(fd, buffer, 0, 1, null) === 1 && buffer[0] !== 10) answer += buffer.toString('utf8');
    return answer.trim().toLowerCase() === 'publish';
  } finally { fs.closeSync(fd); }
}

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
  switch (event) {
    case 'SessionStart':
    case 'UserPromptSubmit': {
      if (!state || (state.status !== 'running' && state.status !== 'paused' && !state.pendingQuestion)) return;
      if (session && !core.heartbeat(session)) {
        process.stdout.write(contextOutput(event, `Research loop: another session (${state.lock?.sessionId}) is driving the loop. Do not run research-loop next here unless the researcher asks you to take over with --force.`) + '\n');
        return;
      }
      let brief = core.briefStatus();
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
      return;
    }
    case 'PostToolUse': {
      // Audit only: note research files read outside the current context pack.
      if (!state || state.status !== 'running') return;
      const paths = await loadProjectPaths(root);
      for (const file of researchReads(paths, input, root)) await core.noteRead(file, input.tool_name ?? '');
      return;
    }
    case 'PreToolUse': {
      const paths = await loadProjectPaths(root);
      const decision = preToolUseDecision(paths, input, root);
      if (decision.deny) process.stdout.write(denyOutput(decision.reason ?? 'Denied by the research loop.') + '\n');
      return;
    }
    case 'Stop': {
      if (!state || state.status !== 'running') return;
      if (session && !core.heartbeat(session)) return;
      await core.validateWorkspace({ fix: true });
      let instruction: string | undefined;
      try { const next = await core.next(); instruction = next.blocked ? undefined : next.instruction; } catch { instruction = undefined; }
      const decision = stopDecision(core.current, input, instruction);
      if (decision.capReached) {
        await core.pause(`Autopilot stopped after ${state.autopilot.iterationCap} automatic continuations in this session. To shed accumulated context, resume in a fresh chat (Claude Code: /clear; Codex: a new thread) with the research-loop skill; the loop rebuilds from the files.`);
        return;
      }
      if (!decision.block) { await core.touch(session); return; }
      const key = session ?? 'unknown';
      const record = state.autopilot.sessions[key] ?? { blocks: 0, lastSignature: '', lastBlockAt: '' };
      record.blocks += 1; record.lastSignature = stageSignature(state); record.lastBlockAt = new Date().toISOString();
      state.autopilot.sessions[key] = record;
      await core.touch(session);
      process.stdout.write(stopBlockOutput(decision.reason ?? 'Continue the research loop.') + '\n');
      return;
    }
    default:
      return;
  }
}

function text(value: string | true | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, sub, third] = args.positional;
  if (!command || command === 'help' || args.flags.help) { process.stdout.write(USAGE + '\n'); return; }
  if (command === 'hook') { await runHook(sub, args); return; }
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
  switch (command) {
    case 'status': {
      if (json) out(core.statusSummary());
      else if (args.flags.brief) out(core.briefStatus());
      else {
        out(core.briefStatus());
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
      const next = await core.next();
      out(json ? { ...core.statusSummary(), instruction: next.instruction } : `Started (${provider}). ${next.instruction}`);
      return;
    }
    case 'extend': {
      const provider = args.flags.provider === 'codex' ? 'codex' : args.flags.provider === 'claude' ? 'claude' : undefined;
      await core.extend(text(args.flags.goal, 'goal'), { provider, sessionId: session, force: args.flags.force === true });
      const next = await core.next();
      out(json ? { ...core.statusSummary(), instruction: next.instruction } : `Extending the project. ${next.instruction}`);
      return;
    }
    case 'resume': { await core.resume({ sessionId: session, provider: args.flags.provider === 'codex' ? 'codex' : args.flags.provider === 'claude' ? 'claude' : undefined, force: args.flags.force === true }); const next = await core.next(); out(json ? { ...core.statusSummary(), instruction: next.instruction } : next.instruction); return; }
    case 'pause': { await core.pause(); out('Paused.'); return; }
    case 'stop': { await core.stop(); out('Stopped.'); return; }
    case 'next': {
      if (session && !(await core.touch(session, args.flags.force === true))) throw new Error(`Another session (${core.current?.lock?.sessionId}) is driving this loop; pass --force to take over.`);
      const next = await core.next();
      if (json) out({ stage: next.stage, blocked: next.blocked, instruction: next.instruction, brief: next.brief });
      else out(`Stage: ${next.stage}\n${next.instruction}`);
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
      if (!['complete', 'none', 'candidate', 'confirmed', 'rejected', 'proved', 'failed', 'question'].includes(outcome)) throw new Error('report needs an outcome: complete|none|candidate|confirmed|rejected|proved|failed|question');
      const report: StageReport = {
        outcome, summary: typeof args.flags.summary === 'string' ? args.flags.summary : '',
        planId: typeof args.flags.plan === 'string' ? args.flags.plan : undefined,
        counterexampleId: typeof args.flags.counterexample === 'string' ? args.flags.counterexample : undefined,
        question: typeof args.flags.question === 'string' ? args.flags.question : undefined,
        assumedDefinitions: typeof args.flags['assumed-definitions'] === 'string' ? args.flags['assumed-definitions'].split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      };
      if (outcome !== 'question' && !report.summary.trim()) throw new Error('--summary is required');
      const result = await core.report(report);
      await core.touch(session);
      out(json ? { ...result, ...core.statusSummary() } : `${result.message}\nStage: ${result.stage}`);
      return;
    }
    case 'validate': {
      const result = await core.validateWorkspace({ fix: args.flags.fix === true });
      if (json) out(result);
      else { for (const problem of result.problems) out(`PROBLEM ${problem}`); for (const id of result.fixed) out(`FIXED ${id} reverted to draft`); if (!result.problems.length) out('No approval problems found.'); }
      if (result.problems.length && !args.flags.fix) process.exitCode = 1;
      return;
    }
    case 'park': { await core.park(text(sub, 'asset'), text(args.flags.reason, 'reason'), typeof args.flags.note === 'string' ? args.flags.note : undefined); out(`Parked ${sub}.`); return; }
    case 'unpark': { await core.unpark(text(sub, 'asset')); out(`Unparked ${sub}.`); return; }
    case 'idea': {
      if (sub === 'add') {
        const tags = args.lists.tag ?? [];
        const id = await core.saveIdea(text(args.flags.title, 'title'), text(args.flags.body, 'body'), args.lists.asset ?? [], args.flags.origin === 'agent' ? 'agent' : 'researcher', tags, toIdeaKind(args.flags.kind, tags));
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
