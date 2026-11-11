import { parseMarkdown, stringifyMarkdown } from './Frontmatter';

/**
 * Git-tracked research records that replace meaning which used to live only in
 * the local `state.json`: falsification checks, researcher decisions, and
 * handoffs. Pure helpers; the core writes the files.
 */

export interface Provenance { performed_by: string; created_at: string; base_commit?: string; extension_version?: string }

/** search_request: the researcher asked for more counterexample search on an asset, `rounds` of it. */
/** `node_check`: an agent's independent check of a definition or citation before auto mode approves it; `reason` is the verdict, `digest` the node version checked. */
/**
 * `route_request`: the researcher asked for a round of routes to a result (a fork names the settled result to start from);
 * `route_drop`: the researcher dropped a route (target: its plan); `route_merge`: what merging a round of routes decided.
 */
/** `idea_update`: an idea's status, its resolution, a section added to it, or where it was tried; ideas themselves are never rewritten. */
export type DecisionKind = 'direction' | 'answer' | 'changes_requested' | 'parked' | 'unparked' | 'search_request' | 'node_check' | 'proof_check' | 'extraction_check' | 'route_request' | 'route_drop' | 'route_merge' | 'idea_update';

/** One change to an idea, applied over its file when it is read. */
export interface IdeaUpdate { status?: string; resolved_by?: string; heading?: string; text?: string; tried?: Record<string, unknown> }

export interface DecisionInfo {
  id: string;
  kind: DecisionKind;
  target: string;
  text: string;
  createdAt: string;
  performedBy?: string;
  reason?: string;
  /** direction: failed plans that the new direction supersedes. */
  failedPlansAtDirection?: string[];
  /** changes_requested: digest of the asset when the change was requested. */
  digest?: string;
  /** search_request: how many rounds were asked for. */
  rounds?: number;
  /** direction and search_request: the last object-search round before it, so later limits count only the rounds after. */
  searchRound?: number;
  /** direction and route_request: the last round of routes to the result before it, so later limits count only the rounds after. */
  routeRound?: number;
  /** route_request: the settled result a forked round starts from. */
  fork?: string;
  /** idea_update: the change to the idea (target). */
  idea?: IdeaUpdate;
  /** proof_check: the statement it was checked against, and the statements of the dependencies and definitions it read. */
  statementDigest?: string;
  dependencyDigests?: Record<string, string>;
}

export interface CheckInfo { id: string; target: string; outcome: string; statementDigest?: string; createdAt?: string; performedBy?: string }

/** `2026-09-28T12:34:56.789Z` → `20260928_123456`, a valid part of a snake_case node ID. */
export function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z?$|Z$/, '').replace('T', '_').toLowerCase();
}

export function safeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'project';
}

function clean<T extends Record<string, unknown>>(data: T): T {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T;
}

export function decisionId(kind: DecisionKind, target: string, provenance: Provenance, suffix: string): string {
  return `decision_${stamp(provenance.created_at)}_${kind}_${safeIdPart(target)}_${suffix}`;
}

export interface DecisionExtra { reason?: string; failedPlansAtDirection?: string[]; digest?: string; rounds?: number; searchRound?: number; routeRound?: number; fork?: string; idea?: IdeaUpdate; statementDigest?: string; dependencyDigests?: Record<string, string> }

export function decisionMarkdown(kind: DecisionKind, target: string, text: string, provenance: Provenance, extra: DecisionExtra = {}): string {
  const titles: Record<DecisionKind, string> = { direction: 'New direction', answer: 'Researcher answer', changes_requested: 'Changes requested', parked: 'Parked', unparked: 'Unparked', search_request: 'Search requested', node_check: 'Independent check', proof_check: 'Independent proof check', extraction_check: 'Extraction coverage check', route_request: 'Routes requested', route_drop: 'Route dropped', route_merge: 'Routes merged', idea_update: 'Idea updated' };
  return stringifyMarkdown(`\n${text.trim() || '(no text)'}\n`, clean({
    type: 'decision', title: `${titles[kind]}: ${target}`, kind, target, reason: extra.reason,
    failed_plans_at_direction: extra.failedPlansAtDirection, digest: extra.digest, rounds: extra.rounds, search_round: extra.searchRound, route_round: extra.routeRound, fork: extra.fork,
    statement_digest: extra.statementDigest, dependency_digests: extra.dependencyDigests, ...provenance,
  }));
}

