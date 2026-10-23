import type { GraphNodeView, LoopTone, NodeProgress } from '../../src/models/graph';

/**
 * The design system's colors (src/webview/themeCss.ts defines the `--ra-*`
 * tokens for light and dark), each with the VS Code theme color as fallback.
 */
export const COLOR = {
  approved: 'var(--ra-done, var(--vscode-testing-iconPassed, #3fb950))',
  draft: 'var(--ra-muted, var(--vscode-descriptionForeground, #8b949e))',
  inactive: 'var(--ra-inactive, var(--vscode-disabledForeground, #6e7681))',
  waiting: 'var(--ra-needs, var(--vscode-editorWarning-foreground, #d29922))',
  active: 'var(--ra-primary, var(--vscode-charts-blue, #2f81f7))',
  error: 'var(--ra-danger, var(--vscode-errorForeground, #f85149))',
  link: 'var(--ra-primary, var(--vscode-textLink-foreground, #3794ff))',
  /** Page background behind the cards. */
  canvas: 'var(--ra-canvas, var(--vscode-editor-background))',
  /** Card surface. */
  card: 'var(--ra-surface, var(--vscode-editorWidget-background, var(--vscode-editor-background)))',
  /** A panel recessed within a card or beside the cards (side lists). */
  sunken: 'var(--ra-surface-sunken, var(--vscode-sideBar-background, var(--vscode-editor-background)))',
  border: 'var(--ra-surface-border, var(--vscode-panel-border, #444))',
  muted: 'var(--ra-muted, var(--vscode-descriptionForeground, #8b949e))',
  /** Solid fill behind white text (primary buttons, the selected toggle). */
  solid: 'var(--ra-primary-solid, var(--vscode-button-background))',
  solidHover: 'var(--ra-primary-solid-hover, var(--vscode-button-hoverBackground))',
} as const;

/** A light wash of `color` over the card surface, for fills that work in both themes. */
export function tint(color: string, percent = 14): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${COLOR.card})`;
}

/** One color per graph state; `dashed` marks results that cannot move yet. */
export const PROGRESS_STYLE: Record<NodeProgress, { color: string; dashed: boolean }> = {
  done: { color: COLOR.approved, dashed: false },
  working: { color: COLOR.active, dashed: false },
  needs_you: { color: COLOR.waiting, dashed: false },
  stuck: { color: COLOR.error, dashed: false },
  waiting: { color: COLOR.muted, dashed: true },
  stalled: { color: COLOR.waiting, dashed: true },
  inactive: { color: COLOR.inactive, dashed: true },
};

/** Definitions, so they read apart from results in both the list and the graph. */
export const DEFINITION_COLOR = 'var(--ra-definition, var(--vscode-terminal-ansiCyan, #11a8cd))';

/** Results taken from the literature (cited from a paper or textbook, or a library result). */
export const CITED_COLOR = 'var(--ra-cited, var(--vscode-charts-purple, #b180d7))';

/**
 * A node's color and border: its state, except that a checked cited result
 * shows in the cited color, so what the project proves and what it quotes are
 * told apart at a glance. An unchecked citation stays grey ("Not checked").
 */
export function nodeStyle(node: Pick<GraphNodeView, 'progress' | 'cited'> & { kind?: GraphNodeView['kind'] }): { color: string; dashed: boolean } {
  const state = PROGRESS_STYLE[node.progress] ?? PROGRESS_STYLE.waiting;
  // A definition that is agreed, or not yet, shows in the definition color; one that needs the researcher keeps that state's color.
  if (node.kind === 'definition' && (node.progress === 'done' || node.progress === 'waiting')) return { color: DEFINITION_COLOR, dashed: node.progress === 'waiting' };
  if (node.cited && node.progress === 'done') return { color: CITED_COLOR, dashed: false };
  return state;
}

export function nodeColor(node: Pick<GraphNodeView, 'progress' | 'cited'> & { kind?: GraphNodeView['kind'] }): string {
  return nodeStyle(node).color;
}

export const TONE_COLOR: Record<LoopTone, string> = {
  neutral: COLOR.muted, info: COLOR.active, warning: COLOR.waiting, error: COLOR.error, success: COLOR.approved,
};

export const SECTION_STATE_COLOR: Record<string, string> = {
  current: COLOR.approved, stale: COLOR.waiting, invalid: COLOR.error, unlocked: COLOR.muted, planned: COLOR.muted, dependency: COLOR.muted,
};

/** Section and paper states in words. */
export const SECTION_STATE_LABEL: Record<string, string> = {
  current: 'up to date', stale: 'out of date', invalid: 'shows results that no longer hold', unlocked: 'not reviewed yet', planned: 'planned', dependency: 'needed by a presented result',
};
