import * as path from 'path';

/** Validate a workspace-relative PDF path before opening it from the webview. */
export function validatePaperPdfPath(filePath: string, pdfFolder: string): string | null {
  if (!filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.includes('\0')) return null;
  if (filePath.split('/').some((part) => part === '..')) return null;
  const normalized = path.posix.normalize(filePath);
  const folder = path.posix.normalize(pdfFolder);
  if (normalized !== filePath || path.posix.dirname(normalized) !== folder || !/\.pdf$/i.test(path.posix.basename(normalized))) return null;
  return normalized;
}

export async function requirePaperPdfPath(
  filePath: string,
  pdfFolder: string,
  isRegularFile: (relativePath: string) => Promise<boolean>,
): Promise<string> {
  const paperPdf = validatePaperPdfPath(filePath, pdfFolder);
  if (!paperPdf) throw new Error(`Paper PDF must be directly inside ${pdfFolder}: ${filePath}`);
  let exists = false;
  try { exists = await isRegularFile(paperPdf); } catch { /* Missing or unreadable file. */ }
  if (!exists) throw new Error(`Paper PDF not found or not a regular file: ${paperPdf}`);
  return paperPdf;
}
