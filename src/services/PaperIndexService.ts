import { PaperEntry, ProjectPaths } from '../models/types';
import { FileService } from './FileService';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parsePapersMd(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = content.split(/(?=^## )/m);
  for (const part of parts) {
    if (!part.startsWith('## ')) continue;
    const firstNewline = part.indexOf('\n');
    const slug = firstNewline === -1 ? part.slice(3).trim() : part.slice(3, firstNewline).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1);
    if (slug) result[slug] = body;
  }
  return result;
}

function parseBib(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let inEntry = false;
  let entrySlug = '';
  let entryLines: string[] = [];
  let braceDepth = 0;

  for (const line of lines) {
    if (!inEntry) {
      const match = line.match(/^@\w+\{([^,]+),/);
      if (match) {
        inEntry = true;
        entrySlug = match[1].trim();
        entryLines = [line];
        braceDepth = countBraces(line);
      }
    } else {
      entryLines.push(line);
      braceDepth += countBraces(line);
      if (braceDepth <= 0) {
        result[entrySlug] = entryLines.join('\n');
        inEntry = false;
        entrySlug = '';
        entryLines = [];
        braceDepth = 0;
      }
    }
  }
  return result;
}

function countBraces(line: string): number {
  return (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Updaters / removers
// ---------------------------------------------------------------------------

function updatePapersMdSection(content: string, slug: string, newBody: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l === `## ${slug}`);

  if (startIdx === -1) {
    return content.trimEnd() + `\n\n## ${slug}\n` + newBody.trimEnd() + '\n';
  }

  let endIdx = startIdx + 1;
  while (endIdx < lines.length && !lines[endIdx].startsWith('## ')) {
    endIdx++;
  }

  return [
    ...lines.slice(0, startIdx),
    `## ${slug}`,
    ...newBody.trimEnd().split('\n'),
    '',
    ...lines.slice(endIdx),
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function removePapersMdSection(content: string, slug: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l === `## ${slug}`);
  if (startIdx === -1) return content;

  let endIdx = startIdx + 1;
  while (endIdx < lines.length && !lines[endIdx].startsWith('## ')) {
    endIdx++;
  }

  return [...lines.slice(0, startIdx), ...lines.slice(endIdx)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function updateBibEntry(content: string, slug: string, newEntry: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => {
    const m = l.match(/^@\w+\{([^,]+),/);
    return m ? m[1].trim() === slug : false;
  });

  if (startIdx === -1) {
    return content.trimEnd() + '\n\n' + newEntry.trim() + '\n';
  }

  let braceDepth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    braceDepth += countBraces(lines[i]);
    if (braceDepth <= 0 && i >= startIdx) { endIdx = i; break; }
    if (i === lines.length - 1) endIdx = i;
  }

  return [
    ...lines.slice(0, startIdx),
    newEntry.trim(),
    ...lines.slice(endIdx + 1),
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function removeBibEntry(content: string, slug: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => {
    const m = l.match(/^@\w+\{([^,]+),/);
    return m ? m[1].trim() === slug : false;
  });
  if (startIdx === -1) return content;

  let braceDepth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    braceDepth += countBraces(lines[i]);
    if (braceDepth <= 0 && i >= startIdx) { endIdx = i; break; }
    if (i === lines.length - 1) endIdx = i;
  }

  return [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PaperIndexService {
  constructor(
    private readonly fileService: FileService,
    private readonly paths: ProjectPaths
  ) {}

  async getPapers(): Promise<PaperEntry[]> {
    const [mdContent, bibContent] = await Promise.all([
      this.fileService.readFile(this.paths.paperIndex).catch(() => ''),
      this.fileService.readFile(this.paths.bibliography).catch(() => ''),
    ]);

    const mdSections = parsePapersMd(mdContent);
    const bibEntries = parseBib(bibContent);

    const allSlugs = [...new Set([...Object.keys(mdSections), ...Object.keys(bibEntries)])];
    return allSlugs.map((slug) => ({
      slug,
      mdSection: mdSections[slug] ?? '',
      bibEntry: bibEntries[slug] ?? '',
    }));
  }

  async savePaper(originalSlug: string, newSlug: string, mdSection: string, bibEntry: string): Promise<void> {
    const [mdContent, bibContent] = await Promise.all([
      this.fileService.readFile(this.paths.paperIndex).catch(() => ''),
      this.fileService.readFile(this.paths.bibliography).catch(() => ''),
    ]);

    let finalMdSection = mdSection;
    let newMd: string;
    let newBib: string;

    if (originalSlug !== newSlug) {
      // Attempt to rename the PDF file on disk. If this fails (file missing, target
      // already exists, etc.) we restore the original file path in papers.md so the
      // reference stays valid.
      try {
        await this.fileService.renameFile(
          `${this.paths.localSourcePdfs}/${originalSlug}.pdf`,
          `${this.paths.localSourcePdfs}/${newSlug}.pdf`
        );
      } catch {
        finalMdSection = finalMdSection.replace(
          /^- (?:Local )?File:.*$/mi,
          `- Local file: \`${this.paths.localSourcePdfs}/${originalSlug}.pdf\``
        );
      }

      newMd = updatePapersMdSection(removePapersMdSection(mdContent, originalSlug), newSlug, finalMdSection);
      newBib = updateBibEntry(removeBibEntry(bibContent, originalSlug), newSlug, bibEntry);
    } else {
      newMd = updatePapersMdSection(mdContent, newSlug, finalMdSection);
      newBib = updateBibEntry(bibContent, newSlug, bibEntry);
    }

    await Promise.all([
      this.fileService.writeFile(this.paths.paperIndex, newMd),
      this.fileService.writeFile(this.paths.bibliography, newBib),
    ]);
  }
}
