import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectPaths, ResearchAssistantConfig } from '../models/types';

const PROJECT_TEMPLATE = `# Project

## Main Problem

## Background

## Current Goals

## Known Results

## Open Questions

## Writing Status
`;

const GITIGNORE_START = '# research-assistant:local:start';
const GITIGNORE_END = '# research-assistant:local:end';

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
    await this.ensureParentDirectory(relativePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  async writeBinary(relativePath: string, data: Uint8Array): Promise<void> {
    const uri = this.resolve(relativePath);
    await this.ensureParentDirectory(relativePath);
    await vscode.workspace.fs.writeFile(uri, data);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
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

  async ensureProjectStructure(
    config: ResearchAssistantConfig,
    paths: ProjectPaths,
    createLatexDefaults: boolean
  ): Promise<void> {
    const researchFolders = [
      paths.researchRoot,
      paths.assets,
      paths.ideas,
      paths.papers,
      paths.workflows,
      paths.localSourcePdfs,
      '.agents/skills',
      '.claude/skills',
      '.github',
    ];

    for (const folder of researchFolders) {
      const uri = this.resolve(folder);
      try {
        await vscode.workspace.fs.createDirectory(uri);
      } catch {
        // already exists
      }
    }

    await this.writeIfMissing(paths.projectMd, PROJECT_TEMPLATE);
    await this.writeIfMissing(paths.paperIndex, '# Papers\n');

    if (config.layout === 'overleaf-shared') {
      await this.writeIfMissing(`${paths.researchRoot}/README.md`, this.researchReadme(paths));
      await this.upsertGitignore(paths.localSourcePdfs);
    }

    if (createLatexDefaults) {
      await vscode.workspace.fs.createDirectory(this.resolve(paths.sections));
      for (const macroPath of paths.macroFiles) {
        await this.writeIfMissing(macroPath, '% Centralized macros and theorem environments\n');
      }
      if (paths.notations) {
        await this.writeIfMissing(paths.notations, '% Centralized notation reference\n');
      }
      await this.writeIfMissing(paths.bibliography, '% BibTeX references\n');

      const preambleInputs = [
        ...paths.macroFiles,
        ...(paths.notations ? [paths.notations] : []),
      ].map((inputPath) => `\\input{${inputPath.replace(/\.tex$/i, '')}}`).join('\n');
      await this.writeIfMissing(
        paths.mainTex,
        `\\documentclass{amsart}\n${preambleInputs}${preambleInputs ? '\n' : ''}\n\\begin{document}\n\n\\end{document}\n`
      );
    }
  }

  private async writeIfMissing(relativePath: string, content: string): Promise<void> {
    if (!(await this.exists(relativePath))) await this.writeFile(relativePath, content);
  }

  private async ensureParentDirectory(relativePath: string): Promise<void> {
    const parent = path.posix.dirname(relativePath);
    if (parent !== '.') await vscode.workspace.fs.createDirectory(this.resolve(parent));
  }

  private researchReadme(paths: ProjectPaths): string {
    return `# Shared research context

This directory is the version-controlled source of truth for Research Assistant.

- \`${paths.projectMd}\` describes the research problem, goals, and open questions.
- \`${paths.assets}/\` contains theorem, lemma, proposition, definition, example, construction, and remark nodes.
- \`${paths.ideas}/\` contains speculative strategies and open directions.
- \`${paths.paperIndex}\` indexes cited papers; \`${paths.papers}/\` contains shared metadata and working transcriptions.
- \`${paths.workflows}/\` contains agent-neutral research workflows.

Original source PDFs are intentionally stored in \`${paths.localSourcePdfs}/\`, which is ignored by Git. Record stable URLs, DOI/arXiv identifiers, checksums, and page-level provenance in shared paper metadata so collaborators can retrieve the same source.
`;
  }

  private async upsertGitignore(localSourcePdfs: string): Promise<void> {
    const current = await this.readFile('.gitignore').catch(() => '');
    const managed = `${GITIGNORE_START}\n/${localSourcePdfs.replace(/\/$/, '')}/\n*.aux\n*.fdb_latexmk\n*.fls\n*.log\n*.out\n*.run.xml\n*.synctex.gz\n*.toc\n${GITIGNORE_END}`;
    const start = current.indexOf(GITIGNORE_START);
    const end = current.indexOf(GITIGNORE_END);
    const updated = start !== -1 && end > start
      ? current.slice(0, start) + managed + current.slice(end + GITIGNORE_END.length)
      : current.trim()
        ? `${current.trimEnd()}\n\n${managed}\n`
        : `${managed}\n`;
    if (updated !== current) await this.writeFile('.gitignore', updated);
  }

  get rootUri(): vscode.Uri {
    return this.workspaceRoot;
  }
}
