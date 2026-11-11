import * as crypto from 'crypto';
import * as path from 'path';
import type matter from 'gray-matter';
import { LOOP_COMMAND, MANUSCRIPT_COMMAND } from './AgentProviders';
import { loadManuscriptImpact } from './ManuscriptImpactLoader';
import { renderImpact } from '../domain/manuscriptImpact';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { ProjectPaths } from '../models/types';
import {
  AUTO_HOLDS_PATH, AgentProvider, ApprovalFile, ApprovalKind, ApprovalRecord, ApprovalRequest, ASSESSMENT_PATH, CONTEXT_MANIFEST_PATH, CONTEXT_PACK_PATH, EVENTS_PATH, GoalAssessment, LoopFiles, LoopQuestion, LoopStage, LoopState,
  BATCH_STAGES, BatchItem, FrozenInput, LoopExtension, NodeCheckTarget, PackageApprovalNode, QuestionKind, ROUTE_STAGES, SEARCH_STAGES, SNAPSHOT_PATH, STATE_DIR, STATE_PATH, StageReport, WaitingReason, approvalDigest, approvalRecordOf, isApproved, isWaitingForHuman, newState,
  proofDigest, proofText, researchDigest, sharedFolders, statementDigest, statementIncomplete, validateResearchFile,
} from './ResearchLoopModel';
import { STATE_LOCK_PATH, StateLockOptions, acquireStateLock } from './StateLock';
import { CONJECTURE_TYPE, INACTIVE_STATUSES, IdeaKind, PROMOTED_TYPES, PROVABLE_TYPES, REUSABLE_IDEA_KINDS, WARNING_SECTION, toIdeaKind } from '../domain/nodeKinds';
import { ideaUsage, promotionCandidates, triedRecords, usageLine } from '../domain/ideaUsage';
import { RankedConjecture, describeConjectures, rankConjectures } from '../domain/conjectures';
import { AUTO_APPROVE_RULES, AutoApprovePolicy, AutoApproveRule, LoopSettings } from '../models/settings';
import type { AgentCheckedView, AutonomyView } from '../models/graph';
import { readLoopSettings } from './LoopSettingsStore';
import { AUTONOMOUS_AUTO_APPROVE, DEFAULT_LOOP_SETTINGS, LOOP_NUMBER_FIELDS } from '../domain/loopSettings';
import {
  CandidateInfo, NEGATED_CONCLUSION, RoundInfo, SearchMode, SearchProgress, TriedIdea, assignDirections, candidateChecks, checkSections, parseCandidate, parseRound, renderBoard, roundDigest, searchProgress, specProperties, triedOutcome,
} from '../domain/search';
import { normalizeContextBudgets, normalizeSyncConfig } from './ProjectPathsCore';
import { projectSection, requiredAssetIds } from '../domain/project';
import { duplicateIds, isCited } from '../domain/schema';
import { appendToSection, hasSection, sectionContent, statementPart, stripManagedBlocks, verdictOutcome } from '../domain/sections';
import { ProofRevision, REVISIONS_DIR, withProof } from '../domain/revisions';
import { ProofGraph, ProofNumbers, ROUTE_DIRECTIONS, RouteInfo, applyBeam, isActiveRoute, isOpenRoute, isRoutePlan, mostProvingStep, reductionDigest, routeInfo, routeLemmas, routeMapCovered, routeMapDigest, routeMapEntries, splitRoutes } from '../domain/routes';
import type { RouteOrigin, RouteRound, RouteSlot } from '../domain/routeSchema';
import { understandingParts } from '../domain/understanding';
import { layoutReport } from '../domain/layout';
import { appendProjectRevision, approvalFiles, isApprovalPath, legacyApprovalsPath, readApprovals, writeApprovals } from './ApprovalStore';
import { LoopGit } from './LoopGit';
import { RemarkInput, Remarks } from './Remarks';
import { Remark, RemarkFrom, isRemarkChecked, remarkReferenceProblems } from '../domain/remarks';
import {
  CheckInfo, DecisionExtra, DecisionInfo, DecisionKind, Provenance, checkMarkdown, sortDecisions, decisionId, decisionMarkdown, deriveChangesRequested, deriveParked,
  failuresSinceDirection, handoffMarkdown, latestDirection, parseCheck, parseDecision, parseHandoff, stamp, stampSearchRecord,
} from './ResearchRecords';
import {
  ContextManifest, ContextNode, ContextSources, DEFAULT_CONTEXT_BUDGETS, RenderedContext, assetClosure, definitionClosure, hasContextPack, planContext, projectPart, renderContext, renderShow,
} from './ResearchContext';
import { ideaPlanProblems } from './ProofIdeas';
import { packageProblemsIn } from './PackageService';
import { collectionProblemsIn } from './CollectionService';
import { PackageLock, lockPath, parseLock, vendoredPath } from '../domain/packages';
import { Teaching } from './Teaching';
import { LIBRARY_PREFIX, LibraryHit, ResultKind, findNodeFile, isLibraryId, isLibraryPath, libraryFolders, libraryProblems, listNodeFiles, locateNodeFile, nodeFolders, searchLibrary } from '../domain/registry';

export interface CoreOptions {
  now?: () => string;
  id?: () => string;
  /** Wait and staleness of the cross-process state lock (tests shorten them). */
  stateLock?: StateLockOptions;
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
  | { stage: 'plan'; assetId: string; repair?: string }
  | { stage: 'verify_proof'; assetId: string; planId: string; recheck?: string[] }
  | { stage: 'search'; assetId: string; mode: SearchMode }
  | { stage: 'conjecture'; ideaId: string }
  | { stage: 'verify_node'; node: NodeCheckTarget }
  | { stage: 'route'; assetId: string; fork?: string }
  | { stage: 'reduce' | 'verify_reduction'; assetId: string; planId: string }
  | { stage: 'waiting'; reason: string; waitingOn: WaitingReason[] };
/** Where the researcher's own results stand after their checks (see intakeReport). */
export interface IntakeReport {
  /** The results no other result of the set rests on: the goals of an intake. */
  main: string[];
  titles: Record<string, string>;
  confirmed: Array<{ id: string; title: string; mode: NodeCheckTarget['mode'] }>;
  gaps: Array<{ id: string; title: string; mode: NodeCheckTarget['mode']; summary: string }>;
  unproved: Array<{ id: string; title: string }>;
  unchecked: Array<{ id: string; title: string; mode: NodeCheckTarget['mode'] }>;
  other: Array<{ id: string; title: string; why: string }>;
}
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
/** Parked results named in the brief status; the rest are counted. */
const BRIEF_PARKED = 3;
/** Set-aside results a reassessment of the goals leads with; the rest are in its report file. */
const GAP_BRIEF = 8;
/** Set-aside results few enough to be the whole frontier of a reassessment, described in full. */
const GAP_FRONTIER = 3;
/** Conjectures an instruction or a handoff names; the rest are counted. */
const CONJECTURES_LISTED = 5;
/** Required results an extension instruction names; past this it counts them. */
const EXTENSION_LISTED = 10;
/** Selection passes after auto approvals; each pass approves at least one request, so this only guards against surprises. */
const MAX_AUTO_PASSES = 16;
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');
/** A save of an idea identical to one saved this recently is taken as a retry of that save. */
const IDEA_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** Stages whose outcome rests on what they read: their inputs are frozen when they begin and compared at the report. */
const FROZEN_STAGES = new Set<LoopStage>(['execute', 'verify_proof', 'verify_node', 'verify_counterexample', 'verify_construction', 'reduce', 'verify_reduction']);

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
  private readonly stateLock: StateLockOptions | undefined;
  /** Nesting depth of `transaction` on this core: the lock is taken once, at the outermost. */
  private lockDepth = 0;
  /** The revision of state.json this core loaded (or last saved); a save under the lock must find it still on disk. */
  private loadedRevision = 0;

  constructor(private readonly files: LoopFiles, private paths: ProjectPaths, options: CoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
    this.iterationCap = options.iterationCap;
    this.git = options.git;
    this.identity = options.identity;
    this.extensionVersion = options.extensionVersion;
    this.contextBudgets = options.contextBudgets;
    this.stateLock = options.stateLock;
  }

  /**
   * Run `action` as the only writer of the loop state: take the cross-process state lock, load the
   * state afresh, act, and release. Every entry point that changes state (the extension's queue, CLI
   * commands and hooks, the MCP server) goes through here. Nested calls on one core reuse the lock.
   */
  async transaction<T>(op: string, action: () => Promise<T>): Promise<T> {
    if (this.lockDepth > 0) return action();
    const release = await acquireStateLock(this.files, op, this.stateLock);
    this.lockDepth++;
    try {
      await this.load();
      return await action();
    } finally {
      this.lockDepth--;
      await release();
    }
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
    this.loadedRevision = this.state?.revision ?? 0;
    // Status lines (the autonomous budget among them) are synchronous: give them the researcher's settings, not the defaults.
    await this.loopSettings().catch(() => undefined);
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
    // Unreadable is not the same as absent: reporting "no loop" here would let a start overwrite the run.
    let parsed: Partial<LoopState> & { version?: number };
    try { parsed = JSON.parse(raw) as Partial<LoopState> & { version?: number }; } catch (error) {
      throw new Error(`${STATE_PATH} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Restore it or move it aside; nothing was overwritten.`);
    }
    if (typeof parsed.version === 'number' && parsed.version > 2) throw new Error(`${STATE_PATH} was written by a newer Research Assistant (state version ${parsed.version}); update the extension. Nothing was overwritten.`);
    return parsed.version === 2 ? parsed as LoopState : undefined;
  }

  /**
   * While one item of a batch reports: the batch's own `current`, which a save writes in place of the
   * item's view (so state.json always holds the batch), and the stage the item's report moved on to.
   */
  private itemMode?: { batch: LoopState['current']; next?: LoopStage };
  /** While one item of a batch reports (or the batch closes): the changed files its validation covers. */
  private itemScope?: (file: string) => boolean;

  private async save(): Promise<void> {
    if (!this.state) return;
    if (this.itemMode) {
      const mode = this.itemMode;
      const item = this.state;
      this.itemMode = undefined;
      this.state = { ...item, stage: 'batch', current: mode.batch };
      try { await this.save(); } finally { item.revision = this.state.revision; item.updatedAt = this.state.updatedAt; this.state = item; this.itemMode = mode; }
      return;
    }
    if (this.lockDepth > 0) {
      // Under the lock nobody else may have saved since this core loaded: a different revision means a writer that skips the lock.
      let onDisk = 0;
      try { onDisk = (JSON.parse(await this.files.readFile(STATE_PATH)) as { revision?: number }).revision ?? 0; } catch { onDisk = 0; }
      if (onDisk !== this.loadedRevision) throw new Error(`${STATE_PATH} was changed by another writer while this operation held ${STATE_LOCK_PATH} (revision ${onDisk}, expected ${this.loadedRevision}); perhaps an older Research Assistant that does not take the lock. Nothing was saved; run the command again.`);
    }
    this.state.revision = this.loadedRevision + 1;
    this.state.updatedAt = this.now();
    await this.files.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n');
    this.loadedRevision = this.state.revision;
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

  // ---------- frozen stage inputs ----------

  /** The digest of one part of a node file as it is now; '' when the file is missing or does not parse. */
  private async inputDigest(file: string, part: FrozenInput['part'], kind: FrozenInput['kind']): Promise<string> {
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw.trim()) return '';
    try { return part === 'statement' ? statementDigest(raw) : part === 'proof' ? proofDigest(raw) : researchDigest(raw, kind); } catch { return ''; }
  }

  /**
   * What a stage works from, frozen as the stage begins: the result's own statement (and its proof,
   * for a proof check), and the statements of the results and definitions it rests on; a checked
   * definition or cited result as a whole. Undefined for a stage whose outcome rests on nothing frozen.
   */
  private async freezeInputs(stage: LoopStage, current: LoopState['current']): Promise<FrozenInput[] | undefined> {
    if (!FROZEN_STAGES.has(stage)) return undefined;
    const inputs: FrozenInput[] = [];
    const add = async (kind: FrozenInput['kind'], id: string, part: FrozenInput['part']) => {
      const file = (await findNodeFile(this.files, this.paths, kind, id)) ?? await this.nodeFile(kind, id);
      inputs.push({ id, kind, file, part, digest: await this.inputDigest(file, part, kind) });
    };
    const result = async (id: string, parts: Array<'statement' | 'proof'>) => {
      const file = (await findNodeFile(this.files, this.paths, 'asset', id)) ?? await this.nodeFile('asset', id);
      let data: Record<string, any> = {};
      try { data = parseMarkdown(await this.files.readFile(file)).data; } catch { /* missing or unparsable: frozen as '' below */ }
      for (const part of parts) await add('asset', id, part);
      for (const dep of Array.isArray(data.depends_on) ? data.depends_on : []) await add('asset', String(dep), 'statement');
      for (const definition of Array.isArray(data.uses_definitions) ? data.uses_definitions : []) await add('definition', String(definition), 'statement');
    };
    if (stage === 'verify_node') {
      const node = current.node;
      if (!node) return undefined;
      if (node.mode === 'proof') await result(node.id, ['statement', 'proof']);
      else await add(node.mode === 'definition' ? 'definition' : 'asset', node.id, 'node');
      return inputs;
    }
    if (!current.assetId) return undefined;
    // A route's reduction rests on its target's statement and dependencies and on each route lemma's statement.
    if ((stage === 'reduce' || stage === 'verify_reduction') && current.planId) {
      await result(current.assetId, ['statement']);
      let lemmas: string[] = [];
      try { lemmas = routeLemmas(parseMarkdown(await this.files.readFile(`${this.paths.plans}/${current.planId}.md`)).data); } catch { /* missing plan: the stage is recomputed */ }
      for (const lemma of lemmas) if (!inputs.some((input) => input.id === lemma && input.part === 'statement')) await add('asset', lemma, 'statement');
      return inputs;
    }
    // Execution writes the proof itself, and its own statement is held fixed by the stage rules: it works from what the result rests on.
    if (stage === 'execute') { await result(current.assetId, []); return inputs.filter((input) => input.id !== current.assetId); }
    await result(current.assetId, stage === 'verify_proof' ? ['statement', 'proof'] : ['statement']);
    return inputs;
  }

  /**
   * What the current stage's target rests on that changed since the stage began. The target itself is
   * left out: a change to the result under check is the stage rules' business (the checker may not edit
   * it), and its frozen digests serve only to stamp the verdict on the version that was checked.
   */
  private async inputDrift(): Promise<FrozenInput[]> {
    const state = this.state;
    const inputs = state?.current.inputs;
    if (!state || !inputs?.length || !FROZEN_STAGES.has(state.stage)) return [];
    const target = state.stage === 'verify_node' ? state.current.node?.id : state.current.assetId;
    return this.changedInputs(inputs.filter((input) => input.id !== target));
  }

  /** The frozen inputs whose file no longer has the frozen digest. */
  private async changedInputs(inputs: FrozenInput[]): Promise<FrozenInput[]> {
    const changed: FrozenInput[] = [];
    for (const input of inputs) if (await this.inputDigest(input.file, input.part, input.kind) !== input.digest) changed.push(input);
    return changed;
  }

  /** The frozen statement digests of what `id` rests on, as a proof's dependency_digests; undefined when one was missing. */
  private frozenDependencies(id: string, inputs = this.state?.current.inputs): Record<string, string> | undefined {
    if (!inputs) return undefined;
    const deps = inputs.filter((input) => input.id !== id && input.part === 'statement');
    if (deps.some((input) => !input.digest)) return undefined;
    return Object.fromEntries(deps.map((input) => [input.id, input.digest]));
  }

  /** The frozen digest of one part of the stage's own target, if the stage froze it. */
  private frozenPart(id: string, part: FrozenInput['part']): string | undefined {
    return this.state?.current.inputs?.find((input) => input.id === id && input.part === part)?.digest;
  }

  /**
   * Something the stage worked from changed before its report (the researcher edited it, a sync
   * brought it, another chat changed it). The work covered the earlier version only: an execution
   * is set aside (not a failed approach) and the result is planned anew; a check's verdict is set
   * aside and the check runs again on the current version. The change itself is never undone.
   */
  private async afterInputDrift(drift: FrozenInput[]): Promise<string> {
    const state = this.require();
    const stage = state.stage;
    const assetId = state.current.assetId;
    const names = [...new Set(drift.map((input) => input.id))];
    const list = names.join(', ');
    const notOurs = `This is someone else's change: do not revert ${names.length > 1 ? 'them' : 'it'}.`;
    await this.event('inputs_changed', { stage, assetId, planId: state.current.planId, changed: drift.map((input) => `${input.id}#${input.part}`) });
    if (stage === 'execute' && assetId) {
      const planId = state.current.planId;
      if (planId) {
        const planFile = `${this.paths.plans}/${planId}.md`;
        const raw = await this.files.readFile(planFile).catch(() => '');
        if (raw) {
          const plan = parseMarkdown(raw);
          plan.data.status = 'abandoned';
          const note = `Set aside: ${list} changed during execution, so this execution worked against an earlier version. Not counted as a failed approach.`;
          await this.writeOwned(planFile, stringifyMarkdown(`${plan.content.trimEnd()}\n\n## ${sectionContent(plan.content, 'Failure') ? 'Superseded' : 'Failure'}\n\n${note}\n`, plan.data));
        }
      }
      await this.setStage('plan', { planId: await this.pendingPlan(assetId), statementDigest: undefined });
      return `${list} changed during execution, so this execution worked against an earlier version. ${planId ? `Plan ${planId} is set aside (not counted as a failed approach); ` : ''}${assetId} is planned anew against the current version, and any draft proof stays in it for reference. ${notOurs} Continue with next.`;
    }
    if (stage === 'reduce') {
      await this.setStage('select', { assetId: undefined, planId: undefined });
      return `${list} changed while the reduction was being written, so it would rest on an earlier version. Nothing is recorded; the loop chooses again: run next. ${notOurs}`;
    }
    if (stage === 'verify_reduction' && state.current.planId) await this.setAsideVerdictIn(`${this.paths.plans}/${state.current.planId}.md`, 'Reduction verdict');
    if (stage === 'verify_proof' && state.current.planId) await this.setAsideVerdict(state.current.planId);
    if (stage === 'verify_counterexample' && state.current.counterexampleId) await this.setAsideVerdictIn(`${this.paths.assets}/${state.current.counterexampleId}.md`);
    if (stage === 'verify_construction' && assetId && state.current.search?.candidateId) {
      const candidate = (await this.searchProgressFor(assetId)).candidates.find((item) => item.id === state.current.search?.candidateId);
      if (candidate) await this.setAsideVerdictIn(candidate.file);
    }
    await this.setStage(stage, {});
    return `${list} changed during the check, so its verdict covers only the earlier version and is set aside. Check again against the current version: run next for the fresh context. ${notOurs}`;
  }

  /** A verdict written into a file (a candidate's or a counterexample's) stays under another heading, so it cannot pass for the next check's. */
  private async setAsideVerdictIn(file: string, heading = 'Verdict'): Promise<void> {
    const raw = await this.files.readFile(file).catch(() => '');
    const pattern = new RegExp(`^## ${heading}[ \\t]*$`, 'gm');
    if (!raw || !new RegExp(pattern.source, 'm').test(raw)) return;
    await this.writeOwned(file, raw.replace(pattern, `## Earlier ${heading.toLowerCase()}`));
  }

  private async setStage(stage: LoopStage, patch: Partial<LoopState['current']> = {}): Promise<void> {
    const state = this.require();
    // An item of a batch moves on only in its own view: the batch stays the stage, and its snapshot stays put.
    if (this.itemMode) { this.itemMode.next = stage; state.current = { ...state.current, ...patch }; await this.save(); return; }
    state.stage = stage;
    state.current = { ...state.current, ...patch, stageStartedAt: this.now(), baseCommit: await this.git?.head() };
    if (!SEARCH_STAGES.has(stage)) delete state.current.search;
    if (!ROUTE_STAGES.has(stage)) delete state.current.route;
    if (stage !== 'batch') delete state.current.batch;
    if (stage !== 'verify_proof') delete state.current.recheck;
    if (stage !== 'verify_node') delete state.current.node;
    if (stage !== 'plan' && stage !== 'execute' && stage !== 'verify_proof') delete state.current.repair;
    if (stage !== 'waiting') delete state.waitingOn;
    const inputs = await this.freezeInputs(stage, state.current);
    if (inputs) state.current.inputs = inputs; else delete state.current.inputs;
    await this.takeSnapshot();
    // The log line goes first and state.json last, so state.json is the commit point: when this throws, the
    // stage on disk has not moved and the caller may retry (at worst the log shows the stage line twice).
    await this.event('stage', { stage, assetId: state.current.assetId, planId: state.current.planId });
    await this.save();
  }

  // ---------- run control ----------

  async start(provider: AgentProvider, options: { goal?: string; sessionId?: string; force?: boolean; inputKind?: 'goals' | 'intake' } = {}): Promise<LoopState> {
    if (this.state && this.state.status === 'running' && !options.force) {
      // A new goal for a running loop is an extension, never a reason to refuse it.
      if (options.goal?.trim()) return this.extend(options.goal, { provider, sessionId: options.sessionId, inputKind: options.inputKind });
      throw new Error('A research loop is already running. Use resume, or stop it first.');
    }
    const state = newState(provider, this.id(), this.now(), this.iterationCap ?? (await this.loopSettings()).iterationCap);
    if (options.goal?.trim()) state.researcherInput = { kind: options.inputKind ?? 'goals', text: options.goal.trim(), at: this.now() };
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
  async extend(goal: string, options: { provider?: AgentProvider; sessionId?: string; force?: boolean; inputKind?: 'goals' | 'intake' } = {}): Promise<LoopState> {
    if (!goal.trim()) throw new Error('Describe the new goal to add.');
    const state = this.state;
    if (!state || state.status === 'stopped' || state.status === 'idle') {
      const started = await this.start(options.provider ?? state?.provider ?? 'claude', { goal, sessionId: options.sessionId, force: true, inputKind: options.inputKind });
      // An explicit extension of a project under revision drafts the goal in, rather than reviewing the old text.
      if (started.stage !== 'draft_project' && !(await this.isProjectApproved())) await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined });
      return started;
    }
    if (options.provider) state.provider = options.provider;
    if (options.sessionId && !this.heartbeat(options.sessionId, options.force)) throw new Error(`Another session (${state.lock?.sessionId}) is driving this loop. Pass --force to take over.`);
    if (state.status !== 'running') state.runningSince = this.now();
    state.status = 'running';
    state.lastError = null;
    state.researcherInput = { kind: options.inputKind ?? 'goals', text: goal.trim(), at: this.now() };
    // A new goal sends the loop on like a resume: an autonomous run that handed back starts afresh, and so does every chat's continuation count.
    if (state.autonomy?.handedOverAt) delete state.autonomy;
    state.autopilot.sessions = {};
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

