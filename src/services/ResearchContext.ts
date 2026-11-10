import { LoopStage } from './ResearchLoopModel';
import { projectSection, requiredAssetIds, requiredResults } from '../domain/project';
import { hasSection, sectionContent, statementPart, stripManagedBlocks } from '../domain/sections';
import { SearchMode, SearchSlot } from '../domain/search';
import { RouteSlot, isRoutePlan, routeLemmas } from '../domain/routeSchema';
import { searchFields, searchScore, searchSummary, searchWords } from '../domain/registry';
import { PROMOTION_TARGETS, REUSABLE_IDEA_KINDS, WARNING_IDEA_STATUSES, WARNING_SECTION, toIdeaKind } from '../domain/nodeKinds';
import { ideaUsage, usageLine } from '../domain/ideaUsage';

/**
 * Deterministic context packs for the research loop. For each stage the loop
 * decides which nodes, and which sections of them, the agent needs; the agent
 * reads the rendered pack instead of browsing research folders. Pure; shared by
 * the core, the CLI, and tests. Must not import vscode.
 */

export interface ContextNode {
  id: string; file: string; raw: string; data: Record<string, any>; body: string;
  /** Set on library nodes: known results the loop approves once and never proves. */
  origin?: 'library'; collection?: string;
}

/** What of a node to show: everything, the statement (body before ## Proof), the title and first paragraph, or named sections. */
export type ContextView = 'all' | 'statement' | 'summary' | string[];
export type ContextKind = 'project' | 'asset' | 'definition' | 'plan' | 'idea' | 'check' | 'candidate' | 'index' | 'papers' | 'text';
export type ContextWorker = 'light' | 'deep';

export interface ContextItem {
  kind: ContextKind;
  id: string;
  file?: string;
  view: ContextView;
  /** 0 is always kept; higher numbers are dropped first when the pack exceeds its budget. */
  priority: number;
  reason: string;
  /** For kind `text`: content the loop compiled (the search board), rendered as is. */
  text?: string;
}

export interface ContextManifest {
  stage: LoopStage;
  assetId?: string;
  planId?: string;
  budget: number;
  worker?: ContextWorker;
  items: ContextItem[];
  /** What this stage deliberately leaves out, stated so the agent does not go looking for it. */
  excluded: string[];
  notes: string[];
}

export interface ContextSources {
  project: string;
  projectFile: string;
  paperIndex: string;
  paperIndexFile: string;
  assets: Map<string, ContextNode>;
  definitions: Map<string, ContextNode>;
  plans: Map<string, ContextNode>;
  ideas: Map<string, ContextNode>;
  checks: Map<string, ContextNode>;
  /** Object-search candidates; absent in callers that predate the search. */
  candidates?: Map<string, ContextNode>;
  /** The project's proof style (research/style.md), which a proof the loop writes follows; absent when none is recorded. */
  style?: string;
  /** Earlier stage reports, oldest first; the pack keeps those for the current asset. */
  reports: Array<{ stage?: string; outcome?: string; summary?: string; assetId?: string; at?: string }>;
}

export interface ContextFocus {
  stage: LoopStage;
  assetId?: string;
  planId?: string;
  counterexampleId?: string;
  /** Stage `conjecture`: the conjecture idea to make precise. */
  ideaId?: string;
  missing?: string[];
  incomplete?: string[];
  researcherInput?: string;
  changesRequested?: string;
  direction?: string;
  /** The direction is the agent's own, given in autonomous mode with `budget allocate`. */
  ownDirection?: boolean;
  /** Object search: the round, this worker's slot (search) or the round's results (search_summary), and the board. */
  search?: { mode: SearchMode; round: number; slot?: SearchSlot; board: string; roundDigest?: string; requested?: boolean };
  /** Stage `verify_proof` as a re-check: what changed since the proof was written or last checked. */
  recheck?: string[];
  /** Stage `verify_node`: the definition, or the cited or library result, to check. */
  node?: { id: string; mode: 'definition' | 'citation' | 'proof'; changed?: string[] };
  /** A round of routes: its number, this worker's slot (stage route), and the result every route of a fork starts from. */
  route?: { round: number; slot?: RouteSlot; fork?: string };
}

export interface RenderedContext { text: string; tokens: number; included: ContextItem[]; omitted: ContextItem[]; files: string[] }

export const DEFAULT_CONTEXT_BUDGETS: Partial<Record<LoopStage, number>> = {
  discuss_goals: 4000, draft_project: 8000, review_project: 4000, scaffold: 12000, sources: 16000,
  search: 8000, search_summary: 4000, verify_counterexample: 10000, verify_construction: 10000, plan: 16000, execute: 30000, verify_proof: 20000, verify_node: 12000, conjecture: 10000,
  route: 16000, route_merge: 12000, review_routes: 4000, reduce: 30000, verify_reduction: 20000,
};

/** Stages that get a pack, and which subagent tier runs them. */
export const STAGE_WORKERS: Partial<Record<LoopStage, ContextWorker>> = {
  scaffold: 'light', sources: 'light', search: 'deep', search_summary: 'light', verify_counterexample: 'deep', verify_construction: 'deep', plan: 'deep', execute: 'deep', verify_proof: 'deep', verify_node: 'deep', conjecture: 'deep',
  route: 'deep', route_merge: 'deep', reduce: 'deep', verify_reduction: 'deep',
};

export function hasContextPack(stage: LoopStage): boolean { return stage in DEFAULT_CONTEXT_BUDGETS; }

/** Rough token estimate; good enough to budget packs, not a tokenizer. */
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

