import * as crypto from 'crypto';
import * as path from 'path';
import type matter from 'gray-matter';
import { LOOP_COMMAND } from './AgentProviders';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { ProjectPaths } from '../models/types';
import {
  AgentProvider, ApprovalFile, ApprovalKind, ApprovalRecord, ApprovalRequest, EVENTS_PATH, LoopFiles, LoopQuestion, LoopStage, LoopState,
  MAX_FAILED_PLANS, PROVABLE_TYPES, QuestionKind, SNAPSHOT_PATH, STATE_PATH, StageReport, hasSection, isApproved, isWaitingForHuman, newState,
  projectSection, proofText, requiredAssetIds, researchDigest, sectionContent, sharedFolders, statementDigest, statementIncomplete, validateResearchFile,
} from './ResearchLoopModel';
import { approvalFiles, isApprovalPath, legacyApprovalsPath, readApprovals, writeApprovals } from './ApprovalStore';
import { LoopGit } from './LoopGit';
import {
  CheckInfo, DecisionInfo, DecisionKind, Provenance, checkMarkdown, decisionId, decisionMarkdown, deriveChangesRequested, deriveParked,
  failuresSinceDirection, handoffMarkdown, parseCheck, parseDecision, parseHandoff, stamp, stampCheck,
} from './ResearchRecords';

export interface CoreOptions {
  now?: () => string;
  id?: () => string;
  iterationCap?: number;
  /** Git for base-commit tracking and provenance; without it the loop works as before. */
  git?: LoopGit;
  /** Who performs researcher actions on this machine; defaults to git user.email. */
  identity?: string;
  extensionVersion?: string;
}
export interface NextResult { stage: LoopStage; instruction: string; brief: Record<string, unknown>; blocked?: string }
export interface ValidationResult { problems: string[]; fixed: string[] }
interface AssetInfo { id: string; raw: string; data: Record<string, any>; body: string }
type Selection =
  | { stage: 'discuss_goals' | 'draft_project' | 'review_project' | 'ready'; note?: string }
  | { stage: 'scaffold'; missing: string[]; incomplete: string[] }
  | { stage: 'falsify' | 'plan'; assetId: string }
  | { stage: 'waiting'; reason: string };

const LOCK_TTL_MS = 10 * 60 * 1000;
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

/**
 * Pure research-loop engine. Files are the state; this class only reads and
 * writes through `LoopFiles`, so the extension, the CLI, and tests share it.
 */
export class ResearchLoopCore {
  private state: LoopState | undefined;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly iterationCap: number;
  private readonly git: LoopGit | undefined;
  private identity: string | undefined;
  private readonly extensionVersion: string | undefined;

  constructor(private readonly files: LoopFiles, private paths: ProjectPaths, options: CoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
    this.iterationCap = options.iterationCap ?? 10;
    this.git = options.git;
    this.identity = options.identity;
    this.extensionVersion = options.extensionVersion;
  }

  setPaths(paths: ProjectPaths): void { this.paths = paths; }
  get current(): LoopState | undefined { return this.state; }
  get projectPaths(): ProjectPaths { return this.paths; }
  get shared() { return sharedFolders(this.paths.researchRoot); }

  /** Who did it, when, and on which commit; stamped on approvals and shared records. */
  async provenance(): Promise<Provenance> {
    if (!this.identity) this.identity = (await this.git?.userEmail()) ?? 'unknown';
    const head = await this.git?.head();
    const result: Provenance = { performed_by: this.identity, created_at: this.now() };
    if (head) result.base_commit = head;
    if (this.extensionVersion) result.extension_version = this.extensionVersion;
    return result;
  }

  private shortId(): string { return this.id().replace(/-/g, '').slice(0, 6).toLowerCase(); }

