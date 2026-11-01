import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { ResearchLoopCore } from '../services/ResearchLoopCore';
import * as os from 'os';
import { BRIDGE_PATH, BRIDGE_REGISTRY, BridgeEntry, STATE_PATH } from '../services/ResearchLoopModel';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths } from './nodeFiles';
import { noteAgentActivity } from '../services/AgentActivity';
import { IDEA_KIND_LIST, toIdeaKind } from '../domain/nodeKinds';

/**
 * Minimal MCP stdio server that forwards researcher-facing tools to the running
 * VS Code extension over localhost. When the extension is not running, tools
 * that need a human answer return `{ answered: false }` so the agent can stay in
 * auto mode; ideas and status still work directly on the files.
 */

const PENDING_NOTE = 'If the result has status "pending", call await_answer with its id until the status is "final".';
/** The researcher reads these fields on the dashboard and in popups; see "Writing for the researcher" in the research-loop skill. */
const FOR_RESEARCHER = 'Shown to the researcher as written: mathematical words and result titles, no IDs, file names, or loop terms (slots, rounds, workers, stages).';
const TOOLS = [
  { name: 'ask_researcher', description: `Ask the researcher a question in a VS Code popup. ${PENDING_NOTE} A final result is {answered:true, text} or {answered:false, reason, auto_action}; on answered:false continue in auto mode as the research-loop skill describes. In autonomous mode nothing pops up: the result is final at once with reason "autonomous"; do what auto_action says.`, inputSchema: { type: 'object', properties: { question: { type: 'string', description: `The question, with what you would do by default. ${FOR_RESEARCHER}` }, kind: { type: 'string', enum: ['goals', 'discussion', 'blocked', 'counterexample_review'] }, asset_id: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'kind'] } },
  { name: 'request_approval', description: `Ask the researcher to approve a project, asset proof, definition, citation, counterexample, or construction specification. Never approves by itself. ${PENDING_NOTE} When the researcher defers, the request stays queued and the loop continues on other work.`, inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['project', 'asset', 'definition', 'citation', 'counterexample', 'specification'] }, target: { type: 'string', description: 'The asset or definition ID; `project` for kind project.' }, summary: { type: 'string', description: `What to check and where to look, in at most five lines; $…$ math renders. ${FOR_RESEARCHER}` } }, required: ['kind', 'target', 'summary'] } },
  { name: 'await_answer', description: 'Keep waiting for the researcher on a pending ask_researcher or request_approval id. Returns status "pending" again or the final result.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'record_idea', description: 'Save a research idea to the ideas folder as a draft idea node. kind says what it is: approach (possible route), question (open question for the researcher), observation, test_case (object worth checking), or risk (suspected gap).', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string', enum: [...IDEA_KIND_LIST] }, related_assets: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, origin: { type: 'string', enum: ['agent', 'researcher'], description: 'researcher when it records the researcher\'s own doubt or idea in their words (the teaching chat); agent (the default) otherwise.' } }, required: ['title', 'body'] } },
  { name: 'mark_understood', description: `Teaching chat: ask the researcher, in a VS Code popup, how well they now understand a verified result; they choose the level (what it says, the key idea, every step) or decline. Never marks by itself. ${PENDING_NOTE} A final result is {answered:true, level} or {answered:false, reason}.`, inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'The verified result or definition ID.' }, suggested: { type: 'string', enum: ['black_box', 'idea', 'full'], description: 'The level the conversation reached, offered first.' }, note: { type: 'string', description: 'The researcher\'s own one-line summary from the conversation, saved with the mark if they accept.' } }, required: ['target'] } },
  { name: 'loop_status', description: 'Current research loop status: stage, asset, pending question, approval queue, parked assets.', inputSchema: { type: 'object', properties: {} } },
];

interface Rpc { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } }

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function registeredRoots(): Promise<BridgeEntry[]> {
  try {
    const entries = JSON.parse(await fs.readFile(path.join(os.homedir(), ...BRIDGE_REGISTRY), 'utf8')) as BridgeEntry[];
    return entries.filter((entry) => entry && typeof entry.root === 'string' && alive(entry.pid));
  } catch { return []; }
}

