import { parseMarkdown } from '../services/Frontmatter';
import { sectionContent } from './sections';
import type { ProjectSummary, ResearchNode } from '../models/types';

/**
 * project.md is the research contract: why the work is done and when it is
 * complete. Required results live in frontmatter, the one machine-read list.
 * Known results, open questions (question ideas), decisions (decision records),
 * and writing status are derived from their own files and shown by the
 * dashboard instead of being restated here. Scope decisions belong in
 * Scope and Assumptions.
 */

/** `owner`: the collaborator (git email) who commits routes into this result and approves it; anyone when unset. */
export interface RequiredResult { id: string; role?: string; owner?: string }

/** Body sections of a schema-2 project. */
export const PROJECT_SECTIONS = ['Main Problem', 'Scope and Assumptions', 'Intended Contribution', 'Background'] as const;
/** Sections the researcher approves together with `required_results`; the others are context. */
export const APPROVED_PROJECT_SECTIONS = ['Main Problem', 'Scope and Assumptions', 'Intended Contribution'] as const;
/** Schema-1 sections folded into the approval digest. */
const LEGACY_APPROVED_SECTIONS = ['Main Problem', 'Current Goals', 'Required Results'] as const;

export const PROJECT_TEMPLATE = `---
type: project
schema_version: 2
# One entry per result the project must establish; the loop is ready when all are approved.
# required_results:
#   - id: main_theorem
#     role: central contribution
required_results: []
---

# Project

## Main Problem

## Scope and Assumptions

## Intended Contribution

## Background
`;

const ID = /^[a-z][a-z0-9_]*$/;

/** True for a project.md written before schema 2 (no `type: project` frontmatter). */
export function isLegacyProject(raw: string): boolean {
  try { return parseMarkdown(raw).data.type !== 'project'; } catch { return true; }
}

export function requiredResults(raw: string): RequiredResult[] {
  let data: Record<string, unknown>;
  let content: string;
  try { ({ data, content } = parseMarkdown(raw)); } catch { return []; }
  if (data.type === 'project') {
    const list = Array.isArray(data.required_results) ? data.required_results : [];
    const results = list.flatMap((item): RequiredResult[] => {
      if (typeof item === 'string') return ID.test(item) ? [{ id: item }] : [];
      if (item && typeof item === 'object' && typeof (item as RequiredResult).id === 'string' && ID.test((item as RequiredResult).id)) {
        const role = (item as RequiredResult).role;
        const owner = (item as RequiredResult).owner;
        return [{ id: (item as RequiredResult).id, ...(typeof role === 'string' && role.trim() ? { role: role.trim() } : {}), ...(typeof owner === 'string' && owner.trim() ? { owner: owner.trim() } : {}) }];
      }
      return [];
    });
    return results.filter((item, index) => results.findIndex((other) => other.id === item.id) === index);
  }
  return legacyRequiredResults(content);
}

export function requiredAssetIds(raw: string): string[] {
  return requiredResults(raw).map((item) => item.id);
}

/** Schema-1 `## Required Results` bullets: `- id: role`. Read only for projects not yet migrated. */
export function legacyRequiredResults(content: string): RequiredResult[] {
  const section = sectionContent(content, 'Required Results');
  const results: RequiredResult[] = [];
  for (const match of section.matchAll(/^[ \t]*-[ \t]*(?:\[[ xX]\][ \t]*)?`?([a-z][a-z0-9_]*)`?(?=[ \t]|:|$)[ \t]*:?[ \t]*(.*)$/gm)) {
    if (!results.some((item) => item.id === match[1])) results.push({ id: match[1], ...(match[2]?.trim() ? { role: match[2].trim() } : {}) });
  }
  return results;
}

export function projectSection(raw: string, heading: string): string {
  let content = raw;
  try { content = parseMarkdown(raw).content; } catch { /* treat as plain Markdown */ }
  return sectionContent(content, heading);
}

/** The text a project approval covers, before normalization and hashing. */
export function approvedProjectParts(raw: string, schema: 1 | 2 = isLegacyProject(raw) ? 1 : 2): string[] {
  if (schema === 1) return LEGACY_APPROVED_SECTIONS.map((heading) => sectionContent(raw, heading));
  const required = requiredResults(raw).map((item) => (item.role ? `${item.id}: ${item.role}` : item.id)).join('\n');
  return [...APPROVED_PROJECT_SECTIONS.map((heading) => projectSection(raw, heading)), required];
}

/** Derived project status for the dashboard; replaces the schema-1 Known Results and Writing Status sections. */
export function summarizeProject(raw: string, nodes: ResearchNode[], writingSections: string[]): ProjectSummary {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const assets = nodes.filter((node) => node.type !== 'definition' && node.type !== 'idea' && node.type !== 'plan');
  return {
    legacy: Boolean(raw.trim()) && isLegacyProject(raw),
    required: requiredResults(raw).map((item) => ({ ...item, title: byId.get(item.id)?.title, status: byId.get(item.id)?.status })),
    assets: { approved: assets.filter((node) => node.status === 'approved').length, draft: assets.filter((node) => node.status === 'draft').length },
    openQuestions: nodes
      .filter((node) => node.type === 'idea' && node.status === 'draft' && (node.idea_kind === 'question' || node.tags.includes('open-question')))
      .map((node) => ({ id: node.id, title: node.title })),
    writingSections,
  };
}
