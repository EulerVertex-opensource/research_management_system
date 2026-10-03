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

export function hasSection(body: string, heading: string): boolean {
  return new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, 'm').test(body);
}

export function hasSectionContent(body: string, heading: string): boolean {
  return Boolean(sectionContent(body, heading));
}

/** Level-2 headings in order of appearance. */
export function sectionHeadings(body: string): string[] {
  return [...body.matchAll(/^## (.+?)[ \t]*$/gm)].map((match) => match[1]);
}

/** Everything before `## Proof`: the statement a researcher approves and a proof may not change. */
export function statementPart(body: string): string {
  return body.split(/^## Proof[ \t]*$/m)[0];
}

/** Ordered checklist step, e.g. `1. [ ] Prove the bound.` */
export const CHECKLIST_STEP = /^\d+\. \[[ xX]\] .+/m;

/** A leading YAML frontmatter block (`---` … `---`), as written by gray-matter. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The Markdown after any leading frontmatter; previews show this so metadata is not rendered as prose. */
export function withoutFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}
