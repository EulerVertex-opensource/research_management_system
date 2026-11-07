import * as path from 'path';
import type matter from 'gray-matter';
import { parseMarkdown } from './Frontmatter';
import { NodeKind } from '../domain/nodeKinds';
import { researchDigest, statementDigest } from '../domain/digests';
import { nodeProblems } from '../domain/schema';
import { LIBRARY_PREFIX, isLibraryId, locateNodeFile } from '../domain/registry';
import { hasSection, sectionContent, statementPart, stripManagedBlocks } from '../domain/sections';
import { SearchMode, SearchSlot, candidateProblems, roundProblems } from '../domain/search';

/**
 * Pure types and helpers for the chat-driven research loop. Shared by the
 * extension, the bundled CLI, and the hook entry point; must not import vscode.
 */

export type AgentProvider = 'claude' | 'codex';
export type LoopStatus = 'idle' | 'running' | 'paused' | 'stopped';
export type LoopStage =
  | 'discuss_goals' | 'draft_project' | 'review_project' | 'scaffold' | 'sources' | 'select'
  | 'search' | 'search_summary' | 'verify_counterexample' | 'verify_construction' | 'plan' | 'execute' | 'verify_proof' | 'conjecture' | 'waiting' | 'ready';
export type QuestionKind = 'goals' | 'discussion' | 'blocked' | 'counterexample_review';
/** `specification`: the required properties of a construction, approved before any search spends tokens on them. */
/** `package`: one review of an imported research package (target: its alias) that approves all of its results at once. */
export type ApprovalKind = 'project' | 'asset' | 'definition' | 'citation' | 'counterexample' | 'specification' | 'package';
export type ReportOutcome = 'complete' | 'none' | 'candidate' | 'confirmed' | 'rejected' | 'proved' | 'failed' | 'question' | 'searched' | 'summarized';
export const REPORT_OUTCOMES: readonly ReportOutcome[] = ['complete', 'none', 'candidate', 'confirmed', 'rejected', 'proved', 'failed', 'question', 'searched', 'summarized'];
/** Stages of one object search; the search round in `current.search` lives through all of them. */
export const SEARCH_STAGES: ReadonlySet<LoopStage> = new Set<LoopStage>(['search', 'search_summary', 'verify_counterexample', 'verify_construction']);

export const STATE_DIR = '.research-assistant-loop';
/** Loop state is rewritten by several processes (extension, MCP bridges, CLI) while others read it, so it is replaced atomically. */
export const isLoopStatePath = (relativePath: string) => relativePath.replace(/\\/g, '/').startsWith(`${STATE_DIR}/`);
export const STATE_PATH = `${STATE_DIR}/state.json`;
export const EVENTS_PATH = `${STATE_DIR}/events.jsonl`;
export const SNAPSHOT_PATH = `${STATE_DIR}/snapshot.json`;
export const BRIDGE_PATH = `${STATE_DIR}/bridge.json`;
/** The current stage's compiled context pack and its manifest (files it covers, token estimate). */
export const CONTEXT_PACK_PATH = `${STATE_DIR}/context/current.md`;
export const CONTEXT_MANIFEST_PATH = `${STATE_DIR}/context/current.json`;
/** The full gap report of an autonomous reassessment of the goals; the instruction carries only its lead. */
export const ASSESSMENT_PATH = `${STATE_DIR}/context/assessment.md`;
/** Local sync bookkeeping (conflict in progress, last prepare); never committed. */
export const SYNC_PATH = `${STATE_DIR}/sync.json`;
/**
 * sha256 of the driver script the running extension ships. Hooks run the copy
 * under the skills folder; a copy that differs is stale and must not act,
 * because an older engine misreads newer files (e.g. split approvals).
 */
export const DRIVER_PATH = `${STATE_DIR}/driver.json`;
/** Whether an agent is in a turn right now; written only from the agent's side (see AgentActivity). */
export const AGENT_PATH = `${STATE_DIR}/agent.json`;
/** Local loop policy (auto mode, limits) the researcher sets in the dashboard; the agent may not write it. */
export const LOOP_SETTINGS_PATH = `${STATE_DIR}/settings.json`;
/** Results auto mode must leave to the researcher, e.g. after a dependency changed under an approval. */
export const AUTO_HOLDS_PATH = `${STATE_DIR}/auto-holds.json`;
/** User-level registry of running extension bridges, so a globally registered MCP server can find the project. */
export const BRIDGE_REGISTRY = ['.research-assistant', 'bridges.json'];
export interface BridgeEntry { root: string; port: number; token: string; pid: number; startedAt: string }
export const EXTENSION_ID = 'tianhao.research-management-system';
/**
 * Chat links that open a node's page in the dashboard. Agent chats render only
 * web links and file paths (Codex drops vscode:// links), so a link points at a
 * small local file per node; when an editor opens one, the extension closes it
 * and shows the node in the dashboard. Without the extension, the file names
 * the node's own file.
 */
