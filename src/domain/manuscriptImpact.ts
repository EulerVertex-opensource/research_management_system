import { AssetComponent, ProjectFacet, assetComponents, projectFacets, sha } from './digests';
import { buildGraph, nodeKey } from './graph';
import { requiredAssetIds } from './project';
import { BlockPolicy, BlockSource, parseTexBlocks } from './texBlocks';
import type { BriefSource, SectionBrief } from '../services/ManuscriptWriting';

/**
 * Manuscript freshness. A section binding (research/writing/bindings/<id>.json,
 * shared in git) snapshots, at the moment a researcher locks the section, the
 * component digests of every node the section presents or depends on and the
 * project facets it restates. Impact compares those snapshots with the files
 * now: staleness belongs to the binding edge, not to the node or the TeX.
 * Pure; the CLI reads files and passes them in.
 */

export interface ImpactNode { id: string; kind: 'asset' | 'definition'; raw: string; data: Record<string, any>; approved: boolean }

export interface BoundSource {
  id: string;
  kind: 'asset' | 'definition';
  /** `direct` when the brief names it; otherwise the source it was reached from. */
  via: string;
  role?: string;
  uses: AssetComponent[];
  /** Every component's digest at lock time, so a block may present a component the brief does not list. */
  digests: Partial<Record<AssetComponent, string>>;
}

/** A marked TeX block as locked: what it presents and its text, to tell research changes from researcher edits. */
export interface BoundBlock { id: string; policy: BlockPolicy; sources: BlockSource[]; textDigest: string }

export interface SectionBinding {
  version: 1;
  section: string;
  tex: string;
  texDigest: string;
  /** Approved project revision the section was reconciled against; absent when project.md was not approved. */
  projectRevision?: number;
  /** Required results at lock time, so a later scope cut can flag the section. */
  required: string[];
  facets: Partial<Record<ProjectFacet, string>>;
  sources: BoundSource[];
  /** Marked blocks in TeX order; absent when the section has none (section-level binding only). */
  blocks?: BoundBlock[];
  lockedAt: string;
  performed_by?: string;
}

export type BindingProblem = { id: string; reason: 'missing' | 'deprecated' | 'unapproved' };

export const texDigest = (tex: string) => sha(tex.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd());

/**
 * The nodes a section needs: brief sources with the components they present,
 * then their dependencies (definitions and lemmas are needed for their statement only).
 */
export function sectionClosure(sources: BriefSource[], nodes: Map<string, ImpactNode>): { bound: Omit<BoundSource, 'digests'>[]; missing: string[] } {
  const graph = buildGraph({ nodes: [...nodes.values()].map(({ id, kind, data }) => ({ id, kind, data })) });
  const bound = new Map<string, Omit<BoundSource, 'digests'>>();
  const missing: string[] = [];
  for (const source of sources) {
    const node = nodes.get(source.id);
    if (!node) { missing.push(source.id); continue; }
    bound.set(source.id, { id: source.id, kind: node.kind, via: 'direct', ...(source.role ? { role: source.role } : {}), uses: [...source.uses] });
  }
  for (const source of sources) {
    const node = nodes.get(source.id);
    if (!node) continue;
    for (const key of graph.reachable([nodeKey(node.kind, node.id)], ['depends_on', 'uses_definition'])) {
      const id = key.slice(key.indexOf(':') + 1);
      const dependency = nodes.get(id);
      if (!dependency) { if (!missing.includes(id)) missing.push(id); continue; }
      const existing = bound.get(id);
      if (existing) { if (!existing.uses.includes('statement')) existing.uses.unshift('statement'); continue; }
      bound.set(id, { id, kind: dependency.kind, via: source.id, uses: ['statement'] });
    }
  }
  return { bound: [...bound.values()], missing };
}

export function nodeProblem(id: string, node: ImpactNode | undefined): BindingProblem | undefined {
  if (!node) return { id, reason: 'missing' };
  if (['deprecated', 'archived'].includes(node.data.status)) return { id, reason: 'deprecated' };
  if (!node.approved) return { id, reason: 'unapproved' };
  return undefined;
}

