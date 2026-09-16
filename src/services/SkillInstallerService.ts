import * as vscode from 'vscode';
import { FileService } from './FileService';

const SKILL_DESTINATIONS = [
  '.agents/skills',
  '.claude/skills',
];

/**
 * Installs the extension's bundled, agent-neutral skills into each supported
 * coding agent's repository-local discovery directory.
 *
 * The bundled `skills/` directory is the single source of truth. Keeping the
 * generated copies byte-for-byte identical prevents the Claude Code and Codex
 * variants from drifting apart.
 */
export class SkillInstallerService {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly fileService: FileService
  ) {}

  async installBundledSkills(): Promise<void> {
    const sourceRoot = vscode.Uri.joinPath(this.extensionUri, 'skills');
    const entries = await vscode.workspace.fs.readDirectory(sourceRoot);

    for (const [skillName, type] of entries) {
      if (!(type & vscode.FileType.Directory)) continue;

      const sourceSkill = vscode.Uri.joinPath(sourceRoot, skillName);
      if (!(await this.hasSkillManifest(sourceSkill))) continue;

      await Promise.all(
        SKILL_DESTINATIONS.map((destinationRoot) =>
          this.copyDirectory(
            sourceSkill,
            this.fileService.resolve(destinationRoot, skillName)
          )
        )
      );
    }
  }

  private async hasSkillManifest(skillDirectory: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.joinPath(skillDirectory, 'SKILL.md')
      );
      return Boolean(stat.type & vscode.FileType.File);
    } catch {
      return false;
    }
  }

  private async copyDirectory(source: vscode.Uri, destination: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(destination);

    const entries = await vscode.workspace.fs.readDirectory(source);
    await Promise.all(
      entries.map(async ([name, type]) => {
        const sourceEntry = vscode.Uri.joinPath(source, name);
        const destinationEntry = vscode.Uri.joinPath(destination, name);

        if (type & vscode.FileType.Directory) {
          await this.copyDirectory(sourceEntry, destinationEntry);
          return;
        }

        if (type & vscode.FileType.File) {
          const content = await vscode.workspace.fs.readFile(sourceEntry);
          await vscode.workspace.fs.writeFile(destinationEntry, content);
        }
      })
    );
  }
}
