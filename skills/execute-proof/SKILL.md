---
name: execute-proof
description: Execute one pending proof plan for a draft asset; on success put the proof in the asset and mark the plan succeeded, on obstruction mark the plan failed. Used by the research loop's execute stage.
---

# Execute a proof plan

Input: the context pack from `research-loop next` (the plan, the frozen target statement, dependency statements, definitions, the full text of each result the plan `adapts`, and the project's proof style when the researchers recorded one). Write the proof the way the proof style asks. Read only the pack; for anything else run `research-loop show <id> [--section Heading]`, for example a dependency's proof only when a step genuinely needs its argument.

- Follow the checklist in order; tick a box only when the step is established in writing.
- A step "as in <id>" follows that result's proof in the pack: carry it over with the changes `## Adapted from` names, check every hypothesis it uses in the new setting, and write the adapted argument out in full. An adapted proof is reproved here, not cited.
- Success: put the complete proof under `## Proof` in the target asset (statement unchanged, status stays `draft`), then set the plan `status: succeeded` and add `## Outcome` naming where the proof lives and what is still assumed. The loop stamps `proof_digest` on the plan when you report; do not write it. Run `check-notation` and `research-maintenance links --file <asset path> --apply`. Report `proved --assumed-definitions a,b` when draft definitions were used.
- A remark, when it helps a reader: after a success, the key idea in a sentence or why the obvious route failed, as `add_remark` on the target with `origin: "agent", from: "loop"` (at most two). An explanation only; a claim the proof does not establish is an idea, not a remark.
- Obstruction: leave the asset untouched, set the plan `status: failed`, write `## Failure` with the exact obstruction (which step, why it cannot be completed, what would be needed). Report `failed`.
- When the obstruction shows more than this plan failing: an approach in `inspired_by` that cannot work for any result of this kind gets `research-loop idea obstruct <idea> --reason "..."`; an observation in `inspired_by` that turns out false gets `research-loop idea refute <idea> --reason "<the counterexample or argument>"`. Similar results then see the reason. A failure for this result alone stays in the plan's `## Failure`; the idea stays open.
- Unclear statement or missing definition: report `question --question "..."`.
- Long proof: if about 30 tool calls in the proof is not complete, stop at a clean point. Write every finished step out in full under `## Progress` in the plan (which checklist items it settles, and the argument itself), and reply `partial: <what remains>`. A fresh worker continues from there with a small context. When you continue a partial execution, read the plan's `## Progress` first (`show <plan id> --section Progress`) and build on it; do not redo it. When the proof is complete, put the whole of it under `## Proof` and delete `## Progress`.

## Repairing a proof

A plan with `purpose: repair` fills a gap in the researcher's own proof; `## Gap` names it and `## Previous proof` holds their proof as written.

- Success: replace `## Proof` in the asset with the complete repaired proof. Keep the researcher's steps, order, notation, and wording wherever they hold; change or add only what the gap needs, and write those parts out in full. `## Outcome` says what was added or changed, by step, so the researcher can find it.
- Never edit `## Previous proof` or `## Gap` in the plan. A proof left unchanged is refused.
- Obstruction: leave the asset's proof as it is (the loop restores the researcher's version anyway), set the plan `status: failed`, and write `## Failure` as for any plan.

## A route's reduction (stage reduce)

A route (a plan with `route_lemmas`) proves its target from its lemmas. The reduction is that argument, written before the lemmas are proved: each lemma, and each dependency, is used as a black box by its statement in the pack, whether or not it is proved yet.

- Follow the route's `## Plan` checklist and write the complete argument under `## Reduction` in the route's plan file, not in the asset: several routes to one result are reduced side by side, and the loop moves the winning one into the asset's `## Proof` itself.
- Success: the plan stays `pending`; report `proved`. The loop records the reduction; an independent check may follow.
- Obstruction (the lemmas, as stated, do not give the target): set the plan `status: failed`, write `## Failure` with the step and what a lemma would have to say instead, and report `failed`. The other routes go on.
- Change neither the target nor any lemma, and never write `reduction_digest` or another field the loop stamps.

A failed plan says nothing about the truth of the statement. Only the plan file and the target's `## Proof` may change (for a reduction, only the route's plan file). Never set `status: approved`.
