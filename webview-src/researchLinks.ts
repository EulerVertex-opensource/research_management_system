import { ResearchNode } from '../src/models/types';

/** Resolve only relative Markdown links to known research nodes. */
export function resolveResearchNodeLink(sourcePath: string, href: string, nodes: ResearchNode[]): ResearchNode | null {
  const targetPath = resolveRelativeLink(sourcePath, href);
  if (!targetPath?.endsWith('.md')) return null;
  return nodes.find((node) => node.filePath === targetPath) ?? null;
}

/** Resolve a relative link without allowing it to escape the workspace. */
function resolveRelativeLink(sourcePath: string, href: string): string | null {
  if (!href || href.startsWith('/') || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  const parts = sourcePath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** PDFs must be direct children of the configured local paper directory. */
export function resolvePaperPdfLink(sourcePath: string, href: string, pdfFolder: string): string | null {
  if (/[?#]/.test(href)) return null;
  const targetPath = resolveRelativeLink(sourcePath, href);
  if (!targetPath || !/\.pdf$/i.test(targetPath)) return null;
  const folder = pdfFolder.replace(/^\.\//, '').replace(/\/$/, '');
  const slash = targetPath.lastIndexOf('/');
  return targetPath.slice(0, slash) === folder && slash < targetPath.length - 1 ? targetPath : null;
}
