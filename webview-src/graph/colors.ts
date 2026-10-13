import type { GraphNodeView, LoopTone, NodeProgress } from '../../src/models/graph';

/** Theme-aware colors: VS Code theme variables with fallbacks, so light and dark themes both read. */
export const COLOR = {
  approved: 'var(--vscode-testing-iconPassed, #3fb950)',
  draft: 'var(--vscode-descriptionForeground, #8b949e)',
  inactive: 'var(--vscode-disabledForeground, #6e7681)',
  waiting: 'var(--vscode-editorWarning-foreground, #d29922)',
  active: 'var(--vscode-charts-blue, var(--vscode-focusBorder, #2f81f7))',
  error: 'var(--vscode-errorForeground, #f85149)',
  link: 'var(--vscode-textLink-foreground, #3794ff)',
  card: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
  border: 'var(--vscode-panel-border, #444)',
  muted: 'var(--vscode-descriptionForeground, #8b949e)',
} as const;

/** A light wash of `color` over the editor background, for fills that work in both themes. */
export function tint(color: string, percent = 14): string {
  return `color-mix(in srgb, ${color} ${percent}%, var(--vscode-editor-background, #1e1e1e))`;
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

/** Results taken from the literature (cited from a paper or textbook, or a library result). */
export const CITED_COLOR = 'var(--vscode-charts-purple, #b180d7)';

/**
 * A node's color and border: its state, except that a checked cited result
 * shows in the cited color, so what the project proves and what it quotes are
 * told apart at a glance. An unchecked citation stays grey ("Not checked").
 */
export function nodeStyle(node: Pick<GraphNodeView, 'progress' | 'cited'>): { color: string; dashed: boolean } {
  const state = PROGRESS_STYLE[node.progress] ?? PROGRESS_STYLE.waiting;
  if (node.cited && node.progress === 'done') return { color: CITED_COLOR, dashed: false };
  return state;
}

export function nodeColor(node: Pick<GraphNodeView, 'progress' | 'cited'>): string {
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
