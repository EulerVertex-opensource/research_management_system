/**
 * Where asset and definition nodes live. Project nodes sit directly in the
 * assets and definitions folders; library nodes (known results imported from
 * earlier work or papers) sit in `<library>/<collection>/assets|definitions/`.
 * Every lookup by ID goes through here so the library is one more place a
 * node can be found, not a special case at each call site. Pure: shared by
 * the extension, the bundled CLIs, and tests.
 */

/** Library node IDs carry this prefix so a reference shows at a glance that it points into the library. */
export const LIBRARY_PREFIX = 'lib_';
export const LIBRARY_KIND_FOLDERS = { asset: 'assets', definition: 'definitions' } as const;
/** Optional per-collection description file. */
export const COLLECTION_FILE = 'collection.md';

export type ResultKind = 'asset' | 'definition';
export type NodeOrigin = 'project' | 'library';

export interface NodeLayout { assets: string; definitions: string; library: string }
export interface NodeLocation { kind: ResultKind; origin: NodeOrigin; collection?: string }

/** The small file interface the registry needs; `listDirs` is optional so older test doubles see an empty library. */
export interface NodeLister {
  listFiles(relativeDir: string, extension?: string): Promise<string[]>;
  listDirs?(relativeDir: string): Promise<string[]>;
  exists(relativePath: string): Promise<boolean>;
}

const dirname = (file: string) => { const index = file.lastIndexOf('/'); return index < 0 ? '.' : file.slice(0, index); };
export const idOf = (file: string) => file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '');
export const isLibraryId = (id: string) => id.startsWith(LIBRARY_PREFIX);

/** Kind and origin of a node file, or undefined when it is not an asset or definition. */
export function locateNodeFile(file: string, layout: NodeLayout): NodeLocation | undefined {
  const folder = dirname(file);
  if (folder === layout.assets) return { kind: 'asset', origin: 'project' };
  if (folder === layout.definitions) return { kind: 'definition', origin: 'project' };
  const prefix = `${layout.library}/`;
  if (!folder.startsWith(prefix)) return undefined;
  const parts = folder.slice(prefix.length).split('/');
  if (parts.length !== 2 || !parts[0]) return undefined;
  const kind = parts[1] === LIBRARY_KIND_FOLDERS.asset ? 'asset' : parts[1] === LIBRARY_KIND_FOLDERS.definition ? 'definition' : undefined;
  return kind ? { kind, origin: 'library', collection: parts[0] } : undefined;
}

/** True when the path is inside the library tree (any depth). */
export function isLibraryPath(file: string, layout: Pick<NodeLayout, 'library'>): boolean {
  return file === layout.library || file.startsWith(`${layout.library}/`);
}

export async function libraryCollections(files: NodeLister, layout: Pick<NodeLayout, 'library'>): Promise<string[]> {
  if (!files.listDirs) return [];
  return (await files.listDirs(layout.library)).map(idOf).filter((name) => /^[a-z0-9][a-z0-9_-]*$/.test(name)).sort();
}

/** The folders holding nodes of a kind: the project folder first, then each collection's folder. */
export async function nodeFolders(files: NodeLister, layout: NodeLayout, kind: ResultKind): Promise<string[]> {
  const project = kind === 'asset' ? layout.assets : layout.definitions;
  const library = (await libraryCollections(files, layout)).map((collection) => `${layout.library}/${collection}/${LIBRARY_KIND_FOLDERS[kind]}`);
  return [project, ...library];
}

/** The library folders only, for both kinds. */
export async function libraryFolders(files: NodeLister, layout: NodeLayout): Promise<string[]> {
  return (await libraryCollections(files, layout)).flatMap((collection) => [`${layout.library}/${collection}/${LIBRARY_KIND_FOLDERS.asset}`, `${layout.library}/${collection}/${LIBRARY_KIND_FOLDERS.definition}`]);
}

export async function listNodeFiles(files: NodeLister, layout: NodeLayout, kind: ResultKind): Promise<string[]> {
  const result: string[] = [];
  for (const folder of await nodeFolders(files, layout, kind)) result.push(...await files.listFiles(folder, '.md'));
  return result;
}

/** The file of a node by ID: the project folder wins, then the library. Undefined when no such node exists. */
export async function findNodeFile(files: NodeLister, layout: NodeLayout, kind: ResultKind, id: string): Promise<string | undefined> {
  const project = `${kind === 'asset' ? layout.assets : layout.definitions}/${id}.md`;
  if (await files.exists(project)) return project;
  if (!isLibraryId(id)) return undefined;
  for (const folder of (await nodeFolders(files, layout, kind)).slice(1)) {
    const file = `${folder}/${id}.md`;
    if (await files.exists(file)) return file;
  }
  return undefined;
}