  /**
   * Files the loop itself writes (approvals, decisions, handoffs, checks it
   * stamps) must not count as the agent's edits in the current stage.
   */
  private async refreshSnapshot(files: string[]): Promise<void> {
    if (!files.length) return;
    const raw = await this.files.readFile(SNAPSHOT_PATH).catch(() => '');
    if (!raw.trim()) return;
    const snapshot = JSON.parse(raw) as Record<string, string>;
    for (const file of files) {
      const content = await this.files.readFile(file).catch(() => undefined);
      if (content === undefined || !content.trim()) delete snapshot[file];
      else snapshot[file] = crypto.createHash('sha256').update(content).digest('hex');
    }
    await this.files.writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 0) + '\n');
  }

  /** Write a loop-owned file and keep it out of the current stage's change set. */
  private async writeOwned(file: string, content: string): Promise<void> {
    await this.files.writeFile(file, content);
    await this.refreshSnapshot([file]);
  }

  // ---------- state persistence ----------

  async load(): Promise<LoopState | undefined> {
    const raw = await this.files.readFile(STATE_PATH).catch(() => '');
    if (!raw.trim()) { this.state = undefined; return undefined; }
    const parsed = JSON.parse(raw) as Partial<LoopState> & { version?: number };
    if (parsed.version !== 2) {
      this.state = undefined;
      return undefined;
    }
    this.state = parsed as LoopState;
    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    this.state.updatedAt = this.now();
    await this.files.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n');
  }

  private require(): LoopState {
    if (!this.state) throw new Error(`No research loop has been started. Run: ${LOOP_COMMAND} start --provider claude|codex`);
    return this.state;
  }

  async event(type: string, data: object = {}): Promise<void> {
    const old = await this.files.readFile(EVENTS_PATH).catch(() => '');
    await this.files.writeFile(EVENTS_PATH, old + JSON.stringify({ at: this.now(), runId: this.state?.runId, type, ...data }) + '\n');
  }

  async recentEvents(limit = 30): Promise<Array<Record<string, unknown>>> {
    const raw = await this.files.readFile(EVENTS_PATH).catch(() => '');
    return raw.trim().split('\n').filter(Boolean).slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  }

  private async setStage(stage: LoopStage, patch: Partial<LoopState['current']> = {}): Promise<void> {
    const state = this.require();
    state.stage = stage;
    state.current = { ...state.current, ...patch, stageStartedAt: this.now(), baseCommit: await this.git?.head() };
    await this.takeSnapshot();
    await this.save();
    await this.event('stage', { stage, assetId: state.current.assetId, planId: state.current.planId });
  }

  // ---------- run control ----------

  async start(provider: AgentProvider, options: { goal?: string; sessionId?: string; force?: boolean } = {}): Promise<LoopState> {
    if (this.state && this.state.status === 'running' && !options.force) throw new Error('A research loop is already running. Use resume, or stop it first.');
    const state = newState(provider, this.id(), this.now(), this.iterationCap);
    if (options.goal?.trim()) state.researcherInput = { kind: 'goals', text: options.goal.trim(), at: this.now() };
    this.state = state;
    if (options.sessionId) state.lock = { sessionId: options.sessionId, provider, acquiredAt: this.now(), heartbeatAt: this.now() };
    await this.adoptExistingApprovals();
    await this.rebuildState();
    // A goal given to an already approved project extends it instead of being dropped.
    if (options.goal?.trim()) await this.markExtension(options.goal.trim());
    await this.save();
    await this.event('started', { provider });
    await this.next();
    return state;
  }

  /** Add a new goal to an approved project: reopen project.md for new required results, keeping the existing ones. */
  async extend(goal: string, options: { provider?: AgentProvider; sessionId?: string; force?: boolean } = {}): Promise<LoopState> {
    if (!goal.trim()) throw new Error('Describe the new goal to add.');
    if (!(await this.isProjectApproved())) throw new Error('project.md is not approved yet; finish or revise the current project instead of extending it.');
    const state = this.state;
    if (!state || state.status === 'stopped' || state.status === 'idle') return this.start(options.provider ?? state?.provider ?? 'claude', { goal, sessionId: options.sessionId, force: true });
    if (options.provider) state.provider = options.provider;
    if (options.sessionId && !this.heartbeat(options.sessionId, options.force)) throw new Error(`Another session (${state.lock?.sessionId}) is driving this loop. Pass --force to take over.`);
    state.status = 'running';
    state.lastError = null;
    state.researcherInput = { kind: 'goals', text: goal.trim(), at: this.now() };
    await this.markExtension(goal.trim());
    await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined });
    return state;
  }

  private async markExtension(goal: string): Promise<void> {
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (!project || !(await this.isProjectApproved(project))) return;
    const state = this.require();
    state.extension = { goal, at: this.now(), baselineRequired: requiredAssetIds(project) };
    await this.event('extended', { goal, baselineRequired: state.extension.baselineRequired });
  }

  /** While extending, project.md may only gain required results. */
  private extensionProblems(project: string): string[] {
    const extension = this.state?.extension;
    if (!extension || extension.projectApproved) return [];
    const required = requiredAssetIds(project);
    const removed = extension.baselineRequired.filter((id) => !required.includes(id));
    const added = required.filter((id) => !extension.baselineRequired.includes(id));
    const problems: string[] = [];
    if (removed.length) problems.push(`project.md: keep the existing required results ${removed.join(', ')}; extending only adds results (deprecate an asset to retire it).`);
    if (!added.length) problems.push('project.md: add the new goal as a new asset ID under ## Required Results.');
    return problems;
  }

  async pause(reason?: string): Promise<void> {
    const state = this.require();
    if (state.status === 'running') { state.status = 'paused'; state.lastError = reason ?? null; await this.save(); await this.event('paused', { reason }); }
  }

  async resume(options: { sessionId?: string; provider?: AgentProvider; force?: boolean } = {}): Promise<void> {
    const state = this.require();
    if (options.provider) state.provider = options.provider;
    if (options.sessionId && !this.heartbeat(options.sessionId, options.force)) throw new Error(`Another session (${state.lock?.sessionId}) is driving this loop. Pass --force to take over.`);
    state.status = 'running';
    state.lastError = null;
    await this.save();
    await this.event('resumed');
  }

  async stop(): Promise<void> {
    const state = this.require();
    state.status = 'stopped';
    state.pendingQuestion = undefined;
    state.lock = undefined;
    await this.save();
    await this.event('stopped');
  }

  /** Refresh the session lock; returns false when another live session owns the loop. */
  heartbeat(sessionId: string, force = false): boolean {
    const state = this.state;
    if (!state) return true;
    const lock = state.lock;
    if (lock && lock.sessionId !== sessionId && !force) {
      const age = Date.now() - Date.parse(lock.heartbeatAt);
      if (Number.isFinite(age) && age < LOCK_TTL_MS) return false;
    }
    state.lock = { sessionId, provider: state.provider, acquiredAt: lock?.sessionId === sessionId ? lock.acquiredAt : this.now(), heartbeatAt: this.now() };
    return true;
  }

  async touch(sessionId?: string, force = false): Promise<boolean> {
    if (!this.state) return true;
    const ok = sessionId ? this.heartbeat(sessionId, force) : true;
    if (ok) await this.save();
    return ok;
  }

  // ---------- approvals ----------

  async approvals(): Promise<ApprovalFile> {
    return readApprovals(this.files, this.paths.researchRoot);
  }

  private async writeApprovals(file: ApprovalFile): Promise<void> {
    const touched = await writeApprovals(this.files, this.paths.researchRoot, file);
    await this.refreshSnapshot(touched);
  }

  private async record(kind: ApprovalRecord['kind'], target: string, raw: string, source: string): Promise<void> {
    const file = await this.approvals();
    file.records = file.records.filter((entry) => !(entry.kind === kind && entry.target === target));
    const provenance = await this.provenance();
    const record: ApprovalRecord = { kind, target, digest: researchDigest(raw, kind), approvedAt: provenance.created_at, source, performed_by: provenance.performed_by };
    if (kind !== 'project') record.statement = statementDigest(raw);
    if (provenance.base_commit) record.base_commit = provenance.base_commit;
    if (provenance.extension_version) record.extension_version = provenance.extension_version;
    file.records.push(record);
    await this.writeApprovals(file);
  }

  /** Record digests for nodes that were approved before the loop existed, so validation does not revert them. */
  async adoptExistingApprovals(): Promise<string[]> {
    const file = await this.approvals();
    const adopted: string[] = [];
    for (const [kind, folder] of [['asset', this.paths.assets], ['definition', this.paths.definitions]] as const) {
      for (const filePath of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(filePath);
        let data: Record<string, any>;
        try { data = parseMarkdown(raw).data; } catch { continue; }
        const id = path.posix.basename(filePath, '.md');
        if (data.status !== 'approved' || file.records.some((record) => record.kind === kind && record.target === id)) continue;
        file.records.push({ kind, target: id, digest: researchDigest(raw, kind), approvedAt: this.now(), source: 'adopted', statement: statementDigest(raw) });
        adopted.push(id);
      }
    }
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (project && !file.records.some((record) => record.kind === 'project') && requiredAssetIds(project).length && projectSection(project, 'Main Problem')) {
      // Never adopt project approval silently: the researcher must approve goals once.
    }
    if (adopted.length) { await this.writeApprovals(file); await this.event('approvals_adopted', { adopted }); }
    return adopted;
  }

  async isProjectApproved(project?: string): Promise<boolean> {
    const raw = project ?? await this.files.readFile(this.paths.projectMd).catch(() => '');
    return Boolean(raw) && isApproved((await this.approvals()).records, 'project', 'project', raw);
  }

  /** Researcher approval. Only the extension (a human click, dashboard, or editor) may call this. */
  async approve(kind: 'project' | 'asset' | 'definition', target: string, source: string): Promise<void> {
    if (kind === 'project') {
      const raw = await this.files.readFile(this.paths.projectMd);
      if (!requiredAssetIds(raw).length) throw new Error('Add asset IDs under ## Required Results before approving the project.');
      await this.record('project', 'project', raw, source);
    } else {
      const file = `${kind === 'asset' ? this.paths.assets : this.paths.definitions}/${target}.md`;
      const raw = await this.files.readFile(file);
      const parsed = parseMarkdown(raw);
      parsed.data.status = 'approved';
      const approved = stringifyMarkdown(parsed.content, parsed.data);
      await this.writeOwned(file, approved);
      await this.record(kind, target, approved, source);
    }
    if (this.state) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => !(item.target === target && (item.kind === kind || (kind === 'asset' && (item.kind === 'citation' || item.kind === 'counterexample')))));
      if (kind === 'asset') await this.clearPark(target, `approved (${source})`);
      await this.save();
    }
    await this.event('approved', { kind, target, source });
  }

  /** Record a researcher's approval made in the dashboard or editor (file already says approved). */
  async recordExisting(kind: 'asset' | 'definition', target: string, source: string): Promise<boolean> {
    const file = `${kind === 'asset' ? this.paths.assets : this.paths.definitions}/${target}.md`;
    if (!(await this.files.exists(file))) return false;
    const raw = await this.files.readFile(file);
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return false; }
    if (data.status !== 'approved') return false;
    if (isApproved((await this.approvals()).records, kind, target, raw)) return false;
    await this.record(kind, target, raw, source);
    await this.refreshSnapshot([file]);
    if (this.state) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => !(item.target === target && ['asset', 'citation', 'definition', 'counterexample'].includes(item.kind)));
      await this.clearPark(target, `approved (${source})`);
      await this.save();
    }
    await this.event('approved', { kind, target, source });
    return true;
  }

  /** Researcher confirmed a counterexample: approve the example and deprecate the refuted asset. */
  async confirmCounterexample(exampleId: string, source: string): Promise<string> {
    const file = `${this.paths.assets}/${exampleId}.md`;
    const data = parseMarkdown(await this.files.readFile(file)).data;
    if (data.type !== 'example' || typeof data.refutes !== 'string') throw new Error(`${exampleId} is not a counterexample.`);
    const target = data.refutes as string;
    await this.approve('asset', exampleId, source);
    const targetFile = `${this.paths.assets}/${target}.md`;
    if (await this.files.exists(targetFile)) {
      const parsed = parseMarkdown(await this.files.readFile(targetFile));
      parsed.data.status = 'deprecated';
      await this.writeOwned(targetFile, stringifyMarkdown(parsed.content, parsed.data));
      const approvals = await this.approvals();
      approvals.records = approvals.records.filter((record) => !(record.kind === 'asset' && record.target === target));
      await this.writeApprovals(approvals);
    }
    if (this.state) {
      await this.clearPark(target, `refuted by ${exampleId}`);
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => item.target !== exampleId);
      await this.save();
    }
    await this.event('refuted', { assetId: target, exampleId, source });
    return target;
  }

  async rejectCounterexample(exampleId: string, reason: string, source: string): Promise<void> {
    const file = `${this.paths.assets}/${exampleId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    parsed.data.status = 'archived';
    const body = hasSection(parsed.content, 'Verdict') ? parsed.content : `${parsed.content.trimEnd()}\n\n## Verdict\n\nrejected: ${reason || 'rejected by the researcher'}\n`;
    await this.writeOwned(file, stringifyMarkdown(body, parsed.data));
    if (this.state) {
      const target = parsed.data.refutes as string | undefined;
      if (target && this.state.parked[target]?.reason === 'counterexample_pending') delete this.state.parked[target];
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => item.target !== exampleId);
      await this.save();
    }
    await this.event('counterexample_rejected', { exampleId, source });
  }

  /**
   * Revert approvals that no longer match their digest, and invalidate
   * dependants whose approved dependency changed its statement.
   */
  async reconcile(changedId?: string, options: { dryRun?: boolean; details?: Array<{ id: string; reason: string }> } = {}): Promise<string[]> {
    const approvals = await this.approvals();
    const reverted: string[] = [];
    const nodes = new Map<string, { kind: 'asset' | 'definition'; file: string; raw: string; data: Record<string, any> }>();
    for (const [kind, folder] of [['asset', this.paths.assets], ['definition', this.paths.definitions]] as const) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        try { nodes.set(path.posix.basename(file, '.md'), { kind, file, raw, data: parseMarkdown(raw).data }); } catch { /* skip */ }
      }
    }
    const revert = async (id: string, reason: string) => {
      const node = nodes.get(id);
      if (!node || node.data.status !== 'approved') return;
      const parsed = parseMarkdown(node.raw);
      parsed.data.status = 'draft';
      node.raw = stringifyMarkdown(parsed.content, parsed.data);
      node.data = parsed.data;
      approvals.records = approvals.records.filter((record) => !(record.kind === node.kind && record.target === id));
      reverted.push(id);
      options.details?.push({ id, reason });
      if (options.dryRun) return;
      await this.files.writeFile(node.file, node.raw);
      await this.event('approval_invalidated', { id, reason });
    };
    const candidates = changedId ? [changedId] : [...nodes.keys()];
    for (const id of candidates) {
      const node = nodes.get(id);
      if (!node || node.data.status !== 'approved') continue;
      const record = approvals.records.find((entry) => entry.kind === node.kind && entry.target === id) as (ApprovalRecord & { statement?: string }) | undefined;
      if (!record) continue; // approved without a record: handled by validateWorkspace (agent) or recorded by the extension (human)
      if (record.digest !== researchDigest(node.raw, node.kind)) {
        await revert(id, 'content_changed');
      }
      if (record.statement && record.statement !== statementDigest(node.raw)) {
        for (const [otherId, other] of nodes) {
          const deps = node.kind === 'asset' ? other.data.depends_on : other.kind === 'asset' ? other.data.uses_definitions : other.data.depends_on;
          if (Array.isArray(deps) && deps.includes(id)) await revert(otherId, `dependency_changed:${id}`);
        }
      }
    }
    if (reverted.length && !options.dryRun) await this.writeApprovals(approvals);
    return reverted;
  }

  // ---------- questions and approval queue ----------

  async askQuestion(kind: QuestionKind, prompt: string, options: { assetId?: string; options?: string[]; timeoutSec?: number } = {}): Promise<LoopQuestion> {
    const state = this.require();
    const question: LoopQuestion = { id: this.id(), kind, prompt, assetId: options.assetId ?? state.current.assetId, options: options.options, createdAt: this.now(), timeoutSec: options.timeoutSec };
    state.pendingQuestion = question;
    await this.save();
    await this.event('question', { kind, assetId: question.assetId, questionId: question.id });
    return question;
  }

  async answerQuestion(questionId: string, decision: 'answer' | 'skip', text: string, source: string): Promise<void> {
    const state = this.require();
    const question = state.pendingQuestion?.id === questionId ? state.pendingQuestion : undefined;
    if (!question) {
      // Late answer to an expired question: keep it for the agent to pick up.
      state.answers.push({ questionId, decision, text, answeredAt: this.now(), source });
      await this.save();
      await this.event('question_answered', { questionId, decision, hasText: Boolean(text.trim()), late: true });
      return;
    }
    state.pendingQuestion = undefined;
    state.answers.push({ questionId, decision, text, answeredAt: this.now(), source, consumed: true });
    await this.event('question_answered', { questionId, kind: question.kind, decision, hasText: Boolean(text.trim()) });
    const assetId = question.assetId;
    if (decision === 'answer' && text.trim()) state.researcherInput = { kind: question.kind, text: text.trim(), at: this.now() };
    if (decision === 'answer' && text.trim() && question.kind === 'discussion') await this.writeDecision('answer', assetId ?? 'project', `${question.prompt}\n\n${text.trim()}`);
    if (question.kind === 'goals') {
      if (decision === 'answer' && text.trim()) await this.setStage('draft_project');
      else if (projectSection(await this.files.readFile(this.paths.projectMd).catch(() => ''), 'Main Problem')) await this.setStage('draft_project');
      else await this.setStage('waiting');
    } else if (question.kind === 'blocked' && assetId) {
      if (decision === 'answer' && text.trim()) {
        state.progress[assetId] = { ...state.progress[assetId], changesRequested: undefined };
        await this.saveIdea(`Direction for ${assetId}`, text, [assetId], 'researcher');
        // The direction answers every failed plan so far; the shared record resets the failure count on every machine.
        await this.writeDecision('direction', assetId, text, { failedPlansAtDirection: await this.failedPlans(assetId) });
        delete state.parked[assetId];
        await this.setStage('plan', { assetId, planId: undefined });
      } else {
        await this.park(assetId, 'three_failures', 'no new direction from the researcher');
        await this.setStage('select');
      }
    } else if (question.kind === 'counterexample_review') {
      if (decision === 'answer' && text.trim()) await this.saveIdea(`Counterexample review for ${assetId ?? 'project'}`, text, assetId ? [assetId] : [], 'researcher');
      await this.save();
    } else {
      if (decision === 'skip' || !text.trim()) {
        await this.saveIdea(`Open question: ${question.prompt.slice(0, 60)}`, `${question.prompt}\n\nThe researcher did not answer; the agent proceeded with its stated default.`, assetId ? [assetId] : [], 'agent', ['open-question']);
      }
      await this.save();
    }
  }

  async expireQuestion(questionId: string): Promise<void> {
    const state = this.require();
    if (state.pendingQuestion?.id !== questionId) return;
    state.pendingQuestion.expiredAt = this.now();
    await this.save();
    await this.event('question_expired', { questionId, kind: state.pendingQuestion.kind });
  }

  /** Auto-mode resolution when a timed question got no answer. */
  async autoResolveQuestion(questionId: string): Promise<void> {
    const state = this.require();
    const question = state.pendingQuestion;
    if (!question || question.id !== questionId) return;
    await this.answerQuestion(questionId, 'skip', '', 'timeout');
  }

  async enqueueApproval(kind: ApprovalKind, target: string, reason: string): Promise<ApprovalRequest> {
    const state = this.require();
    const raw = kind === 'project' ? await this.files.readFile(this.paths.projectMd).catch(() => '') : await this.files.readFile(`${kind === 'definition' ? this.paths.definitions : this.paths.assets}/${target}.md`).catch(() => '');
    const digest = raw ? researchDigest(raw, kind === 'project' ? 'project' : kind === 'definition' ? 'definition' : 'asset') : '';
    const existing = state.approvalQueue.find((item) => item.kind === kind && item.target === target);
    if (existing) {
      if (existing.digest !== digest) { existing.digest = digest; existing.reason = reason; existing.requestedAt = this.now(); await this.save(); }
      return existing;
    }
    const request: ApprovalRequest = { id: this.id(), kind, target, digest, reason, requestedAt: this.now() };
    state.approvalQueue.push(request);
    await this.save();
    await this.event('approval_requested', { kind, target, requestId: request.id });
    return request;
  }

  async resolveApproval(requestId: string, decision: 'approved' | 'changes_requested' | 'later', text: string, source: string): Promise<ApprovalRequest> {
    const state = this.require();
    const request = state.approvalQueue.find((item) => item.id === requestId);
    if (!request) throw new Error('This approval request is no longer pending.');
    await this.event('approval_resolved', { requestId, kind: request.kind, target: request.target, decision, hasText: Boolean(text.trim()) });
    if (decision === 'later') return request;
    if (decision === 'approved') {
      if (request.kind === 'project') await this.approve('project', 'project', source);
      else if (request.kind === 'definition') await this.approve('definition', request.target, source);
      else if (request.kind === 'counterexample') await this.confirmCounterexample(request.target, source);
      else await this.approve('asset', request.target, source);
      if (request.kind === 'project' && this.state?.stage === 'review_project') await this.setStage('select');
      return request;
    }
    state.approvalQueue = state.approvalQueue.filter((item) => item.id !== requestId);
    state.researcherInput = { kind: `changes:${request.kind}:${request.target}`, text: text.trim() || 'Revise and resubmit.', at: this.now() };
    if (request.kind === 'asset') {
      const raw = await this.files.readFile(`${this.paths.assets}/${request.target}.md`).catch(() => '');
      await this.writeDecision('changes_requested', request.target, text.trim() || 'Revise the proof.', { digest: raw ? researchDigest(raw, 'asset') : undefined });
    }
    if (request.kind === 'project') await this.setStage('draft_project');
    else if (request.kind === 'counterexample') await this.rejectCounterexample(request.target, text, source);
    else {
      state.progress[request.target] = { ...state.progress[request.target], changesRequested: text.trim() || 'Revise the proof.' };
      await this.clearPark(request.target, 'changes requested');
      await this.setStage('select');
    }
    return request;
  }

  async park(assetId: string, reason: string, note?: string): Promise<void> {
    const state = this.require();
    state.parked[assetId] = { reason, at: this.now(), note };
    await this.writeDecision('parked', assetId, note ?? '', { reason });
    await this.save();
    await this.event('parked', { assetId, reason });
  }

  async unpark(assetId: string): Promise<void> {
    const state = this.require();
    delete state.parked[assetId];
    await this.writeDecision('unparked', assetId, 'Unparked by the researcher.');
    await this.save();
    await this.event('unparked', { assetId });
  }

  /** Lift a park; a park that collaborators can see (a decision record) is lifted by a record too. */
  private async clearPark(assetId: string, why: string): Promise<void> {
    const entry = this.state?.parked[assetId];
    if (!entry) return;
    delete this.state!.parked[assetId];
    if (entry.reason !== 'counterexample_pending') await this.writeDecision('unparked', assetId, why);
  }

  // ---------- shared records ----------

  private async writeDecision(kind: DecisionKind, target: string, text: string, extra: { reason?: string; failedPlansAtDirection?: string[]; digest?: string } = {}): Promise<string> {
    const provenance = await this.provenance();
    const id = decisionId(kind, target, provenance, this.shortId());
    await this.writeOwned(`${this.shared.decisions}/${id}.md`, decisionMarkdown(kind, target, text, provenance, extra));
    return id;
  }

  async decisions(): Promise<DecisionInfo[]> {
    const result: DecisionInfo[] = [];
    for (const file of await this.files.listFiles(this.shared.decisions)) {
      const info = parseDecision(path.posix.basename(file, '.md'), await this.files.readFile(file).catch(() => ''));
      if (info) result.push(info);
    }
    return result;
  }

  async checks(): Promise<CheckInfo[]> {
    const result: CheckInfo[] = [];
    for (const file of await this.files.listFiles(this.shared.checks)) {
      const info = parseCheck(path.posix.basename(file, '.md'), await this.files.readFile(file).catch(() => ''));
      if (info) result.push(info);
    }
    return result;
  }

  /** A falsification check covers the asset's current statement; a changed statement needs a new check. */
  private isFalsified(assetId: string, raw: string, checks: CheckInfo[]): boolean {
    const digest = statementDigest(raw);
    return checks.some((check) => check.target === assetId && check.statementDigest === digest);
  }

  private async writeCheck(assetId: string, outcome: 'no_counterexample_found' | 'counterexample_rejected', cases: string, limitations: string): Promise<string> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
    const provenance = await this.provenance();
    const id = `check_${assetId}_${stamp(provenance.created_at)}_${this.shortId()}`;
    const file = `${this.shared.checks}/${id}.md`;
    await this.writeOwned(file, checkMarkdown(assetId, outcome, cases, limitations, statementDigest(raw), provenance));
    return file;
  }

  private async failuresSinceDirection(assetId: string): Promise<number> {
    return failuresSinceDirection(await this.failedPlans(assetId), await this.decisions(), assetId).length;
  }

  /**
   * Re-derive the research meaning of the local state from the shared records,
   * so a fresh clone, a deleted state.json, or a pull sees what collaborators
   * decided. Legacy local-only facts are first written out as records.
   */
  async rebuildState(): Promise<{ parked: string[]; changesRequested: string[]; migrated: string[] }> {
    const state = this.require();
    const migrated = await this.migrateLocalState();
    const decisions = await this.decisions();
    const assets = await this.collect(this.paths.assets);
    const localPending = Object.fromEntries(Object.entries(state.parked).filter(([, info]) => info.reason === 'counterexample_pending'));
    state.parked = { ...deriveParked(decisions), ...localPending };
    const requested = deriveChangesRequested(decisions, (target) => { const raw = assets.get(target)?.raw; return raw ? researchDigest(raw, 'asset') : undefined; });
    for (const id of Object.keys(state.progress)) if (state.progress[id].changesRequested && !requested[id]) state.progress[id] = { ...state.progress[id], changesRequested: undefined };
    for (const [id, text] of Object.entries(requested)) state.progress[id] = { ...state.progress[id], changesRequested: text };
    await this.save();
    return { parked: Object.keys(state.parked), changesRequested: Object.keys(requested), migrated };
  }

  /** One-time export of facts that older versions kept only in state.json. */
  private async migrateLocalState(): Promise<string[]> {
    const state = this.require();
    const migrated: string[] = [];
    const checks = await this.checks();
    for (const [assetId, progress] of Object.entries(state.progress)) {
      if (!progress.falsifiedAt) continue;
      const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
      if (raw && !this.isFalsified(assetId, raw, checks)) {
        await this.writeCheck(assetId, 'no_counterexample_found', `Recorded by an earlier loop version on ${progress.falsifiedAt}; the cases were not written down.`, 'Unknown: migrated from local loop state. Re-run falsification if in doubt.');
        migrated.push(`check:${assetId}`);
      }
      state.progress[assetId] = { ...progress, falsifiedAt: undefined };
    }
    const recorded = deriveParked(await this.decisions());
    for (const [assetId, info] of Object.entries(state.parked)) {
      if (info.reason === 'counterexample_pending' || recorded[assetId]) continue;
      await this.writeDecision('parked', assetId, info.note ?? '', { reason: info.reason });
      migrated.push(`parked:${assetId}`);
    }
    return migrated;
  }

  // ---------- ideas ----------

  async saveIdea(title: string, body: string, relatedAssets: string[], origin: 'researcher' | 'agent' = 'researcher', tags: string[] = []): Promise<string> {
    if (!body.trim()) throw new Error('Idea text is required.');
    const assetIds = new Set((await this.files.listFiles(this.paths.assets)).map((file) => path.posix.basename(file, '.md')));
    for (const asset of relatedAssets) if (!assetIds.has(asset)) throw new Error(`Unknown related asset: ${asset}`);
    const ideaId = `idea_${this.id().replace(/-/g, '').slice(0, 12)}`;
    const raw = stringifyMarkdown(`\n${body.trim()}\n`, { type: 'idea', title: title.trim() || 'Untitled idea', status: 'draft', origin, related_assets: relatedAssets, tags });
    await this.files.writeFile(`${this.paths.ideas}/${ideaId}.md`, raw);
    await this.event('idea_saved', { ideaId, relatedAssets, origin });
    return ideaId;
  }

  async convertIdea(ideaId: string, assetId: string, goal: string, steps: string, verification: string): Promise<string> {
    const ideaRaw = await this.files.readFile(`${this.paths.ideas}/${ideaId}.md`);
    if (parseMarkdown(ideaRaw).data.type !== 'idea') throw new Error('Source must be an idea.');
    if (!(await this.files.exists(`${this.paths.assets}/${assetId}.md`))) throw new Error(`Unknown asset: ${assetId}`);
    const checklist = steps.split(/\r?\n/).map((step) => step.trim()).filter(Boolean).map((step, index) => `${index + 1}. [ ] ${step.replace(/^\d+\.\s*(?:\[[ xX]\])?\s*/, '')}`).join('\n');
    if (!goal.trim() || !checklist || !verification.trim()) throw new Error('Goal, steps, and verification are required.');
    const planId = `plan_${this.id().replace(/-/g, '').slice(0, 12)}`;
    const failed = await this.failedPlans(assetId);
    const difference = failed.length ? `\n## Difference from failed plans\n\n${failed.map((id) => `- ${id}: new route from idea ${ideaId}`).join('\n')}\n` : '';
    const raw = stringifyMarkdown(`\n## Goal\n\nTarget: [asset](../assets/${assetId}.md)\n\n${goal.trim()}\n\n## Plan\n\n${checklist}\n\n## Verification\n\n${verification.trim()}\n${difference}`, { type: 'plan', title: goal.trim().slice(0, 80), status: 'pending', target_asset: assetId, inspired_by: [ideaId], tags: [] });
    await this.files.writeFile(`${this.paths.plans}/${planId}.md`, raw);
    if (this.state?.parked[assetId]) { await this.clearPark(assetId, `new plan ${planId} from idea ${ideaId}`); await this.save(); }
    await this.event('idea_converted', { ideaId, planId, assetId });
    return planId;
  }

  // ---------- selection ----------

  private async collect(folder: string): Promise<Map<string, AssetInfo>> {
    const nodes = new Map<string, AssetInfo>();
    for (const file of await this.files.listFiles(folder)) {
      const raw = await this.files.readFile(file);
      try { const parsed = parseMarkdown(raw); nodes.set(path.posix.basename(file, '.md'), { id: path.posix.basename(file, '.md'), raw, data: parsed.data, body: parsed.content }); } catch { /* skip unparsable */ }
    }
    return nodes;
  }

  private async plans(): Promise<AssetInfo[]> { return [...(await this.collect(this.paths.plans)).values()]; }

  private async failedPlans(assetId: string): Promise<string[]> {
    return (await this.plans()).filter((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'failed').map((plan) => plan.id);
  }

  private async pendingPlan(assetId: string): Promise<string | undefined> {
    return (await this.plans()).find((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'pending')?.id;
  }

  /** Required results plus their transitive dependencies in dependency order; missing IDs are reported, not thrown. */
  private closure(required: string[], assets: Map<string, AssetInfo>): { order: string[]; missing: string[]; cycle?: string } {
    const order: string[] = []; const missing: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>(); let cycle: string | undefined;
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) { cycle = id; return; }
      const asset = assets.get(id);
      if (!asset) { if (!missing.includes(id)) missing.push(id); return; }
      visiting.add(id);
      for (const dep of Array.isArray(asset.data.depends_on) ? asset.data.depends_on : []) if (typeof dep === 'string') visit(dep);
      visiting.delete(id); visited.add(id); order.push(id);
    };
    required.forEach(visit);
    return { order, missing, cycle };
  }

  private definitionClosure(order: string[], assets: Map<string, AssetInfo>, definitions: Map<string, AssetInfo>): string[] {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const definition = definitions.get(id);
      for (const dep of Array.isArray(definition?.data.depends_on) ? definition!.data.depends_on : []) if (typeof dep === 'string') visit(dep);
    };
    for (const id of order) for (const definition of Array.isArray(assets.get(id)?.data.uses_definitions) ? assets.get(id)!.data.uses_definitions : []) if (typeof definition === 'string') visit(definition);
    return [...seen];
  }

  private async computeSelection(): Promise<Selection> {
    const state = this.require();
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    const approvals = (await this.approvals()).records;
    const required = requiredAssetIds(project);
    const projectApproved = isApproved(approvals, 'project', 'project', project);
    if (projectApproved && state.extension && !state.extension.projectApproved) {
      // The approved project still lacks the new goal: draft it first. Once it includes a new result, the extension is approved.
      if (!required.some((id) => !state.extension!.baselineRequired.includes(id))) return { stage: 'draft_project' };
      state.extension.projectApproved = true;
    }
    if (!projectApproved) {
      if (required.length && projectSection(project, 'Main Problem')) {
        await this.enqueueApproval('project', 'project', 'Review the goals and required results in project.md.');
        return { stage: 'review_project' };
      }
      return state.researcherInput ? { stage: 'draft_project' } : { stage: 'discuss_goals' };
    }
    const assets = await this.collect(this.paths.assets);
    const definitions = await this.collect(this.paths.definitions);
    const inactive = required.filter((id) => ['deprecated', 'archived'].includes(assets.get(id)?.data.status));
    if (inactive.length) {
      state.researcherInput = { kind: 'project', text: `Required result(s) ${inactive.join(', ')} were deprecated or archived. Revise the goals and required results; give a revised statement a new asset ID.`, at: this.now() };
      return { stage: 'draft_project', note: state.researcherInput.text };
    }
    const { order, missing, cycle } = this.closure(required, assets);
    if (cycle) return { stage: 'waiting', reason: `Dependency cycle at ${cycle}; fix depends_on before continuing.` };
    if (missing.length) return { stage: 'scaffold', missing, incomplete: [] };
    const incomplete = order.filter((id) => assets.get(id)!.data.status === 'draft' && PROVABLE_TYPES.has(assets.get(id)!.data.type) && statementIncomplete(assets.get(id)!.body));
    if (incomplete.length) return { stage: 'scaffold', missing: [], incomplete };
    const examples = [...assets.values()].filter((asset) => asset.data.type === 'example' && typeof asset.data.refutes === 'string');
    const checks = await this.checks();
    const settled = new Set<string>();
    let candidate: { stage: 'falsify' | 'plan'; assetId: string } | undefined;
    for (const id of order) {
      const asset = assets.get(id)!;
      const verified = asset.data.status === 'approved' && isApproved(approvals, 'asset', id, asset.raw);
      if (verified) { settled.add(id); continue; }
      if (asset.data.status === 'approved') {
        // Approved without a matching record: the researcher must re-approve.
        const parsed = parseMarkdown(asset.raw); parsed.data.status = 'draft';
        await this.files.writeFile(`${this.paths.assets}/${id}.md`, stringifyMarkdown(parsed.content, parsed.data));
        await this.event('approval_invalidated', { id, reason: 'no_record' });
        asset.data.status = 'draft';
      }
      if (asset.data.source?.kind === 'paper') {
        await this.enqueueApproval('citation', id, `Check the cited source ${asset.data.source.paper_id} (${asset.data.source.location ?? 'location missing'}) against the statement.`);
        settled.add(id); continue;
      }
      if (!PROVABLE_TYPES.has(asset.data.type)) {
        await this.enqueueApproval('asset', id, `Supporting ${asset.data.type} used by a required result.`);
        settled.add(id); continue;
      }
      const confirmedRefutation = examples.find((example) => example.data.refutes === id && example.data.status === 'approved');
      if (confirmedRefutation) {
        if (!state.researcherInput) state.researcherInput = { kind: 'project', text: `${id} is refuted by ${confirmedRefutation.id}; revise the goal under a new asset ID.`, at: this.now() };
        return { stage: 'draft_project', note: `${id} is refuted by ${confirmedRefutation.id}.` };
      }
      const pendingExample = examples.find((example) => example.data.refutes === id && example.data.status === 'draft');
      if (pendingExample) {
        await this.enqueueApproval('counterexample', pendingExample.id, `Candidate counterexample to ${id}: confirm or reject.`);
        if (!state.parked[id]) state.parked[id] = { reason: 'counterexample_pending', at: this.now() };
        continue;
      }
      if (state.parked[id]) continue;
      if (proofText(asset.body) && !state.progress[id]?.changesRequested) {
        await this.enqueueApproval('asset', id, 'Proof is written; review and approve or request changes.');
        settled.add(id); continue;
      }
      const deps = Array.isArray(asset.data.depends_on) ? asset.data.depends_on as string[] : [];
      if (!deps.every((dep) => settled.has(dep))) continue;
      if (!candidate) candidate = { stage: this.isFalsified(id, asset.raw, checks) ? 'plan' : 'falsify', assetId: id };
    }
    if (candidate) return candidate;
    const definitionIds = this.definitionClosure(order, assets, definitions);
    const unapproved = definitionIds.filter((id) => !(definitions.get(id)?.data.status === 'approved' && isApproved(approvals, 'definition', id, definitions.get(id)!.raw)));
    for (const id of unapproved) if (definitions.has(id)) await this.enqueueApproval('definition', id, 'Definition used by an approved or proved result.');
    const allApproved = order.every((id) => settled.has(id) && assets.get(id)!.data.status === 'approved');
    if (allApproved && !unapproved.length && !order.some((id) => state.parked[id]) && !examples.some((example) => example.data.status === 'draft' && order.includes(example.data.refutes))) {
      if (state.extension) {
        const baseline = new Set(this.closure(state.extension.baselineRequired, assets).order);
        state.extension.newResults = order.filter((id) => !baseline.has(id));
      }
      return { stage: 'ready' };
    }
    const reasons = [
      state.approvalQueue.length ? `${state.approvalQueue.length} approval request(s) waiting: ${state.approvalQueue.map((item) => `${item.kind} ${item.target}`).join(', ')}` : '',
      Object.keys(state.parked).length ? `parked: ${Object.entries(state.parked).map(([id, info]) => `${id} (${info.reason})`).join(', ')}` : '',
      unapproved.filter((id) => !definitions.has(id)).length ? `missing definitions: ${unapproved.filter((id) => !definitions.has(id)).join(', ')}` : '',
    ].filter(Boolean);
    return { stage: 'waiting', reason: reasons.join('; ') || 'nothing actionable' };
  }

  /** Compute or confirm the current stage and return the instruction for the agent. */
  async next(): Promise<NextResult> {
    const state = this.require();
    if (state.status !== 'running') return this.result(`The loop is ${state.status}. Run: ${LOOP_COMMAND} resume`);
    if (state.pendingQuestion) return this.result(`Question ${state.pendingQuestion.id} (${state.pendingQuestion.kind}) is waiting for the researcher: ${state.pendingQuestion.prompt}`);
    const perAsset = ['falsify', 'verify_counterexample', 'plan', 'execute'].includes(state.stage);
    let recompute = ['select', 'waiting', 'ready', 'review_project', 'discuss_goals'].includes(state.stage);
    if (!recompute && !(await this.isProjectApproved()) && state.stage !== 'draft_project') recompute = true;
    if (perAsset && state.current.assetId) {
      const file = `${this.paths.assets}/${state.current.assetId}.md`;
      const data = (await this.files.exists(file)) ? parseMarkdown(await this.files.readFile(file)).data : undefined;
      if (!data || data.status !== 'draft' || state.parked[state.current.assetId]) recompute = true;
    }
    if (recompute) {
      const selection = await this.computeSelection();
      const patch: Partial<LoopState['current']> = 'assetId' in selection ? { assetId: selection.assetId, planId: undefined, counterexampleId: undefined } : { assetId: undefined, planId: undefined, counterexampleId: undefined };
      if (selection.stage === 'plan' && 'assetId' in selection) patch.planId = await this.pendingPlan(selection.assetId);
      await this.setStage(selection.stage, patch);
      if (selection.stage === 'scaffold') state.scaffoldBrief = { missing: selection.missing, incomplete: selection.incomplete };
      if (selection.stage === 'waiting') state.lastError = selection.reason;
      if (selection.stage === 'waiting' || selection.stage === 'ready') await this.save();
    }
    return this.result();
  }

  private result(blocked?: string): NextResult {
    const state = this.require();
    const brief: Record<string, unknown> = {
      stage: state.stage, assetId: state.current.assetId, planId: state.current.planId, counterexampleId: state.current.counterexampleId,
      researcherInput: state.researcherInput?.text, changesRequested: state.current.assetId ? state.progress[state.current.assetId]?.changesRequested : undefined,
      parked: state.parked, approvalQueue: state.approvalQueue.map((item) => `${item.kind}:${item.target}`), scaffold: state.scaffoldBrief, extension: state.extension,
      paths: { project: this.paths.projectMd, assets: this.paths.assets, definitions: this.paths.definitions, ideas: this.paths.ideas, plans: this.paths.plans, checks: this.shared.checks, papers: this.paths.paperIndex, bibliography: this.paths.bibliography },
    };
    return { stage: state.stage, instruction: blocked ?? this.instruction(state), brief, blocked };
  }

  instruction(state: LoopState): string {
    const asset = state.current.assetId ?? '(none)';
    const input = state.researcherInput ? `\nResearcher input: ${state.researcherInput.text}` : '';
    const report = (outcomes: string) => `\nWhen done run: ${LOOP_COMMAND} report <${outcomes}> --summary "<= 5 lines"`;
    switch (state.stage) {
      case 'discuss_goals':
        return `Stage discuss_goals. Ask the researcher for the research goal, the main claim, and constraints with ask_researcher(kind: "goals"). If they answer, the loop moves to draft_project automatically. Without the MCP tool, ask in chat and record the answer with: ${LOOP_COMMAND} question answer --text "..." (or report complete --summary "<their goal>").${input}`;
      case 'draft_project':
        return `Stage draft_project. Draft or revise ${this.paths.projectMd} only: fill ## Main Problem, ## Background, ## Current Goals, ## Required Results (one bullet per stable snake_case asset ID, "- id: role"), ## Known Results, ## Open Questions. Do not claim approval.${state.extension && !state.extension.projectApproved ? ` This extends an approved project: keep every existing bullet under ## Required Results (${state.extension.baselineRequired.join(', ')}) and leave approved statements unchanged; add the new goal as new asset ID(s) and update ## Current Goals.` : ''}${input}${report('complete|question')}`;
      case 'review_project':
        return `Stage review_project. Call request_approval(kind: "project", target: "project", summary: "<what changed>") so the researcher can approve project.md. Do not edit files. Then run: ${LOOP_COMMAND} next`;
      case 'scaffold': {
        const brief = state.scaffoldBrief;
        return `Stage scaffold. Create missing draft assets in ${this.paths.assets}/ for ${brief?.missing?.length ? `missing IDs: ${brief.missing.join(', ')}` : 'every required result and dependency'}${brief?.incomplete?.length ? `; complete the statements of: ${brief.incomplete.join(', ')}` : ''}. Each needs type, title, status: draft, source.kind self_proved (unless genuinely sourced), depends_on, uses_definitions, and a precise ## Statement. Create draft definitions in ${this.paths.definitions}/ as needed. Do not modify existing assets or definitions. Then run order-assets and link-research-nodes.${input}${report('complete|question')}`;
      }
      case 'sources':
        return `Stage sources. Find results from indexed papers (or a verifiable new paper) that the required results can use. For a new paper append a ## slug section with a stable DOI/arXiv/publisher URL to ${this.paths.paperIndex} and a matching BibTeX entry to ${this.paths.bibliography}; never change existing entries. Create only draft, paper-sourced assets (paper_id and exact location) and draft definitions. If a source cannot be verified, do not cite it: ask the researcher or record an idea. Return none when nothing verifiable exists.${report('complete|none|question')}`;
      case 'falsify':
        return `Stage falsify for asset ${asset}. Use the falsify-asset skill: try to refute the exact statement. A candidate must be a new draft example in ${this.paths.assets}/ with refutes: ${asset}, ## Assumptions, ## Calculation; return candidate --counterexample <id>. With no counterexample, write one falsification check ${this.shared.checks}/check_${asset}_<short_slug>.md (type falsification_check, title, target_asset: ${asset}, outcome: no_counterexample_found, ## Cases checked listing each family tried, ## Limitations naming what was not covered) and return none. A failed proof attempt is not a counterexample.${input}${report('candidate|none|question')}`;
      case 'verify_counterexample':
        return `Stage verify_counterexample for ${state.current.counterexampleId} (refutes ${asset}). Independently recheck every hypothesis and calculation; write ## Verdict in the example. confirmed: leave it draft (the researcher will confirm). rejected: set the example status to archived. Never edit ${asset}.${report('confirmed|rejected|question')}`;
      case 'plan': {
        const requested = state.current.assetId ? state.progress[state.current.assetId]?.changesRequested : undefined;
        return `Stage plan for asset ${asset}. Use the prove-asset skill. ${state.current.planId ? `Execute the existing pending plan ${state.current.planId} instead of writing a new one: report complete --plan ${state.current.planId}.` : `Write one new pending plan in ${this.paths.plans}/ (Goal with the target link, Plan checklist, Verification, Assumed definitions; with failed plans present also ## Difference from failed plans, one bullet per failed plan ID).`}${requested ? `\nThe researcher requested changes: ${requested}` : ''}${input}${report('complete --plan <id>|question')}`;
      }
      case 'execute':
        return `Stage execute plan ${state.current.planId} for asset ${asset}. Follow the checklist; tick boxes only for established steps. Success: write the complete proof under ## Proof in the asset (statement unchanged, status draft) and convert the plan to type proof_record (no status) with ## Outcome. Obstruction: set the plan status failed with ## Failure. Never set status approved.${report('proved|failed|question')}`;
      case 'waiting':
        return `Stage waiting. ${state.lastError ?? 'Nothing is actionable.'} Tell the researcher what needs their decision, then stop; the loop resumes when they act.`;
      case 'ready':
        if (state.extension?.newResults?.length) return `Stage ready. Every required result and dependency is approved, including the new result(s) ${state.extension.newResults.join(', ')}. If a manuscript already exists, use the plan-manuscript skill to place only these into the existing outline (new or adjusted section briefs), then redraft only the affected sections; keep the other briefs and TeX files. Otherwise tell the researcher the project is ready for the plan-manuscript skill.`;
        return `Stage ready. Every required result and dependency is approved. Tell the researcher the project is ready for the plan-manuscript skill. To add a new result later, run: ${LOOP_COMMAND} extend --goal "..."`;
      default:
        return `Run: ${LOOP_COMMAND} next`;
    }
  }

  // ---------- report and validation ----------

  private async takeSnapshot(): Promise<void> {
    await this.files.writeFile(SNAPSHOT_PATH, JSON.stringify(await this.fingerprints(), null, 0) + '\n');
  }

  private async fingerprints(): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    const add = async (file: string) => { const raw = await this.files.readFile(file).catch(() => undefined); if (raw !== undefined) map[file] = crypto.createHash('sha256').update(raw).digest('hex'); };
    const shared = this.shared;
    for (const folder of [this.paths.assets, this.paths.definitions, this.paths.ideas, this.paths.plans, shared.checks, shared.decisions, shared.handoffs]) for (const file of await this.files.listFiles(folder)) await add(file);
    for (const file of [this.paths.projectMd, this.paths.paperIndex, this.paths.bibliography, ...await approvalFiles(this.files, this.paths.researchRoot)]) await add(file);
    return map;
  }

  /** Files added or modified since the current stage started. */
  async changedFiles(): Promise<{ added: string[]; modified: string[]; before: Record<string, string> }> {
    const before = JSON.parse(await this.files.readFile(SNAPSHOT_PATH).catch(() => '{}')) as Record<string, string>;
    const after = await this.fingerprints();
    const added = Object.keys(after).filter((file) => !(file in before) && after[file] !== EMPTY_HASH).sort();
    const modified = Object.keys(after).filter((file) => file in before && before[file] !== after[file]).sort();
    return { added, modified, before };
  }

  private folders() { return { assets: this.paths.assets, definitions: this.paths.definitions, ideas: this.paths.ideas, plans: this.paths.plans, checks: this.shared.checks, decisions: this.shared.decisions, handoffs: this.shared.handoffs }; }

  private async paperIds(): Promise<Set<string>> {
    const index = await this.files.readFile(this.paths.paperIndex).catch(() => '');
    return new Set(index.match(/^##\s+([a-z][a-z0-9_]*)\s*$/gm)?.map((heading) => heading.replace(/^##\s+/, '').trim()) ?? []);
  }

  /** Validate the files written during the current stage against that stage's rules. */
  private async validateStageFiles(): Promise<{ added: string[]; modified: string[]; problems: string[] }> {
    const state = this.require();
    const { added, modified } = await this.changedFiles();
    const problems: string[] = [];
    const stage = state.stage;
    const folders = this.folders();
    const isIn = (file: string, folder: string) => path.posix.dirname(file) === folder;
    const allowedFolders = new Set<string>([folders.ideas]);
    if (stage === 'scaffold' || stage === 'sources') { allowedFolders.add(folders.assets); allowedFolders.add(folders.definitions); }
    if (stage === 'falsify' || stage === 'verify_counterexample') allowedFolders.add(folders.assets);
    if (stage === 'falsify') allowedFolders.add(folders.checks);
    if (stage === 'plan' || stage === 'execute') allowedFolders.add(folders.plans);
    if (stage === 'execute') allowedFolders.add(folders.assets);
    const allowedFiles = new Set<string>();
    if (stage === 'draft_project') allowedFiles.add(this.paths.projectMd);
    if (stage === 'sources') { allowedFiles.add(this.paths.paperIndex); allowedFiles.add(this.paths.bibliography); }
    const paperIds = await this.paperIds();
    for (const file of [...added, ...modified]) {
      if (isApprovalPath(this.paths.researchRoot, file)) { problems.push(`${file}: approval records were modified; only the researcher may approve. Restore it with git.`); continue; }
      const folder = path.posix.dirname(file);
      if (folder === folders.decisions || folder === folders.handoffs) { problems.push(`${file}: decisions and handoffs are written only by the loop. Restore it with git.`); continue; }
      if (!allowedFiles.has(file) && !allowedFolders.has(folder)) { problems.push(`${file}: not writable during stage ${stage}.`); continue; }
      if (file === this.paths.paperIndex || file === this.paths.bibliography) continue; // append-only check below
      if (file === this.paths.projectMd) {
        if (!requiredAssetIds(await this.files.readFile(file)).length) problems.push('project.md needs ## Required Results with asset IDs.');
        continue;
      }
      const raw = await this.files.readFile(file);
      try { validateResearchFile(file, raw, folders, paperIds); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); continue; }
      const data = parseMarkdown(raw).data;
      if (modified.includes(file) && ['scaffold', 'sources', 'falsify', 'plan'].includes(stage) && !isIn(file, folders.ideas) && !(stage === 'plan' && isIn(file, folders.plans) && data.status === 'pending')) problems.push(`${file}: existing files may not be changed during ${stage}.`);
      if (stage === 'verify_counterexample' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.counterexampleId}.md`) problems.push(`${file}: verification may change only the candidate example.`);
      if (stage === 'execute' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md`) problems.push(`${file}: execution may change only its target asset.`);
      if (stage === 'execute' && isIn(file, folders.plans) && file !== `${folders.plans}/${state.current.planId}.md`) problems.push(`${file}: execution may change only its active plan.`);
      if ((stage === 'plan' || stage === 'execute') && isIn(file, folders.plans) && data.target_asset !== state.current.assetId) problems.push(`${file}: plan targets ${data.target_asset}, not ${state.current.assetId}.`);
      if ((stage === 'falsify' || stage === 'verify_counterexample') && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md` && (data.type !== 'example' || data.refutes !== state.current.assetId)) problems.push(`${file}: only a counterexample example refuting ${state.current.assetId} may be written now.`);
      if (isIn(file, folders.checks) && (stage !== 'falsify' || data.target_asset !== state.current.assetId || data.outcome !== 'no_counterexample_found')) problems.push(`${file}: a falsification check may only record no_counterexample_found for ${state.current.assetId} during falsify.`);
      if (isIn(file, folders.plans) && data.type === 'plan') {
        const failed = (await this.failedPlans(String(data.target_asset))).filter((id) => id !== path.posix.basename(file, '.md'));
        if (failed.length && data.status === 'pending') {
          const section = sectionContent(parseMarkdown(raw).content, 'Difference from failed plans');
          const missing = failed.filter((id) => !section.includes(id));
          if (missing.length) problems.push(`${file}: ## Difference from failed plans must mention ${missing.join(', ')}.`);
        }
        if (typeof data.target_asset === 'string' && !parseMarkdown(raw).content.includes(`../assets/${data.target_asset}.md`) && !parseMarkdown(raw).content.includes(`${this.paths.assets}/${data.target_asset}.md`)) problems.push(`${file}: missing the target asset link.`);
      }
      for (const dep of Array.isArray(data.depends_on) ? data.depends_on : []) {
        const known = isIn(file, folders.definitions) ? `${folders.definitions}/${dep}.md` : `${folders.assets}/${dep}.md`;
        if (typeof dep !== 'string' || !(await this.files.exists(known))) problems.push(`${file}: unknown dependency ${String(dep)}.`);
      }
      for (const definition of Array.isArray(data.uses_definitions) ? data.uses_definitions : []) if (typeof definition !== 'string' || !(await this.files.exists(`${folders.definitions}/${definition}.md`))) problems.push(`${file}: unknown definition ${String(definition)}.`);
      if (data.type === 'example' && typeof data.refutes === 'string' && !(await this.files.exists(`${folders.assets}/${data.refutes}.md`))) problems.push(`${file}: refutes unknown asset ${data.refutes}.`);
    }
    if (stage === 'sources') {
      const { before } = await this.changedFiles();
      for (const file of [this.paths.paperIndex, this.paths.bibliography]) {
        if (!modified.includes(file)) continue;
        const raw = await this.files.readFile(file);
        const original = await this.originalFromGitOrSnapshot(file, before);
        if (original !== undefined && !raw.startsWith(original.trimEnd())) problems.push(`${file}: append only; existing entries changed.`);
      }
      const existing = await this.paperIds();
      const index = await this.files.readFile(this.paths.paperIndex).catch(() => '');
      const bib = await this.files.readFile(this.paths.bibliography).catch(() => '');
      for (const paperId of existing) {
        const section = new RegExp(`^## ${paperId}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(index)?.[1] ?? '';
        if (added.some((file) => isIn(file, folders.assets)) && !/https?:\/\//.test(section) && !new RegExp(`^@\\w+\\{${paperId},`, 'm').test(bib)) problems.push(`${paperId}: paper needs a stable source URL and a BibTeX entry.`);
      }
    }
    if (stage === 'execute' && state.current.assetId) {
      const file = `${folders.assets}/${state.current.assetId}.md`;
      const raw = await this.files.readFile(file).catch(() => '');
      const frozen = state.current.statementDigest;
      if (raw && frozen && statementDigest(raw) !== frozen) problems.push(`${file}: the statement changed during execution. Restore it; a new statement needs a new asset ID.`);
    }
    return { added, modified, problems };
  }

  private async originalFromGitOrSnapshot(file: string, _before: Record<string, string>): Promise<string | undefined> {
    // Append-only checks compare against the content recorded at stage start, else the stage's base commit.
    const stash = await this.files.readFile(`${path.posix.dirname(SNAPSHOT_PATH)}/stage-files/${file.replace(/\//g, '__')}`).catch(() => undefined);
    if (stash !== undefined || !this.git) return stash;
    return this.git.showFile(this.state?.current.baseCommit ?? 'HEAD', file);
  }

  /**
   * Refuse to attribute files that git changed during the stage (a pull, a
   * merge, a collaborator's commit) to the agent. Local commits by this
   * researcher at a commit point are fine: they do not change the working tree.
   */
  private async staleBaseProblem(): Promise<string | undefined> {
    const base = this.state?.current.baseCommit;
    if (!this.git || !base) return undefined;
    const head = await this.git.head();
    if (!head || head === base) return undefined;
    const { added, modified } = await this.changedFiles();
    const touched = [...added, ...modified];
    if (!touched.length) return undefined;
    const viaGit = new Set((await this.git.diffNameStatus(base, head, touched).catch(() => [])).map((entry) => entry.path));
    const overlap = touched.filter((file) => viaGit.has(file));
    if (!overlap.length) return undefined;
    const me = (await this.provenance()).performed_by;
    const authors = await this.git.authors(`${base}..${head}`, overlap);
    const merges = Number((await this.git.run(['rev-list', '--count', '--merges', `${base}..${head}`])).stdout.trim()) || 0;
    if (!merges && authors.every((author) => author === me)) return undefined;
    return `HEAD moved from ${base.slice(0, 8)} to ${head.slice(0, 8)} during stage ${this.state!.stage} and changed ${overlap.join(', ')} (by ${authors.join(', ') || 'unknown'}). These are not this stage's edits. Run \`${LOOP_COMMAND} sync pull --continue\` to re-baseline, then redo the stage.`;
  }

  private async stashStageFiles(): Promise<void> {
    for (const file of [this.paths.paperIndex, this.paths.bibliography]) {
      const raw = await this.files.readFile(file).catch(() => undefined);
      if (raw !== undefined) await this.files.writeFile(`${path.posix.dirname(SNAPSHOT_PATH)}/stage-files/${file.replace(/\//g, '__')}`, raw);
    }
  }

  async report(report: StageReport): Promise<{ stage: LoopStage; message: string }> {
    const state = this.require();
    if (state.status !== 'running') throw new Error(`The loop is ${state.status}; resume it first.`);
    if (state.pendingQuestion) throw new Error(`Question ${state.pendingQuestion.id} is still pending; answer it (or wait) before reporting.`);
    const stale = report.outcome === 'question' ? undefined : await this.staleBaseProblem();
    if (stale) throw new Error(stale);
    const stage = state.stage;
    const finish = async (message: string, next: LoopStage, patch: Partial<LoopState['current']> = {}) => {
      state.lastSummary = { stage, assetId: state.current.assetId, outcome: report.outcome, summary: report.summary, files: [], at: this.now() };
      await this.event('report', { stage, outcome: report.outcome, summary: report.summary, assetId: state.current.assetId, planId: state.current.planId });
      await this.setStage(next, patch);
      return { stage: next, message };
    };
    const validated = async () => {
      const { added, modified, problems } = await this.validateStageFiles();
      if (problems.length) throw new Error(`Stage ${stage} validation failed:\n- ${problems.join('\n- ')}\nFix the files (restore unintended changes with git) and report again.`);
      if (state.lastSummary) state.lastSummary.files = [...added, ...modified];
      return { added, modified };
    };
    if (report.outcome === 'question') {
      const kind: QuestionKind = stage === 'plan' && report.question?.toLowerCase().includes('fail') ? 'blocked' : 'discussion';
      await this.askQuestion(kind, report.question || report.summary);
      return { stage, message: `Question recorded for the researcher. Ask it in chat, then record the answer with: ${LOOP_COMMAND} question answer --text "..."` };
    }
    switch (stage) {
      case 'discuss_goals': {
        if (!report.summary.trim()) throw new Error('Report the researcher\'s goal in --summary.');
        state.researcherInput = { kind: 'goals', text: report.summary.trim(), at: this.now() };
        return finish('Goals recorded. Draft project.md.', 'draft_project');
      }
      case 'draft_project': {
        await validated();
        const project = await this.files.readFile(this.paths.projectMd);
        if (!projectSection(project, 'Main Problem')) throw new Error('project.md needs a ## Main Problem.');
        if (!requiredAssetIds(project).length) throw new Error('project.md needs ## Required Results with asset IDs.');
        const extensionProblems = this.extensionProblems(project);
        if (extensionProblems.length) throw new Error(`Stage draft_project validation failed:\n- ${extensionProblems.join('\n- ')}`);
        await this.enqueueApproval('project', 'project', report.summary || 'Project goals drafted.');
        state.researcherInput = undefined;
        return finish('project.md drafted; request the researcher\'s approval with request_approval(kind: "project").', 'review_project');
      }
      case 'scaffold': {
        await validated();
        delete state.scaffoldBrief;
        await this.stashStageFiles();
        return finish('Scaffold recorded. Next: sources.', 'sources');
      }
      case 'sources': {
        await validated();
        return finish('Sources recorded. Next: select.', 'select');
      }
      case 'falsify': {
        const { added } = await validated();
        const assetId = state.current.assetId!;
        if (report.outcome === 'candidate') {
          const candidate = report.counterexampleId ?? added.map((file) => path.posix.basename(file, '.md')).find((id) => added.includes(`${this.paths.assets}/${id}.md`));
          if (!candidate) throw new Error('candidate needs --counterexample <example id>.');
          const raw = await this.files.readFile(`${this.paths.assets}/${candidate}.md`);
          if (parseMarkdown(raw).data.refutes !== assetId) throw new Error(`${candidate} must set refutes: ${assetId}.`);
          return finish(`Candidate ${candidate} recorded. Next: verify it independently.`, 'verify_counterexample', { counterexampleId: candidate });
        }
        if (report.outcome !== 'none') throw new Error('falsify outcome must be candidate, none, or question.');
        const checkFiles = added.filter((file) => path.posix.dirname(file) === this.shared.checks);
        if (checkFiles.length !== 1) throw new Error(`none needs exactly one new falsification check in ${this.shared.checks}/ for ${assetId} (## Cases checked, ## Limitations); found ${checkFiles.length}.`);
        const assetRaw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
        await this.files.writeFile(checkFiles[0], stampCheck(await this.files.readFile(checkFiles[0]), statementDigest(assetRaw), await this.provenance()));
        return finish(`No counterexample found for ${assetId}. Next: plan.`, 'plan', { planId: await this.pendingPlan(assetId) });
      }
      case 'verify_counterexample': {
        await validated();
        const assetId = state.current.assetId!;
        const exampleId = state.current.counterexampleId!;
        const example = parseMarkdown(await this.files.readFile(`${this.paths.assets}/${exampleId}.md`));
        if (report.outcome === 'confirmed') {
          if (!sectionContent(example.content, 'Verdict')) throw new Error(`${exampleId} needs a ## Verdict.`);
          await this.enqueueApproval('counterexample', exampleId, `Independently verified counterexample to ${assetId}; confirm or reject.`);
          state.parked[assetId] = { reason: 'counterexample_pending', at: this.now() };
          return finish(`Counterexample ${exampleId} verified; the researcher must confirm it. Call request_approval(kind: "counterexample", target: "${exampleId}").`, 'select', { assetId: undefined, counterexampleId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_counterexample outcome must be confirmed, rejected, or question.');
        if (example.data.status !== 'archived') throw new Error(`Set ${exampleId} status to archived when rejecting it.`);
        await this.writeCheck(assetId, 'counterexample_rejected', `Candidate ${exampleId} was checked independently and rejected:\n\n${sectionContent(example.content, 'Verdict') || report.summary}`, 'Only this candidate family was examined; no systematic search beyond it is recorded here.');
        return finish(`Candidate rejected. Next: plan for ${assetId}.`, 'plan', { counterexampleId: undefined, planId: await this.pendingPlan(assetId) });
      }
      case 'plan': {
        if (report.outcome !== 'complete') throw new Error('plan outcome must be complete --plan <id> or question.');
        const { added } = await validated();
        const assetId = state.current.assetId!;
        const planId = report.planId ?? state.current.planId ?? added.filter((file) => path.posix.dirname(file) === this.paths.plans).map((file) => path.posix.basename(file, '.md'))[0];
        if (!planId) throw new Error('Planning did not produce a plan; pass --plan <id>.');
        const plan = parseMarkdown(await this.files.readFile(`${this.paths.plans}/${planId}.md`));
        if (plan.data.type !== 'plan' || plan.data.status !== 'pending' || plan.data.target_asset !== assetId) throw new Error(`${planId} must be a pending plan targeting ${assetId}.`);
        const assetRaw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
        state.progress[assetId] = { ...state.progress[assetId], changesRequested: undefined };
        state.current.statementDigest = statementDigest(assetRaw);
        state.researcherInput = undefined;
        return finish(`Plan ${planId} recorded. Next: execute it.`, 'execute', { planId });
      }
      case 'execute': {
        await validated();
        const assetId = state.current.assetId!;
        const planId = state.current.planId!;
        const plan = parseMarkdown(await this.files.readFile(`${this.paths.plans}/${planId}.md`));
        if (report.outcome === 'proved') {
          const asset = parseMarkdown(await this.files.readFile(`${this.paths.assets}/${assetId}.md`));
          if (plan.data.type !== 'proof_record' || !sectionContent(plan.content, 'Outcome')) throw new Error(`${planId} must become type proof_record with ## Outcome.`);
          if (!proofText(asset.content)) throw new Error(`${assetId} needs the proof under ## Proof.`);
          if (asset.data.status !== 'draft') throw new Error(`${assetId} must stay draft until the researcher approves it.`);
          await this.enqueueApproval('asset', assetId, `Proof from ${planId}${report.assumedDefinitions?.length ? `; uses draft definitions ${report.assumedDefinitions.join(', ')}` : ''}.`);
          for (const definition of report.assumedDefinitions ?? []) if (await this.files.exists(`${this.paths.definitions}/${definition}.md`)) await this.enqueueApproval('definition', definition, `Used by the proof of ${assetId}.`);
          delete state.current.statementDigest;
          return finish(`Proof recorded for ${assetId}. Call request_approval(kind: "asset", target: "${assetId}") and continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'failed') throw new Error('execute outcome must be proved, failed, or question.');
        if (plan.data.type !== 'plan' || plan.data.status !== 'failed' || !sectionContent(plan.content, 'Failure')) throw new Error(`${planId} must have status failed and a ## Failure section.`);
        const failures = await this.failuresSinceDirection(assetId);
        delete state.current.statementDigest;
        if (failures >= MAX_FAILED_PLANS) {
          await this.setStage('plan', { planId: undefined });
          await this.askQuestion('blocked', `${assetId} has ${failures} documented failed approaches since the last direction. Give a new direction, or skip to park it and move on.`, { assetId });
          return { stage: 'plan', message: `Three approaches failed for ${assetId}. Ask the researcher with ask_researcher(kind: "blocked"); on timeout park the asset.` };
        }
        return finish(`Plan ${planId} failed (${failures}/${MAX_FAILED_PLANS}). Next: a different plan.`, 'plan', { planId: await this.pendingPlan(assetId) });
      }
      default:
        throw new Error(`Stage ${stage} takes no report. Run: ${LOOP_COMMAND} next`);
    }
  }

  /** Agent-agnostic backstop: approved nodes without a verified record are reverted; changed dependencies invalidate dependants. */
  async validateWorkspace(options: { fix?: boolean } = {}): Promise<ValidationResult> {
    const problems: string[] = [];
    const fixed: string[] = [];
    const approvals = await this.approvals();
    for (const [kind, folder] of [['asset', this.paths.assets], ['definition', this.paths.definitions]] as const) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        let parsed: matter.GrayMatterFile<string>;
        try { parsed = parseMarkdown(raw); } catch { problems.push(`${file}: invalid YAML`); continue; }
        const id = path.posix.basename(file, '.md');
        if (parsed.data.status !== 'approved') continue;
        if (!isApproved(approvals.records, kind, id, raw)) {
          problems.push(`${file}: status approved without a matching researcher approval record.`);
          if (options.fix) {
            parsed.data.status = 'draft';
            await this.files.writeFile(file, stringifyMarkdown(parsed.content, parsed.data));
            approvals.records = approvals.records.filter((record) => !(record.kind === kind && record.target === id));
            fixed.push(id);
            await this.event('approval_invalidated', { id, reason: 'validate' });
          }
        }
      }
    }
    if (fixed.length) await this.writeApprovals(approvals);
    if (options.fix) fixed.push(...await this.reconcile());
    return { problems, fixed };
  }

  /**
   * Re-apply `status: approved` where a researcher's approval record still
   * matches the node's current content. Repairs nodes that a stale driver
   * reverted while their records survived; never approves anything new.
   */
  async restoreApprovals(): Promise<string[]> {
    const records = (await this.approvals()).records;
    const restored: string[] = [];
    for (const [kind, folder] of [['asset', this.paths.assets], ['definition', this.paths.definitions]] as const) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        let parsed: matter.GrayMatterFile<string>;
        try { parsed = parseMarkdown(raw); } catch { continue; }
        const id = path.posix.basename(file, '.md');
        if (parsed.data.status === 'approved' || !isApproved(records, kind, id, raw)) continue;
        parsed.data.status = 'approved';
        await this.writeOwned(file, stringifyMarkdown(parsed.content, parsed.data));
        restored.push(id);
      }
    }
    // Retire an emptied legacy approvals.json that an old driver may have re-created.
    if (await this.files.exists(legacyApprovalsPath(this.paths.researchRoot))) await this.writeApprovals({ version: 1, records });
    if (this.state && restored.length) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => !restored.includes(item.target));
      await this.save();
    }
    if (restored.length) await this.event('approvals_restored', { restored });
    return restored;
  }

  // ---------- whole-workspace checks and handoffs (used by sync) ----------

  /** Validate every committed research file, dependency references, and cycles; returns problems without changing files. */
  async validateAll(): Promise<string[]> {
    const problems: string[] = [];
    const folders = this.folders();
    const paperIds = await this.paperIds();
    const assets = await this.collect(this.paths.assets);
    const definitions = await this.collect(this.paths.definitions);
    for (const folder of [folders.assets, folders.definitions, folders.ideas, folders.plans, folders.checks, folders.decisions, folders.handoffs]) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        if (/^<{7} |^>{7} |^={7}$/m.test(raw)) { problems.push(`${file}: unresolved merge conflict markers.`); continue; }
        try { validateResearchFile(file, raw, folders, paperIds, { committed: true }); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); continue; }
        const data = parseMarkdown(raw).data;
        for (const dep of Array.isArray(data.depends_on) ? data.depends_on : []) {
          const known = folder === folders.definitions ? definitions.has(String(dep)) : assets.has(String(dep));
          if (!known) problems.push(`${file}: unknown dependency ${String(dep)}.`);
        }
        for (const definition of Array.isArray(data.uses_definitions) ? data.uses_definitions : []) if (!definitions.has(String(definition))) problems.push(`${file}: unknown definition ${String(definition)}.`);
        if (typeof data.refutes === 'string' && !assets.has(data.refutes)) problems.push(`${file}: refutes unknown asset ${data.refutes}.`);
        if ((folder === folders.plans || folder === folders.checks) && typeof data.target_asset === 'string' && !assets.has(data.target_asset)) problems.push(`${file}: targets unknown asset ${data.target_asset}.`);
      }
    }
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (/^<{7} |^>{7} /m.test(project)) problems.push(`${this.paths.projectMd}: unresolved merge conflict markers.`);
    const { cycle } = this.closure([...assets.keys()], assets);
    if (cycle) problems.push(`Dependency cycle at ${cycle}.`);
    for (const file of await approvalFiles(this.files, this.paths.researchRoot)) {
      const raw = await this.files.readFile(file).catch(() => '');
      if (raw.trim()) try { JSON.parse(raw); } catch { problems.push(`${file}: invalid JSON (merge conflict?).`); }
    }
    return problems;
  }

  /** Approved nodes whose approval no longer matches, without changing anything. */
  async approvalProblems(): Promise<string[]> {
    const problems: string[] = [];
    const records = (await this.approvals()).records;
    for (const [kind, folder] of [['asset', this.paths.assets], ['definition', this.paths.definitions]] as const) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        let data: Record<string, any>;
        try { data = parseMarkdown(raw).data; } catch { continue; }
        const id = path.posix.basename(file, '.md');
        if (data.status === 'approved' && !isApproved(records, kind, id, raw)) problems.push(`${file}: status approved without a matching approval record.`);
      }
    }
    const details: Array<{ id: string; reason: string }> = [];
    await this.reconcile(undefined, { dryRun: true, details });
    for (const item of details) problems.push(`${item.id}: approval is stale (${item.reason}).`);
    return [...new Set(problems)];
  }

  async latestHandoff(): Promise<{ file: string; performedBy?: string; createdAt?: string; workingOn: string[] } | undefined> {
    const handoffs: Array<{ file: string; performedBy?: string; createdAt?: string; workingOn: string[] }> = [];
    for (const file of await this.files.listFiles(this.shared.handoffs)) {
      const info = parseHandoff(await this.files.readFile(file).catch(() => ''));
      if (info) handoffs.push({ file, ...info });
    }
    return handoffs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop();
  }

  /** Write a handoff that tells the next collaborator what was done, what waits, and where to continue. */
  async writeHandoff(note?: string): Promise<string> {
    const provenance = await this.provenance();
    const previous = await this.latestHandoff();
    const since = previous?.createdAt ?? '';
    const state = this.state;
    const events = (await this.recentEvents(500)).filter((event) => String(event.at ?? '') > since);
    const completed = events.flatMap((event) => {
      if (event.type === 'report') return [`${String(event.stage)}${event.assetId ? ` ${String(event.assetId)}` : ''}: ${String(event.outcome)} — ${String(event.summary ?? '').split('\n')[0]}`];
      if (event.type === 'approved') return [`Approved ${String(event.kind)} ${String(event.target)}.`];
      if (event.type === 'refuted') return [`${String(event.assetId)} refuted by ${String(event.exampleId)}.`];
      if (event.type === 'idea_converted') return [`Idea ${String(event.ideaId)} became plan ${String(event.planId)} for ${String(event.assetId)}.`];
      if (event.type === 'synced') return [`Pulled ${String(event.head ?? '').slice(0, 8)} from ${String(event.remote ?? 'upstream')}.`];
      return [];
    });
    const pending: string[] = [];
    if (state) {
      for (const item of state.approvalQueue) pending.push(`${item.kind} ${item.target} waits for researcher approval: ${item.reason}`);
      if (state.pendingQuestion) pending.push(`Open question (${state.pendingQuestion.kind}${state.pendingQuestion.assetId ? `, ${state.pendingQuestion.assetId}` : ''}): ${state.pendingQuestion.prompt}`);
      for (const [id, info] of Object.entries(state.parked)) pending.push(`${id} parked (${info.reason})${info.note ? `: ${info.note}` : ''}`);
    }
    const next = !state ? `Start the loop: ${LOOP_COMMAND} start --provider claude|codex` : state.stage === 'waiting' ? `Waiting on the researcher: ${state.lastError ?? 'see Pending'}` : `Stage ${state.stage}${state.current.assetId ? ` for ${state.current.assetId}` : ''}${state.current.planId ? ` (plan ${state.current.planId})` : ''}: ${this.instruction(state).split('\n')[0]}`;
    const file = `${this.shared.handoffs}/handoff_${stamp(provenance.created_at)}_${this.shortId()}.md`;
    await this.writeOwned(file, handoffMarkdown({ provenance, stage: state?.stage, workingOn: state?.current.assetId ? [state.current.assetId] : [], completed, pending, next, note }));
    await this.event('handoff', { file });
    return file;
  }

  /** After git changed the working tree: re-derive state from the files and start a fresh stage baseline. */
  async rebaseline(): Promise<void> {
    if (!this.state) return;
    await this.adoptExistingApprovals();
    await this.rebuildState();
    for (const file of await this.files.listFiles(`${path.posix.dirname(SNAPSHOT_PATH)}/stage-files`, '')) if (this.files.deleteFile) await this.files.deleteFile(file);
    // Keep requests whose popups may still be open; drop only those a collaborator already settled or removed.
    const records = (await this.approvals()).records;
    const keep: ApprovalRequest[] = [];
    for (const item of this.state.approvalQueue) {
      const file = item.kind === 'project' ? this.paths.projectMd : `${item.kind === 'definition' ? this.paths.definitions : this.paths.assets}/${item.target}.md`;
      const raw = await this.files.readFile(file).catch(() => '');
      if (!raw) continue;
      const kind = item.kind === 'project' ? 'project' : item.kind === 'definition' ? 'definition' : 'asset';
      if (isApproved(records, kind, item.target, raw)) continue;
      if (item.kind !== 'project') { try { if (['deprecated', 'archived'].includes(parseMarkdown(raw).data.status)) continue; } catch { continue; } }
      keep.push(item);
    }
    this.state.approvalQueue = keep;
    await this.setStage('select', { assetId: undefined, planId: undefined, counterexampleId: undefined, statementDigest: undefined });
  }

  // ---------- status ----------

  statusSummary(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { status: 'idle' };
    return {
      status: state.status, stage: state.stage, provider: state.provider, assetId: state.current.assetId, planId: state.current.planId,
      counterexampleId: state.current.counterexampleId, waitingForHuman: isWaitingForHuman(state), pendingQuestion: state.pendingQuestion,
      approvalQueue: state.approvalQueue, parked: state.parked, lock: state.lock, lastSummary: state.lastSummary, lastError: state.lastError,
      unreadAnswers: state.answers.filter((answer) => !answer.consumed), updatedAt: state.updatedAt,
    };
  }

  briefStatus(): string {
    const state = this.state;
    if (!state) return `Research loop: not started. Start it with \`${LOOP_COMMAND} start --provider claude|codex\` or the VS Code command "Research Assistant: Start research loop".`;
    const lines = [`Research loop: ${state.status}, stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}${state.current.planId ? `, plan ${state.current.planId}` : ''}.`];
    if (state.pendingQuestion) lines.push(`Pending question (${state.pendingQuestion.kind}): ${state.pendingQuestion.prompt}`);
    if (state.approvalQueue.length) lines.push(`Waiting for researcher approval: ${state.approvalQueue.map((item) => `${item.kind} ${item.target}`).join(', ')}.`);
    const parked = Object.entries(state.parked);
    if (parked.length) lines.push(`Parked: ${parked.map(([id, info]) => `${id} (${info.reason})`).join(', ')}.`);
    const unread = state.answers.filter((answer) => !answer.consumed);
    if (unread.length) lines.push(`Late researcher answers: ${unread.map((answer) => `"${answer.text.slice(0, 120)}"`).join(' | ')}`);
    if (state.lastError) lines.push(`Note: ${state.lastError}`);
    lines.push(state.status === 'running' && !state.pendingQuestion ? `Continue with: ${LOOP_COMMAND} next` : 'Approval is a researcher action; never set status: approved.');
    return lines.join('\n');
  }

  /** Mark late answers as seen by the agent. */
  async consumeAnswers(): Promise<void> {
    if (!this.state) return;
    let changed = false;
    for (const answer of this.state.answers) if (!answer.consumed) { answer.consumed = true; changed = true; }
    if (changed) await this.save();
  }
}
