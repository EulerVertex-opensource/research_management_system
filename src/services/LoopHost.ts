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
import { AgentProvider, ApprovalKind, BRIDGE_PATH, BRIDGE_REGISTRY, BridgeEntry, LoopState, QuestionKind, STATE_PATH } from './ResearchLoopModel';
import { LoopGit } from './LoopGit';
import { ResearchSync } from './ResearchSync';
import { NodeGitRunner, runShell } from '../cli/nodeGit';
import { loadSyncConfig } from '../cli/nodeFiles';
import { toIdeaKind } from '../domain/nodeKinds';
import { ResearchNode } from '../models/types';
import { GraphAction, GraphPayload } from '../models/graph';
import { collectGraphPayload } from './GraphViewModel';
import { bindingPath, loadImpactNodes, loadProjectRevision, readSectionBriefFile, sectionTexPath } from './ManuscriptImpactLoader';
import { parseWritingOutline } from './ManuscriptWriting';
import { lockBinding } from '../domain/manuscriptImpact';

function extensionVersion(): string | undefined {
  return vscode.extensions.all.find((extension) => extension.id.toLowerCase() === 'tianhao.research-management-system')?.packageJSON?.version;
}

type ToolResult = Record<string, unknown>;

/** Longest a single bridge call may block; stays under Codex's default MCP tool timeout. */
export const MAX_SLICE_SECONDS = 45;
function sliceSeconds(value: unknown): number { return typeof value === 'number' && value > 0 ? Math.min(value, MAX_SLICE_SECONDS) : MAX_SLICE_SECONDS; }

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('researchAssistant').get<T>(`loop.${key}`, fallback);
}

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
  private readonly subscriptions: vscode.Disposable[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  private readonly interactions = new Map<string, Promise<ToolResult>>();
  private readonly git: LoopGit;
  /** Answers given in the dashboard for a question or approval whose popup is still open. */
  private readonly dashboardAnswers = new Map<string, (outcome: { decision: string; text: string }) => void>();
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when the loop state or an approval changes, so the dashboard can refresh its Graph tab. */
  readonly onDidChangeState = this.stateChanged.event;

  constructor(private readonly files: FileService, private readonly output: vscode.OutputChannel) {
    this.git = new LoopGit(new NodeGitRunner(files.rootUri.fsPath));
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = 'research-assistant.loop.openChat';
    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => { void this.onEditorSave(document); }));
  }

  configure(paths: ProjectPaths): void {
    this.paths = paths;
    if (this.core) this.core.setPaths(paths);
    else this.core = new ResearchLoopCore(this.files, paths, { iterationCap: setting('iterationCap', 10), git: this.git, extensionVersion: extensionVersion() });
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, STATE_PATH));
    const refresh = () => { void this.refreshStatusBar(); this.stateChanged.fire(); };
    this.watcher.onDidChange(refresh); this.watcher.onDidCreate(refresh); this.watcher.onDidDelete(refresh);
    void this.startBridge();
    void this.refreshStatusBar();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.statusBar.dispose();
    this.stateChanged.dispose();
    this.subscriptions.forEach((item) => item.dispose());
    this.server?.close();
    void vscode.workspace.fs.delete(this.files.resolve(BRIDGE_PATH)).then(undefined, () => undefined);
    void this.updateRegistry(undefined);
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
    const kind = (await this.files.exists(`${this.paths.definitions}/${id}.md`)) ? 'definition' : 'asset';
    const recorded = await this.withCore((core) => core.recordExisting(kind, id, source)).catch(() => false);
    if (recorded) this.output.appendLine(`[loop] Recorded ${source} approval of ${id}`);
  }

  async reconcile(id: string): Promise<void> {
    const reverted = await this.withCore((core) => core.reconcile(id)).catch(() => [] as string[]);
    if (reverted.length) {
      this.output.appendLine(`[loop] Approval invalidated by edits: ${reverted.join(', ')}`);
      void vscode.window.showWarningMessage(`Research Assistant: ${reverted.join(', ')} reverted to draft because approved content changed.`);
    }
  }

  private async onEditorSave(document: vscode.TextDocument): Promise<void> {
    if (!this.paths || vscode.window.activeTextEditor?.document !== document) return;
    const relative = path.relative(this.files.rootUri.fsPath, document.uri.fsPath).split(path.sep).join('/');
    if (!relative.endsWith('.md')) return;
    const folder = path.posix.dirname(relative);
    if (folder !== this.paths.assets && folder !== this.paths.definitions) return;
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
    const total = setting('questionTimeoutSeconds', 240);
    const slice = sliceSeconds(args.wait_seconds);
    if (name === 'ask_researcher') {
      const question = await this.withCore((core) => core.askQuestion((args.kind as QuestionKind) ?? 'discussion', String(args.question ?? ''), { assetId: typeof args.asset_id === 'string' ? args.asset_id : undefined, options: Array.isArray(args.options) ? args.options.map(String) : undefined, timeoutSec: total }));
      this.interactions.set(question.id, this.askResearcher(question.id, question.prompt, question.kind, question.options, total));
      return this.awaitInteraction(question.id, slice);
    }
    if (name === 'request_approval') {
      const kind = args.kind as ApprovalKind; const target = String(args.target ?? ''); const summary = String(args.summary ?? '');
      const request = await this.withCore((core) => core.enqueueApproval(kind, target, summary));
      this.interactions.set(request.id, this.requestApproval(request.id, kind, target, summary, total));
      return this.awaitInteraction(request.id, slice);
    }
    if (name === 'await_answer') return this.awaitInteraction(String(args.id ?? ''), slice);
    if (name === 'record_idea') {
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      return this.withCore(async (core) => ({ ok: true, idea_id: await core.saveIdea(String(args.title ?? ''), String(args.body ?? ''), Array.isArray(args.related_assets) ? args.related_assets.map(String) : [], 'agent', tags, toIdeaKind(args.kind, tags)) }));
    }
    if (name === 'loop_status') return this.withCore(async (core) => ({ ok: true, state: core.statusSummary(), brief: core.briefStatus() }));
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
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'answer' | 'skip' | 'pause'; text: string }>(waitSeconds * 1000)]);
    if (outcome !== 'timeout') this.dashboardAnswers.delete(questionId);
    if (outcome === 'timeout') {
      await this.withCore((core) => core.autoResolveQuestion(question.id));
      void popup.then(async (late) => {
        if (!late || late.decision !== 'answer') return;
        await this.withCore((core) => core.answerQuestion(question.id, 'answer', late.text, 'popup'));
        void vscode.window.showInformationMessage('Research Assistant: your late answer was saved; the agent sees it on its next turn.');
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

  private autoActionText(kind: QuestionKind): string {
    switch (kind) {
      case 'goals': return 'No goal given. Continue only if project.md already has a Main Problem; otherwise wait.';
      case 'blocked': return 'The asset was parked; run research-loop next to continue with other work.';
      case 'counterexample_review': return 'No comment; the counterexample stays queued for the researcher.';
      default: return 'Proceed with the default you stated; the open question was recorded as an idea.';
    }
  }

  private async showQuestion(prompt: string, kind: QuestionKind, options?: string[]): Promise<{ decision: 'answer' | 'skip' | 'pause'; text: string } | undefined> {
    const label = kind === 'goals' ? 'Research goal' : kind === 'blocked' ? 'Blocked' : kind === 'counterexample_review' ? 'Counterexample' : 'Question';
    if (options?.length) {
      const picked = await vscode.window.showQuickPick([...options, '$(edit) Other…', '$(debug-continue) Skip (auto mode)', '$(debug-pause) Pause loop'], { title: `Research Assistant · ${label}`, placeHolder: prompt, ignoreFocusOut: true });
      if (!picked || picked.includes('Skip')) return { decision: 'skip', text: '' };
      if (picked.includes('Pause')) return { decision: 'pause', text: '' };
      if (!picked.includes('Other')) return { decision: 'answer', text: picked };
    } else {
      const choice = await vscode.window.showInformationMessage(`Research Assistant · ${label}: ${prompt}`, 'Answer…', 'Skip (auto mode)', 'Pause loop');
      if (!choice || choice.startsWith('Skip')) return { decision: 'skip', text: '' };
      if (choice.startsWith('Pause')) return { decision: 'pause', text: '' };
    }
    const text = await vscode.window.showInputBox({ title: `Research Assistant · ${label}`, prompt, ignoreFocusOut: true });
    return text === undefined ? { decision: 'skip', text: '' } : { decision: 'answer', text };
  }

  private async requestApproval(requestId: string, kind: ApprovalKind, target: string, summary: string, waitSeconds: number): Promise<ToolResult> {
    const request = { id: requestId };
    const popup = Promise.race([this.showApproval(kind, target, summary), this.fromDashboard<{ decision: 'approved' | 'changes_requested' | 'later'; text: string }>(requestId)]);
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'approved' | 'changes_requested' | 'later'; text: string }>(waitSeconds * 1000)]);
    if (outcome !== 'timeout') this.dashboardAnswers.delete(requestId);
    const apply = async (result: { decision: 'approved' | 'changes_requested' | 'later'; text: string } | undefined) => {
      if (!result || result.decision === 'later') return;
      await this.withCore((core) => core.resolveApproval(request.id, result.decision, result.text, 'popup'));
    };
    if (outcome === 'timeout') {
      void popup.then(async (late) => { await apply(late); if (late && late.decision !== 'later') void vscode.window.showInformationMessage(`Research Assistant: recorded your decision on ${target}.`); });
      return { answered: false, request_id: request.id, reason: 'timeout', note: 'The request stays queued; continue with other actionable work.' };
    }
    await apply(outcome);
    if (!outcome || outcome.decision === 'later') return { answered: false, request_id: request.id, reason: 'dismissed', note: 'The request stays queued; continue with other actionable work.' };
    return { answered: true, request_id: request.id, decision: outcome.decision, text: outcome.text };
  }

  private async showApproval(kind: ApprovalKind, target: string, summary: string): Promise<{ decision: 'approved' | 'changes_requested' | 'later'; text: string } | undefined> {
    const paths = this.paths!;
    const file = kind === 'project' ? paths.projectMd : kind === 'definition' ? `${paths.definitions}/${target}.md` : `${paths.assets}/${target}.md`;
    const approveLabel = kind === 'counterexample' ? 'Confirm counterexample' : 'Approve';
    const rejectLabel = kind === 'counterexample' ? 'Reject…' : 'Request changes…';
    for (;;) {
      const choice = await vscode.window.showInformationMessage(`Research Assistant · approve ${kind} ${target}: ${summary}`, 'Open file', approveLabel, rejectLabel, 'Later');
      if (choice === 'Open file') { await vscode.window.showTextDocument(this.files.resolve(file)); continue; }
      if (choice === approveLabel) return { decision: 'approved', text: '' };
      if (choice === rejectLabel) {
        const text = await vscode.window.showInputBox({ title: `Research Assistant · ${rejectLabel.replace('…', '')} for ${target}`, prompt: 'What should change?', ignoreFocusOut: true });
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
    try { state = await this.core?.load(); } catch { state = undefined; }
    return collectGraphPayload(this.files, paths, nodes, state);
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
        const file = (await this.files.exists(`${paths.definitions}/${request.id}.md`)) ? `${paths.definitions}/${request.id}.md` : `${paths.assets}/${request.id}.md`;
        await vscode.window.showTextDocument(this.files.resolve(file));
        return;
      }
      case 'openTex': {
        const document = await vscode.workspace.openTextDocument(this.files.resolve(sectionTexPath(paths, request.section)));
        const line = Math.max(0, (request.line ?? 1) - 1);
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
        return;
      }
      case 'agent': {
        await vscode.env.clipboard.writeText(request.prompt);
        await this.openChat(this.core?.current?.provider);
        void vscode.window.showInformationMessage('Research Assistant: the instruction is on your clipboard; paste it into the agent chat.');
        return;
      }
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
      '', 'Lock only after reviewing the TeX: later research changes are measured against this snapshot.',
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(`Lock section "${section.title}" as reconciled with the current research?`, { modal: true, detail }, 'Lock');
    if (choice !== 'Lock') return;
    await this.files.writeFile(bindingPath(paths, sectionId), JSON.stringify(binding, null, 2) + '\n');
    this.output.appendLine(`[manuscript] Locked ${sectionId} at project revision ${revision ?? 'unapproved'}`);
    this.stateChanged.fire();
  }

  // ---------- status bar ----------

  private async refreshStatusBar(): Promise<void> {
    if (!this.core) { this.statusBar.hide(); return; }
    let state: LoopState | undefined;
    try { state = await this.core.load(); } catch { state = undefined; }
    if (!state || state.status === 'idle' || state.status === 'stopped') { this.statusBar.hide(); return; }
    const waiting = Boolean(state.pendingQuestion) || state.stage === 'waiting' || state.approvalQueue.length > 0;
    this.statusBar.text = state.status === 'paused' ? '$(debug-pause) Loop: paused'
      : waiting ? `$(bell) Loop: waiting for you${state.approvalQueue.length ? ` (${state.approvalQueue.length})` : ''}`
      : state.stage === 'ready' ? '$(check) Loop: ready for the manuscript (click to extend)'
      : `$(beaker) Loop: ${state.stage}${state.current.assetId ? ` · ${state.current.assetId}` : ''}`;
    this.statusBar.command = state.stage === 'ready' && state.status === 'running' && !waiting ? 'research-assistant.loop.extend' : 'research-assistant.loop.openChat';
    this.statusBar.tooltip = new vscode.MarkdownString(this.core.briefStatus().replace(/\n/g, '  \n'));
    this.statusBar.show();
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
    const picked = await vscode.window.showQuickPick(PROVIDER_IDS.map((id) => ({ label: AGENT_PROVIDERS[id].label, description: `type ${invocation(id)} in the ${AGENT_PROVIDERS[id].label} chat`, provider: id })),
      { title: 'Research Assistant · Start research loop', placeHolder: 'Which agent chat will drive the loop?' });
    if (!picked) return;
    const goal = await vscode.window.showInputBox({ title: 'Research goal', prompt: 'Describe the research goal, the main claim, and constraints (optional; the agent can ask).', ignoreFocusOut: true });
    if (goal === undefined) return;
    await this.withCore((core) => core.start(picked.provider, { goal, force: true }));
    await this.openChat(picked.provider);
    void vscode.window.showInformationMessage(`Research loop started. ${chatHint(picked.provider)}`);
  }

  async extendCommand(): Promise<void> {
    const goal = await vscode.window.showInputBox({ title: 'Extend the research project', prompt: 'Describe the new goal or conjecture to add. Existing approved results are kept.', ignoreFocusOut: true });
    if (!goal?.trim()) return;
    const state = await this.withCore(async (core) => { await core.extend(goal, { provider: core.current?.provider ?? this.preferredProvider(), force: true }); return core.current; });
    await this.openChat(state?.provider);
    void vscode.window.showInformationMessage(`Research loop reopened to add the new goal. ${state?.provider ? chatHint(state.provider) : allChatHints()}`);
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
    if (!queue.length) { void vscode.window.showInformationMessage('Nothing is waiting for approval.'); return; }
    const picked = await vscode.window.showQuickPick(queue.map((item) => ({ label: `${item.kind} · ${item.target}`, description: item.reason, item })), { title: 'Research Assistant · Pending approvals' });
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

  async syncPullCommand(): Promise<void> {
    const result = await this.withSync((sync) => sync.pull());
    this.report(`pull: ${result.status}`, [...result.summary, ...result.problems.map((line) => `PROBLEM ${line}`), ...result.warnings.map((line) => `WARNING ${line}`)]);
    this.output.show(true);
    if (result.status === 'conflict') void vscode.window.showWarningMessage(`Research sync stopped on conflicts in ${result.conflicted?.join(', ')}. Resolve them, then ask the agent to run sync pull --continue.`);
    else if (result.problems.length) void vscode.window.showWarningMessage(`Pulled, but ${result.problems.length} research file problem(s) need fixing; the loop is paused. See Output.`);
    else void vscode.window.showInformationMessage(result.summary[0] ?? 'Research sync: pulled.');
  }

  async syncPrepareCommand(): Promise<void> {
    const result = await this.withSync((sync) => sync.prepare());
    this.report(`prepare: ${result.ok ? 'ready' : 'not ready'}`, [...result.checks.map((check) => `${check.ok ? (check.warning ? 'WARN' : 'PASS') : 'FAIL'} ${check.name}${check.details.length ? `: ${check.details.join(' | ')}` : ''}`), ...result.summary]);
    this.output.show(true);
    if (result.ok) {
      const choice = await vscode.window.showInformationMessage('Research is ready to share.', 'Publish…');
      if (choice) await this.syncPublishCommand();
    } else void vscode.window.showWarningMessage('Research is not ready to share; see the FAIL items in Output.');
  }

  async syncPublishCommand(): Promise<void> {
    const result = await this.withSync((sync) => sync.publish(async (preview) => this.confirmPublish([
      `To: ${preview.targets.join(' and ')}`,
      preview.files.length ? `Commit ${preview.files.length} file(s):\n${preview.files.slice(0, 25).map((entry) => `${entry.code.trim() || '?'} ${entry.path}`).join('\n')}` : '',
      preview.ahead ? `Plus ${preview.ahead} local commit(s).` : '',
      `Message:\n${preview.message}`,
    ].filter(Boolean).join('\n\n'))));
    this.report(`publish: ${result.status}`, [...result.summary, ...result.warnings.map((line) => `WARNING ${line}`)]);
    if (result.status === 'published') void vscode.window.showInformationMessage(result.summary[result.summary.length - 1] ?? 'Published.');
    else if (result.status !== 'blocked' || result.warnings.length) { this.output.show(true); void vscode.window.showWarningMessage(`Research publish: ${result.summary[result.summary.length - 1] ?? result.status}`); }
  }

  async captureIdeaCommand(): Promise<void> {
    const title = await vscode.window.showInputBox({ title: 'Capture idea · title', ignoreFocusOut: true });
    if (!title) return;
    const body = await vscode.window.showInputBox({ title: 'Capture idea · body', prompt: 'Intuition, gap, approach, or test case', ignoreFocusOut: true });
    if (!body) return;
    const id = await this.withCore((core) => core.saveIdea(title, body, [], 'researcher'));
    void vscode.window.showInformationMessage(`Saved idea ${id}. Ask the agent to "discuss idea ${id}" to turn it into results and plans.`);
  }
}
