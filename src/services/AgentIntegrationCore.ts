import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { AgentProvider } from './ResearchLoopModel';
import { AGENT_PROVIDERS, LOOP_SCRIPT, MAINTENANCE_COMMAND, MCP_SERVER_NAME, PROVIDER_IDS, RETIRED_SKILLS } from './AgentProviders';

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
  const reads = AGENT_PROVIDERS[provider].readToolMatcher;
  return {
    ...(reads ? { PostToolUse: [{ matcher: reads, hooks: [{ type: 'command' as const, command: command('PostToolUse'), timeout: 10 }] }] } : {}),
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: command('SessionStart'), timeout: 20 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit'), timeout: 20 }] }],
    PreToolUse: [{ matcher: AGENT_PROVIDERS[provider].writeToolMatcher, hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 20 }] }],
    Stop: [{ hooks: [{ type: 'command', command: command('Stop'), timeout: 120 }] }],
    ...(AGENT_PROVIDERS[provider].preCompactHook ? { PreCompact: [{ hooks: [{ type: 'command' as const, command: command('PreCompact'), timeout: 20 }] }] } : {}),
    ...(AGENT_PROVIDERS[provider].sessionEndHook ? { SessionEnd: [{ hooks: [{ type: 'command' as const, command: command('SessionEnd'), timeout: 10 }] }] } : {}),
  };
}

const PRE_COMMIT_MARK = '# research-assistant: managed pre-commit check';
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The git pre-commit hook that runs `research-loop precommit`, or undefined
 * when the repository has a hook of its own (left alone). Paths are relative
 * to the repository top, where git runs hooks; without node or the installed
 * script the hook lets every commit through.
 */
export function buildPreCommitHook(existing: string, script: string, project: string): string | undefined {
  if (existing.trim() && !existing.includes(PRE_COMMIT_MARK)) return undefined;
  return [
    '#!/bin/sh',
    PRE_COMMIT_MARK,
    '# Refuses commits that add research file problems (misplaced files, clashing IDs, broken references).',
    '# Skip once with git commit --no-verify. Replace this file with a hook of your own and the extension leaves it alone.',
    `script=${shellQuote(script)}`,
    '[ -f "$script" ] && command -v node >/dev/null 2>&1 || exit 0',
    `exec node "$script" precommit --project ${shellQuote(project)}`,
    '',
  ].join('\n');
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

export const WORKER_TIERS = ['light', 'deep'] as const;
export type WorkerTier = typeof WORKER_TIERS[number];
const WORKER_MARK = '<!-- research-assistant:generated worker -->';

export function workerAgentName(tier: WorkerTier): string { return `research-worker-${tier}`; }

/**
 * A research-loop stage worker as a Claude Code subagent. Light runs the
 * bookkeeping stages on a cheaper model; deep keeps the session's model for
 * the mathematics, with the one-hour prompt cache: its turns often outlast
 * the five-minute default, and each lapse writes its whole context again.
 * A file the researcher edited (no marker) is left alone: returns undefined.
 */
export function buildWorkerAgent(tier: WorkerTier, existingText: string, skillsDir: string, loopCommand: string, maintenanceCommand = MAINTENANCE_COMMAND): string | undefined {
  if (existingText.trim() && !existingText.includes(WORKER_MARK)) return undefined;
  const stages = tier === 'light' ? 'scaffold, sources, and search_summary' : 'search, verify_counterexample, verify_construction, plan, execute, verify_proof, verify_node, conjecture, route, route_merge, reduce, and verify_reduction';
  return `---
name: ${workerAgentName(tier)}
description: Runs one research-loop stage (${stages}) from its compiled context pack and returns a short summary. Used by the research-loop driver only.
tools: Read, Write, Edit, Bash
model: ${tier === 'light' ? 'sonnet' : 'inherit'}
${tier === 'deep' ? 'experimental:\n  cacheTtl: 1h\n' : ''}---
${WORKER_MARK}

You run exactly one research-loop stage. The driver gives you the stage, the asset, the stage skill, and the context pack path.

1. Read the context pack the driver gives you (\`.research-assistant-loop/context/current.md\`, or your own \`search-<slot>.md\` in a search round) and \`${skillsDir}/<stage skill>/SKILL.md\`. Nothing else up front.
2. Need more? Run \`${loopCommand} show <id> [--section Heading]\` for that one node or section. Do not list or read research folders directly.
3. Do the stage's work in the files, following the skill. Never set \`status: approved\`; never run \`report\`, \`next\`, or git commands. The driver does that.
4. Reply with at most five lines (three in a search round): the outcome (for example \`searched\`, \`summarized\`, \`complete --plan <id>\`, \`proved\`, \`failed\`, ${tier === 'deep' ? '`partial: <what remains>`, ' : ''}or \`question: ...\`), the files you wrote, and the key mathematical reason.

Commands you may need (no need to run \`help\`):
- \`${loopCommand} show <id|paper_slug|project> [--section Heading]...\`: one node or section; a paper slug alone shows its outline.
- \`${loopCommand} library search <words...> [--type T]\`: known results to reuse.
- \`${loopCommand} idea add --title "..." --body "..." [--kind approach|question|observation|test_case|risk] [--asset ID] [--origin researcher]\`: keep a side thought. It is recorded as the agent's; add \`--origin researcher\` only for the researcher's own idea in their words.
- \`${maintenanceCommand} validate\` and \`${maintenanceCommand} links --file <path> --apply\`: check the files you wrote.
`;
}

/**
 * .gitignore entries for everything the extension installs or generates for
 * coding agents: every skill it ships or once shipped (per provider skill
 * folder), the worker subagents, hooks, and MCP files. Researchers' own skills
 * and agents under the same folders stay trackable.
 */
export function generatedAgentIgnores(bundledSkillNames: string[]): string[] {
  const skills = [...new Set([...bundledSkillNames, ...RETIRED_SKILLS])].sort();
  return PROVIDER_IDS.flatMap((id) => {
    const spec = AGENT_PROVIDERS[id];
    return [
      ...skills.map((name) => `/${spec.skillsDir}/${name}/`),
      ...(spec.agentsDir ? WORKER_TIERS.map((tier) => `/${spec.agentsDir}/${workerAgentName(tier)}.md`) : []),
      ...(spec.externalWorkers ? WORKER_TIERS.map((tier) => `/${spec.externalWorkers!.dir}/${workerAgentName(tier)}${spec.externalWorkers!.extension}`) : []),
      `/${spec.hooksFile}`,
      ...(spec.mcp.kind === 'project-json' ? [`/${spec.mcp.file}`] : []),
    ];
  });
}
