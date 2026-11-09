/**
 * The one parser for `## Heading` sections in research Markdown. Pure; used by
 * the loop validator, the dashboard, sync summaries, and the CLIs.
 */

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Managed blocks the extension writes (backlinks, related assets); never part of what a researcher approves. */
export const MANAGED_BLOCK = /<!-- research-assistant:[a-z-]+:start -->[\s\S]*?<!-- research-assistant:[a-z-]+:end -->/g;

export function stripManagedBlocks(text: string): string {
  return text.replace(MANAGED_BLOCK, '');
}

/** Trimmed text under `## heading` up to the next `## `, or '' when absent. */
export function sectionContent(body: string, heading: string): string {
  const match = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(body);
  return match ? match[1].trim() : '';
}

/**
 * The outcome a `## Verdict` states: its first non-empty line must begin with
 * the word `confirmed` or `rejected` (emphasis allowed, a reason may follow on
 * the line). The explanation below never counts, so "rejection count" in a
 * confirmed verdict, or "not confirmed", cannot decide it; anything else is undefined.
 */
export function verdictOutcome(verdict: string): 'confirmed' | 'rejected' | undefined {
  const first = verdict.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const match = /^(confirmed|rejected)\b/i.exec(first.replace(/^[>*_\s]+/, ''));
  return match ? (match[1].toLowerCase() as 'confirmed' | 'rejected') : undefined;
}

export function hasSection(body: string, heading: string): boolean {
  return new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, 'm').test(body);
}

export function hasSectionContent(body: string, heading: string): boolean {
  return Boolean(sectionContent(body, heading));
}

/** Add a line at the end of `## heading`, creating the section at the end of the body when it is missing. */
export function appendToSection(body: string, heading: string, line: string): string {
  const match = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(body);
  if (!match) return `${body.trimEnd()}\n\n## ${heading}\n\n${line}\n`;
  const end = match.index + match[0].length;
  const section = `${match[0].trimEnd()}\n${line}\n`;
  const rest = body.slice(end);
  return `${body.slice(0, match.index)}${section}${rest ? `\n${rest}` : ''}`;
}

/** Level-2 headings in order of appearance. */
export function sectionHeadings(body: string): string[] {
  return [...body.matchAll(/^## (.+?)[ \t]*$/gm)].map((match) => match[1]);
}

/** Everything before `## Proof`: the statement a researcher approves and a proof may not change. */
/** Body before `## Proof`, or before `## Construction` (the object a construction search found, written after its specification). */
export function statementPart(body: string): string {
  return body.split(/^## (?:Proof|Construction)[ \t]*$/m)[0];
}

/** Ordered checklist step, e.g. `1. [ ] Prove the bound.` */
export const CHECKLIST_STEP = /^\d+\. \[[ xX]\] .+/m;

/** A leading YAML frontmatter block (`---` … `---`), as written by gray-matter. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The Markdown after any leading frontmatter; previews show this so metadata is not rendered as prose. */
export function withoutFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}
