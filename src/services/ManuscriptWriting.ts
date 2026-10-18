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

/** A section of an adopted manuscript; `text` is the exact TeX moved out of the main document (absent when it already has its own file). */
export interface AdoptedSection { id: string; title: string; text?: string; lines: [number, number] }

export interface ManuscriptAdoption {
  /** `split`: inline sections move to their own files; `inputs`: existing section inputs get the markers. */
  mode: 'split' | 'inputs';
  sections: AdoptedSection[];
  /** 1-based lines of the main document the section block replaces. */
  lines: [number, number];
  /** Section headings after the bibliography; they stay in the main document. */
  left: { line: number; title: string }[];
  updated: string;
}

const SECTION_HEADING = /^\s*\\section\*?\s*(?:\[[^\]]*\])?\s*\{/;
const END_MATTER = /^\s*\\(?:bibliographystyle\b|bibliography\b|printbibliography\b|begin\{thebibliography\}|end\{document\})/;
/** Comment and \appendix lines directly above a heading belong to that section. */
const ATTACHED = /^\s*(?:%|\\appendix\b)/;
const VERBATIM = /^\s*\\(begin|end)\{(comment|verbatim\*?|lstlisting|minted)\}/;
const INPUT_LINE = /^\s*\\(?:input|include)\{([^}]+)\}\s*$/;
const isComment = (line: string) => /^\s*%/.test(line);

/** The braced argument starting at `open` (an index of `{`), or undefined when it does not close. */
function bracedArgument(text: string, open: number): string | undefined {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}' && --depth === 0) return text.slice(open + 1, index);
  }
  return undefined;
}

/** The title of the first \section in `tex`, as plain text for the outline and brief (the TeX keeps the original). */
export function sectionHeadingTitle(tex: string): string | undefined {
  const lines = tex.split(/\r?\n/);
  const index = lines.findIndex((line) => !isComment(line) && SECTION_HEADING.test(line));
  if (index < 0) return undefined;
  const rest = lines.slice(index).join('\n');
  const heading = SECTION_HEADING.exec(rest)!;
  const title = bracedArgument(rest, heading.index + heading[0].length - 1);
  // Outline links cannot hold square brackets; whitespace is collapsed so outline and brief titles match.
  return title?.replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim() || undefined;
}

