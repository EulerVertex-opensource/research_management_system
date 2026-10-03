---
name: check-notation
description: Review research assets or mathematical LaTeX for undefined or inconsistent notation using approved definition files as the primary source. Use after an agent drafts or materially revises an asset, or for a requested notation audit.
---

# Check notation consistency

Read `.research-assistant.json` and the asset or LaTeX under review. For an asset, read its `uses_definitions` files and their definition dependencies, then other relevant approved definitions. Treat approved definitions as the primary source for mathematical meaning and notation; identify draft definitions as candidates. Read every configured macro or preamble file and `notations.tex` when present for LaTeX commands and supplementary conventions. Compare symbol meanings in context; a symbol defined locally within the asset is not automatically an error.

Report missing or stale `uses_definitions` links, undefined symbols, conflicting uses of one symbol, multiple symbols for one object, and conflicts between approved definitions and `notations.tex`. Give locations and concise proposed corrections. Distinguish confirmed inconsistencies from cases needing researcher interpretation. Do not silently rewrite definitions or notation. If no approved definition covers a concept, say so and consider a draft definition candidate. If no notation file is configured, use definitions and local context and say so.

When a verified definition or prerequisite asset is named in prose, check that its relationship ID and relative Markdown link are present. After correcting missing relationship IDs, preview and apply links with `research-maintenance links`.
