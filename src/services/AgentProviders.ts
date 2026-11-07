import * as path from 'path';
import { AgentProvider } from './ResearchLoopModel';

/**
 * The only place that knows per-agent facts. Everything else (skill install,
 * hook and MCP config, chat commands, user-facing hints) reads this registry,
 * so Claude Code and Codex support cannot drift apart.
 */
export interface AgentProviderSpec {
  id: AgentProvider;
  label: string;
  /** VS Code extension that hosts the agent's chat. */
  extensionId: string;
  /** Command that opens that chat (no documented way to pre-fill a prompt). */
  openChatCommand: string;
  /** What the researcher types in the chat to run a skill. */
  invokePrefix: '/' | '$';
  /** Repository-local skill discovery folder. */
  skillsDir: string;
  /** Hook configuration file the extension manages. */
  hooksFile: string;
  /** PreToolUse matcher covering the agent's file-writing and shell tools, its read tools where it has them (a verifier may not read remarks), and the bridge's record_idea and add_remark (the teaching chat must say whose idea or remark it records). */
  writeToolMatcher: string;
  /** PostToolUse matcher for read tools, to audit reads outside the context pack; absent where the agent has no verified PostToolUse hook. */
  readToolMatcher?: string;
  /** The shell tool both the PreToolUse and PostToolUse hooks cover, so a long command counts as work in flight; absent where they do not pair. */
  shellTool?: string;
  /** Whether the agent has a SessionEnd hook, so a closed chat is seen at once rather than after a silence. */
  sessionEndHook: boolean;
  /** Subagent definitions folder; absent where the agent has no project-level subagent files. */
  agentsDir?: string;
  /** Where the agent itself keeps research-worker subagents the extension does not write (ignored, never generated). */
  externalWorkers?: { dir: string; extension: string };
  /** Whether the hooks file also carries permission allow rules (Claude settings). */
  hooksFileHasPermissions: boolean;
  /** How the MCP bridge is registered: a project `.mcp.json`, or Codex's user config via `codex mcp add`. */
  mcp: { kind: 'project-json'; file: string } | { kind: 'codex-cli' };
}

export const AGENT_PROVIDERS: Record<AgentProvider, AgentProviderSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    extensionId: 'anthropic.claude-code',
    openChatCommand: 'claude-vscode.sidebar.open',
    invokePrefix: '/',
    skillsDir: '.claude/skills',
    hooksFile: '.claude/settings.local.json',
    writeToolMatcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob|mcp__research-assistant__record_idea|mcp__research-assistant__add_remark',
    readToolMatcher: 'Read|Grep|Glob|Bash',
    shellTool: 'Bash',
    sessionEndHook: true,
    agentsDir: '.claude/agents',
    hooksFileHasPermissions: true,
    mcp: { kind: 'project-json', file: '.mcp.json' },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    extensionId: 'openai.chatgpt',
    openChatCommand: 'chatgpt.openSidebar',
    invokePrefix: '$',
    skillsDir: '.agents/skills',
    hooksFile: '.codex/hooks.json',
    writeToolMatcher: 'apply_patch|Bash|Write|Edit|mcp__research_assistant__record_idea|mcp__research_assistant__add_remark',
    sessionEndHook: false,
    externalWorkers: { dir: '.codex/agents', extension: '.toml' },
    hooksFileHasPermissions: false,
    mcp: { kind: 'codex-cli' },
  },
};

export const PROVIDER_IDS = Object.keys(AGENT_PROVIDERS) as AgentProvider[];
export const LOOP_SKILL = 'research-loop';
export const MCP_SERVER_NAME = 'research-assistant';
export const LOOP_SCRIPT = 'research-loop.cjs';
export const MCP_SCRIPT = 'research-loop-mcp.cjs';

export function providerSpec(id: AgentProvider): AgentProviderSpec { return AGENT_PROVIDERS[id]; }

/** e.g. "/research-loop" or "$research-loop". */
export function invocation(id: AgentProvider, skill = LOOP_SKILL): string { return `${AGENT_PROVIDERS[id].invokePrefix}${skill}`; }

/** e.g. "Type $research-loop in the Codex chat." */
export function chatHint(id: AgentProvider): string { return `Type ${invocation(id)} in the ${AGENT_PROVIDERS[id].label} chat.`; }

/** Absolute path of a bundled loop script inside a provider's skill folder. */
export function loopScriptPath(root: string, id: AgentProvider, file: string = LOOP_SCRIPT): string {
  return path.join(root, AGENT_PROVIDERS[id].skillsDir, LOOP_SKILL, 'scripts', file);
}

export function allChatHints(): string { return PROVIDER_IDS.map((id) => `${invocation(id)} (${AGENT_PROVIDERS[id].label})`).join(' or '); }

/**
 * How agents run the loop CLI from the project root. Both agents can use the
 * `.agents` copy (the installer writes every provider's skill folder), which is
 * also the path SKILL.md documents; one spelling keeps instructions identical.
 */
export const LOOP_COMMAND = `node ${AGENT_PROVIDERS.codex.skillsDir}/${LOOP_SKILL}/scripts/${LOOP_SCRIPT}`;
/** The manuscript CLI as the draft-latex skill documents it. */
export const MANUSCRIPT_COMMAND = `node ${AGENT_PROVIDERS.codex.skillsDir}/draft-latex/scripts/manuscript-writing.cjs`;
/** The validator as the research-maintenance skill documents it. */
export const MAINTENANCE_COMMAND = `node ${AGENT_PROVIDERS.codex.skillsDir}/research-maintenance/scripts/research-maintenance.cjs`;

/** Bundled skills that were merged or replaced; installs remove their copies and the generated .gitignore keeps ignoring them. */
export const RETIRED_SKILLS = [
  'prove-asset',
  // Merged into research-maintenance, extract-research-nodes, explore-research, plan-manuscript, and draft-latex.
  'order-assets', 'order-definitions', 'link-research-nodes', 'convert-proof-ideas',
  'extract-theorems', 'extract-definitions', 'find-relevant', 'summarize', 'plan-section', 'manuscript-writing',
  // Replaced by search-object when falsification became an object search.
  'falsify-asset',
];
