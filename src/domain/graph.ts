import { requiredAssetIds } from './project';
import type { AssetComponent } from './digests';

/**
 * One typed graph over the project, the research nodes, and the manuscript
 * sections, derived on demand from the files that own each relation (never
 * stored). Mathematical edges carry approval invalidation; workflow edges do
 * not; manuscript edges say which component of a node a section presents.
 * Presentation order is not an edge: it is the outline's section order.
 */

export type GraphNodeKind = 'project' | 'asset' | 'definition' | 'idea' | 'plan' | 'section';

export const MATH_EDGES = ['requires', 'depends_on', 'uses_definition', 'refutes'] as const;
export const WORKFLOW_EDGES = ['targets', 'inspired_by', 'relates_to'] as const;
export const MANUSCRIPT_EDGES = ['presents'] as const;
export type EdgeType = typeof MATH_EDGES[number] | typeof WORKFLOW_EDGES[number] | typeof MANUSCRIPT_EDGES[number];

export interface GraphNode { key: string; kind: GraphNodeKind; id: string }
export interface GraphEdge { from: string; to: string; type: EdgeType; role?: string; components?: AssetComponent[] }

/** A research node as the graph reads it: its folder kind and frontmatter. */
export interface GraphInputNode { id: string; kind: 'asset' | 'definition' | 'idea' | 'plan'; data: Record<string, any> }
/** A manuscript section and the nodes its brief presents. */
export interface GraphInputSection { id: string; sources: { id: string; role?: string; uses: AssetComponent[] }[] }

export const nodeKey = (kind: GraphNodeKind, id: string) => `${kind}:${id}`;

export class TypedGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  addNode(kind: GraphNodeKind, id: string): string {
    const key = nodeKey(kind, id);
    if (!this.nodes.has(key)) this.nodes.set(key, { key, kind, id });
    return key;
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    this.outgoing.set(edge.from, [...(this.outgoing.get(edge.from) ?? []), edge]);
    this.incoming.set(edge.to, [...(this.incoming.get(edge.to) ?? []), edge]);
  }

  out(key: string, types?: readonly EdgeType[]): GraphEdge[] {
    return (this.outgoing.get(key) ?? []).filter((edge) => !types || types.includes(edge.type));
  }

  in(key: string, types?: readonly EdgeType[]): GraphEdge[] {
    return (this.incoming.get(key) ?? []).filter((edge) => !types || types.includes(edge.type));
  }

  /** Everything reachable from `keys` along `types`, starting keys excluded, in first-visit order. */
  reachable(keys: string[], types: readonly EdgeType[], direction: 'out' | 'in' = 'out'): string[] {
    const seen = new Set(keys);
    const order: string[] = [];
    const queue = [...keys];
    while (queue.length) {
      const key = queue.shift()!;
      for (const edge of direction === 'out' ? this.out(key, types) : this.in(key, types)) {
        const next = direction === 'out' ? edge.to : edge.from;
        if (seen.has(next)) continue;
        seen.add(next); order.push(next); queue.push(next);
      }
    }
    return order;
  }
}

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * Build the graph. A reference resolves to whatever node holds that ID (IDs are
 * global across research folders); an unknown ID becomes an asset placeholder
 * so a dangling reference is still visible to callers.
 */
export function buildGraph(input: { project?: string; nodes: GraphInputNode[]; sections?: GraphInputSection[] }): TypedGraph {
  const graph = new TypedGraph();
  const kindOf = new Map(input.nodes.map((node) => [node.id, node.kind]));
  const ref = (id: string) => graph.addNode(kindOf.get(id) ?? 'asset', id);
  for (const node of input.nodes) graph.addNode(node.kind, node.id);
  if (input.project !== undefined) {
    const project = graph.addNode('project', 'project');
    for (const id of requiredAssetIds(input.project)) graph.addEdge({ from: project, to: ref(id), type: 'requires' });
  }
  for (const node of input.nodes) {
    const from = nodeKey(node.kind, node.id);
    const { data } = node;
    if (node.kind === 'asset' || node.kind === 'definition') {
      for (const id of ids(data.depends_on)) graph.addEdge({ from, to: ref(id), type: 'depends_on' });
    }
    if (node.kind === 'asset') {
      for (const id of ids(data.uses_definitions)) graph.addEdge({ from, to: ref(id), type: 'uses_definition' });
      if (typeof data.refutes === 'string') graph.addEdge({ from, to: ref(data.refutes), type: 'refutes' });
    }
    if (node.kind === 'plan') {
      if (typeof data.target_asset === 'string') graph.addEdge({ from, to: ref(data.target_asset), type: 'targets' });
      for (const id of ids(data.inspired_by)) graph.addEdge({ from, to: ref(id), type: 'inspired_by' });
    }
    if (node.kind === 'idea') for (const id of ids(data.related_assets)) graph.addEdge({ from, to: ref(id), type: 'relates_to' });
  }
  for (const section of input.sections ?? []) {
    const from = graph.addNode('section', section.id);
    for (const source of section.sources) graph.addEdge({ from, to: ref(source.id), type: 'presents', role: source.role, components: source.uses });
  }
  return graph;
}
