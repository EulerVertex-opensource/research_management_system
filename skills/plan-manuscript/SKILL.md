---
name: plan-manuscript
description: Plan the paper - the section order for the whole manuscript, or one section's brief - from approved research nodes. Use for presentation order, section outlines, result selection, and identifying missing arguments; use draft-latex to write the TeX.
---

# Plan the manuscript

Read `.research-assistant.json`, the project contract (`project.md`), and `writing/outline.md` under the configured research root. Start from a compact index of asset and definition IDs, titles, status, and dependencies (`research-maintenance validate` prints it in dependency order); read full node bodies only where a result's role is unclear. Do not load the whole research archive.

The outline lists sections in presentation order under `## Sections`, one numbered link per section: `1. [Introduction](sections/introduction.md)`. Each brief `writing/sections/<id>.md` has YAML `title` (identical to the outline link title) and `assets` (verified asset IDs, possibly `[]` for exposition), then `## Purpose`, `## Subsections`, and `## Gaps`. An `assets` entry presents the whole node, so any change to it makes the section stale. Where a section uses only part of a node, list it under `sources` instead, with a `role` (central_result, supporting_result, definition, motivation, counterexample, citation, background) and the components it `uses` (statement, proof, source): an introduction that states the main theorem uses `[statement]`, so a new proof leaves it current. Rhetorical sections (introduction, abstract, conclusion) list the project parts they restate in `project_facets` (problem, scope, contribution, required).

```yaml
title: Introduction
assets: []
sources:
  - id: main_theorem
    role: central_result
    uses: [statement]
project_facets: [contribution]
``` Section IDs are stable lowercase letters, digits, underscores, or hyphens. Briefs are writing plans, distinct from proof plans.

## Scope: manuscript

Discuss audience, main contribution, and argument order with the researcher. Propose a sequence of stable section IDs with a purpose for each. Use dependency order as a consistency check; the exposition may differ for a preview or motivation. Point out missing intermediate arguments. Once the researcher chooses, update the outline and create or revise one brief per section. Preserve existing briefs and TeX files when reorganizing; avoid renaming files with active collaborator edits or Overleaf comments.

## Scope: section

Work on one brief. Find candidate nodes from the index, then read only the relevant ones, plus related ideas and pending plans as possible approaches (kept distinct from established results) and failed plans as recorded obstructions. Give subsection goals, result order, and the exact IDs used. Record draft nodes and speculative ideas under Gaps; never present them as proved. If too few approved results exist, say what is missing. Do not edit TeX while planning.

## Scope: update after the research changed

When the research loop is ready after an extension, or `manuscript-writing.cjs impact` reports uncovered results, place only the uncovered results: add them to an existing brief or add a new section, and add `project_facets` sections (introduction, conclusion) whose claims now understate the contribution. Leave current sections and their briefs alone. A result no longer required (reported as `no longer required`) is the researcher's call: keep it as background, or remove it.

After briefs change, `draft-latex` prepares and writes the sections and syncs the main document's input order.