/** Snapshot a section after the researcher reviewed its TeX. Throws while any needed node is missing or unapproved. */
export function lockBinding(input: {
  section: string; tex: string; texRaw: string; brief: SectionBrief; nodes: Map<string, ImpactNode>;
  project: string; projectRevision?: number; lockedAt: string; performedBy?: string;
}): SectionBinding {
  const { bound, missing } = sectionClosure(input.brief.sources, input.nodes);
  const problems = [...missing.map((id) => ({ id, reason: 'missing' as const })), ...bound.map((source) => nodeProblem(source.id, input.nodes.get(source.id))).filter((problem): problem is BindingProblem => Boolean(problem))];
  if (problems.length) throw new Error(`Cannot lock ${input.section}: ${problems.map((problem) => `${problem.id} is ${problem.reason}`).join('; ')}. Lock once every presented node is approved.`);
  const parsed = parseTexBlocks(input.texRaw);
  if (parsed.problems.length) throw new Error(`Cannot lock ${input.section}: fix the block markers in ${input.tex}: ${parsed.problems.join('; ')}.`);
  const known = new Set(bound.map((source) => source.id));
  const unknown = parsed.blocks.flatMap((block) => block.sources.filter((source) => !known.has(source.id)).map((source) => `${block.id} cites ${source.id}`));
  if (unknown.length) throw new Error(`Cannot lock ${input.section}: ${unknown.join('; ')}, which the brief neither lists nor depends on. Add it to the brief's sources.`);
  const facets = projectFacets(input.project);
  return {
    version: 1, section: input.section, tex: input.tex, texDigest: texDigest(input.texRaw),
    ...(input.projectRevision ? { projectRevision: input.projectRevision } : {}),
    required: requiredAssetIds(input.project),
    facets: Object.fromEntries(input.brief.projectFacets.map((facet) => [facet, facets[facet]])),
    sources: bound.map((source) => ({ ...source, digests: assetComponents(input.nodes.get(source.id)!.raw) })),
    ...(parsed.blocks.length ? { blocks: parsed.blocks.map((block) => ({ id: block.id, policy: block.policy, sources: block.sources, textDigest: texDigest(block.text) })) } : {}),
    lockedAt: input.lockedAt,
    ...(input.performedBy ? { performed_by: input.performedBy } : {}),
  };
}

export type SectionState = 'unlocked' | 'current' | 'stale' | 'invalid';

export interface BlockImpact {
  id: string;
  policy: BlockPolicy;
  state: 'current' | 'stale' | 'invalid';
  stale: { id: string; via: string; components: AssetComponent[] }[];
  invalid: BindingProblem[];
  /** Lines of the markers in the TeX as it is now; absent when the block was removed. */
  lines?: [number, number];
  /** The block's text changed after the lock (researcher edits). */
  textEdited: boolean;
}

export interface SectionImpact {
  id: string;
  title: string;
  state: SectionState;
  /** Bound nodes whose presented components changed. */
  stale: { id: string; via: string; components: AssetComponent[] }[];
  invalid: BindingProblem[];
  /** Project facets the section restates that changed since the lock. */
  facets: ProjectFacet[];
  /** Brief sources added or removed since the lock. */
  added: string[];
  removed: string[];
  /** Required at lock time but no longer required; the section may present a result the project dropped. */
  orphaned: string[];
  /** The TeX changed after the lock (researcher edits); informational, never stale by itself. */
  texEdited: boolean;
  lockedRevision?: number;
  /** Locked blocks, with the research changes attributed to them. */
  blocks: BlockImpact[];
  /** Stale items no block presents: prose outside the blocks may still use them. */
  outside: { id: string; via: string; components: AssetComponent[] }[];
  /** Blocks in the TeX that were added after the lock, and locked blocks since removed. */
  newBlocks: string[];
  removedBlocks: string[];
}

export type ManuscriptState = 'unplanned' | 'current' | 'unlocked' | 'uncovered' | 'stale' | 'invalid';

export interface ManuscriptImpact {
  state: ManuscriptState;
  projectRevision?: number;
  /** Required results no brief presents; `pending` ones are still under research. */
  uncovered: { id: string; pending: boolean }[];
  sections: SectionImpact[];
}

