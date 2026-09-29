---
name: draft-latex
description: Write or revise a manuscript section in LaTeX from approved research nodes, and keep the main document's section inputs in outline order. Use when drafting section text, creating a missing section file, or syncing section order after plan-manuscript changed the outline.
---

# Draft manuscript LaTeX

The bundled script prepares context and syncs inputs (Claude Code has the identical copy under `.claude/skills/draft-latex/scripts/`):

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs prepare <section_id> --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs sync --preview
```

## Write a section

1. Read `.research-assistant.json`, `writing/outline.md`, and the section brief (see `plan-manuscript` for their format).
2. Run `prepare <id> --preview`. It lists the exact context: the brief, its approved assets with their transitive asset and definition dependencies, preamble and macro files, and verified BibTeX keys. Stop if it reports an unknown or unapproved node or a paper source without a BibTeX entry.
3. Read only those files, the main TeX file, the notation file when present, and the current section TeX. Follow existing theorem and proof environments, macros, labels, citation style, and notation.
4. If the section TeX is missing, run `prepare <id> --apply` to create its skeleton, then replace the skeleton with a complete first draft. For an existing section with researcher prose, revise only the requested passage or give a patch; never regenerate the file.
5. Translate Markdown prose and math into idiomatic LaTeX, checking every statement and proof step against its node. Mark each use with a nearby `% [node_id]` comment. Cite a paper-sourced result with its `source.paper_id` as the `\cite{...}` key; reference internal results with LaTeX labels. Do not print node IDs in the PDF.
6. Mark unresolved steps with `% TODO` and describe the gap. Do not silently supply a proof, invent a citation, or change notation.
7. Run `check-notation`, review the Git diff, and compile when a local TeX build is available.

## Sync input order

After section files exist, run `sync --preview` to see the proposed `\input` order from the outline, then `sync --apply`. It changes only the block between these markers in the main document; for an adopted manuscript, add them once around the existing section inputs:

```tex
% research-assistant:sections:start
% research-assistant:sections:end
```

The command refuses to insert markers itself or to sync when a section file is missing. Review the Git diff and compile locally or in Overleaf.
