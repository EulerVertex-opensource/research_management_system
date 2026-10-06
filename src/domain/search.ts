import { hasSection, sectionContent } from './sections';

/**
 * Object search: rounds of workers that each propose candidate objects in an
 * assigned direction and check them property by property. Refute mode looks
 * for a counterexample (every hypothesis holds, the conclusion fails);
 * construct mode looks for an object with every property a construction's
 * specification lists. Workers share memory only through the search board the
 * loop compiles from these records. Pure; shared by the core, CLI, and tests.
 */

export type SearchMode = 'refute' | 'construct';
export const SEARCH_MODES: readonly SearchMode[] = ['refute', 'construct'];
export type Verdict = 'pass' | 'fail' | 'unknown';
const VERDICTS: readonly string[] = ['pass', 'fail', 'unknown'];
/** failed and survived are the worker's verdict; archived means independent verification rejected a survivor. */
export const CANDIDATE_STATUSES = ['failed', 'survived', 'archived'] as const;
export type CandidateStatus = typeof CANDIDATE_STATUSES[number];
/**
 * How a property was checked. Only written reasoning today; a custom verifier
 * (code, a prover) is added here and read through `candidateVerifier`.
 */
export const VERIFIERS = ['reasoning'] as const;
/** The property a refute candidate must satisfy last: the negation of the conclusion. */
export const NEGATED_CONCLUSION = 'NOT';
const PROPERTY_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface Direction { id: string; label: string; modes: SearchMode[]; special?: 'repair' | 'nonexistence' }

/** Directions the loop assigns to worker slots, in order; a researcher's test-case ideas come first. */
export const DIRECTIONS: readonly Direction[] = [
  { id: 'boundary_degenerate', modes: ['refute'], label: 'Boundary and degenerate cases: empty, zero, trivial, and equality cases of every hypothesis.' },
  { id: 'small_cases', modes: ['refute'], label: 'Smallest instances: go through the small sizes, dimensions, or values one by one.' },
  { id: 'drop_hypothesis', modes: ['refute'], label: 'Each hypothesis at its edge: objects that barely satisfy one hypothesis, to see whether the conclusion still needs it.' },
  { id: 'known_counterexamples', modes: ['refute'], label: 'Known pathological objects and counterexamples to related statements (library search, cited papers).' },
  { id: 'extremal', modes: ['refute'], label: 'Extremal and asymptotic objects: limits, very large or unbalanced parameters, extremal configurations.' },
  { id: 'adapt_known', modes: ['construct'], label: 'Adapt a known construction (library search, cited papers) that has most of the properties.' },
  { id: 'symmetric_algebraic', modes: ['construct'], label: 'Symmetric or algebraic families: groups, quotients, polynomial or explicit formulas with parameters to tune.' },
  { id: 'products_limits', modes: ['construct'], label: 'Combine simpler objects: products, sums, gluing, limits, or iterating a step.' },
  { id: 'small_case_search', modes: ['construct'], label: 'Smallest cases first: find the object for small parameters by hand, then look for the pattern.' },
  { id: 'repair_near_miss', modes: ['construct'], special: 'repair', label: 'Repair the best near-miss on the board: change it so the property it failed holds, keeping the others.' },
  { id: 'nonexistence', modes: ['construct'], special: 'nonexistence', label: 'Try to prove no such object exists, starting from the obstructions on the board. Record what you find as an idea; write no candidate.' },
];

export interface SearchSlot { slot: number; direction: string; label: string; candidateId?: string }

export interface SearchNode { id: string; file: string; data: Record<string, any>; body: string }

export interface CandidateInfo {
  id: string; file: string; target: string; status: string; checks: Record<string, Verdict>;
  mode?: SearchMode; round?: number; slot?: number; direction?: string; statementDigest?: string; createdAt?: string;
  object: string; failure: string;
}

export interface RoundInfo {
  id: string; file: string; target: string; mode?: SearchMode; round?: number; statementDigest?: string; createdAt?: string;
  directions: string[]; candidates: string[]; obstructions: string[]; limitations: string;
}

