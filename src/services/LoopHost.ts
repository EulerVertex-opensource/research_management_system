import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { FileService } from './FileService';
import { ProjectPaths } from '../models/types';
import { ResearchLoopCore } from './ResearchLoopCore';
import { AGENT_PROVIDERS, PROVIDER_IDS, allChatHints, chatHint, invocation } from './AgentProviders';
import { AGENT_PATH, AgentProvider, ApprovalKind, BRIDGE_PATH, EXTENSION_ID, BRIDGE_REGISTRY, BridgeEntry, LOOP_SETTINGS_PATH, LoopState, QuestionKind, STATE_PATH } from './ResearchLoopModel';
import { readAgentActivity } from './AgentActivity';
import { LoopSettings } from '../models/settings';
import { normalizeLoopSettings } from '../domain/loopSettings';
import { readLoopSettings, writeLoopSettings } from './LoopSettingsStore';
import { LoopGit } from './LoopGit';
import { AutoPullMode, PrepareResult, PublishResult, PullResult, ResearchSync, autoPullDecision, syncNowAction } from './ResearchSync';
import { SyncBadge, SyncNotice } from '../models/sync';
import { NodeGitRunner, runShell } from '../cli/nodeGit';
import { loadSyncConfig } from '../cli/nodeFiles';
import { toIdeaKind } from '../domain/nodeKinds';
import { findNodeFile, locateNodeFile } from '../domain/registry';
import { ResearchNode } from '../models/types';
import { GraphAction, GraphPayload, LoopHealth } from '../models/graph';
import { collectGraphPayload } from './GraphViewModel';
import { computeLoopHealth, HealthNode } from '../domain/loopHealth';
import { isTimelineEvent } from '../domain/history';
import { requiredAssetIds } from '../domain/project';
import { acceptLabel, approvalTitle } from '../domain/copy';
import { isCited } from '../domain/schema';
import { bindingPath, loadImpactNodes, loadProjectRevision, readSectionBriefFile, sectionTexPath } from './ManuscriptImpactLoader';
import { parseWritingOutline } from './ManuscriptWriting';
import { lockBinding } from '../domain/manuscriptImpact';
import { Teaching } from './Teaching';
import { LEVEL_HINT, LEVEL_LABEL, TEACH_PROMPT_PATTERN, UNDERSTANDING_LEVELS, UNDERSTANDING_PATH, UnderstandingLevel, teachPrompt, toLevel } from '../domain/understandingLevels';
import { WRITE_PROMPT_PATTERN } from '../domain/chatRoles';

function extensionVersion(): string | undefined {
  return vscode.extensions.all.find((extension) => extension.id.toLowerCase() === EXTENSION_ID)?.packageJSON?.version;
}

type ToolResult = Record<string, unknown>;

/** Longest a single bridge call may block; stays under Codex's default MCP tool timeout. */
export const MAX_SLICE_SECONDS = 45;
function sliceSeconds(value: unknown): number { return typeof value === 'number' && value > 0 ? Math.min(value, MAX_SLICE_SECONDS) : MAX_SLICE_SECONDS; }

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('researchAssistant').get<T>(`loop.${key}`, fallback);
}

function syncSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('researchAssistant').get<T>(`sync.${key}`, fallback);
}

/** workspaceState key: sha256 of the loop settings this extension last wrote. */
const SETTINGS_HASH_KEY = 'researchAssistant.loopSettingsHash';
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Refocusing the window re-checks the remote at most this often. */
const AUTO_SYNC_MIN_GAP_MS = 60_000;
/** How often the loop's health is re-derived, so an agent that went quiet shows up without any file change. */
const HEALTH_CHECK_MS = 60_000;
const HEALTH_ICON: Record<LoopHealth['key'], string> = {
  idle: '$(beaker)', goals: '$(bell)', working: '$(sync~spin)', needs_you: '$(bell)', set_aside: '$(warning)', stopped: '$(error)', stalled: '$(debug-disconnect)', agent_idle: '$(debug-disconnect)', paused: '$(debug-pause)', done: '$(check)',
};

/**
 * Extension-side home of the research loop: the shared core over the workspace
 * files, the localhost bridge that the MCP script calls, the popups a
 * researcher answers, the status-bar item, and the command handlers.
 */
export class LoopHost implements vscode.Disposable {
  private core: ResearchLoopCore | undefined;
  private paths: ProjectPaths | undefined;
  private server: http.Server | undefined;
  private token = crypto.randomBytes(24).toString('hex');
  private readonly statusBar: vscode.StatusBarItem;
  private watcher: vscode.FileSystemWatcher | undefined;
  private settingsWatcher: vscode.FileSystemWatcher | undefined;
  private agentWatcher: vscode.FileSystemWatcher | undefined;
  private understandingWatcher: vscode.FileSystemWatcher | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  private readonly interactions = new Map<string, Promise<ToolResult>>();
  private readonly git: LoopGit;
  /** Answers given in the dashboard for a question or approval whose popup is still open. */
  private readonly dashboardAnswers = new Map<string, (outcome: { decision: string; text: string }) => void>();
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when the loop state or an approval changes, so the dashboard can refresh its Graph tab. */
  readonly onDidChangeState = this.stateChanged.event;
  private readonly settingsChanged = new vscode.EventEmitter<void>();
  /** Fires when the local loop settings file changes, so an open Settings view can refresh. */
  readonly onDidChangeSettings = this.settingsChanged.event;
  private readonly synced = new vscode.EventEmitter<void>();
  /** Fires after a pull, publish, or dashboard sync finished (or failed), so the Sync button can refresh. */
  readonly onDidSync = this.synced.event;
  private syncNowRunning = false;
  private autoSyncTimer: ReturnType<typeof setInterval> | undefined;
  private autoSyncRunning = false;
  private lastAutoSync = 0;
  /** Remote commit already announced, so the same upstream state is not announced twice. */
  private announcedUpstream: string | undefined;
  private reportedFetchError: string | undefined;
  /** Remote commits not pulled automatically; shown in the dashboard's Needs you list. */
  private pendingUpstream: { ref: string; behind: number; reason: string } | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private lastHealthKey: string | undefined;
  /** Signature of the last situation announced by a popup, so each one is announced once. */
  private alerted: string | undefined;
  private nodeSource: (() => ResearchNode[]) | undefined;
  /** Guards the health check against re-entering while it resolves an overdue question. */
  private resolving = false;
  /** Questions whose popup is still open, so the health check neither shows a second one nor resolves them behind it. */
  private readonly openQuestions = new Set<string>();
  private openOverviewHandler: (() => Promise<void>) | undefined;
  private showNodeHandler: ((id: string) => Promise<void>) | undefined;

