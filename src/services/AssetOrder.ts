import matter from 'gray-matter';

export interface AssetInput { id: string; raw: string }
export interface AssetChange { id: string; oldTitle: string; newTitle: string; raw: string }
export interface AssetOrderResult { order: string[]; changes: AssetChange[] }

const ACTIVE = new Set(['draft', 'approved']);
const PREFIX = /^\d{3,}\. /;

function replaceTitle(raw: string, title: string, id: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (!frontmatter) throw new Error(`${id}.md needs YAML frontmatter`);
  const titleLine = /^title:[^\r\n]*$/m;
  if (!titleLine.test(frontmatter[1])) throw new Error(`${id}.md needs a single-line title field`);
  const updatedFrontmatter = frontmatter[0].replace(titleLine, `title: ${JSON.stringify(title)}`);
  return updatedFrontmatter + raw.slice(frontmatter[0].length);
}

/** Pure planning step shared by the extension and the bundled command line tool. */
export function computeAssetOrder(inputs: AssetInput[], kind: 'asset' | 'definition' = 'asset'): AssetOrderResult {
  const assets = new Map<string, { raw: string; data: Record<string, unknown>; title: string; status: string; dependencies: string[] }>();
  for (const { id, raw } of inputs) {
    if (assets.has(id)) throw new Error(`Duplicate asset ID: ${id}`);
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = matter(raw); } catch (error) {
      throw new Error(`Cannot parse ${id}.md: ${String(error)}`);
    }
    const data = parsed.data as Record<string, unknown>;
    if (kind === 'definition' && data.type !== 'definition') throw new Error(`${id}.md must have type: definition`);
    if (typeof data.title !== 'string' || !data.title.trim()) throw new Error(`${id}.md needs a title`);
    if (typeof data.status !== 'string') throw new Error(`${id}.md needs a status`);
    if (data.depends_on !== undefined && (!Array.isArray(data.depends_on) || !data.depends_on.every((value: unknown) => typeof value === 'string'))) {
      throw new Error(`${id}.md has an invalid depends_on list`);
    }
    assets.set(id, { raw, data, title: data.title, status: data.status, dependencies: (data.depends_on as string[] | undefined) ?? [] });
  }

  const activeIds = [...assets.keys()].filter((id) => ACTIVE.has(assets.get(id)!.status)).sort();
  const indegree = new Map(activeIds.map((id) => [id, 0]));
  const dependents = new Map(activeIds.map((id) => [id, [] as string[]]));
  for (const id of activeIds) {
    for (const dependency of new Set(assets.get(id)!.dependencies)) {
      const target = assets.get(dependency);
      if (!target) throw new Error(`${id}.md depends on missing asset ${dependency}.md`);
      if (!ACTIVE.has(target.status)) throw new Error(`${id}.md depends on inactive asset ${dependency}.md (${target.status})`);
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

  const width = Math.max(3, String(order.length).length);
  const changes: AssetChange[] = [];
  order.forEach((id, index) => {
    const asset = assets.get(id)!;
    const unnumbered = asset.title.replace(PREFIX, '');
    const normalized = kind === 'definition'
      ? /^Definition \((.*)\)$/.test(unnumbered) ? unnumbered : `Definition (${unnumbered})`
      : unnumbered;
    const newTitle = `${String(index + 1).padStart(width, '0')}. ${normalized}`;
    if (newTitle !== asset.title) {
      changes.push({ id, oldTitle: asset.title, newTitle, raw: replaceTitle(asset.raw, newTitle, id) });
    }
  });
  return { order, changes };
}