const positiveInt = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The verdict map as written; unknown values are dropped (validation reports them). */
export function candidateChecks(data: Record<string, any>): Record<string, Verdict> {
  const raw = data.checks && typeof data.checks === 'object' && !Array.isArray(data.checks) ? data.checks as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'string' && VERDICTS.includes(value))) as Record<string, Verdict>;
}

/** The verifier a candidate's checks used; the single place a new verifier kind is recognised. */
export function candidateVerifier(data: Record<string, any>): string { return typeof data.verifier === 'string' ? data.verifier : 'reasoning'; }

export function parseCandidate(node: SearchNode): CandidateInfo | undefined {
  const { data, body } = node;
  if (data.type !== 'candidate' || typeof data.target_asset !== 'string') return undefined;
  return {
    id: node.id, file: node.file, target: data.target_asset, status: String(data.status ?? ''), checks: candidateChecks(data),
    mode: SEARCH_MODES.includes(data.mode) ? data.mode : undefined, round: positiveInt(data.round), slot: positiveInt(data.slot),
    direction: typeof data.direction === 'string' ? data.direction : undefined,
    statementDigest: typeof data.statement_digest === 'string' ? data.statement_digest : undefined,
    createdAt: typeof data.created_at === 'string' ? data.created_at : undefined,
    object: sectionContent(body, 'Object'), failure: oneLine(sectionContent(body, 'Failure')),
  };
}

/** Bullet lines of a section; a lone "none" counts as empty. */
function bullets(body: string, heading: string): string[] {
  return sectionContent(body, heading).split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter((line) => line && !/^none\.?$/i.test(line));
}

export function parseRound(node: SearchNode): RoundInfo | undefined {
  const { data, body } = node;
  if (data.type !== 'search_round' || typeof data.target_asset !== 'string') return undefined;
  return {
    id: node.id, file: node.file, target: data.target_asset, mode: SEARCH_MODES.includes(data.mode) ? data.mode : undefined, round: positiveInt(data.round),
    statementDigest: typeof data.statement_digest === 'string' ? data.statement_digest : undefined, createdAt: typeof data.created_at === 'string' ? data.created_at : undefined,
    directions: strings(data.directions), candidates: strings(data.candidates), obstructions: bullets(body, 'Obstructions'), limitations: sectionContent(body, 'Limitations'),
  };
}

/** Rules for a candidate file; `committed` also accepts the archived status the loop sets. */
export function candidateProblems(id: string, data: Record<string, any>, body: string, options: { committed?: boolean } = {}): string[] {
  const problems: string[] = [];
  const fields = 'type candidate, title, status failed|survived, target_asset, checks {property: pass|fail|unknown}, ## Object, ## Checks, ## Failure when failed';
  if (data.type !== 'candidate' || typeof data.title !== 'string' || !data.title.trim() || typeof data.target_asset !== 'string') return [`${id}: invalid candidate (${fields}).`];
  const statuses: readonly string[] = options.committed ? CANDIDATE_STATUSES : ['failed', 'survived'];
  if (!statuses.includes(data.status)) problems.push(`${id}: candidate status must be ${statuses.join(' or ')}.`);
  const raw = data.checks && typeof data.checks === 'object' && !Array.isArray(data.checks) ? data.checks as Record<string, unknown> : undefined;
  if (!raw || !Object.keys(raw).length) problems.push(`${id}: checks must map each property to pass, fail, or unknown.`);
  else for (const [key, value] of Object.entries(raw)) {
    if (!PROPERTY_ID.test(key)) problems.push(`${id}: check name ${key} must be a plain identifier such as H1, P2, or NOT.`);
    if (typeof value !== 'string' || !VERDICTS.includes(value)) problems.push(`${id}: check ${key} must be pass, fail, or unknown.`);
  }
  if (!(VERIFIERS as readonly string[]).includes(candidateVerifier(data))) problems.push(`${id}: unknown verifier ${candidateVerifier(data)}; available: ${VERIFIERS.join(', ')}.`);
  if (data.mode !== undefined && !SEARCH_MODES.includes(data.mode)) problems.push(`${id}: mode must be refute or construct.`);
  for (const key of ['round', 'slot']) if (data[key] !== undefined && positiveInt(data[key]) === undefined) problems.push(`${id}: ${key} must be a positive whole number.`);
  if (!sectionContent(body, 'Object')) problems.push(`${id}: candidate needs ## Object describing the object precisely.`);
  if (!hasSection(body, 'Checks')) problems.push(`${id}: candidate needs ## Checks with one ### subsection per property.`);
  const verdicts = Object.values(candidateChecks(data));
  if (data.status === 'failed' && (!verdicts.includes('fail') || !sectionContent(body, 'Failure'))) problems.push(`${id}: a failed candidate needs a failing check and ## Failure naming it.`);
  if (data.status === 'survived' && (!verdicts.length || verdicts.some((verdict) => verdict !== 'pass'))) problems.push(`${id}: a survived candidate must pass every check.`);
  return problems;
}

