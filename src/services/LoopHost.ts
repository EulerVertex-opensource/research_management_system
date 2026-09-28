import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import matter from 'gray-matter';
import { FileService } from './FileService';
import { ProjectPaths } from '../models/types';
import { ResearchLoopCore } from './ResearchLoopCore';
import { AgentProvider, ApprovalKind, BRIDGE_PATH, BRIDGE_REGISTRY, BridgeEntry, LoopState, QuestionKind, STATE_PATH } from './ResearchLoopModel';

type ToolResult = Record<string, unknown>;

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

  constructor(private readonly files: FileService, private readonly output: vscode.OutputChannel) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = 'research-assistant.loop.openChat';
    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => { void this.onEditorSave(document); }));
  }

  configure(paths: ProjectPaths): void {
    this.paths = paths;
    if (this.core) this.core.setPaths(paths);
    else this.core = new ResearchLoopCore(this.files, paths, { iterationCap: setting('iterationCap', 10) });
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.files.rootUri, STATE_PATH));
    const refresh = () => { void this.refreshStatusBar(); };
    this.watcher.onDidChange(refresh); this.watcher.onDidCreate(refresh); this.watcher.onDidDelete(refresh);
    void this.startBridge();
    void this.refreshStatusBar();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.statusBar.dispose();
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
    try { status = matter(document.getText()).data.status; } catch { return; }
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
    const wait = typeof args.wait_seconds === 'number' ? args.wait_seconds : setting('questionTimeoutSeconds', 240);
    if (name === 'ask_researcher') return this.askResearcher(String(args.question ?? ''), (args.kind as QuestionKind) ?? 'discussion', typeof args.asset_id === 'string' ? args.asset_id : undefined, Array.isArray(args.options) ? args.options.map(String) : undefined, wait);
    if (name === 'request_approval') return this.requestApproval(args.kind as ApprovalKind, String(args.target ?? ''), String(args.summary ?? ''), wait);
    if (name === 'record_idea') return this.withCore(async (core) => ({ ok: true, idea_id: await core.saveIdea(String(args.title ?? ''), String(args.body ?? ''), Array.isArray(args.related_assets) ? args.related_assets.map(String) : [], 'agent') }));
    if (name === 'loop_status') return this.withCore(async (core) => ({ ok: true, state: core.statusSummary(), brief: core.briefStatus() }));
    return { answered: false, reason: `unknown tool ${name}` };
  }

  private timeout<T>(ms: number): Promise<T | 'timeout'> { return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)); }

  private async askResearcher(prompt: string, kind: QuestionKind, assetId: string | undefined, options: string[] | undefined, waitSeconds: number): Promise<ToolResult> {
    const question = await this.withCore((core) => core.askQuestion(kind, prompt, { assetId, options, timeoutSec: waitSeconds }));
    const popup = this.showQuestion(prompt, kind, options);
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'answer' | 'skip' | 'pause'; text: string }>(waitSeconds * 1000)]);
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

  private async requestApproval(kind: ApprovalKind, target: string, summary: string, waitSeconds: number): Promise<ToolResult> {
    if (!this.paths) throw new Error('Project paths are not configured.');
    const request = await this.withCore((core) => core.enqueueApproval(kind, target, summary));
    const popup = this.showApproval(kind, target, summary);
    const outcome = await Promise.race([popup, this.timeout<{ decision: 'approved' | 'changes_requested' | 'later'; text: string }>(waitSeconds * 1000)]);
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
    const configured = setting<'auto' | 'claude' | 'codex'>('provider', 'auto');
    if (configured !== 'auto') return configured;
    if (vscode.extensions.getExtension('anthropic.claude-code')) return 'claude';
    if (vscode.extensions.getExtension('openai.chatgpt')) return 'codex';
    return undefined;
  }

  async openChat(provider?: AgentProvider): Promise<void> {
    const target = provider ?? this.preferredProvider();
    try {
      if (target === 'claude' && vscode.extensions.getExtension('anthropic.claude-code')) { await vscode.commands.executeCommand('claude-vscode.sidebar.open'); return; }
      if (target === 'codex' && vscode.extensions.getExtension('openai.chatgpt')) { await vscode.commands.executeCommand('chatgpt.openSidebar'); return; }
    } catch (error: unknown) { this.output.appendLine(`[loop] Could not open the chat: ${String(error)}`); }
    void vscode.window.showInformationMessage('Install the Claude Code or Codex VS Code extension, then type /research-loop (Claude Code) or $research-loop (Codex) in its chat.');
  }

  async startCommand(): Promise<void> {
    const picked = await vscode.window.showQuickPick([
      { label: 'Claude Code', description: 'type /research-loop in the Claude Code chat', provider: 'claude' as AgentProvider },
      { label: 'Codex', description: 'type $research-loop in the Codex chat', provider: 'codex' as AgentProvider },
    ], { title: 'Research Assistant · Start research loop', placeHolder: 'Which agent chat will drive the loop?' });
    if (!picked) return;
    const goal = await vscode.window.showInputBox({ title: 'Research goal', prompt: 'Describe the research goal, the main claim, and constraints (optional; the agent can ask).', ignoreFocusOut: true });
    if (goal === undefined) return;
    await this.withCore((core) => core.start(picked.provider, { goal, force: true }));
    await this.openChat(picked.provider);
    const hint = picked.provider === 'claude' ? 'Type /research-loop in the Claude Code chat.' : 'Type $research-loop in the Codex chat.';
    void vscode.window.showInformationMessage(`Research loop started. ${hint}`);
  }

  async extendCommand(): Promise<void> {
    const goal = await vscode.window.showInputBox({ title: 'Extend the research project', prompt: 'Describe the new goal or conjecture to add. Existing approved results are kept.', ignoreFocusOut: true });
    if (!goal?.trim()) return;
    const state = await this.withCore(async (core) => { await core.extend(goal, { provider: core.current?.provider ?? this.preferredProvider(), force: true }); return core.current; });
    await this.openChat(state?.provider);
    const hint = state?.provider === 'codex' ? 'Type $research-loop in the Codex chat.' : 'Type /research-loop in the Claude Code chat.';
    void vscode.window.showInformationMessage(`Research loop reopened to add the new goal. ${hint}`);
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

  async captureIdeaCommand(): Promise<void> {
    const title = await vscode.window.showInputBox({ title: 'Capture idea · title', ignoreFocusOut: true });
    if (!title) return;
    const body = await vscode.window.showInputBox({ title: 'Capture idea · body', prompt: 'Intuition, gap, approach, or test case', ignoreFocusOut: true });
    if (!body) return;
    const id = await this.withCore((core) => core.saveIdea(title, body, [], 'researcher'));
    void vscode.window.showInformationMessage(`Saved idea ${id}. Ask the agent to "discuss idea ${id}" to turn it into results and plans.`);
  }
}
