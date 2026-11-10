import { AUTO_APPROVE_RULES, AutoApprovePolicy, AutonomyPolicy, LOOP_NUMBER_KEYS, LoopNumberKey, LoopSettings, RIGOR_KEYS, RIGOR_OPTIONS, RigorKey, RigorPolicy, SettingsErrors, SettingsPatch } from '../models/settings';

/**
 * Pure defaults, normalization, and validation for the Settings view and the
 * local loop policy file. Shared by the extension, the CLI, and the webview.
 */

export const DEFAULT_AUTO_APPROVE: AutoApprovePolicy = {
  enabled: false, proofs: true, supporting: true, citations: true, definitions: true, conjectures: true, conjectureIdeas: true, counterexamples: false, specifications: false, routes: false, project: false,
};

/** What autonomous mode approves: every rule, each still judged from the file itself. */
export const AUTONOMOUS_AUTO_APPROVE: AutoApprovePolicy = { enabled: true, ...Object.fromEntries(AUTO_APPROVE_RULES.map((rule) => [rule, true])) } as AutoApprovePolicy;
export const DEFAULT_AUTONOMY: AutonomyPolicy = { enabled: false };

/**
 * Where each rigor policy appears in the Settings view: `checks` under "How thorough" (what the loop
 * verifies before building on a result), `away` under "How involved are you" (what happens when the
 * researcher does not respond), `routes` under "Parallel routes" (how a main result's routes are
 * planned). A Record so a new policy without a place does not compile. Presets cover the checks only.
 */
export const RIGOR_GROUP: Record<RigorKey, 'checks' | 'away' | 'routes'> = {
  refuteSearch: 'checks', verifyProofs: 'checks', agreeDefinitions: 'checks', onDependencyChange: 'checks', verifyExtracted: 'checks',
  missingDefinitions: 'away', whenStuck: 'away', unansweredQuestions: 'away',
  reviewRoutes: 'routes', lemmaRoutes: 'routes',
};
export const CHECK_KEYS = RIGOR_KEYS.filter((key) => RIGOR_GROUP[key] === 'checks');
export const AWAY_KEYS = RIGOR_KEYS.filter((key) => RIGOR_GROUP[key] === 'away');
export const ROUTE_KEYS = RIGOR_KEYS.filter((key) => RIGOR_GROUP[key] === 'routes');
type CheckPolicy = Pick<RigorPolicy, 'refuteSearch' | 'verifyProofs' | 'agreeDefinitions' | 'onDependencyChange' | 'verifyExtracted'>;

/** How thorough: Careful is the default; Fast trades checks for progress. Presets cover the checks only. */
export const RIGOR_PRESETS: Record<'careful' | 'fast', CheckPolicy> = {
  careful: { refuteSearch: 'all', verifyProofs: 'agent', agreeDefinitions: 'main', onDependencyChange: 'revert', verifyExtracted: 'agent' },
  fast: { refuteSearch: 'main', verifyProofs: 'off', agreeDefinitions: 'off', onDependencyChange: 'flag', verifyExtracted: 'off' },
};
export const DEFAULT_RIGOR: RigorPolicy = { ...RIGOR_PRESETS.careful, missingDefinitions: 'wait', whenStuck: 'park', unansweredQuestions: 'wait', reviewRoutes: 'main', lemmaRoutes: 'off' };

/** The preset a policy's checks match, or `custom`. */
export function rigorPreset(policy: RigorPolicy): 'careful' | 'fast' | 'custom' {
  for (const name of ['careful', 'fast'] as const) if (CHECK_KEYS.every((key) => RIGOR_PRESETS[name][key as keyof CheckPolicy] === policy[key])) return name;
  return 'custom';
}

/**
 * How involved the researcher is: one choice in the Settings view over the two switches the
 * settings file stores. `routine` is auto-approval by the rules; `alone` is autonomous mode.
 */
export type Involvement = 'review' | 'routine' | 'alone';
type InvolvementSwitches = Pick<LoopSettings, 'autoApprove' | 'autonomy'>;

export function involvement(settings: InvolvementSwitches): Involvement {
  return settings.autonomy.enabled ? 'alone' : settings.autoApprove.enabled ? 'routine' : 'review';
}

