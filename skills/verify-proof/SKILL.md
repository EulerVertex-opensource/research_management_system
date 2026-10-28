---
name: verify-proof
description: Independently verify a draft asset's proof, as a referee would, and record a confirmed or rejected verdict in the plan that produced it. Used by the research loop's verify_proof stage.
---

# Verify a proof

Input: the context pack from `research-loop next` (the asset's statement and `## Proof`, the statements of its dependencies, and the definitions it uses). The plan that produced the proof is left out on purpose: judge the proof as written, not the reasoning behind it. For anything else run `research-loop show <id> [--section Heading]`.

- Read the statement first and note exactly what it assumes and what it concludes. Then go through the proof one step at a time.
- For each step, check that it follows from the hypotheses, from earlier steps, or from a dependency whose statement is in the pack. When the proof applies a dependency, check every hypothesis of that dependency in this setting.
- Check the edges: quantifiers and their order, boundary and degenerate cases, which way each inequality goes, division by quantities that could vanish, uniformity of constants, and whether "clearly" or "similarly" hides an argument that is not there.
- A gap you can close yourself in a line or two is not a rejection; mention it in the verdict so the researcher sees it. A step that needs a new idea, a claim that is false, or a hypothesis that is never established is a rejection.
- Do not repair the proof, and do not write a different one.

Write `## Verdict` at the end of the plan named in the instruction:

- First line `confirmed` or `rejected`, alone.
- `confirmed`: a few lines on what you checked and any small gaps you closed.
- `rejected`: the first step that fails, quoted or pinpointed, why it fails, and what would be needed to fix it. The loop marks the plan failed and the next plan starts from your verdict.

Report `confirmed` or `rejected` to match the first line, or `question --question "..."` when the statement itself is ambiguous. Only the plan's `## Verdict` may change: leave the asset, the plan's status, and its frontmatter as they are. Never write `verified_proof_digest`; the loop records it.
