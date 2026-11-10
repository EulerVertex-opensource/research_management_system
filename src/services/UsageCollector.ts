import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { UsageRole, UsageView } from '../models/usage';
import { FileUsage, TranscriptKind, consumeLine, emptyFileUsage } from '../domain/usageParse';
import { UsageThread, buildUsageView } from '../domain/usageView';
import { STATE_DIR } from './ResearchLoopModel';

/**
 * Finds the loop's chats among the agents' own transcripts and reads their
 * usage, incrementally: each file is read from where the last read stopped,
 * and what was read is kept per minute in a cache inside the project.
 *
 * Driver chats are known from the loop (the hooks' `context_size` events with
 * their transcript, and the session registry). Their workers:
 * - Claude Code: `<transcript dir>/<session>/subagents/agent-*.jsonl`, typed by the `.meta.json` beside it.
 * - Codex: rollout files under `sessions/YYYY/MM/DD/` whose first line names the driver as `parent_thread_id`.
 * Only usage numbers are read; nothing leaves the machine.
 */

export const USAGE_CACHE_PATH = `${STATE_DIR}/usage-cache.json`;
/** Bumped when what is read from a line changes: an older cache is read again from the start. */
const CACHE_VERSION = 2;
const HEADER_BYTES = 32 * 1024;
const CHUNK_BYTES = 1024 * 1024;

interface CachedFile extends FileUsage { size: number }
interface CodexHeader { parent?: string; role?: string; label?: string }
interface UsageCache {
  version: number;
  files: Record<string, CachedFile>;
  /** Codex rollout file → its subagent header (null: not a subagent). */
  codexHeaders: Record<string, CodexHeader | null>;
  /** Every driver chat seen, with its transcript when known: the session registry keeps only the latest. */
  drivers: Record<string, string>;
}

export interface UsageCollectOptions {
  root: string;
  /** Driver chats: session id → transcript path when the hooks recorded it ('' when unknown). */
  drivers: Map<string, string>;
  claudeHome?: string;
  codexHome?: string;
}

export interface CollectedUsage { threads: UsageThread[]; problems: string[] }

const claudeHomeOf = (options: UsageCollectOptions) => options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const codexHomeOf = (options: UsageCollectOptions) => options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

/** Claude Code's folder name for a project: every character but letters and digits becomes '-'. */
export function claudeProjectFolder(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, '-');
}

/** A worker's role from its agent type (Claude) or role (Codex). */
export function workerRole(type: string | undefined): UsageRole {
  if (type === 'research-worker-light') return 'light';
  if (type === 'research-worker-deep') return 'deep';
  return 'other';
}

const exists = (file: string) => fs.stat(file).then((stat) => stat.isFile(), () => false);

async function readCache(root: string): Promise<UsageCache> {
  try {
    const cache = JSON.parse(await fs.readFile(path.join(root, USAGE_CACHE_PATH), 'utf8')) as UsageCache;
    if (cache.version === CACHE_VERSION && cache.files && cache.codexHeaders && cache.drivers) return cache;
  } catch { /* none yet, or unreadable: start over */ }
  return { version: CACHE_VERSION, files: {}, codexHeaders: {}, drivers: {} };
}

async function writeCache(root: string, cache: UsageCache): Promise<void> {
  const file = path.join(root, USAGE_CACHE_PATH);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(cache));
  // Another process writing the same cache at once only costs a re-read later.
  await fs.rename(temp, file).catch(async () => { await fs.rm(temp, { force: true }); });
}

