/**
 * Settings shown in the dashboard's Settings view. Shared by the extension,
 * the bundled CLI, and the webview; must not import vscode or node modules.
 */

/** Kinds of approval that auto mode may grant without the researcher's click. */
/**
 * `conjectures` agrees on a conjecture's statement (so it may be stated in the paper);
 * `conjectureIdeas` is not an approval but a permission: when nothing else is actionable, the agent
 * turns conjecture ideas into conjectures and searches them for counterexamples on its own.
 */
export type AutoApproveRule = 'proofs' | 'supporting' | 'citations' | 'definitions' | 'conjectures' | 'conjectureIdeas' | 'counterexamples' | 'specifications' | 'project';
export const AUTO_APPROVE_RULES: readonly AutoApproveRule[] = ['proofs', 'supporting', 'citations', 'definitions', 'conjectures', 'conjectureIdeas', 'counterexamples', 'specifications', 'project'];

export type AutoApprovePolicy = { enabled: boolean } & Record<AutoApproveRule, boolean>;

/**
 * Numeric loop settings. Each one has exactly one entry in LOOP_NUMBER_FIELDS
 * (src/domain/loopSettings.ts), which drives defaults, clamping, validation,
 * and the Settings view, so every one is adjustable there.
 */
export const LOOP_NUMBER_KEYS = [
  'maxFailedPlans', 'iterationCap', 'questionTimeoutSeconds',
  'refuteWidth', 'refuteRounds',
  'constructWidth', 'constructRounds', 'constructMaxCandidates', 'specialDirectionsFromRound',
  'candidatesPerWorker', 'boardObstructions', 'boardNearMisses', 'requestedSearchRounds',
  'autonomyBudget', 'autonomyHours', 'autonomyRevisions', 'autonomyConjectures',
  'studyAhead',
] as const;
export type LoopNumberKey = typeof LOOP_NUMBER_KEYS[number];

/** Local loop policy in `.research-assistant-loop/settings.json`; the agent may not write it. */
/**
 * How careful the loop is: the policies that trade rigor for speed. Each key
 * has one entry in RIGOR_FIELDS (src/domain/loopSettings.ts), which drives
 * defaults, validation, presets, and the Settings view.
 */
export const RIGOR_OPTIONS = {
  /** Counterexample search before a proof: every result, main results only, or none. */
  refuteSearch: ['all', 'main', 'off'],
  /** A proof the loop wrote: an independent agent verifies it before approval, the researcher verifies every one (never approved automatically), or neither. */
  verifyProofs: ['agent', 'researcher', 'off'],
  /** The definitions main results use must be agreed before any proof work, or are checked at the end. */
  agreeDefinitions: ['main', 'off'],
  /** When a statement or definition a result rests on changes: send everything downstream back to review, or mark it for re-check. */
  onDependencyChange: ['revert', 'flag'],
  /** Results and definitions just extracted from a manuscript, paper, or notes: an independent agent checks them right away (research-loop check), or nobody does before the researcher. */
  verifyExtracted: ['agent', 'off'],
  /** A definition used but missing: the agent drafts it, then waits for the researcher or goes on with the draft. */
  missingDefinitions: ['wait', 'continue'],
  /** A result stuck with no direction from the researcher: set it aside, or let the agent try one new approach itself. */
  whenStuck: ['park', 'retry'],
  /** A question nobody answers: the loop waits, or the agent goes on with its stated default after the timeout. */
  unansweredQuestions: ['wait', 'default'],
} as const;
export type RigorKey = keyof typeof RIGOR_OPTIONS;
export const RIGOR_KEYS = Object.keys(RIGOR_OPTIONS) as RigorKey[];
export type RigorPolicy = { [K in RigorKey]: (typeof RIGOR_OPTIONS)[K][number] };

/**
 * Autonomous mode: the agent never asks the researcher, decides every question
 * itself, spends `autonomyBudget` attempts (and at most `autonomyHours`), then
 * hands the loop back. It applies every auto-approve rule while it is on.
 */
export interface AutonomyPolicy { enabled: boolean }

export type LoopSettings = { version: 1; autoApprove: AutoApprovePolicy; rigor: RigorPolicy; autonomy: AutonomyPolicy } & Record<LoopNumberKey, number>;

export type ProviderSetting = 'auto' | 'claude' | 'codex';
export type AutoPullMode = 'pull' | 'notify' | 'off';

export interface SettingsPayload {
  agent: { provider: ProviderSetting; useDefaultOnStart: boolean; installed: { claude: boolean; codex: boolean } };
  loop: LoopSettings & { file: string; problems: string[]; queued: number };
  sync: {
    autoPull: AutoPullMode;
    autoPullIntervalMinutes: number;
    remote: string;
    branch?: string;
    overleafRemote?: string;
    overleafBranch: string;
    strategy: 'rebase' | 'merge';
    signCommits: boolean;
    identity?: string;
    latexCommand?: string;
    /** Shown as placeholders: what applies when a field is left empty. */
    defaults: { latexCommand: string; identity?: string };
  };
  contextBudgets: { values: Record<string, number>; defaults: Record<string, number> };
  recentAutoApprovals: Array<{ at: string; kind: string; target: string }>;
}

/** A partial update; `null` clears an optional field (or resets a budget to its default). */
export interface SettingsPatch {
  agent?: { provider?: ProviderSetting; useDefaultOnStart?: boolean };
  loop?: { autoApprove?: Partial<AutoApprovePolicy>; rigor?: Partial<RigorPolicy>; autonomy?: Partial<AutonomyPolicy> } & Partial<Record<LoopNumberKey, number>>;
  sync?: {
    autoPull?: AutoPullMode;
    autoPullIntervalMinutes?: number;
    remote?: string;
    branch?: string | null;
    overleafRemote?: string | null;
    overleafBranch?: string;
    strategy?: 'rebase' | 'merge';
    signCommits?: boolean;
    identity?: string | null;
    latexCommand?: string | null;
  };
  contextBudgets?: Record<string, number | null>;
}

/** Validation errors keyed by field path, e.g. `loop.maxFailedPlans`; `''` holds a general error. */
export type SettingsErrors = Record<string, string>;