const strip = (text: string) => stripManagedBlocks(text).replace(/\n{3,}/g, '\n\n').trim();
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Required results plus their transitive dependencies in dependency order; missing IDs are reported, not thrown. */
export function assetClosure(required: string[], assets: Map<string, { data: Record<string, any> }>): { order: string[]; missing: string[]; cycle?: string } {
  const order: string[] = []; const missing: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>(); let cycle: string | undefined;
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { cycle = id; return; }
    const asset = assets.get(id);
    if (!asset) { if (!missing.includes(id)) missing.push(id); return; }
    visiting.add(id);
    for (const dep of list(asset.data.depends_on)) visit(dep);
    visiting.delete(id); visited.add(id); order.push(id);
  };
  required.forEach(visit);
  return { order, missing, cycle };
}

/** Definitions the given assets use, plus the definitions those depend on. */
export function definitionClosure(order: string[], assets: Map<string, { data: Record<string, any> }>, definitions: Map<string, { data: Record<string, any> }>): string[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of list(definitions.get(id)?.data.depends_on)) visit(dep);
  };
  for (const id of order) for (const definition of list(assets.get(id)?.data.uses_definitions)) visit(definition);
  return [...seen];
}

/** The stage contract: which nodes and sections each stage reads, and what it must not read. */
export function planContext(focus: ContextFocus, sources: ContextSources, budget = DEFAULT_CONTEXT_BUDGETS[focus.stage] ?? 8000): ContextManifest {
  const items: ContextItem[] = [];
  const excluded: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (kind: ContextKind, id: string, file: string | undefined, view: ContextView, priority: number, reason: string) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, id, file, view, priority, reason });
  };
  const asset = (id: string, view: ContextView, priority: number, reason: string) => { const node = sources.assets.get(id); if (node) add('asset', id, node.file, view, priority, reason); };
  const definition = (id: string, priority: number, reason: string) => { const node = sources.definitions.get(id); if (node) add('definition', id, node.file, 'all', priority, reason); };
  const deps = (id: string) => list(sources.assets.get(id)?.data.depends_on);
  const definitionsOf = (ids: string[], direct: number, indirect: number) => {
    const directIds = new Set(ids.flatMap((id) => list(sources.assets.get(id)?.data.uses_definitions)));
    for (const id of definitionClosure(ids, sources.assets, sources.definitions)) definition(id, directIds.has(id) ? direct : indirect, directIds.has(id) ? 'used definition' : 'definition a used definition depends on');
  };
  const target = focus.assetId;
  if (focus.researcherInput) notes.push(`Researcher input: ${focus.researcherInput}`);
  if (focus.changesRequested) notes.push(`The researcher requested changes: ${focus.changesRequested}`);
  if (focus.node?.changed?.length) notes.push(`Re-check: ${focus.node.changed.join(', ')} changed since this proof was last checked. The pack shows their current text. Check every step that uses them against it: a step that held for the old text may not hold now.`);
  if (focus.recheck?.length) notes.push(`Re-check: ${focus.recheck.join(', ')} changed since this proof was written or last checked. The pack shows their current text. Check every step that uses them against it: a step that held for the old text may not hold now.`);
  if (focus.direction) notes.push(`${focus.ownDirection ? 'Your own latest direction (autonomous mode), which this plan must follow' : 'Latest researcher direction'}: ${focus.direction}`);

  switch (focus.stage) {
    case 'discuss_goals':
      add('project', 'project', sources.projectFile, ['Main Problem', 'Scope and Assumptions'], 0, 'current goals');
      // Open questions live in question ideas, not in project.md.
      for (const idea of sources.ideas.values()) if (idea.data.status === 'draft' && idea.data.idea_kind === 'question') add('idea', idea.id, idea.file, 'summary', 1, 'open question');
      excluded.push('other research nodes (not needed to discuss goals)');
      break;
    case 'draft_project':
      add('project', 'project', sources.projectFile, 'all', 0, 'the file this stage edits');
      add('index', 'index', undefined, 'all', 2, 'existing node IDs, so required results reuse them');
      excluded.push('node bodies');
      break;
    case 'review_project':
      add('project', 'project', sources.projectFile, ['Main Problem', 'Scope and Assumptions', 'Intended Contribution', 'Required Results'], 0, 'what the researcher approves');
      break;
    case 'scaffold':
      add('project', 'project', sources.projectFile, ['Main Problem', 'Required Results'], 0, 'what to scaffold');
      add('index', 'index', undefined, 'all', 1, 'existing IDs; do not duplicate them');
      for (const id of focus.incomplete ?? []) asset(id, 'all', 1, 'statement to complete');
      if (focus.missing?.length) notes.push(`Missing asset IDs to create: ${focus.missing.join(', ')}`);
      excluded.push('bodies of existing assets and definitions (use show <id> when a new statement must match one)', 'paper transcriptions');
      break;
    case 'sources': {
      add('project', 'project', sources.projectFile, ['Required Results'], 0, 'what needs support');
      const { order } = assetClosure(requiredAssetIds(sources.project), sources.assets);
      for (const id of order) if (sources.assets.get(id)?.data.status === 'draft') asset(id, 'statement', 1, 'draft result a source could support');
      add('papers', 'papers', sources.paperIndexFile, 'all', 2, 'indexed papers (headings and URLs)');
      add('index', 'index', undefined, 'all', 3, 'existing IDs');
      excluded.push('full paper transcriptions (use show <paper_slug> for an outline, then --section)', 'proofs');
      break;
    }
    case 'search': {
      if (!target || !focus.search) break;
      const { mode, slot } = focus.search;
      asset(target, 'statement', 0, mode === 'refute' ? 'the statement to refute' : 'the specification to construct');
      add('text', 'search_board', undefined, 'all', 0, 'what earlier rounds found');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'direct dependency');
      definitionsOf([target], 1, 3);
      const idea = slot ? sources.ideas.get(slot.direction) : undefined;
      if (idea) add('idea', idea.id, idea.file, 'all', 0, 'the test case this slot tries');
      const nearMiss = slot?.candidateId ? sources.candidates?.get(slot.candidateId) : undefined;
      if (nearMiss) add('candidate', nearMiss.id, nearMiss.file, 'all', 0, 'the near-miss to repair');
      for (const check of sources.checks.values()) if (check.data.target_asset === target && check.data.type === 'falsification_check') add('check', check.id, check.file, ['Limitations'], 3, 'what an earlier check did not cover');
      // A refuted observation linked to or worded like the target: its counterexample may point at one here.
      const refuted = [...sources.ideas.values()].filter((item) => item.data.status === 'refuted' && list(item.data.related_assets).includes(target)).map((item) => item.id);
      for (const id of [...refuted, ...similarIdeas(target, sources).filter((item) => sources.ideas.get(item.id)?.data.status === 'refuted').map((item) => item.id)].slice(0, DEAD_END_LIMIT)) {
        const node = sources.ideas.get(id)!;
        add('idea', id, node.file, ['Refutation'], 2, 'a refuted observation: its counterexample may point at one here');
      }
      // A search the researcher asked for after proofs failed: where a proof broke can show where a counterexample lives.
      if (focus.search.requested) for (const plan of sources.plans.values()) if (plan.data.target_asset === target && plan.data.type === 'plan' && plan.data.status === 'failed') add('plan', plan.id, plan.file, ['Failure'], 3, 'where a proof attempt broke');
      if (slot) notes.push(`Your slot: ${slot.slot}, round ${focus.search.round}. Direction ${slot.direction}: ${slot.label}`);
      if (focus.search.requested) notes.push('The researcher asked for this deeper search; the failed proof attempts below show where proofs broke.');
      excluded.push(`the proof of ${target} (${mode === 'refute' ? 'refute the statement, not the argument' : 'construct from the specification'})`, 'indirect dependencies', focus.search.requested ? 'plan checklists' : 'plans', 'the other slots of this round');
      break;
    }
    case 'verify_construction': {
      if (!target) break;
      asset(target, 'statement', 0, 'the specification to verify against');
      const found = focus.counterexampleId ? sources.candidates?.get(focus.counterexampleId) : undefined;
      if (found) add('candidate', found.id, found.file, ['Object'], 0, 'the object to verify');
      definitionsOf([target], 1, 3);
      for (const dep of deps(target)) asset(dep, 'statement', 2, 'direct dependency');
      excluded.push(`the candidate's own checks and the search reasoning (verify independently)`, 'proofs');
      break;
    }
    case 'search_summary':
      if (!target || !focus.search) break;
      asset(target, 'statement', 0, focus.search.mode === 'refute' ? 'the statement searched' : 'the specification searched');
      add('text', 'search_board', undefined, 'all', 0, 'obstructions and limitations so far');
      add('text', 'search_round', undefined, 'all', 0, `this round's candidates and why they failed`);
      excluded.push('candidate bodies (show <candidate id> for one when a failure line is unclear)', 'proofs', 'plans');
      break;
    case 'verify_counterexample':
      if (focus.counterexampleId) asset(focus.counterexampleId, 'all', 0, 'the candidate to recheck');
      if (target) {
        asset(target, 'statement', 0, 'the statement it claims to refute');
        definitionsOf([target, ...(focus.counterexampleId ? [focus.counterexampleId] : [])], 1, 3);
        for (const dep of deps(target)) asset(dep, 'statement', 2, 'direct dependency');
      }
      excluded.push('the search reasoning (verify independently)', `the proof of ${target ?? 'the target'}`);
      break;
    case 'plan':
    case 'execute': {
      if (!target) break;
      asset(target, 'statement', 0, 'the statement to prove (frozen)');
      const current = focus.planId ? sources.plans.get(focus.planId) : undefined;
      if (current) add('plan', current.id, current.file, 'all', 0, focus.stage === 'execute' ? 'the plan to execute' : 'the pending plan to execute instead of writing a new one');
      // Before dependencies, so a result both used and adapted shows its proof.
      for (const id of list(current?.data.adapts)) asset(id, 'all', 1, 'result whose proof the plan adapts');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'dependency, used as a black box');
      definitionsOf([target], 1, 2);
      if (focus.stage === 'plan') {
        for (const plan of sources.plans.values()) {
          if (plan.data.target_asset !== target || plan.id === focus.planId) continue;
          if (plan.data.type === 'plan' && plan.data.status === 'failed') add('plan', plan.id, plan.file, ['Goal', 'Failure'], 2, 'failed plan: name it under ## Difference from failed plans');
          else if (plan.data.type === 'plan' && plan.data.status === 'succeeded') add('plan', plan.id, plan.file, ['Outcome'], 3, 'earlier successful attempt');
        }
        // Open linked ideas, whether or not a plan used them; dead ends and ideas from similar results come in the idea guide.
        for (const idea of sources.ideas.values()) if (idea.data.status === 'draft' && list(idea.data.related_assets).includes(target)) add('idea', idea.id, idea.file, 'summary', 3, 'related idea');
        const analogues = libraryAnalogues(target, sources);
        if (analogues.length && !current) {
          seen.add('text:library_analogues');
          items.push({ kind: 'text', id: 'library_analogues', view: 'all', priority: 2, reason: 'known results resembling the target', text: renderAnalogues(analogues) });
        }
        const guide = current ? '' : renderIdeaGuide(target, sources);
        if (guide) {
          seen.add('text:idea_guide');
          items.push({ kind: 'text', id: 'idea_guide', view: 'all', priority: 2, reason: 'ideas from similar results, dead ends, and observations to promote', text: guide });
        }
        excluded.push('proofs of dependencies', 'full checklists of failed plans (show <plan> for one when needed)');
      } else {
        excluded.push('other plans and ideas', 'proofs of dependencies');
        if (sources.style?.trim()) {
          seen.add('text:proof_style');
          items.push({ kind: 'text', id: 'proof_style', view: 'all', priority: 1, reason: 'how the researchers want proofs written: follow it', text: sources.style.trim() });
        }
      }
      break;
    }
    case 'conjecture': {
      const idea = focus.ideaId ? sources.ideas.get(focus.ideaId) : undefined;
      if (!idea) break;
      add('idea', idea.id, idea.file, 'all', 0, 'the conjecture idea to make precise');
      const related = list(idea.data.related_assets);
      for (const id of related) asset(id, 'statement', 1, 'a result the idea relates to; serves may name it');
      definitionsOf(related, 1, 3);
      add('project', 'project', sources.projectFile, ['Main Problem', 'Required Results'], 1, 'the goals a conjecture may serve');
      for (const node of sources.assets.values()) if (!node.origin && node.data.type === 'conjecture' && ['draft', 'approved'].includes(node.data.status)) asset(node.id, 'statement', 2, 'an existing conjecture; do not state it again');
      add('index', 'index', undefined, 'all', 3, 'existing IDs, for depends_on, uses_definitions, and serves');
      excluded.push('proofs (a conjecture is stated, not proved)', 'paper transcriptions');
      break;
    }
    case 'verify_node': {
      const node = focus.node;
      if (!node) break;
      if (node.mode === 'proof') {
        asset(node.id, 'all', 0, 'the statement and the proof to verify, as written');
        for (const dep of deps(node.id)) asset(dep, 'statement', 1, 'dependency the proof may use as a black box');
        definitionsOf([node.id], 1, 2);
        excluded.push('remarks', 'proofs of dependencies');
        break;
      }
      if (node.mode === 'definition') {
        definition(node.id, 0, 'the definition to check');
        for (const dep of list(sources.definitions.get(node.id)?.data.depends_on)) definition(dep, 1, 'a definition it builds on');
        const users = [...sources.assets.values()].filter((item) => list(item.data.uses_definitions).includes(node.id));
        for (const user of users) asset(user.id, 'statement', 1, 'a result that uses it: the definition must say what this statement needs');
        add('project', 'project', sources.projectFile, ['Main Problem', 'Required Results'], 2, 'the goals: a definition must not make them trivial or vacuous');
      } else {
        asset(node.id, 'all', 0, 'the result taken from a source: check it against the cited location');
        definitionsOf([node.id], 1, 2);
        add('papers', 'papers', sources.paperIndexFile, 'all', 2, 'indexed papers: read the cited location with show <paper_slug> --section ...');
      }
      excluded.push('remarks', 'plans and proofs of other results');
      break;
    }
    case 'route': {
      if (!target) break;
      const slot = focus.route?.slot;
      asset(target, 'statement', 0, 'the statement every route must reach (frozen)');
      if (focus.route?.fork) asset(focus.route.fork, 'statement', 0, 'the proved result every route of this round starts from');
      const idea = slot?.ideaId ? sources.ideas.get(slot.ideaId) : undefined;
      if (idea) add('idea', idea.id, idea.file, 'all', 0, 'the researcher\'s route this slot works out');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'dependency every route may use as a black box');
      definitionsOf([target], 1, 2);
      for (const plan of sources.plans.values()) {
        if (plan.data.type !== 'plan' || plan.data.target_asset !== target) continue;
        if (plan.data.status === 'failed') add('plan', plan.id, plan.file, ['Goal', 'Route', 'Failure'], 2, 'failed attempt: name it under ## Difference from failed plans');
        else if (plan.data.status === 'pending' && isRoutePlan(plan.data)) add('plan', plan.id, plan.file, ['Route'], 2, 'an open route: plan a different one');
      }
      const analogues = libraryAnalogues(target, sources);
      if (analogues.length) { seen.add('text:library_analogues'); items.push({ kind: 'text', id: 'library_analogues', view: 'all', priority: 2, reason: 'known results resembling the target', text: renderAnalogues(analogues) }); }
      const guide = renderIdeaGuide(target, sources);
      if (guide) { seen.add('text:idea_guide'); items.push({ kind: 'text', id: 'idea_guide', view: 'all', priority: 3, reason: 'ideas from similar results, dead ends, and observations to promote', text: guide }); }
      add('index', 'index', undefined, 'all', 3, 'existing IDs: reuse a result as a lemma instead of stating it again');
      if (slot) notes.push(`Your slot: ${slot.slot}, round ${focus.route?.round}, origin ${slot.origin}. Direction: ${slot.label}`);
      excluded.push('proofs of dependencies', 'the other slots of this round');
      break;
    }
    case 'route_merge':
    case 'review_routes': {
      if (!target) break;
      asset(target, 'statement', 0, 'the result the routes reach');
      const lemmas = new Set<string>();
      for (const plan of sources.plans.values()) {
        if (plan.data.type !== 'plan' || plan.data.target_asset !== target || plan.data.status !== 'pending' || !isRoutePlan(plan.data)) continue;
        const current = plan.data.route_round === focus.route?.round;
        add('plan', plan.id, plan.file, ['Route'], current ? 0 : 1, current ? 'a route of this round' : 'an earlier open route');
        for (const lemma of routeLemmas(plan.data)) lemmas.add(lemma);
      }
      for (const lemma of lemmas) asset(lemma, 'statement', 1, 'a lemma of an open route');
      if (focus.stage === 'route_merge') add('index', 'index', undefined, 'all', 2, 'results already in the project: a lemma that states one of them is merged into it');
      excluded.push('proofs', 'reductions');
      break;
    }
    case 'reduce':
    case 'verify_reduction': {
      if (!target) break;
      const current = focus.planId ? sources.plans.get(focus.planId) : undefined;
      asset(target, 'statement', 0, 'the statement the reduction proves (frozen)');
      if (current) add('plan', current.id, current.file, focus.stage === 'reduce' ? 'all' : ['Route', 'Reduction'], 0, focus.stage === 'reduce' ? 'the route to reduce' : 'the reduction to check, as written');
      for (const lemma of list(current?.data.route_lemmas)) asset(lemma, 'statement', 0, 'route lemma, used as a black box');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'dependency, used as a black box');
      definitionsOf([target], 1, 2);
      if (focus.stage === 'reduce' && sources.style?.trim()) { seen.add('text:proof_style'); items.push({ kind: 'text', id: 'proof_style', view: 'all', priority: 1, reason: 'how the researchers want proofs written: follow it', text: sources.style.trim() }); }
      excluded.push('proofs of the lemmas and dependencies', focus.stage === 'reduce' ? 'other routes' : 'the plan checklist and its reasoning (check the reduction as written)');
      break;
    }
    case 'verify_proof':
      if (!target) break;
      asset(target, 'all', 0, 'the statement and the proof to verify');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'dependency the proof may use as a black box');
      definitionsOf([target], 1, 2);
      excluded.push('the plan and its reasoning (verify the proof as written)', 'proofs of dependencies');
      break;
    default:
      break;
  }
  if (focus.search) {
    for (const item of items) {
      if (item.id === 'search_board') item.text = focus.search.board;
      if (item.id === 'search_round') item.text = `## Round ${focus.search.round} candidates\n\n${focus.search.roundDigest ?? '- none'}`;
    }
  }
  return { stage: focus.stage, assetId: target, planId: focus.planId, budget, worker: STAGE_WORKERS[focus.stage], items, excluded, notes };
}

