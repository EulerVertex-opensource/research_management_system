import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectPaths } from '../models/types';
import { FileService, LATEX_OUTPUT_DIRECTORY, LATEX_WORKSHOP_SETTINGS } from './FileService';

const LATEX_WORKSHOP_ID = 'james-yu.latex-workshop';

export class ManuscriptBuildService {
  constructor(
    private readonly fileService: FileService,
    private readonly workspaceRoot: vscode.Uri
  ) {}

  outputPdfPath(paths: ProjectPaths): string {
    const fileName = `${path.posix.basename(paths.mainTex, path.posix.extname(paths.mainTex))}.pdf`;
    return path.posix.join(LATEX_OUTPUT_DIRECTORY, fileName);
  }

  isLatexWorkshopInstalled(): boolean {
    return Boolean(vscode.extensions.getExtension(LATEX_WORKSHOP_ID));
  }

  configurationConflicts(): string[] {
    return Object.entries(LATEX_WORKSHOP_SETTINGS)
      .filter(([key]) => key !== 'latex-workshop.latex.autoBuild.run')
      .filter(([key, expected]) => {
        const inspected = vscode.workspace.getConfiguration(undefined, this.workspaceRoot).inspect<unknown>(key);
        const configured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
        return configured !== undefined && configured !== expected;
      })
      .map(([key]) => key);
  }

  isAutoBuildEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('latex-workshop', this.workspaceRoot)
      .get<string>('latex.autoBuild.run', 'never') !== 'never';
  }

  async applyRecommendedSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('latex-workshop', this.workspaceRoot);
    await config.update('latex.outDir', LATEX_WORKSHOP_SETTINGS['latex-workshop.latex.outDir'], vscode.ConfigurationTarget.Workspace);
    await config.update('latex.auxDir', LATEX_WORKSHOP_SETTINGS['latex-workshop.latex.auxDir'], vscode.ConfigurationTarget.Workspace);
  }

  async setAutoBuild(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration('latex-workshop', this.workspaceRoot)
      .update('latex.autoBuild.run', enabled ? 'onSave' : 'never', vscode.ConfigurationTarget.Workspace);
  }

  async installLatexWorkshop(): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', LATEX_WORKSHOP_ID);
  }

  async build(
    paths: ProjectPaths,
    viewColumn: vscode.ViewColumn | undefined,
    restorePanelFocus: () => void
  ): Promise<void> {
    const extension = vscode.extensions.getExtension(LATEX_WORKSHOP_ID);
    if (!extension) {
      throw new Error('LaTeX Workshop is not installed. Install the recommended extension to compile locally.');
    }
    if (!(await this.fileService.exists(paths.mainTex))) {
      throw new Error(`The configured main TeX file does not exist: ${paths.mainTex}`);
    }

    await vscode.workspace.fs.createDirectory(this.fileService.resolve(LATEX_OUTPUT_DIRECTORY));
    await extension.activate();
    const mainUri = this.fileService.resolve(paths.mainTex);
    await vscode.window.showTextDocument(mainUri, {
      viewColumn,
      preserveFocus: false,
      preview: true,
    });
    const build = vscode.commands.executeCommand('latex-workshop.build');
    // LaTeX Workshop captures the active root when its command starts. Restore
    // the dashboard immediately while the compiler continues in the background.
    restorePanelFocus();
    await build;

    const outputPdf = this.outputPdfPath(paths);
    if (!(await this.waitForFile(outputPdf, 60_000))) {
      throw new Error(
        `The build command did not produce ${outputPdf}. Check the LaTeX Workshop output and confirm that latexmk is installed.`
      );
    }
  }

  private async waitForFile(relativePath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.fileService.exists(relativePath)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
  }
}
