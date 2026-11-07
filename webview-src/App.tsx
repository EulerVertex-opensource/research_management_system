import React, { useReducer, useCallback, useEffect, useRef, useState } from 'react';
import { DefinitionKind, RemarkView, ResearchNode, NodeType, NodeFrontmatter, LayoutMode, UIState, DEFAULT_UI_STATE, PaperEntry, ProjectPathSummary, ProjectSummary, ManuscriptStatus } from '../src/models/types';
import { ExtensionMessage } from '../src/models/messages';
import { useExtension } from './hooks/useExtension';
import { Sidebar, SidebarView } from './components/Sidebar';
import { NodeList } from './components/NodeList';
import { RemarkList } from './components/RemarkList';
import { RemarkCreate, RemarkDetail } from './components/RemarkDetail';
import { NodeDetail } from './components/NodeDetail';
import { ProjectView } from './components/ProjectView';
import { PaperList } from './components/PaperList';
import { PaperDetail } from './components/PaperDetail';
import { AddPaperButton } from './components/AddPaperButton';
import { CreateNodeModal } from './components/CreateNodeModal';
import { ManuscriptView } from './components/ManuscriptView';
import { resolvePaperPdfLink, resolveResearchNodeLink } from './researchLinks';
import { ASSET_TYPES, ASSET_TYPE_LIST } from '../src/domain/nodeKinds';
import type { GraphAction, GraphPayload } from '../src/models/graph';
import { OverviewPage } from './graph/OverviewPage';
import { NeedsYouPage } from './graph/NeedsYouPage';
import { ProgressView } from './graph/ProgressView';
import { ActivityPage, buttonStyle } from './graph/AttentionList';
import { CoverageMatrix } from './graph/CoverageMatrix';
import { DEFAULT_OPTIONS, ViewOptions, waitingItems } from './graph/graphModel';
import { TechnicalDetails } from './technical';
import { SettingsView } from './components/SettingsView';
import type { SettingsErrors, SettingsPayload } from '../src/models/settings';
import type { SyncBadge, SyncNotice } from '../src/models/sync';
import type { ExportPreviewView, ImportPreviewView, PackageModal, PackagesPayload } from '../src/models/packages';
import { PackageBar } from './components/PackageBar';
import { ImportPackageModal } from './components/ImportPackageModal';
import { ExportPackageModal } from './components/ExportPackageModal';

interface NodeDetailData {
  frontmatter: NodeFrontmatter;
  body: string;
  remarks: RemarkView[];
}

interface State {
  nodes: ResearchNode[];
  projectRoot: string;
  initialized: boolean;
  paths: ProjectPathSummary | null;
  selectedNodeId: string | null;
  nodeDetails: Record<string, NodeDetailData>;
  projectMd: string | null;
  projectSummary: ProjectSummary | null;
  papers: PaperEntry[];
  papersLoaded: boolean;
  selectedPaperSlug: string | null;
  activeView: SidebarView;
  showCreateModal: boolean;
  error: string | null;
  manuscriptStatus: ManuscriptStatus | null;
  graph: GraphPayload | null;
  settings: SettingsPayload | null;
  settingsResult: { requestId: string; errors: SettingsErrors } | null;
  uiState: UIState;
  refreshing: boolean;
  sync: SyncBadge | null;
  notice: SyncNotice | null;
  problems: string[];
  remarks: RemarkView[];
  selectedRemarkId: string | null;
  /** Writing a new remark in the Remarks view; the target it starts on, if any. */
  creatingRemark: { target?: string } | null;
}

