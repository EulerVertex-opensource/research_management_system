import { parseMarkdown } from './Frontmatter';

export const SECTION_START = '% research-assistant:sections:start';
export const SECTION_END = '% research-assistant:sections:end';
const SECTION_ID = /^[a-z0-9][a-z0-9_-]*$/;

export interface WritingSection {
  id: string;
  title: string;
}

export interface SectionBrief {
  title: string;
  assets: string[];
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

export function parseSectionBrief(raw: string, id: string): SectionBrief {
  const parsed = parseMarkdown(raw);
  const title = parsed.data.title;
  const assets = parsed.data.assets;
  if (typeof title !== 'string' || !title.trim()) throw new Error(`Section ${id} needs a title in YAML frontmatter`);
  if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== 'string' || !SECTION_ID.test(asset))) {
    throw new Error(`Section ${id} needs an assets list of stable node IDs`);
  }
  if (new Set(assets).size !== assets.length) throw new Error(`Section ${id} repeats an asset ID`);
  return { title: title.trim(), assets, body: parsed.content };
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

export function sectionTexSkeleton(id: string, title: string, assets: string[]): string {
  const escapedTitle = title.replace(/[\\&%$#_{}]/g, (character) => `\\${character}`);
  const sourceComments = assets.map((asset) => `% [${asset}]`).join('\n');
  return `% Manuscript section: ${id}\n\\section{${escapedTitle}}\\label{sec:${id}}\n\n${sourceComments ? `${sourceComments}\n` : ''}% TODO: Draft from the approved assets in the section brief.\n`;
}
