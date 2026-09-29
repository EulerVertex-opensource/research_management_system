import * as path from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { parseMarkdown } from './Frontmatter';
import { stripOrdinal } from './AssetOrder';

export interface InterlinkInput { filePath: string; raw: string }
export interface InterlinkChange { filePath: string; raw: string; links: number }
export interface InterlinkIssue { filePath: string; line: number; kind: 'missing-relationship' | 'ambiguous-term' | 'missing-target'; text: string }
export interface InterlinkPlan { changes: InterlinkChange[]; issues: InterlinkIssue[] }

interface AstNode {
  type: string;
  value?: string;
  children?: AstNode[];
  position?: { start: { offset?: number; line: number }; end: { offset?: number } };
}
interface IndexedNode extends InterlinkInput {
  id: string;
  kind: 'asset' | 'definition';
  term: string;
  body: string;
  bodyOffset: number;
  dependencies: string[];
  definitions: string[];
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const WORD = /[\p{L}\p{N}_]/u;
const BLOCKED = new Set(['link', 'linkReference', 'image', 'imageReference', 'inlineCode', 'code', 'math', 'inlineMath', 'html', 'heading', 'definition']);

function contains(folder: string, filePath: string): boolean {
  return path.posix.dirname(filePath) === folder.replace(/\/$/, '');
}

function indexNode(input: InterlinkInput, assetFolder: string, definitionFolder: string): IndexedNode | null {
  const kind = contains(assetFolder, input.filePath) ? 'asset' : contains(definitionFolder, input.filePath) ? 'definition' : null;
  if (!kind || !input.filePath.endsWith('.md')) return null;
  const prefix = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(input.raw);
  if (!prefix) throw new Error(`${input.filePath} needs YAML frontmatter`);
  const data = parseMarkdown(input.raw).data;
  const title = data.title;
  if (typeof title !== 'string') throw new Error(`${input.filePath} needs a title`);
  const unnumbered = stripOrdinal(title);
  const term = kind === 'definition' ? /^Definition \((.*)\)$/.exec(unnumbered)?.[1] ?? unnumbered : unnumbered;
  const id = path.posix.basename(input.filePath, '.md');
  return {
    ...input, id, kind, term: term.trim(),
    body: input.raw.slice(prefix[0].length), bodyOffset: prefix[0].length,
    dependencies: Array.isArray(data.depends_on) ? data.depends_on.filter((value: unknown): value is string => typeof value === 'string') : [],
    definitions: Array.isArray(data.uses_definitions) ? data.uses_definitions.filter((value: unknown): value is string => typeof value === 'string') : [],
  };
}

function boundary(text: string, start: number, length: number): boolean {
  return (start === 0 || !WORD.test(text[start - 1])) &&
    (start + length === text.length || !WORD.test(text[start + length]));
}

/** Plans raw offset edits, leaving frontmatter and all Markdown syntax intact. */
export function planResearchInterlinks(inputs: InterlinkInput[], assetFolder: string, definitionFolder: string): InterlinkPlan {
  const indexed = inputs.map((item) => indexNode(item, assetFolder, definitionFolder)).filter((item): item is IndexedNode => item !== null);
  const assets = new Map(indexed.filter((item) => item.kind === 'asset').map((item) => [item.id, item]));
  const definitions = new Map(indexed.filter((item) => item.kind === 'definition').map((item) => [item.id, item]));
  const changes: InterlinkChange[] = [];
  const issues: InterlinkIssue[] = [];

  for (const source of indexed) {
    const targets = source.kind === 'definition' ? [...definitions.values()] : [...assets.values(), ...definitions.values()];
    const linked = new Set(source.dependencies.map((id) => `${source.kind}:${id}`));
    if (source.kind === 'asset') for (const id of source.definitions) linked.add(`definition:${id}`);
    for (const id of source.dependencies) {
      const target = source.kind === 'definition' ? definitions.get(id) : assets.get(id);
      if (!target) issues.push({ filePath: source.filePath, line: 1, kind: 'missing-target', text: `depends_on: ${id}` });
    }
    if (source.kind === 'asset') for (const id of source.definitions) {
      if (!definitions.has(id)) issues.push({ filePath: source.filePath, line: 1, kind: 'missing-target', text: `uses_definitions: ${id}` });
    }

    const terms = new Map<string, IndexedNode[]>();
    for (const target of targets) {
      if (target.filePath === source.filePath || !target.term) continue;
      const key = target.term.toLowerCase();
      terms.set(key, [...(terms.get(key) ?? []), target]);
    }
    const sortedTerms = [...terms.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
    const edits: { start: number; end: number; replacement: string }[] = [];
    const tree = parser.parse(source.body) as unknown as AstNode;
    const walk = (node: AstNode, blocked = false): void => {
      const excluded = blocked || BLOCKED.has(node.type);
      if (node.type === 'text' && !excluded && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
        const start = node.position.start.offset;
        const end = node.position.end.offset;
        const raw = source.body.slice(start, end);
        if (raw !== node.value) return; // Escapes/entities need human review.
        const lower = raw.toLowerCase();
        for (let i = 0; i < raw.length;) {
          const term = sortedTerms.find((candidate) => lower.startsWith(candidate, i) && boundary(raw, i, candidate.length));
          if (!term) { i++; continue; }
          const matches = terms.get(term)!;
          const line = node.position.start.line + raw.slice(0, i).split('\n').length - 1;
          const text = raw.slice(i, i + term.length);
          if (matches.length !== 1) {
            issues.push({ filePath: source.filePath, line, kind: 'ambiguous-term', text });
          } else {
            const target = matches[0];
            const relationship = `${target.kind}:${target.id}`;
            if (!linked.has(relationship)) {
              issues.push({ filePath: source.filePath, line, kind: 'missing-relationship', text: `${text} -> ${target.kind}/${target.id}` });
            } else {
              let relative = path.posix.relative(path.posix.dirname(source.filePath), target.filePath);
              if (!relative.startsWith('.')) relative = `./${relative}`;
              edits.push({ start: source.bodyOffset + start + i, end: source.bodyOffset + start + i + term.length, replacement: `[${text}](${relative})` });
            }
          }
          i += term.length;
        }
      }
      for (const child of node.children ?? []) walk(child, excluded);
    };
    walk(tree);
    if (edits.length) {
      let raw = source.raw;
      for (const edit of edits.sort((a, b) => b.start - a.start)) raw = raw.slice(0, edit.start) + edit.replacement + raw.slice(edit.end);
      changes.push({ filePath: source.filePath, raw, links: edits.length });
    }
  }
  return { changes, issues };
}