  async resume(options: { sessionId?: string; provider?: AgentProvider; force?: boolean; focus?: string[] } = {}): Promise<void> {
    const state = this.require();
    if (options.focus) await this.setFocus(options.focus);
    if (options.provider) state.provider = options.provider;
    if (options.sessionId && !this.heartbeat(options.sessionId, options.force)) throw new Error(`Another session (${state.lock?.sessionId}) is driving this loop. Pass --force to take over.`);
    if (state.status !== 'running') state.runningSince = this.now();
    state.status = 'running';
    state.lastError = null;
    // Resuming after an autonomous run handed back starts a new run with a fresh budget.
    if (state.autonomy?.handedOverAt) delete state.autonomy;
    // The continuation cap counts what a chat did since the researcher last sent the loop on, not over the chat's whole life.
    state.autopilot.sessions = {};
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

  /**
   * Refresh the session lock; returns false when another session owns the loop.
   * A lock another session let go quiet is taken over only with `takeOver`: a
   * driver waiting on a long subagent sends no heartbeat, so a chat that merely
   * looks at the loop must not inherit it.
   */
  heartbeat(sessionId: string, force = false, takeOver = true): boolean {
    const state = this.state;
    if (!state) return true;
    const lock = state.lock;
    if (lock && lock.sessionId !== sessionId && !force) {
      const age = Date.now() - Date.parse(lock.heartbeatAt);
      if (!takeOver || (Number.isFinite(age) && age < LOCK_TTL_MS)) return false;
    }
    state.lock = { sessionId, provider: state.provider, acquiredAt: lock?.sessionId === sessionId ? lock.acquiredAt : this.now(), heartbeatAt: this.now() };
    return true;
  }

  /** A teaching chat may have taken an idle loop's lock before the hooks knew what it was; it gives the lock back. */
  async releaseLock(sessionId: string): Promise<void> {
    if (this.state?.lock?.sessionId !== sessionId) return;
    this.state.lock = undefined;
    await this.save();
  }

  async touch(sessionId?: string, force = false, takeOver = true): Promise<boolean> {
    if (!this.state) return true;
    const ok = sessionId ? this.heartbeat(sessionId, force, takeOver) : true;
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

  private async record(kind: Exclude<ApprovalRecord['kind'], 'routes'>, target: string, raw: string, source: string): Promise<void> {
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

  // ---------- imported packages ----------

  async packageLock(alias: string): Promise<PackageLock> {
    const file = lockPath(this.paths.library, alias);
    return parseLock(await this.files.readFile(file), file);
  }

  /** The alias of the imported package a result belongs to, if any. */
  private async importedPackageOf(kind: ResultKind, id: string): Promise<string | undefined> {
    const file = await findNodeFile(this.files, this.paths, kind, id);
    const location = file ? locateNodeFile(file, this.paths) : undefined;
    if (location?.origin !== 'library' || !location.collection) return undefined;
    return await this.files.exists(lockPath(this.paths.library, location.collection)) ? location.collection : undefined;
  }

  private async packageReason(alias: string): Promise<string> {
    const lock = await this.packageLock(alias).catch(() => undefined);
    if (!lock) return `Imported package ${alias}: accept it once to use its results as known.`;
    const count = Object.keys(lock.nodes).length;
    return `Imported package ${lock.package} ${lock.version} (${count} result${count === 1 ? '' : 's'} and definition${count === 1 ? '' : 's'} in ${this.paths.library}/${alias}): accept it once to use them as known.`;
  }

  private async packageProblemsFor(alias: string): Promise<string[]> {
    const prefix = `${this.paths.library}/${alias}/`;
    return (await packageProblemsIn(this.files, this.paths)).filter((problem) => problem.startsWith(prefix));
  }

  /** Whether an imported package is accepted, and which of its results its record does not (or no longer) cover. */
  async packageStatus(alias: string): Promise<{ approved: boolean; pending: string[]; version?: string; approvedVersion?: string }> {
    const lock = await this.packageLock(alias);
    const records = (await this.approvals()).records;
    const record = records.find((item) => item.kind === 'package' && item.target === alias);
    const pending: string[] = [];
    for (const [id, node] of Object.entries(lock.nodes)) {
      const raw = await this.files.readFile(vendoredPath(this.paths.library, alias, node.kind, id)).catch(() => '');
      let status: unknown;
      try { status = raw ? parseMarkdown(raw).data.status : undefined; } catch { status = undefined; }
      if (!raw || status !== 'approved' || !isApproved(records, node.kind, id, raw)) pending.push(id);
    }
    return { approved: !pending.length, pending, version: lock.version, ...(record?.version ? { approvedVersion: record.version } : {}) };
  }

  /**
   * The researcher accepts an imported package: every result in it becomes
   * approved under one record holding each result's digests. Only the
   * extension (a human click), the researcher's terminal, or auto mode calls this.
   */
  async approvePackage(alias: string, source: string): Promise<string[]> {
    const lock = await this.packageLock(alias);
    const problems = await this.packageProblemsFor(alias);
    if (problems.length) throw new Error(`Cannot accept package ${alias}; it no longer matches its lockfile:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    const nodes: Record<string, PackageApprovalNode> = {};
    for (const [id, node] of Object.entries(lock.nodes)) {
      const file = vendoredPath(this.paths.library, alias, node.kind, id);
      const parsed = parseMarkdown(await this.files.readFile(file));
      if (parsed.data.status !== 'approved') {
        parsed.data.status = 'approved';
        await this.writeOwned(file, stringifyMarkdown(parsed.content, parsed.data));
      }
      const raw = await this.files.readFile(file);
      nodes[id] = { digest: researchDigest(raw, node.kind), statement: statementDigest(raw) };
    }
    const file = await this.approvals();
    // The package record replaces earlier ones and any per-result records of its results.
    file.records = file.records.filter((record) => !(record.kind === 'package' && record.target === alias) && !((record.kind === 'asset' || record.kind === 'definition') && lock.nodes[record.target]));
    const provenance = await this.provenance();
    file.records.push({
      kind: 'package', target: alias, digest: lock.digest, approvedAt: provenance.created_at, source, performed_by: provenance.performed_by,
      ...(provenance.base_commit ? { base_commit: provenance.base_commit } : {}), ...(provenance.extension_version ? { extension_version: provenance.extension_version } : {}),
      package: lock.package, version: lock.version, nodes,
    });
    await this.writeApprovals(file);
    const ids = Object.keys(lock.nodes);
    if (this.state) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => !(item.kind === 'package' && item.target === alias) && !ids.includes(item.target));
      await this.save();
    }
    if (source !== 'auto') for (const [id, node] of Object.entries(lock.nodes)) await this.clearHold(node.kind, id);
    await this.event('approved', { kind: 'package', target: alias, source, version: lock.version });
    return ids;
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
      // A package record stops covering the changed result; the rest of the package stays approved.
      for (const record of approvals.records) if (record.kind === 'package' && record.nodes?.[id]) delete record.nodes[id];
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
      const record = approvalRecordOf(approvals.records, node.kind, id);
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
        if (await this.isConstructionSearch(assetId) || await this.willRoute(assetId)) await this.setStage('select', { assetId: undefined });
        else await this.setStage('plan', { assetId, planId: undefined });
      } else {
        const construct = await this.isConstructionSearch(assetId);
        // With "retry", the agent gets one new approach of its own per stuck episode; a second time it is set aside.
        if ((await this.loopSettings()).rigor.whenStuck === 'retry' && latestDirection(await this.decisions(), assetId)?.reason !== 'agent_retry') {
          const searchRound = construct ? (await this.searchProgressFor(assetId)).lastRound : undefined;
          await this.writeDecision('direction', assetId, 'No direction from the researcher. Try one genuinely different approach of your own, unlike every failed one; if it fails too, the result is set aside.', { reason: 'agent_retry', failedPlansAtDirection: await this.failedPlans(assetId), searchRound });
          delete state.parked[assetId];
          await this.event('agent_retry', { assetId });
          if (construct || await this.willRoute(assetId)) await this.setStage('select', { assetId: undefined });
          else await this.setStage('plan', { assetId, planId: undefined });
          return;
        }
        if (construct) await this.park(assetId, 'search_exhausted', 'no new direction from the researcher');
        else await this.park(assetId, 'three_failures', 'no new direction from the researcher');
        await this.setStage('select');
      }
    } else if (question.kind === 'routes' && assetId) {
      // Each route the researcher names becomes one of their approach ideas; a round gives each its own slot.
      if (decision === 'answer') for (const part of splitRoutes(text)) await this.saveIdea(`Route to ${assetId}: ${part.length > 60 ? `${part.slice(0, 57)}...` : part}`, part, [assetId], 'researcher', ['route'], 'approach');
      if (state.researcherInput?.kind === 'routes') state.researcherInput = undefined;
      await this.save();
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
    // A result of an imported package is reviewed with its package, once.
    if (kind === 'asset' || kind === 'definition' || kind === 'citation') {
      const alias = await this.importedPackageOf(kind === 'definition' ? 'definition' : 'asset', target);
      if (alias) return this.enqueueApproval('package', alias, await this.packageReason(alias));
    }
    const state = this.require();
    let digest: string;
    if (kind === 'package') {
      digest = (await this.packageLock(target).catch(() => undefined))?.digest ?? '';
    } else if (kind === 'routes') {
      digest = await this.routeMapDigestFor(target);
    } else {
      const raw = kind === 'project' ? await this.files.readFile(this.paths.projectMd).catch(() => '') : await this.files.readFile(await this.nodeFile(kind === 'definition' ? 'definition' : 'asset', target)).catch(() => '');
      digest = raw ? approvalDigest(raw, kind === 'project' ? 'project' : kind === 'definition' ? 'definition' : kind === 'specification' ? 'specification' : 'asset') : '';
    }
    const existing = state.approvalQueue.find((item) => item.kind === kind && item.target === target);
    if (existing?.digest === digest) return existing;
    // The researcher reviews with the independent check's verdict on this version, when there is one.
    reason = withCheckNote(reason, await this.verdictNote(kind, target));
    if (existing) {
      existing.digest = digest; existing.reason = reason; existing.requestedAt = this.now(); await this.save();
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
    else if (request.kind === 'routes') { if (state.researcherInput?.kind === `changes:routes:${request.target}`) state.researcherInput = undefined; await this.rejectRouteMap(request.target, text); }
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
    else if (request.kind === 'package') await this.approvePackage(request.target, source);
    else if (request.kind === 'routes') await this.approveRouteMap(request.target, source);
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
    if (kind === 'package') return (await this.packageStatus(target)).approved;
    if (kind === 'routes') return this.routeMapApproved(target);
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
        // autoRule grants a held request only when the agent's re-check lifts the hold.
        if ((request.kind === 'asset' || request.kind === 'definition') && (await this.holds())[`${request.kind}:${request.target}`]) await this.clearRecheckByAgent(request.target, request.kind);
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
    if (request.kind === 'package') {
      // A package holds known results, which auto mode treats like citations; only an intact package of the requested version.
      if (!policy.citations) return undefined;
      const lock = await this.packageLock(request.target).catch(() => undefined);
      return lock && lock.digest === request.digest && !(await this.packageProblemsFor(request.target)).length ? 'citations' : undefined;
    }
    if (request.kind === 'routes') {
      // Judged from the routes as they stand: only the map version the request names.
      if (!policy.routes) return undefined;
      return request.digest === await this.routeMapDigestFor(request.target) ? 'routes' : undefined;
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
    // Held because something it rests on changed: the agent's re-check against the current dependencies may lift it.
    if (hold && !(isLiftableHold(hold.reason) && await this.holdLifted(kind, request.target, raw, data, file, policy, hold.at))) {
      const note = ` (auto mode: needs your review — ${hold.reason.replace(/_/g, ' ')})`;
      const queued = this.state?.approvalQueue.find((item) => item.id === request.id);
      if (queued && !queued.reason.endsWith(note)) { queued.reason += note; await this.save(); }
      return undefined;
    }
    if (kind === 'definition') return policy.definitions && await this.nodeChecked({ id: request.target, mode: 'definition' }, raw) ? 'definitions' : undefined;
    if (data.type === 'example' && typeof data.refutes === 'string') {
      if (request.kind !== 'counterexample' || !policy.counterexamples) return undefined;
      // Only the verdict's leading word decides; its explanation may say "rejection" or "not confirmed" of other things.
      return verdictOutcome(sectionContent(parsed.content, 'Verdict')) === 'confirmed' ? 'counterexamples' : undefined;
    }
    if (request.kind === 'counterexample') return undefined;
    if (locateNodeFile(file, this.paths)?.origin === 'library') return policy.citations && await this.nodeChecked({ id: request.target, mode: 'citation' }, raw) ? 'citations' : undefined;
    if (isCited(data.source)) {
      const source = data.source as { paper_id?: unknown; location?: unknown };
      const indexed = typeof source.paper_id === 'string' && (await this.paperIds()).has(source.paper_id);
      return policy.citations && indexed && typeof source.location === 'string' && source.location.trim() && await this.nodeChecked({ id: request.target, mode: 'citation' }, raw) ? 'citations' : undefined;
    }
    // A citation request for a result that cites nothing is not a citation.
    if (request.kind === 'citation') return undefined;
    if (data.type === CONJECTURE_TYPE) {
      // An agreed statement, not a proof: only once a counterexample search found nothing, unless the researcher turned that search off.
      if (!policy.conjectures) return undefined;
      const searched = this.isFalsified(request.target, raw, await this.checks());
      return searched || (await this.loopSettings()).rigor.refuteSearch !== 'all' ? 'conjectures' : undefined;
    }
    if (!PROVABLE_TYPES.has(data.type)) return policy.supporting ? 'supporting' : undefined;
    if (!policy.proofs) return undefined;
    return (await this.proofIsVouched(request.target, raw, parsed)) || (await this.constructionIsVouched(request.target, raw, parsed)) ? 'proofs' : undefined;
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
      && (verifyProofs !== 'agent' || plan.data.verified_proof_digest === proof))
      // A proof no plan of the loop wrote (the researcher's manuscript, say), checked independently as written against these dependencies.
      || await this.nodeChecked({ id: assetId, mode: 'proof' }, raw);
    if (!vouched) return false;
    return this.dependenciesApproved(parsed.data);
  }

  /** A proof a search construction wrote, after its independent check, and unchanged since. */
  private async constructionIsVouched(assetId: string, raw: string, parsed: matter.GrayMatterFile<string>): Promise<boolean> {
    const progress = this.state?.progress[assetId];
    if (!proofText(parsed.content) || progress?.changesRequested || progress?.constructionProof !== proofDigest(raw)) return false;
    if ((await this.loopSettings()).rigor.verifyProofs === 'researcher') return false;
    return this.dependenciesApproved(parsed.data);
  }

  /** Every result in depends_on and every definition in uses_definitions is approved as it stands now. */
  private async dependenciesApproved(data: Record<string, any>): Promise<boolean> {
    const records = (await this.approvals()).records;
    const refs: Array<[ResultKind, string]> = [
      ...(Array.isArray(data.depends_on) ? data.depends_on as string[] : []).map((id): [ResultKind, string] => ['asset', id]),
      ...(Array.isArray(data.uses_definitions) ? data.uses_definitions as string[] : []).map((id): [ResultKind, string] => ['definition', id]),
    ];
    for (const [kind, id] of refs) {
      const raw = await this.files.readFile(await this.nodeFile(kind, id)).catch(() => '');
      if (!raw || !isApproved(records, kind, id, raw)) return false;
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

  /** Set the researcher's focus to required results (none clears it); returns the focus now. */
  async setFocus(ids: string[]): Promise<string[]> {
    const state = this.require();
    const required = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => ''));
    const unknown = ids.filter((id) => !required.includes(id));
    if (unknown.length) throw new Error(`The focus can only name required results; not under required_results: ${unknown.join(', ')}.`);
    if (ids.length) state.focus = [...new Set(ids)]; else delete state.focus;
    await this.save();
    await this.event('focus_set', { ids: state.focus ?? [] });
    return state.focus ?? [];
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
    // A direction also restarts the count of rounds of routes, as it does for failed plans and search rounds.
    if (kind === 'direction' && extra.routeRound === undefined) {
      const last = await this.lastRouteRound(target);
      if (last) extra = { ...extra, routeRound: last };
    }
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
    // An idea a round already took up stays tried even after the statement changes: its outcome is on the board instead.
    const { candidates: allCandidates, rounds: allRounds } = await this.searchRecords();
    const everTried = new Set([...allRounds.filter((item) => item.target === assetId).flatMap((item) => item.directions), ...allCandidates.filter((item) => item.target === assetId).map((item) => item.direction ?? '')]);
    // Tried is per result: a test case tried for another result is still open for this one.
    const ideas = [...(await this.collect(this.paths.ideas)).values()]
      .filter((idea) => idea.data.idea_kind === 'test_case' && idea.data.status !== 'archived' && Array.isArray(idea.data.related_assets) && idea.data.related_assets.includes(assetId) && !everTried.has(idea.id) && !triedRecords(idea.data).some((record) => record.target === assetId))
      .map((idea) => ({ id: idea.id, title: String(idea.data.title ?? idea.id), origin: typeof idea.data.origin === 'string' ? idea.data.origin : undefined }));
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

  // ---------- the researcher's own results: intake and repair ----------

  /** Whether the researcher asked the loop to fill the gaps in their own proof of this result. */
  private async repairConsent(assetId: string, decisions?: DecisionInfo[]): Promise<boolean> {
    return (decisions ?? await this.decisions()).some((item) => item.kind === 'repair_request' && item.target === assetId);
  }

  /**
   * What a result whose proof the researcher asked the loop to complete needs next: a check of the
   * proof as written when this version has none, a repair plan when the check found a gap. A proof a
   * loop plan wrote (a repair among them) goes the usual way, and so does one the check confirmed.
   */
  private async repairWork(assetId: string, raw: string, decisions?: DecisionInfo[]): Promise<Selection | undefined> {
    if (!(await this.repairConsent(assetId, decisions))) return undefined;
    let content: string;
    try { content = parseMarkdown(raw).content; } catch { return undefined; }
    if (!proofText(content) || (await this.vouchingPlans(assetId, raw)).length) return undefined;
    const verdict = await this.nodeVerdict({ id: assetId, mode: 'proof' }, raw);
    if (!verdict) return { stage: 'verify_node', node: { id: assetId, mode: 'proof' } };
    if (verdict.reason !== 'rejected') return undefined;
    return { stage: 'plan', assetId, repair: verdict.text.trim() || 'the independent check rejected the proof as written.' };
  }

  /** The gap a pending repair plan closes, or undefined for any other plan. */
  private async repairGapOf(planId: string): Promise<string | undefined> {
    try {
      const plan = parseMarkdown(await this.files.readFile(`${this.paths.plans}/${planId}.md`));
      return plan.data.purpose === 'repair' ? sectionContent(plan.content, 'Gap') || 'see ## Gap in the plan.' : undefined;
    } catch { return undefined; }
  }

  /** A plan written to repair the researcher's proof keeps that proof as written, and the gap it closes. */
  private async markRepairPlan(planId: string, assetRaw: string, gap: string): Promise<void> {
    const file = `${this.paths.plans}/${planId}.md`;
    const plan = parseMarkdown(await this.files.readFile(file));
    const previous = stripManagedBlocks(sectionContent(parseMarkdown(assetRaw).content, 'Proof')).trim();
    let content = plan.content.trimEnd();
    if (!hasSection(content, 'Gap')) content += `\n\n## Gap\n\n${gap}`;
    if (!hasSection(content, 'Previous proof')) content += `\n\n## Previous proof\n\n${previous}`;
    await this.writeOwned(file, stringifyMarkdown(`${content}\n`, { ...plan.data, purpose: 'repair', repairs_proof_digest: proofDigest(assetRaw) }));
  }

  /** A failed repair leaves the researcher's proof as they wrote it, for the next attempt to start from. */
  private async restoreRepairedProof(assetId: string, planContent: string): Promise<void> {
    const previous = sectionContent(planContent, 'Previous proof');
    if (!previous) return;
    const file = `${this.paths.assets}/${assetId}.md`;
    const asset = parseMarkdown(await this.files.readFile(file));
    if (stripManagedBlocks(sectionContent(asset.content, 'Proof')).trim() === previous.trim()) return;
    await this.writeOwned(file, stringifyMarkdown(withProof(asset.content, previous), asset.data));
  }

  /**
   * The researcher asks the loop to complete their own proofs of these results: each is checked as
   * written, and a gap the check finds is repaired by a plan that keeps the rest of their argument.
   * Never automatic: the agent runs this only when the researcher asks. Returns the message for the agent.
   */
  async requestRepair(ids: string[]): Promise<string> {
    const asked: string[] = [];
    const skipped: string[] = [];
    for (const id of [...new Set(ids)]) {
      const file = await findNodeFile(this.files, this.paths, 'asset', id);
      const raw = file ? await this.files.readFile(file).catch(() => '') : '';
      let data: Record<string, any> = {};
      try { data = raw ? parseMarkdown(raw).data : {}; } catch { data = {}; }
      if (!file || !raw || isLibraryPath(file, this.paths)) { skipped.push(`${id} (no such result in the project)`); continue; }
      if (data.status !== 'draft' || !PROVABLE_TYPES.has(data.type) || isCited(data.source)) { skipped.push(`${id} (not a draft result the loop proves)`); continue; }
      if (await this.repairConsent(id)) { asked.push(id); continue; }
      await this.writeDecision('repair_request', id, `The researcher asked the loop to check their proof of ${id} and fill the gaps the check finds, keeping the rest of their argument.`);
      await this.event('repair_requested', { assetId: id });
      asked.push(id);
    }
    if (!asked.length) throw new Error(`Nothing to repair: ${skipped.join('; ')}.`);
    return `The loop will check ${asked.join(', ')} as written and repair the gaps it finds${skipped.length ? `; skipped ${skipped.join('; ')}` : ''}.`;
  }

  /**
   * Where the researcher's own results stand: per node, whether an independent check confirmed it,
   * found a gap, or has not run, and which results have no proof yet; and the main results among
   * them (those no other result of the set rests on), which become the goals of an intake.
   */
  async intakeReport(ids: string[]): Promise<IntakeReport> {
    const report: IntakeReport = { main: [], titles: {}, confirmed: [], gaps: [], unproved: [], unchecked: [], other: [] };
    const assets = await this.collectKind('asset');
    const unique = [...new Set(ids)];
    const provable = unique.filter((id) => assets.has(id) && !assets.get(id)!.origin && PROVABLE_TYPES.has(assets.get(id)!.data.type) && !INACTIVE_STATUSES.has(assets.get(id)!.data.status));
    const used = new Set(provable.flatMap((id) => Array.isArray(assets.get(id)!.data.depends_on) ? assets.get(id)!.data.depends_on as string[] : []));
    report.main = provable.filter((id) => !used.has(id));
    if (!report.main.length) report.main = provable;
    for (const id of unique) {
      const { node, raw, skip } = await this.checkTargetOf(id);
      const title = (() => { try { return String(parseMarkdown(raw).data.title ?? id); } catch { return id; } })();
      report.titles[id] = title;
      if (!node) {
        if (skip?.startsWith('no proof yet')) report.unproved.push({ id, title });
        else report.other.push({ id, title, why: skip ?? 'nothing to check' });
        continue;
      }
      const verdict = await this.currentVerdict(node, raw);
      if (!verdict) report.unchecked.push({ id, title, mode: node.mode });
      else if (verdict.reason === 'rejected') report.gaps.push({ id, title, mode: node.mode, summary: verdict.text.trim() });
      else report.confirmed.push({ id, title, mode: node.mode });
    }
    return report;
  }

  /**
   * Close every intake whose results are all settled (approved, set aside, or retired) once the
   * goals are approved: a shared record with what was sound, repaired, proved, and still open, and
   * the conjectures the researcher may take up next. Returns what the agent tells the researcher.
   */
  private async closeIntakes(): Promise<string | undefined> {
    const decisions = sortDecisions(await this.decisions());
    const closed = new Set(decisions.filter((item) => item.kind === 'intake_closed').map((item) => item.target));
    const open = decisions.filter((item) => item.kind === 'intake' && !closed.has(item.id) && item.ids?.length);
    if (!open.length) return undefined;
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (!project || !(await this.isProjectApproved(project))) return undefined;
    const state = this.require();
    const records = (await this.approvals()).records;
    const assets = await this.collectKind('asset');
    const plans = await this.plans();
    const ideas = [...(await this.collect(this.paths.ideas)).values()];
    const messages: string[] = [];
    for (const intake of open) {
      const results = intake.ids!.filter((id) => assets.has(id) && !assets.get(id)!.origin && PROVABLE_TYPES.has(assets.get(id)!.data.type));
      if (!results.length) continue;
      const approved = (id: string) => assets.get(id)!.data.status === 'approved' && isApproved(records, 'asset', id, assets.get(id)!.raw);
      if (!results.every((id) => approved(id) || state.parked[id] || INACTIVE_STATUSES.has(assets.get(id)!.data.status))) continue;
      const title = (id: string) => String(assets.get(id)?.data.title ?? id);
      const vouching = (id: string) => { const digest = proofDigest(assets.get(id)!.raw); return plans.filter((plan) => plan.data.target_asset === id && plan.data.status === 'succeeded' && plan.data.proof_digest === digest); };
      const repaired = results.filter((id) => approved(id) && vouching(id).some((plan) => plan.data.purpose === 'repair'));
      const proved = results.filter((id) => approved(id) && !repaired.includes(id) && vouching(id).length > 0);
      const sound = results.filter((id) => approved(id) && !repaired.includes(id) && !proved.includes(id));
      const unresolved = results.filter((id) => !approved(id) && state.parked[id]);
      const inIntake = new Set(intake.ids);
      const conjectures = [...assets.values()].filter((asset) => asset.data.type === CONJECTURE_TYPE && ['draft', 'approved'].includes(asset.data.status)
        && (inIntake.has(asset.id) || (Array.isArray(asset.data.serves) && asset.data.serves.some((id: string) => inIntake.has(id)))));
      const conjectureIdeas = ideas.filter((idea) => idea.data.idea_kind === 'conjecture' && idea.data.status === 'draft'
        && Array.isArray(idea.data.related_assets) && idea.data.related_assets.some((id: string) => inIntake.has(id)));
      const candidates = [...conjectures.map((item) => item.id), ...conjectureIdeas.map((item) => item.id)];
      const named = (ids: string[]) => ids.map(title).join('; ');
      const lines = [
        sound.length ? `Sound as written: ${named(sound)}.` : '',
        repaired.length ? `Repaired where the check found a gap: ${named(repaired)}.` : '',
        proved.length ? `Proved here: ${named(proved)}.` : '',
        unresolved.length ? `Still open: ${unresolved.map((id) => `${title(id)}${state.parked[id]?.note ? ` (${state.parked[id].note})` : ''}`).join('; ')}.` : '',
      ].filter(Boolean);
      await this.writeDecision('intake_closed', intake.id, lines.join('\n'), { ids: requiredAssetIds(project), candidates });
      await this.event('intake_closed', { intake: intake.id, sound: sound.length, repaired: repaired.length, proved: proved.length, open: unresolved.length });
      const offer = candidates.length
        ? `conjectures from their work: ${candidates.map((id) => `${String((assets.get(id) ?? ideas.find((idea) => idea.id === id))?.data.title ?? id)} (${id})`).join('; ')}, or a goal of their own`
        : 'a goal of their own';
      messages.push(`The researcher's results${intake.source ? ` from ${intake.source}` : ''} are settled. ${lines.join(' ')} Tell the researcher in a few lines, then offer a new research goal: ${offer}. On their choice run ${LOOP_COMMAND} extend --goal "..." (for a conjecture: --goal "Take up the conjecture <id>", then promote it in draft_project).`);
    }
    return messages.length ? messages.join('\n\n') : undefined;
  }

  /**
   * Take the researcher's own results into the loop (`start --intake`): the loop drafts the goals
   * from their main results, then checks each proof as written and repairs the gaps, as the
   * researcher asked. Starts the loop, or extends a running or approved one.
   */
  async intake(ids: string[], options: { provider: AgentProvider; sessionId?: string; force?: boolean; source?: string }): Promise<LoopState> {
    const report = await this.intakeReport(ids);
    if (!report.main.length) throw new Error(`None of ${ids.join(', ')} is a draft result of this project the loop could prove; extract the researcher's results first.`);
    const proved = [...report.confirmed, ...report.gaps, ...report.unchecked].filter((item) => item.mode === 'proof').map((item) => item.id);
    if (proved.length) await this.requestRepair(proved);
    const line = (items: Array<{ id: string; title: string }>) => items.map((item) => `${item.title} (${item.id})`).join('; ');
    const goal = [
      `Complete and verify the researcher's own results${options.source ? ` from ${options.source}` : ''}.`,
      `Main results, to list under required_results: ${line(report.main.map((id) => ({ id, title: report.titles[id] ?? id })))}.`,
      report.gaps.length ? `Gaps the independent checks found: ${report.gaps.map((item) => `${item.title} (${item.id}): ${item.summary.split('\n')[0].replace(/[.\s]+$/, '')}`).join('; ')}.` : '',
      report.unproved.length ? `Without a proof yet: ${line(report.unproved)}.` : '',
      report.unchecked.length ? `Not checked yet (the loop checks them): ${line(report.unchecked)}.` : '',
    ].filter(Boolean).join('\n');
    const state = this.state && this.state.status !== 'stopped' && this.state.status !== 'idle' && !options.force
      ? await this.extend(goal, { provider: options.provider, sessionId: options.sessionId, inputKind: 'intake' })
      : await this.start(options.provider, { goal, sessionId: options.sessionId, force: options.force, inputKind: 'intake' });
    const current = this.require();
    const taken = [...new Set(ids)];
    // Shared, so collaborators' dashboards show the same repair, and the loop knows when it is settled.
    const decision = await this.writeDecision('intake', options.source ?? 'upload', goal, { ids: taken, main: report.main, ...(options.source ? { source: options.source } : {}) });
    current.intake = { ids: taken, main: report.main, ...(options.source ? { source: options.source } : {}), at: this.now(), decision };
    await this.save();
    await this.event('intake', { ids: current.intake.ids, main: report.main, gaps: report.gaps.map((item) => item.id) });
    return state;
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
    const conjecture = data.type === CONJECTURE_TYPE && ['draft', 'approved'].includes(data.status);
    if (!conjecture && (data.status !== 'draft' || !PROVABLE_TYPES.has(data.type))) throw new Error(`${assetId} is not a draft theorem, lemma, proposition, or construction, nor a conjecture; there is nothing to refute.`);
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
    const { triedIdeas, observations } = await this.boardIdeas(assetId, progress);
    return renderBoard(progress, { mode: searchMode, target: assetId, round: round ?? progress.lastRound + 1, obstructions: settings.boardObstructions, nearMisses: settings.boardNearMisses, properties, triedIdeas, observations });
  }

  /**
   * The board's memory of ideas: test cases a round already tried (what came of each, also under an older
   * statement) and open observations on the asset. Ideas a round took up before the loop recorded outcomes
   * show the candidates written in their direction.
   */
  private async boardIdeas(assetId: string, progress: SearchProgress): Promise<{ triedIdeas: TriedIdea[]; observations: Array<{ id: string; title: string }> }> {
    const digest = statementDigest(await this.files.readFile(`${this.paths.assets}/${assetId}.md`));
    const ideas = [...(await this.collect(this.paths.ideas)).values()];
    const related = (idea: { data: Record<string, any> }) => Array.isArray(idea.data.related_assets) && idea.data.related_assets.includes(assetId);
    const triedIdeas: TriedIdea[] = [];
    for (const idea of ideas) {
      if (idea.data.idea_kind !== 'test_case') continue;
      const record = triedRecords(idea.data).filter((item) => item.target === assetId).pop();
      const title = String(idea.data.title ?? idea.id);
      if (record) {
        triedIdeas.push({ id: idea.id, title, round: typeof record.round === 'number' ? record.round : undefined, outcome: String(record.outcome ?? 'tried'), earlier: record.statement_digest !== digest });
      } else if (related(idea) && progress.directionsTried.includes(idea.id)) {
        const written = progress.candidates.filter((item) => item.direction === idea.id);
        triedIdeas.push({ id: idea.id, title, round: written[0]?.round ?? progress.rounds.find((item) => item.directions.includes(idea.id))?.round, outcome: triedOutcome(written, idea.id) });
      }
    }
    triedIdeas.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id));
    const observations = ideas.filter((idea) => idea.data.idea_kind === 'observation' && idea.data.status === 'draft' && related(idea)).map((idea) => ({ id: idea.id, title: String(idea.data.title ?? idea.id) }));
    return { triedIdeas, observations };
  }

  /**
   * A round took up test-case ideas as directions: each records what came of it for this result, so
   * no later round for this result assigns it again and the board shows the outcome. The idea stays
   * open: a search on another result it relates to still tries it.
   */
  private async closeTriedIdeas(assetId: string, search: SearchRound, digest: string): Promise<void> {
    const progress = await this.searchProgressFor(assetId);
    for (const slot of search.slots) {
      const file = `${this.paths.ideas}/${slot.direction}.md`;
      const raw = await this.files.readFile(file).catch(() => '');
      if (!raw) continue;
      const parsed = parseMarkdown(raw);
      if (parsed.data.type !== 'idea' || parsed.data.status === 'archived') continue;
      const records = triedRecords(parsed.data);
      if (records.some((record) => record.target === assetId && record.round === search.round)) continue;
      const written = progress.candidates.filter((item) => item.round === search.round && item.slot === slot.slot);
      const outcome = triedOutcome(written, slot.direction);
      parsed.data.tried_in = [...records, { target: assetId, round: search.round, slot: slot.slot, statement_digest: digest, outcome }];
      await this.writeOwned(file, stringifyMarkdown(appendToSection(parsed.content, 'Tried', `- Search round ${search.round} for ${assetId} (slot ${slot.slot}): ${outcome}`), parsed.data));
      await this.event('idea_tried', { ideaId: slot.direction, assetId, round: search.round, outcome });
    }
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
    const written = stringifyMarkdown(content, parsed.data);
    await this.writeOwned(file, written);
    // The independent check vouches for this proof, as a verified plan does, so auto mode may approve it.
    const state = this.require();
    state.progress[assetId] = { ...state.progress[assetId], constructionProof: proofDigest(written) };
    await this.save();
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
    if (await this.isConjecture(assetId)) {
      this.dropConjectureRequest(assetId);
      return finish(`No counterexample found for the conjecture ${assetId} in ${search.round} round(s); its statement goes to the researcher to agree on. Continue with next.`, 'select', { assetId: undefined, counterexampleId: undefined });
    }
    const [nextStage, patch] = await this.afterSurvived(assetId);
    return finish(`No counterexample found for ${assetId} in ${search.round} round(s). Next: ${nextStage === 'plan' ? 'plan' : 'its routes; continue with next'}.`, nextStage, patch);
  }

  private async isConjecture(assetId: string): Promise<boolean> {
    const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
    try { return Boolean(raw) && parseMarkdown(raw).data.type === CONJECTURE_TYPE; } catch { return false; }
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
    // A promoted copy is this project's own draft: it no longer stands for a node of an imported package.
    delete parsed.data.imported_from;
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

  // ---------- remarks ----------

  /** Remarks on results (see domain/remarks.ts); outside the stage change set, so writing one never disturbs a stage. */
  remarks(): Remarks { return new Remarks(this.files, this.paths); }

  /** Add a remark; one the loop writes must be on the result it is working on. */
  /** Add a remark; one the loop writes must be on the result it is working on. `link` is the chat link to it (it opens the result's dashboard page). */
  async addRemark(input: RemarkInput): Promise<Remark & { link: string }> {
    const state = this.state;
    const remarks = this.remarks();
    const remark = await remarks.add(input, { at: this.now(), loop: { running: state?.status === 'running', assetId: state?.current.assetId, stageStartedAt: state?.current.stageStartedAt } });
    await this.event('remark_added', { assetId: input.target, remarkId: remark.id, origin: input.origin, from: input.from });
    return { ...remark, link: await remarks.link(remark) };
  }

  async editRemark(id: string, changes: { title?: string; body?: string; anchor?: string }, by: RemarkFrom): Promise<Remark> {
    const remark = await this.remarks().edit(id, changes, by, this.now());
    await this.event('remark_edited', { assetId: remark.target, remarkId: id, from: by });
    return remark;
  }

  /**
   * The researcher agrees a remark may appear in the paper, as written. Only the
   * extension calls this (a click in the dashboard); an edit afterwards needs a
   * new approval. It approves the remark's text, never a result.
   */
  async approveRemark(id: string, source: string): Promise<void> {
    let remark = await this.remarks().get(id);
    if (remark.status !== 'active') throw new Error(`${id} is archived; restore it before approving it for the paper.`);
    // Approving a remark for the paper means the researcher read it: an agent's counts as checked too.
    if (!isRemarkChecked(remark)) remark = await this.remarks().check(id, this.now());
    await this.record('remark', id, await this.files.readFile(remark.file), source);
    await this.event('remark_approved', { assetId: remark.target, remarkId: id, source });
  }

  /** The researcher read an agent's remark and agrees with it as worded now (the dashboard only). An edit afterwards unchecks it. */
  async checkRemark(id: string, source: string): Promise<void> {
    const remark = await this.remarks().check(id, this.now());
    await this.event('remark_checked', { assetId: remark.target, remarkId: id, source });
  }

  /** Remark files that are malformed or name no target, and nodes whose relations name a remark. */
  private async remarkProblems(targets: ReadonlySet<string>): Promise<string[]> {
    const remarks = this.remarks();
    const problems = await remarks.problems(targets);
    const ids = new Set((await remarks.all()).map((remark) => remark.id));
    if (!ids.size) return problems;
    for (const kind of ['asset', 'definition'] as const) {
      for (const file of await listNodeFiles(this.files, this.paths, kind)) {
        try { problems.push(...remarkReferenceProblems(file, parseMarkdown(await this.files.readFile(file)).data, ids)); } catch { /* reported elsewhere */ }
      }
    }
    for (const folder of [this.paths.ideas, this.paths.plans]) {
      for (const file of await this.files.listFiles(folder)) {
        try { problems.push(...remarkReferenceProblems(file, parseMarkdown(await this.files.readFile(file)).data, ids)); } catch { /* reported elsewhere */ }
      }
    }
    return problems;
  }

  async restoreRemark(id: string, by: RemarkFrom): Promise<Remark> {
    const remark = await this.remarks().restore(id, by, this.now());
    await this.event('remark_restored', { assetId: remark.target, remarkId: id, from: by });
    return remark;
  }

  async archiveRemark(id: string, by: RemarkFrom): Promise<Remark> {
    const remark = await this.remarks().archive(id, by, this.now());
    await this.event('remark_archived', { assetId: remark.target, remarkId: id, from: by });
    return remark;
  }

  // ---------- ideas ----------

  async saveIdea(title: string, body: string, relatedAssets: string[], origin: 'researcher' | 'agent' = 'agent', tags: string[] = [], ideaKind: IdeaKind = 'approach', extra: Record<string, string> = {}): Promise<string> {
    if (!body.trim()) throw new Error('Idea text is required.');
    const assetIds = new Set((await this.files.listFiles(this.paths.assets)).map((file) => path.posix.basename(file, '.md')));
    for (const asset of relatedAssets) if (!assetIds.has(asset)) throw new Error(`Unknown related asset: ${asset}`);
    const raw = stringifyMarkdown(`\n${body.trim()}\n`, { type: 'idea', title: title.trim() || 'Untitled idea', status: 'draft', idea_kind: ideaKind, origin, related_assets: relatedAssets, tags, ...extra });
    // A retried call (a client timeout, a transport resend) must not save the idea twice: the same idea saved moments ago is that save.
    const since = new Date(Date.parse(this.now()) - IDEA_RETRY_WINDOW_MS).toISOString();
    for (const event of (await this.recentEvents(50, (item) => item.type === 'idea_saved' && String(item.at ?? '') >= since)).reverse()) {
      const earlier = `${this.paths.ideas}/${String(event.ideaId)}.md`;
      if (await this.files.readFile(earlier).catch(() => '') === raw) { await this.event('idea_repeated', { ideaId: event.ideaId }); return String(event.ideaId); }
    }
    const ideaId = `idea_${this.id().replace(/-/g, '').slice(0, 12)}`;
    await this.files.writeFile(`${this.paths.ideas}/${ideaId}.md`, raw);
    await this.event('idea_saved', { ideaId, relatedAssets, origin });
    return ideaId;
  }

  /**
   * Write a pending plan from an idea. The plan lists the idea in `inspired_by`; the idea itself is
   * not changed, so it stays open for other results (where it was used is derived from the plans).
   */
  async convertIdea(ideaId: string, assetId: string, goal: string, steps: string, verification: string): Promise<string> {
    const ideaRaw = await this.files.readFile(`${this.paths.ideas}/${ideaId}.md`);
    const idea = parseMarkdown(ideaRaw).data;
    if (idea.type !== 'idea') throw new Error('Source must be an idea.');
    if (idea.status === 'refuted') throw new Error(`${ideaId} was refuted (see its ## Refutation); a plan cannot rest on it.`);
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

  /**
   * Mark an idea resolved by a decision or an asset; the idea itself is kept. A plan never resolves
   * an approach or observation (it uses it, and other results may too), and a test case is never
   * resolved (where it was tried is recorded per result).
   */
  async resolveIdea(ideaId: string, resolvedBy: string, note?: string): Promise<void> {
    const file = `${this.paths.ideas}/${ideaId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    if (parsed.data.type !== 'idea') throw new Error(`${ideaId} is not an idea.`);
    if (parsed.data.status === 'resolved' && parsed.data.resolved_by === resolvedBy) return;
    const kind = toIdeaKind(parsed.data.idea_kind);
    if (kind === 'test_case') throw new Error(`${ideaId} is a test case: each search round records where it was tried, and it stays open for the other results it relates to. Archive it to drop it.`);
    if (REUSABLE_IDEA_KINDS.has(kind) && await this.files.exists(`${this.paths.plans}/${resolvedBy}.md`)) {
      throw new Error(`A plan uses the ${kind} ${ideaId} without using it up: list it in the plan's inspired_by, and it stays open for other results. ${kind === 'observation' ? 'To settle it, promote it to a lemma (idea promote) or refute it (idea refute).' : 'If it cannot work in general, mark it obstructed (idea obstruct).'}`);
    }
    if (kind === 'observation' && !(await findNodeFile(this.files, this.paths, 'asset', resolvedBy))) throw new Error(`An observation is resolved only by the lemma it became: use idea promote, or idea refute when it is false.`);
    parsed.data.status = 'resolved';
    parsed.data.resolved_by = resolvedBy;
    const content = note ? `${parsed.content.trimEnd()}\n\n## Resolution\n\n${note}\n` : parsed.content;
    await this.files.writeFile(file, stringifyMarkdown(content, parsed.data));
    await this.event('idea_resolved', { ideaId, resolvedBy });
  }

  /**
   * Turn an open observation (or the recurring step of an approach) into a draft lemma, so proofs
   * rely on it through depends_on rather than on an unproved idea. `into` names the results that
   * should depend on it; an approved one is refused, since a new dependency re-opens its approval,
   * which is the researcher's call. The loop proves the lemma like any other draft result.
   */
  async promoteIdea(ideaId: string, options: { id: string; statement: string; title?: string; type?: string; into?: string[]; usesDefinitions?: string[] }): Promise<{ assetId: string; into: string[] }> {
    const file = `${this.paths.ideas}/${ideaId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    if (parsed.data.type !== 'idea') throw new Error(`${ideaId} is not an idea.`);
    const kind = toIdeaKind(parsed.data.idea_kind);
    if (!REUSABLE_IDEA_KINDS.has(kind)) throw new Error(`Only an observation or an approach is promoted to a lemma; ${ideaId} is a ${kind}.`);
    if (parsed.data.status !== 'draft') throw new Error(`${ideaId} is ${parsed.data.status}; only an open idea is promoted.`);
    const type = options.type ?? 'lemma';
    if (type !== 'lemma' && type !== 'proposition') throw new Error('--type is lemma or proposition.');
    const id = options.id.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(id) || isLibraryId(id)) throw new Error(`Invalid asset ID ${id}: use lowercase letters, digits, and underscores, without the ${LIBRARY_PREFIX} prefix.`);
    if (await findNodeFile(this.files, this.paths, 'asset', id) || await findNodeFile(this.files, this.paths, 'definition', id)) throw new Error(`Node ID already exists: ${id}`);
    const statement = options.statement.trim();
    if (!statement) throw new Error('--statement is required: state precisely what the lemma claims, with its hypotheses.');
    const into = [...new Set(options.into ?? [])];
    const targets: Array<{ file: string; parsed: matter.GrayMatterFile<string> }> = [];
    for (const target of into) {
      const targetFile = await findNodeFile(this.files, this.paths, 'asset', target);
      if (!targetFile || locateNodeFile(targetFile, this.paths)?.origin === 'library') throw new Error(`Unknown project asset: ${target}`);
      const data = parseMarkdown(await this.files.readFile(targetFile));
      if (data.data.status === 'approved') throw new Error(`${target} is approved: making it depend on ${id} re-opens its approval, which is the researcher's call. Promote without --into ${target}, then ask the researcher to add the dependency.`);
      if (INACTIVE_STATUSES.has(String(data.data.status))) throw new Error(`${target} is ${String(data.data.status)}; it takes no new dependency.`);
      targets.push({ file: targetFile, parsed: data });
    }
    const uses = [...new Set(options.usesDefinitions ?? [])];
    for (const definition of uses) if (!(await findNodeFile(this.files, this.paths, 'definition', definition))) throw new Error(`Unknown definition: ${definition}`);
    const title = options.title?.trim() || String(parsed.data.title ?? id);
    await this.writeOwned(`${this.paths.assets}/${id}.md`, stringifyMarkdown(`\n## Statement\n\n${statement}\n`, { type, title, status: 'draft', source: { kind: 'original' }, depends_on: [], uses_definitions: uses, tags: [] }));
    for (const target of targets) {
      const deps = Array.isArray(target.parsed.data.depends_on) ? target.parsed.data.depends_on.map(String) : [];
      if (deps.includes(id)) continue;
      target.parsed.data.depends_on = [...deps, id];
      await this.writeOwned(target.file, stringifyMarkdown(target.parsed.content, target.parsed.data));
    }
    await this.resolveIdea(ideaId, id, `Promoted to the ${type} ${id}${into.length ? `, a dependency of ${into.join(', ')}` : ''}.`);
    await this.event('idea_promoted', { ideaId, assetId: id, into });
    return { assetId: id, into };
  }

  /**
   * Settle an idea as a warning: an observation found false (`refuted`) or an approach shown not
   * to work in general (`obstructed`; a failure on one result is a failed plan, not this). The
   * reason is kept, and similar results see it so they do not try the same thing.
   */
  async markIdea(ideaId: string, status: 'refuted' | 'obstructed', reason: string): Promise<void> {
    const file = `${this.paths.ideas}/${ideaId}.md`;
    const parsed = parseMarkdown(await this.files.readFile(file));
    if (parsed.data.type !== 'idea') throw new Error(`${ideaId} is not an idea.`);
    const kind = toIdeaKind(parsed.data.idea_kind);
    const expected = status === 'refuted' ? 'observation' : 'approach';
    if (kind !== expected) throw new Error(`Only an ${expected} is ${status}; ${ideaId} is a ${kind}.`);
    if (parsed.data.status !== 'draft') throw new Error(`${ideaId} is ${parsed.data.status}; only an open idea is ${status}.`);
    if (!reason.trim()) throw new Error(`--reason is required: ${status === 'refuted' ? 'the counterexample or the argument that it is false' : 'why the approach cannot work in general'}.`);
    parsed.data.status = status;
    await this.files.writeFile(file, stringifyMarkdown(appendToSection(parsed.content, WARNING_SECTION[status], reason.trim()), parsed.data));
    await this.event(`idea_${status}`, { ideaId });
  }

  /** Where each idea was used and which open observations should become lemmas; derived from the plans. */
  async ideaUsageReport(): Promise<string> {
    const plans = (await this.plans()).map((plan) => ({ id: plan.id, target_asset: typeof plan.data.target_asset === 'string' ? plan.data.target_asset : undefined, status: String(plan.data.status ?? 'pending'), inspired_by: Array.isArray(plan.data.inspired_by) ? plan.data.inspired_by.map(String) : [] }));
    const ideas = [...(await this.collect(this.paths.ideas)).values()].map((idea) => ({ id: idea.id, title: String(idea.data.title ?? idea.id), status: String(idea.data.status ?? 'draft'), idea_kind: toIdeaKind(idea.data.idea_kind) }));
    const usage = ideaUsage(plans);
    const lines = ideas.filter((idea) => usage.has(idea.id)).map((idea) => `- ${idea.id} (${idea.idea_kind}, ${idea.status}): ${usageLine(usage.get(idea.id))}`);
    const promote = promotionCandidates(ideas, usage).map((item) => `- ${item.id} (${item.title}): used for ${item.targets.join(', ')}. Promote it: idea promote ${item.id} --id <lemma_id> --statement "..." ${item.targets.map((target) => `--into ${target}`).join(' ')}`);
    return [`### Ideas used by plans`, lines.length ? lines.join('\n') : 'None yet.', ...(promote.length ? ['', '### Observations to promote to lemmas', promote.join('\n')] : [])].join('\n');
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
      try { const parsed = parseMarkdown(raw); nodes.set(path.posix.basename(file, '.md'), { id: path.posix.basename(file, '.md'), file, raw, data: parsed.data, body: parsed.content, ...library }); } catch { /* skipped here; next() stops while one exists (unparsableNodes) */ }
    }
    return nodes;
  }

  /** Asset, definition, and plan files that exist but do not parse, with the parser's message. */
  private async unparsableNodes(): Promise<string[]> {
    const folders = [...await nodeFolders(this.files, this.paths, 'asset'), ...await nodeFolders(this.files, this.paths, 'definition'), this.paths.plans];
    const problems: string[] = [];
    for (const folder of [...new Set(folders)]) for (const file of await this.files.listFiles(folder)) {
      const raw = await this.files.readFile(file).catch(() => undefined);
      if (raw === undefined) { problems.push(`${file}: cannot be read`); continue; }
      try { parseMarkdown(raw); } catch (error) { problems.push(`${file}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`); }
    }
    return problems;
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

  /**
   * A hold an agent's check may lift (something the node rests on changed): a proof re-checked
   * against its current dependencies, or a definition or cited result checked again since the hold.
   */
  private async holdLifted(kind: 'asset' | 'definition', id: string, raw: string, data: Record<string, any>, file: string, policy: AutoApprovePolicy, heldAt: string): Promise<boolean> {
    if (kind === 'definition') return policy.definitions && this.nodeChecked({ id, mode: 'definition' }, raw, heldAt);
    if (PROVABLE_TYPES.has(data.type) && !isCited(data.source) && locateNodeFile(file, this.paths)?.origin !== 'library') return policy.proofs && this.recheckSettled(id, raw);
    if (locateNodeFile(file, this.paths)?.origin === 'library' || isCited(data.source)) return policy.citations && this.nodeChecked({ id, mode: 'citation' }, raw, heldAt);
    return false;
  }

  /** The latest independent check of exactly this version of the node confirmed it (and, with `after`, was made after that time). */
  private async nodeChecked(node: NodeCheckTarget, raw: string, after?: string): Promise<boolean> {
    const verdict = await this.currentVerdict(node, raw);
    return verdict?.reason === 'confirmed' && (!after || verdict.createdAt > after);
  }

  /**
   * The latest check of this version of the node. A proof check covers this proof of this statement;
   * whether the dependencies it read are still current is `currentVerdict`'s question.
   */
  private async nodeVerdict(node: NodeCheckTarget, raw: string): Promise<DecisionInfo | undefined> {
    const decisions = sortDecisions(await this.decisions());
    if (node.mode === 'proof') {
      const proof = proofDigest(raw);
      const statement = statementDigest(raw);
      return decisions.filter((decision) => decision.kind === 'proof_check' && decision.target === node.id && decision.digest === proof && decision.statementDigest === statement).pop();
    }
    const digest = researchDigest(raw, node.mode === 'definition' ? 'definition' : 'asset');
    return decisions.filter((decision) => decision.kind === 'node_check' && decision.target === node.id && decision.digest === digest).pop();
  }

  /** The verdict that still holds for this version: a proof check only while the statements it read are unchanged. */
  private async currentVerdict(node: NodeCheckTarget, raw: string): Promise<DecisionInfo | undefined> {
    const verdict = await this.nodeVerdict(node, raw);
    if (!verdict || node.mode !== 'proof') return verdict;
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return undefined; }
    const deps = await this.dependencyDigests(data);
    return deps && sameDigests(verdict.dependencyDigests, deps) ? verdict : undefined;
  }

  /**
   * What an independent check of this node reads, or why there is nothing to check: a definition; a
   * library or cited result against its source; a written proof of a result or example as it stands.
   * A statement without a proof is the loop's to prove, and conjectures and counterexamples have checks of their own.
   */
  private async checkTargetOf(id: string): Promise<{ node?: NodeCheckTarget; raw: string; skip?: string }> {
    const assetFile = await findNodeFile(this.files, this.paths, 'asset', id);
    const file = assetFile ?? await findNodeFile(this.files, this.paths, 'definition', id);
    const raw = file ? await this.files.readFile(file).catch(() => '') : '';
    if (!file || !raw) return { raw, skip: 'no such result or definition' };
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = parseMarkdown(raw); } catch { return { raw, skip: 'invalid YAML' }; }
    const data = parsed.data;
    if (data.status === 'approved') return { raw, skip: 'already approved' };
    if (INACTIVE_STATUSES.has(data.status)) return { raw, skip: String(data.status) };
    if (!assetFile || data.type === 'definition') return { raw, node: { id, mode: 'definition' } };
    if (locateNodeFile(file, this.paths)?.origin === 'library' || isCited(data.source)) return { raw, node: { id, mode: 'citation' } };
    if (typeof data.refutes === 'string') return { raw, skip: 'a possible counterexample: the loop checks it' };
    if (data.type === CONJECTURE_TYPE) return { raw, skip: 'a conjecture: nothing to check yet' };
    if (!PROVABLE_TYPES.has(data.type) && data.type !== 'example') return { raw, skip: `a ${String(data.type)}: nothing to check` };
    if (!proofText(parsed.content)) return { raw, skip: 'no proof yet: the loop proves it' };
    return { raw, node: { id, mode: 'proof' } };
  }

