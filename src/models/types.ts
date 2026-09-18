export type NodeType =
  | 'theorem'
  | 'lemma'
  | 'proposition'
  | 'definition'
  | 'example'
  | 'construction'
  | 'remark'
  | 'idea'
  | 'plan'
  | 'proof_record';

export type NodeStatus = 'draft' | 'approved' | 'deprecated' | 'archived';
export type IdeaStatus = 'pending' | 'failed';
export type ResearchStatus = NodeStatus | IdeaStatus;

export interface NodeSource {
  kind: 'paper' | 'self_proved' | 'textbook' | 'note';
  paper_id?: string;
  location?: string;
}

export interface NodeFrontmatter {
  type: NodeType;
  title: string;
  status?: ResearchStatus;
  tags: string[];
  source?: NodeSource;
  depends_on: string[];
  uses_definitions: string[];
  used_in: string[];
  related_assets: string[];
  target_asset?: string;
  inspired_by?: string[];
}

export interface ResearchNode {
  id: string;
  filePath: string;
  type: NodeType;
  title: string;
  status?: ResearchStatus;
  tags: string[];
  source?: NodeSource;
  depends_on: string[];
  uses_definitions: string[];
  used_in: string[];
  related_assets: string[];
  target_asset?: string;
  inspired_by?: string[];
  body: string;
}

export type LayoutMode = 'editor' | 'preview' | 'split';

export interface UIState {
  layoutMode: LayoutMode;
  splitRatio: number;     // fraction of width given to editor in split mode, 0.2–0.8
  nodeListWidth: number;  // pixel width of the node list column
  metadataHeight: number; // pixel height of the metadata pane in NodeDetail
}

export const DEFAULT_UI_STATE: UIState = {
  layoutMode: 'split',
  splitRatio: 0.5,
  nodeListWidth: 240,
  metadataHeight: 220,
};

export interface PaperEntry {
  slug: string;
  mdSection: string; // raw text of the ## slug section body (without the header line)
  bibEntry: string;  // full @type{slug,...} bib entry text
}

export type ProjectLayout = 'overleaf-shared' | 'legacy';

export interface ResearchAssistantConfig {
  version: 1;
  layout: ProjectLayout;
  latex: {
    projectRoot: string;
    main: string;
    bibliography: string;
    macros: string[];
    notations: string | null;
    sections: string;
  };
  research: {
    root: string;
    project: string;
    paperIndex: string;
    assets: string;
    definitions: string;
    ideas: string;
    plans: string;
    papers: string;
    localSourcePdfs: string;
  };
}

/** All paths are workspace-relative and normalized to POSIX separators. */
export interface ProjectPaths {
  config: string;
  mainTex: string;
  bibliography: string;
  macroFiles: string[];
  notations: string | null;
  sections: string;
  researchRoot: string;
  projectMd: string;
  paperIndex: string;
  assets: string;
  definitions: string;
  ideas: string;
  plans: string;
  papers: string;
  localSourcePdfs: string;
}

export interface ProjectPathSummary {
  layout: ProjectLayout;
  mainTex: string;
  bibliography: string;
  macroFiles: string[];
  notations: string | null;
  sections: string;
  projectMd: string;
  paperIndex: string;
  assets: string;
  definitions: string;
  ideas: string;
  plans: string;
  papers: string;
  localSourcePdfs: string;
}

export type ManuscriptBuildPhase =
  | 'idle'
  | 'compiling'
  | 'succeeded'
  | 'failed'
  | 'unavailable';

export interface ManuscriptStatus {
  phase: ManuscriptBuildPhase;
  mainTex: string;
  outputPdf: string;
  pdfUri?: string;
  pdfVersion?: number;
  latexWorkshopInstalled: boolean;
  autoBuild: boolean;
  configurationConflicts: string[];
  message?: string;
}

export interface AIService {
  ask(
    prompt: string,
    context: ResearchNode[],
    onChunk: (chunk: string) => void
  ): Promise<void>;
}
