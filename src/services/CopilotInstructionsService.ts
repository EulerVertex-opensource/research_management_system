import * as vscode from 'vscode';
import { ProjectPaths, ResearchNode } from '../models/types';
import { FileService } from './FileService';
import { claudeMdForAgentsMd, upsertGeneratedSection } from '../domain/agentInstructions';
import { ASSET_TYPE_LIST, IDEA_KIND_LIST, IDEA_STATUS_LIST, NODE_STATUS_LIST, NODE_TYPE_LIST, PLAN_STATUS_LIST, SOURCE_KIND_LIST } from '../domain/nodeKinds';

const MAINTENANCE = 'node .agents/skills/research-maintenance/scripts/research-maintenance.cjs';
const alternatives = (values: readonly string[]) => values.join(' | ');

const INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
const CODEX_AGENTS_PATH = 'AGENTS.md';
const CLAUDE_INSTRUCTIONS_PATH = 'CLAUDE.md';

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
- \`${paths.projectMd}\`: the research contract: main problem, scope, intended contribution, and \`required_results\`
- \`${paths.assets}/\`: ${ASSET_TYPE_LIST.join(', ')} nodes
- \`${paths.definitions}/\`: primary mathematical definitions and notation
- \`${paths.ideas}/\`: freeform research ideas
- \`${paths.plans}/\`: proof plans, one per attempt, kept whether they succeed or fail
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

- Ideas use \`type: idea\`, \`status: ${alternatives(IDEA_STATUS_LIST)}\`, \`idea_kind: ${alternatives(IDEA_KIND_LIST)}\`, optional \`related_assets\`, and freeform prose; they need no target or checklist.
- Plans use \`type: plan\`, \`status: ${alternatives(PLAN_STATUS_LIST)}\`, one \`target_asset\`, optional \`inspired_by\` idea IDs, and Goal, Plan checkboxes, and Verification. Failed means a documented mathematical obstruction under \`## Failure\`, not that the asset is false. Succeeded means the proof is in the asset and \`## Outcome\` says where.
- Create a new plan inspired by an idea instead of replacing that idea.
- When asked to prove an asset, read its pending linked plans, follow and update one plan's checkboxes, and record any mathematical obstruction under Failure. Put a successful proof in the asset, then set the plan status to succeeded with an Outcome.
- New or materially edited assets and definitions must have \`status: draft\`. Only a researcher promotes them. New ideas start \`draft\`; new plans start \`pending\`.
- Only approved nodes should be relied on in finished manuscript arguments.
- Keep manuscript writing plans separate from proof plans. Work on one section at a time; read its brief, selected approved nodes and dependencies, relevant definitions, and the configured preamble. Do not send the whole research archive to a model.
- Preserve existing section TeX prose. Generate a missing file once; later revisions must target a passage or provide a patch.
- Sync the marked section input block in the main document from the writing outline only after previewing it with the draft-latex skill's \`manuscript-writing.cjs sync --preview\`.
- Write research files only in the configured folders: one node per file directly in its folder, no subfolders, new folders, or index/README/overview notes; group with tags. To organize materials, import papers with import-math-paper and extract results and definitions with extract-research-nodes; loose notes become ideas. A written manuscript is extracted into nodes first, then adopted into section files and briefs with plan-manuscript.
- Use exact node filenames without \`.md\` in relation fields. IDs are global across research folders. Store only forward relations; "used in" and plan lists are derived.
- Assets link definition IDs in \`uses_definitions\`. Definition \`depends_on\` lists definition IDs; asset \`depends_on\` lists asset IDs.
- Extract a definition, standard or introduced by the source, when a kept result uses it in its statement or proof; in the researcher's own manuscript that is every definition. Conditions and hypotheses a source defines are definitions too (one node per labelled hypothesis), listed in the \`uses_definitions\` of the results that assume them. Skip definitions no kept result uses; a definition with the same word but a different meaning gets a qualified ID. Remark assets are only for what defines nothing (standing assumptions, conventions, observations), with verified relative Markdown links to relevant definitions and assets.
- After drafting or materially revising an asset, run \`check-notation\` against linked approved definitions, macros, and the notation supplement.
- After adding or changing assets or definitions, run \`${MAINTENANCE} validate\` (dependencies, schema, IDs; it prints the dependency order) and \`${MAINTENANCE} links --preview\` / \`--apply\` to link verified prose mentions.
- To cite a local source PDF in Markdown, link to its configured \`${paths.localSourcePdfs}/<slug>.pdf\` path relative to the Markdown file. The dashboard opens these links in VS Code's PDF viewer; the PDF remains local and ignored by Git.
- Do not invent a node or paper ID; verify it from the shared files.
- Before editing LaTeX, read every configured macro/preamble file and the notation reference when present.
- Wrap manuscript passages that present a node in \`% research-assistant:block id=... sources=node@component\` ... \`% research-assistant:endblock\` markers (see draft-latex); follow each block's policy (managed, assisted, manual).
- A section's lock (\`writing/bindings/<id>.json\`) records the research it was written from; \`manuscript-writing.cjs impact\` reports which sections are stale. Update only stale sections, and only the passages the change touches.
- Block Markdown math must put opening and closing \`$$\` on separate lines.
- Approval is a researcher action: never set \`status: approved\` and never edit approval records; request approval through the research loop's \`request_approval\` tool.
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
type: ${alternatives(NODE_TYPE_LIST)}
title: string
status: ${alternatives(NODE_STATUS_LIST)} (assets/definitions); ${alternatives(IDEA_STATUS_LIST)} (ideas); ${alternatives(PLAN_STATUS_LIST)} (plans)
idea_kind: ${alternatives(IDEA_KIND_LIST)} (ideas)
target_asset: asset_id (plans)
inspired_by: [idea_id, ...] (plans)
tags: [string, ...]
source:
  kind: ${alternatives(SOURCE_KIND_LIST)}
  paper_id: string
  location: string
depends_on: [node_id, ...] (asset → asset, definition → definition)
uses_definitions: [definition_id, ...] (assets)
related_assets: [asset_id, ...] (ideas)
refutes: asset_id (counterexample examples)
---
\`\`\`

Load only the relevant node files for the current task. Do not copy node bodies into this instruction file; the node files themselves are canonical and merge independently.

## Paper index

Each \`## <slug>\` section in \`${paths.paperIndex}\` may record a local ignored PDF path, a stable source URL, and a description. The slug must match the BibTeX key in \`${paths.bibliography}\`.
`;
}

