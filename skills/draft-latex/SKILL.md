---
name: draft-latex
description: Draft a mathematical manuscript section in LaTeX from approved research nodes. Use when writing or revising section text grounded in the project's established results.
---

# Draft manuscript LaTeX

Read `.research-assistant.json`, the manuscript outline, and the requested section brief. Run `node .agents/skills/manuscript-writing/scripts/manuscript-writing.cjs prepare <id> --preview` before drafting. Stop if it reports an unknown or unapproved asset, definition, or missing BibTeX key. Read only the reported assets, their dependencies and approved definitions, the main TeX file, configured macros or preamble files, notation file when present, and the current section TeX file. Follow existing theorem and proof environments, macros, labels, citation style, and notation.

If the section TeX file is missing, run `prepare <id> --apply` to create it, then replace the untouched skeleton with a complete first draft. For an existing section containing researcher prose, revise only the requested passage or provide a patch; never regenerate the whole file. Translate supported Markdown prose and math into idiomatic LaTeX, checking every statement and proof step against its source node. Mark each use with a nearby `% [node_id]` comment. Use the node's `source.paper_id` as a real `\cite{...}` key when the manuscript attributes a result to a paper; use normal LaTeX labels and references for internal results. Do not print internal asset IDs in the PDF.

Mark unresolved mathematical steps with `% TODO` and describe the gap. Do not silently supply a proof, invent a citation, or change notation. Run `check-notation`, review the Git diff, and compile the manuscript when a local TeX build is available.