export const DASHBOARD_LINKS_DIR = `${STATE_DIR}/open`;
export const dashboardLinkPath = (id: string) => `${DASHBOARD_LINKS_DIR}/${id}.md`;
export const dashboardLinkStub = (title: string, file: string) =>
  `# ${title}\n\nOpening this in the Research Assistant dashboard. If nothing happened, the Research Assistant extension is not running in this window; the file itself is ${file}.\n`;
/** Write the link file of each node that lacks one or names another title or file; returns how many were written. */
export async function writeDashboardLinks(files: LoopFiles, nodes: Array<{ id: string; title: string; file: string }>): Promise<number> {
  let written = 0;
  for (const node of nodes) {
    const stub = dashboardLinkStub(node.title, node.file);
    if ((await files.readFile(dashboardLinkPath(node.id)).catch(() => undefined)) === stub) continue;
    await files.writeFile(dashboardLinkPath(node.id), stub);
    written++;
  }
  return written;
}

export interface LoopFiles {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  /** Append without reading the file back, so writers in other processes never lose lines. */
  appendFile?(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listFiles(relativeDir: string, extension?: string): Promise<string[]>;
  /** Immediate subfolders (paths relative to the project); used to discover library collections. */
  listDirs?(relativeDir: string): Promise<string[]>;
  deleteFile?(relativePath: string): Promise<void>;
}

/** Git-tracked folders that carry research meaning which used to live only in local loop state. */
export interface SharedFolders { checks: string; decisions: string; handoffs: string; approvals: string; candidates: string }
export function sharedFolders(researchRoot: string): SharedFolders {
  const join = (child: string) => researchRoot === '.' ? child : path.posix.join(researchRoot, child);
  return { checks: join('checks'), decisions: join('decisions'), handoffs: join('handoffs'), approvals: join('approvals'), candidates: join('candidates') };
}

export interface LoopQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  assetId?: string;
  options?: string[];
  createdAt: string;
  expiredAt?: string;
  timeoutSec?: number;
}

export interface LoopAnswer { questionId: string; decision: 'answer' | 'skip'; text: string; answeredAt: string; source: string; consumed?: boolean }
export interface ApprovalRequest { id: string; kind: ApprovalKind; target: string; digest: string; reason: string; requestedAt: string }
export interface ResearcherInput { kind: string; text: string; at: string }
/** A new goal added to an approved project; baselineRequired are the required results that must be kept, except retired ones (since deprecated or archived). */
export interface LoopExtension { goal: string; at: string; baselineRequired: string[]; retired?: string[]; projectApproved?: boolean; newResults?: string[] }
/**
 * An autonomous reassessment of the goals: what was proved and set aside (`id@parkedAt`) when it
 * began, the leading set-aside results it offered, the results the agent brought back, and the
 * agent's first `report none`, which the loop answers by asking about each leading result.
 */
export interface GoalAssessment { at: string; proved: string[]; setAside: string[]; candidates?: string[]; broughtBack?: string[]; declined?: string }
export interface LoopLock { sessionId: string; provider?: AgentProvider; acquiredAt: string; heartbeatAt: string }
export interface StageSummary { stage: LoopStage; assetId?: string; outcome: ReportOutcome; summary: string; files: string[]; at: string }
/** One reason the loop has nothing actionable (stage `waiting`); the dashboard lists each one. */
/** `study`: the researcher asked the loop not to get further ahead of them; target is the count of verified results they have not studied. */
export interface WaitingReason { kind: 'approval' | 'parked' | 'missing_definition' | 'cycle' | 'study'; target: string; detail?: string }

