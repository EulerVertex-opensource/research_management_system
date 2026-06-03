import { ResearchNode } from '../models/types';
import { FileService } from './FileService';
import { NodeIndexService } from './NodeIndexService';

export class ContextBuilder {
  constructor(
    private readonly nodeIndex: NodeIndexService,
    private readonly fileService: FileService
  ) {}

  getNodesById(ids: string[]): ResearchNode[] {
    return ids
      .map((id) => this.nodeIndex.getById(id))
      .filter((n): n is ResearchNode => n !== undefined);
  }

  async buildTexContext(texFilePath: string, selectedNodeIds: string[]): Promise<{
    nodes: ResearchNode[];
    texContent: string;
    macroContent: string;
    notationsContent: string;
  }> {
    const nodes = this.getNodesById(selectedNodeIds);

    const [texContent, macroContent, notationsContent] = await Promise.all([
      this.fileService.readFile(texFilePath).catch(() => ''),
      this.fileService.readFile('manuscript/macro.tex').catch(() => ''),
      this.fileService.readFile('manuscript/notations.tex').catch(() => ''),
    ]);

    return { nodes, texContent, macroContent, notationsContent };
  }

  buildContextSummary(nodes: ResearchNode[]): string {
    if (!nodes.length) {
      return '';
    }
    return nodes
      .map(
        (n) =>
          `[${n.type.toUpperCase()}] ${n.title} (${n.status})\n${n.body.substring(0, 300)}${n.body.length > 300 ? '...' : ''}`
      )
      .join('\n\n');
  }
}
