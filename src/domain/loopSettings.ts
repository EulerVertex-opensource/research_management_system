import { AUTO_APPROVE_RULES, AutoApprovePolicy, LoopSettings, SettingsErrors, SettingsPatch } from '../models/settings';

/**
 * Pure defaults, normalization, and validation for the Settings view and the
 * local loop policy file. Shared by the extension, the CLI, and the webview.
 */

export const DEFAULT_AUTO_APPROVE: AutoApprovePolicy = {
  enabled: false, proofs: true, supporting: true, citations: true, definitions: true, counterexamples: false, project: false,
};

export const DEFAULT_LOOP_SETTINGS: LoopSettings = {
  version: 1, autoApprove: DEFAULT_AUTO_APPROVE, maxFailedPlans: 3, iterationCap: 10, questionTimeoutSeconds: 240,
};

export const LIMITS = {
  maxFailedPlans: [1, 10],
  iterationCap: [1, 100],
  questionTimeoutSeconds: [10, 600],
  autoPullIntervalMinutes: [0, 1440],
  contextBudget: [500, 200_000],
} as const satisfies Record<string, readonly [number, number]>;

const clampInt = (value: unknown, [min, max]: readonly [number, number], fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/**
 * Read the loop policy leniently, but fail closed: a missing or malformed
 * autoApprove block means auto mode is off.
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
  return {
    settings: {
      version: 1,
      autoApprove,
      maxFailedPlans: clampInt(input.maxFailedPlans, LIMITS.maxFailedPlans, DEFAULT_LOOP_SETTINGS.maxFailedPlans),
      iterationCap: clampInt(input.iterationCap, LIMITS.iterationCap, DEFAULT_LOOP_SETTINGS.iterationCap),
      questionTimeoutSeconds: clampInt(input.questionTimeoutSeconds, LIMITS.questionTimeoutSeconds, DEFAULT_LOOP_SETTINGS.questionTimeoutSeconds),
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
  return normalizeLoopSettings({ ...settings, ...patch, autoApprove: { ...settings.autoApprove, ...patch.autoApprove } }).settings;
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
    intIn('loop.maxFailedPlans', patch.loop.maxFailedPlans, LIMITS.maxFailedPlans);
    intIn('loop.iterationCap', patch.loop.iterationCap, LIMITS.iterationCap);
    intIn('loop.questionTimeoutSeconds', patch.loop.questionTimeoutSeconds, LIMITS.questionTimeoutSeconds);
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
