import { ASSET_COMPONENTS, AssetComponent } from './digests';

/**
 * Stable block markers inside a section's TeX. A block names the node
 * components it presents, so impact can point at the passages a research
 * change touches instead of the whole section:
 *
 *   % research-assistant:block id=main-theorem-proof sources=main_theorem@proof,helper@statement policy=assisted
 *   ...
 *   % research-assistant:endblock
 *
 * Digests live in the section's binding, never in the TeX, so Overleaf diffs
 * stay clean. `id@a+b` lists components; a bare `id` means every component.
 * Blocks do not nest. The legacy one-line `% [node_id]` tag is still read as a
 * section-level use.
 */

export const BLOCK_POLICIES = ['managed', 'assisted', 'manual'] as const;
/** managed: an agent may rewrite the block from its sources; assisted: an agent proposes a patch the researcher confirms; manual: report only. */
export type BlockPolicy = typeof BLOCK_POLICIES[number];

export interface BlockSource { id: string; components: AssetComponent[] }

export interface TexBlock {
  id: string;
  sources: BlockSource[];
  policy: BlockPolicy;
  /** 1-based lines of the start and end markers. */
  startLine: number;
  endLine: number;
  /** The lines between the markers. */
  text: string;
}

export interface ParsedTexBlocks { blocks: TexBlock[]; tags: string[]; problems: string[] }

const START = /^\s*%\s*research-assistant:block\b(.*)$/;
const END = /^\s*%\s*research-assistant:endblock\s*$/;
const TAG = /^\s*%\s*\[([a-z0-9][a-z0-9_-]*)\]\s*$/;
const ID = /^[a-z0-9][a-z0-9_-]*$/;

function parseSources(value: string, line: number, problems: string[]): BlockSource[] {
  const sources: BlockSource[] = [];
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [id, spec] = entry.split('@');
    if (!ID.test(id)) { problems.push(`line ${line}: invalid source ${entry}`); continue; }
    const components = spec === undefined ? [...ASSET_COMPONENTS] : spec.split('+').map((item) => item.trim());
    const unknown = components.filter((component) => !(ASSET_COMPONENTS as readonly string[]).includes(component));
    if (unknown.length) { problems.push(`line ${line}: source ${id} has unknown component ${unknown.join(', ')} (use ${ASSET_COMPONENTS.join(', ')})`); continue; }
    const existing = sources.find((source) => source.id === id);
    if (existing) existing.components = [...new Set([...existing.components, ...components as AssetComponent[]])];
    else sources.push({ id, components: [...new Set(components as AssetComponent[])] });
  }
  return sources;
}

export function parseTexBlocks(tex: string): ParsedTexBlocks {
  const lines = tex.split(/\r?\n/);
  const blocks: TexBlock[] = [];
  const tags: string[] = [];
  const problems: string[] = [];
  let open: (Omit<TexBlock, 'endLine' | 'text'>) | undefined;
  lines.forEach((line, index) => {
    const number = index + 1;
    const start = START.exec(line);
    if (start) {
      if (open) { problems.push(`line ${number}: block ${open.id} (line ${open.startLine}) is not closed before the next block`); }
      const attributes = new Map<string, string>();
      for (const match of start[1].matchAll(/(\w+)=(\S+)/g)) attributes.set(match[1], match[2]);
      const id = attributes.get('id') ?? '';
      if (!ID.test(id)) problems.push(`line ${number}: a block needs id=<lowercase-id>`);
      else if (blocks.some((block) => block.id === id) || open?.id === id) problems.push(`line ${number}: duplicate block id ${id}`);
      const policy = (attributes.get('policy') ?? 'assisted') as BlockPolicy;
      if (!BLOCK_POLICIES.includes(policy)) problems.push(`line ${number}: policy must be ${BLOCK_POLICIES.join(', ')}`);
      open = { id, sources: parseSources(attributes.get('sources') ?? '', number, problems), policy: BLOCK_POLICIES.includes(policy) ? policy : 'assisted', startLine: number };
      return;
    }
    if (END.test(line)) {
      if (!open) { problems.push(`line ${number}: endblock without a block`); return; }
      blocks.push({ ...open, endLine: number, text: lines.slice(open.startLine, index).join('\n') });
      open = undefined;
      return;
    }
    const tag = TAG.exec(line);
    if (tag && !tags.includes(tag[1])) tags.push(tag[1]);
  });
  if (open) problems.push(`line ${open.startLine}: block ${open.id} has no endblock`);
  return { blocks, tags, problems };
}

export function blockStart(id: string, sources: BlockSource[], policy: BlockPolicy = 'assisted'): string {
  const list = sources.map((source) => source.components.length === ASSET_COMPONENTS.length && ASSET_COMPONENTS.every((component) => source.components.includes(component)) ? source.id : `${source.id}@${source.components.join('+')}`).join(',');
  return `% research-assistant:block id=${id}${list ? ` sources=${list}` : ''} policy=${policy}`;
}

export const BLOCK_END = '% research-assistant:endblock';
