/**
 * The dashboard's Graph tab payload: one derived view of the project, the
 * research graph, the loop's waiting items, and manuscript freshness. Built by
 * the extension (GraphViewModel), rendered by the webview. Pure types only, so
 * the webview can import them without pulling in Node modules.
 */

/** Why a node needs a look; the webview colors and filters by these. */
export type GraphFlag =
  | 'awaiting_approval' // an approval request is queued for this node
  | 'question' // the pending loop question is about this node
  | 'counterexample' // a draft example refutes it and waits for the researcher
  | 'refuted' // an approved example refutes it
  | 'parked'
  | 'active' // the loop is working on it now
  | 'searching' // an object search (counterexample or construction) is running on it
  | 'uncovered' // required, approved, and no manuscript section presents it
  | 'manuscript_stale' // a locked section presenting it is stale because of it
  | 'manuscript_invalid'; // a locked section presents it while it is missing, deprecated, or unapproved

export interface GraphNodeView {
  id: string;
  kind: 'asset' | 'definition';
  type: string;
  title: string;
  status: string;
  required: boolean;
  /** In the dependency closure of the required results. */
  inScope: boolean;
  /** Required result this node serves: its own ID when required, `shared` when it serves several, `other` when none. */
  lane: string;
  flags: GraphFlag[];
  /** Definitions an asset uses, shown as chips instead of nodes by default. */
  definitions: string[];
  counts: { plans: number; failedPlans: number; pendingPlans: number; ideas: number };
  /** Manuscript sections whose brief presents this node. */
  sections: string[];
  /** Required results that (transitively) depend on this node. */
  blocks: string[];
  /** For a counterexample: the asset it refutes. */
  refutes?: string;
  /** Library node (a known result); `collection` is its library folder. */
  origin?: 'library';
  collection?: string;
  filePath: string;
}

export type GraphEdgeType = 'depends_on' | 'uses_definition' | 'refutes';
/** `from` depends on `to`: the edge is drawn from prerequisite `to` to dependant `from`. */
export interface GraphEdgeView { from: string; to: string; type: GraphEdgeType }

export type AttentionPriority = 0 | 1 | 2 | 3;

export type GraphAction =
  | { action: 'approve'; requestId: string }
  | { action: 'requestChanges'; requestId: string; text: string }
  | { action: 'answer'; questionId: string; text: string }
  | { action: 'park'; assetId: string }
  | { action: 'unpark'; assetId: string }
  | { action: 'lock'; section: string }
  | { action: 'openNode'; id: string }
  | { action: 'openTex'; section: string; line?: number }
  /** Agent work stays in the chat: the extension copies the prompt and opens the chat. */
  | { action: 'agent'; prompt: string };

export interface AttentionButton { label: string; action: GraphAction; kind?: 'primary' | 'secondary'; needsText?: string }

export interface AttentionItem {
  key: string;
  priority: AttentionPriority;
  category: 'question' | 'counterexample' | 'approval' | 'manuscript_invalid' | 'manuscript_stale' | 'parked' | 'uncovered' | 'unlocked' | 'required_inactive';
  title: string;
  reason: string;
  /** Node the item is about, for focus and impact. */
  target?: string;
  section?: string;
  /** Required results waiting on this item. */
  blocks: string[];
  /** Manuscript sections the item touches. */
  sections: string[];
  since?: string;
  buttons: AttentionButton[];
}

export type CoverageState = 'current' | 'stale' | 'invalid' | 'planned' | 'dependency';

export interface CoverageCell { state: CoverageState; uses: string[]; blocks: string[] }
export interface CoverageRow { id: string; title: string; required: boolean; uncovered: boolean; cells: Record<string, CoverageCell> }

export interface SectionBlockView { id: string; policy: string; sources: string[]; state: 'current' | 'stale' | 'invalid'; lines?: [number, number]; reasons: string[] }

export interface SectionView {
  id: string;
  title: string;
  state: 'unlocked' | 'current' | 'stale' | 'invalid';
  texPath: string;
  texExists: boolean;
  lockedRevision?: number;
  /** Brief sources, direct. */
  sources: string[];
  /** Everything the lock recorded, direct sources and their dependencies. */
  bound: string[];
  blocks: SectionBlockView[];
  reasons: string[];
}

export interface GraphPayload {
  generatedAt: string;
  required: string[];
  projectRevision?: number;
  projectApproved: boolean;
  loop?: { status: string; stage: string; assetId?: string };
  /** Auto mode is on: some approvals are granted without the researcher. */
  autoMode?: boolean;
  manuscriptState?: string;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  attention: AttentionItem[];
  sections: SectionView[];
  coverage: CoverageRow[];
}
