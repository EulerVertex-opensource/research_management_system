import * as vscode from 'vscode';
import { ResearchNode, AIService } from '../models/types';

export class VscodeLMService implements AIService {
  async ask(
    prompt: string,
    context: ResearchNode[],
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
      throw new Error(
        'No language model available. Make sure GitHub Copilot is installed and signed in.'
      );
    }

    const model = models[0];

    const systemText = this.buildSystemMessage(context);
    const messages = [
      vscode.LanguageModelChatMessage.User(systemText + '\n\n---\n\n' + prompt),
    ];

    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        onChunk(part.value);
      }
    }
  }

  private buildSystemMessage(context: ResearchNode[]): string {
    if (!context.length) {
      return 'You are a helpful mathematical research assistant.';
    }

    const lines = [
      'You are a helpful mathematical research assistant.',
      '',
      'The following research nodes are provided as context:',
      '',
    ];

    for (const node of context) {
      lines.push(`### [${node.type.toUpperCase()}] ${node.title} (id: ${node.id}, status: ${node.status})`);
      if (node.tags.length) {
        lines.push(`Tags: ${node.tags.join(', ')}`);
      }
      if (node.body) {
        lines.push('');
        lines.push(node.body);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
