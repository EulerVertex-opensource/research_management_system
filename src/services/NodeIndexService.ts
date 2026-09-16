import * as path from 'path';
import matter from 'gray-matter';
import { ResearchNode, NodeType, NodeStatus, NodeFrontmatter, ProjectPaths } from '../models/types';
import { FileService } from './FileService';

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
tags: []
used_in: []
---

Write the proposition statement here.
`,
  definition: `---
type: definition
title: {title}
status: draft
source:
  kind: paper
  paper_id: ""
  location: ""
depends_on: []
tags: []
used_in: []
---

Write the definition here.
`,
  example: `---
type: example
title: {title}
status: draft
source:
  kind: self_proved
depends_on: []
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
tags: []
used_in: []
---

Write the remark here.
`,
  idea: `---
type: idea
title: {title}
status: draft
related_assets: []
tags: []
---

Describe the idea here.

Possible strategy:
1. ...
`,
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 64);
}

function parseNode(relativePath: string, raw: string): ResearchNode | null {
  try {
    const { data, content } = matter(raw);
    const id = path.basename(relativePath, '.md');
    return {
      id,
      filePath: relativePath,
      type: (data.type as NodeType) ?? 'remark',
      title: data.title ?? id,
      status: (data.status as NodeStatus) ?? 'draft',
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: data.source,
      depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
      used_in: Array.isArray(data.used_in) ? data.used_in : [],
      related_assets: Array.isArray(data.related_assets) ? data.related_assets : [],
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
    const ideaPaths = await this.fileService.listFiles(this.paths.ideas, '.md');

    for (const filePath of [...assetPaths, ...ideaPaths]) {
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

  async createNode(nodeType: NodeType, title: string): Promise<ResearchNode> {
    const slug = slugify(title) || 'untitled';
    const folder = nodeType === 'idea' ? this.paths.ideas : this.paths.assets;
    const filename = `${slug}.md`;
    const relativePath = `${folder}/${filename}`;

    const template = NODE_TEMPLATES[nodeType] ?? NODE_TEMPLATES.remark;
    const content = template.replace('{title}', title);

    await this.fileService.writeFile(relativePath, content);

    // Re-parse and index the new node
    const node = parseNode(relativePath, content)!;
    this.nodes.set(node.id, node);
    return node;
  }

  async updateStatus(id: string, status: NodeStatus): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const raw = await this.fileService.readFile(node.filePath);
    const parsed = matter(raw);

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
        type: (data.type as NodeType) ?? node.type,
        title: data.title ?? node.title,
        status: (data.status as NodeStatus) ?? node.status,
        tags: Array.isArray(data.tags) ? data.tags : [],
        source: data.source,
        depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
        used_in: Array.isArray(data.used_in) ? data.used_in : [],
        related_assets: Array.isArray(data.related_assets) ? data.related_assets : [],
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
    const fileContent = matter.stringify(
      '\n' + body,
      frontmatter as unknown as Record<string, unknown>
    );
    await this.fileService.writeFile(node.filePath, fileContent);
  }
}
