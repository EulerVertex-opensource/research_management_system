import * as path from 'path';
import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { ResearchNode, NodeType, ResearchStatus, NodeFrontmatter, ProjectPaths } from '../models/types';
import { FileService } from './FileService';
import { resolveIdeaType } from './ProofIdeas';
import { computeAssetOrder } from './AssetOrder';
import { proofDigest } from './ResearchLoopModel';
import { ASSET_TYPES, NodeKind, nodeKindOf, statusesFor } from '../domain/nodeKinds';
import { nodeProblems, planProblems, stripForeignFields } from '../domain/schema';
import { nodeTemplate } from '../domain/templates';
import { libraryFolders, libraryProblems, locateNodeFile } from '../domain/registry';
import { layoutReport } from '../domain/layout';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 64);
}

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Frontmatter as the dashboard edits it. A legacy proof_record reads as a succeeded plan until migrated. */
function frontmatterOf(data: Record<string, any>): NodeFrontmatter {
  const legacyRecord = data.type === 'proof_record';
  const role = resolveIdeaType(data);
  const type = (legacyRecord ? 'plan' : role ?? data.type ?? 'remark') as NodeType;
  return {
    type,
    title: typeof data.title === 'string' ? data.title : '',
    status: legacyRecord ? 'succeeded' : (data.status as ResearchStatus) ?? (type === 'plan' ? 'pending' : 'draft'),
    tags: list(data.tags),
    source: data.source,
    depends_on: list(data.depends_on),
    uses_definitions: list(data.uses_definitions),
    related_assets: list(data.related_assets),
    target_asset: typeof data.target_asset === 'string' ? data.target_asset : undefined,
    inspired_by: list(data.inspired_by),
    refutes: typeof data.refutes === 'string' ? data.refutes : undefined,
    idea_kind: typeof data.idea_kind === 'string' ? data.idea_kind as NodeFrontmatter['idea_kind'] : undefined,
  };
}

function parseNode(relativePath: string, raw: string): ResearchNode | null {
  try {
    const { data, content } = parseMarkdown(raw);
    const id = path.basename(relativePath, '.md');
    const frontmatter = frontmatterOf(data);
    return { ...frontmatter, title: frontmatter.title || id, id, filePath: relativePath, body: content.trim() };
  } catch {
    return null;
  }
}

export class NodeIndexService {
  private nodes: Map<string, ResearchNode> = new Map();
  /** Duplicate IDs and dependency errors found by the last refresh. */
  private problems: string[] = [];

  constructor(
    private readonly fileService: FileService,
    private readonly paths: ProjectPaths
  ) {}

