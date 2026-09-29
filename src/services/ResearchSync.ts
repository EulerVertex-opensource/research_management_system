import * as crypto from 'crypto';
import * as path from 'path';
import { SyncConfig } from '../models/types';
import { LOOP_COMMAND } from './AgentProviders';
import { legacyApprovalsPath } from './ApprovalStore';
import { parseMarkdown } from './Frontmatter';
import { LoopGit, NameStatus } from './LoopGit';
import { LoopFiles, SYNC_PATH } from './ResearchLoopModel';
import { ResearchLoopCore } from './ResearchLoopCore';
import { parseHandoff } from './ResearchRecords';
import { summarizeResearchChanges } from './SyncSummary';
import { isCited } from '../domain/schema';

/**
 * Git-aware sync for the research loop: pull with re-validation and state
 * rebuild, a pre-share checklist, and a human-confirmed publish. Git never
 * picks a side in a conflict here; conflicts stop and wait for the researcher.
 */

export interface SyncRecord {
  phase: 'idle' | 'conflict';
  operation?: 'pull' | 'publish';
  preHead?: string;
  remote?: string;
  branch?: string;
  wasRunning?: boolean;
  conflicted?: string[];
  prepared?: { head: string; fingerprint: string; at: string; handoff?: string; summary: string[] };
  lastPull?: { head: string; at: string; remote: string };
  lastPublish?: { commit: string; at: string; remotes: string[] };
}

export interface CheckResult { name: string; ok: boolean; warning?: boolean; details: string[] }
export interface PullResult { status: 'up_to_date' | 'pulled' | 'conflict'; summary: string[]; problems: string[]; warnings: string[]; conflicted?: string[]; next?: string }
export interface PrepareResult { ok: boolean; checks: CheckResult[]; summary: string[]; handoff?: string }
export interface PublishPreview { files: Array<{ code: string; path: string }>; ahead: number; message: string; targets: string[] }
export interface PublishResult { status: 'nothing' | 'published' | 'conflict' | 'blocked'; commit?: string; pushed: string[]; warnings: string[]; summary: string[] }
export type CommandRunner = (command: string) => Promise<{ code: number; output: string }>;

const WORKING_STAGES = new Set(['draft_project', 'scaffold', 'sources', 'falsify', 'verify_counterexample', 'plan', 'execute']);

export class ResearchSync {
  constructor(
    private readonly core: ResearchLoopCore,
    private readonly files: LoopFiles,
    private readonly git: LoopGit,
    private readonly config: SyncConfig,
    private readonly runCommand?: CommandRunner,
  ) {}

  // ---------- bookkeeping ----------

  async record(): Promise<SyncRecord> {
    const raw = await this.files.readFile(SYNC_PATH).catch(() => '');
    try { return raw.trim() ? JSON.parse(raw) as SyncRecord : { phase: 'idle' }; } catch { return { phase: 'idle' }; }
  }

  private async saveRecord(record: SyncRecord): Promise<void> {
    await this.files.writeFile(SYNC_PATH, JSON.stringify(record, null, 2) + '\n');
  }

  /** Paths a publish commits and a pull summarizes: research folders, manuscript, and project config. */
  async syncPaths(): Promise<string[]> {
    const paths = this.core.projectPaths;
    const shared = this.core.shared;
    const research = paths.researchRoot !== '.' ? [paths.researchRoot] : [
      paths.projectMd, paths.paperIndex, paths.assets, paths.definitions, paths.ideas, paths.plans, paths.papers, paths.writingRoot,
      shared.checks, shared.decisions, shared.handoffs, shared.approvals, legacyApprovalsPath(paths.researchRoot),
    ];
    const manuscript = [paths.mainTex, paths.bibliography, ...paths.macroFiles, ...(paths.notations ? [paths.notations] : []), paths.sections];
    const candidates = [...new Set([...research, ...manuscript, paths.config, '.gitattributes', ...this.config.include])];
    const result: string[] = [];
    for (const candidate of candidates) if (candidate && candidate !== '.' && (await this.files.exists(candidate) || await this.tracked(candidate))) result.push(candidate);
    return result;
  }

  private async tracked(file: string): Promise<boolean> {
    return (await this.git.run(['ls-files', '--error-unmatch', '--', file])).code === 0;
  }

