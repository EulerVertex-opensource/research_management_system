import * as vscode from 'vscode';
import * as path from 'path';

const RESEARCH_FOLDERS = [
  'assets',
  'ideas',
  'raw_papers',
  'manuscript/sections',
  '.research/workflows',
  '.agents/skills',
  '.claude/skills',
];

const INITIAL_FILES: Record<string, string> = {
  'project.md': `# Project\n\n## Main Problem\n\n## Background\n\n## Current Goals\n\n## Known Results\n\n## Open Questions\n\n## Writing Status\n`,
  'papers.md': `# Papers\n`,
  'manuscript/macro.tex': `% Centralized macros and theorem environments\n`,
  'manuscript/notations.tex': `% Centralized notation reference\n`,
  'manuscript/reference.bib': `% BibTeX references\n`,
  'manuscript/main.tex':
    `\\documentclass{amsart}\n\\input{macro}\n\\input{notations}\n\n\\begin{document}\n\n\\end{document}\n`,
};

export class FileService {
  constructor(private readonly workspaceRoot: vscode.Uri) {}

  resolve(...segments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, ...segments);
  }

  async readFile(relativePath: string): Promise<string> {
    const uri = this.resolve(relativePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const uri = this.resolve(relativePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  async writeBinary(relativePath: string, data: Uint8Array): Promise<void> {
    const uri = this.resolve(relativePath);
    await vscode.workspace.fs.writeFile(uri, data);
  }

  async renameFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const oldUri = this.resolve(oldRelativePath);
    const newUri = this.resolve(newRelativePath);
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
  }

  async listFiles(relativeDir: string, extension = '.md'): Promise<string[]> {
    const uri = this.resolve(relativeDir);
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(extension))
        .map(([name]) => path.posix.join(relativeDir, name));
    } catch {
      return [];
    }
  }

  async listFilesRecursive(relativeDir: string, extension: string): Promise<string[]> {
    const uri = this.resolve(relativeDir);
    const results: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of entries) {
        const childPath = path.posix.join(relativeDir, name);
        if (type === vscode.FileType.File && name.endsWith(extension)) {
          results.push(childPath);
        } else if (type === vscode.FileType.Directory) {
          const sub = await this.listFilesRecursive(childPath, extension);
          results.push(...sub);
        }
      }
    } catch {
      // directory may not exist yet
    }
    return results;
  }

  async ensureProjectStructure(): Promise<void> {
    for (const folder of RESEARCH_FOLDERS) {
      const uri = this.resolve(folder);
      try {
        await vscode.workspace.fs.createDirectory(uri);
      } catch {
        // already exists
      }
    }

    for (const [relativePath, content] of Object.entries(INITIAL_FILES)) {
      const uri = this.resolve(relativePath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      }
    }
  }

  get rootUri(): vscode.Uri {
    return this.workspaceRoot;
  }
}
