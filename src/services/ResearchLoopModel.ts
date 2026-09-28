import * as crypto from 'crypto';
import * as path from 'path';
import type matter from 'gray-matter';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';

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

export const PROVABLE_TYPES = new Set(['theorem', 'lemma', 'proposition', 'construction']);
export const ASSET_TYPES = new Set(['theorem', 'lemma', 'proposition', 'example', 'construction', 'remark']);
export const MAX_FAILED_PLANS = 3;
export const STATE_DIR = '.research-assistant-loop';
export const STATE_PATH = `${STATE_DIR}/state.json`;
export const EVENTS_PATH = `${STATE_DIR}/events.jsonl`;
export const SNAPSHOT_PATH = `${STATE_DIR}/snapshot.json`;
export const BRIDGE_PATH = `${STATE_DIR}/bridge.json`;
/** User-level registry of running extension bridges, so a globally registered MCP server can find the project. */
export const BRIDGE_REGISTRY = ['.research-assistant', 'bridges.json'];
export interface BridgeEntry { root: string; port: number; token: string; pid: number; startedAt: string }

export interface LoopFiles {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listFiles(relativeDir: string, extension?: string): Promise<string[]>;
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
  current: { assetId?: string; planId?: string; counterexampleId?: string; stageStartedAt: string };
  progress: Record<string, { falsifiedAt?: string; changesRequested?: string }>;
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

export interface ApprovalRecord { kind: 'project' | 'asset' | 'definition'; target: string; digest: string; approvedAt: string; source?: string }
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

export interface ResearchFolders { assets: string; definitions: string; ideas: string; plans: string }

export function requiredAssetIds(project: string): string[] {
  const match = /^## Required Results\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(project);
  if (!match) return [];
  return [...new Set([...match[1].matchAll(/^\s*-\s*(?:\[[ xX]\]\s*)?`?([a-z][a-z0-9_]*)`?(?:\s|:|$)/gm)].map((item) => item[1]))];
}

export function projectSection(project: string, heading: string): string {
  const match = new RegExp(`^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(project);
  return match ? match[1].trim() : '';
}

export function hasSection(body: string, heading: string): boolean {
  return new RegExp(`^## ${heading}[ \\t]*$`, 'm').test(body);
}

export function sectionContent(body: string, heading: string): string {
  return projectSection(body, heading);
}

function normalizeProse(text: string): string {
  return text
    .replace(/<!-- research-assistant:[a-z-]+:start -->[\s\S]*?<!-- research-assistant:[a-z-]+:end -->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Digest of the parts of a node or the project that a researcher approves. */
export function researchDigest(raw: string, kind: 'project' | 'asset' | 'definition'): string {
  if (kind === 'project') {
    return sha(['Main Problem', 'Current Goals', 'Required Results'].map((heading) => normalizeProse(projectSection(raw, heading))).join('\n'));
  }
  const parsed = parseMarkdown(raw);
  const data = { ...parsed.data };
  for (const key of ['status', 'title', 'used_in', 'tags']) delete data[key];
  return sha(JSON.stringify(sortKeys(data)) + '\n' + normalizeProse(parsed.content));
}

/** Digest of the statement alone; changes here invalidate dependants and freeze proofs. */
export function statementDigest(raw: string): string {
  const parsed = parseMarkdown(raw);
  const body = parsed.content.split(/^## Proof[ \t]*$/m)[0];
  const data = { ...parsed.data };
  for (const key of ['status', 'title', 'used_in', 'tags']) delete data[key];
  return sha(JSON.stringify(sortKeys(data)) + '\n' + normalizeProse(body));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  return value;
}

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
  const statement = body.split(/^## Proof[ \t]*$/m)[0].replace(/<!-- research-assistant:[a-z-]+:start -->[\s\S]*?<!-- research-assistant:[a-z-]+:end -->/g, '');
  return !statement.trim() || /Write the .* here\.|Describe the .* here\./.test(statement);
}

/** Validate one research Markdown file that an agent wrote or changed. */
export function validateResearchFile(filePath: string, raw: string, folders: ResearchFolders, paperIds: Set<string>): void {
  if (!filePath.endsWith('.md')) throw new Error(`Research file must be Markdown: ${filePath}`);
  let parsed: matter.GrayMatterFile<string>;
  try { parsed = parseMarkdown(raw); } catch (error) { throw new Error(`${filePath}: invalid YAML frontmatter (${String(error)})`); }
  const { data, content } = parsed;
  const id = path.posix.basename(filePath, '.md');
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Invalid node ID: ${id}`);
  if (typeof data.title !== 'string' || !data.title.trim()) throw new Error(`${id}: title is required.`);
  const folder = path.posix.dirname(filePath);
  if (folder === folders.assets) {
    if (!ASSET_TYPES.has(data.type)) throw new Error(`${id}: invalid asset type.`);
    if (!['draft', 'deprecated', 'archived'].includes(data.status)) throw new Error(`${id}: agent-written assets must stay draft; approval is a researcher action.`);
    if (data.status === 'draft' && statementIncomplete(content)) throw new Error(`${id}: asset statement is incomplete.`);
    if (data.source?.kind === 'paper' && (!paperIds.has(data.source.paper_id) || !data.source.location)) throw new Error(`${id}: paper source needs an indexed paper and precise location.`);
    if (data.source?.kind !== undefined && !['paper', 'self_proved', 'note'].includes(data.source.kind)) throw new Error(`${id}: source.kind must be paper or self_proved.`);
    if (data.type === 'example' && data.refutes !== undefined) {
      if (typeof data.refutes !== 'string' || !hasSection(content, 'Assumptions') || !hasSection(content, 'Calculation')) throw new Error(`${id}: counterexample needs refutes, Assumptions, and Calculation.`);
    }
  } else if (folder === folders.definitions) {
    if (data.type !== 'definition' || !['draft', 'deprecated', 'archived'].includes(data.status) || !content.trim()) throw new Error(`${id}: invalid draft definition.`);
  } else if (folder === folders.ideas) {
    if (data.type !== 'idea' || !['draft', 'archived'].includes(data.status) || !content.trim()) throw new Error(`${id}: invalid idea (type idea, status draft or archived, non-empty body).`);
  } else if (folder === folders.plans) {
    if (data.type === 'plan') {
      if (!['pending', 'failed'].includes(data.status) || typeof data.target_asset !== 'string' || !hasSection(content, 'Goal') || !hasSection(content, 'Plan') || !hasSection(content, 'Verification') || !/^\d+\. \[[ xX]\] /m.test(content)) throw new Error(`${id}: invalid proof plan (needs status pending|failed, target_asset, Goal, Plan checklist, Verification).`);
      if (data.status === 'failed' && !sectionContent(content, 'Failure')) throw new Error(`${id}: failed plan needs an obstruction under ## Failure.`);
    } else if (data.type === 'proof_record') {
      if (data.status !== undefined || typeof data.target_asset !== 'string' || !sectionContent(content, 'Outcome')) throw new Error(`${id}: invalid proof record (no status, target_asset, ## Outcome).`);
    } else throw new Error(`${id}: plan folder files must be plan or proof_record.`);
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
