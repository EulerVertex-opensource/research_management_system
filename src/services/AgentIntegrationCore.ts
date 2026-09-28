import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { AgentProvider } from './ResearchLoopModel';
import { AGENT_PROVIDERS, LOOP_SCRIPT, MCP_SERVER_NAME } from './AgentProviders';

/**
 * Pure builders for the agent-side configuration the extension generates.
 * Per-agent differences come only from `AGENT_PROVIDERS`; every builder
 * preserves unrelated user content and is idempotent.
 */

export const MANAGED_MARK = LOOP_SCRIPT;
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

interface HookEntry { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }

function quote(value: string): string { return `"${value.replace(/(["\\])/g, '\\$1')}"`; }

export function hookEntries(scriptPath: string, provider: AgentProvider): Record<string, HookEntry[]> {
  const command = (event: string) => `node ${quote(scriptPath)} hook ${event}`;
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: command('SessionStart'), timeout: 20 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit'), timeout: 20 }] }],
    PreToolUse: [{ matcher: AGENT_PROVIDERS[provider].writeToolMatcher, hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 20 }] }],
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

const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** The provider's hooks file: managed hooks (plus permission allows where the file carries them). */
export function buildHooksFile(provider: AgentProvider, existingText: string, scriptPath: string): string {
  const spec = AGENT_PROVIDERS[provider];
  const existing = parseObject(existingText, spec.hooksFile);
  let text = existingText.trim() ? existingText : '{}\n';
  const hooks = (existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {}) as Record<string, unknown[]>;
  for (const [event, entries] of Object.entries(hookEntries(scriptPath, provider))) {
    const kept = Array.isArray(hooks[event]) ? hooks[event].filter((entry) => !isManaged(entry)) : [];
    text = applyEdits(text, modify(text, ['hooks', event], [...kept, ...entries], FORMAT));
  }
  if (spec.hooksFileHasPermissions) {
    const permissions = (existing.permissions && typeof existing.permissions === 'object' ? existing.permissions : {}) as Record<string, unknown>;
    const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((rule): rule is string => typeof rule === 'string') : [];
    const server = `mcp__${MCP_SERVER_NAME}`;
    const wanted = [`Bash(node ${scriptPath} *)`, `Bash(node ${quote(scriptPath)} *)`, server];
    const merged = [...allow.filter((rule) => !rule.includes(MANAGED_MARK) && rule !== server), ...wanted];
    text = applyEdits(text, modify(text, ['permissions', 'allow'], merged, FORMAT));
  }
  return withNewline(text);
}

/** A project MCP JSON file (`.mcp.json`): the bridge server; other servers untouched. */
export function buildProjectMcpJson(existingText: string, mcpScriptPath: string, projectRoot: string, name = '.mcp.json'): string {
  parseObject(existingText, name);
  const text = existingText.trim() ? existingText : '{}\n';
  return withNewline(applyEdits(text, modify(text, ['mcpServers', MCP_SERVER_NAME], { command: 'node', args: [mcpScriptPath, '--project', projectRoot] }, FORMAT)));
}

/**
 * Codex (0.150+) reads MCP servers only from `~/.codex/config.toml`. The bridge
 * owns the `[mcp_servers.research-assistant]` table (and its subtables): it is
 * replaced as a whole, everything else in the file is left byte-for-byte.
 * `default_tools_approval_mode = "approve"` lets Codex call the bridge's tools
 * without an approval prompt (they only ask the researcher, record ideas, and
 * read status); without it `codex exec` refuses the calls.
 */
export function upsertCodexMcpTable(existingToml: string, mcpScriptPath: string): string {
  const table = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    'command = "node"',
    `args = [${JSON.stringify(mcpScriptPath)}]`,
    'default_tools_approval_mode = "approve"',
  ].join('\n');
  const lines = existingToml.split('\n');
  const header = (line: string) => /^\s*\[/.test(line);
  const ours = (line: string) => new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}")(?:\\.[^\\]]*)?\\s*\\]`).test(line);
  const start = lines.findIndex(ours);
  if (start < 0) return existingToml.trim() ? `${existingToml.replace(/\s*$/, '')}\n\n${table}\n` : `${table}\n`;
  let end = start + 1;
  while (end < lines.length && (!header(lines[end]) || ours(lines[end]))) end++;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, start), table, ...lines.slice(end)].join('\n');
}