/** The switches for a level; the rule checkboxes are kept, so returning to `routine` restores them. */
export function withInvolvement<T extends InvolvementSwitches>(settings: T, level: Involvement): T {
  const enabled = level === 'review' ? false : level === 'routine' ? true : settings.autoApprove.enabled;
  return { ...settings, autoApprove: { ...settings.autoApprove, enabled }, autonomy: { enabled: level === 'alone' } };
}

export interface RigorField { label: string; hint: string; options: Record<string, string> }

/** Every "How careful" setting, in display order, with the words for each choice. */
export const RIGOR_FIELDS: { [K in RigorKey]: RigorField & { options: Record<(typeof RIGOR_OPTIONS)[K][number], string> } } = {
  refuteSearch: { label: 'Look for counterexamples before proving', hint: 'A search for a counterexample before each proof catches false statements early, at a cost in tokens.', options: { all: 'Every result', main: 'Main results only', off: 'Never' } },
  verifyProofs: { label: 'Check each proof', hint: 'The agent that planned a proof also writes it. An independent check catches gaps before the proof is approved. If you check them yourself, proofs are never approved automatically, whatever the level above allows.', options: { agent: 'An independent agent verifies it', researcher: 'I verify every proof myself', off: 'No separate check' } },
  agreeDefinitions: { label: 'Agree on definitions before proving', hint: 'The definitions a main result’s statement uses decide what the goal means.', options: { main: 'Main results’ definitions first', off: 'Check them at the end' } },
  verifyExtracted: { label: 'Check what is extracted', hint: 'After results and definitions are extracted from a manuscript, paper, or notes, an independent agent checks each one right away (a proof step by step, a cited result against its source, a definition for what its users need) and then looks for anything the extraction missed. You review with its verdicts; with automatic approval, what passes is approved. One check per result, so it costs tokens.', options: { agent: 'An independent agent checks them right away', off: 'No separate check' } },
  onDependencyChange: { label: 'When something a result rests on changes', hint: 'A changed definition or statement can make the proofs built on it be about something else.', options: { revert: 'Everything downstream back to review', flag: 'Mark it for re-check' } },
  missingDefinitions: { label: 'When a definition is used but missing', hint: 'The agent drafts it in either case; it never accepts it for you.', options: { wait: 'Draft it, then wait for me', continue: 'Draft it and go on' } },
  whenStuck: { label: 'When a result is stuck and you give no direction', hint: 'After the failed-attempt limit, or when a construction search runs out.', options: { park: 'Set it aside', retry: 'Agent tries one new approach itself' } },
  reviewRoutes: { label: 'Review route maps', hint: 'Before the routes to a main result are worked on, you see them side by side, with the lemmas they share, and approve, drop, or add routes. Off: the loop starts on them at once.', options: { main: 'Before working on them', off: 'Don’t ask me' } },
  lemmaRoutes: { label: 'When a lemma in a route is stuck', hint: 'A lemma normally gets one proof attempt after another. On: once its attempts run out, the loop first plans several routes to it before asking you.', options: { off: 'Ask me', on: 'Try several routes first' } },
  unansweredQuestions: { label: 'When a question goes unanswered', hint: 'After the question timeout.', options: { wait: 'The loop waits for me', default: 'The agent goes on with its default' } },
};

/** Where a numeric loop setting appears in the Settings view. */
export type LoopFieldGroup = 'general' | 'away' | 'routes' | 'refute' | 'construct' | 'search' | 'autonomy' | 'teaching';
export const LOOP_FIELD_GROUPS: Record<LoopFieldGroup, string> = {
  general: 'Search & effort',
  away: 'When you don’t respond',
  routes: 'Parallel routes',
  refute: 'Object search: refute (falsify)',
  construct: 'Object search: construct',
  search: 'Object search: workers and board',
  autonomy: 'Working on its own',
  teaching: 'Keeping up with the proofs',
};

export interface LoopNumberField { defaultValue: number; range: readonly [number, number]; label: string; hint: string; unit?: string; group: LoopFieldGroup }

/**
 * Every numeric loop setting, in display order. Defaults, clamping, patch
 * validation, and the Settings view all read this table, so a setting listed
 * here is adjustable in the panel and one missing here does not compile.
 */
