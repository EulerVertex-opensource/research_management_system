import * as path from 'path';
import type matter from 'gray-matter';
import { parseMarkdown } from './Frontmatter';
import { NodeKind } from '../domain/nodeKinds';
import { researchDigest } from '../domain/digests';
import { nodeProblems } from '../domain/schema';
import { hasSection, sectionContent, statementPart, stripManagedBlocks } from '../domain/sections';

/**
 * Pure types and helpers for the chat-driven research loop. Shared by the
 * extension, the bundled CLI, and the hook entry point; must not import vscode.
 */

export type AgentProvider = 'claude' | 'codex';
export type LoopStatus = 'idle' | 'running' | 'paused' | 'stopped';
export type LoopStage =
  | 'discuss_goals' | 'draft_project' | 'review_project' | 'scaffold' | 'sources' | 'select'
  | 'falsify' | 'verify_counterexample' | 'plan' | 'execute' | 'waiting' | 'ready';
export type QuestionKind = 'goals' | 'discussion' | 'blocked' | 'counterexample_review';
export type ApprovalKind = 'project' | 'asset' | 'definition' | 'citation' | 'counterexample';
export type ReportOutcome = 'complete' | 'none' | 'candidate' | 'confirmed' | 'rejected' | 'proved' | 'failed' | 'question';

export const STATE_DIR = '.research-assistant-loop';
export const STATE_PATH = `${STATE_DIR}/state.json`;
export const EVENTS_PATH = `${STATE_DIR}/events.jsonl`;
export const SNAPSHOT_PATH = `${STATE_DIR}/snapshot.json`;
export const BRIDGE_PATH = `${STATE_DIR}/bridge.json`;
/** The current stage's compiled context pack and its manifest (files it covers, token estimate). */
export const CONTEXT_PACK_PATH = `${STATE_DIR}/context/current.md`;
export const CONTEXT_MANIFEST_PATH = `${STATE_DIR}/context/current.json`;
/** Local sync bookkeeping (conflict in progress, last prepare); never committed. */
export const SYNC_PATH = `${STATE_DIR}/sync.json`;
/**
 * sha256 of the driver script the running extension ships. Hooks run the copy
 * under the skills folder; a copy that differs is stale and must not act,
 * because an older engine misreads newer files (e.g. split approvals).
 */
export const DRIVER_PATH = `${STATE_DIR}/driver.json`;
/** User-level registry of running extension bridges, so a globally registered MCP server can find the project. */
export const BRIDGE_REGISTRY = ['.research-assistant', 'bridges.json'];
export interface BridgeEntry { root: string; port: number; token: string; pid: number; startedAt: string }

export interface LoopFiles {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listFiles(relativeDir: string, extension?: string): Promise<string[]>;
  deleteFile?(relativePath: string): Promise<void>;
}

/** Git-tracked folders that carry research meaning which used to live only in local loop state. */
export interface SharedFolders { checks: string; decisions: string; handoffs: string; approvals: string }
export function sharedFolders(researchRoot: string): SharedFolders {
  const join = (child: string) => researchRoot === '.' ? child : path.posix.join(researchRoot, child);
  return { checks: join('checks'), decisions: join('decisions'), handoffs: join('handoffs'), approvals: join('approvals') };
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
/** A new goal added to an approved project; baselineRequired are the required results that must be kept. */
export interface LoopExtension { goal: string; at: string; baselineRequired: string[]; projectApproved?: boolean; newResults?: string[] }
export interface LoopLock { sessionId: string; provider?: AgentProvider; acquiredAt: string; heartbeatAt: string }
export interface StageSummary { stage: LoopStage; assetId?: string; outcome: ReportOutcome; summary: string; files: string[]; at: string }

export interface LoopState {
  version: 2;
  runId: string;
  provider: AgentProvider;
  status: LoopStatus;
  stage: LoopStage;
  resumeStage?: LoopStage;
  current: { assetId?: string; planId?: string; counterexampleId?: string; stageStartedAt: string; baseCommit?: string; statementDigest?: string };
  /** falsifiedAt is legacy local state; falsification now lives in shared check records. */
  progress: Record<string, { falsifiedAt?: string; changesRequested?: string }>;
  scaffoldBrief?: { missing?: string[]; incomplete?: string[] };
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
  startedAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  kind: 'project' | 'asset' | 'definition'; target: string; digest: string; approvedAt: string; source?: string;
  statement?: string; performed_by?: string; base_commit?: string; extension_version?: string;
}
export interface ApprovalFile { version: 1; records: ApprovalRecord[] }

export interface StageReport {
  outcome: ReportOutcome;
  summary: string;
  assetId?: string;
  planId?: string;
  counterexampleId?: string;
  question?: string;
  assumedDefinitions?: string[];
}

export interface ResearchFolders { assets: string; definitions: string; ideas: string; plans: string; checks?: string; decisions?: string; handoffs?: string }

export { researchDigest, statementDigest, proofDigest } from '../domain/digests';

export function isApproved(records: ApprovalRecord[], kind: 'project' | 'asset' | 'definition', target: string, raw: string): boolean {
  return records.some((record) => record.kind === kind && record.target === target && record.digest === researchDigest(raw, kind));
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
  const kind: NodeKind | undefined = folder === folders.assets ? 'asset' : folder === folders.definitions ? 'definition' : folder === folders.ideas ? 'idea' : folder === folders.plans ? 'plan' : undefined;
  if (kind) {
    const problems = nodeProblems(kind, id, data, content, { allowApproved: options.committed, paperIds });
    if (kind === 'asset' && !problems.length && data.status === 'draft' && statementIncomplete(content)) problems.push(`${id}: asset statement is incomplete.`);
    if (problems.length) throw new Error(problems[0]);
  } else if (folders.checks && folder === folders.checks) {
    if (data.type !== 'falsification_check' || typeof data.target_asset !== 'string' || !['no_counterexample_found', 'counterexample_rejected'].includes(data.outcome) || !sectionContent(content, 'Cases checked') || !hasSection(content, 'Limitations')) {
      throw new Error(`${id}: invalid falsification check (type falsification_check, target_asset, outcome no_counterexample_found|counterexample_rejected, ## Cases checked, ## Limitations).`);
    }
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
    autopilot: { iterationCap, sessions: {} }, lastError: null, startedAt: now, updatedAt: now,
  };
}
