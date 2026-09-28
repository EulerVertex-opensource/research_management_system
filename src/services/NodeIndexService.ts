import * as path from 'path';
import matter from 'gray-matter';
import { ResearchNode, NodeType, ResearchStatus, NodeFrontmatter, ProjectPaths } from '../models/types';
import { FileService } from './FileService';
import { hasSectionContent, resolveIdeaType } from './ProofIdeas';

const NODE_TEMPLATES: Record<string, string> = {
  theorem: `---
type: theorem
title: {title}
status: draft
source:
  kind: paper
  paper_id: ""
  location: ""
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Write the theorem statement here.
`,
  lemma: `---
type: lemma
title: {title}
status: draft
source:
  kind: paper
  paper_id: ""
  location: ""
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Write the lemma statement here.
`,
  proposition: `---
type: proposition
title: {title}
status: draft
source:
  kind: paper
  paper_id: ""
  location: ""
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Write the proposition statement here.
`,
  definition: `---
type: definition
title: "Definition ({title})"
status: draft
source:
  kind: self_proved
depends_on: []
tags: []
---

Write the defining statement and the notation it introduces here.
`,
  example: `---
type: example
title: {title}
status: draft
source:
  kind: self_proved
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Describe the example here.
`,
  construction: `---
type: construction
title: {title}
status: draft
source:
  kind: self_proved
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Describe the construction here.
`,
  remark: `---
type: remark
title: {title}
status: draft
depends_on: []
uses_definitions: []
tags: []
used_in: []
---

Write the remark here.
`,
  plan: `---
type: plan
title: {title}
status: pending
target_asset: {target_asset}
inspired_by: []
tags: []
---

## Goal

Target: [asset]({target_link})

Prove the claim stated in the target asset.

## Plan

1. [ ] Describe the first mathematical step.

## Verification

Explain how to check that the steps prove the asset's statement.
`,
  idea: `---
type: idea
title: {title}
status: draft
related_assets: []
tags: []
---

Describe the intuition, possible approach, open gap, or test case here.
`,
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 64);
}

const ASSET_TYPES = new Set<NodeType>(['theorem', 'lemma', 'proposition', 'example', 'construction', 'remark']);

function parseNode(relativePath: string, raw: string): ResearchNode | null {
  try {
    const { data, content } = matter(raw);
    const id = path.basename(relativePath, '.md');
    return {
      id,
      filePath: relativePath,
      type: (resolveIdeaType(data) as NodeType | undefined) ?? (data.type as NodeType) ?? 'remark',
      title: data.title ?? id,
      status: data.type === 'proof_record' ? undefined : (data.status as ResearchStatus) ?? (resolveIdeaType(data) === 'plan' ? 'pending' : 'draft'),
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: data.source,
      depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
      uses_definitions: Array.isArray(data.uses_definitions) ? data.uses_definitions : [],
      used_in: Array.isArray(data.used_in) ? data.used_in : [],
      related_assets: Array.isArray(data.related_assets) ? data.related_assets : [],
      target_asset: typeof data.target_asset === 'string' ? data.target_asset : undefined,
      inspired_by: Array.isArray(data.inspired_by) ? data.inspired_by : [],
      refutes: typeof data.refutes === 'string' ? data.refutes : undefined,
      body: content.trim(),
    };
  } catch {
    return null;
  }
}

export class NodeIndexService {
  private nodes: Map<string, ResearchNode> = new Map();

  constructor(
    private readonly fileService: FileService,
    private readonly paths: ProjectPaths
  ) {}

  async refresh(): Promise<ResearchNode[]> {
    this.nodes.clear();

    const assetPaths = await this.fileService.listFiles(this.paths.assets, '.md');
    const definitionPaths = await this.fileService.listFiles(this.paths.definitions, '.md');
    const ideaPaths = await this.fileService.listFiles(this.paths.ideas, '.md');
    const planPaths = await this.fileService.listFiles(this.paths.plans, '.md');

    for (const filePath of [...assetPaths, ...definitionPaths, ...ideaPaths, ...planPaths]) {
      try {
        const raw = await this.fileService.readFile(filePath);
        const node = parseNode(filePath, raw);
        if (node) {
          this.nodes.set(node.id, node);
        }
      } catch {
        // skip unreadable files
      }
    }

    return Array.from(this.nodes.values());
  }

  getAll(): ResearchNode[] {
    return Array.from(this.nodes.values());
  }

  getById(id: string): ResearchNode | undefined {
    return this.nodes.get(id);
  }