export function parseDecision(id: string, raw: string): DecisionInfo | undefined {
  let data: Record<string, any>; let content: string;
  try { ({ data, content } = parseMarkdown(raw)); } catch { return undefined; }
  return decisionFromData(id, data, content.trim());
}

/** A decision from its fields: a decision file's frontmatter and body, or a record in a log. */
export function decisionFromData(id: string, data: Record<string, any>, text: string): DecisionInfo | undefined {
  if (data.type !== 'decision' || typeof data.kind !== 'string' || typeof data.target !== 'string') return undefined;
  return {
    id, kind: data.kind as DecisionKind, target: data.target, text,
    idea: data.idea && typeof data.idea === 'object' && !Array.isArray(data.idea) ? data.idea as IdeaUpdate : undefined, createdAt: String(data.created_at ?? ''), performedBy: data.performed_by,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    failedPlansAtDirection: Array.isArray(data.failed_plans_at_direction) ? data.failed_plans_at_direction.map(String) : undefined,
    digest: typeof data.digest === 'string' ? data.digest : undefined,
    rounds: typeof data.rounds === 'number' && Number.isInteger(data.rounds) && data.rounds > 0 ? data.rounds : undefined,
    searchRound: typeof data.search_round === 'number' && Number.isInteger(data.search_round) && data.search_round >= 0 ? data.search_round : undefined,
    routeRound: typeof data.route_round === 'number' && Number.isInteger(data.route_round) && data.route_round >= 0 ? data.route_round : undefined,
    fork: typeof data.fork === 'string' ? data.fork : undefined,
    statementDigest: typeof data.statement_digest === 'string' ? data.statement_digest : undefined,
    dependencyDigests: data.dependency_digests && typeof data.dependency_digests === 'object' && !Array.isArray(data.dependency_digests)
      ? Object.fromEntries(Object.entries(data.dependency_digests as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined,
  };
}

export function sortDecisions(decisions: DecisionInfo[]): DecisionInfo[] {
  return [...decisions].sort((a, b) => a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt));
}

/** Assets parked by an explicit decision that no later unpark or direction lifted. */
export function deriveParked(decisions: DecisionInfo[]): Record<string, { reason: string; at: string; note?: string }> {
  const parked: Record<string, { reason: string; at: string; note?: string }> = {};
  for (const decision of sortDecisions(decisions)) {
    if (decision.kind === 'parked') parked[decision.target] = { reason: decision.reason ?? 'parked', at: decision.createdAt, note: decision.text && decision.text !== '(no text)' ? decision.text : undefined };
    else if (decision.kind === 'unparked' || decision.kind === 'direction') delete parked[decision.target];
  }
  return parked;
}

/** The latest change request per asset that still applies: the asset has not changed since it was requested. */
export function deriveChangesRequested(decisions: DecisionInfo[], currentDigest: (target: string) => string | undefined): Record<string, string> {
  const latest = new Map<string, DecisionInfo>();
  for (const decision of sortDecisions(decisions)) if (decision.kind === 'changes_requested') latest.set(decision.target, decision);
  const result: Record<string, string> = {};
  for (const [target, decision] of latest) if (!decision.digest || decision.digest === currentDigest(target)) result[target] = decision.text;
  return result;
}

export function latestDirection(decisions: DecisionInfo[], target: string): DecisionInfo | undefined {
  return sortDecisions(decisions).filter((decision) => decision.kind === 'direction' && decision.target === target).pop();
}

/** Failed plans for an asset that the latest researcher direction has not already answered. */
export function failuresSinceDirection(failedPlans: string[], decisions: DecisionInfo[], target: string): string[] {
  const seen = new Set(latestDirection(decisions, target)?.failedPlansAtDirection ?? []);
  return failedPlans.filter((id) => !seen.has(id));
}

export function parseCheck(id: string, raw: string): CheckInfo | undefined {
  let data: Record<string, any>;
  try { data = parseMarkdown(raw).data; } catch { return undefined; }
  if (data.type !== 'falsification_check' || typeof data.target_asset !== 'string') return undefined;
  return { id, target: data.target_asset, outcome: String(data.outcome ?? ''), statementDigest: data.statement_digest, createdAt: data.created_at, performedBy: data.performed_by };
}

/** Add the loop-owned fields to an agent-written check: which statement it checked, by whom, on which commit. */
export function stampCheck(raw: string, statement: string, provenance: Provenance): string {
  const parsed = parseMarkdown(raw);
  return stringifyMarkdown(parsed.content, clean({ ...parsed.data, statement_digest: statement, ...provenance }));
}

/** Add loop-owned fields to an agent-written search record (candidate or round): where it sits in the search, which statement, by whom. */
export function stampSearchRecord(raw: string, fields: Record<string, unknown>, statement: string, provenance: Provenance): string {
  const parsed = parseMarkdown(raw);
  return stringifyMarkdown(parsed.content, clean({ ...parsed.data, ...fields, statement_digest: statement, ...provenance }));
}

export function checkMarkdown(target: string, outcome: 'no_counterexample_found' | 'counterexample_rejected', cases: string, limitations: string, statement: string, provenance: Provenance): string {
  return stringifyMarkdown(`\n## Cases checked\n\n${cases.trim()}\n\n## Limitations\n\n${limitations.trim()}\n`, clean({
    type: 'falsification_check', title: `Falsification check: ${target}`, target_asset: target, outcome, statement_digest: statement, ...provenance,
  }));
}

export interface HandoffInput {
  provenance: Provenance;
  stage?: string;
  workingOn: string[];
  completed: string[];
  pending: string[];
  next: string;
  note?: string;
}

export function handoffMarkdown(input: HandoffInput): string {
  const list = (items: string[], empty: string) => items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`;
  const body = [
    '', '## Completed', '', list(input.completed, 'Nothing new since the last handoff.'),
    '', '## Pending', '', list(input.pending, 'Nothing is waiting.'),
    '', '## Suggested next action', '', input.next.trim() || 'Run the research loop: next.',
    ...(input.note?.trim() ? ['', '## Note', '', input.note.trim()] : []), '',
  ].join('\n');
  return stringifyMarkdown(body, clean({ type: 'handoff', title: `Research handoff from ${input.provenance.performed_by}`, loop_stage: input.stage, working_on: input.workingOn, ...input.provenance }));
}

export function parseHandoff(raw: string): { performedBy?: string; createdAt?: string; workingOn: string[] } | undefined {
  let data: Record<string, any>;
  try { data = parseMarkdown(raw).data; } catch { return undefined; }
  if (data.type !== 'handoff') return undefined;
  return { performedBy: data.performed_by, createdAt: data.created_at, workingOn: Array.isArray(data.working_on) ? data.working_on.map(String) : [] };
}

// ---------- the record log ----------

/**
 * Bookkeeping records (decisions, handoffs, idea updates) live in append-only JSON-lines logs, one
 * per collaborator, month, and machine (`<user>__<YYYY-MM>__<machine>.jsonl`): each file has a single
 * writer, so collaborators' logs never conflict, and a project keeps a handful of files instead of
 * one per record. Readers merge every log and sort by time.
 */
export const LOG_EXTENSION = '.jsonl';

export function logFileName(identity: string, createdAt: string, machine: string): string {
  return `${safeIdPart(identity)}__${createdAt.slice(0, 7)}__${machine}${LOG_EXTENSION}`;
}

export function parseLog(text: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const record = JSON.parse(line); if (record && typeof record === 'object' && typeof record.type === 'string' && typeof record.id === 'string') records.push(record); } catch { /* a torn line: skipped */ }
  }
  return records;
}

export function logLine(record: Record<string, unknown>): string { return JSON.stringify(clean(record)); }

export function decisionRecord(id: string, kind: DecisionKind, target: string, text: string, provenance: Provenance, extra: DecisionExtra = {}): Record<string, unknown> {
  return clean({
    type: 'decision', id, kind, target, text: text.trim() || '(no text)', reason: extra.reason,
    failed_plans_at_direction: extra.failedPlansAtDirection, digest: extra.digest, rounds: extra.rounds, search_round: extra.searchRound, route_round: extra.routeRound, fork: extra.fork, idea: extra.idea,
    statement_digest: extra.statementDigest, dependency_digests: extra.dependencyDigests, ...provenance,
  });
}

export function decisionFromRecord(record: Record<string, any>): DecisionInfo | undefined {
  return decisionFromData(String(record.id), record, String(record.text ?? ''));
}

export interface HandoffInfo { id: string; performedBy?: string; createdAt?: string; workingOn: string[] }

export function handoffRecord(id: string, input: HandoffInput): Record<string, unknown> {
  // The handoff as the researcher reads it travels with the record (`research-loop handoff --latest` prints it).
  return clean({ type: 'handoff', id, loop_stage: input.stage, working_on: input.workingOn, completed: input.completed, pending: input.pending, next: input.next, note: input.note, markdown: handoffMarkdown(input), ...input.provenance });
}

export function handoffFromRecord(record: Record<string, any>): HandoffInfo | undefined {
  if (record.type !== 'handoff') return undefined;
  return { id: String(record.id), performedBy: record.performed_by, createdAt: record.created_at, workingOn: Array.isArray(record.working_on) ? record.working_on.map(String) : [] };
}

/** An idea as its updates leave it: status and resolution set, sections appended, tries recorded. */
export function applyIdeaUpdates(data: Record<string, any>, content: string, updates: IdeaUpdate[]): { data: Record<string, any>; content: string } {
  const next = { ...data };
  let body = content;
  for (const update of updates) {
    if (update.status) next.status = update.status;
    if (update.resolved_by) next.resolved_by = update.resolved_by;
    if (update.tried) next.tried_in = [...(Array.isArray(next.tried_in) ? next.tried_in : []), update.tried];
    if (update.heading && update.text) {
      const heading = `## ${update.heading}`;
      body = new RegExp(`^${heading}[ \\t]*$`, 'm').test(body)
        ? body.replace(new RegExp(`(^${heading}[ \\t]*\\r?\\n[\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'), (section) => `${section.trimEnd()}\n${update.text}\n\n`)
        : `${body.trimEnd()}\n\n${heading}\n\n${update.text}\n`;
    }
  }
  return { data: next, content: body };
}

/** The idea updates in a set of decisions, per idea, oldest first. */
export function ideaUpdatesOf(decisions: DecisionInfo[]): Map<string, IdeaUpdate[]> {
  const updates = new Map<string, IdeaUpdate[]>();
  for (const decision of sortDecisions(decisions)) if (decision.kind === 'idea_update' && decision.idea) updates.set(decision.target, [...(updates.get(decision.target) ?? []), decision.idea]);
  return updates;
}

/** An idea file's text with its updates applied. */
export function overlayIdea(raw: string, updates: IdeaUpdate[] | undefined): string {
  if (!updates?.length) return raw;
  let parsed: { data: Record<string, any>; content: string };
  try { parsed = parseMarkdown(raw); } catch { return raw; }
  const { data, content } = applyIdeaUpdates(parsed.data, parsed.content, updates);
  return stringifyMarkdown(content, data);
}
