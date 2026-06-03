export type NodeType =
  | 'theorem'
  | 'lemma'
  | 'proposition'
  | 'definition'
  | 'example'
  | 'construction'
  | 'remark'
  | 'idea';

export type NodeStatus = 'draft' | 'approved' | 'deprecated' | 'archived';

export interface NodeSource {
  kind: 'paper' | 'self_proved' | 'textbook' | 'note';
  paper_id?: string;
  location?: string;
}

export interface NodeFrontmatter {
  type: NodeType;
  title: string;
  status: NodeStatus;
  tags: string[];
  source?: NodeSource;
  depends_on: string[];
  used_in: string[];
  related_assets: string[];
}

export interface ResearchNode {
  id: string;
  filePath: string;
  type: NodeType;
  title: string;
  status: NodeStatus;
  tags: string[];
  source?: NodeSource;
  depends_on: string[];
  used_in: string[];
  related_assets: string[];
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

export interface AIService {
  ask(
    prompt: string,
    context: ResearchNode[],
    onChunk: (chunk: string) => void
  ): Promise<void>;
}
