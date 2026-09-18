---
name: plan-manuscript
description: Formulate the paper's presentation order and divide it into independently editable LaTeX sections using research asset IDs.
---

# Plan the manuscript

Read `.research-assistant.json`, the configured project description, existing main TeX file, and `writing/outline.md` under the configured research root. Start with a compact index of asset and definition IDs, titles, status, and dependencies. Read full node bodies only for candidate results whose role in the presentation is unclear. Do not load the entire research archive into one model request.

Discuss the paper's audience, main contribution, and argument order with the researcher. Propose a sequence of stable section IDs and a purpose for each section. Use dependency order as a consistency check; the exposition may differ when a clear preview or motivation is needed. Point out missing intermediate arguments and distinguish approved results from drafts and ideas.

Once the researcher chooses an order, update the numbered links under `## Sections` in the writing outline. Create one brief per section at `writing/sections/<id>.md`, with `title` and `assets` YAML fields and `## Purpose`, `## Subsections`, and `## Gaps` headings. Use only verified asset IDs. Keep the outline link title and brief title identical. Preserve existing briefs and TeX files when reorganizing; avoid renaming files with active collaborator edits or Overleaf comments.

The writing outline determines manuscript input order. Use the `manuscript-writing` skill to preview and apply the input sync after section TeX files exist.
