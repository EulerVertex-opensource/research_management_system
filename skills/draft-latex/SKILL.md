---
name: draft-latex
description: Draft a mathematical manuscript section in LaTeX from approved research nodes. Use when writing or revising section text grounded in the project's established results.
---

# Draft manuscript LaTeX

Read `.research-assistant.json`, the main TeX file, every configured macro or preamble file, linked approved definitions, and the notation file when present. Read the approved node files relevant to the requested section. Follow the project's existing theorem and proof environments, macros, labels, citation style, and notation.

Draft the requested LaTeX using only results supported by the approved nodes. Mark each use of a node with a `% [node_id]` comment. Mark an unresolved mathematical step with `% TODO` and explain the gap; do not silently supply a proof or change notation. Check the draft against the configured files before returning or writing it.