  /** Record an independent check's verdict on exactly this version as a shared decision. */
  /** `checkedAgainst`: the dependency statements the check read, when the stage froze them; otherwise they are read now. */
  private async writeCheckVerdict(node: NodeCheckTarget, raw: string, verdict: 'confirmed' | 'rejected', summary: string, from: 'extraction' | 'auto' | 'recheck', checkedAgainst?: Record<string, string>): Promise<void> {
    if (node.mode === 'proof') {
      const deps = checkedAgainst ?? await this.dependencyDigests(parseMarkdown(raw).data);
      await this.writeDecision('proof_check', node.id, summary, { reason: verdict, digest: proofDigest(raw), statementDigest: statementDigest(raw), dependencyDigests: deps ?? {} });
      await this.event('proof_checked', { assetId: node.id, verdict, from, ...(node.changed?.length ? { changed: node.changed } : {}) });
      return;
    }
    await this.writeDecision('node_check', node.id, summary, { reason: verdict, digest: researchDigest(raw, node.mode === 'definition' ? 'definition' : 'asset') });
    await this.event('node_checked', { assetId: node.id, mode: node.mode, verdict, from });
  }

  /** What a queued approval says about the latest independent check of the version it names. */
  private async verdictNote(kind: ApprovalKind, target: string): Promise<string> {
    if (kind !== 'asset' && kind !== 'definition' && kind !== 'citation') return '';
    const { node, raw } = await this.checkTargetOf(target);
    if (!node) return '';
    const verdict = await this.currentVerdict(node, raw);
    return verdict?.reason === 'confirmed' || verdict?.reason === 'rejected' ? checkNote(verdict.reason, verdict.text) : '';
  }