export function roundProblems(id: string, data: Record<string, any>, body: string): string[] {
  if (typeof data.title !== 'string' || !data.title.trim() || typeof data.target_asset !== 'string' || !hasSection(body, 'Obstructions') || !hasSection(body, 'Limitations')) {
    return [`${id}: invalid search round (type search_round, title, target_asset, ## Obstructions, ## Limitations).`];
  }
  return [];
}

/** Text of each `### <property>` under `## Checks`. */
export function checkSections(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const checks = sectionContent(body, 'Checks');
  for (const part of checks.split(/^### /m).slice(1)) {
    const [heading, ...rest] = part.split('\n');
    const name = heading.trim().split(/[\s:—-]/)[0];
    if (name) result[name] = rest.join('\n').trim();
  }
  return result;
}

/** Property IDs a construction's specification lists, as `- P1: ...` (or `- **P1**`, `- (P1)`). */
export function specProperties(statement: string): string[] {
  const ids: string[] = [];
  for (const match of statement.matchAll(/^\s*[-*]\s+(?:\*\*|\()?(P\d+)(?:\*\*|\))?\s*[:.—-]/gm)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

export interface SearchProgress {
  /** Highest round with records for the current statement; 0 before the first. */
  lastRound: number;
  candidates: CandidateInfo[];
  rounds: RoundInfo[];
  survivors: CandidateInfo[];
  /** Failed and rejected candidates, most checks passed first. */
  nearMisses: CandidateInfo[];
  /** Obstructions from round records, oldest first. */
  obstructions: string[];
  directionsTried: string[];
  limitations: string;
}

/**
 * What the shared records say about the search on one statement; records for an older statement are ignored.
 * `afterRound` keeps only later rounds (those since a direction or a search request), counted by round number, not by clock.
 */
export function searchProgress(target: string, digest: string, candidates: CandidateInfo[], rounds: RoundInfo[], afterRound = 0): SearchProgress {
  const fresh = (record: { target: string; statementDigest?: string; round?: number }) => record.target === target && record.statementDigest === digest && (record.round ?? 0) > afterRound;
  const current = candidates.filter(fresh).sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id));
  const records = rounds.filter(fresh).sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id));
  const lastRound = Math.max(0, ...current.map((item) => item.round ?? 0), ...records.map((item) => item.round ?? 0));
  const passes = (item: CandidateInfo) => Object.values(item.checks).filter((verdict) => verdict === 'pass').length;
  const nearMisses = current.filter((item) => item.status !== 'survived').sort((a, b) => passes(b) - passes(a) || (b.round ?? 0) - (a.round ?? 0) || a.id.localeCompare(b.id));
  const directionsTried = [...new Set([...records.flatMap((item) => item.directions), ...current.map((item) => item.direction).filter((item): item is string => Boolean(item))])];
  return {
    lastRound, candidates: current, rounds: records, survivors: current.filter((item) => item.status === 'survived'), nearMisses,
    obstructions: records.flatMap((item) => item.obstructions), directionsTried, limitations: records.at(-1)?.limitations ?? '',
  };
}