  async createNode(nodeType: NodeType, title: string, targetAsset?: string): Promise<ResearchNode> {
    if (nodeType === 'proof_record') throw new Error('Proof records are created by converting successful plans.');
    const concept = nodeType === 'definition' ? title.replace(/^Definition \((.*)\)$/, '$1') : title;
    const slug = slugify(concept) || 'untitled';
    const folder = nodeType === 'idea' ? this.paths.ideas : nodeType === 'plan' ? this.paths.plans : nodeType === 'definition' ? this.paths.definitions : this.paths.assets;
    const filename = `${slug}.md`;
    const relativePath = `${folder}/${filename}`;
    if (this.nodes.has(slug) || await this.fileService.exists(relativePath)) {
      throw new Error(`Node ID already exists: ${slug}`);
    }

    if (nodeType === 'plan' && (!targetAsset || !this.isTargetAsset(targetAsset))) {
      throw new Error('Choose an existing target asset for the proof plan.');
    }
    const template = NODE_TEMPLATES[nodeType] ?? NODE_TEMPLATES.remark;
    const targetLink = targetAsset ? path.posix.relative(path.posix.dirname(relativePath), `${this.paths.assets}/${targetAsset}.md`) : '';
    const content = nodeType === 'definition'
      ? template.replace('"Definition ({title})"', JSON.stringify(`Definition (${concept})`))
      : template.replace('{title}', concept).replace(/\{target_link\}/g, targetLink.startsWith('.') ? targetLink : `./${targetLink}`).replace(/\{target_asset\}/g, targetAsset ?? '');

    await this.fileService.writeFile(relativePath, content);

    // Re-parse and index the new node
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
    const parsed = matter(raw);

    if (node.type === 'proof_record') throw new Error('Proof records have no status.');
    if (node.type === 'idea' ? !['draft', 'archived'].includes(status) : node.type === 'plan' ? !['pending', 'failed'].includes(status) : !['draft', 'approved', 'deprecated', 'archived'].includes(status)) {
      throw new Error(`Invalid status ${status} for ${node.type}.`);
    }
    if (node.type === 'plan' && status === 'failed' && !hasSectionContent(parsed.content, 'Failure')) {
      throw new Error('Failed plans need a Failure explanation.');
    }
    parsed.data.status = status;

    // Rebuild the file: stringify frontmatter + preserve body
    const updated = matter.stringify(parsed.content, parsed.data);
    await this.fileService.writeFile(node.filePath, updated);

    node.status = status;
  }

  async getNodeDetail(id: string): Promise<{ frontmatter: NodeFrontmatter; body: string }> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }
    const raw = await this.fileService.readFile(node.filePath);
    const { data, content } = matter(raw);
    return {
      frontmatter: {
        type: node.type,
        title: data.title ?? node.title,
        status: data.type === 'proof_record' ? undefined : (data.status as ResearchStatus) ?? node.status,
        tags: Array.isArray(data.tags) ? data.tags : [],
        source: data.source,
        depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
        uses_definitions: Array.isArray(data.uses_definitions) ? data.uses_definitions : [],
        used_in: Array.isArray(data.used_in) ? data.used_in : [],
        related_assets: Array.isArray(data.related_assets) ? data.related_assets : [],
        target_asset: typeof data.target_asset === 'string' ? data.target_asset : undefined,
        inspired_by: Array.isArray(data.inspired_by) ? data.inspired_by : [],
        refutes: typeof data.refutes === 'string' ? data.refutes : undefined,
      },
      body: content.trim(),
    };
  }

  async saveNode(id: string, frontmatter: NodeFrontmatter, body: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }
    // matter.stringify(body, data) → produces "---\n<yaml>\n---\n<body>"
    const data: Record<string, unknown> = { ...frontmatter };
    delete data.kind;
    if (frontmatter.type === 'idea') {
      if (!['draft', 'archived'].includes(frontmatter.status ?? '')) throw new Error('Idea status must be draft or archived.');
      delete data.target_asset;
      delete data.inspired_by;
      delete data.refutes;
      delete data.depends_on;
      delete data.uses_definitions;
      delete data.used_in;
    } else if (frontmatter.type === 'plan' || frontmatter.type === 'proof_record') {
      if (!frontmatter.target_asset || !this.isTargetAsset(frontmatter.target_asset)) {
        throw new Error('Choose an existing target asset.');
      }
      if (frontmatter.type === 'plan' && !['pending', 'failed'].includes(frontmatter.status ?? '')) throw new Error('Proof plan status must be pending or failed.');
      if (frontmatter.type === 'plan' && frontmatter.status === 'failed' && !hasSectionContent(body, 'Failure')) {
        throw new Error('Failed plans need a Failure explanation.');
      }
      if (node.type !== 'proof_record' && frontmatter.type === 'proof_record' && !hasSectionContent(body, 'Outcome')) {
        throw new Error('Proof records need an Outcome section explaining where the proof was incorporated.');
      }
      const targetPath = path.posix.relative(path.posix.dirname(node.filePath), `${this.paths.assets}/${frontmatter.target_asset}.md`);
      const targetLine = `Target: [asset](${targetPath.startsWith('.') ? targetPath : `./${targetPath}`})`;
      if (/^Target: \[asset\]\([^)]+\)$/m.test(body)) body = body.replace(/^Target: \[asset\]\([^)]+\)$/m, targetLine);
      else body = body.replace(/^## Goal\s*$/m, `## Goal\n\n${targetLine}`);
      if (!body.includes(targetLine)) body = `${targetLine}\n\n${body}`;
      if (frontmatter.type === 'proof_record') delete data.status;
      delete data.related_assets;
      delete data.depends_on;
      delete data.uses_definitions;
      delete data.used_in;
    } else {
      delete data.target_asset;
      delete data.kind;
      delete data.inspired_by;
      if (frontmatter.type !== 'example') delete data.refutes;
      if (frontmatter.type === 'example' && frontmatter.refutes) {
        if (!this.isTargetAsset(frontmatter.refutes)) throw new Error('Counterexample must refute an existing asset.');
        if (!/^## Assumptions\s*$/m.test(body) || !/^## Calculation\s*$/m.test(body)) throw new Error('Counterexample needs Assumptions and Calculation sections.');
      }
    }
    if (frontmatter.type === 'definition') {
      delete data.uses_definitions;
      delete data.used_in;
      delete data.related_assets;
    }
    for (const [key, value] of Object.entries(data)) if (value === undefined) delete data[key];
    const fileContent = matter.stringify(
      '\n' + body,
      data
    );
    await this.fileService.writeFile(node.filePath, fileContent);
  }

  private isTargetAsset(id: string): boolean {
    const node = this.nodes.get(id);
    return Boolean(node && node.filePath.startsWith(`${this.paths.assets}/`) && ASSET_TYPES.has(node.type));
  }
}
