---
name: draft-latex
description: Write or revise a manuscript section in LaTeX from approved research nodes, update sections the research changed since they were locked, and keep the main document's section inputs in outline order. Use when drafting section text, creating a missing section file, updating stale sections, syncing section order after plan-manuscript changed the outline, or marking the passages of an adopted manuscript.
---

# Draft manuscript LaTeX

A chat opened for the manuscript, beside the research loop's own chat, never drives the loop (the loop's own chat may use this skill when its `ready` stage asks it to). There, do not run `research-loop next`, `report`, `resume`, or other commands that move the loop, and do not prove results here: a result the paper needs but nobody proved goes under `## Gaps` of its brief (or as an idea) for the loop, which runs in its own chat.

The bundled script prepares context and syncs inputs (Claude Code has the identical copy under `.claude/skills/draft-latex/scripts/`):

```bash
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs impact
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs prepare <section_id> --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs lock <section_id> --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs sync --preview
node .agents/skills/draft-latex/scripts/manuscript-writing.cjs adopt --preview
```

## Write a section

1. Read `.research-assistant.json`, `writing/outline.md`, and the section brief (see `plan-manuscript` for their format).
2. Run `prepare <id> --preview`. It lists the exact context: the brief, its approved assets with their transitive asset and definition dependencies, preamble and macro files, and verified BibTeX keys. Stop if it reports an unknown or unapproved node or a paper source without a BibTeX entry. For a locked section it lists only what changed since the lock (`Changed:`, `Added to brief:`) and names the unchanged nodes, which are already in the TeX: do not reread them (`--full` lists everything).
3. Read only those files, [references/style.md](references/style.md), the main TeX file, the notation file when present, and the current section TeX. Follow existing theorem and proof environments, macros, labels, citation style, and notation.
4. If the section TeX is missing, run `prepare <id> --apply` to create its skeleton, then replace the skeleton with a complete first draft. For an existing section with researcher prose, revise only the requested passage or give a patch; never regenerate the file.
5. Translate Markdown prose and math into idiomatic LaTeX for an expert reader (see Writing for the paper), checking every statement and proof step against its node. Do not present a node the brief lists under `## Excluded`. Wrap each passage that presents a node in a block (the skeleton starts one per brief source):

   ```tex
   % research-assistant:block id=main-theorem-proof sources=main_theorem@proof,compactness_lemma@statement policy=assisted
   \begin{proof} ... \end{proof}
   % research-assistant:endblock
   ```

   `sources` names each node and the components the passage presents (`statement`, `proof`, `source`; a bare ID means all), so a later change points at this block alone. Block IDs are stable lowercase words with hyphens; never rename a locked block. Keep motivation and transitions outside blocks. Only the block's own lines count; blocks do not nest. The older one-line `% [node_id]` tag is still read, as a section-level use. Cite a paper-sourced result with its `source.paper_id` as the `\cite{...}` key; reference internal results with LaTeX labels. Do not print node IDs in the PDF.
6. Present a `type: conjecture` node in a `conjecture` environment (add `\newtheorem{conjecture}` beside the existing theorem environments when the preamble lacks one), with its statement only (`sources=<id>@statement`) and its motivation as prose outside the block; never write a proof for it or state it as a result. Mark unresolved steps with `% TODO` and describe the gap. Do not silently supply a proof, invent a citation, or change notation.
7. Run `check-notation` and `revise-manuscript-prose`, review the Git diff, and compile when a local TeX build is available.

## Writing for the paper

The assets are working documents; the paper is not a concatenation of them. [references/style.md](references/style.md) has examples for each rule.

- Audience: the reader is an expert in the field. Keep every statement exactly and every non-routine proof step. Compress routine verifications to a sentence ("a direct computation gives"), and drop exploratory remarks, restated context, and the asset's internal bookkeeping. Never weaken a statement or skip a non-routine step to save space.
- Remarks: present only the remarks the brief lists (`prepare` prints each as `Remark:`), as a `remark` environment after the result it is on, or folded into the prose around it. Keep its meaning and adapt its wording to the paper; it adds no claim the paper does not prove (say "heuristically" or "one expects" where the remark is intuition). When `prepare` says a remark was written for an earlier version of its result, check it still fits and tell the researcher if it does not. Wrap it in a block citing the remark ID like any source.
- Definitions with `definition_kind: assumption` are standing hypotheses: state them as an `assumption` environment (or "Throughout this section, ...") before the results that use them. A `convention` goes into the notation paragraph.
- Transitions: before each block after the first, write one or two sentences outside the blocks that say why the next result is needed or how it follows from the previous one. End the section with a sentence leading to the next section in the outline. Adjacent blocks with no prose between them read as stitched assets.
- Labels: never print codes carried over from the assets, such as (M1), (S1), (F1), asset-local numbering, or node IDs. Name the object in words ("the monotonicity assumption", "the second step of the proof"). Labels the manuscript itself defines, such as hypotheses (H1)-(H3) in a displayed list referenced with `\ref`, are fine.
- Wording: describe what the mathematics does directly ("the estimate requires $p > 2$") instead of figurative framing ("the decisive clause", "the argument hinges on"). Repeat the precise term rather than varying it. Keep mathematical statements and proof steps intact.

## Adopt existing prose

After `plan-manuscript` adopted a manuscript and filled its briefs, the section files hold the researcher's own prose. Do not run `prepare --apply` (the files exist) and do not redraft. Wrap each passage that presents a brief source, such as a theorem environment with its proof or a definition, in a block with its `sources` and `policy=assisted`. Add only the two marker lines; never change, reflow, or translate a line of the existing text. Use `policy=manual` where the researcher wants the text left alone. Then run `impact`: a section stays `unlocked` until the researcher has approved its nodes and reviewed it, and only then is it locked.

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

After section files exist, run `sync --preview` to see the proposed `\input` order from the outline, then `sync --apply`. It changes only the block between these markers in the main document (`adopt` adds them to an existing manuscript):

```tex
% research-assistant:sections:start
% research-assistant:sections:end
```

The command refuses to insert markers itself or to sync when a section file is missing. Review the Git diff and compile locally or in Overleaf.