export interface RegistryNode { id: string; file: string; data: Record<string, any> }

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Rules that keep the library a closed set of known results: library IDs carry
 * the prefix, project IDs do not, and library nodes never depend on project nodes.
 */
export function libraryProblems(nodes: RegistryNode[], layout: NodeLayout): string[] {
  const problems: string[] = [];
  const origin = new Map<string, NodeOrigin>();
  for (const node of nodes) { const location = locateNodeFile(node.file, layout); if (location) origin.set(node.id, location.origin); }
  for (const node of nodes) {
    const location = locateNodeFile(node.file, layout);
    if (!location) continue;
    if (location.origin === 'library' && !isLibraryId(node.id)) problems.push(`${node.file}: library node IDs must start with ${LIBRARY_PREFIX}.`);
    if (location.origin === 'project' && isLibraryId(node.id)) problems.push(`${node.file}: the ${LIBRARY_PREFIX} prefix is reserved for library nodes; move it under the library or rename it.`);
    if (location.origin !== 'library') continue;
    for (const dep of [...list(node.data.depends_on), ...list(node.data.uses_definitions)]) {
      if (origin.get(dep) === 'project') problems.push(`${node.file}: library node depends on project node ${dep}; library results may use only library results.`);
    }
  }
  return problems;
}

export interface LibraryHit { id: string; kind: ResultKind; collection?: string; type: string; status: string; title: string; summary: string; score: number }
export interface SearchableNode { id: string; file: string; data: Record<string, any>; body: string }

/** Words that match nearly every statement and so rank nothing. */
const STOP_WORDS = new Set('a an and are as at be by every for from if in is it its let of on or that the then there this to under we with'.split(' '));

/**
 * One search word: lowercased, plural dropped, British spelling folded into
 * American (neighbourhoods → neighborhood, normalised → normalized, centre →
 * center), so a paper's spelling does not hide it from the project's.
 */
export function searchWord(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w.replace(/([^aeiou])our/g, '$1or').replace(/is(e|ed|es|ing|ation|ations)$/, 'iz$1').replace(/([bt])re$/, '$1er');
}

/** Normalized search words of a text, without stop words. */
export const searchWords = (text: string): string[] => (text.match(/[\p{L}\p{N}]+/gu) ?? []).map(searchWord).filter((word) => !STOP_WORDS.has(word));
const firstParagraph = (body: string) => body.replace(/^#+ .*$/gm, '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').slice(0, 200) ?? '';

/** The normalized words of a node, by where they occur. */
export function searchFields(node: SearchableNode): { title: Set<string>; tags: Set<string>; statement: Set<string>; id: Set<string> } {
  return {
    title: new Set(searchWords(String(node.data.title ?? ''))),
    tags: new Set(list(node.data.tags).flatMap(searchWords)),
    statement: new Set(searchWords(node.body.split(/^## Proof\b/m)[0])),
    id: new Set(searchWords(node.id.replace(/_/g, ' '))),
  };
}

/**
 * How well a node matches normalized terms: title words count most, then
 * tags, then the statement and the ID. `weight` scales each term (rare terms
 * up, common ones down); without it every term counts once.
 */
export function searchScore(node: SearchableNode, terms: string[], weight: (term: string) => number = () => 1): number {
  const fields = searchFields(node);
  let score = 0;
  for (const term of terms) score += weight(term) * ((fields.title.has(term) ? 3 : 0) + (fields.tags.has(term) ? 2 : 0) + (fields.statement.has(term) ? 1 : 0) + (fields.id.has(term) ? 1 : 0));
  return score;
}

/** The summary a search hit shows: the first paragraph of the body, cut short. */
export const searchSummary = (body: string): string => firstParagraph(body);

/**
 * Rank library nodes against free-text words. With no words, every node
 * matches (a listing).
 */
export function searchLibrary(nodes: SearchableNode[], layout: NodeLayout, query: string, options: { type?: string; collection?: string; limit?: number } = {}): LibraryHit[] {
  const terms = [...new Set(searchWords(query))];
  const hits: LibraryHit[] = [];
  for (const node of nodes) {
    const location = locateNodeFile(node.file, layout);
    if (location?.origin !== 'library') continue;
    if (options.collection && location.collection !== options.collection) continue;
    if (options.type && node.data.type !== options.type) continue;
    const score = searchScore(node, terms);
    if (terms.length && !score) continue;
    hits.push({ id: node.id, kind: location.kind, collection: location.collection, type: String(node.data.type ?? '?'), status: String(node.data.status ?? '-'), title: String(node.data.title ?? node.id), summary: firstParagraph(node.body), score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 20);
}
