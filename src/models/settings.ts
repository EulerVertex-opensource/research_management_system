/**
 * Settings shown in the dashboard's Settings view. Shared by the extension,
 * the bundled CLI, and the webview; must not import vscode or node modules.
 */

/** Kinds of approval that auto mode may grant without the researcher's click. */
export type AutoApproveRule = 'proofs' | 'supporting' | 'citations' | 'definitions' | 'counterexamples' | 'project';
export const AUTO_APPROVE_RULES: readonly AutoApproveRule[] = ['proofs', 'supporting', 'citations', 'definitions', 'counterexamples', 'project'];

export type AutoApprovePolicy = { enabled: boolean } & Record<AutoApproveRule, boolean>;

/** Local loop policy in `.research-assistant-loop/settings.json`; the agent may not write it. */
export interface LoopSettings {
  version: 1;
  autoApprove: AutoApprovePolicy;
  /** Failed plans since the researcher's last direction before the loop asks for help. */
  maxFailedPlans: number;
  /** Automatic continuations the Stop hook allows per chat session. */
  iterationCap: number;
  /** How long a question or approval popup waits before the agent continues. */
  questionTimeoutSeconds: number;
}

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
  loop?: { autoApprove?: Partial<AutoApprovePolicy>; maxFailedPlans?: number; iterationCap?: number; questionTimeoutSeconds?: number };
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
