---
name: execute-proof
description: Execute one pending proof plan for a draft asset; on success put the proof in the asset and mark the plan succeeded, on obstruction mark the plan failed. Used by the research loop's execute stage.
---

# Execute a proof plan

Input: the context pack from `research-loop next` (the plan, the frozen target statement, dependency statements, definitions, and the full text of each result the plan `adapts`). Read only the pack; for anything else run `research-loop show <id> [--section Heading]`, for example a dependency's proof only when a step genuinely needs its argument.

- Follow the checklist in order; tick a box only when the step is established in writing.
- A step "as in <id>" follows that result's proof in the pack: carry it over with the changes `## Adapted from` names, check every hypothesis it uses in the new setting, and write the adapted argument out in full. An adapted proof is reproved here, not cited.
- Success: put the complete proof under `## Proof` in the target asset (statement unchanged, status stays `draft`), then set the plan `status: succeeded` and add `## Outcome` naming where the proof lives and what is still assumed. The loop stamps `proof_digest` on the plan when you report; do not write it. Run `check-notation` and `research-maintenance links --file <asset path> --apply`. Report `proved --assumed-definitions a,b` when draft definitions were used.
- Obstruction: leave the asset untouched, set the plan `status: failed`, write `## Failure` with the exact obstruction (which step, why it cannot be completed, what would be needed). Report `failed`.
- Unclear statement or missing definition: report `question --question "..."`.

A failed plan says nothing about the truth of the statement. Only the plan file and the target's `## Proof` may change. Never set `status: approved`.
