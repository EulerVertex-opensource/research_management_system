import * as vscode from 'vscode';
import { ProjectPaths, ResearchNode } from '../models/types';
import { FileService } from './FileService';
import { RESEARCH_WORKFLOWS } from '../prompts/templates';

const INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
const CODEX_AGENTS_PATH = 'AGENTS.md';
const CLAUDE_INSTRUCTIONS_PATH = 'CLAUDE.md';
const GENERATED_START = '<!-- research-assistant:generated:start -->';
const GENERATED_END = '<!-- research-assistant:generated:end -->';

function formatOptional(paths: string[], fallback: string): string {
  return paths.length ? paths.map((item) => `\`${item}\``).join(', ') : fallback;
}

function sharedGuidance(paths: ProjectPaths): string {
  const macros = formatOptional(paths.macroFiles, '_none configured_');
  const notations = paths.notations ? `\`${paths.notations}\`` : '_none configured_';

  return `# Mathematical Research Workspace

This repository is an Overleaf-compatible LaTeX project and a shared Research Assistant knowledge base. Tracked manuscript and research files are the collaboration source of truth; generated agent guidance, local source PDFs, and build artifacts are not.

## Sources of truth

- \`${paths.mainTex}\`: Overleaf main document
- \`${paths.bibliography}\`: shared BibTeX bibliography
- Macros/preamble: ${macros}
- Notation reference: ${notations}
- \`${paths.projectMd}\`: research problem, goals, known results, and open questions
- \`${paths.assets}/\`: theorem, lemma, proposition, example, construction, and remark nodes
- \`${paths.definitions}/\`: primary mathematical definitions and notation
- \`${paths.ideas}/\`: freeform research ideas
- \`${paths.plans}/\`: executable proof plans and retained proof records
- \`${paths.writingOutline}\`: presentation order for the manuscript
- \`${paths.writingSections}/\`: section briefs with verified asset IDs and writing gaps
- \`${paths.sections}/\`: canonical, editable LaTeX section files
- \`${paths.paperIndex}\`: shared paper index
- \`${paths.papers}/\`: shared paper metadata and searchable working transcriptions
- \`${paths.localSourcePdfs}/\`: local-only authoritative PDFs; this path is ignored by Git

## Collaboration rules

- Treat tracked research Markdown, YAML, BibTeX, configuration, and LaTeX as shared project state. This agent guidance is regenerated locally by Research Assistant.
- Never commit source-paper PDFs or LaTeX build output unless the team explicitly changes that policy.
- Preserve a stable URL, DOI/arXiv identifier, checksum, page number, and theorem location when recording a source.
- Treat a source PDF as authoritative and its Markdown transcription as a searchable working copy.
- Check ambiguous formulas, diagrams, subscripts, superscripts, and symbols against the PDF.
- Do not rename shared files casually: Git-based Overleaf updates can detach comments and tracked-change metadata.
- Pull before editing and again before pushing; resolve conflicts locally.
- Review manuscript changes through Git. Overleaf comments and tracked changes may move when Git pushes alter their files.

## Research rules

- Ideas use \`type: idea\`, \`status: draft | archived\`, optional \`related_assets\`, and freeform prose; they need no target or checklist.
- Plans use \`type: plan\`, \`status: pending | failed\`, one \`target_asset\`, optional \`inspired_by\` idea IDs, and Goal, Plan checkboxes, and Verification. Failed means a documented mathematical obstruction, not that the asset is false.
- Create a new plan inspired by an idea instead of replacing that idea. Successful plans become status-free \`type: proof_record\` files after the proof is put in the asset.
- Keep managed asset, idea, and plan Markdown links synchronized using \`convert-proof-ideas\`. Assets list pending and failed plans, proof records, and draft and archived ideas separately.
- When asked to prove an asset, read its pending linked plans, follow and update one plan's checkboxes, and record any mathematical obstruction under Failure. Put a successful proof in the asset and then convert the plan to a proof record.
- New or materially edited assets and definitions must have \`status: draft\`. Only a researcher promotes them. New ideas start \`draft\`; new plans start \`pending\`.
- Only approved nodes should be relied on in finished manuscript arguments.
- Keep manuscript writing plans separate from proof plans. Work on one section at a time; read its brief, selected approved nodes and dependencies, relevant definitions, and the configured preamble. Do not send the whole research archive to a model.
- Preserve existing section TeX prose. Generate a missing file once; later revisions must target a passage or provide a patch.
- Sync the marked section input block in the main document from the writing outline only after previewing it with the manuscript-writing skill.
- Use exact node filenames without \`.md\` in \`depends_on\`, \`used_in\`, and \`related_assets\`.
- Assets link definition IDs in \`uses_definitions\`. Definition \`depends_on\` lists definition IDs; asset \`depends_on\` lists asset IDs.
- Extract only commonly used mathematical concepts as definitions. Put project-specific conditions and assumptions in draft remark assets, with verified relative Markdown links to relevant definitions and assets. Split mixed passages into a standard definition and a linked remark.
- After drafting or materially revising an asset, run \`check-notation\` against linked approved definitions, macros, and the notation supplement.
- After adding or changing an asset, use the \`order-assets\` skill to check dependencies and title order. The extension also reorders assets when it sees file changes.
- After adding or changing a definition, use \`order-definitions\` to check dependencies and title order. The extension also reorders definitions when it sees file changes.
- After verifying \`depends_on\` or \`uses_definitions\` links, use \`link-research-nodes\` to add relative Markdown links to prose mentions in node bodies.
- To cite a local source PDF in Markdown, link to its configured \`${paths.localSourcePdfs}/<slug>.pdf\` path relative to the Markdown file. The dashboard opens these links in VS Code's PDF viewer; the PDF remains local and ignored by Git.
- Do not invent a node or paper ID; verify it from the shared files.
- Before editing LaTeX, read every configured macro/preamble file and the notation reference when present.
- Cite manuscript use of a node with a \`% [node_id]\` comment.
- Block Markdown math must put opening and closing \`$$\` on separate lines.
- Approval is a researcher action: never set \`status: approved\` and never edit \`approvals.json\`; request approval through the research loop's \`request_approval\` tool.
- A failed proof plan is not a falsification; only a verified counterexample confirmed by the researcher refutes a statement.
- Do not change a statement while proving it; a revised statement gets a new asset ID. New plans after failures need \`## Difference from failed plans\`.
`;
}