export interface ImpactSectionInput { id: string; title: string; brief?: SectionBrief; binding?: SectionBinding; texRaw?: string }

export function sectionImpact(section: ImpactSectionInput, nodes: Map<string, ImpactNode>, project: string): SectionImpact {
  const impact: SectionImpact = { id: section.id, title: section.title, state: 'unlocked', stale: [], invalid: [], facets: [], added: [], removed: [], orphaned: [], texEdited: false, blocks: [], outside: [], newBlocks: [], removedBlocks: [] };
  const binding = section.binding;
  if (!binding) return impact;
  impact.lockedRevision = binding.projectRevision;
  for (const source of binding.sources) {
    const node = nodes.get(source.id);
    const problem = nodeProblem(source.id, node);
    if (problem) { impact.invalid.push(problem); continue; }
    const now = assetComponents(node!.raw);
    const changed = source.uses.filter((use) => source.digests[use] !== now[use]);
    if (changed.length) impact.stale.push({ id: source.id, via: source.via, components: changed });
  }
  const facets = projectFacets(project);
  impact.facets = (Object.keys(binding.facets) as ProjectFacet[]).filter((facet) => binding.facets[facet] !== facets[facet]);
  const direct = binding.sources.filter((source) => source.via === 'direct');
  if (section.brief) {
    const briefIds = section.brief.sources.map((source) => source.id);
    impact.added = briefIds.filter((id) => !direct.some((source) => source.id === id));
    impact.removed = direct.map((source) => source.id).filter((id) => !briefIds.includes(id));
    for (const facet of section.brief.projectFacets) if (!(facet in binding.facets) && !impact.facets.includes(facet)) impact.facets.push(facet);
  }
  const required = requiredAssetIds(project);
  impact.orphaned = direct.map((source) => source.id).filter((id) => binding.required.includes(id) && !required.includes(id));
  impact.texEdited = section.texRaw !== undefined && texDigest(section.texRaw) !== binding.texDigest;
  attributeBlocks(impact, binding, nodes, section.texRaw);
  impact.state = impact.invalid.length ? 'invalid'
    : impact.stale.length || impact.facets.length || impact.added.length || impact.removed.length || impact.orphaned.length ? 'stale'
    : 'current';
  return impact;
}

/**
 * Point each change at the blocks that present it. A dependency's change goes to
 * every block presenting the source it was reached from. Changes no block
 * presents stay in `outside` and still make the section stale.
 */
function attributeBlocks(impact: SectionImpact, binding: SectionBinding, nodes: Map<string, ImpactNode>, texRaw?: string): void {
  if (!binding.blocks?.length) return;
  const now = texRaw === undefined ? undefined : parseTexBlocks(texRaw).blocks;
  const byId = new Map(binding.sources.map((source) => [source.id, source]));
  const attributed = new Set<string>();
  for (const block of binding.blocks) {
    const result: BlockImpact = { id: block.id, policy: block.policy, state: 'current', stale: [], invalid: [], textEdited: false };
    const current = now?.find((item) => item.id === block.id);
    if (current) { result.lines = [current.startLine, current.endLine]; result.textEdited = texDigest(current.text) !== block.textDigest; }
    for (const source of block.sources) {
      const problem = nodeProblem(source.id, nodes.get(source.id));
      if (problem) { result.invalid.push(problem); continue; }
      const digests = assetComponents(nodes.get(source.id)!.raw);
      const locked = byId.get(source.id)?.digests ?? {};
      const changed = source.components.filter((component) => locked[component] !== digests[component]);
      if (changed.length) { result.stale.push({ id: source.id, via: 'direct', components: changed }); attributed.add(`${source.id}:direct`); }
      for (const item of impact.stale.filter((entry) => entry.via === source.id)) {
        if (!result.stale.some((entry) => entry.id === item.id)) result.stale.push(item);
        attributed.add(`${item.id}:${item.via}`);
      }
    }
    result.state = result.invalid.length ? 'invalid' : result.stale.length ? 'stale' : 'current';
    impact.blocks.push(result);
  }
  // A change is covered when some block presents that component, or presents the source it was reached from.
  const presents = (id: string, component: AssetComponent) => binding.blocks!.some((block) => block.sources.some((source) => source.id === id && source.components.includes(component)));
  impact.outside = impact.stale.flatMap((item) => {
    if (item.via !== 'direct' && attributed.has(`${item.id}:${item.via}`)) return [];
    const rest = item.components.filter((component) => !presents(item.id, component));
    return rest.length ? [{ ...item, components: rest }] : [];
  });
  if (now) {
    impact.newBlocks = now.map((block) => block.id).filter((id) => !binding.blocks!.some((block) => block.id === id));
    impact.removedBlocks = binding.blocks.map((block) => block.id).filter((id) => !now.some((block) => block.id === id));
  }
}

