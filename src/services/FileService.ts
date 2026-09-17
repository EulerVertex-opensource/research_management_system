import * as vscode from 'vscode';
import * as path from 'path';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
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
const LATEX_WORKSHOP_ID = 'james-yu.latex-workshop';

export const LATEX_OUTPUT_DIRECTORY = '.latex-out';
export const LATEX_WORKSHOP_SETTINGS = {
  'latex-workshop.latex.outDir': `%WORKSPACE_FOLDER%/${LATEX_OUTPUT_DIRECTORY}`,
  'latex-workshop.latex.auxDir': '%OUTDIR%',
  'latex-workshop.latex.autoBuild.run': 'never',
} as const;

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
    createLatexDefaults: boolean,
    bundledSkillNames: string[]
  ): Promise<void> {
    const researchFolders = [
      paths.researchRoot,
      paths.assets,
      paths.ideas,
      paths.papers,
      paths.localSourcePdfs,
      LATEX_OUTPUT_DIRECTORY,
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
    }

    await this.upsertGitignore(paths, bundledSkillNames);
    await this.ensureLatexWorkspaceConfiguration();

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

Original source PDFs are intentionally stored in \`${paths.localSourcePdfs}/\`, which is ignored by Git. Record stable URLs, DOI/arXiv identifiers, checksums, and page-level provenance in shared paper metadata so collaborators can retrieve the same source.
`;
  }

  private async upsertGitignore(paths: ProjectPaths, bundledSkillNames: string[]): Promise<void> {
    const current = await this.readFile('.gitignore').catch(() => '');
    const managed = [
      GITIGNORE_START,
      '# Local source PDFs and LaTeX output',
      `/${paths.localSourcePdfs.replace(/\/$/, '')}/`,
      `/${LATEX_OUTPUT_DIRECTORY}/`,
      '*.aux',
      '*.fdb_latexmk',
      '*.fls',
      '*.log',
      '*.out',
      '*.run.xml',
      '*.synctex.gz',
      '*.toc',
      '__pycache__/',
      '*.pyc',
      '# Recreated by the same Research Assistant extension version',
      '# Only extension-maintained skills are local; project skills can be tracked',
      ...bundledSkillNames.flatMap((name) => [
        `/.agents/skills/${name}/`,
        `/.claude/skills/${name}/`,
      ]),
      '/.github/copilot-instructions.md',
      '/AGENTS.md',
      '/CLAUDE.md',
      '/.vscode/settings.json',
      '/.vscode/extensions.json',
      ...(paths.researchRoot !== '.' ? [`/${paths.researchRoot}/README.md`] : []),
      GITIGNORE_END,
    ].join('\n');
    const start = current.indexOf(GITIGNORE_START);
    const end = current.indexOf(GITIGNORE_END);
    const updated = start !== -1 && end > start
      ? current.slice(0, start) + managed + current.slice(end + GITIGNORE_END.length)
      : current.trim()
        ? `${current.trimEnd()}\n\n${managed}\n`
        : `${managed}\n`;
    if (updated !== current) await this.writeFile('.gitignore', updated);
  }

  private async ensureLatexWorkspaceConfiguration(): Promise<void> {
    const existingSettings = await this.readFile('.vscode/settings.json').catch(() => '');
    let settings = existingSettings || '{}\n';
    const parsedSettings = this.parseJsoncObject(settings, '.vscode/settings.json');
    for (const [key, value] of Object.entries(LATEX_WORKSHOP_SETTINGS)) {
      if (parsedSettings && Object.prototype.hasOwnProperty.call(parsedSettings, key)) continue;
      settings = applyEdits(settings, modify(settings, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }));
    }
    settings = settings.endsWith('\n') ? settings : `${settings}\n`;
    if (settings !== existingSettings) await this.writeFile('.vscode/settings.json', settings);

    const existingExtensions = await this.readFile('.vscode/extensions.json').catch(() => '');
    let extensions = existingExtensions || '{}\n';
    const parsedExtensions = this.parseJsoncObject(extensions, '.vscode/extensions.json');
    const existing = Array.isArray(parsedExtensions?.recommendations)
      ? parsedExtensions.recommendations.filter((item): item is string => typeof item === 'string')
      : [];
    if (!existing.includes(LATEX_WORKSHOP_ID)) {
      extensions = applyEdits(extensions, modify(
        extensions,
        ['recommendations'],
        [...existing, LATEX_WORKSHOP_ID],
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }
      ));
    }
    extensions = extensions.endsWith('\n') ? extensions : `${extensions}\n`;
    if (extensions !== existingExtensions) await this.writeFile('.vscode/extensions.json', extensions);
  }

  private parseJsoncObject(content: string, relativePath: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const parsed = parse(content, errors, {
      allowTrailingComma: true,
      allowEmptyContent: true,
      disallowComments: false,
    });
    if (errors.length || (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)))) {
      throw new Error(`Research Assistant cannot merge ${relativePath} because it is not valid JSON with comments.`);
    }
    return (parsed ?? {}) as Record<string, unknown>;
  }

  get rootUri(): vscode.Uri {
    return this.workspaceRoot;
  }
}
