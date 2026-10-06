import type { GraphFlag, GraphNodeView } from '../../src/models/graph';

/** Theme-aware colors: VS Code theme variables with fallbacks, so light and dark themes both read. */
export const COLOR = {
  approved: 'var(--vscode-testing-iconPassed, #3fb950)',
  draft: 'var(--vscode-descriptionForeground, #8b949e)',
  inactive: 'var(--vscode-disabledForeground, #6e7681)',
  waiting: 'var(--vscode-editorWarning-foreground, #d29922)',
  active: 'var(--vscode-focusBorder, #2f81f7)',
  error: 'var(--vscode-errorForeground, #f85149)',
  link: 'var(--vscode-textLink-foreground, #3794ff)',
  card: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
  border: 'var(--vscode-panel-border, #444)',
  muted: 'var(--vscode-descriptionForeground, #8b949e)',
} as const;

export const FLAG_META: Record<GraphFlag, { symbol: string; label: string; color: string }> = {
  awaiting_approval: { symbol: '◷', label: 'Waiting for your approval', color: COLOR.waiting },
  question: { symbol: '?', label: 'The loop asked you a question', color: COLOR.waiting },
  counterexample: { symbol: '⚠', label: 'A candidate counterexample waits for you', color: COLOR.error },
  refuted: { symbol: '✕', label: 'Refuted by an approved counterexample', color: COLOR.error },
  parked: { symbol: '⏸', label: 'Parked', color: COLOR.waiting },
  active: { symbol: '●', label: 'The loop is working on it', color: COLOR.active },
  searching: { symbol: '⌕', label: 'An object search is running on it', color: COLOR.active },
  uncovered: { symbol: '○', label: 'Approved but not in the manuscript', color: COLOR.link },
  manuscript_stale: { symbol: '△', label: 'A locked manuscript section is stale because of it', color: COLOR.waiting },
  manuscript_invalid: { symbol: '✕', label: 'A locked manuscript section presents it but it no longer holds', color: COLOR.error },
};

export function statusColor(status: string): string {
  if (status === 'approved') return COLOR.approved;
  if (status === 'deprecated' || status === 'archived') return COLOR.inactive;
  return COLOR.draft;
}

/** The one color a node's border takes: the most urgent flag, else its status. */
export function nodeColor(node: GraphNodeView): string {
  for (const flag of ['counterexample', 'refuted', 'manuscript_invalid', 'question', 'awaiting_approval', 'parked', 'searching', 'active', 'manuscript_stale', 'uncovered'] as GraphFlag[]) {
    if (node.flags.includes(flag)) return FLAG_META[flag].color;
  }
  return statusColor(node.status);
}

export const SECTION_STATE_COLOR: Record<string, string> = {
  current: COLOR.approved, stale: COLOR.waiting, invalid: COLOR.error, unlocked: COLOR.muted, planned: COLOR.muted, dependency: COLOR.muted,
};
