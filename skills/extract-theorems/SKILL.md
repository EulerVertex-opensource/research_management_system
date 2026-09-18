---
name: extract-theorems
description: Extract theorem-like results from an existing paper transcription or research notes into draft research nodes. Use when the source has already been imported; use import-math-paper for a new PDF.
---

# Extract theorem nodes

Read `.research-assistant.json` for the configured paper, asset, and bibliography paths. Identify the paper slug and read the relevant transcription or notes. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available.

Create a separate Markdown asset for each useful theorem, lemma, proposition, or example. Use `extract-definitions` for commonly used definitions; put project-specific conditions or assumptions in linked `remark` assets. Use descriptive snake_case filenames and the repository's YAML frontmatter schema. Record the paper slug and precise page or theorem location in `source`; include the statement, known dependencies, `uses_definitions` links, and relevant tags. Do not invent missing proof details or dependencies. Set every new or materially revised node to `status: draft`.

After writing asset files, use the `order-assets` skill to validate dependencies and update title order.
Use `link-research-nodes` to link verified definition and asset mentions in the new or revised bodies.
Run `check-notation` against new or materially revised assets before finishing.

If the user requested candidates rather than files, return the same information as Markdown code blocks with YAML frontmatter. Flag uncertain readings and any source passages that still need checking.
