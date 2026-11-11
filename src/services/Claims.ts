import { LoopGit } from './LoopGit';

/**
 * Claims: which collaborator works on which unit (a route's reduction, `plan:<id>`, or one result's
 * own proof work, its asset ID), so two research loops on two machines do not do the same work.
 * Git has no locks, so a claim is a soft lock: an append-only event in the claimer's own file, shared
 * on a branch of its own (`research-claims`, never checked out, so sharing a claim never touches the
 * working tree mid-stage). Two claims on one unit are settled the same way on every machine: the
 * earliest wins. A claim lapses after its lease unless renewed.
 */

export const CLAIMS_BRANCH = 'research-claims';
export const CLAIMS_DIR = 'claims';
export const DEFAULT_LEASE_HOURS = 24;

export interface ClaimEvent { key: string; by: string; machine: string; op: 'claim' | 'release'; at: string; lease_hours: number }

export function parseClaimLines(text: string): ClaimEvent[] {
  const events: ClaimEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Partial<ClaimEvent>;
      if (typeof event.key === 'string' && typeof event.by === 'string' && typeof event.at === 'string' && (event.op === 'claim' || event.op === 'release')) {
        events.push({ key: event.key, by: event.by, machine: String(event.machine ?? ''), op: event.op, at: event.at, lease_hours: typeof event.lease_hours === 'number' && event.lease_hours > 0 ? event.lease_hours : DEFAULT_LEASE_HOURS });
      }
    } catch { /* a torn line: skipped */ }
  }
  return events;
}

export interface ActiveClaim { key: string; by: string; machine: string; since: string; until: string }

/**
 * The claim that holds each unit now: per claimer, their latest event on the unit decides (a release
 * ends it, a claim renews it until its lease runs out); among live claims the earliest start wins,
 * ties by claimer, so every machine names the same holder.
 */
export function claimHolders(events: ClaimEvent[], now: string): Map<string, ActiveClaim> {
  const latest = new Map<string, { first: string; last: ClaimEvent }>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const id = `${event.key}\u0000${event.by}\u0000${event.machine}`;
    const entry = latest.get(id);
    if (event.op === 'release') { latest.delete(id); continue; }
    latest.set(id, { first: entry?.first ?? event.at, last: event });
  }
  const holders = new Map<string, ActiveClaim>();
  const nowMs = Date.parse(now);
  for (const { first, last } of latest.values()) {
    const until = new Date(Date.parse(last.at) + last.lease_hours * 3600_000).toISOString();
    if (Date.parse(until) <= nowMs) continue;
    const current = holders.get(last.key);
    const claim = { key: last.key, by: last.by, machine: last.machine, since: first, until };
    if (!current || first < current.since || (first === current.since && `${last.by}${last.machine}` < `${current.by}${current.machine}`)) holders.set(last.key, claim);
  }
  return holders;
}

/** Where other collaborators' claims come from and where this one's go. */
export interface ClaimTransport {
  /** Every collaborator's claim file but this machine's own, as text. */
  fetch(): Promise<string[]>;
  /** Publish this machine's claim file; false when it could not be shared now. */
  push(mine: string): Promise<boolean>;
}

/**
 * The claims branch over git plumbing: blobs, trees, and a commit built on the remote's tip, pushed
 * without touching HEAD, the index, or the working tree. Each machine writes only its own file, so a
 * push that lost a race is rebuilt on the new tip and retried.
 */
export class GitClaimTransport implements ClaimTransport {
  constructor(private readonly git: LoopGit, private readonly remote: () => Promise<string>, private readonly fileName: string, private readonly who: () => Promise<string>) {}

  private async tracking(): Promise<string> { return `refs/remotes/${await this.remote()}/${CLAIMS_BRANCH}`; }

  private async update(): Promise<void> {
    const remote = await this.remote();
    await this.git.run(['fetch', '-q', remote, `+refs/heads/${CLAIMS_BRANCH}:refs/remotes/${remote}/${CLAIMS_BRANCH}`]);
  }

  async fetch(): Promise<string[]> {
    await this.update();
    const ref = await this.tracking();
    if (!(await this.git.refExists(ref))) return [];
    const listed = await this.git.run(['ls-tree', '--name-only', `${ref}:${CLAIMS_DIR}`]);
    if (listed.code !== 0) return [];
    const texts: string[] = [];
    for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (name === this.fileName) continue;
      const text = await this.git.showFile(ref, `${CLAIMS_DIR}/${name}`);
      if (text) texts.push(text);
    }
    return texts;
  }

  async push(mine: string): Promise<boolean> {
    const remote = await this.remote();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.update();
      const ref = await this.tracking();
      const parent = (await this.git.refExists(ref)) ? (await this.git.must(['rev-parse', ref])).trim() : undefined;
      const blob = (await this.git.run(['hash-object', '-w', '--stdin'], mine)).stdout.trim();
      if (!blob) return false;
      const listed = parent ? await this.git.run(['ls-tree', `${parent}:${CLAIMS_DIR}`]) : undefined;
      const entries = (listed?.code === 0 ? listed.stdout.split('\n').filter((line) => line.trim() && !line.endsWith(`\t${this.fileName}`)) : []);
      entries.push(`100644 blob ${blob}\t${this.fileName}`);
      const sub = (await this.git.run(['mktree'], `${entries.join('\n')}\n`)).stdout.trim();
      const root = (await this.git.run(['mktree'], `040000 tree ${sub}\t${CLAIMS_DIR}\n`)).stdout.trim();
      if (!sub || !root) return false;
      const commit = (await this.git.run(['commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', `claims: ${await this.who()}`])).stdout.trim();
      if (!commit) return false;
      const pushed = await this.git.run(['push', '-q', remote, `${commit}:refs/heads/${CLAIMS_BRANCH}`]);
      if (pushed.code === 0) { await this.git.run(['update-ref', ref, commit]); return true; }
    }
    return false;
  }
}
