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

  const openOverview = vscode.commands.registerCommand('research-assistant.openOverview', async () => { await provider!.openOverview(); });

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

  const loop = (name: string, action: () => Promise<unknown>) => vscode.commands.registerCommand(`research-assistant.loop.${name}`, async () => {
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
    loop('extend', () => provider!.loopHost.extendCommand()),
    loop('pause', () => provider!.loopHost.pauseCommand()),
    loop('resume', () => provider!.loopHost.resumeCommand()),
    loop('stop', () => provider!.loopHost.stopCommand()),
    loop('answerQuestion', () => provider!.loopHost.answerQuestionCommand()),
    loop('approve', () => provider!.loopHost.approveCommand()),
    loop('captureIdea', () => provider!.loopHost.captureIdeaCommand()),
    loop('openChat', () => provider!.loopHost.openChat()),
    loop('teach', () => provider!.loopHost.teachCommand()),
    loop('syncStatus', () => provider!.loopHost.syncStatusCommand()),
    loop('syncPull', () => provider!.loopHost.syncPullCommand()),
    loop('syncPrepare', () => provider!.loopHost.syncPrepareCommand()),
    loop('syncPublish', () => provider!.loopHost.syncPublishCommand()),
    loop('syncNow', () => provider!.loopHost.syncNowCommand()),
    loop('refreshIntegration', () => provider!.refreshProject(true)),
  ];

  // Links in the agent chat (the teach skill names results with them) open that node's page in the dashboard.
  const uriHandler = vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      const id = new URLSearchParams(uri.query).get('id');
      if (uri.path === '/node' && id) await provider!.showNode(id);
    },
  });
  // From a research file open in the editor (e.g. a file link in the chat) to its page in the dashboard.
  const showNodeInDashboard = vscode.commands.registerCommand('research-assistant.showNodeInDashboard', async (resource?: vscode.Uri) => {
    const file = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || !file.path.endsWith('.md')) { void vscode.window.showInformationMessage('Open a research file (a result, definition, idea, or plan) first.'); return; }
    await provider!.showNode(file.path.slice(file.path.lastIndexOf('/') + 1, -'.md'.length));
  });

  context.subscriptions.push(output, openDashboard, openOverview, refreshAgentSetup, showOutput, uriHandler, showNodeInDashboard, ...loopCommands);
}

export function deactivate(): void {
  provider?.dispose();
  provider = undefined;
}
