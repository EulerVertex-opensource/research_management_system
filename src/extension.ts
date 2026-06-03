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
  provider = new WebviewProvider(context, workspaceRoot);

  const disposable = vscode.commands.registerCommand(
    'research-assistant.openDashboard',
    async () => {
      await provider!.open();
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  provider = undefined;
}
