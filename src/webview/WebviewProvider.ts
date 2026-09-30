import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FileService } from '../services/FileService';
import { NodeIndexService } from '../services/NodeIndexService';
import { PaperIndexService } from '../services/PaperIndexService';
import { WebviewMessage, ExtensionMessage } from '../models/messages';
import { NodeType, ResearchNode, ResearchStatus, UIState, DEFAULT_UI_STATE, ProjectPaths, ResearchAssistantConfig, ManuscriptBuildPhase, ManuscriptStatus } from '../models/types';
import { generateAgentInstructions } from '../services/CopilotInstructionsService';
import { SkillInstallerService } from '../services/SkillInstallerService';
import { ProjectConfigService } from '../services/ProjectConfigService';
import { LATEX_OUTPUT_DIRECTORY } from '../services/FileService';
import { ManuscriptBuildService } from '../services/ManuscriptBuildService';
import { requirePaperPdfPath } from '../services/PaperPdfPath';
import { AgentIntegrationService } from '../services/AgentIntegrationService';
import { LoopHost } from '../services/LoopHost';
import { parseWritingOutline } from '../services/ManuscriptWriting';
import { summarizeProject } from '../domain/project';
import { OverlayFiles, migrateProject, migrationReasons } from '../services/SchemaMigration';

const UI_STATE_KEY = 'researchAssistant.uiState';