  constructor(private readonly files: FileService, private readonly output: vscode.OutputChannel, private readonly memento?: vscode.Memento) {
    this.git = new LoopGit(new NodeGitRunner(files.rootUri.fsPath));
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = 'research-assistant.openOverview';
    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => { void this.onEditorSave(document); }));
    // Coming back from the Overleaf browser tab is the moment its edits matter.
    this.subscriptions.push(vscode.window.onDidChangeWindowState((state) => { if (state.focused) void this.autoSync(false); }));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('researchAssistant.sync')) this.scheduleAutoSync(); }));
  }

  configure(paths: ProjectPaths): void {
    const first = !this.core;
    this.paths = paths;
    if (this.core) this.core.setPaths(paths);
    else this.core = new ResearchLoopCore(this.files, paths, { git: this.git, extensionVersion: extensionVersion() });
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, STATE_PATH));
    const refresh = () => { void this.refreshStatusBar(); this.stateChanged.fire(); };
    this.watcher.onDidChange(refresh); this.watcher.onDidCreate(refresh); this.watcher.onDidDelete(refresh);
    this.settingsWatcher?.dispose();
    this.settingsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, LOOP_SETTINGS_PATH));
    const settingsRefresh = () => { void this.guardLoopSettings().then(() => { this.settingsChanged.fire(); this.stateChanged.fire(); }); };
    this.settingsWatcher.onDidChange(settingsRefresh); this.settingsWatcher.onDidCreate(settingsRefresh); this.settingsWatcher.onDidDelete(settingsRefresh);
    // The agent writes this on its tool calls: redraw only when the health it implies changes.
    this.agentWatcher?.dispose();
    this.agentWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, AGENT_PATH));
    const agentRefresh = () => { void this.refreshStatusBar(); };
    this.agentWatcher.onDidChange(agentRefresh); this.agentWatcher.onDidCreate(agentRefresh); this.agentWatcher.onDidDelete(agentRefresh);
    // The researcher's marks, from a popup, the dashboard, or their terminal.
    this.understandingWatcher?.dispose();
    this.understandingWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, UNDERSTANDING_PATH));
    this.understandingWatcher.onDidChange(refresh); this.understandingWatcher.onDidCreate(refresh); this.understandingWatcher.onDidDelete(refresh);
    if (first) void this.migrateLoopSettings().then(() => this.guardLoopSettings());
    void this.startBridge();
    void this.refreshStatusBar();
    if (first) { this.scheduleAutoSync(); void this.autoSync(true); }
    if (!this.healthTimer) this.healthTimer = setInterval(() => { void this.refreshStatusBar(); }, HEALTH_CHECK_MS);
  }

  /** Where node titles come from (the dashboard's node index), for the status bar and popups. */
  setNodeSource(source: () => ResearchNode[]): void { this.nodeSource = source; }

  /** How to show one node's page in the dashboard; set by the dashboard. */
  setNodeHandler(handler: (id: string) => Promise<void>): void { this.showNodeHandler = handler; }

  /** How to show the Overview; set by the dashboard. */
  setOverviewHandler(handler: () => Promise<void>): void { this.openOverviewHandler = handler; }

  private async openOverview(): Promise<void> {
    if (this.openOverviewHandler) await this.openOverviewHandler();
    else await vscode.commands.executeCommand('research-assistant.openOverview');
  }

  dispose(): void {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.watcher?.dispose();
    this.settingsWatcher?.dispose();
    this.agentWatcher?.dispose();
    this.understandingWatcher?.dispose();
    this.settingsChanged.dispose();
    this.synced.dispose();
    this.statusBar.dispose();
    this.stateChanged.dispose();
    this.subscriptions.forEach((item) => item.dispose());
    this.server?.close();
    void vscode.workspace.fs.delete(this.files.resolve(BRIDGE_PATH)).then(undefined, () => undefined);
    void this.updateRegistry(undefined);
  }

  // ---------- loop settings ----------

  async loopSettings(): Promise<{ settings: LoopSettings; problems: string[] }> {
    return readLoopSettings(this.files);
  }

  /** Write the researcher's loop settings and apply what changed to the running loop. */
  async saveLoopSettings(next: LoopSettings): Promise<void> {
    const previous = (await readLoopSettings(this.files)).settings;
    const text = await writeLoopSettings(this.files, next);
    await this.memento?.update(SETTINGS_HASH_KEY, sha256(text));
    if (!this.core) return;
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof LoopSettings])));
    if (!Object.keys(changed).length) return;
    const granted = await this.withCore(async (core) => {
      if (!core.current) return [] as string[];
      await core.event('settings_changed', { changed });
      if (next.iterationCap !== previous.iterationCap) await core.setIterationCap(next.iterationCap);
      return next.autoApprove.enabled || next.autonomy.enabled ? core.autoApproveQueued() : [];
    });
    if (granted.length) this.output.appendLine(`[loop] Approved ${granted.length} waiting item(s) automatically: ${granted.map((item) => item.split(':')[1]).join(', ')}`);
  }

  /** Requests waiting for the researcher, and the latest approvals auto mode granted; for the Settings view. */
  async approvalSummary(): Promise<{ queued: number; recentAuto: Array<{ at: string; kind: string; target: string }> }> {
    if (!this.core) return { queued: 0, recentAuto: [] };
    let state: LoopState | undefined;
    try { state = await this.core.peek(); } catch { state = undefined; }
    const recentAuto = (await this.core.recentEvents(1000)).filter((event) => event.type === 'auto_approved').slice(-10).reverse()
      .map((event) => ({ at: String(event.at ?? ''), kind: String(event.kind ?? ''), target: String(event.target ?? '') }));
    return { queued: state?.approvalQueue.length ?? 0, recentAuto };
  }

  async gitIdentity(): Promise<string | undefined> { return this.git.userEmail(); }

  /** Seed the settings file once from the VS Code settings it replaces. */
  private async migrateLoopSettings(): Promise<void> {
    if ((await readLoopSettings(this.files)).exists) return;
    const config = vscode.workspace.getConfiguration('researchAssistant');
    const legacy = (key: string) => { const value = config.inspect<number>(`loop.${key}`); return value?.workspaceValue ?? value?.globalValue; };
    const settings = normalizeLoopSettings({ iterationCap: legacy('iterationCap'), questionTimeoutSeconds: legacy('questionTimeoutSeconds') }).settings;
    const text = await writeLoopSettings(this.files, settings);
    await this.memento?.update(SETTINGS_HASH_KEY, sha256(text));
    this.output.appendLine('[loop] Created .research-assistant-loop/settings.json from the VS Code settings.');
  }

  /**
   * Auto mode and autonomous mode are turned on only from the dashboard. If the file was changed by
   * something else (an agent bypassing the hook, say) and now enables either, turn it off.
   */
  private async guardLoopSettings(): Promise<void> {
    if (!this.memento) return;
    const text = await this.files.readFile(LOOP_SETTINGS_PATH).catch(() => undefined);
    if (text === undefined || sha256(text) === this.memento.get<string>(SETTINGS_HASH_KEY)) return;
    const { settings } = await readLoopSettings(this.files);
    if (!settings.autoApprove.enabled && !settings.autonomy.enabled) return;
    const repaired = { ...settings, autoApprove: { ...settings.autoApprove, enabled: false }, autonomy: { enabled: false } };
    const written = await writeLoopSettings(this.files, repaired);
    await this.memento.update(SETTINGS_HASH_KEY, sha256(written));
    this.output.appendLine('[loop] Automatic approval was enabled outside the dashboard; turned it off.');
    if (this.core?.current) await this.core.event('auto_mode_reset').catch(() => undefined);
  }

  /** Keep `~/.research-assistant/bridges.json` current so a globally registered MCP server (Codex) can find this project. */
  private async updateRegistry(entry: BridgeEntry | undefined): Promise<void> {
    const file = path.join(os.homedir(), ...BRIDGE_REGISTRY);
    try {
      let entries: BridgeEntry[] = [];
      try { entries = JSON.parse(await fs.readFile(file, 'utf8')); } catch { entries = []; }
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      entries = entries.filter((item) => item && item.root !== this.files.rootUri.fsPath && alive(item.pid));
      if (entry) entries.push(entry);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    } catch (error: unknown) { this.output.appendLine(`[loop] Bridge registry: ${String(error)}`); }
  }

  /** Serialize operations: the CLI also writes state.json, so reload before every action. */
  private async withCore<T>(action: (core: ResearchLoopCore) => Promise<T>): Promise<T> {
    if (!this.core) throw new Error('Initialize the Research Assistant project first.');
    const core = this.core;
    const run = this.busy.then(async () => { await core.load(); return action(core); });
    this.busy = run.catch(() => undefined);
    const result = await run;
    void this.refreshStatusBar();
    this.stateChanged.fire();
    return result;
  }

  // ---------- approvals recorded from the dashboard, editor, and watchers ----------

  async recordApprovalIfHuman(id: string, source: string): Promise<void> {
    if (!this.paths) return;
    const kind = (await findNodeFile(this.files, this.paths, 'definition', id)) ? 'definition' : 'asset';
    const recorded = await this.withCore((core) => core.recordExisting(kind, id, source)).catch(() => false);
    if (recorded) this.output.appendLine(`[loop] Recorded ${source} approval of ${id}`);
  }

  /** Remarks the researcher writes, edits, archives, or restores in the dashboard: theirs, from outside the chats. */
  async addRemark(input: { target: string; title: string; body: string; anchor?: string }): Promise<string> {
    return (await this.withCore((core) => core.addRemark({ ...input, origin: 'researcher', from: 'other' }))).id;
  }
  async editRemark(id: string, changes: { title?: string; body?: string; anchor?: string }): Promise<void> {
    await this.withCore((core) => core.editRemark(id, changes, 'other'));
  }
  async archiveRemark(id: string, archived: boolean): Promise<void> {
    await this.withCore((core) => archived ? core.archiveRemark(id, 'other') : core.restoreRemark(id, 'other'));
  }

  /** The researcher clicked "Mark as checked" on an agent's remark in the dashboard. */
  async checkRemark(id: string): Promise<void> {
    await this.withCore((core) => core.checkRemark(id, 'dashboard'));
  }

  /** The researcher clicked "Approve for the paper" on a remark in the dashboard. */
  async approveRemark(id: string): Promise<void> {
    await this.withCore((core) => core.approveRemark(id, 'dashboard'));
    this.output.appendLine(`[loop] Recorded dashboard approval of remark ${id} for the paper`);
  }

  async reconcile(id: string): Promise<void> {
    const reverted = await this.withCore((core) => core.reconcile(id)).catch(() => [] as string[]);
    if (reverted.length) {
      this.output.appendLine(`[loop] Approval invalidated by edits: ${reverted.join(', ')}`);
    }
  }

  private async onEditorSave(document: vscode.TextDocument): Promise<void> {
    if (!this.paths || vscode.window.activeTextEditor?.document !== document) return;
    const relative = path.relative(this.files.rootUri.fsPath, document.uri.fsPath).split(path.sep).join('/');
    if (!relative.endsWith('.md')) return;
    if (!locateNodeFile(relative, this.paths)) return;
    let status: unknown;
    try { status = parseMarkdown(document.getText()).data.status; } catch { return; }
    if (status === 'approved') await this.recordApprovalIfHuman(path.posix.basename(relative, '.md'), 'editor');
  }

  // ---------- bridge ----------

  private async startBridge(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => { void this.handleRequest(request, response); });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await this.files.writeFile(BRIDGE_PATH, JSON.stringify({ port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n');
    await this.updateRegistry({ root: this.files.rootUri.fsPath, port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() });
    this.output.appendLine(`[loop] Bridge listening on 127.0.0.1:${port}`);
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/tool') return reply(404, { error: 'not found' });
    if (request.headers.authorization !== `Bearer ${this.token}`) return reply(401, { error: 'unauthorized' });
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      void (async () => {
        try {
          const { name, arguments: args } = JSON.parse(body || '{}') as { name: string; arguments: Record<string, unknown> };
          reply(200, await this.tool(name, args ?? {}));
        } catch (error: unknown) {
          reply(200, { answered: false, reason: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const total = (await readLoopSettings(this.files)).settings.questionTimeoutSeconds;
    const slice = sliceSeconds(args.wait_seconds);
    if (name === 'ask_researcher') {
      // Autonomous mode: the researcher is away, so nothing pops up and the agent decides at once.
      const alone = await this.withCore(async (core) => (await core.loopSettings()).autonomy.enabled && core.current?.status === 'running'
        ? core.decideAlone((args.kind as QuestionKind) ?? 'discussion', String(args.question ?? ''), typeof args.asset_id === 'string' ? args.asset_id : undefined) : undefined);
      if (alone !== undefined) return { status: 'final', answered: false, reason: 'autonomous', auto_action: alone };
      const question = await this.withCore((core) => core.askQuestion((args.kind as QuestionKind) ?? 'discussion', String(args.question ?? ''), { assetId: typeof args.asset_id === 'string' ? args.asset_id : undefined, options: Array.isArray(args.options) ? args.options.map(String) : undefined, timeoutSec: total }));
      this.interactions.set(question.id, this.askResearcher(question.id, question.prompt, question.kind, question.options, total));
      return this.awaitInteraction(question.id, slice);
    }
    if (name === 'request_approval') {
      const kind = args.kind as ApprovalKind; const target = String(args.target ?? ''); const summary = String(args.summary ?? '');
      const outcome = await this.withCore((core) => core.requestApproval(kind, target, summary));
      if (outcome.status !== 'queued' || !outcome.request) return { status: 'final', answered: true, decision: 'approved', auto: outcome.status === 'auto_approved', note: outcome.status === 'auto_approved' ? 'Approved automatically (auto mode, set by the researcher).' : 'Already approved; nothing to do.' };
      const request = outcome.request;
      // Autonomous mode: nobody reviews it until the loop hands back, so the agent does not wait for it.
      if ((await readLoopSettings(this.files)).settings.autonomy.enabled) return { status: 'final', answered: false, request_id: request.id, reason: 'autonomous', note: 'Queued for the researcher, who reviews it when the loop hands back; continue with other work.' };
      this.interactions.set(request.id, this.requestApproval(request.id, kind, target, summary, total));
      return this.awaitInteraction(request.id, slice);
    }
    if (name === 'await_answer') return this.awaitInteraction(String(args.id ?? ''), slice);
    if (name === 'mark_understood') {
      const id = `understand_${crypto.randomBytes(6).toString('hex')}`;
      this.interactions.set(id, this.askUnderstanding(String(args.target ?? ''), toLevel(args.suggested), typeof args.note === 'string' ? args.note : undefined));
      return this.awaitInteraction(id, slice);
    }
    if (name === 'record_idea') {
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      return this.withCore(async (core) => ({ ok: true, idea_id: await core.saveIdea(String(args.title ?? ''), String(args.body ?? ''), Array.isArray(args.related_assets) ? args.related_assets.map(String) : [], args.origin === 'researcher' ? 'researcher' : 'agent', tags, toIdeaKind(args.kind, tags)) }));
    }
    if (name === 'loop_status') return this.withCore(async (core) => ({ ok: true, state: core.statusSummary({ recentParked: 3 }), brief: core.briefStatus() }));
    if (name === 'confirm_publish') return { confirmed: await this.confirmPublish(String(args.detail ?? '')) };
    return { answered: false, reason: `unknown tool ${name}` };
  }

  /**
   * Answer within one short slice so no MCP client timeout (Codex defaults to
   * about a minute) cuts the call; the popup itself stays open for the full
   * configured timeout and the agent keeps polling with await_answer.
   */
  private async awaitInteraction(id: string, slice: number): Promise<ToolResult> {
    const pending = this.interactions.get(id);
    if (!pending) return { status: 'final', answered: false, id, reason: 'unknown id; it may already have been answered. Check loop_status.' };
    const result = await Promise.race([pending, this.timeout<ToolResult>(slice * 1000)]);
    if (result === 'timeout') return { status: 'pending', answered: false, id, note: 'The researcher has not answered yet. Call await_answer with this id to keep waiting.' };
    this.interactions.delete(id);
    return { status: 'final', id, ...result };
  }

  /** Settles when the researcher answers `id` in the dashboard instead of the popup. */
  private fromDashboard<T>(id: string): Promise<T> {
    return new Promise<T>((resolve) => {
      this.dashboardAnswers.set(id, (outcome) => { this.dashboardAnswers.delete(id); resolve(outcome as T); });
    });
  }

  private timeout<T>(ms: number): Promise<T | 'timeout'> { return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)); }

  private async askResearcher(questionId: string, prompt: string, kind: QuestionKind, options: string[] | undefined, waitSeconds: number): Promise<ToolResult> {
    const question = { id: questionId };
    const popup = Promise.race([this.showQuestion(prompt, kind, options), this.fromDashboard<{ decision: 'answer' | 'skip' | 'pause'; text: string }>(questionId)]);
    this.openQuestions.add(questionId);
    void popup.finally(() => this.openQuestions.delete(questionId));
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'answer' | 'skip' | 'pause'; text: string }>(waitSeconds * 1000)]);
    if (outcome !== 'timeout') this.dashboardAnswers.delete(questionId);
    if (outcome === 'timeout' && (await readLoopSettings(this.files)).settings.rigor.unansweredQuestions === 'wait') {
      // The researcher asked to be waited for: the question stays open and the agent stops; a late answer still lands.
      void popup.then(async (late) => {
        if (!late) return;
        if (late.decision === 'pause') { await this.pauseCommand(); return; }
        await this.withCore((core) => core.answerQuestion(question.id, late.decision === 'answer' ? 'answer' : 'skip', late.text, 'popup'));
      });
      return { answered: false, question_id: question.id, reason: 'waiting', auto_action: 'The researcher has not answered yet and asked the loop to wait for them. Stop working now; the question stays open and the loop resumes when they answer.' };
    }
    if (outcome === 'timeout') {
      await this.withCore((core) => core.autoResolveQuestion(question.id));
      void popup.then(async (late) => {
        if (!late || late.decision !== 'answer') return;
        await this.withCore((core) => core.answerQuestion(question.id, 'answer', late.text, 'popup'));
      });
      return { answered: false, question_id: question.id, reason: 'timeout', auto_action: this.autoActionText(kind) };
    }
    if (!outcome || outcome.decision === 'skip') {
      await this.withCore((core) => core.answerQuestion(question.id, 'skip', '', 'popup'));
      return { answered: false, question_id: question.id, reason: 'dismissed', auto_action: this.autoActionText(kind) };
    }
    if (outcome.decision === 'pause') {
      await this.withCore(async (core) => { await core.answerQuestion(question.id, 'skip', '', 'popup'); await core.pause('Paused by the researcher from a question popup.'); });
      return { answered: false, question_id: question.id, reason: 'paused', auto_action: 'The researcher paused the loop; stop working and wait.' };
    }
    await this.withCore((core) => core.answerQuestion(question.id, 'answer', outcome.text, 'popup'));
    return { answered: true, question_id: question.id, decision: 'answer', text: outcome.text };
  }

  /** The teaching chat asks how well the researcher now knows a result; only their pick is recorded. */
  private async askUnderstanding(target: string, suggested: UnderstandingLevel | undefined, note: string | undefined): Promise<ToolResult> {
    const teaching = this.teaching();
    const item = (await teaching.overview()).items.find((entry) => entry.id === target);
    if (!item) return { answered: false, reason: `${target} is not a verified result; only verified results are marked.` };
    const picked = await this.pickLevel(item.title, item.level, suggested ?? item.suggested, note);
    if (!picked) return { answered: false, reason: 'dismissed', note: 'The researcher did not mark it; carry on teaching.' };
    await teaching.mark(target, picked, { note, at: new Date().toISOString() });
    this.stateChanged.fire();
    return { answered: true, level: picked === 'none' ? 'none' : picked, note: picked === 'none' ? 'The researcher cleared their mark.' : `Recorded: ${LEVEL_LABEL[picked]}.` };
  }

  private async pickLevel(title: string, current: UnderstandingLevel | undefined, suggested: UnderstandingLevel, note?: string): Promise<UnderstandingLevel | 'none' | undefined> {
    const items = [
      ...[suggested, ...UNDERSTANDING_LEVELS.filter((level) => level !== suggested)].map((level) => ({ label: LEVEL_LABEL[level], description: `${LEVEL_HINT[level]}${level === current ? ' (your mark now)' : ''}`, level: level as UnderstandingLevel | 'none' })),
      ...(current ? [{ label: 'Forget my mark', description: 'Show it as new to me again.', level: 'none' as const }] : []),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: `Research Assistant · How well do you know “${title}” now?`, placeHolder: note ? `Your summary: ${note}` : 'Only you decide this; it stays on this computer.', ignoreFocusOut: true });
    return picked?.level;
  }

  /** Verified results new to the researcher or changed since they studied them; 0 when that cannot be read. */
  private async studyBehind(): Promise<number> {
    if (!this.paths) return 0;
    try { return (await this.teaching().overview()).behind; } catch { return 0; }
  }

  private teaching(): Teaching {
    if (!this.paths) throw new Error('Initialize the Research Assistant project first.');
    return new Teaching(this.files, this.paths);
  }

  /** Open the agent chat for a teaching conversation: the prompt is copied, since a new chat is the researcher's to start. */
  async teachCommand(target?: { id: string; title: string }): Promise<void> {
    await vscode.env.clipboard.writeText(teachPrompt(target));
    await this.openChat(this.core?.current?.provider);
    vscode.window.setStatusBarMessage('$(book) Teaching prompt copied: start a new chat beside the loop and paste it', 10000);
  }

  private autoActionText(kind: QuestionKind): string {
    switch (kind) {
      case 'goals': return 'No goal given. Continue only if project.md already has a Main Problem; otherwise wait.';
      case 'blocked': return 'The loop acted on the researcher’s setting: the asset is set aside, or a new approach of your own is recorded for it. Do not park it yourself; run research-loop next.';
      case 'counterexample_review': return 'No comment; the counterexample stays queued for the researcher.';
      default: return 'Proceed with the default you stated; the open question was recorded as an idea.';
    }
  }

  private async showQuestion(prompt: string, kind: QuestionKind, options?: string[]): Promise<{ decision: 'answer' | 'skip' | 'pause'; text: string } | undefined> {
    const label = kind === 'goals' ? 'Your research goal' : kind === 'blocked' ? 'A result is stuck' : kind === 'counterexample_review' ? 'A possible counterexample' : 'The agent asks';
    const decide = 'Let the agent decide';
    if (options?.length) {
      const picked = await vscode.window.showQuickPick([...options, '$(edit) Other…', `$(debug-continue) ${decide}`, '$(debug-pause) Pause the loop'], { title: `Research Assistant · ${label}`, placeHolder: prompt, ignoreFocusOut: true });
      if (!picked || picked.includes(decide)) return { decision: 'skip', text: '' };
      if (picked.includes('Pause')) return { decision: 'pause', text: '' };
      if (!picked.includes('Other')) return { decision: 'answer', text: picked };
    } else {
      const choice = await vscode.window.showInformationMessage(`${label}: ${prompt}`, 'Answer…', decide, 'Pause the loop');
      if (!choice || choice === decide) return { decision: 'skip', text: '' };
      if (choice.startsWith('Pause')) return { decision: 'pause', text: '' };
    }
    const text = await vscode.window.showInputBox({ title: `Research Assistant · ${label}`, prompt, ignoreFocusOut: true });
    return text === undefined ? { decision: 'skip', text: '' } : { decision: 'answer', text };
  }

  private async requestApproval(requestId: string, kind: ApprovalKind, target: string, summary: string, waitSeconds: number): Promise<ToolResult> {
    const request = { id: requestId };
    // No popup: a review waits in the dashboard's Needs you list; the loop only interrupts the researcher when it has stopped.
    const popup = this.fromDashboard<{ decision: 'approved' | 'changes_requested' | 'later'; text: string }>(requestId);
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'approved' | 'changes_requested' | 'later'; text: string }>(waitSeconds * 1000)]);
    if (outcome !== 'timeout') this.dashboardAnswers.delete(requestId);
    const apply = async (result: { decision: 'approved' | 'changes_requested' | 'later'; text: string } | undefined) => {
      if (!result || result.decision === 'later') return;
      await this.withCore((core) => core.resolveApproval(request.id, result.decision, result.text, 'popup'));
    };
    if (outcome === 'timeout') {
      void popup.then(apply);
      return { answered: false, request_id: request.id, reason: 'timeout', note: 'The request stays queued; continue with other actionable work.' };
    }
    await apply(outcome);
    if (!outcome || outcome.decision === 'later') return { answered: false, request_id: request.id, reason: 'dismissed', note: 'The request stays queued; continue with other actionable work.' };
    return { answered: true, request_id: request.id, decision: outcome.decision, text: outcome.text };
  }

  private async showApproval(kind: ApprovalKind, target: string, summary: string): Promise<{ decision: 'approved' | 'changes_requested' | 'later'; text: string } | undefined> {
    const paths = this.paths!;
    const file = kind === 'project' ? paths.projectMd : (await findNodeFile(this.files, paths, kind === 'definition' ? 'definition' : 'asset', target)) ?? `${paths.assets}/${target}.md`;
    const node = this.nodeSource?.().find((item) => item.id === target);
    const approveLabel = acceptLabel(kind, node?.type ?? '');
    const rejectLabel = kind === 'counterexample' ? 'Not a counterexample…' : 'Ask for changes…';
    for (;;) {
      const choice = await vscode.window.showInformationMessage(`${approvalTitle(kind, node?.title || target, node?.type ?? '', node?.origin === 'library')}${summary ? `: ${summary}` : ''}`, 'Open', approveLabel, rejectLabel, 'Later');
      if (choice === 'Open') {
        // A result opens on its dashboard page, like the links in the chat; the project file has none.
        if (kind !== 'project' && this.showNodeHandler) await this.showNodeHandler(target);
        else await vscode.window.showTextDocument(this.files.resolve(file));
        continue;
      }
      if (choice === approveLabel) return { decision: 'approved', text: '' };
      if (choice === rejectLabel) {
        const text = await vscode.window.showInputBox({ title: `Research Assistant · ${rejectLabel.replace('…', '')}: ${node?.title || target}`, prompt: kind === 'counterexample' ? 'Why is it not a counterexample?' : 'What should change?', ignoreFocusOut: true });
        return text === undefined ? { decision: 'later', text: '' } : { decision: 'changes_requested', text };
      }
      return { decision: 'later', text: '' };
    }
  }

  // ---------- dashboard graph ----------

  async graphPayload(nodes: ResearchNode[]): Promise<GraphPayload> {
    if (!this.paths) throw new Error('Initialize the Research Assistant project first.');
    const paths = this.paths;
    let state: LoopState | undefined;
    try { state = await this.core?.peek(); } catch { state = undefined; }
    // Filtered before the limit: a stage that reads many nodes logs a context_request each, which the timeline does not show.
    const events = this.core ? await this.core.recentEvents(80, isTimelineEvent) : [];
    const recheck = this.core ? await this.core.recheckFlags() : {};
    const payload = await collectGraphPayload(this.files, paths, nodes, state, events, recheck);
    const loopSettings = (await readLoopSettings(this.files)).settings;
    payload.autoMode = loopSettings.autoApprove.enabled || loopSettings.autonomy.enabled;
    if (this.core && state) {
      payload.autonomy = await this.core.autonomySummary(state);
      const agentGoals = new Set(await this.core.agentGoals());
      for (const node of payload.nodes) if (node.required && agentGoals.has(node.id)) node.agentGoal = true;
    }
    try {
      const study = await this.teaching().overview();
      const items = new Map(study.items.map((item) => [item.id, item]));
      for (const node of payload.nodes) {
        const item = items.get(node.id);
        if (item) node.understanding = { state: item.state, ...(item.level ? { level: item.level } : {}), suggested: item.suggested };
      }
      payload.study = { behind: study.behind, total: study.items.length };
    } catch (error: unknown) { this.output.appendLine(`[teach] Could not read what you studied: ${String(error)}`); }
    if (this.pendingUpstream) {
      const { ref, behind, reason } = this.pendingUpstream;
      payload.attention.push({
        key: `upstream:${ref}`, priority: 2, category: 'upstream', title: `${ref} has ${behind} new commit${behind === 1 ? '' : 's'} (e.g. from Overleaf)`,
        reason: `Not pulled automatically because ${reason}.`, why: 'Collaborators changed the shared project.', ifIgnored: 'You keep working on an older version.',
        blocks: [], sections: [], buttons: [{ label: 'Pull now', action: { action: 'syncPull' }, kind: 'primary' }],
      });
    }
    return payload;
  }

  /** Researcher actions from the Graph tab. Agent work is never started here: it is copied for the chat. */
  async graphAction(request: GraphAction): Promise<void> {
    if (!this.paths) throw new Error('Initialize the Research Assistant project first.');
    const paths = this.paths;
    switch (request.action) {
      case 'approve':
      case 'requestChanges': {
        const decision = request.action === 'approve' ? 'approved' : 'changes_requested';
        const text = request.action === 'requestChanges' ? request.text.trim() : '';
        if (request.action === 'requestChanges' && !text) throw new Error('Say what should change.');
        const live = this.dashboardAnswers.get(request.requestId);
        if (live) live({ decision, text });
        else await this.withCore((core) => core.resolveApproval(request.requestId, decision, text, 'dashboard'));
        this.stateChanged.fire();
        return;
      }
      case 'answer': {
        if (!request.text.trim()) throw new Error('Write an answer first.');
        const live = this.dashboardAnswers.get(request.questionId);
        if (live) live({ decision: 'answer', text: request.text.trim() });
        else await this.withCore((core) => core.answerQuestion(request.questionId, 'answer', request.text.trim(), 'dashboard'));
        this.stateChanged.fire();
        return;
      }
      case 'park': await this.withCore((core) => core.park(request.assetId, 'researcher', 'Parked from the dashboard.')); return;
      case 'unpark': await this.withCore((core) => core.unpark(request.assetId)); return;
      case 'lock': await this.lockSection(request.section); return;
      case 'openNode': {
        const file = (await findNodeFile(this.files, paths, 'definition', request.id)) ?? (await findNodeFile(this.files, paths, 'asset', request.id)) ?? `${paths.assets}/${request.id}.md`;
        await vscode.window.showTextDocument(this.files.resolve(file));
        return;
      }
      case 'openTex': {
        const document = await vscode.workspace.openTextDocument(this.files.resolve(sectionTexPath(paths, request.section)));
        const line = Math.max(0, (request.line ?? 1) - 1);
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
        return;
      }
      case 'understand': {
        await this.teaching().mark(request.id, request.level, { at: new Date().toISOString() });
        this.stateChanged.fire();
        return;
      }
      case 'teach': {
        const node = request.id ? this.nodeSource?.().find((item) => item.id === request.id) : undefined;
        await this.teachCommand(request.id ? { id: request.id, title: node?.title || request.id } : undefined);
        return;
      }
      case 'agent': {
        await vscode.env.clipboard.writeText(request.prompt);
        await this.openChat(this.core?.current?.provider);
        // Manuscript and teaching work belong in a chat of their own: pasted into the loop's chat, the loop would take it back over.
        const beside = WRITE_PROMPT_PATTERN.test(request.prompt) || TEACH_PROMPT_PATTERN.test(request.prompt);
        vscode.window.setStatusBarMessage(beside ? '$(clippy) Instruction copied: start a new chat beside the loop and paste it' : '$(clippy) Instruction copied: paste it into the agent chat', beside ? 10000 : 8000);
        return;
      }
      case 'loop': {
        if (request.op === 'start') await this.startCommand();
        else if (request.op === 'resume') await this.resumeCommand();
        else if (request.op === 'extend') await this.extendCommand();
        else await this.openChat(this.core?.current?.provider);
        return;
      }
      case 'syncPull': await this.syncPullCommand(); return;
      case 'confirmRecheck': await this.withCore((core) => core.confirmRecheck(request.id)); return;
    }
  }

  /** Lock a section after the researcher confirms the snapshot in a modal: the lock asserts the TeX matches the research. */
  private async lockSection(sectionId: string): Promise<void> {
    const paths = this.paths!;
    const section = parseWritingOutline(await this.files.readFile(paths.writingOutline)).find((entry) => entry.id === sectionId);
    if (!section) throw new Error(`Section ${sectionId} is not listed in the writing outline`);
    const texFile = sectionTexPath(paths, sectionId);
    const texRaw = await this.files.readFile(texFile).catch(() => { throw new Error(`Missing TeX section ${texFile}; draft it before locking.`); });
    const { project, revision } = await loadProjectRevision(this.files, paths);
    const binding = lockBinding({
      section: sectionId, tex: texFile, texRaw, brief: await readSectionBriefFile(this.files, paths, section), nodes: await loadImpactNodes(this.files, paths),
      project, projectRevision: revision, lockedAt: new Date().toISOString(), performedBy: await this.git.userEmail(),
    });
    const detail = [
      `Project revision: ${revision ?? 'unapproved'}`,
      `Sources: ${binding.sources.map((source) => `${source.id} (${source.uses.join(', ')})${source.via === 'direct' ? '' : ` via ${source.via}`}`).join('; ')}`,
      binding.blocks?.length ? `Blocks: ${binding.blocks.map((block) => `${block.id} [${block.policy}]`).join(', ')}` : 'No block markers: the section is tracked as a whole.',
      '', 'Do this only after reading the TeX: later research changes are measured against this snapshot.',
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(`Mark section "${section.title}" as reviewed against the current research?`, { modal: true, detail }, 'Mark as reviewed');
    if (choice !== 'Mark as reviewed') return;
    await this.files.writeFile(bindingPath(paths, sectionId), JSON.stringify(binding, null, 2) + '\n');
    this.output.appendLine(`[manuscript] Locked ${sectionId} at project revision ${revision ?? 'unapproved'}`);
    this.stateChanged.fire();
  }

  // ---------- status bar ----------

  /** The loop's health with node titles from the dashboard's index; light enough for the status bar. */
  private async currentHealth(state: LoopState | undefined): Promise<LoopHealth> {
    const all = this.nodeSource?.() ?? [];
    const failed = new Map<string, number>();
    for (const node of all) if (node.type === 'plan' && node.status === 'failed' && node.target_asset) failed.set(node.target_asset, (failed.get(node.target_asset) ?? 0) + 1);
    const nodes = new Map<string, HealthNode>(all.map((node) => [node.id, { title: node.title || node.id, type: node.type, ...(typeof node.refutes === 'string' ? { refutes: node.refutes } : {}), counts: { failedPlans: failed.get(node.id) ?? 0 }, ...(node.origin === 'library' || isCited(node.source) ? { cited: true } : {}) }]));
    const edges = all.flatMap((node) => [...(node.depends_on ?? []), ...(node.uses_definitions ?? [])].map((to) => ({ from: node.id, to })));
    const project = this.paths ? await this.files.readFile(this.paths.projectMd).catch(() => '') : '';
    const agent = await readAgentActivity(this.files);
    return computeLoopHealth({ state, agent, nodes, edges, required: requiredAssetIds(project), now: new Date().toISOString() });
  }

  private async refreshStatusBar(): Promise<void> {
    if (!this.core) { this.statusBar.hide(); return; }
    let state: LoopState | undefined;
    try { state = await this.core.peek(); } catch { state = undefined; }
    if (state?.pendingQuestion && !this.openQuestions.has(state.pendingQuestion.id) && !this.resolving) {
      // A question the loop raised itself (no popup is waiting on it): resolve it once overdue, per the researcher's setting.
      this.resolving = true;
      try { if (await this.withCore((core) => core.resolveOverdueQuestion())) return; } finally { this.resolving = false; }
    }
    const health = await this.currentHealth(state);
    // Time alone can change the health (an agent going quiet): tell the dashboard when it does.
    if (this.lastHealthKey !== undefined && this.lastHealthKey !== health.signature) this.stateChanged.fire();
    this.lastHealthKey = health.signature;
    void this.announce(health, state);
    const behind = await this.studyBehind();
    const study = behind ? `${behind} verified result${behind === 1 ? '' : 's'} new to you: run “Research Assistant: Study Verified Results” to go through them in a teaching chat.` : '';
    if (health.key === 'idle') {
      if (!behind) { this.statusBar.hide(); return; }
      this.statusBar.text = `$(book) ${behind} to study`;
      this.statusBar.backgroundColor = undefined;
      this.statusBar.command = 'research-assistant.loop.teach';
      this.statusBar.tooltip = study;
      this.statusBar.show();
      return;
    }
    this.statusBar.text = `${HEALTH_ICON[health.key]} ${health.statusBar.text}${behind ? ` · $(book) ${behind} to study` : ''}`;
    this.statusBar.backgroundColor = health.statusBar.level === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : health.statusBar.level === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusBar.command = 'research-assistant.openOverview';
    this.statusBar.tooltip = new vscode.MarkdownString([`**${health.headline}**`, health.body, ...health.blockers.map((item, index) => `${index + 1}. ${item.title}`), `*If you do nothing:* ${health.ifIgnored}`, study, 'Click to open the Overview.'].filter(Boolean).join('\n\n'));
    this.statusBar.show();
  }

  /**
   * The only loop popups: the loop has stopped and waits on the researcher, the
   * agent went quiet, or the loop paused itself. Each situation is announced
   * once; everything else waits in the dashboard.
   */
  private async announce(health: LoopHealth, state: LoopState | undefined): Promise<void> {
    // A question the loop raised itself has no popup of its own (one asked through ask_researcher does): show it, like any direct question.
    const question = state?.pendingQuestion;
    if (question && !this.openQuestions.has(question.id)) {
      if (this.alerted === `question:${question.id}`) return;
      this.alerted = `question:${question.id}`;
      this.openQuestions.add(question.id);
      const outcome = await this.showQuestion(question.prompt, question.kind, question.options).finally(() => this.openQuestions.delete(question.id));
      if (!outcome || this.core?.current?.pendingQuestion?.id !== question.id) return;
      if (outcome.decision === 'pause') { await this.pauseCommand(); return; }
      await this.withCore((core) => core.answerQuestion(question.id, outcome.decision === 'answer' ? 'answer' : 'skip', outcome.text, 'popup'));
      return;
    }
    const alerting = health.key === 'stopped' || health.key === 'stalled' || (health.key === 'paused' && /automatic continuations|autonomous run/.test(health.headline));
    if (!alerting) { this.alerted = undefined; return; }
    if (this.alerted === health.signature) return;
    this.alerted = health.signature;
    const overview = 'Open Overview';
    if (health.key === 'stalled') {
      const copy = 'Copy “continue” and open chat';
      const choice = await vscode.window.showWarningMessage(`${health.headline} ${health.body.split('. ')[0]}. Nothing is lost.`, copy, overview);
      if (choice === copy) {
        const action = health.buttons[0]?.action;
        if (action) await this.graphAction(action);
      } else if (choice === overview) await this.openOverview();
      return;
    }
    if (health.key === 'paused' && /autonomous run/.test(health.headline)) {
      const choice = await vscode.window.showWarningMessage(`${health.headline} ${health.body}`, overview, 'Later');
      if (choice === overview) await this.openOverview();
      return;
    }
    if (health.key === 'paused') {
      const choice = await vscode.window.showWarningMessage(`${health.headline} Resume in a fresh chat so the agent starts from a clean context.`, 'Resume', overview);
      if (choice === 'Resume') await this.resumeCommand();
      else if (choice === overview) await this.openOverview();
      return;
    }
    const list = health.blockers.slice(0, 3).map((item) => item.title).join('; ');
    const choice = await vscode.window.showWarningMessage(`${health.headline}${list ? ` ${list}${health.blockers.length > 3 ? '; …' : ''}.` : ''}`, overview, 'Later');
    if (choice === overview) await this.openOverview();
  }

  // ---------- commands ----------

  private preferredProvider(): AgentProvider | undefined {
    const configured = setting<'auto' | AgentProvider>('provider', 'auto');
    if (configured !== 'auto') return configured;
    return PROVIDER_IDS.find((id) => vscode.extensions.getExtension(AGENT_PROVIDERS[id].extensionId));
  }

  async openChat(provider?: AgentProvider): Promise<void> {
    const target = provider ?? this.preferredProvider();
    const spec = target ? AGENT_PROVIDERS[target] : undefined;
    try {
      if (spec && vscode.extensions.getExtension(spec.extensionId)) { await vscode.commands.executeCommand(spec.openChatCommand); return; }
    } catch (error: unknown) { this.output.appendLine(`[loop] Could not open the chat: ${String(error)}`); }
    void vscode.window.showInformationMessage(`Install the ${PROVIDER_IDS.map((id) => AGENT_PROVIDERS[id].label).join(' or ')} VS Code extension, then type ${allChatHints()} in its chat.`);
  }

  async startCommand(): Promise<void> {
    const preferred = setting('useDefaultAgentOnStart', false) ? this.preferredProvider() : undefined;
    const picked = preferred ? { provider: preferred } : await vscode.window.showQuickPick(PROVIDER_IDS.map((id) => ({ label: AGENT_PROVIDERS[id].label, description: `type ${invocation(id)} in the ${AGENT_PROVIDERS[id].label} chat`, provider: id })),
      { title: 'Research Assistant · Start research loop', placeHolder: 'Which agent chat will drive the loop?' });
    if (!picked) return;
    const goal = await vscode.window.showInputBox({ title: 'Research goal', prompt: 'Describe the research goal, the main claim, and constraints (optional; the agent can ask).', ignoreFocusOut: true });
    if (goal === undefined) return;
    await this.withCore((core) => core.start(picked.provider, { goal, force: true }));
    await this.openChat(picked.provider);
    vscode.window.setStatusBarMessage(`$(beaker) Research loop started. ${chatHint(picked.provider)}`, 10000);
  }

  async extendCommand(): Promise<void> {
    const goal = await vscode.window.showInputBox({ title: 'Extend the research project', prompt: 'Describe the new goal or conjecture to add. Existing approved results are kept.', ignoreFocusOut: true });
    if (!goal?.trim()) return;
    const state = await this.withCore(async (core) => { await core.extend(goal, { provider: core.current?.provider ?? this.preferredProvider(), force: true }); return core.current; });
    await this.openChat(state?.provider);
    vscode.window.setStatusBarMessage(`$(beaker) Research loop reopened for the new goal. ${state?.provider ? chatHint(state.provider) : allChatHints()}`, 10000);
  }

  async pauseCommand(): Promise<void> { await this.withCore((core) => core.pause('Paused by the researcher.')); }
  async resumeCommand(): Promise<void> { await this.withCore((core) => core.resume({ force: true })); await this.openChat(); }
  async stopCommand(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage('Stop the research loop? Files stay; only the run state is cleared.', { modal: true }, 'Stop');
    if (confirm === 'Stop') await this.withCore((core) => core.stop());
  }

  async answerQuestionCommand(): Promise<void> {
    const state = await this.withCore(async (core) => core.current);
    const question = state?.pendingQuestion;
    if (!question) { void vscode.window.showInformationMessage('No question is waiting.'); return; }
    const outcome = await this.showQuestion(question.prompt, question.kind, question.options);
    if (!outcome || outcome.decision === 'skip') return;
    if (outcome.decision === 'pause') { await this.pauseCommand(); return; }
    await this.withCore((core) => core.answerQuestion(question.id, 'answer', outcome.text, 'command'));
  }

  async approveCommand(): Promise<void> {
    const state = await this.withCore(async (core) => core.current);
    const queue = state?.approvalQueue ?? [];
    if (!queue.length) { void vscode.window.showInformationMessage('Nothing is waiting for your review.'); return; }
    const all = this.nodeSource?.() ?? [];
    const picked = await vscode.window.showQuickPick(queue.map((item) => { const node = all.find((entry) => entry.id === item.target); return { label: approvalTitle(item.kind, node?.title || item.target, node?.type ?? '', node?.origin === 'library'), description: item.reason, item }; }), { title: 'Research Assistant · Waiting for your review' });
    if (!picked) return;
    const outcome = await this.showApproval(picked.item.kind, picked.item.target, picked.item.reason);
    if (!outcome || outcome.decision === 'later') return;
    await this.withCore((core) => core.resolveApproval(picked.item.id, outcome.decision, outcome.text, 'command'));
  }

  // ---------- git sync ----------

  /** The human gate on sharing research: a modal only the researcher can answer. */
  private async confirmPublish(detail: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage('Publish research changes to your collaborators?', { modal: true, detail }, 'Publish');
    return choice === 'Publish';
  }

  private async withSync<T>(action: (sync: ResearchSync) => Promise<T>): Promise<T> {
    const root = this.files.rootUri.fsPath;
    const config = await loadSyncConfig(root);
    return this.withCore((core) => action(new ResearchSync(core, this.files, this.git, config, runShell(root))));
  }

  private report(title: string, lines: string[]): void {
    this.output.appendLine(`[sync] ${title}`);
    for (const line of lines) this.output.appendLine(`  ${line}`);
  }

  async syncStatusCommand(): Promise<void> {
    const status = await this.withSync((sync) => sync.status());
    this.report('status', JSON.stringify(status, null, 2).split('\n'));
    this.output.show(true);
  }

  async syncPullCommand(): Promise<PullResult> {
    try {
      const result = await this.withSync((sync) => sync.pull());
      this.showPullResult(result, false);
      return result;
    } finally { this.synced.fire(); }
  }

  private showPullResult(result: PullResult, automatic: boolean): void {
    this.report(`${automatic ? 'auto-' : ''}pull: ${result.status}`, [...result.summary, ...result.problems.map((line) => `PROBLEM ${line}`), ...result.warnings.map((line) => `WARNING ${line}`)]);
    if (!automatic || result.status !== 'pulled' || result.problems.length || result.warnings.length) this.output.show(true);
    if (result.status === 'pulled' || result.status === 'conflict') this.pendingUpstream = undefined;
    if (result.status === 'conflict') void vscode.window.showWarningMessage(`Pulling collaborators’ changes stopped: ${result.conflicted?.length ?? 0} file(s) were changed on both sides (${result.conflicted?.join(', ')}). Fix them, then ask the agent to finish the pull.`);
    else if (result.problems.length) void vscode.window.showWarningMessage(`Pulled, but ${result.problems.length} research file(s) need fixing; the loop is paused. See Output.`);
    else vscode.window.setStatusBarMessage(`$(repo-pull) ${automatic ? 'Pulled collaborators’ changes' : result.summary[0] ?? 'Pulled'}`, 8000);
  }

  // ---------- automatic pull ----------

  private scheduleAutoSync(): void {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = undefined;
    const minutes = syncSetting('autoPullIntervalMinutes', 5);
    if (syncSetting<AutoPullMode>('autoPull', 'pull') === 'off' || !(minutes > 0)) return;
    this.autoSyncTimer = setInterval(() => { void this.autoSync(true); }, Math.max(1, minutes) * 60_000);
  }

  /**
   * Fetch the sync remote and, when it is ahead, pull if nothing local could be
   * mixed in; otherwise announce it once. Never surfaces errors as popups:
   * a project without git, config, or credentials just stays quiet.
   */
  private async autoSync(force: boolean): Promise<void> {
    const mode = syncSetting<AutoPullMode>('autoPull', 'pull');
    if (mode === 'off' || !this.core || this.autoSyncRunning || this.syncNowRunning) return;
    if (!force && Date.now() - this.lastAutoSync < AUTO_SYNC_MIN_GAP_MS) return;
    this.autoSyncRunning = true;
    this.lastAutoSync = Date.now();
    try {
      if (!(await this.isGitRepository())) return;
      const outcome = await this.withSync(async (sync) => {
        const status = await sync.status();
        const decision = autoPullDecision(status, mode);
        if (decision.action !== 'pull') return { status, decision };
        try { return { status, decision, pulled: await sync.pull() }; }
        catch (error: unknown) { return { status, decision: { action: 'notify' as const, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) } }; }
      });
      const { status, decision } = outcome;
      const ref = `${status.remote}/${status.branch}`;
      if (typeof status.fetchError === 'string') {
        if (status.fetchError !== this.reportedFetchError) this.output.appendLine(`[sync] auto-pull could not fetch ${status.remote}: ${status.fetchError}`);
        this.reportedFetchError = status.fetchError;
        return;
      }
      this.reportedFetchError = undefined;
      if (outcome.pulled) { this.announcedUpstream = undefined; this.showPullResult(outcome.pulled, true); this.synced.fire(); return; }
      if (decision.action !== 'notify') return;
      const upstream = (await this.git.run(['rev-parse', ref])).stdout.trim();
      if (upstream && upstream === this.announcedUpstream) return;
      this.announcedUpstream = upstream;
      const behind = status.behind as number;
      this.output.appendLine(`[sync] ${ref} is ${behind} commit(s) ahead; not pulled automatically because ${decision.reason}.`);
      // Waits in the dashboard's Needs you list; nothing is blocked by it.
      this.pendingUpstream = { ref, behind, reason: decision.reason };
      this.stateChanged.fire();
    } catch (error: unknown) {
      this.output.appendLine(`[sync] auto-pull skipped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.autoSyncRunning = false;
    }
  }

  private reportPrepare(result: PrepareResult): void {
    this.report(`prepare: ${result.ok ? 'ready' : 'not ready'}`, [...result.checks.map((check) => `${check.ok ? (check.warning ? 'WARN' : 'PASS') : 'FAIL'} ${check.name}${check.details.length ? `: ${check.details.join(' | ')}` : ''}`), ...result.summary]);
  }

  async syncPrepareCommand(): Promise<void> {
    const result = await this.withSync((sync) => sync.prepare());
    this.reportPrepare(result);
    this.output.show(true);
    if (result.ok) {
      const choice = await vscode.window.showInformationMessage('Research is ready to share.', 'Publish…');
      if (choice) await this.syncPublishCommand();
    } else void vscode.window.showWarningMessage('Research is not ready to share; see the FAIL items in Output.');
  }

  async syncPublishCommand(): Promise<PublishResult> {
    try {
      const result = await this.withSync((sync) => sync.publish(async (preview) => this.confirmPublish([
        `To: ${preview.targets.join(' and ')}`,
        preview.files.length ? `Commit ${preview.files.length} file(s):\n${preview.files.slice(0, 25).map((entry) => `${entry.code.trim() || '?'} ${entry.path}`).join('\n')}` : '',
        preview.ahead ? `Plus ${preview.ahead} local commit(s).` : '',
        `Message:\n${preview.message}`,
      ].filter(Boolean).join('\n\n'))));
      this.report(`publish: ${result.status}`, [...result.summary, ...result.warnings.map((line) => `WARNING ${line}`)]);
      if (result.status === 'published') void vscode.window.showInformationMessage(result.summary[result.summary.length - 1] ?? 'Published.');
      else if (result.status !== 'blocked' || result.warnings.length) { this.output.show(true); void vscode.window.showWarningMessage(`Research publish: ${result.summary[result.summary.length - 1] ?? result.status}`); }
      return result;
    } finally { this.synced.fire(); }
  }

  // ---------- one-click sync (dashboard) ----------

  private async isGitRepository(): Promise<boolean> {
    return (await this.git.run(['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  }

  /**
   * The dashboard's Sync button: share local work if there is any (prepare's
   * checks, then publish behind the researcher's confirmation, which also
   * integrates collaborators' commits), otherwise pull. Returns a notice only
   * when the researcher has to act; successes are announced by toasts.
   */
  async syncNowCommand(): Promise<SyncNotice | undefined> {
    if (this.syncNowRunning) return undefined;
    if (!this.core) throw new Error('Initialize the Research Assistant project first.');
    this.syncNowRunning = true;
    this.synced.fire();
    const warn = (message: string, details?: string[]): SyncNotice => {
      this.output.appendLine(`[sync] ${message}`);
      for (const line of details ?? []) this.output.appendLine(`  ${line}`);
      void vscode.window.showWarningMessage(`Research sync: ${message}`, 'Show details').then((choice) => { if (choice) this.output.show(true); });
      return { level: 'warning', message, details };
    };
    try {
      if (!(await this.isGitRepository())) return warn('This project folder is not a git repository, so there is nothing to sync. Clone the shared repository (or ask a collaborator to set it up) and open that folder.');
      const status = await this.withSync((sync) => sync.status());
      const decision = syncNowAction(status);
      const ref = `${status.remote}/${status.branch}`;
      this.output.appendLine(`[sync] sync now: ${decision.action}`);
      switch (decision.action) {
        case 'blocked':
          return warn(decision.reason, typeof status.fetchError === 'string' ? [status.fetchError] : undefined);
        case 'none':
          void vscode.window.showInformationMessage(`Research is up to date with ${ref}.`);
          return undefined;
        case 'pull': {
          const result = await this.syncPullCommand();
          if (result.status === 'conflict') return { level: 'warning', message: `Sync stopped on conflicts in ${result.conflicted?.join(', ')}. Nothing was overwritten; the researchers decide which version is right.`, details: result.summary };
          if (result.problems.length) return { level: 'warning', message: 'Pulled, but some research files need fixing (the loop is paused):', details: result.problems };
          return undefined;
        }
        case 'share': {
          const prepared = await this.withSync((sync) => sync.prepare());
          this.reportPrepare(prepared);
          if (!prepared.ok) {
            const failed = prepared.checks.filter((check) => !check.ok);
            return warn('Not ready to share yet. Fix these first (you can ask the agent to fix them), then sync again:', failed.map((check) => `${check.name}${check.details.length ? `: ${check.details.join(' ')}` : ''}`));
          }
          const result = await this.syncPublishCommand();
          if (result.status === 'conflict' || (result.status === 'blocked' && result.warnings.length)) return { level: 'warning', message: result.summary[result.summary.length - 1] ?? `Publish ${result.status}.`, details: [...result.summary.slice(0, -1), ...result.warnings] };
          if (result.warnings.length) return { level: 'warning', message: `Published to ${result.pushed.join(' and ')}, with warnings:`, details: result.warnings };
          return undefined;
        }
      }
    } catch (error: unknown) {
      return warn(error instanceof Error ? error.message.split('\n')[0] : String(error), error instanceof Error ? error.message.split('\n').slice(1).filter(Boolean) : undefined);
    } finally {
      this.syncNowRunning = false;
      this.synced.fire();
    }
  }

  /** Local-only sync state for the dashboard's Sync button; never fetches, never throws. */
  async syncBadge(): Promise<SyncBadge> {
    const badge = await this.readSyncBadge();
    return { ...badge, busy: this.syncNowRunning };
  }

  private async readSyncBadge(): Promise<SyncBadge> {
    const base: SyncBadge = { available: false, busy: false, changed: 0, ahead: 0, behind: 0, conflict: false };
    if (!this.core) return { ...base, reason: 'The research project is not set up yet.' };
    try {
      if (!(await this.isGitRepository())) return { ...base, reason: 'This project folder is not a git repository.' };
      const status = await this.withSync((sync) => sync.status({ fetch: false }));
      const remote = String(status.remote);
      const branch = String(status.branch);
      if ((await this.git.run(['remote', 'get-url', remote])).code !== 0) return { ...base, remote, branch, reason: `No git remote named "${remote}"; set the sync remote in Settings.` };
      const count = (value: unknown) => typeof value === 'number' ? value : 0;
      return {
        ...base, available: true, remote, branch,
        changed: Array.isArray(status.uncommitted) ? status.uncommitted.length : 0,
        ahead: count(status.ahead), behind: count(status.behind),
        conflict: status.phase === 'conflict',
      };
    } catch (error: unknown) {
      return { ...base, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) };
    }
  }

  async captureIdeaCommand(): Promise<void> {
    const title = await vscode.window.showInputBox({ title: 'Capture idea · title', ignoreFocusOut: true });
    if (!title) return;
    const body = await vscode.window.showInputBox({ title: 'Capture idea · body', prompt: 'Intuition, gap, approach, or test case', ignoreFocusOut: true });
    if (!body) return;
    const id = await this.withCore((core) => core.saveIdea(title, body, [], 'researcher'));
    vscode.window.setStatusBarMessage(`$(lightbulb) Saved idea ${id}. Ask the agent to "discuss idea ${id}" to turn it into results and plans.`, 10000);
  }
}