function slug(text: string): string {
  const words = text.toLowerCase().replace(/\\[a-z]+/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (words.length <= 40) return words;
  const cut = words.slice(0, 40);
  return cut.includes('_') ? cut.slice(0, cut.lastIndexOf('_')) : cut;
}

/** A stable section ID: the heading's \label (without a sec: prefix) when there is one, otherwise its title. */
function sectionId(text: string, title: string | undefined, position: number, taken: Set<string>): string {
  const label = /\\label\{([^}]*)\}/.exec(text.split(/\r?\n/).slice(0, 4).join('\n'))?.[1];
  const base = slug(label?.replace(/^(?:sec|section|s)[:._-]/i, '') ?? '') || slug(title ?? '') || `section_${position}`;
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`;
  taken.add(id);
  return id;
}

/**
 * Turn an existing manuscript into outline-managed sections without changing a
 * character of its TeX. With inline \section headings, the text from the first
 * heading up to the bibliography is cut at each heading, in order, into section
 * files; the main document keeps its preamble, front matter, and end matter and
 * gets one \input per section between the sync markers. When the body already
 * inputs files from the sections folder, only the markers are added.
 * `sectionsDir` is the sections folder relative to the LaTeX root; `taken`
 * holds IDs already used by section files or briefs.
 */
export function adoptManuscript(mainTex: string, sectionsDir: string, taken: Iterable<string> = []): ManuscriptAdoption {
  if (mainTex.includes(SECTION_START) || mainTex.includes(SECTION_END)) {
    throw new Error('The main document already has section markers; it is adopted. Use plan-manuscript and sync.');
  }
  const lines = mainTex.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bare = lines.map((line) => line.replace(/\r?\n$/, ''));
  const begin = bare.findIndex((line) => !isComment(line) && line.includes('\\begin{document}'));
  if (begin < 0) throw new Error('The main document has no \\begin{document}.');
  const endDocument = bare.findIndex((line, index) => index > begin && !isComment(line) && line.includes('\\end{document}'));
  const bodyEnd = endDocument < 0 ? bare.length : endDocument;
  const eol = mainTex.includes('\r\n') ? '\r\n' : '\n';
  const markers = (inputs: string[]) => [SECTION_START, ...inputs, SECTION_END].map((line) => line + eol).join('');

  const headings: number[] = [];
  let verbatim = false;
  for (let index = begin + 1; index < bodyEnd; index += 1) {
    const line = bare[index];
    const environment = VERBATIM.exec(line);
    if (environment) { verbatim = environment[1] === 'begin'; continue; }
    if (!verbatim && !isComment(line) && SECTION_HEADING.test(line)) headings.push(index);
  }

  if (headings.length) {
    let regionEnd = bodyEnd;
    for (let index = headings[0] + 1; index < bodyEnd; index += 1) {
      if (!isComment(bare[index]) && END_MATTER.test(bare[index])) { regionEnd = index; break; }
    }
    const inside = headings.filter((index) => index < regionEnd);
    const starts = inside.map((heading, position) => {
      const floor = position === 0 ? begin + 1 : inside[position - 1] + 1;
      const climb = (from: number) => { let start = from; while (start > floor && bare[start - 1].trim() && ATTACHED.test(bare[start - 1])) start -= 1; return start; };
      const start = climb(heading);
      // An \appendix separated by blank lines still opens the section below it.
      let probe = start;
      while (probe > floor && !bare[probe - 1].trim()) probe -= 1;
      return probe > floor && /^\s*\\appendix\b/.test(bare[probe - 1]) ? climb(probe - 1) : start;
    });
    const used = new Set(taken);
    const sections = starts.map((start, position) => {
      const end = position + 1 < starts.length ? starts[position + 1] : regionEnd;
      const text = lines.slice(start, end).join('');
      const title = sectionHeadingTitle(text);
      return { id: sectionId(lines.slice(inside[position], end).join(''), title, position + 1, used), title: title ?? `Section ${position + 1}`, text, lines: [start + 1, end] as [number, number] };
    });
    const prefix = sectionsDir === '.' ? '' : `${sectionsDir.replace(/\/+$/, '')}/`;
    const updated = lines.slice(0, starts[0]).join('') + markers(sections.map((section) => `\\input{${prefix}${section.id}}`)) + lines.slice(regionEnd).join('');
    const left = headings.filter((index) => index >= regionEnd).map((index) => ({ line: index + 1, title: sectionHeadingTitle(lines.slice(index).join('')) ?? '' }));
    return { mode: 'split', sections, lines: [starts[0] + 1, regionEnd], left, updated };
  }

  const normalize = (target: string) => target.trim().replace(/^\.\//, '').replace(/\.tex$/, '');
  const folder = sectionsDir.replace(/^\.\//, '').replace(/\/+$/, '');
  const sectionInput = (line: string): string | undefined => {
    const target = INPUT_LINE.exec(line)?.[1];
    if (!target || isComment(line)) return undefined;
    const file = normalize(target);
    const slash = file.lastIndexOf('/');
    const dir = slash < 0 ? '.' : file.slice(0, slash);
    const id = file.slice(slash + 1);
    return dir === (folder || '.') && SECTION_ID.test(id) ? id : undefined;
  };
  const inputs = bare.map((line, index) => (index > begin && index < bodyEnd ? sectionInput(line) : undefined));
  const first = inputs.findIndex(Boolean);
  if (first < 0) throw new Error(`The main document has no \\section heading and no \\input of a file in ${folder || 'the LaTeX root'}/; nothing to adopt.`);
  const last = inputs.length - 1 - [...inputs].reverse().findIndex(Boolean);
  for (let index = first; index <= last; index += 1) {
    if (!inputs[index] && bare[index].trim()) throw new Error(`Line ${index + 1} sits between the section inputs: ${bare[index].trim()}. Move it above or below them so the inputs form one block.`);
  }
  const ids = inputs.filter((id): id is string => Boolean(id));
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`The main document inputs section ${duplicate} twice.`);
  const updated = lines.slice(0, first).join('') + SECTION_START + eol + lines.slice(first, last + 1).join('') + SECTION_END + eol + lines.slice(last + 1).join('');
  return {
    mode: 'inputs',
    sections: ids.map((id) => ({ id, title: id, lines: [inputs.indexOf(id) + 1, inputs.indexOf(id) + 1] as [number, number] })),
    lines: [first + 1, last + 1], left: [], updated,
  };
}

/** The outline after adoption: entries go under the template's empty ## Sections heading. */
export function adoptedOutline(existing: string | undefined, sections: WritingSection[]): string {
  const entries = sections.map((section, index) => `${index + 1}. [${section.title}](sections/${section.id}.md)`).join('\n') + '\n';
  if (existing === undefined || !existing.trim()) return `# Manuscript outline\n\n## Sections\n\n${entries}`;
  const lines = existing.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === '## Sections');
  if (heading < 0) return `${existing.trimEnd()}\n\n## Sections\n\n${entries}`;
  const next = lines.findIndex((line, index) => index > heading && /^##\s/.test(line));
  const tail = next < 0 ? '' : `\n${lines.slice(next).join('\n')}`;
  return `${lines.slice(0, heading + 1).join('\n')}\n\n${entries}${tail}`;
}

/** A brief for an adopted section: the TeX already exists, so the nodes it presents are filled in afterwards. */
export function adoptedBrief(section: WritingSection, origin: string): string {
  return `---\ntitle: ${JSON.stringify(section.title)}\nassets: []\n---\n\n## Purpose\n\nAdopted from ${origin}; the TeX is the researcher's existing prose. List the nodes it presents under \`sources\` (plan-manuscript, adopt scope).\n\n## Subsections\n\n## Gaps\n\n## Excluded\n`;
}
