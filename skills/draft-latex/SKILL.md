---
name: draft-latex
description: Write or revise a manuscript section in LaTeX from approved research nodes, update sections the research changed since they were locked, and keep the main document's section inputs in outline order. Use when drafting section text, creating a missing section file, updating stale sections, or syncing section order after plan-manuscript changed the outline.
---

# Draft manuscript LaTeX

The bundled script prepares context and syncs inputs (Claude Code has the identical copy under `.claude/skills/draft-latex/scripts/`):

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs impact
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs prepare <section_id> --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs lock <section_id> --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs sync --preview
```

## Write a section

1. Read `.research-assistant.json`, `writing/outline.md`, and the section brief (see `plan-manuscript` for their format).
2. Run `prepare <id> --preview`. It lists the exact context: the brief, its approved assets with their transitive asset and definition dependencies, preamble and macro files, and verified BibTeX keys. Stop if it reports an unknown or unapproved node or a paper source without a BibTeX entry. For a locked section it lists only what changed since the lock (`Changed:`, `Added to brief:`) and names the unchanged nodes, which are already in the TeX: do not reread them (`--full` lists everything).
3. Read only those files, the main TeX file, the notation file when present, and the current section TeX. Follow existing theorem and proof environments, macros, labels, citation style, and notation.
4. If the section TeX is missing, run `prepare <id> --apply` to create its skeleton, then replace the skeleton with a complete first draft. For an existing section with researcher prose, revise only the requested passage or give a patch; never regenerate the file.
5. Translate Markdown prose and math into idiomatic LaTeX, checking every statement and proof step against its node. Wrap each passage that presents a node in a block (the skeleton starts one per brief source):

   ```tex
   % research-assistant:block id=main-theorem-proof sources=main_theorem@proof,compactness_lemma@statement policy=assisted
   \begin{proof} ... \end{proof}
   % research-assistant:endblock
   ```

   `sources` names each node and the components the passage presents (`statement`, `proof`, `source`; a bare ID means all), so a later change points at this block alone. Block IDs are stable lowercase words with hyphens; never rename a locked block. Keep motivation and transitions outside blocks. Only the block's own lines count; blocks do not nest. The older one-line `% [node_id]` tag is still read, as a section-level use. Cite a paper-sourced result with its `source.paper_id` as the `\cite{...}` key; reference internal results with LaTeX labels. Do not print node IDs in the PDF.
6. Mark unresolved steps with `% TODO` and describe the gap. Do not silently supply a proof, invent a citation, or change notation.
7. Run `check-notation`, review the Git diff, and compile when a local TeX build is available.

## Keep sections current

A lock records, in `writing/bindings/<id>.json` (shared in Git), the digests of the node components a section presents and the project facets it restates. `impact` compares them with the research now:

- `current`: nothing to do; do not reread or rewrite the section.
- `stale`: a presented component changed (`main_theorem proof changed` touches only the passages giving that proof; a `statement` change touches every use), a dependency's statement changed, a restated project facet changed, or the brief gained or lost a source. Revise only the affected passages.
- `invalid`: a presented node is missing, deprecated, or no longer approved. Do not paper over it; tell the researcher.
- `unlocked`: never locked. Uncovered required results need `plan-manuscript` first.

With blocks, `impact` and `prepare` name the stale blocks and their lines: read only those lines and the changed nodes, and act by the block's `policy`:

- `managed`: rewrite the block from its sources.
- `assisted` (default): propose a patch to the block; the researcher confirms it.
- `manual`: do not edit; tell the researcher what changed.

`Outside blocks` means a change no block presents (for example a brief that lists the whole node while the blocks present only its statement): check the prose around the blocks, or narrow the brief's `uses`. Leave current blocks untouched.

After the researcher has reviewed a drafted or revised section, show `lock <id> --preview`; the researcher (or you, at their request) runs `lock <id> --apply`. Never lock a section the researcher has not reviewed: a lock asserts the TeX matches the research.

## Sync input order

After section files exist, run `sync --preview` to see the proposed `\input` order from the outline, then `sync --apply`. It changes only the block between these markers in the main document; for an adopted manuscript, add them once around the existing section inputs:

```tex
% research-assistant:sections:start
% research-assistant:sections:end
```

The command refuses to insert markers itself or to sync when a section file is missing. Review the Git diff and compile locally or in Overleaf.
