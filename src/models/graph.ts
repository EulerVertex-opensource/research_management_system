/**
 * The dashboard's Graph tab payload: one derived view of the project, the
 * research graph, the loop's waiting items, and manuscript freshness. Built by
 * the extension (GraphViewModel), rendered by the webview. Pure types only, so
 * the webview can import them without pulling in Node modules.
 */

import type { NodeProgress } from '../domain/copy';
import type { UnderstandingLevel, UnderstandingState } from '../domain/understandingLevels';
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
  /** `remarks`: active remarks on it (annotations; see domain/remarks.ts). */
  counts: { plans: number; failedPlans: number; pendingPlans: number; ideas: number; remarks: number };
  /** For a definition: assumption or convention when it is one (definition_kind). */
  definitionKind?: 'assumption' | 'convention';
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
  /** A required result the agent added in autonomous mode, beside the researcher's own goals. */
  agentGoal?: boolean;
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
  /** One of the researcher's own results taken in with an intake: where it stands in the repair (Results → Repair). */
  repair?: RepairNodeView;
  /** A verified result: where the researcher stands on it (their own local mark) and the level the teaching chat aims for. */
  understanding?: { state: UnderstandingState; level?: UnderstandingLevel; suggested: UnderstandingLevel };
}

/**
 * Where one of the researcher's own results stands in the repair. `unchecked`: has a proof, no check yet;
 * `checking`: the agent checks it as written; `gap`: the check found a gap and the researcher has not asked for a
 * repair; `needs_repair`: a gap the loop will repair; `repairing`: a repair is under way; `review`: sound as written
 * or repaired and checked, waiting for the researcher; `stuck`: set aside; `to_prove`: it came without a proof.
 */
export type RepairState = 'unchecked' | 'checking' | 'gap' | 'needs_repair' | 'repairing' | 'review' | 'stuck' | 'to_prove' | 'done' | 'retired';

export interface RepairNodeView {
  /** The intake's decision ID. */
  intake: string;
  state: RepairState;
  /** For review and done: sound as written, repaired, or proved here (it came without a proof). */
  how?: 'sound' | 'repaired' | 'proved';
  /** The gap the independent check found. */
  gap?: string;
  /** Repair attempts that failed. */
  failed: number;
  /** The repair plan under way, or the one that produced the current proof. */
  plan?: string;
  /** For a repaired proof: the researcher's proof as written, and the proof now. */
  previous?: string;
  proof?: string;
  /** The agent is working on it right now. */
  active?: boolean;
  note?: string;
}

/** The researcher's own results taken in at once (`start --intake`), and how the repair ended. */
export interface IntakeView {
  id: string;
  at: string;
  source?: string;
  ids: string[];
  main: string[];
  /** Every result settled: the summary, the goals then, and the conjectures offered as next goals (`open`: still available). */
  closed?: { at: string; summary: string; required: string[]; candidates: Array<{ id: string; title: string; kind: 'conjecture' | 'idea'; open: boolean }> };
}

/** `serves`: the conjecture `from` would unblock or strengthen `to`; not a prerequisite either way. */
export type GraphEdgeType = 'depends_on' | 'uses_definition' | 'refutes' | 'serves';
/** `from` depends on `to`: the edge is drawn from prerequisite `to` to dependant `from`. */
export interface GraphEdgeView { from: string; to: string; type: GraphEdgeType }
/** Edges that make `to` a prerequisite of `from`: the ones layout, closures, and blocking follow. */
export function isPrerequisiteEdge(edge: { type: string }): boolean { return edge.type === 'depends_on' || edge.type === 'uses_definition'; }

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
  | { action: 'loop'; op: 'start' | 'resume' | 'extend' | 'openChat'; goal?: string }
  | { action: 'syncPull' }
  /** The researcher read a result marked for re-check again, and it still holds. */
  | { action: 'confirmRecheck'; id: string }
  /** The researcher's own mark of how well they know a verified result; `none` forgets it. */
  | { action: 'understand'; id: string; level: UnderstandingLevel | 'none' }
  /** Copy a teaching prompt (for one result, or for everything new) and open the agent chat. */
  | { action: 'teach'; id?: string };

export interface AttentionButton { label: string; action: GraphAction; kind?: 'primary' | 'secondary'; needsText?: string; /** Tooltip saying what the button does. */ hint?: string }

