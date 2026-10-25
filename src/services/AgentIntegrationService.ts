import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { FileService } from './FileService';
import { ProjectPaths } from '../models/types';
import { WORKER_TIERS, buildHooksFile, buildPreCommitHook, buildProjectMcpJson, buildWorkerAgent, upsertCodexMcpTable, workerAgentName } from './AgentIntegrationCore';
import { AGENT_PROVIDERS, LOOP_COMMAND, LOOP_SCRIPT, LOOP_SKILL, MCP_SCRIPT, MCP_SERVER_NAME, PROVIDER_IDS, loopScriptPath } from './AgentProviders';
import { NodeGitRunner } from '../cli/nodeGit';

/**
 * Writes each agent's hook and MCP configuration for the research loop, driven
 * by `AGENT_PROVIDERS`. Codex reads MCP servers only from its user config, so
 * its bridge is registered in `~/.codex/config.toml` and finds the open project
 * through the bridge registry. Idempotent.
 */
export class AgentIntegrationService {
  constructor(private readonly fileService: FileService, private readonly extensionRoot: string, private readonly output: vscode.OutputChannel) {}

  async ensure(_paths: ProjectPaths): Promise<string[]> {
    const root = this.fileService.rootUri.fsPath;
    const written: string[] = [];
    const upsert = async (file: string, build: (existing: string) => string) => {
      const existing = await this.fileService.readFile(file).catch(() => '');
      try {
        const content = build(existing);
        if (content !== existing) { await this.fileService.writeFile(file, content); written.push(file); }
      } catch (error: unknown) {
        this.output.appendLine(`[agents] Skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const id of PROVIDER_IDS) {
      const spec = AGENT_PROVIDERS[id];
      await upsert(spec.hooksFile, (existing) => buildHooksFile(id, existing, loopScriptPath(root, id)));
      const mcp = spec.mcp;
      if (mcp.kind === 'project-json') await upsert(mcp.file, (existing) => buildProjectMcpJson(existing, loopScriptPath(root, id, MCP_SCRIPT), root, mcp.file));
      else await this.registerCodexServer();
      if (spec.agentsDir) {
        for (const tier of WORKER_TIERS) {
          const file = `${spec.agentsDir}/${workerAgentName(tier)}.md`;
          const existing = await this.fileService.readFile(file).catch(() => '');
          const content = buildWorkerAgent(tier, existing, spec.skillsDir, LOOP_COMMAND);
          if (content !== undefined && content !== existing) { await this.fileService.writeFile(file, content); written.push(file); }
        }
      }
    }
    await this.ensurePreCommitHook(root).catch((error: unknown) => this.output.appendLine(`[agents] Skipped the git pre-commit check: ${error instanceof Error ? error.message : String(error)}`));
    if (written.length) this.output.appendLine(`[agents] Wrote ${written.join(', ')}`);
    return written;
  }

  /** Install the research pre-commit check in the workspace's git repository, unless the repository manages its own hooks. */
  private async ensurePreCommitHook(root: string): Promise<void> {
    const git = new NodeGitRunner(root);
    const top = await git.run(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return; // not a git repository
    const custom = await git.run(['config', '--get', 'core.hooksPath']);
    if (custom.code === 0 && custom.stdout.trim()) { this.output.appendLine(`[agents] core.hooksPath is set (${custom.stdout.trim()}); the research pre-commit check is not installed.`); return; }
    const hooks = await git.run(['rev-parse', '--git-path', 'hooks']);
    if (hooks.code !== 0) return;
    const project = path.relative(await fs.realpath(top.stdout.trim()), await fs.realpath(root)).split(path.sep).join('/') || '.';
    const script = path.posix.join(project, AGENT_PROVIDERS.codex.skillsDir, LOOP_SKILL, 'scripts', LOOP_SCRIPT);
    const file = path.join(path.resolve(root, hooks.stdout.trim()), 'pre-commit');
    const existing = await fs.readFile(file, 'utf8').catch(() => '');
    const content = buildPreCommitHook(existing, script, project);
    if (content === undefined) { this.output.appendLine(`[agents] ${file} is the repository's own hook; the research pre-commit check is not installed.`); return; }
    if (content === existing) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(file, 0o755);
    this.output.appendLine(`[agents] Installed the research pre-commit check in ${file}`);
  }

  /** Idempotently register the bundled MCP bridge in Codex's user config (only when Codex is installed). */
  private async registerCodexServer(): Promise<void> {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try { await fs.access(codexHome); } catch { return; } // Codex is not installed on this machine
    const file = path.join(codexHome, 'config.toml');
    const script = path.join(this.extensionRoot, 'out', MCP_SCRIPT);
    try {
      const existing = await fs.readFile(file, 'utf8').catch(() => '');
      const updated = upsertCodexMcpTable(existing, script);
      if (updated === existing) return;
      await fs.writeFile(file, updated, 'utf8');
      this.output.appendLine(`[agents] Registered the ${MCP_SERVER_NAME} MCP server in ${file} (${script})`);
    } catch (error: unknown) {
      this.output.appendLine(`[agents] Could not register the MCP server with Codex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
