import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { FileService } from './FileService';
import { ProjectPaths } from '../models/types';
import { buildClaudeMcpJson, buildCodexHooksJson, mergeClaudeSettings } from './AgentIntegrationCore';

function run(command: string, args: string[]): Promise<{ ok: boolean; missing: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 20000 }, (error, stdout, stderr) => resolve({ ok: !error, missing: Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT'), stdout: String(stdout), stderr: String(stderr) }));
  });
}

/**
 * Writes the Claude Code and Codex hook and MCP configuration for the research
 * loop. Claude reads project `.mcp.json`; Codex (0.150) only reads MCP servers
 * from the user config, so the bundled server is registered there once with
 * `codex mcp add`, and it locates the project through the bridge registry.
 */
export class AgentIntegrationService {
  constructor(private readonly fileService: FileService, private readonly extensionRoot: string, private readonly output: vscode.OutputChannel) {}

  async ensure(_paths: ProjectPaths): Promise<string[]> {
    const root = this.fileService.rootUri.fsPath;
    const claudeScript = path.join(root, '.claude', 'skills', 'research-loop', 'scripts', 'research-loop.cjs');
    const claudeMcp = path.join(root, '.claude', 'skills', 'research-loop', 'scripts', 'research-loop-mcp.cjs');
    const codexScript = path.join(root, '.agents', 'skills', 'research-loop', 'scripts', 'research-loop.cjs');
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
    await upsert('.claude/settings.local.json', (existing) => mergeClaudeSettings(existing, claudeScript));
    await upsert('.mcp.json', (existing) => buildClaudeMcpJson(existing, claudeMcp, root));
    await upsert('.codex/hooks.json', (existing) => buildCodexHooksJson(existing, codexScript));
    await this.registerCodexServer();
    if (written.length) this.output.appendLine(`[agents] Wrote ${written.join(', ')}`);
    return written;
  }

  /** Idempotently register the bundled MCP bridge with Codex's user config. */
  private async registerCodexServer(): Promise<void> {
    const script = path.join(this.extensionRoot, 'out', 'research-loop-mcp.cjs');
    const current = await run('codex', ['mcp', 'get', 'research-assistant', '--json']);
    if (current.missing) return; // Codex is not installed on this machine
    if (current.ok && current.stdout.includes(script)) return;
    if (current.ok) await run('codex', ['mcp', 'remove', 'research-assistant']);
    const added = await run('codex', ['mcp', 'add', 'research-assistant', '--', 'node', script]);
    this.output.appendLine(added.ok ? `[agents] Registered the research-assistant MCP server with Codex (${script})` : `[agents] Could not register the MCP server with Codex: ${added.stderr.trim() || added.stdout.trim()}`);
  }
}
