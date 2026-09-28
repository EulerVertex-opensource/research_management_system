import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { ResearchLoopCore } from '../services/ResearchLoopCore';
import * as os from 'os';
import { BRIDGE_PATH, BRIDGE_REGISTRY, BridgeEntry } from '../services/ResearchLoopModel';
import { NodeLoopFiles, findProjectRoot, loadProjectPaths } from './nodeFiles';

/**
 * Minimal MCP stdio server that forwards researcher-facing tools to the running
 * VS Code extension over localhost. When the extension is not running, tools
 * that need a human answer return `{ answered: false }` so the agent can stay in
 * auto mode; ideas and status still work directly on the files.
 */

const PENDING_NOTE = 'If the result has status "pending", call await_answer with its id until the status is "final".';
const TOOLS = [
  { name: 'ask_researcher', description: `Ask the researcher a question in a VS Code popup. ${PENDING_NOTE} A final result is {answered:true, text} or {answered:false, reason, auto_action}; on answered:false continue in auto mode as the research-loop skill describes.`, inputSchema: { type: 'object', properties: { question: { type: 'string' }, kind: { type: 'string', enum: ['goals', 'discussion', 'blocked', 'counterexample_review'] }, asset_id: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'kind'] } },
  { name: 'request_approval', description: `Ask the researcher to approve a project, asset proof, definition, citation, or counterexample. Never approves by itself. ${PENDING_NOTE} When the researcher defers, the request stays queued and the loop continues on other work.`, inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['project', 'asset', 'definition', 'citation', 'counterexample'] }, target: { type: 'string' }, summary: { type: 'string' } }, required: ['kind', 'target', 'summary'] } },
  { name: 'await_answer', description: 'Keep waiting for the researcher on a pending ask_researcher or request_approval id. Returns status "pending" again or the final result.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'record_idea', description: 'Save a research idea (intuition, gap, approach, test case) to the ideas folder as a draft idea node.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, related_assets: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body'] } },
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
  if (name === 'ask_researcher' || name === 'request_approval' || name === 'await_answer') return forward(root, name, args);
  const paths = await loadProjectPaths(root);
  const core = new ResearchLoopCore(new NodeLoopFiles(root), paths);
  await core.load();
  if (name === 'record_idea') {
    const ideaId = await core.saveIdea(String(args.title ?? ''), String(args.body ?? ''), Array.isArray(args.related_assets) ? args.related_assets.map(String) : [], 'agent', Array.isArray(args.tags) ? args.tags.map(String) : []);
    return { ok: true, idea_id: ideaId, path: `${paths.ideas}/${ideaId}.md` };
  }
  if (name === 'loop_status') return { ok: true, state: core.statusSummary(), brief: core.briefStatus() };
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
