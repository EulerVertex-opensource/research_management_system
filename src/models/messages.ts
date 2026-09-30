import type { GraphAction, GraphPayload } from './graph';
import { ResearchNode, NodeType, ResearchStatus, NodeFrontmatter, UIState, PaperEntry, ProjectPathSummary, ProjectSummary, ManuscriptStatus } from './types';

// Messages sent from the extension to the webview
export type ExtensionMessage =
  | { type: 'init'; nodes: ResearchNode[]; projectRoot: string; uiState: UIState; initialized: boolean; paths: ProjectPathSummary }
  | { type: 'nodesUpdated'; nodes: ResearchNode[] }
  | { type: 'nodeDetail'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'projectMd'; content: string; summary?: ProjectSummary }
  | { type: 'papersData'; papers: PaperEntry[] }
  | { type: 'manuscriptStatus'; status: ManuscriptStatus }
  | { type: 'graphData'; payload: GraphPayload }
  | { type: 'error'; message: string };

// Messages sent from the webview to the extension
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'getNodeContent'; id: string }
  | { type: 'saveNode'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'createNode'; nodeType: NodeType; title: string; targetAsset?: string }
  | { type: 'updateStatus'; id: string; status: ResearchStatus }
  | { type: 'getProjectMd' }
  | { type: 'saveProjectMd'; content: string }
  | { type: 'getPapers' }
  | { type: 'savePaper'; originalSlug: string; slug: string; mdSection: string; bibEntry: string }
  | { type: 'saveUIState'; uiState: UIState }
  | { type: 'openInEditor'; filePath: string }
  | { type: 'openFile'; filePath: string }
  | { type: 'initProject' }
  | { type: 'refreshProject' }
  | { type: 'getManuscriptStatus' }
  | { type: 'buildManuscript' }
  | { type: 'reloadManuscript' }
  | { type: 'openManuscriptPdf' }
  | { type: 'setManuscriptAutoBuild'; enabled: boolean }
  | { type: 'applyLatexBuildSettings' }
  | { type: 'installLatexWorkshop' }
  | { type: 'getGraph' }
  | { type: 'graphAction'; request: GraphAction }
  | { type: 'addPaper'; slug: string; fileName: string; fileData: string; bibEntry: string; description: string; sourceUrl: string };