export interface LibraryAnalogue { id: string; collection?: string; status: string; title: string; summary: string; score: number }

/** At most this many analogues, and at most this many from one collection, so one source does not crowd out the rest. */
export const ANALOGUE_LIMIT = 10;
const ANALOGUE_PER_COLLECTION = 3;

/**
 * Library results that resemble the target but that it does not depend on:
 * the same kind of theorem proved in another setting, whose argument a plan
 * may adapt. Ranked by the words of the target's title, tags, and the titles
 * of its definitions, plus the definitions both use (or that the target's
 * definitions were derived from).
 */
/** What a result is about, for finding similar ones: its own words (title, tags), its definitions' words, and its definitions with what they derive from. */
function targetTerms(target: ContextNode, sources: ContextSources): { own: Set<string>; terms: string[]; shared: Set<string> } {
  const definitionIds = list(target.data.uses_definitions);
  const definitionTitles = definitionIds.map((id) => String(sources.definitions.get(id)?.data.title ?? id.replace(/_/g, ' ')).replace(/^Definition\s*\((.*)\)\s*$/i, '$1'));
  // The target's own title and tags say what it is; its definitions only say where it lives, so they count half.
  const own = new Set(searchWords([String(target.data.title ?? ''), ...list(target.data.tags)].join(' ')));
  const terms = [...new Set([...own, ...searchWords(definitionTitles.join(' '))])];
  const shared = new Set(definitionIds.flatMap((id) => { const from = sources.definitions.get(id)?.data.derived_from; return typeof from === 'string' ? [id, from] : [id]; }));
  return { own, terms, shared };
}

