---
name: plan-proof
description: Write one executable proof plan for a draft asset that survived falsification. Used by the research loop's plan stage.
---

# Plan a proof

Input: the context pack from `research-loop next` (target statement, dependency statements, definitions, failed plans' Goal and Failure, earlier succeeded plans' Outcome, related ideas, library analogues, and the idea guide). Read only the pack; for anything else run `research-loop show <id> [--section Heading]`. Approved or proved dependencies are black boxes; unproved draft dependencies may be assumed but must be listed. Library dependencies (`lib_` IDs) are known results: use them as black boxes like approved ones.

Look for an existing proof before designing one. The pack's **Library analogues** lists known results that resemble the target but are not in its `depends_on`: often the same theorem for another flow or setting. Read the `## Proof` of the closest ones (`research-loop show <lib_id> --section Proof`); also run `research-loop library search <words>` with the target's key terms and, before planning a step around a missing lemma, with that lemma's. A known result can serve in two ways:

- **Adapt its proof.** Its argument, with changes, proves the target or a step: list it under `adapts` in the plan's frontmatter and add `## Adapted from` naming each adapted ID, which of its hypotheses hold here and why, and which steps change (new terms, weaker bounds, extra structure). The checklist then follows that proof step by step, each step saying "as in <id> step k" or what replaces it. Adapting needs no dependency change, because the plan reproves what it borrows; but the results the adapted proof itself cites are cited here too, so each must be in `depends_on`, adapted in turn, or raised as below. Prefer it to a proof from scratch whenever an analogue's argument fits. A proof the source leaves as a sketch or a citation ("not detailed", "see X") is not one to adapt: say so and look further.
- **Cite its statement.** The plan uses its conclusion as a black box: only results already in the target's `depends_on` may be cited. If one that is not there would carry a step, record it with `record_idea` (kind `approach`, naming the `lib_` ID and the step) and report `question` so the researcher can add the dependency.

A draft (unchecked) library result may be adapted, since the plan rechecks its argument.

Reuse what the project already learned. The pack's **idea guide** lists ideas recorded for similar results (worded like the target, about a similar result, or used by the plan that proved one), dead ends near the target, and observations to promote:

- An approach or observation another result's plan used is not used up: reuse it when it fits. List every idea the plan draws on in `inspired_by`, not only the one that started it; that is how the project learns which ideas recur and which ones worked.
- An observation is not a proved fact. A step that needs one either proves it in the plan, or, when plans for other results already rely on it (the guide says so), promote it to a lemma first: `research-loop idea promote <idea> --id <lemma_id> --statement "<precise statement with hypotheses>" --into <target>`. The plan then cites the lemma from `depends_on`, and the loop proves the lemma like any other draft result. An approved target takes no new dependency from you: report `question` instead.
- Do not assume a refuted observation, and do not retry an obstructed approach unless the plan names the obstruction and says how it gets past it.

- A `pending` plan for this asset already exists (the pack shows it): do not write a new one; report `complete --plan <id>` so the loop executes it.
- Otherwise create `<plans>/<id>.md` with `type: plan`, `status: pending`, `target_asset`, `inspired_by` every idea ID the plan draws on, and `adapts` for results whose proof you follow. Body:
  - `## Goal` starting with `Target: [asset](../assets/<id>.md)`;
  - `## Plan` as an ordered checklist `1. [ ] ...` of concrete steps, each with a checkable claim;
  - `## Verification`: how the steps combine into the exact statement;
  - `## Assumed definitions`: draft definitions and unproved dependencies relied on;
  - with `adapts`, `## Adapted from`: per adapted ID, the hypotheses that transfer and the steps that change;
  - with failed plans present, `## Difference from failed plans`: one bullet per failed plan ID naming the new information or route.
- No genuinely new approach in sight (every route you see repeats a failed plan, or needs a step nothing available supplies): write no plan and report `none --summary "<what the failed plans show and why nothing new is in sight>"`. Never write a filler plan just to have one: executing it spends an attempt and records a failure that says nothing. `none` spends no attempt; the result counts as stuck, and the loop asks the researcher for a direction (in autonomous mode, you decide).
- If the loop reports the failed-plan limit is reached since the last researcher direction, do not write another plan; report `question`.
- Unclear statement or missing definition: report `question --question "..."`.

Never change the statement; a revised statement gets a new asset ID. Never set `status: approved`.
