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

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const firstParagraph = (body: string) => body.replace(/^#+ .*$/gm, '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').slice(0, 200) ?? '';

/**
 * Rank library nodes against free-text words: title words count most, then
 * tags, then the statement. With no words, every node matches (a listing).
 */
export function searchLibrary(nodes: SearchableNode[], layout: NodeLayout, query: string, options: { type?: string; collection?: string; limit?: number } = {}): LibraryHit[] {
  const terms = [...new Set(words(query))];
  const hits: LibraryHit[] = [];
  for (const node of nodes) {
    const location = locateNodeFile(node.file, layout);
    if (location?.origin !== 'library') continue;
    if (options.collection && location.collection !== options.collection) continue;
    if (options.type && node.data.type !== options.type) continue;
    const title = new Set(words(String(node.data.title ?? '')));
    const tags = new Set(list(node.data.tags).flatMap(words));
    const statement = new Set(words(node.body.split(/^## Proof\b/m)[0]));
    let score = 0;
    for (const term of terms) score += (title.has(term) ? 3 : 0) + (tags.has(term) ? 2 : 0) + (statement.has(term) ? 1 : 0) + (node.id.includes(term) ? 1 : 0);
    if (terms.length && !score) continue;
    hits.push({ id: node.id, kind: location.kind, collection: location.collection, type: String(node.data.type ?? '?'), status: String(node.data.status ?? '-'), title: String(node.data.title ?? node.id), summary: firstParagraph(node.body), score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 20);
}
