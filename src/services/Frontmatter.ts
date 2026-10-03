import matter from 'gray-matter';

/**
 * gray-matter caches parses by content and hands back shallow copies, so
 * mutating `parsed.data` of a cached parse leaks into later parses of the same
 * text. The long-running extension mutates frontmatter (approve, revert,
 * deprecate), so every such caller parses through this uncached helper.
 */
export function parseMarkdown(raw: string): matter.GrayMatterFile<string> {
  return matter(raw, {});
}

export function stringifyMarkdown(content: string, data: Record<string, unknown>): string {
  return matter.stringify(content, data);
}
