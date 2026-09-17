import React, { useReducer, useCallback, useEffect, useRef } from 'react';
import { ResearchNode, NodeType, NodeFrontmatter, LayoutMode, UIState, DEFAULT_UI_STATE, PaperEntry, ProjectPathSummary, ManuscriptStatus } from '../src/models/types';
import { ExtensionMessage } from '../src/models/messages';
import { useExtension } from './hooks/useExtension';
import { Sidebar, SidebarView } from './components/Sidebar';
import { NodeList } from './components/NodeList';
import { NodeDetail } from './components/NodeDetail';
import { ProjectView } from './components/ProjectView';
import { PaperList } from './components/PaperList';
import { PaperDetail } from './components/PaperDetail';
import { AddPaperButton } from './components/AddPaperButton';
import { CreateNodeModal } from './components/CreateNodeModal';
import { ManuscriptView } from './components/ManuscriptView';

interface NodeDetailData {
  frontmatter: NodeFrontmatter;
  body: string;
}

interface State {
  nodes: ResearchNode[];
  projectRoot: string;
  initialized: boolean;
  paths: ProjectPathSummary | null;
  selectedNodeId: string | null;
  nodeDetails: Record<string, NodeDetailData>;
  projectMd: string | null;
  papers: PaperEntry[];
  papersLoaded: boolean;
  selectedPaperSlug: string | null;
  activeView: SidebarView;
  showCreateModal: boolean;
  error: string | null;
  manuscriptStatus: ManuscriptStatus | null;
  uiState: UIState;
}