type Action =
  | { type: 'INIT'; nodes: ResearchNode[]; projectRoot: string; uiState: UIState; initialized: boolean; paths: ProjectPathSummary }
  | { type: 'NODES_UPDATED'; nodes: ResearchNode[] }
  | { type: 'REMARKS_DATA'; remarks: RemarkView[] }
  | { type: 'SELECT_REMARK'; id: string | null }
  | { type: 'CREATE_REMARK'; create: { target?: string } | null }
  | { type: 'NODE_DETAIL'; id: string; frontmatter: NodeFrontmatter; body: string; remarks: RemarkView[] }
  | { type: 'PROJECT_MD'; content: string; summary?: ProjectSummary }
  | { type: 'PAPERS_DATA'; papers: PaperEntry[] }
  | { type: 'SELECT_NODE'; id: string }
  | { type: 'SELECT_PAPER'; slug: string }
  | { type: 'SET_VIEW'; view: SidebarView }
  | { type: 'TOGGLE_CREATE_MODAL' }
  | { type: 'SET_ERROR'; message: string | null }
  | { type: 'SET_REFRESHING'; refreshing: boolean }
  | { type: 'SYNC_STATE'; state: SyncBadge }
  | { type: 'SET_NOTICE'; notice: SyncNotice | null }
  | { type: 'PROBLEMS'; problems: string[] }
  | { type: 'MANUSCRIPT_STATUS'; status: ManuscriptStatus }
  | { type: 'GRAPH_DATA'; payload: GraphPayload }
  | { type: 'SETTINGS_DATA'; settings: SettingsPayload; requestId?: string; errors?: SettingsErrors }
  | { type: 'SET_LAYOUT'; layoutMode: LayoutMode }
  | { type: 'SET_SPLIT_RATIO'; splitRatio: number }
  | { type: 'SET_NODE_LIST_WIDTH'; width: number }
  | { type: 'SET_METADATA_HEIGHT'; height: number }
  | { type: 'SET_SHOW_TECHNICAL'; showTechnical: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INIT':
      return {
        ...state,
        nodes: action.nodes,
        projectRoot: action.projectRoot,
        initialized: action.initialized,
        paths: action.paths,
        activeView: action.initialized ? state.activeView : 'project',
        error: null,
        uiState: action.uiState,
      };
    case 'NODES_UPDATED':
      return { ...state, nodes: action.nodes };
    case 'REMARKS_DATA':
      return { ...state, remarks: action.remarks };
    case 'SELECT_REMARK':
      return { ...state, selectedRemarkId: action.id, creatingRemark: null };
    case 'CREATE_REMARK':
      return { ...state, creatingRemark: action.create, ...(action.create ? { activeView: 'remarks' as SidebarView, selectedRemarkId: null } : {}) };
    case 'NODE_DETAIL':
      return { ...state, nodeDetails: { ...state.nodeDetails, [action.id]: { frontmatter: action.frontmatter, body: action.body, remarks: action.remarks } } };
    case 'PROJECT_MD':
      return { ...state, projectMd: action.content, projectSummary: action.summary ?? null };
    case 'PAPERS_DATA':
      return { ...state, papers: action.papers, papersLoaded: true };
    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.id };
    case 'SELECT_PAPER':
      return { ...state, selectedPaperSlug: action.slug };
    case 'SET_VIEW':
      return { ...state, activeView: action.view, selectedNodeId: null, selectedPaperSlug: null, selectedRemarkId: null, creatingRemark: null };
    case 'TOGGLE_CREATE_MODAL':
      return { ...state, showCreateModal: !state.showCreateModal };
    case 'SET_ERROR':
      // An error ends a refresh too, so the Refresh button never stays stuck.
      return { ...state, error: action.message, refreshing: action.message ? false : state.refreshing };
    case 'SET_REFRESHING':
      return { ...state, refreshing: action.refreshing };
    case 'SYNC_STATE':
      return { ...state, sync: action.state };
    case 'SET_NOTICE':
      return { ...state, notice: action.notice };
    case 'PROBLEMS':
      return { ...state, problems: action.problems };
    case 'MANUSCRIPT_STATUS':
      return { ...state, manuscriptStatus: action.status };
    case 'SETTINGS_DATA':
      return { ...state, settings: action.settings, settingsResult: action.requestId ? { requestId: action.requestId, errors: action.errors ?? {} } : state.settingsResult };
    case 'GRAPH_DATA':
      return { ...state, graph: action.payload };
    case 'SET_LAYOUT':
      return { ...state, uiState: { ...state.uiState, layoutMode: action.layoutMode } };
    case 'SET_SPLIT_RATIO':
      return { ...state, uiState: { ...state.uiState, splitRatio: action.splitRatio } };
    case 'SET_NODE_LIST_WIDTH':
      return { ...state, uiState: { ...state.uiState, nodeListWidth: action.width } };
    case 'SET_METADATA_HEIGHT':
      return { ...state, uiState: { ...state.uiState, metadataHeight: action.height } };
    case 'SET_SHOW_TECHNICAL':
      return { ...state, uiState: { ...state.uiState, showTechnical: action.showTechnical } };
    default:
      return state;
  }
}

const initialState: State = {
  nodes: [],
  projectRoot: '',
  initialized: false,
  paths: null,
  selectedNodeId: null,
  nodeDetails: {},
  projectMd: null,
  projectSummary: null,
  papers: [],
  papersLoaded: false,
  selectedPaperSlug: null,
  activeView: 'assets',
  showCreateModal: false,
  error: null,
  manuscriptStatus: null,
  graph: null,
  settings: null,
  settingsResult: null,
  uiState: DEFAULT_UI_STATE,
  refreshing: false,
  sync: null,
  notice: null,
  problems: [],
  remarks: [],
  selectedRemarkId: null,
  creatingRemark: null,
};

