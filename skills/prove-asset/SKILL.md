---
name: prove-asset
description: Write one executable proof plan for a draft asset that survived falsification, then execute it; on success incorporate the proof and convert the plan to a proof record, on obstruction mark the plan failed. Used by the research loop's plan and execute stages.
---

# Prove an asset

Input: asset ID, optional plan ID, and any researcher direction. Read the asset's statement, its `depends_on` statements (approved or proved dependencies are black boxes; unproved draft dependencies may be assumed but must be listed), its definitions, all plans and proof records targeting it, and its related ideas.

## Plan

- A `pending` plan for this asset already exists: execute it instead of writing a new one (`report complete --plan <id>`).
- Otherwise create `<plans>/<id>.md` with `type: plan`, `status: pending`, `target_asset`, and `inspired_by` idea IDs you used. Body: `## Goal` starting with `Target: [asset](../assets/<id>.md)`, `## Plan` as an ordered checklist `1. [ ] ...` of concrete steps each with a checkable claim, `## Verification` (how the steps combine into the exact statement), `## Assumed definitions` (draft definitions and unproved dependencies relied on), and, when failed plans exist, `## Difference from failed plans` with one bullet per failed plan ID naming the new information or route.
- If the loop reports three failures since the last researcher direction, do not write a fourth plan; report `question`.

## Execute

- Follow the checklist in order; tick a box only when the step is established in writing.
- Success: put the complete proof under `## Proof` in the target asset (statement unchanged, status stays `draft`), then convert the plan to `type: proof_record` (remove `status`, keep `target_asset` and `inspired_by`) with `## Outcome` naming where the proof lives and what is still assumed. Run `check-notation` and `link-research-nodes`. Report `proved --assumed-definitions a,b` when draft definitions were used.
- Obstruction: leave the asset untouched, set the plan `status: failed`, write `## Failure` with the exact obstruction (which step, why it cannot be completed, what would be needed). Report `failed`.
- Unclear statement or missing definition: report `question --question "..."`.

A failed plan says nothing about the truth of the statement. Never set `status: approved`.
