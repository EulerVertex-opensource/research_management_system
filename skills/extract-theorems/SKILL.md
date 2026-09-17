---
name: extract-theorems
description: Extract theorem-like results from an existing paper transcription or research notes into draft research nodes. Use when the source has already been imported; use import-math-paper for a new PDF.
---

# Extract theorem nodes

Read `.research-assistant.json` for the configured paper, asset, and bibliography paths. Identify the paper slug and read the relevant transcription or notes. Check the source PDF for any ambiguous statement, formula, numbering, or attribution when it is available.

Create a separate Markdown node for each useful theorem, lemma, proposition, definition, or example. Use a descriptive snake_case filename and the repository's YAML frontmatter schema. Record the paper slug and precise page or theorem location in `source`; include the statement, known dependencies, and relevant tags. Do not invent missing proof details or dependencies. Set every new or materially revised node to `status: draft`.

If the user requested candidates rather than files, return the same information as Markdown code blocks with YAML frontmatter. Flag uncertain readings and any source passages that still need checking.