export interface DirectionOptions {
  mode: SearchMode; round: number; width: number; tried: string[];
  /** The researcher's open test-case ideas for the asset; each becomes a direction before the catalog. */
  ideas: Array<{ id: string; title: string }>;
  specialFromRound: number;
  nearMiss?: string;
}

/** Deterministic slot assignment: special directions, then untried ideas, then untried catalog directions, then the catalog again. */
export function assignDirections(options: DirectionOptions): SearchSlot[] {
  const { mode, round, width, tried, ideas } = options;
  const picked: Array<Omit<SearchSlot, 'slot'>> = [];
  const catalog = DIRECTIONS.filter((direction) => direction.modes.includes(mode));
  if (round >= options.specialFromRound) {
    for (const direction of catalog.filter((item) => item.special)) {
      if (direction.special === 'repair' && !options.nearMiss) continue;
      picked.push({ direction: direction.id, label: direction.label, ...(direction.special === 'repair' ? { candidateId: options.nearMiss } : {}) });
    }
  }
  for (const idea of ideas) if (!tried.includes(idea.id)) picked.push({ direction: idea.id, label: `The researcher's test case (idea ${idea.id}): ${oneLine(idea.title)}` });
  const regular = catalog.filter((item) => !item.special);
  for (const direction of regular) if (!tried.includes(direction.id)) picked.push({ direction: direction.id, label: direction.label });
  for (let index = 0; picked.length < width && regular.length; index++) {
    const direction = regular[index % regular.length];
    picked.push({ direction: direction.id, label: `${direction.label} Tried before: take a different route than the board shows.` });
  }
  return picked.slice(0, width).map((slot, index) => ({ slot: index + 1, ...slot }));
}

const checkRow = (candidate: CandidateInfo) => Object.entries(candidate.checks).map(([name, verdict]) => `${name} ${verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '?'}`).join(' ');

export interface BoardOptions { mode: SearchMode; target: string; round: number; obstructions: number; nearMisses: number; properties?: string[] }

/** The shared memory every worker of a round reads; its size is set only by the board settings. */
export function renderBoard(progress: SearchProgress, options: BoardOptions): string {
  const goal = options.mode === 'refute'
    ? `Find an object that satisfies every hypothesis of ${options.target} (checks H1, H2, …, one per hypothesis) and violates its conclusion (check ${NEGATED_CONCLUSION}).`
    : `Find an object with every property of the specification of ${options.target}${options.properties?.length ? ` (checks ${options.properties.join(', ')})` : ''}.`;
  const obstructions = progress.obstructions.slice(-options.obstructions);
  const nearMisses = progress.nearMisses.slice(0, options.nearMisses);
  const lines = [
    `## Search board: ${options.mode} search for ${options.target}, round ${options.round}`, '', goal, '',
    `### Obstructions${progress.obstructions.length > obstructions.length ? ` (latest ${obstructions.length} of ${progress.obstructions.length})` : ''}`, '',
    ...(obstructions.length ? obstructions.map((item) => `- ${item}`) : ['- none yet']), '',
    '### Near-misses', '',
    ...(nearMisses.length ? nearMisses.map((item) => `- ${item.id}${item.direction ? ` (${item.direction})` : ''}: ${checkRow(item)}${item.status === 'archived' ? ' — rejected by independent verification' : ''}${item.failure ? ` — ${item.failure}` : ''}`) : ['- none yet']), '',
    '### Directions tried', '', progress.directionsTried.length ? progress.directionsTried.join(', ') : 'none yet',
  ];
  if (progress.limitations) lines.push('', '### Limitations of the last round', '', progress.limitations);
  lines.push('', `${progress.candidates.length} candidate(s) in ${progress.lastRound} round(s) so far.`);
  return lines.join('\n');
}

/** One line per candidate of a round, for the summary stage. */
export function roundDigest(candidates: CandidateInfo[]): string {
  return candidates.length
    ? candidates.map((item) => `- ${item.id}${item.direction ? ` (${item.direction})` : ''}, ${item.status}: ${checkRow(item)}${item.failure ? ` — ${item.failure}` : ''}`).join('\n')
    : '- no candidates this round';
}