export interface LoopState {
  version: 2;
  runId: string;
  provider: AgentProvider;
  status: LoopStatus;
  stage: LoopStage;
  resumeStage?: LoopStage;
  current: {
    assetId?: string; planId?: string; counterexampleId?: string;
    /** Stage `conjecture`: the conjecture idea being made precise. */
    ideaId?: string;
    stageStartedAt: string; baseCommit?: string; statementDigest?: string;
    /** The object-search round in progress: its mode, number, and the direction each worker slot was given. */
    search?: { mode: SearchMode; round: number; slots: SearchSlot[]; candidateId?: string; properties?: string[]; requested?: boolean };
  };
  /** falsifiedAt is legacy local state; falsification now lives in shared check records. */
  /** constructionProof: digest of the proof a verified search construction wrote into the asset; it vouches for that proof as a verified plan would. */
  progress: Record<string, { falsifiedAt?: string; changesRequested?: string; constructionProof?: string }>;
  scaffoldBrief?: { missing?: string[]; incomplete?: string[]; missingDefinitions?: string[] };
  /** Definitions drafted to fill a gap while the researcher asked to be waited for (rigor.missingDefinitions: wait). */
  awaitingDefinitions?: string[];
  parked: Record<string, { reason: string; at: string; note?: string }>;
  pendingQuestion?: LoopQuestion;
  answers: LoopAnswer[];
  approvalQueue: ApprovalRequest[];
  researcherInput?: ResearcherInput;
  extension?: LoopExtension;
  lock?: LoopLock;
  autopilot: { iterationCap: number; sessions: Record<string, { blocks: number; lastSignature: string; lastBlockAt: string }> };
  lastSummary?: StageSummary;
  lastError?: string | null;
  /** Set with stage `waiting`: what the researcher must resolve; `lastError` holds the same as text for the agent. */
  waitingOn?: WaitingReason[];
  /**
   * An autonomous run, while the researcher's setting has autonomous mode on: when it began, the
   * attempts it spent (an executed plan or a search round each), the asset whose allotment ran out
   * and waits on the agent's own decision, the reassessments of the goals it made, what was proved
   * and set aside at the latest one (`id@parkedAt`) and the results it brought back there, and
   * when it handed the loop back.
   */
  autonomy?: { startedAt: string; spent: number; deciding?: string; revisions?: number; assessment?: GoalAssessment; handedOverAt?: string; explored?: number };
  /** Conjecture ideas the agent already tried to make precise (stage `conjecture`), so none is tried twice. */
  conjectureTried?: string[];
  /** Conjecture ideas the researcher asked the agent to make precise, whatever the settings allow. */
  conjectureRequests?: string[];
  /** The required results the researcher wants first: selection works toward them before the rest, and an autonomous reassessment weighs them alone. */
  focus?: string[];
  startedAt: string;
  /** When status last became running (start, resume, or an extension of a stopped loop); an agent silent since then has not picked it up. */
  runningSince?: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  /**
   * `remark`: the researcher agreed a remark may appear in the paper; it covers the remark's text, not any result.
   * `package`: the researcher accepted an imported package (target: its alias); `digest` is the package digest and
   * `nodes` holds each result's digests, so every result it covers counts as approved while its content matches.
   */
  kind: 'project' | 'asset' | 'definition' | 'specification' | 'remark' | 'package'; target: string; digest: string; approvedAt: string; source?: string;
  statement?: string; performed_by?: string; base_commit?: string; extension_version?: string;
  /** Only on a package record. */
  package?: string; version?: string; nodes?: Record<string, PackageApprovalNode>;
}
export interface PackageApprovalNode { digest: string; statement: string }
export interface ApprovalFile { version: 1; records: ApprovalRecord[] }

export interface StageReport {
  outcome: ReportOutcome;
  summary: string;
  assetId?: string;
  planId?: string;
  counterexampleId?: string;
  question?: string;
  assumedDefinitions?: string[];
  /** `report none --confirm`: the agent went through the leading set-aside results and still finds none to bring back. */
  confirm?: boolean;
}

export interface ResearchFolders { assets: string; definitions: string; ideas: string; plans: string; library?: string; checks?: string; decisions?: string; handoffs?: string; candidates?: string }

export { researchDigest, statementDigest, proofDigest } from '../domain/digests';

/** A specification approval covers the statement only, so writing the construction found later keeps it. */
export function approvalDigest(raw: string, kind: ApprovalRecord['kind']): string {
  // A package record is not compared against one file's digest; its results carry their own (see isApproved).
  return kind === 'specification' ? statementDigest(raw) : researchDigest(raw, kind === 'remark' || kind === 'package' ? 'asset' : kind);
}

export function isApproved(records: ApprovalRecord[], kind: ApprovalRecord['kind'], target: string, raw: string): boolean {
  const digest = approvalDigest(raw, kind);
  if (records.some((record) => record.kind === kind && record.target === target && record.digest === digest)) return true;
  // A result of an imported package is also approved by the package's one record.
  return (kind === 'asset' || kind === 'definition') && records.some((record) => record.kind === 'package' && record.nodes?.[target]?.digest === digest);
}

/**
 * The record that approves a result: its own, else the package record that
 * covers it, presented as a per-result record (digest and statement).
 */
export function approvalRecordOf(records: ApprovalRecord[], kind: 'asset' | 'definition', target: string): ApprovalRecord | undefined {
  const own = records.find((record) => record.kind === kind && record.target === target);
  if (own) return own;
  const pkg = records.find((record) => record.kind === 'package' && record.nodes?.[target]);
  if (!pkg) return undefined;
  const node = pkg.nodes![target];
  return { kind, target, digest: node.digest, statement: node.statement, approvedAt: pkg.approvedAt, source: `package:${pkg.target}`, ...(pkg.performed_by ? { performed_by: pkg.performed_by } : {}) };
}