function copilotGuidance(paths: ProjectPaths): string {
  return `# Research Assistant — shared AI context

> Generated deterministically from \`${paths.config}\`. Do not edit this file manually.

${sharedGuidance(paths)}

## Node schema

Each Markdown file in \`${paths.assets}/\`, \`${paths.definitions}/\`, \`${paths.ideas}/\`, or \`${paths.plans}/\` has YAML frontmatter followed by a Markdown body.

\`\`\`yaml
---
type: theorem | lemma | proposition | definition | example | construction | remark | idea | plan | proof_record
title: string
status: draft | approved | deprecated | archived (assets/definitions); draft | archived (ideas); pending | failed (plans); absent (proof records)
target_asset: asset_id (proof plans and proof records)
inspired_by: [idea_id, ...] (proof plans and proof records)
tags: [string, ...]
source:
  kind: paper | self_proved
  paper_id: string
  location: string
depends_on: [node_id, ...]
uses_definitions: [definition_id, ...]
used_in: [node_id, ...]
related_assets: [node_id, ...]
---
\`\`\`

Load only the relevant node files for the current task. Do not copy node bodies into this instruction file; the node files themselves are canonical and merge independently.

## Paper index

Each \`## <slug>\` section in \`${paths.paperIndex}\` may record a local ignored PDF path, a stable source URL, and a description. The slug must match the BibTeX key in \`${paths.bibliography}\`.
`;
}

function upsertGeneratedSection(existing: string, generated: string): string {
  const section = `${GENERATED_START}\n${generated.trim()}\n${GENERATED_END}`;
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + section + existing.slice(end + GENERATED_END.length);
  }
  return existing.trim() ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
}

/** Generate small, deterministic guidance; research node files remain canonical. */
export async function generateAgentInstructions(
  _nodes: ResearchNode[],
  fileService: FileService,
  paths: ProjectPaths
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(fileService.resolve('.github'));
  } catch { /* already exists */ }

  const skillList = Object.entries(RESEARCH_WORKFLOWS)
    .map(([id, workflow]) => `- \`${id.replace(/_/g, '-')}\`: ${workflow.purpose}`)
    .concat('- `order-assets`: Validate dependencies and number draft and approved asset titles.')
    .concat('- `order-definitions`: Validate dependencies and number draft and approved definition titles.')
    .concat('- `extract-definitions`: Extract and migrate definitions, and link assets to them.')
    .concat('- `link-research-nodes`: Link verified asset and definition mentions in Markdown bodies.')
    .concat('- `convert-proof-ideas`: Classify legacy ideas and plans, migrate plans to their own folder, and synchronize Markdown links.')
    .concat('- `plan-manuscript`: Agree on presentation order and write the shared outline and section briefs.')
    .concat('- `manuscript-writing`: Validate section sources, create missing TeX sections, and preview/apply input order.')
    .concat('- `research-loop`: Drive the human-in-the-loop research loop from the chat (goals, project.md, scaffold, sources, falsify, plan, prove, researcher approval).')
    .concat('- `falsify-asset`: Search for and independently verify a counterexample to one draft result.')
    .concat('- `prove-asset`: Write and execute one proof plan for a draft result; convert success into a proof record.')
    .join('\n');
  const agentsContent = `${sharedGuidance(paths)}

## Available skills

${skillList}

For importing or transcribing a paper, use the \`import-math-paper\` skill. Bundled skills are registered for Codex under \`.agents/skills/\` and for Claude Code under \`.claude/skills/\`.
`;

  const existingAgents = await fileService.readFile(CODEX_AGENTS_PATH).catch(() => '');
  const existingClaude = await fileService.readFile(CLAUDE_INSTRUCTIONS_PATH).catch(() => '');
  await Promise.all([
    fileService.writeFile(INSTRUCTIONS_PATH, copilotGuidance(paths)),
    fileService.writeFile(CODEX_AGENTS_PATH, upsertGeneratedSection(existingAgents, agentsContent)),
    fileService.writeFile(CLAUDE_INSTRUCTIONS_PATH, upsertGeneratedSection(existingClaude, agentsContent)),
  ]);
}
