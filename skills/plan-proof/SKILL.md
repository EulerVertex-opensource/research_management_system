---
name: plan-proof
description: Write one executable proof plan for a draft asset that survived falsification. Used by the research loop's plan stage.
---

# Plan a proof

Input: the context pack from `research-loop next` (target statement, dependency statements, definitions, failed plans' Goal and Failure, related ideas). Read only the pack; for anything else run `research-loop show <id> [--section Heading]`. Approved or proved dependencies are black boxes; unproved draft dependencies may be assumed but must be listed.

- A `pending` plan for this asset already exists (the pack shows it): do not write a new one; report `complete --plan <id>` so the loop executes it.
- Otherwise create `<plans>/<id>.md` with `type: plan`, `status: pending`, `target_asset`, and `inspired_by` idea IDs you used. Body:
  - `## Goal` starting with `Target: [asset](../assets/<id>.md)`;
  - `## Plan` as an ordered checklist `1. [ ] ...` of concrete steps, each with a checkable claim;
  - `## Verification`: how the steps combine into the exact statement;
  - `## Assumed definitions`: draft definitions and unproved dependencies relied on;
  - with failed plans present, `## Difference from failed plans`: one bullet per failed plan ID naming the new information or route.
- If the loop reports three failures since the last researcher direction, do not write a fourth plan; report `question`.
- Unclear statement or missing definition: report `question --question "..."`.

Never change the statement; a revised statement gets a new asset ID. Never set `status: approved`.
