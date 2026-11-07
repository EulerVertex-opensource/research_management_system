/**
 * Chats beside the loop's own: a writing chat works on the manuscript with
 * the manuscript skills. The hooks tell it from the chat that drives the loop
 * by the skill its prompt names (or the manuscript script it runs), so it
 * never takes the loop's lock or is sent on to drive the loop.
 */
export const MANUSCRIPT_SKILLS = ['plan-manuscript', 'draft-latex', 'revise-manuscript-prose', 'check-notation'] as const;

/** A prompt that starts a writing chat: `/draft-latex` (Claude Code), `$draft-latex` (Codex), or one naming a manuscript skill. */
export const WRITE_PROMPT_PATTERN = new RegExp(`(?:^|\\s)[/$](?:${MANUSCRIPT_SKILLS.join('|')})\\b|\\b(?:${MANUSCRIPT_SKILLS.join('|')}) skill\\b`, 'i');

/** Ends every manuscript prompt the dashboard copies: the chat it is pasted into should be a new one. */
export const MANUSCRIPT_CHAT_NOTE = 'This chat is only for the manuscript; the loop runs in its own chat.';
