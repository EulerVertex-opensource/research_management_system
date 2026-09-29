/**
 * Reverse relations derived from the forward fields nodes store. Nothing here
 * is written to disk, so it can never drift from `depends_on` and friends.
 */

export interface RelationNode {
  id: string;
  type: string;
  depends_on?: string[];
  uses_definitions?: string[];
  related_assets?: string[];
  target_asset?: string;
  inspired_by?: string[];
  refutes?: string;
}

export interface ReverseRelations {
  /** Assets or definitions whose `depends_on` names this node. */
  usedIn: string[];
  /** Assets whose `uses_definitions` names this definition. */
  usedBy: string[];
  /** Plans targeting this asset. */
  plans: string[];
  /** Ideas whose `related_assets` names this asset. */
  ideas: string[];
  /** Plans an idea inspired. */
  inspired: string[];
  /** Counterexamples refuting this asset. */
  refutedBy: string[];
}

const empty = (): ReverseRelations => ({ usedIn: [], usedBy: [], plans: [], ideas: [], inspired: [], refutedBy: [] });

export function reverseRelations(nodes: RelationNode[]): Map<string, ReverseRelations> {
  const index = new Map<string, ReverseRelations>();
  const add = (target: string | undefined, key: keyof ReverseRelations, source: string) => {
    if (!target) return;
    const entry = index.get(target) ?? empty();
    if (!entry[key].includes(source)) entry[key].push(source);
    index.set(target, entry);
  };
  for (const node of nodes) {
    for (const dependency of node.depends_on ?? []) add(dependency, 'usedIn', node.id);
    for (const definition of node.uses_definitions ?? []) add(definition, 'usedBy', node.id);
    for (const asset of node.related_assets ?? []) add(asset, 'ideas', node.id);
    for (const idea of node.inspired_by ?? []) add(idea, 'inspired', node.id);
    if (node.type === 'plan') add(node.target_asset, 'plans', node.id);
    add(node.refutes, 'refutedBy', node.id);
  }
  for (const entry of index.values()) for (const list of Object.values(entry) as string[][]) list.sort();
  return index;
}
