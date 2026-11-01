/**
 * The levels of understanding a researcher can record for a verified result,
 * and their words. No imports, so the webview can use them too.
 */

/** The researcher's own record, local and never shared (research-local/ is ignored by Git). */
export const UNDERSTANDING_PATH = 'research-local/understanding.json';

/** `black_box`: knows what it says and can use it; `idea`: knows the key idea of the proof; `full`: has checked every step. */
export type UnderstandingLevel = 'black_box' | 'idea' | 'full';
export const UNDERSTANDING_LEVELS: readonly UnderstandingLevel[] = ['black_box', 'idea', 'full'];
export const LEVEL_LABEL: Record<UnderstandingLevel, string> = { black_box: 'What it says', idea: 'The key idea', full: 'Every step' };
export const LEVEL_HINT: Record<UnderstandingLevel, string> = {
  black_box: 'I know the statement and can use it as a black box.',
  idea: 'I know the key idea of the proof and where it is hard.',
  full: 'I have followed every step.',
};

/**
 * Where the researcher stands on one result now: `new` (never marked),
 * `understood`, `statement_changed` (the mark no longer applies), or
 * `proof_changed` (they still know what it says, but the proof they studied is
 * gone). A black-box mark ignores proof changes.
 */
export type UnderstandingState = 'new' | 'understood' | 'statement_changed' | 'proof_changed';
export const STATE_LABEL: Record<UnderstandingState, string> = {
  new: 'New to you', understood: 'Understood', statement_changed: 'Statement changed since you studied it', proof_changed: 'Proof changed since you studied it',
};

const RANK: Record<UnderstandingLevel, number> = { black_box: 1, idea: 2, full: 3 };
export const atLeast = (level: UnderstandingLevel | undefined, wanted: UnderstandingLevel) => Boolean(level && RANK[level] >= RANK[wanted]);
export const toLevel = (value: unknown): UnderstandingLevel | undefined => (UNDERSTANDING_LEVELS as readonly unknown[]).includes(value) ? value as UnderstandingLevel : undefined;

/**
 * What the dashboard copies for a new chat that teaches: it names the teach
 * skill, which is also how the hooks tell a teaching chat from the one that
 * drives the loop (see TEACH_PROMPT_PATTERN).
 */
export function teachPrompt(target?: { id: string; title: string }): string {
  return `Use the teach skill to walk me through ${target ? `${target.title} (${target.id})` : 'the verified results I have not studied yet'}. This chat is only for learning; the loop runs in its own chat.`;
}
/** A prompt that starts a teaching chat: `/teach` (Claude Code), `$teach` (Codex), or one naming the teach skill. */
export const TEACH_PROMPT_PATTERN = /(?:^|\s)[/$]teach\b|\bteach skill\b/i;
