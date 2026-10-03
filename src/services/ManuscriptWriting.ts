import { parseMarkdown } from './Frontmatter';
import { ASSET_COMPONENTS, AssetComponent, PROJECT_FACETS, ProjectFacet } from '../domain/digests';
import { BLOCK_END, blockStart } from '../domain/texBlocks';

export const SECTION_START = '% research-assistant:sections:start';
export const SECTION_END = '% research-assistant:sections:end';
const SECTION_ID = /^[a-z0-9][a-z0-9_-]*$/;

export interface WritingSection {
  id: string;
  title: string;
}

/** How a section uses a node; drives which rhetoric a change touches, not freshness. */
export const SOURCE_ROLES = ['central_result', 'supporting_result', 'definition', 'motivation', 'counterexample', 'citation', 'background'] as const;
export type SourceRole = typeof SOURCE_ROLES[number];

/** A node a section presents and the components it presents; a change to another component leaves the section current. */
export interface BriefSource { id: string; role?: SourceRole; uses: AssetComponent[] }

export interface SectionBrief {
  title: string;
  /** Every source ID, `assets` entries first; kept for callers that only need the IDs. */
  assets: string[];
  sources: BriefSource[];
  /** Project facets a rhetorical section (introduction, abstract, conclusion) restates. */
  projectFacets: ProjectFacet[];
  body: string;
}

export function validSectionId(id: string): boolean {
  return SECTION_ID.test(id);
}

/** The ordered links under "## Sections" are the only source of input order. */
export function parseWritingOutline(raw: string): WritingSection[] {
  const lines = raw.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === '## Sections');
  if (heading < 0) throw new Error('Writing outline needs a ## Sections heading');
  const sections: WritingSection[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim() || /^<!--.*-->$/.test(line.trim())) continue;
    const match = /^\s*\d+[.)]\s+\[([^\]]+)\]\(sections\/([a-z0-9][a-z0-9_-]*)\.md\)\s*$/.exec(line);
    if (!match) throw new Error(`Invalid outline entry: ${line.trim()}`);
    const [, title, id] = match;
    if (seen.has(id)) throw new Error(`Duplicate section ID: ${id}`);
    seen.add(id);
    sections.push({ id, title: title.trim() });
  }
  if (!sections.length) throw new Error('Writing outline has no sections');
  return sections;
}

/**
 * `assets: [id]` is the plain form: each entry presents every component, so any
 * change marks the section stale. `sources` narrows that with a role and the
 * components actually presented.
 */