export const LOOP_NUMBER_FIELDS: Record<LoopNumberKey, LoopNumberField> = {
  maxFailedPlans: { defaultValue: 3, range: [1, 10], group: 'general', label: 'Proof attempts per asset', hint: 'Failed plans before the loop asks you for a new direction.' },
  iterationCap: { defaultValue: 10, range: [1, 100], group: 'general', label: 'Continuations per chat', hint: 'Times the Stop hook sends the agent on in one chat session; applies to the running loop too. When it works on its own, its budget applies instead.' },
  questionTimeoutSeconds: { defaultValue: 240, range: [10, 600], group: 'away', unit: 'seconds', label: 'Question timeout', hint: 'How long a question waits before “When a question goes unanswered” applies. Reviews never time out; they wait in Needs you.' },
  refuteWidth: { defaultValue: 1, range: [1, 8], group: 'refute', label: 'Workers per round', hint: 'Parallel subagents searching for a counterexample, each in its own direction.' },
  refuteRounds: { defaultValue: 1, range: [1, 10], group: 'refute', label: 'Rounds', hint: 'Rounds without a counterexample before the loop moves on to planning a proof.' },
  constructWidth: { defaultValue: 3, range: [1, 8], group: 'construct', label: 'Workers per round', hint: 'Parallel subagents proposing constructions, each in its own direction.' },
  constructRounds: { defaultValue: 4, range: [1, 20], group: 'construct', label: 'Rounds', hint: 'Rounds since your last direction before the loop asks you.' },
  constructMaxCandidates: { defaultValue: 40, range: [1, 500], group: 'construct', label: 'Candidate limit', hint: 'Candidates since your last direction before the loop asks you.' },
  specialDirectionsFromRound: { defaultValue: 2, range: [1, 20], group: 'construct', label: 'Repair and impossibility from round', hint: 'First round that also repairs the best near-miss and tries to prove no construction exists.' },
  candidatesPerWorker: { defaultValue: 3, range: [1, 10], group: 'search', label: 'Candidates per worker', hint: 'Candidates one worker may write in a round.' },
  boardObstructions: { defaultValue: 12, range: [1, 50], group: 'search', label: 'Obstructions shown', hint: 'Latest obstructions on the search board every worker reads.' },
  boardNearMisses: { defaultValue: 3, range: [0, 10], group: 'search', label: 'Near-misses shown', hint: 'Best failed candidates on the search board, with their checks.' },
  requestedSearchRounds: { defaultValue: 2, range: [1, 10], group: 'search', label: 'Rounds for a requested search', hint: 'Default rounds when you ask for a deeper counterexample search.' },
  autonomyBudget: { defaultValue: 30, range: [1, 1000], group: 'autonomy', unit: 'attempts', label: 'Budget', hint: 'Proof attempts and search rounds the agent may spend on its own before it hands the loop back to you.' },
  autonomyHours: { defaultValue: 0, range: [0, 168], group: 'autonomy', unit: 'hours', label: 'Time limit', hint: 'Hands the loop back after this long even with budget left; 0 means no time limit.' },
  autonomyRevisions: { defaultValue: 2, range: [0, 10], group: 'autonomy', label: 'Goal reassessments', hint: 'Times the agent may judge what the goals still need when only set-aside results remain: it brings back a set-aside result that something new gets past, or adds a weaker or alternative goal of its own. Each one after the first needs something proved or set aside since the last. It never drops your goals; you decide about them at hand-back.' },
  autonomyConjectures: { defaultValue: 0, range: [0, 20], group: 'autonomy', label: 'Conjectures to explore', hint: 'Conjectures the agent may take up as goals of its own, best first, once your goals are proved or nothing else is left that it can do. 0 means it never explores; it still recommends them at hand-back. Taking up a conjecture that gets past a set-aside result counts as a goal reassessment instead.' },
  routeWidth: { defaultValue: 3, range: [0, 8], group: 'routes', label: 'Routes per round', hint: 'Routes planned side by side for a main result, each in its own direction (yours first, when you have some). 0: one proof attempt after another, as before.' },
  maxLiveRoutes: { defaultValue: 3, range: [1, 8], group: 'routes', label: 'Routes worked on at once', hint: 'Routes to one result kept going together; the most promising ones go first, the rest wait until one fails.' },
  routeRounds: { defaultValue: 2, range: [1, 10], group: 'routes', label: 'Rounds of routes', hint: 'Rounds of new routes for one result, once every route so far failed, before the loop asks you for a direction.' },
  studyAhead: { defaultValue: 0, range: [0, 50], group: 'teaching', unit: 'results', label: 'How far the loop may get ahead of you', hint: 'Verified results you have not studied yet (with the teach skill, or marked in Results) before the loop waits for you instead of starting new proofs. 0 means it never waits; working on its own ignores this.' },
};

