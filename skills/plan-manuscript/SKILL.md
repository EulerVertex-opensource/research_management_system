---
name: plan-manuscript
description: Plan the paper - the section order for the whole manuscript, or one section's brief - from approved research nodes. Use for presentation order, section outlines, result selection, identifying missing arguments, and adopting an existing manuscript (a main TeX that already holds the paper) into section files and briefs; use draft-latex to write the TeX.
---

# Plan the manuscript

Read `.research-assistant.json`, the project contract (`project.md`), and `writing/outline.md` under the configured research root. Start from a compact index of asset and definition IDs, titles, status, and dependencies (`research-maintenance validate` prints it in dependency order); read full node bodies only where a result's role is unclear. Do not load the whole research archive.

The outline lists sections in presentation order under `## Sections`, one numbered link per section: `1. [Introduction](sections/introduction.md)`. Each brief `writing/sections/<id>.md` has YAML `title` (identical to the outline link title) and `assets` (verified asset IDs, possibly `[]` for exposition), then `## Purpose`, `## Subsections`, `## Gaps`, and `## Excluded`. An `assets` entry presents the whole node, so any change to it makes the section stale. Where a section uses only part of a node, list it under `sources` instead, with a `role` (central_result, supporting_result, definition, motivation, counterexample, citation, background, remark) and the components it `uses` (statement, proof, source): an introduction that states the main theorem uses `[statement]`, so a new proof leaves it current. Rhetorical sections (introduction, abstract, conclusion) list the project parts they restate in `project_facets` (problem, scope, contribution, required).

```yaml
title: Introduction
assets: []
sources:
  - id: main_theorem
    role: central_result
    uses: [statement]
project_facets: [contribution]
``` Section IDs are stable lowercase letters, digits, underscores, or hyphens. Briefs are writing plans, distinct from proof plans.

Briefs cite node IDs. When the project has no nodes but a written draft holds the results, extract them first (`extract-research-nodes`); never write briefs that describe a draft's results in prose under Gaps.

## Scope: adopt an existing manuscript

Use this scope when the main TeX document already holds the paper (inline `\section`s, or its own inputs from the sections folder) and the outline lists no sections. Extract its nodes first.

1. Run `node .agents/skills/draft-latex/scripts/manuscript-writing.cjs adopt --preview` and show the researcher the split. Each section's text moves unchanged into `sections/<id>.tex`, and the main document gets `\input` lines between the sync markers; the preamble, front matter, and bibliography stay. Moving text detaches Overleaf comments and tracked changes, so ask before `adopt --apply` (`ask_researcher` with kind `discussion`, or in chat). Never split or retype the TeX by hand.
2. `adopt --apply` writes the outline in the manuscript's order and one brief per section with `assets: []`. Fill each brief: `sources` for the nodes its TeX states or proves, each with a role and `uses`, plus Purpose and Subsections from the existing text. Draft nodes belong in `sources` here, because the prose already presents them; `lock` waits for their approval. Record under Gaps what the TeX asserts without a node, such as an unproved claim or an uncited fact.
3. Keep the order and the TeX: adoption plans the existing paper; it does not restructure it. Propose any reordering separately (scope manuscript).

Then `draft-latex` wraps the existing passages in blocks (Adopt existing prose).

## Scope: manuscript

Discuss audience, main contribution, and argument order with the researcher. Propose a sequence of stable section IDs with a purpose for each. Use dependency order as a consistency check; the exposition may differ for a preview or motivation. Point out missing intermediate arguments. Once the researcher chooses, update the outline and create or revise one brief per section. Preserve existing briefs and TeX files when reorganizing; avoid renaming files with active collaborator edits or Overleaf comments.

## Scope: section

Work on one brief. Find candidate nodes from the index, then read only the relevant ones, plus related ideas and pending plans as possible approaches (kept distinct from established results) and failed plans as recorded obstructions. Give subsection goals, result order, and the exact IDs used.

Select only what the paper needs. A node belongs in the brief when it is in `required_results`, when a presented proof actually uses it (not merely lists it in `depends_on`), or when the section needs it as motivation or a counterexample. Many approved assets exist only for completeness or an earlier experiment: sanity checks, special cases, variants of an abandoned approach, bookkeeping lemmas. They are correct but do not belong in the paper. List each one under `## Excluded` as `- node_id: reason`, so later drafts and updates do not bring it back. When a presented proof needs an excluded lemma, either state it in one sentence as standard or routine, or move it into the brief; ask the researcher when unsure. Record draft nodes and speculative ideas under Gaps; never present them as proved. Remarks (`node .agents/skills/research-loop/scripts/research-loop.cjs remark list --target <id>`) are annotations on results: the researcher's own, or the loop's. A remark that would help the paper's reader (the idea behind a proof, why a hypothesis is needed) may go in a brief as a source with `role: remark`, right after the result it is on. It must be approved for the paper first: the researcher approves a remark's text in the dashboard (the remark under its result, "approve for the paper"); `prepare` refuses one that is not. Propose remarks, never approve them, and choose few: none by default. When the researcher decides a remark stays out of the paper, list it under `## Excluded` of the brief presenting its result (`- remark_<id>: reason`), so later updates do not offer it again. A remark that claims something no node proves stays out (record the claim as an idea instead). An assumption or convention (`definition_kind`) is a definition: place it before the results that use it, with `role: definition`. An approved conjecture (`type: conjecture`) has an agreed statement and no proof: it may go in a brief, usually in a closing open-problems section or right after the result it would strengthen, and is presented as a conjecture, never as proved. If too few approved results exist, say what is missing. Do not edit TeX while planning.

## Scope: update after the research changed

When the research loop is ready after an extension, or `manuscript-writing.cjs impact` reports uncovered results or remarks approved for the paper but in no brief, place only those (never nodes a brief lists under `## Excluded`): add an uncovered result to an existing brief or add a new section, and add `project_facets` sections (introduction, conclusion) whose claims now understate the contribution. For each such remark, read it and propose to the researcher where it goes, normally as a `role: remark` source right after its result in the brief that presents that result, or that it stays out; add it to `sources` or to `## Excluded` as they decide. A remark on a result no brief presents waits until that result is placed. Leave current sections and their briefs alone. A result no longer required (reported as `no longer required`) is the researcher's call: keep it as background, or remove it.

After briefs change, `draft-latex` prepares and writes the sections and syncs the main document's input order.
