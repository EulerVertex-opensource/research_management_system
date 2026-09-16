import { ResearchNode, NodeType, NodeStatus, NodeFrontmatter, UIState, PaperEntry, ProjectPathSummary } from './types';

// Messages sent from the extension to the webview
export type ExtensionMessage =
  | { type: 'init'; nodes: ResearchNode[]; projectRoot: string; uiState: UIState; initialized: boolean; paths: ProjectPathSummary }
  | { type: 'nodesUpdated'; nodes: ResearchNode[] }
  | { type: 'nodeDetail'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'projectMd'; content: string }
  | { type: 'papersData'; papers: PaperEntry[] }
  | { type: 'error'; message: string };

// Messages sent from the webview to the extension
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'getNodeContent'; id: string }
  | { type: 'saveNode'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'createNode'; nodeType: NodeType; title: string }
  | { type: 'updateStatus'; id: string; status: NodeStatus }
  | { type: 'getProjectMd' }
  | { type: 'saveProjectMd'; content: string }
  | { type: 'getPapers' }
  | { type: 'savePaper'; originalSlug: string; slug: string; mdSection: string; bibEntry: string }
  | { type: 'saveUIState'; uiState: UIState }
  | { type: 'openInEditor'; filePath: string }
  | { type: 'openFile'; filePath: string }
  | { type: 'initProject' }
  | { type: 'refreshProject' }
  | { type: 'addPaper'; slug: string; fileName: string; fileData: string; bibEntry: string; description: string; sourceUrl: string };
