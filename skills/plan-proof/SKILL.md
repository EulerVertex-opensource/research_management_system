---
name: plan-proof
description: Write one executable proof plan for a draft asset that survived falsification. Used by the research loop's plan stage.
---

# Plan a proof

Input: the context pack from `research-loop next` (target statement, dependency statements, definitions, failed plans' Goal and Failure, earlier succeeded plans' Outcome, related ideas). Read only the pack; for anything else run `research-loop show <id> [--section Heading]`. Approved or proved dependencies are black boxes; unproved draft dependencies may be assumed but must be listed. Library dependencies (`lib_` IDs) are known results: use them as black boxes like approved ones.

Before planning a step around a missing lemma, run `research-loop library search <words>` for a known result that gives it. A plan may use only results already in the target's `depends_on`; if a library result that is not there would carry a step, record it with `record_idea` (kind `approach`, naming the `lib_` ID and the step) and report `question` so the researcher can add the dependency.

- A `pending` plan for this asset already exists (the pack shows it): do not write a new one; report `complete --plan <id>` so the loop executes it.
- Otherwise create `<plans>/<id>.md` with `type: plan`, `status: pending`, `target_asset`, and `inspired_by` idea IDs you used. Body:
  - `## Goal` starting with `Target: [asset](../assets/<id>.md)`;
  - `## Plan` as an ordered checklist `1. [ ] ...` of concrete steps, each with a checkable claim;
  - `## Verification`: how the steps combine into the exact statement;
  - `## Assumed definitions`: draft definitions and unproved dependencies relied on;
  - with failed plans present, `## Difference from failed plans`: one bullet per failed plan ID naming the new information or route.
- If the loop reports the failed-plan limit is reached since the last researcher direction, do not write another plan; report `question`.
- Unclear statement or missing definition: report `question --question "..."`.

Never change the statement; a revised statement gets a new asset ID. Never set `status: approved`.
