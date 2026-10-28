import * as crypto from 'crypto';
import * as path from 'path';
import type matter from 'gray-matter';
import { LOOP_COMMAND, MANUSCRIPT_COMMAND } from './AgentProviders';
import { loadManuscriptImpact } from './ManuscriptImpactLoader';
import { renderImpact } from '../domain/manuscriptImpact';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { ProjectPaths } from '../models/types';
import {
  AUTO_HOLDS_PATH, AgentProvider, ApprovalFile, ApprovalKind, ApprovalRecord, ApprovalRequest, CONTEXT_MANIFEST_PATH, CONTEXT_PACK_PATH, EVENTS_PATH, LoopFiles, LoopQuestion, LoopStage, LoopState,
  LoopExtension, QuestionKind, SEARCH_STAGES, SNAPSHOT_PATH, STATE_DIR, STATE_PATH, StageReport, WaitingReason, approvalDigest, isApproved, isWaitingForHuman, newState,
  proofDigest, proofText, researchDigest, sharedFolders, statementDigest, statementIncomplete, validateResearchFile,
} from './ResearchLoopModel';
import { INACTIVE_STATUSES, IdeaKind, PROVABLE_TYPES } from '../domain/nodeKinds';
import { AUTO_APPROVE_RULES, AutoApprovePolicy, AutoApproveRule, LoopSettings } from '../models/settings';
import type { AutonomyView } from '../models/graph';
import { readLoopSettings } from './LoopSettingsStore';
import { AUTONOMOUS_AUTO_APPROVE, DEFAULT_LOOP_SETTINGS, LOOP_NUMBER_FIELDS } from '../domain/loopSettings';
import {
  CandidateInfo, NEGATED_CONCLUSION, RoundInfo, SearchMode, SearchProgress, assignDirections, candidateChecks, checkSections, parseCandidate, parseRound, renderBoard, roundDigest, searchProgress, specProperties,
} from '../domain/search';
import { normalizeContextBudgets, normalizeSyncConfig } from './ProjectPathsCore';
import { projectSection, requiredAssetIds } from '../domain/project';
import { duplicateIds, isCited } from '../domain/schema';
import { hasSection, sectionContent, statementPart } from '../domain/sections';
import { layoutReport } from '../domain/layout';
import { appendProjectRevision, approvalFiles, isApprovalPath, legacyApprovalsPath, readApprovals, writeApprovals } from './ApprovalStore';
import { LoopGit } from './LoopGit';
import {
  CheckInfo, DecisionExtra, DecisionInfo, DecisionKind, Provenance, checkMarkdown, sortDecisions, decisionId, decisionMarkdown, deriveChangesRequested, deriveParked,
  failuresSinceDirection, handoffMarkdown, latestDirection, parseCheck, parseDecision, parseHandoff, stamp, stampSearchRecord,
} from './ResearchRecords';
import {
  ContextManifest, ContextNode, ContextSources, DEFAULT_CONTEXT_BUDGETS, RenderedContext, assetClosure, definitionClosure, hasContextPack, planContext, projectPart, renderContext, renderShow,
} from './ResearchContext';
import { ideaPlanProblems } from './ProofIdeas';
import { LIBRARY_PREFIX, LibraryHit, ResultKind, findNodeFile, isLibraryId, isLibraryPath, libraryFolders, libraryProblems, listNodeFiles, locateNodeFile, nodeFolders, searchLibrary } from '../domain/registry';

export interface CoreOptions {
  now?: () => string;
  id?: () => string;
  /** Overrides the loop settings' iteration cap for runs this core starts (CLI `--iteration-cap`). */
  iterationCap?: number;
  /** Git for base-commit tracking and provenance; without it the loop works as before. */
  git?: LoopGit;
  /** Who performs researcher actions on this machine; defaults to sync.identity, then git user.email. */
  identity?: string;
  extensionVersion?: string;
  /** Per-stage token budgets for context packs; defaults to `contextBudgets` in .research-assistant.json. */
  contextBudgets?: Partial<Record<LoopStage, number>>;
}
export interface NextResult { stage: LoopStage; instruction: string; brief: Record<string, unknown>; blocked?: string }
export interface ValidationResult { problems: string[]; fixed: string[] }
type AssetInfo = ContextNode;
type Selection =
  | { stage: 'discuss_goals' | 'draft_project' | 'review_project' | 'ready'; note?: string }
  | { stage: 'scaffold'; missing: string[]; incomplete: string[]; missingDefinitions?: string[] }
  | { stage: 'plan'; assetId: string }
  | { stage: 'verify_proof'; assetId: string; planId: string }
  | { stage: 'search'; assetId: string; mode: SearchMode }
  | { stage: 'waiting'; reason: string; waitingOn: WaitingReason[] };
type Finish = (message: string, next: LoopStage, patch?: Partial<LoopState['current']>) => Promise<{ stage: LoopStage; message: string }>;
type SearchRound = NonNullable<LoopState['current']['search']>;
/** A construction to search for: it lists required properties (`- P1: ...`) and no construction has been written yet. */
function isConstructionSpec(raw: string): boolean {
  let parsed: { data: Record<string, any>; content: string };
  try { parsed = parseMarkdown(raw); } catch { return false; }
  return parsed.data.type === 'construction' && parsed.data.status === 'draft' && !hasSection(parsed.content, 'Construction') && specProperties(statementPart(parsed.content)).length > 0;
}
/** One worker pack per search slot, beside the stage's index pack. */
const searchPackPath = (slot: number) => `${STATE_DIR}/context/search-${slot}.md`;

const LOCK_TTL_MS = 10 * 60 * 1000;
/** Selection passes after auto approvals; each pass approves at least one request, so this only guards against surprises. */
const MAX_AUTO_PASSES = 16;
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

/**
 * Pure research-loop engine. Files are the state; this class only reads and
 * writes through `LoopFiles`, so the extension, the CLI, and tests share it.
 */
export class ResearchLoopCore {
  private state: LoopState | undefined;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly iterationCap: number | undefined;
  private readonly git: LoopGit | undefined;
  private readonly identity: string | undefined;
  private gitIdentity: string | undefined;
  private readonly extensionVersion: string | undefined;
  private readonly contextBudgets: Partial<Record<LoopStage, number>> | undefined;
  /** Last loop settings read, for the synchronous status text. */
  private lastSettings: LoopSettings | undefined;

  constructor(private readonly files: LoopFiles, private paths: ProjectPaths, options: CoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
    this.iterationCap = options.iterationCap;
    this.git = options.git;
    this.identity = options.identity;
    this.extensionVersion = options.extensionVersion;
    this.contextBudgets = options.contextBudgets;
  }

  setPaths(paths: ProjectPaths): void { this.paths = paths; }
  get current(): LoopState | undefined { return this.state; }
  get projectPaths(): ProjectPaths { return this.paths; }
  get shared() { return sharedFolders(this.paths.researchRoot); }

  /** The researcher's loop policy, read on every use so changes apply without restarting. */
  async loopSettings(): Promise<LoopSettings> {
    this.lastSettings = (await readLoopSettings(this.files)).settings;
    return this.lastSettings;
  }

  /** Raw .research-assistant.json; an unreadable file reads as empty. */
  private async projectConfig(): Promise<{ sync?: Record<string, unknown>; contextBudgets?: unknown }> {
    try { return JSON.parse(await this.files.readFile(this.paths.config)) as { sync?: Record<string, unknown>; contextBudgets?: unknown }; } catch { return {}; }
  }

  /** Who did it, when, and on which commit; stamped on approvals and shared records. */
  async provenance(): Promise<Provenance> {
    const identity = this.identity ?? normalizeSyncConfig((await this.projectConfig()).sync).identity ?? (this.gitIdentity ??= (await this.git?.userEmail()) ?? 'unknown');
    const head = await this.git?.head();
    const result: Provenance = { performed_by: identity, created_at: this.now() };
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
    this.state = await this.peek();
    return this.state;
  }

  /**
   * Read state.json without adopting it. Callers outside the host's serialized
   * queue (status bar, dashboard) use this: replacing `this.state` mid-operation
   * would leave a running action holding a stale copy.
   */
  async peek(): Promise<LoopState | undefined> {
    const raw = await this.files.readFile(STATE_PATH).catch(() => '');
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as Partial<LoopState> & { version?: number };
    return parsed.version === 2 ? parsed as LoopState : undefined;
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

  /**
   * Several processes log here at once (the extension, each chat's MCP bridge,
   * the CLI), so a line is appended, never written back with the file: a
   * read-and-rewrite that read an empty or half-written file erased the history.
   */
  async event(type: string, data: object = {}): Promise<void> {
    const line = JSON.stringify({ at: this.now(), runId: this.state?.runId, type, ...data }) + '\n';
    if (this.files.appendFile) { await this.files.appendFile(EVENTS_PATH, line); return; }
    const old = await this.files.readFile(EVENTS_PATH).catch(() => '');
    await this.files.writeFile(EVENTS_PATH, old + line);
  }

  /** The last `limit` events, counting only those `keep` accepts, so bookkeeping bursts never crowd out the rest. */
  async recentEvents(limit = 30, keep?: (event: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
    const raw = await this.files.readFile(EVENTS_PATH).catch(() => '');
    const events = raw.trim().split('\n').filter(Boolean).map((line): Record<string, unknown> => { try { return JSON.parse(line); } catch { return { raw: line }; } });
    return (keep ? events.filter(keep) : events).slice(-limit);
  }

  private async setStage(stage: LoopStage, patch: Partial<LoopState['current']> = {}): Promise<void> {
    const state = this.require();
    state.stage = stage;
    state.current = { ...state.current, ...patch, stageStartedAt: this.now(), baseCommit: await this.git?.head() };
    if (!SEARCH_STAGES.has(stage)) delete state.current.search;
    if (stage !== 'waiting') delete state.waitingOn;
    await this.takeSnapshot();
    await this.save();
    await this.event('stage', { stage, assetId: state.current.assetId, planId: state.current.planId });
  }

  // ---------- run control ----------

  async start(provider: AgentProvider, options: { goal?: string; sessionId?: string; force?: boolean } = {}): Promise<LoopState> {
    if (this.state && this.state.status === 'running' && !options.force) {
      // A new goal for a running loop is an extension, never a reason to refuse it.
      if (options.goal?.trim()) return this.extend(options.goal, { provider, sessionId: options.sessionId });
      throw new Error('A research loop is already running. Use resume, or stop it first.');
    }
    const state = newState(provider, this.id(), this.now(), this.iterationCap ?? (await this.loopSettings()).iterationCap);
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

  /**
   * Add a new goal. On an approved project this reopens project.md for new required results, keeping the existing ones;
   * on a project still under revision the goal is folded into the draft.
   */
  async extend(goal: string, options: { provider?: AgentProvider; sessionId?: string; force?: boolean } = {}): Promise<LoopState> {
    if (!goal.trim()) throw new Error('Describe the new goal to add.');
    const state = this.state;
    if (!state || state.status === 'stopped' || state.status === 'idle') {
      const started = await this.start(options.provider ?? state?.provider ?? 'claude', { goal, sessionId: options.sessionId, force: true });
      // An explicit extension of a project under revision drafts the goal in, rather than reviewing the old text.
      if (started.stage !== 'draft_project' && !(await this.isProjectApproved())) await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined });
      return started;
    }
    if (options.provider) state.provider = options.provider;
    if (options.sessionId && !this.heartbeat(options.sessionId, options.force)) throw new Error(`Another session (${state.lock?.sessionId}) is driving this loop. Pass --force to take over.`);
    if (state.status !== 'running') state.runningSince = this.now();
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
    await this.refreshRetired();
    await this.event('extended', { goal, baselineRequired: state.extension.baselineRequired });
  }

  /** Record which baseline results are retired, so the draft_project instruction stops asking to keep them. */
  private async refreshRetired(): Promise<void> {
    const extension = this.state?.extension;
    if (!extension || extension.projectApproved) return;
    const retired = await this.retiredBaseline();
    if (retired.length) extension.retired = retired; else delete extension.retired;
  }

  /** Baseline required results since deprecated or archived: the researcher retired them, so an extension may drop them. */
  private async retiredBaseline(): Promise<string[]> {
    const extension = this.state?.extension;
    if (!extension) return [];
    const assets = await this.collectKind('asset');
    return extension.baselineRequired.filter((id) => INACTIVE_STATUSES.has(assets.get(id)?.data.status));
  }

  /** While extending, project.md may only gain required results, apart from retired ones. */
  private async extensionProblems(project: string): Promise<string[]> {
    const extension = this.state?.extension;
    if (!extension || extension.projectApproved) return [];
    const required = requiredAssetIds(project);
    const retired = await this.retiredBaseline();
    const removed = extension.baselineRequired.filter((id) => !required.includes(id) && !retired.includes(id));
    const added = required.filter((id) => !extension.baselineRequired.includes(id));
    const problems: string[] = [];
    if (removed.length) problems.push(`project.md: keep the existing required results ${removed.join(', ')}; extending only adds results (deprecate an asset to retire it).`);
    if (!added.length) problems.push('project.md: add the new goal as a new asset ID under required_results.');
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
    if (state.status !== 'running') state.runningSince = this.now();
    state.status = 'running';
    state.lastError = null;
    // Resuming after an autonomous run handed back starts a new run with a fresh budget.
    if (state.autonomy?.handedOverAt) delete state.autonomy;
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

  /** Apply a changed iteration cap to the running loop too, not only to the next start. */
  async setIterationCap(cap: number): Promise<void> {
    if (!this.state || this.state.autopilot.iterationCap === cap) return;
    this.state.autopilot.iterationCap = cap;
    await this.save();
    await this.event('iteration_cap', { cap });
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
    const previous = file.records.find((entry) => entry.kind === kind && entry.target === target);
    file.records = file.records.filter((entry) => !(entry.kind === kind && entry.target === target));
    const provenance = await this.provenance();
    const record: ApprovalRecord = { kind, target, digest: approvalDigest(raw, kind), approvedAt: provenance.created_at, source, performed_by: provenance.performed_by };
    if (kind !== 'project') record.statement = statementDigest(raw);
    if (provenance.base_commit) record.base_commit = provenance.base_commit;
    if (provenance.extension_version) record.extension_version = provenance.extension_version;
    file.records.push(record);
    await this.writeApprovals(file);
    if (kind === 'project') await this.recordProjectRevision(raw, record, previous);
  }

  private async recordProjectRevision(project: string, record: ApprovalRecord, previous?: ApprovalRecord): Promise<void> {
    const written = await appendProjectRevision(this.files, this.paths.researchRoot, project, record, previous);
    if (!written) return;
    await this.refreshSnapshot([written]);
    await this.event('project_revision', { file: written });
  }

  /** Record digests for nodes that were approved before the loop existed, so validation does not revert them. */
  async adoptExistingApprovals(): Promise<string[]> {
    const file = await this.approvals();
    const adopted: string[] = [];
    for (const kind of ['asset', 'definition'] as const) {
      for (const filePath of await listNodeFiles(this.files, this.paths, kind)) {
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

  /**
   * Researcher approval. Only the extension (a human click, dashboard, or editor)
   * may call this, or auto mode the researcher turned on (source `auto`).
   */
  async approve(kind: 'project' | 'asset' | 'definition' | 'specification', target: string, source: string): Promise<void> {
    if (kind === 'project') {
      const raw = await this.files.readFile(this.paths.projectMd);
      if (!requiredAssetIds(raw).length) throw new Error('Add asset IDs to required_results in project.md before approving the project.');
      await this.record('project', 'project', raw, source);
    } else if (kind === 'specification') {
      // Approves what to search for; the asset stays draft until its construction and proof are approved.
      const raw = await this.files.readFile(`${this.paths.assets}/${target}.md`);
      if (!isConstructionSpec(raw)) throw new Error(`${target} is not a construction with a specification (- P1: ... in its statement).`);
      await this.record('specification', target, raw, source);
    } else {
      const file = await this.nodeFile(kind, target);
      const raw = await this.files.readFile(file);
      const parsed = parseMarkdown(raw);
      parsed.data.status = 'approved';
      const approved = stringifyMarkdown(parsed.content, parsed.data);
      await this.writeOwned(file, approved);
      await this.record(kind, target, approved, source);
    }
    if (this.state) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => kind === 'project' ? item.kind !== 'project'
        : !(item.target === target && (item.kind === kind || (kind === 'asset' && (item.kind === 'citation' || item.kind === 'counterexample')))));
      if (kind === 'asset') await this.clearPark(target, `approved (${source})`);
      await this.save();
    }
    if ((kind === 'asset' || kind === 'definition') && source !== 'auto') await this.clearHold(kind, target);
    await this.event('approved', { kind, target, source });
  }

  /** Record a researcher's approval made in the dashboard or editor (file already says approved). */
  async recordExisting(kind: 'asset' | 'definition', target: string, source: string): Promise<boolean> {
    const file = await this.nodeFile(kind, target);
    if (!(await this.files.exists(file))) return false;
    const raw = await this.files.readFile(file);
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return false; }
    if (data.status !== 'approved') return false;
    if (isApproved((await this.approvals()).records, kind, target, raw)) return false;
    await this.record(kind, target, raw, source);
    await this.refreshSnapshot([file]);
    await this.clearHold(kind, target);
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
      await this.abandonPlans(target, `Target ${target} was refuted by counterexample ${exampleId} and deprecated.`);
    }
    if (this.state) {
      await this.clearPark(target, `refuted by ${exampleId}`);
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => item.target !== exampleId);
      await this.save();
    }
    await this.event('refuted', { assetId: target, exampleId, source });
    return target;
  }