/** `--project`, else the nearest project above cwd, else the single running extension bridge (or the one containing cwd). */
async function projectRoot(): Promise<string | undefined> {
  const index = process.argv.indexOf('--project');
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  const local = findProjectRoot(process.cwd());
  if (local) return local;
  const entries = await registeredRoots();
  const cwd = path.resolve(process.cwd());
  const containing = entries.find((entry) => cwd === entry.root || cwd.startsWith(entry.root + path.sep));
  return (containing ?? (entries.length === 1 ? entries[0] : undefined))?.root;
}

/** The extension answers within its 45 s slice; this bound only guards a hung extension. */
const CALL_TIMEOUT_MS = Number(process.env.RESEARCH_LOOP_MCP_CALL_TIMEOUT_MS) || 55_000;

async function forward(root: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let bridge: { port: number; token: string } | undefined;
  try { bridge = JSON.parse(await fs.readFile(path.join(root, BRIDGE_PATH), 'utf8')); } catch { bridge = undefined; }
  if (!bridge?.port || !bridge.token) return { answered: false, reason: 'extension not running' };
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.status === 401) return { answered: false, reason: 'unauthorized' };
    if (!response.ok) return { answered: false, reason: `extension error ${response.status}` };
    return await response.json() as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.name : String(error);
    return { answered: false, reason: /Timeout|Abort/i.test(message) ? 'timeout' : 'extension not running' };
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = await projectRoot();
  if (!root) return { ok: false, answered: false, reason: 'no .research-assistant.json found and no running Research Assistant extension' };
  // Only an agent calls these tools: a sign of life for the dashboard while the loop runs (the teaching chat's popup is not the loop's work).
  const files = new NodeLoopFiles(root);
  const running = await files.readFile(STATE_PATH).then((text) => (JSON.parse(text) as { status?: string }).status === 'running').catch(() => false);
  if (running && name !== 'mark_understood') await noteAgentActivity(files, { kind: 'active', throttle: true });
  if (name === 'ask_researcher' || name === 'request_approval' || name === 'await_answer') return forward(root, name, args);
  if (name === 'mark_understood') {
    const result = await forward(root, name, args);
    // Without VS Code the researcher can still mark it, from their own terminal only.
    return result.reason === 'extension not running' ? { ...result, note: `Ask the researcher to run, in their own terminal: node .agents/skills/research-loop/scripts/research-loop.cjs teach mark ${String(args.target ?? '<id>')} --level ${String(args.suggested ?? 'idea')} --interactive` } : result;
  }
  const paths = await loadProjectPaths(root);
  const core = new ResearchLoopCore(files, paths);
  await core.load();
  if (name === 'record_idea') {
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const ideaId = await core.saveIdea(String(args.title ?? ''), String(args.body ?? ''), Array.isArray(args.related_assets) ? args.related_assets.map(String) : [], args.origin === 'researcher' ? 'researcher' : 'agent', tags, toIdeaKind(args.kind, tags));
    return { ok: true, idea_id: ideaId, path: `${paths.ideas}/${ideaId}.md` };
  }
  if (name === 'loop_status') return { ok: true, state: core.statusSummary({ recentParked: 3 }), brief: core.briefStatus() };
  throw new Error(`Unknown tool ${name}`);
}

function send(message: Rpc): void { process.stdout.write(JSON.stringify(message) + '\n'); }

async function handle(message: Rpc): Promise<void> {
  const { id, method, params } = message;
  const reply = (result: unknown) => { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); };
  try {
    switch (method) {
      case 'initialize':
        reply({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'research-assistant', version: '0.1.0' } });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: TOOLS });
        return;
      case 'tools/call': {
        const name = String(params?.name ?? '');
        if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool ${name}`);
        const result = await callTool(name, params?.arguments ?? {});
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        return;
      }
      default:
        if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } });
  }
}

const queue: Promise<void>[] = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message: Rpc;
  try { message = JSON.parse(line); } catch { return; }
  queue.push(handle(message));
});
process.stdin.on('end', () => { void Promise.all(queue).then(() => process.exit(0)); });
