---
name: revise-manuscript-prose
description: Review a drafted manuscript section's LaTeX prose for missing transitions between asset blocks, asset-level detail an expert reader does not need, excluded research assets, leaked coded labels such as (M1), and figurative wording, then propose or apply fixes without changing the mathematics. Use after draft-latex writes or revises a section, or for a requested prose pass.
---

# Revise manuscript prose

Read `.research-assistant.json`, `writing/outline.md`, the section brief, and the section TeX. Read the shared style rules at `.agents/skills/draft-latex/references/style.md` (identical copy under `.claude/skills/`). Read a presented node only to check whether a compressed passage still matches it. Do not reread the whole research archive.

Check, in order:

1. Selection: any block whose `sources` name a node the brief lists under `## Excluded`, and any passage presenting an asset the brief does not list.
2. Transitions: two blocks with no prose between them, prose that only announces order ("Next we prove"), and a section end with no link to the next section in the outline.
3. Detail: routine verifications, restated standard material, exploratory remarks, or repeated motivation that an expert reader does not need.
4. Labels: codes matching `\([A-Z]{1,3}\d+\)`, node IDs, and asset-local numbering in printed text. Skip labels the manuscript defines itself, in a displayed hypothesis list or with `\label`/`\tag`, and skip comments.
5. Wording: figurative framing like the examples in the style rules. Use judgement; a listed phrase is not always wrong.

Report each finding with its line, the block ID if any, and a proposed rewrite. Then fix according to where the text lies:

- Prose outside blocks (transitions, motivation): edit directly.
- `managed` blocks: edit directly.
- `assisted` blocks (default): give the patch; the researcher confirms it.
- `manual` blocks: report only.

Never change a mathematical statement, hypothesis, constant, or proof step, and never drop a non-routine step while compressing. When a fix would need different mathematics, or the removal of an excluded asset breaks a proof, report it and leave the text unchanged. Selection problems go back to `plan-manuscript`. Review the Git diff and compile when a local TeX build is available. Do not lock the section; the researcher reviews it first.