  /** Pending plans of a target that is no longer pursued become abandoned, with the reason as their Outcome. */
  private async abandonPlans(target: string, reason: string): Promise<string[]> {
    const abandoned: string[] = [];
    for (const plan of await this.plans()) {
      if (plan.data.type !== 'plan' || plan.data.target_asset !== target || plan.data.status !== 'pending') continue;
      const parsed = parseMarkdown(plan.raw);
      parsed.data.status = 'abandoned';
      await this.writeOwned(plan.file, stringifyMarkdown(`${parsed.content.trimEnd()}\n\n## Outcome\n\n${reason}\n`, parsed.data));
      abandoned.push(plan.id);
    }
    if (abandoned.length) await this.event('plans_abandoned', { target, plans: abandoned });
    return abandoned;
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
   * Revert approvals that no longer match their digest. When an approved
   * statement or definition changed, everything that rests on it, however
   * indirectly, either goes back to review (rigor "revert") or is marked for
   * re-check and kept from auto mode (rigor "flag").
   */
  async reconcile(changedId?: string, options: { dryRun?: boolean; details?: Array<{ id: string; reason: string }> } = {}): Promise<string[]> {
    const approvals = await this.approvals();
    const reverted: string[] = [];
    const nodes = new Map<string, { kind: 'asset' | 'definition'; file: string; raw: string; data: Record<string, any> }>();
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
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
      await this.addHold(node.kind, id, reason.split(':')[0]);
      await this.event('approval_invalidated', { id, reason });
    };
    /** Everything that rests on `id`: results through depends_on or uses_definitions, definitions through depends_on. */
    const downstream = (id: string): string[] => {
      const found = new Set<string>();
      const queue = [id];
      while (queue.length) {
        const current = queue.shift()!;
        for (const [otherId, other] of nodes) {
          if (found.has(otherId) || otherId === id) continue;
          const uses = [...(Array.isArray(other.data.depends_on) ? other.data.depends_on : []), ...(other.kind === 'asset' && Array.isArray(other.data.uses_definitions) ? other.data.uses_definitions : [])];
          if (uses.includes(current)) { found.add(otherId); queue.push(otherId); }
        }
      }
      return [...found];
    };
    /** Mark for re-check: an approved result, or a draft with a written proof, that rests on something changed. */
    const flag = async (id: string, because: string) => {
      const node = nodes.get(id);
      if (!node || !(node.data.status === 'approved' || (node.kind === 'asset' && proofText(parseMarkdown(node.raw).content)))) return;
      options.details?.push({ id, reason: `recheck:${because}` });
      if (options.dryRun) return;
      await this.addHold(node.kind, id, `recheck:${because}`);
      await this.event('recheck_flagged', { id, because });
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
        const policy = (await this.loopSettings()).rigor.onDependencyChange;
        for (const otherId of downstream(id)) {
          if (policy === 'revert') await revert(otherId, `dependency_changed:${id}`);
          else await flag(otherId, id);
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
      // Late answer to an expired question: keep it for the agent to pick up, and settle the question idea it left behind.
      state.answers.push({ questionId, decision, text, answeredAt: this.now(), source });
      if (decision === 'answer' && text.trim()) await this.resolveQuestionIdeas(questionId, text.trim());
      await this.save();
      await this.event('question_answered', { questionId, decision, hasText: Boolean(text.trim()), late: true });
      return;
    }
    state.pendingQuestion = undefined;
    state.answers.push({ questionId, decision, text, answeredAt: this.now(), source, consumed: true });
    await this.event('question_answered', { questionId, kind: question.kind, decision, hasText: Boolean(text.trim()) });
    const assetId = question.assetId;
    if (decision === 'answer' && text.trim()) state.researcherInput = { kind: question.kind, text: text.trim(), at: this.now() };
    if (decision === 'answer' && text.trim() && question.kind === 'discussion') {
      const decisionId = await this.writeDecision('answer', assetId ?? 'project', `${question.prompt}\n\n${text.trim()}`);
      await this.resolveQuestionIdeas(questionId, undefined, decisionId);
    }
    if (question.kind === 'goals') {
      if (decision === 'answer' && text.trim()) await this.setStage('draft_project');
      else if (projectSection(await this.files.readFile(this.paths.projectMd).catch(() => ''), 'Main Problem')) await this.setStage('draft_project');
      else await this.setStage('waiting');
    } else if (question.kind === 'blocked' && assetId) {
      if (decision === 'answer' && text.trim()) {
        state.progress[assetId] = { ...state.progress[assetId], changesRequested: undefined };
        // The decision record is the one home of a direction (plan packs read the latest one). It answers every failed plan so far; the shared record resets the failure count on every machine.
        const searchRound = await this.isConstructionSearch(assetId) ? (await this.searchProgressFor(assetId)).lastRound : undefined;
        await this.writeDecision('direction', assetId, text, { failedPlansAtDirection: await this.failedPlans(assetId), searchRound });
        delete state.parked[assetId];
        // A direction also restarts a construction search's round and candidate limits.
        if (await this.isConstructionSearch(assetId)) await this.setStage('select', { assetId: undefined });
        else await this.setStage('plan', { assetId, planId: undefined });
      } else {
        const construct = await this.isConstructionSearch(assetId);
        // With "retry", the agent gets one new approach of its own per stuck episode; a second time it is set aside.
        if ((await this.loopSettings()).rigor.whenStuck === 'retry' && latestDirection(await this.decisions(), assetId)?.reason !== 'agent_retry') {
          const searchRound = construct ? (await this.searchProgressFor(assetId)).lastRound : undefined;
          await this.writeDecision('direction', assetId, 'No direction from the researcher. Try one genuinely different approach of your own, unlike every failed one; if it fails too, the result is set aside.', { reason: 'agent_retry', failedPlansAtDirection: await this.failedPlans(assetId), searchRound });
          delete state.parked[assetId];
          await this.event('agent_retry', { assetId });
          if (construct) await this.setStage('select', { assetId: undefined });
          else await this.setStage('plan', { assetId, planId: undefined });
          return;
        }
        if (construct) await this.park(assetId, 'search_exhausted', 'no new direction from the researcher');
        else await this.park(assetId, 'three_failures', 'no new direction from the researcher');
        await this.setStage('select');
      }
    } else if (question.kind === 'counterexample_review') {
      if (decision === 'answer' && text.trim()) await this.saveIdea(`Counterexample review for ${assetId ?? 'project'}`, text, assetId ? [assetId] : [], 'researcher', [], 'observation');
      await this.save();
    } else {
      if (decision === 'skip' || !text.trim()) {
        await this.saveIdea(`Open question: ${question.prompt.slice(0, 60)}`, `${question.prompt}\n\nThe researcher did not answer; the agent proceeded with its stated default.`, assetId ? [assetId] : [], 'agent', ['open-question'], 'question', { question_id: questionId });
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

  /**
   * A question past its timeout resolves as unanswered when the researcher's
   * setting says the agent goes on with its default; with "wait" it stays open.
   * Returns whether it resolved one. Callers: next, report, and the extension's
   * health check, so a question the loop raised itself never hangs forever.
   */
  async resolveOverdueQuestion(now = Date.now()): Promise<boolean> {
    const question = this.state?.pendingQuestion;
    if (!question?.timeoutSec) return false;
    if ((await this.loopSettings()).rigor.unansweredQuestions !== 'default') return false;
    if (now - Date.parse(question.createdAt) < question.timeoutSec * 1000) return false;
    await this.event('question_expired', { questionId: question.id, kind: question.kind });
    await this.autoResolveQuestion(question.id);
    return true;
  }

  /** Auto-mode resolution when a timed question got no answer. */
  async autoResolveQuestion(questionId: string): Promise<void> {
    const state = this.require();
    const question = state.pendingQuestion;
    if (!question || question.id !== questionId) return;
    await this.answerQuestion(questionId, 'skip', '', 'timeout');
  }

  async enqueueApproval(kind: ApprovalKind, target: string, reason: string): Promise<ApprovalRequest> {
    // The project has one approval record, keyed `project`; agents may name it by its path.
    if (kind === 'project') target = 'project';
    const state = this.require();
    const raw = kind === 'project' ? await this.files.readFile(this.paths.projectMd).catch(() => '') : await this.files.readFile(await this.nodeFile(kind === 'definition' ? 'definition' : 'asset', target)).catch(() => '');
    const digest = raw ? approvalDigest(raw, kind === 'project' ? 'project' : kind === 'definition' ? 'definition' : kind === 'specification' ? 'specification' : 'asset') : '';
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
      await this.approveRequest(request, source);
      if (request.kind === 'project' && this.state?.stage === 'review_project') await this.setStage('select');
      // A researcher's approval can unblock auto approvals that waited on it (a dependency, say).
      await this.autoApproveQueued();
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

  private async approveRequest(request: ApprovalRequest, source: string): Promise<void> {
    if (request.kind === 'project') await this.approve('project', 'project', source);
    else if (request.kind === 'definition') await this.approve('definition', request.target, source);
    else if (request.kind === 'counterexample') await this.confirmCounterexample(request.target, source);
    else if (request.kind === 'specification') await this.approve('specification', request.target, source);
    else await this.approve('asset', request.target, source);
  }

  /**
   * Queue an approval for the researcher, or grant it when auto mode covers it.
   * Used by the MCP request_approval tool; an approval that is already current is not queued again.
   */
  async requestApproval(kind: ApprovalKind, target: string, reason: string): Promise<{ status: 'queued' | 'auto_approved' | 'already_approved'; request?: ApprovalRequest }> {
    if (await this.isCurrentlyApproved(kind, target)) return { status: 'already_approved' };
    const request = await this.enqueueApproval(kind, target, reason);
    await this.autoApproveQueued();
    return { status: this.require().approvalQueue.some((item) => item.id === request.id) ? 'queued' : 'auto_approved', request };
  }

  private async isCurrentlyApproved(kind: ApprovalKind, target: string): Promise<boolean> {
    if (kind === 'project') return this.isProjectApproved();
    if (kind === 'specification') {
      const raw = await this.files.readFile(`${this.paths.assets}/${target}.md`).catch(() => '');
      return Boolean(raw) && isApproved((await this.approvals()).records, 'specification', target, raw);
    }
    const recordKind = kind === 'definition' ? 'definition' : 'asset';
    const raw = await this.files.readFile(await this.nodeFile(recordKind, target)).catch(() => '');
    if (!raw) return false;
    try { if (parseMarkdown(raw).data.status !== 'approved') return false; } catch { return false; }
    return isApproved((await this.approvals()).records, recordKind, target, raw);
  }

  /**
   * Grant every queued request that auto mode covers, repeating while one
   * approval unblocks another (a dependency before its dependant). Returns
   * `kind:target` for each request granted.
   */
  async autoApproveQueued(): Promise<string[]> {
    if (!this.state?.approvalQueue.length) return [];
    const settings = await this.loopSettings();
    const policy = settings.autonomy.enabled ? AUTONOMOUS_AUTO_APPROVE : settings.autoApprove;
    if (!policy.enabled) return [];
    const granted: string[] = [];
    // Each request is granted at most once per call, so a queue that fails to shrink cannot loop forever.
    const done = new Set<string>();
    for (let progress = true; progress;) {
      progress = false;
      // Read the queue afresh: approving edits `this.state`, which a reload may have replaced since the call began.
      for (const request of [...this.require().approvalQueue]) {
        if (done.has(request.id) || !this.require().approvalQueue.some((item) => item.id === request.id)) continue;
        const rule = await this.autoRule(request, policy);
        if (!rule) continue;
        done.add(request.id);
        await this.approveRequest(request, 'auto');
        await this.event('auto_approved', { kind: request.kind, target: request.target, rule });
        granted.push(`${request.kind}:${request.target}`);
        progress = true;
      }
    }
    return granted;
  }

  /**
   * Which auto-mode rule grants this request, judged from the target file
   * itself (never from the kind the agent asked for); undefined leaves it to the researcher.
   */
  private async autoRule(request: ApprovalRequest, policy: AutoApprovePolicy): Promise<AutoApproveRule | undefined> {
    if (request.kind === 'project') {
      if (!policy.project) return undefined;
      const raw = await this.files.readFile(this.paths.projectMd).catch(() => '');
      return raw && researchDigest(raw, 'project') === request.digest && requiredAssetIds(raw).length && projectSection(raw, 'Main Problem') ? 'project' : undefined;
    }
    if (request.kind === 'specification') {
      if (!policy.specifications) return undefined;
      const raw = await this.files.readFile(`${this.paths.assets}/${request.target}.md`).catch(() => '');
      return raw && statementDigest(raw) === request.digest && isConstructionSpec(raw) ? 'specifications' : undefined;
    }
    const kind: ResultKind = request.kind === 'definition' ? 'definition' : 'asset';
    const file = await findNodeFile(this.files, this.paths, kind, request.target);
    if (!file) return undefined;
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw || researchDigest(raw, kind) !== request.digest) return undefined;
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = parseMarkdown(raw); } catch { return undefined; }
    const data = parsed.data;
    if (data.status !== 'draft') return undefined;
    const hold = (await this.holds())[`${kind}:${request.target}`];
    if (hold) {
      const note = ` (auto mode: needs your review — ${hold.reason.replace(/_/g, ' ')})`;
      const queued = this.state?.approvalQueue.find((item) => item.id === request.id);
      if (queued && !queued.reason.endsWith(note)) { queued.reason += note; await this.save(); }
      return undefined;
    }
    if (kind === 'definition') return policy.definitions ? 'definitions' : undefined;
    if (data.type === 'example' && typeof data.refutes === 'string') {
      if (request.kind !== 'counterexample' || !policy.counterexamples) return undefined;
      const verdict = sectionContent(parsed.content, 'Verdict');
      return /confirm/i.test(verdict) && !/reject/i.test(verdict) ? 'counterexamples' : undefined;
    }
    if (request.kind === 'counterexample') return undefined;
    if (locateNodeFile(file, this.paths)?.origin === 'library') return policy.citations ? 'citations' : undefined;
    if (isCited(data.source)) {
      const source = data.source as { paper_id?: unknown; location?: unknown };
      const indexed = typeof source.paper_id === 'string' && (await this.paperIds()).has(source.paper_id);
      return policy.citations && indexed && typeof source.location === 'string' && source.location.trim() ? 'citations' : undefined;
    }
    // A citation request for a result that cites nothing is not a citation.
    if (request.kind === 'citation') return undefined;
    if (!PROVABLE_TYPES.has(data.type)) return policy.supporting ? 'supporting' : undefined;
    return policy.proofs && (await this.proofIsVouched(request.target, raw, parsed)) ? 'proofs' : undefined;
  }

  /**
   * A proof qualifies for auto approval only when a succeeded plan produced
   * exactly this proof of exactly this statement, over dependencies whose
   * statements have not changed since, and every dependency is approved; and,
   * per the researcher's setting, an independent verification confirmed it
   * (or never, when the researcher verifies every proof).
   */
  private async proofIsVouched(assetId: string, raw: string, parsed: matter.GrayMatterFile<string>): Promise<boolean> {
    if (!proofText(parsed.content) || this.state?.progress[assetId]?.changesRequested) return false;
    const { verifyProofs } = (await this.loopSettings()).rigor;
    if (verifyProofs === 'researcher') return false;
    const dependencies = await this.dependencyDigests(parsed.data);
    if (!dependencies) return false;
    const proof = proofDigest(raw);
    const vouched = (await this.vouchingPlans(assetId, raw)).some((plan) => sameDigests(plan.data.dependency_digests, dependencies)
      && (verifyProofs !== 'agent' || plan.data.verified_proof_digest === proof));
    if (!vouched) return false;
    const records = (await this.approvals()).records;
    for (const dep of Array.isArray(parsed.data.depends_on) ? parsed.data.depends_on as string[] : []) {
      const depRaw = await this.files.readFile(await this.nodeFile('asset', dep)).catch(() => '');
      if (!depRaw || !isApproved(records, 'asset', dep, depRaw)) return false;
    }
    return true;
  }

  /** Statement digests of an asset's dependencies and definitions; undefined when one is missing. */
  private async dependencyDigests(data: Record<string, any>): Promise<Record<string, string> | undefined> {
    const digests: Record<string, string> = {};
    const refs: Array<[ResultKind, unknown]> = [
      ...(Array.isArray(data.depends_on) ? data.depends_on : []).map((id: unknown) => ['asset', id] as [ResultKind, unknown]),
      ...(Array.isArray(data.uses_definitions) ? data.uses_definitions : []).map((id: unknown) => ['definition', id] as [ResultKind, unknown]),
    ];
    for (const [kind, id] of refs) {
      const file = await findNodeFile(this.files, this.paths, kind, String(id));
      const raw = file ? await this.files.readFile(file).catch(() => '') : '';
      if (!raw) return undefined;
      digests[String(id)] = statementDigest(raw);
    }
    return digests;
  }

  // ---------- auto-mode holds ----------

  private async holds(): Promise<Record<string, { reason: string; at: string }>> {
    try { return JSON.parse(await this.files.readFile(AUTO_HOLDS_PATH)) as Record<string, { reason: string; at: string }>; } catch { return {}; }
  }

  /** Keep auto mode off a result whose approval was revoked by a change; only the researcher lifts it. */
  private async addHold(kind: 'asset' | 'definition', target: string, reason: string): Promise<void> {
    const holds = await this.holds();
    holds[`${kind}:${target}`] = { reason, at: this.now() };
    await this.files.writeFile(AUTO_HOLDS_PATH, JSON.stringify(holds, null, 2) + '\n');
  }

  /** Results marked for re-check because something they rest on changed: node ID → the changed node's ID. */
  async recheckFlags(): Promise<Record<string, string>> {
    const flags: Record<string, string> = {};
    for (const [key, hold] of Object.entries(await this.holds())) if (hold.reason.startsWith('recheck:')) flags[key.slice(key.indexOf(':') + 1)] = hold.reason.slice('recheck:'.length);
    return flags;
  }

  /** The researcher read a flagged result again and it still holds. */
  async confirmRecheck(id: string): Promise<void> {
    const holds = await this.holds();
    const key = Object.keys(holds).find((entry) => entry.endsWith(`:${id}`) && holds[entry].reason.startsWith('recheck:'));
    if (!key) return;
    delete holds[key];
    await this.files.writeFile(AUTO_HOLDS_PATH, JSON.stringify(holds, null, 2) + '\n');
    await this.event('recheck_cleared', { id });
  }

  private async clearHold(kind: 'asset' | 'definition', target: string): Promise<void> {
    const holds = await this.holds();
    if (!holds[`${kind}:${target}`]) return;
    delete holds[`${kind}:${target}`];
    await this.files.writeFile(AUTO_HOLDS_PATH, JSON.stringify(holds, null, 2) + '\n');
  }

  async park(assetId: string, reason: string, note?: string): Promise<void> {
    const state = this.require();
    state.parked[assetId] = { reason, at: this.now(), note };
    if (state.autonomy?.deciding === assetId) delete state.autonomy.deciding;
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

  private async writeDecision(kind: DecisionKind, target: string, text: string, extra: DecisionExtra = {}): Promise<string> {
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

  // ---------- object search ----------

  private async searchRecords(): Promise<{ candidates: CandidateInfo[]; rounds: RoundInfo[] }> {
    const candidates = [...(await this.collect(this.shared.candidates)).values()].map(parseCandidate).filter((item): item is CandidateInfo => Boolean(item));
    const rounds = [...(await this.collect(this.shared.checks)).values()].map(parseRound).filter((item): item is RoundInfo => Boolean(item));
    return { candidates, rounds };
  }

  /** The shared search records on an asset's current statement. */
  async searchProgressFor(assetId: string): Promise<SearchProgress> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
    const { candidates, rounds } = await this.searchRecords();
    return searchProgress(assetId, statementDigest(raw), candidates, rounds);
  }

  private searchLimits(mode: SearchMode, settings: LoopSettings): { width: number; rounds: number } {
    return mode === 'refute' ? { width: settings.refuteWidth, rounds: settings.refuteRounds } : { width: settings.constructWidth, rounds: settings.constructRounds };
  }

  /** A draft construction that lists its required properties and has no construction yet: it is searched for, not falsified. */
  private async isConstructionSearch(assetId: string): Promise<boolean> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
    return Boolean(raw) && isConstructionSpec(raw);
  }

  /** Rounds and candidates of a construction search since the researcher's last direction, which the limits count. */
  private async constructionUsage(assetId: string): Promise<{ rounds: number; candidates: number }> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
    const { candidates, rounds } = await this.searchRecords();
    const recent = searchProgress(assetId, statementDigest(raw), candidates, rounds, latestDirection(await this.decisions(), assetId)?.searchRound ?? 0);
    return { rounds: new Set([...recent.rounds.map((item) => item.round), ...recent.candidates.map((item) => item.round)]).size, candidates: recent.candidates.length };
  }

  /** The next round of a search: its number and each worker slot's direction; undefined when the limits are used up. */
  private async nextSearchRound(assetId: string, mode: SearchMode): Promise<SearchRound | undefined> {
    const settings = await this.loopSettings();
    const limits = this.searchLimits(mode, settings);
    const progress = await this.searchProgressFor(assetId);
    const round = progress.lastRound + 1;
    const requested = mode === 'refute' ? await this.searchRequest(assetId) : undefined;
    if (mode === 'refute' && !requested && round > limits.rounds) return undefined;
    if (mode === 'construct') {
      const used = await this.constructionUsage(assetId);
      if (used.rounds >= ((await this.allotment(assetId)) ?? limits.rounds) || used.candidates >= settings.constructMaxCandidates) return undefined;
    }
    const ideas = [...(await this.collect(this.paths.ideas)).values()]
      .filter((idea) => idea.data.idea_kind === 'test_case' && idea.data.status === 'draft' && Array.isArray(idea.data.related_assets) && idea.data.related_assets.includes(assetId))
      .map((idea) => ({ id: idea.id, title: String(idea.data.title ?? idea.id) }));
    const slots = assignDirections({ mode, round, width: limits.width, tried: progress.directionsTried, ideas, specialFromRound: settings.specialDirectionsFromRound, nearMiss: progress.nearMisses[0]?.id });
    if (mode === 'refute') return { mode, round, slots, ...(requested ? { requested: true } : {}) };
    return { mode, round, slots, properties: specProperties(statementPart(parseMarkdown(await this.files.readFile(`${this.paths.assets}/${assetId}.md`)).content)) };
  }

  /** The researcher's latest request for more counterexample search on an asset, while it still has rounds left. */
  private async searchRequest(assetId: string, decisions?: DecisionInfo[]): Promise<{ remaining: number } | undefined> {
    const request = sortDecisions(decisions ?? await this.decisions()).filter((item) => item.kind === 'search_request' && item.target === assetId).pop();
    if (!request) return undefined;
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
    if (!raw) return undefined;
    const { candidates, rounds } = await this.searchRecords();
    const recent = searchProgress(assetId, statementDigest(raw), candidates, rounds, request.searchRound ?? 0);
    const used = new Set([...recent.rounds.map((item) => item.round), ...recent.candidates.map((item) => item.round)]).size;
    const remaining = (request.rounds ?? 1) - used;
    return remaining > 0 ? { remaining } : undefined;
  }

  /**
   * The researcher asks for a deeper counterexample search on an asset, even one already checked.
   * Never automatic: the agent runs this only when the researcher asks. Returns the message for the agent.
   */
  async requestSearch(assetId: string, rounds?: number): Promise<string> {
    const file = `${this.paths.assets}/${assetId}.md`;
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw) throw new Error(`Unknown asset ${assetId}.`);
    const data = parseMarkdown(raw).data;
    if (data.status !== 'draft' || !PROVABLE_TYPES.has(data.type)) throw new Error(`${assetId} is not a draft theorem, lemma, proposition, or construction; there is nothing to refute.`);
    if (isConstructionSpec(raw)) throw new Error(`${assetId} is a construction search; give it a new direction instead (answer its blocked question, or ask the researcher for one).`);
    const field = LOOP_NUMBER_FIELDS.requestedSearchRounds;
    const count = rounds ?? (await this.loopSettings()).requestedSearchRounds;
    if (!Number.isInteger(count) || count < field.range[0] || count > field.range[1]) throw new Error(`--rounds must be a whole number from ${field.range[0]} to ${field.range[1]}.`);
    await this.writeDecision('search_request', assetId, `Search ${count} more round(s) for a counterexample to ${assetId}.`, { rounds: count, searchRound: (await this.searchProgressFor(assetId)).lastRound });
    if (this.state) {
      if (this.state.parked[assetId]) await this.clearPark(assetId, 'counterexample search requested');
      // A plan not yet written gives way at once; a plan being executed finishes first.
      if (this.state.current.assetId === assetId && this.state.stage === 'plan') await this.setStage('select', { assetId: undefined });
      await this.save();
    }
    await this.event('search_requested', { assetId, rounds: count });
    return `Requested ${count} more round(s) of counterexample search for ${assetId}; it starts at the next selection. Run: ${LOOP_COMMAND} next`;
  }

  /** A construction search used its limits: ask the researcher for a direction; silence parks the asset. */
  private async exhaustConstructionSearch(assetId: string): Promise<string> {
    const used = await this.constructionUsage(assetId);
    const observations = [...(await this.collect(this.paths.ideas)).values()].filter((idea) => idea.data.status === 'draft' && idea.data.idea_kind === 'observation' && Array.isArray(idea.data.related_assets) && idea.data.related_assets.includes(assetId)).map((idea) => idea.id);
    await this.setStage('select', { assetId });
    if (await this.autonomy()) {
      await this.event('search_finished', { assetId, mode: 'construct', ...used });
      return this.decideStuck(assetId, `The construction search for ${assetId} used ${used.rounds} round(s) and ${used.candidates} candidate(s) since the last direction without an object that passes every property.`);
    }
    await this.askQuestion('blocked', `The construction search for ${assetId} used ${used.rounds} round(s) and ${used.candidates} candidate(s) since the last direction without an object that passes every property${observations.length ? `; see the observations ${observations.join(', ')}` : ''}. Give a new direction (or relax the specification under a new asset ID), or skip to park it.`, { assetId, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
    await this.event('search_finished', { assetId, mode: 'construct', ...used });
    return `The construction search for ${assetId} is exhausted. Ask the researcher with ask_researcher(kind: "blocked"); if nobody answers, the loop acts on the researcher's setting (sets it aside, or records one new approach for you); do not park it yourself.`;
  }

  /** The search board workers read: obstructions, near-misses, and directions tried on the current statement. */
  async searchBoard(assetId: string, mode?: SearchMode, round?: number): Promise<string> {
    const settings = await this.loopSettings();
    const progress = await this.searchProgressFor(assetId);
    const searchMode = mode ?? this.state?.current.search?.mode ?? ((await this.isConstructionSearch(assetId)) ? 'construct' : 'refute');
    const properties = searchMode === 'construct' ? specProperties(statementPart(parseMarkdown(await this.files.readFile(`${this.paths.assets}/${assetId}.md`)).content)) : undefined;
    return renderBoard(progress, { mode: searchMode, target: assetId, round: round ?? progress.lastRound + 1, obstructions: settings.boardObstructions, nearMisses: settings.boardNearMisses, properties });
  }

  /** End a refute search that found nothing: the loop writes the falsification check from the search records. */
  private async finishRefuteSearch(assetId: string): Promise<void> {
    const progress = await this.searchProgressFor(assetId);
    const cases = progress.candidates.map((item) => `- Round ${item.round ?? '?'}, ${item.direction ?? 'unknown direction'}: ${item.id} ${item.status === 'archived' ? 'rejected by independent verification' : 'failed'}${item.failure ? ` — ${item.failure}` : ''}`);
    for (const round of progress.rounds) for (const direction of round.directions) {
      if (!progress.candidates.some((item) => item.round === round.round && item.direction === direction)) cases.push(`- Round ${round.round}, ${direction}: no plausible candidate.`);
    }
    cases.push(...progress.obstructions.map((item) => `- Obstruction: ${item}`));
    const limitations = `${progress.limitations || 'No limitations were recorded.'}\n\nObject search: ${progress.candidates.length} candidate(s) in ${progress.lastRound} round(s).`;
    await this.writeCheck(assetId, 'no_counterexample_found', cases.join('\n') || '- No candidate was proposed.', limitations);
    await this.event('search_finished', { assetId, mode: 'refute', rounds: progress.lastRound, candidates: progress.candidates.length });
  }

  /** Copy a refute survivor into a draft counterexample (an example with refutes), the form verification and the researcher confirm. */
  private async promoteCounterexample(candidate: CandidateInfo, assetId: string): Promise<string> {
    const parsed = parseMarkdown(await this.files.readFile(candidate.file));
    const checks = checkSections(parsed.content);
    const hypotheses = Object.keys(candidate.checks).filter((name) => name !== NEGATED_CONCLUSION);
    const target = parseMarkdown(await this.files.readFile(`${this.paths.assets}/${assetId}.md`)).data;
    const base = `cx_${candidate.id.replace(/^cand_/, '')}`;
    let id = base;
    for (let index = 2; await this.files.exists(`${this.paths.assets}/${id}.md`); index++) id = `${base}_${index}`;
    const body = [
      '', '## Statement', '', candidate.object, '',
      '## Assumptions', '', hypotheses.map((name) => `### ${name}\n\n${checks[name] || '(see the candidate)'}`).join('\n\n') || '(no hypotheses listed)', '',
      '## Calculation', '', checks[NEGATED_CONCLUSION] || '(see the candidate)', '',
      `Promoted from search candidate ${candidate.id}.`, '',
    ].join('\n');
    await this.writeOwned(`${this.paths.assets}/${id}.md`, stringifyMarkdown(body, {
      type: 'example', title: `Counterexample to ${assetId}: ${String(parsed.data.title ?? candidate.id)}`, status: 'draft', source: { kind: 'original' },
      refutes: assetId, depends_on: [], uses_definitions: Array.isArray(target.uses_definitions) ? target.uses_definitions : [], tags: [],
    }));
    await this.event('search_survivor', { assetId, candidateId: candidate.id, exampleId: id });
    return id;
  }

  /** Write the verified construction and its per-property proof into the asset; its specification (the statement) stays as approved. */
  private async recordConstruction(assetId: string, candidate: CandidateInfo, verdict: string): Promise<void> {
    const file = `${this.paths.assets}/${assetId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    const proof = verdict.replace(/^\s*(confirmed|rejected)\b[.:]?\s*/i, '').trim() || verdict.trim();
    const content = `${parsed.content.trimEnd()}\n\n## Construction\n\n${candidate.object.trim()}\n\n## Proof\n\n${proof}\n\nFound by search candidate ${candidate.id} (round ${candidate.round ?? '?'}) and verified independently.\n`;
    await this.writeOwned(file, stringifyMarkdown(content, parsed.data));
    await this.event('construction_found', { assetId, candidateId: candidate.id });
  }

  /** Independent verification rejected a survivor: it stays on the board as a near-miss. */
  private async archiveCandidate(candidateId: string, reason: string): Promise<void> {
    const file = `${this.shared.candidates}/${candidateId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    parsed.data.status = 'archived';
    const content = sectionContent(parsed.content, 'Failure') ? parsed.content : `${parsed.content.trimEnd()}\n\n## Failure\n\nRejected by independent verification: ${reason.replace(/\s+/g, ' ').trim()}\n`;
    await this.writeOwned(file, stringifyMarkdown(content, parsed.data));
  }

  /** After a round's candidates are recorded: verify a survivor, summarize the round, run the next one, or end the search. */
  private async afterSearchRound(assetId: string, finish: Finish): Promise<{ stage: LoopStage; message: string }> {
    const search = this.require().current.search!;
    const progress = await this.searchProgressFor(assetId);
    const survivor = progress.survivors.find((item) => item.round === search.round);
    if (survivor && search.mode === 'refute') {
      const exampleId = await this.promoteCounterexample(survivor, assetId);
      return finish(`Candidate ${survivor.id} passed its own checks and was copied to ${exampleId}. Next: verify it independently.`, 'verify_counterexample', { counterexampleId: exampleId, search: { ...search, candidateId: survivor.id } });
    }
    if (survivor) return finish(`Candidate ${survivor.id} passed its own checks. Next: verify it independently.`, 'verify_construction', { search: { ...search, candidateId: survivor.id } });
    if (!progress.rounds.some((item) => item.round === search.round)) {
      return finish(`Round ${search.round} recorded. Next: summarize it.`, 'search_summary', { counterexampleId: undefined, search: { ...search, candidateId: undefined } });
    }
    const next = await this.nextSearchRound(assetId, search.mode);
    if (next) return finish(`Round ${search.round} found nothing. Next: round ${next.round}.`, 'search', { counterexampleId: undefined, search: next });
    if (search.mode === 'construct') {
      const result = await finish(`Round ${search.round} found nothing.`, 'select', { counterexampleId: undefined });
      return { stage: this.require().stage, message: `${result.message} ${await this.exhaustConstructionSearch(assetId)}` };
    }
    await this.finishRefuteSearch(assetId);
    return finish(`No counterexample found for ${assetId} in ${search.round} round(s). Next: plan.`, 'plan', { counterexampleId: undefined, planId: await this.pendingPlan(assetId) });
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

  // ---------- library ----------

  /** Library results matching the words, best first (no words: all of them), each with whether its approval is current. */
  async librarySearch(query: string, options: { type?: string; collection?: string; limit?: number; unapproved?: boolean } = {}): Promise<Array<LibraryHit & { approved: boolean }>> {
    const nodes = [...(await this.collectKind('asset')).values(), ...(await this.collectKind('definition')).values()];
    const records = (await this.approvals()).records;
    const raw = new Map(nodes.map((node) => [node.id, node.raw]));
    const hits = searchLibrary(nodes, this.paths, query, { ...options, limit: options.unapproved ? Number.MAX_SAFE_INTEGER : options.limit })
      .map((hit) => ({ ...hit, approved: hit.status === 'approved' && isApproved(records, hit.kind, hit.id, raw.get(hit.id)!) }));
    return (options.unapproved ? hits.filter((hit) => !hit.approved) : hits).slice(0, options.limit ?? (options.unapproved ? Number.MAX_SAFE_INTEGER : 20));
  }

  /**
   * Copy a library result into the project as a draft that records where it
   * came from, so it can be changed or generalized; the library copy stays as it is.
   */
  async promote(libraryId: string, newId?: string): Promise<string> {
    const assetFile = await findNodeFile(this.files, this.paths, 'asset', libraryId);
    const file = assetFile ?? await findNodeFile(this.files, this.paths, 'definition', libraryId);
    if (!file || locateNodeFile(file, this.paths)?.origin !== 'library') throw new Error(`No library result named ${libraryId}.`);
    const kind: ResultKind = assetFile ? 'asset' : 'definition';
    const id = newId ?? libraryId.slice(LIBRARY_PREFIX.length);
    if (!/^[a-z][a-z0-9_]*$/.test(id) || isLibraryId(id)) throw new Error(`Invalid project ID ${id}: use lowercase letters, digits, and underscores, without the ${LIBRARY_PREFIX} prefix.`);
    if (await findNodeFile(this.files, this.paths, 'asset', id) || await findNodeFile(this.files, this.paths, 'definition', id)) throw new Error(`Node ID already exists: ${id}`);
    const target = `${kind === 'asset' ? this.paths.assets : this.paths.definitions}/${id}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    parsed.data.status = 'draft';
    parsed.data.derived_from = libraryId;
    // Relative links in the body were written for the library folder; re-point them from the new one.
    const body = parsed.content.replace(/\]\((?!https?:|#|\/)([^)\s]+\.md)\)/g, (_match, link: string) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
      const relative = path.posix.relative(path.posix.dirname(target), resolved);
      return `](${relative.startsWith('.') ? relative : `./${relative}`})`;
    });
    await this.files.writeFile(target, stringifyMarkdown(body, parsed.data));
    await this.event('library_promoted', { libraryId, id, kind });
    return target;
  }

  // ---------- ideas ----------

  async saveIdea(title: string, body: string, relatedAssets: string[], origin: 'researcher' | 'agent' = 'researcher', tags: string[] = [], ideaKind: IdeaKind = 'approach', extra: Record<string, string> = {}): Promise<string> {
    if (!body.trim()) throw new Error('Idea text is required.');
    const assetIds = new Set((await this.files.listFiles(this.paths.assets)).map((file) => path.posix.basename(file, '.md')));
    for (const asset of relatedAssets) if (!assetIds.has(asset)) throw new Error(`Unknown related asset: ${asset}`);
    const ideaId = `idea_${this.id().replace(/-/g, '').slice(0, 12)}`;
    const raw = stringifyMarkdown(`\n${body.trim()}\n`, { type: 'idea', title: title.trim() || 'Untitled idea', status: 'draft', idea_kind: ideaKind, origin, related_assets: relatedAssets, tags, ...extra });
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
    await this.resolveIdea(ideaId, planId);
    if (this.state?.parked[assetId]) { await this.clearPark(assetId, `new plan ${planId} from idea ${ideaId}`); await this.save(); }
    await this.event('idea_converted', { ideaId, planId, assetId });
    return planId;
  }

  /** Mark an idea resolved by a decision, plan, or asset; the idea itself is kept. */
  async resolveIdea(ideaId: string, resolvedBy: string, note?: string): Promise<void> {
    const file = `${this.paths.ideas}/${ideaId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    if (parsed.data.type !== 'idea') throw new Error(`${ideaId} is not an idea.`);
    if (parsed.data.status === 'resolved' && parsed.data.resolved_by === resolvedBy) return;
    parsed.data.status = 'resolved';
    parsed.data.resolved_by = resolvedBy;
    const content = note ? `${parsed.content.trimEnd()}\n\n## Resolution\n\n${note}\n` : parsed.content;
    await this.files.writeFile(file, stringifyMarkdown(content, parsed.data));
    await this.event('idea_resolved', { ideaId, resolvedBy });
  }

  /** Question ideas left by an unanswered question, resolved once the researcher answers it. */
  private async resolveQuestionIdeas(questionId: string, lateAnswer?: string, decisionId?: string): Promise<void> {
    for (const file of await this.files.listFiles(this.paths.ideas)) {
      let data: Record<string, any>;
      try { data = parseMarkdown(await this.files.readFile(file)).data; } catch { continue; }
      if (data.question_id !== questionId || data.status !== 'draft') continue;
      const id = path.posix.basename(file, '.md');
      const by = decisionId ?? await this.writeDecision('answer', Array.isArray(data.related_assets) && data.related_assets[0] ? String(data.related_assets[0]) : 'project', `${String(data.title ?? '')}\n\n${lateAnswer ?? ''}`);
      await this.resolveIdea(id, by, lateAnswer ? `Answered by the researcher: ${lateAnswer}` : undefined);
    }
  }

  // ---------- selection ----------

  private async collect(folder: string): Promise<Map<string, AssetInfo>> {
    const nodes = new Map<string, AssetInfo>();
    for (const file of await this.files.listFiles(folder)) {
      const raw = await this.files.readFile(file);
      const location = locateNodeFile(file, this.paths);
      const library = location?.origin === 'library' ? { origin: 'library' as const, collection: location.collection } : {};
      try { const parsed = parseMarkdown(raw); nodes.set(path.posix.basename(file, '.md'), { id: path.posix.basename(file, '.md'), file, raw, data: parsed.data, body: parsed.content, ...library }); } catch { /* skip unparsable */ }
    }
    return nodes;
  }

  /** Project and library nodes of one kind, keyed by ID; a project node wins over a library node with the same ID. */
  private async collectKind(kind: ResultKind): Promise<Map<string, AssetInfo>> {
    const nodes = new Map<string, AssetInfo>();
    for (const folder of await nodeFolders(this.files, this.paths, kind)) for (const [id, node] of await this.collect(folder)) if (!nodes.has(id)) nodes.set(id, node);
    return nodes;
  }

  /** The file of an asset or definition, in the project or the library; the project path when it does not exist yet. */
  private async nodeFile(kind: ResultKind, id: string): Promise<string> {
    return (await findNodeFile(this.files, this.paths, kind, id)) ?? `${kind === 'asset' ? this.paths.assets : this.paths.definitions}/${id}.md`;
  }

  private async plans(): Promise<AssetInfo[]> { return [...(await this.collect(this.paths.plans)).values()]; }

  private async failedPlans(assetId: string): Promise<string[]> {
    return (await this.plans()).filter((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'failed').map((plan) => plan.id);
  }

  /** The succeeded plans that produced exactly this proof of exactly this statement. */
  private async vouchingPlans(assetId: string, raw: string): Promise<AssetInfo[]> {
    const proof = proofDigest(raw);
    const statement = statementDigest(raw);
    return (await this.plans()).filter((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'succeeded'
      && plan.data.proof_digest === proof && plan.data.statement_digest === statement);
  }

  /** The plan whose proof still awaits the independent check: one produced the current proof, and no verification has confirmed it. */
  private async unverifiedPlan(assetId: string, raw: string): Promise<string | undefined> {
    const plans = await this.vouchingPlans(assetId, raw);
    return plans.some((plan) => plan.data.verified_proof_digest === proofDigest(raw)) ? undefined : plans[0]?.id;
  }

  /** Independent verification found a gap: the plan fails, pointing at its verdict, and the proof leaves the asset. */
  private async rejectProof(assetId: string, planId: string): Promise<void> {
    const planFile = `${this.paths.plans}/${planId}.md`;
    const plan = parseMarkdown(await this.files.readFile(planFile));
    plan.data.status = 'failed';
    delete plan.data.verified_proof_digest;
    const content = sectionContent(plan.content, 'Failure') ? plan.content : `${plan.content.trimEnd()}\n\n## Failure\n\nIndependent verification rejected the proof; ## Verdict names the step that fails.\n`;
    await this.writeOwned(planFile, stringifyMarkdown(content, plan.data));
    const assetFile = `${this.paths.assets}/${assetId}.md`;
    const asset = parseMarkdown(await this.files.readFile(assetFile));
    const body = asset.content.replace(/^## Proof[ \t]*\r?\n[\s\S]*?(?=^## |^<!-- research-assistant:|(?![\s\S]))/m, '').trimEnd() + '\n';
    await this.writeOwned(assetFile, stringifyMarkdown(body, asset.data));
    await this.event('proof_rejected', { assetId, planId });
  }

  /** After a plan failed (or its proof was rejected): another plan, or, past the asset's limit, a direction from the researcher or the agent's own decision. */
  private async afterFailedPlan(assetId: string, planId: string, what: string, finish: Finish, autonomous: boolean): Promise<{ stage: LoopStage; message: string }> {
    const failures = await this.failuresSinceDirection(assetId);
    const limit = (await this.allotment(assetId)) ?? (await this.loopSettings()).maxFailedPlans;
    if (failures >= limit) {
      await this.setStage('plan', { planId: undefined });
      if (autonomous) return { stage: 'plan', message: await this.decideStuck(assetId, `${failures} approaches failed for ${assetId} since the last direction (its allotment was ${limit}).`) };
      await this.askQuestion('blocked', `${assetId} has ${failures} documented failed approaches since the last direction. Give a new direction, or skip to park it and move on.`, { assetId, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
      return { stage: 'plan', message: `${failures} approaches failed for ${assetId} (limit ${limit}). Ask the researcher with ask_researcher(kind: "blocked"); if nobody answers, the loop acts on the researcher's setting (sets it aside, or records one new approach for you); do not park it yourself.` };
    }
    return finish(`${what} (${failures}/${limit}). Next: a different plan.`, 'plan', { planId: await this.pendingPlan(assetId) });
  }

  private async pendingPlan(assetId: string): Promise<string | undefined> {
    return (await this.plans()).find((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'pending')?.id;
  }

  /** Select the next stage; auto approvals granted on the way are followed by a fresh selection over the updated files. */
  private async computeSelection(): Promise<Selection> {
    let selection = await this.selectOnce();
    for (let pass = 0; pass < MAX_AUTO_PASSES; pass++) {
      if (!(await this.autoApproveQueued()).length) return selection;
      selection = await this.selectOnce();
    }
    await this.event('auto_pass_limit', { stage: selection.stage });
    return selection;
  }

  private async selectOnce(): Promise<Selection> {
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
    const assets = await this.collectKind('asset');
    const definitions = await this.collectKind('definition');
    const inactive = required.filter((id) => ['deprecated', 'archived'].includes(assets.get(id)?.data.status));
    if (inactive.length) {
      state.researcherInput = { kind: 'project', text: `Required result(s) ${inactive.join(', ')} were deprecated or archived. Revise the goals and required results; give a revised statement a new asset ID.`, at: this.now() };
      return { stage: 'draft_project', note: state.researcherInput.text };
    }
    const { order, missing, cycle } = assetClosure(required, assets);
    if (cycle) return { stage: 'waiting', reason: `Dependency cycle at ${cycle}; fix depends_on before continuing.`, waitingOn: [{ kind: 'cycle', target: cycle }] };
    if (missing.length) return { stage: 'scaffold', missing, incomplete: [] };
    const incomplete = order.filter((id) => !assets.get(id)!.origin && assets.get(id)!.data.status === 'draft' && PROVABLE_TYPES.has(assets.get(id)!.data.type) && statementIncomplete(assets.get(id)!.body));
    if (incomplete.length) return { stage: 'scaffold', missing: [], incomplete };
    const rigor = (await this.loopSettings()).rigor;
    // A definition used but missing: the agent drafts it in scaffold (it never accepts it); with "wait", the results using it hold until the researcher agrees.
    const undrafted = definitionClosure(order, assets, definitions).filter((id) => !definitions.has(id));
    if (undrafted.length) {
      if (rigor.missingDefinitions === 'wait') state.awaitingDefinitions = [...new Set([...(state.awaitingDefinitions ?? []), ...undrafted])];
      return { stage: 'scaffold', missing: [], incomplete: [], missingDefinitions: undrafted };
    }
    const definitionAgreed = (id: string) => { const definition = definitions.get(id); return Boolean(definition && definition.data.status === 'approved' && isApproved(approvals, 'definition', id, definition.raw)); };
    if (rigor.agreeDefinitions === 'main') {
      // The definitions main results' statements use decide what the goals mean: agree on them before any proof work.
      const toAgree = definitionClosure(required.filter((id) => assets.has(id)), assets, definitions).filter((id) => definitions.has(id) && !definitionAgreed(id));
      for (const id of toAgree) await this.enqueueApproval('definition', id, 'A main result’s statement uses it: agree on it before the proofs start.');
      if (toAgree.length) return { stage: 'waiting', reason: `Definitions to agree on before proving: ${toAgree.join(', ')}`, waitingOn: toAgree.map((id): WaitingReason => ({ kind: 'approval', target: id, detail: 'definition' })) };
    }
    state.awaitingDefinitions = (state.awaitingDefinitions ?? []).filter((id) => !definitions.has(id) || (!definitionAgreed(id) && !['deprecated', 'archived'].includes(definitions.get(id)!.data.status)));
    if (!state.awaitingDefinitions.length) delete state.awaitingDefinitions;
    const awaiting = (state.awaitingDefinitions ?? []).filter((id) => definitions.has(id));
    for (const id of awaiting) await this.enqueueApproval('definition', id, 'Drafted to fill a missing definition: agree on it before the results that use it go on.');
    const waitsOnDefinition = (assetId: string) => awaiting.length > 0 && definitionClosure([assetId], assets, definitions).some((id) => awaiting.includes(id));
    const examples = [...assets.values()].filter((asset) => asset.data.type === 'example' && typeof asset.data.refutes === 'string');
    const checks = await this.checks();
    const decisions = await this.decisions();
    const settled = new Set<string>();
    let candidate: { stage: 'plan'; assetId: string } | { stage: 'search'; assetId: string; mode: SearchMode } | { stage: 'verify_proof'; assetId: string; planId: string } | undefined;
    for (const id of order) {
      const asset = assets.get(id)!;
      const verified = asset.data.status === 'approved' && isApproved(approvals, 'asset', id, asset.raw);
      if (verified) { settled.add(id); continue; }
      if (asset.data.status === 'approved') {
        // Approved without a matching record: the researcher must re-approve.
        const parsed = parseMarkdown(asset.raw); parsed.data.status = 'draft';
        await this.files.writeFile(asset.file, stringifyMarkdown(parsed.content, parsed.data));
        await this.addHold('asset', id, 'approved_without_record');
        await this.event('approval_invalidated', { id, reason: 'no_record' });
        asset.data.status = 'draft';
      }
      if (asset.origin === 'library') {
        // A known result: approved once by the researcher, never falsified or proved by the loop.
        const cited = isCited(asset.data.source);
        await this.enqueueApproval(cited ? 'citation' : 'asset', id, `Library result${asset.collection ? ` (${asset.collection})` : ''}${cited ? ` citing ${asset.data.source.kind} ${asset.data.source.paper_id} (${asset.data.source.location ?? 'location missing'})` : ''}: approve once to use it as known.`);
        settled.add(id); continue;
      }
      if (isCited(asset.data.source)) {
        await this.enqueueApproval('citation', id, `Check the cited ${asset.data.source.kind} ${asset.data.source.paper_id} (${asset.data.source.location ?? 'location missing'}) against the statement.`);
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
        // A proof the loop wrote is checked independently before it goes to approval, when the researcher asked for that.
        const unverified = rigor.verifyProofs === 'agent' ? await this.unverifiedPlan(id, asset.raw) : undefined;
        if (unverified) { if (!candidate) candidate = { stage: 'verify_proof', assetId: id, planId: unverified }; continue; }
        await this.enqueueApproval('asset', id, 'Proof is written; review and approve or request changes.');
        settled.add(id); continue;
      }
      const deps = Array.isArray(asset.data.depends_on) ? asset.data.depends_on as string[] : [];
      if (!deps.every((dep) => settled.has(dep))) continue;
      if (waitsOnDefinition(id)) continue;
      if (isConstructionSpec(asset.raw)) {
        // What to search for is the researcher's call: no search tokens before the specification is approved.
        if (!isApproved(approvals, 'specification', id, asset.raw)) await this.enqueueApproval('specification', id, 'Approve the required properties (P1, P2, …) before the construction search starts.');
        else if (!candidate) candidate = { stage: 'search', assetId: id, mode: 'construct' };
        continue;
      }
      if (!candidate) {
        // The researcher's setting may skip the counterexample search (for every result, or for all but the main ones); a requested search always runs.
        const skipSearch = rigor.refuteSearch === 'off' || (rigor.refuteSearch === 'main' && !required.includes(id));
        const requested = await this.searchRequest(id, decisions);
        candidate = (this.isFalsified(id, asset.raw, checks) || skipSearch) && !requested ? { stage: 'plan', assetId: id } : { stage: 'search', assetId: id, mode: 'refute' };
      }
    }
    if (candidate) return candidate;
    const definitionIds = definitionClosure(order, assets, definitions);
    const unapproved = definitionIds.filter((id) => !(definitions.get(id)?.data.status === 'approved' && isApproved(approvals, 'definition', id, definitions.get(id)!.raw)));
    for (const id of unapproved) if (definitions.has(id)) await this.enqueueApproval('definition', id, 'Definition used by an approved or proved result.');
    const allApproved = order.every((id) => settled.has(id) && assets.get(id)!.data.status === 'approved');
    if (allApproved && !unapproved.length && !order.some((id) => state.parked[id]) && !examples.some((example) => example.data.status === 'draft' && order.includes(example.data.refutes))) {
      if (state.extension) {
        const baseline = new Set(assetClosure(state.extension.baselineRequired, assets).order);
        state.extension.newResults = order.filter((id) => !baseline.has(id));
      }
      return { stage: 'ready' };
    }
    const reasons = [
      state.approvalQueue.length ? `${state.approvalQueue.length} approval request(s) waiting: ${state.approvalQueue.map((item) => `${item.kind} ${item.target}`).join(', ')}` : '',
      Object.keys(state.parked).length ? `parked: ${Object.entries(state.parked).map(([id, info]) => `${id} (${info.reason})`).join(', ')}` : '',
      unapproved.filter((id) => !definitions.has(id)).length ? `missing definitions: ${unapproved.filter((id) => !definitions.has(id)).join(', ')}` : '',
    ].filter(Boolean);
    const missingDefinitions = unapproved.filter((id) => !definitions.has(id));
    const waitingOn: WaitingReason[] = [
      ...state.approvalQueue.map((item): WaitingReason => ({ kind: 'approval', target: item.target, detail: item.kind })),
      ...Object.entries(state.parked).map(([id, info]): WaitingReason => ({ kind: 'parked', target: id, detail: info.reason })),
      ...missingDefinitions.map((id): WaitingReason => ({ kind: 'missing_definition', target: id, detail: order.find((asset) => (assets.get(asset)?.data.uses_definitions ?? []).includes(id)) })),
    ];
    return { stage: 'waiting', reason: reasons.join('; ') || 'nothing actionable', waitingOn };
  }

  /** Compute or confirm the current stage and return the instruction for the agent. */
  async next(): Promise<NextResult> {
    const state = this.require();
    if (state.status !== 'running') return this.result(`The loop is ${state.status}. Run: ${LOOP_COMMAND} resume`);
    await this.resolveOverdueQuestion();
    const run = await this.autonomy();
    if (run) {
      const question = state.pendingQuestion;
      if (question) {
        // Asked before autonomous mode was turned on: settle it the autonomous way.
        state.pendingQuestion = undefined;
        await this.event('question_expired', { questionId: question.id, kind: question.kind });
        await this.decideAlone(question.kind, question.prompt, question.assetId);
        if (state.status !== 'running') return this.result(state.lastError ?? undefined);
      }
      const over = this.autonomyOver(run, await this.loopSettings());
      if (over) return this.result(await this.handOver(over));
      if (run.deciding && (state.parked[run.deciding] || !(await this.isDraftResult(run.deciding)))) { delete run.deciding; await this.save(); }
      if (run.deciding) return this.result(await this.decisionInstruction(run.deciding));
    }
    if (state.pendingQuestion) return this.result(`Question ${state.pendingQuestion.id} (${state.pendingQuestion.kind}) is waiting for the researcher: ${state.pendingQuestion.prompt}`);
    await this.refreshRetired();
    const perAsset = ['search', 'search_summary', 'verify_counterexample', 'verify_construction', 'plan', 'execute', 'verify_proof'].includes(state.stage);
    // `falsify` is the stage name older loop versions saved; selection now runs an object search instead.
    let recompute = ['select', 'waiting', 'ready', 'review_project', 'discuss_goals', 'falsify'].includes(state.stage);
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
      if (selection.stage === 'verify_proof') patch.planId = selection.planId;
      if (selection.stage === 'search') {
        const search = await this.nextSearchRound(selection.assetId, selection.mode);
        if (!search) {
          if (selection.mode === 'construct') {
            const message = await this.exhaustConstructionSearch(selection.assetId);
            return this.result(message);
          }
          // The records already hold every allowed round (the limit was lowered, or an earlier run stopped before the check).
          await this.finishRefuteSearch(selection.assetId);
          return this.next();
        }
        patch.search = search;
      }
      await this.setStage(selection.stage, patch);
      if (selection.stage === 'scaffold') state.scaffoldBrief = { missing: selection.missing, incomplete: selection.incomplete, ...(selection.missingDefinitions?.length ? { missingDefinitions: selection.missingDefinitions } : {}) };
      if (selection.stage === 'waiting') { state.lastError = selection.reason; state.waitingOn = selection.waitingOn; }
      if (selection.stage === 'waiting' || selection.stage === 'ready') await this.save();
      if (selection.stage === 'waiting' && run && !(await this.reviseGoals(run))) return this.result(await this.handOver(`nothing is left that it can do on its own (${selection.reason})`));
    }
    const result = this.result();
    if (state.stage === 'ready') {
      const manuscript = await this.manuscriptStatus();
      if (manuscript) result.instruction += `\n${manuscript}`;
    }
    if (!hasContextPack(state.stage)) return result;
    const pack = await this.contextPack();
    result.brief.context = { file: CONTEXT_PACK_PATH, tokens: pack.tokens, items: pack.included.map((item) => `${item.id}${Array.isArray(item.view) ? `#${item.view.join(',')}` : item.view === 'all' ? '' : `#${item.view}`}`), omitted: pack.omitted.map((item) => item.id), ...(pack.packs ? { packs: pack.packs } : {}) };
    if (pack.manifest.worker) result.brief.worker = pack.manifest.worker;
    if (pack.packs) {
      result.instruction += `\nWorker packs (research-worker-${pack.manifest.worker ?? 'deep'}, one per slot; give each worker only its own pack and do not read them yourself): ${pack.packs.map((item) => `slot ${item.slot}: ${item.file} (~${item.tokens} tokens)`).join('; ')}.`;
      return result;
    }
    result.instruction += `\nContext pack (~${pack.tokens} tokens): ${CONTEXT_PACK_PATH}. Read it instead of the research folders; for anything else run ${LOOP_COMMAND} show <id> [--section Heading] and say why.${pack.manifest.worker ? ` Subagent: research-worker-${pack.manifest.worker}.` : ''}`;
    return result;
  }

  /**
   * The manuscript's freshness against the research, a second status beside the loop stage:
   * research can be ready while the manuscript is uncovered or stale. Undefined before an outline exists.
   */
  async manuscriptStatus(): Promise<string | undefined> {
    let impact;
    try { impact = await loadManuscriptImpact(this.files, this.paths); } catch (error) { return `Manuscript: unreadable (${error instanceof Error ? error.message : String(error)})`; }
    if (!impact) return undefined;
    if (impact.state === 'current') return renderImpact(impact).split('\n')[0];
    return `${renderImpact(impact)}\nUpdate only these sections: plan-manuscript for uncovered results, draft-latex for stale ones (${MANUSCRIPT_COMMAND} prepare <section> lists only what changed). After the researcher reviews a section, they lock it with ${MANUSCRIPT_COMMAND} lock <section> --apply.`;
  }

  // ---------- context packs ----------

  private async contextSources(): Promise<ContextSources> {
    const events = await this.recentEvents(400);
    return {
      project: await this.files.readFile(this.paths.projectMd).catch(() => ''), projectFile: this.paths.projectMd,
      paperIndex: await this.files.readFile(this.paths.paperIndex).catch(() => ''), paperIndexFile: this.paths.paperIndex,
      assets: await this.collectKind('asset'), definitions: await this.collectKind('definition'),
      plans: await this.collect(this.paths.plans), ideas: await this.collect(this.paths.ideas), checks: await this.collect(this.shared.checks), candidates: await this.collect(this.shared.candidates),
      reports: events.filter((event) => event.type === 'report').map((event) => event as ContextSources['reports'][number]),
    };
  }

  /**
   * Compile the current stage's context pack, write it (and its manifest) to
   * the loop folder, and return it. Deterministic: same files, same pack.
   */
  async contextPack(budget?: number): Promise<RenderedContext & { manifest: ContextManifest; packs?: Array<{ slot: number; direction: string; file: string; tokens: number }> }> {
    const state = this.require();
    const sources = await this.contextSources();
    const assetId = state.current.assetId;
    const limit = budget ?? (await this.contextBudget(state.stage));
    const focus = {
      // verify_construction checks a search candidate, named like the candidate a counterexample check reads.
      stage: state.stage, assetId, planId: state.current.planId, counterexampleId: state.stage === 'verify_construction' ? state.current.search?.candidateId : state.current.counterexampleId,
      missing: state.scaffoldBrief?.missing, incomplete: state.scaffoldBrief?.incomplete, researcherInput: state.researcherInput?.text,
      changesRequested: assetId ? state.progress[assetId]?.changesRequested : undefined,
      ...(assetId ? directionFocus(latestDirection(await this.decisions(), assetId)) : {}),
    };
    const search = assetId && (state.stage === 'search' || state.stage === 'search_summary') ? state.current.search : undefined;
    const writeManifest = (rendered: RenderedContext, manifest: ContextManifest, extra: Record<string, unknown> = {}) => this.files.writeFile(CONTEXT_MANIFEST_PATH, JSON.stringify({ stage: state.stage, assetId, stageStartedAt: state.current.stageStartedAt, tokens: rendered.tokens, budget: manifest.budget, worker: manifest.worker, files: rendered.files, omitted: rendered.omitted.map((item) => item.id), ...extra }, null, 2) + '\n');
    if (search && assetId) {
      const board = await this.searchBoard(assetId, search.mode, search.round);
      if (state.stage === 'search_summary') {
        const progress = await this.searchProgressFor(assetId);
        const manifest = planContext({ ...focus, search: { mode: search.mode, round: search.round, board, roundDigest: roundDigest(progress.candidates.filter((item) => item.round === search.round)) } }, sources, limit);
        const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
        await this.files.writeFile(CONTEXT_PACK_PATH, rendered.text);
        await writeManifest(rendered, manifest);
        return { ...rendered, manifest };
      }
      // One pack per worker slot; the stage pack only lists them, so the driver never reads the workers' material.
      const packs: Array<{ slot: number; direction: string; file: string; tokens: number }> = [];
      const files = new Set<string>();
      let first: (RenderedContext & { manifest: ContextManifest }) | undefined;
      for (const slot of search.slots) {
        const manifest = planContext({ ...focus, search: { mode: search.mode, round: search.round, slot, board, requested: search.requested } }, sources, limit);
        const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
        const file = searchPackPath(slot.slot);
        await this.files.writeFile(file, rendered.text);
        packs.push({ slot: slot.slot, direction: slot.direction, file, tokens: rendered.tokens });
        for (const item of rendered.files) files.add(item);
        first ??= { ...rendered, manifest };
      }
      if (this.files.deleteFile) for (const file of await this.files.listFiles(`${STATE_DIR}/context`, '.md')) {
        const slot = /search-(\d+)\.md$/.exec(file);
        if (slot && Number(slot[1]) > search.slots.length) await this.files.deleteFile(file);
      }
      const index = [`# Search round ${search.round} (${search.mode}) for ${assetId}`, '', 'One pack per worker slot; each worker reads only its own.', '', ...packs.map((item) => `- slot ${item.slot} (${item.direction}): ${item.file} (~${item.tokens} tokens)`), ''].join('\n');
      await this.files.writeFile(CONTEXT_PACK_PATH, index);
      const rendered = { ...first!, text: index, files: [...files], tokens: packs.reduce((sum, item) => sum + item.tokens, 0) };
      await writeManifest(rendered, first!.manifest, { packs });
      return { ...rendered, packs };
    }
    const manifest = planContext(focus, sources, limit);
    const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
    await this.files.writeFile(CONTEXT_PACK_PATH, rendered.text);
    await writeManifest(rendered, manifest);
    return { ...rendered, manifest };
  }

  private async contextBudget(stage: LoopStage): Promise<number> {
    const configured: Partial<Record<string, number>> = this.contextBudgets ?? normalizeContextBudgets((await this.projectConfig()).contextBudgets) ?? {};
    // A budget set for the old falsify stage still applies to the search that replaced it.
    if (stage === 'search' && configured.search === undefined && configured.falsify !== undefined) return configured.falsify;
    return { ...DEFAULT_CONTEXT_BUDGETS, ...configured }[stage] ?? 8000;
  }

  /** One node (or paper transcription) on request, optionally only some sections; recorded so packs can be tuned. */
  async show(id: string, sections: string[] = [], full = false): Promise<string> {
    if (id === 'project') {
      const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
      await this.event('context_request', { id, sections, stage: this.state?.stage });
      return sections.length ? sections.map((heading) => `## ${heading}\n\n${projectPart(project, heading)}`).join('\n\n') : project;
    }
    const files: Array<[string, string | undefined]> = [
      ['asset', await findNodeFile(this.files, this.paths, 'asset', id)], ['definition', await findNodeFile(this.files, this.paths, 'definition', id)],
      ['plan', `${this.paths.plans}/${id}.md`], ['idea', `${this.paths.ideas}/${id}.md`], ['check', `${this.shared.checks}/${id}.md`], ['candidate', `${this.shared.candidates}/${id}.md`],
    ];
    for (const [kind, file] of files) {
      if (!file) continue;
      const raw = await this.files.readFile(file).catch(() => undefined);
      if (raw === undefined) continue;
      const parsed = parseMarkdown(raw);
      await this.event('context_request', { id, kind, sections, stage: this.state?.stage });
      const shown = renderShow({ id, file, raw, data: parsed.data, body: parsed.content }, sections, kind);
      return kind === 'asset' && !sections.length ? `${shown}\n\n${await this.derivedForAsset(id, raw)}` : shown;
    }
    const paper = `${this.paths.papers}/${id}/paper.md`;
    const raw = await this.files.readFile(paper).catch(() => undefined);
    if (raw !== undefined) {
      await this.event('context_request', { id, kind: 'paper', sections, full, stage: this.state?.stage });
      if (full) return raw;
      let parsed: { data: Record<string, any>; content: string } = { data: {}, content: raw };
      try { parsed = parseMarkdown(raw); } catch { /* transcription without frontmatter */ }
      return renderShow({ id, file: paper, raw, data: parsed.data, body: parsed.content }, sections, 'paper');
    }
    throw new Error(`No node or paper named ${id}.`);
  }

  /** How this stage used context: pack size, explicit requests, and research files read outside the pack. */
  async contextAudit(): Promise<{ tokens?: number; budget?: number; requests: string[]; outside: string[] }> {
    const state = this.state;
    const manifest = JSON.parse(await this.files.readFile(CONTEXT_MANIFEST_PATH).catch(() => '{}')) as { tokens?: number; budget?: number; stageStartedAt?: string };
    if (!state || manifest.stageStartedAt !== state.current.stageStartedAt) return { requests: [], outside: [] };
    const since = state.current.stageStartedAt;
    const events = (await this.recentEvents(400)).filter((event) => String(event.at ?? '') >= since);
    const requests = events.filter((event) => event.type === 'context_request').map((event) => `${String(event.id)}${Array.isArray(event.sections) && event.sections.length ? `#${(event.sections as string[]).join(',')}` : ''}`);
    const outside = [...new Set(events.filter((event) => event.type === 'context_outside_read').map((event) => String(event.file)))];
    return { tokens: manifest.tokens, budget: manifest.budget, requests, outside };
  }

  /** Record a research file the agent read outside the current pack (audit only; nothing is blocked). */
  async noteRead(file: string, tool: string): Promise<boolean> {
    const state = this.state;
    if (!state || state.status !== 'running' || !hasContextPack(state.stage)) return false;
    const manifest = JSON.parse(await this.files.readFile(CONTEXT_MANIFEST_PATH).catch(() => '{}')) as { files?: string[]; stageStartedAt?: string };
    if (manifest.stageStartedAt !== state.current.stageStartedAt || !manifest.files) return false;
    if (manifest.files.includes(file)) return false;
    // Files the agent wrote this stage are its own work, not extra context.
    const snapshot = JSON.parse(await this.files.readFile(SNAPSHOT_PATH).catch(() => '{}')) as Record<string, string>;
    const raw = await this.files.readFile(file).catch(() => undefined);
    const isFolder = raw === undefined;
    if (!isFolder && snapshot[file] !== crypto.createHash('sha256').update(raw).digest('hex')) return false;
    await this.event('context_outside_read', { file, tool, stage: state.stage, assetId: state.current.assetId });
    return true;
  }

  private result(blocked?: string): NextResult {
    const state = this.require();
    const brief: Record<string, unknown> = {
      stage: state.stage, assetId: state.current.assetId, planId: state.current.planId, counterexampleId: state.current.counterexampleId, search: state.current.search,
      researcherInput: state.researcherInput?.text, changesRequested: state.current.assetId ? state.progress[state.current.assetId]?.changesRequested : undefined,
      parked: state.parked, approvalQueue: state.approvalQueue.map((item) => `${item.kind}:${item.target}`), scaffold: state.scaffoldBrief, extension: state.extension, autonomy: state.autonomy,
      paths: { project: this.paths.projectMd, assets: this.paths.assets, definitions: this.paths.definitions, ideas: this.paths.ideas, plans: this.paths.plans, checks: this.shared.checks, candidates: this.shared.candidates, papers: this.paths.paperIndex, bibliography: this.paths.bibliography },
    };
    const autonomous = state.status === 'running' && state.autonomy && !state.autonomy.handedOverAt ? `\n${this.autonomyNote(state.autonomy)}` : '';
    return { stage: state.stage, instruction: (blocked ?? this.instruction(state)) + autonomous, brief, blocked };
  }

  private extensionInstruction(extension: LoopExtension): string {
    const retired = extension.retired ?? [];
    const kept = extension.baselineRequired.filter((id) => !retired.includes(id));
    const keep = kept.length ? `keep every existing required_results entry (${kept.join(', ')}) and leave approved statements unchanged` : 'leave approved statements unchanged';
    const replace = retired.length ? ` The required result(s) ${retired.join(', ')} were deprecated or archived: drop them from required_results, and give any revised statement a new asset ID.` : '';
    return ` This extends an approved project: ${keep}; add the new goal as new asset ID(s) and update ## Intended Contribution.${replace}`;
  }

  instruction(state: LoopState): string {
    const asset = state.current.assetId ?? '(none)';
    const input = state.researcherInput ? `\nResearcher input: ${state.researcherInput.text}` : '';
    const report = (outcomes: string) => `\nWhen done run: ${LOOP_COMMAND} report <${outcomes}> --summary "<= 5 lines"`;
    switch (state.stage) {
      case 'discuss_goals':
        return `Stage discuss_goals. Ask the researcher for the research goal, the main claim, and constraints with ask_researcher(kind: "goals"). If they answer, the loop moves to draft_project automatically. Without the MCP tool, ask in chat and record the answer with: ${LOOP_COMMAND} question answer --text "..." (or report complete --summary "<their goal>").${input}`;
      case 'draft_project':
        return `Stage draft_project. Draft or revise ${this.paths.projectMd} only. Keep its frontmatter \`type: project\` and list every result the project must establish under \`required_results\` (one entry per stable snake_case asset ID: \`- id: main_theorem\` with \`role: ...\`). Fill ## Main Problem, ## Scope and Assumptions (including scope decisions), ## Intended Contribution, and ## Background. Record open questions as ideas (record_idea with kind question), not in project.md; do not list known results or writing status: the dashboard derives them. Do not claim approval.${state.extension && !state.extension.projectApproved ? this.extensionInstruction(state.extension) : ''}${input}${report('complete|question')}`;
      case 'review_project':
        return `Stage review_project. Call request_approval(kind: "project", target: "project", summary: "<what changed>") so the researcher can approve project.md. Do not edit files. Then run: ${LOOP_COMMAND} next`;
      case 'scaffold': {
        const brief = state.scaffoldBrief;
        if (brief?.missingDefinitions?.length && !brief.missing?.length && !brief.incomplete?.length) {
          return `Stage scaffold. These definitions are used but have no file: ${brief.missingDefinitions.join(', ')}. Draft each in ${this.paths.definitions}/<id>.md with type: definition, a title "Definition (concept)", status: draft, source (original, or paper/textbook with paper_id and location when the meaning is taken from a source), depends_on for the definitions it uses, and the defining statement with its notation. Read the results that use it so the definition says what they need; search the library first (${LOOP_COMMAND} library search <words>) and, if a lib_ definition means the same, point the users at it instead of drafting. Do not modify existing assets or definitions; never approve a definition. Run research-maintenance validate and links.${input}${report('complete|question')}`;
        }
        return `Stage scaffold. Create missing draft assets in ${this.paths.assets}/ for ${brief?.missing?.length ? `missing IDs: ${brief.missing.join(', ')}` : 'every required result and dependency'}${brief?.incomplete?.length ? `; complete the statements of: ${brief.incomplete.join(', ')}` : ''}. Each needs type, title, status: draft, source.kind original (or paper/textbook with paper_id and location when genuinely cited), depends_on, uses_definitions, and a precise ## Statement. A construction the loop should search for lists its required properties in the statement, one per line as \`- P1: ...\`, \`- P2: ...\` (the researcher approves them before the search); a construction of a given object states the object. Create draft definitions in ${this.paths.definitions}/ as needed. Before creating a dependency or definition, search the library of known results (${LOOP_COMMAND} library search <words>) and reference a matching lib_ ID in depends_on/uses_definitions instead of re-creating it. Do not modify existing assets or definitions. Use the extract-research-nodes skill, then run research-maintenance validate and links.${input}${report('complete|question')}`;
      }
      case 'sources':
        return `Stage sources. Find results from indexed papers (or a verifiable new paper) that the required results can use; import-math-paper and extract-research-nodes cover transcription and extraction. For a new paper append a ## slug section with a stable DOI/arXiv/publisher URL to ${this.paths.paperIndex} and a matching BibTeX entry to ${this.paths.bibliography}; never change existing entries. Create only draft, paper-sourced assets (paper_id and exact location) and draft definitions. If a source cannot be verified, do not cite it: ask the researcher or record an idea. Return none when nothing verifiable exists.${report('complete|none|question')}`;
      case 'search': {
        const search = state.current.search;
        if (!search) return `Run: ${LOOP_COMMAND} next`;
        const perWorker = (this.lastSettings ?? DEFAULT_LOOP_SETTINGS).candidatesPerWorker;
        const single = search.slots.length === 1;
        const checks = search.mode === 'refute' ? `H1, H2, … (one per hypothesis) and ${NEGATED_CONCLUSION} (the conclusion fails)` : `${(search.properties ?? []).join(', ')} (every property of the specification)`;
        return `Stage search (${search.mode}) for asset ${asset}, round ${search.round}. Use the search-object skill. ${single ? 'Run one subagent' : `Run ${search.slots.length} subagents in parallel, all in one message`}, one per slot, each given only its own pack: ${search.slots.map((slot) => `slot ${slot.slot} (${slot.direction})`).join(', ')}. Each worker writes at most ${perWorker} new candidate file(s) ${this.shared.candidates}/cand_${asset}_r${search.round}_s<slot>_<slug>.md (type candidate, title, status failed|survived, target_asset ${asset}, checks {${checks}: pass|fail|unknown}, ## Object, ## Checks with one ### per check, ## Failure naming the first failing check) and stops checking a candidate at its first failing check.${single ? ` The worker also writes the round record ${this.shared.checks}/search_${asset}_r${search.round}_<slug>.md (type search_round, title, target_asset ${asset}, ## Obstructions, ## Limitations).` : ''} Finding no plausible candidate is a valid result: write none. Never write assets or change existing files. A failed proof idea is not a candidate.${input}${report('searched')}`;
      }
      case 'verify_construction': {
        const candidateId = state.current.search?.candidateId ?? '(none)';
        return `Stage verify_construction for ${candidateId} (a construction for ${asset}). Use the search-object skill (Verify a construction). Independently check that the object in ## Object has every property ${(state.current.search?.properties ?? []).join(', ')}, from the specification, not from the candidate's own checks. Add ## Verdict to ${this.shared.candidates}/${candidateId}.md: first line confirmed or rejected, then one ### <property> per property with the complete argument (it becomes the proof). Change nothing else; never edit ${asset}.${report('confirmed|rejected|question')}`;
      }
      case 'search_summary': {
        const round = state.current.search?.round ?? 1;
        return `Stage search_summary for asset ${asset}, round ${round}. Use the search-object skill (Summarize). Write one round record ${this.shared.checks}/search_${asset}_r${round}_<slug>.md (type search_round, title, target_asset ${asset}, ## Obstructions with one line per reason a family of candidates fails, ## Limitations naming what no worker covered). Record an obstruction that reads like a proof step with record_idea (kind approach). Change nothing else.${report('summarized')}`;
      }
      case 'verify_counterexample':
        return `Stage verify_counterexample for ${state.current.counterexampleId} (refutes ${asset}). Independently recheck every hypothesis and calculation; write ## Verdict in the example. confirmed: leave it draft (the researcher will confirm). rejected: set the example status to archived. Never edit ${asset}.${report('confirmed|rejected|question')}`;
      case 'plan': {
        const requested = state.current.assetId ? state.progress[state.current.assetId]?.changesRequested : undefined;
        return `Stage plan for asset ${asset}. Use the plan-proof skill. ${state.current.planId ? `Execute the existing pending plan ${state.current.planId} instead of writing a new one: report complete --plan ${state.current.planId}.` : `First check the pack's library analogues: a known result proving a version of this statement can be adapted (list it under adapts) instead of proving from scratch. Write one new pending plan in ${this.paths.plans}/ (Goal with the target link, Plan checklist, Verification, Assumed definitions; with an adapted result also ## Adapted from; with failed plans present also ## Difference from failed plans, one bullet per failed plan ID).`}${requested ? `\nThe researcher requested changes: ${requested}` : ''}${input}${report('complete --plan <id>|question')}`;
      }
      case 'execute':
        return `Stage execute plan ${state.current.planId} for asset ${asset}. Use the execute-proof skill. Follow the checklist; tick boxes only for established steps. A result the plan adapts comes with its proof in the pack: follow it and check each changed step, rather than proving the step anew. Success: write the complete proof under ## Proof in the asset (statement unchanged, status draft), then set the plan status succeeded and add ## Outcome. Obstruction: set the plan status failed with ## Failure. Never set status approved.${report('proved|failed|question')}`;
      case 'verify_proof':
        return `Stage verify_proof for asset ${asset} (plan ${state.current.planId}). Use the verify-proof skill. Check the ## Proof in the pack against the statement, step by step, as a referee would: every step follows, every hypothesis of a cited result holds, nothing is assumed that the statement does not give. Do not read the plan's reasoning. Add ## Verdict to ${this.paths.plans}/${state.current.planId}.md: first line confirmed or rejected; for rejected, name the first step that fails and why. Change nothing else; never edit ${asset}.${report('confirmed|rejected|question')}`;
      case 'waiting':
        return `Stage waiting. ${state.lastError ?? 'Nothing is actionable.'} Tell the researcher what needs their decision, then stop; the loop resumes when they act.`;
      case 'ready':
        if (state.extension?.newResults?.length) return `Stage ready. Every required result and dependency is approved, including the new result(s) ${state.extension.newResults.join(', ')}. If a manuscript already exists, use the plan-manuscript skill to place only these into the existing outline (new or adjusted section briefs), then redraft only the affected sections; keep the other briefs and TeX files. Otherwise tell the researcher the project is ready for the plan-manuscript skill.`;
        return `Stage ready. Every required result and dependency is approved. Tell the researcher the project is ready for the plan-manuscript skill. To add a new result later, run: ${LOOP_COMMAND} extend --goal "..."`;
      default:
        return `Run: ${LOOP_COMMAND} next`;
    }
  }

  /** Plans, ideas, and counterexamples that point at an asset; derived on request, never stored in the asset. */
  private async derivedForAsset(assetId: string, raw: string): Promise<string> {
    const current = proofDigest(raw);
    const plans = (await this.plans()).filter((plan) => plan.data.target_asset === assetId)
      .map((plan) => `${plan.id} (${String(plan.data.status)}${plan.data.status === 'succeeded' && typeof plan.data.proof_digest === 'string' && plan.data.proof_digest !== current ? ', outdated: the proof changed since' : ''})`);
    const ideas = [...(await this.collect(this.paths.ideas)).values()].filter((idea) => Array.isArray(idea.data.related_assets) && idea.data.related_assets.includes(assetId)).map((idea) => `${idea.id} (${String(idea.data.idea_kind ?? 'approach')}, ${String(idea.data.status)})`);
    const refutedBy = [...(await this.collect(this.paths.assets)).values()].filter((node) => node.data.refutes === assetId).map((node) => `${node.id} (${String(node.data.status)})`);
    const line = (label: string, items: string[]) => `- ${label}: ${items.length ? items.join(', ') : 'none'}`;
    return ['### Derived relations (not stored in the file)', line('Plans', plans), line('Ideas', ideas), line('Refuted by', refutedBy)].join('\n');
  }

  // ---------- report and validation ----------

  private async takeSnapshot(): Promise<void> {
    await this.files.writeFile(SNAPSHOT_PATH, JSON.stringify(await this.fingerprints(), null, 0) + '\n');
  }

  private async fingerprints(): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    const add = async (file: string) => { const raw = await this.files.readFile(file).catch(() => undefined); if (raw !== undefined) map[file] = crypto.createHash('sha256').update(raw).digest('hex'); };
    const shared = this.shared;
    for (const folder of [this.paths.assets, this.paths.definitions, this.paths.ideas, this.paths.plans, shared.checks, shared.candidates, shared.decisions, shared.handoffs, ...await libraryFolders(this.files, this.paths)]) for (const file of await this.files.listFiles(folder)) await add(file);
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

  private folders() { return { assets: this.paths.assets, definitions: this.paths.definitions, ideas: this.paths.ideas, plans: this.paths.plans, library: this.paths.library, checks: this.shared.checks, candidates: this.shared.candidates, decisions: this.shared.decisions, handoffs: this.shared.handoffs }; }

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
    const search = state.current.search;
    if (stage === 'verify_counterexample') allowedFolders.add(folders.assets);
    if (stage === 'search') { allowedFolders.add(folders.candidates); if (search?.slots.length === 1) allowedFolders.add(folders.checks); }
    if (stage === 'search_summary') allowedFolders.add(folders.checks);
    if (stage === 'verify_construction') allowedFolders.add(folders.candidates);
    if (stage === 'plan' || stage === 'execute' || stage === 'verify_proof') allowedFolders.add(folders.plans);
    if (stage === 'execute') allowedFolders.add(folders.assets);
    const allowedFiles = new Set<string>();
    if (stage === 'draft_project') allowedFiles.add(this.paths.projectMd);
    if (stage === 'sources') { allowedFiles.add(this.paths.paperIndex); allowedFiles.add(this.paths.bibliography); }
    const paperIds = await this.paperIds();
    const knownAssets = new Set((await listNodeFiles(this.files, this.paths, 'asset')).map((file) => path.posix.basename(file, '.md')));
    const knownDefinitions = new Set((await listNodeFiles(this.files, this.paths, 'definition')).map((file) => path.posix.basename(file, '.md')));
    for (const file of [...added, ...modified]) {
      if (isApprovalPath(this.paths.researchRoot, file)) { problems.push(`${file}: approval records were modified; only the researcher may approve. Restore it with git.`); continue; }
      const folder = path.posix.dirname(file);
      if (folder === folders.decisions || folder === folders.handoffs) { problems.push(`${file}: decisions and handoffs are written only by the loop. Restore it with git.`); continue; }
      // The library is curated alongside the research at any stage; git keeps its history, and an edit to an approved result reverts it to draft.
      const inLibrary = isLibraryPath(file, this.paths);
      if (!inLibrary && !allowedFiles.has(file) && !allowedFolders.has(folder)) { problems.push(`${file}: not writable during stage ${stage}.`); continue; }
      if (file === this.paths.paperIndex || file === this.paths.bibliography) continue; // append-only check below
      if (file === this.paths.projectMd) {
        if (!requiredAssetIds(await this.files.readFile(file)).length) problems.push('project.md needs required_results with asset IDs.');
        continue;
      }
      const raw = await this.files.readFile(file);
      try { validateResearchFile(file, raw, folders, paperIds); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); continue; }
      const data = parseMarkdown(raw).data;
      if (modified.includes(file) && ['scaffold', 'sources', 'search', 'search_summary', 'plan'].includes(stage) && !inLibrary && !isIn(file, folders.ideas) && !(stage === 'plan' && isIn(file, folders.plans) && data.status === 'pending')) problems.push(`${file}: existing files may not be changed during ${stage}.`);
      if (stage === 'verify_counterexample' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.counterexampleId}.md`) problems.push(`${file}: verification may change only the candidate example.`);
      if (stage === 'execute' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md`) problems.push(`${file}: execution may change only its target asset.`);
      if (stage === 'execute' && isIn(file, folders.plans) && file !== `${folders.plans}/${state.current.planId}.md`) problems.push(`${file}: execution may change only its active plan.`);
      if (stage === 'verify_proof' && isIn(file, folders.plans) && (file !== `${folders.plans}/${state.current.planId}.md` || data.status !== 'succeeded')) problems.push(`${file}: verification may only add ## Verdict to the plan ${state.current.planId}, leaving its status succeeded.`);
      if ((stage === 'plan' || stage === 'execute') && isIn(file, folders.plans) && data.target_asset !== state.current.assetId) problems.push(`${file}: plan targets ${data.target_asset}, not ${state.current.assetId}.`);
      if (stage === 'verify_counterexample' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md` && (data.type !== 'example' || data.refutes !== state.current.assetId)) problems.push(`${file}: only a counterexample example refuting ${state.current.assetId} may be written now.`);
      const id = path.posix.basename(file, '.md');
      if (isIn(file, folders.checks) && !(search && data.type === 'search_round' && data.target_asset === state.current.assetId && id.startsWith(`search_${state.current.assetId}_r${search.round}_`))) {
        problems.push(`${file}: only the round record search_${state.current.assetId ?? '<asset>'}_r${search?.round ?? '<round>'}_<slug> (type search_round, target_asset ${state.current.assetId ?? '<asset>'}) may be written, during an object search; the loop writes falsification checks.`);
      }
      if (isIn(file, folders.candidates)) {
        const slot = search ? new RegExp(`^cand_${state.current.assetId}_r${search.round}_s(\\d+)_[a-z0-9_]+$`).exec(id) : null;
        if (stage !== 'search') { /* verification edits an existing candidate; checked below */ }
        else if (!search || !slot) problems.push(`${file}: a candidate must be named cand_${state.current.assetId ?? '<asset>'}_r${search?.round ?? '<round>'}_s<slot>_<slug>.`);
        else if (!search.slots.some((item) => item.slot === Number(slot[1]))) problems.push(`${file}: slot ${slot[1]} was not assigned this round (slots ${search.slots.map((item) => item.slot).join(', ')}).`);
        if (data.target_asset !== state.current.assetId) problems.push(`${file}: candidate targets ${String(data.target_asset)}, not ${state.current.assetId}.`);
        if (stage === 'search' && search?.mode === 'refute' && candidateChecks(data)[NEGATED_CONCLUSION] === undefined) problems.push(`${file}: a refute candidate needs the check ${NEGATED_CONCLUSION} (the conclusion fails), after one check per hypothesis.`);
        if (stage === 'search' && search?.mode === 'construct') {
          const names = Object.keys(candidateChecks(data));
          const missing = (search.properties ?? []).filter((name) => !names.includes(name));
          const extra = names.filter((name) => !(search.properties ?? []).includes(name));
          if (missing.length || extra.length) problems.push(`${file}: checks must be exactly the specification's properties ${(search.properties ?? []).join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unknown ${extra.join(', ')}` : ''}.`);
        }
        if (stage === 'verify_construction' && (id !== search?.candidateId || data.status !== 'survived')) problems.push(`${file}: verification may only add ## Verdict to the candidate ${search?.candidateId}, leaving its status survived.`);
      }
      if (isIn(file, folders.plans) && data.type === 'plan') {
        const failed = (await this.failedPlans(String(data.target_asset))).filter((id) => id !== path.posix.basename(file, '.md'));
        if (failed.length && data.status === 'pending') {
          const section = sectionContent(parseMarkdown(raw).content, 'Difference from failed plans');
          const missing = failed.filter((id) => !section.includes(id));
          if (missing.length) problems.push(`${file}: ## Difference from failed plans must mention ${missing.join(', ')}.`);
        }
        const adapted = sectionContent(parseMarkdown(raw).content, 'Adapted from');
        for (const id of Array.isArray(data.adapts) ? data.adapts : []) {
          if (typeof id !== 'string' || !knownAssets.has(id)) problems.push(`${file}: adapts unknown result ${String(id)}.`);
          else if (id === data.target_asset) problems.push(`${file}: a plan cannot adapt its own target.`);
          else if (data.status === 'pending' && !adapted.includes(id)) problems.push(`${file}: ## Adapted from must name ${id}, with the hypotheses that transfer and the steps that change.`);
        }
      }
      const isDefinition = locateNodeFile(file, this.paths)?.kind === 'definition';
      for (const dep of Array.isArray(data.depends_on) ? data.depends_on : []) {
        if (typeof dep !== 'string' || !(isDefinition ? knownDefinitions : knownAssets).has(dep)) problems.push(`${file}: unknown dependency ${String(dep)}.`);
      }
      for (const definition of Array.isArray(data.uses_definitions) ? data.uses_definitions : []) if (typeof definition !== 'string' || !knownDefinitions.has(definition)) problems.push(`${file}: unknown definition ${String(definition)}.`);
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
        const section = sectionContent(index, paperId);
        if (added.some((file) => isIn(file, folders.assets)) && !/https?:\/\//.test(section) && !new RegExp(`^@\\w+\\{${paperId},`, 'm').test(bib)) problems.push(`${paperId}: paper needs a stable source URL and a BibTeX entry.`);
      }
    }
    if (stage === 'search' && search) {
      const perWorker = (await this.loopSettings()).candidatesPerWorker;
      const counts = new Map<string, number>();
      for (const file of added.filter((item) => isIn(item, folders.candidates))) {
        const slot = /_s(\d+)_/.exec(path.posix.basename(file, '.md').slice(`cand_${state.current.assetId}_r${search.round}`.length))?.[1] ?? '?';
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      for (const [slot, count] of counts) if (count > perWorker) problems.push(`slot ${slot} wrote ${count} candidates; at most ${perWorker} per worker. Keep the best and record the others as test_case ideas.`);
    }
    const records = added.filter((item) => isIn(item, folders.checks)).length;
    if (((stage === 'search' && search?.slots.length === 1) || stage === 'search_summary') && records !== 1) problems.push(`Write exactly one round record ${folders.checks}/search_${state.current.assetId}_r${search?.round}_<slug>.md (type search_round, ## Obstructions, ## Limitations); found ${records}.`);
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
    const { stage, current: { assetId } } = this.require();
    const result = await this.reportStage(report);
    // An autonomous run pays for each executed plan and each search round.
    const attempt = (stage === 'execute' && (report.outcome === 'proved' || report.outcome === 'failed')) || (stage === 'search' && report.outcome === 'searched');
    const handover = attempt ? await this.charge(assetId, stage, report.outcome) : undefined;
    return handover ? { stage: this.require().stage, message: `${result.message}\n${handover}` } : result;
  }

  private async reportStage(report: StageReport): Promise<{ stage: LoopStage; message: string }> {
    const state = this.require();
    if (state.status !== 'running') throw new Error(`The loop is ${state.status}; resume it first.`);
    await this.resolveOverdueQuestion();
    if (state.pendingQuestion) throw new Error(`Question ${state.pendingQuestion.id} is still pending; answer it (or wait) before reporting.`);
    const run = await this.autonomy();
    if (run?.deciding && report.outcome !== 'question') throw new Error(await this.decisionInstruction(run.deciding));
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
      if (run) return { stage: this.require().stage, message: await this.decideAlone(kind, report.question || report.summary) };
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
        if (!requiredAssetIds(project).length) throw new Error('project.md needs required_results with asset IDs.');
        if (run && state.researcherInput?.kind === 'autonomous_revision' && report.outcome === 'none') {
          // The agent found no sound revision: the goals stay as they were, and the run ends.
          delete state.extension;
          state.researcherInput = undefined;
          await this.setStage('select', { assetId: undefined });
          return { stage: 'select', message: await this.handOver(`it found no sound revision of the goals (${report.summary.split('\n')[0]})`) };
        }
        const extensionProblems = await this.extensionProblems(project);
        if (extensionProblems.length) throw new Error(`Stage draft_project validation failed:\n- ${extensionProblems.join('\n- ')}`);
        if (run && state.researcherInput?.kind === 'autonomous_revision' && state.extension) {
          const baseline = state.extension.baselineRequired;
          await this.event('autonomy_goals_added', { ids: requiredAssetIds(project).filter((id) => !baseline.includes(id)) });
        }
        await this.enqueueApproval('project', 'project', report.summary || 'Project goals drafted.');
        state.researcherInput = undefined;
        if ((await this.autoApproveQueued()).includes('project:project')) return finish('project.md drafted and approved automatically (auto mode). Continue with next.', 'select');
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
      case 'search': {
        if (report.outcome !== 'searched') throw new Error('search outcome must be searched or question.');
        const { added } = await validated();
        const assetId = state.current.assetId!;
        const search = state.current.search!;
        const digest = statementDigest(await this.files.readFile(`${this.paths.assets}/${assetId}.md`));
        const provenance = await this.provenance();
        const candidates: string[] = [];
        for (const file of added.filter((item) => path.posix.dirname(item) === this.shared.candidates)) {
          const id = path.posix.basename(file, '.md');
          const slot = Number(/_s(\d+)_/.exec(id.slice(`cand_${assetId}_r${search.round}`.length))![1]);
          await this.writeOwned(file, stampSearchRecord(await this.files.readFile(file), { mode: search.mode, round: search.round, slot, direction: search.slots.find((item) => item.slot === slot)?.direction }, digest, provenance));
          candidates.push(id);
        }
        for (const file of added.filter((item) => path.posix.dirname(item) === this.shared.checks)) {
          await this.writeOwned(file, stampSearchRecord(await this.files.readFile(file), { mode: search.mode, round: search.round, directions: search.slots.map((item) => item.direction), candidates }, digest, provenance));
        }
        await this.event('search_round', { assetId, mode: search.mode, round: search.round, candidates });
        return this.afterSearchRound(assetId, finish);
      }
      case 'verify_construction': {
        await validated();
        const assetId = state.current.assetId!;
        const search = state.current.search!;
        const candidate = (await this.searchProgressFor(assetId)).candidates.find((item) => item.id === search.candidateId);
        if (!candidate) throw new Error(`Candidate ${search.candidateId} is missing.`);
        const verdict = sectionContent(parseMarkdown(await this.files.readFile(candidate.file)).content, 'Verdict');
        if (!verdict) throw new Error(`${candidate.id} needs a ## Verdict.`);
        if (report.outcome === 'confirmed') {
          const missing = (search.properties ?? []).filter((name) => !new RegExp(`^### ${name}\\b`, 'm').test(verdict));
          if (missing.length) throw new Error(`## Verdict of ${candidate.id} needs a ### section with the argument for ${missing.join(', ')}.`);
          await this.recordConstruction(assetId, candidate, verdict);
          return finish(`Construction for ${assetId} verified and written into it; the researcher approves it as a proof. Continue with next.`, 'select', { assetId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_construction outcome must be confirmed, rejected, or question.');
        await this.archiveCandidate(candidate.id, verdict);
        return this.afterSearchRound(assetId, finish);
      }
      case 'search_summary': {
        if (report.outcome !== 'summarized') throw new Error('search_summary outcome must be summarized or question.');
        const { added } = await validated();
        const assetId = state.current.assetId!;
        const search = state.current.search!;
        const digest = statementDigest(await this.files.readFile(`${this.paths.assets}/${assetId}.md`));
        const candidates = (await this.searchProgressFor(assetId)).candidates.filter((item) => item.round === search.round).map((item) => item.id);
        const provenance = await this.provenance();
        for (const file of added.filter((item) => path.posix.dirname(item) === this.shared.checks)) {
          await this.writeOwned(file, stampSearchRecord(await this.files.readFile(file), { mode: search.mode, round: search.round, directions: search.slots.map((item) => item.direction), candidates }, digest, provenance));
        }
        return this.afterSearchRound(assetId, finish);
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
          if ((await this.autoApproveQueued()).includes(`counterexample:${exampleId}`)) return finish(`Counterexample ${exampleId} confirmed automatically (auto mode); ${assetId} is deprecated. Continue with next.`, 'select', { assetId: undefined, counterexampleId: undefined });
          return finish(`Counterexample ${exampleId} verified; the researcher must confirm it. Call request_approval(kind: "counterexample", target: "${exampleId}").`, 'select', { assetId: undefined, counterexampleId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_counterexample outcome must be confirmed, rejected, or question.');
        if (example.data.status !== 'archived') throw new Error(`Set ${exampleId} status to archived when rejecting it.`);
        const candidateId = state.current.search?.candidateId;
        if (candidateId) {
          // The survivor stays on the board as a near-miss, and the search goes on.
          await this.archiveCandidate(candidateId, sectionContent(example.content, 'Verdict') || report.summary);
          return this.afterSearchRound(assetId, finish);
        }
        await this.writeCheck(assetId, 'counterexample_rejected', `Candidate ${exampleId} was checked independently and rejected:\n\n${sectionContent(example.content, 'Verdict') || report.summary}`, 'Only this candidate family was examined; no systematic search beyond it is recorded here.');
        return finish(`Candidate rejected. Next: plan for ${assetId}.`, 'plan', { counterexampleId: undefined, planId: await this.pendingPlan(assetId) });
      }
      case 'plan': {
        if (report.outcome !== 'complete') throw new Error('plan outcome must be complete --plan <id> or question.');
        const { added } = await validated();
        const assetId = state.current.assetId!;
        const newPlans = added.filter((file) => path.posix.dirname(file) === this.paths.plans);
        if (newPlans.length > 1) throw new Error(`Write one plan per plan stage; found ${newPlans.length} new plans (${newPlans.join(', ')}). Keep the best one and record the others as ideas.`);
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
          if (plan.data.type !== 'plan' || plan.data.status !== 'succeeded' || !sectionContent(plan.content, 'Outcome')) throw new Error(`${planId} must get status succeeded and a ## Outcome.`);
          if (!proofText(asset.content)) throw new Error(`${assetId} needs the proof under ## Proof.`);
          if (asset.data.status !== 'draft') throw new Error(`${assetId} must stay draft until the researcher approves it.`);
          // Tie the succeeded plan to the proof it produced; a later proof edit shows the plan as outdated.
          const assetRaw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
          plan.data.proof_digest = proofDigest(assetRaw);
          // What the proof stands on, so auto mode can tell when a statement it relied on changed.
          plan.data.statement_digest = statementDigest(assetRaw);
          plan.data.dependency_digests = await this.dependencyDigests(asset.data) ?? {};
          // Only a confirmed verification of this proof stamps it.
          delete plan.data.verified_proof_digest;
          await this.writeOwned(`${this.paths.plans}/${planId}.md`, stringifyMarkdown(plan.content, plan.data));
          for (const definition of report.assumedDefinitions ?? []) if (await this.files.exists(`${this.paths.definitions}/${definition}.md`)) await this.enqueueApproval('definition', definition, `Used by the proof of ${assetId}.`);
          delete state.current.statementDigest;
          if ((await this.loopSettings()).rigor.verifyProofs === 'agent') return finish(`Proof recorded for ${assetId}. Next: verify it independently.`, 'verify_proof', { planId });
          await this.enqueueApproval('asset', assetId, `Proof from ${planId}${report.assumedDefinitions?.length ? `; uses draft definitions ${report.assumedDefinitions.join(', ')}` : ''}.`);
          if ((await this.autoApproveQueued()).includes(`asset:${assetId}`)) return finish(`Proof recorded for ${assetId} and approved automatically (auto mode). Continue with next.`, 'select', { assetId: undefined, planId: undefined });
          return finish(`Proof recorded for ${assetId}. Call request_approval(kind: "asset", target: "${assetId}") and continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'failed') throw new Error('execute outcome must be proved, failed, or question.');
        if (plan.data.type !== 'plan' || plan.data.status !== 'failed' || !sectionContent(plan.content, 'Failure')) throw new Error(`${planId} must have status failed and a ## Failure section.`);
        delete state.current.statementDigest;
        return this.afterFailedPlan(assetId, planId, `Plan ${planId} failed`, finish, Boolean(run));
      }
      case 'verify_proof': {
        await validated();
        const assetId = state.current.assetId!;
        const planId = state.current.planId!;
        const planFile = `${this.paths.plans}/${planId}.md`;
        const plan = parseMarkdown(await this.files.readFile(planFile));
        const verdict = sectionContent(plan.content, 'Verdict');
        if (!verdict) throw new Error(`${planId} needs a ## Verdict.`);
        if (report.outcome === 'confirmed') {
          if (!/^confirmed\b/i.test(verdict)) throw new Error(`## Verdict of ${planId} must begin with confirmed.`);
          const assetRaw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
          plan.data.verified_proof_digest = proofDigest(assetRaw);
          await this.writeOwned(planFile, stringifyMarkdown(plan.content, plan.data));
          await this.event('proof_verified', { assetId, planId });
          await this.enqueueApproval('asset', assetId, `Proof from ${planId}, verified independently.`);
          if ((await this.autoApproveQueued()).includes(`asset:${assetId}`)) return finish(`Proof of ${assetId} verified independently and approved automatically (auto mode). Continue with next.`, 'select', { assetId: undefined, planId: undefined });
          return finish(`Proof of ${assetId} verified independently. Call request_approval(kind: "asset", target: "${assetId}") and continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_proof outcome must be confirmed, rejected, or question.');
        if (!/^rejected\b/i.test(verdict)) throw new Error(`## Verdict of ${planId} must begin with rejected.`);
        await this.rejectProof(assetId, planId);
        return this.afterFailedPlan(assetId, planId, `Independent verification rejected the proof from ${planId}`, finish, Boolean(run));
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
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
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
            await this.addHold(kind, id, 'approved_without_record');
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
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
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
    const assets = await this.collectKind('asset');
    const definitions = await this.collectKind('definition');
    const library = await libraryFolders(this.files, this.paths);
    const nodeFiles: string[] = [];
    for (const folder of [folders.assets, folders.definitions, folders.ideas, folders.plans, ...library]) nodeFiles.push(...await this.files.listFiles(folder));
    problems.push(...duplicateIds(nodeFiles));
    problems.push(...libraryProblems([...assets.values(), ...definitions.values()], this.paths));
    const nodeInputs = async (folder: string) => Promise.all((await this.files.listFiles(folder)).map(async (file) => ({ filePath: file, raw: await this.files.readFile(file) })));
    problems.push(...ideaPlanProblems(await nodeInputs(folders.assets), [...await nodeInputs(folders.ideas), ...await nodeInputs(folders.plans)]));
    for (const folder of [folders.assets, folders.definitions, folders.ideas, folders.plans, folders.checks, folders.candidates, folders.decisions, folders.handoffs, ...library]) {
      for (const file of await this.files.listFiles(folder)) {
        const raw = await this.files.readFile(file);
        if (/^<{7} |^>{7} |^={7}$/m.test(raw)) { problems.push(`${file}: unresolved merge conflict markers.`); continue; }
        try { validateResearchFile(file, raw, folders, paperIds, { committed: true }); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); continue; }
        const data = parseMarkdown(raw).data;
        for (const dep of Array.isArray(data.depends_on) ? data.depends_on : []) {
          const known = locateNodeFile(file, this.paths)?.kind === 'definition' ? definitions.has(String(dep)) : assets.has(String(dep));
          if (!known) problems.push(`${file}: unknown dependency ${String(dep)}.`);
        }
        for (const definition of Array.isArray(data.uses_definitions) ? data.uses_definitions : []) if (!definitions.has(String(definition))) problems.push(`${file}: unknown definition ${String(definition)}.`);
        if (typeof data.refutes === 'string' && !assets.has(data.refutes)) problems.push(`${file}: refutes unknown asset ${data.refutes}.`);
        if ((folder === folders.plans || folder === folders.checks || folder === folders.candidates) && typeof data.target_asset === 'string' && !assets.has(data.target_asset)) problems.push(`${file}: targets unknown asset ${data.target_asset}.`);
      }
    }
    problems.push(...(await layoutReport(this.files, this.paths)).problems);
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (/^<{7} |^>{7} /m.test(project)) problems.push(`${this.paths.projectMd}: unresolved merge conflict markers.`);
    const { cycle } = assetClosure([...assets.keys()], assets);
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
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
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
      const file = item.kind === 'project' ? this.paths.projectMd : await this.nodeFile(item.kind === 'definition' ? 'definition' : 'asset', item.target);
      const raw = await this.files.readFile(file).catch(() => '');
      if (!raw) continue;
      const kind = item.kind === 'project' ? 'project' : item.kind === 'definition' ? 'definition' : 'asset';
      if (isApproved(records, kind, kind === 'project' ? 'project' : item.target, raw)) continue;
      if (item.kind !== 'project') { try { if (['deprecated', 'archived'].includes(parseMarkdown(raw).data.status)) continue; } catch { continue; } }
      keep.push(item);
    }
    this.state.approvalQueue = keep;
    await this.setStage('select', { assetId: undefined, planId: undefined, counterexampleId: undefined, statementDigest: undefined });
  }

  // ---------- autonomous mode ----------

  /**
   * Start, keep, or drop the autonomous run to match the researcher's setting.
   * Returns the run while autonomous mode is on and it has not handed back yet.
   */
  private async autonomy(): Promise<NonNullable<LoopState['autonomy']> | undefined> {
    const state = this.state;
    if (!state) return undefined;
    if (!(await this.loopSettings()).autonomy.enabled) {
      if (state.autonomy) { delete state.autonomy; await this.save(); await this.event('autonomy_off'); }
      return undefined;
    }
    if (!state.autonomy) { state.autonomy = { startedAt: this.now(), spent: 0 }; await this.save(); await this.event('autonomy_started'); }
    return state.autonomy.handedOverAt ? undefined : state.autonomy;
  }

  /** Why the autonomous run is over, or undefined while budget and time remain. */
  private autonomyOver(run: NonNullable<LoopState['autonomy']>, settings: LoopSettings): string | undefined {
    if (run.spent >= settings.autonomyBudget) return `it spent its budget of ${settings.autonomyBudget} attempt(s)`;
    if (settings.autonomyHours > 0 && Date.parse(this.now()) - Date.parse(run.startedAt) >= settings.autonomyHours * 3600_000) return `it reached its time limit of ${settings.autonomyHours} hour(s)`;
    return undefined;
  }

  /** One attempt spent on `assetId`; returns the hand-back message when that was the last one. */
  private async charge(assetId: string | undefined, stage: LoopStage, outcome: string): Promise<string | undefined> {
    const run = await this.autonomy();
    if (!run) return undefined;
    run.spent += 1;
    await this.save();
    await this.event('autonomy_spent', { assetId, stage, outcome });
    const over = this.autonomyOver(run, await this.loopSettings());
    return over ? this.handOver(over) : undefined;
  }

  /** End the autonomous run: a handoff tells the researcher what happened, and the loop pauses for them. */
  private async handOver(reason: string): Promise<string> {
    const state = this.require();
    const run = state.autonomy!;
    run.handedOverAt = this.now();
    delete run.deciding;
    const text = `Autonomous run finished: ${reason}.`;
    await this.event('autonomy_handover', { reason, spent: run.spent });
    await this.writeHandoff(`${text} ${run.spent} attempt(s) spent${run.revisions ? `; the agent added goals of its own ${run.revisions} time(s), keeping yours` : ''}.`);
    await this.pause(text);
    return `${text} The loop is handed back to the researcher: stop working now and tell them briefly what was proved, what was set aside, and what waits for their review.`;
  }

  autonomyNote(run: NonNullable<LoopState['autonomy']>): string {
    const settings = this.lastSettings ?? DEFAULT_LOOP_SETTINGS;
    const until = settings.autonomyHours > 0 ? `, until ${new Date(Date.parse(run.startedAt) + settings.autonomyHours * 3600_000).toISOString()}` : '';
    return `Autonomous mode (set by the researcher): they are away. Never call ask_researcher or report question; decide every question yourself and say what you chose and why in the report summary. Budget: ${run.spent} of ${settings.autonomyBudget} attempts spent (an executed plan or a search round is one)${until}. When a result's attempts run out, decide yourself whether it deserves more (${LOOP_COMMAND} budget allocate) or should be set aside.`;
  }

  /**
   * Nothing is left that the agent can do alone, but results it could not prove are set aside:
   * while revisions remain, it rethinks the goals itself. The revision is an extension of the
   * approved project, so it can only add results (a weaker statement, a special case, another
   * route) and never drops the researcher's. Returns whether a revision started.
   */
  private async reviseGoals(run: NonNullable<LoopState['autonomy']>): Promise<boolean> {
    const state = this.require();
    const settings = await this.loopSettings();
    if ((run.revisions ?? 0) >= settings.autonomyRevisions || !(await this.isProjectApproved())) return false;
    const setAside = Object.entries(state.parked).filter(([id, info]) => info.reason !== 'counterexample_pending' && !(run.revisedFor ?? []).includes(id));
    if (!setAside.length) return false;
    run.revisions = (run.revisions ?? 0) + 1;
    run.revisedFor = [...(run.revisedFor ?? []), ...setAside.map(([id]) => id)];
    const list = setAside.map(([id, info]) => `${id} (${info.reason.replace(/_/g, ' ')}${info.note ? `: ${info.note}` : ''})`).join('; ');
    const goal = `Autonomous revision ${run.revisions} of ${settings.autonomyRevisions} (the researcher is away). Set aside: ${list}. From what is proved so far and what the failed plans and searches showed, judge whether a weaker statement, a special case, or another route to the Main Problem is within reach. If so, add it under new asset ID(s) and say in ## Intended Contribution what changed and why; the researcher decides at hand-back whether to keep the originals. If no sound revision is in sight, run: ${LOOP_COMMAND} report none --summary "<why>", and the loop hands back.`;
    await this.markExtension(goal);
    state.researcherInput = { kind: 'autonomous_revision', text: goal, at: this.now() };
    state.lastError = null;
    await this.event('autonomy_revision', { revision: run.revisions, setAside: setAside.map(([id]) => id) });
    await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined });
    return true;
  }

  /** The current or last autonomous run for the Overview; undefined when there has been none since the loop last resumed. */
  async autonomySummary(state = this.state): Promise<AutonomyView | undefined> {
    const run = state?.autonomy;
    if (!state || !run) return undefined;
    const settings = await this.loopSettings();
    const events = (await this.recentEvents(Number.MAX_SAFE_INTEGER)).filter((event) => String(event.at ?? '') >= run.startedAt);
    const spending = new Map<string, number>();
    const proved: string[] = [];
    const setAside: Array<{ id: string; note?: string }> = [];
    const addedGoals: string[] = [];
    let decided = 0;
    for (const event of events) {
      const assetId = typeof event.assetId === 'string' ? event.assetId : undefined;
      if (event.type === 'autonomy_spent' && assetId) {
        spending.set(assetId, (spending.get(assetId) ?? 0) + 1);
        if (event.outcome === 'proved' && !proved.includes(assetId)) proved.push(assetId);
      }
      if (event.type === 'parked' && event.reason === 'agent_gave_up' && assetId && state.parked[assetId] && !setAside.some((item) => item.id === assetId)) setAside.push({ id: assetId, note: state.parked[assetId].note });
      if (event.type === 'autonomy_goals_added' && Array.isArray(event.ids)) for (const id of event.ids) if (!addedGoals.includes(String(id))) addedGoals.push(String(id));
      if (event.type === 'autonomy_decided') decided += 1;
    }
    const handover = events.filter((event) => event.type === 'autonomy_handover').pop();
    return {
      active: state.status === 'running' && !run.handedOverAt, startedAt: run.startedAt, handedOverAt: run.handedOverAt,
      reason: run.handedOverAt && typeof handover?.reason === 'string' ? handover.reason : undefined,
      spent: run.spent, budget: settings.autonomyBudget,
      deadline: settings.autonomyHours > 0 ? new Date(Date.parse(run.startedAt) + settings.autonomyHours * 3600_000).toISOString() : undefined,
      revisions: run.revisions ?? 0, revisionLimit: settings.autonomyRevisions,
      spending: [...spending].map(([id, attempts]) => ({ id, attempts })).sort((a, b) => b.attempts - a.attempts),
      proved, setAside, addedGoals, decided,
    };
  }

  /** Required results the agent added in any autonomous revision of the goals; they stay marked after the run. */
  async agentGoals(): Promise<string[]> {
    const ids = (await this.recentEvents(Number.MAX_SAFE_INTEGER, (event) => event.type === 'autonomy_goals_added')).flatMap((event) => Array.isArray(event.ids) ? event.ids.map(String) : []);
    return [...new Set(ids)];
  }

  /** Attempts the agent gave an asset with `budget allocate`, while that is its latest direction. */
  private async allotment(assetId: string): Promise<number | undefined> {
    const direction = latestDirection(await this.decisions(), assetId);
    return direction?.reason === 'autonomous' ? direction.rounds : undefined;
  }

  private async isDraftResult(assetId: string): Promise<boolean> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
    try { return Boolean(raw) && parseMarkdown(raw).data.status === 'draft'; } catch { return false; }
  }

  /** A result's attempts ran out: the loop waits on the agent's own decision, never on the researcher. */
  private async decideStuck(assetId: string, what: string): Promise<string> {
    const run = this.require().autonomy!;
    run.deciding = assetId;
    await this.save();
    await this.event('autonomy_deciding', { assetId });
    return this.decisionInstruction(assetId, what);
  }

  private async decisionInstruction(assetId: string, what?: string): Promise<string> {
    const run = this.require().autonomy!;
    const left = Math.max(0, (await this.loopSettings()).autonomyBudget - run.spent);
    return `${what ?? `The attempts for ${assetId} are used up.`} Decide yourself, without the researcher: read its failed plans and search board (${LOOP_COMMAND} show <plan>, ${LOOP_COMMAND} search status ${assetId}) and judge whether a genuinely different approach is in sight. Then either give it more attempts with that approach: ${LOOP_COMMAND} budget allocate ${assetId} <n> --reason "<what the failures show and what to try instead>" (${left} attempt(s) of the budget left; weigh what other results still need), or set it aside: ${LOOP_COMMAND} park ${assetId} --reason agent_gave_up --note "<the obstruction, and the kind of idea that would get past it>".`;
  }

  /**
   * Autonomous mode: the agent gives an asset `attempts` more tries with a
   * direction of its own. Recorded as a direction, so failed plans before it
   * stop counting and the plan pack shows it; a set-aside asset comes back.
   */
  async allocate(assetId: string, attempts: number, reason: string): Promise<string> {
    const state = this.require();
    const run = await this.autonomy();
    if (!run) throw new Error('budget allocate works only in autonomous mode, which the researcher turns on in Settings.');
    if (!reason.trim()) throw new Error('Say in --reason what the failures show and what to try instead.');
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
    if (!raw) throw new Error(`Unknown asset ${assetId}.`);
    const data = parseMarkdown(raw).data;
    if (data.status !== 'draft' || !PROVABLE_TYPES.has(data.type)) throw new Error(`${assetId} is not a draft theorem, lemma, proposition, or construction.`);
    const left = (await this.loopSettings()).autonomyBudget - run.spent;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > left) throw new Error(`Give a whole number of attempts from 1 to ${left} (the budget left).`);
    const construct = isConstructionSpec(raw);
    const searchRound = construct ? (await this.searchProgressFor(assetId)).lastRound : undefined;
    await this.writeDecision('direction', assetId, reason.trim(), { reason: 'autonomous', rounds: attempts, failedPlansAtDirection: await this.failedPlans(assetId), searchRound });
    delete state.parked[assetId];
    await this.event('budget_allocated', { assetId, attempts });
    if (run.deciding === assetId) {
      delete run.deciding;
      if (construct) await this.setStage('select', { assetId: undefined });
      else await this.setStage('plan', { assetId, planId: undefined });
    } else await this.save();
    return `${assetId} has ${attempts} more ${construct ? 'search round(s)' : 'proof attempt(s)'} with your direction. Run: ${LOOP_COMMAND} next`;
  }

  /**
   * Autonomous mode answers in the researcher's place, without a popup: a stuck
   * result waits on the agent's own decision; any other question is kept as an
   * idea for the researcher, and the agent goes on with its stated default.
   * Returns what the agent does next.
   */
  async decideAlone(kind: QuestionKind, prompt: string, assetId?: string): Promise<string> {
    const state = this.require();
    const target = assetId ?? state.current.assetId;
    if (kind === 'blocked' && target && await this.isDraftResult(target)) return this.decideStuck(target, `You are stuck on ${target}: ${prompt}`);
    await this.event('autonomy_decided', { kind, assetId: target });
    if (kind === 'goals') {
      if (!projectSection(await this.files.readFile(this.paths.projectMd).catch(() => ''), 'Main Problem')) return this.handOver('it has no research goal to work on; give one and resume');
      await this.setStage('draft_project');
      return `Autonomous mode: the researcher is not asked. project.md already states the goal; continue with ${LOOP_COMMAND} next.`;
    }
    if (kind === 'counterexample_review') return `Autonomous mode: nobody reviews it now; it stays recorded. Continue with ${LOOP_COMMAND} next.`;
    if (prompt.trim()) await this.saveIdea(`Open question: ${prompt.slice(0, 60)}`, `${prompt}\n\nAutonomous mode: the researcher was not asked; the agent went on with its stated default.`, target && await this.files.exists(`${this.paths.assets}/${target}.md`) ? [target] : [], 'agent', ['open-question'], 'question');
    return 'Autonomous mode: the researcher is not asked. Go on with the default you stated; the question is kept as an idea for their review.';
  }

  // ---------- status ----------

  statusSummary(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { status: 'idle' };
    return {
      status: state.status, stage: state.stage, provider: state.provider, assetId: state.current.assetId, planId: state.current.planId,
      counterexampleId: state.current.counterexampleId, waitingForHuman: isWaitingForHuman(state), pendingQuestion: state.pendingQuestion,
      approvalQueue: state.approvalQueue, parked: state.parked, lock: state.lock, lastSummary: state.lastSummary, lastError: state.lastError,
      unreadAnswers: state.answers.filter((answer) => !answer.consumed), autonomy: state.autonomy, updatedAt: state.updatedAt,
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
    if (state.autonomy && !state.autonomy.handedOverAt) lines.push(this.autonomyNote(state.autonomy));
    const auto = this.lastSettings?.autonomy.enabled ? AUTONOMOUS_AUTO_APPROVE : this.lastSettings?.autoApprove;
    if (auto?.enabled) lines.push(`Auto mode (set by the researcher): approves ${AUTO_APPROVE_RULES.filter((rule) => auto[rule]).join(', ') || 'nothing'} without asking.`);
    const rigor = this.lastSettings?.rigor;
    if (rigor) lines.push(`How careful (set by the researcher): counterexample search ${rigor.refuteSearch === 'all' ? 'for every result' : rigor.refuteSearch === 'main' ? 'for main results only' : 'off'}; each proof ${rigor.verifyProofs === 'agent' ? 'is verified independently before approval' : rigor.verifyProofs === 'researcher' ? 'is verified by the researcher (never approved automatically)' : 'goes to approval without a separate check'}; definitions ${rigor.agreeDefinitions === 'main' ? 'used by main results are agreed before proving' : 'checked at the end'}; when stuck without a direction, ${rigor.whenStuck === 'retry' ? 'try one new approach of your own' : 'the result is set aside'}; unanswered questions ${rigor.unansweredQuestions === 'wait' ? 'wait for the researcher' : 'proceed with your stated default'}.`);
    if (state.stage === 'ready') lines.push(`If the researcher's message asks for a new result or goal, run: ${LOOP_COMMAND} extend --goal "<their goal>"`);
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

function sameDigests(stamped: unknown, current: Record<string, string>): boolean {
  if (!stamped || typeof stamped !== 'object' || Array.isArray(stamped)) return false;
  const entries = Object.entries(stamped as Record<string, unknown>);
  return entries.length === Object.keys(current).length && entries.every(([id, digest]) => current[id] === digest);
}

/** A direction as the plan pack shows it: the agent's own (autonomous mode) is not the researcher's. */
function directionFocus(direction: DecisionInfo | undefined): { direction?: string; ownDirection?: boolean } {
  if (!direction) return {};
  return direction.reason === 'autonomous' ? { direction: direction.text, ownDirection: true } : { direction: direction.text };
}
