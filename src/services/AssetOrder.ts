import { parseMarkdown } from './Frontmatter';
import { ACTIVE_STATUSES } from '../domain/nodeKinds';

export interface AssetInput { id: string; raw: string }
export interface AssetChange { id: string; oldTitle: string; newTitle: string; raw: string }
export interface AssetOrderResult { order: string[] }

/** Schema-1 projects wrote the dependency position into titles ("001. Title"); order is now derived. */
const ORDINAL_PREFIX = /^\d{3,}\. /;

export function stripOrdinal(title: string): string {
  return title.replace(ORDINAL_PREFIX, '');
}

function replaceTitle(raw: string, title: string, id: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (!frontmatter) throw new Error(`${id}.md needs YAML frontmatter`);
  const titleLine = /^title:[^\r\n]*$/m;
  if (!titleLine.test(frontmatter[1])) throw new Error(`${id}.md needs a single-line title field`);
  const updatedFrontmatter = frontmatter[0].replace(titleLine, `title: ${JSON.stringify(title)}`);
  return updatedFrontmatter + raw.slice(frontmatter[0].length);
}

/**
 * Validate `depends_on` (missing, inactive, cyclic) and return active node IDs
 * in dependency order. Pure and read-only: the order is shown by the dashboard
 * and printed by `research-maintenance validate`, never written into files.
 */
export function computeAssetOrder(inputs: AssetInput[], kind: 'asset' | 'definition' = 'asset'): AssetOrderResult {
  const assets = new Map<string, { status: string; dependencies: string[] }>();
  for (const { id, raw } of inputs) {
    if (assets.has(id)) throw new Error(`Duplicate asset ID: ${id}`);
    let data: Record<string, unknown>;
    try { data = parseMarkdown(raw).data; } catch (error) {
      throw new Error(`Cannot parse ${id}.md: ${String(error)}`);
    }
    if (kind === 'definition' && data.type !== 'definition') throw new Error(`${id}.md must have type: definition`);
    if (typeof data.title !== 'string' || !data.title.trim()) throw new Error(`${id}.md needs a title`);
    if (typeof data.status !== 'string') throw new Error(`${id}.md needs a status`);
    if (data.depends_on !== undefined && (!Array.isArray(data.depends_on) || !data.depends_on.every((value: unknown) => typeof value === 'string'))) {
      throw new Error(`${id}.md has an invalid depends_on list`);
    }
    assets.set(id, { status: data.status, dependencies: (data.depends_on as string[] | undefined) ?? [] });
  }

  const activeIds = [...assets.keys()].filter((id) => ACTIVE_STATUSES.has(assets.get(id)!.status)).sort();
  const indegree = new Map(activeIds.map((id) => [id, 0]));
  const dependents = new Map(activeIds.map((id) => [id, [] as string[]]));
  for (const id of activeIds) {
    for (const dependency of new Set(assets.get(id)!.dependencies)) {
      const target = assets.get(dependency);
      if (!target) throw new Error(`${id}.md depends on missing ${kind} ${dependency}.md`);
      if (!ACTIVE_STATUSES.has(target.status)) throw new Error(`${id}.md depends on inactive ${kind} ${dependency}.md (${target.status})`);
      dependents.get(dependency)!.push(id);
      indegree.set(id, indegree.get(id)! + 1);
    }
  }

  const ready = activeIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort();
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (order.length !== activeIds.length) {
    const cycle = activeIds.filter((id) => indegree.get(id)! > 0);
    throw new Error(`Dependency cycle involving: ${cycle.join(', ')}`);
  }
  return { order };
}

/** Title rewrites that remove schema-1 ordinal prefixes; used by the schema migration. */
export function ordinalTitleFixes(inputs: AssetInput[]): AssetChange[] {
  const changes: AssetChange[] = [];
  for (const { id, raw } of inputs) {
    let title: unknown;
    try { title = parseMarkdown(raw).data.title; } catch { continue; }
    if (typeof title !== 'string' || !ORDINAL_PREFIX.test(title)) continue;
    const newTitle = stripOrdinal(title);
    changes.push({ id, oldTitle: title, newTitle, raw: replaceTitle(raw, newTitle, id) });
  }
  return changes;
}
