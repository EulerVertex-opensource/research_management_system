import type { DefinitionKind, IdeaKind, NodeType, ResearchStatus } from '../domain/nodeKinds';
import type { NodeSource } from '../domain/schema';

export type { DefinitionKind, IdeaKind, NodeStatus, NodeType, PlanStatus, IdeaStatus, ResearchStatus } from '../domain/nodeKinds';
export type { NodeSource } from '../domain/schema';

/** Frontmatter as the dashboard edits it: forward relations only; reverse ones are derived. */
export interface NodeFrontmatter {
  type: NodeType;
  title: string;
  status?: ResearchStatus;
  tags: string[];
  source?: NodeSource;
  depends_on: string[];
  uses_definitions: string[];
  related_assets: string[];
  target_asset?: string;
  inspired_by?: string[];
  refutes?: string;
  /** Only on a conjecture: the results it would unblock or strengthen. */
  serves?: string[];
  idea_kind?: IdeaKind;
  /** Only on a definition: definition (absent), assumption, or convention. */
  definition_kind?: DefinitionKind;
}

/** A remark as the dashboard shows it under its result (see domain/remarks.ts). */
export interface RemarkView {
  id: string;
  title: string;
  /** The asset or definition it is on, and that result's title. */
  target: string;
  targetTitle?: string;
  status: 'active' | 'archived';
  body: string;
  anchor?: string;
  origin: 'researcher' | 'agent';
  from: 'teaching' | 'loop' | 'other';
  /** Written for an earlier version of the result. */
  stale: boolean;
  /** The researcher approved this exact text for the paper. */
  approved: boolean;
  /** The researcher's own, or an agent's they checked as worded now. */
  checked: boolean;
  file: string;
  at: string;
}

export interface ResearchNode extends NodeFrontmatter {
  id: string;
  filePath: string;
  body: string;
  /** 1-based position in dependency order among active assets or definitions; derived, never stored. */
  order?: number;
  /** A succeeded plan whose target's proof changed since the plan produced it; derived, never stored. */
  outdated?: boolean;
  /** Set on library nodes (known results under the library folder); derived from the path. */
  origin?: 'library';
  collection?: string;
  /** A route plan's route fields (route_lemmas, route_title, its own origin, ...); see ROUTE_FIELDS. */
  route?: Record<string, unknown>;
}

/** What the dashboard derives for project.md instead of storing it there: progress, open questions, writing. */
export interface ProjectSummary {
  /** project.md predates schema 2; `research-maintenance migrate` upgrades it. */
  legacy: boolean;
  required: Array<{ id: string; role?: string; title?: string; status?: string }>;
  assets: { approved: number; draft: number };
  openQuestions: Array<{ id: string; title: string }>;
  /** Section titles in manuscript order, or empty when there is no outline yet. */
  writingSections: string[];
}

export type LayoutMode = 'editor' | 'preview' | 'split';

export interface UIState {
  layoutMode: LayoutMode;
  splitRatio: number;     // fraction of width given to editor in split mode, 0.2–0.8
  nodeListWidth: number;  // pixel width of the node list column
  metadataHeight: number; // pixel height of the metadata pane in NodeDetail
  showTechnical: boolean; // show IDs, file paths, and the agent's raw last step on the research pages
}

export const DEFAULT_UI_STATE: UIState = {
  layoutMode: 'split',
  splitRatio: 0.5,
  nodeListWidth: 240,
  metadataHeight: 220,
  showTechnical: false,
};

export interface PaperEntry {
  slug: string;
  mdSection: string; // raw text of the ## slug section body (without the header line)
  bibEntry: string;  // full @type{slug,...} bib entry text
}

export type ProjectLayout = 'overleaf-shared' | 'legacy';

/** Git collaboration settings for `research-loop sync`. */
export interface SyncConfig {
  /** Main collaboration remote (GitHub or Overleaf). */
  remote: string;
  /** Branch on `remote`; defaults to the current branch. */
  branch?: string;
  /** Optional Overleaf remote that receives a fast-forward push after publishing to `remote`. */
  overleafRemote?: string;
  overleafBranch: string;
  strategy: 'rebase' | 'merge';
  /** Extra paths committed on publish, besides the research folders and the manuscript. */
  include: string[];
  /** Command that compiles the manuscript for `sync prepare --latex`, e.g. "latexmk -pdf -interaction=nonstopmode main.tex". */
  latexCommand?: string;
  signCommits: boolean;
  /** Overrides git user.email as the collaborator identity in records. */
  identity?: string;
}

export interface ResearchAssistantConfig {
  version: 1;
  layout: ProjectLayout;
  sync?: SyncConfig;
  /** Per-stage token budgets for the loop's context packs, overriding the defaults. */
  contextBudgets?: Record<string, number>;
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
    /** Known results imported from earlier work or papers; defaults to `<root>/library`. */
    library?: string;
    /** Remarks (annotations on results); defaults to `remarks` beside the ideas folder. */
    remarks?: string;
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
  /** Remarks: annotations on results and definitions, one file each; not nodes. */
  remarks: string;
  /** Library of known results: `<library>/<collection>/assets|definitions/lib_*.md`. */
  library: string;
  writingRoot: string;
  writingOutline: string;
  writingSections: string;
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
