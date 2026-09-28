import * as path from 'path';
import * as crypto from 'crypto';
import { ResearchLoopCore } from '../services/ResearchLoopCore';
import { ReportOutcome, StageReport, stageSignature } from '../services/ResearchLoopModel';
import { HookInput, preToolUseDecision, stopDecision } from '../services/ResearchLoopHooks';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths } from './nodeFiles';

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
  report <complete|none|candidate|confirmed|rejected|proved|failed|question> --summary "..." [--plan ID] [--counterexample ID] [--question "..."] [--assumed-definitions a,b]
  validate [--fix]
  park <asset> --reason TEXT [--note TEXT] | unpark <asset>
  idea add --title "..." --body "..." [--asset ID]... [--origin researcher|agent]
  idea convert <ideaId> --asset ID --goal "..." --steps "line per step" --verification "..."
  question pending | question answer --text "..." | question skip | question poll <id>
  hook <SessionStart|UserPromptSubmit|PreToolUse|Stop|SubagentStop>   (reads hook JSON on stdin)
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

async function openCore(root: string, iterationCap?: number): Promise<ResearchLoopCore> {
  const paths = await loadProjectPaths(root);
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths, { iterationCap });
  await core.load();
  return core;
}

async function runHook(event: string, args: Args): Promise<void> {
  let input: HookInput = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  const root = typeof args.flags.project === 'string' ? path.resolve(args.flags.project) : findProjectRoot(input.cwd ?? process.cwd());
  if (!root) return;
  let core: ResearchLoopCore;
  try { core = await openCore(root); } catch { return; }
  const state = core.current;
  const session = input.session_id;
  switch (event) {
    case 'SessionStart':
    case 'UserPromptSubmit': {
      if (!state || (state.status !== 'running' && state.status !== 'paused' && !state.pendingQuestion)) return;
      if (session && !core.heartbeat(session)) {
        process.stdout.write(`Research loop: another session (${state.lock?.sessionId}) is driving the loop. Do not run research-loop next here unless the researcher asks you to take over with --force.\n`);
        return;
      }
      process.stdout.write(core.briefStatus() + '\n');
      await core.consumeAnswers();
      await core.touch(session);
      return;
    }
    case 'PreToolUse': {
      const paths = await loadProjectPaths(root);
      const decision = preToolUseDecision(paths, input, root);
      if (decision.deny) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } }) + '\n');
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
        await core.pause(`Autopilot stopped after ${state.autopilot.iterationCap} automatic continuations in this session. Resume from the status bar or with research-loop resume.`);
        return;
      }
      if (!decision.block) { await core.touch(session); return; }
      const key = session ?? 'unknown';
      const record = state.autopilot.sessions[key] ?? { blocks: 0, lastSignature: '', lastBlockAt: '' };
      record.blocks += 1; record.lastSignature = stageSignature(state); record.lastBlockAt = new Date().toISOString();
      state.autopilot.sessions[key] = record;
      await core.touch(session);
      // Exit code 2 with the reason on stderr is the documented blocking contract for both Claude Code and Codex.
      process.stderr.write(decision.reason + '\n');
      process.exitCode = 2;
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
  const json = args.flags.json === true;
  const cap = typeof args.flags['iteration-cap'] === 'string' ? Number(args.flags['iteration-cap']) : undefined;
  const core = await openCore(root, cap);
  const session = typeof args.flags.session === 'string' ? args.flags.session : undefined;
  const out = (value: unknown) => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  switch (command) {
    case 'status': {
      if (json) out(core.statusSummary());
      else if (args.flags.brief) out(core.briefStatus());
      else { out(core.briefStatus()); const events = await core.recentEvents(8); if (events.length) out('Recent events:\n' + events.map((event) => `- ${String(event.at)} ${String(event.type)}${event.stage ? ` ${String(event.stage)}` : ''}${event.assetId ? ` ${String(event.assetId)}` : ''}${event.summary ? ` — ${String(event.summary)}` : ''}`).join('\n')); }
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
        const id = await core.saveIdea(text(args.flags.title, 'title'), text(args.flags.body, 'body'), args.lists.asset ?? [], args.flags.origin === 'agent' ? 'agent' : 'researcher', args.lists.tag ?? []);
        out(json ? { ideaId: id } : `Saved idea ${id}.`);
        return;
      }
      if (sub === 'convert') {
        const id = await core.convertIdea(text(third, 'ideaId'), text(args.flags.asset, 'asset'), text(args.flags.goal, 'goal'), text(args.flags.steps, 'steps'), text(args.flags.verification, 'verification'));
        out(json ? { planId: id } : `Created plan ${id} from ${third}.`);
        return;
      }
      throw new Error('idea add|convert');
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
    default:
      throw new Error(`Unknown command ${command}\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { parseArgs, crypto };