export class WebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private watchers: vscode.Disposable[] = [];
  /** Index problems last shown, so a refresh only raises new ones. */
  private reportedProblems = '';
  private migrationOffered = false;
  private startup: Promise<void> | undefined;

  private readonly fileService: FileService;
  private readonly configService: ProjectConfigService;
  private nodeIndex: NodeIndexService | undefined;
  private paperIndex: PaperIndexService | undefined;
  private paths: ProjectPaths | undefined;
  private readonly skillInstaller: SkillInstallerService;
  private readonly agentIntegration: AgentIntegrationService;
  readonly loopHost: LoopHost;
  private integrationEnsured = false;
  private readonly context: vscode.ExtensionContext;
  private readonly manuscriptBuildService: ManuscriptBuildService;
  private manuscriptPhase: ManuscriptBuildPhase = 'idle';
  private manuscriptMessage: string | undefined;
  private readonly output: vscode.OutputChannel;
  /** The Graph tab asked for data at least once; only then are updates pushed. */
  private graphWanted = false;
  private graphTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: vscode.ExtensionContext, workspaceRoot: vscode.Uri, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
    this.fileService = new FileService(workspaceRoot);
    this.configService = new ProjectConfigService(this.fileService);
    this.skillInstaller = new SkillInstallerService(context.extensionUri, this.fileService);
    this.agentIntegration = new AgentIntegrationService(this.fileService, context.extensionUri.fsPath, output);
    this.loopHost = new LoopHost(this.fileService, output);
    this.manuscriptBuildService = new ManuscriptBuildService(this.fileService, workspaceRoot);
    this.loopHost.onDidChangeState(() => this.scheduleGraph());
  }

  start(): Promise<void> {
    this.startup ??= this.loadProject().catch((error: unknown) => {
      this.startup = undefined;
      throw error;
    });
    return this.startup;
  }

  dispose(): void {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
    this.loopHost.dispose();
  }

  async open(): Promise<void> {
    await this.start();
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'researchDashboard',
      'Research Assistant',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview'),
          vscode.Uri.joinPath(this.fileService.rootUri, LATEX_OUTPUT_DIRECTORY),
        ],
      }
    );

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Attach message listeners before loading HTML: the webview posts `ready`
    // as soon as React mounts, and losing it leaves all panels uninitialized.
    this.panel.webview.html = this.getHtml();
  }

  /**
   * Recreate missing project scaffolding, reinstall bundled skills for every
   * supported agent, and regenerate the agent instruction and workflow files.
   * Existing research files are preserved by ensureProjectStructure().
   */
  async refreshProject(showConfirmation = false): Promise<void> {
    const startedAt = Date.now();
    this.output.appendLine(`[refresh] Starting for ${this.fileService.rootUri.fsPath}`);
    try {
      const config = await this.configService.loadOrDiscover();
      const paths = this.configService.resolvePaths(config);
      const mainAlreadyExists = await this.fileService.exists(paths.mainTex);
      const bundledSkillNames = await this.skillInstaller.listBundledSkillNames();
      this.output.appendLine(`[refresh] Layout: ${config.layout}; main TeX: ${paths.mainTex}`);

      await this.configService.save(config);
      this.output.appendLine('[refresh] Saved .research-assistant.json');

      await this.fileService.ensureProjectStructure(config, paths, !mainAlreadyExists, bundledSkillNames);
      this.output.appendLine('[refresh] Reconciled scaffold, .gitignore, .vscode settings, extension recommendations, and .latex-out');

      await this.skillInstaller.installBundledSkills(bundledSkillNames);
      this.output.appendLine('[refresh] Installed bundled agent skills');
      await this.agentIntegration.ensure(paths);
      this.integrationEnsured = true;
      this.output.appendLine('[refresh] Ensured Claude Code and Codex hooks and MCP configuration');

      this.configureServices(paths);
      const [nodes, papers] = await Promise.all([
        this.refreshIndex(),
        this.paperIndex!.getPapers(),
      ]);
      await generateAgentInstructions(nodes, this.fileService, paths);
      this.output.appendLine('[refresh] Regenerated agent guidance');
      this.setupFileWatchers();
      this.output.appendLine('[refresh] Restarted project and manuscript PDF watchers');

      const projectRoot = this.fileService.rootUri.fsPath;
      const uiState = this.getSavedUIState();
      this.send({ type: 'init', nodes, projectRoot, uiState, initialized: true, paths: this.pathSummary(config, paths) });
      this.send({ type: 'papersData', papers });
      await this.sendManuscriptStatus();
      await this.sendProjectMd();

      this.output.appendLine(`[refresh] Completed in ${Date.now() - startedAt} ms`);
      if (showConfirmation) {
        void vscode.window.showInformationMessage(
          'Research Assistant: refreshed project paths, shared scaffold, agent guidance, LaTeX build settings, and manuscript preview.'
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[refresh] FAILED after ${Date.now() - startedAt} ms: ${message}`);
      if (error instanceof Error && error.stack) this.output.appendLine(error.stack);
      this.output.show(true);
      throw error;
    }
  }

  private async loadProject(): Promise<void> {
    const initialized = await this.configService.hasSavedConfig();
    const config = await this.configService.loadOrDiscover();
    const paths = this.configService.resolvePaths(config);
    this.configureServices(paths);
    if (initialized) {
      const reinstalled = await this.skillInstaller.ensureCurrentDrivers().catch((error: unknown) => { this.output.appendLine(`[skills] Could not check the loop driver: ${String(error)}`); return false; });
      if (reinstalled) this.output.appendLine('[skills] Project skills and loop driver were older than this extension; reinstalled them.');
    }
    if (initialized && !this.integrationEnsured) {
      this.integrationEnsured = true;
      await this.agentIntegration.ensure(paths).catch((error: unknown) => this.output.appendLine(`[agents] ${String(error)}`));
    }
    const [nodes, papers] = await Promise.all([
      this.refreshIndex(),
      this.paperIndex!.getPapers(),
    ]);
    this.setupFileWatchers();
    this.send({
      type: 'init',
      nodes,
      projectRoot: this.fileService.rootUri.fsPath,
      uiState: this.getSavedUIState(),
      initialized,
      paths: this.pathSummary(config, paths),
    });
    this.send({ type: 'papersData', papers });
    await this.sendManuscriptStatus();
    if (initialized) {
      await this.sendProjectMd();
      void this.offerSchemaMigration(paths).catch((error: unknown) => this.output.appendLine(`[migrate] ${String(error)}`));
    }
  }

  /** Once per session, offer to upgrade a project written in an older research schema; previews before writing. */
  private async offerSchemaMigration(paths: ProjectPaths): Promise<void> {
    if (this.migrationOffered) return;
    const reasons = await migrationReasons(this.fileService, paths);
    if (!reasons.length) return;
    this.migrationOffered = true;
    const choice = await vscode.window.showInformationMessage(
      `Research Assistant: this project uses an older research file format (${reasons.join('; ')}). Migrate it now? You will see the changes first.`,
      'Preview Migration', 'Later'
    );
    if (choice !== 'Preview Migration') return;
    const overlay = new OverlayFiles(this.fileService);
    const report = await migrateProject(overlay, paths);
    const changes = await overlay.changes();
    this.output.appendLine(`[migrate] ${changes.length} file change(s):`);
    for (const change of changes) this.output.appendLine(`  ${change.after === null ? 'DELETE' : change.before === undefined ? 'CREATE' : 'UPDATE'} ${change.file}`);
    for (const note of report.notes) this.output.appendLine(`  NOTE ${note}`);
    for (const item of report.review) this.output.appendLine(`  REVIEW ${item}`);
    this.output.show(true);
    const apply = await vscode.window.showWarningMessage(
      `Apply the migration to ${changes.length} file(s)?`,
      { modal: true, detail: `${[...report.notes, ...report.review.map((item) => `Review: ${item}`)].slice(0, 12).join('\n')}\n\nThe full list is in the Research Assistant output. Commit your work first so you can review the migration with git diff.` },
      'Apply'
    );
    if (apply !== 'Apply') return;
    await overlay.flush();
    this.output.appendLine('[migrate] Applied. Review with git diff before committing.');
    await this.refreshNodes();
    await this.sendProjectMd();
  }

  private configureServices(paths: ProjectPaths): void {
    this.paths = paths;
    this.nodeIndex = new NodeIndexService(this.fileService, paths);
    this.paperIndex = new PaperIndexService(this.fileService, paths);
    this.loopHost.configure(paths);
  }

  /** Refresh the node index and surface duplicate IDs or dependency errors once per change. */
  private async refreshIndex(): Promise<ResearchNode[]> {
    const nodes = await this.nodeIndex!.refresh();
    const problems = this.nodeIndex!.getProblems();
    const signature = problems.join('\n');
    if (signature !== this.reportedProblems) {
      this.reportedProblems = signature;
      for (const problem of problems) this.output.appendLine(`[nodes] ${problem}`);
      if (problems.length) this.send({ type: 'error', message: problems.length === 1 ? problems[0] : `${problems[0]} (+${problems.length - 1} more; see the Research Assistant output)` });
    }
    return nodes;
  }

  private pathSummary(config: ResearchAssistantConfig, paths: ProjectPaths) {
    return {
      layout: config.layout,
      mainTex: paths.mainTex,
      bibliography: paths.bibliography,
      macroFiles: paths.macroFiles,
      notations: paths.notations,
      sections: paths.sections,
      projectMd: paths.projectMd,
      paperIndex: paths.paperIndex,
      assets: paths.assets,
      definitions: paths.definitions,
      ideas: paths.ideas,
      plans: paths.plans,
      papers: paths.papers,
      localSourcePdfs: paths.localSourcePdfs,
    };
  }

  private setupFileWatchers(): void {
    if (!this.paths || !this.nodeIndex || !this.paperIndex) return;
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
    const root = this.fileService.rootUri;
    const paths = this.paths;

    // Watch shared asset and idea node files.
    const nodeWatchers = [paths.assets, paths.definitions, paths.ideas, paths.plans].map((folder) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `${folder}/*.md`))
    );

    const onNodeFileChange = async (uri: vscode.Uri) => {
      try {
        const changedId = uri.path.split('/').pop()?.replace(/\.md$/, '');
        if (changedId && (uri.path.includes(`/${paths.assets}/`) || uri.path.includes(`/${paths.definitions}/`))) await this.loopHost.reconcile(changedId);
        const nodes = await this.refreshIndex();
        this.send({ type: 'nodesUpdated', nodes });
        this.scheduleGraph();
        generateAgentInstructions(nodes, this.fileService, paths).catch(() => {});

        const filename = uri.path.split('/').pop();
        if (filename?.endsWith('.md')) {
          const id = filename.slice(0, -3);
          if (this.nodeIndex!.getById(id)) {
            const detail = await this.nodeIndex!.getNodeDetail(id);
            this.send({ type: 'nodeDetail', id, ...detail });
          }
        }
      } catch { /* non-fatal */ }
    };

    const onNodeFileDelete = async () => {
      try {
        const nodes = await this.refreshIndex();
        this.send({ type: 'nodesUpdated', nodes });
        this.scheduleGraph();
        generateAgentInstructions(nodes, this.fileService, paths).catch(() => {});
      } catch { /* non-fatal */ }
    };

    const [assetWatcher, definitionWatcher, ideaWatcher, planWatcher] = nodeWatchers;
    assetWatcher.onDidChange((uri) => { void onNodeFileChange(uri); });
    assetWatcher.onDidCreate((uri) => { void onNodeFileChange(uri); });
    assetWatcher.onDidDelete(() => { void onNodeFileDelete(); });
    definitionWatcher.onDidChange((uri) => { void onNodeFileChange(uri); });
    definitionWatcher.onDidCreate((uri) => { void onNodeFileChange(uri); });
    definitionWatcher.onDidDelete(() => { void onNodeFileDelete(); });
    ideaWatcher.onDidChange((uri) => { void onNodeFileChange(uri); });
    ideaWatcher.onDidCreate((uri) => { void onNodeFileChange(uri); });
    ideaWatcher.onDidDelete(() => { void onNodeFileDelete(); });
    planWatcher.onDidChange((uri) => { void onNodeFileChange(uri); });
    planWatcher.onDidCreate((uri) => { void onNodeFileChange(uri); });
    planWatcher.onDidDelete(() => { void onNodeFileDelete(); });

    // Watch the configured project description.
    const projectWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, paths.projectMd)
    );
    projectWatcher.onDidChange(async () => {
      try { await this.sendProjectMd(); } catch { /* non-fatal */ }
      this.scheduleGraph();
    });

    // Manuscript plans, locks, section TeX, and shared approvals feed the Graph tab.
    const graphWatchers = [`${paths.writingRoot}/**`, `${paths.sections}/*.tex`, `${paths.researchRoot === '.' ? '' : `${paths.researchRoot}/`}approvals/**`].map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern));
      const refresh = () => this.scheduleGraph();
      watcher.onDidChange(refresh); watcher.onDidCreate(refresh); watcher.onDidDelete(refresh);
      return watcher;
    });

    // Watch the configured paper index and bibliography.
    const refreshPapers = async () => {
      try {
        const papers = await this.paperIndex!.getPapers();
        this.send({ type: 'papersData', papers });
      } catch { /* non-fatal */ }
    };

    const papersWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, paths.paperIndex)
    );
    papersWatcher.onDidChange(refreshPapers);
    papersWatcher.onDidCreate(refreshPapers);

    const bibWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, paths.bibliography)
    );
    bibWatcher.onDidChange(refreshPapers);

    const pdfWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, this.manuscriptBuildService.outputPdfPath(paths))
    );
    const refreshPdf = async () => {
      this.manuscriptPhase = 'succeeded';
      this.manuscriptMessage = undefined;
      await this.sendManuscriptStatus();
    };
    pdfWatcher.onDidChange(refreshPdf);
    pdfWatcher.onDidCreate(refreshPdf);
    pdfWatcher.onDidDelete(async () => {
      this.manuscriptPhase = 'idle';
      this.manuscriptMessage = undefined;
      await this.sendManuscriptStatus();
    });

    this.watchers = [...nodeWatchers, projectWatcher, ...graphWatchers, papersWatcher, bibWatcher, pdfWatcher];
  }

  private async sendManuscriptStatus(forceReload = false): Promise<void> {
    if (!this.paths || !this.panel) return;
    const outputPdf = this.manuscriptBuildService.outputPdfPath(this.paths);
    const outputUri = this.fileService.resolve(outputPdf);
    const installed = this.manuscriptBuildService.isLatexWorkshopInstalled();
    const status: ManuscriptStatus = {
      phase: installed ? this.manuscriptPhase : 'unavailable',
      mainTex: this.paths.mainTex,
      outputPdf,
      latexWorkshopInstalled: installed,
      autoBuild: this.manuscriptBuildService.isAutoBuildEnabled(),
      configurationConflicts: this.manuscriptBuildService.configurationConflicts(),
      message: installed ? this.manuscriptMessage : 'LaTeX Workshop is not installed.',
    };
    try {
      const stat = await vscode.workspace.fs.stat(outputUri);
      const version = forceReload ? Date.now() : stat.mtime;
      const versionedUri = outputUri.with({ query: `v=${version}` });
      status.pdfUri = this.panel.webview.asWebviewUri(versionedUri).toString();
      status.pdfVersion = version;
    } catch {
      // The empty state explains that the manuscript has not been built yet.
    }
    this.output.appendLine(
      `[manuscript] Main: ${status.mainTex}; PDF: ${status.pdfUri ? 'found' : 'missing'} (${status.outputPdf}); phase: ${status.phase}`
    );
    this.send({ type: 'manuscriptStatus', status });
  }

  /** Coalesce bursts of file events (an agent writing several files) into one Graph refresh. */
  private scheduleGraph(): void {
    if (!this.graphWanted || !this.panel) return;
    if (this.graphTimer) clearTimeout(this.graphTimer);
    this.graphTimer = setTimeout(() => { this.graphTimer = undefined; void this.sendGraph(); }, 300);
  }

  private async sendGraph(): Promise<void> {
    if (!this.nodeIndex || !this.panel) return;
    try {
      this.send({ type: 'graphData', payload: await this.loopHost.graphPayload(this.nodeIndex.getAll()) });
    } catch (error: unknown) {
      this.output.appendLine(`[graph] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private send(message: ExtensionMessage): void {
    this.panel?.webview.postMessage(message);
  }

  private getSavedUIState(): UIState {
    const saved = this.context.globalState.get<Partial<UIState>>(UI_STATE_KEY);
    if (!saved) return DEFAULT_UI_STATE;
    return { ...DEFAULT_UI_STATE, ...saved };
  }

  /** project.md plus what the dashboard derives for it (progress, open questions, writing order). */
  private async sendProjectMd(): Promise<void> {
    if (!this.paths) return;
    const content = await this.fileService.readFile(this.paths.projectMd).catch(() => '');
    const outline = await this.fileService.readFile(this.paths.writingOutline).catch(() => '');
    let writingSections: string[] = [];
    try { writingSections = outline ? parseWritingOutline(outline).map((section) => section.title) : []; } catch { /* no sections yet */ }
    const summary = summarizeProject(content, this.nodeIndex?.getAll() ?? [], writingSections);
    this.send({ type: 'projectMd', content, summary });
  }

  private async refreshNodes(): Promise<void> {
    if (!this.nodeIndex || !this.paths) return;
    const nodes = await this.refreshIndex();
    this.send({ type: 'nodesUpdated', nodes });
    this.scheduleGraph();
    generateAgentInstructions(nodes, this.fileService, this.paths).catch(() => { /* non-fatal */ });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          this.output.appendLine('[webview] Dashboard ready; loading project and manuscript preview');
          await this.loadProject();
          break;
        }

        case 'initProject': {
          await this.refreshProject(true);
          break;
        }

        case 'refreshProject': {
          await this.refreshProject(true);
          break;
        }

        case 'getManuscriptStatus': {
          await this.sendManuscriptStatus();
          break;
        }

        case 'reloadManuscript': {
          await this.sendManuscriptStatus(true);
          break;
        }

        case 'buildManuscript': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          this.manuscriptPhase = 'compiling';
          this.manuscriptMessage = undefined;
          await this.sendManuscriptStatus();
          try {
            await this.manuscriptBuildService.build(
              this.paths,
              this.panel?.viewColumn,
              () => this.panel?.reveal(this.panel.viewColumn, false)
            );
            this.manuscriptPhase = 'succeeded';
            this.manuscriptMessage = undefined;
          } catch (error: unknown) {
            this.manuscriptPhase = this.manuscriptBuildService.isLatexWorkshopInstalled() ? 'failed' : 'unavailable';
            this.manuscriptMessage = error instanceof Error ? error.message : String(error);
          }
          await this.sendManuscriptStatus(true);
          break;
        }

        case 'openManuscriptPdf': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          const outputPdf = this.manuscriptBuildService.outputPdfPath(this.paths);
          if (!(await this.fileService.exists(outputPdf))) throw new Error('Compile the manuscript before opening its PDF.');
          await vscode.env.openExternal(this.fileService.resolve(outputPdf));
          break;
        }

        case 'setManuscriptAutoBuild': {
          await this.manuscriptBuildService.setAutoBuild(msg.enabled);
          await this.sendManuscriptStatus();
          break;
        }

        case 'applyLatexBuildSettings': {
          await this.manuscriptBuildService.applyRecommendedSettings();
          this.manuscriptPhase = 'idle';
          this.manuscriptMessage = undefined;
          await this.sendManuscriptStatus();
          break;
        }

        case 'installLatexWorkshop': {
          await this.manuscriptBuildService.installLatexWorkshop();
          await this.sendManuscriptStatus();
          break;
        }

        case 'getNodeContent': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          const { frontmatter, body } = await this.nodeIndex.getNodeDetail(msg.id);
          this.send({ type: 'nodeDetail', id: msg.id, frontmatter, body });
          break;
        }

        case 'saveNode': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.nodeIndex.saveNode(msg.id, msg.frontmatter, msg.body);
          if (msg.frontmatter.status === 'approved') await this.loopHost.recordApprovalIfHuman(msg.id, 'dashboard');
          await this.refreshNodes();
          const updated = await this.nodeIndex.getNodeDetail(msg.id);
          this.send({ type: 'nodeDetail', id: msg.id, ...updated });
          break;
        }

        case 'getProjectMd': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          await this.sendProjectMd();
          break;
        }

        case 'saveProjectMd': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          await this.fileService.writeFile(this.paths.projectMd, msg.content);
          break;
        }

        case 'getPapers': {
          if (!this.paperIndex) throw new Error('Initialize the Research Assistant project first.');
          const papers = await this.paperIndex.getPapers();
          this.send({ type: 'papersData', papers });
          break;
        }

        case 'savePaper': {
          if (!this.paperIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.paperIndex.savePaper(msg.originalSlug, msg.slug, msg.mdSection, msg.bibEntry);
          // File watchers will fire and push papersData automatically
          break;
        }

        case 'saveUIState': {
          await this.context.globalState.update(UI_STATE_KEY, msg.uiState);
          break;
        }

        case 'createNode': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.nodeIndex.createNode(msg.nodeType as NodeType, msg.title, msg.targetAsset);
          await this.refreshNodes();
          break;
        }

        case 'updateStatus': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.nodeIndex.updateStatus(msg.id, msg.status as ResearchStatus);
          if (msg.status === 'approved') await this.loopHost.recordApprovalIfHuman(msg.id, 'dashboard');
          await this.refreshNodes();
          break;
        }

        case 'openInEditor': {
          const uri = this.fileService.resolve(msg.filePath);
          await vscode.window.showTextDocument(uri);
          break;
        }

        case 'openFile': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          const paperPdf = await requirePaperPdfPath(msg.filePath, this.paths.localSourcePdfs, async (filePath) => {
            const stat = await vscode.workspace.fs.stat(this.fileService.resolve(filePath));
            return Boolean(stat.type & vscode.FileType.File) && !(stat.type & vscode.FileType.SymbolicLink);
          });
          const uri = this.fileService.resolve(paperPdf);
          // Use the same VS Code PDF viewer as the dashboard's Open PDF button.
          await vscode.commands.executeCommand('vscode.open', uri);
          break;
        }

        case 'getGraph': {
          this.graphWanted = true;
          await this.sendGraph();
          break;
        }

        case 'graphAction': {
          await this.loopHost.graphAction(msg.request);
          if (msg.request.action !== 'agent' && msg.request.action !== 'openNode' && msg.request.action !== 'openTex') await this.sendGraph();
          break;
        }

        case 'addPaper': {
          if (!this.paths) throw new Error('Initialize the Research Assistant project first.');
          const pdfBytes = Buffer.from(msg.fileData, 'base64');
          const sourceSha256 = crypto.createHash('sha256').update(pdfBytes).digest('hex');
          await this.fileService.writeBinary(`${this.paths.localSourcePdfs}/${msg.slug}.pdf`, pdfBytes);

          const currentBib = await this.fileService.readFile(this.paths.bibliography).catch(() => '');
          const newBib = currentBib.trimEnd() + '\n\n' + msg.bibEntry.trim() + '\n';
          await this.fileService.writeFile(this.paths.bibliography, newBib);

          const currentPapers = await this.fileService.readFile(this.paths.paperIndex).catch(() => '');
          const lines = [`## ${msg.slug}`, '', `- Local file: \`${this.paths.localSourcePdfs}/${msg.slug}.pdf\``];
          if (msg.sourceUrl) lines.push(`- Source URL: ${msg.sourceUrl}`);
          lines.push(`- SHA-256: \`${sourceSha256}\``);
          if (msg.description) lines.push(`- Description: ${msg.description}`);
          const newPapers = currentPapers.trimEnd() + '\n\n' + lines.join('\n') + '\n';
          await this.fileService.writeFile(this.paths.paperIndex, newPapers);
          // File watchers will fire and push papersData
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[webview:${msg.type}] ${message}`);
      if (err instanceof Error && err.stack) this.output.appendLine(err.stack);
      this.send({ type: 'error', message });
    }
  }

  private getHtml(): string {
    const webview = this.panel!.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.js')
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.css')
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'pdf.worker.min.mjs')
    );
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             worker-src ${webview.cspSource} blob:;
             connect-src ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Research Assistant</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; width: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: 14px;
    }

    /* Markdown prose styles for .md-preview */
    .md-preview { font-size: 14px; line-height: 1.8; }
    .md-preview h1 { font-size: 1.6em; font-weight: 700; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
    .md-preview h2 { font-size: 1.3em; font-weight: 600; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
    .md-preview h3 { font-size: 1.1em; font-weight: 600; margin: 0.7em 0 0.3em; }
    .md-preview h4, .md-preview h5, .md-preview h6 { font-size: 1em; font-weight: 600; margin: 0.6em 0 0.3em; }
    .md-preview p { margin: 0.5em 0; }
    .md-preview.md-inline { display: inline; font-size: inherit; line-height: 1.5; }
    .md-preview.md-inline p { display: inline; margin: 0; }
    .md-preview ul, .md-preview ol { padding-left: 1.6em; margin: 0.4em 0; }
    .md-preview li { margin: 0.15em 0; }
    .md-preview li input[type="checkbox"] { margin-right: 0.4em; }
    .md-preview blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 0.5em 0; padding: 0.2em 0.8em; opacity: 0.8; }
    .md-preview code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: var(--vscode-textCodeBlock-background); padding: 0.1em 0.35em; border-radius: 3px; }
    .md-preview pre { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 0.8em 1em; margin: 0.6em 0; overflow-x: auto; }
    .md-preview pre code { background: none; padding: 0; font-size: 0.88em; }
    .md-preview table { border-collapse: collapse; margin: 0.6em 0; width: 100%; }
    .md-preview th, .md-preview td { border: 1px solid var(--vscode-panel-border); padding: 0.35em 0.7em; text-align: left; }
    .md-preview th { background: var(--vscode-list-hoverBackground); font-weight: 600; }
    .md-preview a { color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: pointer; }
    .md-preview hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 1em 0; }
    .md-preview .katex-display { overflow-x: auto; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__RESEARCH_ASSISTANT_PDF_WORKER__ = ${JSON.stringify(pdfWorkerUri.toString())};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