export function libraryAnalogues(targetId: string, sources: ContextSources, limit = ANALOGUE_LIMIT): LibraryAnalogue[] {
  const target = sources.assets.get(targetId);
  if (!target) return [];
  const { own, terms, shared } = targetTerms(target, sources);
  const skip = new Set([targetId, ...list(target.data.depends_on)]);
  const library = [...sources.assets.values()].filter((node) => node.origin === 'library');
  // Inverse document frequency over the library: a word every result shares ranks nothing.
  const frequency = new Map<string, number>();
  for (const node of library) {
    const fields = searchFields(node);
    for (const term of new Set([...fields.title, ...fields.tags, ...fields.statement])) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const weight = (term: string) => (own.has(term) ? 2 : 1) * Math.log((library.length + 1) / ((frequency.get(term) ?? 0) + 1));
  const ranked = library
    .filter((node) => !skip.has(node.id))
    .map((node) => ({ node, score: searchScore(node, terms, weight) + 3 * list(node.data.uses_definitions).filter((id) => shared.has(id)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const perCollection = new Map<string, number>();
  const picked: LibraryAnalogue[] = [];
  for (const { node, score } of ranked) {
    if (picked.length >= limit) break;
    const collection = node.collection ?? '';
    if ((perCollection.get(collection) ?? 0) >= ANALOGUE_PER_COLLECTION) continue;
    perCollection.set(collection, (perCollection.get(collection) ?? 0) + 1);
    picked.push({ id: node.id, collection: node.collection, status: String(node.data.status ?? '-'), title: String(node.data.title ?? node.id).replace(/\s+/g, ' '), summary: searchSummary(statementOf(node.body)), score });
  }
  return picked;
}

/** At most this many open ideas from similar results, and this many dead ends, in a plan pack. */
export const IDEA_SUGGESTION_LIMIT = 3;
export const DEAD_END_LIMIT = 4;
/** Minimum match for a project result to count as similar, and for an idea's own words to match the target. */
const SIMILAR_RESULT_MIN = 4;
const SIMILAR_IDEA_MIN = 4;
/** A plan that used the idea proved a similar result: the strongest reason to try it again. */
const PROVED_SIMILAR_BONUS = 5;

export interface IdeaSuggestion { id: string; score: number; reason: string; warning: boolean }
/** Words most result titles share ("Main theorem", "Key lemma"); the project is too small for word frequencies to discount them. */
const GENERIC_RESULT_WORDS = new Set(searchWords('main key theorem lemma proposition corollary result claim statement definition every all any some exist exists there holds true'));

/**
 * Ideas recorded elsewhere that may serve this result, found without any link to it: ideas worded
 * like it, ideas about similar project results, and ideas that inspired the plans that proved them.
 * Open approaches and observations are offered for reuse; refuted and obstructed ones as dead
 * ends. Ideas already linked to the target (related_assets) are left to the caller.
 */
export function similarIdeas(targetId: string, sources: ContextSources): IdeaSuggestion[] {
  const target = sources.assets.get(targetId);
  if (!target) return [];
  const found = targetTerms(target, sources);
  const own = new Set([...found.own].filter((term) => !GENERIC_RESULT_WORDS.has(term)));
  const terms = found.terms.filter((term) => !GENERIC_RESULT_WORDS.has(term));
  const shared = found.shared;
  if (!terms.length && !shared.size) return [];
  const weight = (term: string) => (own.has(term) ? 2 : 1);
  const best = new Map<string, IdeaSuggestion>();
  const offer = (id: string, score: number, reason: string) => {
    const idea = sources.ideas.get(id);
    if (!idea || list(idea.data.related_assets).includes(targetId)) return;
    const status = String(idea.data.status ?? 'draft');
    const warning = WARNING_IDEA_STATUSES.has(status);
    if (!warning && !(status === 'draft' && REUSABLE_IDEA_KINDS.has(toIdeaKind(idea.data.idea_kind)))) return;
    const previous = best.get(id);
    if (!previous || previous.score < score) best.set(id, { id, score, reason, warning });
  };
  for (const idea of sources.ideas.values()) {
    const score = searchScore(idea, terms, weight);
    if (score >= SIMILAR_IDEA_MIN) offer(idea.id, score, 'worded like this result');
  }
  const similar = [...sources.assets.values()]
    .filter((node) => !node.origin && node.id !== targetId && node.data.type !== 'example')
    .map((node) => ({ id: node.id, score: searchScore(node, terms, weight) + 3 * list(node.data.uses_definitions).filter((id) => shared.has(id)).length + (node.data.type === target.data.type ? 1 : 0) }))
    .filter((entry) => entry.score >= SIMILAR_RESULT_MIN)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5);
  for (const { id: assetId, score } of similar) {
    for (const idea of sources.ideas.values()) if (list(idea.data.related_assets).includes(assetId)) offer(idea.id, score, `recorded for the similar result ${assetId}`);
    for (const plan of sources.plans.values()) {
      if (plan.data.target_asset !== assetId || plan.data.status !== 'succeeded') continue;
      for (const id of list(plan.data.inspired_by)) offer(id, score + PROVED_SIMILAR_BONUS, `used by ${plan.id}, which proved the similar result ${assetId}`);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Plan-pack block: where linked ideas were used, ideas from similar results, dead ends, and observations to promote first. */
function renderIdeaGuide(targetId: string, sources: ContextSources): string {
  const usage = ideaUsage([...sources.plans.values()].map((plan) => ({ id: plan.id, target_asset: typeof plan.data.target_asset === 'string' ? plan.data.target_asset : undefined, status: String(plan.data.status ?? 'pending'), inspired_by: list(plan.data.inspired_by) })));
  const depends = new Set(list(sources.assets.get(targetId)?.data.depends_on));
  const linked = [...sources.ideas.values()].filter((idea) => list(idea.data.related_assets).includes(targetId));
  const suggestions = similarIdeas(targetId, sources);
  const open = suggestions.filter((item) => !item.warning).slice(0, IDEA_SUGGESTION_LIMIT);
  const deadEnds = [
    ...linked.filter((idea) => WARNING_IDEA_STATUSES.has(String(idea.data.status))).map((idea) => ({ id: idea.id, reason: 'linked to this result' })),
    ...suggestions.filter((item) => item.warning),
  ].slice(0, DEAD_END_LIMIT);
  const kind = (idea: ContextNode) => toIdeaKind(idea.data.idea_kind);
  const title = (idea: ContextNode) => String(idea.data.title ?? idea.id).replace(/\s+/g, ' ');
  const firstParagraph = (text: string) => (strip(text).split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').slice(0, 300);
  const usedElsewhere = (id: string) => (usage.get(id)?.targets ?? []).filter((target) => target !== targetId);
  const lines: string[] = [];
  const usedLinked = linked.filter((idea) => String(idea.data.status) === 'draft' && usage.has(idea.id));
  if (usedLinked.length) lines.push('### Linked ideas plans already used', '', ...usedLinked.map((idea) => `- ${idea.id} (${kind(idea)}): ${title(idea)}; ${usageLine(usage.get(idea.id))}`), '');
  const became = linked.filter((idea) => String(idea.data.status) === 'resolved' && typeof idea.data.resolved_by === 'string' && sources.assets.has(String(idea.data.resolved_by)) && !depends.has(String(idea.data.resolved_by)));
  if (became.length) lines.push('### Linked ideas that became results', '', ...became.map((idea) => `- ${idea.id} became ${String(idea.data.resolved_by)}, which is not in depends_on; a plan that needs it cites it once the researcher adds the dependency (report question).`), '');
  if (open.length) {
    lines.push('### Ideas from similar results (not linked to this one)', '', 'An approach or observation used for another result is not used up: reuse it when it fits, and list it in inspired_by. An observation is not a proved fact: a step that needs it proves it in the plan, or it is promoted to a lemma first.', '');
    for (const item of open) {
      const idea = sources.ideas.get(item.id)!;
      const used = usageLine(usage.get(item.id));
      lines.push(`- ${idea.id} (${kind(idea)}): ${title(idea)}. Why: ${item.reason}${used ? `; ${used}` : ''}. ${firstParagraph(idea.body)}`);
    }
    lines.push('');
  }
  if (deadEnds.length) {
    lines.push('### Dead ends near this result', '', 'Do not assume a refuted observation, and do not retry an obstructed approach unless the plan says how it gets past the obstruction.', '');
    for (const item of deadEnds) {
      const idea = sources.ideas.get(item.id)!;
      const section = WARNING_SECTION[String(idea.data.status)];
      lines.push(`- ${idea.id} (${kind(idea)}, ${String(idea.data.status)}): ${title(idea)}. Why shown: ${item.reason}. ${section}: ${firstParagraph(sectionContent(idea.body, section) || idea.body)}`);
    }
    lines.push('');
  }
  const promote = [...linked, ...open.map((item) => sources.ideas.get(item.id)!)]
    .filter((idea) => kind(idea) === 'observation' && String(idea.data.status) === 'draft' && usedElsewhere(idea.id).length >= PROMOTION_TARGETS - 1);
  if (promote.length) lines.push('### Observations to promote before relying on them', '', ...promote.map((idea) => `- ${idea.id}: plans for ${usedElsewhere(idea.id).join(', ')} already rely on it. If this plan needs it too, promote it to a lemma first (idea promote ${idea.id} --id <lemma_id> --statement "..." --into ${targetId}), so the proof cites it through depends_on.`), '');
  return lines.join('\n').trim();
}

function renderAnalogues(analogues: LibraryAnalogue[]): string {
  return [
    '### Library analogues (not in depends_on)',
    '',
    'Known results that resemble the target, ranked by shared words and definitions. A draft one is not yet checked. Read its proof with `show <id> --section Proof` before deciding.',
    '',
    ...analogues.map((item) => `- ${item.id} (${item.collection ?? 'library'}, ${item.status}): ${item.title} — ${item.summary}`),
  ].join('\n');
}

/** A project section, or the required results from frontmatter (or the legacy section) under that heading. */
export function projectPart(project: string, heading: string): string {
  if (heading !== 'Required Results') return projectSection(project, heading);
  return requiredResults(project).map((item) => `- ${item.id}${item.role ? `: ${item.role}` : ''}`).join('\n');
}

function frontmatterLine(data: Record<string, any>): string {
  const parts: string[] = [];
  for (const key of ['type', 'status', 'idea_kind', 'target_asset', 'refutes', 'outcome']) if (data[key] !== undefined) parts.push(`${key}: ${String(data[key])}`);
  for (const key of ['depends_on', 'uses_definitions', 'inspired_by', 'adapts']) if (list(data[key]).length) parts.push(`${key}: [${list(data[key]).join(', ')}]`);
  if (data.source?.kind) parts.push(`source: ${data.source.kind}${data.source.paper_id ? ` ${data.source.paper_id}` : ''}${data.source.location ? ` (${data.source.location})` : ''}`);
  return parts.join('; ');
}

/** Body before `## Proof`, without managed link blocks. */
export function statementOf(body: string): string { return strip(statementPart(body)); }

/** Named `## ` sections, in the given order; missing ones are skipped. */
export function sectionsOf(body: string, headings: string[]): string {
  return headings.map((heading) => {
    const content = heading === 'Statement' && !hasSection(body, 'Statement') ? statementOf(body) : strip(sectionContent(body, heading));
    return content ? `## ${heading}\n\n${content}` : '';
  }).filter(Boolean).join('\n\n');
}

/**
 * Project nodes, plus the library nodes they reference. The library can be
 * large, so the rest of it is only counted and found on demand by search.
 */
function nodeIndex(sources: ContextSources): string {
  const line = (node: ContextNode) => `${node.id} | ${node.data.type ?? '?'} | ${node.data.status ?? '-'} | deps=[${list(node.data.depends_on).join(',')}] | ${String(node.data.title ?? '').replace(/\s+/g, ' ')}${node.origin === 'library' ? ` | library:${node.collection ?? ''}` : ''}`;
  const all = [...sources.assets.values(), ...sources.definitions.values()];
  const project = all.filter((node) => node.origin !== 'library');
  const referenced = new Set(project.flatMap((node) => [...list(node.data.depends_on), ...list(node.data.uses_definitions)]));
  const library = all.filter((node) => node.origin === 'library');
  const shown = library.filter((node) => referenced.has(node.id));
  const hidden = library.length - shown.length;
  const more = hidden ? [`(${hidden} more library result(s) not referenced yet: ${LIBRARY_SEARCH_HINT})`] : [];
  return [...project, ...shown].map(line).concat(more).join('\n');
}

export const LIBRARY_SEARCH_HINT = 'research-loop library search <words>';

function paperIndexOutline(text: string): string {
  return text.split('\n').filter((line) => /^#{1,3} /.test(line) || /https?:\/\//.test(line)).join('\n').trim();
}

function renderItem(item: ContextItem, sources: ContextSources): string {
  if (item.kind === 'text') return item.text?.trim() ?? '';
  if (item.kind === 'index') return `### Node index (id | type | status | deps | title)\n\n${nodeIndex(sources) || '(no nodes yet)'}`;
  if (item.kind === 'papers') return `### Paper index — ${item.file}\n\n${paperIndexOutline(sources.paperIndex) || '(no indexed papers)'}`;
  if (item.kind === 'project') {
    const body = item.view === 'all' ? strip(sources.project) : (item.view as string[]).map((heading) => { const content = projectPart(sources.project, heading); return content ? `## ${heading}\n\n${content}` : ''; }).filter(Boolean).join('\n\n');
    return `### Project — ${item.file}\n\n${body || '(empty)'}`;
  }
  const map = { asset: sources.assets, definition: sources.definitions, plan: sources.plans, idea: sources.ideas, check: sources.checks, candidate: sources.candidates ?? new Map<string, ContextNode>() }[item.kind];
  const node = map.get(item.id);
  if (!node) return '';
  let body: string;
  if (item.view === 'all') body = strip(node.body);
  else if (item.view === 'statement') body = statementOf(node.body);
  else if (item.view === 'summary') body = strip(node.body).split(/\n\s*\n/)[0] ?? '';
  else body = sectionsOf(node.body, item.view);
  const scope = item.view === 'all' ? '' : ` [${Array.isArray(item.view) ? item.view.join(', ') : item.view}]`;
  return `### ${item.kind} ${item.id}${scope} — ${node.file}\n${String(node.data.title ?? '')}${frontmatterLine(node.data) ? `\n(${frontmatterLine(node.data)})` : ''}\n\n${body}`.trim();
}

/**
 * Render a manifest within its budget. Items are kept in priority order;
 * whole items are dropped (never cut mid-section), priority 0 always stays.
 */
export function renderContext(manifest: ContextManifest, sources: ContextSources, showCommand: string): RenderedContext {
  const reports = sources.reports.filter((report) => report.stage && (manifest.assetId ? report.assetId === manifest.assetId : true)).slice(-4);
  const header = [
    `# Context pack: stage ${manifest.stage}${manifest.assetId ? `, asset ${manifest.assetId}` : ''}${manifest.planId ? `, plan ${manifest.planId}` : ''}`,
    '',
    `Read only this pack for this stage. Anything else: \`${showCommand} <id> [--section Heading]\`, and say why you need it. Do not browse research folders.`,
    ...(manifest.excluded.length ? ['', `Not included on purpose: ${manifest.excluded.join('; ')}.`] : []),
    ...(manifest.notes.length ? ['', ...manifest.notes] : []),
    ...(reports.length ? ['', '## Earlier reports', '', ...reports.map((report) => `- ${report.stage} → ${report.outcome}: ${String(report.summary ?? '').replace(/\s+/g, ' ').trim()}`)] : []),
  ].join('\n');
  const rendered = manifest.items.map((item, index) => ({ item, index, text: renderItem(item, sources) })).filter((entry) => entry.text);
  let used = estimateTokens(header);
  const keep = new Set<number>();
  const omitted: ContextItem[] = [];
  for (const entry of [...rendered].sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)) {
    const cost = estimateTokens(entry.text) + 2;
    if (entry.item.priority === 0 || used + cost <= manifest.budget) { keep.add(entry.index); used += cost; } else omitted.push(entry.item);
  }
  const included = rendered.filter((entry) => keep.has(entry.index));
  const parts = [header, ...included.map((entry) => `---\n\n${entry.text}`)];
  if (omitted.length) parts.push(`---\n\n## Available on request (left out to stay within ~${manifest.budget} tokens)\n\n${omitted.map((item) => `- ${item.id}${Array.isArray(item.view) ? ` --section ${item.view.join(' --section ')}` : ''} (${item.reason})`).join('\n')}`);
  const text = parts.join('\n\n') + '\n';
  const files = [...new Set([sources.projectFile, ...included.map((entry) => entry.item.file).filter((file): file is string => Boolean(file))])];
  return { text, tokens: estimateTokens(text), included: included.map((entry) => entry.item), omitted, files };
}

/** One node for `show`: named sections, or the whole body. A paper transcription without sections shows only its outline. */
export function renderShow(node: ContextNode, sections: string[], kind: string): string {
  const head = `### ${kind} ${node.id} — ${node.file}${node.data.title ? `\n${String(node.data.title)}` : ''}${frontmatterLine(node.data) ? `\n(${frontmatterLine(node.data)})` : ''}`;
  if (sections.length) {
    const body = kind === 'paper' ? sections.map((heading) => anyLevelSection(node.body, heading)).filter(Boolean).join('\n\n') : sectionsOf(node.body, sections);
    return `${head}\n\n${body || `(no section ${sections.join(', ')})`}`;
  }
  if (kind === 'paper') {
    const outline = node.body.split('\n').filter((line) => /^#{1,4} /.test(line)).join('\n');
    return `${head}\n\nOutline (${estimateTokens(node.body)} tokens in full; add --section "<heading>" to read one part, or --full):\n\n${outline}`;
  }
  return `${head}\n\n${strip(node.body)}`;
}

/** A heading at any level, up to the next heading of the same or a higher level. */
function anyLevelSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => { const match = /^(#{1,6})\s+(.*)$/.exec(line); return Boolean(match && match[2].trim().toLowerCase().includes(heading.toLowerCase())); });
  if (start < 0) return '';
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = start + 1;
  while (end < lines.length && !(/^(#{1,6})\s/.test(lines[end]) && /^(#+)/.exec(lines[end])![1].length <= level)) end++;
  return lines.slice(start, end).join('\n').trim();
}