  async refresh(): Promise<ResearchNode[]> {
    this.nodes.clear();
    this.problems = [];

    const folders = [this.paths.assets, this.paths.definitions, this.paths.ideas, this.paths.plans, ...await libraryFolders(this.fileService, this.paths)];
    const raws = new Map<string, string>();
    for (const folder of folders) {
      for (const filePath of await this.fileService.listFiles(folder, '.md')) {
        try {
          const raw = await this.fileService.readFile(filePath);
          const node = parseNode(filePath, raw);
          if (!node) continue;
          const location = locateNodeFile(filePath, this.paths);
          if (location?.origin === 'library') { node.origin = 'library'; node.collection = location.collection; }
          const existing = this.nodes.get(node.id);
          if (existing) {
            this.problems.push(`${filePath}: node ID ${node.id} is already used by ${existing.filePath}; IDs are global across research folders.`);
            continue;
          }
          this.nodes.set(node.id, node);
          raws.set(filePath, raw);
        } catch {
          // skip unreadable files
        }
      }
    }
    // A succeeded plan is outdated once its target's proof no longer matches the digest stamped on success.
    for (const node of this.nodes.values()) {
      if (node.type !== 'plan' || node.status !== 'succeeded') continue;
      const stamped = parseMarkdown(raws.get(node.filePath)!).data.proof_digest;
      const target = node.target_asset ? this.nodes.get(node.target_asset) : undefined;
      if (typeof stamped === 'string' && target) node.outdated = proofDigest(raws.get(target.filePath)!) !== stamped;
    }
    this.problems.push(...(await layoutReport(this.fileService, this.paths)).problems);
    this.problems.push(...libraryProblems([...this.nodes.values()].map((node) => ({ id: node.id, file: node.filePath, data: node })), this.paths));
    for (const kind of ['asset', 'definition'] as const) {
      // Project and library nodes are ordered together, so a project result may depend on a library one.
      const inputs = [...this.nodes.values()].filter((node) => locateNodeFile(node.filePath, this.paths)?.kind === kind).map((node) => ({ id: node.id, raw: raws.get(node.filePath)! }));
      try {
        computeAssetOrder(inputs, kind).order.forEach((id, index) => { this.nodes.get(id)!.order = index + 1; });
      } catch (error: unknown) {
        this.problems.push(`${kind === 'asset' ? 'Asset' : 'Definition'} order: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return Array.from(this.nodes.values());
  }

  getAll(): ResearchNode[] {
    return Array.from(this.nodes.values());
  }

  getProblems(): string[] {
    return [...this.problems];
  }

  getById(id: string): ResearchNode | undefined {
    return this.nodes.get(id);
  }

  async createNode(nodeType: NodeType, title: string, targetAsset?: string): Promise<ResearchNode> {
    const kind = nodeKindOf(nodeType) ?? 'asset';
    const concept = nodeType === 'definition' ? title.replace(/^Definition \((.*)\)$/, '$1') : title;
    const slug = slugify(concept) || 'untitled';
    const relativePath = `${this.folderOf(kind)}/${slug}.md`;
    if (this.nodes.has(slug) || await this.fileService.exists(relativePath)) {
      throw new Error(`Node ID already exists: ${slug}`);
    }

    if (nodeType === 'plan' && (!targetAsset || !this.isTargetAsset(targetAsset))) {
      throw new Error('Choose an existing target asset for the proof plan.');
    }
    const targetLink = targetAsset ? path.posix.relative(path.posix.dirname(relativePath), `${this.paths.assets}/${targetAsset}.md`) : '';
    const content = nodeTemplate(nodeType, {
      title: nodeType === 'definition' ? `Definition (${concept})` : concept,
      targetAsset,
      targetLink: targetLink.startsWith('.') ? targetLink : `./${targetLink}`,
    });

    await this.fileService.writeFile(relativePath, content);

    const node = parseNode(relativePath, content)!;
    this.nodes.set(node.id, node);
    return node;
  }

  async updateStatus(id: string, status: ResearchStatus): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const raw = await this.fileService.readFile(node.filePath);
    const parsed = parseMarkdown(raw);

    if (!statusesFor(node.type).includes(status)) throw new Error(`Invalid status ${status} for ${node.type}.`);
    if (node.type === 'plan') {
      const problem = planProblems(id, { ...parsed.data, type: 'plan', status }, parsed.content)[0];
      if (problem) throw new Error(problem);
      parsed.data.type = 'plan';
    }
    parsed.data.status = status;

    await this.fileService.writeFile(node.filePath, stringifyMarkdown(parsed.content, parsed.data));
    node.status = status;
  }

  async getNodeDetail(id: string): Promise<{ frontmatter: NodeFrontmatter; body: string }> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }
    const raw = await this.fileService.readFile(node.filePath);
    const { data, content } = parseMarkdown(raw);
    const frontmatter = frontmatterOf(data);
    return { frontmatter: { ...frontmatter, title: frontmatter.title || node.title }, body: content.trim() };
  }

  async saveNode(id: string, frontmatter: NodeFrontmatter, body: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }
    const kind = nodeKindOf(frontmatter.type);
    if (!kind) throw new Error(`Unknown node type: ${frontmatter.type}`);
    // Keep fields the dashboard does not edit (origin, custom metadata), drop relations foreign to the kind.
    const existing = parseMarkdown(await this.fileService.readFile(node.filePath)).data;
    const data = stripForeignFields(kind, { ...existing, ...frontmatter }, frontmatter.type);
    if (kind === 'plan') {
      if (!frontmatter.target_asset || !this.isTargetAsset(frontmatter.target_asset)) throw new Error('Choose an existing target asset.');
      const targetPath = path.posix.relative(path.posix.dirname(node.filePath), `${this.paths.assets}/${frontmatter.target_asset}.md`);
      const targetLine = `Target: [asset](${targetPath.startsWith('.') ? targetPath : `./${targetPath}`})`;
      if (/^Target: \[asset\]\([^)]+\)$/m.test(body)) body = body.replace(/^Target: \[asset\]\([^)]+\)$/m, targetLine);
      else body = body.replace(/^## Goal\s*$/m, `## Goal\n\n${targetLine}`);
      if (!body.includes(targetLine)) body = `${targetLine}\n\n${body}`;
    }
    if (frontmatter.type === 'example' && frontmatter.refutes && !this.isTargetAsset(frontmatter.refutes)) throw new Error('Counterexample must refute an existing asset.');
    for (const [key, value] of Object.entries(data)) if (value === undefined) delete data[key];
    const problem = nodeProblems(kind, id, data, body, { allowApproved: true })[0];
    if (problem) throw new Error(problem);
    await this.fileService.writeFile(node.filePath, stringifyMarkdown('\n' + body, data));
  }

  private folderOf(kind: NodeKind): string {
    return kind === 'idea' ? this.paths.ideas : kind === 'plan' ? this.paths.plans : kind === 'definition' ? this.paths.definitions : this.paths.assets;
  }

  private isTargetAsset(id: string): boolean {
    const node = this.nodes.get(id);
    return Boolean(node && node.filePath.startsWith(`${this.paths.assets}/`) && ASSET_TYPES.has(node.type));
  }
}
