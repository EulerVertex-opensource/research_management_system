/**
 * Just enough BibTeX and paper-index handling to merge one project's
 * citations into another: entries are found by key and compared by the work
 * they name (DOI, arXiv ID, or title and year), never rewritten beyond their
 * key. Pure: shared by the extension, the bundled CLIs, and tests.
 */

export interface BibEntry { key: string; type: string; raw: string; start: number; end: number }

const ENTRY_START = /^[ \t]*@(\w+)\s*\{\s*([^,\s]+)\s*,/gm;
const NON_ENTRIES = new Set(['comment', 'string', 'preamble']);

/** Every entry of a .bib text, in order, with its exact source text. */
export function parseBibEntries(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  ENTRY_START.lastIndex = 0;
  for (let match = ENTRY_START.exec(text); match; match = ENTRY_START.exec(text)) {
    const start = match.index + match[0].indexOf('@');
    const open = text.indexOf('{', start);
    let depth = 0;
    let index = open;
    for (; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) break;
    }
    const end = Math.min(index + 1, text.length);
    ENTRY_START.lastIndex = end;
    if (NON_ENTRIES.has(match[1].toLowerCase())) continue;
    entries.push({ key: match[2], type: match[1].toLowerCase(), raw: text.slice(start, end), start, end });
  }
  return entries;
}

export function bibKeys(text: string): Set<string> {
  return new Set(parseBibEntries(text).map((entry) => entry.key));
}

/** One field's value with outer braces or quotes removed, or undefined. */
export function bibField(raw: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*)\\}|"([^"]*)"|([\\w.-]+))`, 'i').exec(raw);
  const value = match ? (match[1] ?? match[2] ?? match[3]) : undefined;
  return value?.trim() || undefined;
}

const normalizeDoi = (value: string) => value.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').trim();
const normalizeEprint = (value: string) => value.toLowerCase().replace(/^arxiv:\s*/, '').replace(/v\d+$/, '').trim();
const normalizeTitle = (value: string) => value.toLowerCase().replace(/\\[a-z]+\s*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The identifiers that name an entry's work, strongest first. */
export function workIdentity(raw: string): { doi?: string; eprint?: string; title?: string } {
  const doi = bibField(raw, 'doi');
  const eprint = bibField(raw, 'eprint') ?? bibField(raw, 'arxiv');
  const title = bibField(raw, 'title');
  const year = bibField(raw, 'year');
  return {
    ...(doi ? { doi: normalizeDoi(doi) } : {}),
    ...(eprint ? { eprint: normalizeEprint(eprint) } : {}),
    ...(title ? { title: `${normalizeTitle(title)}|${year ?? ''}` } : {}),
  };
}

/** True when two entries name the same work: same DOI, else same arXiv ID, else same title and year. */
export function sameWork(a: string, b: string): boolean {
  const x = workIdentity(a);
  const y = workIdentity(b);
  if (x.doi && y.doi) return x.doi === y.doi;
  if (x.eprint && y.eprint) return x.eprint === y.eprint;
  if (x.title && y.title) return x.title === y.title;
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** True when two entries share a DOI or arXiv ID (the identifiers strong enough to match under different keys). */
export function sameIdentifier(a: string, b: string): boolean {
  const x = workIdentity(a);
  const y = workIdentity(b);
  return Boolean((x.doi && x.doi === y.doi) || (x.eprint && x.eprint === y.eprint));
}

export function renameBibKey(raw: string, key: string): string {
  return raw.replace(/^(\s*@\w+\s*\{\s*)[^,\s]+/, `$1${key}`);
}

/** A stable URL for an entry: its url field, else its DOI or arXiv link. */
export function bibUrl(raw: string): string | undefined {
  const url = bibField(raw, 'url');
  if (url && /^https?:\/\//.test(url)) return url;
  const { doi, eprint } = workIdentity(raw);
  if (doi) return `https://doi.org/${doi}`;
  if (eprint) return `https://arxiv.org/abs/${eprint}`;
  return undefined;
}

export function appendBibEntries(text: string, entries: string[]): string {
  if (!entries.length) return text;
  const base = text.trimEnd();
  return `${base}${base ? '\n\n' : ''}${entries.map((entry) => entry.trim()).join('\n\n')}\n`;
}

export function removeBibEntries(text: string, keys: Set<string>): string {
  const doomed = parseBibEntries(text).filter((entry) => keys.has(entry.key));
  if (!doomed.length) return text;
  let result = text;
  for (const entry of [...doomed].reverse()) {
    let end = entry.end;
    while (result[end] === '\n' || result[end] === '\r') end++;
    result = result.slice(0, entry.start) + result.slice(end);
  }
  return `${result.trimEnd()}\n`;
}

// ---------- the paper index (`## <slug>` sections) ----------

/** Body of each `## slug` section of the paper index, by slug. */
export function paperSections(index: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const match of index.matchAll(/^##\s+([a-z][a-z0-9_]*)\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)) sections.set(match[1], match[2].trim());
  return sections;
}

export function appendPaperSections(index: string, sections: Array<{ slug: string; body: string }>): string {
  if (!sections.length) return index;
  const base = index.trimEnd();
  return `${base}${base ? '\n\n' : ''}${sections.map((section) => `## ${section.slug}\n\n${section.body.trim()}`).join('\n\n')}\n`;
}

export function removePaperSections(index: string, slugs: Set<string>): string {
  if (!slugs.size) return index;
  const parts = index.split(/(?=^## )/m);
  const kept = parts.filter((part) => {
    const match = /^##\s+([a-z][a-z0-9_]*)\s*$/m.exec(part.split('\n')[0]);
    return !(match && slugs.has(match[1]));
  });
  return `${kept.join('').trimEnd()}\n`;
}

/** Keys a TeX text cites with \cite, \citet, \citep, \nocite, and similar. */
export function texCitations(tex: string): Set<string> {
  const keys = new Set<string>();
  for (const match of tex.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g)) {
    for (const key of match[1].split(',')) if (key.trim()) keys.add(key.trim());
  }
  return keys;
}
