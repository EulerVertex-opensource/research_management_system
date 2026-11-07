import type { GraphAction, GraphPayload } from './graph';
import type { SettingsErrors, SettingsPatch, SettingsPayload } from './settings';
import type { SyncBadge, SyncNotice } from './sync';
import type { CitationView, ExportPreviewView, ExportRequest, ImportPreviewView, PackageModal, PackagesPayload } from './packages';
import { DefinitionKind, RemarkView, ResearchNode, NodeType, ResearchStatus, NodeFrontmatter, UIState, PaperEntry, ProjectPathSummary, ProjectSummary, ManuscriptStatus } from './types';

// Messages sent from the extension to the webview
export type ExtensionMessage =
  | { type: 'init'; nodes: ResearchNode[]; projectRoot: string; uiState: UIState; initialized: boolean; paths: ProjectPathSummary }
  | { type: 'nodesUpdated'; nodes: ResearchNode[] }
  | { type: 'nodeDetail'; id: string; frontmatter: NodeFrontmatter; body: string; remarks?: RemarkView[] }
  /** Every remark (active and archived), for the Remarks view. */
  | { type: 'remarksData'; remarks: RemarkView[] }
  | { type: 'projectMd'; content: string; summary?: ProjectSummary }
  | { type: 'papersData'; papers: PaperEntry[] }
  | { type: 'manuscriptStatus'; status: ManuscriptStatus }
  | { type: 'graphData'; payload: GraphPayload }
  /** Switch the dashboard to a view, e.g. the Overview after a status bar click. */
  | { type: 'showView'; view: 'graph' }
  /** Open one node's page, e.g. from a link in the agent chat. */
  | { type: 'showNode'; id: string }
  /** Current settings; after an update, `requestId` echoes it and `errors` lists invalid fields (nothing was written then). */
  | { type: 'settingsData'; settings: SettingsPayload; requestId?: string; errors?: SettingsErrors }
  /** Answer to `refreshDashboard`, after every panel's data was re-sent. */
  | { type: 'refreshDone' }
  | { type: 'syncState'; state: SyncBadge }
  /** Outcome of a dashboard sync that needs the researcher's attention. */
  | { type: 'notice'; notice: SyncNotice }
  /** Problems in the research files themselves (duplicate IDs, dependency order); shown as a quiet note, not an error banner. */
  | { type: 'problems'; problems: string[] }
  /** A prompt for the agent chat is on the clipboard: the dashboard says so where the researcher clicked. */
  | { type: 'copied'; prompt: 'instruction' | 'teaching' }
  | { type: 'packagesData'; data: PackagesPayload }
  | { type: 'packageExportPreview'; preview: ExportPreviewView }
  | { type: 'packageImportPreview'; preview: ImportPreviewView }
  /** A package action finished; the dialog closes. */
  | { type: 'packageDone'; message: string }
  /** This project's citation (Settings); `saved` is set when a save just succeeded. */
  | { type: 'citationData'; data: CitationView; saved?: boolean }
  /** Open the Library with a package dialog (from a command). */
  | { type: 'showPackageModal'; modal: PackageModal }
  | { type: 'error'; message: string };

// Messages sent from the webview to the extension
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'getNodeContent'; id: string }
  | { type: 'saveNode'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'approveRemark'; id: string; nodeId?: string }
  | { type: 'getRemarks' }
  | { type: 'checkRemark'; id: string }
  | { type: 'addRemark'; target: string; title: string; body: string; anchor?: string }
  | { type: 'editRemark'; id: string; title?: string; body?: string; anchor?: string }
  | { type: 'archiveRemark'; id: string; archived: boolean }
  | { type: 'createNode'; nodeType: NodeType; title: string; targetAsset?: string; definitionKind?: DefinitionKind }
  | { type: 'updateStatus'; id: string; status: ResearchStatus }
  /** Approve several library results at once (the extension asks the researcher to confirm). */
  | { type: 'approveNodes'; ids: string[]; label: string }
  | { type: 'getProjectMd' }
  | { type: 'saveProjectMd'; content: string }
  | { type: 'getPapers' }
  | { type: 'savePaper'; originalSlug: string; slug: string; mdSection: string; bibEntry: string }
  | { type: 'saveUIState'; uiState: UIState }
  | { type: 'openInEditor'; filePath: string }
  | { type: 'openFile'; filePath: string }
  | { type: 'initProject' }
  | { type: 'refreshProject' }
  /** Re-read research files from disk and re-send every panel (lighter than refreshProject). */
  | { type: 'refreshDashboard' }
  /** Pull and/or publish to the sync remote, as `research-assistant.loop.syncNow`. */
  | { type: 'syncNow' }
  | { type: 'getManuscriptStatus' }
  | { type: 'buildManuscript' }
  | { type: 'reloadManuscript' }
  | { type: 'openManuscriptPdf' }
  | { type: 'setManuscriptAutoBuild'; enabled: boolean }
  | { type: 'applyLatexBuildSettings' }
  | { type: 'installLatexWorkshop' }
  | { type: 'getGraph' }
  | { type: 'graphAction'; request: GraphAction }
  | { type: 'getSettings' }
  | { type: 'updateSettings'; requestId: string; patch: SettingsPatch }
  | { type: 'addPaper'; slug: string; fileName: string; fileData: string; bibEntry: string; description: string; sourceUrl: string }
  | { type: 'getPackages' }
  | { type: 'packagePreviewExport'; request: ExportRequest }
  | { type: 'packageExport'; request: ExportRequest }
  /** Choose a package file or project folder in a VS Code dialog, then preview it (as an update of `update` when set). */
  | { type: 'packagePickSource'; kind: 'file' | 'folder'; update?: string }
  /** Preview an import from a source already chosen; `update` previews the recorded source of that package when `source` is empty. */
  | { type: 'packagePreviewImport'; source?: string; alias?: string; update?: string }
  | { type: 'packageImport'; source: string; alias?: string; update?: string }
  | { type: 'packageApprove'; alias: string }
  | { type: 'packageRemove'; alias: string }
  | { type: 'getCitation' }
  | { type: 'saveCitation'; text: string };