/** Read what was appended to `file` since `cached`; returns the updated entry. */
async function readIncrement(file: string, kind: TranscriptKind, cached: CachedFile | undefined, mainChain: boolean): Promise<CachedFile> {
  const stat = await fs.stat(file);
  // A file that shrank was replaced: read it again from the start.
  let entry: CachedFile = cached && cached.kind === kind && stat.size >= cached.offset ? cached : { ...emptyFileUsage(kind), size: 0 };
  if (stat.size === entry.offset) return { ...entry, size: stat.size };
  entry = { ...entry, minutes: entry.minutes.map((minute) => [...minute] as typeof minute), compactions: [...entry.compactions], stops: [...(entry.stops ?? [])] };
  const handle = await fs.open(file, 'r');
  try {
    let position = entry.offset;
    let carry: Buffer = Buffer.alloc(0);
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(10, start); newline !== -1; newline = data.indexOf(10, start)) {
        consumeLine(entry, data.toString('utf8', start, newline), mainChain);
        start = newline + 1;
      }
      carry = Buffer.from(data.subarray(start));
      data = Buffer.alloc(0);
    }
    // A last line still being written is read next time, whole.
    entry.offset = position - carry.length;
  } finally { await handle.close(); }
  return { ...entry, size: stat.size };
}

/** A Codex rollout file (under `sessions/`, named `rollout-…-<thread>.jsonl`), as opposed to a Claude transcript. */
const isRollout = (file: string) => path.basename(file).startsWith('rollout-') && file.includes(`${path.sep}sessions${path.sep}`);

