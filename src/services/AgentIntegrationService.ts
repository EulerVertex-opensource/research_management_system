import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { FileService } from './FileService';
import { ProjectPaths } from '../models/types';
import { WORKER_TIERS, buildHooksFile, buildProjectMcpJson, buildWorkerAgent, upsertCodexMcpTable, workerAgentName } from './AgentIntegrationCore';
import { AGENT_PROVIDERS, LOOP_COMMAND, MCP_SCRIPT, MCP_SERVER_NAME, PROVIDER_IDS, loopScriptPath } from './AgentProviders';

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
    if (written.length) this.output.appendLine(`[agents] Wrote ${written.join(', ')}`);
    return written;
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
