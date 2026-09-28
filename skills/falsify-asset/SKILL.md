---
name: falsify-asset
description: Try to refute one draft research asset before proving it, and independently verify a candidate counterexample. Used by the research loop's falsify and verify_counterexample stages.
---

# Falsify an asset

Input: the asset ID; for verification also the candidate example ID. Read the asset's statement, its `uses_definitions` (note which are draft), and its direct `depends_on` statements only.

## Falsify

1. List every hypothesis and quantifier. Look at boundary and degenerate cases, dropped finiteness, compactness, or nondegeneracy assumptions, and known results that conflict.
2. Search for a concrete object satisfying every hypothesis but violating the conclusion. Compute explicitly.
3. Found: create `<assets>/<slug>.md` with `type: example`, `status: draft`, `refutes: <asset>`, `source.kind: self_proved`, `## Assumptions` (each hypothesis and why the object satisfies it), and `## Calculation` (why the conclusion fails). Report `candidate --counterexample <slug>`.
4. Not found: write one check `<research>/checks/check_<asset>_<short_slug>.md` with frontmatter `type: falsification_check`, `title`, `target_asset: <asset>`, `outcome: no_counterexample_found`, then `## Cases checked` (each family of objects or cases tried, one bullet each, with the key computation) and `## Limitations` (what was not covered, e.g. noncompact or degenerate cases). Report `none`. Collaborators rely on this record instead of repeating the search, so be concrete. Never write to the target asset.

A failed proof attempt, doubt, or a gap in a draft definition is not a counterexample; record such observations with `record_idea`.

## Verify

Reread the statement and the example from the files, not from memory. Recheck every assumption and every calculation step and try to break the example. Add `## Verdict` to the example: `confirmed` or `rejected` with the reason. Rejected: set the example `status: archived`. Confirmed: leave it `draft`; the loop asks the researcher to confirm it and parks the asset meanwhile. Never edit the refuted asset.

Report `confirmed` or `rejected`. Never set `status: approved`.