export function safeRelativeFile(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) throw new Error(`Unsafe file path: ${filePath}`);
  return normalized;
}

export function proofText(body: string): string { return sectionContent(body, 'Proof'); }
export function statementIncomplete(body: string): boolean {
  const statement = stripManagedBlocks(statementPart(body));
  return !statement.trim() || /Write the .* here\.|Describe the .* here\./.test(statement);
}

/**
 * Validate one research Markdown file. By default it applies the rules for a
 * file the agent wrote; `committed` accepts researcher-approved nodes and the
 * loop-written shared records, for whole-workspace checks after a pull.
 */
export function validateResearchFile(filePath: string, raw: string, folders: ResearchFolders, paperIds: Set<string>, options: { committed?: boolean } = {}): void {
  if (!filePath.endsWith('.md')) throw new Error(`Research file must be Markdown: ${filePath}`);
  let parsed: matter.GrayMatterFile<string>;
  try { parsed = parseMarkdown(raw); } catch (error) { throw new Error(`${filePath}: invalid YAML frontmatter (${String(error)})`); }
  const { data, content } = parsed;
  const id = path.posix.basename(filePath, '.md');
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Invalid node ID: ${id}`);
  if (typeof data.title !== 'string' || !data.title.trim()) throw new Error(`${id}: title is required.`);
  const folder = path.posix.dirname(filePath);
  const location = folders.library ? locateNodeFile(filePath, { assets: folders.assets, definitions: folders.definitions, library: folders.library }) : undefined;
  if (location?.origin === 'library' && !isLibraryId(id)) throw new Error(`${filePath}: library node IDs must start with ${LIBRARY_PREFIX}.`);
  if (location?.origin === 'project' && isLibraryId(id)) throw new Error(`${filePath}: the ${LIBRARY_PREFIX} prefix is reserved for library nodes.`);
  const kind: NodeKind | undefined = location?.kind ?? (folder === folders.assets ? 'asset' : folder === folders.definitions ? 'definition' : folder === folders.ideas ? 'idea' : folder === folders.plans ? 'plan' : undefined);
  if (kind) {
    const problems = nodeProblems(kind, id, data, content, { allowApproved: options.committed, paperIds });
    if (kind === 'asset' && !problems.length && data.status === 'draft' && statementIncomplete(content)) problems.push(`${id}: asset statement is incomplete.`);
    if (problems.length) throw new Error(problems[0]);
  } else if (folders.checks && folder === folders.checks) {
    if (data.type === 'search_round') {
      const problems = roundProblems(id, data, content);
      if (problems.length) throw new Error(problems[0]);
    } else if (data.type !== 'falsification_check' || typeof data.target_asset !== 'string' || !['no_counterexample_found', 'counterexample_rejected'].includes(data.outcome) || !sectionContent(content, 'Cases checked') || !hasSection(content, 'Limitations')) {
      throw new Error(`${id}: invalid falsification check (type falsification_check, target_asset, outcome no_counterexample_found|counterexample_rejected, ## Cases checked, ## Limitations).`);
    }
  } else if (folders.candidates && folder === folders.candidates) {
    const problems = candidateProblems(id, data, content, { committed: options.committed });
    if (problems.length) throw new Error(problems[0]);
  } else if (options.committed && folders.decisions && folder === folders.decisions) {
    if (data.type !== 'decision' || typeof data.target !== 'string' || typeof data.kind !== 'string') throw new Error(`${id}: invalid decision record.`);
  } else if (options.committed && folders.handoffs && folder === folders.handoffs) {
    if (data.type !== 'handoff') throw new Error(`${id}: invalid handoff record.`);
  } else throw new Error(`Research loop may not write ${filePath}.`);
}

export function stageSignature(state: LoopState): string {
  return [state.stage, state.current.assetId ?? '', state.current.planId ?? '', state.current.stageStartedAt, state.lastSummary?.at ?? ''].join(':');
}

export function isWaitingForHuman(state: LoopState): boolean {
  return Boolean(state.pendingQuestion) || state.stage === 'waiting';
}

export function newState(provider: AgentProvider, runId: string, now: string, iterationCap: number): LoopState {
  return {
    version: 2, runId, provider, status: 'running', stage: 'select',
    current: { stageStartedAt: now }, progress: {}, parked: {}, answers: [], approvalQueue: [],
    autopilot: { iterationCap, sessions: {} }, lastError: null, startedAt: now, runningSince: now, updatedAt: now,
  };
}
