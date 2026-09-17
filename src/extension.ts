import * as vscode from 'vscode';
import { WebviewProvider } from './webview/WebviewProvider';

let provider: WebviewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showErrorMessage(
      'Research Assistant: Please open a folder first.'
    );
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri;
  const output = vscode.window.createOutputChannel('Research Assistant');
  output.appendLine(`[activate] Extension ${context.extension.packageJSON.version ?? 'unknown'} loaded.`);
  output.appendLine(`[activate] Workspace: ${workspaceRoot.fsPath}`);
  provider = new WebviewProvider(context, workspaceRoot, output);

  const openDashboard = vscode.commands.registerCommand(
    'research-assistant.openDashboard',
    async () => {
      await provider!.open();
    }
  );

  const refreshAgentSetup = vscode.commands.registerCommand(
    'research-assistant.refreshAgentSetup',
    async () => {
      try {
        await provider!.refreshProject(true);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[refresh] FAILED: ${message}`);
        if (error instanceof Error && error.stack) output.appendLine(error.stack);
        output.show(true);
        void vscode.window.showErrorMessage(`Research Assistant refresh failed: ${message}`);
      }
    }
  );

  const showOutput = vscode.commands.registerCommand(
    'research-assistant.showOutput',
    () => output.show(true)
  );

  context.subscriptions.push(output, openDashboard, refreshAgentSetup, showOutput);
}

export function deactivate(): void {
  provider = undefined;
}