export function parseSectionBrief(raw: string, id: string): SectionBrief {
  const parsed = parseMarkdown(raw);
  const title = parsed.data.title;
  const assets = parsed.data.assets;
  const sources = parsed.data.sources;
  if (typeof title !== 'string' || !title.trim()) throw new Error(`Section ${id} needs a title in YAML frontmatter`);
  if (assets === undefined && sources === undefined) throw new Error(`Section ${id} needs an assets list of stable node IDs`);
  if (assets !== undefined && (!Array.isArray(assets) || assets.some((asset) => typeof asset !== 'string' || !SECTION_ID.test(asset)))) {
    throw new Error(`Section ${id} needs an assets list of stable node IDs`);
  }
  if (sources !== undefined && !Array.isArray(sources)) throw new Error(`Section ${id}: sources must be a list`);
  const list: BriefSource[] = [
    ...((assets ?? []) as string[]).map((asset) => ({ id: asset, uses: [...ASSET_COMPONENTS] })),
    ...((sources ?? []) as unknown[]).map((entry) => briefSource(entry, id)),
  ];
  const ids = list.map((source) => source.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Section ${id} repeats an asset ID`);
  const facets = parsed.data.project_facets ?? [];
  if (!Array.isArray(facets) || facets.some((facet) => !(PROJECT_FACETS as readonly string[]).includes(facet))) {
    throw new Error(`Section ${id}: project_facets must list ${PROJECT_FACETS.join(', ')}`);
  }
  return { title: title.trim(), assets: ids, sources: list, projectFacets: facets as ProjectFacet[], body: parsed.content };
}

function briefSource(entry: unknown, section: string): BriefSource {
  if (typeof entry === 'string') entry = { id: entry };
  const source = entry as { id?: unknown; role?: unknown; uses?: unknown };
  if (!source || typeof source.id !== 'string' || !SECTION_ID.test(source.id)) throw new Error(`Section ${section}: each source needs a stable node id`);
  if (source.role !== undefined && !(SOURCE_ROLES as readonly unknown[]).includes(source.role)) throw new Error(`Section ${section}: source ${source.id} role must be one of ${SOURCE_ROLES.join(', ')}`);
  const uses = source.uses ?? [...ASSET_COMPONENTS];
  if (!Array.isArray(uses) || !uses.length || uses.some((use) => !(ASSET_COMPONENTS as readonly unknown[]).includes(use))) {
    throw new Error(`Section ${section}: source ${source.id} uses must list ${ASSET_COMPONENTS.join(', ')}`);
  }
  return { id: source.id, ...(source.role ? { role: source.role as SourceRole } : {}), uses: [...new Set(uses as AssetComponent[])] };
}

/** Only the marked input block may change; all other manuscript text is retained. */
export function syncInputBlock(mainTex: string, inputs: string[]): { before: string; after: string; updated: string } {
  const start = mainTex.indexOf(SECTION_START);
  const end = mainTex.indexOf(SECTION_END);
  if (start < 0 || end < 0) throw new Error('Add the section markers to main.tex before syncing an existing manuscript');
  if (mainTex.indexOf(SECTION_START, start + 1) >= 0 || mainTex.indexOf(SECTION_END, end + 1) >= 0 || end <= start) {
    throw new Error('main.tex must contain one correctly ordered section marker pair');
  }
  const startLineStart = mainTex.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = mainTex.indexOf('\n', start);
  if (lineEnd < 0 || mainTex.slice(startLineStart, start).trim() || mainTex.slice(start + SECTION_START.length, lineEnd).trim()) {
    throw new Error('The section start marker must be alone on its line');
  }
  const endLineStart = mainTex.lastIndexOf('\n', end - 1) + 1;
  const endLineEnd = mainTex.indexOf('\n', end);
  if (mainTex.slice(endLineStart, end).trim() || mainTex.slice(end + SECTION_END.length, endLineEnd < 0 ? undefined : endLineEnd).trim()) {
    throw new Error('The section end marker must be alone on its line');
  }
  const eol = mainTex.includes('\r\n') ? '\r\n' : '\n';
  const before = mainTex.slice(lineEnd + 1, endLineStart);
  if (before.split(/\r?\n/).some((line) => line.trim() && !/^\s*\\(?:input|include)\{[^}]+\}\s*$/.test(line))) {
    throw new Error('The marked section block contains text other than inputs; move it outside the markers before syncing');
  }
  const after = inputs.map((input) => `\\input{${input}}`).join(eol) + (inputs.length ? eol : '');
  return { before, after, updated: mainTex.slice(0, lineEnd + 1) + after + mainTex.slice(endLineStart) };
}

/** A new section: one assisted block per brief source, so later research changes point at the passage that presents it. */
export function sectionTexSkeleton(id: string, title: string, sources: BriefSource[]): string {
  const escapedTitle = title.replace(/[\\&%$#_{}]/g, (character) => `\\${character}`);
  const blocks = sources.map((source) => `${blockStart(source.id.replace(/_/g, '-'), [{ id: source.id, components: source.uses }])}\n% TODO: Present ${source.id} from its approved node.\n${BLOCK_END}\n`).join('\n');
  return `% Manuscript section: ${id}\n\\section{${escapedTitle}}\\label{sec:${id}}\n\n${blocks ? `${blocks}\n` : ''}% TODO: Draft from the approved assets in the section brief.\n`;
}