  private async target(remote?: string): Promise<{ remote: string; branch: string; ref: string }> {
    const chosen = remote ?? this.config.remote;
    const overleaf = Boolean(this.config.overleafRemote) && chosen === this.config.overleafRemote;
    const branch = overleaf ? this.config.overleafBranch : this.config.branch ?? await this.git.branch();
    if (!branch) throw new Error('Not on a branch (detached HEAD). Check out a branch or set sync.branch in .research-assistant.json.');
    return { remote: chosen, branch, ref: `${chosen}/${branch}` };
  }

  private async fetch(remote: string): Promise<void> {
    const result = await this.git.run(['fetch', '--prune', remote]);
    if (result.code !== 0) throw new Error(`git fetch ${remote} failed:\n${(result.stderr || result.stdout).trim()}\nCheck sync.remote in .research-assistant.json and your credentials.`);
  }

  private async identity(): Promise<string> { return (await this.core.provenance()).performed_by; }

  /** Hash of HEAD plus every uncommitted change under the sync paths; publish refuses if it moved since prepare. */
  private async fingerprint(): Promise<string> {
    const hash = crypto.createHash('sha256');
    hash.update(`${await this.git.head() ?? ''}\n`);
    for (const entry of await this.git.status(await this.syncPaths())) {
      const content = await this.files.readFile(entry.path).catch(() => '');
      hash.update(`${entry.code} ${entry.path} ${crypto.createHash('sha256').update(content).digest('hex')}\n`);
    }
    return hash.digest('hex');
  }

  // ---------- status ----------

  async status(options: { fetch?: boolean } = {}): Promise<Record<string, unknown>> {
    const record = await this.record();
    const { remote, branch, ref } = await this.target();
    let fetchError: string | undefined;
    if (options.fetch !== false) await this.fetch(remote).catch((error: unknown) => { fetchError = error instanceof Error ? error.message : String(error); });
    const hasUpstream = await this.git.refExists(ref);
    const dirty = await this.git.status(await this.syncPaths());
    const state = this.core.current;
    const stageEdits = state && WORKING_STAGES.has(state.stage) ? await this.core.changedFiles() : undefined;
    const handoff = await this.core.latestHandoff();
    return {
      remote, branch, overleafRemote: this.config.overleafRemote,
      ahead: hasUpstream ? await this.git.revCount(`${ref}..HEAD`) : undefined,
      behind: hasUpstream ? await this.git.revCount(`HEAD..${ref}`) : undefined,
      upstreamMissing: !hasUpstream || undefined,
      fetchError,
      uncommitted: dirty.map((entry) => `${entry.code.trim() || '?'} ${entry.path}`),
      unreportedStageEdits: stageEdits ? [...stageEdits.added, ...stageEdits.modified] : [],
      phase: record.phase, conflicted: record.conflicted,
      prepared: record.prepared ? { at: record.prepared.at, head: record.prepared.head.slice(0, 8) } : undefined,
      lastPull: record.lastPull, lastPublish: record.lastPublish,
      latestHandoff: handoff ? { file: handoff.file, by: handoff.performedBy, at: handoff.createdAt, workingOn: handoff.workingOn } : undefined,
      loop: state ? { status: state.status, stage: state.stage, assetId: state.current.assetId } : undefined,
    };
  }

  // ---------- pull ----------

