/**
 * The dashboard's Graph tab payload: one derived view of the project, the
 * research graph, the loop's waiting items, and manuscript freshness. Built by
 * the extension (GraphViewModel), rendered by the webview. Pure types only, so
 * the webview can import them without pulling in Node modules.
 */

import type { NodeProgress } from '../domain/copy';
export type { NodeProgress } from '../domain/copy';

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
  /** One of five states for the graph, derived from status and flags. */
  progress: NodeProgress;
  /** Short state label, e.g. "Set aside" or "Needs your review". */
  progressLabel: string;
  /** One line under the title, e.g. "3 proof attempts failed" or "Needs Key bound first". */
  progressDetail: string;
  /** Taken from the literature rather than proved here: a paper or textbook source, or a library result. */
  cited?: { kind: string; paper?: string; location?: string };
  /** Marked for re-check: the ID of the statement or definition it rests on that changed (rigor "flag"). */
  recheck?: string;
  /** The statement (Markdown, the part above the proof), shown when a result's card is opened. */
  statement: string;
  /** For a required result: how many of the results it rests on (itself included) are done. */
  closure?: { done: number; total: number };
}

export type GraphEdgeType = 'depends_on' | 'uses_definition' | 'refutes';
/** `from` depends on `to`: the edge is drawn from prerequisite `to` to dependant `from`. */
export interface GraphEdgeView { from: string; to: string; type: GraphEdgeType }

export type AttentionPriority = 0 | 1 | 2 | 3 | 4;

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
  | { action: 'agent'; prompt: string }
  /** Loop controls the researcher may use from the dashboard. */
  | { action: 'loop'; op: 'start' | 'resume' | 'extend' | 'openChat' }
  | { action: 'syncPull' }
  /** The researcher read a result marked for re-check again, and it still holds. */
  | { action: 'confirmRecheck'; id: string };

export interface AttentionButton { label: string; action: GraphAction; kind?: 'primary' | 'secondary'; needsText?: string }

export interface AttentionItem {
  key: string;
  priority: AttentionPriority;
  category: 'question' | 'counterexample' | 'approval' | 'manuscript_invalid' | 'manuscript_stale' | 'parked' | 'uncovered' | 'unlocked' | 'required_inactive' | 'upstream' | 'loop' | 'recheck';
  title: string;
  /** Extra detail, e.g. the agent's summary of what it wants reviewed; may be empty. */
  reason: string;
  /** Why it matters, in one sentence. */
  why: string;
  /** What happens if the researcher does nothing. */
  ifIgnored: string;
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

/**
 * What the loop is doing and whose turn it is, for the status card on top of
 * the Overview, the status bar, and the popups. Derived, never stored.
 */
export type LoopHealthKey = 'idle' | 'goals' | 'working' | 'needs_you' | 'set_aside' | 'stopped' | 'stalled' | 'paused' | 'done';
export type LoopTone = 'neutral' | 'info' | 'warning' | 'error' | 'success';

/** One numbered reason the loop cannot continue. */
export interface LoopBlocker { target?: string; title: string; detail: string; buttons: AttentionButton[] }

export interface LoopHealth {
  key: LoopHealthKey;
  /** Who has to move next. */
  turn: 'agent' | 'researcher' | 'nobody';
  tone: LoopTone;
  eyebrow: string;
  headline: string;
  body: string;
  /** From the root cause down to the main result it holds up (node IDs). */
  chain: string[];
  blockers: LoopBlocker[];
  ifIgnored: string;
  buttons: AttentionButton[];
  /** The agent's last reported step. */
  last?: { at: string; text: string };
  statusBar: { text: string; level: 'normal' | 'warning' | 'error' };
  /** Stable while the situation is the same; a change in it may deserve a popup. */
  signature: string;
}

/** One line of the "What happened" timeline. */
export interface HistoryEntry { at: string; text: string; tone: LoopTone; target?: string }

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
  health: LoopHealth;
  /** Newest first. */
  history: HistoryEntry[];
}