const loopNumberDefaults = Object.fromEntries(LOOP_NUMBER_KEYS.map((key) => [key, LOOP_NUMBER_FIELDS[key].defaultValue])) as Record<LoopNumberKey, number>;

export const DEFAULT_LOOP_SETTINGS: LoopSettings = { version: 1, autoApprove: DEFAULT_AUTO_APPROVE, rigor: DEFAULT_RIGOR, autonomy: DEFAULT_AUTONOMY, ...loopNumberDefaults };

export const LIMITS = {
  autoPullIntervalMinutes: [0, 1440],
  contextBudget: [500, 200_000],
} as const satisfies Record<string, readonly [number, number]>;

const clampInt = (value: unknown, [min, max]: readonly [number, number], fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/**
 * Read the loop policy leniently, but fail closed: a missing or malformed
 * autoApprove or autonomy block means auto mode or autonomous mode is off.
 */
export function normalizeLoopSettings(raw: unknown): { settings: LoopSettings; problems: string[] } {
  const problems: string[] = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (raw !== undefined && input !== raw) problems.push('Loop settings are not a JSON object; using defaults.');
  const auto = input.autoApprove;
  let autoApprove: AutoApprovePolicy = { ...DEFAULT_AUTO_APPROVE };
  if (auto !== undefined) {
    const valid = auto && typeof auto === 'object' && !Array.isArray(auto)
      && ['enabled', ...AUTO_APPROVE_RULES].every((key) => (auto as Record<string, unknown>)[key] === undefined || typeof (auto as Record<string, unknown>)[key] === 'boolean');
    if (valid) autoApprove = { ...DEFAULT_AUTO_APPROVE, ...(auto as Partial<AutoApprovePolicy>) };
    else problems.push('autoApprove is malformed; auto mode is off.');
  }
  const autonomyInput = input.autonomy;
  let autonomy: AutonomyPolicy = { ...DEFAULT_AUTONOMY };
  if (autonomyInput !== undefined) {
    const enabled = autonomyInput && typeof autonomyInput === 'object' && !Array.isArray(autonomyInput) ? (autonomyInput as Record<string, unknown>).enabled : undefined;
    if (enabled === undefined || typeof enabled === 'boolean') autonomy = { enabled: enabled === true };
    else problems.push('autonomy is malformed; autonomous mode is off.');
  }
  const rigorInput = input.rigor && typeof input.rigor === 'object' && !Array.isArray(input.rigor) ? input.rigor as Record<string, unknown> : {};
  if (input.rigor !== undefined && rigorInput !== input.rigor) problems.push('rigor is malformed; using the careful defaults.');
  // A check added later is missing from older settings: it follows the preset the other checks still match (Fast stays Fast).
  const fastBefore = CHECK_KEYS.every((key) => rigorInput[key] === undefined ? key === 'verifyExtracted' : rigorInput[key] === RIGOR_PRESETS.fast[key as keyof CheckPolicy]);
  const fallback = (key: RigorKey) => (key === 'verifyExtracted' && fastBefore ? RIGOR_PRESETS.fast.verifyExtracted : DEFAULT_RIGOR[key]);
  const rigor = Object.fromEntries(RIGOR_KEYS.map((key) => {
    const value = rigorInput[key];
    if (value === undefined) return [key, fallback(key)];
    if ((RIGOR_OPTIONS[key] as readonly unknown[]).includes(value)) return [key, value];
    problems.push(`rigor.${key} is not one of ${RIGOR_OPTIONS[key].join(', ')}; using ${DEFAULT_RIGOR[key]}.`);
    return [key, DEFAULT_RIGOR[key]];
  })) as RigorPolicy;
  return {
    settings: {
      version: 1,
      autoApprove,
      rigor,
      autonomy,
      ...Object.fromEntries(LOOP_NUMBER_KEYS.map((key) => [key, clampInt(input[key], LOOP_NUMBER_FIELDS[key].range, LOOP_NUMBER_FIELDS[key].defaultValue)])) as Record<LoopNumberKey, number>,
    },
    problems,
  };
}

/** Parse the settings file text; unreadable JSON falls back to defaults (auto mode off). */
export function parseLoopSettings(text: string | undefined): { settings: LoopSettings; problems: string[] } {
  if (!text?.trim()) return normalizeLoopSettings(undefined);
  try { return normalizeLoopSettings(JSON.parse(text)); } catch { return { settings: normalizeLoopSettings(undefined).settings, problems: ['Loop settings file is not valid JSON; using defaults with auto mode off.'] }; }
}

export function applyLoopPatch(settings: LoopSettings, patch: SettingsPatch['loop']): LoopSettings {
  if (!patch) return settings;
  return normalizeLoopSettings({ ...settings, ...patch, autoApprove: { ...settings.autoApprove, ...patch.autoApprove }, rigor: { ...settings.rigor, ...patch.rigor }, autonomy: { ...settings.autonomy, ...patch.autonomy } }).settings;
}

/** Git remote and branch names go into git arguments: no options, no ranges, no shell characters. */
const GIT_NAME = /^[A-Za-z0-9._/-]+$/;
function gitNameProblem(value: string): string | undefined {
  if (!GIT_NAME.test(value)) return 'Use letters, digits, ".", "_", "/", and "-" only.';
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.includes('..') || value.endsWith('.lock')) return 'Not a valid git name.';
  return undefined;
}