  async pull(options: { remote?: string; continue?: boolean } = {}): Promise<PullResult> {
    const record = await this.record();
    if (options.continue) {
      if (record.phase !== 'conflict') {
        // Re-baseline after a raw git pull or a manual merge: nothing to resume, but the loop must forget the old snapshot.
        const base = record.preHead ?? this.core.current?.current.baseCommit ?? record.lastPull?.head ?? (await this.git.head())!;
        return this.integrate(base, { ...record, operation: 'pull' }, 'manual');
      }
      const inProgress = await this.git.operationInProgress();
      const conflicts = await this.git.conflicts();
      if (inProgress || conflicts.length) {
        throw new Error(`The ${inProgress ?? 'merge'} is not finished${conflicts.length ? `; unresolved: ${conflicts.join(', ')}` : ''}. The researcher resolves each conflict (never pick a side for a mathematical statement automatically), then runs \`git add <file>\` and \`git ${inProgress === 'rebase' ? 'rebase --continue' : 'commit'}\`, then \`${LOOP_COMMAND} sync pull --continue\`.`);
      }
      return this.integrate(record.preHead!, record, record.remote ?? this.config.remote);
    }
    if (record.phase === 'conflict') throw new Error(`A ${record.operation ?? 'pull'} stopped on conflicts in ${record.conflicted?.join(', ') ?? 'research files'}. Resolve them, then run \`${LOOP_COMMAND} sync pull --continue\`.`);
    const state = this.core.current;
    if (state && WORKING_STAGES.has(state.stage)) {
      const { added, modified } = await this.core.changedFiles();
      if (added.length || modified.length) throw new Error(`Stage ${state.stage} has unreported edits (${[...added, ...modified].join(', ')}). Report the stage first (${LOOP_COMMAND} report ...), or restore the files, then pull.`);
    }
    const dirty = await this.git.status(await this.syncPaths());
    const trackedElsewhere = (await this.git.status([], false)).filter((entry) => !dirty.some((item) => item.path === entry.path));
    if (dirty.length || trackedElsewhere.length) {
      throw new Error(`Uncommitted changes would be mixed with the pull:\n${[...dirty, ...trackedElsewhere].map((entry) => `  ${entry.code} ${entry.path}`).join('\n')}\nShare them first (${LOOP_COMMAND} sync prepare, then the researcher publishes), or commit/stash them.`);
    }
    const { remote, ref } = await this.target(options.remote);
    await this.fetch(remote);
    if (!(await this.git.refExists(ref))) throw new Error(`${ref} does not exist. Set sync.remote / sync.branch in .research-assistant.json.`);
    const preHead = (await this.git.head())!;
    const behind = await this.git.revCount(`HEAD..${ref}`);
    if (!behind) return { status: 'up_to_date', summary: [`Already up to date with ${ref}.`], problems: [], warnings: [] };
    const wasRunning = state?.status === 'running';
    if (wasRunning) await this.core.pause(`sync pull from ${ref}`);
    const next: SyncRecord = { ...record, phase: 'idle', operation: 'pull', preHead, remote, wasRunning };
    await this.saveRecord(next);
    const conflict = await this.integrateUpstream(ref, next);
    if (conflict) return conflict;
    return this.integrate(preHead, next, remote);
  }

