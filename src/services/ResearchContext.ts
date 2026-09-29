import { LoopStage } from './ResearchLoopModel';
import { projectSection, requiredAssetIds, requiredResults } from '../domain/project';
import { hasSection, sectionContent, statementPart, stripManagedBlocks } from '../domain/sections';

/**
 * Deterministic context packs for the research loop. For each stage the loop
 * decides which nodes, and which sections of them, the agent needs; the agent
 * reads the rendered pack instead of browsing research folders. Pure; shared by
 * the core, the CLI, and tests. Must not import vscode.
 */

export interface ContextNode { id: string; file: string; raw: string; data: Record<string, any>; body: string }

/** What of a node to show: everything, the statement (body before ## Proof), the title and first paragraph, or named sections. */
export type ContextView = 'all' | 'statement' | 'summary' | string[];
export type ContextKind = 'project' | 'asset' | 'definition' | 'plan' | 'idea' | 'check' | 'index' | 'papers';
export type ContextWorker = 'light' | 'deep';

export interface ContextItem {
  kind: ContextKind;
  id: string;
  file?: string;
  view: ContextView;
  /** 0 is always kept; higher numbers are dropped first when the pack exceeds its budget. */
  priority: number;
  reason: string;
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
  /** Earlier stage reports, oldest first; the pack keeps those for the current asset. */
  reports: Array<{ stage?: string; outcome?: string; summary?: string; assetId?: string; at?: string }>;
}

export interface ContextFocus {
  stage: LoopStage;
  assetId?: string;
  planId?: string;
  counterexampleId?: string;
  missing?: string[];
  incomplete?: string[];
  researcherInput?: string;
  changesRequested?: string;
  direction?: string;
}

export interface RenderedContext { text: string; tokens: number; included: ContextItem[]; omitted: ContextItem[]; files: string[] }

export const DEFAULT_CONTEXT_BUDGETS: Partial<Record<LoopStage, number>> = {
  discuss_goals: 4000, draft_project: 8000, review_project: 4000, scaffold: 12000, sources: 16000,
  falsify: 12000, verify_counterexample: 10000, plan: 16000, execute: 30000,
};

/** Stages that get a pack, and which subagent tier runs them. */
export const STAGE_WORKERS: Partial<Record<LoopStage, ContextWorker>> = {
  scaffold: 'light', sources: 'light', falsify: 'deep', verify_counterexample: 'deep', plan: 'deep', execute: 'deep',
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
  if (focus.direction) notes.push(`Latest researcher direction: ${focus.direction}`);

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
    case 'falsify':
      if (!target) break;
      asset(target, 'statement', 0, 'the statement to refute');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'direct dependency');
      definitionsOf([target], 1, 3);
      for (const check of sources.checks.values()) if (check.data.target_asset === target) add('check', check.id, check.file, ['Limitations'], 3, 'what an earlier check did not cover');
      excluded.push(`the proof of ${target} (refute the statement, not the argument)`, 'indirect dependencies', 'plans and ideas');
      break;
    case 'verify_counterexample':
      if (focus.counterexampleId) asset(focus.counterexampleId, 'all', 0, 'the candidate to recheck');
      if (target) {
        asset(target, 'statement', 0, 'the statement it claims to refute');
        definitionsOf([target, ...(focus.counterexampleId ? [focus.counterexampleId] : [])], 1, 3);
        for (const dep of deps(target)) asset(dep, 'statement', 2, 'direct dependency');
      }
      excluded.push('the falsify stage reasoning (verify independently)', `the proof of ${target ?? 'the target'}`);
      break;
    case 'plan':
    case 'execute': {
      if (!target) break;
      asset(target, 'statement', 0, 'the statement to prove (frozen)');
      const current = focus.planId ? sources.plans.get(focus.planId) : undefined;
      if (current) add('plan', current.id, current.file, 'all', 0, focus.stage === 'execute' ? 'the plan to execute' : 'the pending plan to execute instead of writing a new one');
      for (const dep of deps(target)) asset(dep, 'statement', 1, 'dependency, used as a black box');
      definitionsOf([target], 1, 2);
      if (focus.stage === 'plan') {
        for (const plan of sources.plans.values()) {
          if (plan.data.target_asset !== target || plan.id === focus.planId) continue;
          if (plan.data.type === 'plan' && plan.data.status === 'failed') add('plan', plan.id, plan.file, ['Goal', 'Failure'], 2, 'failed plan: name it under ## Difference from failed plans');
          else if (plan.data.type === 'plan' && plan.data.status === 'succeeded') add('plan', plan.id, plan.file, ['Outcome'], 3, 'earlier successful attempt');
        }
        for (const idea of sources.ideas.values()) if (idea.data.status !== 'archived' && list(idea.data.related_assets).includes(target)) add('idea', idea.id, idea.file, 'summary', 3, 'related idea');
        excluded.push('proofs of dependencies', 'full checklists of failed plans (show <plan> for one when needed)');
      } else {
        excluded.push('other plans and ideas', 'proofs of dependencies');
      }
      break;
    }
    default:
      break;
  }
  return { stage: focus.stage, assetId: target, planId: focus.planId, budget, worker: STAGE_WORKERS[focus.stage], items, excluded, notes };
}

/** A project section, or the required results from frontmatter (or the legacy section) under that heading. */
export function projectPart(project: string, heading: string): string {
  if (heading !== 'Required Results') return projectSection(project, heading);
  return requiredResults(project).map((item) => `- ${item.id}${item.role ? `: ${item.role}` : ''}`).join('\n');
}

function frontmatterLine(data: Record<string, any>): string {
  const parts: string[] = [];
  for (const key of ['type', 'status', 'idea_kind', 'target_asset', 'refutes', 'outcome']) if (data[key] !== undefined) parts.push(`${key}: ${String(data[key])}`);
  for (const key of ['depends_on', 'uses_definitions', 'inspired_by']) if (list(data[key]).length) parts.push(`${key}: [${list(data[key]).join(', ')}]`);
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

function nodeIndex(sources: ContextSources): string {
  const line = (node: ContextNode) => `${node.id} | ${node.data.type ?? '?'} | ${node.data.status ?? '-'} | deps=[${list(node.data.depends_on).join(',')}] | ${String(node.data.title ?? '').replace(/\s+/g, ' ')}`;
  return [...sources.assets.values(), ...sources.definitions.values()].map(line).join('\n');
}

function paperIndexOutline(text: string): string {
  return text.split('\n').filter((line) => /^#{1,3} /.test(line) || /https?:\/\//.test(line)).join('\n').trim();
}

function renderItem(item: ContextItem, sources: ContextSources): string {
  if (item.kind === 'index') return `### Node index (id | type | status | deps | title)\n\n${nodeIndex(sources) || '(no nodes yet)'}`;
  if (item.kind === 'papers') return `### Paper index — ${item.file}\n\n${paperIndexOutline(sources.paperIndex) || '(no indexed papers)'}`;
  if (item.kind === 'project') {
    const body = item.view === 'all' ? strip(sources.project) : (item.view as string[]).map((heading) => { const content = projectPart(sources.project, heading); return content ? `## ${heading}\n\n${content}` : ''; }).filter(Boolean).join('\n\n');
    return `### Project — ${item.file}\n\n${body || '(empty)'}`;
  }
  const map = { asset: sources.assets, definition: sources.definitions, plan: sources.plans, idea: sources.ideas, check: sources.checks }[item.kind];
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