/** Claude transcript of a session: the project's own folder, or any project folder. */
async function findClaudeTranscript(options: UsageCollectOptions, id: string): Promise<string | undefined> {
  const projects = path.join(claudeHomeOf(options), 'projects');
  const own = path.join(projects, claudeProjectFolder(options.root), `${id}.jsonl`);
  if (await exists(own)) return own;
  for (const folder of await fs.readdir(projects).catch(() => [] as string[])) {
    const candidate = path.join(projects, folder, `${id}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** Every Codex rollout file, by date folder (oldest first). */
async function codexRollouts(options: UsageCollectOptions): Promise<string[]> {
  const sessions = path.join(codexHomeOf(options), 'sessions');
  const files: string[] = [];
  const list = async (folder: string) => (await fs.readdir(folder).catch(() => [] as string[])).sort();
  for (const year of await list(sessions)) for (const month of await list(path.join(sessions, year))) for (const day of await list(path.join(sessions, year, month))) {
    for (const name of await list(path.join(sessions, year, month, day))) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(path.join(sessions, year, month, day, name));
  }
  return files;
}

async function codexHeader(file: string): Promise<CodexHeader | null> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const head = buffer.toString('utf8', 0, bytesRead);
    const spawn = /"thread_spawn":\{"parent_thread_id":"([^"]+)"/.exec(head);
    if (!spawn) return null;
    const role = /"agent_role":"([^"]+)"/.exec(head)?.[1];
    const label = /"agent_path":"([^"]+)"/.exec(head)?.[1] ?? /"agent_nickname":"([^"]+)"/.exec(head)?.[1];
    return { parent: spawn[1], ...(role ? { role } : {}), ...(label ? { label: label.replace(/^\/root\//, '') } : {}) };
  } finally { await handle.close(); }
}

export async function collectUsage(options: UsageCollectOptions): Promise<CollectedUsage> {
  const cache = await readCache(options.root);
  const before = JSON.stringify(cache.drivers);
  for (const [id, transcript] of options.drivers) if (transcript || !(id in cache.drivers)) cache.drivers[id] = transcript || cache.drivers[id] || '';
  const problems: string[] = [];
  const threads: UsageThread[] = [];
  let changed = JSON.stringify(cache.drivers) !== before;
  const seenFiles = new Set<string>();

  const read = async (file: string, kind: TranscriptKind, mainChain: boolean) => {
    seenFiles.add(file);
    const cached = cache.files[file];
    const entry = await readIncrement(file, kind, cached, mainChain);
    if (!cached || cached.offset !== entry.offset || cached.size !== entry.size) { cache.files[file] = entry; changed = true; }
    return entry;
  };
  const thread = (id: string, provider: TranscriptKind, role: UsageRole, usage: FileUsage, extra: { parent?: string; label?: string } = {}): UsageThread => ({
    id, provider, role, ...extra, minutes: usage.minutes, compactions: usage.compactions, stops: usage.stops ?? [], ...(usage.quota ? { quota: usage.quota } : {}),
  });

  let rollouts: string[] | undefined;
  for (const [id, recorded] of Object.entries(cache.drivers)) {
    try {
      const known = recorded && recorded.endsWith(`${id}.jsonl`) && await exists(recorded) ? recorded : undefined;
      const claude = known ? (isRollout(known) ? undefined : known) : await findClaudeTranscript(options, id);
      if (claude) {
        threads.push(thread(id, 'claude', 'driver', await read(claude, 'claude', true)));
        const folder = path.join(path.dirname(claude), id, 'subagents');
        for (const name of (await fs.readdir(folder).catch(() => [] as string[])).filter((entry) => entry.endsWith('.jsonl')).sort()) {
          const file = path.join(folder, name);
          let meta: { agentType?: string; description?: string } = {};
          try { meta = JSON.parse(await fs.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* untyped worker */ }
          threads.push(thread(name.replace(/\.jsonl$/, ''), 'claude', workerRole(meta.agentType), await read(file, 'claude', false), { parent: id, ...(meta.description ? { label: meta.description } : {}) }));
        }
        continue;
      }
      rollouts ??= await codexRollouts(options);
      const own = known ?? rollouts.find((file) => file.endsWith(`-${id}.jsonl`));
      if (!own) { problems.push(`No transcript found for chat ${id}.`); continue; }
      threads.push(thread(id, 'codex', 'driver', await read(own, 'codex', true)));
      // Workers start after their driver: only rollouts from its day on.
      const day = path.dirname(own);
      for (const file of rollouts) {
        if (file === own || path.dirname(file) < day) continue;
        if (!(file in cache.codexHeaders)) { cache.codexHeaders[file] = await codexHeader(file).catch(() => null); changed = true; }
        const header = cache.codexHeaders[file];
        if (header?.parent !== id) continue;
        const workerId = /-([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? path.basename(file);
        threads.push(thread(workerId, 'codex', workerRole(header.role), await read(file, 'codex', true), { parent: id, ...(header.label ? { label: header.label } : {}) }));
      }
    } catch (error) {
      problems.push(`Could not read the transcript of chat ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Files no longer present are forgotten.
  for (const file of Object.keys(cache.files)) if (!seenFiles.has(file) && !(await exists(file))) { delete cache.files[file]; changed = true; }
  if (changed) await writeCache(options.root, cache).catch(() => undefined);
  return { threads, problems };
}

/** Driver chats the loop knows: `context_size` events (with their transcripts) and the session registry's driving chats. */
export function knownDrivers(events: Array<Record<string, unknown>>, sessionsText: string | undefined): Map<string, string> {
  const drivers = new Map<string, string>();
  try {
    const drive = (JSON.parse(sessionsText ?? '') as { drive?: Record<string, string> }).drive ?? {};
    for (const id of Object.keys(drive)) drivers.set(id, '');
  } catch { /* no registry yet */ }
  for (const event of events) {
    if (event.type !== 'context_size' && event.type !== 'context_compacted') continue;
    const id = typeof event.sessionId === 'string' ? event.sessionId : '';
    if (!id) continue;
    const transcript = typeof event.transcriptPath === 'string' ? event.transcriptPath : '';
    if (transcript || !drivers.has(id)) drivers.set(id, transcript || drivers.get(id) || '');
  }
  return drivers;
}

/** The Usage card for `root`: knows its driver chats from the loop's events and session registry. */
export async function loadUsageView(options: { root: string; events: Array<Record<string, unknown>>; span?: string; resetTokens: number; title?: (id: string) => string; claudeHome?: string; codexHome?: string; now?: number }): Promise<UsageView> {
  const sessionsText = await fs.readFile(path.join(options.root, STATE_DIR, 'sessions.json'), 'utf8').catch(() => undefined);
  const { threads, problems } = await collectUsage({ root: options.root, drivers: knownDrivers(options.events, sessionsText), claudeHome: options.claudeHome, codexHome: options.codexHome });
  return buildUsageView({ events: options.events, threads, span: options.span, now: options.now ?? Date.now(), resetTokens: options.resetTokens, title: options.title, problems });
}
