import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';

/**
 * Pure builders for the agent-side configuration the extension generates:
 * Claude Code hooks/permissions, `.mcp.json`, Codex `hooks.json`, and the
 * Codex `config.toml` MCP block. Every builder preserves unrelated user content
 * and is idempotent.
 */

export const MANAGED_MARK = 'research-loop.cjs';
const TOML_START = '# research-assistant:start';
const TOML_END = '# research-assistant:end';
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

interface HookEntry { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }

function quote(value: string): string { return `"${value.replace(/(["\\])/g, '\\$1')}"`; }

export function hookEntries(scriptPath: string, flavor: 'claude' | 'codex'): Record<string, HookEntry[]> {
  const command = (event: string) => `node ${quote(scriptPath)} hook ${event}`;
  const writeMatcher = flavor === 'claude' ? 'Write|Edit|MultiEdit|NotebookEdit|Bash' : 'apply_patch|shell|Bash|Write|Edit';
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: command('SessionStart'), timeout: 20 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit'), timeout: 20 }] }],
    PreToolUse: [{ matcher: writeMatcher, hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 20 }] }],
    Stop: [{ hooks: [{ type: 'command', command: command('Stop'), timeout: 120 }] }],
  };
}

function isManaged(entry: unknown): boolean {
  const hooks = (entry as HookEntry | undefined)?.hooks;
  return Array.isArray(hooks) && hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(MANAGED_MARK));
}

function parseObject(text: string, name: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is not a JSON object; fix it or remove it before refreshing.`);
  return value as Record<string, unknown>;
}

function mergeHooks(existingText: string, scriptPath: string, flavor: 'claude' | 'codex', name: string): string {
  const existing = parseObject(existingText, name);
  let text = existingText.trim() ? existingText : '{}\n';
  const hooks = (existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {}) as Record<string, unknown[]>;
  for (const [event, entries] of Object.entries(hookEntries(scriptPath, flavor))) {
    const kept = Array.isArray(hooks[event]) ? hooks[event].filter((entry) => !isManaged(entry)) : [];
    text = applyEdits(text, modify(text, ['hooks', event], [...kept, ...entries], FORMAT));
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `.claude/settings.local.json`: managed hooks plus permission allows for the loop script and MCP server. */
export function mergeClaudeSettings(existingText: string, scriptPath: string): string {
  let text = mergeHooks(existingText, scriptPath, 'claude', '.claude/settings.local.json');
  const existing = parseObject(text, '.claude/settings.local.json');
  const permissions = (existing.permissions && typeof existing.permissions === 'object' ? existing.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((rule): rule is string => typeof rule === 'string') : [];
  const wanted = [`Bash(node ${scriptPath} *)`, `Bash(node ${quote(scriptPath)} *)`, 'mcp__research-assistant'];
  const merged = [...allow.filter((rule) => !rule.includes(MANAGED_MARK) && rule !== 'mcp__research-assistant'), ...wanted];
  text = applyEdits(text, modify(text, ['permissions', 'allow'], merged, FORMAT));
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `.mcp.json`: the `research-assistant` stdio server; other servers untouched. */
export function buildClaudeMcpJson(existingText: string, mcpScriptPath: string, projectRoot: string): string {
  parseObject(existingText, '.mcp.json');
  let text = existingText.trim() ? existingText : '{}\n';
  text = applyEdits(text, modify(text, ['mcpServers', 'research-assistant'], { command: 'node', args: [mcpScriptPath, '--project', projectRoot] }, FORMAT));
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `.codex/hooks.json`: same shape as Claude hooks with Codex tool matchers. */
export function buildCodexHooksJson(existingText: string, scriptPath: string): string {
  return mergeHooks(existingText, scriptPath, 'codex', '.codex/hooks.json');
}

/** `.codex/config.toml`: a marker block with the MCP server; skipped when the user defined the server elsewhere. */
export function mergeCodexConfigToml(existingText: string, mcpScriptPath: string, projectRoot: string): { content: string; skipped?: string } {
  const block = [
    TOML_START,
    '[mcp_servers.research-assistant]',
    'command = "node"',
    `args = [${quote(mcpScriptPath)}, "--project", ${quote(projectRoot)}]`,
    'tool_timeout_sec = 600',
    TOML_END,
  ].join('\n');
  const start = existingText.indexOf(TOML_START);
  const end = existingText.indexOf(TOML_END);
  const outside = start >= 0 && end > start ? existingText.slice(0, start) + existingText.slice(end + TOML_END.length) : existingText;
  if (/^\s*\[mcp_servers\.research-assistant\]/m.test(outside)) {
    return { content: existingText, skipped: '.codex/config.toml already defines [mcp_servers.research-assistant] outside the managed block; update it by hand or run: codex mcp add research-assistant -- node <research-loop-mcp.cjs>' };
  }
  if (start >= 0 && end > start) return { content: existingText.slice(0, start) + block + existingText.slice(end + TOML_END.length) };
  const content = existingText.trim() ? `${existingText.trimEnd()}\n\n${block}\n` : `${block}\n`;
  return { content };
}