type Action =
  | { type: 'INIT'; nodes: ResearchNode[]; projectRoot: string; uiState: UIState; initialized: boolean; paths: ProjectPathSummary }
  | { type: 'NODES_UPDATED'; nodes: ResearchNode[] }
  | { type: 'NODE_DETAIL'; id: string; frontmatter: NodeFrontmatter; body: string }
  | { type: 'PROJECT_MD'; content: string }
  | { type: 'PAPERS_DATA'; papers: PaperEntry[] }
  | { type: 'SELECT_NODE'; id: string }
  | { type: 'SELECT_PAPER'; slug: string }
  | { type: 'SET_VIEW'; view: SidebarView }
  | { type: 'TOGGLE_CREATE_MODAL' }
  | { type: 'SET_ERROR'; message: string | null }
  | { type: 'MANUSCRIPT_STATUS'; status: ManuscriptStatus }
  | { type: 'SET_LAYOUT'; layoutMode: LayoutMode }
  | { type: 'SET_SPLIT_RATIO'; splitRatio: number }
  | { type: 'SET_NODE_LIST_WIDTH'; width: number }
  | { type: 'SET_METADATA_HEIGHT'; height: number };

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
    case 'NODE_DETAIL':
      return { ...state, nodeDetails: { ...state.nodeDetails, [action.id]: { frontmatter: action.frontmatter, body: action.body } } };
    case 'PROJECT_MD':
      return { ...state, projectMd: action.content };
    case 'PAPERS_DATA':
      return { ...state, papers: action.papers, papersLoaded: true };
    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.id };
    case 'SELECT_PAPER':
      return { ...state, selectedPaperSlug: action.slug };
    case 'SET_VIEW':
      return { ...state, activeView: action.view, selectedNodeId: null, selectedPaperSlug: null };
    case 'TOGGLE_CREATE_MODAL':
      return { ...state, showCreateModal: !state.showCreateModal };
    case 'SET_ERROR':
      return { ...state, error: action.message };
    case 'MANUSCRIPT_STATUS':
      return { ...state, manuscriptStatus: action.status };
    case 'SET_LAYOUT':
      return { ...state, uiState: { ...state.uiState, layoutMode: action.layoutMode } };
    case 'SET_SPLIT_RATIO':
      return { ...state, uiState: { ...state.uiState, splitRatio: action.splitRatio } };
    case 'SET_NODE_LIST_WIDTH':
      return { ...state, uiState: { ...state.uiState, nodeListWidth: action.width } };
    case 'SET_METADATA_HEIGHT':
      return { ...state, uiState: { ...state.uiState, metadataHeight: action.height } };
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
  papers: [],
  papersLoaded: false,
  selectedPaperSlug: null,
  activeView: 'assets',
  showCreateModal: false,
  error: null,
  manuscriptStatus: null,
  uiState: DEFAULT_UI_STATE,
};

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const handleMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.type) {
      case 'init':
        dispatch({ type: 'INIT', nodes: msg.nodes, projectRoot: msg.projectRoot, uiState: msg.uiState, initialized: msg.initialized, paths: msg.paths });
        break;
      case 'nodesUpdated':
        dispatch({ type: 'NODES_UPDATED', nodes: msg.nodes });
        break;
      case 'nodeDetail':
        dispatch({ type: 'NODE_DETAIL', id: msg.id, frontmatter: msg.frontmatter, body: msg.body });
        break;
      case 'projectMd':
        dispatch({ type: 'PROJECT_MD', content: msg.content });
        break;
      case 'papersData':
        dispatch({ type: 'PAPERS_DATA', papers: msg.papers });
        break;
      case 'manuscriptStatus':
        dispatch({ type: 'MANUSCRIPT_STATUS', status: msg.status });
        break;
      case 'error':
        dispatch({ type: 'SET_ERROR', message: msg.message });
        break;
    }
  }, []);

  const send = useExtension(handleMessage);

  useEffect(() => {
    send({ type: 'ready' });
  }, [send]);

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
  };

  const handleSelectNode = (node: ResearchNode) => {
    dispatch({ type: 'SELECT_NODE', id: node.id });
    // Always fetch fresh content so external edits (e.g. from Copilot) are reflected immediately
    send({ type: 'getNodeContent', id: node.id });
  };

  const handleSaveNode = (id: string, frontmatter: NodeFrontmatter, body: string) => {
    send({ type: 'saveNode', id, frontmatter, body });
  };

  const handleSaveProjectMd = (content: string) => {
    send({ type: 'saveProjectMd', content });
  };

  const handleCreateNode = (nodeType: NodeType, title: string) => {
    send({ type: 'createNode', nodeType, title });
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
    state.activeView === 'ideas' ? 'idea' : undefined;

  const showNodeList = state.activeView === 'assets' || state.activeView === 'ideas';
  const showPaperList = state.activeView === 'papers';
  const showListColumn = showNodeList || showPaperList;

  const { layoutMode, splitRatio, nodeListWidth, metadataHeight } = state.uiState;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar active={state.activeView} onChange={handleSetView} />

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
                  {state.activeView === 'assets' ? 'Assets' : state.activeView === 'ideas' ? 'Ideas' : 'Papers'}
                </span>
                {showNodeList && (
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
              </div>

              {/* List body */}
              {showNodeList && (
                <NodeList
                  nodes={state.nodes}
                  selectedId={state.selectedNodeId}
                  onSelect={handleSelectNode}
                  filterType={filterType}
                />
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

          {state.activeView === 'project' ? (
            <ProjectView
              content={state.projectMd}
              projectRoot={state.projectRoot}
              initialized={state.initialized}
              paths={state.paths}
              layoutMode={layoutMode}
              splitRatio={splitRatio}
              onLayoutChange={handleLayoutChange}
              onSplitRatioChange={handleSplitRatioChange}
              onSave={handleSaveProjectMd}
              onInitProject={() => send({ type: 'initProject' })}
              onRefreshProject={() => send({ type: 'refreshProject' })}
            />
          ) : showPaperList ? (
            selectedPaper ? (
              <PaperDetail
                key={selectedPaper.slug}
                paper={selectedPaper}
                onSave={handleSavePaper}
                onOpenPdf={handleOpenPdf}
                sourcePdfDirectory={state.paths?.localSourcePdfs ?? 'research-local/raw_papers'}
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
                layoutMode={layoutMode}
                splitRatio={splitRatio}
                metadataHeight={metadataHeight}
                allNodes={state.nodes}
                allPapers={state.papers}
                sourcePdfDirectory={state.paths?.localSourcePdfs ?? 'research-local/raw_papers'}
                onLayoutChange={handleLayoutChange}
                onSplitRatioChange={handleSplitRatioChange}
                onMetadataHeightChange={handleMetadataHeightChange}
                onSave={handleSaveNode}
                onOpenInEditor={handleOpenInEditor}
                onOpenPdf={handleOpenPdf}
              />
            ) : selectedNode ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>Loading…</div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 13 }}>Select a node to view and edit</div>
            )
          ) : state.activeView === 'manuscript' ? (
            <ManuscriptView
              status={state.manuscriptStatus}
              onBuild={() => send({ type: 'buildManuscript' })}
              onReload={() => send({ type: 'reloadManuscript' })}
              onOpenExternal={() => send({ type: 'openManuscriptPdf' })}
              onSetAutoBuild={(enabled) => send({ type: 'setManuscriptAutoBuild', enabled })}
              onApplySettings={() => send({ type: 'applyLatexBuildSettings' })}
              onInstallLatexWorkshop={() => send({ type: 'installLatexWorkshop' })}
            />
          ) : null}
        </div>
      </div>

      {state.showCreateModal && (
        <CreateNodeModal
          allowedTypes={
            state.activeView === 'ideas'
              ? ['idea']
              : ['theorem', 'lemma', 'proposition', 'definition', 'example', 'construction', 'remark']
          }
          onConfirm={handleCreateNode}
          onCancel={() => dispatch({ type: 'TOGGLE_CREATE_MODAL' })}
        />
      )}
    </div>
  );
}