export function manuscriptImpact(input: { project: string; projectRevision?: number; sections: ImpactSectionInput[]; nodes: Map<string, ImpactNode> }): ManuscriptImpact {
  const sections = input.sections.map((section) => sectionImpact(section, input.nodes, input.project));
  const presented = new Set(input.sections.flatMap((section) => section.brief?.sources.map((source) => source.id) ?? []));
  const uncovered = requiredAssetIds(input.project).filter((id) => !presented.has(id)).map((id) => ({ id, pending: !input.nodes.get(id)?.approved }));
  const has = (state: SectionState) => sections.some((section) => section.state === state);
  const state: ManuscriptState = !sections.length ? 'unplanned'
    : has('invalid') ? 'invalid'
    : has('stale') ? 'stale'
    : uncovered.length ? 'uncovered'
    : has('unlocked') ? 'unlocked'
    : 'current';
  return { state, ...(input.projectRevision ? { projectRevision: input.projectRevision } : {}), uncovered, sections };
}

/** One line per section for the loop brief and the CLI. */
export function renderImpact(impact: ManuscriptImpact): string {
  const lines = [`Manuscript: ${impact.state}${impact.projectRevision ? ` (project revision ${impact.projectRevision})` : ''}`];
  if (impact.uncovered.length) lines.push(`Uncovered required results: ${impact.uncovered.map((item) => `${item.id}${item.pending ? ' (research in progress)' : ''}`).join(', ')}`);
  for (const section of impact.sections) {
    const details = [
      ...section.invalid.map((problem) => `${problem.id} ${problem.reason}`),
      ...section.stale.map((item) => `${item.id} ${item.components.join('+')} changed${item.via === 'direct' ? '' : ` (dependency of ${item.via})`}`),
      ...section.facets.map((facet) => `project ${facet} changed`),
      ...section.added.map((id) => `brief added ${id}`),
      ...section.removed.map((id) => `brief removed ${id}`),
      ...section.orphaned.map((id) => `${id} no longer required`),
    ];
    const revision = section.lockedRevision && impact.projectRevision && section.lockedRevision !== impact.projectRevision ? ` [locked at revision ${section.lockedRevision}]` : '';
    lines.push(`- ${section.id}: ${section.state}${revision}${details.length ? ` — ${details.join('; ')}` : ''}${section.texEdited ? ' (TeX edited since lock)' : ''}`);
    for (const block of section.blocks.filter((item) => item.state !== 'current')) {
      const reasons = [...block.invalid.map((problem) => `${problem.id} ${problem.reason}`), ...block.stale.map((item) => `${item.id} ${item.components.join('+')} changed`)];
      lines.push(`  - block ${block.id} [${block.policy}]${block.lines ? ` lines ${block.lines[0]}-${block.lines[1]}` : ' (removed from the TeX)'}: ${block.state} — ${reasons.join('; ')}${block.textEdited ? ' (edited since lock)' : ''}`);
    }
    if (section.blocks.length && section.outside.length) lines.push(`  - outside blocks: ${section.outside.map((item) => `${item.id} ${item.components.join('+')} changed`).join('; ')}`);
    if (section.newBlocks.length) lines.push(`  - blocks added since lock: ${section.newBlocks.join(', ')}`);
    if (section.removedBlocks.length) lines.push(`  - blocks removed since lock: ${section.removedBlocks.join(', ')}`);
  }
  return lines.join('\n');
}