/** Views drawn from the research overview payload. */
const GRAPH_VIEWS: SidebarView[] = ['graph', 'needs', 'results', 'activity', 'manuscript'];
const PASTE_KEY = /Mac/i.test(navigator.platform) ? '⌘V' : 'Ctrl+V';

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-pressed={active} onClick={onClick}
      style={{ padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer', background: active ? 'var(--vscode-button-background)' : 'transparent', color: active ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)' }}>
      {children}
    </button>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Kept here so the Results view, the chosen Needs you item and the Manuscript tab survive switching pages.
  const [resultsOptions, setResultsOptions] = useState<ViewOptions>(DEFAULT_OPTIONS);
  const [resultsSelected, setResultsSelected] = useState<string | undefined>();
  const [needsKey, setNeedsKey] = useState<string | undefined>();
  const [pendingNode, setPendingNode] = useState<string | null>(null);
  const [manuscriptTab, setManuscriptTab] = useState<'paper' | 'coverage'>('paper');
  const [coverageSection, setCoverageSection] = useState<string | undefined>();
  const [showProblems, setShowProblems] = useState(false);
  // Research packages: the Library's package bar and its import, update, and export dialogs.
  const [packages, setPackages] = useState<PackagesPayload | undefined>();
  const [packageModal, setPackageModal] = useState<PackageModal | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewView | undefined>();
  const [exportPreview, setExportPreview] = useState<ExportPreviewView | undefined>();
  const [packageBusy, setPackageBusy] = useState(false);
  // `at` restarts the timer when the same kind of prompt is copied again.
  const [copied, setCopied] = useState<{ prompt: 'instruction' | 'teaching'; at: number } | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 10000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'init':
        dispatch({ type: 'INIT', nodes: msg.nodes, projectRoot: msg.projectRoot, uiState: msg.uiState, initialized: msg.initialized, paths: msg.paths });
        break;
      case 'nodesUpdated':
        dispatch({ type: 'NODES_UPDATED', nodes: msg.nodes });
        break;
      case 'remarksData':
        dispatch({ type: 'REMARKS_DATA', remarks: msg.remarks });
        break;
      case 'nodeDetail':
        dispatch({ type: 'NODE_DETAIL', id: msg.id, frontmatter: msg.frontmatter, body: msg.body, remarks: msg.remarks ?? [] });
        break;
      case 'projectMd':
        dispatch({ type: 'PROJECT_MD', content: msg.content, summary: msg.summary });
        break;
      case 'papersData':
        dispatch({ type: 'PAPERS_DATA', papers: msg.papers });
        break;
      case 'manuscriptStatus':
        dispatch({ type: 'MANUSCRIPT_STATUS', status: msg.status });
        break;
      case 'graphData':
        dispatch({ type: 'GRAPH_DATA', payload: msg.payload });
        break;
      case 'showView':
        dispatch({ type: 'SET_VIEW', view: msg.view });
        break;
      case 'showNode':
        setPendingNode(msg.id);
        break;
      case 'settingsData':
        dispatch({ type: 'SETTINGS_DATA', settings: msg.settings, requestId: msg.requestId, errors: msg.errors });
        break;
      case 'refreshDone':
        dispatch({ type: 'SET_REFRESHING', refreshing: false });
        break;
      case 'syncState':
        dispatch({ type: 'SYNC_STATE', state: msg.state });
        break;
      case 'notice':
        dispatch({ type: 'SET_NOTICE', notice: msg.notice });
        break;
      case 'problems':
        dispatch({ type: 'PROBLEMS', problems: msg.problems });
        break;
      case 'copied':
        setCopied({ prompt: msg.prompt, at: Date.now() });
        break;
      case 'packagesData':
        setPackages(msg.data);
        break;
      case 'packageExportPreview':
        setExportPreview(msg.preview);
        setPackageBusy(false);
        break;
      case 'packageImportPreview':
        setImportPreview(msg.preview);
        setPackageBusy(false);
        break;
      case 'packageDone':
        setPackageModal(null);
        setPackageBusy(false);
        dispatch({ type: 'SET_NOTICE', notice: { level: 'info', title: 'Packages', message: msg.message } });
        break;
      case 'showPackageModal':
        dispatch({ type: 'SET_VIEW', view: 'library' });
        setPackageModal(msg.modal);
        break;
      case 'error':
        setPackageBusy(false);
        dispatch({ type: 'SET_ERROR', message: msg.message });
        break;
    }
  }, []);

  const send = useExtension(handleMessage);

  useEffect(() => {
    send({ type: 'ready' });
    // The sidebar's Needs you count comes from the overview payload.
    send({ type: 'getGraph' });
  }, [send]);

  // The Library shows the packages; node changes (an approval, say) can change their state.
  useEffect(() => {
    if (state.activeView === 'library') send({ type: 'getPackages' });
  }, [state.activeView, state.nodes, send]);

  // A package dialog asks for its first preview when it opens.
  useEffect(() => {
    setImportPreview(undefined);
    setExportPreview(undefined);
    if (!packageModal) { setPackageBusy(false); return; }
    if (packageModal.kind === 'export') { setPackageBusy(true); send({ type: 'packagePreviewExport', request: {} }); }
    if (packageModal.kind === 'update') { setPackageBusy(true); send({ type: 'packagePreviewImport', update: packageModal.alias }); }
  }, [packageModal, send]);

  const handleSetView = (view: SidebarView) => {
    dispatch({ type: 'SET_VIEW', view });
    if (view === 'project' && state.projectMd === null) {
      send({ type: 'getProjectMd' });
    }
    if (view === 'papers' && !state.papersLoaded) {
      send({ type: 'getPapers' });
    }
    if (view === 'manuscript') {
      send({ type: 'getManuscriptStatus' });
    }
    if (view === 'remarks') {
      send({ type: 'getRemarks' });
    }
    if (GRAPH_VIEWS.includes(view)) {
      send({ type: 'getGraph' });
    }
    if (view === 'settings') {
      send({ type: 'getSettings' });
    }
  };

  const showInResults = (id: string) => { setResultsSelected(id); handleSetView('results'); };
  const openNeeds = (key?: string) => { setNeedsKey(key); handleSetView('needs'); };
  const openPaper = (section?: string) => { setCoverageSection(section); setManuscriptTab('coverage'); handleSetView('manuscript'); };
  const openNodeById = (id: string) => { const node = state.nodes.find((item) => item.id === id); if (node) handleNavigateNode(node); };
  const graphAction = (request: GraphAction) => send({ type: 'graphAction', request });
  // A node asked for from outside (a chat link): shown once the node index has it.
  useEffect(() => {
    if (!pendingNode) return;
    if (!state.nodes.length) return;
    const node = state.nodes.find((item) => item.id === pendingNode);
    if (node) handleNavigateNode(node);
    setPendingNode(null);
  }, [pendingNode, state.nodes]);

  const handleRefresh = () => {
    dispatch({ type: 'SET_REFRESHING', refreshing: true });
    send({ type: 'refreshDashboard' });
    if (state.selectedNodeId) send({ type: 'getNodeContent', id: state.selectedNodeId });
  };

  const handleSync = () => {
    dispatch({ type: 'SET_NOTICE', notice: null });
    if (state.sync) dispatch({ type: 'SYNC_STATE', state: { ...state.sync, busy: true } });
    send({ type: 'syncNow' });
  };

  const handleSelectNode = (node: ResearchNode) => {
    dispatch({ type: 'SELECT_NODE', id: node.id });
    // Always fetch fresh content so external edits (e.g. from Copilot) are reflected immediately
    send({ type: 'getNodeContent', id: node.id });
  };

  const handleNavigateNode = (node: ResearchNode) => {
    const view: SidebarView = node.type === 'idea' ? 'ideas' : node.type === 'plan' ? 'plans' : node.origin === 'library' ? 'library'
      : node.filePath.startsWith(`${state.paths?.definitions ?? 'research/definitions'}/`) ? 'definitions' : 'assets';
    dispatch({ type: 'SET_VIEW', view });
    dispatch({ type: 'SELECT_NODE', id: node.id });
    send({ type: 'getNodeContent', id: node.id });
  };

  const handleOpenResearchLink = (sourcePath: string, href: string): boolean => {
    if (/\.pdf(?:[?#]|$)/i.test(href)) {
      const pdfPath = resolvePaperPdfLink(sourcePath, href, state.paths?.localSourcePdfs ?? 'research-local/raw_papers');
      if (pdfPath) {
        send({ type: 'openFile', filePath: pdfPath });
      } else {
        dispatch({ type: 'SET_ERROR', message: `Paper PDF link must point directly into the configured local PDF folder: ${href}` });
      }
      return true;
    }
    const target = resolveResearchNodeLink(sourcePath, href, state.nodes);
    if (target) {
      handleNavigateNode(target);
      return true;
    }
    dispatch({ type: 'SET_ERROR', message: `Research link target not found: ${href}` });
    return true;
  };

  const handleSaveNode = (id: string, frontmatter: NodeFrontmatter, body: string) => {
    send({ type: 'saveNode', id, frontmatter, body });
  };

  const handleSaveProjectMd = (content: string) => {
    send({ type: 'saveProjectMd', content });
  };

  const handleCreateNode = (nodeType: NodeType, title: string, targetAsset?: string, definitionKind?: DefinitionKind) => {
    send({ type: 'createNode', nodeType, title, targetAsset, definitionKind });
    dispatch({ type: 'TOGGLE_CREATE_MODAL' });
  };

  const handleOpenInEditor = () => {
    const node = state.nodes.find((n) => n.id === state.selectedNodeId);
    if (node) send({ type: 'openInEditor', filePath: node.filePath });
  };

  const handleAddPaper = (slug: string, fileName: string, fileData: string, bibEntry: string, description: string, sourceUrl: string) => {
    send({ type: 'addPaper', slug, fileName, fileData, bibEntry, description, sourceUrl });
  };

  const handleSavePaper = (originalSlug: string, newSlug: string, mdSection: string, bibEntry: string) => {
    send({ type: 'savePaper', originalSlug, slug: newSlug, mdSection, bibEntry });
    if (originalSlug !== newSlug) {
      dispatch({ type: 'SELECT_PAPER', slug: newSlug });
    }
  };

  const handleOpenPdf = (slug: string) => {
    if (state.paths) send({ type: 'openFile', filePath: `${state.paths.localSourcePdfs}/${slug}.pdf` });
  };

  const handleLayoutChange = (layoutMode: LayoutMode) => {
    dispatch({ type: 'SET_LAYOUT', layoutMode });
    send({ type: 'saveUIState', uiState: { ...state.uiState, layoutMode } });
  };

  const handleSplitRatioChange = (splitRatio: number) => {
    dispatch({ type: 'SET_SPLIT_RATIO', splitRatio });
    send({ type: 'saveUIState', uiState: { ...state.uiState, splitRatio } });
  };

  const handleShowTechnical = (showTechnical: boolean) => {
    dispatch({ type: 'SET_SHOW_TECHNICAL', showTechnical });
    send({ type: 'saveUIState', uiState: { ...state.uiState, showTechnical } });
  };

  const uiStateRef = useRef(state.uiState);
  uiStateRef.current = state.uiState;

  const handleMetadataHeightChange = useCallback((height: number) => {
    dispatch({ type: 'SET_METADATA_HEIGHT', height });
    send({ type: 'saveUIState', uiState: { ...uiStateRef.current, metadataHeight: height } });
  }, [send]);

  const nodeListRef = useRef<HTMLDivElement>(null);

  const startNodeListDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = nodeListRef.current?.offsetWidth ?? uiStateRef.current.nodeListWidth;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (me: MouseEvent) => {
      const newWidth = Math.max(150, Math.min(500, startWidth + me.clientX - startX));
      dispatch({ type: 'SET_NODE_LIST_WIDTH', width: newWidth });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      send({ type: 'saveUIState', uiState: uiStateRef.current });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [send]);

  const selectedNode = state.nodes.find((n) => n.id === state.selectedNodeId) ?? null;
  const selectedDetail = state.selectedNodeId ? state.nodeDetails[state.selectedNodeId] : null;
  const selectedPaper = state.papers.find((p) => p.slug === state.selectedPaperSlug) ?? null;

  const filterType =
    state.activeView === 'assets' ? 'asset' :
    state.activeView === 'definitions' ? 'definition' :
    state.activeView === 'library' ? 'library' :
    state.activeView === 'ideas' ? 'idea' :
    state.activeView === 'plans' ? 'plan' : undefined;

  const showRemarkList = state.activeView === 'remarks';
  const remarkTargets = state.nodes.filter((node) => ASSET_TYPES.has(node.type) || node.type === 'definition');
  const selectedRemark = state.remarks.find((remark) => remark.id === state.selectedRemarkId) ?? null;
  const openRemark = (id: string) => { dispatch({ type: 'SET_VIEW', view: 'remarks' }); dispatch({ type: 'SELECT_REMARK', id }); send({ type: 'getRemarks' }); };
  const showNodeList = state.activeView === 'assets' || state.activeView === 'definitions' || state.activeView === 'library' || state.activeView === 'ideas' || state.activeView === 'plans';
  const showPaperList = state.activeView === 'papers';
  const showListColumn = showNodeList || showPaperList || showRemarkList;

  const { layoutMode, splitRatio, nodeListWidth, metadataHeight } = state.uiState;

  return (
    <TechnicalDetails.Provider value={state.uiState.showTechnical}>
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        active={state.activeView}
        onChange={handleSetView}
        refreshing={state.refreshing}
        onRefresh={handleRefresh}
        sync={state.sync}
        onSync={handleSync}
        needsCount={state.graph ? waitingItems(state.graph).length : 0}
        problems={state.problems.length}
        onProblems={() => setShowProblems(!showProblems)}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* Left list column (assets / ideas / papers) */}
        {showListColumn && (
          <>
            <div
              ref={nodeListRef}
              style={{ width: nodeListWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
              {/* Column header */}
              <div
                style={{
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--vscode-panel-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {state.activeView === 'assets' ? 'Assets' : state.activeView === 'definitions' ? 'Definitions' : state.activeView === 'library' ? 'Library' : state.activeView === 'ideas' ? 'Ideas' : state.activeView === 'plans' ? 'Plans' : state.activeView === 'remarks' ? 'Remarks' : 'Papers'}
                </span>
                {showNodeList && state.activeView !== 'library' && (
                  <button
                    onClick={() => dispatch({ type: 'TOGGLE_CREATE_MODAL' })}
                    title="Create new node"
                    style={{ padding: '1px 9px', fontSize: 16, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: 3, cursor: 'pointer' }}
                  >
                    +
                  </button>
                )}
                {showPaperList && (
                  <AddPaperButton onAdd={handleAddPaper} />
                )}
                {showRemarkList && (
                  <button
                    onClick={() => dispatch({ type: 'CREATE_REMARK', create: {} })}
                    title="Write a remark on a result"
                    style={{ padding: '1px 9px', fontSize: 16, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: 3, cursor: 'pointer' }}
                  >
                    +
                  </button>
                )}
              </div>

              {/* List body */}
              {state.activeView === 'library' && (
                <PackageBar
                  data={packages}
                  onImport={() => setPackageModal({ kind: 'import' })}
                  onExport={() => setPackageModal({ kind: 'export' })}
                  onAccept={(alias) => send({ type: 'packageApprove', alias })}
                  onUpdate={(alias) => setPackageModal({ kind: 'update', alias })}
                  onRemove={(alias) => send({ type: 'packageRemove', alias })}
                />
              )}
              {showNodeList && (
                <NodeList
                  nodes={state.nodes}
                  selectedId={state.selectedNodeId}
                  onSelect={handleSelectNode}
                  filterType={filterType}
                  definitionPath={state.paths?.definitions ?? 'research/definitions'}
                  onApprove={(ids, label) => send({ type: 'approveNodes', ids, label })}
                />
              )}
              {showRemarkList && (
                <RemarkList remarks={state.remarks} selectedId={state.selectedRemarkId} onSelect={(id) => dispatch({ type: 'SELECT_REMARK', id })} />
              )}
              {showPaperList && (
                <PaperList
                  papers={state.papers}
                  selectedSlug={state.selectedPaperSlug}
                  onSelect={(slug) => dispatch({ type: 'SELECT_PAPER', slug })}
                />
              )}
            </div>

            {/* Vertical splitter */}
            <div
              onMouseDown={startNodeListDrag}
              style={{ width: 5, flexShrink: 0, cursor: 'col-resize', background: 'transparent', borderRight: '1px solid var(--vscode-panel-border)', transition: 'background 0.1s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-focusBorder)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            />
          </>
        )}

        {/* Content area */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {state.error && (
            <div style={{ padding: '7px 14px', background: 'var(--vscode-inputValidation-errorBackground)', color: 'var(--vscode-inputValidation-errorForeground)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <span>{state.error}</span>
              <button onClick={() => dispatch({ type: 'SET_ERROR', message: null })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
            </div>
          )}
          {copied && (
            <div role="status" style={{ padding: '7px 14px', background: 'var(--vscode-editorWidget-background)', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span>
                <span style={{ color: 'var(--vscode-testing-iconPassed)' }}>✓</span>{' '}
                {copied.prompt === 'teaching'
                  ? <>Teaching prompt copied. Start a new chat beside the loop and paste it with <strong>{PASTE_KEY}</strong>.</>
                  : <>Instruction copied. Paste it into the agent chat with <strong>{PASTE_KEY}</strong> and send it.</>}
              </span>
              <button onClick={() => setCopied(null)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
            </div>
          )}
          {state.notice && (
            <div style={{ padding: '7px 14px', background: state.notice.level === 'warning' ? 'var(--vscode-inputValidation-warningBackground)' : 'var(--vscode-inputValidation-infoBackground)', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexShrink: 0, maxHeight: 200, overflowY: 'auto' }}>
              <div>
                <div><strong>{state.notice.title ?? 'Sync'}:</strong> {state.notice.message}</div>
                {state.notice.details?.length ? (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {state.notice.details.map((line, index) => <li key={index}>{line}</li>)}
                  </ul>
                ) : null}
              </div>
              <button onClick={() => dispatch({ type: 'SET_NOTICE', notice: null })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
            </div>
          )}

          {showProblems && state.problems.length > 0 && (
            <div role="status" style={{ padding: '8px 14px', background: 'var(--vscode-inputValidation-infoBackground)', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, display: 'flex', gap: 10, alignItems: 'flex-start', flexShrink: 0, maxHeight: 220, overflowY: 'auto' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>Some research files do not fit together. The research goes on, but these results may be ordered or linked wrongly until it is fixed.</div>
                <ul style={{ margin: '4px 0 6px', paddingLeft: 18, opacity: 0.85 }}>{state.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
                <button style={buttonStyle('primary')} title="Copies an instruction and opens the agent chat; paste it there."
                  onClick={() => graphAction({ action: 'agent', prompt: `The Research Assistant reports these problems in the research files:\n${state.problems.map((problem) => `- ${problem}`).join('\n')}\nExplain each in plain words and propose a fix; change nothing until I agree.` })}>
                  Ask the agent to fix it ↗
                </button>
              </div>
              <button onClick={() => setShowProblems(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
            </div>
          )}

          {state.activeView === 'project' ? (
            <ProjectView
              content={state.projectMd}
              summary={state.projectSummary}
              onOpenNode={(id) => { const node = state.nodes.find((item) => item.id === id); if (node) handleNavigateNode(node); }}
              projectRoot={state.projectRoot}
              initialized={state.initialized}
              paths={state.paths}
              layoutMode={layoutMode}
              splitRatio={splitRatio}
              onLayoutChange={handleLayoutChange}
              onSplitRatioChange={handleSplitRatioChange}
              onSave={handleSaveProjectMd}
              onOpenNodeLink={(href) => handleOpenResearchLink(state.paths?.projectMd ?? 'research/project.md', href)}
              onInitProject={() => send({ type: 'initProject' })}
              onRefreshProject={() => send({ type: 'refreshProject' })}
            />
          ) : showRemarkList ? (
            state.creatingRemark ? (
              <RemarkCreate
                targets={remarkTargets}
                initialTarget={state.creatingRemark.target}
                onCreate={(input) => { send({ type: 'addRemark', ...input }); dispatch({ type: 'CREATE_REMARK', create: null }); }}
                onCancel={() => dispatch({ type: 'CREATE_REMARK', create: null })}
              />
            ) : selectedRemark ? (
              <RemarkDetail
                key={selectedRemark.id}
                remark={selectedRemark}
                target={state.nodes.find((node) => node.id === selectedRemark.target)}
                onOpenTarget={handleNavigateNode}
                onOpenFile={(filePath) => send({ type: 'openInEditor', filePath })}
                onApprove={(id) => send({ type: 'approveRemark', id })}
                onCheck={(id) => send({ type: 'checkRemark', id })}
                onSave={(id, changes) => send({ type: 'editRemark', id, title: changes.title, body: changes.body, anchor: changes.anchor })}
                onArchive={(id, archived) => send({ type: 'archiveRemark', id, archived })}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>
                Select a remark to read and edit
              </div>
            )
          ) : showPaperList ? (
            selectedPaper ? (
              <PaperDetail
                key={selectedPaper.slug}
                paper={selectedPaper}
                onSave={handleSavePaper}
                onOpenPdf={handleOpenPdf}
                sourcePdfDirectory={state.paths?.localSourcePdfs ?? 'research-local/raw_papers'}
                onOpenNodeLink={(href) => handleOpenResearchLink(state.paths?.paperIndex ?? 'research/papers.md', href)}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>
                Select a paper to view and edit
              </div>
            )
          ) : showNodeList ? (
            selectedNode && selectedDetail ? (
              <NodeDetail
                key={selectedNode.id}
                id={selectedNode.id}
                frontmatter={selectedDetail.frontmatter}
                body={selectedDetail.body}
                remarks={selectedDetail.remarks}
                layoutMode={layoutMode}
                splitRatio={splitRatio}
                metadataHeight={metadataHeight}
                allNodes={state.nodes}
                definitionPath={state.paths?.definitions ?? 'research/definitions'}
                allPapers={state.papers}
                sourcePdfDirectory={state.paths?.localSourcePdfs ?? 'research-local/raw_papers'}
                onLayoutChange={handleLayoutChange}
                onSplitRatioChange={handleSplitRatioChange}
                onMetadataHeightChange={handleMetadataHeightChange}
                onSave={handleSaveNode}
                onOpenInEditor={handleOpenInEditor}
                onOpenPdf={handleOpenPdf}
                onNavigateNode={handleNavigateNode}
                onOpenNodeLink={(href) => handleOpenResearchLink(selectedNode.filePath, href)}
                onOpenFile={(filePath) => send({ type: 'openInEditor', filePath })}
                onApproveRemark={(remarkId) => send({ type: 'approveRemark', id: remarkId, nodeId: selectedNode.id })}
                onCheckRemark={(remarkId) => send({ type: 'checkRemark', id: remarkId })}
                onOpenRemark={openRemark}
                onAddRemark={() => dispatch({ type: 'CREATE_REMARK', create: { target: selectedNode.id } })}
              />
            ) : selectedNode ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>Loading…</div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>Select a node to view and edit</div>
            )
          ) : state.activeView === 'graph' ? (
            <OverviewPage
              payload={state.graph}
              onAction={graphAction}
              onNavigate={openNodeById}
              onShowInResults={showInResults}
              onOpenNeeds={openNeeds}
              onOpenActivity={() => handleSetView('activity')}
              onOpenPaper={openPaper}
              onOpenSettings={() => handleSetView('settings')}
            />
          ) : state.activeView === 'needs' ? (
            <NeedsYouPage payload={state.graph} selectedKey={needsKey} onSelect={setNeedsKey} onAction={graphAction} onNavigate={openNodeById} onShowInResults={showInResults} onOpenPaper={openPaper} />
          ) : state.activeView === 'results' ? (
            state.graph
              ? <ProgressView payload={state.graph} options={resultsOptions} onOptions={setResultsOptions} selectedId={resultsSelected} onSelect={setResultsSelected} onNavigate={openNodeById} onAction={graphAction} />
              : <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading the results…</div>
          ) : state.activeView === 'activity' ? (
            <ActivityPage entries={state.graph?.history} onShow={showInResults} />
          ) : state.activeView === 'settings' ? (
            <SettingsView
              settings={state.settings}
              result={state.settingsResult}
              onSave={(requestId, patch) => send({ type: 'updateSettings', requestId, patch })}
              onNavigate={(id) => { const node = state.nodes.find((item) => item.id === id); if (node) handleNavigateNode(node); }}
              showTechnical={state.uiState.showTechnical}
              onShowTechnical={handleShowTechnical}
            />
          ) : state.activeView === 'manuscript' ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
              <div role="group" aria-label="Manuscript view" style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border)', borderRadius: 4, overflow: 'hidden' }}>
                <TabButton active={manuscriptTab === 'paper'} onClick={() => setManuscriptTab('paper')}>The paper</TabButton>
                <TabButton active={manuscriptTab === 'coverage'} onClick={() => setManuscriptTab('coverage')}>Which results it covers</TabButton>
              </div>
            </div>
            {manuscriptTab === 'coverage' ? (
              <div style={{ flex: 1, minHeight: 0 }}>
                {state.graph
                  ? <CoverageMatrix payload={state.graph} highlightSection={coverageSection} onFocus={showInResults} onAction={graphAction} />
                  : <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>Loading…</div>}
              </div>
            ) : (
            <ManuscriptView
              status={state.manuscriptStatus}
              onBuild={() => send({ type: 'buildManuscript' })}
              onReload={() => send({ type: 'reloadManuscript' })}
              onOpenExternal={() => send({ type: 'openManuscriptPdf' })}
              onSetAutoBuild={(enabled) => send({ type: 'setManuscriptAutoBuild', enabled })}
              onApplySettings={() => send({ type: 'applyLatexBuildSettings' })}
              onInstallLatexWorkshop={() => send({ type: 'installLatexWorkshop' })}
            />
            )}
            </div>
          ) : null}
        </div>
      </div>

      {state.showCreateModal && (
        <CreateNodeModal
          assets={state.nodes.filter((node) => ASSET_TYPES.has(node.type) && node.filePath.startsWith(`${state.paths?.assets ?? 'research/assets'}/`))}
          allowedTypes={
            state.activeView === 'ideas'
              ? ['idea']
              : state.activeView === 'plans'
                ? ['plan']
              : state.activeView === 'definitions'
                ? ['definition']
                : [...ASSET_TYPE_LIST]
          }
          onConfirm={handleCreateNode}
          onCancel={() => dispatch({ type: 'TOGGLE_CREATE_MODAL' })}
        />
      )}
      {(packageModal?.kind === 'import' || packageModal?.kind === 'update') && (
        <ImportPackageModal
          update={packageModal.kind === 'update' ? packageModal.alias : undefined}
          preview={importPreview}
          busy={packageBusy}
          // No busy flag: the researcher may close the file dialog, and then no answer comes.
          onPick={(kind) => send({ type: 'packagePickSource', kind, update: packageModal.kind === 'update' ? packageModal.alias : undefined })}
          onAlias={(alias) => { if (importPreview) { setPackageBusy(true); send({ type: 'packagePreviewImport', source: importPreview.source, alias }); } }}
          onConfirm={(preview) => { setPackageBusy(true); send({ type: 'packageImport', source: preview.source, alias: preview.alias, update: preview.update }); }}
          onCancel={() => setPackageModal(null)}
        />
      )}
      {packageModal?.kind === 'export' && (
        <ExportPackageModal
          preview={exportPreview}
          busy={packageBusy}
          onChange={(request) => { setPackageBusy(true); send({ type: 'packagePreviewExport', request }); }}
          onConfirm={(request) => send({ type: 'packageExport', request })}
          onCancel={() => setPackageModal(null)}
        />
      )}
    </div>
    </TechnicalDetails.Provider>
  );
}