/** Check a patch before anything is written; the webview runs the same check for inline errors. */
export function validateSettingsPatch(patch: SettingsPatch, budgetStages: readonly string[]): SettingsErrors {
  const errors: SettingsErrors = {};
  const intIn = (key: string, value: unknown, [min, max]: readonly [number, number]) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors[key] = `Enter a whole number from ${min} to ${max}.`;
  };
  const oneOf = (key: string, value: unknown, allowed: readonly string[]) => {
    if (value !== undefined && !allowed.includes(value as string)) errors[key] = `Choose one of: ${allowed.join(', ')}.`;
  };
  const bool = (key: string, value: unknown) => { if (value !== undefined && typeof value !== 'boolean') errors[key] = 'Expected on or off.'; };

  if (patch.agent) {
    oneOf('agent.provider', patch.agent.provider, ['auto', 'claude', 'codex']);
    bool('agent.useDefaultOnStart', patch.agent.useDefaultOnStart);
  }
  if (patch.loop) {
    for (const key of ['enabled', ...AUTO_APPROVE_RULES] as const) bool(`loop.autoApprove.${key}`, patch.loop.autoApprove?.[key]);
    bool('loop.autonomy.enabled', patch.loop.autonomy?.enabled);
    for (const key of LOOP_NUMBER_KEYS) intIn(`loop.${key}`, patch.loop[key], LOOP_NUMBER_FIELDS[key].range);
    for (const key of RIGOR_KEYS) oneOf(`loop.rigor.${key}`, patch.loop.rigor?.[key], RIGOR_OPTIONS[key]);
  }
  if (patch.sync) {
    const sync = patch.sync;
    oneOf('sync.autoPull', sync.autoPull, ['pull', 'notify', 'off']);
    intIn('sync.autoPullIntervalMinutes', sync.autoPullIntervalMinutes, LIMITS.autoPullIntervalMinutes);
    oneOf('sync.strategy', sync.strategy, ['rebase', 'merge']);
    bool('sync.signCommits', sync.signCommits);
    for (const key of ['remote', 'overleafBranch'] as const) {
      const value = sync[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim()) { errors[`sync.${key}`] = 'Required.'; continue; }
      const problem = gitNameProblem(value.trim());
      if (problem) errors[`sync.${key}`] = problem;
    }
    for (const key of ['branch', 'overleafRemote'] as const) {
      const value = sync[key];
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue;
      const problem = typeof value === 'string' ? gitNameProblem(value.trim()) : 'Expected text.';
      if (problem) errors[`sync.${key}`] = problem;
    }
    for (const key of ['identity', 'latexCommand'] as const) {
      const value = sync[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) errors[`sync.${key}`] = 'Use a single line.';
    }
  }
  if (patch.contextBudgets) {
    for (const [stage, value] of Object.entries(patch.contextBudgets)) {
      if (!budgetStages.includes(stage)) { errors[`contextBudgets.${stage}`] = 'Unknown stage.'; continue; }
      if (value !== null) intIn(`contextBudgets.${stage}`, value, LIMITS.contextBudget);
    }
  }
  return errors;
}
