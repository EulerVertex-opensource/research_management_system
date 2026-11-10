import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ProjectPaths, ResearchAssistantConfig, SyncConfig } from '../models/types';
import { LoopFiles, isLoopStatePath } from '../services/ResearchLoopModel';
import { assertWritableInside, isInside } from '../services/PathBoundary';
import { PROJECT_CONFIG_PATH, defaultLatexCommand, normalizeConfig, normalizeSyncConfig, pathsFromConfigText } from '../services/ProjectPathsCore';

/** Node `fs` implementation of the small file interface used by the research loop. */
export class NodeLoopFiles implements LoopFiles {
  constructor(readonly root: string) {}

  private resolve(relativePath: string): string {
    const full = path.resolve(this.root, relativePath);
    if (!isInside(this.root, full)) throw new Error(`Path leaves the project: ${relativePath}`);
    return full;
  }

  /** A path to write or delete: also its real location, symbolic links followed, stays in the project. */
  private async resolveWritable(relativePath: string): Promise<string> {
    const full = this.resolve(relativePath);
    await assertWritableInside(this.root, full, relativePath);
    return full;
  }

  async readFile(relativePath: string): Promise<string> { return fs.readFile(this.resolve(relativePath), 'utf8'); }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const full = await this.resolveWritable(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    if (!isLoopStatePath(relativePath)) { await fs.writeFile(full, content, 'utf8'); return; }
    // A reader in another process sees the old file or the new one, never a truncated one.
    const temp = `${full}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(temp, content, 'utf8');
    try { await fs.rename(temp, full); } catch (error) {
      await fs.rm(temp, { force: true });
      // Windows refuses to replace a file another process holds open; fall back to an in-place write.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
      await fs.writeFile(full, content, 'utf8');
    }
  }

  async appendFile(relativePath: string, content: string): Promise<void> {
    const full = await this.resolveWritable(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, content, 'utf8');
  }

  async deleteFile(relativePath: string): Promise<void> {
    await fs.rm(await this.resolveWritable(relativePath), { force: true });
  }

  async deleteEmptyDir(relativeDir: string): Promise<void> {
    // rmdir refuses a folder that still holds anything, which is the point.
    await fs.rmdir(await this.resolveWritable(relativeDir)).catch(() => undefined);
  }

  async exists(relativePath: string): Promise<boolean> {
    try { await fs.access(this.resolve(relativePath)); return true; } catch { return false; }
  }

  async listFiles(relativeDir: string, extension = '.md'): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.resolve(relativeDir), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension)).map((entry) => path.posix.join(relativeDir, entry.name)).sort();
    } catch { return []; }
  }

  async listDirs(relativeDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.resolve(relativeDir), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.posix.join(relativeDir, entry.name)).sort();
    } catch { return []; }
  }
}

/** Walk up from `start` to the nearest folder containing `.research-assistant.json`. */
export function findProjectRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (fsSync.existsSync(path.join(current, PROJECT_CONFIG_PATH))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function loadProjectConfig(root: string): Promise<ResearchAssistantConfig> {
  return normalizeConfig(JSON.parse(await fs.readFile(path.join(root, PROJECT_CONFIG_PATH), 'utf8')) as Partial<ResearchAssistantConfig>);
}

export async function loadProjectPaths(root: string): Promise<ProjectPaths> {
  return pathsFromConfigText(await fs.readFile(path.join(root, PROJECT_CONFIG_PATH), 'utf8'));
}

export async function loadSyncConfig(root: string): Promise<SyncConfig> {
  const raw = JSON.parse(await fs.readFile(path.join(root, PROJECT_CONFIG_PATH), 'utf8')) as Partial<ResearchAssistantConfig> & { sync?: Partial<SyncConfig> };
  const sync = normalizeSyncConfig(raw.sync);
  // Derived, not saved, so it follows later changes to latex.main.
  return { ...sync, latexCommand: sync.latexCommand ?? defaultLatexCommand(normalizeConfig(raw).latex) };
}