  /** Rebase or merge onto `ref`; on conflict record it and return a conflict result, never resolving it. */
  private async integrateUpstream(ref: string, record: SyncRecord): Promise<PullResult | undefined> {
    const args = this.config.strategy === 'merge' ? ['merge', '--no-edit', ref] : ['rebase', ref];
    const result = await this.git.run(args);
    if (result.code === 0) return undefined;
    const conflicted = await this.git.conflicts();
    if (!conflicted.length && !(await this.git.operationInProgress())) throw new Error(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
    await this.saveRecord({ ...record, phase: 'conflict', conflicted });
    await this.core.event('sync_conflict', { ref, conflicted, operation: record.operation });
    return {
      status: 'conflict', conflicted, problems: [], warnings: [],
      summary: [
        `Conflicts with ${ref} in: ${conflicted.join(', ')}.`,
        'The research loop is paused. Nothing was resolved automatically: when two collaborators changed the same statement, proof, or decision, the researchers decide which version is right.',
        `Resolve each file, \`git add\` it, run \`git ${this.config.strategy === 'merge' ? 'commit' : 'rebase --continue'}\`, then \`${LOOP_COMMAND} sync pull --continue\`.`,
      ],
    };
  }

  /** After git changed HEAD: validate, invalidate stale approvals, rebuild loop state, and summarize in research terms. */
  private async integrate(preHead: string, record: SyncRecord, remote: string): Promise<PullResult> {
    const head = (await this.git.head())!;
    const paths = await this.syncPaths();
    const changes: NameStatus[] = preHead && preHead !== head ? await this.git.diffNameStatus(preHead, head, paths) : [];
    const summary = await summarizeResearchChanges(changes, {
      paths: this.core.projectPaths, shared: this.core.shared,
      before: (file) => this.git.showFile(preHead, file), after: (file) => this.files.readFile(file).catch(() => undefined),
    });
    const problems = await this.core.validateAll();
    const details: Array<{ id: string; reason: string }> = [];
    await this.core.reconcile(undefined, { details });
    for (const item of details) summary.push(`Approval of ${item.id} invalidated (${item.reason.replace('dependency_changed:', 'dependency ')}); it needs the researcher's review again.`);
    const warnings: string[] = [];
    const me = await this.identity();
    const workingOn = this.core.current?.current.assetId;
    for (const change of changes) {
      if (change.status !== 'A' || path.posix.dirname(change.path) !== this.core.shared.handoffs) continue;
      const handoff = parseHandoff(await this.files.readFile(change.path).catch(() => ''));
      if (handoff && handoff.performedBy !== me && workingOn && handoff.workingOn.includes(workingOn)) warnings.push(`${handoff.performedBy} was also working on ${workingOn} (${change.path}); coordinate before continuing on it.`);
    }
    let next: string | undefined;
    if (this.core.current) {
      await this.core.rebaseline();
      await this.core.event('synced', { head, remote, preHead, changes: changes.length });
      if (problems.length) {
        if (this.core.current.status === 'running') await this.core.pause('research files need fixing after sync');
        next = `The loop stays paused until these problems are fixed; then run ${LOOP_COMMAND} resume.`;
      } else if (record.wasRunning || this.core.current.status === 'running') {
        await this.core.resume();
        next = (await this.core.next()).instruction;
      }
    }
    await this.saveRecord({ phase: 'idle', lastPull: { head, at: new Date().toISOString(), remote }, prepared: undefined, lastPublish: record.lastPublish });
    if (!summary.length) summary.push(changes.length ? 'Only non-research files changed.' : 'No research files changed.');
    return { status: 'pulled', summary, problems, warnings, next };
  }

  // ---------- prepare ----------

  async prepare(options: { latex?: boolean; fetch?: boolean; note?: string } = {}): Promise<PrepareResult> {
    const record = await this.record();
    const checks: CheckResult[] = [];
    const add = (name: string, details: string[], warning = false) => checks.push({ name, ok: warning || !details.length, warning: warning && details.length > 0, details });
    if (record.phase === 'conflict') add('No unresolved sync conflict', [`Conflicts in ${record.conflicted?.join(', ')}; finish with sync pull --continue.`]);
    const state = this.core.current;
    if (state && WORKING_STAGES.has(state.stage)) {
      const { added, modified } = await this.core.changedFiles();
      add('Current stage reported', added.length || modified.length ? [`Stage ${state.stage} has unreported edits: ${[...added, ...modified].join(', ')}.`] : []);
    }
    add('Research files valid (format, dependencies, no cycles)', await this.core.validateAll());
    add('Approvals match current content', await this.core.approvalProblems());
    add('Sources cited with index entry, location, URL, and BibTeX', await this.sourceProblems());
    const bib = await this.bibWarnings();
    add('BibTeX entries unique', bib);
    if (options.latex) {
      if (!this.config.latexCommand || !this.runCommand) add('LaTeX compiles', ['Set sync.latexCommand in .research-assistant.json (e.g. "latexmk -pdf -interaction=nonstopmode main.tex").']);
      else {
        const result = await this.runCommand(this.config.latexCommand);
        add('LaTeX compiles', result.code === 0 ? [] : [`${this.config.latexCommand} exited ${result.code}:\n${result.output.split('\n').filter((line) => /^!|Error|error:/.test(line)).slice(0, 10).join('\n') || result.output.slice(-800)}`]);
      }
    }
    const { remote, ref } = await this.target();
    let behind = 0;
    if (options.fetch !== false) {
      try { await this.fetch(remote); } catch (error) { add('Upstream reachable', [error instanceof Error ? error.message : String(error)], true); }
    }
    if (await this.git.refExists(ref)) behind = await this.git.revCount(`HEAD..${ref}`);
    add('Upstream has no newer commits', behind ? [`${ref} has ${behind} new commit(s); publish will rebase and re-validate, or run sync pull first to review them.`] : [], true);
    add('Notation consistent', ['Not checked automatically; run the check-notation skill on changed nodes before sharing.'], true);

    const summary = await this.localSummary(ref);
    if (state) {
      for (const item of state.approvalQueue) summary.push(`Waiting for approval: ${item.kind} ${item.target}.`);
      for (const [id, info] of Object.entries(state.parked)) summary.push(`Parked: ${id} (${info.reason}).`);
    }
    const ok = checks.every((check) => check.ok);
    if (!ok) { await this.saveRecord({ ...record, prepared: undefined }); return { ok, checks, summary }; }
    const handoff = await this.core.writeHandoff(options.note);
    await this.saveRecord({ ...record, prepared: { head: (await this.git.head()) ?? '', fingerprint: await this.fingerprint(), at: new Date().toISOString(), handoff, summary } });
    return { ok, checks, summary, handoff };
  }

  /** What this clone would share: working tree and local commits compared with upstream (or HEAD without one). */
  private async localSummary(ref: string): Promise<string[]> {
    const base = (await this.git.refExists(ref)) ? ref : 'HEAD';
    const paths = await this.syncPaths();
    const out = await this.git.must(['diff', '--name-status', '-M', base, '--', ...paths]);
    const changes: NameStatus[] = out.split('\n').filter(Boolean).map((line) => {
      const [status, first, second] = line.split('\t');
      return status.startsWith('R') ? { status: 'R', from: first, path: second } : { status: status[0], path: first };
    });
    for (const entry of await this.git.status(paths)) if (entry.code === '??') changes.push({ status: 'A', path: entry.path });
    return summarizeResearchChanges(changes, {
      paths: this.core.projectPaths, shared: this.core.shared,
      before: (file) => this.git.showFile(base, file), after: (file) => this.files.readFile(file).catch(() => undefined),
    });
  }

  private async sourceProblems(): Promise<string[]> {
    const paths = this.core.projectPaths;
    const index = await this.files.readFile(paths.paperIndex).catch(() => '');
    const bib = await this.files.readFile(paths.bibliography).catch(() => '');
    const sections = new Map<string, string>();
    for (const match of index.matchAll(/^##\s+([a-z][a-z0-9_]*)\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)) sections.set(match[1], match[2]);
    const bibKeys = new Set([...bib.matchAll(/^@\w+\s*\{\s*([^,\s]+)\s*,/gm)].map((match) => match[1]));
    const problems: string[] = [];
    const cited = new Set<string>();
    for (const file of await this.files.listFiles(paths.assets)) {
      let data: Record<string, any>;
      try { data = parseMarkdown(await this.files.readFile(file)).data; } catch { continue; }
      if (!isCited(data.source)) continue;
      const paperId = String(data.source.paper_id ?? '');
      cited.add(paperId);
      if (!sections.has(paperId)) problems.push(`${file}: cites ${paperId || '(no paper_id)'}, which is not in ${paths.paperIndex}.`);
      if (!String(data.source.location ?? '').trim()) problems.push(`${file}: cited source needs an exact location (theorem number, page).`);
    }
    for (const paperId of cited) {
      const section = sections.get(paperId);
      if (section === undefined) continue;
      if (!/https?:\/\//.test(section)) problems.push(`${paperId}: needs a stable DOI/arXiv/publisher URL in ${paths.paperIndex}.`);
      if (!bibKeys.has(paperId)) problems.push(`${paperId}: needs a BibTeX entry with key ${paperId} in ${paths.bibliography}.`);
    }
    return problems;
  }

  private async bibWarnings(): Promise<string[]> {
    const bib = await this.files.readFile(this.core.projectPaths.bibliography).catch(() => '');
    const seen = new Map<string, number>();
    for (const match of bib.matchAll(/^@\w+\s*\{\s*([^,\s]+)\s*,/gm)) seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
    return [...seen].filter(([, count]) => count > 1).map(([key, count]) => `BibTeX key ${key} appears ${count} times.`);
  }

  // ---------- publish ----------

  async publish(confirm: (preview: PublishPreview) => Promise<boolean>, options: { message?: string } = {}): Promise<PublishResult> {
    const record = await this.record();
    if (record.phase === 'conflict') throw new Error(`Finish the ${record.operation ?? 'pull'} first: ${LOOP_COMMAND} sync pull --continue.`);
    const prepared = record.prepared;
    if (!prepared) throw new Error(`Run ${LOOP_COMMAND} sync prepare first; publish only shares a checked state.`);
    if (prepared.head !== ((await this.git.head()) ?? '') || prepared.fingerprint !== await this.fingerprint()) throw new Error(`Research files changed after sync prepare. Run ${LOOP_COMMAND} sync prepare again.`);
    const { remote, branch, ref } = await this.target();
    const paths = await this.syncPaths();
    const files = await this.git.status(paths);
    const ahead = (await this.git.refExists(ref)) ? await this.git.revCount(`${ref}..HEAD`) : await this.git.revCount('HEAD');
    if (!files.length && !ahead) return { status: 'nothing', pushed: [], warnings: [], summary: ['Nothing to publish.'] };
    const message = this.commitMessage(options.message, prepared);
    const targets = [`${remote} ${branch}`];
    if (this.config.overleafRemote && this.config.overleafRemote !== remote) targets.push(`${this.config.overleafRemote} ${this.config.overleafBranch} (Overleaf, fast-forward only)`);
    if (!(await confirm({ files, ahead, message, targets }))) return { status: 'blocked', pushed: [], warnings: [], summary: ['Publish cancelled by the researcher.'] };

    let commit = (await this.git.head())!;
    if (files.length) {
      await this.git.must(['add', '-A', '--', ...paths]);
      await this.git.must(['commit', ...(this.config.signCommits ? ['-S'] : []), '-m', message, '--', ...paths]);
      commit = (await this.git.head())!;
      await this.core.event('committed', { commit });
    }
    await this.fetch(remote);
    const summary: string[] = [];
    if ((await this.git.refExists(ref)) && await this.git.revCount(`HEAD..${ref}`)) {
      const preHead = commit;
      const wasRunning = this.core.current?.status === 'running';
      if (wasRunning) await this.core.pause(`sync publish integrating ${ref}`);
      const next: SyncRecord = { ...record, prepared: undefined, phase: 'idle', operation: 'publish', preHead, remote, wasRunning };
      await this.saveRecord(next);
      const conflict = await this.integrateUpstream(ref, next);
      if (conflict) return { status: 'conflict', commit, pushed: [], warnings: [], summary: [`Committed ${commit.slice(0, 8)} locally; not pushed.`, ...conflict.summary, 'After --continue, run sync prepare and publish again.'] };
      const integrated = await this.integrate(preHead, next, remote);
      summary.push(`Integrated ${ref} before pushing:`, ...integrated.summary.map((line) => `  ${line}`));
      const problems = [...integrated.problems, ...await this.core.approvalProblems()];
      if (problems.length || (await this.git.status(paths)).length) {
        return { status: 'blocked', commit, pushed: [], warnings: problems, summary: [...summary, `Committed ${commit.slice(0, 8)} locally; not pushed because the combined research needs attention. Fix it, then run sync prepare and publish again.`] };
      }
      commit = (await this.git.head())!;
    }
    const pushed: string[] = [];
    const warnings: string[] = [];
    await this.git.must(['push', remote, `HEAD:refs/heads/${branch}`]);
    pushed.push(`${remote} ${branch}`);
    if (this.config.overleafRemote && this.config.overleafRemote !== remote) {
      const overleaf = await this.git.run(['push', this.config.overleafRemote, `HEAD:refs/heads/${this.config.overleafBranch}`]);
      if (overleaf.code === 0) pushed.push(`${this.config.overleafRemote} ${this.config.overleafBranch}`);
      else warnings.push(`Overleaf push rejected (${(overleaf.stderr || overleaf.stdout).trim().split('\n').pop()}). Someone edited in Overleaf: run ${LOOP_COMMAND} sync pull --remote ${this.config.overleafRemote}, then publish again. Never force-push to Overleaf.`);
    }
    await this.saveRecord({ phase: 'idle', lastPull: record.lastPull, lastPublish: { commit, at: new Date().toISOString(), remotes: pushed } });
    await this.core.event('published', { commit, remotes: pushed });
    return { status: 'published', commit, pushed, warnings, summary: [...summary, `Published ${commit.slice(0, 8)} to ${pushed.join(' and ')}.`] };
  }

  private commitMessage(custom: string | undefined, prepared: NonNullable<SyncRecord['prepared']>): string {
    const lines = prepared.summary.filter((line) => !line.startsWith('Waiting') && !line.startsWith('Parked'));
    const subject = custom?.trim() || `research: ${lines[0]?.replace(/\.$/, '') ?? 'update research records'}`.slice(0, 72);
    const body = lines.slice(0, 20).map((line) => `- ${line}`).join('\n');
    const trailers = [prepared.handoff ? `Research-Handoff: ${prepared.handoff}` : '', this.core.current ? `Research-Loop-Run: ${this.core.current.runId}` : ''].filter(Boolean).join('\n');
    return [subject, body, trailers].filter(Boolean).join('\n\n');
  }
}
