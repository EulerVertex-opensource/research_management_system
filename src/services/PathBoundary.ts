import * as fs from 'fs/promises';
import * as path from 'path';

/** `full` lies in `root` (or is `root`), compared as text. */
export function isInside(root: string, full: string): boolean {
  const relative = path.relative(root, full);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The real path of `full`, or of its nearest existing ancestor joined with the part that does not exist yet. */
async function realTarget(full: string): Promise<string> {
  const missing: string[] = [];
  let current = full;
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return full;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Before a write or deletion: the target, with symbolic links resolved, still lies in the project.
 * A text check alone lets a link inside the project carry a write outside it.
 */
export async function assertWritableInside(root: string, full: string, shown: string): Promise<void> {
  if (!isInside(root, full)) throw new Error(`Path leaves the project: ${shown}`);
  const [realRoot, target] = await Promise.all([fs.realpath(root).catch(() => root), realTarget(full)]);
  if (!isInside(realRoot, target)) throw new Error(`Path leaves the project through a symbolic link: ${shown} resolves to ${target}`);
}
