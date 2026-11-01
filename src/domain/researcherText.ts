/**
 * Text the agent writes for the researcher (report summaries, park notes)
 * shows on the dashboard as is. This finds the loop's own vocabulary in it,
 * so the CLI can remind the agent to say it in research terms. A reminder,
 * never a failure: a false alarm must not block a stage.
 */

const CHECKS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bslots?\s*#?\d+/i, what: 'search slot numbers' },
  { pattern: /\b(?:worker|subagent|context pack|round record|candidates? (?:file|written))s?\b/i, what: 'loop internals (workers, packs, candidate files)' },
  { pattern: /\b[\w-]+\.(?:md|json|jsonl|tex|cjs|ts)\b/, what: 'file names' },
  { pattern: /`[^`]+`/, what: 'code formatting' },
  // A snake_case word whose first part has two letters or more: an ID such as lib_arf_surgery, not a subscript such as x_1.
  { pattern: /\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/, what: 'IDs (use the result’s title)' },
];

/** What in `text` reads as the loop's vocabulary rather than mathematics; empty when nothing does. Math in `$…$` is ignored. */
export function internalVocabulary(text: string): string[] {
  const prose = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, ' ');
  return CHECKS.filter((check) => check.pattern.test(prose)).map((check) => check.what);
}

/** One line for the CLI after a report or park, or '' when the text reads fine. */
export function vocabularyReminder(text: string): string {
  const found = internalVocabulary(text);
  return found.length
    ? `Note: the researcher reads this text on the dashboard. Next time leave out ${found.join(', ')}; see "Writing for the researcher" in the research-loop skill.`
    : '';
}
