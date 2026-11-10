import * as crypto from 'crypto';
import * as os from 'os';
import { LoopFiles, STATE_DIR } from './ResearchLoopModel';

/**
 * One writer of the loop state at a time, across processes: the extension, each CLI command and hook,
 * and each chat's MCP server. Every one of them loads state.json, changes it, and writes it back whole,
 * so without this a slower writer silently overwrites a faster one (and two chats can both "win" the
 * driver lock). The lock is a file created exclusively; its holder refreshes it while it works, and a
 * waiter breaks it only when its holder is gone (a dead process on this machine) or has gone quiet.
 */
export const STATE_LOCK_PATH = `${STATE_DIR}/state.lock`;
/** How long a writer waits for the lock before giving up with the holder's name. */
export const STATE_LOCK_WAIT_MS = 30_000;
/** A lock not refreshed for this long is abandoned (its holder refreshes every STATE_LOCK_REFRESH_MS). */
export const STATE_LOCK_STALE_MS = 90_000;
export const STATE_LOCK_REFRESH_MS = 20_000;

export interface StateLockHolder { token: string; pid: number; host: string; op: string; at: string; refreshedAt: string }
export interface StateLockOptions { waitMs?: number; staleMs?: number; refreshMs?: number }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readHolder(files: LoopFiles): Promise<StateLockHolder | undefined> {
  const raw = await files.readFile(STATE_LOCK_PATH).catch(() => '');
  try { return raw.trim() ? JSON.parse(raw) as StateLockHolder : undefined; } catch { return undefined; }
}

/** Why `holder` no longer holds the lock, or undefined while it does. */
export function abandoned(holder: StateLockHolder, staleMs: number, now = Date.now()): string | undefined {
  if (holder.host === os.hostname() && Number.isInteger(holder.pid) && !alive(holder.pid)) return `process ${holder.pid} is gone`;
  const last = Date.parse(holder.refreshedAt ?? holder.at);
  if (Number.isFinite(last) && now - last > staleMs) return `not refreshed since ${holder.refreshedAt ?? holder.at}`;
  return undefined;
}

/** The lock stayed taken for the whole wait. */
export class StateLockBusy extends Error { override name = 'StateLockBusy'; }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the state lock for `op`; resolves to its release. A file system that cannot create a file
 * exclusively (an in-memory one in tests, a virtual workspace) gets no lock: a no-op release.
 */
export async function acquireStateLock(files: LoopFiles, op: string, options: StateLockOptions = {}): Promise<() => Promise<void>> {
  if (!files.createExclusive) return async () => undefined;
  const waitMs = options.waitMs ?? STATE_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? STATE_LOCK_STALE_MS;
  const now = new Date().toISOString();
  const mine: StateLockHolder = { token: crypto.randomBytes(8).toString('hex'), pid: process.pid, host: os.hostname(), op, at: now, refreshedAt: now };
  const deadline = Date.now() + waitMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 250)) {
    if (await files.createExclusive(STATE_LOCK_PATH, JSON.stringify(mine) + '\n')) break;
    const holder = await readHolder(files);
    const gone = holder ? abandoned(holder, staleMs) : undefined;
    if (holder && gone) {
      // Break it only if it is still that same abandoned lock, not one a faster waiter just took.
      const again = await readHolder(files);
      if (again?.token === holder.token && files.deleteFile) await files.deleteFile(STATE_LOCK_PATH);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder ? `${holder.op} (process ${holder.pid} on ${holder.host}, since ${holder.at})` : 'another process';
      throw new StateLockBusy(`The research loop is busy: ${who} holds ${STATE_LOCK_PATH}. Try again in a moment. If no Research Assistant process is running, delete that file.`);
    }
    await sleep(delay);
  }
  const refresh = setInterval(() => {
    void (async () => {
      const holder = await readHolder(files);
      if (holder?.token === mine.token) await files.writeFile(STATE_LOCK_PATH, JSON.stringify({ ...mine, refreshedAt: new Date().toISOString() }) + '\n');
    })().catch(() => undefined);
  }, options.refreshMs ?? STATE_LOCK_REFRESH_MS);
  refresh.unref?.();
  return async () => {
    clearInterval(refresh);
    // A lock broken as abandoned and taken by another writer is theirs now: leave it.
    const holder = await readHolder(files);
    if (holder?.token === mine.token && files.deleteFile) await files.deleteFile(STATE_LOCK_PATH);
  };
}
