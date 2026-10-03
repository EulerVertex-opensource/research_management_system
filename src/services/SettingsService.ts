import * as vscode from 'vscode';
import { ProjectConfigService } from './ProjectConfigService';
import { LoopHost } from './LoopHost';
import { AGENT_PROVIDERS } from './AgentProviders';
import { DEFAULT_CONTEXT_BUDGETS } from './ResearchContext';
import { defaultLatexCommand, normalizeSyncConfig } from './ProjectPathsCore';
import { applyLoopPatch, validateSettingsPatch } from '../domain/loopSettings';
import { AutoPullMode, ProviderSetting, SettingsErrors, SettingsPatch, SettingsPayload } from '../models/settings';
import { LOOP_SETTINGS_PATH } from './ResearchLoopModel';

const BUDGET_STAGES = Object.keys(DEFAULT_CONTEXT_BUDGETS);
/** Sync fields stored in the shared .research-assistant.json; the others are VS Code settings on this machine. */
const SHARED_SYNC_KEYS = ['remote', 'branch', 'overleafRemote', 'overleafBranch', 'strategy', 'signCommits', 'identity', 'latexCommand'] as const;

/**
 * The dashboard's Settings view: gathers settings from their three homes (VS
 * Code settings, the shared project config, the local loop policy) and writes a patch back.
 */
export class SettingsService {
  constructor(private readonly config: ProjectConfigService, private readonly loopHost: LoopHost) {}

  async payload(): Promise<SettingsPayload> {
    const vs = vscode.workspace.getConfiguration('researchAssistant');
    const project = await this.config.loadOrDiscover();
    const sync = normalizeSyncConfig(project.sync);
    const { settings, problems } = await this.loopHost.loopSettings();
    const { queued, recentAuto } = await this.loopHost.approvalSummary();
    const installed = (id: 'claude' | 'codex') => Boolean(vscode.extensions.getExtension(AGENT_PROVIDERS[id].extensionId));
    return {
      agent: { provider: vs.get<ProviderSetting>('loop.provider', 'auto'), useDefaultOnStart: vs.get<boolean>('loop.useDefaultAgentOnStart', false), installed: { claude: installed('claude'), codex: installed('codex') } },
      loop: { ...settings, file: LOOP_SETTINGS_PATH, problems, queued },
      sync: {
        autoPull: vs.get<AutoPullMode>('sync.autoPull', 'pull'),
        autoPullIntervalMinutes: vs.get<number>('sync.autoPullIntervalMinutes', 5),
        remote: sync.remote, branch: sync.branch, overleafRemote: sync.overleafRemote, overleafBranch: sync.overleafBranch,
        strategy: sync.strategy, signCommits: sync.signCommits, identity: sync.identity, latexCommand: sync.latexCommand,
        defaults: { latexCommand: defaultLatexCommand(project.latex), identity: await this.loopHost.gitIdentity() },
      },
      contextBudgets: { values: project.contextBudgets ?? {}, defaults: { ...DEFAULT_CONTEXT_BUDGETS } },
      recentAutoApprovals: recentAuto,
    };
  }

  /** Validate the whole patch first; write nothing when any field is invalid. Returns the errors (empty on success). */
  async update(patch: SettingsPatch): Promise<SettingsErrors> {
    const errors = validateSettingsPatch(patch, BUDGET_STAGES);
    if (Object.keys(errors).length) return errors;

    const shared = SHARED_SYNC_KEYS.filter((key) => patch.sync?.[key] !== undefined);
    if (shared.length || patch.contextBudgets) {
      if (!(await this.config.hasSavedConfig())) return { '': 'Initialize the project first: shared settings live in .research-assistant.json.' };
      const project = await this.config.loadOrDiscover();
      if (shared.length) {
        const next: Record<string, unknown> = { ...project.sync };
        for (const key of shared) {
          const value = patch.sync![key];
          next[key] = typeof value === 'string' ? value.trim() || undefined : value ?? undefined;
        }
        project.sync = normalizeSyncConfig(next);
      }
      if (patch.contextBudgets) {
        const budgets: Record<string, number> = { ...project.contextBudgets };
        for (const [stage, value] of Object.entries(patch.contextBudgets)) {
          if (value === null) delete budgets[stage];
          else budgets[stage] = value;
        }
        project.contextBudgets = Object.keys(budgets).length ? budgets : undefined;
      }
      await this.config.save(project);
    }

    if (patch.loop) await this.loopHost.saveLoopSettings(applyLoopPatch((await this.loopHost.loopSettings()).settings, patch.loop));

    const vs = vscode.workspace.getConfiguration('researchAssistant');
    const updates: Array<[string, unknown]> = [
      ['loop.provider', patch.agent?.provider], ['loop.useDefaultAgentOnStart', patch.agent?.useDefaultOnStart],
      ['sync.autoPull', patch.sync?.autoPull], ['sync.autoPullIntervalMinutes', patch.sync?.autoPullIntervalMinutes],
    ];
    for (const [key, value] of updates) {
      if (value === undefined) continue;
      // Personal settings go to the user scope, unless this workspace already overrides them.
      const target = vs.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vs.update(key, value, target);
    }
    return {};
  }
}
