import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FileService } from '../services/FileService';
import { NodeIndexService } from '../services/NodeIndexService';
import { PaperIndexService } from '../services/PaperIndexService';
import { WebviewMessage, ExtensionMessage } from '../models/messages';
import { NodeType, NodeStatus, UIState, DEFAULT_UI_STATE, ProjectPaths, ResearchAssistantConfig } from '../models/types';
import { generateAgentInstructions } from '../services/CopilotInstructionsService';
import { SkillInstallerService } from '../services/SkillInstallerService';
import { ProjectConfigService } from '../services/ProjectConfigService';

const UI_STATE_KEY = 'researchAssistant.uiState';

export class WebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private watchers: vscode.Disposable[] = [];

  private readonly fileService: FileService;
  private readonly configService: ProjectConfigService;
  private nodeIndex: NodeIndexService | undefined;
  private paperIndex: PaperIndexService | undefined;
  private paths: ProjectPaths | undefined;
  private readonly skillInstaller: SkillInstallerService;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, workspaceRoot: vscode.Uri) {
    this.context = context;
    this.fileService = new FileService(workspaceRoot);
    this.configService = new ProjectConfigService(this.fileService);
    this.skillInstaller = new SkillInstallerService(context.extensionUri, this.fileService);
  }

  async open(): Promise<void> {
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
        ],
      }
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.watchers.forEach((w) => w.dispose());
      this.watchers = [];
    });
  }

  /**
   * Recreate missing project scaffolding, reinstall bundled skills for every
   * supported agent, and regenerate the agent instruction and workflow files.
   * Existing research files are preserved by ensureProjectStructure().
   */
  async refreshProject(showConfirmation = false): Promise<void> {
    const config = await this.configService.loadOrDiscover();
    const paths = this.configService.resolvePaths(config);
    const mainAlreadyExists = await this.fileService.exists(paths.mainTex);
    await this.configService.save(config);
    await this.fileService.ensureProjectStructure(config, paths, !mainAlreadyExists);
    await this.skillInstaller.installBundledSkills();

    this.configureServices(paths);

    const [nodes, papers] = await Promise.all([
      this.nodeIndex!.refresh(),
      this.paperIndex!.getPapers(),
    ]);
    await generateAgentInstructions(nodes, this.fileService, paths);
    this.setupFileWatchers();

    const projectRoot = this.fileService.rootUri.fsPath;
    const uiState = this.getSavedUIState();
    this.send({ type: 'init', nodes, projectRoot, uiState, initialized: true, paths: this.pathSummary(config, paths) });
    this.send({ type: 'papersData', papers });
    const projectContent = await this.fileService.readFile(paths.projectMd).catch(() => '');
    this.send({ type: 'projectMd', content: projectContent });

    if (showConfirmation) {
      void vscode.window.showInformationMessage(
        'Research Assistant: refreshed Codex and Claude Code skills and project guidance.'
      );
    }
  }

  private async loadProject(): Promise<void> {
    const initialized = await this.configService.hasSavedConfig();
    const config = await this.configService.loadOrDiscover();
    const paths = this.configService.resolvePaths(config);
    this.configureServices(paths);

    const [nodes, papers] = await Promise.all([
      this.nodeIndex!.refresh(),
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
    if (initialized) {
      const content = await this.fileService.readFile(paths.projectMd).catch(() => '');
      this.send({ type: 'projectMd', content });
    }
  }

  private configureServices(paths: ProjectPaths): void {
    this.paths = paths;
    this.nodeIndex = new NodeIndexService(this.fileService, paths);
    this.paperIndex = new PaperIndexService(this.fileService, paths);
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
      ideas: paths.ideas,
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
    const nodeWatchers = [paths.assets, paths.ideas].map((folder) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `${folder}/*.md`))
    );

    const onNodeFileChange = async (uri: vscode.Uri) => {
      try {
        const nodes = await this.nodeIndex!.refresh();
        this.send({ type: 'nodesUpdated', nodes });
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
        const nodes = await this.nodeIndex!.refresh();
        this.send({ type: 'nodesUpdated', nodes });
        generateAgentInstructions(nodes, this.fileService, paths).catch(() => {});
      } catch { /* non-fatal */ }
    };

    for (const watcher of nodeWatchers) {
      watcher.onDidChange(onNodeFileChange);
      watcher.onDidCreate(onNodeFileChange);
      watcher.onDidDelete(onNodeFileDelete);
    }

    // Watch the configured project description.
    const projectWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, paths.projectMd)
    );
    projectWatcher.onDidChange(async () => {
      try {
        const content = await this.fileService.readFile(paths.projectMd).catch(() => '');
        this.send({ type: 'projectMd', content });
      } catch { /* non-fatal */ }
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

    this.watchers = [...nodeWatchers, projectWatcher, papersWatcher, bibWatcher];
  }

  private send(message: ExtensionMessage): void {
    this.panel?.webview.postMessage(message);
  }

  private getSavedUIState(): UIState {
    const saved = this.context.globalState.get<Partial<UIState>>(UI_STATE_KEY);
    if (!saved) return DEFAULT_UI_STATE;
    return { ...DEFAULT_UI_STATE, ...saved };
  }

  private async refreshNodes(): Promise<void> {
    if (!this.nodeIndex || !this.paths) return;
    const nodes = await this.nodeIndex.refresh();
    this.send({ type: 'nodesUpdated', nodes });
    generateAgentInstructions(nodes, this.fileService, this.paths).catch(() => { /* non-fatal */ });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
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

        case 'getNodeContent': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          const { frontmatter, body } = await this.nodeIndex.getNodeDetail(msg.id);
          this.send({ type: 'nodeDetail', id: msg.id, frontmatter, body });
          break;
        }

        case 'saveNode': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.nodeIndex.saveNode(msg.id, msg.frontmatter, msg.body);
          await this.refreshNodes();
          const updated = await this.nodeIndex.getNodeDetail(msg.id);
          this.send({ type: 'nodeDetail', id: msg.id, ...updated });
          break;
        }

        case 'getProjectMd': {
          if (!this.paths) throw new Error('Project paths are not configured.');
          const content = await this.fileService.readFile(this.paths.projectMd).catch(() => '');
          this.send({ type: 'projectMd', content });
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
          await this.nodeIndex.createNode(msg.nodeType as NodeType, msg.title);
          await this.refreshNodes();
          break;
        }

        case 'updateStatus': {
          if (!this.nodeIndex) throw new Error('Initialize the Research Assistant project first.');
          await this.nodeIndex.updateStatus(msg.id, msg.status as NodeStatus);
          await this.refreshNodes();
          break;
        }

        case 'openInEditor': {
          const uri = this.fileService.resolve(msg.filePath);
          await vscode.window.showTextDocument(uri);
          break;
        }

        case 'openFile': {
          // Uses vscode.open command so non-text files (PDFs) open with their default handler
          const uri = this.fileService.resolve(msg.filePath);
          await vscode.commands.executeCommand('vscode.open', uri);
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
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
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
    .md-preview a { color: var(--vscode-textLink-foreground); }
    .md-preview hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 1em 0; }
    .md-preview .katex-display { overflow-x: auto; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
