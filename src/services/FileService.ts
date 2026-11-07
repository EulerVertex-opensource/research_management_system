import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { ProjectPaths, ResearchAssistantConfig } from '../models/types';
import { AGENT_PROVIDERS, PROVIDER_IDS } from './AgentProviders';
import { migrateApprovals } from './ApprovalStore';
import { isLoopStatePath, sharedFolders } from './ResearchLoopModel';
import { PROJECT_TEMPLATE } from '../domain/project';
import { generatedAgentIgnores } from './AgentIntegrationCore';
import { ASSET_TYPE_LIST } from '../domain/nodeKinds';

const GITIGNORE_START = '# research-assistant:local:start';
const WRITING_OUTLINE_TEMPLATE = `# Manuscript outline

List sections in presentation order using stable IDs. Each entry points to a brief in sections/<id>.md. Keep proof plans in the configured research plans folder.

## Sections

`;
const GITIGNORE_END = '# research-assistant:local:end';
const GITATTRIBUTES_START = '# research-assistant:merge:start';
const GITATTRIBUTES_END = '# research-assistant:merge:end';
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
    if (!isLoopStatePath(relativePath)) { await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8')); return; }
    // The MCP bridges and the CLI read loop state concurrently: replace it whole, never truncate it in place.
    const temp = uri.with({ path: `${uri.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp` });
    await vscode.workspace.fs.writeFile(temp, Buffer.from(content, 'utf8'));
    try { await vscode.workspace.fs.rename(temp, uri, { overwrite: true }); } catch {
      await vscode.workspace.fs.delete(temp).then(undefined, () => undefined);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  }

  /** Append in one write; vscode.workspace.fs has no append, so local files use node's. */
  async appendFile(relativePath: string, content: string): Promise<void> {
    const uri = this.resolve(relativePath);
    await this.ensureParentDirectory(relativePath);
    if (uri.scheme === 'file') { await fsp.appendFile(uri.fsPath, content, 'utf8'); return; }
    const old = await this.readFile(relativePath).catch(() => '');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(old + content, 'utf8'));
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

  async deleteFile(relativePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.resolve(relativePath));
    } catch {
      // already gone
    }
  }

  async deleteEmptyDir(relativeDir: string): Promise<void> {
    try {
      const uri = this.resolve(relativeDir);
      if (!(await vscode.workspace.fs.readDirectory(uri)).length) await vscode.workspace.fs.delete(uri);
    } catch {
      // missing, or not empty
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

  async listDirs(relativeDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.resolve(relativeDir));
      return entries.filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.')).map(([name]) => path.posix.join(relativeDir, name)).sort();
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
      paths.definitions,
      paths.ideas,
      paths.plans,
      paths.library,
      paths.writingSections,
      paths.papers,
      paths.localSourcePdfs,
      LATEX_OUTPUT_DIRECTORY,
      ...PROVIDER_IDS.map((id) => AGENT_PROVIDERS[id].skillsDir),
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
    await this.writeIfMissing(paths.writingOutline, WRITING_OUTLINE_TEMPLATE);

    if (config.layout === 'overleaf-shared') {
      await this.writeIfMissing(`${paths.researchRoot}/README.md`, this.researchReadme(paths));
    }

    await this.upsertGitignore(paths, bundledSkillNames);
    await this.upsertGitattributes(paths);
    // One file per approval, so collaborators approving different results do not conflict.
    await migrateApprovals(this, paths.researchRoot);
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
        `\\documentclass{amsart}\n${preambleInputs}${preambleInputs ? '\n' : ''}\n\\begin{document}\n\n% research-assistant:sections:start\n% research-assistant:sections:end\n\n\\end{document}\n`
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
    const shared = sharedFolders(paths.researchRoot);
    return `# Shared research context

This directory is the version-controlled source of truth for Research Assistant.

- \`${paths.projectMd}\` is the research contract: the problem, scope, intended contribution, and the \`required_results\` that decide when the work is complete.
- \`${paths.assets}/\` contains ${ASSET_TYPE_LIST.join(', ')} nodes.
- \`${paths.definitions}/\` contains mathematical definitions and their notation.
- \`${paths.ideas}/\` contains freeform research ideas.
- \`${paths.plans}/\` contains proof plans, one per attempt; failed and succeeded plans are kept as the record of what was tried.
- \`${paths.library}/<collection>/assets|definitions/\` holds known results imported from earlier work or papers, grouped by source (one folder per collection). Their IDs start with \`lib_\`; project results reference them in \`depends_on\`/\`uses_definitions\`. A researcher approves each one once; the loop never re-proves them. Library files can be edited at any time (git keeps the history); editing an approved one returns it to draft for re-approval.
- \`${paths.writingOutline}\` orders manuscript sections; \`${paths.writingSections}/\` contains section briefs. LaTeX section files remain the manuscript source of truth.
- \`${paths.paperIndex}\` indexes cited papers; \`${paths.papers}/\` contains shared metadata and working transcriptions.
- \`${shared.checks}/\` records falsification checks (what was tried against which statement, and what was not covered) and the summary of each object-search round (obstructions, limitations).
- \`${shared.candidates}/\` holds object-search candidates: each object a worker proposed for a counterexample or construction, with a pass/fail verdict per property, so collaborators and later rounds do not repeat them.
- \`${shared.decisions}/\` records researcher decisions (new directions, change requests, parked results); \`${shared.handoffs}/\` says where work stopped and what comes next.
- \`${shared.approvals}/\` holds one approval record per approved result; approvals are made only by a researcher in VS Code.

Nothing else belongs here: nodes sit directly in their folders (group them with tags), with no subfolders, new folders, or index, README, or overview notes. Files elsewhere are never read by the dashboard or the loop; \`research-maintenance validate\` and \`sync prepare\` report them.

Share work with \`research-loop sync prepare\` and the "Publish Research to Collaborators" command; bring in collaborators' work with \`research-loop sync pull\`. Keep research discussion in these files rather than Overleaf comments, which Git synchronization can drop.

Original source PDFs are intentionally stored in \`${paths.localSourcePdfs}/\`, which is ignored by Git. Record stable URLs, DOI/arXiv identifiers, checksums, and page-level provenance in shared paper metadata so collaborators can retrieve the same source.
`;
  }

  /** Rewrite the managed .gitignore block; writes only when it changed (e.g. a newer extension bundles a new skill). */
  async upsertGitignore(paths: ProjectPaths, bundledSkillNames: string[]): Promise<void> {
    const current = await this.readFile('.gitignore').catch(() => '');
    const localPdfs = paths.localSourcePdfs.replace(/\/$/, '');
    const managed = [
      GITIGNORE_START,
      '# Local-only research files, source PDFs, and LaTeX output',
      '/research-local/',
      ...(localPdfs.startsWith('research-local/') ? [] : [`/${localPdfs}/`]),
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
      '# Preinstalled skills, worker subagents, hooks, and MCP files are local; your own skills and agents can be tracked',
      ...generatedAgentIgnores(bundledSkillNames),
      '/.github/copilot-instructions.md',
      '/AGENTS.md',
      '/CLAUDE.md',
      '/.vscode/settings.json',
      '/.vscode/extensions.json',
      '/.research-assistant-loop/',
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

  /** Append-only indexes merge by keeping both sides' new entries instead of conflicting. */
  private async upsertGitattributes(paths: ProjectPaths): Promise<void> {
    const current = await this.readFile('.gitattributes').catch(() => '');
    const managed = [
      GITATTRIBUTES_START,
      '# Research Assistant appends to these; union merge keeps both collaborators\' new entries',
      `/${paths.paperIndex} merge=union`,
      `/${paths.bibliography} merge=union`,
      GITATTRIBUTES_END,
    ].join('\n');
    const start = current.indexOf(GITATTRIBUTES_START);
    const end = current.indexOf(GITATTRIBUTES_END);
    const updated = start !== -1 && end > start
      ? current.slice(0, start) + managed + current.slice(end + GITATTRIBUTES_END.length)
      : current.trim() ? `${current.trimEnd()}\n\n${managed}\n` : `${managed}\n`;
    if (updated !== current) await this.writeFile('.gitattributes', updated);
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