/**
 * Always-loaded guidance in AGENTS.md, read by both Codex and Claude Code (one
 * file, so the two cannot drift): only the invariants every task needs. Paths live in the config file, skills
 * are discovered by the agents themselves, and stage rules live in the skills,
 * so none of that is repeated here (it would cost context in every turn and in
 * every subagent).
 */
function agentGuidance(paths: ProjectPaths): string {
  return `# Mathematical Research Workspace

Overleaf-compatible LaTeX project plus a shared research knowledge base. Folder paths are in \`${paths.config}\`; tracked research Markdown, BibTeX, and LaTeX are the shared source of truth. The bundled skills carry the detailed rules; load the one the task needs.

## Invariants

- Approval is a researcher action: never write \`status: approved\`, never edit approval records; use the research loop's \`request_approval\`.
- New or materially changed assets and definitions stay \`status: draft\`; new ideas \`draft\`, new plans \`pending\`.
- Never change a statement while proving it; a revised statement gets a new asset ID. A failed plan is not a falsification.
- Never invent a node ID, paper, theorem location, citation, or proof step; verify IDs from the files.
- IDs in \`depends_on\`, \`uses_definitions\`, \`related_assets\`, \`target_asset\` are exact filenames without \`.md\`, unique across research folders. Store forward relations only. Block \`$$\` go on their own lines.
- Research files go only where \`${paths.config}\` puts them: one node per file directly in the assets, definitions, ideas, or plans folder; papers as \`<slug>/paper.md\` and \`metadata.yaml\`; known results in \`library/<collection>/\`. No subfolders, new folders, or index, README, overview, or other folder notes; group with \`tags\`. The PreToolUse hook denies other paths and \`validate\` reports them.
- Organizing materials means extracting them: \`import-math-paper\` for each paper PDF, then \`extract-research-nodes\` for results and definitions; loose notes and questions become ideas. A written manuscript (a main TeX that already holds the paper, or a Markdown draft) is extracted into nodes first, then adopted with \`plan-manuscript\` (adopt scope) and \`draft-latex\`; organizing is not finished at the outline. Keep raw files out of the research folders (PDFs in \`${paths.localSourcePdfs}/\`).
- After changing assets or definitions: \`research-maintenance\` (validate, links), then \`check-notation\`. Links for the files you changed are also applied when your turn ends; review \`links --preview\` for missing relations.
- Only approved nodes support manuscript arguments; plan with \`plan-manuscript\` and write one section at a time with \`draft-latex\`, then \`revise-manuscript-prose\`.
- Share research through the research loop's \`sync\` commands, not raw git pull/push. Do not rename shared files; never commit source PDFs (\`${paths.localSourcePdfs}/\`) or LaTeX build output.

## Reading context

- Read only what the task needs. In the research loop, the stage's context pack (\`.research-assistant-loop/context/current.md\`) is the reading list; request more with \`research-loop show <id> [--section Heading]\`.
- Prefer a node's statement or one section over whole files, and a paper's outline and one section over its full transcription. Do not scan whole research folders.
`;
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

  const existingAgents = await fileService.readFile(CODEX_AGENTS_PATH).catch(() => '');
  await Promise.all([
    fileService.writeFile(INSTRUCTIONS_PATH, copilotGuidance(paths)),
    fileService.writeFile(CODEX_AGENTS_PATH, upsertGeneratedSection(existingAgents, agentGuidance(paths))),
    retireClaudeMd(fileService),
  ]);
}

/** A CLAUDE.md would stop Claude Code from reading AGENTS.md: drop our old copy, or import AGENTS.md into the researcher's own file. */
async function retireClaudeMd(fileService: FileService): Promise<void> {
  const existing = await fileService.readFile(CLAUDE_INSTRUCTIONS_PATH).catch(() => undefined);
  if (existing === undefined) return;
  const next = claudeMdForAgentsMd(existing);
  if (next === null) await fileService.deleteFile(CLAUDE_INSTRUCTIONS_PATH);
  else if (next !== existing) await fileService.writeFile(CLAUDE_INSTRUCTIONS_PATH, next);
}