export interface AttentionItem {
  key: string;
  priority: AttentionPriority;
  category: 'question' | 'counterexample' | 'approval' | 'manuscript_invalid' | 'manuscript_stale' | 'parked' | 'uncovered' | 'unlocked' | 'required_inactive' | 'upstream' | 'loop' | 'recheck' | 'promote' | 'intake';
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
  /** A route map review: the detail shows the routes to `target` side by side. */
  routeMap?: boolean;
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
 * `agent_idle`: the loop runs but no agent is in a turn (none picked it up,
 * it handed back, or it went quiet); `stalled`: quiet for far longer.
 */
export type LoopHealthKey = 'idle' | 'goals' | 'working' | 'needs_you' | 'set_aside' | 'stopped' | 'stalled' | 'agent_idle' | 'paused' | 'done';
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
  /** The agent's last sign of life while the loop runs (its own hooks, commands, and tool calls). */
  agentAt?: string;
  statusBar: { text: string; level: 'normal' | 'warning' | 'error' };
  /** Stable while the situation is the same; a change in it may deserve a popup. */
  signature: string;
}

/** An autonomous run as the Overview shows it, derived from the loop state and its events. */
export interface AutonomyView {
  /** Working on its own now; false once it handed back. */
  active: boolean;
  startedAt: string;
  handedOverAt?: string;
  /** Why it handed back. */
  reason?: string;
  spent: number;
  budget: number;
  /** When the time limit hands back; absent without one. */
  deadline?: string;
  revisions: number;
  revisionLimit: number;
  /** Attempts per result in this run, most first. */
  spending: Array<{ id: string; attempts: number }>;
  /** Results it proved in this run. */
  proved: string[];
  /** Results it set aside in this run and that are still set aside, with its note. */
  setAside: Array<{ id: string; note?: string }>;
  /** Required results it added in this run's revisions of the goals. */
  addedGoals: string[];
  /** Questions it decided itself; each is kept as an idea. */
  decided: number;
  /** Approved in this run on an independent agent's check alone: definitions, results taken from a source, and proofs re-checked after something they rest on changed. */
  agentChecked?: AgentCheckedView;
}

export interface AgentCheckedView { definitions: string[]; citations: string[]; rechecked: string[]; proofs: string[] }

/** One line of the Activity timeline. */
export interface HistoryEntry { at: string; text: string; tone: LoopTone; target?: string }

/**
 * One route to a result (a plan with route_lemmas), for the Routes view, the result card, and the
 * route map review. `left`: how much is still to prove through it (its proof number), null when it
 * cannot prove its target any more.
 */
export interface RouteView {
  planId: string;
  title: string;
  target: string;
  origin: 'researcher' | 'agent' | 'fork';
  forkedFrom?: string;
  state: 'live' | 'reduced' | 'suspended' | 'dead' | 'failed' | 'won' | 'superseded' | 'abandoned' | 'frozen';
  reduction: 'none' | 'written' | 'verified' | 'failed';
  lemmas: string[];
  settledLemmas: number;
  left: number | null;
  round?: number;
  death?: { kind: 'refuted' | 'inactive' | 'cycle'; lemma: string };
  suspendedBy?: string[];
  supersededBy?: string;
  /** Why it was dropped (`## Dropped`) or failed (`## Failure`): the first paragraph, cut short. */
  closedReason?: string;
}

export interface GraphPayload {
  generatedAt: string;
  required: string[];
  projectRevision?: number;
  projectApproved: boolean;
  loop?: { status: string; stage: string; assetId?: string };
  /** Auto mode is on: some approvals are granted without the researcher. */
  autoMode?: boolean;
  /** The autonomous run: its budget while it works, and what it did once it handed back. */
  autonomy?: AutonomyView;
  manuscriptState?: string;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  attention: AttentionItem[];
  sections: SectionView[];
  coverage: CoverageRow[];
  health: LoopHealth;
  /** Newest first. */
  history: HistoryEntry[];
  /** Verified results, and how many of them are new to the researcher or changed since they studied them. */
  study?: { behind: number; total: number };
  /** Every route to every result (parallel routes), oldest first. */
  routes?: RouteView[];
  /** The researcher's own results taken in at once (intakes), newest first. */
  intakes?: IntakeView[];
}