  /** The node a queued approval names, when auto mode would approve it once an independent check confirms this version. */
  private async nodeCheckFor(request: ApprovalRequest, policy: AutoApprovePolicy): Promise<NodeCheckTarget | undefined> {
    if (request.kind !== 'definition' && request.kind !== 'citation' && request.kind !== 'asset') return undefined;
    const kind: ResultKind = request.kind === 'definition' ? 'definition' : 'asset';
    const file = await findNodeFile(this.files, this.paths, kind, request.target);
    const raw = file ? await this.files.readFile(file).catch(() => '') : '';
    if (!file || !raw || researchDigest(raw, kind) !== request.digest) return undefined;
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return undefined; }
    if (data.status !== 'draft') return undefined;
    const node: NodeCheckTarget | undefined = kind === 'definition' ? (policy.definitions ? { id: request.target, mode: 'definition' } : undefined)
      : policy.citations && (locateNodeFile(file, this.paths)?.origin === 'library' || isCited(data.source)) && data.type !== 'example' ? { id: request.target, mode: 'citation' } : undefined;
    if (!node) return undefined;
    const hold = (await this.holds())[`${kind}:${request.target}`];
    if (hold && !isLiftableHold(hold.reason)) return undefined;
    // One check per version: a confirmed one is approved by autoRule, a rejected one stays with the researcher.
    const verdict = await this.nodeVerdict(node, raw);
    if (verdict && (!hold || verdict.createdAt > hold.at)) return undefined;
    return node;
  }

  /** The first queued definition or citation auto mode waits to see checked; before those, what the scaffold or sources stage just extracted. */
  private async nodeToCheck(): Promise<NodeCheckTarget | undefined> {
    const extracted = await this.extractedToCheck();
    if (extracted) return extracted;
    const settings = await this.loopSettings();
    const policy = settings.autonomy.enabled ? AUTONOMOUS_AUTO_APPROVE : settings.autoApprove;
    if (!policy.enabled) return undefined;
    // Definitions first: results are read in their terms.
    const queue = [...this.require().approvalQueue].sort((a, b) => Number(b.kind === 'definition') - Number(a.kind === 'definition'));
    for (const request of queue) {
      const node = await this.nodeCheckFor(request, policy);
      if (node) return node;
    }
    return undefined;
  }

  /** Extracted nodes still waiting for their check, definitions first; the list drops what was checked, approved, or removed. */
  private async extractedToCheck(): Promise<NodeCheckTarget | undefined> {
    const state = this.require();
    if (!state.extractedChecks?.length) return undefined;
    const pending: NodeCheckTarget[] = [];
    for (const id of state.extractedChecks) {
      const { node, raw } = await this.checkTargetOf(id);
      if (node && !(await this.currentVerdict(node, raw))) pending.push(node);
    }
    const kept = pending.map((node) => node.id);
    if (kept.length !== state.extractedChecks.length) {
      if (kept.length) state.extractedChecks = kept; else delete state.extractedChecks;
      await this.save();
    }
    return pending.find((node) => node.mode === 'definition') ?? pending[0];
  }

  /** Remember what an extracting stage added, when the researcher wants extracted nodes checked right away. */
  private async noteExtracted(added: string[]): Promise<void> {
    if ((await this.loopSettings()).rigor.verifyExtracted !== 'agent') return;
    const folders = new Set([this.paths.assets, this.paths.definitions]);
    const ids = added.filter((file) => folders.has(path.posix.dirname(file)) && file.endsWith('.md')).map((file) => path.posix.basename(file, '.md'));
    if (!ids.length) return;
    const state = this.require();
    state.extractedChecks = [...new Set([...(state.extractedChecks ?? []), ...ids])];
    await this.save();
  }

  /**
   * A proof no loop plan wrote, confirmed by an independent check that read dependencies whose
   * statements have changed since: it is checked again, when proofs are verified independently or
   * auto mode would otherwise approve it. A rejected check stays with the researcher.
   */
  private async checkedProofRecheck(assetId: string, raw: string): Promise<NodeCheckTarget | undefined> {
    const { verifyProofs } = (await this.loopSettings()).rigor;
    if (verifyProofs === 'researcher') return undefined;
    if ((await this.vouchingPlans(assetId, raw)).length) return undefined;
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return undefined; }
    const deps = await this.dependencyDigests(data);
    const prior = deps ? await this.nodeVerdict({ id: assetId, mode: 'proof' }, raw) : undefined;
    if (!deps || prior?.reason !== 'confirmed' || sameDigests(prior.dependencyDigests, deps)) return undefined;
    if (verifyProofs !== 'agent' && !(await this.agentMayRecheck())) return undefined;
    return { id: assetId, mode: 'proof', changed: changedDigests(prior.dependencyDigests, deps) };
  }

  private async needsNodeCheck(node: NodeCheckTarget): Promise<boolean> {
    if (node.changed?.length) {
      const raw = await this.files.readFile(await this.nodeFile('asset', node.id)).catch(() => '');
      return Boolean(raw && await this.checkedProofRecheck(node.id, raw));
    }
    if (this.require().extractedChecks?.includes(node.id)) {
      const target = await this.checkTargetOf(node.id);
      if (target.node && !(await this.currentVerdict(target.node, target.raw))) return true;
    }
    if (node.mode === 'proof' && await this.repairConsent(node.id)) {
      const raw = await this.files.readFile(await this.nodeFile('asset', node.id)).catch(() => '');
      if (raw && (await this.repairWork(node.id, raw))?.stage === 'verify_node') return true;
    }
    const settings = await this.loopSettings();
    const policy = settings.autonomy.enabled ? AUTONOMOUS_AUTO_APPROVE : settings.autoApprove;
    if (!policy.enabled) return false;
    const request = this.require().approvalQueue.find((item) => item.target === node.id && (node.mode === 'definition' ? item.kind === 'definition' : item.kind === 'citation' || item.kind === 'asset'));
    return Boolean(request && await this.nodeCheckFor(request, policy));
  }

  /** Record the verdict of a node check as a shared decision, then let auto mode act on it. */
  private async recordNodeCheck(node: NodeCheckTarget, verdict: 'confirmed' | 'rejected', summary: string): Promise<string> {
    const kind: ResultKind = node.mode === 'definition' ? 'definition' : 'asset';
    const file = await findNodeFile(this.files, this.paths, kind, node.id);
    const raw = file ? await this.files.readFile(file).catch(() => '') : '';
    if (!raw) throw new Error(`${node.id} is gone; run ${LOOP_COMMAND} next.`);
    const state = this.require();
    // The verdict covers the version frozen when the check began; one read now that differs is not what was checked.
    const frozen = state.current.inputs ? state.current.inputs.filter((input) => input.id === node.id) : [];
    for (const input of frozen) {
      const now = input.part === 'statement' ? statementDigest(raw) : input.part === 'proof' ? proofDigest(raw) : researchDigest(raw, kind);
      if (now !== input.digest) throw new Error(`${node.id} changed while the verdict was being recorded. Run ${LOOP_COMMAND} next.`);
    }
    const extracted = Boolean(state.extractedChecks?.includes(node.id));
    await this.writeCheckVerdict(node, raw, verdict, summary, node.changed?.length ? 'recheck' : extracted ? 'extraction' : 'auto', state.current.inputs && node.mode === 'proof' ? this.frozenDependencies(node.id) ?? {} : undefined);
    if (extracted) { state.extractedChecks = state.extractedChecks!.filter((id) => id !== node.id); if (!state.extractedChecks.length) delete state.extractedChecks; await this.save(); }
    if (node.mode === 'proof' && node.changed?.length) return this.afterProofRecheck(node.id, node.changed, raw, verdict, summary);
    return this.afterCheckVerdict(node.id, verdict, summary, 'Continue with next.');
  }

  /** Put a new verdict on the queued approval it concerns; a confirmed one may let auto mode approve it. */
  private async afterCheckVerdict(id: string, verdict: 'confirmed' | 'rejected', summary: string, then: string): Promise<string> {
    const request = this.state?.approvalQueue.find((item) => item.target === id && item.kind !== 'counterexample' && item.kind !== 'specification');
    if (request) { request.reason = withCheckNote(request.reason, checkNote(verdict, summary)); await this.save(); }
    if (verdict === 'confirmed') {
      const granted = request ? await this.autoApproveQueued() : [];
      return granted.some((item) => item.endsWith(`:${id}`)) ? `${id} checked and approved automatically (auto mode). ${then}` : `${id} checked; the verdict goes with its approval request. ${then}`;
    }
    return `${id} did not pass the check; it waits for the researcher with your verdict. ${then}`;
  }

  /**
   * A proof no plan wrote, re-checked after something it rests on changed. Confirmed: an approved
   * result keeps its approval and loses its re-check mark, a draft goes to approval. Rejected: the
   * proof stays (it is the researcher's to revise, not the loop's to discard), an approved result
   * goes back to draft, and the researcher sees the verdict.
   */
  private async afterProofRecheck(assetId: string, changed: string[], raw: string, verdict: 'confirmed' | 'rejected', summary: string): Promise<string> {
    const approved = parseMarkdown(raw).data.status === 'approved' && isApproved((await this.approvals()).records, 'asset', assetId, raw);
    if (verdict === 'confirmed') {
      if (approved) {
        await this.clearRecheckByAgent(assetId);
        return `The proof of ${assetId} still holds after ${changed.join(', ')} changed (independent re-check); its re-check mark is cleared. Continue with next.`;
      }
      await this.enqueueApproval('asset', assetId, `Proof re-checked independently after ${changed.join(', ')} changed.`);
      return this.afterCheckVerdict(assetId, verdict, summary, 'Continue with next.');
    }
    if (approved) {
      const file = await this.nodeFile('asset', assetId);
      const parsed = parseMarkdown(raw);
      parsed.data.status = 'draft';
      await this.writeOwned(file, stringifyMarkdown(parsed.content, parsed.data));
      const approvals = await this.approvals();
      approvals.records = approvals.records.filter((record) => !(record.kind === 'asset' && record.target === assetId));
      await this.writeApprovals(approvals);
    }
    await this.clearHold('asset', assetId);
    await this.addHold('asset', assetId, 'dependency_changed');
    await this.event('recheck_rejected', { assetId, changed, kept: true });
    await this.enqueueApproval('asset', assetId, `After ${changed.join(', ')} changed, an independent re-check found a problem in the proof; the proof is kept for you to revise.`);
    await this.afterCheckVerdict(assetId, verdict, summary, '');
    return `After ${changed.join(', ')} changed, the proof of ${assetId} did not pass the re-check; ${approved ? 'it goes back to draft and ' : ''}the proof stays for the researcher to revise, with your verdict. Continue with next.`;
  }

  // ---------- extraction checks (research-loop check) ----------
  //
  // Run in the chat that extracted, right after extracting, whether or not a loop runs. These never
  // touch the loop's stage, lock, or context pack: they read the files, write decision records and
  // events, and write their packs under checks/. Only a verdict on a node that already waits in the
  // approval queue updates the loop state (its note, and auto mode).

  /** Whether the researcher wants extracted nodes checked right away, and where each named node stands. */
  /** `requested`: the researcher asked for these checks in this chat, so they run whatever the setting says. */
  async extractionChecks(ids: string[], options: { requested?: boolean } = {}): Promise<{ enabled: boolean; pending: NodeCheckTarget[]; checked: Array<{ id: string; mode: NodeCheckTarget['mode']; verdict: string; summary: string }>; skipped: Array<{ id: string; why: string }> }> {
    const enabled = options.requested === true || (await this.loopSettings()).rigor.verifyExtracted === 'agent';
    const pending: NodeCheckTarget[] = [];
    const checked: Array<{ id: string; mode: NodeCheckTarget['mode']; verdict: string; summary: string }> = [];
    const skipped: Array<{ id: string; why: string }> = [];
    for (const id of [...new Set(ids)]) {
      const { node, raw, skip } = await this.checkTargetOf(id);
      if (!node) { skipped.push({ id, why: skip ?? 'nothing to check' }); continue; }
      const verdict = await this.currentVerdict(node, raw);
      if (verdict) checked.push({ id, mode: node.mode, verdict: verdict.reason ?? '', summary: verdict.text.split('\n')[0] });
      else pending.push(node);
    }
    // Definitions first: the results are read in their terms.
    pending.sort((a, b) => Number(b.mode === 'definition') - Number(a.mode === 'definition'));
    return { enabled, pending, checked, skipped };
  }

  /** Write one check's pack beside the loop's (never over it) and return the worker's instruction. */
  async extractionCheckTask(node: NodeCheckTarget): Promise<{ file: string; tokens: number; instruction: string }> {
    const sources = await this.contextSources();
    const manifest = planContext({ stage: 'verify_node', node }, sources, await this.contextBudget('verify_node'));
    const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
    const file = checkPackPath(node.id);
    await this.files.writeFile(file, rendered.text);
    // What this check reads, frozen with its pack: the verdict is recorded only if these are unchanged.
    const inputs = await this.freezeInputs('verify_node', { stageStartedAt: this.now(), node }) ?? [];
    await this.files.writeFile(checkInputsPath(node.id), JSON.stringify({ node, inputs }, null, 2) + '\n');
    const instruction = `Check ${nodeCheckWhat(node)}. Read only the pack ${file} and what you request with ${LOOP_COMMAND} show <id> [--section Heading]. Change no file. Record the verdict with ${LOOP_COMMAND} check verdict ${node.id} confirmed --summary "<what you checked>" or ${LOOP_COMMAND} check verdict ${node.id} rejected --summary "<the first problem: what is wrong and what would fix it>".`;
    return { file, tokens: rendered.tokens, instruction };
  }

  /** Record a verdict from an extraction check; one on a node that already waits for approval goes on its request. */
  async recordExtractionCheck(id: string, verdict: 'confirmed' | 'rejected', summary: string): Promise<string> {
    if (!summary.trim()) throw new Error('Give the verdict in --summary: what you checked, or the first problem and what would fix it.');
    const { node, raw, skip } = await this.checkTargetOf(id);
    if (!node) throw new Error(`${id}: nothing to check (${skip}).`);
    // The verdict covers what the check task froze; anything changed since (the node itself included: the checker changes no file) voids it.
    let frozen: { node: NodeCheckTarget; inputs: FrozenInput[] } | undefined;
    try { frozen = JSON.parse(await this.files.readFile(checkInputsPath(id))) as { node: NodeCheckTarget; inputs: FrozenInput[] }; } catch { frozen = undefined; }
    if (frozen) {
      const changed = frozen.node.mode !== node.mode ? frozen.inputs.filter((input) => input.id === id) : await this.changedInputs(frozen.inputs);
      if (changed.length) {
        const names = [...new Set(changed.map((input) => input.id))].join(', ');
        await this.event('inputs_changed', { check: id, changed: changed.map((input) => `${input.id}#${input.part}`) });
        throw new Error(`${names} changed since the check of ${id} began, so this verdict covers only the earlier version and is not recorded. Run ${LOOP_COMMAND} check next again for a fresh check of the current version. This is someone else's change: do not revert it.`);
      }
    }
    await this.writeCheckVerdict(node, raw, verdict, summary.trim(), 'extraction', frozen && node.mode === 'proof' ? this.frozenDependencies(id, frozen.inputs) ?? {} : undefined);
    if (frozen && this.files.deleteFile) await this.files.deleteFile(checkInputsPath(id));
    return this.afterCheckVerdict(id, verdict, summary.trim(), `Run ${LOOP_COMMAND} check next for what remains.`);
  }

  /**
   * Whether this batch from this source still needs its coverage check. Each batch is checked once;
   * after gaps were filled the larger batch is checked again, but two checks in a row that found gaps
   * end it: what is still missing goes to the researcher with the last verdict.
   */
  async coverageDue(source: string, ids: string[]): Promise<{ due: boolean; last?: DecisionInfo }> {
    const digest = batchDigest(ids);
    const history = sortDecisions(await this.decisions()).filter((decision) => decision.kind === 'extraction_check' && decision.target === coverageTarget(source));
    const exact = history.filter((decision) => decision.digest === digest).pop();
    if (exact) return { due: false, last: exact };
    const [before, last] = history.slice(-2);
    if (before?.reason === 'gaps' && last?.reason === 'gaps') return { due: false, last };
    return { due: true, last };
  }

  /** A pack listing what was extracted, for one worker to read against the source and name what is missing. */
  async coverageTask(source: string, ids: string[]): Promise<{ file: string; instruction: string }> {
    const lines = [`# Coverage check: ${source}`, '', `The nodes extracted from ${source}. Read the source itself in full (${LOOP_COMMAND} show <paper_slug> for an indexed paper, or the file) and compare.`, ''];
    for (const id of [...new Set(ids)].sort()) {
      const file = await findNodeFile(this.files, this.paths, 'asset', id) ?? await findNodeFile(this.files, this.paths, 'definition', id);
      const raw = file ? await this.files.readFile(file).catch(() => '') : '';
      if (!raw) { lines.push(`## ${id}`, '', '(missing)', ''); continue; }
      let parsed: matter.GrayMatterFile<string>;
      try { parsed = parseMarkdown(raw); } catch { lines.push(`## ${id}`, '', '(invalid YAML)', ''); continue; }
      const data = parsed.data;
      const statement = (sectionContent(parsed.content, 'Statement') ?? statementPart(parsed.content) ?? '').trim();
      lines.push(`## ${id} (${String(data.type ?? 'node')}): ${String(data.title ?? '')}`, '');
      if (data.source?.location) lines.push(`Source location: ${String(data.source.location)}`);
      if (Array.isArray(data.depends_on) && data.depends_on.length) lines.push(`depends_on: ${data.depends_on.join(', ')}`);
      if (Array.isArray(data.uses_definitions) && data.uses_definitions.length) lines.push(`uses_definitions: ${data.uses_definitions.join(', ')}`);
      lines.push(`Has a proof: ${proofText(parsed.content) ? 'yes' : 'no'}`, '', statement.slice(0, 1200) || '(no statement)', '');
    }
    const file = checkPackPath('coverage');
    await this.files.writeFile(file, lines.join('\n'));
    const instruction = `Check that the extraction from ${source} is complete. Read the source and ${file}. Name anything missing: a result, example, definition, assumption, or convention the source states that no node holds; a claim left in prose that no node proves; a \\ref or \\cite, or a use of a defined term, that is missing from depends_on or uses_definitions; a proof the source gives that the node lacks. Change no file. Record it with ${LOOP_COMMAND} check coverage --source "${source}" --ids ${[...new Set(ids)].join(',')} complete --summary "<what you compared>" or ... gaps --summary "<one line per missing item, with its place in the source>".`;
    return { file, instruction };
  }

  async recordCoverage(source: string, ids: string[], verdict: 'complete' | 'gaps', summary: string): Promise<string> {
    if (!summary.trim()) throw new Error('Say in --summary what you compared, or list each missing item with its place in the source.');
    await this.writeDecision('extraction_check', coverageTarget(source), summary.trim(), { reason: verdict, digest: batchDigest(ids) });
    await this.event('coverage_checked', { source, verdict, nodes: [...new Set(ids)].length });
    return verdict === 'complete' ? `Coverage of ${source} recorded: nothing missing.` : `Coverage of ${source} recorded with gaps. Extract each missing item, then run ${LOOP_COMMAND} check next with the new IDs added (the new nodes are checked too).`;
  }

  /**
   * The plan whose proof needs an independent check now, and what changed since it was written or
   * last checked. With "verify each proof", a proof counts as checked only against the current
   * statements of its dependencies and definitions. With no separate check, a proof is checked only
   * when something it rests on changed and auto mode would otherwise approve it. Never when the
   * researcher checks every proof, or for a proof no plan of the loop produced.
   */
  private async proofToCheck(assetId: string, raw: string): Promise<{ planId: string; changed: string[] } | undefined> {
    const { verifyProofs } = (await this.loopSettings()).rigor;
    if (verifyProofs === 'researcher') return undefined;
    const plans = await this.vouchingPlans(assetId, raw);
    if (!plans.length) return undefined;
    let data: Record<string, any>;
    try { data = parseMarkdown(raw).data; } catch { return undefined; }
    const proof = proofDigest(raw);
    const deps = await this.dependencyDigests(data);
    const current = (plan: AssetInfo) => !deps || sameDigests(plan.data.dependency_digests, deps);
    if (plans.some((plan) => current(plan) && (verifyProofs !== 'agent' || plan.data.verified_proof_digest === proof))) return undefined;
    const plan = plans.find((item) => item.data.verified_proof_digest === proof) ?? plans[0];
    const changed = deps ? changedDigests(plan.data.dependency_digests, deps) : [];
    if (verifyProofs === 'agent') return { planId: plan.id, changed };
    return changed.length && await this.agentMayRecheck() ? { planId: plan.id, changed } : undefined;
  }

  /** Auto mode covers proofs and the researcher does not check every proof: an agent's re-check may stand in for them when something a proof rests on changed. */
  private async agentMayRecheck(): Promise<boolean> {
    const settings = await this.loopSettings();
    const policy = settings.autonomy.enabled ? AUTONOMOUS_AUTO_APPROVE : settings.autoApprove;
    return policy.enabled && policy.proofs && settings.rigor.verifyProofs !== 'researcher';
  }

  /** A result marked for re-check whose proof is vouched for against its current dependencies, none of which still waits for its own re-check. */
  private async recheckSettled(assetId: string, raw: string): Promise<boolean> {
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = parseMarkdown(raw); } catch { return false; }
    if (await this.heldDependency(parsed.data)) return false;
    return (await this.proofIsVouched(assetId, raw, parsed)) || (await this.constructionIsVouched(assetId, raw, parsed));
  }

  /** A result this one depends on is still held from auto mode (reverted or marked for re-check, and not settled again). */
  private async heldDependency(data: Record<string, any>): Promise<boolean> {
    const holds = await this.holds();
    return (Array.isArray(data.depends_on) ? data.depends_on as unknown[] : []).some((dep) => Boolean(holds[`asset:${String(dep)}`]));
  }

  private async clearRecheckByAgent(id: string, kind: 'asset' | 'definition' = 'asset'): Promise<void> {
    await this.clearHold(kind, id);
    await this.event('recheck_cleared', { id, by: 'agent' });
  }

  /** Keep a plan's earlier verdict under another heading before a re-check writes a new one. */
  private async setAsideVerdict(planId: string): Promise<void> {
    const file = `${this.paths.plans}/${planId}.md`;
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw || !/^## Verdict[ \t]*$/m.test(raw)) return;
    await this.writeOwned(file, raw.replace(/^## Verdict[ \t]*$/gm, '## Earlier verdict'));
  }

  /**
   * A re-check found that the proof no longer holds after something it rests on changed. That is no
   * failed approach: the plan is abandoned, the proof leaves the asset (an approved one goes back to
   * draft and stays held from auto mode), and the loop plans the result anew.
   */
  private async rejectStaleProof(assetId: string, planId: string, changed: string[]): Promise<string> {
    const planFile = `${this.paths.plans}/${planId}.md`;
    const plan = parseMarkdown(await this.files.readFile(planFile));
    plan.data.status = 'abandoned';
    delete plan.data.verified_proof_digest;
    await this.writeOwned(planFile, stringifyMarkdown(`${plan.content.trimEnd()}\n\n## Failure\n\nAfter ${changed.join(', ')} changed, the independent re-check found the proof no longer holds; ## Verdict names the step. Not counted as a failed approach.\n`, plan.data));
    const assetFile = `${this.paths.assets}/${assetId}.md`;
    const asset = parseMarkdown(await this.files.readFile(assetFile));
    const wasApproved = asset.data.status === 'approved';
    if (wasApproved) asset.data.status = 'draft';
    const body = asset.content.replace(/^## Proof[ \t]*\r?\n[\s\S]*?(?=^## |^<!-- research-assistant:|(?![\s\S]))/m, '').trimEnd() + '\n';
    await this.writeOwned(assetFile, stringifyMarkdown(body, asset.data));
    if (wasApproved) {
      const approvals = await this.approvals();
      approvals.records = approvals.records.filter((record) => !(record.kind === 'asset' && record.target === assetId));
      await this.writeApprovals(approvals);
    }
    await this.clearHold('asset', assetId);
    await this.addHold('asset', assetId, 'dependency_changed');
    await this.event('recheck_rejected', { assetId, planId, changed });
    return `After ${changed.join(', ')} changed, the proof of ${assetId} no longer holds (## Verdict in ${planId}); it ${wasApproved ? 'goes back to draft and ' : ''}will be planned anew. This is not counted as a failed approach. Continue with next.`;
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
      const settings = await this.loopSettings();
      const main = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => '')).includes(assetId);
      if (settings.rigor.lemmaRoutes === 'on' && settings.routeWidth > 0 && !main && !(await this.isRouted(assetId))) {
        // The researcher's setting: a stuck lemma first gets a round of routes, then the blocked question.
        await this.writeDecision('route_request', assetId, `${failures} proof attempts failed for ${assetId}; plan several routes to it before asking the researcher.`, { reason: 'stuck', routeRound: 0 });
        return finish(`${what} (${failures}/${limit}). Next: several routes to ${assetId} side by side.`, 'select', { assetId: undefined, planId: undefined });
      }
      await this.setStage('plan', { planId: undefined });
      if (autonomous) return { stage: 'plan', message: await this.decideStuck(assetId, `${failures} approaches failed for ${assetId} since the last direction (its allotment was ${limit}).`) };
      await this.askQuestion('blocked', `${assetId} has ${failures} documented failed approaches since the last direction. Give a new direction, or skip to park it and move on.`, { assetId, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
      return { stage: 'plan', message: `${failures} approaches failed for ${assetId} (limit ${limit}). Ask the researcher with ask_researcher(kind: "blocked"); if nobody answers, the loop acts on the researcher's setting (sets it aside, or records one new approach for you); do not park it yourself.` };
    }
    return finish(`${what} (${failures}/${limit}). Next: a different plan.`, 'plan', { planId: await this.pendingPlan(assetId) });
  }

  /**
   * The plan stage found no genuinely new approach. Nothing was executed, so no attempt is spent and
   * no failed plan is recorded: the result is stuck now. In autonomous mode the agent decides itself
   * (a new direction with budget allocate, or set it aside); a second "none" right after its own
   * direction, before any plan under it was tried, sets the result aside. Otherwise the researcher is
   * asked for a direction, as after the failed-plan limit.
   */
  private async noNewPlan(files: { added: string[] }, summary: string, finish: Finish, autonomous: boolean): Promise<{ stage: LoopStage; message: string }> {
    const assetId = this.require().current.assetId!;
    if (!summary.trim()) throw new Error('Say in --summary why no new approach is in sight: what the failed plans show.');
    const written = files.added.filter((file) => path.posix.dirname(file) === this.paths.plans);
    if (written.length) throw new Error(`You wrote ${written.join(', ')}: report complete --plan <id> to execute it, or remove it and report none.`);
    await this.event('no_new_plan', { assetId });
    if (autonomous) {
      const direction = latestDirection(await this.decisions(), assetId);
      if (direction?.reason === 'autonomous' && !(await this.failuresSinceDirection(assetId))) {
        await this.park(assetId, 'agent_gave_up', summary.trim());
        return finish(`No plan came from your own direction for ${assetId}; it is set aside with your note. Continue with next.`, 'select', { assetId: undefined, planId: undefined });
      }
      await finish(`No new approach for ${assetId}.`, 'plan', { planId: undefined });
      return { stage: 'plan', message: await this.decideStuck(assetId, `No new approach is in sight for ${assetId}: ${summary.trim()}`) };
    }
    await finish(`No new approach for ${assetId}.`, 'plan', { planId: undefined });
    await this.askQuestion('blocked', `No new approach is in sight for ${assetId}: ${summary.trim()} Give a new direction, or skip to set it aside.`, { assetId, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
    return { stage: 'plan', message: `No new approach for ${assetId}. Ask the researcher with ask_researcher(kind: "blocked"); if nobody answers, the loop acts on the researcher's setting (sets it aside, or records one new approach for you); do not park it yourself.` };
  }

  /** The pending classic plan for an asset; routes (plans with route_lemmas) are worked on by the route scheduler instead. */
  private async pendingPlan(assetId: string): Promise<string | undefined> {
    return (await this.plans()).find((plan) => plan.data.type === 'plan' && plan.data.target_asset === assetId && plan.data.status === 'pending' && !isRoutePlan(plan.data))?.id;
  }

  /** Select the next stage; auto approvals granted on the way are followed by a fresh selection over the updated files. */
  private async computeSelection(): Promise<Selection> {
    return this.withNodeCheck(await this.selectAndApprove());
  }

  private async selectAndApprove(): Promise<Selection> {
    let selection = await this.selectOnce();
    for (let pass = 0; pass < MAX_AUTO_PASSES; pass++) {
      if (!(await this.autoApproveQueued()).length) return selection;
      selection = await this.selectOnce();
    }
    await this.event('auto_pass_limit', { stage: selection.stage });
    return selection;
  }

  /** A queued definition or citation that auto mode would approve once checked goes first: proof work may rest on it. */
  private async withNodeCheck(selection: Selection): Promise<Selection> {
    if (!['plan', 'search', 'conjecture', 'waiting', 'route', 'reduce'].includes(selection.stage)) return selection;
    const node = await this.nodeToCheck();
    return node ? { stage: 'verify_node', node } : selection;
  }

  /** `skip`: results another worker of a batch already has; selection passes over them. */
  private async selectOnce(skip: ReadonlySet<string> = new Set()): Promise<Selection> {
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
      // The researcher's own results were just taken in: the goals are drafted from them first, whatever project.md says now.
      if (state.researcherInput?.kind === 'intake') return { stage: 'draft_project' };
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
    // The researcher's focus is visited first, so its results are selected before the rest.
    const roots = [...(state.focus ?? []).filter((id) => required.includes(id)), ...required];
    const base = assetClosure(roots, assets);
    // Lemmas of open routes are in scope too, but only the route scheduler works on them.
    const { order, missing, cycle } = await this.routeClosure(roots, base, assets);
    const routeOnly = new Set(order.filter((id) => !base.order.includes(id)));
    if (cycle) return { stage: 'waiting', reason: `Dependency cycle at ${cycle}; fix depends_on before continuing.`, waitingOn: [{ kind: 'cycle', target: cycle }] };
    if (missing.length) return { stage: 'scaffold', missing, incomplete: [] };
    // A goal never rests on a conjecture: the loop does not prove conjectures, so it must be promoted first.
    const conjecturesInGoals = base.order.filter((id) => assets.get(id)!.data.type === CONJECTURE_TYPE);
    if (conjecturesInGoals.length) {
      state.researcherInput = { kind: 'project', text: `The goals rest on the conjecture(s) ${conjecturesInGoals.join(', ')}, which the loop does not prove. For each, either make it a goal (${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition, and list it under required_results) or change the goals so that they do not depend on it (a new asset ID for a revised statement).`, at: this.now() };
      return { stage: 'draft_project', note: state.researcherInput.text };
    }
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
    // What each result needs next, in the order met; the first in topological order is chosen below.
    const work = new Map<string, Selection>();
    const offer = (id: string, selection: Selection) => { if (!work.has(id) && !skip.has(id)) work.set(id, selection); };
    // Results worked on through routes (parallel routes), not by one plan after another.
    const routed = new Set<string>();
    const settings = await this.loopSettings();
    const allPlans = await this.plans();
    const isRoutedNow = async (id: string) => {
      const mine = allPlans.filter((plan) => plan.data.target_asset === id && isRoutePlan(plan.data));
      if (mine.some((plan) => plan.data.status === 'pending')) return true;
      if (settings.routeWidth === 0) return false;
      if (mine.length) return true;
      if (this.routeRequest(id, await this.lastRouteRound(id, mine), decisions)) return true;
      // A main result not yet attempted starts with a round of routes; one already attempted the classic way stays so.
      return required.includes(id) && !allPlans.some((plan) => plan.data.target_asset === id);
    };
    const flags = await this.recheckFlags();
    const agentRechecks = await this.agentMayRecheck();
    for (const id of order) {
      const asset = assets.get(id)!;
      const verified = asset.data.status === 'approved' && isApproved(approvals, 'asset', id, asset.raw);
      if (verified) {
        settled.add(id);
        // Marked for re-check (something it rests on changed) while auto mode may let the agent's re-check stand in for the researcher.
        if (flags[id] && agentRechecks) {
          const check = await this.proofToCheck(id, asset.raw);
          const checked = check ? undefined : await this.checkedProofRecheck(id, asset.raw);
          if (check) offer(id, { stage: 'verify_proof', assetId: id, planId: check.planId, recheck: check.changed.length ? check.changed : [flags[id]] });
          else if (checked) offer(id, { stage: 'verify_node', node: { ...checked, changed: checked.changed?.length ? checked.changed : [flags[id]] } });
          else if (await this.recheckSettled(id, asset.raw)) await this.clearRecheckByAgent(id);
        }
        continue;
      }
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
        // The researcher's own proof, which they asked the loop to complete: checked as written, then repaired where the check found a gap.
        const repair = await this.repairWork(id, asset.raw, decisions);
        if (repair) { offer(id, repair); continue; }
        // A proof the loop wrote is checked independently before it goes to approval, when the researcher asked for that,
        // and again when something it rests on changed since.
        const check = await this.proofToCheck(id, asset.raw);
        if (check) { offer(id, { stage: 'verify_proof', assetId: id, planId: check.planId, ...(check.changed.length ? { recheck: check.changed } : {}) }); continue; }
        // A proof checked independently as written (the researcher's manuscript, say) is checked again once something it rests on changed.
        const checked = await this.checkedProofRecheck(id, asset.raw);
        if (checked) { offer(id, { stage: 'verify_node', node: checked }); continue; }
        await this.enqueueApproval('asset', id, 'Proof is written; review and approve or request changes.');
        settled.add(id); continue;
      }
      const deps = Array.isArray(asset.data.depends_on) ? asset.data.depends_on as string[] : [];
      if (!deps.every((dep) => settled.has(dep))) continue;
      if (waitsOnDefinition(id)) continue;
      if (isConstructionSpec(asset.raw)) {
        // What to search for is the researcher's call: no search tokens before the specification is approved.
        if (!isApproved(approvals, 'specification', id, asset.raw)) await this.enqueueApproval('specification', id, 'Approve the required properties (P1, P2, …) before the construction search starts.');
        else offer(id, { stage: 'search', assetId: id, mode: 'construct' });
        continue;
      }
      // The researcher's setting may skip the counterexample search (for every result, or for all but the main ones); a requested search always runs.
      const skipSearch = rigor.refuteSearch === 'off' || (rigor.refuteSearch === 'main' && !required.includes(id));
      const requested = await this.searchRequest(id, decisions);
      if (!((this.isFalsified(id, asset.raw, checks) || skipSearch) && !requested)) offer(id, { stage: 'search', assetId: id, mode: 'refute' });
      else if (await isRoutedNow(id)) routed.add(id);
      else offer(id, { stage: 'plan', assetId: id });
    }
    let candidate: Selection | undefined;
    const routing = routed.size ? { ...(await this.routeGraph({ assets, settled, examples, maxLive: settings.maxLiveRoutes })), work, routed, required, decisions, settings, skip } : undefined;
    for (const id of order) {
      if (routing && routed.has(id) && !routeOnly.has(id)) {
        const selection = await this.routeSelection(id, routing);
        if (selection === 'reselect') return this.selectOnce(skip);
        if (selection) { candidate = selection; break; }
        continue;
      }
      const offered = work.get(id);
      // A lemma reached only through routes is the scheduler's, except a check of its proof, which never hurts.
      if (!offered || (routeOnly.has(id) && offered.stage !== 'verify_proof' && offered.stage !== 'verify_node')) continue;
      candidate = offered;
      break;
    }
    if (candidate && candidate.stage !== 'verify_proof' && candidate.stage !== 'verify_node' && candidate.stage !== 'verify_reduction') {
      // The researcher asked the loop not to get further ahead of them: no new proof work while too many verified results wait to be studied.
      const behind = await this.studyBacklog();
      if (behind) return { stage: 'waiting', reason: `${behind.count} verified result(s) wait for the researcher to study them (their limit is ${behind.limit}); the loop starts no new proof until they catch up with the teach skill`, waitingOn: [{ kind: 'study', target: String(behind.count), detail: String(behind.limit) }] };
    }
    if (candidate) return candidate;
    const definitionIds = definitionClosure(order, assets, definitions);
    const unapproved = definitionIds.filter((id) => !(definitions.get(id)?.data.status === 'approved' && isApproved(approvals, 'definition', id, definitions.get(id)!.raw)));
    for (const id of unapproved) if (definitions.has(id)) await this.enqueueApproval('definition', id, 'Definition used by an approved or proved result.');
    // Nothing on the way to the goals is actionable: work on conjectures, when the researcher allows it.
    const conjectureWork = await this.conjectureWork({ assets, approvals, checks, examples, refuteSearch: rigor.refuteSearch });
    if (conjectureWork) return conjectureWork;
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

  // ---------- batches: several results worked on at once ----------

  /**
   * What a selection takes, so the next worker of a batch passes over it: the route for a reduction or
   * its check (several routes to one result are reduced side by side: each writes only its own plan),
   * else the result.
   */
  private selectionKey(selection: Selection): string | undefined {
    if (selection.stage === 'reduce' || selection.stage === 'verify_reduction') return `plan:${selection.planId}`;
    if (selection.stage === 'verify_node') return selection.node.id;
    return 'assetId' in selection ? selection.assetId : undefined;
  }

  /** One item of a batch from a selection of a stage a batch may hold; a plan that already exists is executed instead. */
  private async batchItem(selection: Selection, item: number): Promise<BatchItem | undefined> {
    if (!BATCH_STAGES.has(selection.stage)) return undefined;
    if (selection.stage === 'verify_node') return { item, stage: 'verify_node', assetId: selection.node.id, node: selection.node };
    if (!('assetId' in selection)) return undefined;
    const assetId = selection.assetId;
    if (selection.stage === 'plan') {
      const pending = await this.pendingPlan(assetId);
      if (!pending) return { item, stage: 'plan', assetId, ...(selection.repair ? { repair: selection.repair } : {}) };
      const raw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`).catch(() => '');
      const repair = await this.repairGapOf(pending);
      return { item, stage: 'execute', assetId, planId: pending, ...(raw ? { statementDigest: statementDigest(raw) } : {}), ...(repair ? { repair } : {}) };
    }
    if (selection.stage === 'verify_proof') {
      if (selection.recheck?.length) await this.setAsideVerdict(selection.planId);
      return { item, stage: 'verify_proof', assetId, planId: selection.planId, ...(selection.recheck?.length ? { recheck: selection.recheck } : {}) };
    }
    if (selection.stage === 'reduce' || selection.stage === 'verify_reduction') return { item, stage: selection.stage, assetId, planId: selection.planId };
    return undefined;
  }

  /** What an item's stage sees as `current`: the batch's, narrowed to the item. */
  private itemCurrent(item: BatchItem, base: LoopState['current']): LoopState['current'] {
    const { batch: _batch, route: _route, search: _search, ...rest } = base;
    return { ...rest, assetId: item.assetId, planId: item.planId, node: item.node, recheck: item.recheck, inputs: item.inputs, statementDigest: item.statementDigest, repair: item.repair };
  }

  /**
   * With more than one worker allowed and the chosen stage one a batch may hold, gather more stages
   * for other results (selection passing over the results already taken) and start a batch. Returns
   * whether it did; one item alone runs as an ordinary stage.
   */
  private async startBatch(first: Selection): Promise<boolean> {
    const workers = (await this.loopSettings()).parallelWorkers;
    if (workers < 2) return false;
    const head = await this.batchItem(first, 1);
    if (!head) return false;
    const items = [head];
    const skip = new Set([this.selectionKey(first)!]);
    for (let tries = 0; items.length < workers && tries < workers * 3; tries++) {
      const next = await this.selectOnce(skip);
      const key = this.selectionKey(next);
      if (!key || skip.has(key)) break;
      skip.add(key);
      const item = await this.batchItem(next, items.length + 1);
      if (item) items.push(item);
    }
    if (items.length < 2) return false;
    await this.setStage('batch', { assetId: undefined, planId: undefined, batch: { items } });
    const state = this.require();
    for (const item of items) {
      const inputs = await this.freezeInputs(item.stage, this.itemCurrent(item, state.current));
      if (inputs) item.inputs = inputs;
    }
    await this.save();
    await this.event('batch_started', { items: items.map((item) => ({ item: item.item, stage: item.stage, assetId: item.assetId })) });
    return true;
  }

  /** The files an item owns among the changed ones: its target's proof (execute), its plan, or the plan it writes. */
  private async itemOwned(item: BatchItem, files: string[]): Promise<Set<string>> {
    const owned = new Set<string>();
    for (const file of files) {
      if (item.planId && file === `${this.paths.plans}/${item.planId}.md`) owned.add(file);
      else if (item.stage === 'execute' && file === `${this.paths.assets}/${item.assetId}.md`) owned.add(file);
      else if (item.stage === 'plan' && path.posix.dirname(file) === this.paths.plans) {
        try { if (parseMarkdown(await this.files.readFile(file)).data.target_asset === item.assetId) owned.add(file); } catch { /* unreadable: the item's rules report it */ }
      }
    }
    return owned;
  }

  /**
   * Report one item of a batch: the item's stage runs its usual report against its own files only,
   * as if it were the stage (no snapshot is retaken, so the other items' changes stay checked). The
   * last item also checks that nothing outside the items changed, then the batch closes.
   */
  private async reportBatchItem(report: StageReport): Promise<{ stage: LoopStage; message: string }> {
    const state = this.require();
    const batch = state.current.batch;
    if (!batch) throw new Error(`No batch is open; run ${LOOP_COMMAND} next.`);
    if (report.item === undefined) throw new Error(`A batch is open: report each item with --item <n> (open: ${batch.items.filter((entry) => !entry.done).map((entry) => entry.item).join(', ')}).`);
    const item = batch.items.find((entry) => entry.item === report.item);
    if (!item) throw new Error(`No item ${report.item} in this batch (items ${batch.items.map((entry) => entry.item).join(', ')}).`);
    if (item.done) throw new Error(`Item ${item.item} was reported already (${item.done.outcome}).`);
    const changes = await this.changedFiles();
    const changed = [...changes.added, ...changes.modified, ...changes.removed];
    const last = batch.items.every((entry) => entry === item || entry.done);
    if (last) {
      // Nothing but the items' own files (and ideas) may have changed during the batch.
      const ownedByAny = new Set<string>();
      for (const entry of batch.items) for (const file of await this.itemOwned(entry, changed)) ownedByAny.add(file);
      this.itemScope = (file) => !ownedByAny.has(file);
      try {
        const { problems } = await this.validateStageFiles();
        if (problems.length) throw new Error(`Batch validation failed (files no item owns):\n- ${problems.join('\n- ')}\nRestore your own unintended changes with git and report item ${item.item} again.`);
      } finally { this.itemScope = undefined; }
    }
    const owned = await this.itemOwned(item, changed);
    const saved = { stage: state.stage, current: state.current };
    this.itemMode = { batch: saved.current };
    this.itemScope = (file) => owned.has(file);
    state.stage = item.stage;
    state.current = this.itemCurrent(item, saved.current);
    let result: { stage: LoopStage; message: string };
    try {
      result = await this.reportStage(report);
    } finally {
      state.stage = saved.stage;
      state.current = saved.current;
      this.itemMode = undefined;
      this.itemScope = undefined;
    }
    item.done = { outcome: report.outcome, summary: report.summary, at: this.now() };
    const open = batch.items.filter((entry) => !entry.done);
    if (!open.length) {
      await this.event('batch_finished', { items: batch.items.length });
      await this.setStage('select', { assetId: undefined, planId: undefined });
      // Attempts spent by earlier items may have used up the budget: the run ends now that the batch is reported.
      const run = await this.autonomy();
      const over = run ? this.autonomyOver(run, await this.loopSettings()) : undefined;
      if (over) return { stage: this.require().stage, message: `Item ${item.item}: ${result.message}\n${await this.handOver(over)}` };
      return { stage: 'select', message: `Item ${item.item}: ${result.message}\nEvery item of the batch is reported. Continue with ${LOOP_COMMAND} next.` };
    }
    await this.save();
    return { stage: 'batch', message: `Item ${item.item}: ${result.message}\nStill to report: item(s) ${open.map((entry) => entry.item).join(', ')}.` };
  }

  // ---------- parallel routes ----------

  private async routePlans(): Promise<AssetInfo[]> { return (await this.plans()).filter((plan) => isRoutePlan(plan.data)); }

  /**
   * The goals' closure widened by the lemmas of open routes to results not yet approved (and what
   * those rest on), so they get their statements, definitions, and counterexample search like any
   * result. Only the goals' own closure can be missing a node or close a dependency cycle: a route
   * whose lemma is gone is dead, not a reason to scaffold.
   */
  private async routeClosure(roots: string[], base: ReturnType<typeof assetClosure>, assets: Map<string, AssetInfo>): Promise<ReturnType<typeof assetClosure>> {
    const open = (await this.routePlans()).filter((plan) => plan.data.status === 'pending');
    if (!open.length) return base;
    const extra: string[] = [];
    let closure = base;
    for (;;) {
      const inScope = new Set(closure.order);
      const lemmas = [...new Set(open.filter((plan) => inScope.has(String(plan.data.target_asset)) && assets.get(String(plan.data.target_asset))?.data.status !== 'approved').flatMap((plan) => routeLemmas(plan.data)))]
        .filter((id) => !inScope.has(id) && !extra.includes(id) && assets.has(id));
      if (!lemmas.length) return { order: closure.order, missing: base.missing, ...(base.cycle ? { cycle: base.cycle } : {}) };
      extra.push(...lemmas);
      closure = assetClosure([...roots, ...extra], assets);
    }
  }

  /**
   * Whether a result is worked on through routes rather than by one plan after another (the same
   * rule as selection): it has an open route; or routes are on and it has routes, a pending request
   * for a round, or it is a main result not yet attempted.
   */
  private async willRoute(id: string): Promise<boolean> {
    const plans = (await this.plans()).filter((plan) => plan.data.target_asset === id);
    const mine = plans.filter((plan) => isRoutePlan(plan.data));
    if (mine.some((plan) => plan.data.status === 'pending')) return true;
    if ((await this.loopSettings()).routeWidth === 0) return false;
    if (mine.length || this.routeRequest(id, await this.lastRouteRound(id, mine), await this.decisions())) return true;
    return requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => '')).includes(id) && !plans.length;
  }

  /** The stage after a result survived its counterexample search: its routes (through selection), or a plan. */
  private async afterSurvived(assetId: string): Promise<[LoopStage, Partial<LoopState['current']>]> {
    return await this.willRoute(assetId) ? ['select', { assetId: undefined, counterexampleId: undefined, planId: undefined }] : ['plan', { counterexampleId: undefined, planId: await this.pendingPlan(assetId) }];
  }

  /** Whether a result has routes, whatever their state. */
  private async isRouted(assetId: string): Promise<boolean> { return (await this.routePlans()).some((plan) => plan.data.target_asset === assetId); }

  /** The latest round of routes to a result; 0 before the first. */
  private async lastRouteRound(target: string, plans?: AssetInfo[]): Promise<number> {
    const rounds = (plans ?? await this.routePlans()).filter((plan) => plan.data.target_asset === target && Number.isInteger(plan.data.route_round)).map((plan) => Number(plan.data.route_round));
    return rounds.length ? Math.max(...rounds) : 0;
  }

  /** The researcher's request for a round of routes that has not run yet (a fork names where it starts). */
  private routeRequest(target: string, last: number, decisions: DecisionInfo[]): DecisionInfo | undefined {
    const request = sortDecisions(decisions).filter((item) => item.kind === 'route_request' && item.target === target).pop();
    return request && (request.routeRound ?? 0) >= last ? request : undefined;
  }

  /** A reduction counts only for the statements it was written against: a changed lemma or target statement voids it. */
  private currentReductionPlan(plan: AssetInfo, assets: Map<string, AssetInfo>): { id: string; data: Record<string, any>; content: string } {
    const inputs = plan.data.reduction_inputs;
    const stale = Boolean(inputs) && typeof inputs === 'object' && Object.entries(inputs as Record<string, unknown>).some(([id, digest]) => { const node = assets.get(id); return !node || statementDigest(node.raw) !== digest; });
    return { id: plan.id, data: stale ? { ...plan.data, reduction_digest: undefined, reduction_verified_digest: undefined } : plan.data, content: plan.body };
  }

  /**
   * Every route with its state (its lemmas as settled as the selection found them, refuted by a
   * confirmed counterexample, retired, or set aside), at most `maxLive` active per result, the
   * cheapest first, and the AND-OR graph the scheduler reads.
   */
  private async routeGraph(input: { assets: Map<string, AssetInfo>; settled: Set<string>; examples: AssetInfo[]; maxLive: number }): Promise<{ routes: RouteInfo[]; graph: ProofGraph }> {
    const state = this.require();
    const { assets, settled, examples } = input;
    const refuted = (id: string) => examples.some((example) => example.data.refutes === id && example.data.status === 'approved');
    const retired = (id: string) => !assets.has(id) || ['deprecated', 'archived'].includes(assets.get(id)!.data.status);
    const plans = await this.plans();
    const failed = (id: string) => plans.filter((plan) => plan.data.target_asset === id && plan.data.status === 'failed').length;
    const raw = plans.filter((plan) => isRoutePlan(plan.data))
      .map((plan) => routeInfo(this.currentReductionPlan(plan, assets), (id) => ({ settled: settled.has(id), refuted: refuted(id), inactive: retired(id), parked: Boolean(state.parked[id]) })));
    const graphOf = (routes: RouteInfo[]): ProofGraph => ({
      settled: (id) => settled.has(id),
      dead: (id) => retired(id) || refuted(id),
      deps: (id) => (Array.isArray(assets.get(id)?.data.depends_on) ? (assets.get(id)!.data.depends_on as unknown[]).map(String) : []).filter((dep) => !settled.has(dep)),
      routes: (id) => routes.filter((route) => route.target === id),
      leafCost: (id) => 1 + 0.5 * failed(id),
    });
    const numbers = new ProofNumbers(graphOf(raw));
    const routes = applyBeam(raw, input.maxLive, (route) => numbers.ofRoute(route));
    return { routes, graph: graphOf(routes) };
  }

  /**
   * The next step for a result worked on through routes: the most-proving step of its route tree.
   * `reselect`: a complete route was committed (or a reduction stamped) on the way, so the caller
   * selects again over the changed files. A main result's routes wait while the researcher reviews
   * its route map; a result with no route left gets a new round, or, past the round limit, a
   * direction from the researcher (in autonomous mode, the agent's own decision).
   */
  private async routeSelection(id: string, ctx: {
    routes: RouteInfo[]; graph: ProofGraph; work: Map<string, Selection>; routed: Set<string>; required: string[]; decisions: DecisionInfo[]; settings: LoopSettings; skip?: ReadonlySet<string>;
  }): Promise<Selection | 'reselect' | undefined> {
    const skip = ctx.skip ?? new Set<string>();
    const { settings } = ctx;
    if (settings.rigor.reviewRoutes === 'main' && ctx.required.includes(id) && ctx.routes.some((route) => route.target === id && isActiveRoute(route)) && !(await this.routeMapApproved(id))) {
      await this.enqueueApproval('routes', id, `Review the routes to ${id} before they are worked on: drop a route, add one of your own, or approve the map.`);
      return undefined;
    }
    const plans = await this.routePlans();
    const rounds = new Map<string, 'round' | 'stuck' | 'waiting'>();
    for (const node of ctx.routed) {
      const mine = ctx.routes.filter((route) => route.target === node);
      if (mine.some(isActiveRoute)) continue;
      if (mine.some((route) => route.state === 'suspended')) { rounds.set(node, 'waiting'); continue; }
      const last = await this.lastRouteRound(node, plans);
      const used = Math.max(0, last - (latestDirection(ctx.decisions, node)?.routeRound ?? 0));
      rounds.set(node, this.routeRequest(node, last, ctx.decisions) || used < settings.routeRounds ? 'round' : 'stuck');
    }
    const actionable = (node: string) => !skip.has(node) && (ctx.work.has(node) || (ctx.routed.has(node) && rounds.has(node) && rounds.get(node) !== 'waiting'));
    const step = mostProvingStep(id, ctx.graph, actionable, (candidate) => (candidate.kind === 'reduce' || candidate.kind === 'verify_reduction') && skip.has(`plan:${candidate.planId}`));
    if (!step) return undefined;
    switch (step.kind) {
      case 'asset': {
        if (!ctx.routed.has(step.id)) return ctx.work.get(step.id);
        if (rounds.get(step.id) === 'round') {
          const last = await this.lastRouteRound(step.id, plans);
          const fork = this.routeRequest(step.id, last, ctx.decisions)?.fork;
          return { stage: 'route', assetId: step.id, ...(fork ? { fork } : {}) };
        }
        await this.routesStuck(step.id, `Every route to ${step.id} so far failed or was ruled out, and its rounds of routes are used up.`);
        return undefined;
      }
      case 'reduce': return { stage: 'reduce', assetId: step.target, planId: step.planId };
      case 'verify_reduction': {
        if (settings.rigor.verifyProofs === 'agent') return { stage: 'verify_reduction', assetId: step.target, planId: step.planId };
        // The researcher turned the independent check off since the reduction was written: it stands as written.
        const file = `${this.paths.plans}/${step.planId}.md`;
        const plan = parseMarkdown(await this.files.readFile(file));
        plan.data.reduction_verified_digest = plan.data.reduction_digest;
        await this.writeOwned(file, stringifyMarkdown(plan.content, plan.data));
        return 'reselect';
      }
      case 'commit':
        await this.commitRoute(step.planId);
        return 'reselect';
    }
  }

  /** No route to a result is left and its rounds are used up: the researcher gives a direction (in autonomous mode, the agent decides). */
  private async routesStuck(assetId: string, what: string): Promise<void> {
    const state = this.require();
    const run = await this.autonomy();
    if (run) { if (!run.deciding) await this.decideStuck(assetId, what); return; }
    if (state.pendingQuestion) return;
    await this.event('routes_exhausted', { assetId });
    await this.askQuestion('blocked', `${what} Give a new direction for new routes, or skip to set it aside.`, { assetId, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
  }

  /**
   * Commit a complete route: its reduction becomes the result's proof and its lemmas join the
   * result's depends_on; the plan succeeds (stamped as a proof the loop wrote, verified when the
   * reduction was checked independently) and the result's other open routes are superseded. A route
   * whose lemmas already rest on the result would close a cycle: it is abandoned instead.
   */
  private async commitRoute(planId: string): Promise<string | undefined> {
    const planFile = `${this.paths.plans}/${planId}.md`;
    const plan = parseMarkdown(await this.files.readFile(planFile));
    const target = String(plan.data.target_asset);
    const assetFile = `${this.paths.assets}/${target}.md`;
    const asset = parseMarkdown(await this.files.readFile(assetFile));
    if (proofText(asset.content)) return undefined;
    const lemmas = routeLemmas(plan.data);
    if (assetClosure(lemmas, await this.collectKind('asset')).order.includes(target)) {
      plan.data.status = 'abandoned';
      await this.writeOwned(planFile, stringifyMarkdown(`${plan.content.trimEnd()}\n\n## Abandoned\n\nCommitting this route would make ${target} rest on itself: one of its lemmas already depends on it.\n`, plan.data));
      await this.event('route_abandoned', { target, planId, reason: 'cycle' });
      return undefined;
    }
    const deps = Array.isArray(asset.data.depends_on) ? asset.data.depends_on.map(String) : [];
    asset.data.depends_on = [...new Set([...deps, ...lemmas])];
    const committed = stringifyMarkdown(withProof(asset.content, sectionContent(plan.content, 'Reduction')), asset.data);
    await this.writeOwned(assetFile, committed);
    plan.data.status = 'succeeded';
    plan.data.proof_digest = proofDigest(committed);
    plan.data.statement_digest = statementDigest(committed);
    plan.data.dependency_digests = await this.dependencyDigests(asset.data) ?? {};
    if (plan.data.reduction_checked === true) plan.data.verified_proof_digest = plan.data.proof_digest;
    else delete plan.data.verified_proof_digest;
    const outcome = `The reduction is now the proof of ${target} (under ## Proof)${lemmas.length ? `; it rests on ${lemmas.join(', ')}, now in its depends_on` : ''}.`;
    await this.writeOwned(planFile, stringifyMarkdown(`${plan.content.trimEnd()}\n\n## Outcome\n\n${outcome}\n`, plan.data));
    const superseded: string[] = [];
    for (const other of await this.routePlans()) {
      if (other.id === planId || other.data.target_asset !== target || other.data.status !== 'pending') continue;
      const parsed = parseMarkdown(other.raw);
      parsed.data.status = 'superseded';
      parsed.data.superseded_by = planId;
      await this.writeOwned(other.file, stringifyMarkdown(parsed.content, parsed.data));
      superseded.push(other.id);
    }
    // The route map is settled with the route chosen: nothing of it waits for review any more.
    const state = this.require();
    state.approvalQueue = state.approvalQueue.filter((item) => !(item.kind === 'routes' && item.target === target));
    await this.save();
    await this.event('route_won', { target, planId, superseded });
    return target;
  }

  /** The researcher's routes, the latest direction, and directions of the agent's own, up to the researcher's number of routes per round. */
  private async routeSlots(round: RouteRound): Promise<RouteSlot[]> {
    const settings = await this.loopSettings();
    const width = Math.max(1, settings.routeWidth);
    const slots: RouteSlot[] = [];
    const push = (direction: string, label: string, origin: RouteOrigin, ideaId?: string) => slots.push({ slot: slots.length + 1, direction, label, origin, ...(ideaId ? { ideaId } : {}) });
    const agentDirection = (index: number) => ROUTE_DIRECTIONS[((round.round - 1) * width + index) % ROUTE_DIRECTIONS.length];
    if (round.fork) {
      for (let index = 0; index < width; index++) { const direction = agentDirection(index); push(`fork_${direction.id}`, `Start from ${round.fork}: ${direction.label.charAt(0).toLowerCase()}${direction.label.slice(1)}`, 'fork'); }
      return slots;
    }
    const used = new Set((await this.routePlans()).flatMap((plan) => Array.isArray(plan.data.inspired_by) ? plan.data.inspired_by.map(String) : []));
    for (const idea of (await this.collect(this.paths.ideas)).values()) {
      const related = Array.isArray(idea.data.related_assets) ? idea.data.related_assets.map(String) : [];
      if (idea.data.status !== 'draft' || toIdeaKind(idea.data.idea_kind) !== 'approach' || idea.data.origin !== 'researcher' || !related.includes(round.target) || used.has(idea.id)) continue;
      push(idea.id, String(idea.data.title ?? idea.id), 'researcher', idea.id);
    }
    const direction = latestDirection(await this.decisions(), round.target);
    if (direction?.text && (direction.routeRound ?? 0) >= round.round - 1) push('direction', direction.text.split('\n')[0], direction.reason === 'autonomous' || direction.reason === 'agent_retry' ? 'agent' : 'researcher');
    for (let index = 0; slots.length < width; index++) { const next = agentDirection(index); push(next.id, next.label, 'agent'); }
    return slots;
  }

  /**
   * Before a round of routes: ask the researcher for routes of their own (not in autonomous mode or
   * for a fork), then assign the round's slots. Returns a message when the stage waits on that.
   */
  private async prepareRouteRound(): Promise<string | undefined> {
    const state = this.require();
    const round = state.current.route;
    if (!round) { await this.setStage('select', { assetId: undefined }); return `Run: ${LOOP_COMMAND} next`; }
    if (round.slots.length) return undefined;
    if (!round.asked) {
      round.asked = true;
      if (!(await this.autonomy()) && !round.fork) {
        const width = (await this.loopSettings()).routeWidth;
        await this.askQuestion('routes', `Before routes to ${round.target} are planned: do you have routes in mind? Write each as a line or separate them with ";" (for example "first prove the energy bound, then the decay; via compactness"). Let the agent decide, and it plans ${width} route(s) of its own; your routes come first, and the agent adds its own up to ${width}.`, { assetId: round.target, timeoutSec: (await this.loopSettings()).questionTimeoutSeconds });
        return `The researcher is asked for routes of their own to ${round.target} (a popup in VS Code). Wait for the answer, then run ${LOOP_COMMAND} next. Without the extension, ask in chat and record the answer with ${LOOP_COMMAND} question answer --text "...", or ${LOOP_COMMAND} question skip.`;
      }
    }
    round.slots = await this.routeSlots(round);
    await this.save();
    await this.event('route_round', { target: round.target, round: round.round, slots: round.slots.map((slot) => `${slot.slot}:${slot.origin}:${slot.direction}`) });
    return undefined;
  }

  private async routeMapInputs(target: string): Promise<{ goal: string; routes: Array<{ id: string; data: Record<string, any>; content: string }>; lemmaRaw: (id: string) => string | undefined }> {
    const goal = await this.files.readFile(`${this.paths.assets}/${target}.md`).catch(() => '');
    const routes = (await this.routePlans()).filter((plan) => plan.data.target_asset === target).map((plan) => ({ id: plan.id, data: plan.data, content: plan.body }));
    const assets = await this.collectKind('asset');
    return { goal, routes, lemmaRaw: (id) => assets.get(id)?.raw };
  }

  private async routeMapDigestFor(target: string): Promise<string> {
    const { goal, routes, lemmaRaw } = await this.routeMapInputs(target);
    return routeMapDigest(goal, routes, lemmaRaw);
  }

  /** An approved route map still covers the result's open routes (see routeMapCovered). */
  private async routeMapApproved(target: string): Promise<boolean> {
    const record = (await this.approvals()).records.find((item) => item.kind === 'routes' && item.target === target);
    if (!record?.nodes) return false;
    const { goal, routes, lemmaRaw } = await this.routeMapInputs(target);
    return routeMapCovered({ statement: record.statement, routes: Object.fromEntries(Object.entries(record.nodes).map(([id, node]) => [id, node.digest])) }, goal, routes, lemmaRaw);
  }

  /** The researcher (or auto mode they turned on) approves a result's route map: each open route is recorded with its digest. */
  private async approveRouteMap(target: string, source: string): Promise<void> {
    const { goal, routes, lemmaRaw } = await this.routeMapInputs(target);
    if (!goal) throw new Error(`Unknown result ${target}.`);
    const statement = statementDigest(goal);
    const file = await this.approvals();
    file.records = file.records.filter((entry) => !(entry.kind === 'routes' && entry.target === target));
    const provenance = await this.provenance();
    const nodes = Object.fromEntries(Object.entries(routeMapEntries(routes, lemmaRaw)).map(([id, digest]) => [id, { digest, statement }]));
    file.records.push({ kind: 'routes', target, digest: routeMapDigest(goal, routes, lemmaRaw), statement, approvedAt: provenance.created_at, source, performed_by: provenance.performed_by, nodes, ...(provenance.base_commit ? { base_commit: provenance.base_commit } : {}) });
    await this.writeApprovals(file);
    if (this.state) {
      this.state.approvalQueue = this.state.approvalQueue.filter((item) => !(item.kind === 'routes' && item.target === target));
      await this.save();
    }
    await this.event('approved', { kind: 'routes', target, source });
  }

  /** The researcher asked for other routes: the open ones are dropped, and their words become the direction of the next round. */
  private async rejectRouteMap(target: string, text: string): Promise<void> {
    for (const plan of (await this.routePlans()).filter((item) => item.data.target_asset === target && item.data.status === 'pending')) {
      await this.dropRouteFile(plan, `The researcher asked for other routes${text.trim() ? `: ${text.trim()}` : '.'}`);
    }
    await this.writeDecision('direction', target, text.trim() || 'Plan other routes than the ones dropped.', { failedPlansAtDirection: await this.failedPlans(target) });
    await this.setStage('select', { assetId: undefined, planId: undefined });
  }

  private async dropRouteFile(plan: AssetInfo, reason: string): Promise<void> {
    const parsed = parseMarkdown(plan.raw);
    parsed.data.status = 'abandoned';
    await this.writeOwned(plan.file, stringifyMarkdown(`${parsed.content.trimEnd()}\n\n## Dropped\n\n${reason}\n`, parsed.data));
    await this.writeDecision('route_drop', plan.id, reason);
    await this.event('route_dropped', { planId: plan.id, target: plan.data.target_asset });
  }

  /**
   * The researcher asks for a round of routes to a result; with `fork`, every route of the round
   * starts from that settled result. Never automatic: the agent runs this only when the researcher asks.
   */
  async requestRoutes(target: string, fork?: string, note?: string): Promise<string> {
    const raw = await this.files.readFile(`${this.paths.assets}/${target}.md`).catch(() => '');
    if (!raw) throw new Error(`Unknown result ${target}.`);
    const data = parseMarkdown(raw).data;
    if (data.status !== 'draft' || !PROVABLE_TYPES.has(data.type) || isConstructionSpec(raw)) throw new Error(`${target} is not a draft theorem, lemma, or proposition still to prove.`);
    if (proofText(parseMarkdown(raw).content)) throw new Error(`${target} already has a proof; review it instead.`);
    if ((await this.loopSettings()).routeWidth === 0) throw new Error('Routes are off: Settings → Parallel routes → Routes per round is 0.');
    if (fork) {
      const assets = await this.collectKind('asset');
      const from = assets.get(fork);
      if (!from) throw new Error(`Unknown result ${fork}.`);
      if (from.data.status !== 'approved') throw new Error(`${fork} is not approved yet: a fork starts from a settled result.`);
      if (fork === target || assetClosure([fork], assets).order.includes(target)) throw new Error(`${fork} rests on ${target}: a route from it would be circular.`);
    }
    const last = await this.lastRouteRound(target);
    await this.writeDecision('route_request', target, note?.trim() || (fork ? `Plan routes to ${target} that start from ${fork}.` : `Plan a round of routes to ${target}.`), { routeRound: last, ...(fork ? { fork } : {}) });
    if (this.state) {
      if (this.state.parked[target]) await this.clearPark(target, 'routes requested');
      if (this.state.current.assetId === target && this.state.stage === 'plan') await this.setStage('select', { assetId: undefined });
      await this.save();
    }
    return `Routes requested for ${target}${fork ? `, starting from ${fork}` : ''}. The loop plans them when it next reaches ${target}; continue with ${LOOP_COMMAND} next.`;
  }

  /** The researcher drops one route. */
  async dropRoute(planId: string, reason: string): Promise<string> {
    const plan = (await this.routePlans()).find((item) => item.id === planId);
    if (!plan) throw new Error(`${planId} is not a route.`);
    if (plan.data.status !== 'pending') throw new Error(`${planId} is ${plan.data.status}, not open.`);
    if (!reason.trim()) throw new Error('Say why with --reason.');
    await this.dropRouteFile(plan, reason.trim());
    if (this.state?.current.planId === planId) await this.setStage('select', { assetId: undefined, planId: undefined });
    return `Route ${planId} dropped. Continue with ${LOOP_COMMAND} next.`;
  }

  private requireMergeStage(): RouteRound {
    const state = this.require();
    if (state.stage !== 'route_merge' || !state.current.route) throw new Error('Routes are merged only during stage route_merge.');
    return state.current.route;
  }

  /**
   * Stage route_merge: `dup` states the same as `keep`; every open route that uses `dup` uses `keep`
   * instead, and `dup` is archived with `merged_into`. Only a draft lemma that nothing but routes
   * uses can be merged away.
   */
  async mergeRouteLemma(dup: string, keep: string): Promise<string> {
    this.requireMergeStage();
    if (dup === keep) throw new Error('Name two different results.');
    const assets = await this.collectKind('asset');
    const from = assets.get(dup); const into = assets.get(keep);
    if (!from || from.origin) throw new Error(`${dup} is not a result of this project.`);
    if (!into) throw new Error(`Unknown result ${keep}.`);
    if (into.data.type === CONJECTURE_TYPE || ['deprecated', 'archived'].includes(into.data.status)) throw new Error(`${keep} is a conjecture or retired; a route cannot rest on it.`);
    if (from.data.status !== 'draft' || proofText(from.body)) throw new Error(`${dup} is approved or proved; merge the other way round.`);
    const project = await this.files.readFile(this.paths.projectMd).catch(() => '');
    if (requiredAssetIds(project).includes(dup)) throw new Error(`${dup} is a required result; it cannot be merged away.`);
    const users = [...assets.values()].filter((node) => Array.isArray(node.data.depends_on) && node.data.depends_on.includes(dup)).map((node) => node.id);
    if (users.length) throw new Error(`${dup} is in the depends_on of ${users.join(', ')}; only a lemma that routes alone use can be merged away.`);
    const changed: string[] = []; const abandoned: string[] = [];
    for (const plan of (await this.routePlans()).filter((item) => item.data.status === 'pending' && routeLemmas(item.data).includes(dup))) {
      const parsed = parseMarkdown(plan.raw);
      if (parsed.data.target_asset === keep || assetClosure([keep], assets).order.includes(String(parsed.data.target_asset))) {
        parsed.data.status = 'abandoned';
        await this.writeOwned(plan.file, stringifyMarkdown(`${parsed.content.trimEnd()}\n\n## Abandoned\n\n${dup} is the same as ${keep}, on which ${parsed.data.target_asset} cannot rest.\n`, parsed.data));
        abandoned.push(plan.id);
        continue;
      }
      parsed.data.route_lemmas = [...new Set(routeLemmas(parsed.data).map((id) => id === dup ? keep : id))];
      await this.writeOwned(plan.file, stringifyMarkdown(parsed.content.replace(new RegExp(`\\b${dup}\\b`, 'g'), keep), parsed.data));
      changed.push(plan.id);
    }
    if (!changed.length && !abandoned.length) throw new Error(`No open route uses ${dup}.`);
    const parsed = parseMarkdown(from.raw);
    parsed.data.status = 'archived';
    parsed.data.merged_into = keep;
    await this.writeOwned(from.file, stringifyMarkdown(parsed.content, parsed.data));
    await this.event('route_lemmas_merged', { dup, keep, routes: changed, abandoned });
    return `${dup} merged into ${keep}: ${changed.length ? `the route(s) ${changed.join(', ')} now use ${keep}` : 'no route still uses it'}${abandoned.length ? `; ${abandoned.join(', ')} abandoned (they would rest on their own target)` : ''}.`;
  }

  /** Stage route_merge: `strong` implies `weak`. `weak` gets a route of its own from `strong`, so proving either serves the routes that need `weak`. */
  async implyRouteLemma(strong: string, weak: string, note?: string): Promise<string> {
    this.requireMergeStage();
    if (strong === weak) throw new Error('Name two different results.');
    const assets = await this.collectKind('asset');
    const from = assets.get(strong); const to = assets.get(weak);
    if (!from || !to) throw new Error(`Unknown result ${!from ? strong : weak}.`);
    if (from.data.type === CONJECTURE_TYPE || ['deprecated', 'archived'].includes(from.data.status)) throw new Error(`${strong} is a conjecture or retired; a route cannot rest on it.`);
    if (to.origin || to.data.status !== 'draft' || proofText(to.body)) throw new Error(`${weak} is not a draft result still to prove.`);
    if (assetClosure([strong], assets).order.includes(weak)) throw new Error(`${strong} already rests on ${weak}.`);
    const converse = (await this.routePlans()).find((plan) => plan.data.status === 'pending' && plan.data.target_asset === strong && routeLemmas(plan.data).includes(weak));
    if (converse) throw new Error(`${weak} already implies ${strong} (${converse.id}): they are equivalent, so merge them instead (${LOOP_COMMAND} route merge <dup> --into <keep>).`);
    const id = `route_${weak}_from_${strong}`.slice(0, 120);
    const file = `${this.paths.plans}/${id}.md`;
    if (await this.files.exists(file)) throw new Error(`${id} exists already.`);
    const title = String(from.data.title ?? strong);
    const body = `\n## Goal\n\nTarget: [${weak}](../assets/${weak}.md)\n\n## Route\n\n- ${strong}: ${note?.trim() || `it implies ${weak} directly.`}\n\n## Plan\n\n1. [ ] Derive ${weak} from ${strong}.\n\n## Verification\n\nThe derivation gives the exact statement of ${weak}.\n`;
    await this.writeOwned(file, stringifyMarkdown(body, { type: 'plan', title: `Route to ${weak} from ${title}`, status: 'pending', target_asset: weak, route_lemmas: [strong], route_title: `from ${title}`, origin: 'agent', route_round: (await this.lastRouteRound(weak)) + 1, inspired_by: [], tags: ['route'] }));
    await this.event('route_implied', { strong, weak, planId: id });
    return `${weak} gets the route ${id} from ${strong}: proving ${strong} now serves every route that needs ${weak}.`;
  }

  /** Stage route_merge: two lemmas look alike but differ; the difference is kept as an observation. */
  async distinctRouteLemmas(a: string, b: string, note: string): Promise<string> {
    this.requireMergeStage();
    if (!note.trim()) throw new Error('Say how they differ with --note.');
    const idea = await this.saveIdea(`${a} and ${b} differ`, note.trim(), [a, b], 'agent', ['route'], 'observation');
    return `Recorded how ${a} and ${b} differ (${idea}).`;
  }

  /** The routes to a result, for the researcher and the CLI: state, reduction, lemmas settled, and the work left. */
  async routeStatus(target: string): Promise<{ target: string; routes: RouteInfo[]; text: string }> {
    const assets = await this.collectKind('asset');
    if (!assets.has(target)) throw new Error(`Unknown result ${target}.`);
    const approvals = (await this.approvals()).records;
    const settled = new Set([...assets.values()].filter((node) => node.data.status === 'approved' && (node.origin === 'library' || isApproved(approvals, 'asset', node.id, node.raw))).map((node) => node.id));
    const examples = [...assets.values()].filter((node) => node.data.type === 'example' && typeof node.data.refutes === 'string');
    const settings = await this.loopSettings();
    const { routes, graph } = await this.routeGraph({ assets, settled, examples, maxLive: settings.maxLiveRoutes });
    const mine = routes.filter((route) => route.target === target);
    const numbers = new ProofNumbers(graph);
    const lines = mine.map((route) => {
      const left = numbers.ofRoute(route);
      return `- ${route.title} (${route.planId}, ${route.origin}${route.forkedFrom ? ` from ${route.forkedFrom}` : ''}): ${route.state}; reduction ${route.reduction}; lemmas ${route.settledLemmas}/${route.lemmas.length}${route.lemmas.length ? ` (${route.lemmas.join(', ')})` : ''}${Number.isFinite(left) && isActiveRoute(route) ? `; ${left} step(s) left` : ''}${route.death ? `; ${route.death.lemma} ${route.death.kind}` : ''}${route.suspendedBy?.length ? `; waits on ${route.suspendedBy.join(', ')}` : ''}`;
    });
    const open = mine.filter(isOpenRoute).length;
    const text = mine.length ? [`Routes to ${target}: ${open} open of ${mine.length}`, ...lines].join('\n') : `No routes to ${target} yet.`;
    return { target, routes: mine, text };
  }

  // ---------- conjectures ----------

  /** The agent may make conjecture ideas precise and search conjectures on its own: in autonomous mode, or in auto mode with the researcher's rule. */
  private async conjectureWorkAllowed(): Promise<boolean> {
    const settings = await this.loopSettings();
    return settings.autonomy.enabled || (settings.autoApprove.enabled && settings.autoApprove.conjectureIdeas);
  }

  /**
   * Work on conjectures once nothing on the way to the goals is actionable. A conjecture whose
   * statement no search has checked is searched for a counterexample (never planned or proved);
   * a checked one goes to the researcher to agree on its statement; then a conjecture idea is made
   * precise. Searching and making ideas precise need the researcher's permission (or their request
   * for that idea or conjecture); asking them to agree on a statement does not.
   */
  private async conjectureWork(input: { assets: Map<string, AssetInfo>; approvals: ApprovalRecord[]; checks: CheckInfo[]; examples: AssetInfo[]; refuteSearch: string }): Promise<Selection | undefined> {
    const state = this.require();
    const allowed = await this.conjectureWorkAllowed();
    const requests = state.conjectureRequests ?? [];
    let search: Selection | undefined;
    for (const [id, asset] of input.assets) {
      if (asset.origin || asset.data.type !== CONJECTURE_TYPE || !['draft', 'approved'].includes(asset.data.status)) continue;
      if (input.examples.some((example) => example.data.refutes === id && example.data.status === 'approved')) continue;
      const pending = input.examples.find((example) => example.data.refutes === id && example.data.status === 'draft');
      if (pending) {
        await this.enqueueApproval('counterexample', pending.id, `Candidate counterexample to the conjecture ${id}: confirm or reject.`);
        if (!state.parked[id]) state.parked[id] = { reason: 'counterexample_pending', at: this.now() };
        continue;
      }
      if (state.parked[id] || statementIncomplete(asset.body)) continue;
      if (asset.data.status === 'approved' && isApproved(input.approvals, 'asset', id, asset.raw)) continue;
      const falsified = this.isFalsified(id, asset.raw, input.checks);
      // A deeper search the researcher asked for (search request) runs even on a checked statement, like a goal's.
      const deeper = Boolean(await this.searchRequest(id));
      const requested = requests.includes(id);
      if (deeper || (!falsified && (input.refuteSearch === 'all' || requested) && (allowed || requested))) { search ??= { stage: 'search', assetId: id, mode: 'refute' }; continue; }
      await this.enqueueApproval('asset', id, falsified
        ? 'Conjecture: a counterexample search found nothing; agree on the statement so the paper may state it.'
        : 'Conjecture: agree on the statement so the paper may state it (no counterexample search has checked it).');
    }
    if (search) return search;
    const ideas = await this.conjectureIdeas();
    const next = ideas.find((idea) => requests.includes(idea.id)) ?? (allowed ? ideas[0] : undefined);
    return next ? { stage: 'conjecture', ideaId: next.id } : undefined;
  }

  /** Draft conjecture ideas not yet tried, the researcher's first. */
  private async conjectureIdeas(): Promise<AssetInfo[]> {
    const tried = new Set(this.require().conjectureTried ?? []);
    return [...(await this.collect(this.paths.ideas)).values()]
      .filter((idea) => idea.data.type === 'idea' && idea.data.status === 'draft' && idea.data.idea_kind === 'conjecture' && !tried.has(idea.id))
      .sort((a, b) => Number(b.data.origin === 'researcher') - Number(a.data.origin === 'researcher') || a.id.localeCompare(b.id));
  }

  /** The researcher asks for a conjecture idea to be made precise, or a conjecture to be searched, whatever the settings allow. */
  async requestConjecture(id: string): Promise<string> {
    const state = this.require();
    const idea = await this.files.readFile(`${this.paths.ideas}/${id}.md`).catch(() => '');
    const asset = idea ? '' : await this.files.readFile(`${this.paths.assets}/${id}.md`).catch(() => '');
    const data = idea ? parseMarkdown(idea).data : asset ? parseMarkdown(asset).data : undefined;
    if (!data) throw new Error(`Unknown idea or conjecture ${id}.`);
    if (idea && (data.idea_kind !== 'conjecture' || data.status !== 'draft')) throw new Error(`${id} is not a draft conjecture idea (idea_kind: conjecture).`);
    if (asset && data.type !== CONJECTURE_TYPE) throw new Error(`${id} is not a conjecture.`);
    state.conjectureRequests = [...new Set([...(state.conjectureRequests ?? []), id])];
    if (idea) state.conjectureTried = (state.conjectureTried ?? []).filter((item) => item !== id);
    await this.save();
    await this.event('conjecture_requested', { id });
    return idea
      ? `The agent makes ${id} precise once nothing on the way to the goals is actionable.`
      : `The agent searches ${id} for a counterexample once nothing on the way to the goals is actionable.`;
  }

  /** A conjecture is settled for now: take it off the researcher's requests. */
  private dropConjectureRequest(id: string): void {
    const state = this.require();
    if (!state.conjectureRequests?.includes(id)) return;
    state.conjectureRequests = state.conjectureRequests.filter((item) => item !== id);
    if (!state.conjectureRequests.length) delete state.conjectureRequests;
  }

  /** A retyped node keeps its falsification: the check is carried over to the new statement digest when only the type or the motivation changed. */
  private async carryChecks(id: string, before: string, after: string, change: string): Promise<void> {
    const checks = await this.checks();
    if (this.isFalsified(id, after, checks)) return;
    const digest = statementDigest(before);
    const old = checks.filter((check) => check.target === id && check.statementDigest === digest).pop();
    if (!old) return;
    const outcome = old.outcome === 'counterexample_rejected' ? 'counterexample_rejected' : 'no_counterexample_found';
    await this.writeCheck(id, outcome, `- Carried over from ${old.id}: only ${change} changed, not the mathematical statement.`, `See ${old.id} for the cases searched and the limitations of that search.`);
  }

  /**
   * Make a conjecture a goal. Only while the goals are drafted (an extension the researcher asked
   * for, or an autonomous reassessment or exploration), because project.md must list it next. The
   * status returns to draft, so an agreed statement is never taken for a proof.
   */
  async promoteConjecture(id: string, as: string): Promise<string> {
    const state = this.require();
    if (state.stage !== 'draft_project') throw new Error(`A conjecture becomes a goal while the goals are drafted: run ${LOOP_COMMAND} extend --goal "Take up the conjecture ${id}" (at the researcher's request), then promote it in that stage.`);
    if (!(PROMOTED_TYPES as readonly string[]).includes(as)) throw new Error(`--as must be one of ${PROMOTED_TYPES.join(', ')}.`);
    const file = `${this.paths.assets}/${id}.md`;
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw) throw new Error(`Unknown asset ${id}.`);
    const parsed = parseMarkdown(raw);
    if (parsed.data.type !== CONJECTURE_TYPE) throw new Error(`${id} is a ${String(parsed.data.type)}, not a conjecture.`);
    if (!['draft', 'approved'].includes(parsed.data.status)) throw new Error(`${id} is ${String(parsed.data.status)}; only an active conjecture becomes a goal.`);
    const examples = [...(await this.collectKind('asset')).values()].filter((asset) => asset.data.type === 'example' && asset.data.refutes === id && ['draft', 'approved'].includes(asset.data.status));
    if (examples.length) throw new Error(`${id} has a counterexample (${examples.map((item) => item.id).join(', ')}); it cannot become a goal.`);
    parsed.data.type = as;
    parsed.data.status = 'draft';
    delete parsed.data.serves;
    delete parsed.data.priority;
    const promoted = stringifyMarkdown(parsed.content, parsed.data);
    await this.writeOwned(file, promoted);
    await this.carryChecks(id, raw, promoted, 'the type');
    this.dropConjectureRequest(id);
    await this.save();
    await this.event('conjecture_promoted', { id, as });
    return `${id} is now a draft ${as}. List it under required_results in ${this.paths.projectMd} and say in ## Intended Contribution what it adds; then report as the stage asks.`;
  }

  /**
   * Turn a draft result that no goal needs any more (a new route got past it) into a conjecture,
   * instead of leaving it set aside: its failed plans and search records stay with it. Its pending
   * plans are abandoned and the park is lifted. Between stages only, never for the current asset.
   */
  async demoteToConjecture(id: string, note: string, serves: string[] = []): Promise<string> {
    const state = this.require();
    if (state.current.assetId === id && !['select', 'waiting', 'ready', 'draft_project'].includes(state.stage)) throw new Error(`${id} is the asset of the current stage ${state.stage}; finish the stage first.`);
    const file = `${this.paths.assets}/${id}.md`;
    const raw = await this.files.readFile(file).catch(() => '');
    if (!raw) throw new Error(`Unknown asset ${id}.`);
    const parsed = parseMarkdown(raw);
    if (!(PROMOTED_TYPES as readonly string[]).includes(parsed.data.type)) throw new Error(`Only a theorem, lemma, or proposition becomes a conjecture; ${id} is a ${String(parsed.data.type)}.`);
    if (parsed.data.status !== 'draft') throw new Error(`${id} is ${String(parsed.data.status)}; only a draft result becomes a conjecture.`);
    if (proofText(parsed.content)) throw new Error(`${id} has a proof waiting for review; review it instead.`);
    const assets = await this.collectKind('asset');
    const required = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => ''));
    const { order } = assetClosure(required, assets);
    if (order.includes(id)) throw new Error(`${id} is still on the way to the goals${required.includes(id) ? ' (it is a required result)' : ''}; change the goals first so that none depends on it.`);
    for (const target of serves) if (!assets.has(target)) throw new Error(`serves names an unknown result: ${target}.`);
    const motivation = sectionContent(parsed.content, 'Motivation');
    if (!note.trim() && !motivation) throw new Error('Say in --note why it is still believed and what it would give; it becomes the ## Motivation.');
    const content = note.trim()
      ? motivation ? parsed.content.replace(/^## Motivation[ \t]*$/m, `## Motivation\n\n${note.trim()}\n`) : `${parsed.content.trimEnd()}\n\n## Motivation\n\n${note.trim()}\n`
      : parsed.content;
    parsed.data.type = CONJECTURE_TYPE;
    if (serves.length) parsed.data.serves = serves;
    const demoted = stringifyMarkdown(content, parsed.data);
    await this.writeOwned(file, demoted);
    await this.carryChecks(id, raw, demoted, 'the type and the motivation');
    const abandoned = await this.abandonPlans(id, 'Abandoned: the result became a conjecture, since no goal needs it any more.');
    await this.clearPark(id, 'It became a conjecture: no goal needs it any more.');
    await this.save();
    await this.event('conjecture_demoted', { id, abandoned });
    return `${id} is now a conjecture${abandoned.length ? `; its pending plan(s) ${abandoned.join(', ')} were abandoned` : ''}. Its failed plans and search records stay with it.`;
  }

  /** Conjectures ranked against the goals (see rankConjectures). */
  private async rankedConjectures(): Promise<RankedConjecture[]> {
    const state = this.require();
    const { assets, proved } = await this.progress();
    const required = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => ''));
    const open = new Set<string>(assetClosure(required.filter((id) => !proved.has(id)), assets).order.filter((id) => !proved.has(id)));
    for (const id of Object.keys(state.parked)) open.add(id);
    const checks = await this.checks();
    const approvals = (await this.approvals()).records;
    const examples = [...assets.values()].filter((asset) => asset.data.type === 'example' && typeof asset.data.refutes === 'string');
    const raisedBy = new Set([...(await this.collect(this.paths.ideas)).values()].filter((idea) => idea.data.origin === 'researcher' && idea.data.idea_kind === 'conjecture' && typeof idea.data.resolved_by === 'string').map((idea) => String(idea.data.resolved_by)));
    const conjectures = [...assets.values()].filter((asset) => !asset.origin && asset.data.type === CONJECTURE_TYPE).map((asset) => ({
      id: asset.id,
      status: asset.data.status === 'approved' && !isApproved(approvals, 'asset', asset.id, asset.raw) ? 'draft' : String(asset.data.status),
      serves: Array.isArray(asset.data.serves) ? asset.data.serves.map(String) : [],
      priority: asset.data.priority === 'high' || asset.data.priority === 'low' ? asset.data.priority : undefined,
      researcher: raisedBy.has(asset.id),
      falsified: this.isFalsified(asset.id, asset.raw, checks),
      refuted: examples.some((example) => example.data.refutes === asset.id && example.data.status === 'approved'),
    }));
    return rankConjectures(conjectures, { open, proved: new Set(proved.keys()) });
  }

  /** Every active conjecture, ranked; for `conjecture list`. */
  async conjectureList(): Promise<RankedConjecture[]> { return this.rankedConjectures(); }

  /** The conjectures worth taking up next, for the researcher: at the end of the goals and at hand-back. */
  async conjectureRecommendation(): Promise<string | undefined> {
    const ranked = (await this.rankedConjectures()).filter((item) => item.agreed || item.falsified);
    if (!ranked.length) return undefined;
    return `Conjectures worth taking up next, best first:\n${describeConjectures(ranked, CONJECTURES_LISTED)}\nRecommend them to the researcher. If they want one as a goal, run ${LOOP_COMMAND} extend --goal "Take up the conjecture <id>" and promote it there (${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition).`;
  }

  /**
   * Autonomous mode, with the researcher's permission (autonomyConjectures): the goals are proved,
   * or nothing else is left that the agent can do, so it takes up a conjecture as a goal of its
   * own, best first. An extension like a reassessment's: it never drops the researcher's goals.
   * Returns whether an exploration started.
   */
  private async exploreConjecture(run: NonNullable<LoopState['autonomy']>, why: string): Promise<boolean> {
    const state = this.require();
    const settings = await this.loopSettings();
    if ((run.explored ?? 0) >= settings.autonomyConjectures || !(await this.isProjectApproved())) return false;
    const ranked = (await this.rankedConjectures()).filter((item) => item.agreed || item.falsified);
    if (!ranked.length) return false;
    run.explored = (run.explored ?? 0) + 1;
    const left = Math.max(0, settings.autonomyBudget - run.spent);
    const goal = [
      `Autonomous exploration ${run.explored} of ${settings.autonomyConjectures} (the researcher is away and allowed it): ${why}. Take up one conjecture as a goal of your own; the leading ones, best first:`,
      describeConjectures(ranked, CONJECTURES_LISTED),
      `Read the leading ones (show <id>) and judge which is worth the budget (${left} attempt(s) left). To take one up: ${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition, list it under required_results, and say in ## Intended Contribution what it adds. Then run: ${LOOP_COMMAND} report complete --summary "<what you took up and why>". If none is worth it now, run: ${LOOP_COMMAND} report none --summary "<why>"; the loop then hands back.`,
    ].join('\n');
    await this.markExtension(goal);
    state.researcherInput = { kind: 'autonomous_conjecture', text: goal, at: this.now() };
    state.lastError = null;
    await this.event('autonomy_exploration', { explored: run.explored, candidates: ranked.slice(0, CONJECTURES_LISTED).map((item) => item.id) });
    await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined, ideaId: undefined });
    return true;
  }

  // ---------- rewordings from the teaching chat ----------

  private async removeFile(file: string): Promise<void> {
    if (this.files.deleteFile) await this.files.deleteFile(file);
    else await this.files.writeFile(file, '');
  }

  /** Remarks a rewording proposed before remarks had files of their own: the researcher's, from the teaching chat. */
  private async legacyRemarks(assetId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.remarks().add({ target: assetId, title: 'Remarks from the teaching chat', body: text, origin: 'researcher', from: 'teaching' }, { at: this.now() });
    await this.event('remark_added', { assetId, origin: 'researcher', from: 'teaching' });
  }

  /**
   * Apply one rewording the teaching chat proposed (see revisions.ts). Remarks
   * an older proposal carried become a remark file at once. A reworded proof replaces the old one, which its rewrite plan keeps, and the
   * independent check runs on it next, whatever the researcher's check
   * setting. A proposal made against an older version is dropped. Returns
   * true when it started that check.
   */
  private async startRevision(): Promise<boolean> {
    for (const file of await this.files.listFiles(REVISIONS_DIR, '.json')) {
      let revision: ProofRevision | undefined;
      try { revision = JSON.parse(await this.files.readFile(file)) as ProofRevision; } catch { revision = undefined; }
      const drop = async (reason: string) => { await this.removeFile(file); await this.event('revision_discarded', { assetId: revision?.id, reason }); };
      if (!revision?.id) { await drop('unreadable'); continue; }
      const nodeFile = (await findNodeFile(this.files, this.paths, 'asset', revision.id)) ?? (await findNodeFile(this.files, this.paths, 'definition', revision.id));
      if (!nodeFile || isLibraryPath(nodeFile, this.paths)) { await drop('no such result in the project'); continue; }
      const raw = await this.files.readFile(nodeFile);
      const parts = understandingParts(raw);
      if (parts.statementDigest !== revision.baseStatement || (revision.proof && parts.proofDigest !== revision.baseProof)) { await drop('the result changed after the rewording was proposed'); continue; }
      const parsed = parseMarkdown(raw);
      if (revision.remarks) await this.legacyRemarks(revision.id, revision.remarks);
      if (!revision.proof) { await this.removeFile(file); continue; }
      const wasApproved = parsed.data.status === 'approved' && isApproved((await this.approvals()).records, 'asset', revision.id, raw);
      // The changed proof is not what the researcher approved: it is a draft again until they accept it.
      const data = { ...parsed.data, status: parsed.data.status === 'approved' ? 'draft' : parsed.data.status };
      const newRaw = stringifyMarkdown(withProof(parsed.content, revision.proof), data);
      await this.files.writeFile(nodeFile, newRaw);
      let planId = `${revision.id}_rewording`;
      for (let n = 2; await this.files.exists(`${this.paths.plans}/${planId}.md`); n++) planId = `${revision.id}_rewording_${n}`;
      const previous = stripManagedBlocks(sectionContent(parsed.content, 'Proof')).trim();
      const body = [
        `## Goal\n\nTarget: [${String(parsed.data.title ?? revision.id)}](../assets/${revision.id}.md)\n\nReword the proof as the researcher asked in the teaching chat; the mathematics stays the same.`,
        '## Plan\n\n1. [x] Reword the proof as described under ## Changes.',
        '## Verification\n\nAn independent check of the reworded proof against the statement, as for any proof.',
        `## Changes\n\n${revision.changes ?? 'Rewording.'}`,
        `## Previous proof\n\n${previous}`,
        `## Outcome\n\nThe reworded proof is in [${String(parsed.data.title ?? revision.id)}](../assets/${revision.id}.md).`,
      ].join('\n\n');
      await this.files.writeFile(`${this.paths.plans}/${planId}.md`, stringifyMarkdown(`\n${body}\n`, {
        type: 'plan', title: `Reworded proof of ${String(parsed.data.title ?? revision.id)}`, status: 'succeeded', target_asset: revision.id, purpose: 'rewrite', inspired_by: [], tags: [],
        proof_digest: proofDigest(newRaw), statement_digest: statementDigest(newRaw), dependency_digests: await this.dependencyDigests(data) ?? {},
        rewrites_proof_digest: parts.proofDigest, ...(wasApproved ? { was_approved: true } : {}),
      }));
      await this.removeFile(file);
      await this.event('revision_started', { assetId: revision.id, planId });
      await this.setStage('verify_proof', { assetId: revision.id, planId, counterexampleId: undefined });
      return true;
    }
    return false;
  }

  /** A confirmed rewording: the researcher's understanding moves to the wording they asked for (and remarks an older rewording plan carried become a remark file). */
  private async finishRewrite(assetId: string, planContent: string, planData: Record<string, any>, assetRaw: string): Promise<void> {
    if (/^## Remarks to add[ \t]*$/m.test(planContent)) {
      const remarks = sectionContent(planContent, 'Remarks to add');
      if (remarks !== '(remove the remarks)') await this.legacyRemarks(assetId, remarks);
    }
    await new Teaching(this.files, this.paths).carryMark(assetId, String(planData.rewrites_proof_digest ?? ''), assetRaw, this.now());
  }

  /** A rejected rewording: the previous proof comes back (approved again when it was), and the rewrite plan is abandoned, not counted as a failed attempt. */
  private async rejectRewrite(assetId: string, planId: string): Promise<string> {
    const planFile = `${this.paths.plans}/${planId}.md`;
    const plan = parseMarkdown(await this.files.readFile(planFile));
    const file = `${this.paths.assets}/${assetId}.md`;
    const asset = parseMarkdown(await this.files.readFile(file));
    const restored = { content: withProof(asset.content, sectionContent(plan.content, 'Previous proof')), data: { ...asset.data } };
    const approvedAgain = plan.data.was_approved === true && isApproved((await this.approvals()).records, 'asset', assetId, stringifyMarkdown(restored.content, { ...restored.data, status: 'approved' }));
    if (approvedAgain) restored.data.status = 'approved';
    await this.writeOwned(file, stringifyMarkdown(restored.content, restored.data));
    plan.data.status = 'abandoned';
    delete plan.data.verified_proof_digest;
    const content = `${plan.content.trimEnd()}\n\n## Failure\n\nThe independent check rejected the reworded proof; ## Verdict names the step. The previous proof was restored.\n`;
    await this.writeOwned(planFile, stringifyMarkdown(content, plan.data));
    await this.event('revision_rejected', { assetId, planId });
    return `The reworded proof of ${assetId} did not pass the independent check (## Verdict in ${planId}); the previous proof is back${approvedAgain ? ' and still approved' : ''}. Tell the researcher in one line, naming the step; the teaching chat shows the verdict. Continue with next.`;
  }

  /** Verified results the researcher has not studied, when that reaches their `studyAhead` limit; never while the agent works on its own. */
  private async studyBacklog(): Promise<{ count: number; limit: number } | undefined> {
    const settings = await this.loopSettings();
    if (!settings.studyAhead || settings.autonomy.enabled) return undefined;
    const { behind } = await new Teaching(this.files, this.paths).overview();
    return behind >= settings.studyAhead ? { count: behind, limit: settings.studyAhead } : undefined;
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
      if (run.deciding && state.stage !== 'batch') return this.result(await this.decisionInstruction(run.deciding));
    }
    // A batch is reported in full first, whatever one of its items raised.
    if (state.stage === 'batch' && !state.current.batch?.items.some((item) => !item.done)) await this.setStage('select', { assetId: undefined, planId: undefined });
    if (state.pendingQuestion && state.stage !== 'batch') return this.result(`Question ${state.pendingQuestion.id} (${state.pendingQuestion.kind}) is waiting for the researcher: ${state.pendingQuestion.prompt}`);
    // Selection reads nodes leniently and skips a file it cannot parse; deciding on that view would treat an existing result as missing.
    const unparsable = await this.unparsableNodes();
    if (unparsable.length) return this.result(`These research files do not parse, so the loop cannot tell what they hold:\n${unparsable.map((problem) => `- ${problem}`).join('\n')}\nFix them (keep their IDs; run research-maintenance validate), then run next. Do not re-create them under new IDs.`);
    // What the current stage works from changed since it began: its work would rest on an earlier version.
    const drift = await this.inputDrift();
    const driftNote = drift.length ? await this.afterInputDrift(drift) : undefined;
    await this.refreshRetired();
    const perAsset = ['search', 'search_summary', 'verify_counterexample', 'verify_construction', 'plan', 'execute', 'verify_proof', 'route', 'route_merge', 'reduce', 'verify_reduction'].includes(state.stage);
    // `falsify` is the stage name older loop versions saved; selection now runs an object search instead.
    // A route map under review waits like the project's: selection works on other results meanwhile.
    let recompute = ['select', 'waiting', 'ready', 'review_project', 'review_routes', 'discuss_goals', 'falsify'].includes(state.stage);
    if (!recompute && !(await this.isProjectApproved()) && state.stage !== 'draft_project') recompute = true;
    if (perAsset && state.current.assetId) {
      const file = `${this.paths.assets}/${state.current.assetId}.md`;
      const data = (await this.files.exists(file)) ? parseMarkdown(await this.files.readFile(file)).data : undefined;
      // A re-check of an approved result marked for re-check runs on an approved asset.
      const recheckingApproved = state.stage === 'verify_proof' && Boolean(state.current.recheck?.length) && data?.status === 'approved';
      if (!data || (data.status !== 'draft' && !recheckingApproved) || state.parked[state.current.assetId]) recompute = true;
      if (data?.type === CONJECTURE_TYPE && !SEARCH_STAGES.has(state.stage)) recompute = true;
    }
    if (ROUTE_STAGES.has(state.stage) && !state.current.route) recompute = true;
    if ((state.stage === 'reduce' || state.stage === 'verify_reduction') && state.current.planId) {
      // The route was dropped, failed, or won meanwhile: there is nothing left to reduce or check.
      const raw = await this.files.readFile(`${this.paths.plans}/${state.current.planId}.md`).catch(() => '');
      let open = false;
      try { const data = raw ? parseMarkdown(raw).data : undefined; open = Boolean(data) && isRoutePlan(data) && data!.status === 'pending'; } catch { /* unreadable: choose again */ }
      if (!open) recompute = true;
    }
    // A node check whose target no longer waits for auto mode (approved meanwhile, changed, or held for the researcher) is dropped.
    if (state.stage === 'verify_node' && !(state.current.node && await this.needsNodeCheck(state.current.node))) recompute = true;
    if (state.stage === 'conjecture') {
      const idea = state.current.ideaId ? await this.files.readFile(`${this.paths.ideas}/${state.current.ideaId}.md`).catch(() => '') : '';
      let draft = false;
      try { draft = Boolean(idea) && parseMarkdown(idea).data.status === 'draft'; } catch { /* unreadable: choose again */ }
      if (!draft) recompute = true;
    }
    // Between stages, a rewording from the teaching chat goes first: its check is short and the researcher is waiting on it.
    if (recompute && await this.startRevision()) recompute = false;
    const chosen = recompute ? await this.computeSelection() : undefined;
    // With several workers allowed, independent results are worked on side by side.
    if (chosen && await this.startBatch(chosen)) recompute = false;
    if (recompute && chosen) {
      const selection = chosen;
      const patch: Partial<LoopState['current']> = 'assetId' in selection ? { assetId: selection.assetId, planId: undefined, counterexampleId: undefined, ideaId: undefined } : { assetId: undefined, planId: undefined, counterexampleId: undefined, ideaId: undefined };
      if (selection.stage === 'conjecture') patch.ideaId = selection.ideaId;
      if (selection.stage === 'verify_node') { patch.node = selection.node; patch.assetId = selection.node.id; }
      if (selection.stage === 'plan' && 'assetId' in selection) {
        patch.planId = await this.pendingPlan(selection.assetId);
        patch.repair = selection.repair;
      }
      if (selection.stage === 'reduce' || selection.stage === 'verify_reduction') patch.planId = selection.planId;
      if (selection.stage === 'route') patch.route = { target: selection.assetId, round: (await this.lastRouteRound(selection.assetId)) + 1, slots: [], ...(selection.fork ? { fork: selection.fork } : {}) };
      if (selection.stage === 'verify_proof') {
        patch.planId = selection.planId;
        patch.recheck = selection.recheck?.length ? selection.recheck : undefined;
        // A re-check writes a fresh verdict: the earlier one stays in the plan under another heading, so it cannot pass for the new one.
        if (selection.recheck?.length) await this.setAsideVerdict(selection.planId);
      }
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
      if (selection.stage === 'waiting' && run && !(await this.assessGoals(run)) && !(await this.exploreConjecture(run, `nothing else is left that it can do on its own (${selection.reason})`))) return this.result(await this.handOver(`nothing is left that it can do on its own (${selection.reason})`));
      if (selection.stage === 'ready' && run) await this.exploreConjecture(run, 'every goal is proved');
    }
    if (state.stage === 'route') {
      const waiting = await this.prepareRouteRound();
      if (waiting) return this.result(waiting);
    }
    const result = this.result();
    const settled = await this.closeIntakes();
    if (settled) result.instruction = `${settled}\n\n${result.instruction}`;
    if (driftNote) result.instruction = `${driftNote.replace(/ (Continue with next\.|Check again against the current version: run next for the fresh context\.)/, '')}\n\n${result.instruction}`;
    if (state.stage === 'ready') {
      const manuscript = await this.manuscriptStatus();
      if (manuscript) result.instruction += `\n${manuscript}`;
      const conjectures = await this.conjectureRecommendation();
      if (conjectures) result.instruction += `\n${conjectures}`;
    }
    if (!hasContextPack(state.stage)) return result;
    const pack = await this.contextPack();
    result.brief.context = { file: CONTEXT_PACK_PATH, tokens: pack.tokens, items: pack.included.map((item) => `${item.id}${Array.isArray(item.view) ? `#${item.view.join(',')}` : item.view === 'all' ? '' : `#${item.view}`}`), omitted: pack.omitted.map((item) => item.id), ...(pack.packs ? { packs: pack.packs } : {}) };
    if (pack.manifest.worker) result.brief.worker = pack.manifest.worker;
    if (pack.packs) {
      const unit = state.stage === 'batch' ? 'item' : 'slot';
      result.instruction += `\nWorker packs (research-worker-${pack.manifest.worker ?? 'deep'}, one per ${unit}; give each worker only its own pack and do not read them yourself): ${pack.packs.map((item) => `${unit} ${item.slot}: ${item.file} (~${item.tokens} tokens)`).join('; ')}.`;
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
    if (impact.state === 'current' && !impact.unplacedRemarks.length) return renderImpact(impact).split('\n')[0];
    return `${renderImpact(impact)}\nUpdate only these sections: plan-manuscript for uncovered results${impact.unplacedRemarks.length ? ' and approved remarks (propose where each goes, or list it under ## Excluded of the brief of its result; the researcher decides)' : ''}, draft-latex for stale ones (${MANUSCRIPT_COMMAND} prepare <section> lists only what changed). After the researcher reviews a section, they lock it with ${MANUSCRIPT_COMMAND} lock <section> --apply.`;
  }

  // ---------- context packs ----------

  private async contextSources(): Promise<ContextSources> {
    // Count reports only: a burst of context reads or search bookkeeping must not push an earlier report out of the window.
    const reports = await this.recentEvents(400, (event) => event.type === 'report');
    return {
      project: await this.files.readFile(this.paths.projectMd).catch(() => ''), projectFile: this.paths.projectMd,
      paperIndex: await this.files.readFile(this.paths.paperIndex).catch(() => ''), paperIndexFile: this.paths.paperIndex,
      assets: await this.collectKind('asset'), definitions: await this.collectKind('definition'),
      plans: await this.collect(this.paths.plans), ideas: await this.collect(this.paths.ideas), checks: await this.collect(this.shared.checks), candidates: await this.collect(this.shared.candidates),
      style: await new Teaching(this.files, this.paths).styleText(),
      reports: reports.map((event) => event as ContextSources['reports'][number]),
    };
  }

  /**
   * Compile the current stage's context pack, write it (and its manifest) to
   * the loop folder, and return it. Deterministic: same files, same pack.
   */
  async contextPack(budget?: number, out?: string): Promise<RenderedContext & { manifest: ContextManifest; packs?: Array<{ slot: number; direction: string; file: string; tokens: number }> }> {
    const state = this.require();
    if (state.stage === 'batch' && state.current.batch && !out) {
      // One pack per item, compiled as for its own stage; the driver never reads the workers' material.
      const packs: Array<{ slot: number; direction: string; file: string; tokens: number }> = [];
      const files = new Set<string>();
      let first: (RenderedContext & { manifest: ContextManifest }) | undefined;
      const saved = { stage: state.stage, current: state.current };
      try {
        for (const item of state.current.batch.items.filter((entry) => !entry.done)) {
          state.stage = item.stage;
          state.current = this.itemCurrent(item, saved.current);
          const file = `${STATE_DIR}/context/item-${item.item}.md`;
          const pack = await this.contextPack(budget, file);
          packs.push({ slot: item.item, direction: `${item.stage} ${item.assetId}`, file, tokens: pack.tokens });
          for (const entry of pack.files) files.add(entry);
          first ??= pack;
        }
      } finally { state.stage = saved.stage; state.current = saved.current; }
      const index = ['# Batch', '', 'One pack per item; each worker reads only its own.', '', ...packs.map((item) => `- item ${item.slot} (${item.direction}): ${item.file} (~${item.tokens} tokens)`), ''].join('\n');
      await this.files.writeFile(CONTEXT_PACK_PATH, index);
      const rendered = { ...first!, text: index, files: [...files], tokens: packs.reduce((sum, item) => sum + item.tokens, 0) };
      await this.files.writeFile(CONTEXT_MANIFEST_PATH, JSON.stringify({ stage: 'batch', stageStartedAt: state.current.stageStartedAt, tokens: rendered.tokens, packs }, null, 2) + '\n');
      return { ...rendered, manifest: { ...first!.manifest, stage: 'batch' }, packs };
    }
    const sources = await this.contextSources();
    const assetId = state.current.assetId;
    const limit = budget ?? (await this.contextBudget(state.stage));
    const focus = {
      // verify_construction checks a search candidate, named like the candidate a counterexample check reads.
      stage: state.stage, assetId, planId: state.current.planId, counterexampleId: state.stage === 'verify_construction' ? state.current.search?.candidateId : state.current.counterexampleId, ideaId: state.current.ideaId,
      missing: state.scaffoldBrief?.missing, incomplete: state.scaffoldBrief?.incomplete, researcherInput: state.researcherInput?.text,
      changesRequested: assetId ? state.progress[assetId]?.changesRequested : undefined,
      ...(assetId ? directionFocus(latestDirection(await this.decisions(), assetId)) : {}),
      ...(state.stage === 'verify_proof' && state.current.recheck?.length ? { recheck: state.current.recheck } : {}),
      ...(state.stage === 'verify_node' && state.current.node ? { node: state.current.node, assetId: undefined } : {}),
      ...(ROUTE_STAGES.has(state.stage) && state.current.route ? { route: { round: state.current.route.round, ...(state.current.route.fork ? { fork: state.current.route.fork } : {}) } } : {}),
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
    const round = state.stage === 'route' ? state.current.route : undefined;
    if (round?.slots.length && assetId) {
      // One pack per route worker, like a search round: the driver never reads the workers' material.
      const packs: Array<{ slot: number; direction: string; file: string; tokens: number }> = [];
      const files = new Set<string>();
      let first: (RenderedContext & { manifest: ContextManifest }) | undefined;
      for (const slot of round.slots) {
        const manifest = planContext({ ...focus, route: { round: round.round, slot, ...(round.fork ? { fork: round.fork } : {}) } }, sources, limit);
        const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
        const file = `${STATE_DIR}/context/route-${slot.slot}.md`;
        await this.files.writeFile(file, rendered.text);
        packs.push({ slot: slot.slot, direction: slot.direction, file, tokens: rendered.tokens });
        for (const item of rendered.files) files.add(item);
        first ??= { ...rendered, manifest };
      }
      if (this.files.deleteFile) for (const file of await this.files.listFiles(`${STATE_DIR}/context`, '.md')) {
        const slot = /route-(\d+)\.md$/.exec(file);
        if (slot && Number(slot[1]) > round.slots.length) await this.files.deleteFile(file);
      }
      const index = [`# Routes to ${assetId}, round ${round.round}`, '', 'One pack per worker slot; each worker reads only its own.', '', ...packs.map((item) => `- slot ${item.slot} (${item.direction}): ${item.file} (~${item.tokens} tokens)`), ''].join('\n');
      await this.files.writeFile(CONTEXT_PACK_PATH, index);
      const rendered = { ...first!, text: index, files: [...files], tokens: packs.reduce((sum, item) => sum + item.tokens, 0) };
      await writeManifest(rendered, first!.manifest, { packs });
      return { ...rendered, packs };
    }
    const manifest = planContext(focus, sources, limit);
    const rendered = renderContext(manifest, sources, `${LOOP_COMMAND} show`);
    await this.files.writeFile(out ?? CONTEXT_PACK_PATH, rendered.text);
    if (!out) await writeManifest(rendered, manifest);
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
      if (kind === 'asset' && !sections.length) return `${shown}\n\n${await this.derivedForAsset(id, raw)}`;
      if (kind === 'idea' && !sections.length) return `${shown}\n\n${await this.derivedForIdea(id)}`;
      return shown;
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
    const events = await this.recentEvents(400, (event) => String(event.at ?? '') >= since && (event.type === 'context_request' || event.type === 'context_outside_read'));
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
    // A long project is not listed in full: the list would crowd out the rest of the instruction, and the report checks it anyway.
    const entries = kept.length > EXTENSION_LISTED ? `all ${kept.length} existing required_results entries` : `every existing required_results entry (${kept.join(', ')})`;
    const keep = kept.length ? `keep ${entries} and leave approved statements unchanged` : 'leave approved statements unchanged';
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
        if (state.researcherInput?.kind === 'autonomous_conjecture') return `Stage draft_project: an autonomous exploration.\n${state.researcherInput.text}\nIf you take one up, edit only ${this.paths.projectMd} (the promote command retypes the conjecture).${state.extension && !state.extension.projectApproved ? this.extensionInstruction(state.extension) : ''}`;
        if (state.researcherInput?.kind === 'autonomous_revision') return `Stage draft_project: an autonomous reassessment of the goals.\n${state.researcherInput.text}\nIf you add goals, edit only ${this.paths.projectMd}.${state.extension && !state.extension.projectApproved ? this.extensionInstruction(state.extension) : ''}`;
        if (state.researcherInput?.kind === 'intake') return `Stage draft_project, from the researcher's own results (extracted from what they uploaded). Draft or revise ${this.paths.projectMd} only; never edit the extracted results. Keep its frontmatter \`type: project\` and list under \`required_results\` every main result named below (\`- id: <id>\` with \`role: ...\`); their lemmas follow through depends_on. ## Main Problem states what the main results establish; ## Scope and Assumptions the standing hypotheses of the upload; ## Intended Contribution that the project completes and verifies these results, naming the gaps the checks found and the results still without a proof; ## Background what the upload builds on. Record open questions as ideas. Report with a summary the researcher reads with the approval: one line on the goals, then the gaps the loop will try to fill, by result title.${state.extension && !state.extension.projectApproved ? this.extensionInstruction(state.extension) : ''}${input}${report('complete|question')}`;
        return `Stage draft_project. Draft or revise ${this.paths.projectMd} only. Keep its frontmatter \`type: project\` and list every result the project must establish under \`required_results\` (one entry per stable snake_case asset ID: \`- id: main_theorem\` with \`role: ...\`). Fill ## Main Problem, ## Scope and Assumptions (including scope decisions), ## Intended Contribution, and ## Background. Record open questions as ideas (record_idea with kind question), not in project.md; do not list known results or writing status: the dashboard derives them. Do not claim approval.${state.extension && !state.extension.projectApproved ? this.extensionInstruction(state.extension) : ''}${input}${report('complete|question')}`;
      case 'review_project':
        return `Stage review_project. Call request_approval(kind: "project", target: "project", summary: "<what changed>") so the researcher can approve project.md. Do not edit files. Then run: ${LOOP_COMMAND} next`;
      case 'scaffold': {
        const brief = state.scaffoldBrief;
        if (brief?.missingDefinitions?.length && !brief.missing?.length && !brief.incomplete?.length) {
          return `Stage scaffold. These definitions are used but have no file: ${brief.missingDefinitions.join(', ')}. Draft each in ${this.paths.definitions}/<id>.md with type: definition, a title "Definition (concept)", status: draft, source (original, or paper/textbook with paper_id and location when the meaning is taken from a source), depends_on for the definitions it uses, and the defining statement with its notation. When the ID names a hypothesis the results take for granted rather than a concept, add definition_kind: assumption and title it "Assumption (...)"; for notation or a normalization with no mathematical content, definition_kind: convention and "Convention (...)". Read the results that use it so the definition says what they need; search the library first (${LOOP_COMMAND} library search <words>) and, if a lib_ definition means the same, point the users at it instead of drafting. Do not modify existing assets or definitions; never approve a definition. Run research-maintenance validate and links.${input}${report('complete|question')}`;
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
        return `Stage verify_counterexample for ${state.current.counterexampleId} (refutes ${asset}). Independently recheck every hypothesis and calculation; write ## Verdict in the example, beginning with the word confirmed or rejected, then the reason. confirmed: leave it draft (the researcher will confirm). rejected: set the example status to archived. Never edit ${asset}.${report('confirmed|rejected|question')}`;
      case 'plan': {
        const requested = state.current.assetId ? state.progress[state.current.assetId]?.changesRequested : undefined;
        if (state.current.repair && !state.current.planId) return `Stage plan for asset ${asset}: a repair of the researcher's own proof, which they asked the loop to complete. The independent check found: ${state.current.repair}\nUse the plan-proof skill (Repairing a proof). Read the proof as written (${LOOP_COMMAND} show ${asset} --section Proof). Write one new pending plan in ${this.paths.plans}/ that closes this gap and keeps the researcher's argument: the steps that hold stay as they are, and the checklist covers only what the gap needs (the missing case, estimate, or lemma, proved inside the proof). Goal with the target link, Plan checklist, Verification, Assumed definitions; with failed repair plans present also ## Difference from failed plans. Do not edit the asset: the loop keeps the proof as written in the plan. If the gap cannot be closed without changing the statement, write no plan and report none --summary "<what the statement would need>".${input}${report('complete --plan <id>|none|question')}`;
        return `Stage plan for asset ${asset}. Use the plan-proof skill. ${state.current.planId ? `Execute the existing pending plan ${state.current.planId} instead of writing a new one: report complete --plan ${state.current.planId}.` : `First check the pack's library analogues: a known result proving a version of this statement can be adapted (list it under adapts) instead of proving from scratch. Write one new pending plan in ${this.paths.plans}/ (Goal with the target link, Plan checklist, Verification, Assumed definitions; with an adapted result also ## Adapted from; with failed plans present also ## Difference from failed plans, one bullet per failed plan ID). If no genuinely new approach is in sight, write no plan and report none --summary "<what the failed plans show and why nothing new is in sight>": it spends no attempt, and the result counts as stuck.`}${requested ? `\nThe researcher requested changes: ${requested}` : ''}${input}${report(state.current.planId ? 'complete --plan <id>|question' : 'complete --plan <id>|none|question')}`;
      }
      case 'execute':
        if (state.current.repair) return `Stage execute plan ${state.current.planId} for asset ${asset}: a repair of the researcher's proof. Use the execute-proof skill (Repairing a proof). The gap: ${state.current.repair}\nFollow the checklist; tick boxes only for established steps. Success: replace ## Proof in the asset with the complete repaired proof, keeping the researcher's steps and wording wherever they hold and changing only what the gap needs (statement unchanged, status draft); set the plan status succeeded and add ## Outcome saying what was added or changed. The proof as written stays in the plan under ## Previous proof: never edit that section. Obstruction: leave the asset's proof as it is, set the plan status failed with ## Failure. Never set status approved.${report('proved|failed|question')}`;
        return `Stage execute plan ${state.current.planId} for asset ${asset}. Use the execute-proof skill. Follow the checklist; tick boxes only for established steps. A result the plan adapts comes with its proof in the pack: follow it and check each changed step, rather than proving the step anew. Success: write the complete proof under ## Proof in the asset (statement unchanged, status draft), then set the plan status succeeded and add ## Outcome. Obstruction: set the plan status failed with ## Failure. Never set status approved.${report('proved|failed|question')}`;
      case 'verify_proof':
        return `Stage verify_proof for asset ${asset} (plan ${state.current.planId}).${state.current.recheck?.length ? ` This is a re-check: ${state.current.recheck.join(', ')} changed since the proof was written or last checked; check every step that uses them against their current text (the pack notes it).` : ''} Use the verify-proof skill. Check the ## Proof in the pack against the statement, step by step, as a referee would: every step follows, every hypothesis of a cited result holds, nothing is assumed that the statement does not give. Do not read the plan's reasoning. Add ## Verdict to ${this.paths.plans}/${state.current.planId}.md: first line confirmed or rejected; for rejected, name the first step that fails and why. Change nothing else; never edit ${asset}.${report('confirmed|rejected|question')}`;
      case 'verify_node': {
        const node = state.current.node;
        if (!node) return `Run: ${LOOP_COMMAND} next`;
        const settings = this.lastSettings ?? DEFAULT_LOOP_SETTINGS;
        const why = node.changed?.length ? `This is a re-check: ${node.changed.join(', ')} changed since the proof was last checked; check every step that uses them against their current text (the pack notes it).`
          : settings.autonomy.enabled || settings.autoApprove.enabled ? 'Auto mode approves it only after an independent check; the researcher is not asked.' : 'The researcher reviews it with your verdict.';
        return `Stage verify_node for ${node.id}. ${why} Use the verify-node skill and check ${nodeCheckWhat(node)}. Read only the pack and what you request with show. Change no file: your verdict is the report. Report confirmed --summary "<what you checked>" or rejected --summary "<the first problem: what is wrong and what would fix it>"; question only when the source cannot be read.${report('confirmed|rejected|question')}`;
      }
      case 'conjecture': {
        const idea = state.current.ideaId ?? '(none)';
        return `Stage conjecture for the idea ${idea}. The pack holds the idea, the results it relates to, the goals, and the existing conjectures. Make it precise as one new conjecture in ${this.paths.assets}/<id>.md: type conjecture, title, status draft, source.kind original, depends_on, uses_definitions, serves (the results it would unblock or strengthen: an open goal, a set-aside result, or a proved one), a precise statement, and ## Motivation (why it is believed: evidence, special cases; and what it would give). Use existing definitions (search the library first, ${LOOP_COMMAND} library search <words>) or draft new ones in ${this.paths.definitions}/. Do not search, plan, or prove it: the loop searches it for a counterexample next, and the researcher agrees on its statement. If it cannot be stated precisely, or it is known, false, or trivial, write nothing and report none with the reason; the idea stays for the researcher with your note. Run research-maintenance validate and links.${report('complete --asset <id>|none|question')}`;
      }
      case 'batch': {
        const open = (state.current.batch?.items ?? []).filter((item) => !item.done);
        if (!open.length) return `Run: ${LOOP_COMMAND} next`;
        const lines = open.map((item) => `Item ${item.item}: ${this.instruction({ ...state, stage: item.stage, current: this.itemCurrent(item, state.current) }).replace('--summary "<= 5 lines"', `--item ${item.item} --summary "<= 5 lines"`)}`);
        return `Stage batch: ${open.length} result(s) worked on side by side, each by its own worker. Spawn one subagent per item in a single message (research-worker-deep), give each only its item's instruction below and its own pack, and require at most five lines back. Then report every item on its own with --item <n>, in any order, and run next only once all are reported. A partial execution gets a fresh worker for that item alone.${state.pendingQuestion ? ' A question waits for the researcher; report the items meanwhile.' : ''}\n\n${lines.join('\n\n')}`;
      }
      case 'route': {
        const round = state.current.route;
        if (!round?.slots.length) return `Run: ${LOOP_COMMAND} next`;
        const slots = round.slots.map((slot) => `slot ${slot.slot} (origin ${slot.origin}${slot.ideaId ? `, idea ${slot.ideaId}` : ''}): ${slot.label}`).join('; ');
        return `Stage route for ${round.target}, round ${round.round}${round.fork ? `; every route starts from ${round.fork}` : ''}. Use the plan-routes skill. Spawn one subagent per slot in a single message, each given only its slot number and its own pack, and require at most three lines back. Each writes at most one route, ${this.paths.plans}/route_${round.target}_r${round.round}_s<slot>_<slug>.md: type plan, status pending, target_asset ${round.target}, route_lemmas (the results the route proves first: reuse existing IDs, library ones included, and create each new one as a draft lemma in ${this.paths.assets}/ with a precise ## Statement), route_title (a short name for the researcher), origin as its slot says${round.fork ? `, forked_from ${round.fork} (also listed in route_lemmas)` : ''}, inspired_by (the slot's idea, when it has one); body ## Goal with the target link, ## Route (one line per lemma: what it gives the reduction), ## Plan (the reduction from the lemmas, as a checklist), ## Verification, and with failed plans present ## Difference from failed plans. Plan only: no proof, no counterexample search, no change to existing files. Slots: ${slots}.${report('complete|none|question')}`;
      }
      case 'route_merge': {
        const round = state.current.route;
        if (!round) return `Run: ${LOOP_COMMAND} next`;
        return `Stage route_merge for ${round.target}, round ${round.round}. Use the merge-routes skill. The pack holds the open routes to ${round.target} and their lemmas. Compare this round's new lemmas with every other lemma and with results already in the project or the library (${LOOP_COMMAND} library search <words>). When two state the same, run ${LOOP_COMMAND} route merge <dup> --into <keep> (keep the one already proved or approved, else the older); when one implies another, ${LOOP_COMMAND} route imply <stronger> <weaker> [--note "..."]; when they look alike but differ, ${LOOP_COMMAND} route distinct <a> <b> --note "<how>". Change no file yourself. The summary says what was merged, or that nothing was.${report('complete')}`;
      }
      case 'review_routes': {
        const target = state.current.route?.target ?? asset;
        return `Stage review_routes for ${target}. Call request_approval(kind: "routes", target: "${target}", summary: "<one line per route, the lemmas they share, what was merged>") so the researcher can review the route map in the dashboard. Do not edit files. Then run: ${LOOP_COMMAND} next`;
      }
      case 'reduce':
        return `Stage reduce for the route ${state.current.planId} to ${asset}. Use the execute-proof skill (a route's reduction). Write under ## Reduction in ${this.paths.plans}/${state.current.planId}.md the complete argument that ${asset} follows from the route's lemmas and its dependencies, each used as a black box by its statement (the pack shows them); tick the plan's checklist as you go. Change nothing else: not ${asset}, not the lemmas. Success: the plan stays pending; report proved. Obstruction: set the plan status failed and write ## Failure (which step, why it cannot be done, what would be needed); report failed.${report('proved|failed|question')}`;
      case 'verify_reduction':
        return `Stage verify_reduction for the route ${state.current.planId} to ${asset}. Use the verify-proof skill on the reduction, in a fresh subagent. Check, as written, that ## Reduction in ${state.current.planId} proves the exact statement of ${asset} from the route's lemmas and its dependencies, used only by their statements. Add ## Reduction verdict to the plan: first line confirmed or rejected, then the reasons step by step. Change nothing else.${report('confirmed|rejected|question')}`;
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

  /** Plans that used an idea, derived from their inspired_by; never stored in the idea. */
  private async derivedForIdea(ideaId: string): Promise<string> {
    const plans = (await this.plans()).filter((plan) => Array.isArray(plan.data.inspired_by) && plan.data.inspired_by.map(String).includes(ideaId))
      .map((plan) => ({ id: plan.id, target_asset: typeof plan.data.target_asset === 'string' ? plan.data.target_asset : undefined, status: String(plan.data.status ?? 'pending'), inspired_by: [ideaId] }));
    const usage = ideaUsage(plans).get(ideaId);
    return ['### Derived relations (not stored in the file)', `- Used by plans: ${usage?.uses.length ? usage.uses.map((use) => `${use.plan} for ${use.target} (${use.status})`).join(', ') : 'none'}`].join('\n');
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

  /** Files added, modified, or removed since the current stage started (the loop's own writes and deletions excepted). */
  async changedFiles(): Promise<{ added: string[]; modified: string[]; removed: string[]; before: Record<string, string> }> {
    const before = JSON.parse(await this.files.readFile(SNAPSHOT_PATH).catch(() => '{}')) as Record<string, string>;
    const after = await this.fingerprints();
    const added = Object.keys(after).filter((file) => !(file in before) && after[file] !== EMPTY_HASH).sort();
    const modified = Object.keys(after).filter((file) => file in before && before[file] !== after[file]).sort();
    const removed = Object.keys(before).filter((file) => !(file in after) && before[file] !== EMPTY_HASH).sort();
    return { added, modified, removed, before };
  }

  private folders() { return { assets: this.paths.assets, definitions: this.paths.definitions, ideas: this.paths.ideas, plans: this.paths.plans, library: this.paths.library, checks: this.shared.checks, candidates: this.shared.candidates, decisions: this.shared.decisions, handoffs: this.shared.handoffs }; }

  private async paperIds(): Promise<Set<string>> {
    const index = await this.files.readFile(this.paths.paperIndex).catch(() => '');
    return new Set(index.match(/^##\s+([a-z][a-z0-9_]*)\s*$/gm)?.map((heading) => heading.replace(/^##\s+/, '').trim()) ?? []);
  }

  /** Validate the files written during the current stage against that stage's rules. */
  private async validateStageFiles(ignore: Set<string> = new Set()): Promise<{ added: string[]; modified: string[]; problems: string[] }> {
    const state = this.require();
    const changes = await this.changedFiles();
    const scope = this.itemScope ?? (() => true);
    const [added, modified, removed] = [changes.added, changes.modified, changes.removed].map((files) => files.filter((file) => !ignore.has(file) && scope(file)));
    const problems: string[] = [];
    const stage = state.stage;
    const folders = this.folders();
    // No stage deletes research files (ideas aside; library packages are removed by the researcher and checked against their lockfile).
    for (const file of removed) {
      if (path.posix.dirname(file) === folders.ideas || locateNodeFile(file, this.paths)?.origin === 'library') continue;
      problems.push(`${file}: deleted during stage ${stage}. Restore it with git; a result that should go is retired or deprecated, never removed.`);
    }
    const isIn = (file: string, folder: string) => path.posix.dirname(file) === folder;
    const allowedFolders = new Set<string>([folders.ideas]);
    if (stage === 'scaffold' || stage === 'sources' || stage === 'conjecture') { allowedFolders.add(folders.assets); allowedFolders.add(folders.definitions); }
    const search = state.current.search;
    if (stage === 'verify_counterexample') allowedFolders.add(folders.assets);
    if (stage === 'search') { allowedFolders.add(folders.candidates); if (search?.slots.length === 1) allowedFolders.add(folders.checks); }
    if (stage === 'search_summary') allowedFolders.add(folders.checks);
    if (stage === 'verify_construction') allowedFolders.add(folders.candidates);
    if (stage === 'plan' || stage === 'execute' || stage === 'verify_proof') allowedFolders.add(folders.plans);
    if (stage === 'execute') allowedFolders.add(folders.assets);
    // A round of routes writes the routes and the new lemmas (and definitions) they need; a reduction and its check, only their route.
    if (stage === 'route') { allowedFolders.add(folders.plans); allowedFolders.add(folders.assets); allowedFolders.add(folders.definitions); }
    if (stage === 'reduce' || stage === 'verify_reduction') allowedFolders.add(folders.plans);
    const round = state.current.route;
    const routeAssets = stage === 'route' ? await this.collectKind('asset') : undefined;
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
      if (stage === 'conjecture' && isIn(file, folders.assets) && data.type !== CONJECTURE_TYPE) problems.push(`${file}: this stage writes one conjecture (type conjecture) and nothing else in ${folders.assets}.`);
      if (stage === 'conjecture' && isIn(file, folders.ideas) && modified.includes(file) && path.posix.basename(file, '.md') === state.current.ideaId && parseMarkdown(raw).data.status !== 'draft') problems.push(`${file}: leave the idea draft; the loop resolves it from your report.`);
      if (modified.includes(file) && ['scaffold', 'sources', 'search', 'search_summary', 'plan', 'conjecture', 'route', 'route_merge', 'review_routes'].includes(stage) && !inLibrary && !isIn(file, folders.ideas) && !(stage === 'plan' && isIn(file, folders.plans) && data.status === 'pending')) problems.push(`${file}: existing files may not be changed during ${stage}.`);
      if (stage === 'verify_counterexample' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.counterexampleId}.md`) problems.push(`${file}: verification may change only the candidate example.`);
      if (stage === 'execute' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md`) problems.push(`${file}: execution may change only its target asset.`);
      if (stage === 'execute' && isIn(file, folders.plans) && file !== `${folders.plans}/${state.current.planId}.md`) problems.push(`${file}: execution may change only its active plan.`);
      if (stage === 'verify_proof' && isIn(file, folders.plans) && (file !== `${folders.plans}/${state.current.planId}.md` || data.status !== 'succeeded')) problems.push(`${file}: verification may only add ## Verdict to the plan ${state.current.planId}, leaving its status succeeded.`);
      if ((stage === 'plan' || stage === 'execute') && isIn(file, folders.plans) && data.target_asset !== state.current.assetId) problems.push(`${file}: plan targets ${data.target_asset}, not ${state.current.assetId}.`);
      if (stage === 'verify_counterexample' && isIn(file, folders.assets) && file !== `${folders.assets}/${state.current.assetId}.md` && (data.type !== 'example' || data.refutes !== state.current.assetId)) problems.push(`${file}: only a counterexample example refuting ${state.current.assetId} may be written now.`);
      const id = path.posix.basename(file, '.md');
      if (stage === 'route' && isIn(file, folders.plans)) {
        const match = round ? new RegExp(`^route_${round.target}_r${round.round}_s(\\d+)_[a-z0-9_]+$`).exec(id) : null;
        const slot = match ? round!.slots.find((item) => item.slot === Number(match[1])) : undefined;
        if (!round || !match) problems.push(`${file}: a route is named route_${round?.target ?? '<result>'}_r${round?.round ?? '<round>'}_s<slot>_<slug>.`);
        else if (!slot) problems.push(`${file}: slot ${match[1]} was not assigned this round (slots ${round.slots.map((item) => item.slot).join(', ')}).`);
        if (!isRoutePlan(data)) problems.push(`${file}: a route needs route_lemmas (a list; empty for a direct route).`);
        else if (round) {
          if (data.status !== 'pending') problems.push(`${file}: a new route is pending.`);
          if (data.target_asset !== round.target) problems.push(`${file}: the route targets ${String(data.target_asset)}, not ${round.target}.`);
          if (slot && data.origin !== slot.origin) problems.push(`${file}: origin must be ${slot.origin}, as its slot says.`);
          if (round.fork && data.forked_from !== round.fork) problems.push(`${file}: this round starts from ${round.fork}: set forked_from ${round.fork} and list it in route_lemmas.`);
          for (const key of ['reduction_digest', 'reduction_verified_digest', 'reduction_inputs', 'reduction_checked', 'route_round', 'superseded_by']) if (data[key] !== undefined) problems.push(`${file}: ${key} is written by the loop; remove it.`);
          for (const lemma of routeLemmas(data)) {
            const node = routeAssets?.get(lemma);
            if (!node) problems.push(`${file}: unknown lemma ${lemma}; create it as a draft lemma with a precise ## Statement, or reuse an existing ID.`);
            else if (node.data.type === CONJECTURE_TYPE || ['deprecated', 'archived'].includes(node.data.status)) problems.push(`${file}: ${lemma} is a conjecture or retired; a route cannot rest on it.`);
          }
          if (routeAssets && assetClosure(routeLemmas(data), routeAssets).order.includes(round.target)) problems.push(`${file}: a lemma of this route rests on ${round.target} itself.`);
        }
      }
      if (stage === 'route' && isIn(file, folders.assets)) {
        if (!PROVABLE_TYPES.has(data.type) || isConstructionSpec(raw)) problems.push(`${file}: a route's new lemma is a draft theorem, lemma, or proposition.`);
        else if (statementIncomplete(parseMarkdown(raw).content)) problems.push(`${file}: a route's new lemma needs a precise ## Statement.`);
      }
      if ((stage === 'reduce' || stage === 'verify_reduction') && isIn(file, folders.plans)) {
        if (file !== `${folders.plans}/${state.current.planId}.md`) problems.push(`${file}: this stage may change only the route ${state.current.planId}.`);
        else if (stage === 'reduce' && !['pending', 'failed'].includes(data.status)) problems.push(`${file}: leave the route pending (report proved), or set it failed with ## Failure (report failed).`);
        else if (stage === 'verify_reduction' && (data.status !== 'pending' || reductionDigest(parseMarkdown(raw).content) !== data.reduction_digest)) problems.push(`${file}: the check may only add ## Reduction verdict, leaving the route pending and its ## Reduction unchanged.`);
      }
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
        // Only a plan being written answers the failures so far; an older route given its reduction later need not name failures that came after it.
        if (failed.length && data.status === 'pending' && (stage === 'plan' || stage === 'route')) {
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
      for (const target of Array.isArray(data.serves) ? data.serves : []) if (typeof target !== 'string' || !knownAssets.has(target)) problems.push(`${file}: serves unknown result ${String(target)}.`);
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
      for (const [slot, count] of counts) if (count > perWorker) problems.push(`slot ${slot} wrote ${count} candidates; at most ${perWorker} per worker. Keep the best; an object you have not checked may become a test_case idea, a failed one never.`);
    }
    if (stage === 'route' && round) {
      const counts = new Map<string, number>();
      for (const file of added.filter((item) => isIn(item, folders.plans))) {
        const slot = new RegExp(`^route_${round.target}_r${round.round}_s(\\d+)_`).exec(path.posix.basename(file, '.md'))?.[1];
        if (slot) counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      for (const [slot, count] of counts) if (count > 1) problems.push(`slot ${slot} wrote ${count} routes; one per slot. Keep the best and record the others as approach ideas.`);
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
    const state = this.require();
    if (report.item !== undefined && state.stage !== 'batch') throw new Error('--item belongs to a batch; none is open.');
    // A batch item is charged like the stage it is.
    const item = state.stage === 'batch' ? state.current.batch?.items.find((entry) => entry.item === report.item) : undefined;
    const stage = item?.stage ?? state.stage;
    const assetId = item?.assetId ?? state.current.assetId;
    const result = state.stage === 'batch' ? await this.reportBatchItem(report) : await this.reportStage(report);
    // An autonomous run pays for each executed plan, each search round, and each conjecture idea it tries to make precise.
    const attempt = ((stage === 'execute' || stage === 'reduce') && (report.outcome === 'proved' || report.outcome === 'failed')) || (stage === 'search' && report.outcome === 'searched')
      || (stage === 'conjecture' && (report.outcome === 'complete' || report.outcome === 'none'));
    const handover = attempt ? await this.charge(assetId, stage, report.outcome) : undefined;
    return handover ? { stage: this.require().stage, message: `${result.message}\n${handover}` } : result;
  }

  private async reportStage(report: StageReport): Promise<{ stage: LoopStage; message: string }> {
    const state = this.require();
    if (state.status !== 'running') throw new Error(`The loop is ${state.status}; resume it first.`);
    await this.resolveOverdueQuestion();
    // The other items of a batch were done alongside: a question or a decision one of them raised waits until the batch is reported.
    if (state.pendingQuestion && !this.itemMode) throw new Error(`Question ${state.pendingQuestion.id} is still pending; answer it (or wait) before reporting.`);
    const run = await this.autonomy();
    if (run?.deciding && report.outcome !== 'question' && !this.itemMode) throw new Error(await this.decisionInstruction(run.deciding));
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
      if (problems.length) throw new Error(`Stage ${stage} validation failed:\n- ${problems.join('\n- ')}\nFix the files (restore your own unintended changes with git) and report again. A file listed here that you did not change was changed by someone else: do not revert it; ask the researcher (report question).`);
      if (state.lastSummary) state.lastSummary.files = [...added, ...modified];
      return { added, modified };
    };
    if (report.outcome === 'question') {
      // Being stuck without a new approach is report none at the plan stage; a question there is a genuine one, unless it names the failures.
      const kind: QuestionKind = stage === 'plan' && report.question?.toLowerCase().includes('fail') ? 'blocked' : 'discussion';
      if (run) return { stage: this.require().stage, message: await this.decideAlone(kind, report.question || report.summary) };
      await this.askQuestion(kind, report.question || report.summary);
      return { stage, message: `Question recorded for the researcher. Ask it in chat, then record the answer with: ${LOOP_COMMAND} question answer --text "..."` };
    }
    // Something this stage worked from changed since it began: the work covered an earlier version, and the change is not the agent's to undo.
    const drift = await this.inputDrift();
    if (drift.length) {
      const { problems } = await this.validateStageFiles(new Set(drift.map((input) => input.file)));
      if (problems.length) throw new Error(`Stage ${stage} validation failed:\n- ${problems.join('\n- ')}\nRestore your own unintended changes with git and report again. (Separately, ${[...new Set(drift.map((input) => input.id))].join(', ')} changed during the stage: that is someone else's change; do not revert it.)`);
      const message = await this.afterInputDrift(drift);
      return { stage: this.require().stage, message };
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
        if (state.researcherInput?.kind === 'intake' && state.intake) {
          const assets = await this.collectKind('asset');
          const unlisted = state.intake.main.filter((id) => assets.has(id) && !INACTIVE_STATUSES.has(assets.get(id)!.data.status) && !requiredAssetIds(project).includes(id));
          if (unlisted.length) throw new Error(`List the researcher's main result(s) ${unlisted.join(', ')} under required_results: the researcher asked the loop to complete and verify them. If they asked to leave one out, ask them to deprecate it in the dashboard first.`);
        }
        const assessment = run && state.researcherInput?.kind === 'autonomous_revision' ? run.assessment ?? { at: this.now(), proved: [], setAside: [] } : undefined;
        const exploring = Boolean(run) && state.researcherInput?.kind === 'autonomous_conjecture';
        const added = (assessment || exploring) && state.extension ? requiredAssetIds(project).filter((id) => !state.extension!.baselineRequired.includes(id)) : [];
        if (exploring && report.outcome === 'none') {
          // No conjecture worth the budget: the goals stay as they were, and the run ends.
          delete state.extension;
          state.researcherInput = undefined;
          await this.setStage('select', { assetId: undefined });
          return { stage: 'select', message: await this.handOver(`it found no conjecture worth taking up (${report.summary.split('\n')[0]})`) };
        }
        if (exploring && !added.length) throw new Error(`Nothing changed: take up a conjecture (${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition, and list it under required_results), or run ${LOOP_COMMAND} report none --summary "<why>".`);
        const goalAssets = await this.collectKind('asset');
        const resting = assetClosure(requiredAssetIds(project), goalAssets).order.filter((id) => goalAssets.get(id)?.data.type === CONJECTURE_TYPE);
        if (resting.length) throw new Error(`The goals rest on the conjecture(s) ${resting.join(', ')}, which the loop does not prove: promote each (${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition) or change the goals so that none depends on it.`);
        if (assessment) {
          const broughtBack = (assessment.broughtBack ?? []).filter((id) => !state.parked[id]);
          if (report.outcome === 'none' && !broughtBack.length) {
            // A first `none` is answered with the leading candidates: the run ends only once the agent has said why each stays set aside.
            const candidates = assessment.candidates ?? [];
            if (candidates.length && !assessment.declined) {
              if (report.confirm) throw new Error(`Run ${LOOP_COMMAND} report none --summary "<why>" without --confirm first; the loop then names the results to go through.`);
              assessment.declined = report.summary.trim();
              await this.save();
              await this.event('autonomy_none_questioned', { candidates });
              return { stage, message: `Before the loop hands back, go through the leading set-aside results one by one: ${candidates.join(', ')}. Read each (${LOOP_COMMAND} show <id>; their obstructions are in ${ASSESSMENT_PATH}) and judge whether something proved since it was set aside, or a different idea, gets past its obstruction, and whether a new lemma could supply its missing step (option b). If one can be brought back, run ${LOOP_COMMAND} budget allocate <id> <n> --reason "..."; if a lemma can supply a step, add it to project.md; then report complete. Otherwise run: ${LOOP_COMMAND} report none --confirm --summary "<one line per result: <id>: why it stays set aside, and why no lemma can supply its missing step now>"` };
            }
            if (candidates.length) {
              if (!report.confirm) throw new Error(`Add --confirm once you have gone through ${candidates.join(', ')}, or bring one back with ${LOOP_COMMAND} budget allocate.`);
              const missing = candidates.filter((id) => !report.summary.includes(id));
              if (missing.length) throw new Error(`Say for each leading result why it stays set aside; the summary does not mention ${missing.join(', ')}.`);
            }
            // The agent found nothing sound to do: the goals stay as they were, and the run ends.
            const why = (assessment.declined || report.summary).split('\n')[0];
            delete state.extension;
            state.researcherInput = undefined;
            await this.setStage('select', { assetId: undefined });
            return { stage: 'select', message: await this.handOver(`it found no sound revision of the goals (${why})`) };
          }
          if (!added.length && !broughtBack.length) throw new Error(`Nothing changed: bring back a set-aside result (${LOOP_COMMAND} budget allocate <id> <n> --reason "..."), add a goal under a new asset ID in required_results, or run ${LOOP_COMMAND} report none --summary "<why>".`);
          const blocked = await this.setAsideDependencies(broughtBack);
          if (blocked.length) throw new Error(`The results you brought back still depend on set-aside ${blocked.join(', ')}: bring those back too, or set a result aside again (${LOOP_COMMAND} park <id> --reason agent_gave_up --note "...").`);
          delete assessment.broughtBack;
          if (!added.length) {
            // Only brought back: there is nothing to extend, and an untouched project needs no approval.
            delete state.extension;
            if (await this.isProjectApproved(project)) {
              state.researcherInput = undefined;
              return finish(`Brought back ${broughtBack.join(', ')}. Continue with ${LOOP_COMMAND} next.`, 'select');
            }
          }
        }
        const extensionProblems = await this.extensionProblems(project);
        if (extensionProblems.length) throw new Error(`Stage draft_project validation failed:\n- ${extensionProblems.join('\n- ')}`);
        if (added.length) await this.event('autonomy_goals_added', { ids: added });
        await this.enqueueApproval('project', 'project', report.summary || 'Project goals drafted.');
        state.researcherInput = undefined;
        if ((await this.autoApproveQueued()).includes('project:project')) return finish('project.md drafted and approved automatically (auto mode). Continue with next.', 'select');
        return finish('project.md drafted; request the researcher\'s approval with request_approval(kind: "project").', 'review_project');
      }
      case 'route': {
        const round = state.current.route;
        if (!round) throw new Error(`No round of routes is open; run ${LOOP_COMMAND} next.`);
        const { added } = await validated();
        const written = added.filter((file) => path.posix.dirname(file) === this.paths.plans);
        state.researcherInput = undefined;
        if (report.outcome === 'none') {
          if (written.length) throw new Error(`report none writes no route; remove ${written.join(', ')} or report complete.`);
          if (!report.summary.trim()) throw new Error('Say in --summary why no route is in sight.');
          await finish(`No route to ${round.target} in sight.`, 'select', { assetId: undefined });
          await this.routesStuck(round.target, `No route to ${round.target} is in sight: ${report.summary.trim()}`);
          return { stage: this.require().stage, message: `No route to ${round.target} in sight. ${(await this.autonomy()) ? 'Decide yourself what comes next (the instruction from next says how).' : 'The researcher is asked for a direction; continue with next.'}` };
        }
        if (report.outcome !== 'complete') throw new Error('route outcome must be complete, none, or question.');
        if (!written.length) throw new Error('No route was written: write at least one, or report none --summary "<why no route is in sight>".');
        for (const file of written) {
          const parsed = parseMarkdown(await this.files.readFile(file));
          parsed.data.route_round = round.round;
          await this.writeOwned(file, stringifyMarkdown(parsed.content, parsed.data));
        }
        await this.event('routes_proposed', { target: round.target, round: round.round, routes: written.map((file) => path.posix.basename(file, '.md')) });
        return finish(`${written.length} route(s) to ${round.target} recorded. Next: merge them with the other routes and known results.`, 'route_merge', { route: round });
      }
      case 'route_merge': {
        const round = state.current.route;
        if (!round) throw new Error(`No round of routes is open; run ${LOOP_COMMAND} next.`);
        await validated();
        if (report.outcome !== 'complete') throw new Error('route_merge outcome must be complete.');
        await this.writeDecision('route_merge', round.target, report.summary.trim() || 'Nothing to merge.', { routeRound: round.round });
        const settings = await this.loopSettings();
        const main = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => '')).includes(round.target);
        const open = (await this.routePlans()).some((plan) => plan.data.target_asset === round.target && plan.data.status === 'pending');
        if (settings.rigor.reviewRoutes === 'main' && main && open && !(await this.routeMapApproved(round.target))) {
          await this.enqueueApproval('routes', round.target, report.summary.trim() || `Review the routes to ${round.target}.`);
          if ((await this.autoApproveQueued()).includes(`routes:${round.target}`)) return finish(`Routes to ${round.target} merged; the route map was approved automatically (auto mode). Continue with next.`, 'select', { assetId: undefined });
          return finish(`Routes to ${round.target} merged. Call request_approval(kind: "routes", target: "${round.target}", summary: "<one line per route, the lemmas they share, what was merged>") and continue with next: the loop works on other results while the researcher reviews the map.`, 'review_routes', { route: round });
        }
        return finish(`Routes to ${round.target} merged. Continue with next.`, 'select', { assetId: undefined });
      }
      case 'review_routes':
        throw new Error(`Nothing to report in review_routes: call request_approval(kind: "routes") and run ${LOOP_COMMAND} next.`);
      case 'reduce': {
        await validated();
        const assetId = state.current.assetId!;
        const planId = state.current.planId!;
        const file = `${this.paths.plans}/${planId}.md`;
        const plan = parseMarkdown(await this.files.readFile(file));
        const title = String(plan.data.route_title ?? planId);
        if (report.outcome === 'proved') {
          if (plan.data.status !== 'pending' || !sectionContent(plan.content, 'Reduction')) throw new Error(`${planId} needs the complete argument under ## Reduction, its status still pending.`);
          const digest = reductionDigest(plan.content);
          plan.data.reduction_digest = digest;
          // The statements it was written against: a later change to one of them voids it.
          plan.data.reduction_inputs = Object.fromEntries((state.current.inputs ?? []).filter((input) => input.kind === 'asset' && input.part === 'statement').map((input) => [input.id, input.digest]));
          delete plan.data.reduction_verified_digest;
          delete plan.data.reduction_checked;
          const check = (await this.loopSettings()).rigor.verifyProofs === 'agent';
          if (!check) plan.data.reduction_verified_digest = digest;
          await this.writeOwned(file, stringifyMarkdown(plan.content, plan.data));
          await this.event('route_reduced', { target: assetId, planId });
          return finish(`The reduction of the route ${title} to ${assetId} is recorded.${check ? ' Next: an independent check of it.' : ''} Continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'failed') throw new Error('reduce outcome must be proved, failed, or question.');
        if (plan.data.status !== 'failed' || !sectionContent(plan.content, 'Failure')) throw new Error(`${planId} must have status failed and a ## Failure section.`);
        await this.event('route_failed', { target: assetId, planId, reason: 'reduction' });
        return finish(`The route ${title} to ${assetId} failed. Continue with next: the loop goes on with the other routes.`, 'select', { assetId: undefined, planId: undefined });
      }
      case 'verify_reduction': {
        await validated();
        const assetId = state.current.assetId!;
        const planId = state.current.planId!;
        const file = `${this.paths.plans}/${planId}.md`;
        const plan = parseMarkdown(await this.files.readFile(file));
        const verdict = sectionContent(plan.content, 'Reduction verdict');
        if (!verdict) throw new Error(`${planId} needs a ## Reduction verdict.`);
        if (report.outcome === 'confirmed') {
          if (verdictOutcome(verdict) !== 'confirmed') throw new Error(`## Reduction verdict of ${planId} must begin with confirmed.`);
          plan.data.reduction_verified_digest = plan.data.reduction_digest;
          plan.data.reduction_checked = true;
          await this.writeOwned(file, stringifyMarkdown(plan.content, plan.data));
          await this.event('route_reduction_verified', { target: assetId, planId });
          return finish(`The reduction of ${planId} holds (independent check). Continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_reduction outcome must be confirmed, rejected, or question.');
        if (verdictOutcome(verdict) !== 'rejected') throw new Error(`## Reduction verdict of ${planId} must begin with rejected.`);
        plan.data.status = 'failed';
        delete plan.data.reduction_digest; delete plan.data.reduction_verified_digest; delete plan.data.reduction_inputs;
        await this.writeOwned(file, stringifyMarkdown(`${plan.content.trimEnd()}\n\n## Failure\n\nThe independent check rejected the reduction:\n\n${verdict}\n`, plan.data));
        await this.event('route_failed', { target: assetId, planId, reason: 'reduction_rejected' });
        return finish(`The independent check rejected the reduction of ${planId}; the route failed. Continue with next.`, 'select', { assetId: undefined, planId: undefined });
      }
      case 'conjecture': {
        const ideaId = state.current.ideaId;
        if (!ideaId) throw new Error(`No conjecture idea is open; run ${LOOP_COMMAND} next.`);
        const { added } = await validated();
        const created = added.filter((file) => path.posix.dirname(file) === this.paths.assets).map((file) => path.posix.basename(file, '.md'));
        state.conjectureTried = [...new Set([...(state.conjectureTried ?? []), ideaId])];
        this.dropConjectureRequest(ideaId);
        if (report.outcome === 'none') {
          if (created.length) throw new Error(`report none writes no conjecture; remove ${created.join(', ')} or report complete --asset <id>.`);
          if (!report.summary.trim()) throw new Error('Say in --summary why the idea cannot be made a precise conjecture now.');
          const file = `${this.paths.ideas}/${ideaId}.md`;
          const parsed = parseMarkdown(await this.files.readFile(file));
          await this.writeOwned(file, stringifyMarkdown(`${parsed.content.trimEnd()}\n\n## Not yet a conjecture\n\n${report.summary.trim()}\n`, parsed.data));
          return finish(`The idea ${ideaId} stays an idea, with your note. Continue with next.`, 'select', { ideaId: undefined });
        }
        if (report.outcome !== 'complete') throw new Error('conjecture outcome must be complete --asset <id>, none, or question.');
        const assetId = report.assetId ?? (created.length === 1 ? created[0] : undefined);
        if (!assetId) throw new Error(`Write exactly one new conjecture and pass --asset <id>; found ${created.length ? created.join(', ') : 'none'}.`);
        if (!created.includes(assetId)) throw new Error(`${assetId} is not a conjecture written in this stage.`);
        await this.resolveIdea(ideaId, assetId);
        return finish(`Conjecture ${assetId} recorded from the idea ${ideaId}. Next: the loop searches it for a counterexample (when allowed), then asks to agree on its statement. Continue with next.`, 'select', { ideaId: undefined });
      }
      case 'scaffold': {
        await this.noteExtracted((await validated()).added);
        delete state.scaffoldBrief;
        await this.stashStageFiles();
        return finish('Scaffold recorded. Next: sources.', 'sources');
      }
      case 'sources': {
        await this.noteExtracted((await validated()).added);
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
        await this.closeTriedIdeas(assetId, search, digest);
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
          return finish(`Construction for ${assetId} verified and written into it as its proof; it is approved like an independently verified proof. Continue with next.`, 'select', { assetId: undefined });
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
          const verdict = sectionContent(example.content, 'Verdict');
          if (!verdict) throw new Error(`${exampleId} needs a ## Verdict.`);
          if (verdictOutcome(verdict) !== 'confirmed') throw new Error(`## Verdict of ${exampleId} must begin with the word confirmed (the reason follows), matching the reported outcome.`);
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
        if (await this.isConjecture(assetId)) return finish(`Candidate rejected; the conjecture ${assetId} stands. Continue with next.`, 'select', { assetId: undefined, counterexampleId: undefined });
        const [nextStage, patch] = await this.afterSurvived(assetId);
        return finish(`Candidate rejected. Next: ${nextStage === 'plan' ? `plan for ${assetId}` : `routes to ${assetId}; continue with next`}.`, nextStage, patch);
      }
      case 'plan': {
        if (report.outcome === 'none') return this.noNewPlan(await validated(), report.summary, finish, Boolean(run));
        if (report.outcome !== 'complete') throw new Error('plan outcome must be complete --plan <id>, none, or question.');
        const { added } = await validated();
        const assetId = state.current.assetId!;
        const newPlans = added.filter((file) => path.posix.dirname(file) === this.paths.plans);
        if (newPlans.length > 1) throw new Error(`Write one plan per plan stage; found ${newPlans.length} new plans (${newPlans.join(', ')}). Keep the best one and record the others as ideas.`);
        const planId = report.planId ?? state.current.planId ?? added.filter((file) => path.posix.dirname(file) === this.paths.plans).map((file) => path.posix.basename(file, '.md'))[0];
        if (!planId) throw new Error('Planning did not produce a plan; pass --plan <id>.');
        const plan = parseMarkdown(await this.files.readFile(`${this.paths.plans}/${planId}.md`));
        if (plan.data.type !== 'plan' || plan.data.status !== 'pending' || plan.data.target_asset !== assetId) throw new Error(`${planId} must be a pending plan targeting ${assetId}.`);
        const assetRaw = await this.files.readFile(`${this.paths.assets}/${assetId}.md`);
        const repair = await this.repairWork(assetId, assetRaw);
        if (repair?.stage === 'plan' && repair.repair) await this.markRepairPlan(planId, assetRaw, repair.repair);
        state.progress[assetId] = { ...state.progress[assetId], changesRequested: undefined };
        state.current.statementDigest = statementDigest(assetRaw);
        state.researcherInput = undefined;
        return finish(`Plan ${planId} recorded${repair?.stage === 'plan' ? ' (a repair of the researcher\'s proof)' : ''}. Next: execute it.`, 'execute', { planId, ...(repair?.stage === 'plan' && repair.repair ? { repair: repair.repair } : {}) });
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
          if (plan.data.purpose === 'repair' && proofDigest(assetRaw) === plan.data.repairs_proof_digest) throw new Error(`The proof of ${assetId} is unchanged: write the repaired proof under ## Proof in the asset, closing the gap named in ${planId}.`);
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
          await this.enqueueApproval('asset', assetId, `${plan.data.purpose === 'repair' ? `Your proof, repaired by ${planId} where the check found a gap (your version is kept in the plan)` : `Proof from ${planId}`}${report.assumedDefinitions?.length ? `; uses draft definitions ${report.assumedDefinitions.join(', ')}` : ''}.`);
          if ((await this.autoApproveQueued()).includes(`asset:${assetId}`)) return finish(`Proof recorded for ${assetId} and approved automatically (auto mode). Continue with next.`, 'select', { assetId: undefined, planId: undefined });
          return finish(`Proof recorded for ${assetId}. Call request_approval(kind: "asset", target: "${assetId}") and continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'failed') throw new Error('execute outcome must be proved, failed, or question.');
        if (plan.data.type !== 'plan' || plan.data.status !== 'failed' || !sectionContent(plan.content, 'Failure')) throw new Error(`${planId} must have status failed and a ## Failure section.`);
        if (plan.data.purpose === 'repair') await this.restoreRepairedProof(assetId, plan.content);
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
          // The verdict covers the versions frozen when the check began (the drift check above found them unchanged), never what is read now.
          const frozenProof = this.frozenPart(assetId, 'proof');
          if (frozenProof && (proofDigest(assetRaw) !== frozenProof || statementDigest(assetRaw) !== this.frozenPart(assetId, 'statement'))) throw new Error(`${assetId} changed while the verdict was being recorded. Run ${LOOP_COMMAND} next.`);
          plan.data.verified_proof_digest = frozenProof ?? proofDigest(assetRaw);
          const assetData = parseMarkdown(assetRaw).data;
          const checkedAgainst = state.current.inputs ? this.frozenDependencies(assetId) : await this.dependencyDigests(assetData);
          if (checkedAgainst) plan.data.dependency_digests = checkedAgainst;
          await this.writeOwned(planFile, stringifyMarkdown(plan.content, plan.data));
          const recheck = state.current.recheck;
          await this.event('proof_verified', { assetId, planId, ...(recheck?.length ? { recheck } : {}) });
          if (recheck?.length && assetData.status === 'approved' && isApproved((await this.approvals()).records, 'asset', assetId, assetRaw)) {
            // An approved result marked for re-check: it stays approved, and the mark goes.
            await this.clearRecheckByAgent(assetId);
            return finish(`The proof of ${assetId} still holds after ${recheck.join(', ')} changed (independent re-check); its re-check mark is cleared. Continue with next.`, 'select', { assetId: undefined, planId: undefined });
          }
          const rewrite = plan.data.purpose === 'rewrite';
          if (rewrite) await this.finishRewrite(assetId, plan.content, plan.data, assetRaw);
          await this.enqueueApproval('asset', assetId, rewrite ? 'Proof reworded at your request in the teaching chat, verified independently.' : plan.data.purpose === 'repair' ? `Your proof, repaired by ${planId} where the check found a gap and verified independently (your version is kept in the plan).` : `Proof from ${planId}, verified independently.`);
          if ((await this.autoApproveQueued()).includes(`asset:${assetId}`)) return finish(`Proof of ${assetId} verified independently and approved automatically (auto mode). Continue with next.`, 'select', { assetId: undefined, planId: undefined });
          return finish(`Proof of ${assetId} verified independently. Call request_approval(kind: "asset", target: "${assetId}") and continue with next.`, 'select', { assetId: undefined, planId: undefined });
        }
        if (report.outcome !== 'rejected') throw new Error('verify_proof outcome must be confirmed, rejected, or question.');
        if (!/^rejected\b/i.test(verdict)) throw new Error(`## Verdict of ${planId} must begin with rejected.`);
        // A rejected rewording costs nothing: the verified proof it would have replaced comes back.
        if (plan.data.purpose === 'rewrite') return finish(await this.rejectRewrite(assetId, planId), 'select', { assetId: undefined, planId: undefined });
        if (state.current.recheck?.length) return finish(await this.rejectStaleProof(assetId, planId, state.current.recheck), 'select', { assetId: undefined, planId: undefined });
        await this.rejectProof(assetId, planId);
        if (plan.data.purpose === 'repair') await this.restoreRepairedProof(assetId, plan.content);
        return this.afterFailedPlan(assetId, planId, `Independent verification rejected the proof from ${planId}`, finish, Boolean(run));
      }
      case 'verify_node': {
        await validated();
        const node = state.current.node;
        if (!node) throw new Error(`No node check is in progress. Run: ${LOOP_COMMAND} next`);
        if (report.outcome !== 'confirmed' && report.outcome !== 'rejected') throw new Error('verify_node outcome must be confirmed, rejected, or question.');
        if (!report.summary.trim()) throw new Error('Give your verdict in --summary: what you checked, or the first problem and what would fix it.');
        return finish(await this.recordNodeCheck(node, report.outcome, report.summary.trim()), 'select', { assetId: undefined, node: undefined });
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
        for (const target of Array.isArray(data.serves) ? data.serves : []) if (!assets.has(String(target))) problems.push(`${file}: serves unknown result ${String(target)}.`);
        if ((folder === folders.plans || folder === folders.checks || folder === folders.candidates) && typeof data.target_asset === 'string' && !assets.has(data.target_asset)) problems.push(`${file}: targets unknown asset ${data.target_asset}.`);
      }
    }
    problems.push(...(await layoutReport(this.files, this.paths)).problems);
    problems.push(...await packageProblemsIn(this.files, this.paths));
    problems.push(...await collectionProblemsIn(this.files, this.paths));
    problems.push(...await this.remarkProblems(new Set([...assets.keys(), ...definitions.keys()])));
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
    // Mid-batch the run does not end: the other items' work is reported first, and the batch's close checks the budget.
    const state = this.require();
    if (state.stage === 'batch' && state.current.batch?.items.some((item) => !item.done)) return undefined;
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
    const ranked = (await this.rankedConjectures()).filter((item) => item.agreed || item.falsified);
    const conjectures = ranked.length ? `\n\nConjectures worth taking up next, best first:\n${describeConjectures(ranked, CONJECTURES_LISTED)}` : '';
    const checked = agentCheckedSince((await this.recentEvents(Number.MAX_SAFE_INTEGER)).filter((event) => String(event.at ?? '') >= run.startedAt));
    const checkedLines = [
      checked.definitions.length ? `- Definitions: ${checked.definitions.join(', ')}` : '',
      checked.citations.length ? `- Results taken from a source (checked against it): ${checked.citations.join(', ')}` : '',
      checked.proofs.length ? `- Proofs no plan of the loop wrote, checked as written: ${checked.proofs.join(', ')}` : '',
      checked.rechecked.length ? `- Proofs re-checked after something they rest on changed: ${checked.rechecked.join(', ')}` : '',
    ].filter(Boolean);
    const review = checkedLines.length ? `\n\nApproved on an independent agent's check alone; worth your review:\n${checkedLines.join('\n')}` : '';
    await this.writeHandoff(`${text} ${run.spent} attempt(s) spent${run.revisions ? `; the agent reassessed what the goals still need ${run.revisions} time(s), keeping yours` : ''}${run.explored ? `; it took up ${run.explored} conjecture(s) as goals of its own` : ''}.${review}${conjectures}`);
    await this.pause(text);
    return `${text} The loop is handed back to the researcher: stop working now and tell them briefly what was proved, what was set aside, and what waits for their review${checkedLines.length ? ', including what was approved on an independent agent\'s check alone (the handoff lists it)' : ''}${ranked.length ? `, and recommend the conjectures worth taking up next (${ranked.slice(0, 3).map((item) => item.id).join(', ')}; ${LOOP_COMMAND} conjecture list ranks them)` : ''}.`;
  }

  autonomyNote(run: NonNullable<LoopState['autonomy']>): string {
    const settings = this.lastSettings ?? DEFAULT_LOOP_SETTINGS;
    const until = settings.autonomyHours > 0 ? `, until ${new Date(Date.parse(run.startedAt) + settings.autonomyHours * 3600_000).toISOString()}` : '';
    return `Autonomous mode (set by the researcher): they are away. Never call ask_researcher or report question; decide every question yourself and say what you chose and why in the report summary. Budget: ${run.spent} of ${settings.autonomyBudget} attempts spent (an executed plan or a search round is one)${until}. When a result's attempts run out, decide yourself whether it deserves more (${LOOP_COMMAND} budget allocate) or should be set aside.`;
  }

  /**
   * Nothing is left that the agent can do alone, but results it could not prove are set aside on
   * the way to the goals: while reassessments remain, it judges what still separates the project
   * from its goals and acts on that itself. It brings back a set-aside result that something new
   * gets past (`budget allocate`), adds goals of its own (an extension of the approved project, so
   * it never drops the researcher's), or both. A later reassessment needs something proved or set
   * aside since the last one, so the run cannot circle. Returns whether a reassessment started.
   */
  private async assessGoals(run: NonNullable<LoopState['autonomy']>): Promise<boolean> {
    const state = this.require();
    const settings = await this.loopSettings();
    if ((run.revisions ?? 0) >= settings.autonomyRevisions || !(await this.isProjectApproved())) return false;
    const progress = await this.progress();
    const gap = await this.goalGap(progress, run.assessment);
    if (!gap.blockers.length || (run.assessment && !gap.changed)) return false;
    run.revisions = (run.revisions ?? 0) + 1;
    run.assessment = { at: this.now(), proved: [...progress.proved.keys()], setAside: progress.setAside.map(([id, info]) => `${id}@${info.at}`), candidates: gap.candidates };
    await this.files.writeFile(ASSESSMENT_PATH, gap.full);
    const left = Math.max(0, settings.autonomyBudget - run.spent);
    const serving = (await this.rankedConjectures()).filter((item) => item.rank === 0 && (item.agreed || item.falsified));
    const offPath = progress.setAside.map(([id]) => id).filter((id) => !gap.blockers.includes(id) && PROMOTED_TYPES.includes(progress.assets.get(id)?.data.type));
    // The lead and the choice come first and stay short: an agent may see only the head of a long instruction.
    const goal = [
      `Autonomous reassessment ${run.revisions} of ${settings.autonomyRevisions} (the researcher is away): nothing is actionable, but ${gap.focus.length ? `the researcher's focus ${gap.focus.join(', ')} is open${gap.outside ? ` (${gap.outside} other open required result(s) lie outside it)` : ''}` : `${gap.open} required result(s) are open`}. Before you stop, judge what still separates ${gap.focus.length ? 'the focus' : 'the project'} from its goals and act on it.`,
      gap.brief,
      gap.narrow ? 'The frontier is narrow: unless an obstruction above is false, the way on is (b), a result that supplies it.' : '',
      `Read a candidate before you judge it (show <id>), then do ${serving.length ? 'any' : 'either or both'}:`,
      `(a) Bring back a set-aside result when something proved since it was set aside, or a genuinely different idea, gets past its recorded obstruction: ${LOOP_COMMAND} budget allocate <id> <n> --reason "<what changed and how it gets past the obstruction>" (${left} attempt(s) of the budget left; the reason becomes the direction its plans must follow). Bring back the set-aside results it depends on too.`,
      '(b) Add the missing step as a new result under new asset ID(s): a lemma that supplies an obstruction above, or a weaker form of it that still serves the goal; or a weaker statement, a special case, or another route to the goal. Say in ## Intended Contribution what changed and why; once it is proved, the next reassessment can bring back what it unblocks, and the researcher decides at hand-back whether to keep the originals.',
      serving.length ? `(c) Take up a conjecture that serves an open goal, as a goal: ${LOOP_COMMAND} conjecture promote <id> --as lemma|theorem|proposition, then list it under required_results. The leading ones:\n${describeConjectures(serving, CONJECTURES_LISTED)}` : '',
      offPath.length ? `Set-aside results no goal needs any more (${offPath.slice(0, CONJECTURES_LISTED).join(', ')}${offPath.length > CONJECTURES_LISTED ? ', …' : ''}): if one is still believed, keep it as a conjecture: ${LOOP_COMMAND} conjecture demote <id> --note "<why it is believed and what it would give>" [--serves id,id].` : '',
      `Then run: ${LOOP_COMMAND} report complete --summary "<the gap as you see it, and what you chose>". Only if ${serving.length ? 'none' : 'neither'} is sound, run: ${LOOP_COMMAND} report none --summary "<why>"; the loop then asks you about each leading candidate before it hands back.`,
    ].filter(Boolean).join('\n');
    await this.markExtension(goal);
    state.researcherInput = { kind: 'autonomous_revision', text: goal, at: this.now() };
    state.lastError = null;
    await this.event('autonomy_revision', { revision: run.revisions, setAside: gap.blockers });
    await this.setStage('draft_project', { assetId: undefined, planId: undefined, counterexampleId: undefined });
    return true;
  }

  /** Results proved (approved with a matching record), with when, and the results the agent may bring back. */
  private async progress(): Promise<{ assets: Map<string, AssetInfo>; proved: Map<string, string>; setAside: Array<[string, LoopState['parked'][string]]> }> {
    const state = this.require();
    const assets = await this.collectKind('asset');
    const records = (await this.approvals()).records;
    const proved = new Map<string, string>();
    for (const [id, asset] of assets) {
      if (asset.data.status !== 'approved' || !isApproved(records, 'asset', id, asset.raw)) continue;
      proved.set(id, records.filter((record) => record.kind === 'asset' && record.target === id).map((record) => record.approvedAt).sort().pop() ?? '');
    }
    return { assets, proved, setAside: Object.entries(state.parked).filter(([, info]) => info.reason !== 'counterexample_pending') };
  }

  /**
   * What still separates the project from its goals: the set-aside results on the paths of the open
   * required results (below a proved result nothing is in the way), those with something proved
   * since they were set aside first, each with its recorded obstruction and the goals it blocks;
   * and what changed since the last reassessment. `brief` leads with the first few, `full` (written
   * to ASSESSMENT_PATH) has them all with their whole notes.
   */
  private async goalGap(progress: Awaited<ReturnType<ResearchLoopCore['progress']>>, before?: GoalAssessment): Promise<{ open: number; focus: string[]; outside: number; narrow: boolean; brief: string; full: string; candidates: string[]; blockers: string[]; changed: boolean }> {
    const state = this.require();
    const { assets, proved } = progress;
    const parked = new Map(progress.setAside);
    const required = requiredAssetIds(await this.files.readFile(this.paths.projectMd).catch(() => '')).filter((id) => !proved.has(id));
    // With a focus, only its open goals count; once all of it is proved, the whole project does again.
    const focus = (state.focus ?? []).filter((id) => required.includes(id));
    const open = focus.length ? focus : required;
    const blocks = new Map<string, string[]>();
    const unblocked: string[] = [];
    for (const goal of open) {
      const seen = new Set<string>();
      const visit = (id: string) => {
        if (seen.has(id) || proved.has(id)) return;
        seen.add(id);
        const deps = assets.get(id)?.data.depends_on;
        for (const dep of Array.isArray(deps) ? deps as string[] : []) visit(dep);
        if (parked.has(id)) blocks.set(id, [...(blocks.get(id) ?? []), goal]);
      };
      visit(goal);
      if (![...blocks.values()].some((goals) => goals.includes(goal))) unblocked.push(goal);
    }
    const recent = [...proved].sort(([, a], [, b]) => b.localeCompare(a));
    const provedSince = (id: string) => recent.filter(([, at]) => at > parked.get(id)!.at).map(([result]) => result);
    const blockers = [...blocks.keys()].sort((a, b) => Number(provedSince(b).length > 0) - Number(provedSince(a).length > 0) || blocks.get(b)!.length - blocks.get(a)!.length || parked.get(b)!.at.localeCompare(parked.get(a)!.at));
    const few = (ids: string[], n: number) => `${ids.slice(0, n).join(', ')}${ids.length > n ? ` and ${ids.length - n} more` : ''}`;
    const describe = (id: string, noteLength: number, shown: number) => {
      const info = parked.get(id)!;
      const note = info.note ? `: ${info.note.length > noteLength ? `${info.note.slice(0, noteLength)}…` : info.note}` : '';
      const since = provedSince(id);
      const goals = blocks.get(id)!;
      return `- ${id} (${info.reason.replace(/_/g, ' ')}${note}); blocks ${goals.length === 1 && goals[0] === id ? 'itself' : few(goals, shown)}; set aside ${info.at.slice(0, 10)}, ${since.length ? `proved since: ${few(since, shown)}` : 'nothing proved since'}`;
    };
    const others = progress.setAside.length - blockers.length;
    const fresh = before ? [...proved.keys()].filter((id) => !before.proved.includes(id)) : [];
    const newlySetAside = before ? progress.setAside.filter(([id, info]) => !before.setAside.includes(`${id}@${info.at}`)).map(([id]) => id) : [];
    const changed = fresh.length || newlySetAside.length ? `Since the last reassessment: ${[fresh.length ? `proved ${fresh.join(', ')}` : '', newlySetAside.length ? `set aside ${newlySetAside.join(', ')}` : ''].filter(Boolean).join('; ')}.` : '';
    const candidates = blockers.slice(0, GAP_BRIEF);
    // A few blockers are the whole frontier: they get their notes in full.
    const narrow = blockers.length > 0 && blockers.length <= GAP_FRONTIER;
    const brief = [
      narrow ? `Only ${blockers.length} set-aside result(s) stand in the way, the whole frontier (${ASSESSMENT_PATH} has the rest of the report):` : `${blockers.length} set-aside result(s) stand in their way. The leading ones (something proved since they were set aside first; all of them with their whole notes: ${ASSESSMENT_PATH}):`,
      ...candidates.map((id) => narrow ? describe(id, 800, 3) : describe(id, 160, 2)),
      changed,
    ];
    const full = [
      `# Reassessment of the goals\n\n${open.length} required result(s) are open; ${blockers.length} set-aside result(s) stand in their way, with the obstruction as recorded:\n`,
      ...blockers.map((id) => describe(id, Number.MAX_SAFE_INTEGER, 10)),
      unblocked.length ? `\nOpen with nothing set aside in the way (they wait on the researcher): ${unblocked.join(', ')}.` : '',
      others ? `\n${others} other set-aside result(s) lie on no path to an open goal: ${progress.setAside.map(([id]) => id).filter((id) => !blocks.has(id)).join(', ')}.` : '',
      changed ? `\n${changed}` : '',
      state.approvalQueue.length ? `\nWaiting for the researcher: ${state.approvalQueue.map((item) => `${item.kind} ${item.target}`).join(', ')}.` : '',
    ];
    return { open: open.length, focus, outside: focus.length ? required.length - focus.length : 0, narrow, brief: brief.filter(Boolean).join('\n'), full: full.filter(Boolean).join('\n') + '\n', candidates, blockers, changed: Boolean(changed) };
  }

  /** Set-aside results that the given results depend on, directly or through other results. */
  private async setAsideDependencies(ids: string[]): Promise<string[]> {
    const state = this.require();
    const assets = await this.collectKind('asset');
    const found: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const deps = assets.get(id)?.data.depends_on;
      for (const dep of Array.isArray(deps) ? deps as string[] : []) {
        if (state.parked[dep] && !found.includes(dep)) found.push(dep);
        visit(dep);
      }
    };
    ids.forEach(visit);
    return found;
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
    const agentChecked = agentCheckedSince(events);
    return {
      active: state.status === 'running' && !run.handedOverAt, startedAt: run.startedAt, handedOverAt: run.handedOverAt,
      reason: run.handedOverAt && typeof handover?.reason === 'string' ? handover.reason : undefined,
      spent: run.spent, budget: settings.autonomyBudget,
      deadline: settings.autonomyHours > 0 ? new Date(Date.parse(run.startedAt) + settings.autonomyHours * 3600_000).toISOString() : undefined,
      revisions: run.revisions ?? 0, revisionLimit: settings.autonomyRevisions,
      spending: [...spending].map(([id, attempts]) => ({ id, attempts })).sort((a, b) => b.attempts - a.attempts),
      proved, setAside, addedGoals, decided,
      ...(agentChecked.definitions.length || agentChecked.citations.length || agentChecked.rechecked.length || agentChecked.proofs.length ? { agentChecked } : {}),
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
    // Brought back while reassessing the goals: the reassessment's report settles what comes next.
    const assessment = state.researcherInput?.kind === 'autonomous_revision' ? run.assessment : undefined;
    if (assessment) {
      assessment.broughtBack = [...new Set([...(assessment.broughtBack ?? []), assetId])];
      await this.save();
      return `${assetId} comes back with ${attempts} more ${construct ? 'search round(s)' : 'proof attempt(s)'} and your direction. Bring back others or add goals, then run: ${LOOP_COMMAND} report complete --summary "<the gap as you see it, and what you chose>"`;
    }
    if (run.deciding === assetId) {
      delete run.deciding;
      if (construct || await this.willRoute(assetId)) await this.setStage('select', { assetId: undefined });
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

  /** `recentParked` keeps only that many of the latest parked results (an agent's view); the full map is for scripts and the researcher. */
  statusSummary(options: { recentParked?: number } = {}): Record<string, unknown> {
    const state = this.state;
    if (!state) return { status: 'idle' };
    const parked = options.recentParked === undefined ? state.parked : Object.fromEntries(this.recentParked(options.recentParked));
    return {
      status: state.status, stage: state.stage, provider: state.provider, assetId: state.current.assetId, planId: state.current.planId,
      counterexampleId: state.current.counterexampleId, waitingForHuman: isWaitingForHuman(state), pendingQuestion: state.pendingQuestion,
      approvalQueue: state.approvalQueue, parked, parkedCount: Object.keys(state.parked).length, lock: state.lock, lastSummary: state.lastSummary, lastError: state.lastError,
      unreadAnswers: state.answers.filter((answer) => !answer.consumed), autonomy: state.autonomy, focus: state.focus, updatedAt: state.updatedAt,
    };
  }

  /** The latest parked results, newest first. */
  private recentParked(limit: number): Array<[string, LoopState['parked'][string]]> {
    return Object.entries(this.state?.parked ?? {}).sort(([, a], [, b]) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, limit);
  }

  /**
   * The loop's state for the agent's context. The hooks send it every turn, so
   * it names only the latest parked results. `compact` is for turns that are
   * a subagent's hand-back rather than the researcher's: only what changes.
   */
  briefStatus(options: { compact?: boolean } = {}): string {
    const state = this.state;
    if (!state) return `Research loop: not started. Start it with \`${LOOP_COMMAND} start --provider claude|codex\` or the VS Code command "Research Assistant: Start research loop".`;
    const lines = [`Research loop: ${state.status}, stage ${state.stage}${state.current.assetId ? `, asset ${state.current.assetId}` : ''}${state.current.planId ? `, plan ${state.current.planId}` : ''}.`];
    if (state.pendingQuestion) lines.push(`Pending question (${state.pendingQuestion.kind}): ${state.pendingQuestion.prompt}`);
    const unread = state.answers.filter((answer) => !answer.consumed);
    if (unread.length) lines.push(`Late researcher answers: ${unread.map((answer) => `"${answer.text.slice(0, 120)}"`).join(' | ')}`);
    if (options.compact) return lines.join('\n');
    if (state.approvalQueue.length) lines.push(`Waiting for researcher approval: ${state.approvalQueue.map((item) => `${item.kind} ${item.target}`).join(', ')}.`);
    const parkedCount = Object.keys(state.parked).length;
    if (parkedCount) {
      const recent = this.recentParked(BRIEF_PARKED);
      lines.push(`Parked (${parkedCount}): ${recent.map(([id, info]) => `${id} (${info.reason})`).join(', ')}${parkedCount > recent.length ? `, and ${parkedCount - recent.length} earlier (${LOOP_COMMAND} status --json lists them)` : ''}.`);
    }
    if (state.lastError) lines.push(`Note: ${state.lastError}`);
    if (state.focus?.length) lines.push(`Focus (set by the researcher): ${state.focus.join(', ')}; the loop works toward these first.`);
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

/** What was approved on an agent's check alone, from a run's events: confirmed node checks, and proofs re-checked after a dependency changed. */
function agentCheckedSince(events: Array<Record<string, unknown>>): AgentCheckedView {
  const view: AgentCheckedView = { definitions: [], citations: [], rechecked: [], proofs: [] };
  const add = (list: string[], id: unknown) => { if (typeof id === 'string' && id && !list.includes(id)) list.push(id); };
  for (const event of events) {
    if (event.type === 'node_checked' && event.verdict === 'confirmed') add(event.mode === 'definition' ? view.definitions : view.citations, event.assetId);
    if (event.type === 'proof_verified' && Array.isArray(event.recheck) && event.recheck.length) add(view.rechecked, event.assetId);
    if (event.type === 'proof_checked' && event.verdict === 'confirmed') add(event.from === 'recheck' ? view.rechecked : view.proofs, event.assetId);
  }
  return view;
}

/** Holds an agent's re-check may lift: something the result rests on changed. A change to the result itself, or an approval without a record, stays with the researcher. */
function isLiftableHold(reason: string): boolean {
  return reason === 'dependency_changed' || reason.startsWith('recheck:');
}

/** The dependencies whose statement digest differs from the one stamped (added, removed, or changed). */
function changedDigests(stamped: unknown, current: Record<string, string>): string[] {
  const old = stamped && typeof stamped === 'object' && !Array.isArray(stamped) ? stamped as Record<string, unknown> : {};
  return [...new Set([...Object.keys(old), ...Object.keys(current)])].filter((id) => old[id] !== current[id]).sort();
}

/** Where research-loop check writes a pack: never the loop's own pack, which a running loop reads. */
function checkPackPath(id: string): string {
  return `${STATE_DIR}/checks/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`;
}

/** Beside an extraction check's pack: what the check reads, frozen when the task was written. */
function checkInputsPath(id: string): string {
  return checkPackPath(id).replace(/\.md$/, '.inputs.json');
}

const coverageTarget = (source: string) => source.trim();
const batchDigest = (ids: string[]) => crypto.createHash('sha256').update([...new Set(ids)].sort().join('\n')).digest('hex').slice(0, 16);

/** What an independent check of a node looks at, said once for the loop's stage and for research-loop check. */
function nodeCheckWhat(node: NodeCheckTarget): string {
  if (node.mode === 'definition') return `the definition ${node.id}: it is well formed (every symbol and term it uses is defined, by itself or by a definition it lists in depends_on, and nothing is circular), it says what the results that use it need, and it does not make a goal trivial, vacuous, or a different problem (an empty class, a condition that already contains the conclusion, a weaker notion than the goals mean); when it cites a source, it matches the source`;
  if (node.mode === 'citation') return `the result ${node.id}, taken from a source: read the cited location (${LOOP_COMMAND} show <paper_slug> --section ...; a library collection names its paper) and check that the statement matches it exactly: every hypothesis kept, quantifiers and their order, constants, the theorem number or page`;
  return `the proof of ${node.id} as written, against its statement, step by step as a referee would (the verify-proof skill's standard): every step follows, every hypothesis of a cited result or dependency holds where it is used, nothing is assumed that the statement does not give, and every case is covered. A gap that a short argument closes is still a gap: name it`;
}

const CONFIRMED_NOTE = " (an independent agent's check confirmed it)";
const PROBLEM_NOTE = " (the agent's check found a problem: ";

/** The note a queued approval carries about the independent check of its version. */
function checkNote(verdict: 'confirmed' | 'rejected', summary: string): string {
  return verdict === 'confirmed' ? CONFIRMED_NOTE : `${PROBLEM_NOTE}${summary.split('\n')[0].slice(0, 200)})`;
}

/** Replace an earlier check note on an approval reason with the current one (or none). */
function withCheckNote(reason: string, note: string): string {
  const at = Math.max(reason.lastIndexOf(CONFIRMED_NOTE), reason.lastIndexOf(PROBLEM_NOTE));
  return (at >= 0 ? reason.slice(0, at) : reason) + note;
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
