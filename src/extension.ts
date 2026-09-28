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
  void provider.start().catch((error: unknown) => {
    output.appendLine(`[startup] Failed: ${error instanceof Error ? error.message : String(error)}`);
  });

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

  const loop = (name: string, action: () => Promise<void>) => vscode.commands.registerCommand(`research-assistant.loop.${name}`, async () => {
    try {
      await provider!.start();
      await action();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[loop:${name}] ${message}`);
      void vscode.window.showErrorMessage(`Research loop: ${message}`);
    }
  });
  const loopCommands = [
    loop('start', () => provider!.loopHost.startCommand()),
    loop('pause', () => provider!.loopHost.pauseCommand()),
    loop('resume', () => provider!.loopHost.resumeCommand()),
    loop('stop', () => provider!.loopHost.stopCommand()),
    loop('answerQuestion', () => provider!.loopHost.answerQuestionCommand()),
    loop('approve', () => provider!.loopHost.approveCommand()),
    loop('captureIdea', () => provider!.loopHost.captureIdeaCommand()),
    loop('openChat', () => provider!.loopHost.openChat()),
    loop('refreshIntegration', () => provider!.refreshProject(true)),
  ];

  context.subscriptions.push(output, openDashboard, refreshAgentSetup, showOutput, ...loopCommands);
}

export function deactivate(): void {
  provider?.dispose();
  provider = undefined;
}
