import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FileService } from './FileService';
import { AGENT_PROVIDERS, LOOP_SCRIPT, LOOP_SKILL, MCP_SCRIPT, PROVIDER_IDS, RETIRED_SKILLS } from './AgentProviders';
import { DRIVER_PATH } from './ResearchLoopModel';

const SKILL_DESTINATIONS = PROVIDER_IDS.map((id) => AGENT_PROVIDERS[id].skillsDir);
/** Built CLIs (under out/) copied into each skill's scripts folder. */
export const SKILL_SCRIPTS: Record<string, string[]> = {
  'research-loop': [LOOP_SCRIPT, MCP_SCRIPT],
  'research-maintenance': ['research-maintenance.cjs'],
  'draft-latex': ['manuscript-writing.cjs'],
};

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

  async listBundledSkillNames(): Promise<string[]> {
    const sourceRoot = vscode.Uri.joinPath(this.extensionUri, 'skills');
    const entries = await vscode.workspace.fs.readDirectory(sourceRoot);
    const skillNames: string[] = [];

    for (const [skillName, type] of entries) {
      if (!(type & vscode.FileType.Directory)) continue;

      const sourceSkill = vscode.Uri.joinPath(sourceRoot, skillName);
      if (!(await this.hasSkillManifest(sourceSkill))) continue;
      skillNames.push(skillName);
    }

    return skillNames;
  }

  /**
   * Hooks and the Claude MCP server run the project's copy of the loop driver,
   * while the extension runs its own engine. Reinstall the bundled skills when
   * the copy differs from this extension's build, so two engine versions never
   * write the same loop state. Returns true when it reinstalled.
   */
  async ensureCurrentDrivers(): Promise<boolean> {
    const bundled = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'out', LOOP_SCRIPT));
    let stale = false;
    for (const destinationRoot of SKILL_DESTINATIONS) {
      const installed = await vscode.workspace.fs.readFile(this.fileService.resolve(destinationRoot, LOOP_SKILL, 'scripts', LOOP_SCRIPT)).then((data) => data, () => undefined);
      if (!installed || Buffer.compare(Buffer.from(installed), Buffer.from(bundled)) !== 0) stale = true;
    }
    if (stale) await this.installBundledSkills(await this.listBundledSkillNames());
    else await this.writeDriverStamp(bundled);
    return stale;
  }

  private async writeDriverStamp(driver: Uint8Array): Promise<void> {
    const sha256 = crypto.createHash('sha256').update(driver).digest('hex');
    await this.fileService.writeFile(DRIVER_PATH, JSON.stringify({ sha256, writtenAt: new Date().toISOString() }, null, 2) + '\n');
  }

  async installBundledSkills(skillNames: string[]): Promise<void> {
    const sourceRoot = vscode.Uri.joinPath(this.extensionUri, 'skills');
    for (const retired of RETIRED_SKILLS) {
      for (const destinationRoot of SKILL_DESTINATIONS) await this.removeRetiredSkill(destinationRoot, retired);
    }

    for (const skillName of skillNames) {
      const sourceSkill = vscode.Uri.joinPath(sourceRoot, skillName);
      await Promise.all(SKILL_DESTINATIONS.map((destinationRoot) => this.copyDirectory(sourceSkill, this.fileService.resolve(destinationRoot, skillName))));
      for (const script of SKILL_SCRIPTS[skillName] ?? []) {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'out', script));
        await Promise.all(SKILL_DESTINATIONS.map(async (destinationRoot) => {
          const destination = this.fileService.resolve(destinationRoot, skillName, 'scripts');
          await vscode.workspace.fs.createDirectory(destination);
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(destination, script), content);
        }));
        if (script === LOOP_SCRIPT) await this.writeDriverStamp(content);
      }
    }
  }

  /**
   * Remove an installed copy of a retired bundled skill. A folder is only
   * deleted when its SKILL.md names that skill and describes research work, so
   * a researcher's own skill that happens to share the name is left alone.
   */
  private async removeRetiredSkill(destinationRoot: string, name: string): Promise<void> {
    const folder = this.fileService.resolve(destinationRoot, name);
    const manifest = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'SKILL.md')).then((data) => Buffer.from(data).toString('utf8'), () => undefined);
    if (manifest === undefined || !isBundledSkillManifest(manifest, name)) return;
    await vscode.workspace.fs.delete(folder, { recursive: true }).then(undefined, () => undefined);
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

/** True for a SKILL.md this extension shipped under `name`: its frontmatter names the skill and it describes research nodes. */
export function isBundledSkillManifest(manifest: string, name: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(manifest)?.[1] ?? '';
  return new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(frontmatter) && /research|\.research-assistant\.json|asset/i.test(manifest);
}
